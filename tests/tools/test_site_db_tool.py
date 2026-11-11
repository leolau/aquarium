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
