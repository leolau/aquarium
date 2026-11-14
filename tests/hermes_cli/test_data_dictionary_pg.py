"""Data dictionary against a real Postgres: versions, approval, grants, site seeding.

Needs ``HERMES_TEST_SITE_PG_DSN`` (a disposable superuser address); skipped otherwise.
"""

from __future__ import annotations

import asyncio
import os
import uuid

import pytest

import hermes_cli.data_dictionary as dd
import hermes_cli.site_sources as ss
from hermes_cli.access import Principal

DSN = os.environ.get("HERMES_TEST_SITE_PG_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="HERMES_TEST_SITE_PG_DSN not set")

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
BOSS = Principal(user_id="boss", display="Boss", role="admin")
DESIGN = {
    "entities": [
        {
            "name": "orders",
            "kind": "variable",
            "reason": "Each order placed in the shop",
            "columns": [{"name": "order_no", "type": "text"}, {"name": "amount", "type": "number"}],
            "key": ["order_no"],
        }
    ]
}
ORDERS = {"meaning": "Orders placed in the shop", "row": "One order", "grain": "order",
          "columns": {"amount": "Total in HKD, refunds excluded"},
          "metrics": [{"name": "revenue", "definition": "sum(amount)"}]}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(ss, "_role_secrets_path", lambda: tmp_path / "roles.json")
    monkeypatch.setattr(ss, "_registry_ready", set())
    monkeypatch.setattr(dd, "_ready", set())
    profile = f"p{uuid.uuid4().hex[:8]}"
    monkeypatch.setattr(ss, "current_profile", lambda: profile)
    ss.set_database(ss.SiteDatabase(DSN))
    site = run(ss.create_site(ALICE, {"name": f"t{uuid.uuid4().hex[:8]}", "base_url": "https://shop.example"}))
    yield profile, site
    ss.set_database(None)

    async def drop():
        import asyncpg

        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{site.schema_name}" CASCADE')
            for role in (site.writer_role, site.reader_role):
                await conn.execute(f"DROP OWNED BY {role}")
                await conn.execute(f"DROP ROLE IF EXISTS {role}")
            await conn.execute("DELETE FROM public.site_sources WHERE id = $1::uuid", site.id)
            await conn.execute("DELETE FROM public.data_sources WHERE profile = $1", profile)
        finally:
            await conn.close()

    run(drop())


def sources(principal, profile):
    return {s["kind"]: s for s in run(dd.list_sources(principal, profile))}


def test_site_source_seeds_from_approved_design(env):
    profile, site = env

    async def go():
        proposed = await ss.propose_design(site, DESIGN, None, by="alice")
        await ss.apply_design(site, proposed["version"], approved_by="alice")

    run(go())
    mine = sources(ALICE, profile)
    assert set(mine) == {"site"}  # the app source needs a grant
    assert mine["site"]["access"] == "manage" and mine["site"]["status"] == "approved"
    source = run(dd.get_source(mine["site"]["id"]))
    approved = run(dd.dictionary(source))["approved"]
    assert approved["entries"]["tables"]["orders"]["meaning"] == "Each order placed in the shop"
    assert approved["changes"][0]["origin"] == "design"
    assert sources(BOB, profile) == {}
    assert set(sources(BOSS, profile)) == {"app", "site"}


def test_draft_review_approve_and_restore(env):
    profile, _site = env
    app = run(dd.get_source(sources(BOSS, profile)["app"]["id"]))
    first = run(dd.propose(app, tables={"tasks": ORDERS}, by="boss"))
    assert first == {"version": 1, "status": "draft", "changed_tables": ["tasks"]}
    second = run(dd.propose(app, tables={"goals": {"meaning": "Goals"}}, origin="chat", by="bob"))
    assert second["version"] == 1 and second["changed_tables"] == ["goals", "tasks"]
    with pytest.raises(ss.SiteError, match="not the open draft"):
        run(dd.approve(app, 2, by="boss"))
    done = run(dd.approve(app, 1, reject=["goals"], by="boss"))
    assert done["changed_tables"] == ["tasks"]
    approved = run(dd.dictionary(app, draft=True))
    assert set(approved["approved"]["entries"]["tables"]) == {"tasks"} and approved["draft"] is None
    run(dd.propose(app, remove=["tasks"], by="boss"))
    run(dd.approve(app, 2, by="boss"))
    assert run(dd.dictionary(app))["approved"]["entries"]["tables"] == {}
    with pytest.raises(ss.SiteError, match="never approved"):
        run(dd.restore(app, 9, by="boss"))
    restored = run(dd.restore(app, 1, by="boss"))
    assert restored == {"version": 3, "status": "approved", "restored_from": 1}
    assert set(run(dd.dictionary(app))["approved"]["entries"]["tables"]) == {"tasks"}
    assert [v["status"] for v in run(dd.list_versions(app))] == ["approved", "superseded", "superseded"]


def test_rejecting_every_change_leaves_approved_alone(env):
    profile, _site = env
    app = run(dd.get_source(sources(BOSS, profile)["app"]["id"]))
    run(dd.propose(app, tables={"tasks": ORDERS}, by="boss"))
    assert run(dd.approve(app, 1, reject=["tasks"], by="boss"))["status"] == "rejected"
    assert run(dd.dictionary(app))["approved"] is None
    run(dd.propose(app, tables={"tasks": ORDERS}, by="boss"))
    assert run(dd.discard(app, by="boss")) is True
    assert run(dd.discard(app, by="boss")) is False


def test_grants_and_validation(env):
    profile, _site = env
    app_id = sources(BOSS, profile)["app"]["id"]
    run(dd.put_grant(app_id, "bob", "propose", by="boss"))
    app = run(dd.get_source(app_id))
    assert run(dd.resolve_access(app, BOB)) == "propose"
    assert sources(BOB, profile)["app"]["access"] == "propose"
    run(dd.put_grant(app_id, "bob", "read", by="boss"))
    assert run(dd.resolve_access(app, BOB)) == "read"
    assert run(dd.revoke_grant(app_id, "bob")) is True
    assert run(dd.resolve_access(app, BOB)) is None
    with pytest.raises(ss.SiteError, match="read or propose"):
        run(dd.put_grant(app_id, "bob", "admin", by="boss"))
    for bad in ({"Bad Name": {}}, {"tasks": {"meaning": "x" * 3000}}, {"tasks": {"metrics": [{}]}}):
        with pytest.raises(ss.SiteError):
            run(dd.propose(app, tables=bad, by="boss"))
    with pytest.raises(ss.SiteError, match="nothing to propose"):
        run(dd.propose(app, by="boss"))


def test_confirmed_answer_becomes_a_feedback_example(env):
    profile, _site = env
    app = run(dd.get_source(sources(BOSS, profile)["app"]["id"]))
    run(dd.propose(app, tables={"tasks": ORDERS}, by="boss"))
    run(dd.approve(app, 1, by="boss"))
    q, sql = "How many tasks are open?", "SELECT count(*) FROM tasks WHERE status = 'open'"
    out = run(dd.add_example(app, table="tasks", question=q, sql=sql, by="bob"))
    assert out["changed_tables"] == ["tasks"]
    run(dd.add_example(app, table="tasks", question=q, sql=sql, by="bob"))
    draft = run(dd.dictionary(app, draft=True))["draft"]
    entry = draft["entries"]["tables"]["tasks"]
    assert [e["question"] for e in entry["examples"]].count(q) == 1
    assert entry["meaning"] == ORDERS["meaning"]
    assert {c["origin"] for c in draft["changes"]} == {"feedback"}
    with pytest.raises(ss.SiteError):
        run(dd.add_example(app, table="tasks", question="", sql=sql, by="bob"))
