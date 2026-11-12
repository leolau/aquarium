"""site_sources: design validation, DDL generation, writer decisions, access (no DB)."""

from __future__ import annotations

import sys
import types
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

import hermes_cli.site_sources as ss

DESIGN = {
    "entities": [
        {
            "name": "about",
            "kind": "fixed",
            "columns": [{"name": "title", "type": "text"}, {"name": "body", "type": "text"}],
            "key": ["title"],
            "refresh": {"mode": "full"},
            "reason": "rarely changes",
        },
        {
            "name": "orders",
            "kind": "variable",
            "columns": [
                {"name": "order_no", "type": "text"},
                {"name": "amount", "type": "number"},
                {"name": "placed_at", "type": "timestamp"},
            ],
            "key": ["order_no"],
            "refresh": {"mode": "incremental", "cursor": "placed_at", "full_every": "P7D"},
        },
    ]
}


def site(**kw):
    base = dict(
        id="11111111-1111-1111-1111-111111111111",
        slug="shop",
        name="Shop",
        base_url="https://shop.example",
        owner_user_id="alice",
        profile="default",
        schema_name="site_shop",
        db_role="site_shop_rw",
    )
    base.update(kw)
    return ss.Site(**base)


# -- names --------------------------------------------------------------------


@pytest.mark.parametrize("raw,slug", [("My Shop!", "my_shop"), ("ACME-2", "acme_2"), ("9lives", "s_9lives")])
def test_normalize_slug(raw, slug):
    assert ss.normalize_slug(raw) == slug
    assert ss.schema_name(slug) == f"site_{slug}"
    assert ss.writer_role(slug) == f"site_{slug}_rw"
    assert ss.reader_role(slug) == f"site_{slug}_ro"


@pytest.mark.parametrize("bad", ["", "___", None])
def test_normalize_slug_refuses_empty(bad):
    with pytest.raises(ss.SiteError):
        ss.normalize_slug(bad)


# -- design validation --------------------------------------------------------


def test_validate_design_normalises():
    out = ss.validate_design(DESIGN)
    orders = out["entities"][1]
    assert orders["refresh"]["mode"] == "incremental"
    assert orders["key"] == ["order_no"]


@pytest.mark.parametrize(
    "entity,needle",
    [
        ({"name": "_runs", "kind": "variable", "columns": [{"name": "a"}], "key": ["a"]}, "entity name"),
        ({"name": "x", "kind": "maybe", "columns": [{"name": "a"}], "key": ["a"]}, "kind"),
        ({"name": "x", "kind": "variable", "columns": [{"name": "a"}], "key": []}, "needs a key"),
        ({"name": "x", "kind": "variable", "columns": [{"name": "a", "type": "money"}], "key": ["a"]}, "type"),
        ({"name": "x", "kind": "variable", "columns": [{"name": "a; drop"}], "key": ["a"]}, "column name"),
        ({"name": "x", "kind": "fixed", "columns": [{"name": "a"}], "refresh": {"mode": "incremental"}}, "fixed"),
        ({"name": "x", "kind": "variable", "columns": [{"name": "a"}], "key": ["a"], "refresh": {"cursor": "z"}}, "cursor"),
    ],
)
def test_validate_design_refuses(entity, needle):
    with pytest.raises(ss.SiteError, match=needle):
        ss.validate_design({"entities": [entity]})


# -- DDL ------------------------------------------------------------------------


def test_meta_ddl_creates_every_meta_table():
    sql = "\n".join(ss.meta_ddl("site_shop"))
    assert 'CREATE SCHEMA IF NOT EXISTS "site_shop"' in sql
    for table in ss.META_TABLES:
        assert f'"site_shop".{table}' in sql
    assert "'insert', 'update', 'remove', 'restore', 'version'" in sql


def test_design_ddl_new_schema_creates_variable_tables_only():
    stmts = ss.design_ddl("site_shop", DESIGN, {})
    creates = [s for s in stmts if s.startswith("CREATE TABLE")]
    assert len(creates) == 1 and '"site_shop"."orders"' in creates[0]
    for std, _ in ss.STANDARD_COLUMNS:
        assert f'"{std}"' in creates[0]
    assert '"amount" numeric' in creates[0] and '"placed_at" timestamptz' in creates[0]
    assert not any("about" in s for s in stmts)


def _existing():
    cols = {n: t.split()[0] for n, t in ss.STANDARD_COLUMNS}
    cols.update(order_no="text", amount="numeric", placed_at="timestamptz", legacy="text")
    return {"orders": cols}


