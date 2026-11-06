"""Projects-side reconciliation: card-settlement refill (Gap A) and the
open-run sweep — capacity top-up + staleness (Gap B) (FG-32).

See ``plans/2026-09-13-project-run-resilience-plan.md`` for the incident and
design this module implements.

``projects_run.promote_run_cards()`` — the only thing that moves a run's
``triage`` cards into ``todo`` under the project's ``max_in_progress`` cap
(§4.1) — is otherwise called from exactly two places: ``start_run()`` and
the human ``continue_run()`` action. Nothing re-invokes it when a card the
run is waiting on finishes, fails, or blocks and a slot frees up, so a run
whose cap is smaller than its playbook (the default, ``max_in_progress=1``)
promotes its first batch and then stalls forever with no human action —
independent of any process restart.

``on_card_settled()`` is the completion-side fix (Gap A): called from
``kanban_db`` right after a run-linked card leaves ``running``/``ready``
(done, blocked, or a dependency wait), it looks up the owning run and, if
still ``running``, tops up its promoted cards via
``projects_run.refill_run_cards()`` — the same promotion the run started
with, minus forcing past a held checkpoint, which stays ``continue_run()``'s
human act.

``reconcile_all_open_runs()`` is the periodic sweep (Gap B): a card
completion is exactly the event a process restart can lose (the worker
finished and called back into a process that no longer exists, or never
even started because the restart landed before any card left ``triage``).
The sweep re-drives the same refill on every open run on an interval,
independent of any single event firing, and fails a run loudly — closing it
and raising an FG-10 approval — once it has been ``running`` with no card or
session activity for longer than ``projects.run_stall_seconds`` and there is
nothing left to promote or in flight. A run must never silently claim
``running`` past the point it can actually progress (§6).

This module is imported lazily from ``kanban_db.py`` (never at module load
time) so the generic kanban store keeps knowing nothing about Projects
beyond "does this task carry a ``project_id``" — the same layering the rest
of FG-32 already holds to (``kanban_db`` is the shared dispatch substrate;
Projects is a consumer, never a patch to it).
"""

from __future__ import annotations

import logging
import time as _time
from typing import Any, Dict, List, Optional

from hermes_cli import projects_db

log = logging.getLogger(__name__)


def on_card_settled(bconn, task_id: str) -> List[str]:
    """Best-effort: top up the owning run's promoted cards, if any.

    Returns the task ids promoted (empty when the card is not
    project-linked, its run is not ``running``, or there is nothing left to
    promote). Never raises — callers are board state transitions that must
    not fail because Projects reconciliation did.
    """
    try:
        return _on_card_settled(bconn, task_id)
    except Exception:  # noqa: BLE001 — must never break a board transition
        log.warning(
            "projects: reconcile-on-settle failed for card %s", task_id,
            exc_info=True,
        )
        return []


def _on_card_settled(bconn, task_id: str) -> List[str]:
    from hermes_cli import projects_run

    with projects_db.connect_closing() as pconn:
        run_card = projects_db.get_run_card_by_task(pconn, task_id)
        if run_card is None:
            return []
        run = projects_db.get_project_run_by_id(pconn, run_card["run_id"])
        if run is None or run.get("status") != "running":
            return []
        project = projects_db.get_project(pconn, run["project_id"])
        if project is None:
            return []
        promoted = projects_run.refill_run_cards(
            pconn, bconn, project=project, run=run
        )
        # A card the unblock-loop breaker just parked stays parked (refill
        # never re-queues it); say so now. The re-plan itself is the
        # sweep's job — this may be a short-lived worker process.
        projects_run.handle_parked_cards(pconn, bconn, project=project, run=run)
        if not promoted:
            # Nothing left to promote right now — the common reason is a
            # checkpoint that just engaged (the card that settled *was*
            # the checkpoint). Notify the instant it happens rather than
            # waiting on the next periodic sweep (§12 push edition).
            projects_run.notify_if_awaiting_checkpoint(
                pconn, bconn, project=project, run=run
            )
            # The other reason there's nothing left to promote: there's
            # nothing left, full stop — every card settled. Close the run
            # the instant that happens rather than leaving it `running`
            # forever with nothing to do, which otherwise reads as
            # "stalled" even though it's the success it is (§6.1).
            projects_run.maybe_close_completed_run(
                pconn, bconn, project=project, run=run
            )
        return promoted


