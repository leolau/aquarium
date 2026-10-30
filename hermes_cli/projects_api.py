"""HTTP routes for the Projects feature — API (design §12 / §17 steps 3–5).

The record API: read/write of the project itself plus the sub-objects the
first page needs — outputs (+ deliveries + the human-only accept), members,
profiles, contacts, links, the principal-filtered board and card creation —
plus the run machinery (step 4): the playbook and its revisions (§7),
directives/feedback guidance (§5), the run lifecycle (§6), and the
toolsets/skills narrowing filter + autonomy route (§4/§4.1) — plus the
schedule wiring (step 5): ``PUT/DELETE /schedule`` against the host
profile's cron job (§3.2), the ``next_run_at`` display cache, the full
derived health (§9.2) and ``doctor`` (§15 failure mode 1). Derived values
are computed on read and never stored: progress (§9.1 ladder), health and
the card rollup.

Mounted by ``web_server.py`` beside the todos and incomings routers, prefix
``/api/registry/projects``. Calls ``projects_db``, ``kanban_db``,
``kanban_view`` and ``cron.jobs`` directly — never the dashboard kanban
plugin over HTTP.

Permissions are enforced here and only here (§11): the store has no RLS.

* Reads by somebody without access are **404, not 403** — the existence of
  a project is itself information.
* Writes need ``lead`` or an instance ``admin``/``owner``. The judgement
  acts — links, contacts, proposing an output, delivering, accepting — are
  additionally open to the ``member`` role. A ``viewer`` never writes and
  never sees ``contacts[].address`` (dropped, not blanked).
* Board reads always pass the caller's principal into
  ``kanban_db.list_tasks`` — a project view must not become the way to read
  another user's ``private:`` card.

Every §17 API step has landed: the ``from_todo`` card seam (§10, step 8b)
on ``POST /{slug}/cards``; the score routes (§8, step 9b) on
``POST /{slug}/runs/{n}/score`` + ``score_self`` on the retro route; the
retro learning write-back (§8.2, step 10) as ``proposals`` on the retro
route — playbook revisions and directives land inactive, skill candidates
record project + run provenance — plus
``POST /{slug}/directives/{id}/activate`` for the member crossing; and the
events feed + ``summarise`` (step 11) as ``GET /{slug}/events?since=`` and
``POST /{slug}/summarise``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from hermes_cli import (
    kanban_db,
    kanban_view,
    projects_db,
    projects_schedule,
    run_activity,
)
from hermes_cli.profiles import normalize_profile_name, resolve_profile_env
from hermes_state import (
    kanban_task_call_stats,
    kanban_task_token_totals_by_task,
    kanban_tasks_token_totals,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200

# ---------------------------------------------------------------------------
# Principal resolution (§11 rule 1)
# ---------------------------------------------------------------------------


async def _principal_read(request: Request):
    """C1 principal for reads — ``?as=`` narrowing allowed, as /todos does."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=True)


