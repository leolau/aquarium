"""site_db tool: acts for the bound person and checks their site access."""

from __future__ import annotations

import asyncio
import json

import pytest

import hermes_cli.site_sources as ss
import tools.site_db_tool as tool
from tools.access_policy import acting_as

SITE = ss.Site(
    id="11111111-1111-1111-1111-111111111111",
    slug="shop",
    name="Shop",
    base_url="https://shop.example",
    owner_user_id="alice",
    schema_name="site_shop",
    db_role="site_shop_rw",
)


def call(user, role, **args):
    async def go():
        with acting_as(user, role):
            return json.loads(await tool.site_db_tool(args))

    return asyncio.run(go())


@pytest.fixture(autouse=True)
def fake_registry(monkeypatch):
    calls = []

    async def find_site(ref, **_kw):
        return SITE if ref in ("shop", SITE.id) else None

    async def grant_for(_site_id, user_id, **_kw):
        return {"reader": "read"}.get(user_id)

    async def grants_of(user_id, **_kw):
        return {SITE.id: "read"} if user_id == "reader" else {}

    async def list_sites(**_kw):
        return [SITE]

    def rec(name, result):
        async def fake(*a, **k):
            calls.append((name, a, k))
            return result

        return fake

    monkeypatch.setattr(ss, "current_profile", lambda: "default")
    monkeypatch.setattr(ss, "find_site", find_site)
    monkeypatch.setattr(ss, "grant_for", grant_for)
    monkeypatch.setattr(ss, "grants_of", grants_of)
    monkeypatch.setattr(ss, "list_sites", list_sites)
    monkeypatch.setattr(ss, "query", rec("query", {"columns": ["a"], "rows": [[1]]}))
    monkeypatch.setattr(ss, "propose_design", rec("propose_design", {"version": 2}))
    monkeypatch.setattr(ss, "apply_design", rec("apply_design", {"version": 2}))
    monkeypatch.setattr(ss, "start_refresh", rec("start_refresh", {"id": "r"}))
    monkeypatch.setattr(ss, "list_runs", rec("list_runs", []))
    return calls


def test_stranger_cannot_see_or_query(fake_registry):
    assert call("bob", "member", action="list_sites")["sites"] == []
    out = call("bob", "member", action="query", site="shop", sql="select 1")
    assert out["success"] is False and "no site" in out["error"]
    assert fake_registry == []


def test_reader_can_query_but_not_refresh_or_propose(fake_registry):
    assert call("reader", "member", action="query", site="shop", sql="select 1")["success"]
    for action in ("refresh", "propose_design", "approve_design"):
        out = call("reader", "member", action=action, site="shop", version=1, design={}, recipe={})
        assert out["success"] is False and "not manage" in out["error"]
    assert [c[0] for c in fake_registry] == ["query"]


def test_owner_proposes_and_refreshes(fake_registry):
    assert call("alice", "member", action="propose_design", site="shop", design={"e": 1}, recipe={})["success"]
    assert call("alice", "member", action="refresh", site="shop", mode="full")["success"]
    names = [c[0] for c in fake_registry]
    assert names == ["propose_design", "start_refresh"]
    assert fake_registry[1][2]["trigger"] == "agent" and fake_registry[1][2]["mode"] == "full"


def test_unbound_call_is_refused():
    out = asyncio.run(tool.site_db_tool({"action": "list_sites"}))
    assert json.loads(out)["success"] is False


def test_create_site_respects_create_roles(monkeypatch):
    monkeypatch.setattr("hermes_cli.config.load_config_readonly", lambda: {})
    out = call("m", "member", action="create_site", name="X", base_url="https://x.example")
    assert out["success"] is False and "can't add sites" in out["error"]


