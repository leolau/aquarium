"""FG-33 P8-2 item 2.2: the ``/api/tools*`` router (``hermes_cli/tools_api.py``).

Behaviour/invariant tests against the real app with an in-memory registry:
route order, batch health + SSRF rules, per-app write checks (decision 9),
secrets/egress through the root helpers, feedback, idempotency coverage.
"""

from __future__ import annotations

import dataclasses
import json
import socket
from types import SimpleNamespace

import pytest

from hermes_cli import app_runtime as rt
from hermes_cli import tools_api
from hermes_cli.tools_registry import Tool

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
ALICE = SimpleNamespace(user_id="alice", display="Alice", role="member", is_owner=False)
BOB = SimpleNamespace(user_id="bob", display="Bob", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)


def _tool(name, owner, visibility, **kw):
    base = dict(
        id=f"tol_{name}", name=name, kind="in_house", stack="nextjs-node",
        owner_user_id=owner, visibility=visibility, mode="dev", status="enabled",
        mcp_endpoint_ref=None, web_url=None, config_json={},
    )
    base.update(kw)
    return Tool(**base)


def _can_read(principal, visibility):
    return principal.is_owner or visibility == "shared" or visibility == f"private:{principal.user_id}"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    tools_api._health_cache.clear()


@pytest.fixture
def api(monkeypatch, tmp_path):
    from starlette.testclient import TestClient

    import hermes_cli.datastore as datastore
    import hermes_cli.tools_registry as tools_registry
    from hermes_cli import web_server

    rows = {
        "notes": _tool("notes", "alice", "private:alice", hosting="local",
                       mcp_endpoint_ref="la-notes"),
        "board": _tool("board", "bob", "shared", hosting="local"),
        "secret": _tool("secret", "bob", "private:bob", hosting="local"),
        "site": _tool("site", "alice", "shared", kind="external", hosting="external",
                      public_url="https://site.example.com"),
        "off": _tool("off", "alice", "shared", status="disabled"),
    }
    state = {"as": ALICE, "helper": [], "records": [], "endpoints": {}}

    async def caller(request, *, allow_as=False):
        return state["as"]

    class Registry:
        def __init__(self, store):
            self.mode = store if store in ("dev", "prod") else "dev"
            self.store = SimpleNamespace(mode=self.mode)

        async def initialize(self):
            pass

        async def get(self, name):
            return rows.get(name)

        async def get_for_principal(self, principal, name):
            tool = rows.get(name)
            return tool if tool and _can_read(principal, tool.visibility) else None

        async def list_for_principal(self, principal):
            return [t for t in rows.values() if _can_read(principal, t.visibility)]

        async def set_enabled(self, principal, name, enabled):
            if not principal.is_owner and rows[name].owner_user_id != principal.user_id:
                raise PermissionError("not the tool's owner")  # like _assert_can_write
            rows[name] = dataclasses.replace(rows[name], status="enabled" if enabled else "disabled")
            return rows[name]

    def runner(argv, stdin, timeout):
        state["helper"].append((argv, json.loads(stdin) if stdin else None))
        spec = json.loads(stdin) if stdin else {}
        if argv[-1] == "set-secret":
            names = ["APP_MCP_TOKEN"] + ([] if spec.get("delete") else [spec["name"]])
            return 0, json.dumps({"secret_names": names, "restart_needed": True}), ""
        if argv[-1] == "set":
            return 0, json.dumps({"hosts": spec["hosts"]}), ""
        return 0, "{}", ""

    class Runtime(rt.AppRuntime):
        def __init__(self, *a, **k):
            super().__init__(rt.HelperClient(runner), tools_root=tmp_path / "tools")

        async def _record(self, registry, principal, tool, action, payload, *, reversible=True):
            state["records"].append((principal.user_id, action, payload))

    async def update_tool(registry, name, **cols):
        if "secret_names" in cols:
            cols["secret_names"] = tuple(cols["secret_names"])
        rows[name] = dataclasses.replace(rows[name], **cols)
        return rows[name]

    async def update_endpoint(registry, endpoint, **cols):
        state["endpoints"].setdefault(endpoint, {}).update(cols)
        return {"name": endpoint, "transport": {"type": "http"}, **state["endpoints"][endpoint]}

    monkeypatch.setattr(web_server, "_comms_resolve_principal", caller)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda r: state["as"].user_id)
    monkeypatch.setattr(datastore, "get_store", lambda kind, mode, **k: mode)
    monkeypatch.setattr(datastore, "resolve_mode", lambda m=None, **k: m or "dev")
    monkeypatch.setattr(tools_registry, "ToolRegistry", Registry)
    monkeypatch.setattr(rt, "AppRuntime", Runtime)
    monkeypatch.setattr(tools_api, "_update_tool", update_tool)
    monkeypatch.setattr(tools_api, "_update_endpoint", update_endpoint)
    monkeypatch.setattr(web_server.app.state, "bound_host", None, raising=False)
    client = TestClient(web_server.app, raise_server_exceptions=False)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return client, rows, state


