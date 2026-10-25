"""FG-33 app MCPs from the endpoint registry: which chats get them, that a chat
keeps the app tools it started with, and that app actions need approval."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hermes_cli.mcp_endpoints import (
    MCPEndpoint,
    _check_app_fields,
    _row_to_endpoint,
    _validate_transport,
)
from tools import mcp_tool, registry_mcp
from tools.registry import registry

mcp_types = pytest.importorskip("mcp.types")


def _tool(name, **annotations):
    return mcp_types.Tool(
        name=name,
        description=f"{name} tool",
        inputSchema={"type": "object", "properties": {}},
        annotations=mcp_types.ToolAnnotations(**annotations) if annotations else None,
    )


@pytest.fixture
def app_server():
    """A connected ``la-notes`` app server resolved for amy's chats."""
    registry_mcp._reset_for_tests()
    name = "la-notes"
    with registry_mcp._lock:
        registry_mcp._grants[name] = {"amy"}
    server = mcp_tool.MCPServerTask(name)
    server.session = object()
    server._tools = [
        _tool("list_notes", readOnlyHint=True),
        _tool("action_add_note"),
        _tool("wipe", destructiveHint=True),
    ]
    names = mcp_tool._register_server_tools(
        name, server, {"tools": {"resources": False, "prompts": False}}
    )
    server._registered_tool_names = names
    with mcp_tool._lock:
        mcp_tool._servers[name] = server
    yield name, {n.rsplit("_notes_", 1)[1]: n for n in names}
    with mcp_tool._lock:
        mcp_tool._servers.pop(name, None)
    for tool in names:
        registry.deregister(tool)
        mcp_tool._forget_mcp_tool_server(tool)
    registry_mcp._reset_for_tests()


def _call(tool, user="amy"):
    from model_tools import handle_function_call

    return json.loads(handle_function_call(tool, {}, principal_user_id=user))


# -- who sees and calls app tools ------------------------------------------------


def test_app_tools_never_come_from_toolsets(app_server):
    from model_tools import get_tool_definitions

    name, tools = app_server
    for kwargs in ({}, {"enabled_toolsets": [f"mcp-{name}"]}, {"enabled_toolsets": ["all"]}):
        listed = {t["function"]["name"] for t in get_tool_definitions(quiet_mode=True, **kwargs)}
        assert not listed & set(tools.values()), kwargs


def test_only_people_the_app_was_resolved_for_may_call_it(app_server):
    _name, tools = app_server
    for who in ("ben", None):
        assert "not set up for this chat" in _call(tools["list_notes"], who)["error"]
    assert "not set up for this chat" not in json.dumps(_call(tools["list_notes"], "amy"))


# -- app actions need approval ------------------------------------------------------


@pytest.mark.parametrize("which", ["action_add_note", "wipe"])
def test_app_actions_are_refused_without_approval(app_server, which):
    _name, tools = app_server
    with patch(
        "tools.approval.request_elicitation_consent_detailed",
        return_value=("decline", "user_denied"),
    ) as ask:
        result = _call(tools[which])
    assert ask.called
    assert "not approved" in result["error"]


def test_app_action_gate_fails_closed(app_server):
    _name, tools = app_server
    with patch(
        "tools.approval.request_elicitation_consent_detailed",
        side_effect=RuntimeError("approval machinery down"),
    ):
        assert "not approved" in _call(tools["wipe"])["error"]


def test_app_action_runs_once_approved_and_read_only_tools_never_ask(app_server):
    _name, tools = app_server
    with patch(
        "tools.approval.request_elicitation_consent_detailed",
        return_value=("accept", "approved"),
    ) as ask:
        approved = _call(tools["action_add_note"])
        read = _call(tools["list_notes"])
    assert ask.call_count == 1
    assert "not approved" not in json.dumps(approved)
    assert "not approved" not in json.dumps(read)


def test_only_app_servers_get_the_mutation_gate():
    wipe = _tool("wipe", destructiveHint=True)
    action = _tool("action_go")
    assert mcp_tool._app_tool_needs_approval("xa-shop", wipe)
    assert mcp_tool._app_tool_needs_approval("la-notes", action)
    assert not mcp_tool._app_tool_needs_approval("la-notes", _tool("list", destructiveHint=False))
    assert not mcp_tool._app_tool_needs_approval("github", wipe)
    assert not mcp_tool._app_tool_needs_approval("app", action)


