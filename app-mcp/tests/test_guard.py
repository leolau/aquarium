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