# ── routing ─────────────────────────────────────────────────────────────────

def test_name_routes_never_shadow_literal_tools_routes():
    from hermes_cli.web_server import app

    paths = [getattr(r, "path", "") for r in app.routes]
    first_param = paths.index("/api/tools/{name}")
    for literal in ("/api/tools/toolsets", "/api/tools/computer-use/status",
                    "/api/tools/changes", "/api/tools/quota"):
        assert paths.index(literal) < first_param, literal


def test_moved_routes_are_served_from_the_router():
    from hermes_cli.web_server import app

    endpoints = {(getattr(r, "path", ""), m): r.endpoint for r in app.routes
                 for m in (getattr(r, "methods", None) or ())}
    for key in (("/api/tools", "GET"), ("/api/tools/{name}/build", "POST"),
                ("/api/tools/{name}", "DELETE"), ("/api/tools/{name}/promote", "POST")):
        assert endpoints[key].__module__ == "hermes_cli.tools_api", key


# ── batch health ────────────────────────────────────────────────────────────

def test_batch_health_one_read_runtime_for_local_cached_probe_for_external(api, monkeypatch):
    client, rows, state = api
    probes = []

    async def runtime_rows(registry, ids):
        return {"tol_notes": {"runtime_state": "running", "health": "degraded"}}

    def probe(kind, url):
        probes.append((kind, url))
        return {"reachable": True, "detail": "HTTP 200", "status": 200}

    monkeypatch.setattr(tools_api, "_runtime_rows", runtime_rows)
    monkeypatch.setattr(tools_api, "_probe", probe)
    body = client.get("/api/tools?include=health").json()
    health = {t["name"]: t["health"]["state"] for t in body["tools"]}
    assert health == {"notes": "degraded", "board": "unknown", "site": "ok", "off": "off"}
    assert "secret" not in health  # C2: bob's private app is invisible to alice
    assert probes == [("public", "https://site.example.com")]
    client.get("/api/tools?include=health")
    assert len(probes) == 1  # 30 s cache
    assert "health" not in client.get("/api/tools").json()["tools"][0]


def test_single_health_route_keeps_its_shape_and_hides_private_apps(api, monkeypatch):
    client, rows, state = api
    monkeypatch.setattr(tools_api, "_probe", lambda k, u: {"reachable": False, "detail": "x", "status": None})
    out = client.get("/api/tools/site/health").json()
    assert out["name"] == "site" and out["reachable"] is False and out["health"]["state"] == "down"
    assert client.get("/api/tools/secret/health").status_code == 404


def test_probe_target_only_uses_loopback_web_urls():
    assert tools_api._probe_target(_tool("a", "x", "shared", web_url="http://127.0.0.1:4310/")) == (
        "internal", "http://127.0.0.1:4310/")
    assert tools_api._probe_target(_tool("a", "x", "shared", web_url="http://10.0.0.5/")) is None
    assert tools_api._probe_target(_tool("a", "x", "shared", web_url="http://169.254.169.254/")) is None


@pytest.mark.parametrize("url", ["http://example.com/", "https://user:pw@example.com/", "ftp://example.com"])
def test_fetch_public_refuses_non_https(url):
    with pytest.raises(ValueError):
        tools_api.fetch_public(url)


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:192.168.1.1"])
def test_fetch_public_refuses_private_resolution(monkeypatch, address):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(family, socket.SOCK_STREAM, 6, "", (address, 443))])
    monkeypatch.setattr(socket, "create_connection",
                        lambda *a, **k: pytest.fail("connected to a private address"))
    with pytest.raises(ValueError, match="private"):
        tools_api.fetch_public("https://rebind.example.com/")


# ── reads ───────────────────────────────────────────────────────────────────

def test_get_tool_and_mcp_are_c2_scoped_and_hide_secret_refs(api, monkeypatch):
    client, rows, state = api
    from hermes_cli import mcp_endpoints

    class Endpoints:
        def __init__(self, store):
            pass

        async def get(self, name):
            return mcp_endpoints.MCPEndpoint(
                id="mep_1", name=name, kind="in_house",
                transport={"type": "http", "url": "http://127.0.0.1:4500/api/mcp", "auth": "bearer"},
                owner_user_id="alice", visibility="private:alice", mode="dev",
                app_kind="local", secret_ref="la-notes-dev")

    monkeypatch.setattr(mcp_endpoints, "MCPEndpointRegistry", Endpoints)
    got = client.get("/api/tools/notes").json()
    assert got["can_manage"] is True and got["path"] == "/apps-dev/notes"
    mcp = client.get("/api/tools/notes/mcp").json()
    assert mcp["takes_effect"] == "next_chat" and "secret_ref" not in mcp["endpoint"]
    state["as"] = BOB
    assert client.get("/api/tools/notes").status_code == 404
    assert client.get("/api/tools/board").json()["can_manage"] is True