async def _principal_write(request: Request):
    """C1 principal for writes — always the acting principal, never ``?as=``."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=False)


async def _interactive_subject(request: Request) -> str:
    """The verified login subject, or ``""`` for a session-less caller.

    The human-only seam (§8.1): an interactive console session — and the
    agent-home BFF, which forwards the user's verified session cookie —
    carries a subject; an agent turn, a service caller or an in-process
    test client does not. Overridable by the CLI harness, which is the
    human operator's terminal acting through the machine-operator surface.
    """
    from hermes_cli.web_server import _comms_session_subject

    return _comms_session_subject(request)


async def _enrolled_profiles(user_id: str) -> set[str]:
    """Profiles where the caller holds an **active** principals row.

    The bounded fan-out the shared-read rule needs (§11 rule 2): iterates
    the profile registry under the caller's own subject. Degrades to an
    empty set — never a 500, never a grant — when the access store is
    unreachable.
    """
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.console_scope import enrolled_profiles
        from hermes_cli.web_server import _comms_app_store

        factory = lambda home: PrincipalStore(_comms_app_store())  # noqa: E731
        names = await enrolled_profiles(
            user_id, store_factory=factory, active_only=True
        )
        return set(names)
    except Exception:  # pragma: no cover - defensive: fail closed
        logger.debug("projects: enrollment fan-out unavailable", exc_info=True)
        return set()


# ---------------------------------------------------------------------------
# Access decisions (§11 rules 2–3)
# ---------------------------------------------------------------------------


def _instance_admin(principal) -> bool:
    """Box-wide ``owner``/``admin`` — the instance roles that outrank the
    per-project membership matrix."""
    if getattr(principal, "is_owner", False):
        return True
    return getattr(principal, "role", "") in ("owner", "admin")


def _member_role_sync(conn, project_id: str, user_id: str) -> Optional[str]:
    row = conn.execute(
        "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        (project_id, user_id),
    ).fetchone()
    return row["role"] if row else None


def _can_read(project, role, principal, enrolled: set[str], profiles) -> bool:
    if _instance_admin(principal):
        return True
    if project.owner_user_id and project.owner_user_id == principal.user_id:
        return True
    if role is not None:
        return True
    # Shared-read: visibility='shared' AND an active principals row in one
    # of the project's profiles. A suspended enrolment carries no weight.
    if getattr(project, "visibility", "shared") == "shared":
        if enrolled & {p["profile"] for p in profiles}:
            return True
    return False


def _can_write(project, role, principal) -> bool:
    """Record writes: lead, the project creator, or an instance admin/owner."""
    if _instance_admin(principal):
        return True
    if project.owner_user_id and project.owner_user_id == principal.user_id:
        return True
    return role == "lead"


def _can_member_act(project, role, principal) -> bool:
    """The judgement acts (§11 rule 3): links, contacts, proposing an
    output, delivering, accepting. Everything ``_can_write`` plus the plain
    ``member`` role — a viewer still never writes."""
    return _can_write(project, role, principal) or role == "member"


def _load_ctx_sync(slug: str, user_id: str):
    """One synchronous read of the project + its membership context.

    Returns ``(project, member_role, profiles)`` or ``None`` when the slug
    names no project. Callers gate on this — the 404/403 decision is made
    from one consistent snapshot.
    """
    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        if project is None:
            return None
        role = _member_role_sync(conn, project.id, user_id)
        profiles = projects_db.get_project_profiles(conn, project.id)
    return project, role, profiles


async def _require_read(request: Request):
    """Resolve the principal, load the project and gate the read.

    Anything the caller may not read is a **404** — indistinguishable from
    a project that does not exist.
    """
    slug = request.path_params["slug"]
    principal = await _principal_read(request)
    ctx = await asyncio.to_thread(_load_ctx_sync, slug, principal.user_id)
    if ctx is None:
        raise HTTPException(status_code=404, detail="project not found")
    project, role, profiles = ctx
    enrolled = await _enrolled_profiles(principal.user_id)
    if not _can_read(project, role, principal, enrolled, profiles):
        raise HTTPException(status_code=404, detail="project not found")
    return project, role, profiles, principal


async def _require_write(request: Request, *, judgement: bool = False):
    """Same gate as :func:`_require_read`, then the write check.

    A readable-but-not-writable caller gets a 403: they already know the
    project exists, so hiding it would only confuse.
    """
    project, role, profiles, principal = await _require_read(request)
    ok = _can_member_act(project, role, principal) if judgement else _can_write(
        project, role, principal
    )
    if not ok:
        raise HTTPException(status_code=403, detail="not permitted")
    return project, role, profiles, principal


def _refuse_if_archived(project, act: str) -> None:
    """§13: a shelved project does not run and does not learn.

    Archive drops the project out of the list *and stops it running*;
    its detail page offers restore as the only *growing* write. Every
    route that grows the record calls this gate; the routes that stay
    open are deliberate, not omissions:

    - ``PATCH /{slug}`` — a typo in an archived goal is still fixable
      (pinned by ``test_archived_project_still_accepts_a_patch_and_
      restore_unblocks``).
    - ``POST /{slug}/restore`` — the one write the detail page offers.
    - ``POST /{slug}/runs/{run_no}/cancel`` — cancelling *reduces* the
      record; archive refuses to shelve a project while a run is still
      ``running``/``waiting``, so cancel is the sanctioned way out.
    - The DELETE routes (outputs, members, profiles, contacts, links,
      schedule) and ``POST /{slug}/directives/{id}/retire`` — every one
      removes or detaches. Archive is not a write-lock on the record,
      it is a stop on *growth*.
    - ``POST /{slug}/members``, ``/profiles``, ``/contacts``, ``/links``
      — bookkeeping on a shelved record, same class as ``PATCH /{slug}``.

    ``POST /{slug}/archive`` and ``DELETE /{slug}`` never reach this
    gate: archive has its own already-archived refusal, and hard delete
    *requires* ``archived`` to be true.

    The gate also holds one layer below the router (U9):
    ``kanban_db.create_task`` refuses an archived project itself, so the
    card writers that never pass through this file — the to-do promote
    route and ``hermes kanban create --project`` — inherit the same
    refusal."""
    if project.archived:
        raise HTTPException(
            status_code=409,
            detail=f"project {project.slug} is archived — restore it before {act}",
        )


async def _require_human(request: Request, act: str) -> str:
    """§8.1/§8.2: a human act needs a verified interactive subject.

    The one gate every human-only route passes (§16): the role check says
    *may this member judge*, this says *is a human actually judging*. An
    agent turn, a service caller or a session-less CLI invocation has no
    subject and is refused — the returned subject is the provenance to
    record alongside the write.
    """
    subject = await _interactive_subject(request)
    if not subject:
        raise HTTPException(
            status_code=403,
            detail=f"{act} is a human act — no verified session, no {act}",
        )
    return subject


# ---------------------------------------------------------------------------
# Derived values: progress ladder (§9.1), card rollup, health (§9.2)
# ---------------------------------------------------------------------------


def goal_progress_hook(project, goal_link: dict) -> Optional[dict]:
    """Rung 2 of the ladder — the linked goal's FG-29 metric progress.

    Overridable seam: returns ``None`` until the goals store reader is
    wired (a rung-2 answer must be the goal's own metric, never a guess),
    and the ladder falls through to the card rollup labelled as such.
    """
    return None


def _card_rollup_sync(bconn, project_id: str, principal) -> dict:
    # One archived-inclusive query, two counts: `total` keeps the board's
    # live picture, `total_with_archived` is the caller-visible total
    # (§12 decision 17, U5). `total_all_principals` is a plain COUNT(*)
    # with no principal filter — what the delete ROUTE counts (U8): a
    # lead who cannot see a colleague's private card must still see the
    # same number the refusal is based on. A count leaks no title,
    # assignee or column.
    tasks = kanban_db.list_tasks(
        bconn, project_id=project_id, principal=principal, include_archived=True
    )
    rollup = {
        "total": 0,
        "done": 0,
        "running": 0,
        "blocked": 0,
        "total_with_archived": len(tasks),
    }
    for t in tasks:
        status = getattr(t, "status", "")
        if status == "archived":
            continue
        rollup["total"] += 1
        if status in rollup:
            rollup[status] += 1
    rollup["total_all_principals"] = bconn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?",
        (project_id,),
    ).fetchone()["n"]
    return rollup


def _standing_headline(project, deliveries: list[dict]) -> str:
    """Rung 4: never a percentage — when it was last reviewed, and what
    this period delivered."""
    review_every = str(project.review_every or "").strip()
    parts: list[str] = []
    if review_every:
        parts.append(f"review every {review_every}")
    period_deliveries = [
        d for d in deliveries if d.get("delivered_at") and _in_period(project, d["delivered_at"])
    ]
    parts.append(f"{len(period_deliveries)} delivered this period")
    return " · ".join(parts)


def _in_period(project, ts: int) -> bool:
    """Crude period window from ``review_every`` (``30d`` / ``2w`` / ``1m``);
    defaults to 7d when unset or unparseable."""
    days = 7
    m = re.fullmatch(r"(\d+)\s*([dwm])", str(project.review_every or "").strip())
    if m:
        n = int(m.group(1))
        days = n if m.group(2) == "d" else n * 7 if m.group(2) == "w" else n * 30
    return ts >= int(time.time()) - days * 86400


def _derive_progress(
    project,
    outputs: list[dict],
    deliveries: list[dict],
    card_rollup: dict,
    goal_links: list[dict],
) -> dict:
    """One ``progress`` object on read, first rung that applies (§9.1).

    Rung 1 outranks rung 3 deliberately: cards-done counts the work, not
    the result. Whatever rung wins, the card rollup rides along — it is
    what tells you whether progress is currently moving.
    """
    cards = dict(card_rollup)

    if getattr(project, "cadence", "one_off") == "standing":
        return {
            "rung": "standing",
            "label": "standing",
            "headline": _standing_headline(project, deliveries),
            "cards": cards,
        }

    required = [o for o in outputs if o.get("required")]
    delivered_ids = {d["output_id"] for d in deliveries}

    def _advanced(o: dict) -> bool:
        return o.get("status") in ("accepted", "delivered") or o["id"] in delivered_ids

    if required and any(_advanced(o) for o in required):
        accepted_required = [
            o for o in required if o.get("status") == "accepted"
        ]
        return {
            "rung": "outputs",
            "label": "outputs",
            "headline": (
                f"{len(accepted_required)} of {len(required)} outputs accepted"
            ),
            "accepted": len(accepted_required),
            "required": len(required),
            "cards": cards,
        }

    if goal_links:
        metric = goal_progress_hook(project, goal_links[0])
        if metric is not None:
            return {
                "rung": "goal",
                "label": "goal",
                "headline": metric.get("headline", "goal progress"),
                "metric": metric,
                "cards": cards,
            }

    done, total = cards.get("done", 0), cards.get("total", 0)
    return {
        "rung": "cards",
        "label": "cards",
        "headline": f"{done} of {total} cards done",
        "cards": cards,
    }


def _output_rollup(outputs: list[dict]) -> dict:
    """Per-status counts of the declared outputs, so a list row or the
    progress panel can say "2 delivered, 1 accepted of 3" without
    re-deriving it from the rows (§9.1)."""
    rollup = {
        "total": len(outputs),
        "required": 0,
        "delivered": 0,
        "accepted": 0,
        "awaiting_acceptance": 0,
    }
    for o in outputs:
        if o.get("required"):
            rollup["required"] += 1
        status = o.get("status")
        if status == "delivered":
            rollup["delivered"] += 1
            rollup["awaiting_acceptance"] += 1
        elif status == "accepted":
            rollup["delivered"] += 1
            rollup["accepted"] += 1
    return rollup


def _full_health(conn, project, card_rollup: dict, profiles: list) -> str:
    """The complete §9.2 ladder, computed on read from runs + the cron
    store. The cron round-trip only happens for scheduled projects — a
    list page must not open every profile's store for nothing."""
    runs = projects_db.list_project_runs(conn, project.id, limit=10)
    cron_job = None
    if getattr(project, "cron_job_id", None):
        cron_job = projects_schedule.resolve_cron_job(project, profiles)
    return projects_schedule.derive_health(
        project,
        card_rollup=card_rollup,
        profiles=profiles,
        runs=runs,
        cron_job=cron_job,
        pconn=conn,
    )


def _divergent_self(run: dict) -> Optional[int]:
    """§8.2 rule 2: ``score_self`` is reported only when it and
    ``score_user`` differ by ≥2 — that gap is the learning signal, and
    carrying it only when it *is* one keeps the runs table honest."""
    self_score, user_score = run.get("score_self"), run.get("score_user")
    if self_score is None or user_score is None:
        return None
    if abs(int(self_score) - int(user_score)) >= 2:
        return int(self_score)
    return None


def _derived_score(conn, project_id: str) -> Optional[dict]:
    """§8.1: the project's score is **derived** — the mean of the last
    five ``score_user`` values, never an all-time number. Recomputed on
    every read, so re-scoring an old run moves it. The window is the last
    five *scores*, not scores inside the last N runs (E5) — an unscored
    streak must not make the score disappear."""
    runs = projects_db.last_scored_runs(conn, project_id, limit=5)
    scored = [int(r["score_user"]) for r in runs]
    if not scored:
        return None
    return {"mean": round(sum(scored) / len(scored), 1), "runs": len(scored)}


def _runs_brief(conn, project_id: str, *, limit: int = 5) -> list[dict]:
    """The last N runs as one-line rows (§12 detail). Cost stays fail-open
    and lives on the run-detail read, not here.

    A ``waiting`` run is never truncated out (F5): the header's Continue
    affordance must find it however old it is, so the newest one is
    appended when it fell out of the window.
    """
    rows = projects_db.list_project_runs(conn, project_id, limit=limit)
    if not any(r.get("status") == "waiting" for r in rows):
        waiting = projects_db.latest_waiting_run(conn, project_id)
        if waiting is not None:
            rows = [*rows, waiting]
    out = []
    for r in rows:
        duration = None
        if r.get("started_at") and r.get("ended_at"):
            duration = int(r["ended_at"]) - int(r["started_at"])
        row = {
            "run_no": r["run_no"],
            "status": r["status"],
            "trigger": r["trigger"],
            "started_at": r.get("started_at"),
            "ended_at": r.get("ended_at"),
            "duration_seconds": duration,
            "outcome": r.get("outcome"),
            "score_user": r.get("score_user"),
        }
        divergent = _divergent_self(r)
        if divergent is not None:
            # Presence IS the signal: the brief carries score_self only
            # when the ≥2 divergence makes it worth reading (§12).
            row["score_self"] = divergent
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# Payload helpers
# ---------------------------------------------------------------------------


def _project_payload(project, *, extra: Optional[dict] = None) -> dict:
    d = project.to_dict()
    d.pop("folders", None)  # folder list rides with the detail read
    if extra:
        d.update(extra)
    return d


def _contacts_payload(contacts: list[dict], *, include_address: bool) -> list[dict]:
    """A viewer never sees ``address``: the field is dropped, not blanked,
    so a client cannot leak it back (§11 rule 3)."""
    out = []
    for c in contacts:
        row = dict(c)
        if not include_address:
            row.pop("address", None)
        out.append(row)
    return out


def _board_conn(project):
    """The project's board connection, closed on exit (FD hygiene mirrors
    ``projects_db.connect_closing``)."""
    return kanban_db.connect_closing(board=project.board_slug or None)


def _event_dict(ev) -> dict:
    return {
        "id": ev.id,
        "task_id": ev.task_id,
        "kind": ev.kind,
        "payload": ev.payload,
        "created_at": ev.created_at,
    }


def _decode_cursor(cursor: Optional[str]) -> Optional[tuple]:
    if not cursor:
        return None
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        created, pid = raw.rsplit("|", 1)
        return int(created), pid
    except Exception:
        raise HTTPException(status_code=400, detail="invalid cursor")


def _encode_cursor(created_at: int, pid: str) -> str:
    return base64.urlsafe_b64encode(f"{created_at}|{pid}".encode()).decode()


# ---------------------------------------------------------------------------
# GET / — the readable list
# ---------------------------------------------------------------------------

# ``attention`` is the rung a human must look at — which includes ``stalled``,
# the worse rung that outranks it (§9.2). The chip sends ``health=attention``;
# the server expands it here so the filter and the cursor agree (F2).
_HEALTH_ALIASES = {"attention": frozenset({"attention", "stalled"})}

# ``active`` is the list's default view — the live work. A project still in
# ``planning`` (created, no active plan yet) is live work that needs the
# user's attention most, so the default view must show it rather than hide
# it until its first activation.
_STATUS_ALIASES = {"active": frozenset({"active", "planning"})}


# ---------------------------------------------------------------------------
# GET / — sorting
# ---------------------------------------------------------------------------

#: ``sort=`` values and the order each takes when ``order=`` is absent.
_SORT_DEFAULT_ORDER = {
    "created": "desc",
    "completed": "desc",
    "due": "asc",
    "name": "asc",
    "status": "asc",
    "duration": "desc",
    "tokens": "desc",
}

#: The lifecycle order the ``status`` sort follows.
_STATUS_SORT_RANK = {
    "needs_completion": 0,
    "planning": 1,
    "active": 2,
    "paused": 3,
    "done": 4,
    "archived": 5,
}


def _sort_spec(sort: Optional[str], order: Optional[str]) -> Optional[tuple[str, bool]]:
    """``(field, descending)``, or None for the default newest-first order,
    which keeps its keyset cursor."""
    field = sort or "created"
    if field not in _SORT_DEFAULT_ORDER:
        field = "created"
    descending = (order or _SORT_DEFAULT_ORDER[field]) == "desc"
    if field == "created" and descending:
        return None
    return field, descending


def _encode_offset_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(f"@{int(offset)}".encode()).decode()


def _decode_offset_cursor(cursor: Optional[str]) -> int:
    if not cursor:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        if not raw.startswith("@"):
            raise ValueError(raw)
        return max(0, int(raw[1:]))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid cursor")


def _project_run_seconds(project_ids: list[str]) -> dict[str, int]:
    """Total wall-clock run time per project (a live run counts up to now),
    the same sum the detail's ``usage.run_seconds`` shows."""
    now = int(time.time())
    with projects_db.connect_closing() as conn:
        rows = conn.execute(
            "SELECT project_id,"
            " SUM(MAX(0, COALESCE(ended_at, ?) - started_at)) AS seconds"
            " FROM project_runs WHERE started_at IS NOT NULL"
            " GROUP BY project_id",
            (now,),
        ).fetchall()
    wanted = set(project_ids)
    out = {pid: 0 for pid in project_ids}
    for row in rows:
        if row["project_id"] in wanted:
            out[row["project_id"]] = int(row["seconds"] or 0)
    return out


def _project_last_run_end(project_ids: list[str]) -> dict[str, int]:
    with projects_db.connect_closing() as conn:
        rows = conn.execute(
            "SELECT project_id, MAX(ended_at) AS ended FROM project_runs"
            " WHERE ended_at IS NOT NULL GROUP BY project_id"
        ).fetchall()
    wanted = set(project_ids)
    return {
        row["project_id"]: int(row["ended"])
        for row in rows
        if row["project_id"] in wanted and row["ended"] is not None
    }


def _project_token_totals(projects: list) -> dict[str, Optional[int]]:
    """Input + output tokens per project across its cards' worker ledgers
    (as the detail's ``usage.tokens.total``). None when no ledger the
    project's cards ran under could be read — "not recorded", not zero."""
    cards: list[tuple[str, str, Optional[str]]] = []
    by_board: dict[Optional[str], list[str]] = {}
    for p in projects:
        by_board.setdefault(p.board_slug or None, []).append(p.id)
    for board, ids in by_board.items():
        with kanban_db.connect_closing(board=board) as bconn:
            for start in range(0, len(ids), 500):
                chunk = ids[start:start + 500]
                marks = ",".join("?" * len(chunk))
                cards.extend(
                    (row[0], row[1], row[2])
                    for row in bconn.execute(
                        "SELECT project_id, id, assignee FROM tasks"
                        f" WHERE project_id IN ({marks})",
                        chunk,
                    )
                )
    out: dict[str, Optional[int]] = {p.id: None for p in projects}
    with_cards = {pid for pid, _tid, _a in cards}
    for pid in out:
        if pid not in with_cards:
            out[pid] = 0
    by_home: dict[str, list[tuple[str, str]]] = {}
    for pid, task_id, assignee in cards:
        try:
            home = resolve_profile_env(normalize_profile_name(assignee or "default"))
        except (FileNotFoundError, ValueError):
            continue
        by_home.setdefault(str(home), []).append((pid, task_id))
    for home, pairs in by_home.items():
        per_task = kanban_task_token_totals_by_task(
            Path(home) / "state.db", [tid for _pid, tid in pairs]
        )
        if per_task is None:
            continue
        for pid, task_id in pairs:
            out[pid] = (out[pid] or 0) + per_task.get(task_id, 0)
    return out


def _sort_values(rows: list, field: str) -> dict[str, Any]:
    """The value each project sorts on; None sorts last in either order."""
    ids = [p.id for p in rows]
    if field == "created":
        return {p.id: p.created_at for p in rows}
    if field == "completed":
        # Projects closed before ``completed_at`` existed fall back to the
        # end of their last run.
        last_end = _project_last_run_end(ids)
        return {
            p.id: p.completed_at
            if p.completed_at is not None
            else (last_end.get(p.id) if p.status in ("done", "archived") else None)
            for p in rows
        }
    if field == "due":
        return {p.id: p.due_at for p in rows}
    if field == "name":
        return {p.id: (p.name or "").casefold() for p in rows}
    if field == "status":
        return {p.id: _STATUS_SORT_RANK.get(p.status, len(_STATUS_SORT_RANK)) for p in rows}
    if field == "duration":
        return dict(_project_run_seconds(ids))
    if field == "tokens":
        return dict(_project_token_totals(rows))
    return {}


def _sorted_rows(rows: list, values: dict[str, Any], field: str, descending: bool) -> list:
    """Sort on the field, ties newest first, missing values last."""
    present = [p for p in rows if values.get(p.id) is not None]
    missing = [p for p in rows if values.get(p.id) is None]
    present.sort(key=lambda p: (p.created_at, p.id), reverse=True)
    present.sort(key=lambda p: values[p.id], reverse=descending)
    missing.sort(key=lambda p: (p.created_at, p.id), reverse=True)
    return present + missing


def _sort_extra(project, sorted_by: Optional[tuple[str, bool]], values: dict) -> dict:
    """The sort value a card shows when it isn't already on the card."""
    if sorted_by is None:
        return {}
    field = sorted_by[0]
    if field == "completed":
        return {"completed_at": values.get(project.id)}
    if field == "duration":
        return {"usage": {"run_seconds": values.get(project.id)}}
    if field == "tokens":
        return {"usage": {"tokens_total": values.get(project.id)}}
    return {}


def _list_sync(
    principal,
    *,
    status: Optional[str],
    cadence: Optional[str],
    q: Optional[str],
    include_archived: bool,
    limit: int,
    cursor: Optional[tuple],
    enrolled: frozenset = frozenset(),
    health: Optional[str] = None,
    category: Optional[str] = None,
    sort: Optional[str] = None,
    order: Optional[str] = None,
    offset: int = 0,
    rollup_only: bool = False,
) -> dict:
    with projects_db.connect_closing() as conn:
        rows = projects_db.list_projects(conn, include_archived=include_archived)
    sorted_by = _sort_spec(sort, order)
    sort_values: dict[str, Any] = {}
    if sorted_by is None:
        # Newest first; the keyset cursor sorts on (created_at, id).
        rows.sort(key=lambda p: (p.created_at, p.id), reverse=True)
    else:
        field, descending = sorted_by
        sort_values = _sort_values(rows, field)
        rows = _sorted_rows(rows, sort_values, field, descending)
        # Any other order pages by position in the sorted list.
        cursor = None

    health_set = _HEALTH_ALIASES.get(health) if health else None
    if health and health_set is None:
        health_set = frozenset({health})
    # ``category=a,b,none``: any of these ids, "none" meaning Uncategorized.
    category_set = (
        frozenset(
            None if c == "none" else c
            for c in (part.strip() for part in category.split(","))
            if c
        )
        if category
        else None
    )
    status_set = _STATUS_ALIASES.get(status) if status else None
    if status and status_set is None:
        status_set = frozenset({status})

    # Every filter runs BEFORE the page slice and the cursor is taken from
    # the last row *examined*: a post-slice filter both repeats rows and
    # silently drops the ones between the last kept row and the slice end
    # (M2).
    out = []
    last_examined = None
    exhausted = True
    with projects_db.connect_closing() as conn:
        for index, p in enumerate(rows):
            if sorted_by is not None and index < offset:
                continue
            if cursor and (p.created_at, p.id) >= cursor:
                continue
            if len(out) >= limit:
                # The page is full but rows remain — the next page resumes
                # strictly after ``last_examined``.
                exhausted = False
                break
            last_examined = (
                (p.created_at, p.id) if sorted_by is None else index + 1
            )
            if status == "archived":
                # The Archived chip must find every shelved row (U6) —
                # including rows archived before Block 4b, when shelving
                # set the flag without the status.
                if not (getattr(p, "archived", 0) or p.status == "archived"):
                    continue
            elif status_set and p.status not in status_set:
                continue
            if cadence and getattr(p, "cadence", None) != cadence:
                continue
            if category_set and p.category_id not in category_set:
                continue
            if q and q.lower() not in f"{p.name} {p.goal or ''}".lower():
                continue
            role = _member_role_sync(conn, p.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, p.id)
            if not _can_read(p, role, principal, enrolled, profiles):
                continue
            if rollup_only:
                # Card counts only: skip outputs, links, members and the
                # health derivation (run history + cron resolution).
                with _board_conn(p) as bconn:
                    out.append({"cards": _card_rollup_sync(bconn, p.id, principal)})
                continue
            outputs = projects_db.get_project_outputs(conn, p.id)
            deliveries = projects_db.get_output_deliveries(conn, project_id=p.id)
            links = projects_db.get_project_links(conn, p.id)
            members = projects_db.get_project_members(conn, p.id)
            with _board_conn(p) as bconn:
                rollup = _card_rollup_sync(bconn, p.id, principal)
            progress = _derive_progress(
                p, outputs, deliveries, rollup,
                [l for l in links if l["kind"] == "goal"],
            )
            item_health = _full_health(conn, p, rollup, profiles)
            if health_set and item_health not in health_set:
                continue
            out.append(
                _project_payload(
                    p,
                    extra={
                        "progress": progress,
                        "output_rollup": _output_rollup(outputs),
                        "member_count": len(members),
                        "health": item_health,
                        **_sort_extra(p, sorted_by, sort_values),
                    },
                )
            )

    next_cursor = None
    if not exhausted and last_examined:
        next_cursor = (
            _encode_cursor(*last_examined)
            if sorted_by is None
            else _encode_offset_cursor(last_examined)
        )
    return {"items": out, "next_cursor": next_cursor}


@router.get("")
async def list_projects(request: Request) -> dict[str, Any]:
    principal = await _principal_read(request)
    params = request.query_params
    try:
        limit = min(int(params.get("limit", _DEFAULT_LIMIT)), _MAX_LIMIT)
    except ValueError:
        limit = _DEFAULT_LIMIT
    sort = params.get("sort") or None
    order = params.get("order") or None
    if sort is not None and sort not in _SORT_DEFAULT_ORDER:
        raise HTTPException(status_code=400, detail="invalid sort")
    if order is not None and order not in ("asc", "desc"):
        raise HTTPException(status_code=400, detail="invalid order")
    offset = 0
    cursor = None
    if _sort_spec(sort, order) is None:
        cursor = _decode_cursor(params.get("cursor"))
    else:
        offset = _decode_offset_cursor(params.get("cursor"))
    enrolled = frozenset(await _enrolled_profiles(principal.user_id))
    return await asyncio.to_thread(
        _list_sync,
        principal,
        status=params.get("status"),
        cadence=params.get("cadence"),
        q=params.get("q"),
        include_archived=params.get("archived") in ("1", "true"),
        limit=limit,
        cursor=cursor,
        enrolled=enrolled,
        health=params.get("health"),
        category=params.get("category") or None,
        sort=sort,
        order=order,
        offset=offset,
    )


# ---------------------------------------------------------------------------
# POST — create under the full §2.2 contract
# ---------------------------------------------------------------------------


@router.post("")
async def create_project_route(request: Request) -> dict[str, Any]:
    principal = await _principal_write(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")

    missing = [
        field
        for field, present in (
            ("goal", bool(str(body.get("goal") or "").strip())),
            ("description", bool(str(body.get("description") or "").strip())),
            ("outputs", bool(body.get("outputs"))),
            ("host_profile", bool(str(body.get("host_profile") or "").strip())),
        )
        if not present
    ]
    if missing:
        raise HTTPException(
            status_code=422,
            detail={"missing": missing,
                    "message": f"refused: missing mandatory {', '.join(missing)}"},
        )

    outputs = body.get("outputs") or []
    if not isinstance(outputs, list) or not outputs:
        raise HTTPException(
            status_code=422,
            detail={"missing": ["outputs"],
                    "message": "refused: a project declares at least one output"},
        )

    def _create_sync() -> dict:
        with projects_db.connect_closing() as conn:
            pid = projects_db.create_full_project(
                conn,
                goal=str(body["goal"]).strip(),
                description=str(body["description"]).strip(),
                name=body.get("name") or None,
                slug=body.get("slug") or None,
                folders=body.get("folders") or None,
                primary_path=body.get("primary_path"),
                icon=body.get("icon"),
                color=body.get("color"),
                board_slug=body.get("board_slug") or None,
                owner_user_id=principal.user_id,
                cadence=str(body.get("cadence") or "one_off"),
                autonomy=str(body.get("autonomy") or "supervised"),
                category_id=body.get("category_id"),
            )
            # Host profile [4] + the creator as its lead.
            projects_db.add_project_profile(
                conn,
                project_id=pid,
                profile=str(body["host_profile"]).strip(),
                role="host",
                added_by=principal.user_id,
            )
            projects_db.add_project_member(
                conn,
                project_id=pid,
                user_id=principal.user_id,
                role="lead",
                added_by=principal.user_id,
            )
            for spec in outputs:
                if isinstance(spec, str):
                    spec = {"title": spec}
                projects_db.add_project_output(
                    conn,
                    project_id=pid,
                    title=str(spec.get("title") or "").strip(),
                    spec=spec.get("spec"),
                    kind=str(spec.get("kind") or "artifact"),
                    required=bool(spec.get("required", True)),
                    recurring=bool(spec.get("recurring", False)),
                )
            if (
                body.get("target_audience")
                or body.get("definition_of_done")
                or body.get("visibility")
            ):
                projects_db.update_project_fields(
                    conn,
                    pid,
                    {
                        k: body[k]
                        for k in ("target_audience", "definition_of_done",
                                  "visibility")
                        if body.get(k)
                    },
                )
            goal_link = body.get("goal_link")
            if goal_link and str(goal_link.get("ref") or "").strip():
                projects_db.add_project_link(
                    conn,
                    project_id=pid,
                    kind="goal",
                    profile=str(goal_link.get("profile") or "default"),
                    ref=str(goal_link["ref"]).strip(),
                    label=goal_link.get("label"),
                    added_by=principal.user_id,
                )
            project = projects_db.get_project(conn, pid)
            return _project_payload(project, extra={"created": True})

    try:
        return await asyncio.to_thread(_create_sync)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------------------
# GET /doctor — diagnosable breaks across readable projects (§15.1)
#
# Registered BEFORE ``GET /{slug}`` so the literal path wins over the slug
# parameter. ``hermes projects doctor`` (step 9) calls this same surface.
# ---------------------------------------------------------------------------


def _doctor_sync(principal, enrolled: frozenset, slug: Optional[str]) -> dict:
    items = []
    with projects_db.connect_closing() as conn:
        rows = projects_db.list_projects(conn, include_archived=False)
        if slug:
            rows = [p for p in rows if p.slug == slug]
        for p in rows:
            role = _member_role_sync(conn, p.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, p.id)
            if not _can_read(p, role, principal, enrolled, profiles):
                continue
            runs = projects_db.list_project_runs(conn, p.id, limit=10)
            cron_job = None
            if getattr(p, "cron_job_id", None):
                cron_job = projects_schedule.resolve_cron_job(p, profiles)
            findings = projects_schedule.doctor_findings(
                conn, p, profiles=profiles, runs=runs, cron_job=cron_job
            )
            if findings:
                items.append(
                    {
                        "slug": p.slug,
                        "name": p.name,
                        "cadence": p.cadence,
                        "findings": findings,
                    }
                )
    return {"items": items}


@router.get("/running-cards")
async def running_cards_route(request: Request) -> dict[str, Any]:
    """Running kanban cards across the caller's readable active projects —
    the status strip's count, without building the full list payload."""
    principal = await _principal_read(request)
    enrolled = frozenset(await _enrolled_profiles(principal.user_id))
    page = await asyncio.to_thread(
        _list_sync,
        principal,
        status="active",
        cadence=None,
        q=None,
        include_archived=False,
        limit=_MAX_LIMIT,
        cursor=None,
        enrolled=enrolled,
        rollup_only=True,
    )
    return {
        "running_cards": sum(item["cards"]["running"] for item in page["items"])
    }


@router.get("/doctor")
async def doctor_route(request: Request) -> dict[str, Any]:
    principal = await _principal_read(request)
    slug = request.query_params.get("slug")
    enrolled = frozenset(await _enrolled_profiles(principal.user_id))
    return await asyncio.to_thread(_doctor_sync, principal, enrolled, slug)


# ---------------------------------------------------------------------------
# GET /{slug} — the whole record in one read
# ---------------------------------------------------------------------------


def _detail_sync(project, principal, *, include_address: bool) -> dict:
    with projects_db.connect_closing() as conn:
        pid = project.id
        outputs = projects_db.get_project_outputs(conn, pid)
        deliveries = projects_db.get_output_deliveries(conn, project_id=pid)
        members = projects_db.get_project_members(conn, pid)
        profiles = projects_db.get_project_profiles(conn, pid)
        contacts = projects_db.get_project_contacts(conn, pid)
        links = projects_db.get_project_links(conn, pid)

    deliveries_by_output: dict[str, list[dict]] = {}
    for d in deliveries:
        deliveries_by_output.setdefault(d["output_id"], []).append(d)
    outputs_out = [
        {**o, "deliveries": deliveries_by_output.get(o["id"], [])}
        for o in outputs
    ]

    links_by_kind: dict[str, list[dict]] = {}
    for link in links:
        row = dict(link)
        # A link is a pointer, never an authority (§11 rule 5): nothing but
        # the cached label leaves this step until the owning store's reader
        # resolves it under the caller's principal (steps 4 / 8b).
        row["resolved"] = None if row["kind"] != "url" else True
        links_by_kind.setdefault(row["kind"], []).append(row)

    with _board_conn(project) as bconn:
        rollup = _card_rollup_sync(bconn, project.id, principal)
        recent_task_ids = [
            t.id
            for t in kanban_db.list_tasks(
                bconn, project_id=project.id, principal=principal
            )[:20]
        ]
        events: list[dict] = []
        for tid in recent_task_ids:
            for ev in kanban_db.list_events(bconn, tid)[-5:]:
                events.append(_event_dict(ev))
        project_cards = [
            (row[0], row[1])
            for row in bconn.execute(
                "SELECT id, assignee FROM tasks WHERE project_id = ?",
                (project.id,),
            )
        ]

    progress = _derive_progress(
        project, outputs, deliveries, rollup,
        links_by_kind.get("goal", []),
    )

    with projects_db.connect_closing() as conn:
        health = _full_health(conn, project, rollup, profiles)
        runs_brief = _runs_brief(conn, project.id)
        score = _derived_score(conn, project.id)
        # ``next_run_at`` is a display cache (§3.2): refreshed on read,
        # the cron store stays authoritative.
        next_run_at = projects_schedule.refresh_next_run(conn, project)
        clarify = projects_db.clarify_summary(conn, project.id)
        all_runs = projects_db.list_project_runs(conn, project.id, limit=100_000)

    detail = _project_payload(project)
    detail.update(
        {
            "outputs": outputs_out,
            "members": members,
            "profiles": profiles,
            "contacts": _contacts_payload(contacts, include_address=include_address),
            "links": links_by_kind,
            "progress": progress,
            "output_rollup": _output_rollup(outputs),
            "score": score,
            "health": health,
            "next_run_at": next_run_at,
            "runs": runs_brief,
            "card_rollup": rollup,
            "recent_events": events,
            "clarify": clarify,
            "usage": _project_usage(all_runs, project_cards),
        }
    )
    return detail


@router.get("/{slug}")
async def get_project_detail(request: Request) -> dict[str, Any]:
    project, role, _profiles, principal = await _require_read(request)
    # Write authority implies address visibility (M3): an owner or instance
    # admin with no member row has ``role is None`` but must still see
    # addresses — derive from the same predicate that authorises writes.
    include_address = _can_write(project, role, principal) or role in (
        "lead", "editor",
    )
    return await asyncio.to_thread(
        _detail_sync, project, principal, include_address=include_address
    )


# ---------------------------------------------------------------------------
# PATCH /{slug} — record fields (lead / instance admin)
# ---------------------------------------------------------------------------


@router.patch("/{slug}")
async def patch_project(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")

    base_fields = ("name", "goal", "description", "icon", "color", "board_slug")
    extra_fields = (
        "cadence", "due_at", "review_every", "target_audience", "score_rubric",
        "visibility", "definition_of_done", "max_in_progress",
        "budget_usd_per_run",
    )

    def _patch_sync() -> dict:
        with projects_db.connect_closing() as conn:
            # First, so an unknown category refuses before any other write.
            if "category_id" in body:
                projects_db.set_project_category(conn, project.id, body["category_id"])
            base = {k: body[k] for k in base_fields if k in body}
            if base:
                projects_db.update_project(conn, project.id, **base)
            extra = {k: body[k] for k in extra_fields if k in body}
            if extra:
                projects_db.update_project_fields(conn, project.id, extra)
            if (
                "cadence" in body
                and project.cadence == "repeatable"
                and str(body["cadence"]).strip() != "repeatable"
                and project.cron_job_id
            ):
                # §3.1: leaving repeatable pauses and detaches the cron
                # job — never deletes it — and records who changed it.
                projects_schedule.detach_project_schedule(
                    conn,
                    project=project,
                    reason=(
                        f"cadence changed from repeatable to "
                        f"'{str(body['cadence']).strip()}'"
                    ),
                    changed_by=principal.user_id,
                )
            if "status" in body:
                projects_db.set_project_status(
                    conn, project.id, str(body["status"])
                )
            fresh = projects_db.get_project(conn, project.id)
            return _project_payload(fresh)

    try:
        return await asyncio.to_thread(_patch_sync)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------------------
# Lifecycle: archive / restore / hard delete (§13, decision 17)
# ---------------------------------------------------------------------------


@router.post("/{slug}/archive")
async def archive_project_route(request: Request) -> dict[str, Any]:
    """Shelve a project (§13): the archived flag and the ``archived`` status
    land in one transaction, and the schedule detaches by the same call —
    the invariant is that no archived project keeps firing. An optional
    ``reason`` is recorded with who did it. Lead / instance admin. Returns
    the **updated row**, never an ack.
    """
    project, _role, _profiles, principal = await _require_write(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    reason = str(body.get("reason") or "").strip()

    def _archive_sync() -> dict:
        with projects_db.connect_closing() as conn:
            fresh = projects_db.get_project(conn, project.id)
            if fresh is None:
                raise ValueError("project not found")
            if fresh.archived:
                raise ValueError(
                    f"project {fresh.slug} is already archived"
                )
            # §13 (U7): archive stops the project running — so it cannot
            # shelve a run that is still running or waiting at a checkpoint.
            # The resumable run would outlive the shelf; cancel (or letting
            # it finish) is the sanctioned way out. `blocked` is a card-level
            # wait with no resume affordance; terminal statuses are fine.
            open_runs = projects_db.list_open_project_runs(conn, fresh.id)
            if open_runs:
                held = ", ".join(
                    f"run {r['run_no']} ({r['status']})" for r in open_runs
                )
                raise ValueError(
                    f"project {fresh.slug} still has an open run — {held}. "
                    "Cancel it (or let it finish) before archiving."
                )
            # One transaction: archived=1 AND status='archived'. Refuses a
            # needs_completion record (L2), naming the missing fields.
            projects_db.archive_project(conn, fresh.id)
            if getattr(fresh, "cron_job_id", None):
                projects_schedule.detach_project_schedule(
                    conn,
                    project=fresh,
                    reason=(
                        f"project archived{f': {reason}' if reason else ''}"
                    ),
                    changed_by=principal.user_id,
                )
            note = f"Project archived{f': {reason}' if reason else ''}."
            try:
                projects_db.add_project_directive(
                    conn,
                    project_id=fresh.id,
                    kind="directive",
                    body=note,
                    author_user_id=principal.user_id,
                )
            except ValueError:  # pragma: no cover - directive cap: never block
                logger.debug("projects: directive cap — archive note dropped")
            updated = projects_db.get_project(conn, fresh.id)
            return _project_payload(updated)

    try:
        return await asyncio.to_thread(_archive_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{slug}/restore")
async def restore_project_route(request: Request) -> dict[str, Any]:
    """Bring a shelved project back (§13): ``archived=0`` and
    ``status='paused'`` — re-entry is a decision, so never straight to
    ``active``. The schedule is **not** re-created; ``PUT /schedule`` does
    that. Returns the updated row.
    """
    project, _role, _profiles, _principal = await _require_write(request)

    def _restore_sync() -> dict:
        with projects_db.connect_closing() as conn:
            fresh = projects_db.get_project(conn, project.id)
            if fresh is None:
                raise ValueError("project not found")
            if not fresh.archived:
                raise ValueError(f"project {fresh.slug} is not archived")
            projects_db.restore_project(conn, fresh.id)
            updated = projects_db.get_project(conn, fresh.id)
            return _project_payload(updated)

    try:
        return await asyncio.to_thread(_restore_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/{slug}")
async def delete_project_route(request: Request) -> dict[str, Any]:
    """Hard delete — the narrow exception (decision 17), never the default.

    Human-only (§8.1/§8.2), owner or lead, and ``?confirm=<slug>`` must
    name the slug. Refused ``409`` unless the project is already archived
    and carries no run, no delivered or accepted output and no card —
    anything else has history, and ``tasks.project_id`` has no foreign key
    back to ``projects``, so a permissive delete would orphan somebody's
    board. Clears the active pointer and detaches the schedule before the
    row goes.
    """
    project, _role, _profiles, principal = await _require_write(request)
    await _require_human(request, "hard delete")
    confirm = (request.query_params.get("confirm") or "").strip()
    if confirm != project.slug:
        raise HTTPException(
            status_code=422,
            detail="confirm must equal the project slug",
        )

    def _delete_sync() -> dict:
        with projects_db.connect_closing() as conn:
            fresh = projects_db.get_project(conn, project.id)
            if fresh is None:
                raise HTTPException(status_code=404, detail="project not found")
            blockers: list[str] = []
            if not fresh.archived:
                blockers.append("it is not archived")
            runs = conn.execute(
                "SELECT COUNT(*) AS n FROM project_runs WHERE project_id = ?",
                (fresh.id,),
            ).fetchone()["n"]
            if runs:
                blockers.append(f"{runs} run" + ("" if runs == 1 else "s"))
            done_outputs = conn.execute(
                "SELECT COUNT(*) AS n FROM project_outputs "
                "WHERE project_id = ? AND status IN ('delivered', 'accepted')",
                (fresh.id,),
            ).fetchone()["n"]
            if done_outputs:
                blockers.append(
                    f"{done_outputs} delivered or accepted output"
                    + ("" if done_outputs == 1 else "s")
                )
            # The board lives in the per-profile kanban store — count every
            # card pointing at this project, archived cards included: an
            # orphan is an orphan whatever its column.
            with _board_conn(fresh) as bconn:
                cards = kanban_db.list_tasks(
                    bconn, project_id=fresh.id, include_archived=True
                )
            if cards:
                blockers.append(
                    f"{len(cards)} card" + ("" if len(cards) == 1 else "s")
                )
            if blockers:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"refused: {fresh.slug} still has history — "
                        + ", ".join(blockers)
                        + ". Archive keeps it; hard delete is only for the "
                        "genuinely empty mistake."
                    ),
                )
            # Cleanup before the row goes (§12): the active pointer and the
            # schedule first, then the delete cascades the project_* tables
            # on the FK — and stops there, by design.
            if projects_db.get_active_id(conn) == fresh.id:
                projects_db.set_active(conn, None)
            if getattr(fresh, "cron_job_id", None):
                projects_schedule.detach_project_schedule(
                    conn,
                    project=fresh,
                    reason="project deleted",
                    changed_by=principal.user_id,
                )
            projects_db.delete_project(conn, fresh.id)
            return {"deleted": fresh.slug}

    return await asyncio.to_thread(_delete_sync)


# ---------------------------------------------------------------------------
# Outputs + deliveries + accept (§6.1)
# ---------------------------------------------------------------------------


@router.post("/{slug}/outputs")
async def add_output(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "declaring an output")
    body = await request.json()
    try:
        def _add_sync() -> dict:
            with projects_db.connect_closing() as conn:
                oid = projects_db.add_project_output(
                    conn,
                    project_id=project.id,
                    title=str(body.get("title") or "").strip(),
                    spec=body.get("spec"),
                    kind=str(body.get("kind") or "artifact"),
                    required=bool(body.get("required", True)),
                    recurring=bool(body.get("recurring", False)),
                )
                row = next(
                    o for o in projects_db.get_project_outputs(conn, project.id)
                    if o["id"] == oid
                )
                return dict(row)
        return await asyncio.to_thread(_add_sync)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{slug}/outputs/{output_id}")
async def patch_output(request: Request, output_id: str) -> dict[str, Any]:
    project, role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "changing an output")
    body = await request.json()
    # Changing what counts as required is structural — lead and above only.
    if "required" in body and not _can_write(project, role, principal):
        raise HTTPException(status_code=403, detail="not permitted")

    def _patch_sync() -> dict:
        with projects_db.connect_closing() as conn:
            changed = projects_db.update_project_output(
                conn,
                output_id,
                title=body.get("title"),
                spec=body.get("spec"),
                kind=body.get("kind"),
                required=body.get("required"),
                recurring=body.get("recurring"),
                status=body.get("status"),
            )
            if not changed:
                raise KeyError(output_id)
            row = next(
                (
                    o
                    for o in projects_db.get_project_outputs(conn, project.id)
                    if o["id"] == output_id
                ),
                None,
            )
            if row is None:
                raise KeyError(output_id)
            return dict(row)

    try:
        return await asyncio.to_thread(_patch_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="output not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{slug}/outputs/{output_id}")
async def delete_output(request: Request, output_id: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )

    def _delete_sync() -> None:
        with projects_db.connect_closing() as conn:
            projects_db.remove_project_output(conn, output_id)

    try:
        await asyncio.to_thread(_delete_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"deleted": output_id}


@router.post("/{slug}/outputs/{output_id}/deliver")
async def deliver_output(request: Request, output_id: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "delivering an output")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    def _deliver_sync() -> dict:
        from hermes_cli.projects_outputs_api import retain_delivery

        try:
            link_kind, link_ref = retain_delivery(
                project, body.get("link_kind"), body.get("link_ref")
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        with projects_db.connect_closing() as conn:
            did = projects_db.record_output_delivery(
                conn,
                output_id=output_id,
                run_id=body.get("run_id"),
                task_id=body.get("task_id"),
                link_kind=link_kind,
                link_ref=link_ref,
                profile=body.get("profile"),
                label=body.get("label"),
                note=body.get("note"),
            )
            projects_db.update_project_output(conn, output_id, status="delivered")
            return {"delivery_id": did, "output_id": output_id,
                    "by": principal.user_id}

    try:
        return await asyncio.to_thread(_deliver_sync)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{slug}/outputs/{output_id}/accept")
async def accept_output(request: Request, output_id: str) -> dict[str, Any]:
    """Only a human accepts an output (§6.1) — a member judgement act with
    the identity gate on top (§16).

    Accepting the last required output of a ``one_off`` project *offers*
    closure in the response; it never closes the project by itself. The
    response carries the updated row so a UI can merge it without a
    reload."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "accepting an output")
    subject = await _require_human(request, "accepting an output")

    def _accept_sync() -> dict:
        with projects_db.connect_closing() as conn:
            if not projects_db.accept_project_output(
                conn, output_id, accepted_by=subject
            ):
                raise KeyError(output_id)
            outputs = projects_db.get_project_outputs(conn, project.id)
            required = [o for o in outputs if o.get("required")]
            all_accepted = bool(required) and all(
                o.get("status") == "accepted" for o in required
            )
            offers_closure = (
                all_accepted and getattr(project, "cadence", "one_off") == "one_off"
            )
            row = next((o for o in outputs if o.get("id") == output_id), None)
            return {
                "output": row,
                "accepted": output_id,
                "by": subject,
                "offers_closure": offers_closure,
            }

    try:
        return await asyncio.to_thread(_accept_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="output not found")


# ---------------------------------------------------------------------------
# Members
# ---------------------------------------------------------------------------


@router.post("/{slug}/members")
async def add_member(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)
    body = await request.json()
    user_id = str(body.get("user_id") or "").strip()
    role = str(body.get("role") or "member")
    if not user_id:
        raise HTTPException(status_code=422, detail="user_id is required")

    def _add_sync() -> dict:
        with projects_db.connect_closing() as conn:
            if not projects_db.add_project_member(
                conn,
                project_id=project.id,
                user_id=user_id,
                role=role,
                added_by=principal.user_id,
            ):
                raise ValueError(f"{user_id} is already a member")
            return {"user_id": user_id, "role": role}

    try:
        return await asyncio.to_thread(_add_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/{slug}/members/{user_id}")
async def remove_member(request: Request, user_id: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)

    def _remove_sync() -> None:
        with projects_db.connect_closing() as conn:
            members = projects_db.get_project_members(conn, project.id)
            leads = [m for m in members if m["role"] == "lead"]
            target = next((m for m in members if m["user_id"] == user_id), None)
            if target is None:
                raise KeyError(user_id)
            if target["role"] == "lead" and len(leads) <= 1:
                raise ValueError(
                    "refusing to remove the last lead; promote another first"
                )
            projects_db.remove_project_member(conn, project.id, user_id)

    try:
        await asyncio.to_thread(_remove_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="member not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"removed": user_id}


# ---------------------------------------------------------------------------
# Profiles
# ---------------------------------------------------------------------------


@router.post("/{slug}/profiles")
async def add_profile(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)
    body = await request.json()
    profile = str(body.get("profile") or "").strip()
    if not profile:
        raise HTTPException(status_code=422, detail="profile is required")

    def _add_sync() -> dict:
        with projects_db.connect_closing() as conn:
            if not projects_db.add_project_profile(
                conn,
                project_id=project.id,
                profile=profile,
                role=str(body.get("role") or "member"),
                added_by=principal.user_id,
            ):
                raise ValueError(f"profile {profile!r} is already attached")
            return {"profile": profile}

    try:
        return await asyncio.to_thread(_add_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/{slug}/profiles/{name}")
async def remove_profile(request: Request, name: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)

    def _remove_sync() -> None:
        with projects_db.connect_closing() as conn:
            profiles = projects_db.get_project_profiles(conn, project.id)
            if not any(p["profile"] == name for p in profiles):
                raise KeyError(name)
            if len(profiles) <= 1:
                raise ValueError(
                    "refusing to detach the last profile; a project without "
                    "profiles has nowhere to run"
                )
            projects_db.remove_project_profile(conn, project.id, name)

    try:
        await asyncio.to_thread(_remove_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="profile not attached")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {"detached": name}


# ---------------------------------------------------------------------------
# Contacts ([10] — address is members-only PII)
# ---------------------------------------------------------------------------


@router.post("/{slug}/contacts")
async def add_contact(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    body = await request.json()

    def _add_sync() -> dict:
        with projects_db.connect_closing() as conn:
            cid = projects_db.add_project_contact(
                conn,
                project_id=project.id,
                name=str(body.get("name") or "").strip(),
                role=body.get("role"),
                org=body.get("org"),
                platform=body.get("platform"),
                address=body.get("address"),
                user_id=body.get("user_id"),
                notes=body.get("notes"),
                created_by=principal.user_id,
            )
            row = next(
                c for c in projects_db.get_project_contacts(conn, project.id)
                if c["id"] == cid
            )
            return dict(row)

    try:
        return await asyncio.to_thread(_add_sync)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.patch("/{slug}/contacts/{contact_id}")
async def patch_contact(request: Request, contact_id: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)
    body = await request.json()

    def _patch_sync() -> dict:
        with projects_db.connect_closing() as conn:
            if not projects_db.update_project_contact(conn, contact_id, **body):
                raise KeyError(contact_id)
            row = next(
                (
                    c
                    for c in projects_db.get_project_contacts(conn, project.id)
                    if c["id"] == contact_id
                ),
                None,
            )
            if row is None:
                raise KeyError(contact_id)
            return dict(row)

    try:
        return await asyncio.to_thread(_patch_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="contact not found")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{slug}/contacts/{contact_id}")
async def delete_contact(request: Request, contact_id: str) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request)

    def _delete_sync() -> None:
        with projects_db.connect_closing() as conn:
            if not projects_db.remove_project_contact(conn, contact_id):
                raise KeyError(contact_id)

    try:
        await asyncio.to_thread(_delete_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="contact not found")
    return {"deleted": contact_id}


# ---------------------------------------------------------------------------
# Links — pointers, never authorities (§11 rule 5)
# ---------------------------------------------------------------------------


@router.post("/{slug}/links")
async def add_link(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    body = await request.json()
    kind = str(body.get("kind") or "").strip()
    ref = str(body.get("ref") or "").strip()
    profile = str(body.get("profile") or "default").strip()
    if not kind or not ref:
        raise HTTPException(status_code=422, detail="kind and ref are required")

    def _add_sync() -> dict:
        with projects_db.connect_closing() as conn:
            if not projects_db.add_project_link(
                conn,
                project_id=project.id,
                kind=kind,
                profile=profile,
                ref=ref,
                label=body.get("label"),
                added_by=principal.user_id,
            ):
                raise ValueError("link already exists")
            return {"kind": kind, "profile": profile, "ref": ref,
                    "label": body.get("label")}

    try:
        return await asyncio.to_thread(_add_sync)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.delete("/{slug}/links")
async def delete_link(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    body = await request.json()
    kind = str(body.get("kind") or "").strip()
    ref = str(body.get("ref") or "").strip()
    profile = str(body.get("profile") or "default").strip()

    def _delete_sync() -> None:
        with projects_db.connect_closing() as conn:
            if not projects_db.remove_project_link(
                conn,
                project_id=project.id,
                kind=kind,
                profile=profile,
                ref=ref,
            ):
                raise KeyError(kind)

    try:
        await asyncio.to_thread(_delete_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="link not found")
    return {"detached": {"kind": kind, "profile": profile, "ref": ref}}


# ---------------------------------------------------------------------------
# Board + cards (rule 4: reads stay principal-filtered)
# ---------------------------------------------------------------------------


@router.get("/{slug}/board")
async def project_board(request: Request) -> dict[str, Any]:
    """The project's cards through the one shared rollup (design §12) —
    ``build_board_view`` with ``project_id`` and the caller's principal, so
    another user's ``private:`` card stays invisible here too."""
    project, _role, _profiles, principal = await _require_read(request)

    def _board_sync() -> dict:
        with _board_conn(project) as bconn:
            view = kanban_view.build_board_view(
                bconn, project_id=project.id, principal=principal
            )
            blocked = [
                task
                for column in view["columns"]
                for task in column["tasks"]
                if task["status"] == "blocked"
            ]
            pending = kanban_db.list_task_approvals(
                bconn, [task["id"] for task in blocked]
            )
            for task in blocked:
                task["pending_approvals"] = pending.get(task["id"], [])
            return view

    return await asyncio.to_thread(_board_sync)


# ---------------------------------------------------------------------------
# GET /{slug}/events — the live-update tail (§12)
# ---------------------------------------------------------------------------


@router.get("/{slug}/events")
async def project_events(request: Request) -> dict[str, Any]:
    """The event tail for live updates: ``task_events`` rows for the
    project's cards with ``id`` greater than ``since``, plus the current
    ``latest_event_id`` to use as the next cursor. The board read passes
    the caller's principal, so another user's ``private:`` cards — and
    their events — stay invisible here too."""
    project, _role, _profiles, principal = await _require_read(request)
    raw_since = request.query_params.get("since")
    since = 0
    if raw_since is not None:
        try:
            since = int(raw_since)
        except ValueError:
            raise HTTPException(status_code=400, detail="since must be an integer")
        if since < 0:
            raise HTTPException(status_code=400, detail="since must be >= 0")

    def _events_sync() -> dict:
        with _board_conn(project) as bconn:
            # The project-scoped tail (E4): one join against
            # ``tasks.project_id`` with the C2 visibility clause — never an
            # id list (bound-variable cap) and never a full card re-list.
            latest, events = kanban_db.project_events_tail(
                bconn, project.id, principal=principal, since_id=since
            )
        return {
            "events": [_event_dict(ev) for ev in events],
            "latest_event_id": latest,
            "since": since,
        }

    return await asyncio.to_thread(_events_sync)


# ---------------------------------------------------------------------------
# POST /{slug}/summarise — the rolling "where this stands" (§2.2)
# ---------------------------------------------------------------------------


_SUMMARY_MAX_LEN = 4_000


@router.post("/{slug}/summarise")
async def summarise_project(request: Request) -> dict[str, Any]:
    """Write the rolling "where this stands" summary, stamping ``summary_at``.

    A record-keeping write (§2.2): whoever can write the project may
    summarise it — typically the agent at the end of a run, or a human
    correcting the record. Not a judgement act.
    """
    project, _role, _profiles, _principal = await _require_write(request)
    _refuse_if_archived(project, "re-summarising it")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    summary = str(body.get("summary") or "").strip()
    if not summary:
        raise HTTPException(status_code=422, detail="summary must not be empty")
    if len(summary) > _SUMMARY_MAX_LEN:
        raise HTTPException(
            status_code=422,
            detail=f"summary must be at most {_SUMMARY_MAX_LEN} characters",
        )

    def _summarise_sync() -> dict:
        with projects_db.connect_closing() as conn:
            summary_at = projects_db.set_project_summary(conn, project.id, summary)
        if summary_at is None:
            raise HTTPException(status_code=404, detail="project not found")
        return {"summary": summary, "summary_at": summary_at}

    return await asyncio.to_thread(_summarise_sync)


@router.post("/{slug}/cards")
async def create_card(request: Request) -> dict[str, Any]:
    """Create a card on the project's board.

    Cards created through the Projects surface land in ``triage`` — a
    project asking for work is not the same as a human approving it
    (§10: promotion is not dispatch).

    The ``from_todo`` seam (§10, step 8b): ``{"from_todo": {"profile": …,
    "id": …}}`` promotes a to-do into a card — human-only, one-way, no
    reverse sync, no ``project_id`` on to-dos. The to-do is read under the
    caller's own principal (not visible → 404); the card inherits its
    title/description, a ``project_links(kind='todo')`` row records
    provenance, and the to-do moves to ``working`` with a history entry
    naming the card. If the stage move fails the card is rolled back — a
    half-promotion would strand the work in neither place.
    """
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "adding a card")
    body = await request.json()
    title = str(body.get("title") or "").strip()
    card_body = body.get("body")

    # ── The promotion seam (§10): validate the to-do BEFORE anything is
    # created, so a bad ref fails with nothing to roll back.
    from_todo = body.get("from_todo")
    todo = None
    # The to-do store a promotion reads is the *serving* process's store
    # (``todo_store.default_store``), so a promotion can only name the
    # profile serving this request — honouring a foreign ``profile`` would
    # read the wrong store while recording foreign provenance (E2).
    serving_profile = (
        request.query_params.get("profile") or "default"
    ).strip() or "default"
    todo_profile = serving_profile
    if isinstance(from_todo, dict) and from_todo:
        todo_id = str(from_todo.get("id") or "").strip()
        todo_profile = str(from_todo.get("profile") or "").strip() or serving_profile
        if not todo_id:
            raise HTTPException(
                status_code=422, detail="from_todo needs an id"
            )
        if todo_profile != serving_profile:
            raise HTTPException(
                status_code=422,
                detail="a to-do can only be promoted from the profile serving "
                       "this request — open that profile's Projects to promote "
                       "it there",
            )
        from hermes_cli.todo_store import default_store

        try:
            todo = await default_store().get(principal, todo_id)
        except Exception:  # noqa: BLE001 - store unreachable = not visible
            todo = None
        if todo is None:
            raise HTTPException(
                status_code=404, detail="to-do not found or not visible"
            )
        title = title or todo.title
        card_body = card_body or todo.description
    if not title:
        raise HTTPException(status_code=422, detail="title is required")

    def _create_sync() -> dict:
        with _board_conn(project) as bconn:
            tid = kanban_db.create_task(
                bconn,
                title=title,
                body=card_body,
                assignee=body.get("assignee"),
                created_by=principal.user_id,
                triage=True,
                board=project.board_slug or None,
                project_id=project.id,
                owner_user_id=principal.user_id,
                # A project card is shared with the project's members; the
                # per-project read gate (§11) is the authority, so a NULL
                # visibility (invisible to every non-owner) would be wrong.
                visibility="shared",
            )
            if todo is not None:
                # Provenance pointer (§11 rule 5): the card came from this
                # to-do. INSERT OR IGNORE — re-promoting is a no-op here.
                with projects_db.connect_closing() as pconn:
                    projects_db.add_project_link(
                        pconn,
                        project_id=project.id,
                        kind="todo",
                        profile=todo_profile,
                        ref=todo.id,
                        label=todo.title,
                        added_by=principal.user_id,
                    )
        return {"task_id": tid, "project_id": project.id, "status": "triage"}

    try:
        result = await asyncio.to_thread(_create_sync)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if todo is not None:
        # The to-do moves to ``working`` AFTER the card exists, with a
        # history entry naming the card — the store's ``action:`` prefix
        # convention puts it on the same timeline as the stage changes.
        from hermes_cli.todo_store import TodoError, default_store

        store = default_store()
        actor = f"user:{principal.user_id}"
        try:
            await store.set_stage(
                principal, todo.id, "working", actor=actor
            )
            await store.record_outbound(
                principal,
                todo.id,
                event=f"card:{result['task_id']}",
                channel="promote",
                actor=actor,
            )
        except (TodoError, LookupError) as exc:
            # Roll the card back: promotion is one atomic idea, and a card
            # whose to-do refused to move would look dispatched when it
            # was not.
            def _rollback_sync() -> None:
                with _board_conn(project) as bconn:
                    kanban_db.delete_task(bconn, str(result["task_id"]))
                # Roll the provenance link back with the card (E2): the
                # insert is ``INSERT OR IGNORE``, so a stranded row would
                # keep its stale label/added_by on a later re-promotion.
                with projects_db.connect_closing() as pconn:
                    projects_db.remove_project_link(
                        pconn,
                        project_id=project.id,
                        kind="todo",
                        profile=todo_profile,
                        ref=todo.id,
                    )

            await asyncio.to_thread(_rollback_sync)
            raise HTTPException(
                status_code=409,
                detail=f"the to-do could not move to working: {exc}",
            )
        result["from_todo"] = {"profile": todo_profile, "id": todo.id}
    return result


def _card_payload(bconn, project: projects_db.Project, task_id: str, *, principal) -> Optional[dict]:
    """One card, joined with the worker's live progress signal.

    Shared by the plain GET and the push stream so the two can never drift.
    Re-checks visibility under ``principal`` on every call (not just once at
    connection-open) — a ``private:`` card owned by someone else is a 404
    through the project surface, and a card's visibility can itself change
    mid-stream (an edit). Returns ``None`` for "no such card here", which
    the GET route turns into 404 and the stream turns into a ``gone`` frame.
    """
    task = kanban_db.get_task(bconn, task_id)
    if task is None or getattr(task, "project_id", None) != project.id:
        return None
    visibility = getattr(task, "visibility", None) or ""
    owner = getattr(task, "owner_user_id", None)
    if (
        visibility.startswith("private:")
        and owner != principal.user_id
        and not _instance_admin(principal)
    ):
        return None
    # The board-list endpoint attaches each card's latest run summary
    # (kanban_db.latest_summaries, batched) so a blocked/handed-off
    # card isn't a blank drawer; this single-card endpoint used to
    # call task_dict() with no summary at all, so `kanban_block`'s
    # required `reason` — the one thing a human needs to see to know
    # what to do — never reached the card detail page.
    summary = kanban_db.latest_summary(bconn, task_id)
    payload = kanban_view.task_dict(task, latest_summary=summary)
    # A card's worker runs in its own process — there is no *in-memory*
    # reasoning/tool-call buffer to tail the way an inline Projects run's
    # session has (run_activity.py). But `_default_spawn` (kanban_db.py)
    # redirects the worker's stdout/stderr to a durable per-task log file
    # any process can read; `worker_log_plain_tail` strips the
    # terminal-only noise (ANSI codes, spinner-frame repeats, decorative
    # borders) down to the model's own sentences and its tool-call
    # summaries — the closest thing to a live stream this surface has.
    # Heartbeat notes and comments are the lighter-weight progress signal
    # a worker also posts (e.g. "93/131 slides completed…").
    payload["comments"] = [
        {"author": c.author, "body": c.body, "created_at": c.created_at}
        for c in kanban_db.list_comments(bconn, task_id)
    ]
    heartbeat_notes = [
        {"note": e.payload["note"], "created_at": e.created_at}
        for e in kanban_db.list_events(bconn, task_id)
        if e.kind == "heartbeat"
        and isinstance(e.payload, dict)
        and e.payload.get("note")
    ]
    payload["latest_heartbeat"] = heartbeat_notes[-1] if heartbeat_notes else None
    payload["worker_log_tail"] = kanban_db.worker_log_plain_tail(
        task_id, board=project.board_slug or None
    )
    if task.status == "blocked":
        payload["pending_approvals"] = kanban_db.list_task_approvals(
            bconn, [task_id]
        ).get(task_id, [])
    payload["model_calls"] = _card_model_calls(bconn, task)
    return payload


def _project_usage(runs: list[dict], cards: list[tuple]) -> dict:
    """What the whole project has used so far: every run's wall-clock time
    (a live run counts up to now) and every card's model tokens.

    Tokens come from each worker profile's ``api_call_log`` (workers run
    under ``-p <assignee>``, as in :func:`_card_model_calls`). ``tokens`` is
    None when no profile's ledger could be read — "not recorded", not zero.
    """
    now = int(time.time())
    run_seconds = 0
    for run in runs:
        if run.get("started_at"):
            end = run.get("ended_at") or now
            run_seconds += max(0, int(end) - int(run["started_at"]))

    by_home: dict[str, list[str]] = {}
    for task_id, assignee in cards:
        try:
            home = resolve_profile_env(normalize_profile_name(assignee or "default"))
        except (FileNotFoundError, ValueError):
            continue
        by_home.setdefault(str(home), []).append(task_id)

    tokens: Optional[dict] = None
    if not cards:
        tokens = dict(calls=0, input_tokens=0, output_tokens=0,
                      cache_read_tokens=0, reasoning_tokens=0)
    for home, task_ids in by_home.items():
        part = kanban_tasks_token_totals(Path(home) / "state.db", task_ids)
        if part is None:
            continue
        if tokens is None:
            tokens = dict.fromkeys(part, 0)
        for key, value in part.items():
            tokens[key] += value
    if tokens is not None:
        tokens["total"] = tokens["input_tokens"] + tokens["output_tokens"]
    return {"runs": len(runs), "run_seconds": run_seconds, "tokens": tokens}


def _card_model_calls(bconn, task) -> Optional[dict]:
    """The card's provider-call stats, from its worker profile's ledger.

    Workers run under ``-p <assignee>``, so their calls land in that
    profile's ``state.db``. Each row is labelled with its attempt number
    (1-based, in start order) and how that run ended.
    """
    try:
        home = resolve_profile_env(normalize_profile_name(task.assignee or "default"))
    except (FileNotFoundError, ValueError):
        return None
    stats = kanban_task_call_stats(Path(home) / "state.db", task.id)
    if stats is None:
        return None
    runs = kanban_db.list_runs(bconn, task.id)
    attempt = {r.id: (i + 1, r.outcome or r.status) for i, r in enumerate(runs)}
    for row in stats["rows"]:
        num, outcome = attempt.get(row["run_id"], (None, None))
        row["attempt"] = num
        row["run_outcome"] = outcome
    return stats


@router.get("/{slug}/cards/{task_id}")
async def get_card(request: Request, task_id: str) -> dict[str, Any]:
    """One card, re-checked under the caller's principal: a ``private:``
    card owned by someone else is a 404 through the project surface too."""
    project, _role, _profiles, principal = await _require_read(request)

    def _get_sync() -> Optional[dict]:
        with _board_conn(project) as bconn:
            return _card_payload(bconn, project, task_id, principal=principal)

    payload = await asyncio.to_thread(_get_sync)
    if payload is None:
        raise HTTPException(status_code=404, detail="card not found")
    return payload


@router.get("/{slug}/cards/{task_id}/stream")
async def card_stream_route(request: Request, task_id: str) -> StreamingResponse:
    """Push one card's row live while a worker is on it (§12 live updates,
    push edition): the same payload ``GET /cards/{task_id}`` returns —
    including its heartbeat note and comment thread — re-diffed on a short
    server-side tick instead of the browser polling for it. Ends once the
    card leaves ``running``, since nothing else moves it on its own."""
    project, _role, _profiles, principal = await _require_read(request)

    def _produce() -> Optional[dict]:
        with _board_conn(project) as bconn:
            return _card_payload(bconn, project, task_id, principal=principal)

    # A truly unknown/invisible card is a 404, same as the plain GET —
    # see run_stream_route for why this check happens before, not inside,
    # the stream.
    if await asyncio.to_thread(_produce) is None:
        raise HTTPException(status_code=404, detail="card not found")

    return await _watch_stream(
        request, _produce, is_terminal=lambda row: row.get("status") != "running"
    )


_CARD_STATUS_MOVES = ("ready", "blocked", "done", "archived")


def _move_card_sync(bconn, task, new_status: str, actor: str) -> tuple[bool, str]:
    """Route a human column move to the structured kanban verb that owns
    the transition. ``running``/``review``/``scheduled`` are the
    dispatcher's and a worker's to set, never a drag; returns
    ``(ok, reason)`` so the caller can name what refused."""
    cur = task.status
    if cur == new_status:
        return True, ""
    if new_status == "done":
        return kanban_db.complete_task(bconn, task.id), (
            "only a ready or running card can be marked done"
        )
    if new_status == "blocked":
        return kanban_db.block_task(bconn, task.id, reason=f"blocked by {actor}"), (
            "only a ready or running card can be blocked"
        )
    if new_status == "archived":
        return kanban_db.archive_task(bconn, task.id), "the card is already archived"
    if new_status == "ready":
        if cur in ("blocked", "scheduled"):
            return kanban_db.unblock_task(bconn, task.id), "the card is not blocked"
        if cur == "triage":
            # Specify promotes to todo and runs the ready pass itself; a
            # parent-gated card legitimately stays in todo.
            if not kanban_db.specify_triage_task(bconn, task.id):
                return False, "the card left triage already"
            after = kanban_db.get_task(bconn, task.id)
            if after is not None and after.status == "ready":
                return True, ""
        ok, reason = kanban_db.promote_task(bconn, task.id, actor=actor)
        return ok, reason or "the card cannot be made ready from here"
    return False, f"unknown status {new_status!r}"


@router.patch("/{slug}/cards/{task_id}")
async def update_card(request: Request, task_id: str) -> dict[str, Any]:
    """Edit a card by hand: ``title`` / ``body`` / ``assignee`` (a project
    profile, or ``null`` to unassign) / ``status`` (a column move).

    A judgement act (§10): moving a card to ``ready`` is the human
    approval the dispatcher waits for, so the plain ``member`` role may do
    it; a viewer never writes. ``running``, ``review`` and ``scheduled``
    are not settable — the worker and the dispatcher own those.
    """
    project, _role, profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "editing a card")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")

    title = body.get("title")
    if title is not None:
        title = str(title).strip()
        if not title:
            raise HTTPException(status_code=422, detail="title must not be empty")
    card_body = body.get("body")
    if card_body is not None:
        card_body = str(card_body)
    has_assignee = "assignee" in body
    assignee = body.get("assignee")
    if has_assignee and assignee is not None:
        assignee = str(assignee).strip() or None
        if assignee is not None and assignee not in {
            row["profile"] for row in profiles
        }:
            raise HTTPException(
                status_code=422,
                detail=f"{assignee!r} is not one of this project's profiles",
            )
    status = body.get("status")
    if status is not None:
        status = str(status)
        if status not in _CARD_STATUS_MOVES:
            raise HTTPException(
                status_code=422,
                detail="status must be one of " + ", ".join(_CARD_STATUS_MOVES),
            )
    if title is None and card_body is None and not has_assignee and status is None:
        raise HTTPException(status_code=422, detail="nothing to change")

    actor = f"user:{principal.user_id}"

    def _sync() -> dict:
        with _board_conn(project) as bconn:
            task = kanban_db.get_task(bconn, task_id)
            if task is None or getattr(task, "project_id", None) != project.id:
                raise KeyError(task_id)
            if title is not None or card_body is not None:
                sets, vals = [], []
                if title is not None:
                    sets.append("title = ?")
                    vals.append(title)
                if card_body is not None:
                    sets.append("body = ?")
                    vals.append(card_body)
                vals.append(task_id)
                with kanban_db.write_txn(bconn):
                    bconn.execute(
                        f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", vals
                    )
                    kanban_db._append_event(bconn, task_id, "edited", {"actor": actor})
            if has_assignee:
                try:
                    kanban_db.assign_task(bconn, task_id, assignee)
                except RuntimeError as exc:
                    raise ValueError(str(exc))
            if status is not None:
                ok, reason = _move_card_sync(bconn, task, status, actor)
                if not ok:
                    raise ValueError(reason)
            updated = kanban_db.get_task(bconn, task_id)
            return kanban_view.task_dict(updated)

    try:
        return await asyncio.to_thread(_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="card not found")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.post("/{slug}/cards/{task_id}/reclaim")
async def reclaim_card(request: Request, task_id: str) -> dict[str, Any]:
    """Stop a stuck worker and re-queue the card.

    ``reclaim_task`` terminates the worker, releases the claim and resets
    the card to ``ready`` (clearing the failure counter); the dispatcher
    respawns on its next tick. Also the retry path for ``blocked`` cards.
    """
    project, _role, _profiles, _principal = await _require_write(request)

    def _sync() -> bool:
        with _board_conn(project) as bconn:
            task = kanban_db.get_task(bconn, task_id)
            if task is None or getattr(task, "project_id", None) != project.id:
                raise KeyError(task_id)
            return kanban_db.reclaim_task(
                bconn, task_id, reason="agent-home operator re-run"
            )

    try:
        ok = await asyncio.to_thread(_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="card not found")
    if not ok:
        raise HTTPException(
            status_code=409, detail="the card is not reclaimable right now"
        )
    return {"ok": True, "task_id": task_id}


@router.post("/{slug}/cards/{task_id}/stop")
async def stop_card(request: Request, task_id: str) -> dict[str, Any]:
    """Halt the card without a re-run: kill any worker, park it in blocked."""
    project, _role, _profiles, _principal = await _require_write(request)

    def _sync() -> bool:
        with _board_conn(project) as bconn:
            task = kanban_db.get_task(bconn, task_id)
            if task is None or getattr(task, "project_id", None) != project.id:
                raise KeyError(task_id)
            # reclaim first so a live worker is terminated; then block so the
            # dispatcher does not respawn it.
            kanban_db.reclaim_task(bconn, task_id, reason="agent-home operator stop")
            return kanban_db.block_task(
                bconn, task_id, reason="stopped from agent-home"
            )

    try:
        ok = await asyncio.to_thread(_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="card not found")
    if not ok:
        raise HTTPException(
            status_code=409, detail="the card cannot be stopped right now"
        )
    return {"ok": True, "task_id": task_id}


# ---------------------------------------------------------------------------
# Step 4: playbook, directives (guidance), runs, tools/autonomy (§4/§5/§6/§7)
# ---------------------------------------------------------------------------

from hermes_cli import projects_run  # noqa: E402


@router.get("/{slug}/playbook")
async def get_playbook_route(request: Request) -> dict[str, Any]:
    """The method: the active revision (with steps) + the revision list."""
    project, _role, _profiles, _principal = await _require_read(request)

    def _get_sync() -> dict:
        with projects_db.connect_closing() as conn:
            active = projects_db.get_playbook(conn, project.id)
            revs = projects_db.list_playbook_revs(conn, project.id)
        return {"active": active, "revisions": revs}

    return await asyncio.to_thread(_get_sync)


@router.post("/{slug}/playbook")
async def save_playbook_route(request: Request) -> dict[str, Any]:
    """Propose revision N+1 with ``active=0`` (§7.2).

    Open to the ``member`` role — the agent proposes the method; only a
    lead/admin may activate it. Cycle-checked at save time with the
    offending keys named (§7.1), and a step ``assignee`` must be one of
    the project's profiles.
    """
    project, _role, profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "revising its plan")
    body = await request.json()
    steps = body.get("steps") or []

    def _save_sync() -> dict:
        profile_names = {p["profile"] for p in profiles}
        try:
            cleaned = projects_db.validate_playbook_steps(steps)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        for step in cleaned:
            assignee = step.get("assignee")
            if assignee and profile_names and assignee not in profile_names:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"step {step['key']!r}: assignee {assignee!r} is not "
                        f"one of the project's profiles {sorted(profile_names)}"
                    ),
                )
        with projects_db.connect_closing() as conn:
            rev = projects_db.save_playbook_rev(
                conn,
                project_id=project.id,
                body=str(body.get("body") or ""),
                steps=cleaned,
                created_by=principal.user_id,
                note=body.get("note"),
            )
        # A new revision is a proposal: nothing changes until a human
        # activates it, and a running run keeps its pinned rev either way.
        return {"rev": rev, "active": False}

    return await asyncio.to_thread(_save_sync)


