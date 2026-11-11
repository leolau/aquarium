"""/api/sites/*: every route checks the caller's site grant server-side.

The registry and the per-site data calls are faked; what is under test is the
authorization in ``site_sources_api`` — non-grantee 404, read grantee 403 on
management routes, site owner / grantee / profile admin allowed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import hermes_cli.site_sources as ss
import hermes_cli.site_sources_api as api

SITE_ID = "11111111-1111-1111-1111-111111111111"
SITE = ss.Site(
    id=SITE_ID,
    slug="shop",
    name="Shop",
    base_url="https://shop.example",
    owner_user_id="alice",
    profile="default",
    status="active",
    schema_name="site_shop",
    db_role="site_shop_rw",
)
GRANTS = {"reader": "read", "manager": "admin"}
PEOPLE = {
    "alice": "member",  # the site's owner
    "reader": "member",
    "manager": "viewer",
    "stranger": "member",
    "boss": "admin",
    "root": "owner",
}

# (method, path, needs site admin)
ROUTES = [
    ("GET", f"/api/sites/{SITE_ID}", False),
    ("PATCH", f"/api/sites/{SITE_ID}", True),
    ("DELETE", f"/api/sites/{SITE_ID}", True),
    ("GET", f"/api/sites/{SITE_ID}/designs", False),
    ("POST", f"/api/sites/{SITE_ID}/designs/1/approve", True),
    ("GET", f"/api/sites/{SITE_ID}/grants", True),
    ("POST", f"/api/sites/{SITE_ID}/grants", True),
    ("DELETE", f"/api/sites/{SITE_ID}/grants?user_id=reader", True),
    ("POST", f"/api/sites/{SITE_ID}/refresh", True),
    ("GET", f"/api/sites/{SITE_ID}/runs", False),
    ("GET", f"/api/sites/{SITE_ID}/tables", False),
    ("GET", f"/api/sites/{SITE_ID}/tables/orders?q=a&page=1&include_removed=true", False),
    ("GET", f"/api/sites/{SITE_ID}/tables/orders/export?format=csv", False),
    ("GET", f"/api/sites/{SITE_ID}/tables/orders/export?format=xlsx", False),
    ("GET", f"/api/sites/{SITE_ID}/history/orders/A1", False),
]
BODIES = {
    ("PATCH", "/api/sites/"): {"name": "Shop 2"},
    ("POST", "/grants"): {"user_id": "newbie", "grant": "read"},
    ("POST", "/refresh"): {"mode": "full"},
}


def _body_for(method, path):
    for (m, frag), body in BODIES.items():
        if m == method and frag in path:
            return body
    return None


@pytest.fixture
def client(monkeypatch):
    calls = []

    async def caller(request):
        user = request.headers.get("x-test-user", "stranger")
        return SimpleNamespace(user_id=user, display=user, role=PEOPLE.get(user, "member"))

    monkeypatch.setattr(api, "_caller", caller)
    monkeypatch.setattr(api, "_config", lambda: {})
    monkeypatch.setattr(ss, "current_profile", lambda: "default")

    async def get_site(site_id, **_kw):
        return SITE if site_id == SITE_ID else None

    async def grant_for(site_id, user_id, **_kw):
        return GRANTS.get(user_id)

    async def grants_of(user_id, **_kw):
        return {SITE_ID: GRANTS[user_id]} if user_id in GRANTS else {}

    async def list_sites(**_kw):
        return [SITE]

    def record(name, result):
        async def fake(*args, **kwargs):
            calls.append(name)
            return result

        return fake

    monkeypatch.setattr(ss, "get_site", get_site)
    monkeypatch.setattr(ss, "grant_for", grant_for)
    monkeypatch.setattr(ss, "grants_of", grants_of)
    monkeypatch.setattr(ss, "list_sites", list_sites)
    monkeypatch.setattr(ss, "approved_design", record("approved_design", (1, {}, {})))
    monkeypatch.setattr(ss, "update_site", record("update_site", SITE))
    monkeypatch.setattr(ss, "set_status", record("set_status", None))
    async def list_designs(*_a, **_kw):
        calls.append("list_designs")
        return [{"version": 1, "design": {}, "recipe": {"secret": 1}}]

    monkeypatch.setattr(ss, "list_designs", list_designs)
    monkeypatch.setattr(ss, "apply_design", record("apply_design", {"version": 1, "status": "approved"}))
    monkeypatch.setattr(ss, "list_grants", record("list_grants", []))
    monkeypatch.setattr(ss, "put_grant", record("put_grant", {"user_id": "newbie", "grant": "read"}))
    monkeypatch.setattr(ss, "revoke_grant", record("revoke_grant", True))
    monkeypatch.setattr(ss, "start_refresh", record("start_refresh", {"id": "r1", "status": "running"}))
    monkeypatch.setattr(ss, "list_runs", record("list_runs", []))
    monkeypatch.setattr(ss, "table_summaries", record("table_summaries", []))
    monkeypatch.setattr(ss, "table_rows", record("table_rows", {"rows": []}))
    monkeypatch.setattr(ss, "export_rows", record("export_rows", (["a"], [["=1"]])))
    # Route tests check authorization; XLSX encoding (openpyxl, optional) is tested in test_site_sources.
    monkeypatch.setattr(ss, "to_xlsx", lambda columns, rows, *, title: b"PK\x03\x04")
    monkeypatch.setattr(ss, "history", record("history", {"changes": []}))
    monkeypatch.setattr(ss, "create_site", record("create_site", SITE))

    app = FastAPI()
    app.include_router(api.router)
    tc = TestClient(app)
    tc.calls = calls
    return tc


def _call(client, method, path, user):
    body = _body_for(method, path)
    return client.request(method, path, json=body, headers={"x-test-user": user})


@pytest.mark.parametrize("method,path,_admin", ROUTES)
def test_non_grantee_gets_404_and_nothing_runs(client, method, path, _admin):
    res = _call(client, method, path, "stranger")
    assert res.status_code == 404, res.text
    assert client.calls == []


@pytest.mark.parametrize("method,path,_admin", ROUTES)
def test_unknown_site_is_404_even_for_profile_owner(client, method, path, _admin):
    res = _call(client, method, path.replace(SITE_ID, "22222222-2222-2222-2222-222222222222"), "root")
    assert res.status_code == 404


@pytest.mark.parametrize("method,path,admin", ROUTES)
def test_read_grantee(client, method, path, admin):
    res = _call(client, method, path, "reader")
    if admin:
        assert res.status_code == 403, res.text
        assert client.calls == []
    else:
        assert res.status_code == 200, res.text


@pytest.mark.parametrize("user", ["alice", "manager", "boss", "root"])
@pytest.mark.parametrize("method,path,_admin", ROUTES)
def test_site_admins_allowed(client, method, path, _admin, user):
    res = _call(client, method, path, user)
    assert res.status_code in (200, 202), (user, res.text)


def test_site_of_another_profile_is_404(client, monkeypatch):
    monkeypatch.setattr(ss, "current_profile", lambda: "other")
    assert _call(client, "GET", f"/api/sites/{SITE_ID}", "root").status_code == 404


def test_list_only_shows_accessible_sites(client):
    assert client.get("/api/sites", headers={"x-test-user": "stranger"}).json()["sites"] == []
    sites = client.get("/api/sites", headers={"x-test-user": "reader"}).json()["sites"]
    assert [s["access"] for s in sites] == ["read"]


def test_recipe_hidden_from_readers(client):
    designs = client.get(f"/api/sites/{SITE_ID}/designs", headers={"x-test-user": "reader"}).json()
    assert "recipe" not in designs["designs"][0]
    designs = client.get(f"/api/sites/{SITE_ID}/designs", headers={"x-test-user": "alice"}).json()
    assert designs["designs"][0]["recipe"] == {"secret": 1}


def test_create_respects_create_roles(client, monkeypatch):
    body = {"name": "Shop", "base_url": "https://shop.example"}
    assert client.post("/api/sites", json=body, headers={"x-test-user": "stranger"}).status_code == 403
    assert client.post("/api/sites", json=body, headers={"x-test-user": "boss"}).status_code == 200
    monkeypatch.setattr(api, "_config", lambda: {"sites": {"create_roles": ["owner", "member"]}})
    assert client.post("/api/sites", json=body, headers={"x-test-user": "stranger"}).status_code == 200


def test_settings_reports_can_create(client):
    out = client.get("/api/sites/settings", headers={"x-test-user": "reader"}).json()
    assert out == {"create_roles": ["owner", "admin"], "can_create": False}


def test_export_headers_and_formula_guard(client):
    res = client.get(f"/api/sites/{SITE_ID}/tables/orders/export?format=csv", headers={"x-test-user": "reader"})
    assert res.headers["content-disposition"] == 'attachment; filename="shop-orders.csv"'
    assert "'=1" in res.content.decode("utf-8-sig")
    bad = client.get(f"/api/sites/{SITE_ID}/tables/orders/export?format=pdf", headers={"x-test-user": "reader"})
    assert bad.status_code == 400


def test_grant_to_site_owner_refused(client):
    res = client.post(
        f"/api/sites/{SITE_ID}/grants", json={"user_id": "alice", "grant": "read"}, headers={"x-test-user": "root"}
    )
    assert res.status_code == 400


def test_patch_cannot_set_internal_status(client):
    res = client.patch(f"/api/sites/{SITE_ID}", json={"status": "active"}, headers={"x-test-user": "alice"})
    assert res.status_code == 200
    res = client.patch(f"/api/sites/{SITE_ID}", json={"status": "studying"}, headers={"x-test-user": "alice"})
    assert res.status_code == 400


def test_put_settings_is_admin_gated():
    route = next(r for r in api.router.routes if r.path == "/api/sites/settings" and "PUT" in r.methods)
    assert route.dependencies, "PUT /api/sites/settings must declare the ADMIN dependency"