# ── writes: decision 9 ──────────────────────────────────────────────────────

def test_member_manages_own_app_but_not_others(api):
    client, rows, state = api
    ok = client.put("/api/tools/notes/icon", json={"icon_source": "generated", "icon": "N", "icon_color": "teal"})
    assert ok.status_code == 200 and ok.json()["icon"] == "N"
    assert state["records"][-1][:2] == ("alice", "hermes tool icon notes")
    assert client.put("/api/tools/board/icon", json={"icon_source": "generated", "icon": "B"}).status_code == 403
    assert client.put("/api/tools/secret/icon", json={"icon_source": "generated", "icon": "S"}).status_code == 404
    state["as"] = VIEWER
    assert client.put("/api/tools/board/visibility", json={"visibility": "private"}).status_code == 403
    state["as"] = ADMIN
    assert client.put("/api/tools/board/visibility", json={"visibility": "private"}).json()["visibility"] == "private:bob"


def test_icon_rejects_bad_input(api):
    client, rows, state = api
    assert client.put("/api/tools/notes/icon", json={"icon_source": "generated", "icon": "x" * 9}).status_code == 400
    assert client.put("/api/tools/notes/icon", json={"icon_source": "favicon"}).status_code == 400
    assert client.put("/api/tools/notes/icon", json={"icon_source": "uploaded"}).status_code == 400


def test_visibility_mirrors_the_mcp_endpoint(api):
    client, rows, state = api
    out = client.put("/api/tools/notes/visibility", json={"visibility": "shared"})
    assert out.json()["visibility"] == "shared"
    assert state["endpoints"]["la-notes"] == {"visibility": "shared"}
    assert client.put("/api/tools/notes/visibility", json={"visibility": "public"}).status_code == 400


def test_mcp_toggle_applies_next_chat(api):
    client, rows, state = api
    out = client.put("/api/tools/notes/mcp", json={"enabled": False}).json()
    assert out["takes_effect"] == "next_chat" and state["endpoints"]["la-notes"] == {"enabled": False}
    assert client.put("/api/tools/site/mcp", json={"enabled": False}).status_code == 409


def test_member_enables_own_tool(api, monkeypatch):
    client, rows, state = api

    async def admin_set(registry, name, enabled):
        rows[name] = dataclasses.replace(rows[name], status="enabled" if enabled else "disabled")
        return rows[name]

    monkeypatch.setattr(tools_api, "_admin_set_enabled", admin_set)
    assert client.put("/api/tools/notes/enabled", json={"enabled": False}).json()["status"] == "disabled"
    assert client.put("/api/tools/board/enabled", json={"enabled": False}).status_code == 403
    state["as"] = ADMIN  # an admin acts on anyone's app (decision 9)
    assert client.put("/api/tools/board/enabled", json={"enabled": False}).json()["status"] == "disabled"


# ── secrets + egress through the helpers ────────────────────────────────────

def test_secret_value_goes_only_to_the_helper(api):
    client, rows, state = api
    resp = client.put("/api/tools/notes/secrets", json={"name": "STRIPE_KEY", "value": "sk_live_zzz"})
    assert resp.status_code == 200
    assert "sk_live_zzz" not in resp.text
    assert resp.json() == {"tool": "notes", "mode": "dev", "secret_names": ["STRIPE_KEY"],
                           "restart_needed": True}
    argv, spec = state["helper"][-1]
    assert argv == ["sudo", "-n", rt.HELPER, "set-secret"]
    assert spec == {"slug": "notes", "mode": "dev", "name": "STRIPE_KEY", "value": "sk_live_zzz"}
    assert rows["notes"].secret_names == ("STRIPE_KEY",)
    assert all("sk_live_zzz" not in json.dumps(r) for r in state["records"])
    deleted = client.put("/api/tools/notes/secrets", json={"name": "STRIPE_KEY", "delete": True})
    assert deleted.json()["secret_names"] == [] and state["helper"][-1][1]["delete"] is True


@pytest.mark.parametrize("name", ["APP_MCP_TOKEN", "DATABASE_URL", "NEXT_PUBLIC_X", "PATH", "lower"])
def test_reserved_secret_names_never_reach_sudo(api, name):
    client, rows, state = api
    assert client.put("/api/tools/notes/secrets", json={"name": name, "value": "v"}).status_code == 400
    assert state["helper"] == []


