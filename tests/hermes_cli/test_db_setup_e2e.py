"""Table setup as the schema owner only (`hermes db migrate`, hermes_cli/db_setup.py).

Real Postgres in Docker: the owner login keeps setting tables up on first use
as before; a least-privilege login (``hermes_app``) skips that setup instead of
failing on it, once ``hermes db migrate`` has run as the owner.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import asyncpg
import pytest

from hermes_cli import db_migrate, db_setup
from hermes_cli.access import PrincipalStore
from hermes_cli.datastore import get_store

REPO = Path(__file__).resolve().parents[2]
APP_PASSWORD = "app-test-pw"


@pytest.mark.parametrize(
    "query, setup",
    [
        ("CREATE TABLE IF NOT EXISTS t (id int)", True),
        ("\n  -- comment\n  ALTER TABLE t ADD COLUMN IF NOT EXISTS x int", True),
        ("DO $$ BEGIN END $$;", True),
        ("drop policy if exists p on t", True),
        ("GRANT SELECT ON t TO r", True),
        ("CREATE TEMP TABLE scratch (id int)", False),
        ("INSERT INTO t VALUES (1)", False),
        ("SELECT set_config('x', 'y', true)", False),
        ("SET LOCAL ROLE hermes_app", False),
        ("UPDATE t SET created = now()", False),
    ],
)
def test_is_setup_sql(query: str, setup: bool) -> None:
    assert db_setup.is_setup_sql(query) is setup


@pytest.mark.parametrize(
    "text, expected",
    [
        ("HERMES_DB_ADMIN_URL=postgresql://a@h/db\n", "postgresql://a@h/db"),
        ("# owner\nexport HERMES_DB_ADMIN_URL='postgresql://a@h/db'\n", "postgresql://a@h/db"),
        ("DATABASE_URL=postgresql://b@h/db\n", "postgresql://b@h/db"),
        ("postgresql://c@h/db\n", "postgresql://c@h/db"),
        ("OTHER=1\n", ""),
    ],
)
def test_parse_dsn(text: str, expected: str) -> None:
    assert db_migrate.parse_dsn(text) == expected


def test_admin_address_never_reaches_the_agent_shell() -> None:
    from tools.environments.local import _sanitize_subprocess_env

    env = _sanitize_subprocess_env({"HERMES_DB_ADMIN_URL": "postgresql://x", "PATH": "/bin"})
    assert "HERMES_DB_ADMIN_URL" not in env


def test_deploy_migrates_as_owner_before_restarting() -> None:
    script = (REPO / "deploy/hermes-deploy.sh").read_text()
    migrate = script.index("hermes_cli.db_migrate --dsn-stdin")
    assert migrate < script.index('echo "== restarting services =="')
    assert '"${migrate[@]}" < "$DB_ADMIN_ENV"' in script
    assert "DB_ADMIN_ENV=${DB_ADMIN_ENV:-/etc/aquarium/db-admin.env}" in script


def test_deploy_falls_back_to_the_gateway_database_url(tmp_path: Path) -> None:
    """Without db-admin.env the deploy reads the gateway's DATABASE_URL (last file wins)."""
    script = (REPO / "deploy/hermes-deploy.sh").read_text()
    start = script.index("gateway_db_env() {")
    func = script[start:script.index("\n}\n", start) + 3]
    first, second, empty = tmp_path / "a.env", tmp_path / "b.env", tmp_path / "c.env"
    first.write_text("DATABASE_URL=postgresql://first\n")
    second.write_text("X=1\nDATABASE_URL=postgresql://second\n")
    empty.write_text("Y=2\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "systemctl").write_text(
        f"#!/bin/sh\necho '{first} (ignore_errors=no)'\n"
        f"echo '{second} (ignore_errors=yes)'\necho '{empty} (ignore_errors=no)'\n"
    )
    (bin_dir / "systemctl").chmod(0o755)
    out = subprocess.run(
        ["bash", "-c", f"set -euo pipefail\n{func}\ngateway_db_env"],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin"},
        capture_output=True, text=True, check=True,
    ).stdout
    assert out.strip() == "DATABASE_URL=postgresql://second"


def test_installer_keeps_the_owner_address_root_only() -> None:
    script = (REPO / "install-aquarium.sh").read_text()
    assert "> /etc/aquarium/db-admin.env" in script
    assert "chmod 600 /etc/aquarium/db-admin.env" in script
    assert "hermes_cli.db_migrate --dsn-stdin < /etc/aquarium/db-admin.env" in script
    assert "from hermes_cli.access import ensure_app_role, initialize_access" not in script


# --------------------------------------------------------------------------- real Postgres


async def _probe(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the Postgres E2E test")
    if subprocess.run(["docker", "info"], check=False, capture_output=True).returncode:
        pytest.skip("Docker daemon is unavailable for the Postgres E2E test")
    # pgvector/pgvector:pg16 — Postgres 16 with the `vector` extension (memory tables need it).
    image = "pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
    subprocess.run(["docker", "pull", image], check=True, capture_output=True)
    container = f"hermes-dbsetup-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        ["docker", "run", "--detach", "--rm", "--name", container,
         "--env", "POSTGRES_PASSWORD=hermes-test", "--env", "POSTGRES_DB=hermes_test",
         "--publish", "127.0.0.1::5432", image],
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


def _app_dsn(owner_dsn: str) -> str:
    return owner_dsn.replace("postgres:hermes-test@", f"hermes_app:{APP_PASSWORD}@")


