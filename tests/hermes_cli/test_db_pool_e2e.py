"""E2E: the process-wide Postgres pool and the principal lookup cache.

Runs against a throwaway local Postgres cluster (``initdb`` on a free port in
a temp dir) — no Docker. Skipped when the Postgres server binaries are absent.
"""

from __future__ import annotations

import asyncio
import glob
import os
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Iterator

import pytest

asyncpg = pytest.importorskip("asyncpg")

from hermes_cli import access, db_pool  # noqa: E402
from hermes_cli.access import PrincipalStore  # noqa: E402
from hermes_cli.datastore import (  # noqa: E402
    SupabaseAppStore,
    ensure_app_schema,
    get_store,
    initialize_supabase_app,
)

POOL_SIZE = 3


def _pg_bin(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    candidates = sorted(glob.glob(f"/usr/lib/postgresql/*/bin/{name}"))
    return candidates[-1] if candidates else None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="module")
def postgres_dsn(tmp_path_factory) -> Iterator[str]:
    initdb, pg_ctl = _pg_bin("initdb"), _pg_bin("pg_ctl")
    if not initdb or not pg_ctl:
        pytest.skip("Postgres server binaries (initdb/pg_ctl) are not installed")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("initdb refuses to run as root")
    root = tmp_path_factory.mktemp("pg")
    data = root / "data"
    subprocess.run(
        [initdb, "-D", str(data), "-U", "postgres", "--auth=trust", "-E", "UTF8"],
        check=True,
        capture_output=True,
    )
    port = _free_port()
    subprocess.run(
        [
            pg_ctl, "-D", str(data), "-l", str(root / "log"), "-w", "start",
            "-o", f"-p {port} -k {root} -c listen_addresses=127.0.0.1",
        ],
        check=True,
        capture_output=True,
    )
    try:
        yield f"postgresql://postgres@127.0.0.1:{port}/postgres"
    finally:
        subprocess.run(
            [pg_ctl, "-D", str(data), "-m", "immediate", "stop"],
            check=False,
            capture_output=True,
        )


async def _reset_schema(dsn: str) -> None:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await conn.execute("DROP SCHEMA IF EXISTS app_prod_alt CASCADE")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


async def _backends(dsn: str) -> int:
    """Client backends on the test database, excluding this probe."""
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        return await conn.fetchval(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"
        )
    finally:
        await conn.close()


@pytest.fixture
def pooled(postgres_dsn: str, monkeypatch):
    asyncio.run(_reset_schema(postgres_dsn))
    access.reset_access_cache()
    db_pool.enable(db_pool.PoolSettings(max_size=POOL_SIZE, acquire_timeout=10.0))
    try:
        yield postgres_dsn
    finally:
        db_pool.disable()
        access.reset_access_cache()


def test_pool_size_is_read_from_config_yaml() -> None:
    settings = db_pool.settings_from_config(
        {"datastore": {"supabase_app": {"pool_size": 7, "pool_acquire_timeout": 2}}}
    )
    assert settings == db_pool.PoolSettings(max_size=7, acquire_timeout=2.0)
    assert db_pool.settings_from_config({}) == db_pool.PoolSettings()
    assert not db_pool.enable(db_pool.PoolSettings(max_size=0))


