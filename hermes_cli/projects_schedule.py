"""Projects step 5 — schedule wiring, health and doctor (design §3.2, §9.2).

A repeatable project's schedule IS a ``hermes cron`` job in the **host
profile's** cron store (§3.2). We do not write a scheduler: ``cron/jobs.py``
already ships parsing, next-run computation, claiming and per-profile
isolation (#4707). This module is the bridge — it targets the host profile's
``jobs.json`` by re-pointing ``cron.jobs``' module-level paths for the
duration of one call, then reads the results back into the project record:

- ``schedule``     — the schedule text the user gave (authoritative copy of
                     intent; the cron store is authoritative for firing);
- ``cron_job_id``  — the job in the host profile's store (two halves of one
                     link; ``doctor`` round-trips it, because a broken
                     schedule is invisible otherwise — it simply never runs);
- ``next_run_at``  — a display cache refreshed on read. Never make a
                     scheduling decision from it.

Health (§9.2) is derived on read, never stored, and ``stalled`` exists
because the failure mode of an automated project is **silence** — which
looks identical to success on a list page. ``doctor`` names every broken
link so the silence has somewhere to surface.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, List, Optional

from hermes_cli import projects_db

logger = logging.getLogger(__name__)

# Default period assumed for a repeatable project whose schedule cannot be
# parsed (staleness = two of these, §9.2). Weekly is the honest guess.
_DEFAULT_PERIOD_SECONDS = 7 * 86400


class SchedulePreconditionError(ValueError):
    """A §3.1/§3.2 precondition is missing (no playbook, no host profile…).

    Subclasses ``ValueError`` so careless callers still catch it; the API
    maps it to 409 — distinct from the 422 an invalid schedule string
    earns.
    """


# ---------------------------------------------------------------------------
# Targeting the host profile's cron store
# ---------------------------------------------------------------------------

# ``cron.jobs`` pins its store paths in module globals at import time
# (anchored on the ACTIVE profile's HERMES_HOME — that anchoring is the
# #4707 security boundary and must stay). The web server normally runs
# under the default profile, so wiring a job for another profile means
# re-pointing those globals for the duration of one operation. The lock
# serialises the swap; ``cron.jobs``' own locks protect the store itself.
_CRON_SWAP_LOCK = threading.Lock()


def _host_profile_cron_dir(profile: str) -> Path:
    """The host profile's ``cron`` directory (its HERMES_HOME / cron)."""
    from hermes_cli import profiles

    return profiles.get_profile_dir(profile) / "cron"


@contextmanager
def _cron_in_profile(profile: str) -> Iterator[None]:
    """Re-target ``cron.jobs`` at *profile*'s cron store for one call."""
    from cron import jobs as cron_jobs

    cron_dir = _host_profile_cron_dir(profile)
    saved = (
        cron_jobs.HERMES_DIR,
        cron_jobs.CRON_DIR,
        cron_jobs.JOBS_FILE,
        cron_jobs.OUTPUT_DIR,
    )
    with _CRON_SWAP_LOCK:
        cron_jobs.HERMES_DIR = cron_dir.parent
        cron_jobs.CRON_DIR = cron_dir
        cron_jobs.JOBS_FILE = cron_dir / "jobs.json"
        cron_jobs.OUTPUT_DIR = cron_dir / "output"
        try:
            yield
        finally:
            (
                cron_jobs.HERMES_DIR,
                cron_jobs.CRON_DIR,
                cron_jobs.JOBS_FILE,
                cron_jobs.OUTPUT_DIR,
            ) = saved