async def _drop_schemas(owner_dsn: str) -> None:
    conn = await asyncpg.connect(owner_dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_dev CASCADE; DROP SCHEMA IF EXISTS app_prod CASCADE;")
    finally:
        await conn.close()


async def _app_login(owner_dsn: str) -> None:
    """Stand-in for PR 2: let the migrate-created hermes_app role log in."""
    conn = await asyncpg.connect(owner_dsn, ssl=False)
    try:
        await conn.execute(f"ALTER ROLE hermes_app LOGIN PASSWORD '{APP_PASSWORD}'")
    finally:
        await conn.close()


async def _table_exists(owner_dsn: str, name: str) -> bool:
    conn = await asyncpg.connect(owner_dsn, ssl=False)
    try:
        return await conn.fetchval("SELECT to_regclass($1)", name) is not None
    finally:
        await conn.close()


def _migrate(owner_dsn: str) -> None:
    db_setup._setup_allowed.clear()
    rows = db_migrate.migrate(owner_dsn, config=_config("${DATABASE_URL}"))
    assert [r for r in rows if r[2]] == []
    assert {mode for mode, _, _ in rows} == {"prod", "dev"}


def test_owner_login_still_sets_tables_up_on_first_use(postgres_dsn: str) -> None:
    from hermes_cli.tools_registry import ToolRegistry

    asyncio.run(_drop_schemas(postgres_dsn))
    db_setup._setup_allowed.clear()
    store = get_store("supabase-app", "prod", config=_config(postgres_dsn))
    asyncio.run(ToolRegistry(store).initialize())
    assert asyncio.run(_table_exists(postgres_dsn, "app_prod.tools"))


def test_least_privilege_login_skips_setup_after_migrate(postgres_dsn: str) -> None:
    """Every first-use setup path works as hermes_app instead of 'must be owner'."""
    from hermes_cli.file_registry import FileRegistry
    from hermes_cli.tools_registry import ToolRegistry
    from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

    asyncio.run(_drop_schemas(postgres_dsn))
    _migrate(postgres_dsn)
    asyncio.run(_app_login(postgres_dsn))
    db_setup._setup_allowed.clear()
    store = get_store("supabase-app", "prod", config=_config(_app_dsn(postgres_dsn)))

    async def run() -> str:
        connection = await store.connect()
        try:
            assert await connection.fetchval("SELECT current_user") == "hermes_app"
            assert connection._hermes_skip_setup is True
            # Without the skip this is "permission denied for schema app_prod".
            assert await connection.execute("CREATE TABLE IF NOT EXISTS tools (id int)") == "SKIPPED"
        finally:
            await connection.close()
        await ToolRegistry(store).initialize()
        await FileRegistry(store).initialize()
        await PgvectorMemoryStore(store).initialize()
        principals = PrincipalStore(store)
        await principals.enroll("owner-1", role="owner")
        owner = await principals.get_owner()
        return owner.user_id

    assert asyncio.run(run()) == "owner-1"


def test_migrate_refuses_a_login_that_does_not_own_the_schema(postgres_dsn: str) -> None:
    asyncio.run(_drop_schemas(postgres_dsn))
    _migrate(postgres_dsn)
    asyncio.run(_app_login(postgres_dsn))
    db_setup._setup_allowed.clear()
    rows = db_migrate.migrate(_app_dsn(postgres_dsn), config=_config("${DATABASE_URL}"))
    assert [(mode, name) for mode, name, error in rows if error] == [
        ("prod", "schema owner"), ("dev", "schema owner"),
    ]


def test_least_privilege_login_without_migrate_names_the_fix(postgres_dsn: str) -> None:
    asyncio.run(_drop_schemas(postgres_dsn))
    _migrate(postgres_dsn)
    asyncio.run(_app_login(postgres_dsn))
    asyncio.run(_drop_schemas(postgres_dsn))
    db_setup._setup_allowed.clear()
    store = get_store("supabase-app", "prod", config=_config(_app_dsn(postgres_dsn)))
    with pytest.raises(RuntimeError, match="hermes db migrate"):
        asyncio.run(store.connect())


def test_cli_reads_the_owner_address_from_stdin_and_never_prints_it(
    postgres_dsn: str, tmp_path: Path
) -> None:
    asyncio.run(_drop_schemas(postgres_dsn))
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(
        'datastore:\n  supabase_app:\n    dsn: "${DATABASE_URL}"\n'
    )
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    env["HERMES_HOME"] = str(home)
    proc = subprocess.run(
        [sys.executable, "-I", "-m", "hermes_cli.db_migrate", "--dsn-stdin"],
        input=f"# owner\nHERMES_DB_ADMIN_URL={postgres_dsn}\n",
        env=env, cwd=REPO, capture_output=True, text=True, timeout=300,
    )
    assert proc.returncode == 0, proc.stderr
    assert "Database tables are up to date." in proc.stdout
    assert "hermes-test" not in proc.stdout + proc.stderr
    assert asyncio.run(_table_exists(postgres_dsn, "app_prod.file_assets"))


def test_cli_without_a_datastore_does_nothing(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text("model: x\n")
    env = {k: v for k, v in os.environ.items() if k != "DATABASE_URL"}
    env["HERMES_HOME"] = str(home)
    proc = subprocess.run(
        [sys.executable, "-I", "-m", "hermes_cli.db_migrate"],
        env=env, cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "nothing to migrate" in proc.stdout