def test_registered_service_gated():
    from tools.registry import registry
    from toolsets import _HERMES_CORE_TOOLS, resolve_toolset

    assert "site_db" in registry.get_all_tool_names()
    assert resolve_toolset("site_db") == ["site_db"]
    assert "site_db" in _HERMES_CORE_TOOLS
    assert "site_db" in resolve_toolset("hermes-api-server")


@pytest.fixture
def study(monkeypatch):
    seen = {}

    async def explore_site(site, principal, **kw):
        seen["explore"] = (site.slug, principal.user_id, kw)
        return {"login": "site-login/shop", "pages": []}

    async def preview_recipe(site, principal, **kw):
        seen["preview"] = (site.slug, principal.user_id, kw)
        return {"ok": True, "entities": {}}

    monkeypatch.setattr(ss, "explore_site", explore_site)
    monkeypatch.setattr(ss, "preview_recipe", preview_recipe)
    return seen


def test_explore_and_preview_need_site_admin(fake_registry, study):
    for action in ("explore", "preview"):
        out = call("reader", "member", action=action, site="shop", goto=["/"])
        assert out["success"] is False and "not manage" in out["error"]
        assert call("bob", "member", action=action, site="shop")["success"] is False
    assert study == {}


def test_owner_explores_and_previews_in_process(fake_registry, study):
    out = call("alice", "member", action="explore", site="shop", recipe={"login": {}}, goto=["/a"],
               probes=[{"name": "p", "steps": []}])
    assert out["success"] and out["site"] == "shop"
    assert study["explore"] == ("shop", "alice", {"recipe": {"login": {}}, "probes": [{"name": "p", "steps": []}],
                                                  "goto": ["/a"]})
    out = call("alice", "member", action="preview", site="shop", entities=["orders"], mode="incremental",
               cursors={"orders": "2026-01-01"}, max_rows=5, sample=1)
    assert out["success"] and out["ok"] is True
    _, _, kw = study["preview"]
    assert kw == {"recipe": None, "entities": ["orders"], "mode": "incremental",
                  "cursors": {"orders": "2026-01-01"}, "row_limit": 5, "sample": 1}
    assert fake_registry == []


def _with_runner(monkeypatch, browse=None, run=None):
    import hermes_cli.site_recipe_runner as srr

    if browse:
        monkeypatch.setattr(srr, "browse", browse)
    if run:
        monkeypatch.setattr(srr, "run_recipe", run)
    return srr


def test_study_without_saved_login_refuses_before_browsing(monkeypatch, tmp_path):
    def browse(*a, **k):
        raise AssertionError("must not open a browser")

    _with_runner(monkeypatch, browse=browse)

    async def no_login(site):
        return None

    monkeypatch.setattr(ss, "load_login", no_login)
    from hermes_cli.access import Principal

    with pytest.raises(ss.SiteError, match="no saved login") as err:
        asyncio.run(ss.explore_site(SITE, Principal(user_id="alice", display="alice", role="member"),
                                    recipe={"login": {"url": "/"}}, goto=["/"]))
    assert err.value.status == 409


def test_study_recipe_stays_on_the_sites_origin():
    with pytest.raises(ss.SiteError, match="own address"):
        ss.study_recipe(SITE, {"base_url": "https://evil.example", "login": {}})
    assert ss.study_recipe(SITE, {})["base_url"] == SITE.base_url
    assert ss.study_recipe(SITE, '{"base_url": "https://SHOP.example/x"}')["site"] == "shop"


