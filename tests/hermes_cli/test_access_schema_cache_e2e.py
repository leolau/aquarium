"""initialize_access runs its schema DDL once per process, not per connection.

Production ran the access DDL (``ALTER TABLE principals ADD COLUMN IF NOT
EXISTS ...``, ``CREATE UNIQUE INDEX IF NOT EXISTS principals_single_owner``)
and the ``schema_owner`` claim/read on every ``PrincipalStore`` call, ~650k
times each. These pin the cache down against a real Postgres, including the
cases that must still re-run the DDL: a dropped or recreated schema, a dropped
table, an explicit reset, and a different profile.
"""

from __future__ import annotations

import asyncio
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import asyncpg
import pytest

import hermes_cli.access as access
import hermes_cli.datastore as datastore
from hermes_cli.access import PrincipalStore, initialize_access, reset_access_cache
from hermes_cli.datastore import SchemaOwnershipError, SupabaseAppStore

SCHEMA = "app_cachetest"


async def _probe_postgres(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    daemon = subprocess.run(
        ["docker", "info"],
        check=False,
        capture_output=True,
        text=True,
    )
    if daemon.returncode != 0:
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")

    image = (
        "postgres@sha256:"
        "742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
    )
    subprocess.run(["docker", "pull", image], check=True, capture_output=True)
    container = f"hermes-access-cache-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        [
            "docker",
            "run",
            "--detach",
            "--rm",
            "--name",
            container,
            "--env",
            "POSTGRES_PASSWORD=hermes-test",
            "--env",
            "POSTGRES_DB=hermes_test",
            "--publish",
            "127.0.0.1::5432",
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


@pytest.fixture
def hermes_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "hermes-root"
    (root / "profiles").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    datastore.forget_verified_schema()
    reset_access_cache()
    return root


def _use_profile(root: Path, name: str, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = root / "profiles" / name
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


async def _drop(dsn: str, sql: str = f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE") -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        await connection.execute(sql)
    finally:
        await connection.close()


class _Counter:
    """Counts access DDL batches, schema claims and schema_owner reads."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.ddl = 0
        self.claims = 0
        self.owner_reads = 0
        real_ensure = datastore.ensure_app_schema
        real_verify_fetchrow = asyncpg.Connection.fetchrow
        real_execute = asyncpg.Connection.execute
        counter = self

        async def ensure(connection, *, schema=None):
            counter.claims += 1
            return await real_ensure(connection, schema=schema)

        async def execute(self, query, *args, timeout=None):
            if query == access.ACCESS_SCHEMA_SQL:
                counter.ddl += 1
            return await real_execute(self, query, *args, timeout=timeout)

        async def fetchrow(self, query, *args, timeout=None, record_class=None):
            if "FROM" in query and "schema_owner" in query:
                counter.owner_reads += 1
            return await real_verify_fetchrow(
                self, query, *args, timeout=timeout, record_class=record_class
            )

        monkeypatch.setattr(datastore, "ensure_app_schema", ensure)
        monkeypatch.setattr(asyncpg.Connection, "execute", execute)
        monkeypatch.setattr(asyncpg.Connection, "fetchrow", fetchrow)


@pytest.mark.asyncio
async def test_ddl_runs_once_across_many_connections(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "cache", monkeypatch)
    count = _Counter(monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    principals = PrincipalStore(store)

    await principals.enroll("root", display="Root", role="owner")
    for _ in range(25):
        owner = await principals.get_owner()
        assert owner is not None and owner.user_id == "root"

    assert count.ddl == 1
    assert count.claims == 1
    # The marker is read once by the very first connect (the schema did not
    # exist yet, so nothing was cached) and then once more after it was
    # claimed; every later connect is served from the verified cache.
    assert count.owner_reads <= 1


@pytest.mark.asyncio
async def test_dropped_schema_is_recreated(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "cache", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    principals = PrincipalStore(store)
    await principals.enroll("root", role="owner")

    await _drop(postgres_dsn)
    count = _Counter(monkeypatch)

    assert await principals.get_owner() is None
    await principals.enroll("root", role="owner")
    assert (await principals.get_owner()).user_id == "root"
    assert count.ddl == 1


@pytest.mark.asyncio
async def test_dropped_table_or_index_is_recreated(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "cache", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    principals = PrincipalStore(store)
    await principals.enroll("root", role="owner")

    await _drop(postgres_dsn, f"DROP TABLE {SCHEMA}.principal_aliases")
    await _drop(postgres_dsn, f"DROP INDEX {SCHEMA}.principals_single_owner")
    await principals.get_owner()

    connection = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        for name in ("principal_aliases", "principals_single_owner"):
            assert await connection.fetchval(
                "SELECT to_regclass($1)", f"{SCHEMA}.{name}"
            ) is not None
    finally:
        await connection.close()
    # The exactly-one-owner invariant is enforced again.
    with pytest.raises(asyncpg.UniqueViolationError):
        await principals.enroll("second", role="owner")


@pytest.mark.asyncio
async def test_reset_access_cache_reruns_ddl(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "cache", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    await PrincipalStore(store).get_owner()
    count = _Counter(monkeypatch)

    await PrincipalStore(store).get_owner()
    assert count.ddl == 0
    reset_access_cache()
    await PrincipalStore(store).get_owner()
    assert count.ddl == 1


@pytest.mark.asyncio
async def test_recreated_schema_claimed_by_another_profile_is_refused(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cached verification must not outlive a fresh claim by someone else."""
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "first", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    await PrincipalStore(store).get_owner()
    await PrincipalStore(store).get_owner()

    await _drop(postgres_dsn)
    _use_profile(hermes_root, "second", monkeypatch)
    await PrincipalStore(store).get_owner()

    _use_profile(hermes_root, "first", monkeypatch)
    with pytest.raises(SchemaOwnershipError):
        await store.connect()


@pytest.mark.asyncio
async def test_each_profile_still_claims_and_is_checked(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "first", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    await PrincipalStore(store).get_owner()

    _use_profile(hermes_root, "second", monkeypatch)
    with pytest.raises(SchemaOwnershipError):
        await PrincipalStore(store).get_owner()


@pytest.mark.asyncio
async def test_unidentifiable_connection_always_runs_ddl(
    postgres_dsn: str, hermes_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _drop(postgres_dsn)
    _use_profile(hermes_root, "cache", monkeypatch)
    store = SupabaseAppStore("prod", SCHEMA, postgres_dsn)
    count = _Counter(monkeypatch)
    monkeypatch.setattr(
        "hermes_cli.db_setup.connection_key", lambda connection: ("", "", "")
    )
    for _ in range(3):
        connection = await store.connect()
        try:
            await initialize_access(connection)
        finally:
            await connection.close()
    assert count.ddl == 3
