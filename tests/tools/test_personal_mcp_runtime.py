"""Per-person MCP tools at chat time: who sees them, who may call them, and
that a chat keeps the tool list it started with (prompt caching)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from tools import mcp_tool, personal_mcp
from tools.registry import registry


def _schema(name):
    return {"name": name, "description": f"{name} tool", "parameters": {"type": "object", "properties": {}}}


@pytest.fixture
def fake_server():
    """Register one personal server for amy as if it had connected."""
    personal_mcp._reset_for_tests()
    server = personal_mcp.internal_name("amy", "notion")
    tool = f"mcp_{server}_search"
    registry.register(
        name=tool,
        toolset=f"mcp-{server}",
        schema=_schema(tool),
        handler=lambda args, **kw: json.dumps({"ok": True}),
        is_async=False,
        description="search",
    )
    mcp_tool._track_mcp_tool_server(tool, server)
    task = SimpleNamespace(_registered_tool_names=[tool], session=object())
    with mcp_tool._lock:
        mcp_tool._servers[server] = task
    with personal_mcp._lock:
        personal_mcp._owners[server] = "amy"
    yield server, tool
    with mcp_tool._lock:
        mcp_tool._servers.pop(server, None)
    registry.deregister(tool)
    mcp_tool._forget_mcp_tool_server(tool)
    personal_mcp._reset_for_tests()


def test_personal_tools_never_come_from_toolsets(fake_server):
    from model_tools import get_tool_definitions

    server, tool = fake_server
    for kwargs in ({}, {"enabled_toolsets": [f"mcp-{server}"]}, {"enabled_toolsets": ["all"]}):
        names = {t["function"]["name"] for t in get_tool_definitions(quiet_mode=True, **kwargs)}
        assert tool not in names, kwargs


def test_only_the_owner_may_call_a_personal_tool(fake_server):
    from model_tools import handle_function_call

    _server, tool = fake_server
    for who in ("ben", None):
        out = json.loads(handle_function_call(tool, {}, principal_user_id=who, principal_role="member"))
        assert "another person" in out["error"], who
    assert personal_mcp.blocked_call_error(tool, "amy") is None
    assert personal_mcp.blocked_call_error("terminal", "ben") is None


def test_shared_mcp_tools_are_not_personal(fake_server):
    assert personal_mcp.owner_of_tool("mcp_app_ui_snapshot") is None
    assert personal_mcp.personal_tool_names(["mcp_app_ui_snapshot", "terminal"]) == set()


def test_internal_names_differ_per_person_and_are_tool_safe():
    a = personal_mcp.internal_name("amy@example.com", "my-notion")
    b = personal_mcp.internal_name("ben@example.com", "my-notion")
    assert a != b
    assert a.endswith("_my_notion") and all(c.isalnum() or c == "_" for c in a)


@pytest.fixture
def db(tmp_path):
    from hermes_state import SessionDB

    d = SessionDB(db_path=tmp_path / "state.db")
    yield d
    d.close()


def test_chat_keeps_the_servers_it_started_with(db):
    personal_mcp._reset_for_tests()
    db.create_session("s1", "api_server", model_config={"max_iterations": 9})
    assert personal_mcp.choose_for_session("s1", "amy", ["notion"], db) == ["notion"]
    stored = json.loads(db.get_session("s1")["model_config"])
    assert stored["max_iterations"] == 9
    assert stored[personal_mcp.SESSION_KEY] == {"user": "amy", "servers": ["notion"]}

    # Amy adds "github" mid-chat: this chat keeps its list (also after a restart).
    personal_mcp._reset_for_tests()
    assert personal_mcp.choose_for_session("s1", "amy", ["github", "notion"], db) == ["notion"]
    # A removed server disappears (it can't be called any more).
    assert personal_mcp.choose_for_session("s1", "amy", ["github"], db) == []
    # A new chat gets everything she has now.
    db.create_session("s2", "api_server")
    assert personal_mcp.choose_for_session("s2", "amy", ["github", "notion"], db) == ["github", "notion"]


def test_choice_for_a_chat_without_a_row_goes_into_its_first_write(db):
    personal_mcp._reset_for_tests()
    init_cfg = {"max_iterations": 9}
    assert personal_mcp.choose_for_session("new", "amy", ["notion"], db, init_cfg) == ["notion"]
    assert init_cfg[personal_mcp.SESSION_KEY] == {"user": "amy", "servers": ["notion"]}
    db.create_session("new", "api_server", model_config=init_cfg)
    personal_mcp._reset_for_tests()
    assert personal_mcp.choose_for_session("new", "amy", ["github", "notion"], db) == ["notion"]


def test_continued_chat_inherits_the_choice(db):
    personal_mcp._reset_for_tests()
    db.create_session("parent", "api_server")
    personal_mcp.choose_for_session("parent", "amy", ["notion"], db)
    db.create_session("child", "api_server", parent_session_id="parent")
    personal_mcp._reset_for_tests()
    assert personal_mcp.choose_for_session("child", "amy", ["github", "notion"], db) == ["notion"]


def test_apply_to_agent_adds_only_the_owners_tools(fake_server, monkeypatch, db):
    server, tool = fake_server
    monkeypatch.setattr(personal_mcp, "_load_user_servers", lambda uid: {"notion": {"url": "https://x"}} if uid == "amy" else {})
    monkeypatch.setattr(personal_mcp, "connect", lambda uid, servers: {"notion": server} if uid == "amy" else {})

    def _agent(uid):
        return SimpleNamespace(
            _internal_user_id=uid, session_id=f"chat-{uid}", _session_db=db,
            _session_init_model_config={}, tools=[{"type": "function", "function": _schema("terminal")}],
        )

    amy = _agent("amy")
    personal_mcp.apply_to_agent(amy)
    assert [t["function"]["name"] for t in amy.tools] == ["terminal", tool]

    for uid in ("ben", None):
        other = _agent(uid)
        personal_mcp.apply_to_agent(other)
        assert [t["function"]["name"] for t in other.tools] == ["terminal"], uid
        assert other._personal_mcp_defs == []


def test_tool_refresh_keeps_the_personal_tools(fake_server, monkeypatch):
    """The between-turns MCP refresh must not drop (or add) personal tools."""
    _server, tool = fake_server
    personal_defs = [{"type": "function", "function": _schema(tool)}]
    agent = SimpleNamespace(
        enabled_toolsets=["todo"], disabled_toolsets=None,
        tools=[{"type": "function", "function": _schema("todo")}] + personal_defs,
        valid_tool_names={"todo", tool}, _personal_mcp_defs=personal_defs,
        _tool_snapshot_generation=-1,
    )
    mcp_tool.refresh_agent_mcp_tools(agent, quiet_mode=True)
    assert tool in {t["function"]["name"] for t in agent.tools}
