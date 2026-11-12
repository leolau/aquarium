"""Who "Whose data" offers each caller mirrors the read predicate (FG-38 P4).

Real Postgres people store; the route function runs as each principal.
"""

import asyncio

import asyncpg
import pytest

from hermes_cli import config as hermes_config
from hermes_cli import web_server
from hermes_cli.access import PrincipalStore
from hermes_cli.datastore import get_store, initialize_supabase_app
from tests.hermes_cli.test_account_owners_e2e import postgres_dsn  # noqa: F401


@pytest.fixture
def people(postgres_dsn, monkeypatch):  # noqa: F811
    config = {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}
    app = get_store("supabase-app", "prod", config=config)

    async def _setup():
        conn = await asyncpg.connect(postgres_dsn, ssl=False)
        try:
            await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
            await initialize_supabase_app(conn)
        finally:
            await conn.close()
        store = PrincipalStore(app)
        out = {}
        for user_id, role in (("leo", "owner"), ("mia", "admin"), ("kit", "admin"),
                              ("sam", "member"), ("vee", "viewer"), ("old", "member")):
            out[user_id] = await store.enroll(user_id, display=user_id.title(), role=role)
        await store.set_active("old", False)
        return out

    principals = asyncio.run(_setup())
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: app)
    return principals


def _offered(monkeypatch, principal, *, role_reads):
    async def _as(_request, **_kw):
        return principal

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _as)
    monkeypatch.setattr(
        hermes_config, "load_config",
        lambda *a, **k: {"memory": {"sharing": {"role_reads": role_reads}}},
    )
    body = asyncio.run(web_server.access_viewable_people(None))
    assert body["me"] == principal.user_id and body["role_reads"] is role_reads
    return [p["user_id"] for p in body["people"]]


@pytest.mark.parametrize("role_reads", [False, True])
def test_the_owner_may_pick_every_active_person(people, monkeypatch, role_reads):
    assert _offered(monkeypatch, people["leo"], role_reads=role_reads) == [
        "leo", "mia", "kit", "sam", "vee"]


def test_without_role_reads_everyone_else_picks_only_themselves(people, monkeypatch):
    for who in ("mia", "sam", "vee"):
        assert _offered(monkeypatch, people[who], role_reads=False) == [who]


def test_with_role_reads_an_admin_picks_members_and_viewers_only(people, monkeypatch):
    assert _offered(monkeypatch, people["mia"], role_reads=True) == ["mia", "sam", "vee"]
    assert _offered(monkeypatch, people["sam"], role_reads=True) == ["sam", "vee"]
    assert _offered(monkeypatch, people["vee"], role_reads=True) == ["vee"]
