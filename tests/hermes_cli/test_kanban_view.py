"""Behaviour contract for hermes_cli/kanban_view — the one shared board rollup.

Extracted verbatim from plugins/kanban/dashboard/plugin_api.py's GET /board
(Projects design §12, step 2); these tests pin the payload shape so the
dashboard and the (later) Projects router can never drift about what
"progress" means.
"""

from __future__ import annotations

import time

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_view as kv
from hermes_cli import projects_db as pdb


@pytest.fixture
def conn(tmp_path):
    c = kb.connect(db_path=tmp_path / "kanban.db")
    try:
        yield c
    finally:
        c.close()


def _columns(view) -> dict[str, list[dict]]:
    return {c["name"]: c["tasks"] for c in view["columns"]}


def _set_status(conn, task_id: str, status: str) -> None:
    # View tests only care about the column a task sits in; the lifecycle
    # transitions are covered elsewhere. Direct SQL matches the kanban test
    # idiom (see test_kanban_block_kinds.py).
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET status=? WHERE id=?", (status, task_id))


def _seed(conn) -> dict[str, str]:
    """A parent with one done + one open child, a commented task, and a
    task carrying a long run summary."""
    parent = kb.create_task(conn, title="Parent", tenant="acme")
    _set_status(conn, parent, "running")
    done_child = kb.create_task(conn, title="Child done")
    _set_status(conn, done_child, "done")
    open_child = kb.create_task(conn, title="Child open")
    kb.link_tasks(conn, parent, done_child)
    kb.link_tasks(conn, parent, open_child)

    commented = kb.create_task(conn, title="Commented", assignee="default", tenant="beta")
    _set_status(conn, commented, "review")
    kb.add_comment(conn, commented, "human", "first")
    kb.add_comment(conn, commented, "human", "second")

    summarized = kb.create_task(conn, title="Summarized")
    _set_status(conn, summarized, "done")
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "INSERT INTO task_runs (task_id, status, started_at, ended_at, summary) "
            "VALUES (?, 'done', ?, ?, ?)",
            (summarized, now - 10, now, "S" * 500),
        )
    return {
        "parent": parent,
        "done_child": done_child,
        "open_child": open_child,
        "commented": commented,
        "summarized": summarized,
    }


def test_board_view_payload_shape_and_grouping(conn):
    ids = _seed(conn)
    view = kv.build_board_view(conn)

    cols = _columns(view)
    # The dashboard's left-to-right columns, in order; archived only on ask.
    assert [c["name"] for c in view["columns"]] == kv.BOARD_COLUMNS
    assert "archived" not in cols

    by_title = {t["title"]: t for tasks in cols.values() for t in tasks}
    assert by_title["Parent"]["id"] == ids["parent"]
    assert "Parent" in [t["title"] for t in cols["running"]]
    assert "Commented" in [t["title"] for t in cols["review"]]


def test_board_view_rollups_are_per_task_facts(conn):
    ids = _seed(conn)
    cols = _columns(kv.build_board_view(conn))
    by_id = {t["id"]: t for tasks in cols.values() for t in tasks}

    # Child done/total rollup on the parent; None without children.
    assert by_id[ids["parent"]]["progress"] == {"done": 1, "total": 2}
    assert by_id[ids["commented"]]["progress"] is None

    # Link counts see both directions.
    assert by_id[ids["parent"]]["link_counts"] == {"parents": 0, "children": 2}
    assert by_id[ids["done_child"]]["link_counts"] == {"parents": 1, "children": 0}

    # Comment counts aggregate per task.
    assert by_id[ids["commented"]]["comment_count"] == 2
    assert by_id[ids["parent"]]["comment_count"] == 0


def test_board_view_summary_preview_truncated(conn):
    ids = _seed(conn)
    cols = _columns(kv.build_board_view(conn))
    by_id = {t["id"]: t for tasks in cols.values() for t in tasks}

    preview = by_id[ids["summarized"]]["latest_summary"]
    assert preview == "S" * kv.CARD_SUMMARY_PREVIEW_CHARS
    # A task with no run summary carries an explicit None.
    assert by_id[ids["parent"]]["latest_summary"] is None


