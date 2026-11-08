"""Kanban decomposer — fan a triage task out into a graph of child tasks.

Invoked by ``hermes kanban decompose [task_id | --all]`` and the
auto-decompose path in the gateway dispatcher loop. Reads the user's
profile roster (with descriptions) and asks the auxiliary LLM to
return a task graph in JSON. Then atomically creates the children,
links them under the root, and flips the root ``triage -> todo``.

The root task stays alive and becomes the parent of every leaf child,
so when the whole graph completes the root wakes back up — its
assignee (the orchestrator profile) gets a chance to judge completion
and add more tasks if the work isn't done yet.

Design notes
------------

* Mirrors the shape of ``hermes_cli/kanban_specify.py``: lazy aux
  client import inside the function, lenient response parse, never
  raises on expected failure modes.

* The system prompt sees the *configured* profile roster as FG-34
  capability cards (``profile_capabilities.roster_prompt_block``):
  description, installed skills, toolsets, model and 90-day track
  record, plus the default fallback. Profiles without a description
  are still listed so the decomposer can match on skills or name.

* ``fanout=false`` collapses to the same effect as ``kanban specify``:
  we tighten the body and flip ``triage -> todo`` as a single task,
  no children created. This makes ``decompose`` a strict superset of
  ``specify`` from the user's perspective.

* If the LLM picks an assignee that doesn't exist as a profile, we
  rewrite it to the configured ``default_assignee`` (or the default
  profile if unset). A child task NEVER ends up with ``assignee=None``.

* Every pick carries a reason (``assignee_reason``, ``fit``,
  ``matched_skills``, ``assigned_by``: FG-34 contract C-3), recorded on
  the task as an ``assignment`` event and a comment. A fallback says why.
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass
from typing import Optional

from hermes_cli import kanban_db as kb
from hermes_cli import profiles as profiles_mod
from hermes_cli.profile_capabilities import capability_roster, roster_prompt_block

logger = logging.getLogger(__name__)


_SYSTEM_PROMPT = """You are the Kanban decomposer for the Hermes Agent board.

A user dropped a rough idea into the Triage column. Your job is to break it
into a small graph of concrete child tasks and route each one to the best-
matching profile from the available roster.

You will be given:
  - The original task title and body
  - The list of available profiles: name, description, skills, tools and
    track record (card runs completed / blocked / failed, recent titles)
  - The fallback "default_assignee" used when no profile fits

Output a single JSON object with this exact shape:

  {
    "fanout": true,
    "rationale": "<one sentence on why this decomposition>",
    "tasks": [
      {
        "title": "<concrete task title, imperative voice, <= 80 chars>",
        "body":  "<detailed spec for the worker on this child task>",
        "assignee": "<profile name from the roster, or null for default>",
        "assignee_reason": "<one sentence: the skill/tool/track record that fits, or what is missing>",
        "fit": "strong" | "partial" | "none",
        "matched_skills": ["<skill or tool names from that profile's card>"],
        "parents": [<int>, ...]
      },
      ...
    ]
  }

Rules:
  - "parents" is a list of INDICES (0-based) into this same "tasks" list,
    expressing actual data dependencies. Tasks with no parents run in
    PARALLEL. Tasks with parents wait until every parent completes.
  - Prefer parallelism. If two tasks can be done independently, give
    them no parents so the dispatcher fans them out at once.
  - Use 2-6 tasks for normal work. Don't create 20 tiny tasks. Don't
    cram everything into 1 task.
  - Pick assignees from the roster by matching the task to each profile's
    SKILLS, TOOLS, DESCRIPTION and TRACK RECORD (not the name). Prefer a
    profile whose track record shows it completes this kind of work. When
    nothing fits, use null with "fit": "none" and say in "assignee_reason"
    what is missing; the system will route to the default_assignee.
  - Each child task body is what a fresh worker will read with no other
    context — be specific about goal, approach, and acceptance criteria.

When the task is genuinely a single unit of work (no useful decomposition),
return:

  {
    "fanout": false,
    "rationale": "<one sentence>",
    "title": "<tightened title>",
    "body":  "<concrete spec for a single worker>",
    "assignee": "<profile name from the roster, or null for default>",
    "assignee_reason": "<one sentence>",
    "fit": "strong" | "partial" | "none",
    "matched_skills": ["<skill or tool names>"]
  }

In that case the task stays as one work item, just with a tightened spec and
a concrete assignee. If no profile fits, use null and the system will route to
the default_assignee.

No preamble, no closing remarks, no code fences. Output only the JSON object.
"""


_USER_TEMPLATE = """Task id: {task_id}
Title: {title}
Body:
{body}

