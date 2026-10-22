"""Projects runs + playbook engine (design ed.3.2 §4–§7).

This module is the *execution* half of Projects; ``projects_api.py`` is the
HTTP seam over it. Everything here is deliberately built on shipped seams:

- The sequencing engine is the board's: playbook steps become cards with
  ``project_id`` + ``task_links`` parents, and ``recompute_ready()`` owns
  todo → ready promotion. Projects writes zero scheduling logic (§7.1).
- The run's own session — when a playbook has ``mode: 'inline'`` steps —
  spawns through ``agent.seeded_session.spawn_seeded_session()``, the ONLY
  session-spawn path this feature may use (§6).
- Guidance is compiled into the seed prompt at spawn time, never injected
  mid-conversation (§5.1): the system prompt is frozen for the life of a
  conversation and per-conversation caching is sacred.
- Toolsets/skills are a **narrowing filter, never a grant** (§4.1): the
  effective set is the intersection with what the host profile enables.

Approvals ride the shipped FG-10 surface (``hermes_cli.human_comms.
NotificationStore``) and run cost reads the shipped C8 ledger
(``hermes_cli.interactions``): a run binds a real trace at start so its
cost is queryable — never stored (§6).
"""

from __future__ import annotations

import asyncio
import contextvars
import datetime as _dt
import json
import logging
import re
import uuid
from typing import Any, Callable, Dict, List, Optional, Sequence

from hermes_cli import kanban_db, projects_clarify_context, projects_db, run_activity

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config (config.yaml ``projects:`` — never env vars, AGENTS.md)
# ---------------------------------------------------------------------------

DEFAULT_MAX_SKILLS = 5
DEFAULT_GUIDANCE_MAX_DIRECTIVES = 20
DEFAULT_GUIDANCE_MAX_CHARS = 4000
DEFAULT_BRIEF_MAX_CHARS = 1200
# A `running` run with no card/session activity for longer than this looks
# orphaned rather than slow (Gap B/C — see plans/2026-09-13-project-run-
# resilience-plan.md). 2h is long enough to never fire on a legitimately
# long inline session, short enough to catch a restart-orphaned run same-day.
DEFAULT_RUN_STALL_SECONDS = 7200
# How often the gateway's embedded watcher sweeps open runs for capacity
# refill + staleness (Gap B). Independent of dispatch_interval_seconds —
# this is a much cheaper, much less frequent pass.
DEFAULT_RECONCILE_INTERVAL_SECONDS = 300

_CONFIG_CACHE: Optional[Dict[str, Any]] = None


def projects_runtime_config() -> Dict[str, Any]:
    """The ``projects:`` section of config.yaml with fail-open defaults."""
    global _CONFIG_CACHE
    if _CONFIG_CACHE is not None:
        return _CONFIG_CACHE
    raw: Dict[str, Any] = {}
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        section = cfg.get("projects")
        if isinstance(section, dict):
            raw = section
    except Exception:  # noqa: BLE001 — config is advisory here
        raw = {}
    out = {
        "max_skills": _int_or(raw.get("max_skills"), DEFAULT_MAX_SKILLS),
        "guidance_max_directives": _int_or(
            raw.get("guidance_max_directives"), DEFAULT_GUIDANCE_MAX_DIRECTIVES
        ),
        "guidance_max_chars": _int_or(
            raw.get("guidance_max_chars"), DEFAULT_GUIDANCE_MAX_CHARS
        ),
        "brief_max_chars": _int_or(
            raw.get("brief_max_chars"), DEFAULT_BRIEF_MAX_CHARS
        ),
        "run_stall_seconds": _int_or(
            raw.get("run_stall_seconds"), DEFAULT_RUN_STALL_SECONDS
        ),
        "reconcile_interval_seconds": _int_or(
            raw.get("reconcile_interval_seconds"),
            DEFAULT_RECONCILE_INTERVAL_SECONDS,
        ),
    }
    _CONFIG_CACHE = out
    return out


def _int_or(value: Any, default: int) -> int:
    try:
        n = int(value)
        return n if n > 0 else default
    except (TypeError, ValueError):
        return default


def _epoch_day(ts: Any) -> str:
    try:
        return _dt.datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return "?"


# ---------------------------------------------------------------------------
# §4.1 — toolsets / skills: intersection, never union
# ---------------------------------------------------------------------------

def parse_csv_field(value: Any) -> List[str]:
    """A project's ``toolsets``/``skills`` columns are comma lists."""
    if not value:
        return []
    if isinstance(value, (list, tuple)):
        items = value
    else:
        items = str(value).split(",")
    out: List[str] = []
    for item in items:
        s = str(item).strip()
        if s and s not in out:
            out.append(s)
    return out


def resolve_toolsets(
    requested: Sequence[str], enabled: Sequence[str]
) -> tuple[List[str], List[str]]:
    """``host profile enabled ∩ project requested`` (§4.1 rule 1).

    Returns ``(effective, dropped)``. A name the host profile does not
    enable is dropped — never granted — and the drop must be recorded on
    the run, because a silently narrower run looks like a broken agent.
    Empty ``requested`` means "whatever the host profile normally does".
    """
    if not requested:
        return list(enabled), []
    enabled_set = set(enabled)
    effective = [t for t in requested if t in enabled_set]
    dropped = [t for t in requested if t not in enabled_set]
    return effective, dropped


#: Always-present tool surface for a narrowed card worker — without these
#: the worker cannot even touch its own workspace or ask for help. The
#: floor is intersected with profile-enabled too (§4.1 is never a union):
#: a profile that genuinely lacks ``terminal`` does not get it granted.
#: ``kanban`` guarantees the lifecycle tools (complete/block/comment) are
#: loaded even on configurations where HERMES_KANBAN_TASK's auto-append
#: path changes.
CARD_TOOLSET_FLOOR: tuple[str, ...] = (
    "kanban",
    "file",
    "terminal",
    "clarify",
    "todo",
)


def resolve_card_toolsets(
    requested: Sequence[str], enabled: Sequence[str]
) -> tuple[Optional[List[str]], List[str]]:
    """The tool surface stamped on one run card.

    ``requested`` is the step's declared ``toolsets`` falling back to the
    project's ``toolsets`` column — empty means "no opinion", the worker
    keeps the profile's full surface (``None``). Otherwise the effective
    set is ``enabled ∩ requested`` plus the :data:`CARD_TOOLSET_FLOOR`
    members the profile enables. Returns ``(stamped_or_None, dropped)``.
    """
    if not requested:
        return None, []
    effective, dropped = resolve_toolsets(requested, enabled)
    for floor in CARD_TOOLSET_FLOOR:
        if floor in enabled and floor not in effective:
            effective.append(floor)
    return effective or None, dropped


def resolve_skills(
    requested: Sequence[str],
    available: Sequence[str],
    max_skills: int = DEFAULT_MAX_SKILLS,
) -> tuple[List[str], List[str], bool]:
    """Skills are prompt bytes: cap + resolve through the host loader
    (§4.1 rule 2). Returns ``(effective, dropped, truncated)``."""
    if not requested:
        return [], [], False
    available_set = set(available)
    kept = [s for s in requested if s in available_set]
    dropped = [s for s in requested if s not in available_set]
    truncated = len(kept) > max_skills
    return kept[:max_skills], dropped, truncated


# ---------------------------------------------------------------------------
# §5.2 — the compiled guidance block
# ---------------------------------------------------------------------------