def _iso_to_epoch(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(str(iso))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        from hermes_time import now as hermes_now

        dt = dt.replace(tzinfo=hermes_now().tzinfo)
    return int(dt.timestamp())


def _host_of(profiles: List[dict]) -> Optional[str]:
    """The host profile from the project's profiles rows — the ``role='host'``
    row, mirroring ``projects_run.host_profile_name``."""
    for p in profiles:
        if p.get("role") == "host":
            return p["profile"]
    return profiles[0]["profile"] if profiles else None


def _host_profile_for(conn: sqlite3.Connection, project_id: str) -> Optional[str]:
    return _host_of(projects_db.get_project_profiles(conn, project_id))


def resolve_cron_job(project, profiles: List[dict]) -> Optional[dict]:
    """The project's cron job from the host profile's store, or ``None``.

    ``None`` covers every failure mode at once — no host profile, no
    ``cron_job_id``, job deleted, store unreadable — because the caller
    (health, doctor) only cares that the link does not round-trip.
    """
    host = _host_of(profiles)
    job_id = getattr(project, "cron_job_id", None)
    if not host or not job_id:
        return None
    try:
        from cron import jobs as cron_jobs

        with _cron_in_profile(host):
            return cron_jobs.get_job(job_id)
    except Exception:  # pragma: no cover - defensive: fail open
        logger.debug("projects: cron store unreadable for %s", host, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# PUT / DELETE — the wiring itself (§3.2)
# ---------------------------------------------------------------------------


def set_project_schedule(
    conn: sqlite3.Connection,
    *,
    project,
    schedule: str,
    profiles: List[dict],
    changed_by: Optional[str] = None,
) -> dict:
    """Create or update the host profile's cron job for *project*.

    Refuses — naming what is missing — without: a ``repeatable`` cadence,
    a host profile enrolled in the project, and an **active playbook**
    (§3.1: a schedule with no method is a timer that produces nothing).
    One-shot schedules are refused: a repeatable project fires forever.
    """
    if getattr(project, "status", "") == "needs_completion":
        # L2: an imported legacy project is quarantined until a human
        # completes it — a schedule on such a row would fire runs with no
        # goal, no outputs and no host profile to run them in.
        missing = []
        if not str(getattr(project, "goal", "") or "").strip():
            missing.append("a goal")
        if not _host_of(profiles):
            missing.append("a host profile")
        if not projects_db.get_project_outputs(conn, project.id):
            missing.append("at least one output")
        raise SchedulePreconditionError(
            "this project was imported from a legacy store and needs "
            "completion before it can be scheduled — missing "
            + ", ".join(missing or ["the mandatory fields"])
        )
    if getattr(project, "cadence", "one_off") != "repeatable":
        raise SchedulePreconditionError(
            "only a repeatable project can carry a schedule — set cadence "
            "to 'repeatable' first"
        )
    host = _host_of(profiles)
    if not host:
        raise SchedulePreconditionError(
            "a repeatable project needs a host profile before it can be "
            "scheduled"
        )
    if projects_db.get_playbook(conn, project.id) is None:
        raise SchedulePreconditionError(
            "a schedule needs an active playbook — save and activate a "
            "method first (§3.1)"
        )

    text = str(schedule or "").strip()
    if not text:
        raise ValueError("schedule must not be empty")
    from cron import jobs as cron_jobs

    parsed = cron_jobs.parse_schedule(text)  # ValueError → API 422
    if parsed.get("kind") == "once":
        raise ValueError(
            "a repeatable project needs a recurring schedule (cron "
            "expression or 'every 30m'), not a one-shot"
        )

    prompt = f"hermes projects run {project.slug} --trigger schedule"
    origin = {
        "kind": "project",
        "project_id": project.id,
        "project_slug": project.slug,
        "set_by": changed_by,
    }
    name = f"Project: {project.name}"
    workdir = getattr(project, "primary_path", None) or None

    with _cron_in_profile(host):
        if project.cron_job_id and cron_jobs.get_job(project.cron_job_id):
            job = cron_jobs.update_job(
                project.cron_job_id,
                {"schedule": parsed, "schedule_display": parsed.get("display", text)},
            )
        else:
            from cron import scheduler

            _person, refused = scheduler.resolve_run_principal(
                getattr(project, "owner_user_id", None),
                hermes_home=_host_profile_cron_dir(host).parent,
            )
            if refused:
                raise SchedulePreconditionError(
                    f"the schedule would never run in profile {host}: {refused}"
                )
            job = cron_jobs.create_job(
                prompt=prompt,
                schedule=text,
                name=name,
                origin=origin,
                deliver="local",
                workdir=workdir,
                owner_user_id=getattr(project, "owner_user_id", None),
            )
    job_id = job["id"]
    next_run_at = _iso_to_epoch(job.get("next_run_at"))

    fields: dict[str, Any] = {
        "schedule": text,
        "cron_job_id": job_id,
        "next_run_at": next_run_at,
    }
    projects_db.update_project_fields(conn, project.id, fields)
    return {
        "schedule": text,
        "cron_job_id": job_id,
        "next_run_at": next_run_at,
        "schedule_display": job.get("schedule_display") or text,
    }


def clear_project_schedule(
    conn: sqlite3.Connection, *, project
) -> bool:
    """Remove the cron job and the project-side halves of the link.

    ``False`` when there was nothing wired. Removing the job (not pausing
    it) keeps the store honest — the cadence-change path is the one that
    pauses, because that job may be re-attached (§3.1).
    """
    removed = False
    host = _host_profile_for(conn, project.id)
    if project.cron_job_id and host:
        try:
            from cron import jobs as cron_jobs

            with _cron_in_profile(host):
                removed = cron_jobs.remove_job(project.cron_job_id)
        except Exception:  # pragma: no cover - defensive: fail open
            logger.debug(
                "projects: could not remove cron job %s", project.cron_job_id,
                exc_info=True,
            )
    projects_db.update_project_fields(
        conn,
        project.id,
        {"schedule": None, "cron_job_id": None, "next_run_at": None},
    )
    return removed


def detach_project_schedule(
    conn: sqlite3.Connection, *, project, reason: str, changed_by: Optional[str] = None
) -> None:
    """Pause and detach without deleting (§3.1: cadence leaving
    ``repeatable`` never silently deletes the job). The ``schedule`` text
    stays on the record so re-scheduling is one PUT away; a directive
    entry names who changed it.
    """
    host = _host_profile_for(conn, project.id)
    if project.cron_job_id and host:
        try:
            from cron import jobs as cron_jobs

            with _cron_in_profile(host):
                cron_jobs.pause_job(project.cron_job_id, reason=reason)
        except Exception:  # pragma: no cover - defensive: fail open
            logger.debug(
                "projects: could not pause cron job %s", project.cron_job_id,
                exc_info=True,
            )
    projects_db.update_project_fields(
        conn, project.id, {"cron_job_id": None, "next_run_at": None}
    )
    if changed_by:
        try:
            projects_db.add_project_directive(
                conn,
                project_id=project.id,
                kind="directive",
                body=f"Schedule paused and detached: {reason}.",
                author_user_id=changed_by,
            )
        except ValueError:  # pragma: no cover - directive cap: never block
            logger.debug("projects: directive cap — detach note dropped")


def refresh_next_run(conn: sqlite3.Connection, project) -> Optional[int]:
    """Refresh the ``next_run_at`` display cache from the cron store.

    The cron store stays authoritative (§3.2): this only copies. A job
    that no longer resolves clears the cache (and doctor names why); a
    paused job shows no next run. Fail-open — an unreadable store leaves
    the cached value alone.
    """
    host = _host_profile_for(conn, project.id)
    if not (host and project.cron_job_id):
        return project.next_run_at
    try:
        from cron import jobs as cron_jobs

        with _cron_in_profile(host):
            job = cron_jobs.get_job(project.cron_job_id)
    except Exception:  # pragma: no cover - defensive: fail open
        logger.debug("projects: cron store unreadable", exc_info=True)
        return project.next_run_at
    if job is None or job.get("state") == "paused" or not job.get("enabled", True):
        value = None
    else:
        value = _iso_to_epoch(job.get("next_run_at"))
    try:
        projects_db.update_project_fields(
            conn, project.id, {"next_run_at": value}
        )
    except sqlite3.Error:  # pragma: no cover - defensive
        logger.debug("projects: next_run_at cache write failed", exc_info=True)
    return value


# ---------------------------------------------------------------------------
# Period estimation — for the two-period staleness check (§9.2)
# ---------------------------------------------------------------------------


def schedule_period_seconds(
    schedule_text: Optional[str], *, default: int = _DEFAULT_PERIOD_SECONDS
) -> int:
    """Best-effort seconds between fires; ``default`` when unparseable.

    Never load-bearing: it only sizes the staleness window. ``every Nm``
    gives N minutes; a cron expression is measured between two consecutive
    fires (floored at an hour — a monthly schedule's gap is its period);
    anything else falls back to a week.
    """
    text = str(schedule_text or "").strip()
    if not text:
        return default
    lowered = text.lower()
    try:
        from cron import jobs as cron_jobs

        if lowered.startswith("every "):
            minutes = cron_jobs.parse_duration(text[6:].strip())
            return max(minutes * 60, 60)
        parsed = cron_jobs.parse_schedule(text)
    except ValueError:
        return default
    if parsed.get("kind") == "interval":
        return max(int(parsed.get("minutes", 0)) * 60, 60)
    if parsed.get("kind") == "cron":
        try:
            from croniter import croniter

            base = datetime.now()
            it = croniter(parsed["expr"], base)
            first = it.get_next(datetime)
            second = it.get_next(datetime)
            return max(int((second - first).total_seconds()), 3600)
        except Exception:
            return default
    return default


def _review_period_seconds(review_every: Optional[str]) -> int:
    m = re.fullmatch(r"(\d+)\s*([dwm])", str(review_every or "").strip())
    if not m:
        return 7 * 86400
    n = int(m.group(1))
    return n * (86400 if m.group(2) == "d" else 7 * 86400 if m.group(2) == "w" else 30 * 86400)


# ---------------------------------------------------------------------------
# Health (§9.2) — derived on read, never stored
# ---------------------------------------------------------------------------


def _epoch_from_timestamp(value) -> int:
    """Best-effort epoch seconds from a stored timestamp. The cron store
    writes ISO strings, the projects store writes epoch ints; an
    unparseable value is 0, which simply leaves the anchor unset."""
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value)).timestamp())
    except ValueError:
        return 0