def test_parallel_lookups_stay_within_the_pool_bound(pooled: str, monkeypatch) -> None:
    """N parallel principal reads — from the server loop *and* from worker
    threads running their own ``asyncio.run`` — never open more than
    ``pool_size`` connections and never fail."""
    monkeypatch.setattr(access, "PRINCIPAL_CACHE_TTL", 0.0)  # every call hits Postgres
    store = get_store("supabase-app", "prod", config=_config(pooled))
    principals = PrincipalStore(store)

    async def _seed() -> None:
        await principals.enroll("leo", display="Leo", role="owner")
        for i in range(5):
            await principals.enroll(f"user{i}", display=f"User {i}")

    asyncio.run(_seed())

    peak = 0
    stop = threading.Event()

    def _sample() -> None:
        nonlocal peak
        while not stop.is_set():
            peak = max(peak, asyncio.run(_backends(pooled)))
            time.sleep(0.01)

    sampler = threading.Thread(target=_sample)
    sampler.start()
    errors: list[BaseException] = []

    async def _burst() -> None:
        results = await asyncio.gather(
            *(principals.get(f"user{i % 5}") for i in range(60)),
            return_exceptions=True,
        )
        errors.extend(r for r in results if isinstance(r, BaseException))
        assert all(r is not None for r in results)

    def _thread_burst() -> None:
        try:
            asyncio.run(_burst())
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=_thread_burst) for _ in range(4)]
    try:
        for t in threads:
            t.start()
        asyncio.run(_burst())
        for t in threads:
            t.join()
    finally:
        stop.set()
        sampler.join()

    assert errors == []
    assert 0 < peak <= POOL_SIZE
    (stats,) = db_pool.stats().values()
    assert stats["size"] <= POOL_SIZE and stats["idle"] == stats["size"]


def test_connections_return_to_the_pool_on_error_paths(pooled: str) -> None:
    store = get_store("supabase-app", "prod", config=_config(pooled))

    async def _fail_inside_transaction() -> None:
        conn = await store.connect()
        try:
            async with conn.transaction():
                await conn.execute("SET LOCAL application_name = 'leaky'")
                await conn.execute("SELECT * FROM no_such_table")
        finally:
            await conn.close()

    async def _run() -> None:
        for _ in range(POOL_SIZE * 3):
            with pytest.raises(asyncpg.UndefinedTableError):
                await _fail_inside_transaction()
        # Session state set on one checkout never reaches the next.
        conn = await store.connect()
        try:
            await conn.execute("SET application_name = 'mine'")
        finally:
            await conn.close()
        for _ in range(POOL_SIZE + 1):
            conn = await store.connect()
            try:
                assert not conn.is_in_transaction()
                assert await conn.fetchval("SHOW application_name") != "mine"
            finally:
                await conn.close()

    asyncio.run(_run())
    (stats,) = db_pool.stats().values()
    assert stats["idle"] == stats["size"] <= POOL_SIZE


def test_a_pooled_connection_is_pinned_to_its_own_profile_schema(pooled: str) -> None:
    prod = get_store("supabase-app", "prod", config=_config(pooled))
    alt = SupabaseAppStore(mode="prod", schema="app_prod_alt", dsn=pooled)

    async def _run() -> None:
        conn = await prod.connect()
        try:
            await ensure_app_schema(conn, schema="app_prod_alt")
        finally:
            await conn.close()
        for _ in range(POOL_SIZE * 2):
            for store in (prod, alt):
                conn = await store.connect()
                try:
                    assert await conn.fetchval("SELECT current_schema()") == store.schema
                finally:
                    await conn.close()

    asyncio.run(_run())


def test_access_ddl_runs_once_per_process_not_per_call(pooled: str) -> None:
    store = get_store("supabase-app", "prod", config=_config(pooled))
    principals = PrincipalStore(store)
    executed: list[str] = []
    real_execute = db_pool.PooledConnection.execute

    async def _spy(self, query, *args, **kwargs):
        executed.append(query)
        return await real_execute(self, query, *args, **kwargs)

    async def _run() -> None:
        await principals.enroll("leo", display="Leo", role="owner")
        db_pool.PooledConnection.execute = _spy
        try:
            access.invalidate_principal_cache()
            for _ in range(5):
                await principals.get("leo")
                access.invalidate_principal_cache()
        finally:
            db_pool.PooledConnection.execute = real_execute

    asyncio.run(_run())
    ddl = [q for q in executed if "ALTER TABLE" in q or "CREATE TABLE" in q]
    assert ddl == []