def compile_guidance(
    project: projects_db.Project,
    *,
    run_no: int,
    outputs: List[dict],
    deliveries_by_output: Dict[str, List[dict]],
    sample_links: List[dict],
    directives: List[dict],
    last_run: Optional[dict] = None,
    cfg: Optional[Dict[str, Any]] = None,
    clarify_lines: Optional[List[str]] = None,
) -> str:
    """Assemble the §5.2 block in its fixed order.

    Hard rules enforced here:
    - empty optional sections are omitted **with their heading**;
    - outputs come before instructions and are never truncated —
      truncation eats the brief, then the directives, then the agreed
      scope (``clarify_lines``) instead;
    - directives are capped, newest first, dated and attributed;
    - the compiled block is capped at ``guidance_max_chars``.
    """
    cfg = cfg or projects_runtime_config()
    lines: List[str] = []

    lines.append(f"## Project: {project.name}")
    lines.append(f"Goal: {project.goal}")
    cadence = "one-off" if project.cadence == "one_off" else "repeatable"
    lines.append(
        f"Run {run_no} · {cadence} · autonomy: {project.autonomy or 'supervised'}"
    )
    dod = (project.definition_of_done or "").strip()
    lines.append(
        f"Definition of done: {dod or 'all required outputs accepted'}"
    )

    brief_lines: List[str] = []
    description = (project.description or "").strip()
    if description:
        limit = cfg["brief_max_chars"]
        if len(description) > limit:
            description = (
                description[:limit].rstrip()
                + f"\n…[truncated — see `hermes projects show {project.slug}` "
                "for the rest]"
            )
        brief_lines = ["", "### Brief", description]

    audience_lines: List[str] = []
    audience = (project.target_audience or "").strip()
    if audience:
        audience_lines = ["", "### Audience", audience]

    output_lines: List[str] = ["", "### Outputs expected of this run"]
    any_output = False
    for out in outputs:
        any_output = True
        deliveries = deliveries_by_output.get(out["id"]) or []
        delivered_run = next(
            (d for d in deliveries if d.get("run_no")), None
        )
        flags: List[str] = []
        if out.get("required"):
            flags.append("required")
        if out.get("recurring"):
            flags.append("recurring")
        suffix = f" ({', '.join(flags)})" if flags else ""
        if delivered_run is not None:
            output_lines.append(
                f"- [x] {out['title']} (delivered run {delivered_run['run_no']})"
            )
        else:
            spec = (out.get("spec") or "").strip()
            spec_part = f" — {spec}" if spec else ""
            output_lines.append(f"- [ ] {out['title']}{spec_part}{suffix}")
    if not any_output:
        output_lines = []

    sample_lines: List[str] = []
    if sample_links:
        sample_lines = ["", "### Samples to match"]
        for link in sample_links:
            label = link.get("label") or link.get("ref")
            sample_lines.append(f"- {label} → {link.get('ref')}")

    scope_lines: List[str] = ["", *clarify_lines] if clarify_lines else []

    directive_lines: List[str] = []
    cap = cfg["guidance_max_directives"]
    active = [d for d in directives if d.get("active")]
    active = active[:cap]  # already newest-first from the store
    if active:
        directive_lines = ["", "### Standing instructions (newest first)"]
        for i, d in enumerate(active, 1):
            directive_lines.append(
                f"{i}. {d['body']} [{d.get('author_user_id') or '?'}, "
                f"{_epoch_day(d.get('created_at'))}]"
            )

    retro_lines: List[str] = []
    if last_run and (last_run.get("retro") or "").strip():
        retro_lines = ["", "### What we learnt last run"]
        score = last_run.get("score_user") or last_run.get("score_self")
        score_part = f" (score: {score}/5)" if score else ""
        note = (last_run.get("score_note") or "").strip()
        note_part = f' — "{note}"' if note else ""
        retro_lines.append(
            f"Run {last_run.get('run_no')}:{score_part}{note_part} "
            f"{last_run['retro'].strip()}"
        )

    # Fixed order: header/brief/audience first, outputs before instructions,
    # samples after outputs, the agreed scope, then directives, then the retro.
    header = lines
    block_parts = [
        "\n".join(header),
        *[
            "\n".join(part)
            for part in (
                brief_lines,
                audience_lines,
                output_lines,
                sample_lines,
                scope_lines,
                directive_lines,
                retro_lines,
            )
            if part
        ],
    ]
    block = "\n".join(block_parts)

    # Cap: never the outputs list. Eat the brief, then the directives,
    # then the agreed scope.
    limit = cfg["guidance_max_chars"]
    if len(block) > limit and brief_lines:
        over = len(block) - limit
        brief_lines = [
            "",
            "### Brief",
            description[: max(0, len(description) - over)].rstrip()
            + "\n…[truncated to fit the guidance budget]",
        ]
        block = _rejoin(
            header, brief_lines, audience_lines, output_lines,
            sample_lines, scope_lines, directive_lines, retro_lines,
        )
    if len(block) > limit and directive_lines:
        while len(block) > limit and len(directive_lines) > 3:
            directive_lines.pop()
        directive_lines.append("…[further standing instructions omitted]")
        block = _rejoin(
            header, brief_lines, audience_lines, output_lines,
            sample_lines, scope_lines, directive_lines, retro_lines,
        )
    if len(block) > limit and scope_lines:
        scope_lines = _trim_scope_lines(scope_lines, len(block) - limit)
        block = _rejoin(
            header, brief_lines, audience_lines, output_lines,
            sample_lines, scope_lines, directive_lines, retro_lines,
        )
    return block


def _trim_scope_lines(scope_lines: List[str], over: int) -> List[str]:
    """Shed ``over`` chars from the agreed-scope section: Q→A lines go
    newest-first, then the understanding is shortened. A heading left with
    nothing under it is dropped; nothing left at all returns ``[]``."""
    marker = projects_clarify_context.OMITTED_MARKER
    scope_h = projects_clarify_context.SCOPE_HEADING
    qa_heads = (
        projects_clarify_context.CLARIFICATIONS_HEADING,
        projects_clarify_context.PENDING_HEADING,
    )
    target = len("\n".join(scope_lines)) - over
    lines = [ln for ln in scope_lines if ln != marker]
    trimmed = len(lines) != len(scope_lines)

    def _pair_indices() -> List[int]:
        section, found = None, []
        for i, ln in enumerate(lines):
            if ln.startswith("### "):
                section = ln
            elif section in qa_heads and ln.startswith("- "):
                found.append(i)
        return found

    pairs = _pair_indices()
    while pairs and len("\n".join(lines + [marker])) > target:
        del lines[pairs.pop()]
        trimmed = True

    out: List[str] = []
    for j, ln in enumerate(lines):
        if ln in qa_heads:
            nxt = lines[j + 1] if j + 1 < len(lines) else ""
            if not nxt.startswith("- "):
                if out and out[-1] == "":
                    out.pop()
                continue
        out.append(ln)
    if scope_h not in out and not any(ln in qa_heads for ln in out):
        return []
    if trimmed:
        out.append(marker)
    if len("\n".join(out)) > target and scope_h in out:
        i = out.index(scope_h) + 1
        if i < len(out):
            note = "…[truncated to fit the guidance budget]"
            keep = len(out[i]) - (len("\n".join(out)) - target) - len(note)
            out[i] = out[i][: max(0, keep)].rstrip() + note
    return out


def _rejoin(*parts: List[str]) -> str:
    return "\n".join("\n".join(p) for p in parts if p)


# ---------------------------------------------------------------------------
# §7 — playbook instantiation onto the board
# ---------------------------------------------------------------------------

def held_step_keys(steps: Sequence[dict]) -> set:
    """Keys that succeed a ``checkpoint`` step — held until the human
    passes the checkpoint (§7.1)."""
    checkpoints = {s["key"] for s in steps if s.get("checkpoint")}
    return {
        s["key"] for s in steps if set(s.get("depends_on") or []) & checkpoints
    }


