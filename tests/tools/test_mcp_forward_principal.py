"""``forward_principal`` sends the chat's user to app-mcp in ``_meta`` (F4).

app-mcp routes every UI/Folder Bridge command to the browser session of the
user named here, so the Hermes side must forward it only when configured
and never invent one.
"""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from tools.mcp_tool import PRINCIPAL_META_KEY, MCPServerTask, _make_tool_handler, _servers


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


def test_off_by_default():
    assert MCPServerTask("app").forward_principal is False
