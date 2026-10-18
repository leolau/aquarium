"""Every database feature the agent uses works as the limited ``hermes_app`` login.

Real Postgres (pgvector image) in Docker, temp HERMES_HOME. The schema is set
up once by ``hermes db migrate`` as the owner (``postgres``); every feature
then runs through ``SupabaseAppStore`` logged in as ``hermes_app``, the way the
gateway and the agent's terminal commands will after the switch-over.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator

import asyncpg
import pytest

from hermes_cli import db_migrate, db_setup
from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.datastore import get_store

APP_PASSWORD = "app-login-test-pw"
IMAGE = "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"


async def _probe(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def owner_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    if subprocess.run(["docker", "info"], check=False, capture_output=True).returncode:
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")
    subprocess.run(["docker", "pull", IMAGE], check=True, capture_output=True)
    container = f"hermes-applogin-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        ["docker", "run", "--detach", "--rm", "--name", container,
         "--env", "POSTGRES_PASSWORD=hermes-test", "--env", "POSTGRES_DB=hermes_test",
         "--publish", "127.0.0.1::5432", IMAGE],
        check=True, capture_output=True, text=True,
    )
    try:
        port = subprocess.run(
            ["docker", "port", container, "5432/tcp"],
            check=True, capture_output=True, text=True,
        ).stdout.strip().rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(60):
            try:
                asyncio.run(_probe(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(["docker", "rm", "--force", container], check=False, capture_output=True)


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


def _app_dsn(owner: str) -> str:
    return owner.replace("postgres:hermes-test@", f"hermes_app:{APP_PASSWORD}@")


async def _owner_exec(owner: str, sql: str, *args: object) -> None:
    conn = await asyncpg.connect(owner, ssl=False)
    try:
        await conn.execute(sql, *args)
    finally:
        await conn.close()


@pytest.fixture
def app_store(owner_dsn: str):
    """Fresh schemas, migrated as the owner; the store logs in as hermes_app."""
    asyncio.run(_owner_exec(
        owner_dsn, "DROP SCHEMA IF EXISTS app_dev CASCADE; DROP SCHEMA IF EXISTS app_prod CASCADE;"
    ))
    db_setup._setup_allowed.clear()
    rows = db_migrate.migrate(owner_dsn, config=_config("${DATABASE_URL}"), app_password=APP_PASSWORD)
    assert [r for r in rows if r[2]] == []
    db_setup._setup_allowed.clear()
    return get_store("supabase-app", "prod", config=_config(_app_dsn(owner_dsn)))


async def _people(store) -> tuple[Principal, Principal, Principal]:
    principals = PrincipalStore(store)
    owner = await principals.enroll("leo", display="Leo", role="owner")
    alice = await principals.enroll("alice", display="Alice")
    bob = await principals.enroll("bob", display="Bob")
    return owner, alice, bob


def test_hermes_app_is_a_limited_login(owner_dsn: str, app_store) -> None:
    async def run() -> None:
        conn = await asyncpg.connect(_app_dsn(owner_dsn), ssl=False)
        try:
            flags = await conn.fetchrow(
                "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb "
                "FROM pg_roles WHERE rolname = current_user"
            )
            assert dict(flags) == {
                "rolcanlogin": True, "rolsuper": False, "rolbypassrls": False,
                "rolcreaterole": False, "rolcreatedb": False,
            }
            # Cannot switch the row rules off or change tables.
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute("ALTER TABLE app_prod.memories DISABLE ROW LEVEL SECURITY")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute("DROP TABLE app_prod.file_assets")
            # Cannot read a schema it was not granted (stand-in for Supabase auth).
            await _owner_exec(owner_dsn, "CREATE SCHEMA IF NOT EXISTS auth_test;"
                              "CREATE TABLE IF NOT EXISTS auth_test.users (pw text)")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.fetch("SELECT * FROM auth_test.users")
            # Bound to a member it sees only what the read rules allow.
            await _owner_exec(
                owner_dsn,
                "INSERT INTO app_prod.file_assets (owner_user_id, visibility, surface, filename,"
                " content_type, byte_size, sha256, storage_bucket, storage_path) VALUES"
                " ('alice', 'private:alice', 'agent_home', 'a.txt', 'text/plain', 1, 'x', 'b', 'p')",
            )
            async with conn.transaction():
                await conn.execute("SELECT set_config('hermes.principal_id', 'bob', true),"
                                   " set_config('hermes.principal_role', 'member', true)")
                assert await conn.fetchval("SELECT count(*) FROM app_prod.file_assets") == 0
            # Unbound (background jobs) it reads like postgres does today.
            assert await conn.fetchval("SELECT count(*) FROM app_prod.file_assets") == 1
        finally:
            await conn.close()

    asyncio.run(run())


def test_promote_config_as_hermes_app(owner_dsn: str, app_store) -> None:
    from hermes_cli.promote import promote_artifact

    asyncio.run(_owner_exec(
        owner_dsn,
        "INSERT INTO app_dev.artifact_definitions (kind, ref, definition) "
        "VALUES ('config', 'notifications', $1::jsonb)",
        json.dumps({"enabled": True}),
    ))

    async def run():
        result = await promote_artifact(
            app_store, "config", "notifications", actor="leo",
            approval_callback=lambda *_a, **_k: "once",
        )
        conn = await app_store.connect()
        try:
            row = await conn.fetchval(
                "SELECT definition FROM artifact_definitions WHERE kind='config' AND ref='notifications'"
            )
        finally:
            await conn.close()
        return result, row

    result, row = asyncio.run(run())
    assert result is not None
    assert json.loads(row) == {"enabled": True}


def test_schema_promotion_needs_the_owner(owner_dsn: str, app_store) -> None:
    """A promoted SQL migration must fail loudly as hermes_app, not be skipped."""
    from hermes_cli.promote import promote_artifact

    asyncio.run(_owner_exec(
        owner_dsn,
        "INSERT INTO app_dev.artifact_definitions (kind, ref, definition) "
        "VALUES ('schema', 'add-widgets', $1::jsonb)",
        json.dumps({"sql": "CREATE TABLE widgets (id int)"}),
    ))
    with pytest.raises(PermissionError, match="schema owner"):
        asyncio.run(promote_artifact(
            app_store, "schema", "add-widgets", actor="leo",
            approval_callback=lambda *_a, **_k: "once",
        ))


def test_transfer_ownership_as_hermes_app(app_store) -> None:
    async def run() -> str:
        await _people(app_store)
        principals = PrincipalStore(app_store)
        await principals.transfer_owner("alice", actor="leo", approved=True)
        return (await principals.get_owner()).user_id

    assert asyncio.run(run()) == "alice"


def test_create_in_house_tool_as_hermes_app(app_store) -> None:
    from hermes_cli.tools_registry import ToolRegistry

    async def run():
        owner, alice, bob = await _people(app_store)
        registry = ToolRegistry(app_store)
        tool = await registry.create(alice, "pdf-merge", "in_house")
        return tool

    tool = asyncio.run(run())
    assert tool.name == "pdf-merge"


def test_office_doc_register_is_private_per_user(app_store) -> None:
    from hermes_cli.file_registry import FileRegistry

    async def run():
        owner, alice, bob = await _people(app_store)
        registry = FileRegistry(app_store)
        asset = await registry.register(
            alice, surface="agent_home", filename="budget.xlsx",
            content_type="application/vnd.ms-excel", byte_size=4, sha256="ab" * 32,
            storage_bucket="files", storage_path="alice/budget.xlsx",
        )
        mine = [a.id for a in (await registry.list(alice))[0]]
        theirs = [a.id for a in (await registry.list(bob))[0]]
        owners = [a.id for a in (await registry.list(owner))[0]]
        bob_get = await registry.get(bob, asset.id)
        return asset.id, mine, theirs, owners, bob_get

    asset_id, mine, theirs, owners, bob_get = asyncio.run(run())
    assert asset_id in mine and asset_id in owners
    assert asset_id not in theirs and bob_get is None


def test_memory_is_private_per_user(app_store) -> None:
    from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

    async def run():
        owner, alice, bob = await _people(app_store)
        memory = PgvectorMemoryStore(app_store)
        await memory.initialize()
        await memory.write(alice, "Alice's bank PIN is 4321")
        await memory.write(bob, "Bob likes green tea", visibility="shared")
        alice_sees = [m.text for m in await memory.query(alice, "bank PIN")]
        bob_sees = [m.text for m in await memory.query(bob, "bank PIN")]
        return alice_sees, bob_sees

    alice_sees, bob_sees = asyncio.run(run())
    assert "Alice's bank PIN is 4321" in alice_sees
    assert "Alice's bank PIN is 4321" not in bob_sees


def test_memory_projection_cron_sees_every_user(app_store) -> None:
    """`hermes memory projection fit` (timer) relied on postgres bypassing the rules."""
    from hermes_cli.memory_projection import fit_projection
    from plugins.memory.supabase_pgvector.store import PROJECTION_TABLE, PgvectorMemoryStore

    async def run() -> int:
        owner, alice, bob = await _people(app_store)
        memory = PgvectorMemoryStore(app_store)
        await memory.initialize()
        for who, text in ((alice, "a1"), (alice, "a2"), (bob, "b1"), (bob, "b2")):
            await memory.write(who, f"note {text} about tea")
        await fit_projection(memory, sample_size=100)
        conn = await app_store.connect()
        try:
            async with conn.transaction():
                from hermes_cli.access import bind_principal

                await bind_principal(conn, owner)
                return await conn.fetchval(f"SELECT count(*) FROM {PROJECTION_TABLE}")
        finally:
            await conn.close()

    assert asyncio.run(run()) == 4


def test_migrate_input_carries_the_app_password() -> None:
    text = "HERMES_DB_ADMIN_URL=postgresql://o@h/d\nHERMES_APP_DB_PASSWORD='s3cret'\n"
    assert db_migrate.parse_dsn(text) == "postgresql://o@h/d"
    assert db_migrate.parse_env(text)[db_migrate.APP_PASSWORD_KEY] == "s3cret"