def checkpoint_wait_info(
    conn, project: projects_db.Project, run: dict, cards: List[dict]
) -> Optional[dict]:
    """Which checkpoint is holding this run right now, if any (§7.1).

    A supervised run whose checkpoint step(s) are done while their
    successors still sit in triage is held on the human's continue — the
    row itself keeps saying ``running`` (nothing turns it to ``waiting``
    when a checkpoint card finishes), so both *whether* it's held and
    *which* card is causing it are derived here from the playbook + board
    state, never stored. ``cards`` is the run's own card list, each with
    at least ``step_key``, ``task_id``, ``status``, ``title`` — the same
    shape ``_run_payload`` (projects_api.py) and the reconcile sweep
    already build.

    Returns ``None`` when nothing is currently held, otherwise the
    checkpoint card (the one a human needs to look at) plus every
    successor step still waiting on it — a playbook can chain more than
    one checkpoint, though one is the common case.
    """
    if run.get("status") not in ("running", "waiting") or not cards:
        return None
    if (getattr(project, "autonomy", None) or "supervised") != "supervised":
        return None
    playbook = projects_db.get_playbook(conn, project.id, rev=run.get("playbook_rev"))
    steps = (playbook or {}).get("steps") or []
    held = held_step_keys(steps)
    if not held:
        return None
    checkpoints = {s["key"] for s in steps if s.get("checkpoint")}
    deps_of = {s["key"]: set(s.get("depends_on") or []) for s in steps}
    status_of = {c.get("step_key"): c.get("status") for c in cards}
    task_of = {c.get("step_key"): c.get("task_id") for c in cards}
    title_of = {c.get("step_key"): c.get("title") for c in cards}
    # A held successor is waiting *right now* iff its OWN gating
    # checkpoint(s) are done — an EARLIER regression here checked whether
    # every checkpoint anywhere in the playbook was done before
    # considering anything held, so a playbook with two checkpoints (this
    # project's) had its first, already-finished checkpoint's hold masked
    # by the second, still-open one — the run looked "not held" and got
    # auto-failed as stale a second time even though a card was
    # genuinely, correctly waiting on a human (2026-09-14 recurrence).
    held_now = [
        key
        for key in held
        if status_of.get(key) == "triage"
        and (gating := deps_of.get(key, set()) & checkpoints)
        and all(status_of.get(c) == "done" for c in gating)
    ]
    # A checkpoint card can itself be the thing waiting on a human:
    # `blocked` is the deliberate review-required handoff the worker
    # prompt teaches (sticky until an operator unblocks it), and a
    # checkpoint still in `triage` after its own deps settled is awaiting
    # approval to start. Same hold, different shape — without it the
    # stale-run sweep auto-fails a correctly paused run (found in
    # production 2026-10-02: the review checkpoint blocked for human
    # review, the run was auto-failed two hours later mid-wait, and every
    # card then completed under a "failed" run).
    engaged = sorted(
        key
        for key in checkpoints
        if status_of.get(key) == "blocked"
        or (
            status_of.get(key) == "triage"
            and all(
                status_of.get(d) in ("done", "archived")
                for d in deps_of.get(key, set())
            )
        )
    )
    if not held_now and not engaged:
        return None
    # The specific checkpoint step(s) gating the currently-held successors
    # — the thing a human actually needs to go look at.
    causing = sorted(
        set(engaged)
        | {
            dep
            for key in held_now
            for dep in deps_of.get(key, set())
            if dep in checkpoints
        }
    )
    held_keys = sorted(
        set(held_now)
        | {
            key
            for key in held
            for dep in engaged
            if dep in deps_of.get(key, set())
            and status_of.get(key) not in ("done", "archived", "failed", "cancelled")
        }
    )
    checkpoint_key = causing[0] if causing else None
    return {
        "checkpoint_step_key": checkpoint_key,
        "checkpoint_task_id": task_of.get(checkpoint_key),
        "checkpoint_title": title_of.get(checkpoint_key),
        "held_step_keys": held_keys,
        "held_task_ids": [task_of[k] for k in held_keys if task_of.get(k)],
    }


def run_awaits_continue(conn, project, run: dict, cards: List[dict]) -> bool:
    """Cheap boolean form of :func:`checkpoint_wait_info` — what the run
    page's existing ``awaiting_continue`` flag has always meant."""
    return checkpoint_wait_info(conn, project, run, cards) is not None


def host_profile_name(pconn, project_id: str) -> Optional[str]:
    profiles = projects_db.get_project_profiles(pconn, project_id)
    for p in profiles:
        if p.get("role") == "host":
            return p["profile"]
    return profiles[0]["profile"] if profiles else None


def instantiate_run_cards(
    bconn,
    pconn,
    *,
    project: projects_db.Project,
    run_id: str,
    run_no: int,
    steps: Sequence[dict],
    created_by: str,
    card_toolsets: Optional[Dict[str, List[str]]] = None,
) -> Dict[str, Any]:
    """Write every step as a card carrying ``project_id`` + parent links,
    then record the run → card mapping (§7.1). Cards are always CREATED in
    ``triage`` — promotion is a separate, autonomy-aware step — and never
    ``ready``/``running`` at creation (the store would refuse it anyway).

    ``card_toolsets`` maps step keys to the tool surface already resolved
    for that card (see :func:`resolve_card_toolsets`); absent or a missing
    key means the worker gets the assignee profile's full CLI surface.

    Returns ``{"cards": {step_key: task_id}, "inline": [step, ...]}``.
    """
    card_ids: Dict[str, str] = {}
    inline_steps: List[dict] = []
    profiles = projects_db.get_project_profiles(pconn, project.id)
    profile_names = {p["profile"] for p in profiles}
    host = host_profile_name(pconn, project.id)

    for step in steps:
        if step.get("mode") == "inline":
            inline_steps.append(step)
            continue
        assignee = step.get("assignee") or host
        if assignee and profile_names and assignee not in profile_names:
            # A bad playbook stalls visibly instead of running under a
            # surprise profile (§7.1).
            raise ValueError(
                f"step {step['key']!r}: assignee {assignee!r} is not one of "
                f"the project's profiles {sorted(profile_names)}"
            )
        body = step.get("body") or ""
        tid = kanban_db.create_task(
            bconn,
            title=step["title"],
            body=(
                f"{body}\n\n(project: {project.slug} · run {run_no} · "
                f"step `{step['key']}`)"
            ).strip(),
            assignee=assignee,
            created_by=created_by,
            triage=True,
            board=project.board_slug or None,
            project_id=project.id,
            owner_user_id=created_by,
            visibility="shared",
            toolsets=(card_toolsets or {}).get(step["key"]),
        )
        card_ids[step["key"]] = tid

    for step in steps:
        if step.get("mode") == "inline":
            continue
        child = card_ids[step["key"]]
        for dep in step.get("depends_on") or []:
            parent = card_ids.get(dep)
            if parent:
                kanban_db.link_tasks(bconn, parent_id=parent, child_id=child)

    for key, tid in card_ids.items():
        projects_db.link_run_card(pconn, run_id, tid, step_key=key)

    return {"cards": card_ids, "inline": inline_steps}


def _project_in_flight(bconn, project: projects_db.Project) -> int:
    """Cards in ``running`` + ``ready`` — what ``max_in_progress`` caps."""
    tasks = kanban_db.list_tasks(bconn, project_id=project.id)
    return sum(1 for t in tasks if t.status in ("running", "ready"))


def promote_run_cards(
    bconn,
    pconn,
    *,
    project: projects_db.Project,
    run_id: str,
    steps: Sequence[dict],
    autonomy: str,
    held: set,
    force_held: bool = False,
) -> List[str]:
    """Move this run's triage cards to ``todo`` per §4.

    - ``manual``: nothing is ever promoted by a run — a human holds every
      gate. There is no path that silently promotes a manual project.
    - ``supervised``: steps not held by a checkpoint are promoted; the
      checkpoint's successors wait for an explicit continue.
    - ``autonomous``: every step (checkpoints still raise an approval on
      completion — autonomy never waives FG-10).

    ``force_held`` is set by the human "continue" act, which passes the
    checkpoint and releases its successors.

    The ``max_in_progress`` cap is enforced here — the project's own
    promotion step, never by patching the shared dispatcher: count cards in
    running + ready, promote at most up to the cap.

    Candidate order matters when the cap is narrower than the playbook:
    ``get_run_cards()`` has no natural order (SQLite returns
    ``project_run_cards`` rows by primary key, i.e. by ``task_id`` — random
    relative to the playbook). Promoting whichever triage card happens to
    sort first can pick a step whose own dependency was never promoted,
    which then can never reach ``ready`` — deadlocking the run on a step
    that is not even the one blocking progress, while the real
    dependency-free root never gets a turn (found in production, 2026-09).
    So candidates are (a) split into dependency-satisfied vs. not, ready
    ones first, and (b) ordered by playbook position as the deterministic
    tie-break within each group, instead of by the incidental DB order.
    """
    if autonomy == "manual":
        return []
    by_key = {s["key"]: s for s in steps if s.get("mode") != "inline"}
    run_cards = projects_db.get_run_cards(pconn, run_id)
    key_of = {rc["task_id"]: rc.get("step_key") for rc in run_cards}

    cap = project.max_in_progress
    room = None
    if cap:
        room = max(0, int(cap) - _project_in_flight(bconn, project))
        if room == 0:
            return []

    task_ids = list(key_of.keys())
    status_by_task: Dict[str, str] = {}
    if task_ids:
        placeholders = ",".join("?" for _ in task_ids)
        rows = bconn.execute(
            f"SELECT id, status FROM tasks WHERE id IN ({placeholders})",
            task_ids,
        ).fetchall()
        status_by_task = {row["id"]: row["status"] for row in rows}
    status_by_key = {
        key_of[tid]: status
        for tid, status in status_by_task.items()
        if key_of.get(tid)
    }

    def _deps_satisfied(step_key: str) -> bool:
        step = by_key.get(step_key)
        deps = (step.get("depends_on") if step else None) or []
        return all(status_by_key.get(dep) == "done" for dep in deps)

    eligible: List[tuple] = []
    for rc in run_cards:
        key = key_of.get(rc["task_id"]) or rc.get("step_key")
        if key is None or key not in by_key:
            continue
        if key in held and not force_held:
            continue
        if status_by_task.get(rc["task_id"]) != "triage":
            continue
        eligible.append((rc["task_id"], key))

    order_index = {s["key"]: i for i, s in enumerate(steps)}
    eligible.sort(key=lambda pair: order_index.get(pair[1], len(steps)))
    eligible.sort(key=lambda pair: 0 if _deps_satisfied(pair[1]) else 1)

    promoted: List[str] = []
    for task_id, _key in eligible:
        if room is not None and len(promoted) >= room:
            break
        if kanban_db.specify_triage_task(bconn, task_id):
            promoted.append(task_id)
    return promoted


