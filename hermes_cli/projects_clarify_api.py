"""``/{slug}/clarify`` — the agent asks clarifying questions before it plans.

The Scope tab. After a project is created (and at any later time) the agent
reads the brief, goal, outputs and inputs and asks the owner a short round
of questions about goal, scope, audience, success criteria, constraints,
inputs and format. The owner answers or skips; the agent may ask follow-up
rounds or say it has enough. The owner then confirms the agent's
understanding (optionally edited) and may start the plan draft from it.

Contracts:

* **Soft gate.** Nothing here blocks drafting a plan or starting a run.
* **Never touches a running conversation.** Questions come from one fresh,
  tool-less auxiliary call (``auxiliary.projects_clarify``, else
  ``compression``) in a background job — no session is resumed, appended
  to or interrupted, so a running task's prompt cache is untouched
  (AGENTS.md).
* One question job per project at a time (409 while one runs), tracked
  in-process like the plan drafter. A model failure becomes a ``failed``
  job with a friendly ``detail``, never a stack trace.
* Reads need read permission; every write needs write permission and is
  refused on an archived project.
"""

from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import projects_api, projects_db
from hermes_cli.projects_api import (
    _refuse_if_archived,
    _require_read,
    _require_write,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

FOCUS_MAX_LEN = 500
UNDERSTANDING_MAX_LEN = 4_000
PROMPT_MAX_CHARS = 12_000
_BRIEF_MAX = 3_000
_INPUTS_MAX = 3_000
_HISTORY_MAX = 4_500
_LINE_MAX = 240
_NOTE_MAX = 600
_MAX_OUTPUTS = 20
_MAX_INPUTS_PER_GROUP = 20

CLARIFY_TIMEOUT_SECONDS = 90.0

_CLARIFY_TASK = "projects_clarify"
_CLARIFY_FALLBACK_TASK = "compression"

_NOTE_PREFIX = "note:"
_URL_RE = re.compile(r"^https?://\S+$", re.I)
# Kinds the Inputs tab lists under "Links & notes" (mirrors
# agent-home/src/components/projects/inputs/inputKinds.ts). ``goal`` is the
# project's own aim, not an input.
_LINK_SECTION_KINDS = ("url", "todo", "arrival", "conversation")

_CLARIFY_SYSTEM = (
    "You help scope a project before an AI agent starts working on it. You "
    "are given the project's brief, goal, outputs and inputs, and any "
    "earlier rounds of clarifying questions with the owner's answers. "
    "Decide what you still need to know to plan the work well: the goal, "
    "the scope (what is in and out), the audience, how success is judged, "
    "constraints (deadlines, budget, tone, rules), inputs (sources, "
    "examples) and the format of the outputs. Reply with ONE JSON object "
    "and nothing else, shaped as "
    '{"understanding": "<3-6 sentences: your current understanding of the '
    'goal and scope>", "done": <bool>, "questions": [{"category": '
    '"goal|scope|audience|success|constraints|inputs|format|other", '
    '"question": "<one clear question>", "why": "<one short line: why the '
    'answer matters>", "options": ["<short suggested answer>"], '
    '"allow_multiple": <bool>}]}. '
    "Ask 3-7 questions in a first round (fewer in a follow-up round), most "
    "important first. Never ask what the brief, the inputs or an earlier "
    "answer already settles, and never repeat an earlier question. Offer 2-4 "
    "short suggested answers when the likely answers are predictable, "
    "otherwise an empty list; set allow_multiple=true when several may "
    "apply. If you already have enough to plan the work, set done=true and "
    "return an empty questions list. Write the understanding and every "
    "question in the same language as the brief."
)


class ClarifyModelUnavailable(RuntimeError):
    """No model is configured for the clarify call."""


# ---------------------------------------------------------------------------
# Question jobs (in-process, one per project — mirrors ``_PLAN_DRAFTS``)
# ---------------------------------------------------------------------------

_CLARIFY_JOBS: dict[str, dict[str, Any]] = {}
_CLARIFY_JOBS_LOCK = threading.Lock()


def reset_state() -> None:
    """Forget every job (tests)."""
    with _CLARIFY_JOBS_LOCK:
        _CLARIFY_JOBS.clear()


def _job_snapshot(project_id: str) -> dict:
    with _CLARIFY_JOBS_LOCK:
        job = _CLARIFY_JOBS.get(project_id)
        return dict(job) if job else {"status": "idle"}


def _job_running(project_id: str) -> bool:
    with _CLARIFY_JOBS_LOCK:
        job = _CLARIFY_JOBS.get(project_id)
        return bool(job and job.get("status") == "running")


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------


def _redact(text: str) -> str:
    try:
        from agent.redact import redact_sensitive_text

        return redact_sensitive_text(text, force=True)
    except Exception:  # pragma: no cover - redaction is best-effort
        return text


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _line(text: Any, limit: int = _LINE_MAX) -> str:
    """One line, secrets redacted, bounded."""
    return _clip(_redact(" ".join(str(text or "").split())), limit)


def _block(text: Any, limit: int) -> str:
    """Multi-line text (line breaks kept), secrets redacted, bounded."""
    s = re.sub(r"\n{3,}", "\n\n", str(text or "").strip())
    return _clip(_redact(s), limit)


def _is_note(ref: str) -> bool:
    return ref.startswith(_NOTE_PREFIX)


def _is_url(ref: str) -> bool:
    return bool(_URL_RE.match(ref))


def group_input_links(links: list[dict]) -> dict[str, list[dict]]:
    """Split project links into the Inputs tab's three sections.

    Mirrors ``groupInputLinks`` in ``inputKinds.ts``: **files** are ``file``
    links plus ``sample``/``reference`` links that are neither a note nor a
    URL; **memories** are ``memory`` links; **links** are notes, URLs,
    to-dos, arrivals and conversations. Newest first."""
    files: list[dict] = []
    memories: list[dict] = []
    other: list[dict] = []
    for link in links:
        kind = link.get("kind")
        ref = str(link.get("ref") or "")
        if kind == "file":
            files.append(link)
        elif kind == "memory":
            memories.append(link)
        elif kind in ("sample", "reference"):
            (other if _is_note(ref) or _is_url(ref) else files).append(link)
        elif kind in _LINK_SECTION_KINDS:
            other.append(link)

    def newest(rows: list[dict]) -> list[dict]:
        return sorted(rows, key=lambda r: -(r.get("added_at") or 0))

    return {"files": newest(files), "memories": newest(memories), "links": newest(other)}


def _file_line(link: dict) -> str:
    name = _line(link.get("label") or link.get("ref"), 160)
    role = {
        "sample": "template to match",
        "reference": "reference to read",
    }.get(link.get("kind"), "file")
    return f"- {name} ({role})"


def _link_line(link: dict) -> str:
    kind = link.get("kind")
    ref = str(link.get("ref") or "")
    label = link.get("label")
    if _is_note(ref):
        return f"- Note: {_line(ref[len(_NOTE_PREFIX):], _NOTE_MAX)}"
    if kind in ("url", "sample", "reference") and _is_url(ref):
        role = {"sample": " (template to match)", "reference": " (reference)"}.get(kind, "")
        text = _line(label, 120) if label and label != ref else ""
        return f"- Link{role}: {(text + ' ') if text else ''}<{_line(ref, 200)}>"
    word = {"todo": "To-do", "arrival": "Inbox item", "conversation": "Conversation"}.get(
        kind, "Link"
    )
    return f"- {word}: {_line(label or ref, 160)}"


def _bounded(lines: list[str], limit: int, more_label: str = "more") -> list[str]:
    out: list[str] = []
    used = 0
    for i, line in enumerate(lines):
        if used + len(line) + 1 > limit:
            out.append(f"- … {len(lines) - i} {more_label}")
            break
        out.append(line)
        used += len(line) + 1
    return out


def _inputs_section(links: list[dict]) -> list[str]:
    groups = group_input_links(links)
    lines: list[str] = ["INPUTS THE OWNER ATTACHED:"]
    if not any(groups.values()):
        return lines + ["- none"]
    body: list[str] = []
    for title, rows, render in (
        ("Files", groups["files"], _file_line),
        ("Memories", groups["memories"], lambda r: f"- {_line(r.get('label') or r.get('ref'), 160)}"),
        ("Links & notes", groups["links"], _link_line),
    ):
        if not rows:
            continue
        body.append(f"{title}:")
        body.extend(render(r) for r in rows[:_MAX_INPUTS_PER_GROUP])
        if len(rows) > _MAX_INPUTS_PER_GROUP:
            body.append(f"- … {len(rows) - _MAX_INPUTS_PER_GROUP} more")
    return lines + _bounded(body, _INPUTS_MAX, "more inputs")


def _round_lines(rnd: dict, questions: list[dict]) -> list[str]:
    head = f"Round {rnd['round_no']} ({rnd['status']})"
    if rnd.get("focus"):
        head += f" — owner asked to focus on: {_line(rnd['focus'], 200)}"
    lines = [head + ":"]
    for q in questions:
        lines.append(f"- Q [{q.get('category') or 'other'}]: {_line(q.get('question'), 300)}")
        if q.get("status") == "answered":
            lines.append(f"  A: {_line(q.get('answer'), 400)}")
        elif q.get("status") == "skipped":
            lines.append("  A: (skipped by the owner)")
        else:
            lines.append("  A: (not answered yet)")
    if rnd.get("understanding"):
        label = "Confirmed understanding" if rnd["status"] == "confirmed" else "Your understanding then"
        lines.append(f"{label}: {_line(rnd['understanding'], 800)}")
    return lines


def _history_section(rounds: list[dict], questions: list[dict]) -> list[str]:
    if not rounds:
        return []
    by_round: dict[int, list[dict]] = {}
    for q in questions:
        by_round.setdefault(int(q["round_no"]), []).append(q)
    # Newest rounds matter most: keep them whole, drop the oldest first.
    kept: list[list[str]] = []
    used = 0
    for rnd in reversed(rounds):
        block = _round_lines(rnd, by_round.get(int(rnd["round_no"]), []))
        size = sum(len(x) + 1 for x in block)
        if kept and used + size > _HISTORY_MAX:
            break
        kept.append(block)
        used += size
    lines = ["", "EARLIER ROUNDS OF QUESTIONS (oldest first):"]
    skipped = len(rounds) - len(kept)
    if skipped:
        lines.append(f"- … {skipped} older rounds omitted")
    for block in reversed(kept):
        lines.extend(block)
    return lines


def build_clarify_prompt(project, *, focus: Optional[str] = None) -> str:
    """The project as bounded text for the clarify call. Reads only."""
    with projects_db.connect_closing() as conn:
        outputs = projects_db.get_project_outputs(conn, project.id)
        links = projects_db.get_project_links(conn, project.id)
        rounds = projects_db.list_clarify_rounds(conn, project.id)
        questions = projects_db.list_clarifications(conn, project.id)

    lines: list[str] = [f"PROJECT: {_line(project.name)}"]
    if project.goal:
        lines.append(f"Goal: {_line(project.goal, 600)}")
    if (project.description or "").strip():
        lines += ["Brief:", _block(project.description, _BRIEF_MAX)]
    if (project.target_audience or "").strip():
        lines.append(f"Audience: {_line(project.target_audience, 300)}")
    if (project.definition_of_done or "").strip():
        lines.append(f"Done when: {_line(project.definition_of_done, 400)}")
    lines.append(f"Cadence: {project.cadence}; autonomy: {project.autonomy}.")

    lines += ["", "OUTPUTS THE PROJECT MUST DELIVER:"]
    if not outputs:
        lines.append("- none declared yet")
    for out in outputs[:_MAX_OUTPUTS]:
        flag = "" if out.get("required", 1) else " (optional)"
        bit = f"- {_line(out.get('title') or out.get('id'), 160)}{flag}"
        if out.get("kind"):
            bit += f" [{out['kind']}]"
        if (out.get("spec") or "").strip():
            bit += f": {_line(out['spec'], 300)}"
        lines.append(bit)
    if len(outputs) > _MAX_OUTPUTS:
        lines.append(f"- … {len(outputs) - _MAX_OUTPUTS} more outputs")

    lines.append("")
    lines += _inputs_section(links)
    lines += _history_section(rounds, questions)

    lines.append("")
    if focus:
        lines.append(f"The owner asks you to focus on: {_line(focus, FOCUS_MAX_LEN)}")
    if rounds:
        lines.append(
            f"This is round {len(rounds) + 1}. Ask only follow-ups that the earlier "
            "answers leave open; if they are enough, set done=true."
        )
    else:
        lines.append("This is the first round of questions.")

    text = "\n".join(lines)
    if len(text) > PROMPT_MAX_CHARS:
        text = text[: PROMPT_MAX_CHARS - 40].rstrip() + "\n… (project text truncated)"
    return text


def build_clarify_messages(project, *, focus: Optional[str] = None) -> list[dict]:
    return [
        {"role": "system", "content": _CLARIFY_SYSTEM},
        {"role": "user", "content": build_clarify_prompt(project, focus=focus)},
    ]


# ---------------------------------------------------------------------------
# The model call (tests replace ``_call_clarify_model``)
# ---------------------------------------------------------------------------


def _call_clarify_model(messages: list[dict]) -> str:
    """One fresh, tool-less auxiliary call (``auxiliary.projects_clarify``,
    else ``compression``) — never the interactive agent loop."""
    from agent.auxiliary_client import (
        _get_auxiliary_task_config,
        call_llm,
        resolve_task_timeout,
    )

    task = (
        _CLARIFY_TASK
        if _get_auxiliary_task_config(_CLARIFY_TASK).get("provider")
        else _CLARIFY_FALLBACK_TASK
    )
    # The timeout is this feature's own (auxiliary.<task>.timeout or its
    # default), checked against the provider/model the call really uses.
    task_cfg = _get_auxiliary_task_config(task)
    try:
        response = call_llm(
            task,
            messages=messages,
            temperature=0.3,
            max_tokens=1_500,
            timeout=resolve_task_timeout(
                _CLARIFY_TASK,
                task_cfg.get("provider"),
                task_cfg.get("model"),
                default=CLARIFY_TIMEOUT_SECONDS,
            ),
        )
    except RuntimeError as exc:
        if "No LLM provider configured" in str(exc):
            raise ClarifyModelUnavailable(str(exc)) from exc
        raise
    return response.choices[0].message.content or ""


class ClarifyReplyError(ValueError):
    """The model's reply could not be read as questions."""


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1")
    return bool(value)


def parse_clarify_reply(raw: str) -> dict:
    """``{understanding, done, questions}`` from the model's reply.

    Accepts a bare object, one wrapped in prose or a code fence, a question
    given as a plain string, and ``options`` given as one string. With no
    usable question the round is ``done``."""
    try:
        data = projects_api._extract_json_object(raw)
    except ValueError as exc:
        raise ClarifyReplyError("the model did not return questions") from exc
    understanding = _block(data.get("understanding"), UNDERSTANDING_MAX_LEN)
    raw_qs = data.get("questions")
    if not isinstance(raw_qs, list):
        raw_qs = []
    questions: list[dict] = []
    for item in raw_qs:
        if isinstance(item, str):
            item = {"question": item}
        if not isinstance(item, dict):
            continue
        text = str(item.get("question") or item.get("text") or "").strip()
        if not text:
            continue
        options = item.get("options") or item.get("suggestions") or []
        if isinstance(options, str):
            options = [options]
        if not isinstance(options, list):
            options = []
        questions.append(
            {
                "category": str(item.get("category") or "other"),
                "question": text,
                "why": str(item.get("why") or "").strip() or None,
                "options": [str(o) for o in options if isinstance(o, (str, int, float))],
                "allow_multiple": _as_bool(item.get("allow_multiple")),
            }
        )
        if len(questions) >= projects_db.CLARIFY_MAX_QUESTIONS:
            break
    if not questions and not understanding:
        raise ClarifyReplyError("the model returned no questions")
    done = _as_bool(data.get("done")) or not questions
    return {"understanding": understanding or None, "done": done, "questions": questions}


def _clarify_error_detail(exc: Exception) -> str:
    if isinstance(exc, ClarifyModelUnavailable):
        return "Scope questions aren't set up on this box yet — no model is configured for them."
    if isinstance(exc, ClarifyReplyError):
        return "The agent's reply couldn't be read as questions. Try again."
    if isinstance(exc, TimeoutError) or "timed out" in str(exc).lower():
        return "The agent took too long to come up with questions. Try again in a moment."
    try:
        from agent.auxiliary_client import _is_auth_error, _is_payment_error

        if _is_payment_error(exc) or _is_auth_error(exc):
            return "The model provider refused the request. Check the provider account, then try again."
    except Exception:
        pass
    return "The agent couldn't come up with questions just now. Try again in a moment."


def _clarify_job(
    *, project_id: str, messages: list[dict], created_by: str, focus: Optional[str]
) -> None:
    def _set(**fields: Any) -> None:
        with _CLARIFY_JOBS_LOCK:
            state = _CLARIFY_JOBS.get(project_id)
            if state is not None:
                state.update(fields)

    try:
        parsed = parse_clarify_reply(_call_clarify_model(messages))
        with projects_db.connect_closing() as conn:
            round_no = projects_db.add_clarify_round(
                conn,
                project_id,
                questions=parsed["questions"],
                understanding=parsed["understanding"],
                done=parsed["done"],
                created_by=created_by,
                focus=focus,
            )
        _set(status="done", round_no=round_no, detail=None, finished_at=int(time.time()))
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, not raised
        logger.warning("clarify questions failed for project %s: %s", project_id, exc)
        _set(status="failed", detail=_clarify_error_detail(exc), finished_at=int(time.time()))


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


def clarify_state(project_id: str) -> dict:
    """``ClarifyState``: the summary plus every round, question and the job."""
    with projects_db.connect_closing() as conn:
        summary = projects_db.clarify_summary(conn, project_id)
        rounds = projects_db.list_clarify_rounds(conn, project_id)
        questions = projects_db.list_clarifications(conn, project_id)
    return {
        **summary,
        "rounds": rounds,
        "questions": questions,
        "job": _job_snapshot(project_id),
    }


async def _json_object(request: Request) -> dict:
    raw = await request.body()
    if not raw.strip():
        return {}
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    return body


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/{slug}/clarify")
async def get_clarify(request: Request) -> dict[str, Any]:
    project, _role, _profiles, _principal = await _require_read(request)
    return await asyncio.to_thread(clarify_state, project.id)


@router.post("/{slug}/clarify/questions")
async def ask_clarify_questions(request: Request) -> dict[str, Any]:
    """Start a round of agent questions. Body ``{focus?}``. Returns the
    state at once with ``job.status == "running"``; poll ``GET …/clarify``."""
    project, _role, _profiles, principal = await _require_write(request)
    _refuse_if_archived(project, "asking scope questions")
    body = await _json_object(request)
    focus = str(body.get("focus") or "").strip()
    if len(focus) > FOCUS_MAX_LEN:
        raise HTTPException(
            status_code=422, detail=f"Keep the focus under {FOCUS_MAX_LEN} characters."
        )

    def _start_sync() -> dict:
        messages = build_clarify_messages(project, focus=focus or None)
        with _CLARIFY_JOBS_LOCK:
            current = _CLARIFY_JOBS.get(project.id)
            if current and current.get("status") == "running":
                raise HTTPException(
                    status_code=409, detail="the agent is already working on questions"
                )
            _CLARIFY_JOBS[project.id] = {"status": "running", "started_at": int(time.time())}
        threading.Thread(
            target=_clarify_job,
            kwargs={
                "project_id": project.id,
                "messages": messages,
                "created_by": principal.user_id,
                "focus": focus or None,
            },
            name=f"clarify-{project.slug}",
            daemon=True,
        ).start()
        return clarify_state(project.id)

    return await asyncio.to_thread(_start_sync)


@router.post("/{slug}/clarify/answers")
async def answer_clarify_questions(request: Request) -> dict[str, Any]:
    """Body ``{answers: [{id, answer} | {id, skip: true}]}``; returns the state."""
    project, _role, _profiles, principal = await _require_write(request)
    _refuse_if_archived(project, "answering scope questions")
    body = await _json_object(request)
    raw = body.get("answers")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(status_code=422, detail="Answer at least one question.")
    answers: list[dict] = []
    for item in raw:
        if not isinstance(item, dict) or not str(item.get("id") or "").strip():
            raise HTTPException(status_code=422, detail="each answer needs a question id")
        qid = str(item["id"]).strip()
        if item.get("skip") is True:
            answers.append({"id": qid, "skip": True})
        else:
            answers.append({"id": qid, "answer": str(item.get("answer") or "")})

    def _answer_sync() -> dict:
        try:
            with projects_db.connect_closing() as conn:
                projects_db.answer_clarifications(
                    conn, project.id, answers, user_id=principal.user_id
                )
        except KeyError:
            raise HTTPException(status_code=404, detail="that question no longer exists")
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return clarify_state(project.id)

    return await asyncio.to_thread(_answer_sync)


@router.post("/{slug}/clarify/confirm")
async def confirm_clarify(request: Request) -> dict[str, Any]:
    """Body ``{understanding?, draft_plan?}`` → ``{state, plan_draft}``.

    Confirms the latest round (open questions become skipped), storing the
    edited understanding when given. With ``draft_plan`` the ordinary plan
    draft starts; a refusal (e.g. no outputs) is reported as ``plan_draft:
    {status: "refused", detail}``, not as an error."""
    project, _role, profiles, principal = await _require_write(request)
    _refuse_if_archived(project, "confirming its scope")
    body = await _json_object(request)
    understanding = str(body.get("understanding") or "").strip()
    if len(understanding) > UNDERSTANDING_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"Keep the summary under {UNDERSTANDING_MAX_LEN} characters.",
        )
    draft_plan = body.get("draft_plan") is True
    accessible = (
        await projects_api._accessible_profiles(principal, project)
        if draft_plan else None
    )

    def _confirm_sync() -> dict:
        if _job_running(project.id):
            raise HTTPException(
                status_code=409,
                detail="the agent is still working on questions — wait for it to finish",
            )
        with projects_db.connect_closing() as conn:
            confirmed = projects_db.confirm_clarify_round(
                conn, project.id, user_id=principal.user_id,
                understanding=understanding or None,
            )
        if confirmed is None:
            raise HTTPException(
                status_code=409,
                detail="there is nothing to confirm yet — ask the agent for questions first",
            )
        plan_draft: Optional[dict] = None
        if draft_plan:
            try:
                plan_draft = projects_api.start_plan_draft(
                    project, profiles, principal, accessible=accessible
                )
            except HTTPException as exc:
                plan_draft = {"status": "refused", "detail": str(exc.detail)}
        return {"state": clarify_state(project.id), "plan_draft": plan_draft}

    return await asyncio.to_thread(_confirm_sync)