# ---------------------------------------------------------------------------
# POST/GET /{slug}/playbook/draft — the agent drafts a proposed revision
# ---------------------------------------------------------------------------
#
# One background job per project, tracked in-process (like chat runs): the
# browser starts it, polls for the outcome, and the proposal lands as an
# ordinary inactive revision the lead activates from the Plan panel. The
# model call is an auxiliary task ("projects_plan"; falls back to the
# compression model when unconfigured), never the interactive agent loop, so
# nothing enters the user's chat.

_PLAN_DRAFTS: dict[str, dict[str, Any]] = {}
_PLAN_DRAFTS_LOCK = threading.Lock()
_PLAN_DRAFT_TASK = "projects_plan"
_PLAN_DRAFT_FALLBACK_TASK = "compression"
_PLAN_DRAFT_MAX_STEPS = 12

_PLAN_DRAFT_SYSTEM = (
    "You draft execution plans for an AI agent that will carry out a project "
    "for a user. Reply with ONE JSON object and nothing else, shaped as "
    '{"body": "<2-4 sentences: the approach>", "steps": [{"key": "<kebab-case, '
    'unique>", "title": "<imperative, one line>", "body": "<what done looks '
    'like, 1-2 sentences>", "depends_on": ["<key>"], "checkpoint": <bool>, '
    '"toolsets": ["<toolset name>"]}]}. '
    "Write 3-7 concrete steps that together deliver every listed output; set "
    "checkpoint=true on a step whose result the user should review before "
    "the agent continues (typically before anything is sent or published). "
    'For each step also set "toolsets" to the minimal subset of the listed '
    "available toolsets the step's worker actually needs (e.g. file + "
    "terminal for document work, web + browser for research); every omitted "
    "toolset shrinks the worker's prompt and speeds it up. Omit the field "
    "only when a step genuinely needs the full tool surface. "
    "Do not invent outputs, people or tools that are not in the brief."
)