# ---------------------------------------------------------------------------
# §6.1 — deliveries, outcome and closure
# ---------------------------------------------------------------------------

def derive_run_outcome(
    pconn, *, project_id: str, run_id: str
) -> tuple[str, str]:
    """Machine-set outcome on close (§6.1 table), from deliveries."""
    outputs = projects_db.get_project_outputs(pconn, project_id)
    deliveries = projects_db.get_output_deliveries(pconn, run_id=run_id)
    delivered_ids = {d["output_id"] for d in deliveries}
    required = [o for o in outputs if o.get("required")]
    required_done = [o for o in required if o["id"] in delivered_ids]
    if required:
        if len(required_done) == len(required):
            return "delivered", (
                f"all {len(required)} required output(s) delivered"
            )
        if required_done:
            missing = ", ".join(
                o["title"] for o in required if o["id"] not in delivered_ids
            )
            return "partial", (
                f"delivered {len(required_done)} of {len(required)} "
                f"required output(s); missing: {missing}"
            )
        return "no_output", (
            "run completed but delivered no required output — the outputs "
            "exist to record that; deliver them or drop them"
        )
    if delivered_ids:
        return "delivered", f"{len(delivered_ids)} output(s) delivered"
    return "done", "no outputs were expected of this run"


def close_run(
    pconn,
    *,
    run: dict,
    status: str = "done",
    summary: Optional[str] = None,
    error: Optional[str] = None,
    outcome: Optional[str] = None,
) -> dict:
    """Close a run: terminal status + outcome; the spawn-time toolset
    prelude in ``summary`` survives an agent-supplied summary."""
    if outcome is None and status == "done":
        _, outcome = derive_run_outcome(pconn, project_id=run["project_id"], run_id=run["id"])
    prelude = (run.get("summary") or "").strip()
    merged = None
    if summary:
        merged = f"{prelude}\n\n{summary}".strip() if prelude else summary
    elif prelude:
        merged = prelude
    projects_db.close_project_run(
        pconn, run["id"], status=status, outcome=outcome,
        summary=merged, error=error,
    )
    return projects_db.get_project_run_by_id(pconn, run["id"])


# ---------------------------------------------------------------------------
# The run's human seams: approvals (FG-10) and cost (C8 ledger)
# ---------------------------------------------------------------------------

def _approval_store(app_store, *, config):
    """Seam over the FG-10 store construction so the default is testable."""
    from hermes_cli.human_comms import NotificationStore

    return NotificationStore(app_store, config=config)


async def _push_approval(*, title: str, body: str, url: str, tag: str) -> None:
    """Best-effort Web Push for a just-raised approval (§7.1/§12).

    The in-app notification bell already has the item the moment
    ``store.create`` returns — this is the *courtesy* that means a person
    doesn't have to have the app open to find out. Reuses the app
    platform's existing push sender (VAPID keys + device subscriptions
    already live there for chat delivery); a missing/unconfigured plugin,
    no enrolled devices, or a transport failure is never an error here —
    the approval itself is already durably stored either way.
    """
    try:
        from plugins.platforms.app.push import send_push
    except Exception:
        return  # the app platform plugin isn't installed on this box
    try:
        await send_push(tag, title=title, body=body, url=url)
    except Exception:
        log.debug("projects: push notification for %r failed", tag, exc_info=True)


def raise_approval(
    project: projects_db.Project,
    run: dict,
    reason: str,
    *,
    kind: str = "checkpoint",
    dedupe_suffix: Optional[str] = None,
    url: Optional[str] = None,
) -> None:
    """Checkpoint / budget-stop approval through the shipped FG-10 surface,
    with a best-effort push notification alongside it.

    Raised with ``reversible=False`` so C6 never auto-answers it (§4: a
    supervised run holds until a human passes the checkpoint). There is no
    fail-open on the *approval* itself — a swallowed approval is worse
    than a failed start, so a store failure logs at ERROR and propagates.
    The push is a courtesy on top and never raises: a person who never
    enrolled a device (or is offline) still has the durable approval row
    and the run page itself, which is why §12's UI must never depend on
    the push having been delivered.

    ``dedupe_suffix`` distinguishes more than one hold of the same
    ``kind`` within a run (e.g. a playbook with two checkpoints) — without
    it every hold of that kind in the run collapses onto one dedupe key.
    ``url`` is the deep link the push opens straight into; defaults to the
    run's own page.
    """
    target = project.owner_user_id
    if not target:
        raise RuntimeError(
            f"project '{project.slug}' has no owner_user_id — cannot raise "
            "a run approval"
        )
    run_no = run.get("run_no")
    link = url or f"/projects/{project.slug}/runs/{run_no}"
    dedupe_key = f"proj:{project.slug}:run:{run_no}:{kind}"
    if dedupe_suffix:
        dedupe_key = f"{dedupe_key}:{dedupe_suffix}"
    title = f"Project '{project.name}' run {run_no} needs you ({kind})"

    async def _raise() -> None:
        from hermes_cli.config import load_config
        from hermes_cli.datastore import get_store

        resolved = load_config() or {}
        app_store = get_store("supabase-app", "prod", config=resolved)
        store = _approval_store(app_store, config=resolved)
        await store.initialize()
        result = await store.create(
            kind="approval",
            target_user_id=target,
            title=title,
            body=reason,
            reversible=False,
            dedupe_key=dedupe_key,
        )
        # A re-raise onto an already-pending item is not a new event — the
        # human already has one notification for it; pushing again would
        # just be noise for something they haven't acted on yet.
        if getattr(result, "created", True):
            await _push_approval(title=title, body=reason, url=link, tag=dedupe_key)

    try:
        asyncio.run(_raise())
    except Exception:
        log.error(
            "projects: approval NOT raised for %s run %s (%s) — the "
            "approval surface failed; refusing to continue silently",
            project.slug, run.get("run_no"), reason, exc_info=True,
        )
        raise


_COST_AMOUNT_RE = re.compile(r"amount_usd=([0-9]*\.?[0-9]+)")


def _cost_from_interactions(interactions) -> Optional[float]:
    """Sum a trace's ``cost`` events. The ledger stores no cost column: the
    adapters emit ``kind='cost'`` with ``amount_usd=…`` in the summary."""
    total = 0.0
    seen = False
    for item in interactions:
        if item.kind != "cost":
            continue
        match = _COST_AMOUNT_RE.search(item.summary or "")
        if match:
            seen = True
            total += float(match.group(1))
    return total if seen else None


def _owner_principal(project: projects_db.Project):
    """A read principal scoped to the project owner — the trace's actor."""
    from hermes_cli.access import Principal

    owner = project.owner_user_id or ""
    return Principal(user_id=owner, display=owner, role="member")


def _default_cost_reader(trace_id: str, principal) -> Optional[float]:
    """The shipped reader: ``InteractionLedger.get_trace`` (§6 — cost is
    never stored). Fail-open: a broken observability path reads as "not
    recorded"; a run must never fail because observability is off."""

    async def _read() -> Optional[float]:
        from hermes_cli.config import load_config
        from hermes_cli.datastore import SupabaseAppStore, get_store
        from hermes_cli.interactions import InteractionLedger

        resolved = load_config() or {}
        store = get_store("supabase-app", "prod", config=resolved)
        if not isinstance(store, SupabaseAppStore) or not store.dsn:
            return None
        ledger = InteractionLedger(store, config=resolved)
        interactions, _rollup = await ledger.get_trace(trace_id, principal)
        return _cost_from_interactions(interactions)

    try:
        return asyncio.run(_read())
    except Exception:  # noqa: BLE001 — cost is observability, never fatal
        log.warning(
            "projects: cost read failed for trace %s — not recorded",
            trace_id, exc_info=True,
        )
        return None