def test_board_view_tenants_assignees_and_event_cursor(conn):
    ids = _seed(conn)
    view = kv.build_board_view(conn)

    assert view["tenants"] == ["acme", "beta"]
    assert view["assignees"] == ["default"]
    # Event cursor is an int; seeding already appended lifecycle events.
    cursor = view["latest_event_id"]
    assert isinstance(cursor, int)
    assert isinstance(view["now"], int)

    # Any event advances the cursor — the live-update tail keys on it.
    now = int(time.time())
    with kb.write_txn(conn):
        conn.execute(
            "INSERT INTO task_events (task_id, kind, payload, created_at) "
            "VALUES (?, 'status_changed', '{\"to\": \"running\"}', ?)",
            (ids["parent"], now),
        )
    assert kv.build_board_view(conn)["latest_event_id"] > cursor


def test_board_view_include_archived_column(conn):
    tid = kb.create_task(conn, title="Old")
    _set_status(conn, tid, "done")
    kb.archive_task(conn, tid)

    assert _columns(kv.build_board_view(conn)).get("archived") is None
    cols = _columns(kv.build_board_view(conn, include_archived=True))
    assert [t["id"] for t in cols["archived"]] == [tid]


def test_board_view_narrows_to_a_project(conn, tmp_path):
    # Step 3's GET /{slug}/board reads through this same helper.
    with pdb.connect_closing() as pc:
        pid = pdb.create_project(pc, name="Web App", folders=[])
        proj = pdb.get_project(pc, pid)

    linked = kb.create_task(conn, title="linked", project_id=proj.slug)
    kb.create_task(conn, title="unlinked")

    view = kv.build_board_view(conn, project_id=proj.id)
    titles = [t["title"] for c in view["columns"] for t in c["tasks"]]
    assert titles == ["linked"]
    # Rollups stay whole-table facts; the filter only narrows the task list.
    by_id = {t["id"]: t for c in view["columns"] for t in c["tasks"]}
    assert by_id[linked]["comment_count"] == 0

    # The slug resolves like the id does; unknown projects show an empty board.
    assert [
        t["id"] for c in kv.build_board_view(conn, project_id=proj.slug)["columns"]
        for t in c["tasks"]
    ] == [linked]
    assert not any(
        c["tasks"] for c in kv.build_board_view(conn, project_id="p_nope")["columns"]
    )


def test_plugin_api_aliases_point_at_the_shared_helper():
    # The dashboard plugin must render through kanban_view, not a copy.
    from plugins.kanban.dashboard import plugin_api

    assert plugin_api.BOARD_COLUMNS is kv.BOARD_COLUMNS
    assert plugin_api._task_dict is kv.task_dict
    assert plugin_api._compute_task_diagnostics is kv.compute_task_diagnostics
    assert (
        plugin_api._warnings_summary_from_diagnostics
        is kv.warnings_summary_from_diagnostics
    )


def test_project_board_runs_diagnostics_only_for_its_own_cards(conn, monkeypatch):
    """A project board diagnoses the cards it lists — not every task in the
    shared kanban.db — and each card's diagnostics match the whole-board pass."""
    with pdb.connect_closing() as pc:
        mine = pdb.get_project(pc, pdb.create_project(pc, name="Mine", folders=[]))
        other = pdb.get_project(pc, pdb.create_project(pc, name="Other", folders=[]))
    listed = kb.create_task(conn, title="listed", project_id=mine.id)
    shelved = kb.create_task(conn, title="shelved", project_id=mine.id)
    _set_status(conn, shelved, "archived")
    foreign = kb.create_task(conn, title="foreign", project_id=other.id)
    for task_id in (listed, foreign):
        for _ in range(4):
            with kb.write_txn(conn):
                kb._append_event(conn, task_id, "blocked", {"reason": "x"})
                kb._append_event(conn, task_id, "unblocked", {})

    real = kv.compute_task_diagnostics
    seen: list = []

    def spy(c, task_ids=None):
        seen.append(None if task_ids is None else sorted(task_ids))
        return real(c, task_ids=task_ids)

    monkeypatch.setattr(kv, "compute_task_diagnostics", spy)

    whole = kv.build_board_view(conn)
    narrowed = kv.build_board_view(conn, project_id=mine.id, include_archived=True)
    assert seen == [None, [listed]]

    def diags(view):
        return {
            t["id"]: (t.get("diagnostics"), t.get("warnings"))
            for c in view["columns"]
            for t in c["tasks"]
        }

    assert set(diags(narrowed)) == {listed, shelved}
    assert diags(narrowed)[listed] == diags(whole)[listed]