# ---------------------------------------------------------------------------
# Gap B/C shared liveness — doctor/health and the sweep must never disagree
# about what "stale" means, so both read this one function.
# ---------------------------------------------------------------------------

def run_last_activity_at(pconn, project, run: dict) -> int:
    """Best-effort "last time anything happened on this run".

    Considers the run's own ``started_at`` and the latest
    ``created_at``/``started_at``/``completed_at``/``last_heartbeat_at``
    across every card linked to the run. Fails open to ``started_at`` alone
    when the board can't be read — staleness detection must never itself
    become the reason a run looks broken.
    """
    started_at = int(run.get("started_at") or 0)
    try:
        run_cards = projects_db.get_run_cards(pconn, run["id"])
    except Exception:  # noqa: BLE001
        return started_at
    task_ids = [rc["task_id"] for rc in run_cards]
    if not task_ids:
        return started_at
    try:
        from hermes_cli import kanban_db

        with kanban_db.connect_closing(board=project.board_slug or None) as bconn:
            placeholders = ",".join("?" for _ in task_ids)
            rows = bconn.execute(
                "SELECT created_at, started_at, completed_at, last_heartbeat_at "
                f"FROM tasks WHERE id IN ({placeholders})",
                task_ids,
            ).fetchall()
    except Exception:  # noqa: BLE001
        return started_at
    latest = started_at
    for row in rows:
        keys = row.keys()
        for field in ("created_at", "started_at", "completed_at", "last_heartbeat_at"):
            value = row[field] if field in keys else None
            if value:
                latest = max(latest, int(value))
    return latest


# ---------------------------------------------------------------------------
# Gap B — the periodic sweep: refill first, fail loudly only once refill
# found nothing left to do and the run has gone dark past the threshold.
# ---------------------------------------------------------------------------

def reconcile_all_open_runs(now: Optional[int] = None) -> List[Dict[str, Any]]:
    """Sweep every project's ``running`` runs: refill capacity, and fail
    loudly any run that has nothing left to promote or in flight and has
    shown no activity for ``projects.run_stall_seconds``.

    Called by the gateway's kanban dispatcher watcher on a low-frequency
    interval (``projects.reconcile_interval_seconds``) and once shortly
    after startup — see ``gateway/kanban_watchers.py``. Fully best-effort
    per run: one broken project must never stop the sweep over the rest.
    Returns one dict per run touched (refilled or failed) — empty when
    nothing needed anything, which is the common case on a healthy box.
    """
    from hermes_cli import projects_run

    now = int(now if now is not None else _time.time())
    cfg = projects_run.projects_runtime_config()
    stall_after = cfg.get(
        "run_stall_seconds", projects_run.DEFAULT_RUN_STALL_SECONDS
    )

    results: List[Dict[str, Any]] = []
    with projects_db.connect_closing() as pconn:
        try:
            projects = projects_db.list_projects(pconn, include_archived=False)
        except Exception:  # noqa: BLE001
            log.warning("projects: reconcile sweep could not list projects", exc_info=True)
            return results
        for project in projects:
            try:
                runs = [
                    r
                    for r in projects_db.list_project_runs(pconn, project.id, limit=50)
                    if r.get("status") == "running"
                ]
            except Exception:  # noqa: BLE001
                log.warning(
                    "projects: reconcile sweep could not list runs for %s",
                    project.slug, exc_info=True,
                )
                continue
            for run in runs:
                try:
                    outcome = _reconcile_one_run(
                        pconn, project, run, now=now, stall_after=stall_after
                    )
                except Exception:  # noqa: BLE001
                    log.warning(
                        "projects: reconcile sweep failed for %s run %s",
                        project.slug, run.get("run_no"), exc_info=True,
                    )
                    continue
                if outcome:
                    results.append(outcome)
    return results