def _plan_draft_prompt(
    project,
    outputs: list[dict],
    *,
    clarify_lines: Optional[list[str]] = None,
    enabled_toolsets: Optional[list[str]] = None,
) -> str:
    """The plan drafter's user message. ``clarify_lines`` (the agreed
    scope) is read from the store when not given. ``enabled_toolsets``
    is the host profile's tool surface — the only names a step's
    ``toolsets`` may usefully name."""
    if clarify_lines is None:
        from hermes_cli import projects_clarify_context

        try:
            with projects_db.connect_closing() as conn:
                clarify_lines = projects_clarify_context.clarify_context_lines(
                    conn, project.id
                )
        except Exception:  # pragma: no cover - never block a draft on this
            logger.warning("plan draft: agreed scope unavailable", exc_info=True)
            clarify_lines = []
    lines = [f"Project: {project.name}", f"Goal: {project.goal or ''}"]
    if (project.description or "").strip():
        lines += ["", "Brief:", project.description.strip()]
    if (project.target_audience or "").strip():
        lines += ["", f"Audience: {project.target_audience.strip()}"]
    lines += ["", "Outputs the project must deliver:"]
    for out in outputs:
        flag = "" if out.get("required", 1) else " (optional)"
        lines.append(f"- {out.get('title') or out.get('id')}{flag}")
    lines += [
        "",
        f"Cadence: {project.cadence}; autonomy: {project.autonomy}.",
    ]
    if enabled_toolsets:
        lines += [
            "",
            "Toolsets the step workers may use (a step's \"toolsets\" may "
            "name only these):",
            ", ".join(enabled_toolsets),
        ]
    if clarify_lines:
        from hermes_cli.projects_clarify_context import has_confirmed_scope

        lines += ["", *clarify_lines, ""]
        if has_confirmed_scope(clarify_lines):
            lines.append(
                "The plan must honour the agreed scope and the owner's answers "
                "above: plan nothing outside it and leave out nothing it "
                "requires."
            )
        else:
            lines.append(
                "The owner has not confirmed a scope yet; take their answers "
                "above into account."
            )
    return "\n".join(lines)