# ---------------------------------------------------------------------------
# Principal cache: authorization / isolation
# ---------------------------------------------------------------------------


def _count_connects(monkeypatch) -> list[int]:
    calls = [0]
    real = SupabaseAppStore.connect

    async def _counting(self):
        calls[0] += 1
        return await real(self)

    monkeypatch.setattr(SupabaseAppStore, "connect", _counting)
    return calls


def test_cached_lookups_never_cross_principals_or_profiles(pooled: str, monkeypatch) -> None:
    prod = get_store("supabase-app", "prod", config=_config(pooled))
    alt = SupabaseAppStore(mode="prod", schema="app_prod_alt", dsn=pooled)
    main, other = PrincipalStore(prod), PrincipalStore(alt)

    async def _run() -> None:
        conn = await prod.connect()
        try:
            await ensure_app_schema(conn, schema="app_prod_alt")
        finally:
            await conn.close()
        await main.enroll("leo", display="Leo", role="owner")
        await main.enroll("ada", display="Ada", role="member")
        await main.enroll("bob", display="Bob", role="viewer")
        await other.enroll("ada", display="Ada elsewhere", role="admin")
        calls = _count_connects(monkeypatch)

        ada = await main.get("ada")
        bob = await main.get("bob")
        assert (ada.user_id, ada.role) == ("ada", "member")
        assert (bob.user_id, bob.role) == ("bob", "viewer")
        # Same subject, another profile: its own row, never the cached one.
        assert (await other.get("ada")).role == "admin"
        assert await other.get("bob") is None
        assert (await main.get_owner()).user_id == "leo"
        assert (await other.get_owner()) is None
        before = calls[0]
        assert (await main.get("ada")).role == "member"
        assert (await main.get("bob")).role == "viewer"
        assert (await other.get("ada")).role == "admin"
        assert calls[0] == before, "repeat lookups are served from the cache"

    asyncio.run(_run())
    # Keys are hashes: no subject, schema-independent secret or DSN in clear.
    flat = " ".join(" ".join(key) for key in access._principal_cache)
    for raw in ("ada", "bob", "leo", pooled):
        assert raw not in flat.replace("app_prod", "")


def test_role_and_membership_changes_invalidate_the_cache(pooled: str) -> None:
    store = get_store("supabase-app", "prod", config=_config(pooled))
    principals = PrincipalStore(store)

    async def _run() -> None:
        await principals.enroll("leo", display="Leo", role="owner")
        await principals.enroll("ada", display="Ada", role="admin")
        assert (await principals.get("ada")).role == "admin"
        await principals.set_role("ada", "viewer")
        assert (await principals.get("ada")).role == "viewer"
        await principals.set_active("ada", False)
        assert (await principals.get("ada")).active is False
        await principals.unenroll("ada")
        assert await principals.get("ada") is None
        assert await principals.resolve_alias("ada-login") is None
        await principals.link_alias("ada-login", "leo")
        assert await principals.resolve_alias("ada-login") == "leo"

    asyncio.run(_run())


def test_a_change_from_another_process_shows_within_the_ttl(pooled: str, monkeypatch) -> None:
    monkeypatch.setattr(access, "PRINCIPAL_CACHE_TTL", 0.2)
    store = get_store("supabase-app", "prod", config=_config(pooled))
    principals = PrincipalStore(store)

    async def _run() -> None:
        await principals.enroll("leo", display="Leo", role="owner")
        await principals.enroll("ada", display="Ada", role="admin")
        assert (await principals.get("ada")).role == "admin"
        # A direct write (the CLI in another process) bypasses invalidation.
        conn = await asyncpg.connect(pooled, ssl=False)
        try:
            await conn.execute(
                "UPDATE app_prod.principals SET role = 'viewer' WHERE user_id = 'ada'"
            )
        finally:
            await conn.close()
        await asyncio.sleep(0.25)
        assert (await principals.get("ada")).role == "viewer"

    asyncio.run(_run())
