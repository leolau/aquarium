"""Postgres E2E for the inbound item registry and the shared tag vocabulary.

Exercises the real tables against a throwaway Postgres: upsert identity (a
re-polled email is one item that changed, not two that disagree), keyset paging
that stays stable while new arrivals land, Chinese search actually matching,
tag filtering across entity kinds, and the negative access test enforced by
row-level security.
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
from hermes_cli.inbound_registry import (
    INBOUND_ITEMS_TABLE,
    InboundRegistry,
    decode_cursor,
    register_arrival,
)
from hermes_cli.file_registry import FileRegistry
from hermes_cli.tags import TagRegistry


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
    container = f"hermes-inbound-{uuid.uuid4().hex[:12]}"
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


async def _registry(dsn: str, *, with_files: bool = False) -> InboundRegistry:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    if with_files:
        # The attachment link is a column on `file_assets`, so that table has
        # to exist before the inbound registry can add it. Only the tests that
        # exercise attachments pay for it; the rest prove the registry stands
        # up on a box that has never registered a file.
        await FileRegistry(
            get_store("supabase-app", "prod", config=_config(dsn))
        ).initialize()
    registry = InboundRegistry(get_store("supabase-app", "prod", config=_config(dsn)))
    await registry.initialize()
    store = PrincipalStore(get_store("supabase-app", "prod", config=_config(dsn)))
    await store.enroll("leo", display="Leo", role="owner")
    await store.enroll("ada", display="Ada")
    await store.enroll("bob", display="Bob")
    return registry


def _principal(user_id: str, role: str = "member") -> Principal:
    return Principal(user_id=user_id, display=user_id, role=role)  # type: ignore[arg-type]


async def _arrive(registry: InboundRegistry, principal: Principal, **kwargs):
    fields = {
        "surface": "email",
        "external_id": f"msg-{uuid.uuid4().hex[:8]}",
        "account_id": "leo@example.com",
        "body": "the body",
    }
    fields.update(kwargs)
    return await registry.register(principal, **fields)


@pytest.mark.asyncio
async def test_initializes_without_a_file_registry(postgres_dsn: str) -> None:
    """A box that has never received a file still gets a working inbox.

    The attachment link is best-effort for exactly this reason; if it were
    fatal, installing the Incomings feature would depend on the order two
    unrelated registries happened to be initialised in.
    """
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="no-files-here")

    assert await registry.get(ada, item.id) is not None
    assert await registry.attachments(ada, item.id) == []


@pytest.mark.asyncio
async def test_arrival_keeps_full_provenance(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    when = datetime(2026, 8, 10, 9, 30, tzinfo=timezone.utc)

    item = await _arrive(
        registry,
        ada,
        surface="whatsapp",
        external_id="wamid.42",
        account_id="+85212345678",
        conversation="group:tender-2026",
        conversation_name="Tender 2026",
        sender_id="+85298765432",
        sender_name="Ada Wong",
        body="можем ли we meet at three",
        occurred_at=when,
        importance="urgent",
        metadata={"batch_id": "b-7"},
    )

    assert item.surface == "whatsapp"
    assert item.conversation_name == "Tender 2026"
    assert item.sender_name == "Ada Wong"
    assert item.occurred_at == when
    assert item.importance == "urgent"
    assert item.metadata == {"batch_id": "b-7"}
    assert item.visibility == "private:ada"
    assert item.remembered is False


@pytest.mark.asyncio
async def test_repolling_the_same_email_updates_one_row(postgres_dsn: str) -> None:
    """Unlike a file arrival, a re-polled message is one item, not two facts.

    An IMAP poller re-reading a page, or a calendar sync seeing a meeting move,
    must not double the inbox.
    """
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")

    first = await _arrive(
        registry,
        ada,
        external_id="<abc@mail>",
        subject="Quote request",
        body="original",
    )
    second = await _arrive(
        registry,
        ada,
        external_id="<abc@mail>",
        subject="Quote request (updated)",
        body="rescheduled to Thursday",
    )

    assert first.id == second.id
    assert second.subject == "Quote request (updated)"
    page = await registry.list(ada)
    assert len(page.items) == 1
    assert page.items[0].body == "rescheduled to Thursday"


@pytest.mark.asyncio
async def test_the_same_external_id_on_two_surfaces_is_two_items(
    postgres_dsn: str,
) -> None:
    """Identity includes the surface and account, so ids never collide across
    channels that happen to number their messages the same way."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    a = await _arrive(registry, ada, surface="email", external_id="1")
    b = await _arrive(registry, ada, surface="whatsapp", external_id="1")
    c = await _arrive(
        registry, ada, surface="email", external_id="1", account_id="other@example.com"
    )
    assert len({a.id, b.id, c.id}) == 3


