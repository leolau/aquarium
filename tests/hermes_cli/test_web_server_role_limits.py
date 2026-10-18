"""Settings → "What each role can use": read and edit per-role tool limits.

Real ``tools.access_policy`` and real config.yaml under a throwaway
``HERMES_HOME``; only the C1 principal resolver (Postgres) is stubbed. The
page's view must match what the dispatcher enforces (``denied_tools``), only
the owner or an admin may change it, and the owner row is locked.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="vic", display="Vic", role="viewer", is_owner=False)


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def acting(monkeypatch):
    """``acting["as"]`` is the logged-in principal."""
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server, "_comms_session_subject", lambda request: state["as"].user_id
    )
    return state


@pytest.fixture
def client(acting):
    try:
        from starlette.testclient import TestClient
    except ImportError:  # pragma: no cover
        pytest.skip("fastapi/starlette not installed")
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _role(body, name):
    return next(r for r in body["roles"] if r["role"] == name)


def _group(role, name):
    return next(g for g in role["groups"] if g["name"] == name)


def _saved_access():
    from hermes_cli.config import load_config

    return load_config().get("access")


def test_defaults_match_what_the_dispatcher_enforces(client):
    from tools.access_policy import denied_tools

    resp = client.get("/api/access/roles")
    assert resp.status_code == 200
    body = resp.json()
    assert [r["role"] for r in body["roles"]] == ["owner", "admin", "member", "viewer"]
    for role, user in (("owner", "root"), ("admin", "ann"), ("member", "mia"), ("viewer", "vic")):
        row = _role(body, role)
        assert set(row["blocked_tools"]) == set(denied_tools(user, role))
        assert row["customised"] is False

    owner = _role(body, "owner")
    assert owner["locked"] is True and owner["files"] == "any"
    assert all(g["state"] == "allowed" for g in owner["groups"])

    member = _role(body, "member")
    assert member["files"] == "own_folder"
    assert _group(member, "terminal")["state"] == "blocked"
    assert _group(member, "terminal")["risky"] is True
    assert _group(member, "code_execution")["state"] == "blocked"
    assert _group(member, "browser")["state"] == "allowed"
    assert "can't use the terminal" in member["summary"]
    assert "run code" in member["summary"]

    viewer = _role(body, "viewer")
    assert _group(viewer, "file")["state"] == "partial"
    assert set(_group(viewer, "file")["blocked_tools"]) == {"write_file", "patch"}


@pytest.mark.parametrize("who", [OWNER, ADMIN])
def test_owner_and_admin_can_change_a_role(client, acting, who):
    from tools.access_policy import denied_tools

    acting["as"] = who
    resp = client.put("/api/access/roles/member", json={"deny_tools": ["terminal", "process", "read_terminal", "close_terminal", "browser"]})
    assert resp.status_code == 200, resp.text
    member = _role(resp.json(), "member")
    assert member["customised"] is True
    assert _group(member, "browser")["state"] == "blocked"
    assert _group(member, "code_execution")["state"] == "allowed"
    # Whole groups are written by their toolset name.
    stored = _saved_access()["roles"]["member"]["deny_tools"]
    assert "browser" in stored and "terminal" in stored
    assert "browser_click" not in stored
    # The dispatcher sees the same limits as the page.
    denied = denied_tools("mia", "member")
    assert "browser_click" in denied and "execute_code" not in denied


@pytest.mark.parametrize("who", [MEMBER, VIEWER])
def test_members_and_viewers_cannot_change_limits(client, acting, who):
    acting["as"] = who
    resp = client.put("/api/access/roles/member", json={"deny_tools": []})
    assert resp.status_code == 403
    assert _saved_access() in (None, {})
    # ... but can still read them.
    assert client.get("/api/access/roles").status_code == 200


def test_owner_row_is_locked(client):
    resp = client.put("/api/access/roles/owner", json={"deny_tools": ["terminal"]})
    assert resp.status_code == 400
    assert client.put("/api/access/roles/owner", json={"reset": True}).status_code == 400
    assert _saved_access() in (None, {})


def test_rejects_unknown_role_and_bad_names(client):
    assert client.put("/api/access/roles/superuser", json={"deny_tools": []}).status_code == 400
    assert client.put("/api/access/roles/member", json={"deny_tools": ["rm -rf /"]}).status_code == 400
    assert client.put("/api/access/roles/member", json={}).status_code == 400


def test_reset_restores_defaults_and_keeps_other_settings(client):
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    cfg["access"] = {"roles": {"member": {"deny_tools": [], "files": "any"}}}
    save_config(cfg)
    assert "terminal" not in _role(client.get("/api/access/roles").json(), "member")["blocked_tools"]

    resp = client.put("/api/access/roles/member", json={"reset": True})
    assert resp.status_code == 200
    member = _role(resp.json(), "member")
    assert member["customised"] is False
    assert "terminal" in member["blocked_tools"]
    # The file rule is a separate setting and survives the reset.
    assert member["files"] == "any" and member["files_customised"] is True
    assert _saved_access() == {"roles": {"member": {"files": "any"}}}


def test_allowing_everything_is_stored_as_an_empty_list(client):
    resp = client.put("/api/access/roles/viewer", json={"deny_tools": []})
    assert resp.status_code == 200
    viewer = _role(resp.json(), "viewer")
    assert viewer["blocked_tools"] == [] and viewer["customised"] is True
    assert _saved_access()["roles"]["viewer"]["deny_tools"] == []


def test_no_login_operator_acts_as_owner_without_datastore(client, monkeypatch):
    from hermes_cli import web_server

    async def _not_configured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no datastore")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _not_configured)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "")
    resp = client.put("/api/access/roles/member", json={"deny_tools": ["terminal"]})
    assert resp.status_code == 200
