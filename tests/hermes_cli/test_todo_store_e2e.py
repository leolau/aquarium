"""Postgres E2E for the to-do store.

Exercises the things that can only be wrong against a real database: the
additive migration applied on top of an existing FG-06 ``tasks`` table, the
partial dedupe index that must catch a replayed batch and must *not* catch the
same request made again after the first was completed, stage/status staying in
lockstep, the audit trail, keyset paging, the notification stamp's
single-winner guarantee, the staged sweep, and RLS isolation between people.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.task_registry import TASKS_TABLE, TaskRegistryStore, TaskSpec
from hermes_cli.todo_store import TodoStore


async def _probe_postgres(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    daemon = subprocess.run(
        ["docker", "info"], check=False, capture_output=True, text=True
    )
    if daemon.returncode != 0:
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")

    image = (
        "postgres@sha256:"
        "742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
    )
    subprocess.run(["docker", "pull", image], check=True, capture_output=True)
    container = f"hermes-todos-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        [
            "docker", "run", "--detach", "--rm", "--name", container,
            "--env", "POSTGRES_PASSWORD=hermes-test",
            "--env", "POSTGRES_DB=hermes_test",
            "--publish", "127.0.0.1::5432",
            image,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        port_result = subprocess.run(
            ["docker", "port", container, "5432/tcp"],
            check=True,
            capture_output=True,
            text=True,
        )
        port = port_result.stdout.strip().rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(60):
            try:
                asyncio.run(_probe_postgres(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(
            ["docker", "rm", "--force", container],
            check=False,
            capture_output=True,
        )


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


async def _store(dsn: str, *, legacy_tasks_first: bool = False) -> TodoStore:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    app_store = get_store("supabase-app", "prod", config=_config(dsn))
    if legacy_tasks_first:
        # Stand the FG-06 table up on its own first, so the migration is
        # proven against a box that has been running tasks for months rather
        # than only against a table this module created.
        await TaskRegistryStore(app_store).initialize()
    store = TodoStore(app_store)
    await store.initialize()
    principals = PrincipalStore(app_store)
    await principals.enroll("leo", display="Leo", role="owner")
    await principals.enroll("ada", display="Ada")
    await principals.enroll("bob", display="Bob")
    return store


def _principal(user_id: str, role: str = "member") -> Principal:
    return Principal(user_id=user_id, display=user_id, role=role)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_migration_is_idempotent_and_keeps_existing_tasks(
    postgres_dsn: str,
) -> None:
    """An FG-06 task written before to-dos existed must still be a valid row.

    The columns are additive with defaults for exactly this reason: the
    upgrade cannot require a backfill or the first deploy loses history.
    """
    store = await _store(postgres_dsn, legacy_tasks_first=True)
    ada = _principal("ada")
    registry = TaskRegistryStore(
        get_store("supabase-app", "prod", config=_config(postgres_dsn))
    )
    legacy = await registry.create_task(
        ada,
        TaskSpec(
            title="Ship the tender",
            description="from before to-dos",
            trigger_state="drafting",
            completion_state="submitted",
            progress_states=("drafting", "reviewing", "submitted"),
        ),
    )

    # Re-running initialize() must be a no-op, not an error.
    await store.initialize()

    migrated = await store.get(ada, legacy.id)
    assert migrated is not None
    assert migrated.stage == "open"
    assert migrated.priority == "normal"
    assert migrated.source_kind is None
    assert migrated.current_state == "drafting"


@pytest.mark.asyncio
async def test_a_replayed_batch_collapses_onto_one_todo(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    source = str(uuid.uuid4())

    first = await store.create(
        ada,
        title="Send the signed quote back to Acme",
        stage="staged",
        source_kind="inbound",
        source_ref=source,
        origin="triage",
    )
    second = await store.create(
        ada,
        title="send the signed quote back to acme",
        stage="staged",
        source_kind="inbound",
        source_ref=source,
        origin="triage",
    )

    assert first.created is True
    assert second.created is False
    assert second.id == first.id
    items, _ = await store.list(ada)
    assert len(items) == 1


@pytest.mark.asyncio
async def test_the_same_request_after_completion_is_a_new_todo(
    postgres_dsn: str,
) -> None:
    """The dedupe index covers live rows only.

    "Send the invoice" next month is a real new to-do; keying it against
    completed history would silently swallow it.
    """
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    source = str(uuid.uuid4())

    first = await store.create(
        ada,
        title="Send the invoice",
        source_kind="inbound",
        source_ref=source,
        origin="triage",
    )
    await store.set_stage(ada, first.id, "done")

    again = await store.create(
        ada,
        title="Send the invoice",
        source_kind="inbound",
        source_ref=source,
        origin="triage",
    )
    assert again.created is True
    assert again.id != first.id


@pytest.mark.asyncio
async def test_redetection_never_demotes_a_promoted_todo(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    source = str(uuid.uuid4())

    todo = await store.create(
        ada,
        title="Reply to the tender clarification",
        stage="staged",
        source_kind="inbound",
        source_ref=source,
    )
    await store.set_stage(ada, todo.id, "working")

    reseen = await store.create(
        ada,
        title="Reply to the tender clarification",
        stage="staged",
        priority="high",
        source_kind="inbound",
        source_ref=source,
    )
    assert reseen.created is False
    assert reseen.stage == "working"
    assert reseen.priority == "high"


@pytest.mark.asyncio
async def test_stage_and_status_move_together(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(ada, title="Draft the reply", stage="staged")
    assert todo.status == "pending"

    working = await store.set_stage(ada, todo.id, "working")
    assert (working.stage, working.status) == ("working", "in_progress")
    assert working.closed_at is None

    done = await store.set_stage(ada, todo.id, "done", outcome="sent")
    assert (done.stage, done.status) == ("done", "completed")
    assert done.closed_at is not None
    assert done.outcome == "sent"


@pytest.mark.asyncio
async def test_every_stage_change_leaves_an_audit_row(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(
        ada, title="Book the venue", stage="staged", actor="skill:email-triage"
    )
    await store.set_stage(ada, todo.id, "open", actor="system:promotion")
    await store.set_stage(ada, todo.id, "dismissed", actor="user:ada")

    history = await store.history(ada, todo.id)
    assert [(h["from"], h["to"]) for h in history] == [
        ("stage:new", "stage:staged"),
        ("stage:staged", "stage:open"),
        ("stage:open", "stage:dismissed"),
    ]
    assert history[0]["actor"] == "skill:email-triage"
    assert history[-1]["actor"] == "user:ada"


@pytest.mark.asyncio
async def test_only_one_caller_wins_the_notification_stamp(
    postgres_dsn: str,
) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(ada, title="Confirm Thursday", stage="open")

    assert await store.mark_notified(ada, todo.id) is True
    assert await store.mark_notified(ada, todo.id) is False
    assert await store.pending_notification(ada) == []


@pytest.mark.asyncio
async def test_staged_todos_are_never_up_for_notification(
    postgres_dsn: str,
) -> None:
    """The point of `staged` is that it is silent."""
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    await store.create(ada, title="FYI: newsletter", stage="staged")
    open_todo = await store.create(ada, title="Answer the auditor", stage="open")

    pending = await store.pending_notification(ada)
    assert [t.id for t in pending] == [open_todo.id]


@pytest.mark.asyncio
async def test_snoozing_hides_the_todo_and_rearms_notification(
    postgres_dsn: str,
) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(ada, title="Chase the deposit", stage="open")
    await store.mark_notified(ada, todo.id)

    later = datetime.now(timezone.utc) + timedelta(days=2)
    await store.snooze(ada, todo.id, later)

    visible, _ = await store.list(ada)
    assert visible == []
    assert await store.list(ada, include_snoozed=True) != ([], None)

    # Once the snooze lapses it is both visible and announceable again.
    after = later + timedelta(minutes=1)
    returned, _ = await store.list(ada, now=after)
    assert [t.id for t in returned] == [todo.id]
    assert [t.id for t in await store.pending_notification(ada, now=after)] == [
        todo.id
    ]


@pytest.mark.asyncio
async def test_unsnooze_restores_the_todo_exactly_as_it_was(
    postgres_dsn: str,
) -> None:
    """Undo after a snooze: visible again and not announced a second time."""
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(ada, title="Ring the landlord", stage="open")
    await store.mark_notified(ada, todo.id)
    before = await store.get(ada, todo.id)
    assert before is not None and before.notified_at is not None

    await store.snooze(ada, todo.id, datetime.now(timezone.utc) + timedelta(days=1))
    restored = await store.unsnooze(
        ada, todo.id, until=before.snoozed_until, notified_at=before.notified_at
    )

    assert restored.snoozed_until is None
    assert restored.notified_at == before.notified_at
    assert [t.id for t in (await store.list(ada))[0]] == [todo.id]
    assert await store.pending_notification(ada) == []

    # An earlier snooze comes back as it was, not cleared.
    earlier = datetime.now(timezone.utc) + timedelta(hours=3)
    await store.snooze(ada, todo.id, earlier)
    await store.snooze(ada, todo.id, earlier + timedelta(days=7))
    back = await store.unsnooze(ada, todo.id, until=earlier)
    assert back.snoozed_until == earlier

    # Clearing with no arguments wakes it now.
    cleared = await store.unsnooze(ada, todo.id)
    assert cleared.snoozed_until is None
    history = [step["to"] for step in await store.history(ada, todo.id)]
    assert "stage:snooze cleared" in history


@pytest.mark.asyncio
async def test_nobody_else_can_unsnooze_my_todo(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada, bob = _principal("ada"), _principal("bob")
    todo = await store.create(ada, title="Private errand", stage="open")
    later = datetime.now(timezone.utc) + timedelta(days=1)
    await store.snooze(ada, todo.id, later)

    with pytest.raises(LookupError):
        await store.unsnooze(bob, todo.id)
    still = await store.get(ada, todo.id)
    assert still is not None and still.snoozed_until == later


@pytest.mark.asyncio
async def test_untouched_staged_todos_expire(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    stale = await store.create(ada, title="Old FYI", stage="staged")
    fresh = await store.create(ada, title="New FYI", stage="staged")
    promoted = await store.create(ada, title="Real work", stage="open")

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        await conn.execute(
            f"UPDATE {TASKS_TABLE} SET updated_at = NOW() - INTERVAL '30 days'"
            " WHERE id = $1",
            stale.id,
        )
    finally:
        await conn.close()

    swept = await store.expire_staged(ada, older_than_days=14)
    assert swept == 1
    assert (await store.get(ada, stale.id)).stage == "dismissed"  # type: ignore[union-attr]
    assert (await store.get(ada, fresh.id)).stage == "staged"  # type: ignore[union-attr]
    assert (await store.get(ada, promoted.id)).stage == "open"  # type: ignore[union-attr]
    history = await store.history(ada, stale.id)
    assert history[-1]["actor"] == "system:expiry"


@pytest.mark.asyncio
async def test_filters_and_facets_agree(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    await store.create(
        ada, title="Urgent thing", stage="open", priority="high",
        source_kind="inbound", source_ref=str(uuid.uuid4()),
    )
    await store.create(ada, title="Quiet thing", stage="staged", source_kind="cron")
    await store.create(ada, title="My own thing", stage="open", source_kind="user")

    open_items, _ = await store.list(ada, stages=["open"])
    assert len(open_items) == 2
    high, _ = await store.list(ada, priorities=["high"])
    assert [t.title for t in high] == ["Urgent thing"]
    searched, _ = await store.list(ada, query="quiet")
    assert [t.title for t in searched] == ["Quiet thing"]

    facets = await store.facets(ada)
    assert dict((f["value"], f["count"]) for f in facets["stages"]) == {
        "open": 2,
        "staged": 1,
    }
    assert {f["value"] for f in facets["sources"]} == {"inbound", "cron", "user"}


@pytest.mark.asyncio
async def test_paging_is_stable_while_new_todos_land(postgres_dsn: str) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    for index in range(5):
        await store.create(ada, title=f"Item {index}")

    first_page, cursor = await store.list(ada, limit=2)
    assert len(first_page) == 2
    assert cursor is not None

    await store.create(ada, title="Arrived mid-scroll")

    second_page, _ = await store.list(ada, limit=2, cursor=cursor)
    ids = {t.id for t in first_page} | {t.id for t in second_page}
    assert len(ids) == 4, "a new arrival must not shift the page boundary"


@pytest.mark.asyncio
async def test_one_person_cannot_see_or_move_anothers_todo(
    postgres_dsn: str,
) -> None:
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    bob = _principal("bob")
    todo = await store.create(ada, title="Ada's private follow-up")

    assert await store.get(bob, todo.id) is None
    assert await store.list(bob) == ([], None)
    with pytest.raises(LookupError):
        await store.set_stage(bob, todo.id, "dismissed")

    # The owner role is the deliberate exception (contract C2).
    assert await store.get(_principal("leo", role="owner"), todo.id) is not None


@pytest.mark.asyncio
async def test_the_outbound_trail_reads_back_with_parsed_events(
    postgres_dsn: str,
) -> None:
    """``list_outbound`` is the replay guard's only source of truth.

    It has to run against the real ``task_transitions`` shape (the timestamp
    column is ``ts``) and return the *parsed* event name, because the row is
    stored as ``action:<event>:<channel>`` and the guard compares a bare
    ``"sent"``. Both halves were wrong at once behind a mocked store.
    """
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    todo = await store.create(ada, title="Reply to the tender query")

    assert await store.list_outbound(ada, todo.id) == []

    await store.record_session(
        ada, todo.id, session_id="todo_abc", actor="user:ada"
    )
    events = [row["event"] for row in await store.list_outbound(ada, todo.id)]
    assert events == ["session"], "a spawn pointer must not read as a delivery"

    await store.record_outbound(
        ada, todo.id, event="sent", channel="whatsapp", actor="user:ada"
    )
    rows = await store.list_outbound(ada, todo.id)
    assert [row["event"] for row in rows] == ["sent", "session"], "newest first"
    assert rows[0]["actor"] == "user:ada"
    assert rows[0]["at"] is not None


@pytest.mark.asyncio
async def test_the_outbound_trail_is_invisible_to_another_principal(
    postgres_dsn: str,
) -> None:
    """Visibility gates the trail, not just the to-do.

    Otherwise the guard would leak "this was already sent" about a to-do the
    caller cannot read.
    """
    store = await _store(postgres_dsn)
    ada = _principal("ada")
    bob = _principal("bob")
    todo = await store.create(ada, title="Ada's outgoing reply")
    await store.record_outbound(
        ada, todo.id, event="sent", channel="whatsapp", actor="user:ada"
    )

    assert await store.list_outbound(bob, todo.id) == []
    assert len(await store.list_outbound(ada, todo.id)) == 1