def _extract_json_object(text: str) -> dict:
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("the model did not return a plan")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise ValueError("the model did not return a plan")
    return data


def _normalise_draft_steps(
    raw_steps: Any,
    *,
    assignee: Optional[str],
    profile_names: set[str],
    enabled_toolsets: Optional[list[str]] = None,
) -> list[dict]:
    if not isinstance(raw_steps, list) or not raw_steps:
        raise ValueError("the model returned no steps")
    def _slug(raw: Any, fallback: str) -> str:
        key = re.sub(r"[^a-z0-9]+", "-", str(raw or "").lower()).strip("-")
        return key[:40] or fallback

    steps: list[dict] = []
    key_map: dict[str, str] = {}
    seen: set[str] = set()
    for i, step in enumerate(raw_steps[:_PLAN_DRAFT_MAX_STEPS]):
        if not isinstance(step, dict):
            continue
        title = str(step.get("title") or "").strip()
        if not title:
            continue
        original = str(step.get("key") or "").strip()
        key = _slug(original or title, f"step-{i + 1}")
        base, n = key, 2
        while key in seen:
            key = f"{base}-{n}"
            n += 1
        seen.add(key)
        if original:
            key_map[original] = key
        key_map[_slug(original or title, key)] = key
        deps = step.get("depends_on") or step.get("needs") or []
        who = step.get("assignee")
        if not (isinstance(who, str) and who in profile_names):
            who = assignee
        raw_ts = step.get("toolsets")
        step_ts = [
            str(t).strip()
            for t in raw_ts
            if isinstance(t, str) and t.strip()
        ] if isinstance(raw_ts, list) else []
        if enabled_toolsets is not None:
            # The prompt's catalog is the host's enabled surface — a name
            # outside it would be dropped at run start anyway, so keep the
            # saved plan clean of names that could never load.
            enabled_set = set(enabled_toolsets)
            step_ts = [t for t in step_ts if t in enabled_set]
        steps.append(
            {
                "key": key,
                "title": title,
                "body": str(step.get("body") or ""),
                "assignee": who,
                "depends_on": [str(d) for d in deps] if isinstance(deps, list) else [],
                "checkpoint": bool(step.get("checkpoint")),
                "toolsets": step_ts,
            }
        )
    # Dependencies name the model's keys; map them onto the cleaned keys
    # and drop any that did not survive (or point at the step itself).
    for step in steps:
        mapped = [key_map.get(d, key_map.get(_slug(d, ""), d)) for d in step["depends_on"]]
        step["depends_on"] = [
            d for d in dict.fromkeys(mapped) if d in seen and d != step["key"]
        ]
    return projects_db.validate_playbook_steps(steps)