def test_design_ddl_is_additive():
    design = {"entities": [dict(DESIGN["entities"][1])]}
    design["entities"][0]["columns"] = DESIGN["entities"][1]["columns"] + [{"name": "status", "type": "text"}]
    stmts = ss.design_ddl("site_shop", design, _existing())
    assert stmts == ['ALTER TABLE "site_shop"."orders" ADD COLUMN "status" text']
    assert not any("DROP" in s.upper() for s in stmts)


def test_design_ddl_unchanged_is_a_no_op():
    assert ss.design_ddl("site_shop", DESIGN, _existing()) == []


def test_design_ddl_never_retypes():
    design = {"entities": [dict(DESIGN["entities"][1])]}
    design["entities"][0]["columns"] = [
        {"name": "order_no", "type": "text"},
        {"name": "amount", "type": "text"},
        {"name": "placed_at", "type": "timestamp"},
    ]
    with pytest.raises(ss.DesignConflict, match="never retyped"):
        ss.design_ddl("site_shop", design, _existing())


def test_design_ddl_refuses_foreign_table():
    with pytest.raises(ss.DesignConflict, match="not a site table"):
        ss.design_ddl("site_shop", DESIGN, {"orders": {"order_no": "text"}})


def test_role_grants_stay_in_the_schema():
    stmts = ss.role_grant_sql("site_shop", rw="site_shop_rw", ro="site_shop_ro")
    assert all('"site_shop"' in s for s in stmts)
    joined = " ".join(stmts)
    assert "DELETE" not in joined and "TRUNCATE" not in joined
    ro = [s for s in stmts if s.endswith("site_shop_ro") and "TABLES" in s]
    assert ro and all("GRANT SELECT ON" in s for s in ro)


# -- writer decisions ---------------------------------------------------------


def test_decide_upsert():
    h = ss.content_hash({"a": 1})
    assert ss.decide_upsert(None, h) == "insert"
    assert ss.decide_upsert({"_hash": h, "_removed_at": None}, h) is None
    assert ss.decide_upsert({"_hash": "old", "_removed_at": None}, h) == "update"
    assert ss.decide_upsert({"_hash": h, "_removed_at": datetime.now()}, h) == "restore"


def test_decide_fixed():
    h = ss.content_hash({"a": 1})
    assert ss.decide_fixed(None, h) == "insert"
    assert ss.decide_fixed({"content_hash": h, "valid_to": None}, h) is None
    assert ss.decide_fixed({"content_hash": "x", "valid_to": None}, h) == "version"
    assert ss.decide_fixed({"content_hash": h, "valid_to": datetime.now()}, h) == "restore"


def test_content_hash_ignores_key_order():
    assert ss.content_hash({"a": 1, "b": 2}) == ss.content_hash({"b": 2, "a": 1})


def test_record_key():
    spec = {"name": "orders", "key": ["order_no"]}
    assert ss.record_key(spec, {"order_no": " A1 "}) == "A1"
    with pytest.raises(ss.SiteError):
        ss.record_key(spec, {"order_no": ""})


@pytest.mark.parametrize(
    "value,kind,out",
    [("12", "integer", 12), ("1,234.50", "number", None), ("yes", "boolean", True), ("", "text", None)],
)
def test_coerce(value, kind, out):
    got = ss.coerce(value, kind)
    if out is None and value:
        assert got is not None
    else:
        assert got == out


def test_naive_timestamps_use_the_design_timezone():
    hk = ss.design_zone({"timezone": "Asia/Hong_Kong"})
    utc = timezone.utc
    assert ss.design_zone({}) is utc
    assert ss.coerce("2026-11-11T09:30:00", "timestamp", hk).astimezone(utc) == datetime(2026, 11, 11, 1, 30, tzinfo=utc)
    assert ss.coerce(datetime(2026, 11, 11, 9, 30), "timestamptz", hk).astimezone(utc).hour == 1
    # Values that carry an offset keep it; the default stays UTC.
    assert ss.coerce("2026-11-11T09:30:00Z", "timestamp", hk) == datetime(2026, 11, 11, 9, 30, tzinfo=utc)
    assert ss.coerce("2026-11-11T09:30:00+02:00", "timestamp", hk).astimezone(utc).hour == 7
    assert ss.coerce("2026-11-11T09:30:00", "timestamp") == datetime(2026, 11, 11, 9, 30, tzinfo=utc)
    # DST zones resolve per date.
    ny = ss.design_zone({"timezone": "America/New_York"})
    assert ss.coerce("2026-07-01T12:00:00", "timestamp", ny).astimezone(utc).hour == 16
    assert ss.coerce("2026-12-01T12:00:00", "timestamp", ny).astimezone(utc).hour == 17


