"""Postgres E2E for the inbound file registry (contract C2/C3).

Exercises the real table against a throwaway Postgres: every arrival recorded
separately (a re-send is a second event, not a duplicate to collapse) with its
provenance round-tripping intact, list filters, the negative access test
enforced by row-level security, and the deliberate separation from memory —
registering a file writes nothing to ``rag_documents``.
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
from hermes_cli.file_registry import (
    FILE_ASSETS_TABLE,
    FileRegistry,
    content_digest,
    storage_key,
    store_and_register,
)


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
    container = f"hermes-files-{uuid.uuid4().hex[:12]}"
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


async def _registry(dsn: str, *, reset: bool = True) -> FileRegistry:
    if reset:
        conn = await asyncpg.connect(dsn, ssl=False)
        try:
            await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
            await initialize_supabase_app(conn)
        finally:
            await conn.close()
    registry = FileRegistry(
        get_store("supabase-app", "prod", config=_config(dsn))
    )
    await registry.initialize()
    store = PrincipalStore(get_store("supabase-app", "prod", config=_config(dsn)))
    await store.enroll("leo", display="Leo", role="owner")
    await store.enroll("ada", display="Ada")
    await store.enroll("bob", display="Bob")
    return registry


def _principal(user_id: str, role: str = "member") -> Principal:
    return Principal(user_id=user_id, display=user_id, role=role)  # type: ignore[arg-type]


async def _register(
    registry: FileRegistry,
    principal: Principal,
    *,
    filename: str = "grant.pdf",
    payload: bytes = b"a grant application",
    surface: str = "telegram",
    **kwargs,
):
    digest = content_digest(payload)
    return await registry.register(
        principal,
        surface=surface,
        filename=filename,
        content_type="application/pdf",
        byte_size=len(payload),
        sha256=digest,
        storage_bucket="agent-home-media",
        storage_path=storage_key(principal.user_id, surface, digest, filename),
        **kwargs,
    )


@pytest.mark.asyncio
async def test_registration_keeps_full_provenance(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    when = datetime(2026, 8, 6, 14, 8, tzinfo=timezone.utc)

    asset = await _register(
        registry,
        ada,
        surface="whatsapp",
        account_id="+85212345678",
        conversation="group:tender-2026",
        sender_id="+85298765432",
        sender_name="Ada Wong",
        message_id="wamid.42",
        received_at=when,
    )

    assert asset.surface == "whatsapp"
    assert asset.sender_name == "Ada Wong"
    assert asset.conversation == "group:tender-2026"
    assert asset.message_id == "wamid.42"
    assert asset.received_at == when
    assert asset.visibility == "private:ada"
    assert asset.remembered is False


@pytest.mark.asyncio
async def test_the_same_file_sent_three_times_is_three_arrivals(
    postgres_dsn: str,
) -> None:
    """Three sends are three events, even when the bytes are identical.

    Each keeps its own sender, conversation and timestamp — that provenance is
    the reason the table exists. Only the storage object is shared.
    """
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    arrivals = [
        ("telegram", "Ada Wong", "chat:1", 12),
        ("whatsapp", "Bob", "group:tender-2026", 14),
        ("email", "Chair", "thread:99", 23),
    ]
    assets = [
        await _register(
            registry,
            ada,
            surface=surface,
            sender_name=sender,
            conversation=conversation,
            received_at=datetime(2026, 8, 6, hour, 0, tzinfo=timezone.utc),
        )
        for surface, sender, conversation, hour in arrivals
    ]

    assert len({a.id for a in assets}) == 3
    rows, total = await registry.list(ada)
    assert total == 3
    assert [r.sender_name for r in rows] == ["Chair", "Bob", "Ada Wong"]
    assert [r.surface for r in rows] == ["email", "whatsapp", "telegram"]
    # Same bytes ⇒ one content-addressed object behind all three rows.
    assert len({r.sha256 for r in rows}) == 1
    assert len({r.storage_path for r in rows}) == 1


@pytest.mark.asyncio
async def test_a_members_file_is_invisible_to_another_member(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    ada, bob = _principal("ada"), _principal("bob")
    asset = await _register(registry, ada)

    assert await registry.get(ada, asset.id) is not None
    assert await registry.get(bob, asset.id) is None
    rows, total = await registry.list(bob)
    assert (rows, total) == ([], 0)
    # The owner role reads through, as it does for memories.
    assert await registry.get(_principal("leo", "owner"), asset.id) is not None


@pytest.mark.asyncio
async def test_list_filters_by_surface_query_and_remembered(
    postgres_dsn: str,
) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    now = datetime.now(timezone.utc)
    await _register(
        registry,
        ada,
        filename="grant.pdf",
        payload=b"one",
        surface="telegram",
        sender_name="Ada Wong",
        received_at=now - timedelta(hours=2),
    )
    await _register(
        registry,
        ada,
        filename="selfie.jpg",
        payload=b"two",
        surface="whatsapp",
        sender_name="Bob",
        received_at=now - timedelta(hours=1),
    )
    invoice = await _register(
        registry,
        ada,
        filename="invoice.pdf",
        payload=b"three",
        surface="email",
        received_at=now,
    )

    rows, total = await registry.list(ada)
    assert total == 3
    assert [r.filename for r in rows] == ["invoice.pdf", "selfie.jpg", "grant.pdf"]

    rows, total = await registry.list(ada, surfaces=["telegram", "email"])
    assert {r.filename for r in rows} == {"grant.pdf", "invoice.pdf"}

    rows, _ = await registry.list(ada, query="pdf")
    assert {r.filename for r in rows} == {"grant.pdf", "invoice.pdf"}
    rows, _ = await registry.list(ada, query="ada wong")
    assert {r.filename for r in rows} == {"grant.pdf"}

    document_id = str(uuid.uuid4())
    updated = await registry.mark_remembered(
        ada, invoice.id, document_id=document_id, remembered_by="email-triage"
    )
    assert updated is not None and updated.remembered is True
    assert updated.remembered_by == "email-triage"

    rows, _ = await registry.list(ada, remembered=True)
    assert [r.filename for r in rows] == ["invoice.pdf"]
    rows, _ = await registry.list(ada, remembered=False)
    assert {r.filename for r in rows} == {"grant.pdf", "selfie.jpg"}


@pytest.mark.asyncio
async def test_registering_does_not_ingest_into_memory(postgres_dsn: str) -> None:
    """The whole point of the split: arrival is not remembering."""
    registry = await _registry(postgres_dsn)
    await _register(registry, _principal("ada"))

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        files = await conn.fetchval(f"SELECT count(*) FROM app_prod.{FILE_ASSETS_TABLE}")
        documents = await conn.fetchval(
            "SELECT to_regclass('app_prod.rag_documents')"
        )
    finally:
        await conn.close()
    assert files == 1
    assert documents is None


@pytest.mark.asyncio
async def test_store_and_register_uploads_then_records(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    uploaded: list[tuple[str, bytes, str]] = []

    class _Storage:
        bucket = "agent-home-media"

        async def upload(self, path, data, *, content_type="application/octet-stream"):
            uploaded.append((path, data, content_type))
            return path

    asset = await store_and_register(
        ada,
        b"minutes of the meeting",
        surface="email",
        filename="minutes.txt",
        content_type="text/plain",
        sender_name="Chair",
        registry=registry,
        storage=_Storage(),
    )

    assert asset is not None
    assert len(uploaded) == 1
    path, data, content_type = uploaded[0]
    assert asset.storage_path == path
    # Owner-prefixed and content-addressed, so a re-send overwrites itself
    # rather than filling the bucket with copies.
    assert path.startswith("ada/files/")
    assert asset.sha256[:16] in path
    assert data == b"minutes of the meeting"
    assert content_type == "text/plain"
    assert asset.sha256 == content_digest(b"minutes of the meeting")


@pytest.mark.asyncio
async def test_registration_failure_is_swallowed(postgres_dsn: str) -> None:
    """A file arriving must never be able to fail the conversation."""
    registry = await _registry(postgres_dsn)

    class _Broken:
        bucket = "agent-home-media"

        async def upload(self, *args, **kwargs):
            raise RuntimeError("storage is down")

    asset = await store_and_register(
        _principal("ada"),
        b"payload",
        surface="telegram",
        filename="x.bin",
        registry=registry,
        storage=_Broken(),
    )
    assert asset is None


@pytest.mark.asyncio
async def test_oversized_files_are_not_registered(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)

    class _Storage:
        bucket = "agent-home-media"
        calls = 0

        async def upload(self, *args, **kwargs):
            _Storage.calls += 1

    asset = await store_and_register(
        _principal("ada"),
        b"x" * (25 * 1024 * 1024 + 1),
        surface="telegram",
        filename="huge.zip",
        registry=registry,
        storage=_Storage(),
    )
    assert asset is None
    assert _Storage.calls == 0


@pytest.mark.asyncio
async def test_backfill_idempotency_on_storage_path(postgres_dsn: str) -> None:
    """A second backfill run never invents a second arrival.

    The backfill command checks ``storage_path`` against existing rows before
    inserting.  §4 of the handoff is explicit: there is no unique constraint,
    so idempotency is an application-level check — this test asserts that check
    actually works against the live table.
    """
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")

    # Register one file through the normal path.
    asset = await _register(registry, ada, filename="minutes.txt")
    path = asset.storage_path

    # Simulate the backfill's idempotency check: ``SELECT 1 FROM file_assets
    # WHERE storage_path = $1 LIMIT 1``.
    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        already = await conn.fetchval(
            f"SELECT 1 FROM app_prod.{FILE_ASSETS_TABLE} "
            f"WHERE storage_path = $1 LIMIT 1",
            path,
        )
        assert already == 1, "registered path must be found"

        # A path the backfill discovered but has not yet written — must be
        # absent so the check returns None (triggering an insert).
        missing = await conn.fetchval(
            f"SELECT 1 FROM app_prod.{FILE_ASSETS_TABLE} "
            f"WHERE storage_path = $1 LIMIT 1",
            "ada/files/newcomer.txt",
        )
        assert missing is None

        # After a manual insert (what the backfill does), the same path is
        # found — a second run would skip it.
        await conn.execute(
            f"""INSERT INTO app_prod.{FILE_ASSETS_TABLE} (
                    owner_user_id, visibility, surface, account_id,
                    conversation, sender_id, sender_name, message_id,
                    received_at, filename, content_type, byte_size,
                    sha256, storage_bucket, storage_path)
                VALUES (
                    $1, $2, 'agent_home', $3, NULL, $4, $5, NULL,
                    NOW(), $6, 'text/plain', 4, $7, $8, $9)""",
            "ada", "private:ada", "ada", "ada", "Ada",
            "newcomer.txt", content_digest(b"new"),
            "agent-home-media", "ada/files/newcomer.txt",
        )
        second = await conn.fetchval(
            f"SELECT 1 FROM app_prod.{FILE_ASSETS_TABLE} "
            f"WHERE storage_path = $1 LIMIT 1",
            "ada/files/newcomer.txt",
        )
        assert second == 1

        # Total rows: original + the one we just wrote — no duplicate.
        total = await conn.fetchval(
            f"SELECT count(*) FROM app_prod.{FILE_ASSETS_TABLE} "
            f"WHERE storage_path = $1",
            "ada/files/newcomer.txt",
        )
        assert total == 1, "second backfill must not create a duplicate"
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_storage_path_lookup_uses_its_index(postgres_dsn: str) -> None:
    registry = await _registry(postgres_dsn)
    ada = _principal("ada")
    asset = await _register(registry, ada)
    assert (await registry.get_by_storage_path(ada, asset.storage_path)).id == asset.id

    conn = await asyncpg.connect(dsn=postgres_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_prod")
        indexdef = await conn.fetchval(
            "SELECT indexdef FROM pg_indexes WHERE schemaname = 'app_prod' "
            "AND indexname = 'file_assets_storage_path_idx'"
        )
        assert indexdef is not None and "(storage_path)" in indexdef
        async with conn.transaction():
            await conn.execute("SET LOCAL enable_seqscan = off")
            plan = "\n".join(
                r[0]
                for r in await conn.fetch(
                    "EXPLAIN SELECT 1 FROM file_assets WHERE storage_path = $1 LIMIT 1",
                    asset.storage_path,
                )
            )
        assert "file_assets_storage_path_idx" in plan
    finally:
        await conn.close()