def _call_plan_model(prompt: str) -> str:
    from agent.auxiliary_client import _get_auxiliary_task_config, call_llm

    task = (
        _PLAN_DRAFT_TASK
        if _get_auxiliary_task_config(_PLAN_DRAFT_TASK).get("provider")
        else _PLAN_DRAFT_FALLBACK_TASK
    )
    response = call_llm(
        task,
        messages=[
            {"role": "system", "content": _PLAN_DRAFT_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        temperature=0.3,
        max_tokens=2000,
    )
    return response.choices[0].message.content or ""


_STEP_TOOLSETS_SYSTEM = (
    "You assign tool lists to the steps of an existing execution plan. Each "
    "step runs as its own AI worker; every toolset a worker does not need "
    "shrinks its prompt and speeds it up. Reply with ONE JSON object and "
    'nothing else, shaped as {"toolsets": {"<step key>": ["<toolset name>"]}}, '
    "giving each listed step the minimal subset of the available toolsets it "
    "needs (e.g. file + terminal for document work, web + browser for "
    "research, the matching service toolset for Google Drive or Canva work). "
    "Use only the available toolset names. Leave a step out only when it "
    "genuinely needs the full tool surface."
)


def _step_toolsets_prompt(project, steps: list[dict], enabled_toolsets: list[str]) -> str:
    lines = [f"Project: {project.name}", f"Goal: {project.goal or ''}", ""]
    lines.append("Available toolsets: " + ", ".join(enabled_toolsets))
    lines += ["", "Steps:"]
    for step in steps:
        lines.append(f"- {step['key']}: {step.get('title') or ''}")
        if (step.get("body") or "").strip():
            lines.append(f"  {step['body'].strip()}")
    return "\n".join(lines)


def _call_step_toolsets_model(prompt: str) -> str:
    from agent.auxiliary_client import _get_auxiliary_task_config, call_llm

    task = (
        _PLAN_DRAFT_TASK
        if _get_auxiliary_task_config(_PLAN_DRAFT_TASK).get("provider")
        else _PLAN_DRAFT_FALLBACK_TASK
    )
    response = call_llm(
        task,
        messages=[
            {"role": "system", "content": _STEP_TOOLSETS_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        temperature=0.2,
        max_tokens=1500,
    )
    return response.choices[0].message.content or ""


def fill_missing_step_toolsets(
    steps: list[dict], suggested: Any, enabled_toolsets: list[str]
) -> tuple[list[dict], list[str]]:
    """Copy ``steps`` with the model's ``suggested`` lists on every card step
    that has none. Names outside ``enabled_toolsets`` are dropped; a step the
    model left out (or gave nothing usable) keeps the full surface. Returns
    ``(steps, filled_keys)``."""
    enabled_set = set(enabled_toolsets)
    by_key = suggested if isinstance(suggested, dict) else {}
    out: list[dict] = []
    filled: list[str] = []
    for step in steps:
        step = dict(step)
        if step.get("mode") != "inline" and not step.get("toolsets"):
            raw = by_key.get(step["key"])
            names = list(dict.fromkeys(
                str(t).strip() for t in (raw if isinstance(raw, list) else [])
                if isinstance(t, str) and str(t).strip() in enabled_set
            ))
            if names:
                step["toolsets"] = names
                filled.append(step["key"])
        out.append(step)
    return out, filled


@router.post("/{slug}/playbook/toolsets")
async def fill_playbook_toolsets_route(request: Request) -> dict[str, Any]:
    """Propose the active plan again with a tool list on every step that
    lacks one, so its card workers load only what they need. Lands as an
    ordinary inactive revision — activation stays human (§7.2)."""
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "revising its plan")

    def _fill_sync() -> dict:
        with projects_db.connect_closing() as conn:
            active = projects_db.get_playbook(conn, project.id)
        if not active:
            raise HTTPException(status_code=409, detail="the project has no active plan")
        steps = active.get("steps") or []
        missing = [
            s for s in steps if s.get("mode") != "inline" and not s.get("toolsets")
        ]
        if not missing:
            raise HTTPException(
                status_code=409, detail="every step already has a tool list"
            )
        enabled = projects_run._enabled_toolsets_for_profile(
            project.host_profile or ""
        )
        if not enabled:
            raise HTTPException(
                status_code=409,
                detail="the host profile's toolsets are unavailable",
            )
        try:
            data = _extract_json_object(
                _call_step_toolsets_model(
                    _step_toolsets_prompt(project, missing, enabled)
                )
            )
        except Exception as exc:  # noqa: BLE001 — reported, not raised raw
            raise HTTPException(
                status_code=502, detail=_plan_draft_error_detail(exc)
            )
        new_steps, filled = fill_missing_step_toolsets(
            steps, data.get("toolsets"), enabled
        )
        if not filled:
            raise HTTPException(
                status_code=502, detail="the model suggested no usable tool lists"
            )
        with projects_db.connect_closing() as conn:
            rev = projects_db.save_playbook_rev(
                conn,
                project_id=project.id,
                body=str(active.get("body") or ""),
                steps=new_steps,
                created_by=principal.user_id,
                note=f"tool lists added to rev {active.get('rev')} by the agent",
            )
        return {
            "rev": rev,
            "active": False,
            "from_rev": active.get("rev"),
            "filled": filled,
            "steps": [
                {"key": s["key"], "title": s.get("title"), "toolsets": s.get("toolsets") or []}
                for s in new_steps
            ],
        }

    return await asyncio.to_thread(_fill_sync)


def _plan_draft_error_detail(exc: Exception) -> str:
    """Translate provider failures into an actionable detail for the UI."""
    err = str(exc)
    try:
        from agent.auxiliary_client import _is_auth_error, _is_payment_error

        if _is_payment_error(exc):
            return (
                "The model provider for plan drafting denied access "
                "(subscription or model entitlement inactive). Renew the "
                "provider plan or repoint auxiliary.compression / "
                f"auxiliary.projects_plan in config. Provider said: {err}"
            )
        if _is_auth_error(exc):
            return (
                "The model provider for plan drafting rejected its "
                "credentials. Re-authenticate the provider, then retry. "
                f"Provider said: {err}"
            )
    except Exception:
        pass
    return err


def _plan_draft_job(
    *,
    project_id: str,
    prompt: str,
    assignee: Optional[str],
    profile_names: set[str],
    created_by: Optional[str],
    enabled_toolsets: Optional[list[str]] = None,
) -> None:
    def _set(**fields: Any) -> None:
        with _PLAN_DRAFTS_LOCK:
            state = _PLAN_DRAFTS.get(project_id)
            if state is not None:
                state.update(fields)

    try:
        data = _extract_json_object(_call_plan_model(prompt))
        steps = _normalise_draft_steps(
            data.get("steps"),
            assignee=assignee,
            profile_names=profile_names,
            enabled_toolsets=enabled_toolsets,
        )
        with projects_db.connect_closing() as conn:
            rev = projects_db.save_playbook_rev(
                conn,
                project_id=project_id,
                body=str(data.get("body") or "").strip(),
                steps=steps,
                created_by=created_by,
                note="drafted by the agent",
            )
        _set(status="done", rev=rev, finished_at=int(time.time()))
    except Exception as exc:  # noqa: BLE001 — surfaced to the UI, not raised
        logger.warning("plan draft failed for project %s: %s", project_id, exc)
        _set(
            status="failed",
            detail=_plan_draft_error_detail(exc),
            finished_at=int(time.time()),
        )


def start_plan_draft(project, profiles, principal) -> dict:
    """Start the background plan draft for ``project``; returns the job state.

    Raises ``HTTPException`` 409 while a draft is already running or when
    the project declares no outputs. Shared by the draft route and the
    scope-confirm route (``projects_clarify_api``)."""
    with _PLAN_DRAFTS_LOCK:
        current = _PLAN_DRAFTS.get(project.id)
        if current and current.get("status") == "running":
            raise HTTPException(
                status_code=409, detail="the agent is already drafting a plan"
            )
    with projects_db.connect_closing() as conn:
        outputs = projects_db.get_project_outputs(conn, project.id)
    if not outputs:
        raise HTTPException(
            status_code=409,
            detail="declare at least one output before drafting a plan",
        )
    profile_names = {p["profile"] for p in profiles}
    assignee = project.host_profile or (
        sorted(profile_names)[0] if profile_names else None
    )
    enabled_toolsets: Optional[list[str]] = None
    if assignee:
        try:
            enabled_toolsets = projects_run._enabled_toolsets_for_profile(
                assignee
            )
        except Exception:  # noqa: BLE001 — the draft works without a catalog
            logger.debug(
                "plan draft: toolset catalog unavailable for %s",
                assignee, exc_info=True,
            )
    state = {"status": "running", "started_at": int(time.time())}
    with _PLAN_DRAFTS_LOCK:
        _PLAN_DRAFTS[project.id] = state
        # Snapshot before the job starts: it updates ``state`` in place and
        # can finish before this function returns.
        started = dict(state)
    threading.Thread(
        target=_plan_draft_job,
        kwargs={
            "project_id": project.id,
            "prompt": _plan_draft_prompt(
                project, outputs, enabled_toolsets=enabled_toolsets
            ),
            "assignee": assignee,
            "profile_names": profile_names,
            "created_by": principal.user_id,
            "enabled_toolsets": enabled_toolsets,
        },
        name=f"plan-draft-{project.slug}",
        daemon=True,
    ).start()
    return started


@router.post("/{slug}/playbook/draft")
async def draft_playbook_route(request: Request) -> dict[str, Any]:
    """Ask the agent to draft a proposed plan from the brief (§7.2).

    Same gate as saving a revision — the proposal is inactive until a
    lead activates it. Returns at once; poll ``GET …/playbook/draft``.
    """
    project, _role, profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "drafting its plan")
    return await asyncio.to_thread(start_plan_draft, project, profiles, principal)


@router.get("/{slug}/playbook/draft")
async def draft_playbook_status_route(request: Request) -> dict[str, Any]:
    project, _role, _profiles, _principal = await _require_read(request)
    with _PLAN_DRAFTS_LOCK:
        state = _PLAN_DRAFTS.get(project.id)
        return dict(state) if state else {"status": "idle"}


@router.post("/{slug}/playbook/{rev}/activate")
async def activate_playbook_route(request: Request, rev: int) -> dict[str, Any]:
    """Human-only activation (§7.2): lead/admin AND a verified session,
    records ``activated_at`` + ``note``. A mid-flight run is unaffected —
    it keeps its pinned rev."""
    project, _role, _profiles, _principal = await _require_write(request)
    _refuse_if_archived(project, "activating a plan")
    subject = await _require_human(request, "activating a playbook revision")
    body = await request.json() if request.headers.get("content-length") else {}

    def _activate_sync() -> dict:
        with projects_db.connect_closing() as conn:
            ok = projects_db.activate_playbook_rev(
                conn, project.id, rev, note=body.get("note")
            )
        if not ok:
            raise HTTPException(
                status_code=404, detail=f"playbook revision {rev} not found"
            )
        return {"rev": rev, "active": True, "by": subject}

    return await asyncio.to_thread(_activate_sync)


@router.delete("/{slug}/playbook/{rev}")
async def discard_playbook_route(request: Request, rev: int) -> dict[str, Any]:
    """Discard a proposed revision — the paired human judgement to
    activation (§7.2). Refused for the active rev and for any rev a run
    pinned (it is that run's recorded plan and stays for history)."""
    project, _role, _profiles, _principal = await _require_write(request)
    _refuse_if_archived(project, "discarding a plan revision")
    await _require_human(request, "discarding a playbook revision")

    def _discard_sync() -> dict:
        with projects_db.connect_closing() as conn:
            refusal = projects_db.discard_playbook_rev(conn, project.id, rev)
        if refusal == "not_found":
            raise HTTPException(
                status_code=404, detail=f"playbook revision {rev} not found"
            )
        if refusal == "active":
            raise HTTPException(
                status_code=409,
                detail="the active revision cannot be discarded",
            )
        if refusal and refusal.startswith("pinned:"):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"revision {rev} is pinned by run "
                    f"{refusal.split(':', 1)[1]} — it is that run's recorded "
                    "plan and stays for history"
                ),
            )
        return {"rev": rev, "discarded": True}

    return await asyncio.to_thread(_discard_sync)


@router.get("/{slug}/directives")
async def list_directives_route(request: Request) -> dict[str, Any]:
    project, _role, _profiles, _principal = await _require_read(request)
    include_retired = request.query_params.get("include_retired") == "true"

    def _list_sync() -> dict:
        with projects_db.connect_closing() as conn:
            rows = projects_db.list_project_directives(
                conn, project.id, active_only=not include_retired
            )
            proposed = projects_db.list_proposed_directives(conn, project.id)
        return {
            "directives": rows,
            # §8.2: what runs proposed — inactive until a member activates.
            "proposed": proposed,
            # §5.1: guidance never applies mid-conversation.
            "applies_from": "next run",
        }

    return await asyncio.to_thread(_list_sync)


@router.post("/{slug}/directives")
async def add_directive_route(request: Request) -> dict[str, Any]:
    """Standing instruction or feedback (§5). Judgement act: ``member``+.
    The active set is capped — adding directive N+1 is a 409 *retire one
    first*. The response carries the one product sentence that must never
    be omitted: guidance applies from the next run."""
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "adding guidance")
    body = await request.json()

    def _add_sync() -> dict:
        cfg = projects_run.projects_runtime_config()
        with projects_db.connect_closing() as conn:
            try:
                did = projects_db.add_project_directive(
                    conn,
                    project_id=project.id,
                    kind=body.get("kind", "directive"),
                    body=body.get("body", ""),
                    scope=body.get("scope", "project"),
                    target_ref=body.get("target_ref"),
                    rating=body.get("rating"),
                    author_user_id=principal.user_id,
                    max_active=cfg["guidance_max_directives"],
                )
            except ValueError as exc:
                status = 409 if "retire one first" in str(exc) else 422
                raise HTTPException(status_code=status, detail=str(exc))
            row = conn.execute(
                "SELECT * FROM project_directives WHERE id = ?", (did,)
            ).fetchone()
        # The full row, so a UI can show the new instruction — body, author,
        # date — without a reload; ``applies_from`` rides flat beside it.
        return {**(dict(row) if row else {"id": did}),
                "applies_from": "next run"}

    return await asyncio.to_thread(_add_sync)