Available profiles (assignees you may pick from):
{roster}

Default assignee (used when no profile fits a task): {default_assignee}
"""


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@dataclass
class DecomposeOutcome:
    """Result of decomposing a single triage task."""

    task_id: str
    ok: bool
    reason: str = ""
    fanout: bool = False
    child_ids: list[str] | None = None
    new_title: Optional[str] = None


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _extract_json_blob(raw: str) -> Optional[dict]:
    if not raw:
        return None
    stripped = _FENCE_RE.sub("", raw.strip())
    first = stripped.find("{")
    last = stripped.rfind("}")
    if first == -1 or last == -1 or last <= first:
        return None
    candidate = stripped[first : last + 1]
    try:
        val = json.loads(candidate)
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(val, dict):
        return None
    return val


def _profile_author() -> str:
    """Mirror of ``hermes_cli.kanban._profile_author``."""
    return (
        os.environ.get("HERMES_PROFILE")
        or os.environ.get("USER")
        or "decomposer"
    )


def _load_config() -> dict:
    try:
        from hermes_cli.config import load_config
        return load_config() or {}
    except Exception:
        return {}


def _resolve_orchestrator_profile(cfg: dict) -> str:
    """Resolve which profile owns the root/orchestration task after fan-out.

    Falls back to the active default profile when ``kanban.orchestrator_profile``
    is unset, so a task is never stranded for lack of an orchestrator.
    """
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    explicit = (kanban_cfg.get("orchestrator_profile") or "").strip()
    if explicit:
        try:
            if profiles_mod.profile_exists(explicit):
                return explicit
        except Exception:
            pass
    # Fall back to the active default profile.
    try:
        return profiles_mod.get_active_profile_name() or "default"
    except Exception:
        return "default"


def _resolve_default_assignee(cfg: dict) -> str:
    """Resolve which profile catches child tasks the orchestrator can't route."""
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    explicit = (kanban_cfg.get("default_assignee") or "").strip()
    if explicit:
        try:
            if profiles_mod.profile_exists(explicit):
                return explicit
        except Exception:
            pass
    try:
        return profiles_mod.get_active_profile_name() or "default"
    except Exception:
        return "default"


def _build_roster(board_conn=None) -> tuple[list[dict], set[str]]:
    """Return (roster_for_prompt, valid_assignee_names).

    Each roster entry is a capability card (``profile_capabilities``)
    plus ``has_description``. The valid-set is used after the LLM
    responds to rewrite invalid assignees to the default fallback.
    """
    roster: list[dict] = []
    valid: set[str] = set()
    try:
        all_profiles = profiles_mod.list_profiles()
    except Exception as exc:
        logger.warning("decompose: failed to list profiles: %s", exc)
        return roster, valid
    names = [p.name for p in all_profiles]
    listed = {p.name: (p.description or "").strip() for p in all_profiles}
    try:
        cards = capability_roster(names, board_conn=board_conn)
    except Exception as exc:  # noqa: BLE001 — capability_roster should not raise
        logger.warning("decompose: capability roster failed: %s", exc)
        cards = [{"name": n} for n in dict.fromkeys(names)]
    for card in cards:
        desc = (card.get("description") or "").strip() or listed.get(card["name"], "")
        roster.append({**card, "description": desc, "has_description": bool(desc)})
        valid.add(card["name"])
    return roster, valid


def _format_roster(roster: list[dict]) -> str:
    if not roster:
        return "  (no profiles installed — decomposer cannot route work)"
    return roster_prompt_block(roster)


def _normalize_assignee_choice(
    assignee: object,
    *,
    default_assignee: str,
    valid_names: set[str],
) -> str:
    """Return a valid assignee, falling back to ``default_assignee``.

    Fan-out children and the single-task fallback should share the same
    routing guarantee: promoted work must not be left unassigned.
    """
    if not isinstance(assignee, str) or not assignee.strip():
        return default_assignee
    chosen = assignee.strip()
    if chosen not in valid_names:
        return default_assignee
    return chosen


_REASON_MAX = 240
_FITS = ("strong", "partial", "none")


def _card_capabilities(card: Optional[dict]) -> dict[str, str]:
    """Lower-cased skill/toolset names (and ``category/skill``) → card name."""
    names: dict[str, str] = {}
    for skill in (card or {}).get("skills") or []:
        name = str(skill.get("name") or "").strip()
        if not name:
            continue
        names[name.lower()] = name
        if skill.get("category"):
            names[f"{skill['category']}/{name}".lower()] = name
    for toolset in (card or {}).get("toolsets") or []:
        if toolset:
            names[str(toolset).lower()] = str(toolset)
    return names