@pytest.mark.asyncio
async def test_chinese_search_finds_a_word_inside_a_sentence(
    postgres_dsn: str,
) -> None:
    """The under-match bug, end to end against real Postgres.

    With plain `to_tsvector('simple', body)` the whole sentence is one lexeme
    and this returns nothing; the bigram-segmented `search_text` is what makes
    it match.
    """
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    await _arrive(
        registry, ada, external_id="cjk-1", body="請問明天的會議改到下午三點嗎"
    )
    await _arrive(registry, ada, external_id="cjk-2", body="報價單已經寄出")

    page = await registry.list(ada, query="會議")
    assert [i.external_id for i in page.items] == ["cjk-1"]

    page = await registry.list(ada, query="報價")
    assert [i.external_id for i in page.items] == ["cjk-2"]

    # English still works, and a word that is absent still misses — the index
    # got more findable, not indiscriminate.
    await _arrive(registry, ada, external_id="en-1", body="the quarterly invoice")
    page = await registry.list(ada, query="invoice")
    assert [i.external_id for i in page.items] == ["en-1"]
    page = await registry.list(ada, query="沒有這個詞")
    assert page.items == []


@pytest.mark.asyncio
async def test_single_chinese_character_falls_back_to_substring(
    postgres_dsn: str,
) -> None:
    """One character has no bigram, so only the ILIKE path can answer it."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    await _arrive(registry, ada, external_id="cjk-1", body="請問明天的會議")

    page = await registry.list(ada, query="會")
    assert [i.external_id for i in page.items] == ["cjk-1"]


@pytest.mark.asyncio
async def test_search_matches_sender_and_conversation(postgres_dsn: str) -> None:
    """"Everything from Ada" is how people search an inbox."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    await _arrive(
        registry, ada, external_id="m1", sender_name="Ada Wong", body="hello"
    )
    await _arrive(
        registry,
        ada,
        external_id="m2",
        conversation_name="Tender 2026",
        body="hello",
    )

    page = await registry.list(ada, query="Wong")
    assert [i.external_id for i in page.items] == ["m1"]
    page = await registry.list(ada, query="Tender")
    assert [i.external_id for i in page.items] == ["m2"]


