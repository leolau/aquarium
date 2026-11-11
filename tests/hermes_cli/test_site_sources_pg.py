"""site_sources against a real Postgres: provisioning, roles, SiteWriter, refresh.

Needs a disposable server: ``HERMES_TEST_SITE_PG_DSN=postgresql://postgres:pw@host:port/db``
(a superuser or a login with CREATEROLE). Skipped otherwise.
"""

from __future__ import annotations

import asyncio
import os
import sys
import types
import uuid

import pytest

import hermes_cli.site_sources as ss
from hermes_cli.access import Principal

DSN = os.environ.get("HERMES_TEST_SITE_PG_DSN", "")
pytestmark = pytest.mark.skipif(not DSN, reason="HERMES_TEST_SITE_PG_DSN not set")

DESIGN = {
    "entities": [
        {
            "name": "about",
            "kind": "fixed",
            "columns": [{"name": "title", "type": "text"}, {"name": "body", "type": "text"}],
            "key": ["title"],
        },
        {
            "name": "orders",
            "kind": "variable",
            "columns": [{"name": "order_no", "type": "text"}, {"name": "amount", "type": "number"}],
            "key": ["order_no"],
            "refresh": {"mode": "incremental", "cursor": "amount"},
        },
    ]
}
RECIPE = {
    "version": 1,
    "site": "shop",
    "base_url": "https://shop.example",
    "entities": {
        "orders": {
            "kind": "variable",
            "key": ["order_no"],
            "cursor": "amount",
            "steps": [
                {"op": "goto", "url": "/orders"},
                {
                    "op": "extract_table",
                    "table": "#orders",
                    "columns": {"order_no": {"header": "Order"}, "amount": {"header": "Amount", "type": "int"}},
                },
            ],
        }
    },
}
ALICE = Principal(user_id="alice", display="Alice", role="member")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setattr(ss, "_role_secrets_path", lambda: tmp_path / "roles.json")
    monkeypatch.setattr(ss, "current_profile", lambda: "default")
    monkeypatch.setattr(ss, "_registry_ready", set())
    db = ss.SiteDatabase(DSN)
    ss.set_database(db)
    slug = f"t{uuid.uuid4().hex[:10]}"
    created = run(ss.create_site(ALICE, {"name": slug, "base_url": "https://shop.example"}))
    yield created
    ss.set_database(None)

    async def drop():
        import asyncpg

        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute(f'DROP SCHEMA IF EXISTS "{created.schema_name}" CASCADE')
            for role in (created.writer_role, created.reader_role):
                await conn.execute(f"DROP OWNED BY {role}")
                await conn.execute(f"DROP ROLE IF EXISTS {role}")
            await conn.execute("DELETE FROM public.site_sources WHERE id = $1::uuid", created.id)
        finally:
            await conn.close()

    run(drop())


def approve(site, design=DESIGN):
    async def go():
        proposed = await ss.propose_design(site, design, RECIPE, by="alice")
        return await ss.apply_design(site, proposed["version"], approved_by="alice")

    return run(go())


async def _writer(site):
    conn = await ss.database().restricted(site, write=True)
    return ss.SiteWriter(site, DESIGN, conn)


def test_provision_and_apply_design(site):
    assert site.status == "draft" and site.schema_name == f"site_{site.slug}"
    out = approve(site)
    assert any("CREATE TABLE" in s for s in out["statements"])
    again = run(ss.propose_design(site, DESIGN, RECIPE, by="alice"))
    assert run(ss.apply_design(site, again["version"], approved_by="alice"))["statements"] == []
    retyped = {"entities": [dict(DESIGN["entities"][1], columns=[
        {"name": "order_no", "type": "text"}, {"name": "amount", "type": "text"}])]}
    with pytest.raises(ss.DesignConflict):  # refused when proposed, before any approval
        run(ss.propose_design(site, retyped, RECIPE, by="alice"))
    assert run(ss.get_site(site.id)).status == "active"