def _assignment_choice(
    entry: dict,
    *,
    default_assignee: str,
    valid_names: set[str],
    cards: dict[str, dict],
) -> tuple[str, dict]:
    """Return ``(assignee, assignment)`` for one decomposer pick.

    ``assignment`` holds the FG-34 C-3 fields. A valid pick keeps the
    model's reason, fit and the ``matched_skills`` that are on the chosen
    profile's card; anything else routes to ``default_assignee`` with a
    reason saying why.
    """
    raw = entry.get("assignee")
    picked = raw.strip() if isinstance(raw, str) else ""
    chosen = _normalize_assignee_choice(
        raw, default_assignee=default_assignee, valid_names=valid_names,
    )
    reason = entry.get("assignee_reason")
    reason = " ".join(reason.split()) if isinstance(reason, str) else ""
    if picked and chosen == picked:
        fit = entry.get("fit") if entry.get("fit") in _FITS else None
        known = _card_capabilities(cards.get(chosen))
        matched = list(dict.fromkeys(
            known[s.strip().lower()]
            for s in (entry.get("matched_skills") or [])
            if isinstance(s, str) and s.strip().lower() in known
        )) if isinstance(entry.get("matched_skills"), list) else []
        if not reason:
            reason = (
                f"Picked for its {', '.join(matched)}." if matched
                else f"Picked {chosen} from the roster."
            )
        assignment: dict = {
            "assignee_reason": _truncate(reason, _REASON_MAX),
            "fit": fit,
            "matched_skills": matched,
            "assigned_by": "planner",
        }
        return chosen, assignment

    if picked:
        why = (
            f"The decomposer picked {picked!r}, which is not an available "
            f"profile; routed to the default assignee {default_assignee}."
        )
    elif reason:
        why = f"No good fit: {reason.rstrip('.')}. Routed to the default assignee {default_assignee}."
    else:
        why = f"No profile in the roster fits this task; routed to the default assignee {default_assignee}."
    suggested = entry.get("suggested_profile")
    assignment = {
        "assignee_reason": _truncate(why, _REASON_MAX),
        "fit": "none",
        "matched_skills": [],
        "assigned_by": "fallback",
    }
    if isinstance(suggested, str) and suggested.strip():
        assignment["suggested_profile"] = suggested.strip()[:80]
    return chosen, assignment


