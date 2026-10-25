import pytest

from app_mcp.guard import looks_destructive


def test_matches_destructive_verbs():
    assert looks_destructive("Delete")
    assert looks_destructive("Delete task")
    assert looks_destructive("Archive conversation")
    assert looks_destructive("Send")
    assert looks_destructive("Submit run")
    assert looks_destructive("Remove member")
    assert looks_destructive("please DELETE this")


def test_ignores_safe_labels():
    assert not looks_destructive("Filter")
    assert not looks_destructive("Chats")
    assert not looks_destructive("Open task")
    assert not looks_destructive("Sender settings")  # word boundary, not substring
    assert not looks_destructive("Deliverable notes")  # boundary: not "deliver"
    assert not looks_destructive("")
    assert not looks_destructive(None)


def test_boundary_not_substring():
    # "post" matches as a word, but "postpone" must not.
    assert looks_destructive("Post update")
    assert not looks_destructive("Postpone reminder")


@pytest.mark.parametrize(
    "name",
    [
        "Approve",
        "Approve for this chat",
        "Always approve",
        "Deny",
        "Trusted for import",
        "Trusted for import (agent may copy files into Files without asking each time)",
        "Allow on this card",
        "Needs re-approval",
        "Acknowledge",
    ],
)
def test_consent_controls_are_user_only(name):
    from app_mcp.guard import is_user_only, looks_like_consent

    assert looks_like_consent(name)
    assert is_user_only({"name": name})


@pytest.mark.parametrize("name", ["Filter", "Rename", "Open chat", "Connected folders", "Title"])
def test_ordinary_controls_are_not_user_only(name):
    from app_mcp.guard import is_user_only

    assert not is_user_only({"name": name})


def test_page_marker_makes_any_control_user_only():
    from app_mcp.guard import is_user_only

    assert is_user_only({"name": "Connect", "denied": True})


@pytest.mark.parametrize(
    "name",
    [
        "Deploy",
        "Deploy to prod",
        "Deploying…",
        "Publish",
        "Publish app",
        "Publishing…",
        "Make live",
        "Make Live",
        "Redeploy",
        "Re-deploy",
        "Unlink",
        "Unlink Telegram 123456",
    ],
)
def test_going_live_controls_are_user_only(name):
    from app_mcp.guard import is_user_only, looks_like_consent

    assert looks_like_consent(name)
    assert is_user_only({"name": name})


@pytest.mark.parametrize(
    "name",
    [
        "Deployments",
        "Deployed 2 min ago",
        "Published from leo",
        "Link account",
        "Live preview",
        "Make a copy",
        "Unpublished drafts",
    ],
)
def test_going_live_words_match_whole_verbs_only(name):
    from app_mcp.guard import is_user_only

    assert not is_user_only({"name": name})


def test_delete_stays_destructive_not_user_only():
    from app_mcp.guard import is_user_only

    assert looks_destructive("Delete app")
    assert not is_user_only({"name": "Delete app"})
    assert is_user_only({"name": "Delete app", "denied": True})


@pytest.mark.parametrize("tool", ["app_act", "app_act_destructive"])
@pytest.mark.parametrize("name", ["Publish", "Deploy to prod", "Make live", "Redeploy", "Unlink"])
def test_neither_act_tool_presses_going_live_controls(tool, name):
    """Through a real MCP client: the browser never receives the click."""
    import asyncio
    import json

    from mcp.shared.memory import create_connected_server_and_client_session
    from mcp.types import TextContent

    from app_mcp import server

    commands: list[dict] = []
    elements = [{"id": 1, "role": "button", "name": name, "tag": "button", "selector": "#b"}]

    class FakeBrowser:
        async def send(self, message: str) -> None:
            msg = json.loads(message)
            if msg["command"]["type"] == "snapshot":
                payload = {"ok": True, "detail": "snap", "elements": elements}
            else:
                commands.append(msg["command"])
                payload = {"ok": True, "detail": "did it"}
            asyncio.get_running_loop().call_soon(
                server.hub.resolve_result, self, msg["id"], payload
            )

    async def _call() -> dict:
        meta = {server.PRINCIPAL_META_KEY: "leo_owner"}
        async with create_connected_server_and_client_session(server.mcp) as client:
            result = await client.call_tool(tool, {"action": "click", "element_id": 1}, meta=meta)
        content = result.content[0]
        assert isinstance(content, TextContent)
        return json.loads(content.text)

    browser = FakeBrowser()
    server.hub.attach(browser, "leo_owner")
    try:
        res = asyncio.run(_call())
    finally:
        server.hub.detach(browser)
    assert res["ok"] is False and "Only the user" in res["detail"]
    assert commands == []
