"""app_act / app_describe_page through a real in-memory MCP client (F4).

The fake browser plays the agent-home bridge: it answers snapshot commands
with a fixed element list and records every other command it receives, so
the tests can assert what the browser would really have been told to do.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from app_mcp import server

LEO = "leo_owner"

ELEMENTS = [
    {"id": 1, "role": "button", "name": "Rename", "tag": "button", "selector": "#rename"},
    {"id": 2, "role": "button", "name": "Delete project", "tag": "button", "selector": "#del"},
    {"id": 3, "role": "textbox", "name": "Password", "tag": "input", "selector": "#pw",
     "value": "hunter2"},
    {"id": 4, "role": "textbox", "name": "Title", "tag": "input", "selector": "#title",
     "value": "Ship it"},
    {"id": 5, "role": "button", "name": "", "tag": "button", "selector": "#icon"},
    {"id": 6, "role": "button", "name": "Open", "tag": "button", "selector": "div > button"},
    {"id": 7, "role": "button", "name": "Open", "tag": "button", "selector": "#open2"},
]


class FakeBrowser:
    def __init__(self, hub, elements: list[dict[str, Any]]):
        self.hub = hub
        self.elements = elements
        self.commands: list[dict[str, Any]] = []

    async def send(self, message: str) -> None:
        msg = json.loads(message)
        command = msg["command"]
        if command["type"] == "snapshot":
            payload = {"ok": True, "detail": "snap", "elements": self.elements}
        else:
            self.commands.append(command)
            payload = {"ok": True, "detail": f"did {command['type']}"}
        asyncio.get_running_loop().call_soon(
            self.hub.resolve_result, self, msg["id"], payload
        )


@pytest.fixture
def leo_browser():
    browser = FakeBrowser(server.hub, ELEMENTS)
    server.hub.attach(browser, LEO)
    yield browser
    server.hub.detach(browser)


async def _call(tool: str, args: dict[str, Any], user: str | None = LEO) -> dict[str, Any]:
    meta = {server.PRINCIPAL_META_KEY: user} if user else None
    async with create_connected_server_and_client_session(server.mcp) as client:
        result = await client.call_tool(tool, args, meta=meta)
    return json.loads(result.content[0].text)


def call(tool: str, args: dict[str, Any], user: str | None = LEO) -> dict[str, Any]:
    return asyncio.run(_call(tool, args, user))


def test_safe_click_sends_only_the_resolved_id(leo_browser):
    res = call("app_act", {"action": "click", "name": "rename"})
    assert res["ok"] is True
    assert leo_browser.commands == [{"type": "click", "elementId": 1, "expectName": "Rename"}]


def test_misleading_name_with_a_destructive_id_is_refused(leo_browser):
    """Before: a supplied name short-circuited the guard and the id was clicked."""
    res = call("app_act", {"action": "click", "element_id": 2, "name": "Rename"})
    assert res["ok"] is False
    assert leo_browser.commands == []


def test_destructive_id_is_refused(leo_browser):
    res = call("app_act", {"action": "click", "element_id": 2})
    assert res["ok"] is False and "app_act_destructive" in res["detail"]
    assert leo_browser.commands == []


def test_noncanonical_selector_cannot_bypass_the_guard(leo_browser):
    """Before: a selector not equal to the snapshot's string skipped the guard
    and the browser then resolved it to the destructive button."""
    res = call("app_act", {"action": "click", "selector": "button#del"})
    assert res["ok"] is False
    assert leo_browser.commands == []


def test_canonical_selector_to_destructive_element_is_refused(leo_browser):
    res = call("app_act", {"action": "click", "selector": "#del"})
    assert res["ok"] is False and res["element"] == "Delete project"
    assert leo_browser.commands == []


def test_ambiguous_name_is_refused(leo_browser):
    res = call("app_act", {"action": "click", "name": "Open"})
    assert res["ok"] is False and "element_id" in res["detail"]
    assert leo_browser.commands == []


def test_unnamed_control_needs_the_destructive_tool(leo_browser):
    res = call("app_act", {"action": "click", "element_id": 5})
    assert res["ok"] is False
    assert leo_browser.commands == []


def test_destructive_tool_still_acts_on_the_resolved_element(leo_browser):
    res = call("app_act_destructive", {"action": "click", "element_id": 2})
    assert res["ok"] is True
    assert leo_browser.commands == [
        {"type": "click", "elementId": 2, "expectName": "Delete project"}
    ]


def test_type_into_a_field_still_works(leo_browser):
    res = call("app_act", {"action": "type", "element_id": 4, "value": "Ship it now"})
    assert res["ok"] is True
    assert leo_browser.commands[0]["value"] == "Ship it now"


def test_describe_page_redacts_secret_values(leo_browser):
    res = call("app_describe_page", {})
    assert res["ok"] is True
    pw = next(e for e in res["elements"] if e["id"] == 3)
    assert "value" not in pw and pw["sensitive"] is True
    assert "hunter2" not in json.dumps(res)
    assert next(e for e in res["elements"] if e["id"] == 4)["value"] == "Ship it"


def test_reading_a_password_field_is_refused(leo_browser):
    res = call("app_act", {"action": "read", "element_id": 3})
    assert res["ok"] is False
    assert leo_browser.commands == []


def test_request_without_a_user_touches_no_browser(leo_browser):
    res = call("app_act", {"action": "click", "element_id": 1}, user=None)
    assert res["ok"] is False and "which user" in res["detail"]
    assert leo_browser.commands == []


def test_other_users_turn_cannot_drive_leos_browser(leo_browser):
    """Before: the hub sent every command to whichever browser connected last."""
    mallory_browser = FakeBrowser(server.hub, ELEMENTS)
    server.hub.attach(mallory_browser, "mallory_member")
    try:
        res = call("app_act", {"action": "click", "element_id": 1}, user="mallory_member")
        assert res["ok"] is True
        assert mallory_browser.commands and leo_browser.commands == []
        state = call("app_state", {}, user=LEO)
        assert state["connected"] is True and state["user"] == LEO
    finally:
        server.hub.detach(mallory_browser)


def test_folder_tools_route_to_the_callers_bridge_only():
    leo_bridge = FakeBrowser(server.folder_hub, [])
    server.folder_hub.attach(leo_bridge, LEO)
    try:
        res = call("folder_bridge_get_file_metadata", {"folder_id": "f1", "path": "a.txt"},
                   user="mallory_member")
        assert res["ok"] is False
        assert leo_bridge.commands == []
        res = call("folder_bridge_get_file_metadata", {"folder_id": "f1", "path": "a.txt"})
        assert res["ok"] is True and leo_bridge.commands[0]["type"] == "getFileMetadata"
    finally:
        server.folder_hub.detach(leo_bridge)