@pytest.mark.asyncio
async def test_keyset_paging_walks_the_whole_list_without_gaps(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    for n in range(25):
        await _arrive(
            registry,
            ada,
            external_id=f"m{n:03d}",
            occurred_at=base + timedelta(minutes=n),
        )

    seen: list[str] = []
    cursor = None
    pages = 0
    while True:
        page = await registry.list(ada, limit=10, cursor=cursor)
        seen.extend(i.external_id for i in page.items)
        pages += 1
        cursor = page.next_cursor
        if cursor is None:
            break
        assert pages < 10, "paging did not terminate"

    assert pages == 3
    assert len(seen) == len(set(seen)) == 25
    assert seen == sorted(seen, reverse=True)


@pytest.mark.asyncio
async def test_a_new_arrival_mid_scroll_does_not_shift_the_page(
    postgres_dsn: str,
) -> None:
    """The reason for keyset over OFFSET: a message landing between two page
    reads must not push a row across the boundary and show it twice."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    base = datetime(2026, 8, 1, tzinfo=timezone.utc)
    for n in range(10):
        await _arrive(
            registry,
            ada,
            external_id=f"m{n:02d}",
            occurred_at=base + timedelta(minutes=n),
        )

    first = await registry.list(ada, limit=5)
    await _arrive(
        registry,
        ada,
        external_id="newest",
        occurred_at=base + timedelta(hours=1),
    )
    second = await registry.list(ada, limit=5, cursor=first.next_cursor)

    ids = [i.external_id for i in first.items] + [i.external_id for i in second.items]
    assert len(ids) == len(set(ids))
    assert "newest" not in ids


@pytest.mark.asyncio
async def test_items_sharing_a_timestamp_are_not_skipped(postgres_dsn: str) -> None:
    """Ties on occurred_at are broken by id in both the ORDER BY and the
    cursor comparison; if they were not, a page boundary landing inside a tie
    would drop rows."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    same = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    for n in range(6):
        await _arrive(registry, ada, external_id=f"tie{n}", occurred_at=same)

    seen: list[str] = []
    cursor = None
    while True:
        page = await registry.list(ada, limit=2, cursor=cursor)
        seen.extend(i.external_id for i in page.items)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert sorted(seen) == [f"tie{n}" for n in range(6)]


@pytest.mark.asyncio
async def test_cursor_is_opaque_but_round_trips(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    when = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
    await _arrive(registry, ada, external_id="a", occurred_at=when)
    await _arrive(registry, ada, external_id="b", occurred_at=when)

    page = await registry.list(ada, limit=1)
    assert page.next_cursor is not None
    ts, item_id = decode_cursor(page.next_cursor)
    assert ts == when
    assert item_id == page.items[0].id

    with pytest.raises(ValueError):
        decode_cursor("not-a-cursor")


@pytest.mark.asyncio
async def test_filters_narrow_by_surface_kind_importance_and_date(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    now = datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    await _arrive(
        registry,
        ada,
        external_id="w1",
        surface="whatsapp",
        importance="urgent",
        occurred_at=now - timedelta(days=3),
    )
    await _arrive(
        registry,
        ada,
        external_id="e1",
        surface="email",
        has_attachments=True,
        occurred_at=now - timedelta(hours=2),
    )
    await _arrive(
        registry,
        ada,
        external_id="c1",
        surface="calendar",
        kind="event",
        occurred_at=now + timedelta(days=1),
        ends_at=now + timedelta(days=1, hours=1),
    )

    page = await registry.list(ada, surfaces=["whatsapp", "calendar"])
    assert {i.external_id for i in page.items} == {"w1", "c1"}
    page = await registry.list(ada, kinds=["event"])
    assert [i.external_id for i in page.items] == ["c1"]
    page = await registry.list(ada, importance=["urgent"])
    assert [i.external_id for i in page.items] == ["w1"]
    page = await registry.list(ada, has_attachments=True)
    assert [i.external_id for i in page.items] == ["e1"]
    page = await registry.list(ada, since=now - timedelta(hours=3))
    assert {i.external_id for i in page.items} == {"e1", "c1"}
    page = await registry.list(ada, until=now)
    assert {i.external_id for i in page.items} == {"w1", "e1"}


@pytest.mark.asyncio
async def test_facets_count_only_what_the_reader_can_see(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada, bob = _principal("ada"), _principal("bob")
    await _arrive(registry, ada, external_id="a1", surface="email")
    await _arrive(registry, ada, external_id="a2", surface="email")
    await _arrive(
        registry, ada, external_id="a3", surface="whatsapp", importance="urgent"
    )
    await _arrive(registry, bob, external_id="b1", surface="email")

    facets = await registry.facets(ada)
    assert facets["surfaces"] == [
        {"value": "email", "count": 2},
        {"value": "whatsapp", "count": 1},
    ]
    assert facets["importance"] == [{"value": "urgent", "count": 1}]
    assert await registry.facets(bob) == {
        "surfaces": [{"value": "email", "count": 1}],
        "importance": [],
    }


@pytest.mark.asyncio
async def test_one_members_arrivals_are_invisible_to_another(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    ada, bob = _principal("ada"), _principal("bob")
    item = await _arrive(registry, ada, external_id="private-1")

    assert await registry.get(ada, item.id) is not None
    assert await registry.get(bob, item.id) is None
    assert (await registry.list(bob)).items == []
    # The owner role reads through, as it does for files and memories.
    assert await registry.get(_principal("leo", "owner"), item.id) is not None


@pytest.mark.asyncio
async def test_remember_links_an_arrival_to_its_document(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="keep-me")
    document_id = str(uuid.uuid4())

    updated = await registry.mark_remembered(
        ada, item.id, document_id=document_id, remembered_by="email-triage"
    )
    assert updated is not None
    assert updated.remembered is True
    assert updated.document_id == document_id
    assert updated.remembered_by == "email-triage"

    page = await registry.list(ada, remembered=True)
    assert [i.external_id for i in page.items] == ["keep-me"]
    page = await registry.list(ada, remembered=False)
    assert page.items == []

    # A member cannot mark somebody else's arrival as remembered.
    assert (
        await registry.mark_remembered(
            _principal("bob"),
            item.id,
            document_id=str(uuid.uuid4()),
            remembered_by="bob",
        )
        is None
    )


@pytest.mark.asyncio
async def test_registering_does_not_ingest_into_memory(postgres_dsn: str) -> None:
    """Arrival is a fact; remembering is a judgement made later."""
    registry = await _registry(postgres_dsn)
    await _arrive(registry, _principal("ada"), external_id="x")

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        items = await conn.fetchval(
            f"SELECT count(*) FROM app_prod.{INBOUND_ITEMS_TABLE}"
        )
        documents = await conn.fetchval("SELECT to_regclass('app_prod.rag_documents')")
    finally:
        await conn.close()
    assert items == 1
    assert documents is None


@pytest.mark.asyncio
async def test_register_arrival_swallows_failures(postgres_dsn: str) -> None:
    """A poller must not crash because the shared store blinked."""

    class _Broken:
        async def register(self, *args, **kwargs):
            raise RuntimeError("postgres is down")

    result = await register_arrival(
        _principal("ada"),
        surface="email",
        external_id="boom",
        registry=_Broken(),  # type: ignore[arg-type]
    )
    assert result is None


# ---------------------------------------------------------------------------
# The shared tag vocabulary
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tags_are_shared_across_entity_kinds(postgres_dsn: str) -> None:
    """One vocabulary for sessions and incomings — the point of promoting it
    out of the session SQLite store."""
    registry = await _registry(postgres_dsn)
    tags: TagRegistry = registry.tags
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="tagged")

    on_item = await tags.assign(ada, "inbound", item.id, "Invoice", color="amber")
    on_session = await tags.assign(ada, "session", "sess-abc123", "invoice")

    # Case-insensitive dedup, exactly as SessionDB.create_tag behaves.
    assert on_item.id == on_session.id
    listed = await tags.list(ada)
    assert [t.name for t in listed] == ["Invoice"]
    assert listed[0].usage_count == 2
    assert listed[0].color == "amber"

    scoped = await tags.list(ada, entity_kind="inbound")
    assert scoped[0].usage_count == 1


@pytest.mark.asyncio
async def test_tag_filtering_supports_any_all_and_exclude(postgres_dsn: str) -> None:
    """The tri-state chips in TagFilterBar, resolved server-side."""
    registry = await _registry(postgres_dsn)
    tags = registry.tags
    ada = _principal("ada")
    a = await _arrive(registry, ada, external_id="a")
    b = await _arrive(registry, ada, external_id="b")
    c = await _arrive(registry, ada, external_id="c")

    await tags.assign(ada, "inbound", a.id, "invoice")
    await tags.assign(ada, "inbound", a.id, "urgent")
    await tags.assign(ada, "inbound", b.id, "invoice")
    await tags.assign(ada, "inbound", c.id, "urgent")

    page = await registry.list(ada, include_tags=["invoice"])
    assert {i.external_id for i in page.items} == {"a", "b"}

    page = await registry.list(ada, include_tags=["invoice", "urgent"], tag_match="any")
    assert {i.external_id for i in page.items} == {"a", "b", "c"}

    page = await registry.list(ada, include_tags=["invoice", "urgent"], tag_match="all")
    assert {i.external_id for i in page.items} == {"a"}

    page = await registry.list(ada, exclude_tags=["urgent"])
    assert {i.external_id for i in page.items} == {"b"}

    page = await registry.list(
        ada, include_tags=["invoice"], exclude_tags=["urgent"]
    )
    assert {i.external_id for i in page.items} == {"b"}


@pytest.mark.asyncio
async def test_a_member_cannot_see_or_use_another_members_tags(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    tags = registry.tags
    ada, bob = _principal("ada"), _principal("bob")
    item = await _arrive(registry, ada, external_id="a")
    tag = await tags.assign(ada, "inbound", item.id, "confidential")

    assert [t.name for t in await tags.list(bob)] == []
    assert await tags.for_entity(bob, "inbound", item.id) == []
    assert await tags.unassign(bob, "inbound", item.id, tag.id) is False
    assert await tags.delete(bob, tag.id) is False
    # Still attached for its owner after the failed attempts.
    assert [t.name for t in await tags.for_entity(ada, "inbound", item.id)] == [
        "confidential"
    ]


@pytest.mark.asyncio
async def test_deleting_a_tag_removes_its_assignments(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    tags = registry.tags
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="a")
    tag = await tags.assign(ada, "inbound", item.id, "temp")

    assert await tags.delete(ada, tag.id) is True
    assert await tags.for_entity(ada, "inbound", item.id) == []
    page = await registry.list(ada, include_tags=["temp"])
    assert page.items == []


@pytest.mark.asyncio
async def test_deleting_an_item_purges_its_tag_assignments(
    postgres_dsn: str,
) -> None:
    """entity_id is polymorphic and cannot carry a foreign key, so a recycled
    id would otherwise inherit a stranger's tags."""
    registry = await _registry(postgres_dsn)
    tags = registry.tags
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="a")
    await tags.assign(ada, "inbound", item.id, "keep")

    assert await registry.delete(ada, item.id) is True
    assert await tags.for_entity(ada, "inbound", item.id) == []
    assert [t.usage_count for t in await tags.list(ada)] == [0]


@pytest.mark.asyncio
async def test_assignment_source_is_preserved(postgres_dsn: str) -> None:
    """`manual` vs an LLM suggestion vs a skill name — the provenance the
    session tag map already carried."""
    registry = await _registry(postgres_dsn)
    tags = registry.tags
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="a")
    await tags.assign(ada, "inbound", item.id, "auto", source="email-triage")

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        source = await conn.fetchval(
            "SELECT source FROM app_prod.tag_assignments WHERE entity_id = $1",
            item.id,
        )
    finally:
        await conn.close()
    assert source == "email-triage"


@pytest.mark.asyncio
async def test_attachments_link_both_ways(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn, with_files=True)
    ada = _principal("ada")
    item = await _arrive(registry, ada, external_id="with-file")

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        asset_id = await conn.fetchval(
            """INSERT INTO file_assets
                   (owner_user_id, visibility, surface, filename, content_type,
                    byte_size, sha256, storage_bucket, storage_path)
               VALUES ('ada', 'private:ada', 'email', 'quote.pdf',
                       'application/pdf', 12, 'deadbeef', 'b', 'p')
               RETURNING id"""
        )
    finally:
        await conn.close()

    assert await registry.link_attachment(ada, item.id, str(asset_id)) is True
    files = await registry.attachments(ada, item.id)
    assert [f["filename"] for f in files] == ["quote.pdf"]
    refreshed = await registry.get(ada, item.id)
    assert refreshed is not None and refreshed.has_attachments is True
    # Another member sees neither the link nor the file.
    assert await registry.attachments(_principal("bob"), item.id) == []


@pytest.mark.asyncio
async def test_backfill_is_idempotent_and_adopts_legacy_files(
    postgres_dsn: str, tmp_path, monkeypatch
) -> None:
    """Replaying the pipeline twice is one inbox, not two.

    The live hooks only mirror what arrives from now on, so everything older
    exists solely in the pipeline's SQLite. The backfill has to use the same
    external ids the hooks use, or a repair would double every arrival.
    """
    import sqlite3

    from hermes_cli import incomings_backfill

    await _registry(postgres_dsn, with_files=True)
    store = get_store("supabase-app", "prod", config=_config(postgres_dsn))

    db_path = tmp_path / "pipeline.db"
    pipeline = sqlite3.connect(db_path)
    pipeline.executescript(
        """
        CREATE TABLE email_messages (
            id TEXT PRIMARY KEY, account_id TEXT, from_addr TEXT,
            from_name TEXT, to_addrs TEXT, cc_addrs TEXT, subject TEXT,
            body_text TEXT, body_html TEXT, has_attachments INTEGER,
            attachment_info TEXT, message_id TEXT, in_reply_to TEXT,
            thread_id TEXT, folder TEXT, received_at TEXT, batch_id TEXT,
            raw_headers TEXT
        );
        INSERT INTO email_messages
            (id, account_id, from_addr, subject, body_text, has_attachments,
             message_id, thread_id, folder, received_at)
        VALUES ('1', 'leo@example.com', 'ada@example.com', 'Quote',
                'the quote is attached', 1, 'rfc-1', 't-1', 'INBOX',
                '2026-08-10T09:30:00+00:00');
        """
    )
    pipeline.commit()
    pipeline.close()

    # A file registered before the feature existed: same surface, account and
    # message id as the arrival, but no link yet.
    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        await conn.execute(
            """INSERT INTO file_assets
                   (owner_user_id, visibility, surface, account_id, message_id,
                    filename, content_type, byte_size, sha256,
                    storage_bucket, storage_path)
               VALUES ('leo', 'private:leo', 'email', 'leo@example.com',
                       'rfc-1', 'quote.pdf', 'application/pdf', 12,
                       'deadbeef', 'b', 'p')"""
        )
    finally:
        await conn.close()

    monkeypatch.setattr(incomings_backfill, "get_store", lambda *a, **k: store)
    for _ in range(2):
        code = await incomings_backfill._run(
            db_path=str(db_path),
            surfaces=("email",),
            since=None,
            dry_run=False,
            actor=None,
        )
        assert code == 0

    leo = _principal("leo", role="owner")
    registry = InboundRegistry(store)
    page = await registry.list(leo, surfaces=["email"])
    assert [i.external_id for i in page.items] == ["rfc-1"]
    assert page.items[0].subject == "Quote"

    # The pre-existing attachment now points at the message it arrived in.
    files = await registry.attachments(leo, page.items[0].id)
    assert [f["filename"] for f in files] == ["quote.pdf"]


@pytest.mark.asyncio
async def test_triage_stamps_importance_and_a_re_poll_keeps_it(
    postgres_dsn: str,
) -> None:
    """The triage verdict outlives the next poll of the same mailbox.

    Triage runs minutes after the message landed and holds only the
    classification. The poller, re-reading the same page, holds everything
    *except* the classification — so an unguarded upsert would quietly clear
    the urgency the user filters by.
    """
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    item = await _arrive(registry, leo, external_id="rfc-9", body="the quote")
    assert item.importance is None

    assert (
        await registry.set_importance(
            leo,
            surface="email",
            external_id="rfc-9",
            account_id="leo@example.com",
            importance="high",
        )
        is True
    )
    stamped = await registry.get(leo, item.id)
    assert stamped is not None and stamped.importance == "high"

    # The poller sees the same message again and re-registers it verbatim.
    await _arrive(registry, leo, external_id="rfc-9", body="the quote")
    kept = await registry.get(leo, item.id)
    assert kept is not None and kept.importance == "high"

    # And the filter finds it by that verdict.
    page = await registry.list(leo, importance=["high"])
    assert [i.external_id for i in page.items] == ["rfc-9"]


@pytest.mark.asyncio
async def test_importance_cannot_be_stamped_across_principals(
    postgres_dsn: str,
) -> None:
    """A triage run for one owner cannot reach another's inbox."""
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    await _arrive(registry, ada, external_id="rfc-10", account_id="ada@example.com")
    assert (
        await registry.set_importance(
            _principal("bob"),
            surface="email",
            external_id="rfc-10",
            account_id="ada@example.com",
            importance="high",
        )
        is False
    )


@pytest.mark.asyncio
async def test_owner_page_reads_off_the_occurred_index(postgres_dsn: str) -> None:
    """The owner's scope predicate is ``TRUE``, so no ``owner_user_id`` equality
    reaches the planner: the newest-first page must still come off an index
    rather than a full scan and sort of every arrival."""
    await _registry(postgres_dsn)
    conn = await asyncpg.connect(dsn=postgres_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        indexdef = await conn.fetchval(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app_prod' "
            "AND indexname = $1",
            f"{INBOUND_ITEMS_TABLE}_occurred_idx",
        )
        assert indexdef is not None
        assert "(occurred_at DESC, id DESC)" in indexdef

        async with conn.transaction():
            await conn.execute("SET LOCAL enable_seqscan = off")
            plan = "\n".join(
                r[0]
                for r in await conn.fetch(
                    f"""EXPLAIN SELECT * FROM {INBOUND_ITEMS_TABLE}
                         WHERE TRUE ORDER BY occurred_at DESC, id DESC LIMIT 51"""
                )
            )
        assert f"{INBOUND_ITEMS_TABLE}_occurred_idx" in plan
        assert "Sort" not in plan
    finally:
        await conn.close()


async def _row_version(dsn: str, external_id: str) -> tuple:
    conn = await asyncpg.connect(dsn=dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        row = await conn.fetchrow(
            f"SELECT xmin::text AS xmin, updated_at FROM {INBOUND_ITEMS_TABLE} "
            "WHERE external_id = $1",
            external_id,
        )
        return (row["xmin"], row["updated_at"])
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_identical_re_registration_does_not_rewrite_the_row(
    postgres_dsn: str,
) -> None:
    """A poller re-registering an item it already mirrored is a read, not a
    write: no new tuple version, ``updated_at`` untouched, same item back."""
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    when = datetime(2026, 8, 10, 9, 30, tzinfo=timezone.utc)
    fields = dict(
        external_id="rfc-same",
        subject="Quote",
        body="the quote 報價單",
        sender_name="Ada",
        occurred_at=when,
        ends_at=when + timedelta(hours=1),
        metadata={"folder": "INBOX", "to": ["leo@example.com"]},
        has_attachments=True,
    )
    first = await _arrive(registry, leo, **fields)
    before = await _row_version(postgres_dsn, "rfc-same")

    again = await _arrive(registry, leo, **fields)

    assert again == first
    assert await _row_version(postgres_dsn, "rfc-same") == before


@pytest.mark.asyncio
async def test_changed_re_registration_still_updates(postgres_dsn: str) -> None:
    """Each mirrored field on its own is enough to make the upsert write."""
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    when = datetime(2026, 8, 10, 9, 30, tzinfo=timezone.utc)
    base = dict(
        external_id="rfc-moves",
        subject="Standup",
        body="daily",
        occurred_at=when,
        metadata={"status": "confirmed"},
    )
    item = await _arrive(registry, leo, **base)
    changes = [
        {"subject": "Standup (moved)"},
        {"body": "weekly"},
        {"occurred_at": when + timedelta(days=1)},
        {"ends_at": when + timedelta(hours=2)},
        {"metadata": {"status": "cancelled"}},
        {"has_attachments": True},
        {"sender_name": "Bob"},
        {"conversation": "thread-2"},
        {"kind": "event"},
        {"importance": "high"},
    ]
    for change in changes:
        base.update(change)
        before = await _row_version(postgres_dsn, "rfc-moves")
        updated = await _arrive(registry, leo, **base)
        assert updated.id == item.id
        for key, value in change.items():
            assert getattr(updated, key) == value, key
        assert await _row_version(postgres_dsn, "rfc-moves") != before, change

    # Search follows the new text, not the first registration's.
    page = await registry.list(leo, query="weekly")
    assert [i.external_id for i in page.items] == ["rfc-moves"]


@pytest.mark.asyncio
async def test_re_poll_without_verdict_is_a_no_op_once_triaged(
    postgres_dsn: str,
) -> None:
    """A re-poll carries no importance; once triage stamped one, the re-poll
    neither erases it nor rewrites the row to keep it."""
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    when = datetime(2026, 8, 10, tzinfo=timezone.utc)
    await _arrive(registry, leo, external_id="rfc-t", occurred_at=when)
    await registry.set_importance(
        leo,
        surface="email",
        external_id="rfc-t",
        account_id="leo@example.com",
        importance="high",
    )
    before = await _row_version(postgres_dsn, "rfc-t")
    again = await _arrive(registry, leo, external_id="rfc-t", occurred_at=when)
    assert again.importance == "high"
    assert await _row_version(postgres_dsn, "rfc-t") == before


@pytest.mark.asyncio
async def test_concurrent_identical_registrations_make_one_row(
    postgres_dsn: str,
) -> None:
    """Racing the same arrival still yields one row and a returned item each."""
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    when = datetime(2026, 8, 10, tzinfo=timezone.utc)
    items = await asyncio.gather(
        *(
            _arrive(registry, leo, external_id="rfc-race", occurred_at=when)
            for _ in range(8)
        )
    )
    assert len({i.id for i in items}) == 1
    page = await registry.list(leo)
    assert [i.external_id for i in page.items] == ["rfc-race"]


@pytest.mark.asyncio
async def test_re_registering_a_mailbox_writes_nothing(postgres_dsn: str) -> None:
    """The cost being cut: re-registering N unchanged arrivals used to write N
    new tuple versions (each re-indexing search_tsv); now it writes none."""
    registry = await _registry(postgres_dsn)
    leo = _principal("leo", role="owner")
    when = datetime(2026, 8, 10, tzinfo=timezone.utc)
    n = 200
    conn = await registry._connect()
    try:
        for i in range(n):
            await _arrive(
                registry, leo, external_id=f"bulk-{i}", occurred_at=when,
                body=f"message {i}", connection=conn,
            )
    finally:
        await conn.close()

    conn = await registry._connect()
    try:
        async with conn.transaction():
            for i in range(n):
                await _arrive(
                    registry, leo, external_id=f"bulk-{i}", occurred_at=when,
                    body=f"message {i}", connection=conn,
                )
            written = await conn.fetchval(
                "SELECT n_tup_ins + n_tup_upd FROM pg_stat_xact_user_tables "
                "WHERE relname = $1",
                INBOUND_ITEMS_TABLE,
            )
    finally:
        await conn.close()
    assert written == 0


@pytest.mark.asyncio
async def test_backfill_uses_one_connection(
    postgres_dsn: str, tmp_path, monkeypatch
) -> None:
    """A replay of many rows opens one Postgres connection, not one per row,
    and a second replay of the same SQLite rewrites nothing."""
    import sqlite3

    from hermes_cli import incomings_backfill

    await _registry(postgres_dsn)
    store = get_store("supabase-app", "prod", config=_config(postgres_dsn))
    db_path = tmp_path / "pipeline.db"
    pipeline = sqlite3.connect(db_path)
    pipeline.execute(
        """CREATE TABLE messages (
            id TEXT PRIMARY KEY, source_phone TEXT, sender_phone TEXT,
            sender_name TEXT, chat_id TEXT, is_group INTEGER, text TEXT,
            media_type TEXT, media_path TEXT, media_mimetype TEXT,
            timestamp TEXT, received_at TEXT, batch_id TEXT, raw_json TEXT)"""
    )
    pipeline.executemany(
        "INSERT INTO messages (id, source_phone, sender_phone, chat_id, "
        "is_group, text, timestamp) VALUES (?, '852', '853', 'c', 0, ?, ?)",
        [
            (f"wa-{i}", f"hello {i}", f"2026-08-10T09:{i % 60:02d}:00+00:00")
            for i in range(50)
        ],
    )
    pipeline.commit()
    pipeline.close()

    connects = 0
    real_connect = type(store).connect

    async def counting_connect(self, *args, **kwargs):
        nonlocal connects
        connects += 1
        return await real_connect(self, *args, **kwargs)

    # The store is a frozen dataclass, so count at the class.
    monkeypatch.setattr(type(store), "connect", counting_connect)
    monkeypatch.setattr(incomings_backfill, "get_store", lambda *a, **k: store)

    async def run() -> None:
        assert (
            await incomings_backfill._run(
                db_path=str(db_path),
                surfaces=("whatsapp",),
                since=None,
                dry_run=False,
                actor=None,
            )
            == 0
        )

    await run()
    first_pass = connects
    assert first_pass < 50

    before = await _row_version(postgres_dsn, "wa-7")
    await run()
    assert await _row_version(postgres_dsn, "wa-7") == before

    page = await InboundRegistry(store).list(
        _principal("leo", role="owner"), surfaces=["whatsapp"], limit=200
    )
    assert len(page.items) == 50
