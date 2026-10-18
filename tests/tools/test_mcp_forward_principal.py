"""``forward_principal`` sends the chat's user to app-mcp in ``_meta`` (F4).

app-mcp routes every UI/Folder Bridge command to the browser session of the
user named here, so the Hermes side must forward it only when configured
and never invent one.
"""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tools.mcp_tool import (
    PRINCIPAL_META_KEY,
    MCPServerTask,
    _forward_principal_setting,
    _make_tool_handler,
    _servers,
)


def _run_direct(coro_or_factory, timeout=30):
    coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
    return asyncio.run(coro)


def _server(forward: bool):
    session = MagicMock()
    session.call_tool = AsyncMock(
        return_value=SimpleNamespace(content=[SimpleNamespace(text="ok")], isError=False)
    )
    server = MCPServerTask("app")
    server.session = session
    server._tools = []
    server.forward_principal = forward
    return server, session


def _call(forward: bool, **kwargs):
    server, session = _server(forward)
    _servers["app"] = server
    try:
        handler = _make_tool_handler("app", "app_state", 30)
        with patch("tools.mcp_tool._run_on_mcp_loop", side_effect=_run_direct):
            out = json.loads(handler({}, **kwargs))
        return out, session.call_tool
    finally:
        _servers.pop("app", None)


def test_forwards_the_principal_when_enabled():
    out, call_tool = _call(True, principal_user_id="u-123")
    assert out["result"] == "ok"
    call_tool.assert_called_once_with(
        "app_state", arguments={}, meta={PRINCIPAL_META_KEY: "u-123"}
    )


def test_never_forwards_when_disabled():
    _, call_tool = _call(False, principal_user_id="u-123")
    call_tool.assert_called_once_with("app_state", arguments={})


def test_no_principal_means_no_meta():
    _, call_tool = _call(True)
    call_tool.assert_called_once_with("app_state", arguments={})


def test_off_before_config_is_read():
    assert MCPServerTask("app").forward_principal is False


@pytest.mark.parametrize(
    "name, config",
    [
        # The live box's entry predates forward_principal: it must keep working.
        ("app", {"url": "http://127.0.0.1:9220/mcp", "timeout": 3600}),
        ("aquarium-ui", {"url": "http://localhost:9220/mcp/"}),
    ],
)
def test_on_by_default_for_app_mcp(name, config):
    assert _forward_principal_setting(name, config) is True


@pytest.mark.parametrize(
    "name, config",
    [
        ("github", {"url": "https://api.githubcopilot.com/mcp/"}),
        ("other", {"url": "http://127.0.0.1:9999/mcp"}),
        ("fs", {"command": "npx", "args": ["@modelcontextprotocol/server-filesystem"]}),
    ],
)
def test_off_by_default_for_other_servers(name, config):
    assert _forward_principal_setting(name, config) is False


def test_explicit_setting_wins():
    assert _forward_principal_setting("app", {"forward_principal": False}) is False
    assert _forward_principal_setting("other", {"forward_principal": "true"}) is True
