"""Tests for typed block reasons + the unblock-loop breaker.

Covers the built-in fix for the kanban "blocked loop" — a worker blocks a
task, a cron unblocks it, the worker re-blocks for the same reason, repeat
forever. The fix gives ``block_task`` a typed ``kind`` and a persistent
``block_recurrences`` counter:

* ``dependency`` blocks route to ``todo`` (parent-gated, auto-resumed) and
  never enter the human ``blocked`` bucket a cron would keep unblocking.
* ``needs_input`` / ``capability`` / un-typed blocks land in ``blocked``;
  each same-cause re-block after an unblock increments ``block_recurrences``,
  and at ``BLOCK_RECURRENCE_LIMIT`` the task routes to ``triage`` for a human.
* ``unblock_task`` deliberately does NOT reset ``block_recurrences`` (the
  amnesia that let the loop run unbounded).
* A successful ``complete_task`` resets the loop memory.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from hermes_cli import kanban_db as kb


@pytest.fixture
def kanban_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _running_task(conn, title="t"):
    """Create a task and drive it to ``running`` so block_task can act."""
    tid = kb.create_task(conn, title=title, assignee="worker")
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (tid,))
    claimed = kb.claim_task(conn, tid, claimer="worker")
    assert claimed is not None
    return tid


def _make_running_again(conn, tid):
    with kb.write_txn(conn):
        conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (tid,))
    assert kb.claim_task(conn, tid, claimer="worker") is not None


# ---------------------------------------------------------------------------
# Loop breaker
# ---------------------------------------------------------------------------


def test_first_typed_block_lands_in_blocked(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(conn, tid, reason="which key?", kind="needs_input")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_kind == "needs_input"
        assert t.block_recurrences == 1


def test_unblock_does_not_reset_recurrence_counter(kanban_home: Path) -> None:
    """The crux of the fix: unblock must preserve the loop counter."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="x", kind="needs_input")
        assert kb.get_task(conn, tid).block_recurrences == 1
        assert kb.unblock_task(conn, tid)
        t = kb.get_task(conn, tid)
        assert t.status == "ready"
        assert t.block_recurrences == 1  # NOT reset to 0
        assert t.block_kind == "needs_input"  # kind preserved for comparison


def test_same_cause_reblock_routes_to_triage(kanban_home: Path) -> None:
    """Dale's loop: block → unblock → re-block same kind → triage."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        for _ in range(kb.BLOCK_RECURRENCE_LIMIT - 1):
            kb.block_task(conn, tid, reason="need creds", kind="needs_input")
            assert kb.get_task(conn, tid).status == "blocked"
            kb.unblock_task(conn, tid)
            _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="still need creds", kind="needs_input")
        t = kb.get_task(conn, tid)
        assert t.status == "triage"
        assert t.block_recurrences == kb.BLOCK_RECURRENCE_LIMIT


def test_the_breaker_parks_on_the_third_same_cause_block(kanban_home: Path) -> None:
    """Owner's rule: two same-cause blocks are still a human's blocked card;
    the third parks it in triage."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        statuses = []
        for attempt in range(3):
            kb.block_task(conn, tid, reason="needs the MCP approval", kind="needs_input")
            statuses.append(kb.get_task(conn, tid).status)
            if attempt < 2:
                kb.unblock_task(conn, tid)
                _make_running_again(conn, tid)
        assert statuses == ["blocked", "blocked", "triage"]


def test_untyped_block_loop_also_protected(kanban_home: Path) -> None:
    """Legacy un-typed blocks (kind=None) still trip the breaker."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        for _ in range(kb.BLOCK_RECURRENCE_LIMIT - 1):
            kb.block_task(conn, tid, reason="a")
            kb.unblock_task(conn, tid)
            _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="a again")
        assert kb.get_task(conn, tid).status == "triage"


def test_different_kinds_do_not_compound(kanban_home: Path) -> None:
    """A re-block for a DIFFERENT reason resets the counter to 1."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="a", kind="needs_input")
        kb.unblock_task(conn, tid)
        _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="b", kind="capability")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_recurrences == 1