def test_one_study_at_a_time(monkeypatch):
    import threading

    started, release = threading.Event(), threading.Event()

    def browse(recipe, probes, credential, **kw):
        started.set()
        release.wait(5)
        yield "home", {"url": "/", "title": "t"}

    _with_runner(monkeypatch, browse=browse)

    async def saved(site):
        return {"username": "u", "password": "pw-secret"}

    monkeypatch.setattr(ss, "load_login", saved)
    from hermes_cli.access import Principal

    me = Principal(user_id="alice", display="alice", role="member")

    async def go():
        first = asyncio.create_task(ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"]))
        await asyncio.to_thread(started.wait, 5)
        with pytest.raises(ss.SiteError, match="another site explore/preview") as err:
            await ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"])
        assert err.value.status == 409
        release.set()
        return await first

    out = asyncio.run(go())
    assert [p["name"] for p in out["pages"]] == ["home"]
    out = asyncio.run(ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"]))  # lock released
    assert out["pages"]


def test_explore_output_is_capped_and_masks_the_password(monkeypatch):
    def browse(recipe, probes, credential, **kw):
        for probe in probes:
            yield probe["name"], {"url": "/", "title": "pw-secret", "text": "x" * 50_000,
                                  "links": [{"text": f"l{i}", "href": "/"} for i in range(500)]}

    _with_runner(monkeypatch, browse=browse)

    async def saved(site):
        return {"username": "u", "password": "pw-secret"}

    monkeypatch.setattr(ss, "load_login", saved)
    from hermes_cli.access import Principal

    out = asyncio.run(ss.explore_site(SITE, Principal(user_id="alice", display="alice", role="member"),
                                      recipe={"login": {"url": "/"}}, goto=[f"/p{i}" for i in range(20)]))
    text = json.dumps(out)
    assert "pw-secret" not in text
    assert len(text) < ss.STUDY_MAX_CHARS * 1.5
    assert len(out["pages"]) == 20 and "inventory_omitted" in out["pages"][-1]
    first = out["pages"][0]["inventory"]
    assert len(first["links"]) == 60 and first["links_omitted"] == 440 and len(first["text"]) == 1500
    with pytest.raises(ss.SiteError, match="at most"):
        asyncio.run(ss.explore_site(SITE, Principal(user_id="alice", display="alice", role="member"),
                                    goto=[f"/p{i}" for i in range(21)]))


def test_a_cancelled_study_keeps_the_lock_until_its_browser_is_done(monkeypatch):
    import threading

    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def browse(recipe, probes, credential, **kw):
        started.set()
        release.wait(5)
        finished.set()
        yield "home", {"url": "/"}

    _with_runner(monkeypatch, browse=browse)

    async def saved(site):
        return {"username": "u", "password": "pw-secret"}

    monkeypatch.setattr(ss, "load_login", saved)
    from hermes_cli.access import Principal

    me = Principal(user_id="alice", display="alice", role="member")

    async def go():
        first = asyncio.create_task(ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"]))
        await asyncio.to_thread(started.wait, 5)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        with pytest.raises(ss.SiteError, match="another site explore/preview"):
            await ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"])
        release.set()
        await asyncio.to_thread(finished.wait, 5)
        for _ in range(100):
            if not ss._study_busy.locked():
                break
            await asyncio.sleep(0.01)
        return await ss.explore_site(SITE, me, recipe={"login": {}}, goto=["/"])

    assert asyncio.run(go())["pages"]


def test_scrub_masks_short_passwords_as_words():
    assert ss._scrub({"a": "user ab said", "b": ["abc"]}, {"password": "ab"}) == {"a": "user *** said", "b": ["abc"]}
    assert ss._scrub({"t": "x-secret-y"}, {"password": "secret"}) == {"t": "x-***-y"}
    assert ss._scrub({"t": "ok"}, None) == {"t": "ok"}


def test_page_summaries_count_towards_the_explore_cap(monkeypatch):
    def browse(recipe, probes, credential, **kw):
        for probe in probes:
            yield probe["name"], {"url": "/", "title": "t" * 5000, "headings": ["h" * 5000] * 20}

    _with_runner(monkeypatch, browse=browse)
    from hermes_cli.access import Principal

    out = asyncio.run(ss.explore_site(SITE, Principal(user_id="alice", display="alice", role="member"),
                                      goto=[f"/p{i}" for i in range(20)]))
    assert len(json.dumps(out)) < ss.STUDY_MAX_CHARS * 1.2
    assert "omitted" in out["pages"][-1] and "summary" not in out["pages"][-1]


def test_describe_lists_tables_or_one_table(fake_registry, monkeypatch):
    calls = []

    async def summaries(site, q=None, **_kw):
        calls.append(("summaries", site.slug, q))
        return [{"name": "orders", "rows": 3}]

    async def describe(site, entity, **_kw):
        calls.append(("describe", entity))
        return {"name": entity, "rows": 3, "columns": []}

    monkeypatch.setattr(ss, "table_summaries", summaries)
    monkeypatch.setattr(ss, "describe_entity", describe)
    assert call("reader", "member", action="describe", site="shop", q="order")["tables"][0]["name"] == "orders"
    assert call("reader", "member", action="describe", site="shop", entity="orders")["table"]["rows"] == 3
    assert call("bob", "member", action="describe", site="shop")["success"] is False
    assert calls == [("summaries", "shop", "order"), ("describe", "orders")]


def test_app_actions_run_for_the_bound_person(fake_registry, monkeypatch):
    from hermes_cli import app_data

    seen = []

    async def describe(principal, **_kw):
        seen.append(("describe", principal.user_id))
        return [{"area": "todos", "rows": 2}]

    async def query(principal, areas, sql, **kw):
        seen.append(("query", principal.user_id, tuple(areas), sql, kw["max_rows"]))
        return {"columns": ["n"], "rows": [[2]], "row_count": 1, "truncated": False}

    monkeypatch.setattr(app_data, "describe", describe)
    monkeypatch.setattr(app_data, "query", query)
    assert call("reader", "member", action="app_describe")["areas"][0]["area"] == "todos"
    out = call("reader", "member", action="app_query", areas=["todos"], sql="SELECT 1", max_rows=7)
    assert out["rows"] == [[2]]
    assert seen == [("describe", "reader"), ("query", "reader", ("todos",), "SELECT 1", 7)]


def test_dictionary_actions(fake_registry, monkeypatch):
    from hermes_cli import data_dictionary as dd

    app = dd.Source(id="s1", kind="app", profile="default", name="Aquarium data")
    levels = {"reader": "read", "editor": "propose"}
    proposed = []

    async def sync_sources(profile, **_kw):
        return [app]

    async def resolve_access(source, principal, **_kw):
        return levels.get(principal.user_id)

    async def dictionary(source, *, draft=False, **_kw):
        return {"approved": {"version": 3, "entries": {"tables": {"todos": {"meaning": "m"}}}},
                **({"draft": {"version": 4, "changed_tables": ["goals"]}} if draft else {})}

    async def propose(source, **kw):
        proposed.append(kw)
        return {"version": 4, "status": "draft", "changed_tables": ["todos"]}

    monkeypatch.setattr(dd, "sync_sources", sync_sources)
    monkeypatch.setattr(dd, "resolve_access", resolve_access)
    monkeypatch.setattr(dd, "dictionary", dictionary)
    monkeypatch.setattr(dd, "propose", propose)
    out = call("reader", "member", action="dictionary", source="app")
    assert out["approved"]["version"] == 3 and "draft" not in out
    assert call("editor", "member", action="dictionary")["draft"]["version"] == 4
    assert "not suggest" in call("reader", "member", action="propose_dictionary", source="app",
                                 tables={"todos": {}})["error"]
    assert "shared with you" in call("stranger", "member", action="dictionary", source="app")["error"]
    out = call("editor", "member", action="propose_dictionary", source="app",
               tables={"todos": {"meaning": "x"}}, origin="feedback")
    assert out["proposed"]["version"] == 4 and proposed[0]["origin"] == "feedback"
    assert proposed[0]["by"] == "editor"
    assert "origin must be" in call("editor", "member", action="propose_dictionary", source="app",
                                    tables={}, origin="design")["error"]