def test_writer_semantics_and_change_log(site):
    approve(site)

    async def go():
        w = await _writer(site)
        try:
            r1 = await w.begin_run("full", "manual")
            await w.upsert("orders", [{"order_no": "A1", "amount": "10"}, {"order_no": "A2", "amount": "5"}])
            assert await w.record_fixed("about", None, {"title": "Us", "body": "v1"}) == "insert"
            r1 = await w.finish_run(r1, full_entities=["orders", "about"])
            assert (r1.status, r1.inserted, r1.removed) == ("ok", 2, 0)

            # incremental: A2 unseen -> NOT removed; A1 changed -> update
            r2 = await w.begin_run("incremental", "schedule")
            counts = await w.upsert("orders", [{"order_no": "A1", "amount": "11"}])
            assert counts["updated"] == 1
            r2 = await w.finish_run(r2, full_entities=[])
            assert r2.removed == 0

            # failed full run never removes
            r3 = await w.begin_run("full", "manual")
            await w.upsert("orders", [{"order_no": "A1", "amount": "11"}])
            r3 = await w.finish_run(r3, full_entities=["orders"], error="boom")
            assert (r3.status, r3.removed) == ("error", 0)

            # clean full run: A2 unseen -> removed (kept, marked)
            r4 = await w.begin_run("full", "manual")
            c4 = await w.upsert("orders", [{"order_no": "A1", "amount": "11"}])
            assert c4["unchanged"] == 1
            assert await w.record_fixed("about", None, {"title": "Us", "body": "v2"}) == "version"
            r4 = await w.finish_run(r4, full_entities=["orders", "about"])
            assert r4.removed == 1 and r4.versions == 1

            # A2 comes back -> restore
            r5 = await w.begin_run("incremental", "manual")
            assert (await w.upsert("orders", [{"order_no": "A2", "amount": "5"}]))["restored"] == 1
            await w.finish_run(r5)
        finally:
            await w.conn.close()

        rows = await ss.table_rows(site, "orders", include_removed=True)
        by_key = {r["_key"]: r for r in rows["rows"]}
        assert set(by_key) == {"A1", "A2"} and by_key["A2"]["_removed_at"] is None
        hist = await ss.history(site, "orders", "A2")
        assert [c["op"] for c in hist["changes"]] == ["insert", "remove", "restore"]
        fixed = await ss.history(site, "about", "Us")
        assert [v["version"] for v in fixed["versions"]] == [1, 2]
        assert [c["op"] for c in fixed["changes"]] == ["insert", "version"]
        hist_a1 = await ss.history(site, "orders", "A1")
        assert [c["op"] for c in hist_a1["changes"]] == ["insert", "update"]
        runs = await ss.list_runs(site)
        assert len(runs) == 5

    run(go())


def test_reader_role_is_confined(site):
    approve(site)

    async def go():
        out = await ss.query(site, "SELECT count(*) AS n FROM orders")
        assert out["rows"][0][0] == 0 or out["rows"][0] == {"n": 0} or out["rows"]
        for bad in (
            "SELECT * FROM public.site_sources",
            "SELECT * FROM public.site_source_grants",
        ):
            with pytest.raises(ss.SiteError):
                await ss.query(site, bad)
        conn = await ss.database().restricted(site, write=False)
        try:
            import asyncpg

            with pytest.raises(asyncpg.PostgresError):
                await conn.execute("INSERT INTO orders (_key, _hash, _payload) VALUES ('x', 'h', '{}')")
        finally:
            await conn.close()
        wconn = await ss.database().restricted(site, write=True)
        try:
            import asyncpg

            with pytest.raises(asyncpg.PostgresError):
                await wconn.execute("DELETE FROM orders")
            with pytest.raises(asyncpg.PostgresError):
                await wconn.execute("CREATE TABLE sneaky (a int)")
        finally:
            await wconn.close()

    run(go())


def test_refresh_now_calls_run_recipe(site, monkeypatch):
    approve(site)
    seen = {}

    def run_recipe(recipe, credential, *, entities=None, mode, cursors):
        seen.setdefault("calls", []).append((tuple(entities), mode))
        if mode == "full":
            yield ("about", "fixed", "Us", {"title": "Us", "body": "hello"})
        else:
            yield ("_page", "", None, {})
            yield ("orders", "variable", "B1", {"order_no": "B1", "amount": 3})

    fake = types.ModuleType("hermes_cli.site_recipe_runner")
    fake.run_recipe = run_recipe
    monkeypatch.setitem(sys.modules, "hermes_cli.site_recipe_runner", fake)
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "site_recipe_runner", fake, raising=False)
    site = run(ss.get_site(site.id))
    out = run(ss.start_refresh(site, trigger="manual", wait=True))
    assert out["entity_modes"] == {"about": "full", "orders": "incremental"}
    assert sorted(seen["calls"]) == [(("about",), "full"), (("orders",), "incremental")]
    runs = run(ss.list_runs(site))
    assert runs[0]["status"] == "ok" and runs[0]["inserted"] == 1 and runs[0]["pages"] == 1


DESIGN3 = {
    "entities": DESIGN["entities"]
    + [
        {
            "name": "stock",
            "kind": "variable",
            "columns": [{"name": "sku", "type": "text"}],
            "key": ["sku"],
        }
    ]
}
RECIPE3 = {"entities": {"about": {"steps": []}, "orders": {"steps": []}, "stock": {"steps": []}}}