def test_block_loop_detected_event_emitted(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        for _ in range(kb.BLOCK_RECURRENCE_LIMIT - 1):
            kb.block_task(conn, tid, reason="x", kind="capability")
            kb.unblock_task(conn, tid)
            _make_running_again(conn, tid)
        kb.block_task(conn, tid, reason="x", kind="capability")
        events = [e for e in kb.list_events(conn, tid)
                  if e.kind == "block_loop_detected"]
        assert events, "expected a block_loop_detected event"
        payload = events[-1].payload or {}
        assert payload.get("recurrences") == kb.BLOCK_RECURRENCE_LIMIT
        assert payload.get("kind") == "capability"


# ---------------------------------------------------------------------------
# Dependency routing
# ---------------------------------------------------------------------------


def test_dependency_block_routes_to_todo(kanban_home: Path) -> None:
    """Dependency waits never enter the human 'blocked' bucket."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(conn, tid, reason="need X first", kind="dependency")
        t = kb.get_task(conn, tid)
        assert t.status == "todo"
        assert t.block_kind == "dependency"


def test_dependency_then_parent_done_promotes(kanban_home: Path) -> None:
    """A dependency-parked child becomes ready once its parent completes."""
    with kb.connect_closing() as conn:
        parent = kb.create_task(conn, title="parent", assignee="worker")
        child = _running_task(conn, title="child")
        kb.link_tasks(conn, parent_id=parent, child_id=child)
        kb.block_task(conn, child, reason="wait", kind="dependency")
        assert kb.get_task(conn, child).status == "todo"
        # Finish the parent, then let recompute_ready run.
        with kb.write_txn(conn):
            conn.execute("UPDATE tasks SET status='ready' WHERE id=?", (parent,))
        kb.claim_task(conn, parent, claimer="worker")
        kb.complete_task(conn, parent, result="done")
        kb.recompute_ready(conn)
        assert kb.get_task(conn, child).status == "ready"


# ---------------------------------------------------------------------------
# Completion resets loop memory
# ---------------------------------------------------------------------------


def test_completion_clears_block_memory(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="x", kind="capability")
        kb.unblock_task(conn, tid)
        assert kb.get_task(conn, tid).block_recurrences == 1
        kb.complete_task(conn, tid, result="done")
        t = kb.get_task(conn, tid)
        assert t.status == "done"
        assert t.block_recurrences == 0
        assert t.block_kind is None


# ---------------------------------------------------------------------------
# Validation + back-compat
# ---------------------------------------------------------------------------


def test_invalid_kind_rejected(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with pytest.raises(ValueError):
            kb.block_task(conn, tid, reason="x", kind="bogus")


def test_block_without_kind_is_backward_compatible(kanban_home: Path) -> None:
    """Existing callers that pass no kind keep the old single-block behaviour."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        assert kb.block_task(conn, tid, reason="legacy")
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.block_kind is None


# ---------------------------------------------------------------------------
# Auto-retry timer (a block that clears on its own — e.g. a daily API quota)
# ---------------------------------------------------------------------------


def test_retry_after_seconds_stamps_retry_at(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        before = int(time.time())
        assert kb.block_task(
            conn, tid, reason="Canva's daily limit was reached",
            kind="transient", retry_after_seconds=86_400,
        )
        t = kb.get_task(conn, tid)
        assert t.status == "blocked"
        assert t.retry_at is not None
        assert t.retry_at >= before + 86_400


def test_negative_or_zero_retry_after_seconds_rejected(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        with pytest.raises(ValueError):
            kb.block_task(conn, tid, reason="x", retry_after_seconds=0)
        with pytest.raises(ValueError):
            kb.block_task(conn, tid, reason="x", retry_after_seconds=-5)


def test_auto_retry_unblocks_once_the_timer_elapses(kanban_home: Path) -> None:
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(
            conn, tid, reason="quota wall", kind="transient",
            retry_after_seconds=60,
        )
        # Not due yet.
        assert kb.auto_retry_timed_blocks(conn) == []
        assert kb.get_task(conn, tid).status == "blocked"
        # Fast-forward past the timer.
        future = int(time.time()) + 61
        assert kb.auto_retry_timed_blocks(conn, now=future) == [tid]
        t = kb.get_task(conn, tid)
        assert t.status == "ready"
        assert t.retry_at is None
        events = [e for e in kb.list_events(conn, tid) if e.kind == "auto_retry"]
        assert events, "expected an auto_retry event, not a plain unblocked"


def test_auto_retry_leaves_untimed_blocks_alone(kanban_home: Path) -> None:
    """A block with no retry_after_seconds keeps waiting for a human."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(conn, tid, reason="need a decision", kind="needs_input")
        assert kb.get_task(conn, tid).retry_at is None
        far_future = int(time.time()) + 10 ** 9
        assert kb.auto_retry_timed_blocks(conn, now=far_future) == []
        assert kb.get_task(conn, tid).status == "blocked"


def test_auto_retry_still_escalates_a_genuine_loop_to_triage(kanban_home: Path) -> None:
    """A retry timer is not a way to spin forever: if the worker hits the
    same wall again right after an auto-retry, the existing unblock-loop
    breaker still trips at BLOCK_RECURRENCE_LIMIT — same as a human/cron
    unblock would."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(
            conn, tid, reason="quota wall", kind="transient",
            retry_after_seconds=1,
        )
        future = int(time.time()) + 2
        for _ in range(kb.BLOCK_RECURRENCE_LIMIT - 2):
            assert kb.auto_retry_timed_blocks(conn, now=future) == [tid]
            _make_running_again(conn, tid)
            kb.block_task(
                conn, tid, reason="quota wall again", kind="transient",
                retry_after_seconds=1,
            )
            assert kb.get_task(conn, tid).status == "blocked"
            future += 2
        assert kb.auto_retry_timed_blocks(conn, now=future) == [tid]
        _make_running_again(conn, tid)
        kb.block_task(
            conn, tid, reason="quota wall again", kind="transient",
            retry_after_seconds=1,
        )
        t = kb.get_task(conn, tid)
        assert t.status == "triage"
        assert t.retry_at is None  # no timer once it's a human's problem


def test_dispatch_once_runs_the_auto_retry_sweep(kanban_home: Path) -> None:
    """The feature has to actually fire on its own: a real dispatcher tick
    (not just a direct auto_retry_timed_blocks() call) must pick up a
    timed-out block. dry_run=True only skips the claim+spawn step —
    reclaim/promote/auto-retry bookkeeping still runs for real, same as
    test_dispatch_dry_run_does_not_claim relies on for its own assertions."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(
            conn, tid, reason="quota wall", kind="transient",
            retry_after_seconds=3600,
        )
        # Back-date the timer instead of sleeping through it — dispatch_once
        # doesn't take a `now` override, so this is the only way to test the
        # real tick's wiring without slowing the suite down.
        with kb.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET retry_at = ? WHERE id = ?",
                (int(time.time()) - 1, tid),
            )
        res = kb.dispatch_once(conn, dry_run=True)
        assert tid in res.auto_retried
        assert kb.get_task(conn, tid).status == "ready"


def test_manual_unblock_clears_a_pending_retry_timer(kanban_home: Path) -> None:
    """A human clicking 'Make ready' before the timer fires must not leave
    a stale retry_at that could later auto-retry a task the human already
    handled some other way."""
    with kb.connect_closing() as conn:
        tid = _running_task(conn)
        kb.block_task(
            conn, tid, reason="quota wall", kind="transient",
            retry_after_seconds=3600,
        )
        assert kb.unblock_task(conn, tid)
        t = kb.get_task(conn, tid)
        assert t.status == "ready"
        assert t.retry_at is None
