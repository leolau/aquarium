"""Only the owner or an admin may change Tools & Integrations.

MCP servers, toolsets and tool-registry rows apply to everyone in the profile,
so a logged-in member or viewer gets a 403 on every change endpoint while the
GET lists stay readable. A caller with no login (operator token, CLI) keeps
full access. Real config under a throwaway ``HERMES_HOME``; only the C1
principal resolver (Postgres) and the login subject are stubbed.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

DENIED = "Only the owner or an admin can change tools and integrations."

CHANGE_ROUTES = [
    ("post", "/api/mcp/servers", {"name": "evil", "url": "https://evil.example/mcp"}),
    ("delete", "/api/mcp/servers/github", None),
    ("post", "/api/mcp/servers/github/test", None),
    ("put", "/api/mcp/servers/github/enabled", {"enabled": False}),
    ("post", "/api/mcp/servers/github/oauth/start", None),
    ("post", "/api/mcp/servers/github/oauth/redirect", {"url": "?code=x&state=y"}),
    ("post", "/api/mcp/servers/github/oauth/cancel", None),
    ("post", "/api/mcp/catalog/install", {"name": "github"}),
    ("put", "/api/tools/toolsets/web", {"enabled": False}),
    ("put", "/api/tools/toolsets/web/provider", {"provider": "x"}),
    ("put", "/api/tools/toolsets/web/env", {"env": {"K": "V"}}),
    ("post", "/api/tools/toolsets/web/post-setup", {"key": "x"}),
    ("put", "/api/tools/some_tool/enabled", {"enabled": False}),
    ("put", "/api/tools/some_tool/config", {"config": {}}),
    ("post", "/api/tools/some_tool/promote", {}),
    ("post", "/api/tools/computer-use/permissions/grant", None),
]


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    try:
        import hermes_constants

        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    except (ImportError, AttributeError):
        pass
    return tmp_path


@pytest.fixture
def acting(monkeypatch):
    """``acting["as"]`` is the logged-in principal (``None`` → no login)."""
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: state["as"].user_id if state["as"] else "",
    )
    return state


@pytest.fixture
def client(acting):
    try:
        from starlette.testclient import TestClient
    except ImportError:  # pragma: no cover
        pytest.skip("fastapi/starlette not installed")
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def github_server():
    from hermes_cli.mcp_config import _save_mcp_server

    assert _save_mcp_server("github", {"url": "https://api.githubcopilot.com/mcp/"})


def _servers():
    from hermes_cli.mcp_config import _get_mcp_servers

    return _get_mcp_servers()


def _call(client, method, path, body):
    kwargs = {"json": body} if body is not None else {}
    return getattr(client, method)(path, **kwargs)


def test_every_change_route_is_gated():
    """Every non-GET tool/MCP endpoint carries the role check — a new one can't
    slip past it, and the list above covers all of them."""
    from hermes_cli.web_server import _require_tools_manager, app

    gated = set()
    for route in app.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None) or set()
        if not path.startswith(("/api/mcp", "/api/tools")):
            continue
        # A person's own servers: open to every signed-in person, scoped to the
        # caller (tests/hermes_cli/test_personal_mcp.py, test_route_authorization.py).
        if path.startswith("/api/mcp/personal"):
            continue
        for method in methods - {"GET", "HEAD", "OPTIONS"}:
            deps = {d.call for d in route.dependant.dependencies}
            assert _require_tools_manager in deps, f"{method} {path} is not role-gated"
            gated.add((method.lower(), path))
    assert len(gated) == len(CHANGE_ROUTES)


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
@pytest.mark.parametrize("method,path,body", CHANGE_ROUTES)
def test_member_and_viewer_cannot_change_tools(
    client, acting, github_server, who, method, path, body
):
    acting["as"] = who
    resp = _call(client, method, path, body)
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"] == DENIED
    servers = _servers()
    assert set(servers) == {"github"}
    assert servers["github"].get("enabled", True) is not False


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_and_viewer_can_still_read_the_lists(client, acting, github_server, who):
    acting["as"] = who
    resp = client.get("/api/mcp/servers")
    assert resp.status_code == 200
    assert [s["name"] for s in resp.json()["servers"]] == ["github"]
    assert client.get("/api/tools/toolsets").status_code == 200


@pytest.mark.parametrize("who", [OWNER, ADMIN, None], ids=["owner", "admin", "no-login"])
def test_owner_admin_and_operator_can_change_mcp_servers(client, acting, who):
    acting["as"] = who
    resp = client.post(
        "/api/mcp/servers", json={"name": "github", "url": "https://api.githubcopilot.com/mcp/"}
    )
    assert resp.status_code == 200, resp.text
    resp = client.put("/api/mcp/servers/github/enabled", json={"enabled": False})
    assert resp.status_code == 200, resp.text
    assert _servers()["github"]["enabled"] is False
    assert client.delete("/api/mcp/servers/github").status_code == 200
    assert _servers() == {}


@pytest.mark.parametrize("who", [OWNER, ADMIN, None], ids=["owner", "admin", "no-login"])
def test_owner_admin_and_operator_pass_the_gate_on_toolsets(client, acting, who):
    acting["as"] = who
    # Past the role gate, an unknown toolset is the handler's own 400.
    resp = client.put("/api/tools/toolsets/no-such-toolset", json={"enabled": False})
    assert resp.status_code == 400, resp.text


def test_single_user_install_without_datastore_keeps_access(client, acting, monkeypatch):
    from hermes_cli import web_server

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no DSN")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    acting["as"] = MEMBER  # a login subject, but nobody to resolve it against
    resp = client.post(
        "/api/mcp/servers", json={"name": "github", "url": "https://api.githubcopilot.com/mcp/"}
    )
    assert resp.status_code == 200, resp.text
