"""Settings → Menu: which agent-home menu items each role sees.

Real ``hermes_cli.agent_home_nav`` and real config.yaml under a throwaway
``HERMES_HOME`` (the default profile); only the C1 principal resolver is
stubbed. Only owner/admin may change the lists, the owner always sees every
item, and home/settings can never be hidden.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="vic", display="Vic", role="viewer", is_owner=False)

# Profiles is locked hidden for members and viewers (Skills follows the
# role's Skills permission instead).
LOCKED_OFF = ["profiles"]


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def acting(monkeypatch):
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
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _saved_nav():
    from hermes_cli.config import load_config

    return (load_config().get("agent_home") or {}).get("nav")


def test_defaults_hide_only_admin_only_apps_from_members_and_viewers(client, acting):
    for who, hidden in ((OWNER, []), (ADMIN, []), (MEMBER, LOCKED_OFF), (VIEWER, LOCKED_OFF)):
        acting["as"] = who
        body = client.get("/api/agent-home/nav").json()
        assert body["hidden"] == hidden
        assert body["role"] == who.role
        assert set(body["locked"]) == {"home", "settings"}


@pytest.mark.parametrize("who", [OWNER, ADMIN], ids=["owner", "admin"])
def test_owner_and_admin_save_a_role_list(client, acting, who):
    acting["as"] = who
    resp = client.put("/api/agent-home/nav/member", json={"hidden": ["graph", "core"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["roles"]["member"] == ["graph", "core", *LOCKED_OFF]
    assert _saved_nav() == {"roles": {"member": {"hidden": ["graph", "core", *LOCKED_OFF]}}}


def test_each_role_gets_its_own_effective_list(client, acting):
    client.put("/api/agent-home/nav/member", json={"hidden": ["graph"]})
    client.put("/api/agent-home/nav/viewer", json={"hidden": ["graph", "tools"]})
    client.put("/api/agent-home/nav/admin", json={"hidden": ["core"]})
    expected = [
        (OWNER, []),
        (ADMIN, ["core"]),
        (MEMBER, ["graph", *LOCKED_OFF]),
        (VIEWER, ["graph", "tools", *LOCKED_OFF]),
    ]
    for who, hidden in expected:
        acting["as"] = who
        assert client.get("/api/agent-home/nav").json()["hidden"] == hidden, who.role


def test_per_role_lists_only_for_owner_and_admin(client, acting):
    client.put("/api/agent-home/nav/viewer", json={"hidden": ["tools"]})
    for who in (OWNER, ADMIN):
        acting["as"] = who
        assert client.get("/api/agent-home/nav").json()["roles"]["viewer"] == ["tools", *LOCKED_OFF]
    for who in (MEMBER, VIEWER):
        acting["as"] = who
        assert "roles" not in client.get("/api/agent-home/nav").json()


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_and_viewer_cannot_change_the_menu(client, acting, who):
    acting["as"] = who
    resp = client.put("/api/agent-home/nav/member", json={"hidden": ["graph"]})
    assert resp.status_code == 403
    assert _saved_nav() is None


@pytest.mark.parametrize(
    "role,hidden",
    [
        ("member", ["nope"]),
        ("member", ["graph", "graph"]),
        ("member", ["home"]),
        ("viewer", ["settings"]),
        ("owner", ["home"]),
        ("stranger", []),
    ],
    ids=["unknown-id", "duplicate", "home-locked", "settings-locked", "owner-home-locked", "unknown-role"],
)
def test_bad_lists_are_rejected(client, acting, role, hidden):
    resp = client.put(f"/api/agent-home/nav/{role}", json={"hidden": hidden})
    assert resp.status_code == 400, resp.text
    assert _saved_nav() is None


def test_owner_has_an_own_list_only_the_owner_can_change(client, acting):
    resp = client.put("/api/agent-home/nav/owner", json={"hidden": ["graph", "profiles"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["roles"]["owner"] == ["graph", "profiles"]
    assert client.get("/api/agent-home/nav").json()["hidden"] == ["graph", "profiles"]
    acting["as"] = ADMIN
    assert client.get("/api/agent-home/nav").json()["roles"]["owner"] == ["graph", "profiles"]
    resp = client.put("/api/agent-home/nav/owner", json={"hidden": []})
    assert resp.status_code == 403
    assert _saved_nav()["roles"]["owner"]["hidden"] == ["graph", "profiles"]
    assert client.get("/api/agent-home/nav").json()["hidden"] == []


def test_hand_edited_config_cannot_hide_locked_or_unknown_items(client, acting):
    from hermes_cli.config import load_config, save_config

    cfg = load_config()
    cfg["agent_home"] = {"nav": {"roles": {"member": {"hidden": ["home", "x", "graph", "settings"]}}}}
    save_config(cfg)
    acting["as"] = MEMBER
    assert client.get("/api/agent-home/nav").json()["hidden"] == ["graph", *LOCKED_OFF]


@pytest.mark.parametrize("role", ["member", "viewer"])
def test_admin_only_apps_cannot_be_shown_to_members_or_viewers(client, acting, role):
    resp = client.put(f"/api/agent-home/nav/{role}", json={"hidden": []})
    assert resp.status_code == 200, resp.text
    assert resp.json()["roles"][role] == LOCKED_OFF
    assert _saved_nav()["roles"][role]["hidden"] == LOCKED_OFF


def test_admin_only_apps_stay_optional_for_admins(client, acting):
    resp = client.put("/api/agent-home/nav/admin", json={"hidden": ["skills"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["roles"]["admin"] == ["skills"]
    assert client.put("/api/agent-home/nav/admin", json={"hidden": []}).json()["roles"]["admin"] == []


def test_operator_without_datastore_is_the_owner(client, monkeypatch):
    from hermes_cli import web_server

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no datastore")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "")
    body = client.get("/api/agent-home/nav").json()
    assert body["is_owner"] is True and body["hidden"] == []
    assert client.put("/api/agent-home/nav/viewer", json={"hidden": ["core"]}).status_code == 200