def run_cost(
    trace_id: Optional[str],
    *,
    reader: Optional[Callable] = None,
    principal=None,
):
    """Cost of a run, read from the C8 ledger — never stored (§6).

    Fail-open contract: no trace, no ledger, or no read principal →
    ``None`` ("not recorded"); a run must never fail because observability
    is off. An injected ``reader`` always wins — it is the test/override
    seam and may map an untraced run to a number.
    """
    if reader is not None:
        try:
            return reader(trace_id)
        except Exception:  # noqa: BLE001
            return None
    if not trace_id:
        return None
    if principal is None:
        return None
    return _default_cost_reader(trace_id, principal)


def budget_gate(
    project: projects_db.Project, run: dict, *, reader: Optional[Callable] = None
) -> Optional[str]:
    """``budget_usd_per_run`` crossed → the run stops promoting and waits;
    one approval is raised. Never kills a card mid-flight (§4)."""
    budget = project.budget_usd_per_run
    if not budget:
        return None
    cost = run_cost(
        run.get("trace_id"), reader=reader, principal=_owner_principal(project)
    )
    if cost is None or float(cost) <= float(budget):
        return None
    reason = (
        f"run {run.get('run_no')} of project '{project.name}' has spent "
        f"${float(cost):.2f}; budget is ${float(budget):.2f} per run — continue?"
    )
    raise_approval(project, run, reason, kind="budget")
    return reason


# ---------------------------------------------------------------------------
# §6 — the run lifecycle orchestration
# ---------------------------------------------------------------------------

def _mint_run_trace(project: projects_db.Project, *, run_no: int, config):
    """Mint the run's C8 trace — off-gateway surfaces pass ``mode='prod'``.

    Returns ``(trace, ledger)``; ``(None, None)`` when action tracking is
    disabled or the app store is not configured — then the run row carries
    no trace and the budget gate has no numbers to enforce with.
    """
    try:
        from hermes_cli import interactions

        return interactions.create_trace(
            config=config,
            actor_user_id=project.owner_user_id or "",
            session_key=f"projects:{project.slug}:run-{run_no}",
            platform="projects",
            mode="prod",
        )
    except Exception:  # noqa: BLE001 — observability must never break a run
        log.warning(
            "projects: C8 trace mint failed for %s run %s — budget not "
            "enforceable for this run",
            project.slug, run_no, exc_info=True,
        )
        return None, None


def start_run(
    pconn,
    bconn,
    *,
    project: projects_db.Project,
    trigger: str = "manual",
    triggered_by: Optional[str] = None,
    playbook_rev: Optional[int] = None,
    spawn_inline: Optional[Callable] = None,
    cost_reader: Optional[Callable] = None,
) -> Dict[str, Any]:
    """Open a run and bring up its cards + guidance (§6 pipeline).

    The run pins its ``playbook_rev`` (§7.2), compiles the guidance block
    once (§5.1), instantiates the playbook onto the board, promotes per
    autonomy, and — when the playbook has ``mode: 'inline'`` steps —
    spawns ONE seeded session for them through the shared spawn path.
    """
    if project.status not in ("active",):
        raise ValueError(
            f"project '{project.slug}' is '{project.status}': only an active "
            "project may run"
        )

    if trigger == "schedule":
        waits = project_human_waits(bconn, project)
        if waits:
            last = projects_db.list_project_runs(pconn, project.id, limit=1)
            if last:
                notify_waiting_on_you(
                    project, last[0], waits[0],
                    lead="A scheduled run was skipped:",
                )
            log.info(
                "projects: scheduled run of %s skipped — card %s waits on a person",
                project.slug, waits[0]["task_id"],
            )
            raise ScheduledRunSkipped(waits[0])

    playbook = projects_db.get_playbook(pconn, project.id, rev=playbook_rev)
    if playbook is None:
        raise ValueError(
            f"project '{project.slug}' has no playbook"
            + (f" revision {playbook_rev}" if playbook_rev else " — save one first")
        )
    steps = playbook.get("steps") or []
    if not steps:
        raise ValueError("the playbook has no steps")

    host = host_profile_name(pconn, project.id)
    if not host:
        raise ValueError("the project has no profiles — add one before running")

    run = projects_db.open_project_run(
        pconn,
        project_id=project.id,
        trigger=trigger,
        triggered_by=triggered_by,
        profile=host,
        playbook_rev=playbook["rev"],
    )

    # §6 + C8: the run binds a REAL trace so its cost is readable through
    # the ledger (never stored). Without tracing there is no trace id and
    # the budget gate has nothing to enforce with.
    try:
        from hermes_cli.config import load_config

        full_cfg = load_config() or {}
    except Exception:  # noqa: BLE001 — observability config is advisory
        full_cfg = {}
    trace, ledger = _mint_run_trace(project, run_no=run["run_no"], config=full_cfg)
    if trace is not None:
        projects_db.update_project_run(pconn, run["id"], trace_id=trace.trace_id)
        run = dict(run, trace_id=trace.trace_id)

    # §4.1 — narrowing filter; drops are recorded on the run, never silent.
    cfg = projects_runtime_config()
    enabled = _enabled_toolsets_for_profile(host)
    requested = parse_csv_field(project.toolsets)
    effective, ts_dropped = resolve_toolsets(requested, enabled)
    available = _available_skill_names(host)
    req_skills = parse_csv_field(project.skills)
    eff_skills, sk_dropped, sk_truncated = resolve_skills(
        req_skills, available, cfg["max_skills"]
    )
    prelude_bits: List[str] = []
    if ts_dropped:
        prelude_bits.append(
            "Toolsets requested but NOT enabled by host profile "
            f"'{host}' (dropped): {', '.join(ts_dropped)}"
        )
    # Per-card tool surface: a step's declared ``toolsets`` narrows the
    # worker's prompt (fewer tool schemas per API call). Step wins over
    # the project's ``toolsets`` column; neither = full profile surface.
    card_toolsets: Dict[str, List[str]] = {}
    for step in steps:
        if step.get("mode") == "inline":
            continue
        step_own = parse_csv_field(step.get("toolsets"))
        stamped, step_dropped = resolve_card_toolsets(
            step_own or requested, enabled
        )
        if stamped is not None:
            card_toolsets[step["key"]] = stamped
        # Inherited drops are already named by the project-level line
        # above; only a step's own request earns a per-step note.
        if step_own and step_dropped:
            prelude_bits.append(
                f"Step '{step['key']}' toolsets not enabled by host "
                f"profile '{host}' (dropped): {', '.join(step_dropped)}"
            )
    if sk_dropped:
        prelude_bits.append(
            f"Skills not found in host profile (dropped): {', '.join(sk_dropped)}"
        )
    if sk_truncated:
        prelude_bits.append(
            f"Skills capped at {cfg['max_skills']} (projects.max_skills); "
            "the remainder was not preloaded"
        )
    if prelude_bits:
        projects_db.update_project_run(
            pconn, run["id"], summary="; ".join(prelude_bits)
        )
        run = projects_db.get_project_run_by_id(pconn, run["id"])

    guidance = compile_guidance(
        project,
        run_no=run["run_no"],
        outputs=projects_db.get_project_outputs(pconn, project.id),
        deliveries_by_output=_deliveries_by_output(pconn, project.id),
        sample_links=_sample_links(pconn, project.id),
        directives=projects_db.list_project_directives(pconn, project.id),
        last_run=_previous_run(pconn, project.id, run["run_no"]),
        cfg=cfg,
        clarify_lines=projects_clarify_context.clarify_context_lines(
            pconn, project.id
        ),
    )

    made = instantiate_run_cards(
        bconn,
        pconn,
        project=project,
        run_id=run["id"],
        run_no=run["run_no"],
        steps=steps,
        created_by=triggered_by or "projects",
        card_toolsets=card_toolsets,
    )
    held = held_step_keys(steps)
    autonomy = project.autonomy or "supervised"
    if autonomy == "autonomous":
        # §4 table: autonomous has no checkpoint holds — every step moves.
        held = set()
    promoted = promote_run_cards(
        bconn,
        pconn,
        project=project,
        run_id=run["id"],
        steps=steps,
        autonomy=autonomy,
        held=held,
    )
    if autonomy != "manual" and held:
        raise_approval(
            project,
            run,
            f"run {run['run_no']}: checkpoint step(s) "
            f"{sorted({s['key'] for s in steps if s.get('checkpoint')})} "
            "hold their successors until you continue",
        )

    session_info: Dict[str, Any] = {}
    if made["inline"]:
        from hermes_cli import interactions

        spawner = spawn_inline or _default_spawn_inline
        # The run's session binds the run's trace (contextvar), so its
        # tool calls + cost events land under it; ``copy_context()`` in
        # the spawn carries the binding into the session thread.
        with interactions.bind_trace(trace):
            session_info = spawner(
                project=project,
                run=run,
                guidance=guidance,
                inline_steps=made["inline"],
                enabled_toolsets=effective or None,
            )
        if session_info.get("session_id"):
            projects_db.update_project_run(
                pconn, run["id"], session_id=session_info["session_id"]
            )
    if trace is not None and ledger is not None:
        try:
            asyncio.run(ledger.flush(trace))
        except Exception:  # noqa: BLE001 — observability, never fatal
            log.warning(
                "projects: C8 trace flush failed for %s run %s — cost "
                "reads as not recorded",
                project.slug, run.get("run_no"), exc_info=True,
            )

    gate = budget_gate(project, run, reader=cost_reader)
    if gate:
        projects_db.update_project_run(pconn, run["id"], status="waiting")
        run = projects_db.get_project_run_by_id(pconn, run["id"])

    return {
        "run": projects_db.get_project_run_by_id(pconn, run["id"]),
        "guidance": guidance,
        "cards": made["cards"],
        "inline_steps": [s["key"] for s in made["inline"]],
        "promoted": promoted,
        "toolsets_effective": effective,
        "toolsets_dropped": ts_dropped,
        "skills_effective": eff_skills,
        "skills_dropped": sk_dropped,
        "session": session_info,
        "budget_gate": gate,
    }


