"""Settings → Skills permissions: per-profile, per-role skill rows.

Real ``tools.skills_access`` / ``tools.access_policy`` and real config.yaml
under a throwaway ``HERMES_HOME``; only the C1 principal resolver (Postgres)
is stubbed. The page, the API gates and the tool dispatcher must agree.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="vic", display="Vic", role="viewer", is_owner=False)

ALL_ON = {"use": True, "view": True, "agent_edit": True, "manage": True, "lab": True}
MEMBER_DEFAULT = {
    "use": True,
    "view": False,
    "agent_edit": False,
    "manage": False,
    "lab": False,
}


def _write_skill(skills_dir, name):
    d = skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: test skill\n---\n\n# {name}\n",
        encoding="utf-8",
    )


@pytest.fixture
def homes(tmp_path, monkeypatch, _isolate_hermes_home):
    """The default home plus one named profile, each with a skill."""
    from hermes_cli import profiles
    from hermes_constants import get_hermes_home

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    other = profiles_root / "worker_alpha"
    for home in (default_home, other):
        (home / "skills").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
    _write_skill(default_home / "skills", "demo-skill")
    _write_skill(other / "skills", "demo-skill")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": other}


@pytest.fixture
def acting(monkeypatch, homes):
    """``acting["as"]`` is the signed-in principal (``None`` → no login)."""
    from hermes_cli import profile_route_scope, web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    async def _fake_target_principal(conn, entry):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: state["as"].user_id if state["as"] else "",
    )
    monkeypatch.setattr(
        profile_route_scope, "_target_principal", _fake_target_principal
    )
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    import hermes_state
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app
    from hermes_constants import get_hermes_home

    hermes_state.DEFAULT_DB_PATH = get_hermes_home() / "state.db"
    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _row(body, role):
    return next(r for r in body["roles"] if r["role"] == role)


def _config(home):
    import yaml

    return yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}


# ── Defaults and normalisation (pure) ────────────────────────────────────────


def test_defaults_match_todays_behaviour():
    from tools import skills_access
    from tools.access_policy import denied_tools

    assert skills_access.role_actions("owner", {}) == ALL_ON
    assert skills_access.role_actions("admin", {}) == ALL_ON
    assert skills_access.role_actions("member", {}) == MEMBER_DEFAULT
    assert skills_access.role_actions("viewer", {}) == MEMBER_DEFAULT
    # The tool rows are exactly what the dispatcher enforces.
    for user, role in (("mia", "member"), ("vic", "viewer"), ("ann", "admin")):
        denied = denied_tools(user, role)
        rows = skills_access.role_actions(role)
        assert rows["use"] == (
            "skill_view" not in denied and "skills_list" not in denied
        )
        assert rows["agent_edit"] == ("skill_manage" not in denied)


@pytest.mark.parametrize(
    "changes,expected",
    [
        ({"manage": True}, {"view": True, "manage": True}),
        ({"lab": True}, {"view": True, "lab": True}),
        ({"agent_edit": True}, {"use": True, "agent_edit": True}),
        ({"view": False}, {"view": False, "manage": False, "lab": False}),
        ({"use": False}, {"use": False, "agent_edit": False}),
        ({"view": False, "manage": True}, {"view": False, "manage": False}),
    ],
)
def test_implications_are_restored_on_write(changes, expected):
    from tools import skills_access

    start = {"use": True, "view": True, "agent_edit": True, "manage": True, "lab": True}
    if changes.get("manage") or changes.get("lab") or changes.get("agent_edit"):
        start = {
            "use": False,
            "view": False,
            "agent_edit": False,
            "manage": False,
            "lab": False,
        }
    out = skills_access.normalise(start, changes)
    for key, value in expected.items():
        assert out[key] is value, (key, out)


def test_hand_edited_config_fails_closed():
    from tools import skills_access

    cfg = {
        "access": {
            "roles": {
                "member": {"skills": {"view": False, "manage": True, "lab": True}}
            }
        }
    }
    rows = skills_access.role_actions("member", cfg)
    assert rows["manage"] is False and rows["lab"] is False


def test_bad_actions_are_rejected():
    from tools import skills_access

    with pytest.raises(ValueError):
        skills_access.set_role_actions({}, "member", {"fly": True})
    with pytest.raises(ValueError):
        skills_access.set_role_actions({}, "member", {"view": "yes"})
    with pytest.raises(ValueError):
        skills_access.set_role_actions({}, "owner", {"view": False})


# ── GET / PUT / me ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "who", [OWNER, ADMIN, None], ids=["owner", "admin", "no-login"]
)
def test_matrix_shape_and_editable_for_the_caller(client, acting, who):
    acting["as"] = who
    resp = client.get("/api/access/skills")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [a["key"] for a in body["actions"]] == [
        "use",
        "view",
        "agent_edit",
        "manage",
        "lab",
    ]
    assert all(a["label"] and a["description"] for a in body["actions"])
    assert [r["role"] for r in body["roles"]] == ["owner", "admin", "member", "viewer"]
    owner = _row(body, "owner")
    assert owner["locked"] is True and owner["editable"] is False
    assert owner["actions"] == ALL_ON and owner["customised"] is False
    assert _row(body, "admin")["actions"] == ALL_ON
    assert _row(body, "member")["actions"] == MEMBER_DEFAULT
    assert _row(body, "admin")["editable"] is (who is not ADMIN)
    assert _row(body, "member")["editable"] is True
    assert _row(body, "viewer")["editable"] is True


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_members_and_viewers_cannot_read_or_change_the_matrix(client, acting, who):
    acting["as"] = who
    assert client.get("/api/access/skills").status_code == 403
    assert (
        client.put(
            "/api/access/skills/member", json={"actions": {"view": True}}
        ).status_code
        == 403
    )
    assert (
        client.put("/api/access/skills/viewer", json={"reset": True}).status_code == 403
    )
    assert "access" not in _config(acting_home())


def acting_home():
    from hermes_constants import get_hermes_home

    return get_hermes_home()


def test_me_reports_the_callers_own_rows(client, acting):
    acting["as"] = MEMBER
    assert client.get("/api/access/skills/me").json() == {
        "role": "member",
        "actions": MEMBER_DEFAULT,
    }
    acting["as"] = OWNER
    assert client.get("/api/access/skills/me").json() == {
        "role": "owner",
        "actions": ALL_ON,
    }
    acting["as"] = None
    assert client.get("/api/access/skills/me").json()["role"] == "owner"


def test_owner_column_is_locked(client, acting):
    resp = client.put("/api/access/skills/owner", json={"actions": {"view": False}})
    assert resp.status_code == 400
    assert (
        client.put("/api/access/skills/owner", json={"reset": True}).status_code == 400
    )
    assert (
        client.put("/api/access/skills/superuser", json={"reset": True}).status_code
        == 400
    )
    assert (
        client.put(
            "/api/access/skills/member", json={"actions": {"fly": True}}
        ).status_code
        == 400
    )
    assert client.put("/api/access/skills/member", json={}).status_code == 400


def test_admin_column_is_owner_only(client, acting):
    acting["as"] = ADMIN
    resp = client.put("/api/access/skills/admin", json={"actions": {"lab": False}})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Only the owner can change what admins can do."
    acting["as"] = OWNER
    resp = client.put("/api/access/skills/admin", json={"actions": {"lab": False}})
    assert resp.status_code == 200, resp.text
    admin = _row(resp.json(), "admin")
    assert admin["actions"]["lab"] is False and admin["customised"] is True


@pytest.mark.parametrize("who", [OWNER, ADMIN], ids=["owner", "admin"])
def test_owner_and_admin_edit_member_and_viewer(client, acting, who):
    from tools.access_policy import denied_tools

    acting["as"] = who
    resp = client.put(
        "/api/access/skills/member",
        json={"actions": {"manage": True, "agent_edit": True}},
    )
    assert resp.status_code == 200, resp.text
    member = _row(resp.json(), "member")
    assert member["actions"] == {
        "use": True,
        "view": True,
        "agent_edit": True,
        "manage": True,
        "lab": False,
    }
    assert member["customised"] is True
    stored = _config(acting_home())["access"]["roles"]["member"]
    assert stored["skills"] == {"view": True, "manage": True, "lab": False}
    assert "skill_manage" not in denied_tools("mia", "member")
    # Other tool limits are untouched.
    assert "terminal" in denied_tools("mia", "member")

    resp = client.put("/api/access/skills/viewer", json={"actions": {"use": False}})
    assert resp.status_code == 200
    assert _row(resp.json(), "viewer")["actions"]["use"] is False
    assert {"skills_list", "skill_view", "skill_manage"} <= denied_tools(
        "vic", "viewer"
    )

    resp = client.put("/api/access/skills/member", json={"reset": True})
    assert _row(resp.json(), "member")["actions"] == MEMBER_DEFAULT
    assert _row(resp.json(), "member")["customised"] is False
    assert "member" not in (_config(acting_home()).get("access") or {}).get("roles", {})


def test_the_tools_grid_sees_the_same_tool_rows(client, acting):
    client.put("/api/access/skills/member", json={"actions": {"use": False}})
    roles = client.get("/api/access/roles").json()["roles"]
    member = next(r for r in roles if r["role"] == "member")
    assert {"skills_list", "skill_view"} <= set(member["blocked_tools"])
    # ... and a change in the tools grid shows up here.
    client.put("/api/access/roles/member", json={"deny_tools": []})
    acting["as"] = OWNER
    rows = _row(client.get("/api/access/skills").json(), "member")["actions"]
    assert rows["use"] is True and rows["agent_edit"] is True


# ── Enforcement on the skills routes ─────────────────────────────────────────

VIEW_ROUTES = [
    ("get", "/api/skills", None),
    ("get", "/api/skills/content?name=demo-skill", None),
]
MANAGE_ROUTES = [
    ("put", "/api/skills/toggle", {"name": "demo-skill", "enabled": False}),
    (
        "post",
        "/api/skills",
        {
            "name": "new-skill",
            "content": "---\nname: new-skill\ndescription: x.\n---\n# x\n",
        },
    ),
    (
        "put",
        "/api/skills/content",
        {
            "name": "demo-skill",
            "content": "---\nname: demo-skill\ndescription: y.\n---\n# y\n",
        },
    ),
    ("get", "/api/skills/details?name=demo-skill", None),
    ("post", "/api/skills/hub/install", {"identifier": "x"}),
    ("post", "/api/skills/hub/uninstall", {"name": "x"}),
    ("post", "/api/skills/hub/update", {}),
]
LAB_ROUTES = [
    ("get", "/api/skills/usage", None),
    ("get", "/api/skills/versions?name=demo-skill", None),
    ("get", "/api/skills/improve/sessions", None),
]
_SPAWNING = {
    "/api/skills/hub/install",
    "/api/skills/hub/uninstall",
    "/api/skills/hub/update",
}


def _call(client, method, path, body):
    if body is None:
        return client.request(method.upper(), path)
    return client.request(method.upper(), path, json=body)


@pytest.mark.parametrize(
    "method,path,body",
    VIEW_ROUTES + MANAGE_ROUTES + LAB_ROUTES,
    ids=[f"{m} {p}" for m, p, _ in VIEW_ROUTES + MANAGE_ROUTES + LAB_ROUTES],
)
@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_defaults_refuse_members_and_viewers(client, acting, who, method, path, body):
    acting["as"] = who
    resp = _call(client, method, path, body)
    assert resp.status_code == 403, (path, resp.status_code, resp.text[:200])


@pytest.fixture
def no_spawn(monkeypatch):
    from hermes_cli import web_server

    monkeypatch.setattr(
        web_server, "_spawn_hermes_action", lambda args, name: SimpleNamespace(pid=1)
    )


@pytest.mark.parametrize(
    "row,routes",
    [("view", VIEW_ROUTES), ("manage", MANAGE_ROUTES), ("lab", LAB_ROUTES)],
)
def test_owner_enabling_a_row_lets_the_member_in(client, acting, no_spawn, row, routes):
    acting["as"] = OWNER
    assert (
        client.put(
            "/api/access/skills/member", json={"actions": {row: True}}
        ).status_code
        == 200
    )
    acting["as"] = MEMBER
    for method, path, body in routes:
        resp = _call(client, method, path, body)
        assert resp.status_code != 403, (path, resp.text[:200])
        assert resp.status_code < 500 or path in _SPAWNING, (path, resp.text[:200])
    # Viewers keep their own (default) column.
    acting["as"] = VIEWER
    method, path, body = routes[0]
    assert _call(client, method, path, body).status_code == 403


def test_owner_turning_admin_rows_off_takes_effect_next_request(client, acting):
    acting["as"] = ADMIN
    assert client.get("/api/skills").status_code == 200
    acting["as"] = OWNER
    client.put("/api/access/skills/admin", json={"actions": {"view": False}})
    acting["as"] = ADMIN
    assert client.get("/api/skills").status_code == 403
    assert client.get("/api/skills/usage").status_code == 403
    # The owner always passes.
    acting["as"] = OWNER
    assert client.get("/api/skills").status_code == 200


# ── Tools: use / agent_edit ──────────────────────────────────────────────────


def test_tool_rows_reach_the_dispatcher(client, acting):
    from model_tools import handle_function_call

    def call(tool):
        return json.loads(
            handle_function_call(
                tool, {}, principal_user_id="mia", principal_role="member"
            )
        )

    assert "not available to your role" in call("skill_manage").get("error", "")
    assert "not available to your role" not in str(call("skills_list"))

    client.put("/api/access/skills/member", json={"actions": {"agent_edit": True}})
    assert "not available to your role" not in str(call("skill_manage"))

    client.put("/api/access/skills/member", json={"actions": {"use": False}})
    for tool in ("skills_list", "skill_view", "skill_manage"):
        assert "not available to your role" in call(tool).get("error", ""), tool


# ── Profile scoping ──────────────────────────────────────────────────────────


def test_a_change_in_one_profile_leaves_the_other_alone(client, acting, homes):
    acting["as"] = OWNER
    resp = client.put(
        "/api/access/skills/member?profile=worker_alpha",
        json={"actions": {"view": True}},
    )
    assert resp.status_code == 200, resp.text
    assert (
        _config(homes["worker_alpha"])["access"]["roles"]["member"]["skills"]["view"]
        is True
    )
    assert "access" not in _config(homes["default"])
    other = client.get("/api/access/skills?profile=worker_alpha").json()
    assert _row(other, "member")["actions"]["view"] is True
    here = client.get("/api/access/skills").json()
    assert _row(here, "member")["actions"]["view"] is False

    acting["as"] = MEMBER
    assert client.get("/api/skills?profile=worker_alpha").status_code == 200
    assert client.get("/api/skills").status_code == 403
    assert (
        client.get("/api/access/skills/me?profile=worker_alpha").json()["actions"][
            "view"
        ]
        is True
    )
    assert client.get("/api/access/skills/me").json()["actions"]["view"] is False
