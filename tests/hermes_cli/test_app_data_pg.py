"""app_data against a real Postgres: private copies, the sandbox login, caps.

Needs a disposable server: ``HERMES_TEST_SITE_PG_DSN=postgresql://postgres:pw@host:port/db``
(a superuser). Skipped otherwise.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass

import pytest

import hermes_cli.app_data as ad
import hermes_cli.site_sources as ss
from hermes_cli.access import Principal

DSN = os.environ.get("HERMES_TEST_SITE_PG_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="HERMES_TEST_SITE_PG_DSN not set")

ALICE = Principal(user_id="alice", display="Alice", role="member")
OWNER = Principal(user_id="leo", display="Leo", role="owner")


def run(coro):
    return asyncio.run(coro)


@dataclass
class Store:
    schema: str
    dsn: str = DSN
    mode: str = "prod"

    async def connect(self):
        import asyncpg

        return await asyncpg.connect(self.dsn, server_settings={"search_path": self.schema})


@pytest.fixture
def store(tmp_path, monkeypatch):
    import asyncpg

    from hermes_cli.goal_registry import GoalRegistryStore
    from hermes_cli.todo_store import TodoStore

    monkeypatch.setattr(ss, "_role_secrets_path", lambda: tmp_path / "roles.json")
    s = Store(schema=f"app_{uuid.uuid4().hex[:10]}")

    async def setup():
        await TodoStore(s).initialize()
        await GoalRegistryStore(s).initialize()
        conn = await asyncpg.connect(DSN)
        try:
            await ad.ensure_sandbox_role(conn)
            for owner, vis, title in (
                ("alice", "private:alice", "alice todo"),
                ("bob", "private:bob", "bob secret"),
                ("bob", "shared", "team todo"),
            ):
                await conn.execute(
                    f'INSERT INTO "{s.schema}".tasks (owner_user_id, visibility, title, '
                    "trigger_state, completion_state, current_state) VALUES ($1, $2, $3, 'a', 'b', 'c')",
                    owner, vis, title,
                )
        finally:
            await conn.close()

    run(setup())
    yield s

    async def drop():
        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute(f'DROP SCHEMA "{s.schema}" CASCADE')
        finally:
            await conn.close()

    run(drop())


def titles(out):
    return sorted(r[0] for r in out["rows"])


def test_member_sees_only_own_and_shared_rows(store):
    out = run(ad.query(ALICE, ["todos"], "SELECT title FROM todos", store=store))
    assert titles(out) == ["alice todo", "team todo"]
    assert titles(run(ad.query(OWNER, ["todos"], "SELECT title FROM todos", store=store))) == [
        "alice todo", "bob secret", "team todo"]


def test_set_config_cannot_widen_the_copy(store):
    sql = (
        "SELECT title FROM (SELECT set_config('hermes.principal_role','owner',true), "
        "set_config('hermes.principal_id','bob',true)) s, todos"
    )
    assert titles(run(ad.query(ALICE, ["todos"], sql, store=store))) == ["alice todo", "team todo"]


def test_real_tables_are_unreachable(store):
    for bad in (
        f'SELECT title FROM "{store.schema}".tasks',
        f'SELECT * FROM "{store.schema}".principals',
        "SELECT * FROM public.site_sources",
    ):
        with pytest.raises(ss.SiteError):
            run(ad.query(ALICE, ["todos"], bad, store=store))


def test_refusals(store):
    with pytest.raises(ss.SiteError, match="signed-in"):
        run(ad.query(None, ["todos"], "SELECT 1", store=store))
    with pytest.raises(ss.SiteError, match="unknown area"):
        run(ad.query(ALICE, ["credentials"], "SELECT 1", store=store))
    with pytest.raises(ss.SiteError, match="areas= is required"):
        run(ad.query(ALICE, [], "SELECT 1", store=store))
    with pytest.raises(ss.SiteError, match="only SELECT"):
        run(ad.query(ALICE, ["todos"], "DELETE FROM todos", store=store))


def test_row_and_area_caps(store, monkeypatch):
    out = run(ad.query(ALICE, ["todos"], "SELECT g FROM generate_series(1, 20) g", max_rows=5, store=store))
    assert out["row_count"] == 5 and out["truncated"] is True
    monkeypatch.setattr(ad, "AREA_ROW_CAP", 1)
    with pytest.raises(ss.SiteError, match="more than 1"):
        run(ad.query(ALICE, ["todos"], "SELECT 1", store=store))


def test_statement_timeout(store, monkeypatch):
    monkeypatch.setattr(ss, "QUERY_TIMEOUT_MS", 200)
    with pytest.raises(ss.SiteError, match="query failed"):
        run(ad.query(ALICE, ["todos"], "SELECT pg_sleep(2)", store=store))


def test_sandbox_with_a_table_grant_is_refused(store):
    import asyncpg

    async def go():
        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute(f'GRANT USAGE ON SCHEMA "{store.schema}" TO {ad.SANDBOX_ROLE}')
            await conn.execute(f'GRANT SELECT ON "{store.schema}".tasks TO {ad.SANDBOX_ROLE}')
            with pytest.raises(ss.SiteError, match="can reach"):
                await ad.query(ALICE, ["todos"], "SELECT 1", store=store)
        finally:
            await conn.execute(f'REVOKE ALL ON "{store.schema}".tasks FROM {ad.SANDBOX_ROLE}')
            await conn.execute(f'REVOKE ALL ON SCHEMA "{store.schema}" FROM {ad.SANDBOX_ROLE}')
            await conn.close()

    run(go())


def test_describe_counts_visible_rows(store):
    areas = {a["area"]: a for a in run(ad.describe(ALICE, store=store))}
    assert areas["todos"]["rows"] == 2 and areas["goals"]["rows"] == 0
    assert "files" not in areas
    assert any(c["name"] == "title" for c in areas["todos"]["columns"])