# -- next chat only ----------------------------------------------------------------


async def _notify_list_changed(server_name):
    note = mcp_types.ServerNotification(
        root=mcp_types.ToolListChangedNotification(method="notifications/tools/list_changed")
    )
    with patch.object(mcp_tool.MCPServerTask, "_schedule_tools_refresh") as refresh:
        await mcp_tool.MCPServerTask(server_name)._make_message_handler()(note)
    return refresh.called


@pytest.mark.asyncio
async def test_app_tool_list_changes_are_not_applied_to_live_chats():
    assert not await _notify_list_changed("la-notes")
    assert not await _notify_list_changed("xa-shop")
    assert await _notify_list_changed("github")


class _FakeDb:
    def __init__(self):
        self.rows = {}

    def get_session(self, sid):
        return self.rows.get(sid)

    def update_session_meta(self, sid, model_config):
        self.rows[sid]["model_config"] = model_config


@pytest.fixture
def clean_registry_mcp():
    registry_mcp._reset_for_tests()
    yield
    registry_mcp._reset_for_tests()


def test_a_chat_keeps_the_apps_it_started_with(clean_registry_mcp):
    db = _FakeDb()
    db.rows["s1"] = {"model_config": None, "parent_session_id": None}
    assert registry_mcp.choose_for_session("s1", "amy", ["la-a"], db) == ["la-a"]
    pinned = json.loads(db.rows["s1"]["model_config"])[registry_mcp.SESSION_KEY]
    assert pinned == {"user": "amy", "servers": ["la-a"]}

    registry_mcp._reset_for_tests()  # a restarted process reads the pin back
    assert registry_mcp.choose_for_session("s1", "amy", ["la-a", "xa-b"], db) == ["la-a"]
    # An app switched off (or no longer visible) drops out.
    assert registry_mcp.choose_for_session("s1", "amy", ["xa-b"], db) == []

    db.rows["s2"] = {"model_config": None, "parent_session_id": None}
    assert registry_mcp.choose_for_session("s2", "amy", ["la-a", "xa-b"], db) == ["la-a", "xa-b"]


def test_a_new_chat_row_gets_the_pin_from_the_agent(clean_registry_mcp):
    pending = {}
    chosen = registry_mcp.choose_for_session("new", "amy", ["la-a"], _FakeDb(), pending)
    assert chosen == ["la-a"]
    assert pending[registry_mcp.SESSION_KEY] == {"user": "amy", "servers": ["la-a"]}


def _agent(**extra):
    base = dict(
        _internal_user_id="amy",
        _internal_user_role="member",
        platform="cli",
        session_id=None,
        _session_db=None,
        _session_init_model_config=None,
        tools=[{"type": "function", "function": {"name": "terminal"}}],
    )
    base.update(extra)
    return SimpleNamespace(**base)


def test_chat_start_adds_every_visible_enabled_app_and_refresh_keeps_them(app_server):
    name, tools = app_server
    agent = _agent()
    with patch.object(
        registry_mcp, "load_endpoint_configs", return_value={name: {"url": "http://x/mcp"}}
    ) as load, patch.object(registry_mcp, "connect", return_value=[name]):
        registry_mcp.apply_registry_endpoints(agent)
    assert load.call_args.args[:2] == ("amy", "member")
    have = {t["function"]["name"] for t in agent.tools}
    assert set(tools.values()) <= have and "terminal" in have

    rebuilt, names = [], set()
    registry_mcp.reinject(agent, rebuilt, names)
    assert names == set(tools.values())


def test_a_chat_without_a_known_person_gets_no_apps(clean_registry_mcp):
    agent = _agent(_internal_user_id=None)
    with patch.object(registry_mcp, "load_endpoint_configs") as load:
        registry_mcp.apply_registry_endpoints(agent)
    assert not load.called
    assert agent._registry_mcp_defs == []


def test_chat_start_survives_an_unreachable_registry(clean_registry_mcp):
    agent = _agent()
    with patch.object(registry_mcp, "load_endpoint_configs", side_effect=OSError("db down")):
        registry_mcp.apply_registry_endpoints(agent)
    assert agent._registry_mcp_defs == []
    assert [t["function"]["name"] for t in agent.tools] == ["terminal"]