@pytest.mark.parametrize("zone", ["HKT", "", 8, "Not/AZone"])
def test_validate_design_rejects_a_bad_timezone(zone):
    design = {"timezone": zone, "entities": [{"name": "about", "kind": "fixed", "columns": []}]}
    with pytest.raises(ss.SiteError, match="IANA"):
        ss.validate_design(design)


def test_validate_design_keeps_a_valid_timezone():
    design = {"timezone": "Asia/Hong_Kong", "entities": [{"name": "about", "kind": "fixed", "columns": []}]}
    assert ss.validate_design(design)["timezone"] == "Asia/Hong_Kong"


# -- refresh planning ---------------------------------------------------------


def test_plan_modes_full_every_and_fixed():
    now = datetime(2026, 11, 10, tzinfo=timezone.utc)
    modes = ss.plan_modes(DESIGN, requested_entities=None, requested_mode=None,
                          default_mode="incremental", last_full={"orders": now - timedelta(days=1)}, now=now)
    assert modes == {"about": "full", "orders": "incremental"}
    modes = ss.plan_modes(DESIGN, requested_entities=["orders"], requested_mode=None,
                          default_mode="incremental", last_full={"orders": now - timedelta(days=8)}, now=now)
    assert modes == {"orders": "full"}
    modes = ss.plan_modes(DESIGN, requested_entities=None, requested_mode="incremental",
                          default_mode="full", last_full={}, now=now)
    assert modes["about"] == "full"
    with pytest.raises(ss.SiteError, match="unknown"):
        ss.plan_modes(DESIGN, requested_entities=["nope"], requested_mode=None,
                      default_mode="full", last_full={})


def test_recipe_runner_import_guard(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli.site_recipe_runner", None)
    with pytest.raises(ss.SiteError) as err:
        ss._recipe_runner()
    assert err.value.status == 503
    fake = types.ModuleType("hermes_cli.site_recipe_runner")
    fake.run_recipe = lambda *a, **k: iter(())
    monkeypatch.setitem(sys.modules, "hermes_cli.site_recipe_runner", fake)
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "site_recipe_runner", fake, raising=False)
    assert ss._recipe_runner() is fake.run_recipe