def continue_run(
    pconn,
    bconn,
    *,
    project: projects_db.Project,
    run: dict,
    cost_reader: Optional[Callable] = None,
) -> Dict[str, Any]:
    """The human passes a checkpoint or answers a budget stop (§12):
    release the held successors, move a blocked checkpoint card back to
    ready, and resume a ``waiting`` run."""
    if run["status"] in ("done", "failed", "cancelled"):
        raise ValueError(f"run {run['run_no']} is already {run['status']}")
    playbook = projects_db.get_playbook(pconn, project.id, rev=run["playbook_rev"])
    steps = (playbook or {}).get("steps") or []
    autonomy = project.autonomy or "supervised"
    held = set() if autonomy == "autonomous" else held_step_keys(steps)
    promoted = promote_run_cards(
        bconn,
        pconn,
        project=project,
        run_id=run["id"],
        steps=steps,
        autonomy=autonomy,
        held=held,
        force_held=True,
    )
    updated = run
    if run["status"] == "waiting":
        gate = budget_gate(project, run, reader=cost_reader)
        if gate:
            return {
                "run": run, "promoted": promoted, "unblocked": [],
                "budget_gate": gate,
            }
        projects_db.update_project_run(pconn, run["id"], status="running")
        updated = projects_db.get_project_run_by_id(pconn, run["id"])
    unblocked = release_blocked_checkpoints(pconn, bconn, run=run, steps=steps)
    return {
        "run": updated, "promoted": promoted, "unblocked": unblocked,
        "budget_gate": None,
    }


def release_blocked_checkpoints(
    pconn, bconn, *, run: dict, steps: Sequence[dict],
) -> List[str]:
    """Move the run's ``blocked`` checkpoint cards back to ready.

    A review checkpoint's worker often stops the card itself ("review
    requested — press Continue to approve"), and :func:`checkpoint_wait_info`
    then shows the run as waiting on Continue. Continue must release that
    card too, or it only re-promotes successors that still depend on it and
    nothing moves (found in production 2026-10-22: three Continue presses did
    nothing until the card's own Make ready). A card blocked on a pending
    tool approval is left alone: answering the approval is what releases it.
    """
    checkpoints = {s["key"] for s in steps if s.get("checkpoint")}
    if not checkpoints:
        return []
    blocked = [
        c["task_id"]
        for c in run_cards_brief(pconn, bconn, run)
        if c.get("step_key") in checkpoints and c.get("status") == "blocked"
    ]
    if not blocked:
        return []
    pending = kanban_db.list_task_approvals(bconn, blocked)
    return [
        task_id
        for task_id in blocked
        if not pending.get(task_id) and kanban_db.unblock_task(bconn, task_id)
    ]


def resume_run(
    pconn, bconn, *, project: projects_db.Project, run: dict,
) -> Dict[str, Any]:
    """Continue a ``failed``/``cancelled`` run from wherever its cards
    already are — never re-instantiates the playbook.

    This is the human's answer to "the automatic recovery gave up (Gap B's
    stale-run sweep, or a manual Stop) but the work already done is still
    good — pick up where it left off," as distinct from "Repeat this run"
    (``start_run()`` on the same method), which creates a brand-new run and
    a brand-new card for every step, redoing completed work from scratch.
    Found necessary in production: a run auto-failed after 2h of no card
    activity while a card was genuinely just rate-limited (a third-party
    API daily quota), and the only recovery available was to hand-edit the
    kanban board — see plans/2026-09-13-project-run-resilience-plan.md.

    What it does, and nothing else:
    - Reopens the run row (``status`` -> ``running``, clears
      ``outcome``/``error``/``ended_at``). Completed cards are untouched —
      they are already ``done`` on the board and this never touches
      ``instantiate_run_cards()``.
    - Unblocks any of the run's cards still sitting ``blocked`` (a human
      clicking Resume is exactly the "someone looked at this, retry it"
      signal ``hermes kanban unblock`` requires).
    - Re-runs the run's own promotion step (``promote_run_cards``) with
      ``force_held=True`` — matching ``continue_run``'s own force, because
      a card can reach ``triage`` a second time via the board's block-loop
      breaker (``BLOCK_RECURRENCE_LIMIT``) even after its checkpoint was
      already passed once; without forcing, the checkpoint-successor check
      would refuse to re-promote a step that has every right to retry.

    Refuses (``ValueError``) a run that is not ``failed``/``cancelled`` —
    ``done`` has already delivered and reopening it has no defined next
    step; ``running``/``waiting`` are already live and have their own
    actions (Cancel/Stop, Continue). Also refuses (:class:`RunAlreadyOpen`)
    while another run of the project is open — one open run at a time.
    """
    if run.get("status") not in ("failed", "cancelled"):
        raise ValueError(
            f"run {run.get('run_no')} is '{run.get('status')}' — only a "
            "failed or cancelled run can be resumed"
        )
    open_runs = projects_db.list_open_project_runs(pconn, project.id)
    if open_runs:
        raise projects_db.RunAlreadyOpen(
            open_runs[0]["run_no"], open_runs[0]["status"]
        )
    projects_db.update_project_run(
        pconn, run["id"], status="running", outcome=None, error=None,
        ended_at=None,
    )
    reopened = projects_db.get_project_run_by_id(pconn, run["id"])

    for rc in projects_db.get_run_cards(pconn, reopened["id"]):
        task = kanban_db.get_task(bconn, rc["task_id"])
        if task is not None and task.status == "blocked":
            kanban_db.unblock_task(bconn, rc["task_id"])

    playbook = projects_db.get_playbook(
        pconn, project.id, rev=reopened.get("playbook_rev")
    )
    steps = (playbook or {}).get("steps") or []
    autonomy = project.autonomy or "supervised"
    held = set() if autonomy == "autonomous" else held_step_keys(steps)
    promoted = promote_run_cards(
        bconn, pconn, project=project, run_id=reopened["id"], steps=steps,
        autonomy=autonomy, held=held, force_held=True,
    )
    return {
        "run": projects_db.get_project_run_by_id(pconn, reopened["id"]),
        "promoted": promoted,
    }


def refill_run_cards(
    pconn, bconn, *, project: projects_db.Project, run: dict
) -> List[str]:
    """Top up this run's promoted cards after a card frees ``max_in_progress``
    room (§4.1) — the completion-side counterpart to the one-shot promotion
    at ``start_run()``/``continue_run()``.

    ``promote_run_cards()`` is otherwise called from exactly those two
    places, so a run whose cap is smaller than its playbook (the default,
    ``max_in_progress=1``) promotes its first batch and then never promotes
    again on its own — it stalls until a human calls ``continue``, even
    with zero checkpoints involved. This is the hook that keeps a run
    self-propelling: called after a run-linked card leaves
    ``running``/``ready`` (done, blocked, or a dependency wait), it re-runs
    the same promotion the run started with.

    A held checkpoint's successors are never forced open here — that stays
    ``continue_run()``'s human act (``force_held`` defaults to ``False``).
    A no-op (``[]``) when the run is not ``running``, has no playbook, or
    has nothing left to promote.
    """
    if run.get("status") != "running":
        return []
    playbook = projects_db.get_playbook(pconn, project.id, rev=run.get("playbook_rev"))
    steps = (playbook or {}).get("steps") or []
    if not steps:
        return []
    autonomy = project.autonomy or "supervised"
    held = set() if autonomy == "autonomous" else held_step_keys(steps)
    return promote_run_cards(
        bconn,
        pconn,
        project=project,
        run_id=run["id"],
        steps=steps,
        autonomy=autonomy,
        held=held,
    )