def test_channel_chats_read_production_endpoints():
    assert registry_mcp._mode_for("telegram") == "prod"


def test_only_app_endpoints_reach_chats():
    class _Registry:
        def __init__(self, store):
            pass

        async def resolve_server_configs(self, principal, *, apps_only=False):
            assert apps_only and principal.user_id == "amy"
            return {"la-a": {"url": "u"}, "tool-x": {"command": "node"}}

    with patch("hermes_cli.mcp_endpoints.MCPEndpointRegistry", _Registry), patch(
        "hermes_cli.datastore.get_store", return_value=object()
    ):
        assert registry_mcp.load_endpoint_configs("amy", "member", "prod") == {
            "la-a": {"url": "u"}
        }


# -- endpoint rows and transport ----------------------------------------------------


def test_transport_auth_names_a_type_not_a_token():
    assert _validate_transport({"type": "http", "url": "u", "auth": "Bearer"})["auth"] == "bearer"
    assert _validate_transport({"type": "http", "url": "u", "auth": "oauth"})["auth"] == "oauth"
    with pytest.raises(ValueError, match="auth type"):
        _validate_transport({"type": "http", "url": "u", "auth": "sk-live-abc123"})


def _ep(name="xa-shop", **kw):
    fields = dict(
        id="mep_1",
        name=name,
        kind="remote",
        transport={"type": "http", "url": "https://shop/mcp", "auth": "bearer"},
        owner_user_id="amy",
        visibility="shared",
        mode="prod",
    )
    fields.update(kw)
    return MCPEndpoint(**fields)


def test_bearer_endpoint_config_names_the_secret_never_the_token():
    cfg = _ep(app_kind="external", secret_ref="xa-shop.token", forward_principal=True).to_server_config()
    assert cfg == {
        "url": "https://shop/mcp",
        "secret_ref": "xa-shop.token",
        "forward_principal": True,
    }
    assert "auth" not in cfg  # the client reads auth as the OAuth switch


def test_app_names_carry_their_kind():
    http = {"type": "http", "url": "u"}
    _check_app_fields("la-notes", "local", None, http)
    _check_app_fields("tool-x", None, None, http)
    for name, kind in (("la-notes", "external"), ("la-notes", None), ("notes", "local"), ("xa-s", "local")):
        with pytest.raises(ValueError):
            _check_app_fields(name, kind, None, http)
    with pytest.raises(ValueError, match="secret_ref"):
        _check_app_fields("xa-s", "external", None, {**http, "auth": "bearer"})
    with pytest.raises(ValueError, match="secret_ref"):
        _check_app_fields("xa-s", "external", "../etc/passwd", http)


def test_rows_from_before_fg33_read_as_enabled_non_app_endpoints():
    row = {
        "id": "mep_1",
        "name": "tool-x",
        "kind": "in_house",
        "transport": json.dumps({"type": "stdio", "command": "node"}),
        "owner_user_id": "amy",
        "visibility": "shared",
        "mode": "prod",
    }
    ep = _row_to_endpoint(row)  # type: ignore[arg-type]
    assert ep.enabled and ep.app_kind is None and ep.secret_ref is None
    assert not ep.forward_principal


def test_secret_ref_sends_its_token_as_bearer(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    secrets = tmp_path / "auth" / "mcp-secrets"
    secrets.mkdir(parents=True)
    (secrets / "xa-shop.token").write_text("tok123\n", encoding="utf-8")

    headers: dict = {}
    mcp_tool._add_secret_ref_token("xa-shop", {"secret_ref": "xa-shop.token"}, headers)
    assert headers == {"Authorization": "Bearer tok123"}

    kept = {"authorization": "Bearer mine"}
    mcp_tool._add_secret_ref_token("xa-shop", {"secret_ref": "xa-shop.token"}, kept)
    assert kept == {"authorization": "Bearer mine"}

    for ref in ("../../etc/passwd", "missing"):
        empty: dict = {}
        mcp_tool._add_secret_ref_token("xa-shop", {"secret_ref": ref}, empty)
        assert empty == {}
