"""Shared kanban board aggregation — the one rollup every surface renders.

Extracted from ``plugins/kanban/dashboard/plugin_api.py``'s ``GET /board``
(Projects design §12 "One shared rollup helper", step 2). The dashboard
plugin and — later — the Projects router (``GET /{slug}/board``) both
build their board view through :func:`build_board_view` so two surfaces
can never disagree about what "progress" means.

Pure read path: no writes, no connection lifecycle. The caller owns the
``sqlite3.Connection`` (a ``kanban_db.connect()`` handle) and closes it.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import asdict
from typing import Any, Optional

from hermes_cli import kanban_db

# Columns shown by board UIs, in left-to-right order. "archived" is
# available via a filter toggle rather than a visible column.
#
# Keep this in sync with kanban_db.VALID_STATUSES.  In particular,
# ``scheduled`` is a first-class waiting column used for time-based follow-ups;
# if it is omitted here, the board-level fallback mis-buckets scheduled
# tasks into ``todo`` and makes the dashboard look like the Scheduled column
# disappeared.
BOARD_COLUMNS: list[str] = [
    "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
]

# Latest run summary is truncated to a card-size preview in board payloads;
# the full text stays available via the per-task detail endpoint.
CARD_SUMMARY_PREVIEW_CHARS = 200


def task_dict(
    task: kanban_db.Task,
    *,
    latest_summary: Optional[str] = None,
) -> dict[str, Any]:
    """Serialise one task for a board/list payload."""
    d = asdict(task)
    # Add derived age metrics so the UI can colour stale cards without
    # computing deltas client-side.
    try:
        d["age"] = kanban_db.task_age(task)
    except Exception:
        d["age"] = {"created_age_seconds": None, "started_age_seconds": None, "time_to_complete_seconds": None}
    # Surface the latest non-null run summary so boards don't show
    # blank cards/drawers for tasks where the worker handed off via
    # ``task_runs.summary`` (the kanban-worker pattern) instead of
    # ``tasks.result``. ``None`` when no run has produced a summary yet.
    d["latest_summary"] = latest_summary
    # Keep body short on list endpoints; full body comes from the task detail.
    return d


def compute_task_diagnostics(
    conn: sqlite3.Connection,
    task_ids: Optional[list[str]] = None,
) -> dict[str, list[dict]]:
    """Run the diagnostic rule engine against every task (or a subset)
    and return ``{task_id: [diagnostic_dict, ...]}``.

    Tasks with no active diagnostics are omitted from the result.
    Uses ``hermes_cli.kanban_diagnostics`` — see that module for the
    rule definitions.
    """
    from hermes_cli import kanban_diagnostics as kd
    from hermes_cli.config import load_config

    diag_config = kd.config_from_runtime_config(load_config())

    # Build the candidate task list. We need each task's row + its
    # events + its runs. Doing N separate queries works but scales
    # poorly; do three aggregate queries instead.
    if task_ids is not None:
        if not task_ids:
            return {}
        placeholders = ",".join(["?"] * len(task_ids))
        rows = conn.execute(
            f"SELECT * FROM tasks WHERE id IN ({placeholders})",
            tuple(task_ids),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE status != 'archived'",
        ).fetchall()

    if not rows:
        return {}

    # Index events + runs by task id. For very large boards this will
    # slurp a lot — acceptable on the dashboard's typical working set
    # (hundreds of tasks), but we can add pagination / filtering later
    # if profiling shows it's a hotspot.
    row_ids = [r["id"] for r in rows]
    placeholders = ",".join(["?"] * len(row_ids))
    events_by_task: dict[str, list] = {tid: [] for tid in row_ids}
    for ev_row in conn.execute(
        f"SELECT * FROM task_events WHERE task_id IN ({placeholders}) ORDER BY id",
        tuple(row_ids),
    ).fetchall():
        events_by_task.setdefault(ev_row["task_id"], []).append(ev_row)
    runs_by_task: dict[str, list] = {tid: [] for tid in row_ids}
    for run_row in conn.execute(
        f"SELECT * FROM task_runs WHERE task_id IN ({placeholders}) ORDER BY id",
        tuple(row_ids),
    ).fetchall():
        runs_by_task.setdefault(run_row["task_id"], []).append(run_row)

    out: dict[str, list[dict]] = {}
    for r in rows:
        tid = r["id"]
        diags = kd.compute_task_diagnostics(
            r,
            events_by_task.get(tid, []),
            runs_by_task.get(tid, []),
            config=diag_config,
        )
        if diags:
            out[tid] = [d.to_dict() for d in diags]
    return out


def warnings_summary_from_diagnostics(
    diagnostics: list[dict],
) -> Optional[dict]:
    """Compact summary for cards: {count, highest_severity, kinds,
    latest_at}. Same shape additions plus ``highest_severity`` so the UI
    can color badges per diagnostic severity.

    Returns None when ``diagnostics`` is empty.
    """
    if not diagnostics:
        return None
    from hermes_cli.kanban_diagnostics import SEVERITY_ORDER

    kinds: dict[str, int] = {}
    latest = 0
    highest_idx = -1
    highest_sev: Optional[str] = None
    count = 0
    for d in diagnostics:
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + d.get("count", 1)
        count += d.get("count", 1)
        la = d.get("last_seen_at") or 0
        if la > latest:
            latest = la
        sev = d.get("severity")
        if sev in SEVERITY_ORDER:
            idx = SEVERITY_ORDER.index(sev)
            if idx > highest_idx:
                highest_idx = idx
                highest_sev = sev
    return {
        "count": count,
        "kinds": kinds,
        "latest_at": latest,
        "highest_severity": highest_sev,
    }


def build_board_view(
    conn: sqlite3.Connection,
    *,
    tenant: Optional[str] = None,
    include_archived: bool = False,
    workflow_template_id: Optional[str] = None,
    current_step_key: Optional[str] = None,
    project_id: Optional[str] = None,
    principal: Optional[kanban_db.Principal] = None,
) -> dict[str, Any]:
    """Aggregate a board into the column-grouped payload every board UI
    renders.

    Returns ``{"columns": [{name, tasks}], "tenants", "assignees",
    "latest_event_id", "now"}`` — the exact shape the dashboard plugin's
    ``GET /board`` returned before this helper existed.

    ``project_id`` (id or slug) narrows the task list to one project's
    cards — used by the Projects router's ``GET /{slug}/board``; the
    dashboard leaves it ``None``. Rollups (link counts, child progress)
    stay whole-table: they are per-task facts, identical either way;
    diagnostics are computed for the listed cards only.
    """
    tasks = kanban_db.list_tasks(
        conn,
        tenant=tenant,
        include_archived=include_archived,
        workflow_template_id=workflow_template_id,
        current_step_key=current_step_key,
        project_id=project_id,
        principal=principal,
    )
    # Pre-fetch link counts per task (cheap: one query).
    link_counts: dict[str, dict[str, int]] = {}
    for row in conn.execute(
        "SELECT parent_id, child_id FROM task_links"
    ).fetchall():
        link_counts.setdefault(row["parent_id"], {"parents": 0, "children": 0})[
            "children"
        ] += 1
        link_counts.setdefault(row["child_id"], {"parents": 0, "children": 0})[
            "parents"
        ] += 1

    # Comment + event counts (both cheap aggregates).
    comment_counts: dict[str, int] = {
        r["task_id"]: r["n"]
        for r in conn.execute(
            "SELECT task_id, COUNT(*) AS n FROM task_comments GROUP BY task_id"
        )
    }

    # Progress rollup: for each parent, how many children are done / total.
    # One pass over task_links joined with child status — cheaper than
    # N per-task queries and the UI uses it to render "N/M".
    progress: dict[str, dict[str, int]] = {}
    for row in conn.execute(
        "SELECT l.parent_id AS pid, t.status AS cstatus "
        "FROM task_links l JOIN tasks t ON t.id = l.child_id"
    ).fetchall():
        p = progress.setdefault(row["pid"], {"done": 0, "total": 0})
        p["total"] += 1
        if row["cstatus"] == "done":
            p["done"] += 1

    # Diagnostics rollup for this board — see kanban_diagnostics.
    # We get the full structured list per task AND a compact
    # summary for the card badge (so cards don't carry the detail
    # text; the drawer fetches that via the task detail endpoint).
    # A project board only renders its own cards, so run the rule engine
    # over those alone — the whole-table pass costs every other project's
    # tasks, events and runs on every project read (the Models page reads
    # every project). Each task's diagnostics depend only on its own rows.
    if project_id is None:
        diagnostics_per_task = compute_task_diagnostics(conn, task_ids=None)
    else:
        diagnostics_per_task = compute_task_diagnostics(
            conn, task_ids=[t.id for t in tasks if t.status != "archived"]
        )

    latest_event_id = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS m FROM task_events"
    ).fetchone()["m"]

    columns: dict[str, list[dict]] = {c: [] for c in BOARD_COLUMNS}
    if include_archived:
        columns["archived"] = []

    # Batch-fetch the latest non-null run summary per task in one
    # window-function query (avoids N+1 ``latest_summary`` calls
    # for boards with hundreds of tasks). Truncated to a card-size
    # preview here — the full text is available via the task detail.
    summary_map = kanban_db.latest_summaries(conn, [t.id for t in tasks])

    for t in tasks:
        full = summary_map.get(t.id)
        preview = (
            full[:CARD_SUMMARY_PREVIEW_CHARS] if full else None
        )
        d = task_dict(t, latest_summary=preview)
        d["link_counts"] = link_counts.get(t.id, {"parents": 0, "children": 0})
        d["comment_count"] = comment_counts.get(t.id, 0)
        d["progress"] = progress.get(t.id)  # None when the task has no children
        diags = diagnostics_per_task.get(t.id)
        if diags:
            # Full list goes into the payload so the drawer can render
            # without a second round-trip. The board-level badge only
            # needs the summary.
            d["diagnostics"] = diags
            d["warnings"] = warnings_summary_from_diagnostics(diags)
        col = t.status if t.status in columns else "todo"
        columns[col].append(d)

    # Stable per-column ordering already applied by list_tasks
    # (priority DESC, created_at ASC), keep as-is.

    # List of known tenants for the UI filter dropdown.
    tenants = [
        r["tenant"]
        for r in conn.execute(
            "SELECT DISTINCT tenant FROM tasks WHERE tenant IS NOT NULL ORDER BY tenant"
        )
    ]
    # List of distinct assignees for the lane-by-profile sub-grouping.
    assignees = [
        r["assignee"]
        for r in conn.execute(
            "SELECT DISTINCT assignee FROM tasks WHERE assignee IS NOT NULL "
            "AND status != 'archived' ORDER BY assignee"
        )
    ]

    return {
        "columns": [
            {"name": name, "tasks": columns[name]} for name in columns.keys()
        ],
        "tenants": tenants,
        "assignees": assignees,
        "latest_event_id": int(latest_event_id),
        "now": int(time.time()),
    }
