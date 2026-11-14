"""/api/data/*: access is checked server-side on every route (store faked)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import hermes_cli.data_dictionary as dd
import hermes_cli.data_dictionary_api as api
import hermes_cli.site_sources as ss

SID = "22222222-2222-2222-2222-222222222222"
SOURCE = dd.Source(id=SID, kind="app", profile="default", name="Aquarium data", owner_user_id="alice")
ACCESS = {"alice": "manage", "proposer": "propose", "reader": "read"}

# (method, path, level needed)
ROUTES = [
    ("GET", f"/api/data/sources/{SID}", "read"),
    ("GET", f"/api/data/sources/{SID}/versions", "read"),
    ("GET", f"/api/data/sources/{SID}/versions/1", "read"),
    ("POST", f"/api/data/sources/{SID}/draft", "propose"),
    ("POST", f"/api/data/sources/{SID}/draft/approve", "manage"),
    ("DELETE", f"/api/data/sources/{SID}/draft", "manage"),
    ("POST", f"/api/data/sources/{SID}/versions/1/restore", "manage"),
    ("GET", f"/api/data/sources/{SID}/grants", "manage"),
    ("POST", f"/api/data/sources/{SID}/grants", "manage"),
    ("DELETE", f"/api/data/sources/{SID}/grants?user_id=reader", "manage"),
]
BODIES = {
    "/draft": {"tables": {"tasks": {"meaning": "x"}}},
    "/draft/approve": {"version": 2},
    "/grants": {"user_id": "newbie", "grant": "read"},
}


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def caller(request):
        return SimpleNamespace(user_id=request.headers["x-test-user"], role="member", is_owner=False)

    async def get_source(source_id, **_kw):
        return SOURCE if source_id == SID else None

    async def resolve_access(source, principal, **_kw):
        return ACCESS.get(principal.user_id)

    def record(name, result):
        async def fake(*args, **kwargs):
            calls.append(name)
            return result

        return fake

    monkeypatch.setattr(api, "_caller", caller)
    monkeypatch.setattr(ss, "current_profile", lambda: "default")
    monkeypatch.setattr(dd, "get_source", get_source)
    monkeypatch.setattr(dd, "resolve_access", resolve_access)
    monkeypatch.setattr(dd, "dictionary", record("dictionary", {"approved": None}))
    monkeypatch.setattr(dd, "list_versions", record("list_versions", []))
    monkeypatch.setattr(dd, "get_version", record("get_version", {"version": 1, "status": "approved"}))
    for name in ("propose", "approve", "discard", "restore", "list_grants", "put_grant", "revoke_grant"):
        monkeypatch.setattr(dd, name, record(name, {}))
    app = FastAPI()
    app.include_router(api.router)
    tc = TestClient(app)
    tc.calls = calls
    return tc


def call(client, method, path, user):
    body = next((b for k, b in BODIES.items() if method == "POST" and path.endswith(k)), None)
    return client.request(method, path, json=body, headers={"x-test-user": user})


@pytest.mark.parametrize("method,path,need", ROUTES)
def test_access_levels(client, method, path, need):
    assert call(client, method, path, "stranger").status_code == 404
    for user, level in ACCESS.items():
        allowed = dd.allows(level, need)
        assert call(client, method, path, user).status_code == (200 if allowed else 403), (user, path)
    assert client.calls  # something ran for the allowed callers


def test_unknown_source_and_other_profile_are_404(client, monkeypatch):
    assert call(client, "GET", "/api/data/sources/nope", "alice").status_code == 404
    monkeypatch.setattr(ss, "current_profile", lambda: "other")
    assert call(client, "GET", f"/api/data/sources/{SID}", "alice").status_code == 404


def test_readers_do_not_see_drafts(client, monkeypatch):
    seen = []

    async def dictionary(source, *, draft=False, **_kw):
        seen.append(draft)
        return {"approved": None}

    monkeypatch.setattr(dd, "dictionary", dictionary)
    call(client, "GET", f"/api/data/sources/{SID}", "reader")
    call(client, "GET", f"/api/data/sources/{SID}", "proposer")
    assert seen == [False, True]


def test_guards(client):
    assert call(client, "POST", f"/api/data/sources/{SID}/grants", "alice").status_code == 200
    r = client.post(f"/api/data/sources/{SID}/grants", json={"user_id": "alice"}, headers={"x-test-user": "alice"})
    assert r.status_code == 400
    r = client.post(f"/api/data/sources/{SID}/draft", json={"origin": "restore"}, headers={"x-test-user": "alice"})
    assert r.status_code == 400
    r = client.post(f"/api/data/sources/{SID}/draft/approve", json={}, headers={"x-test-user": "alice"})
    assert r.status_code == 400


def test_access_level_rules():
    site_src = dd.Source(id=SID, kind="site", profile="default", name="Shop", owner_user_id="alice", site_id="s")
    member = SimpleNamespace(user_id="bob", role="member", is_owner=False)
    assert dd.access_level(site_src, member, None) is None
    assert dd.access_level(site_src, member, None, "read") == "read"
    assert dd.access_level(site_src, member, "propose", "read") == "propose"
    assert dd.access_level(site_src, member, None, "admin") == "manage"
    assert dd.access_level(SOURCE, member, None, "admin") is None  # site access only counts for site sources
    assert dd.access_level(SOURCE, SimpleNamespace(user_id="x", role="admin", is_owner=False), None) == "manage"
    assert dd.access_level(SOURCE, None, "read") is None