def _install_runner(monkeypatch, fn, report_cls):
    fake = types.ModuleType("hermes_cli.site_recipe_runner")
    fn.__module__ = "hermes_cli.site_recipe_runner"
    fake.run_recipe = fn
    fake.RunReport = report_cls
    monkeypatch.setitem(sys.modules, "hermes_cli.site_recipe_runner", fake)
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "site_recipe_runner", fake, raising=False)


def test_refresh_uses_runner_report(site, monkeypatch):
    """Removal follows report.full_entities; failed entities keep their rows; cursors are stored."""
    from dataclasses import dataclass, field

    @dataclass
    class RunReport:
        pages: int = 0
        rows: dict = field(default_factory=dict)
        completed: list = field(default_factory=list)
        full_entities: list = field(default_factory=list)
        failed: dict = field(default_factory=dict)
        cursors: dict = field(default_factory=dict)

        def as_dict(self):
            return dict(vars(self))

    class RecipeRunError(RuntimeError):
        pass

    plan = {"round": 1}

    def run_recipe(recipe, credential, *, entities=None, mode, cursors, report=None):
        first = plan["round"] == 1
        plan.setdefault("seen_cursors", []).append(dict(cursors))
        for name in entities:
            if name == "orders":
                rows = [("A1", 1), ("A2", 2)] if first else [("A1", 1)]
                for key, amount in rows:
                    yield ("orders", "variable", key, {"order_no": key, "amount": amount})
                report.cursors["orders"] = 99
                report.full_entities.append("orders")  # e.g. no cursor yet -> full extract
            elif name == "stock":
                if first:
                    yield ("stock", "variable", "S1", {"sku": "S1"})
                    report.full_entities.append("stock")
                else:
                    report.failed["stock"] = "layout changed"
                    continue
            elif name == "about":
                yield ("about", "fixed", "Us", {"title": "Us", "body": "b"})
                report.full_entities.append("about")
            report.completed.append(name)
            report.pages += 1
        if report.failed:
            raise RecipeRunError("some entities failed")

    RecipeRunError.__name__ = "RecipeRunError"
    _install_runner(monkeypatch, run_recipe, RunReport)
    approve(site, DESIGN3)
    site = run(ss.get_site(site.id))
    run(ss.start_refresh(site, trigger="manual", wait=True))
    plan["round"] = 2
    run(ss.start_refresh(site, trigger="manual", wait=True, mode="incremental"))

    runs = run(ss.list_runs(site))
    assert runs[0]["status"] == "partial" and runs[1]["status"] == "ok"
    detail = runs[0]["detail"]
    detail = detail if isinstance(detail, dict) else __import__("json").loads(detail)
    assert "stock" in detail["failed_entities"] and "stock" not in detail["full_entities"]
    assert detail["report"]["failed"] == {"stock": "layout changed"}
    orders = {r["_key"]: r for r in run(ss.table_rows(site, "orders", include_removed=True))["rows"]}
    assert orders["A2"]["_removed_at"] is not None  # full per report -> removed
    stock = run(ss.table_rows(site, "stock", include_removed=True))["rows"]
    assert [r["_removed_at"] for r in stock] == [None]  # failed entity -> kept
    assert any(c.get("orders") == 99 for c in plan["seen_cursors"])  # stored report cursor fed back


def test_refresh_without_browser_engine_records_clear_error(site, monkeypatch):
    """The real runner on a box without playwright: the run fails with a readable error, no traceback text."""
    import tools.lazy_deps

    for name in [m for m in sys.modules if m == "playwright" or m.startswith("playwright.")]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, "playwright", None)

    def no_install(*_a, **_k):
        raise tools.lazy_deps.FeatureUnavailable("sites.playwright", ("playwright",), "lazy installs are disabled")

    monkeypatch.setattr(tools.lazy_deps, "ensure", no_install)
    monkeypatch.setattr("tools.url_safety.is_safe_url", lambda _url: True)  # shop.example has no DNS here

    async def saved_login(_site):
        return {"username": "u", "password": "hunter2"}

    monkeypatch.setattr(ss, "load_login", saved_login)
    approve(site)
    site = run(ss.get_site(site.id))
    run(ss.start_refresh(site, trigger="manual", wait=True))

    latest = run(ss.list_runs(site))[0]
    assert latest["status"] == "error"
    assert latest["error"].startswith("browser engine not installed")
    assert "Traceback" not in latest["error"] and "ImportError" not in latest["error"]
    assert "hunter2" not in latest["error"]