def run_cards_brief(pconn, bconn, run: dict) -> List[dict]:
    """The minimal ``{step_key, task_id, status, title}`` shape
    :func:`checkpoint_wait_info` needs, built straight from the board —
    the same join ``_run_payload`` (projects_api.py) does at fuller detail,
    factored out here so the reconcile sweep and the completion hook don't
    need the HTTP layer to check a checkpoint hold."""
    cards = []
    for rc in projects_db.get_run_cards(pconn, run["id"]):
        task = kanban_db.get_task(bconn, rc["task_id"])
        cards.append(
            {
                "step_key": rc.get("step_key"),
                "task_id": rc["task_id"],
                "status": task.status if task else None,
                "title": task.title if task else None,
            }
        )
    return cards


def run_cards_all_settled(cards: List[dict]) -> bool:
    """True once every card linked to a run has left the working pipeline
    (``done`` or ``archived``) — nothing left for this run to promote or
    for a worker to still be doing."""
    return bool(cards) and all(c.get("status") in ("done", "archived") for c in cards)


def maybe_close_completed_run(
    pconn, bconn, *, project: projects_db.Project, run: dict
) -> Optional[dict]:
    """Close a run as ``done`` the instant every one of its cards has
    settled (§6.1).

    Finishing the last card was never itself the event that closes the
    run — nothing else does either, so a fully-finished run just sits
    ``running`` forever with nothing left to promote. That reads as
    *stalled* on the run page (`_run_stalled`, projects_api.py, correctly
    says no worker is active — for once, the right reason: everything is
    actually done), not as the success it is (found in production,
    2026-09-14: "7 of 7 steps done" next to a red "Failed"/"Stalled"
    badge). A no-op (``None``) unless the run is still ``running`` and
    every one of its cards has genuinely settled.
    """
    if run.get("status") != "running":
        return None
    cards = run_cards_brief(pconn, bconn, run)
    if not run_cards_all_settled(cards):
        return None
    return close_run(pconn, run=run)


#: Block kinds only a person can clear (kanban_db.VALID_BLOCK_KINDS).
HUMAN_BLOCK_KINDS = ("needs_input", "capability")


class ScheduledRunSkipped(ValueError):
    """A scheduled run would only hit a card that is already waiting on a
    person — starting it changes nothing but adds another run that stalls on
    the same wait."""

    def __init__(self, wait: dict):
        self.wait = wait
        super().__init__(
            f"scheduled run skipped — \"{wait.get('title') or wait['task_id']}\" "
            f"({wait['task_id']}) is waiting on you. Answer or unblock it; "
            "scheduled runs resume after that. A run started by hand still runs."
        )


def _human_wait(bconn, task) -> dict:
    return {
        "task_id": task.id,
        "title": task.title,
        "block_kind": task.block_kind,
        "reason": _latest_card_note(bconn, task.id),
    }


def project_human_waits(bconn, project: projects_db.Project) -> List[dict]:
    """Every card of this project blocked on a person, oldest first."""
    rows = bconn.execute(
        "SELECT id FROM tasks WHERE project_id = ? AND status = 'blocked' "
        "AND block_kind IN (?, ?) ORDER BY created_at, id",
        (project.id, *HUMAN_BLOCK_KINDS),
    ).fetchall()
    waits = []
    for row in rows:
        task = kanban_db.get_task(bconn, row["id"])
        if task is not None:
            waits.append(_human_wait(bconn, task))
    return waits


def run_human_waits(bconn, task_ids: List[str]) -> List[dict]:
    """Cards blocked on a person anywhere in a run's dependency tree — the
    run's own cards, or a card they (transitively) depend on."""
    seen: set = set()
    stack = list(task_ids)
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(kanban_db.parent_ids(bconn, node))
    waits = []
    for task_id in sorted(seen):
        task = kanban_db.get_task(bconn, task_id)
        if (
            task is not None
            and task.status == "blocked"
            and task.block_kind in HUMAN_BLOCK_KINDS
        ):
            waits.append(_human_wait(bconn, task))
    return waits


def notify_waiting_on_you(
    project: projects_db.Project, run: dict, wait: dict, *, lead: str
) -> None:
    """One approval per waiting card (deduped by card), never raises."""
    reason = f"{lead} \"{wait.get('title') or wait['task_id']}\" is waiting on you."
    if wait.get("reason"):
        reason = f"{reason}\n\n{wait['reason']}"
    try:
        raise_approval(
            project, run, reason, kind="waiting_on_you",
            dedupe_suffix=wait["task_id"],
            url=f"/projects/{project.slug}/cards/{wait['task_id']}",
        )
    except Exception:  # noqa: BLE001 — the skip/hold itself still stands
        log.warning(
            "projects: could not raise waiting-on-you approval for %s",
            project.slug, exc_info=True,
        )


def notify_if_awaiting_checkpoint(
    pconn, bconn, *, project: projects_db.Project, run: dict
) -> bool:
    """Fire the *live* "waiting on you" notification the moment this run's
    checkpoint actually engages (§7.1/§12) — as opposed to the generic
    notice ``start_run()`` raises once when the playbook is instantiated,
    long before anyone knows whether or when a checkpoint will actually be
    reached. Quotes the checkpoint card's own comment (the worker's
    findings/questions) so the push and the in-app item carry the real
    content, not just "there's a checkpoint somewhere in this playbook."

    Safe to call on every refill and every sweep tick: ``raise_approval``'s
    dedupe key is per run *and* per checkpoint step, so re-detecting the
    same hold is a no-op after the first call. Returns whether a
    checkpoint is currently held, regardless of who raised it.
    """
    info = checkpoint_wait_info(pconn, project, run, run_cards_brief(pconn, bconn, run))
    if info is None:
        return False
    comment = _latest_card_note(bconn, info.get("checkpoint_task_id"))
    reason = f"Checkpoint step \"{info.get('checkpoint_title')}\" is done and waiting on your review before its next step(s) proceed."
    if comment:
        reason = f"{reason}\n\n{comment}"
    try:
        raise_approval(
            project, run, reason, kind="checkpoint",
            dedupe_suffix=info.get("checkpoint_step_key"),
            url=f"/projects/{project.slug}/runs/{run.get('run_no')}",
        )
    except Exception:  # noqa: BLE001 — a failed-open notify must not break refill
        log.warning(
            "projects: could not raise live checkpoint approval for %s run %s",
            project.slug, run.get("run_no"), exc_info=True,
        )
    return True


def _latest_card_note(bconn, task_id: Optional[str]) -> Optional[str]:
    """The most recent thing the checkpoint card's worker said — its own
    comment if it left one, else the run summary. `None` if it left
    neither (nothing to quote)."""
    if not task_id:
        return None
    try:
        comments = kanban_db.list_comments(bconn, task_id)
        if comments:
            return comments[-1].body
        return kanban_db.latest_summary(bconn, task_id)
    except Exception:  # noqa: BLE001
        return None