def _run_stall_config() -> dict:
    """Lazy import — ``projects_run`` is the config owner (§ Gap B/C: doctor
    and the sweep must read the same threshold or they'll disagree about
    what "stale" means)."""
    try:
        from hermes_cli import projects_run

        return projects_run.projects_runtime_config()
    except Exception:  # noqa: BLE001 — config is advisory here
        return {"run_stall_seconds": 7200}


def _stalest_open_run(pconn, project, runs: List[dict], *, now: int) -> Optional[dict]:
    """The ``running`` run (if any) with no card/session activity for
    longest past ``run_stall_seconds`` — ``None`` when every open run is
    either not stale or not ``running``. Read-only, fail-open: any error
    here reads as "nothing to report", never as a crash.
    """
    try:
        from hermes_cli import projects_reconcile
    except Exception:  # noqa: BLE001
        return None
    cfg = _run_stall_config()
    threshold = cfg.get("run_stall_seconds", 7200)
    worst: Optional[dict] = None
    for run in runs:
        if run.get("status") != "running":
            continue
        try:
            last = projects_reconcile.run_last_activity_at(pconn, project, run)
        except Exception:  # noqa: BLE001
            continue
        if not last:
            continue
        age = now - last
        if age <= threshold:
            continue
        if _run_waits_on_human(pconn, project, run):
            continue  # waiting on a person is not a stall
        if worst is None or age > worst["age"]:
            worst = {"run": run, "age": age}
    return worst