def test_check_recipe_refuses_mutating_steps(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_cli.site_recipe_runner", None)
    ok = {"entities": {"orders": {"steps": [{"action": "click", "selector": "a.next-page"}]}}}
    assert ss.check_recipe(ok) == ok
    bad = {"entities": {"orders": {"steps": [{"action": "click", "text": "Delete order"}]}}}
    with pytest.raises(ss.SiteError, match="forbidden"):
        ss.check_recipe(bad)


# -- read-only query guard ------------------------------------------------------


@pytest.mark.parametrize("sql", ["SELECT * FROM orders", "with t as (select 1) select * from t", "select 1;"])
def test_check_select_accepts(sql):
    assert ss.check_select(sql)


@pytest.mark.parametrize("sql", ["DELETE FROM orders", "select 1; drop table orders", "", "update orders set a=1"])
def test_check_select_refuses(sql):
    with pytest.raises(ss.SiteError):
        ss.check_select(sql)


# -- access -------------------------------------------------------------------


def P(user_id, role):
    return SimpleNamespace(user_id=user_id, role=role)


def test_access_level():
    s = site()
    assert ss.access_level(s, P("zed", "owner"), None) == "admin"
    assert ss.access_level(s, P("adam", "admin"), None) == "admin"
    assert ss.access_level(s, P("alice", "member"), None) == "admin"
    assert ss.access_level(s, P("bob", "member"), "read") == "read"
    assert ss.access_level(s, P("bob", "member"), "admin") == "admin"
    assert ss.access_level(s, P("carol", "viewer"), None) is None
    assert ss.access_level(s, None, "admin") is None


def test_create_roles_default_and_set():
    assert ss.create_roles({}) == ["owner", "admin"]
    cfg = {}
    assert ss.set_create_roles(cfg, ["member"]) == ["owner", "member"]
    assert cfg == {"sites": {"create_roles": ["owner", "member"]}}
    assert ss.can_create(P("m", "member"), cfg)
    assert not ss.can_create(P("v", "viewer"), cfg)
    assert not ss.can_create(P("m", "member"), {})
    with pytest.raises(ss.SiteError):
        ss.set_create_roles(cfg, ["root"])


def test_site_view_never_has_credentials():
    view = site(credential_ref="site-login/abc").view("read")
    assert view["login_saved"] is True and view["access"] == "read"
    assert not any("password" in k for k in view)


# -- export ---------------------------------------------------------------------


def test_csv_neutralises_formulas():
    data = ss.to_csv(["a", "b"], [["=HYPERLINK(1)", "plain"], ["+1", None]]).decode("utf-8-sig")
    assert "'=HYPERLINK(1)" in data and "'+1" in data and "plain" in data


def test_xlsx_roundtrip():
    openpyxl = pytest.importorskip("openpyxl")
    import io

    data = ss.to_xlsx(["a", "b"], [["=1+1", 2]], title="orders")
    wb = openpyxl.load_workbook(io.BytesIO(data))
    ws = wb.active
    assert [c.value for c in ws[1]] == ["a", "b"]
    assert ws.cell(2, 1).value == "'=1+1" and ws.cell(2, 2).value == 2


def test_role_dsn_keeps_supavisor_tenant():
    dsn = ss.role_dsn("postgresql://postgres.tenant:pw@db.example:6543/postgres", "site_shop_ro", "p@ss")
    assert dsn == "postgresql://site_shop_ro.tenant:p%40ss@db.example:6543/postgres"
    assert ss.role_dsn("postgres://app:x@h/db", "r", "s") == "postgres://r:s@h/db"


def test_plan_modes_recipe_always_full():
    recipe = {"entities": {"orders": {"mode": "full", "steps": []}}}
    modes = ss.plan_modes(DESIGN, requested_entities=["orders"], requested_mode=None,
                          default_mode="incremental", last_full={"orders": datetime.now(timezone.utc)},
                          recipe=recipe)
    assert modes == {"orders": "full"}
    assert ss.recipe_entity(recipe, "orders")["mode"] == "full"
    assert ss.recipe_entity({"entities": [{"name": "x", "mode": "full"}]}, "x")["mode"] == "full"
    assert ss.recipe_entity(None, "x") == {}


def test_new_report_only_when_runner_takes_one(monkeypatch):
    mod = types.ModuleType("fake_runner_mod")

    class RunReport:
        def __init__(self):
            self.pages = 0

    def with_report(recipe, credential, *, entities=None, mode, cursors, report=None):
        return iter(())

    def without(recipe, credential, *, entities=None, mode, cursors):
        return iter(())

    for fn in (with_report, without):
        fn.__module__ = "fake_runner_mod"
    mod.RunReport = RunReport
    monkeypatch.setitem(sys.modules, "fake_runner_mod", mod)
    assert isinstance(ss._new_report(with_report), RunReport)
    assert ss._new_report(without) is None


def test_merge_report_sums_over_groups():
    into = {}
    ss._merge_report(into, {"pages": 2, "rows": {"a": 3}, "full_entities": ["a"], "cursors": {"a": 1}})
    ss._merge_report(into, {"pages": 1, "rows": {"a": 1, "b": 2}, "failed": {"b": "x"}})
    assert into["pages"] == 3 and into["rows"] == {"a": 4, "b": 2}
    assert into["full_entities"] == ["a"] and into["failed"] == {"b": "x"} and into["cursors"] == {"a": 1}


def test_consume_keeps_the_runner_on_one_thread():
    """Sync Playwright breaks if a later batch is pulled on another thread."""
    import asyncio
    import threading

    threads: list = []

    def runner():
        try:
            for i in range(ss._BATCH * 3 + 7):
                threads.append(threading.get_ident())
                yield ("orders", "variable", str(i), {"order_no": str(i)})
        finally:
            threads.append(threading.get_ident())

    stored: list = []

    class Writer:
        entities = {"orders": {"kind": "variable"}}

        async def upsert(self, entity, records):
            stored.extend(records)

    run = ss.SiteRun(id="r", mode="full", trigger="schedule")

    async def main():
        # A busy default pool would hand later batches to other threads.
        busy = [asyncio.to_thread(threading.Event().wait, 0.05) for _ in range(8)]
        await asyncio.gather(ss._consume(Writer(), run, runner(), {"orders"}), *busy)

    asyncio.run(main())
    assert len(stored) == ss._BATCH * 3 + 7
    assert len(set(threads)) == 1 and threads[0] != threading.get_ident()