@router.post("/{slug}/directives/{directive_id}/retire")
async def retire_directive_route(
    request: Request, directive_id: str
) -> dict[str, Any]:
    """Retire, never delete (§5.2): the historical record survives."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )

    def _retire_sync() -> dict:
        with projects_db.connect_closing() as conn:
            ok = projects_db.retire_project_directive(conn, directive_id)
        if not ok:
            raise HTTPException(
                status_code=404, detail="directive not found or already retired"
            )
        return {"id": directive_id, "retired": True}

    return await asyncio.to_thread(_retire_sync)


@router.post("/{slug}/directives/{directive_id}/activate")
async def activate_directive_route(
    request: Request, directive_id: str
) -> dict[str, Any]:
    """§8.2: a proposed directive crosses on a **human's** word — the one
    learning-path crossing, so it carries the identity gate (§16). The
    active-set cap is enforced here, at the crossing, not at proposal time;
    like every guidance write, it applies from the next run."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "activating guidance")
    subject = await _require_human(request, "activating a directive")

    def _activate_sync() -> dict:
        cfg = projects_run.projects_runtime_config()
        with projects_db.connect_closing() as conn:
            row = conn.execute(
                "SELECT project_id, active, retired_at FROM project_directives "
                "WHERE id = ?",
                (directive_id,),
            ).fetchone()
            if (
                row is None
                or row["project_id"] != project.id
                or row["active"]
                or row["retired_at"] is not None
            ):
                raise KeyError(directive_id)
            try:
                projects_db.activate_project_directive(
                    conn,
                    directive_id,
                    max_active=cfg["guidance_max_directives"],
                )
            except ValueError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
        return {
            "id": directive_id, "active": True, "applies_from": "next run",
            "by": subject,
        }

    try:
        return await asyncio.to_thread(_activate_sync)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail="directive not found, already active, or retired",
        )


# ---------------------------------------------------------------------------
# Runs (§6)
# ---------------------------------------------------------------------------


_RUN_STALL_SECONDS = 10 * 60


def _run_stalled(
    run: dict, cards: list[dict], blocked_tasks: list[dict]
) -> bool:
    """A ``running`` run with no claimable card has no worker behind it.

    The dispatcher promotes ready cards within a tick (~60s), so a run
    whose cards sit todo for over ten minutes is orphaned, not busy; a
    blocked task anywhere in the tree (the cards then wait on it
    forever) means it right now.
    """
    if run.get("status") != "running" or not cards:
        return False
    statuses = {c.get("status") for c in cards}
    if statuses & {"running", "ready"}:
        return False
    if blocked_tasks:
        return True
    started = run.get("started_at")
    return (
        started is not None
        and int(time.time()) - int(started) > _RUN_STALL_SECONDS
    )


_CARD_WEIGHT = {
    "done": 1.0,
    "running": 0.5,
    "blocked": 0.0,
    "ready": 0.0,
    "todo": 0.0,
    "triage": 0.0,
    "archived": 0.0,
}


def _run_completion_percent(run: dict, cards: list[dict]) -> int:
    """0–100 from the cards' board state: done counts whole, a card with a
    worker on it counts half. A finished run reads 100 whatever its cards
    ended as (cancel archives them); a run without cards is 0 until done."""
    if run.get("status") == "done":
        return 100
    if not cards:
        return 0
    total = sum(_CARD_WEIGHT.get(c.get("status") or "", 0.0) for c in cards)
    return int(round(100 * total / len(cards)))


def _card_attempts(bconn, task_id: str) -> dict:
    """Attempt history for a card, so the run page can say *why* a card is
    on its second try instead of showing a bare ``running``.

    ``attempts`` counts every worker claim; ``failed_attempts`` the closed
    ones that did not complete/block cleanly (crash, timeout, protocol
    violation, spawn failure); ``last_error`` is the newest such error.
    """
    runs = kanban_db.list_runs(bconn, task_id)
    failed = [
        r for r in runs
        if r.ended_at is not None
        and r.outcome not in ("completed", "blocked", "reclaimed", None)
    ]
    last = failed[-1] if failed else None
    return {
        "attempts": len(runs),
        "failed_attempts": len(failed),
        "last_error": last.error if last else None,
        "last_outcome": last.outcome if last else None,
    }


def _run_blocked_tasks(bconn, cards: list[dict]) -> list[dict]:
    """Blocked tasks anywhere in the run's dependency tree.

    A decomposed run stalls when a subtask blocks: the run's own cards
    then wait, ``todo``, forever. Listing them (with the failure that
    blocked them) puts the retry one tap away on the run page.
    """
    seeds = [c["task_id"] for c in cards]
    if not seeds:
        return []
    seen: set[str] = set()
    stack = list(seeds)
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        stack.extend(kanban_db.parent_ids(bconn, node))
        stack.extend(kanban_db.child_ids(bconn, node))
    blocked = []
    for task_id in sorted(seen - set(seeds)):
        task = kanban_db.get_task(bconn, task_id)
        if task is not None and task.status == "blocked":
            blocked.append(
                {
                    "task_id": task_id,
                    "title": task.title,
                    "status": task.status,
                    "error": task.last_failure_error,
                }
            )
    return blocked


def _checkpoint_wait_payload(conn, bconn, project, run: dict, cards: list[dict]) -> Optional[dict]:
    """The UI-facing form of `projects_run.checkpoint_wait_info` — adds the
    checkpoint card's own comment/summary (its findings/questions) so the
    run page can show *what* it's waiting on, not just *that* it is (§12).
    """
    info = projects_run.checkpoint_wait_info(conn, project, run, cards)
    if info is None:
        return None
    task_id = info.get("checkpoint_task_id")
    comment = None
    if task_id:
        try:
            comments = kanban_db.list_comments(bconn, task_id)
            comment = comments[-1].body if comments else kanban_db.latest_summary(bconn, task_id)
        except Exception:  # noqa: BLE001 — the hold itself is still real without this
            comment = None
    return {
        "checkpoint_task_id": task_id,
        "checkpoint_title": info.get("checkpoint_title"),
        "comment": comment,
        "held_task_ids": info.get("held_task_ids") or [],
    }


def _run_payload(
    conn, bconn, run: dict, *, principal, project: projects_db.Project
) -> dict:
    """One run row joined with its cards' live board state."""
    cards = []
    for rc in projects_db.get_run_cards(conn, run["id"]):
        task = kanban_db.get_task(bconn, rc["task_id"])
        card = {
            "task_id": rc["task_id"],
            "step_key": rc.get("step_key"),
            "status": task.status if task else None,
            "title": task.title if task else None,
        }
        card.update(_card_attempts(bconn, rc["task_id"]))
        cards.append(card)
    payload = dict(run)
    payload["cards"] = cards
    payload["completion_percent"] = _run_completion_percent(run, cards)
    blocked = _run_blocked_tasks(bconn, cards)
    payload["blocked_tasks"] = blocked
    waiting = (
        projects_run.run_human_waits(bconn, [c["task_id"] for c in cards])
        if run.get("status") == "running"
        else []
    )
    payload["waiting_on_you"] = waiting
    payload["stalled"] = not waiting and _run_stalled(run, cards, blocked)
    checkpoint_wait = _checkpoint_wait_payload(conn, bconn, project, run, cards)
    payload["awaiting_continue"] = checkpoint_wait is not None
    payload["checkpoint_wait"] = checkpoint_wait
    payload["cost"] = projects_run.run_cost(
        run.get("trace_id"), principal=principal
    )
    # Fail-open contract (§6): no ledger → "not recorded", never an error.
    payload["cost_recorded"] = payload["cost"] is not None
    if run.get("started_at"):
        end = run.get("ended_at") or int(time.time())
        payload["duration_seconds"] = max(0, end - int(run["started_at"]))
    return payload


@router.get("/{slug}/runs")
async def list_runs_route(request: Request) -> dict[str, Any]:
    """The record (§12): duration, outcome, deliveries and status."""
    project, _role, _profiles, _principal = await _require_read(request)

    def _list_sync() -> dict:
        with projects_db.connect_closing() as conn:
            runs = projects_db.list_project_runs(conn, project.id)
            deliveries = projects_db.get_output_deliveries(
                conn, project_id=project.id
            )
        by_run: dict = {}
        for d in deliveries:
            if d.get("run_id"):
                by_run.setdefault(d["run_id"], 0)
                by_run[d["run_id"]] += 1
        for r in runs:
            r["deliveries"] = by_run.get(r["id"], 0)
            if r.get("started_at"):
                end = r.get("ended_at") or int(time.time())
                r["duration_seconds"] = max(0, end - int(r["started_at"]))
        return {"runs": runs}

    return await asyncio.to_thread(_list_sync)


@router.get("/{slug}/runs/{run_no}")
async def get_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """Run detail: cards, deliveries, cost read from the C8 trace (never
    stored — fail-open), and the retro once written."""
    project, _role, _profiles, principal = await _require_read(request)

    def _get_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            deliveries = projects_db.get_output_deliveries(conn, run_id=run["id"])
            with _board_conn(project) as bconn:
                payload = _run_payload(
                    conn, bconn, run, principal=principal, project=project
                )
        payload["deliveries"] = deliveries
        return payload

    try:
        return await asyncio.to_thread(_get_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


@router.post("/{slug}/runs")
async def start_run_route(request: Request) -> dict[str, Any]:
    """Start a run now. ``trigger`` defaults to ``manual``; the CLI's
    ``run`` verb (step 9) passes ``schedule``/``event``/``review`` through
    the same gate — the cron job fires ``hermes projects run <slug>
    --trigger schedule`` (§3.2). An optional ``playbook_rev`` repeats an
    old method — "do exactly what worked last time" (§7.2)."""
    project, _role, _profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "running it")
    body = await request.json() if request.headers.get("content-length") else {}
    trigger = str(body.get("trigger") or "manual").strip()
    if trigger not in projects_db.VALID_RUN_TRIGGERS:
        raise HTTPException(
            status_code=422,
            detail=f"trigger must be one of {sorted(projects_db.VALID_RUN_TRIGGERS)}",
        )

    def _start_sync() -> dict:
        with projects_db.connect_closing() as conn:
            with _board_conn(project) as bconn:
                try:
                    return projects_run.start_run(
                        conn,
                        bconn,
                        project=project,
                        trigger=trigger,
                        triggered_by=principal.user_id,
                        playbook_rev=body.get("playbook_rev"),
                    )
                except (
                    projects_db.RunAlreadyOpen, projects_run.ScheduledRunSkipped
                ) as exc:
                    raise HTTPException(status_code=409, detail=str(exc))
                except ValueError as exc:
                    detail = str(exc)
                    status = 409 if "no playbook" in detail or "no profiles" in detail else 422
                    raise HTTPException(status_code=status, detail=detail)

    return await asyncio.to_thread(_start_sync)


@router.post("/{slug}/runs/{run_no}/continue")
async def continue_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """The human passes a checkpoint or answers a budget stop (§12): the
    held successors move to ``todo`` and a ``waiting`` run resumes."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "continuing a run")

    def _continue_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            with _board_conn(project) as bconn:
                try:
                    return projects_run.continue_run(
                        conn, bconn, project=project, run=run
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=409, detail=str(exc))

    try:
        return await asyncio.to_thread(_continue_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


@router.post("/{slug}/runs/{run_no}/resume")
async def resume_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """Continue a ``failed``/``cancelled`` run from wherever its cards
    already are — distinct from ``POST /runs`` ("Repeat this run"), which
    starts a brand-new run on the same method and redoes every step."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "resuming a run")

    def _resume_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            with _board_conn(project) as bconn:
                try:
                    return projects_run.resume_run(
                        conn, bconn, project=project, run=run
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=409, detail=str(exc))

    try:
        return await asyncio.to_thread(_resume_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


@router.post("/{slug}/runs/{run_no}/cancel")
async def cancel_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """Stop promoting and archive the run's un-started cards; a running
    worker is never killed (§12)."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )

    def _cancel_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            with _board_conn(project) as bconn:
                try:
                    return projects_run.cancel_run(
                        conn, bconn, project=project, run=run
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=409, detail=str(exc))

    try:
        return await asyncio.to_thread(_cancel_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


#: How often the activity stream looks for new events. Reasoning arrives in
#: bursts, so a short poll of an in-memory buffer reads as live without
#: coupling the agent thread to this request's event loop.
_ACTIVITY_TICK_SECONDS = 0.4

#: How often the row-level live streams (run, card, project cursor) re-read
#: their row and check for a change. Most of a tick's cost is a local
#: SQLite read, so this can run tighter than the old client polls
#: (RUN_POLL_INTERVAL_MS / CARD_POLL_INTERVAL_MS were 5s, the project page's
#: was 15s) without adding real load — a change now reaches the browser in
#: about one tick instead of averaging half the old interval.
_ROW_TICK_SECONDS = 1.0

#: Send a bare SSE comment this often when nothing has changed, so a
#: reverse proxy's idle-connection timeout never closes a quiet stream out
#: from under a long-open tab. A comment line (leading ``:``) is invisible
#: to `readSseFrames` — it never reaches a frame handler.
_ROW_HEARTBEAT_SECONDS = 20.0


async def _watch_stream(
    request: Request,
    produce: Callable[[], Optional[dict]],
    *,
    is_terminal: Callable[[dict], bool],
    tick_seconds: float = _ROW_TICK_SECONDS,
) -> StreamingResponse:
    """Shared tick-and-diff loop behind the run/card/project-cursor live
    streams (§12 live updates, push edition).

    Re-reads ``produce()`` on a short local interval and emits an
    ``update`` frame only when the serialised row actually changed, so a
    quiet run doesn't spam frames and a real change reaches the browser
    within one tick. Emits ``gone`` and ends if ``produce()`` returns
    ``None`` (the row disappeared or became unreadable under the caller's
    principal); emits ``end`` and ends once ``is_terminal`` says there is
    nothing left to watch; ends silently on client disconnect. A read
    failure is never surfaced here — same contract as the plain GET routes
    this mirrors and `run_activity_route`.
    """

    async def _events():
        last: Optional[str] = None
        idle = 0.0
        while True:
            row = await asyncio.to_thread(produce)
            if row is None:
                yield _sse("gone", {})
                return
            serialized = json.dumps(row, sort_keys=True, default=str)
            if serialized != last:
                last = serialized
                idle = 0.0
                yield _sse("update", row)
                if is_terminal(row):
                    yield _sse("end", {})
                    return
            else:
                idle += tick_seconds
                if idle >= _ROW_HEARTBEAT_SECONDS:
                    idle = 0.0
                    yield b": keep-alive\n\n"
            if await request.is_disconnected():
                return
            await asyncio.sleep(tick_seconds)

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


#: Matches `useRunLive.ts`'s TERMINAL set exactly: once a run reaches one of
#: these there is nothing left for the stream to watch — unless a card is
#: still actively running (see `_run_is_terminal` below).
_RUN_TERMINAL_STATUSES = {"done", "failed", "cancelled"}


def _run_is_terminal(row: dict) -> bool:
    """Mirrors `useRunLive.ts`'s `isRunLive(status, hasActiveCard)` exactly:
    a terminal run row (e.g. auto-failed by the stale-run sweep) can still
    have a card actively working, and a human can act on that card directly
    without the run row ever reopening in the same instant. Ending the
    stream the moment the row closes would freeze the page on a stale
    "Failed" banner instead of showing that card actually finish — the
    confusion PR #403 was built to fix. So a terminal row keeps the stream
    open for as long as any of its cards is still `running`."""
    if row.get("status") not in _RUN_TERMINAL_STATUSES:
        return False
    return not any(c.get("status") == "running" for c in row.get("cards") or [])


@router.get("/{slug}/runs/{run_no}/stream")
async def run_stream_route(request: Request, run_no: int) -> StreamingResponse:
    """Push the run row live instead of making the browser poll for it
    (§12 live updates, push edition): the same payload ``GET
    /runs/{run_no}`` returns, re-diffed on a short server-side tick so a
    status/board/card change reaches the page in about a second instead of
    waiting out the old poll interval. Ends once the run reaches a
    terminal status with no card still running."""
    project, _role, _profiles, principal = await _require_read(request)

    def _produce() -> Optional[dict]:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                return None
            deliveries = projects_db.get_output_deliveries(conn, run_id=run["id"])
            with _board_conn(project) as bconn:
                payload = _run_payload(
                    conn, bconn, run, principal=principal, project=project
                )
        payload["deliveries"] = deliveries
        return payload

    # A truly unknown run is a 404, same as the plain GET — matching
    # run_activity_route's convention of checking existence before opening
    # the stream. `_produce` returning None once the stream is already open
    # (the run vanished mid-watch, which should not happen in practice) is
    # instead a `gone` frame, since an HTTP status can no longer change.
    if await asyncio.to_thread(_produce) is None:
        raise HTTPException(status_code=404, detail="run not found")

    return await _watch_stream(request, _produce, is_terminal=_run_is_terminal)


@router.get("/{slug}/events/stream")
async def project_events_stream(request: Request) -> StreamingResponse:
    """Push the project's event cursor live (§12): the same
    ``latest_event_id`` ``GET /events`` returns, so the project page's tail
    can react to a movement immediately instead of on its next poll. A
    project has no terminal state, so this stream only ends on client
    disconnect — a reverse proxy's idle timeout is covered by the shared
    heartbeat, same as the run/card streams."""
    project, _role, _profiles, principal = await _require_read(request)

    def _produce() -> dict:
        with _board_conn(project) as bconn:
            latest, _events = kanban_db.project_events_tail(
                bconn, project.id, principal=principal, since_id=0, limit=1
            )
        return {"latest_event_id": latest}

    return await _watch_stream(request, _produce, is_terminal=lambda _row: False)


@router.get("/{slug}/runs/{run_no}/activity")
async def run_activity_route(request: Request, run_no: int) -> StreamingResponse:
    """What the run is thinking, as it thinks it (§12).

    Server-sent events: ``reasoning`` for the agent's own words, ``tool``
    for a tool's id and name, ``status`` for start/end. A tool's arguments
    and results are never sent — they carry file contents and credentials,
    and this stream is read by a browser.

    ``?after=`` resumes from a sequence number, so a reconnect (or a second
    device) replays what it missed rather than starting blank. Only the
    run's **inline** steps are visible here: a board-dispatched card runs in
    another process, and the stream says ``unavailable`` rather than
    implying an empty buffer means an idle run.
    """
    project, _role, _profiles, _principal = await _require_read(request)
    raw_after = request.query_params.get("after")
    after = 0
    if raw_after is not None:
        try:
            after = int(raw_after)
        except ValueError:
            raise HTTPException(status_code=400, detail="after must be an integer")
        if after < 0:
            raise HTTPException(status_code=400, detail="after must be >= 0")

    def _run_sync() -> Optional[dict]:
        with projects_db.connect_closing() as conn:
            return projects_db.get_project_run(conn, project.id, run_no)

    run = await asyncio.to_thread(_run_sync)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")

    key = run_activity.run_key(project.id, run_no)

    async def _events():
        cursor = after
        while True:
            events, done, known = run_activity.read(key, cursor)
            if not known:
                yield _sse(
                    "unavailable",
                    {
                        "reason": (
                            "This run's steps are not running in this process, "
                            "so there is no live reasoning to show."
                        )
                    },
                )
                return
            for event in events:
                cursor = event["seq"]
                yield _sse(event["kind"], event)
            if done:
                yield _sse("end", {"cursor": cursor})
                return
            if await request.is_disconnected():
                return
            await asyncio.sleep(_ACTIVITY_TICK_SECONDS)

    return StreamingResponse(
        _events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


def _sse(event: str, payload: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n".encode(
        "utf-8"
    )


@router.post("/{slug}/runs/{run_no}/stop")
async def stop_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """Stop the run now: terminate every live worker, archive what has not
    started, close the run. The verb Cancel deliberately is not (§12)."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )

    def _stop_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            with _board_conn(project) as bconn:
                try:
                    return projects_run.stop_run(
                        conn, bconn, project=project, run=run
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=409, detail=str(exc))

    try:
        return await asyncio.to_thread(_stop_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


VALID_PROPOSAL_KINDS = ("playbook", "directive", "skill")


def _parse_proposals(body: dict) -> list[dict]:
    """The retro's at-most-three concrete proposals (§8.1). Each is a dict
    with a ``kind`` — playbook | directive | skill — and a non-empty
    ``body``; nothing here is applied yet, everything materializes
    inactive (§8.2)."""
    proposals = body.get("proposals")
    if proposals is None:
        return []
    if not isinstance(proposals, list):
        raise HTTPException(
            status_code=422, detail="proposals must be a list"
        )
    if len(proposals) > 3:
        raise HTTPException(
            status_code=422,
            detail="at most three concrete proposals per retro (§8.1)",
        )
    cleaned: list[dict] = []
    for i, p in enumerate(proposals):
        if not isinstance(p, dict):
            raise HTTPException(
                status_code=422, detail=f"proposal {i + 1} must be an object"
            )
        kind = str(p.get("kind") or "").strip()
        if kind not in VALID_PROPOSAL_KINDS:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"proposal {i + 1}: kind must be one of "
                    f"{sorted(VALID_PROPOSAL_KINDS)}"
                ),
            )
        text = str(p.get("body") or "").strip()
        if not text:
            raise HTTPException(
                status_code=422,
                detail=f"proposal {i + 1}: body must not be empty",
            )
        cleaned.append({"kind": kind, "body": text, "raw": p})
    return cleaned