def _run_waits_on_human(pconn, project, run: dict) -> bool:
    """Fail-open: an unreadable board reads as "not waiting"."""
    try:
        from hermes_cli import kanban_db, projects_run

        task_ids = [rc["task_id"] for rc in projects_db.get_run_cards(pconn, run["id"])]
        with kanban_db.connect_closing(board=project.board_slug or None) as bconn:
            return bool(projects_run.run_human_waits(bconn, task_ids))
    except Exception:  # noqa: BLE001
        return False


def _project_human_waits(project) -> List[dict]:
    """Fail-open: an unreadable board reads as "nothing waiting"."""
    try:
        from hermes_cli import kanban_db, projects_run

        with kanban_db.connect_closing(board=project.board_slug or None) as bconn:
            return projects_run.project_human_waits(bconn, project)
    except Exception:  # noqa: BLE001
        return []


def derive_health(
    project,
    *,
    card_rollup: dict,
    profiles: List[dict],
    runs: List[dict],
    cron_job: Optional[dict] = None,
    now: Optional[int] = None,
    pconn=None,
) -> str:
    """``stalled`` outranks ``attention``: silence beats noise.

    ``cron_job`` is the resolved job row — ``None`` means the link did not
    round-trip. Callers that cannot afford the store read on every row may
    pass the project with ``cron_job_id`` cleared; the list route resolves
    the job only for scheduled projects.

    ``pconn``, when given, additionally checks every ``running`` run for
    staleness (Gap B/C — a run stuck since a lost process restart looked
    identical to a working one otherwise, for *any* cadence, not just
    ``repeatable``'s schedule-silence check above). Omitted by callers that
    don't have a connection handy; the check is simply skipped then, same
    fail-open posture as everything else here.
    """
    now = int(now if now is not None else time.time())
    cadence = getattr(project, "cadence", "one_off")

    # ---- stalled --------------------------------------------------------
    if pconn is not None:
        stalled_run = _stalest_open_run(pconn, project, runs, now=now)
        if stalled_run is not None:
            cfg = _run_stall_config()
            if stalled_run["age"] > cfg["run_stall_seconds"] * 4:
                return "stalled"
    if cadence == "repeatable":
        if not any(p.get("role") == "host" for p in profiles):
            # The host row left project_profiles — never silently re-home.
            return "stalled"
        if getattr(project, "cron_job_id", None) and cron_job is None:
            # A broken link is invisible otherwise — it simply never runs.
            return "stalled"
        period = schedule_period_seconds(getattr(project, "schedule", None))
        last_start = max(
            (int(r.get("started_at") or 0) for r in runs), default=0
        )
        # A schedule that has never fired is measured from when it was
        # wired: the cron job's own creation, falling back to the project
        # record. Silence since then IS the failure mode (§9.2).
        anchor = last_start or _epoch_from_timestamp(
            (cron_job or {}).get("created_at")
        ) or int(getattr(project, "created_at", 0) or 0)
        if anchor and anchor < now - 2 * period:
            return "stalled"

    # ---- attention -------------------------------------------------------
    if pconn is not None and stalled_run is not None:
        return "attention"
    if card_rollup.get("blocked"):
        return "attention"
    if any(r.get("status") in ("waiting", "blocked") for r in runs):
        return "attention"
    if (
        cadence == "one_off"
        and getattr(project, "due_at", None)
        and int(project.due_at) < now
        and getattr(project, "status", "") not in ("done", "archived")
    ):
        return "attention"
    if cadence == "standing":
        period = _review_period_seconds(getattr(project, "review_every", None))
        anchor = int(
            getattr(project, "last_reviewed_at", None)
            or getattr(project, "created_at", 0)
            or 0
        )
        if anchor and anchor < now - period:
            return "attention"
    closed = [r for r in runs if r.get("status") in ("done", "failed")]
    if closed:
        last = closed[0]  # runs are newest-first (run_no DESC)
        outcome = str(last.get("outcome") or "")
        if "no_output" in outcome or "partial" in outcome:
            return "attention"
        score = last.get("score_user")
        if score is not None and int(score) <= 2:
            return "attention"
    return "ok"


