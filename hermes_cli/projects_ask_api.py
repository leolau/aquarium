"""``POST /{slug}/ask`` — ask the project a question (read-only Q&A).

The ask box under the project page's live bar. The answer comes from a
compact, bounded text **snapshot** of the project's current state — brief,
the owner-agreed scope and clarifications, active requirements (directives), the active plan's steps, recent runs with
their stall state, the caller-visible board, outputs, the last events — sent
to the auxiliary model in its **own one-shot call**.

Contracts:

* **Read-only.** Read permission only; nothing here writes the projects or
  kanban stores, and the model gets no tools.
* **Never touches a running conversation.** The call is a fresh message list
  of its own — no session is resumed, appended to or interrupted, so a
  running task's prompt cache is untouched (AGENTS.md).
* **Citations are checked.** The model cites ``[kind:id]`` tags from the
  snapshot; tags that do not name a snapshot item are dropped.
* Rate-limited per principal; a model failure or timeout is a friendly
  502/503/504, never a stack trace.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections import deque
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import kanban_db, projects_clarify_context, projects_db
from hermes_cli.projects_api import (
    _board_conn,
    _require_read,
    _run_stalled,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

QUESTION_MAX_LEN = 2_000
HISTORY_MAX_TURNS = 6
_HISTORY_FIELD_MAX = 1_000
SNAPSHOT_MAX_CHARS = 12_000
_LINE_MAX = 240
_MAX_CARDS = 40
_MAX_RUNS = 5
_MAX_EVENTS = 20
_MAX_STEPS = 30
_MAX_REQUIREMENTS = 20
_MAX_OUTPUTS = 20
_MAX_CLARIFICATIONS = 12

ASK_TIMEOUT_SECONDS = 60.0
RATE_LIMIT = 10
RATE_WINDOW_SECONDS = 60.0

_ASK_TASK = "projects_ask"
_ASK_FALLBACK_TASK = "compression"

SOURCE_KINDS = ("card", "run", "output", "requirement", "plan", "event", "scope")

# Event payload fields safe to show: short status words only — never tool
# arguments, worker output or anything else a payload may carry.
_EVENT_SAFE_FIELDS = ("status", "from", "to", "outcome", "column")

_ASK_SYSTEM = (
    "You answer questions about one project for the person who runs it. "
    "You are given a snapshot of the project's current state. Answer only "
    "from the snapshot; if it does not say, say you don't know. Answer in "
    "the same language as the question, concisely (a few sentences or a "
    "short list), in plain words. Cite what you used with the bracketed "
    "tags exactly as they appear in the snapshot, e.g. [card:t_abc] or "
    "[run:3]. Never invent tags. You cannot change anything. If the answer "
    "suggests a new requirement or change the person may want, end with one "
    "line starting 'REQUIREMENT:' followed by that requirement as a short "
    "instruction; otherwise omit that line."
)

_CITATION_RE = re.compile(
    r"\[(" + "|".join(SOURCE_KINDS) + r"):([^\]\s]{1,120})\]"
)
_SUGGESTION_RE = re.compile(r"^\s*REQUIREMENT:\s*(.+?)\s*$", re.MULTILINE)


class AskModelUnavailable(RuntimeError):
    """No model is configured for the ask call."""


# ---------------------------------------------------------------------------
# Snapshot
# ---------------------------------------------------------------------------


def _clean(text: Any, limit: int = _LINE_MAX) -> str:
    """One line, secrets redacted, bounded."""
    s = " ".join(str(text or "").split())
    try:
        from agent.redact import redact_sensitive_text

        s = redact_sensitive_text(s, force=True)
    except Exception:  # pragma: no cover - redaction is best-effort
        pass
    if len(s) > limit:
        s = s[: limit - 1].rstrip() + "…"
    return s


def _ago(ts: Optional[int], now: int) -> str:
    if not ts:
        return "?"
    d = max(0, now - int(ts))
    if d < 90:
        return f"{d}s ago"
    if d < 90 * 60:
        return f"{d // 60}m ago"
    if d < 36 * 3600:
        return f"{d // 3600}h ago"
    return f"{d // 86400}d ago"


def build_snapshot(project, principal, *, now: Optional[int] = None) -> tuple[str, dict]:
    """The project's state as bounded text, plus the citable index.

    Returns ``(text, index)`` where ``index`` maps ``"kind:id"`` to
    ``{"kind", "id", "label"}``. Reads only; the board is read under the
    caller's principal so a private card never reaches the model.
    """
    now = int(now if now is not None else time.time())
    index: dict[str, dict] = {}
    lines: list[str] = []

    def cite(kind: str, ident: Any, label: str) -> str:
        ident = str(ident)
        tag = f"{kind}:{ident}"
        index[tag] = {"kind": kind, "id": ident, "label": _clean(label, 80)}
        return f"[{tag}]"

    with projects_db.connect_closing() as conn:
        pid = project.id
        directives = projects_db.list_project_directives(conn, pid, active_only=True)
        playbook = projects_db.get_playbook(conn, pid)
        runs = projects_db.list_project_runs(conn, pid, limit=_MAX_RUNS)
        outputs = projects_db.get_project_outputs(conn, pid)
        deliveries = projects_db.get_output_deliveries(conn, project_id=pid)
        run_cards = {r["id"]: projects_db.get_run_cards(conn, r["id"]) for r in runs}
        scope = projects_clarify_context.clarify_context(conn, pid)

    lines.append(f"PROJECT: {_clean(project.name)} (status {project.status}, cadence {project.cadence})")
    if project.goal:
        lines.append(f"Goal: {_clean(project.goal, 400)}")
    if project.description:
        lines.append(f"Brief: {_clean(project.description, 600)}")
    if project.definition_of_done:
        lines.append(f"Done when: {_clean(project.definition_of_done, 300)}")
    if project.summary:
        lines.append(f"Where it stands ({_ago(project.summary_at, now)}): {_clean(project.summary, 600)}")
    lines.extend(_scope_lines(scope, cite))

    lines.append("")
    lines.append("REQUIREMENTS (active, newest first):")
    reqs = [d for d in directives if d.get("kind") == "directive"][:_MAX_REQUIREMENTS]
    feedback = [d for d in directives if d.get("kind") != "directive"][:_MAX_REQUIREMENTS]
    if not reqs:
        lines.append("- none")
    for n, d in enumerate(reqs, start=1):
        tag = cite("requirement", d["id"], f"requirement R{n}")
        lines.append(f"- {tag} R{n}: {_clean(d.get('body'))}")
    for d in feedback:
        tag = cite("requirement", d["id"], "feedback")
        rating = f" ({d['rating']})" if d.get("rating") else ""
        lines.append(f"- {tag} feedback{rating}: {_clean(d.get('body'))}")

    lines.append("")
    if playbook:
        lines.append(f"PLAN (rev {playbook.get('rev')}, active):")
        steps = playbook.get("steps") or []
        for i, step in enumerate(steps[:_MAX_STEPS], start=1):
            key = step.get("key") or f"step-{i}"
            title = step.get("title") or key
            tag = cite("plan", key, f"plan step {i}: {title}")
            extra = " (checkpoint: waits for a human)" if step.get("checkpoint") else ""
            who = f" → {step['assignee']}" if step.get("assignee") else ""
            lines.append(f"- {tag} step {i}: {_clean(title, 120)}{who}{extra}")
        if len(steps) > _MAX_STEPS:
            lines.append(f"- … {len(steps) - _MAX_STEPS} more steps")
    else:
        lines.append("PLAN: no active plan")

    with _board_conn(project) as bconn:
        tasks = kanban_db.list_tasks(bconn, project_id=project.id, principal=principal)
        visible = {t.id: t for t in tasks}

        lines.append("")
        lines.append("RUNS (newest first):")
        if not runs:
            lines.append("- none yet")
        for r in runs:
            cards = []
            for rc in run_cards.get(r["id"], []):
                t = visible.get(rc["task_id"])
                if t is None:
                    continue
                cards.append({"task_id": t.id, "status": t.status, "title": t.title})
            blocked = [c for c in cards if c["status"] == "blocked"]
            stalled = _run_stalled(r, cards, blocked)
            tag = cite("run", r["run_no"], f"run {r['run_no']}")
            when = f"started {_ago(r.get('started_at'), now)}"
            if r.get("ended_at"):
                when += f", ended {_ago(r.get('ended_at'), now)}"
            done = sum(1 for c in cards if c["status"] == "done")
            parts = [f"- {tag} run {r['run_no']}: {r['status']}", when]
            if cards:
                parts.append(f"{done}/{len(cards)} cards done")
            if stalled:
                parts.append("STALLED (no worker is making progress)")
            if r.get("outcome"):
                parts.append(f"outcome: {_clean(r['outcome'], 160)}")
            if r.get("error"):
                parts.append(f"error: {_clean(r['error'], 160)}")
            lines.append(", ".join(parts))

        lines.append("")
        lines.append("BOARD CARDS (visible to you):")
        live = [t for t in tasks if t.status != "archived"]
        if not live:
            lines.append("- none")
        for t in live[:_MAX_CARDS]:
            tag = cite("card", t.id, f'card "{t.title}"')
            who = t.assignee or "unassigned"
            bits = [f"- {tag} {_clean(t.title, 120)}: {t.status}, {who}"]
            if t.status == "running" and t.last_heartbeat_at:
                bits.append(f"last heartbeat {_ago(t.last_heartbeat_at, now)}")
            if t.status == "blocked" and t.last_failure_error:
                bits.append(f"blocked because: {_clean(t.last_failure_error, 160)}")
            if t.status == "done" and t.result:
                bits.append(f"result: {_clean(t.result, 160)}")
            lines.append(", ".join(bits))
        if len(live) > _MAX_CARDS:
            lines.append(f"- … {len(live) - _MAX_CARDS} more cards")

        latest, _ = kanban_db.project_events_tail(
            bconn, project.id, principal=principal, since_id=0, limit=0
        )
        _, window = kanban_db.project_events_tail(
            bconn,
            project.id,
            principal=principal,
            since_id=max(0, latest - 500),
            limit=500,
        )
        events = window[-_MAX_EVENTS:]

    lines.append("")
    lines.append("OUTPUTS:")
    by_output: dict[str, list[dict]] = {}
    for d in deliveries:
        by_output.setdefault(d["output_id"], []).append(d)
    if not outputs:
        lines.append("- none")
    for o in outputs[:_MAX_OUTPUTS]:
        tag = cite("output", o["id"], f"output: {o.get('title')}")
        state = o.get("status") or "pending"
        bits = [f"- {tag} {_clean(o.get('title'), 120)}: {state}"]
        if o.get("required"):
            bits.append("required")
        if o.get("accepted_at"):
            bits.append(f"accepted {_ago(o['accepted_at'], now)}")
        dels = by_output.get(o["id"], [])
        if dels:
            last = dels[0]
            label = last.get("label") or last.get("link_kind") or "delivery"
            bits.append(f"{len(dels)} deliveries, last: {_clean(label, 80)} {_ago(last.get('delivered_at'), now)}")
        else:
            bits.append("not delivered yet")
        lines.append(", ".join(bits))

    lines.append("")
    lines.append("RECENT EVENTS (oldest first):")
    if not events:
        lines.append("- none")
    for ev in events:
        t = visible.get(ev.task_id)
        title = t.title if t else ev.task_id
        tag = cite("event", ev.id, f"{ev.kind} · {title}")
        safe = ""
        if isinstance(ev.payload, dict):
            kept = [
                f"{k}={_clean(ev.payload[k], 40)}"
                for k in _EVENT_SAFE_FIELDS
                if isinstance(ev.payload.get(k), (str, int, float))
            ]
            if kept:
                safe = " (" + ", ".join(kept) + ")"
        lines.append(f"- {tag} {_ago(ev.created_at, now)}: {ev.kind}{safe} on \"{_clean(title, 80)}\"")

    text = "\n".join(lines)
    if len(text) > SNAPSHOT_MAX_CHARS:
        text = text[: SNAPSHOT_MAX_CHARS - 40].rstrip() + "\n… (snapshot truncated)"
        # A tag cut off by the cap is no longer citable.
        index = {k: v for k, v in index.items() if f"[{k}]" in text}
    return text, index


def _scope_lines(scope: dict, cite: Callable[[str, Any, str], str]) -> list[str]:
    """The agreed scope + clarifications; ``[]`` when there are none.
    Citations are ``[scope:<round_no>]``."""
    tags: dict[int, str] = {}

    def tag(round_no: int) -> str:
        if round_no not in tags:
            tags[round_no] = cite("scope", round_no, f"agreed scope, round {round_no}")
        return tags[round_no]

    out: list[str] = []
    if scope.get("understanding") and scope.get("round_no"):
        out += [
            "",
            f"AGREED SCOPE (confirmed by the owner) {tag(scope['round_no'])}: "
            f"{_clean(scope['understanding'], 800)}",
        ]
    for heading, pairs in (
        ("CLARIFICATIONS (the owner's answers):", scope.get("confirmed") or []),
        ("OWNER'S ANSWERS SO FAR (not yet confirmed):", scope.get("pending") or []),
    ):
        if not pairs:
            continue
        if not out:
            out.append("")
        out.append(heading)
        newest = pairs[-_MAX_CLARIFICATIONS:]
        for p in newest:
            out.append(
                f"- {tag(p['round_no'])} {_clean(p['question'], 120)} → "
                f"{_clean(p['answer'], 160)}"
            )
        if len(pairs) > len(newest):
            out.append(f"- … {len(pairs) - len(newest)} earlier answers")
    return out


# ---------------------------------------------------------------------------
# Citations
# ---------------------------------------------------------------------------


def parse_answer(raw: str, index: dict) -> dict:
    """Split the model's text into ``answer``, checked ``sources`` and an
    optional ``suggested_requirement``. Citation tags are removed from the
    answer text; tags not in ``index`` are dropped."""
    raw = str(raw or "")
    suggestion = None
    m = _SUGGESTION_RE.search(raw)
    if m:
        suggestion = _CITATION_RE.sub("", m.group(1)).strip() or None
        raw = raw[: m.start()] + raw[m.end():]
    sources: list[dict] = []
    seen: set[str] = set()
    for kind, ident in _CITATION_RE.findall(raw):
        tag = f"{kind}:{ident}"
        if tag in index and tag not in seen:
            seen.add(tag)
            sources.append(dict(index[tag]))
    answer = _CITATION_RE.sub("", raw)
    answer = re.sub(r"[ \t]+([.,;:!?。，；：！？)])", r"\1", answer)
    answer = re.sub(r"\(\s*\)|（\s*）", "", answer)
    answer = re.sub(r"[ \t]{2,}", " ", answer)
    answer = re.sub(r"\n{3,}", "\n\n", answer).strip()
    out: dict[str, Any] = {"answer": answer, "sources": sources}
    if suggestion:
        out["suggested_requirement"] = suggestion[:500]
    return out


# ---------------------------------------------------------------------------
# The model call (injectable)
# ---------------------------------------------------------------------------


def _call_ask_model(messages: list[dict]) -> str:
    """One fresh, tool-less auxiliary call — the same model selection as the
    plan drafter (``auxiliary.projects_ask``, else ``compression``)."""
    from agent.auxiliary_client import (
        _get_auxiliary_task_config,
        call_llm,
        resolve_task_timeout,
    )

    task = (
        _ASK_TASK
        if _get_auxiliary_task_config(_ASK_TASK).get("provider")
        else _ASK_FALLBACK_TASK
    )
    # The timeout is this feature's own (auxiliary.<task>.timeout or its
    # default), checked against the provider/model the call really uses.
    task_cfg = _get_auxiliary_task_config(task)
    try:
        response = call_llm(
            task,
            messages=messages,
            temperature=0.2,
            max_tokens=800,
            timeout=resolve_task_timeout(
                _ASK_TASK,
                task_cfg.get("provider"),
                task_cfg.get("model"),
                default=ASK_TIMEOUT_SECONDS,
            ),
        )
    except RuntimeError as exc:
        if "No LLM provider configured" in str(exc):
            raise AskModelUnavailable(str(exc)) from exc
        raise
    return response.choices[0].message.content or ""


# Tests replace this; production uses the auxiliary client.
ask_model: Callable[[list[dict]], str] = _call_ask_model


def build_messages(snapshot: str, question: str, history: list[dict]) -> list[dict]:
    messages: list[dict] = [
        {"role": "system", "content": _ASK_SYSTEM},
        {"role": "user", "content": f"PROJECT SNAPSHOT\n\n{snapshot}"},
        {"role": "assistant", "content": "Understood. What would you like to know?"},
    ]
    for turn in history:
        messages.append({"role": "user", "content": turn["q"]})
        messages.append({"role": "assistant", "content": turn["a"]})
    messages.append({"role": "user", "content": question})
    return messages


def _model_error_detail(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, AskModelUnavailable):
        return 503, "Asking isn't set up on this box yet — no model is configured for it."
    try:
        from agent.auxiliary_client import _is_auth_error, _is_payment_error

        if _is_payment_error(exc) or _is_auth_error(exc):
            return 503, "The model provider refused the request. Check the provider account, then try again."
    except Exception:
        pass
    return 502, "The agent couldn't answer just now. Try again in a moment."


# ---------------------------------------------------------------------------
# Rate limit + idempotent replay (in-process)
# ---------------------------------------------------------------------------

_RATE_LOCK = threading.Lock()
_RATE: dict[str, deque] = {}
_REPLAY: dict[tuple[str, str], tuple[float, dict]] = {}
_REPLAY_TTL = 300.0
_REPLAY_MAX = 500


def _rate_check(user_id: str, *, now: Optional[float] = None) -> None:
    now = time.monotonic() if now is None else now
    with _RATE_LOCK:
        q = _RATE.setdefault(user_id, deque())
        while q and now - q[0] > RATE_WINDOW_SECONDS:
            q.popleft()
        if len(q) >= RATE_LIMIT:
            raise HTTPException(
                status_code=429,
                detail="You're asking a lot quickly — wait a minute and try again.",
            )
        q.append(now)


def _replay_get(user_id: str, key: str) -> Optional[dict]:
    if not key:
        return None
    now = time.monotonic()
    with _RATE_LOCK:
        hit = _REPLAY.get((user_id, key))
        if hit and now - hit[0] <= _REPLAY_TTL:
            return hit[1]
    return None


def _replay_put(user_id: str, key: str, payload: dict) -> None:
    if not key:
        return
    now = time.monotonic()
    with _RATE_LOCK:
        if len(_REPLAY) >= _REPLAY_MAX:
            for k, (ts, _) in list(_REPLAY.items()):
                if now - ts > _REPLAY_TTL:
                    del _REPLAY[k]
            while len(_REPLAY) >= _REPLAY_MAX:
                del _REPLAY[next(iter(_REPLAY))]
        _REPLAY[(user_id, key)] = (now, payload)


def reset_state() -> None:
    """Clear the rate-limit and replay tables (tests)."""
    with _RATE_LOCK:
        _RATE.clear()
        _REPLAY.clear()


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------


def _parse_body(body: Any) -> tuple[str, list[dict]]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    question = str(body.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=422, detail="Type a question first.")
    if len(question) > QUESTION_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"That question is too long — keep it under {QUESTION_MAX_LEN} characters.",
        )
    raw_history = body.get("history") or []
    if not isinstance(raw_history, list):
        raise HTTPException(status_code=422, detail="history must be a list")
    history: list[dict] = []
    for turn in raw_history[-HISTORY_MAX_TURNS:]:
        if not isinstance(turn, dict):
            continue
        q = str(turn.get("q") or "").strip()[:_HISTORY_FIELD_MAX]
        a = str(turn.get("a") or "").strip()[:_HISTORY_FIELD_MAX]
        if q and a:
            history.append({"q": q, "a": a})
    return question, history


@router.post("/{slug}/ask")
async def ask_project(request: Request) -> dict[str, Any]:
    """Answer a question about the project from its current state.

    Body ``{question, history?: [{q, a}]}`` → ``{answer, sources: [{kind,
    id, label}], suggested_requirement?}``. Read permission only.
    """
    project, _role, _profiles, principal = await _require_read(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    question, history = _parse_body(body)

    user_id = str(getattr(principal, "user_id", "") or "")
    key = (request.headers.get("idempotency-key") or "").strip()[:200]
    replay_key = f"{project.id}:{key}" if key else ""
    cached = _replay_get(user_id, replay_key)
    if cached is not None:
        return cached
    _rate_check(user_id)

    snapshot, index = await asyncio.to_thread(build_snapshot, project, principal)
    messages = build_messages(snapshot, question, history)
    try:
        raw = await asyncio.wait_for(
            asyncio.to_thread(ask_model, messages), timeout=ASK_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail="The agent took too long to answer. Try again in a moment.",
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — mapped to a friendly status
        logger.warning("project ask failed for %s: %s", project.slug, exc)
        status, detail = _model_error_detail(exc)
        raise HTTPException(status_code=status, detail=detail)

    payload = parse_answer(raw, index)
    if not payload["answer"]:
        raise HTTPException(
            status_code=502, detail="The agent couldn't answer just now. Try again in a moment."
        )
    _replay_put(user_id, replay_key, payload)
    return payload