@router.post("/{slug}/runs/{run_no}/retro")
async def run_retro_route(request: Request, run_no: int) -> dict[str, Any]:
    """Write or edit the retrospective. An optional ``score_self`` (1–5,
    §8.1) rides with it — the run's own claim against ``score_rubric``,
    written unprompted so self-scores stay comparable to human ones.
    ``score_user`` is human-only on the ``/score`` route.

    The retro may carry ``proposals`` — at most three (§8.1), one per §8.2
    destination, and each lands **inactive**: a playbook revision (``note``
    naming the run) a lead/admin activates, a directive row any member
    activates, and a skill candidate recording this project and run as its
    provenance. Nothing on the learning path is automatic."""
    project, _role, profiles, principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "writing a retro")
    body = await request.json()
    retro = str(body.get("retro") or "").strip()
    if not retro:
        raise HTTPException(status_code=422, detail="retro must not be empty")
    score_self = body.get("score_self")
    if score_self is not None:
        try:
            score_self = int(score_self)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=422, detail="score_self must be an integer 1–5"
            )
        if not 1 <= score_self <= 5:
            raise HTTPException(
                status_code=422, detail="score_self must be between 1 and 5"
            )
    proposals = _parse_proposals(body)
    profile_names = {p["profile"] for p in profiles}

    def _materialize(conn, run_no: int) -> list[dict]:
        """One connection, all crossings inactive (§8.2)."""
        landed: list[dict] = []
        for p in proposals:
            if p["kind"] == "playbook":
                try:
                    cleaned = projects_db.validate_playbook_steps(
                        p["raw"].get("steps") or []
                    )
                except ValueError as exc:
                    raise HTTPException(status_code=422, detail=str(exc))
                for step in cleaned:
                    assignee = step.get("assignee")
                    if assignee and profile_names and assignee not in profile_names:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"step {step['key']!r}: assignee {assignee!r} "
                                f"is not one of the project's profiles "
                                f"{sorted(profile_names)}"
                            ),
                        )
                rev = projects_db.save_playbook_rev(
                    conn,
                    project_id=project.id,
                    body=p["body"],
                    steps=cleaned,
                    created_by=principal.user_id,
                    note=f"proposed by run {run_no}",
                )
                landed.append({"kind": "playbook", "rev": rev, "active": False})
            elif p["kind"] == "directive":
                did = projects_db.add_project_directive(
                    conn,
                    project_id=project.id,
                    kind="directive",
                    body=p["body"],
                    author_user_id=principal.user_id,
                    active=False,
                )
                landed.append({"kind": "directive", "id": did, "active": False})
            else:  # skill — provenance only (§8.2 row 3)
                name = str(p["raw"].get("name") or "").strip() or (
                    f"know-how from run {run_no}"
                )
                cid = projects_db.add_skill_candidate(
                    conn,
                    project_id=project.id,
                    run_no=run_no,
                    name=name,
                    body=p["body"],
                )
                landed.append({"kind": "skill", "id": cid})
        return landed

    def _retro_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            fields: dict = {"retro": retro, "retro_at": int(time.time())}
            if score_self is not None:
                fields["score_self"] = score_self
            projects_db.update_project_run(conn, run["id"], **fields)
            payload = projects_db.get_project_run_by_id(conn, run["id"])
            payload["proposals"] = _materialize(conn, run_no)
            return payload

    try:
        return await asyncio.to_thread(_retro_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


@router.post("/{slug}/runs/{run_no}/score")
async def score_run_route(request: Request, run_no: int) -> dict[str, Any]:
    """``score_user`` + ``score_note`` (§8.1): 1–5, optional, **human-only
    and editable** — never agent-writable, re-scoring just overwrites.

    A judgement act (``member``+), and the one write with an identity gate
    on top: a caller without a verified interactive session is refused
    (§16). The derived project score (mean of the last five) moves on
    every read, including when an old run is re-scored."""
    project, _role, _profiles, _principal = await _require_write(
        request, judgement=True
    )
    _refuse_if_archived(project, "scoring a run")
    subject = await _require_human(request, "scoring a run")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    try:
        score = int(body.get("score"))
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=422, detail="score must be an integer 1–5"
        )
    if not 1 <= score <= 5:
        raise HTTPException(
            status_code=422, detail="score must be between 1 and 5"
        )
    note = str(body.get("note") or "").strip() or None

    def _score_sync() -> dict:
        with projects_db.connect_closing() as conn:
            run = projects_db.get_project_run(conn, project.id, run_no)
            if run is None:
                raise KeyError(run_no)
            projects_db.update_project_run(
                conn,
                run["id"],
                score_user=score,
                score_note=note,
                scored_by=subject,
                scored_at=int(time.time()),
            )
            return {
                "scored": run_no,
                "score_user": score,
                "score_note": note,
                "by": subject,
            }

    try:
        return await asyncio.to_thread(_score_sync)
    except KeyError:
        raise HTTPException(status_code=404, detail="run not found")


# ---------------------------------------------------------------------------
# Instruments: tools/skills narrowing (§4.1) + autonomy (§4)
# ---------------------------------------------------------------------------


# Toolset/skill names are stored as one CSV column (§1.1 rows 13/14 say
# lists, the UI splits on commas), so a name containing the separator would
# silently round-trip as two unknown names. Reject the separator — and
# anything else outside the safe set — at write time (L1).
_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


def _reject_bad_names(names: list[str], kind: str) -> None:
    invalid = [n for n in names if not _TOOL_NAME_RE.match(n)]
    if invalid:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{kind} names may only contain letters, digits and "
                f"'_' '.' ':' '-' — invalid: {', '.join(invalid)}"
            ),
        )


@router.patch("/{slug}/tools")
async def patch_tools_route(request: Request) -> dict[str, Any]:
    """Set the project's ``toolsets``/``skills`` (§12).

    Names are validated at write time so an impossible request is refused
    loudly; the stored lists are still a *narrowing filter* — at spawn the
    effective set is intersected with what the host profile enables (§4.1),
    and the response shows that intersection.
    """
    project, _role, profiles, _principal = await _require_write(request)
    _refuse_if_archived(project, "changing its tools")
    body = await request.json()

    def _patch_sync() -> dict:
        updates: dict = {}
        if "toolsets" in body:
            names = [str(t).strip() for t in (body.get("toolsets") or []) if str(t).strip()]
            _reject_bad_names(names, "toolset")
            unknown = [
                t for t in names
                if t.casefold() not in kanban_db.KNOWN_TOOLSET_NAMES
            ]
            if unknown:
                raise HTTPException(
                    status_code=422,
                    detail=f"unknown toolset(s): {', '.join(unknown)}",
                )
            updates["toolsets"] = ",".join(names)
        if "skills" in body:
            # One seam for resolution: the same host-profile loader the
            # run spawn uses (§4.1), so write-time validation and spawn
            # agree about what exists.
            with projects_db.connect_closing() as conn:
                host = projects_run.host_profile_name(conn, project.id)
            known = projects_run._available_skill_names(host or "") or None
            names = [str(s).strip() for s in (body.get("skills") or []) if str(s).strip()]
            _reject_bad_names(names, "skill")
            if known is not None:
                unknown = [s for s in names if s not in known]
                if unknown:
                    raise HTTPException(
                        status_code=422,
                        detail=f"unknown skill(s): {', '.join(unknown)}",
                    )
            updates["skills"] = ",".join(names)
        if not updates:
            raise HTTPException(
                status_code=422, detail="provide toolsets and/or skills"
            )
        with projects_db.connect_closing() as conn:
            projects_db.update_project_fields(conn, project.id, updates)
            fresh = projects_db.get_project(conn, project.slug)
            host = projects_run.host_profile_name(conn, project.id)
            enabled = projects_run._enabled_toolsets_for_profile(host or "")
            available = projects_run._available_skill_names(host or "")
        cfg = projects_run.projects_runtime_config()
        eff_ts, dropped_ts = projects_run.resolve_toolsets(
            projects_run.parse_csv_field(fresh.toolsets), enabled
        )
        eff_sk, dropped_sk, truncated = projects_run.resolve_skills(
            projects_run.parse_csv_field(fresh.skills), available,
            cfg["max_skills"],
        )
        return {
            "toolsets": projects_run.parse_csv_field(fresh.toolsets),
            "skills": projects_run.parse_csv_field(fresh.skills),
            "host_profile": host,
            "effective_toolsets": eff_ts,
            "dropped_toolsets": dropped_ts,
            "effective_skills": eff_sk,
            "dropped_skills": dropped_sk,
            "skills_truncated": truncated,
        }

    return await asyncio.to_thread(_patch_sync)


@router.patch("/{slug}/autonomy")
async def patch_autonomy_route(request: Request) -> dict[str, Any]:
    """A separate route so the audit line and the permission check are
    unmistakable (§12). Lead/admin only — ``_can_write``."""
    project, _role, _profiles, _principal = await _require_write(request)
    _refuse_if_archived(project, "changing its autonomy")
    body = await request.json()
    autonomy = body.get("autonomy")
    if autonomy not in projects_db.VALID_AUTONOMY_LEVELS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"autonomy must be one of "
                f"{sorted(projects_db.VALID_AUTONOMY_LEVELS)}"
            ),
        )

    def _patch_sync() -> dict:
        with projects_db.connect_closing() as conn:
            projects_db.update_project_fields(
                conn, project.id, {"autonomy": autonomy}
            )
            fresh = projects_db.get_project(conn, project.slug)
        return {"slug": fresh.slug, "autonomy": fresh.autonomy}

    return await asyncio.to_thread(_patch_sync)


# ---------------------------------------------------------------------------
# PUT/DELETE /{slug}/schedule — the host profile's cron job (§3.2)
# ---------------------------------------------------------------------------


@router.put("/{slug}/schedule")
async def put_schedule_route(request: Request) -> dict[str, Any]:
    """Create or update the cron job in the host profile's store. Lead
    only — a schedule is an automation decision, not a judgement act.
    §3.1 preconditions map to 409 naming what is missing; an invalid
    schedule string maps to 422."""
    project, _role, profiles, principal = await _require_write(request)
    _refuse_if_archived(project, "scheduling it")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")

    def _put_sync() -> dict:
        with projects_db.connect_closing() as conn:
            return projects_schedule.set_project_schedule(
                conn,
                project=project,
                schedule=str(body.get("schedule") or ""),
                profiles=profiles,
                changed_by=principal.user_id,
            )

    try:
        return await asyncio.to_thread(_put_sync)
    except projects_schedule.SchedulePreconditionError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.delete("/{slug}/schedule")
async def delete_schedule_route(request: Request) -> dict[str, Any]:
    """Remove the cron job and both halves of the link. Removing — not
    pausing — keeps the store honest; the cadence-change path is the one
    that pauses (§3.1)."""
    project, _role, _profiles, _principal = await _require_write(request)

    def _del_sync() -> dict:
        with projects_db.connect_closing() as conn:
            removed = projects_schedule.clear_project_schedule(
                conn, project=project
            )
            return {"scheduled": False, "removed": removed}

    return await asyncio.to_thread(_del_sync)


@router.get("/{slug}/doctor")
async def project_doctor_route(request: Request) -> dict[str, Any]:
    """One project's diagnosable breaks, with the health they imply
    (§9.2 / §15 failure mode 1)."""
    project, _role, profiles, principal = await _require_read(request)

    def _doc_sync() -> dict:
        with projects_db.connect_closing() as conn:
            runs = projects_db.list_project_runs(conn, project.id, limit=10)
        cron_job = None
        if getattr(project, "cron_job_id", None):
            cron_job = projects_schedule.resolve_cron_job(project, profiles)
        with _board_conn(project) as bconn:
            rollup = _card_rollup_sync(bconn, project.id, principal)
        with projects_db.connect_closing() as conn:
            findings = projects_schedule.doctor_findings(
                conn, project, profiles=profiles, runs=runs, cron_job=cron_job
            )
            health = projects_schedule.derive_health(
                project,
                card_rollup=rollup,
                profiles=profiles,
                runs=runs,
                cron_job=cron_job,
                pconn=conn,
            )
        return {
            "slug": project.slug,
            "health": health,
            "findings": findings,
            "clean": not findings,
        }

    return await asyncio.to_thread(_doc_sync)