def decompose_task(
    task_id: str,
    *,
    author: Optional[str] = None,
    timeout: Optional[int] = None,
) -> DecomposeOutcome:
    """Decompose a triage task into a graph of child tasks.

    Returns an outcome describing what happened. Never raises for
    expected failure modes (task not in triage, no aux client
    configured, API error, malformed response, decomposer returned
    fanout=true with empty task list) — those surface via ``ok=False``.
    """
    with kb.connect_closing() as conn:
        task = kb.get_task(conn, task_id)
    if task is None:
        return DecomposeOutcome(task_id, False, "unknown task id")
    if task.status != "triage":
        return DecomposeOutcome(
            task_id, False, f"task is not in triage (status={task.status!r})"
        )
    if task.project_id:
        return DecomposeOutcome(
            task_id, False, "project card — its run promotes it, not the decomposer"
        )

    cfg = _load_config()
    orchestrator = _resolve_orchestrator_profile(cfg)
    default_assignee = _resolve_default_assignee(cfg)
    kanban_cfg = cfg.get("kanban", {}) if isinstance(cfg, dict) else {}
    auto_promote = bool(kanban_cfg.get("auto_promote_children", True))
    roster, valid_names = _build_roster()
    cards = {card["name"]: card for card in roster}

    try:
        from agent.auxiliary_client import (  # type: ignore
            get_auxiliary_extra_body,
            get_text_auxiliary_client,
        )
    except Exception as exc:
        logger.debug("decompose: auxiliary client import failed: %s", exc)
        return DecomposeOutcome(task_id, False, "auxiliary client unavailable")

    try:
        client, model = get_text_auxiliary_client("kanban_decomposer")
    except Exception as exc:
        logger.debug("decompose: get_text_auxiliary_client failed: %s", exc)
        return DecomposeOutcome(task_id, False, "auxiliary client unavailable")

    if client is None or not model:
        return DecomposeOutcome(task_id, False, "no auxiliary client configured")

    user_msg = _USER_TEMPLATE.format(
        task_id=task.id,
        title=_truncate(task.title or "", 400),
        body=_truncate(task.body or "(no body)", 4000),
        roster=_format_roster(roster),
        default_assignee=default_assignee,
    )

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=4000,
            timeout=timeout or 180,
            extra_body=get_auxiliary_extra_body() or None,
        )
    except Exception as exc:
        logger.info(
            "decompose: API call failed for %s (%s)", task_id, exc,
        )
        return DecomposeOutcome(task_id, False, f"LLM error: {type(exc).__name__}")

    try:
        raw = resp.choices[0].message.content or ""
    except Exception:
        raw = ""

    parsed = _extract_json_blob(raw)
    if parsed is None:
        return DecomposeOutcome(task_id, False, "LLM returned malformed JSON")

    fanout = bool(parsed.get("fanout"))
    audit_author = author or _profile_author()

    if not fanout:
        # Fall back to single-task spec promotion (same effect as specify).
        new_title = parsed.get("title")
        new_body = parsed.get("body")
        title_val = new_title.strip() if isinstance(new_title, str) and new_title.strip() else None
        body_val = new_body if isinstance(new_body, str) and new_body.strip() else None
        assignee_val = None
        assignment_val = None
        if not task.assignee:
            assignee_val, assignment_val = _assignment_choice(
                parsed,
                default_assignee=default_assignee,
                valid_names=valid_names,
                cards=cards,
            )
        if title_val is None and body_val is None:
            return DecomposeOutcome(
                task_id, False, "decomposer returned fanout=false with no title/body",
            )
        with kb.connect_closing() as conn:
            ok = kb.specify_triage_task(
                conn,
                task_id,
                title=title_val,
                body=body_val,
                assignee=assignee_val,
                author=audit_author,
                assignment=assignment_val,
            )
        if not ok:
            return DecomposeOutcome(
                task_id, False, "task moved out of triage before promotion",
            )
        return DecomposeOutcome(
            task_id, True, "single task (no fanout)",
            fanout=False, new_title=title_val,
        )

    raw_tasks = parsed.get("tasks") or []
    if not isinstance(raw_tasks, list) or not raw_tasks:
        return DecomposeOutcome(
            task_id, False, "decomposer returned fanout=true with empty tasks list",
        )

    # Rewrite invalid assignees to the default fallback. Never leave a
    # task with assignee=None — the user explicitly does not want that.
    children: list[dict] = []
    for idx, entry in enumerate(raw_tasks):
        if not isinstance(entry, dict):
            return DecomposeOutcome(
                task_id, False, f"tasks[{idx}] is not an object",
            )
        title = entry.get("title")
        if not isinstance(title, str) or not title.strip():
            return DecomposeOutcome(
                task_id, False, f"tasks[{idx}].title is missing or empty",
            )
        body = entry.get("body")
        if not isinstance(body, str):
            body = ""
        assignee = entry.get("assignee")
        chosen, assignment = _assignment_choice(
            entry,
            default_assignee=default_assignee,
            valid_names=valid_names,
            cards=cards,
        )
        if (
            isinstance(assignee, str)
            and assignee.strip()
            and assignee.strip() not in valid_names
        ):
            logger.info(
                "decompose: task %s child %d picked unknown assignee %r — "
                "routing to default_assignee %r",
                task_id, idx, assignee, default_assignee,
            )
        parents = entry.get("parents") or []
        if not isinstance(parents, list):
            parents = []
        # Clean parent indices: drop non-int and out-of-range.
        clean_parents = [p for p in parents if isinstance(p, int) and 0 <= p < len(raw_tasks) and p != idx]
        children.append({
            "title": title.strip()[:200],
            "body": body.strip(),
            "assignee": chosen,
            "parents": clean_parents,
            "assignment": assignment,
        })

    try:
        with kb.connect_closing() as conn:
            child_ids = kb.decompose_triage_task(
                conn,
                task_id,
                root_assignee=orchestrator,
                children=children,
                author=audit_author,
                auto_promote=auto_promote,
            )
    except ValueError as exc:
        return DecomposeOutcome(task_id, False, f"DB rejected graph: {exc}")
    except Exception as exc:
        logger.exception("decompose: DB error on task %s", task_id)
        return DecomposeOutcome(task_id, False, f"DB error: {type(exc).__name__}")

    if child_ids is None:
        return DecomposeOutcome(
            task_id, False, "task moved out of triage before decomposition",
        )

    return DecomposeOutcome(
        task_id, True, f"decomposed into {len(child_ids)} children",
        fanout=True, child_ids=child_ids,
    )


def list_triage_ids(*, tenant: Optional[str] = None) -> list[str]:
    """Return task ids currently in the triage column.

    Project cards are skipped: a project run holds its cards in triage on
    purpose and promotes them itself, so the sweeper must not fan them out.
    """
    with kb.connect_closing() as conn:
        rows = kb.list_tasks(
            conn,
            status="triage",
            tenant=tenant,
            limit=1000,
        )
    return [row.id for row in rows if not row.project_id]