def cancel_run(pconn, bconn, *, project: projects_db.Project, run: dict) -> dict:
    """Stop promoting; archive this run's un-started cards; NEVER kill a
    running worker (§12)."""
    if run["status"] in ("done", "failed", "cancelled"):
        raise ValueError(f"run {run['run_no']} is already {run['status']}")
    archived: List[str] = []
    left_running: List[str] = []
    for task_id in _run_card_subtree(pconn, bconn, run):
        row = bconn.execute(
            "SELECT status FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            continue
        if row["status"] == "running":
            left_running.append(task_id)
            continue
        if row["status"] in ("triage", "todo", "ready"):
            kanban_db.archive_task(bconn, task_id)
            archived.append(task_id)
    outcome = "cancelled"
    if left_running:
        outcome += f" ({len(left_running)} card(s) left running to finish)"
    return projects_db_close_and_fetch(
        pconn, run, status="cancelled", outcome=outcome
    )


def stop_run(pconn, bconn, *, project: projects_db.Project, run: dict) -> dict:
    """Stop the run *now*: terminate every live worker, then close it.

    The louder sibling of :func:`cancel_run`. Cancel is the polite exit —
    it stops promoting and lets a card that is already running finish,
    which is right when a person is closing a record. It is the wrong
    answer to "stop it, it is doing the wrong thing": the worker keeps
    going and the person is told the run is cancelled.

    So this one reclaims each running card — which terminates the worker
    process — and then blocks it, so the dispatcher does not simply
    respawn what was just killed. Un-started cards are archived exactly as
    cancel archives them. The outcome names both halves, because "stopped"
    without a count is the kind of sentence that gets believed.

    An *inline* run has no card to reclaim: the step runs inside the web
    server's own process. It is closed here and its late completion cannot
    reopen it (``close_project_run`` is terminal), but the turn itself
    finishes on its own — the outcome says so rather than implying a kill
    that did not happen.
    """
    if run["status"] in ("done", "failed", "cancelled"):
        raise ValueError(f"run {run['run_no']} is already {run['status']}")
    stopped: List[str] = []
    archived: List[str] = []
    for task_id in _run_card_subtree(pconn, bconn, run):
        row = bconn.execute(
            "SELECT status FROM tasks WHERE id = ?", (task_id,)
        ).fetchone()
        if row is None:
            continue
        if row["status"] == "running":
            # Reclaim first so the live worker is signalled, then block so
            # the dispatcher does not pick the card straight back up.
            # ``reclaim_task`` returns False when the card finished between
            # the read above and this line — a card that ended on its own
            # is not a worker this stop terminated, and is not counted as
            # one. It is still blocked, so nothing respawns it.
            if kanban_db.reclaim_task(
                bconn, task_id, reason="run stopped from agent-home"
            ):
                stopped.append(task_id)
            kanban_db.block_task(
                bconn, task_id, reason="run stopped from agent-home"
            )
            continue
        if row["status"] in ("triage", "todo", "ready"):
            kanban_db.archive_task(bconn, task_id)
            archived.append(task_id)
    parts = ["stopped"]
    if stopped:
        parts.append(f"{len(stopped)} worker(s) terminated")
    if archived:
        parts.append(f"{len(archived)} card(s) archived")
    if not stopped and not archived and run.get("session_id"):
        parts.append("the in-process step finishes on its own")
    return projects_db_close_and_fetch(
        pconn, run, status="cancelled", outcome="; ".join(parts)
    )


def _run_card_subtree(pconn, bconn, run: dict) -> List[str]:
    """The run's cards plus every card a worker spawned beneath them
    (``task_links`` descendants) that stayed in the same project. A worker
    that fans a step out into children leaves nothing in ``run_cards``;
    without this walk Stop archives the parent and the children keep
    running for hours, outside anything the run page shows."""
    project_id = run.get("project_id")
    ordered: List[str] = []
    seen: set = set()
    stack = [rc["task_id"] for rc in projects_db.get_run_cards(pconn, run["id"])]
    while stack:
        tid = stack.pop(0)
        if tid in seen:
            continue
        seen.add(tid)
        ordered.append(tid)
        rows = bconn.execute(
            "SELECT l.child_id FROM task_links l JOIN tasks t ON t.id = l.child_id "
            "WHERE l.parent_id = ? AND (t.project_id = ? OR t.project_id IS NULL)",
            (tid, project_id),
        ).fetchall()
        stack.extend(r["child_id"] for r in rows)
    return ordered


def projects_db_close_and_fetch(
    pconn, run: dict, *, status: str, outcome: str
) -> dict:
    projects_db.close_project_run(pconn, run["id"], status=status, outcome=outcome)
    return projects_db.get_project_run_by_id(pconn, run["id"])


# ---------------------------------------------------------------------------
# Small resolvers (lazy, fail-open)
# ---------------------------------------------------------------------------

def _enabled_toolsets_for_profile(profile: str) -> List[str]:
    """The host profile's enabled toolsets — the superset a project may
    intersect with (§4.1). Read inside the profile's runtime scope — never
    the calling process's config; an unknown profile grants nothing.

    Resolved through the same ``_get_platform_tools(cfg, "cli")`` the
    dispatcher pins on workers: composite names (``hermes-cli``) expand
    to the individual toolsets they grant, so a bare ``toolsets:
    [hermes-cli]`` profile correctly reports its real surface instead of
    one unsplittable bundle name — which would make every per-card
    intersection drop to nothing (found live, 2026-10-05).
    """
    try:
        from agent.profile_runtime import profile_runtime_scope
        from hermes_cli import profiles
        from hermes_cli.config import load_config_readonly
        from hermes_cli.tools_config import _get_platform_tools

        home = profiles.get_profile_dir(profile)
        if not home.is_dir():
            return []  # unknown profile → fail closed: no grant
        with profile_runtime_scope(home):
            cfg = load_config_readonly() or {}
        return sorted(_get_platform_tools(cfg, "cli"))
    except Exception:  # noqa: BLE001 — fail closed: no grant
        return []


def _available_skill_names(profile: str) -> List[str]:
    """Skills visible to the host profile through the shipped loader —
    scanned inside the profile's runtime scope (the host's skills, never
    the server's)."""
    try:
        from agent.profile_runtime import profile_runtime_scope
        from agent.skill_commands import get_skill_commands
        from hermes_cli import profiles

        home = profiles.get_profile_dir(profile)
        if not home.is_dir():
            return []  # unknown profile → fail closed: no grant
        with profile_runtime_scope(home):
            return list(get_skill_commands().keys())
    except Exception:  # noqa: BLE001 — fail closed: no grant
        return []


def _deliveries_by_output(pconn, project_id: str) -> Dict[str, List[dict]]:
    out: Dict[str, List[dict]] = {}
    for d in projects_db.get_output_deliveries(pconn, project_id=project_id):
        out.setdefault(d["output_id"], []).append(d)
    return out


def _sample_links(pconn, project_id: str) -> List[dict]:
    return [
        link
        for link in projects_db.get_project_links(pconn, project_id)
        if link.get("kind") == "sample"
    ]


def _previous_run(pconn, project_id: str, run_no: int) -> Optional[dict]:
    if run_no <= 1:
        return None
    prev = projects_db.get_project_run(pconn, project_id, run_no - 1)
    return prev if prev and (prev.get("retro") or "").strip() else None


def _default_spawn_inline(
    *,
    project: projects_db.Project,
    run: dict,
    guidance: str,
    inline_steps: Sequence[dict],
    enabled_toolsets: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """The ONLY session-spawn path this feature may use (§6).

    The session's reasoning and tool calls are published to
    :mod:`hermes_cli.run_activity` as they happen, so the run page can show
    what the run is doing rather than only that it is running. Only the
    reasoning text and a tool's id and name are published — arguments and
    results stay in this process.
    """
    try:
        from agent.seeded_session import spawn_seeded_session
    except Exception as exc:  # noqa: BLE001
        return {"session_id": None, "error": f"seeded session unavailable: {exc}"}
    step_text = "\n".join(
        f"- [{s['key']}] {s['title']}" + (f": {s['body']}" if s.get("body") else "")
        for s in inline_steps
    )
    prompt = (
        f"{guidance}\n\n### Inline steps for this run\n{step_text}\n\n"
        "Do these steps now, in order. Record every deliverable you "
        "produce as an output delivery for this project."
    )
    session_id = f"proj-run-{run.get('run_no')}-{uuid.uuid4().hex[:8]}"
    from hermes_cli import profiles

    host_profile = run.get("profile")
    key = run_activity.run_key(project.id, int(run.get("run_no") or 0))
    run_activity.begin(key)
    run_activity.publish_reasoning(
        key,
        f"Starting {len(inline_steps)} inline step(s): "
        + ", ".join(s["key"] for s in inline_steps),
    )
    try:
        result = spawn_seeded_session(
            prompt,
            origin=f"projects:{project.slug}:run-{run.get('run_no')}",
            session_id=session_id,
            # The run executes in the HOST profile's home — its memory,
            # secrets and soul, matching the profile the run row records
            # (§6).
            profile_home=(
                str(profiles.get_profile_dir(host_profile)) if host_profile else None
            ),
            enabled_toolsets=list(enabled_toolsets) if enabled_toolsets else None,
            context=contextvars.copy_context(),
            reasoning_callback=lambda text: run_activity.publish_reasoning(key, text),
            tool_start_callback=lambda tc_id, name, args: run_activity.publish_tool(
                key, "start", tc_id, name
            ),
            tool_complete_callback=(
                lambda tc_id, name, args, res: run_activity.publish_tool(
                    key, "complete", tc_id, name
                )
            ),
        )
    finally:
        run_activity.finish(key, "Inline steps finished.")
    return {
        "session_id": session_id,
        "error": result.error,
        "timed_out": result.timed_out,
    }