# ---------------------------------------------------------------------------
# Doctor (§15 failure mode 1) — name the silence
# ---------------------------------------------------------------------------

_SEVERITY = {
    "needs_completion": "attention",
    "no_active_playbook": "attention",
    "no_schedule": "info",
    "host_profile_missing": "stalled",
    "cron_job_missing": "stalled",
    "stalled_repeatable": "stalled",
    "standing_overdue": "attention",
    "one_off_overdue": "attention",
    "board_missing": "attention",
    "run_stalled": "attention",
    "waiting_on_you": "attention",
}


def doctor_findings(
    conn: sqlite3.Connection,
    project,
    *,
    profiles: List[dict],
    runs: List[dict],
    cron_job: Optional[dict] = None,
    now: Optional[int] = None,
) -> List[dict]:
    """Every diagnosable break on one project, newest-first irrelevant.

    Codes map to §9.2 health levels so the UI can colour them; ``info``
    is a nudge, not a fault (a repeatable with no schedule yet).
    """
    now = int(now if now is not None else time.time())
    cadence = getattr(project, "cadence", "one_off")
    findings: List[dict] = []

    def _add(code: str, detail: str) -> None:
        findings.append(
            {"code": code, "severity": _SEVERITY[code], "detail": detail}
        )

    if getattr(project, "status", "") == "needs_completion":
        # L2: surface the quarantine on the list page — the row shows
        # "needs completion" instead of an empty goal.
        missing = []
        if not str(getattr(project, "goal", "") or "").strip():
            missing.append("a goal")
        if not projects_db.get_project_outputs(conn, project.id):
            missing.append("at least one output")
        if not any(p.get("role") == "host" for p in profiles):
            missing.append("a host profile")
        _add(
            "needs_completion",
            "imported from a legacy store — needs completion before it can "
            "be activated or scheduled: missing "
            + ", ".join(missing or ["the mandatory fields"]),
        )

    if cadence == "repeatable":
        if projects_db.get_playbook(conn, project.id) is None:
            _add(
                "no_active_playbook",
                "no active playbook — a schedule would fire a run with no method",
            )
        if not getattr(project, "schedule", None) and not getattr(
            project, "cron_job_id", None
        ):
            _add("no_schedule", "repeatable but not scheduled yet")
        if not any(p.get("role") == "host" for p in profiles):
            _add(
                "host_profile_missing",
                "no host profile row — the run would have nowhere to execute, "
                "and the schedule is not re-homed silently (§3.2)",
            )
        if getattr(project, "cron_job_id", None) and cron_job is None:
            _add(
                "cron_job_missing",
                f"cron job '{project.cron_job_id}' no longer resolves in the "
                "host profile's store — the project will never run again on its own",
            )
        period = schedule_period_seconds(getattr(project, "schedule", None))
        last_start = max((int(r.get("started_at") or 0) for r in runs), default=0)
        if last_start and last_start < now - 2 * period:
            days = (now - last_start) // 86400
            _add(
                "stalled_repeatable",
                f"last run {days}d ago — more than two schedule periods",
            )
    elif cadence == "standing":
        period = _review_period_seconds(getattr(project, "review_every", None))
        anchor = int(
            getattr(project, "last_reviewed_at", None)
            or getattr(project, "created_at", 0)
            or 0
        )
        if anchor and anchor < now - period:
            _add(
                "standing_overdue",
                f"last reviewed {(now - anchor) // 86400}d ago (review every {project.review_every or '7d'})",
            )
    elif cadence == "one_off":
        if (
            getattr(project, "due_at", None)
            and int(project.due_at) < now
            and getattr(project, "status", "") not in ("done", "archived")
        ):
            _add("one_off_overdue", "past its due date and not done")

    # Unresolvable link the doctor can check today: the project's own board.
    board = getattr(project, "board_slug", None)
    if board:
        try:
            from hermes_cli import kanban_db

            with kanban_db.connect_closing(board=board) as bconn:
                bconn.execute("SELECT 1 FROM tasks LIMIT 1")
        except Exception:
            _add("board_missing", f"board '{board}' does not resolve")

    # A stuck run looks identical to a working one on the list page —
    # for EVERY cadence, not just repeatable's schedule-silence check
    # above. Gap B/C (plans/2026-09-13-project-run-resilience-plan.md):
    # found via a run that sat `running` for 13+ hours after a process
    # restart with `doctor` reporting nothing wrong.
    stalled_run = _stalest_open_run(conn, project, runs, now=now)
    if stalled_run is not None:
        hours = stalled_run["age"] // 3600
        _add(
            "run_stalled",
            f"run {stalled_run['run'].get('run_no')} has shown no "
            f"card/session activity for {hours}h — likely orphaned",
        )

    waits = _project_human_waits(project)
    if waits:
        first = waits[0]
        detail = (
            f"\"{first.get('title') or first['task_id']}\" is waiting on you — "
            "answer or unblock it"
        )
        if len(waits) > 1:
            detail += f" (and {len(waits) - 1} more card(s))"
        if cadence == "repeatable" and getattr(project, "cron_job_id", None):
            detail += ". Scheduled runs are skipped until then"
        _add("waiting_on_you", detail)

    return findings