def _replan_drafter():
    try:
        from hermes_cli import projects_api
    except Exception:  # noqa: BLE001 — no API deps here: mark, don't re-plan
        log.warning("projects: re-plan unavailable", exc_info=True)
        return None
    return projects_api.start_replan_draft


def _reconcile_one_run(
    pconn, project, run: dict, *, now: int, stall_after: int
) -> Optional[Dict[str, Any]]:
    from hermes_cli import kanban_db, projects_run

    with kanban_db.connect_closing(board=project.board_slug or None) as bconn:
        promoted = projects_run.refill_run_cards(
            pconn, bconn, project=project, run=run
        )
        # Loop-parked cards are never re-promoted above; mark them (if the
        # settle hook did not) and ask the planner, once per parking, for
        # another way to continue.
        projects_run.handle_parked_cards(
            pconn, bconn, project=project, run=run, replan=_replan_drafter()
        )
        if promoted:
            return {
                "project": project.slug, "run_no": run.get("run_no"),
                "action": "refilled", "promoted": promoted,
            }

        run_cards = projects_db.get_run_cards(pconn, run["id"])
        in_flight = False
        for rc in run_cards:
            task = kanban_db.get_task(bconn, rc["task_id"])
            if task is not None and task.status in ("running", "ready"):
                in_flight = True
                break

        # Nothing promoted, nothing in flight — the same safety net the
        # completion hook already runs (on_card_settled), for the case
        # that hook never fired (a process restart landed between the
        # last card settling and the hook running). Two different good
        # reasons look identical from here: every card genuinely settled
        # (close the run — §6.1), or a checkpoint is legitimately holding
        # it open (not "orphaned"; waiting on a human for however long
        # that takes, never auto-failed for going quiet — §7.1).
        if not in_flight:
            closed = projects_run.maybe_close_completed_run(
                pconn, bconn, project=project, run=run
            )
            if closed:
                return {
                    "project": project.slug, "run_no": run.get("run_no"),
                    "action": "completed",
                }
            if projects_run.notify_if_awaiting_checkpoint(
                pconn, bconn, project=project, run=run
            ):
                return {
                    "project": project.slug, "run_no": run.get("run_no"),
                    "action": "awaiting_continue",
                }
            # A card only a person can clear (needs_input / capability) is
            # holding the run: waiting on a human, not orphaned (§7.1).
            waits = projects_run.run_human_waits(
                bconn, [rc["task_id"] for rc in run_cards]
            )
            if waits:
                projects_run.notify_waiting_on_you(
                    project, run, waits[0],
                    lead=f"Run {run.get('run_no')} is paused:",
                )
                return {
                    "project": project.slug, "run_no": run.get("run_no"),
                    "action": "waiting_on_human",
                    "task_id": waits[0]["task_id"],
                }
    if in_flight:
        return None

    last = run_last_activity_at(pconn, project, run)
    if not last or now - last <= stall_after:
        return None

    # Nothing promoted, nothing in flight, stale past the threshold: this
    # run cannot progress on its own. Re-read fresh before closing — a
    # second gateway (another profile) may have already closed it in a
    # race, and closing an already-closed run twice is not idempotent.
    fresh = projects_db.get_project_run_by_id(pconn, run["id"])
    if fresh is None or fresh.get("status") != "running":
        return None

    hours = (now - last) // 3600
    closed = projects_run.close_run(
        pconn, run=fresh, status="failed", outcome="stalled",
        error=(
            f"no card or session progressed this run for over {hours}h — "
            "likely orphaned by a process restart or a stuck dependency chain"
        ),
    )
    try:
        projects_run.raise_approval(
            project, closed,
            f"run {run.get('run_no')} of project '{project.name}' was "
            f"automatically failed — {hours}h with no activity",
            kind="stalled_run",
        )
    except Exception:  # noqa: BLE001
        log.warning(
            "projects: could not raise stalled-run approval for %s",
            project.slug, exc_info=True,
        )
    return {
        "project": project.slug, "run_no": run.get("run_no"),
        "action": "failed_stale", "hours_stale": hours,
    }