def test_secrets_refused_for_non_local_and_other_members(api):
    client, rows, state = api
    assert client.put("/api/tools/site/secrets", json={"name": "K", "value": "v"}).status_code == 400
    assert client.put("/api/tools/board/secrets", json={"name": "K", "value": "v"}).status_code == 403
    assert state["helper"] == []


def test_egress_calls_the_egress_helper_with_validated_hosts(api):
    client, rows, state = api
    out = client.put("/api/tools/notes/egress", json={"hosts": ["API.Stripe.com", "*.openai.com", "api.stripe.com"]})
    assert out.json()["hosts"] == ["*.openai.com", "api.stripe.com"]
    argv, spec = state["helper"][-1]
    assert argv == ["sudo", "-n", rt.EGRESS_HELPER, "set"]
    assert spec == {"slug": "notes", "mode": "dev", "hosts": ["*.openai.com", "api.stripe.com"]}


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "db.internal", "printer.local", "a b.com",
                                  "x.com:443", "x.com/path", "1.10.in-addr.arpa"])
def test_egress_refuses_non_public_hosts(api, host):
    client, rows, state = api
    assert client.put("/api/tools/notes/egress", json={"hosts": [host]}).status_code == 400
    assert state["helper"] == []


# ── favicon + feedback ──────────────────────────────────────────────────────

def test_local_favicon_snapshot_is_stored_and_svg_refused(api, monkeypatch, tmp_path):
    client, rows, state = api
    import hermes_cli.file_registry as file_registry

    stored = []

    async def store(principal, data, **kw):
        stored.append((principal.user_id, kw["content_type"], len(data)))
        return SimpleNamespace(id="fil_icon")

    monkeypatch.setattr(file_registry, "store_and_register", store)
    app_dir = tmp_path / "tools" / "notes" / "app"
    app_dir.mkdir(parents=True)
    (app_dir / "icon.png").write_bytes(b"<svg xmlns='http://www.w3.org/2000/svg'/>")
    assert client.post("/api/tools/notes/favicon-refresh", json={}).status_code == 400
    (app_dir / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 64)
    out = client.post("/api/tools/notes/favicon-refresh", json={}).json()
    assert out["icon_source"] == "favicon" and out["icon_asset_id"] == "fil_icon"
    assert stored == [("alice", "image/png", 72)]


def test_feedback_lands_on_the_linked_project(api):
    client, rows, state = api
    from hermes_cli import projects_db

    assert client.post("/api/tools/notes/feedback", json={"body": "bigger buttons"}).status_code == 409
    with projects_db.connect_closing() as conn:
        pid = projects_db.create_project(conn, name="Notes", slug="notes-proj", owner_user_id="alice")
        pid = getattr(pid, "id", pid)
        projects_db.add_project_member(conn, project_id=pid, user_id="alice", role="lead")
    rows["notes"] = dataclasses.replace(rows["notes"], project_slug="notes-proj")
    out = client.post("/api/tools/notes/feedback", json={"text": "bigger buttons", "rating": "bad"})
    assert out.status_code == 200, out.text
    with projects_db.connect_closing() as conn:
        directives = projects_db.list_project_directives(conn, pid)
    assert [(d["kind"], d["body"], d["target_ref"]) for d in directives] == [
        ("feedback", "bigger buttons", "tool:notes")]
    assert client.post("/api/tools/notes/feedback", json={"body": " "}).status_code == 400


# ── idempotency + lifecycle mount ───────────────────────────────────────────

def test_tools_and_quotas_writes_honour_idempotency_keys():
    from hermes_cli.projects_idempotency import _covers

    assert _covers("/api/tools/notes/icon") and _covers("/api/quotas/alice")
    assert _covers("/api/tools") and not _covers("/api/toolsets") and not _covers("/api/quotasx")


def test_idempotency_replays_a_tool_write(api, monkeypatch, tmp_path):
    client, rows, state = api
    monkeypatch.setenv("HERMES_IDEMPOTENCY_DB", str(tmp_path / "idem.db"))
    headers = {"Idempotency-Key": "k-egress-1"}
    body = {"hosts": ["api.stripe.com"]}
    first = client.put("/api/tools/notes/egress", json=body, headers=headers)
    second = client.put("/api/tools/notes/egress", json=body, headers=headers)
    assert first.status_code == second.status_code == 200
    assert second.headers.get("Idempotent-Replayed") == "true"
    assert len(state["helper"]) == 1


def test_lifecycle_router_is_mounted_when_present():
    import importlib.util

    from hermes_cli.web_server import app

    if importlib.util.find_spec("hermes_cli.app_lifecycle_api") is None:
        pytest.skip("item 2.4's lifecycle router is not merged yet")
    paths = {getattr(r, "path", "") for r in app.routes}
    assert {"/api/tools/{name}/archive", "/api/tools/{name}/purge",
            "/api/tools/{name}/restore"} <= paths
