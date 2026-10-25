"""The agent's session_search tool only recalls the caller's own chats.

Real ``SessionDB`` in a throwaway ``HERMES_HOME``: Mia's agent must not browse,
search, read or scroll Tom's (or an unowned legacy) conversation; the owner and
an identity-less session (CLI, cron) still see every chat.
"""

from __future__ import annotations

import json

import pytest

from tools.session_search_tool import (
    UNRESOLVED_OWNER_SCOPE,
    owner_scope_for,
    session_search,
)


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_state

    d = hermes_state.SessionDB(db_path=tmp_path / "state.db")
    d.ensure_session("s-mia", source="agent_home", user_id="mia")
    d.append_message("s-mia", "user", "mia budget salary plan")
    d.ensure_session("s-tom", source="agent_home", user_id="tom")
    tom_msg = d.append_message("s-tom", "user", "tom salary secret")
    d.end_session("s-tom", "compression")
    d.create_session("s-tom-2", source="agent_home", parent_session_id="s-tom")
    d.append_message("s-tom-2", "user", "tom salary continued")
    d.ensure_session("s-legacy", source="agent_home")
    d.append_message("s-legacy", "user", "legacy salary note")
    d.tom_msg = tom_msg
    yield d
    d.close()


def _sids(payload: str) -> set:
    data = json.loads(payload)
    return {r["session_id"] for r in data.get("results", [])}


def test_owner_scope():
    assert owner_scope_for(None, None, trusted_local=True) is None
    assert owner_scope_for(None, None) == UNRESOLVED_OWNER_SCOPE
    assert owner_scope_for(None, "owner") == UNRESOLVED_OWNER_SCOPE
    assert owner_scope_for("root", "owner") is None
    assert owner_scope_for("mia", "member") == "mia"
    assert owner_scope_for("ann", "admin") == "ann"


def test_discover_only_returns_own_chats(db):
    assert _sids(session_search(query="salary", limit=10, db=db, owner_user_id="mia")) == {"s-mia"}
    everyone = _sids(session_search(query="salary", limit=10, db=db))
    assert {"s-mia", "s-legacy"} <= everyone
    assert everyone & {"s-tom", "s-tom-2"}


def test_browse_only_lists_own_chats(db):
    data = json.loads(session_search(db=db, limit=10, owner_user_id="mia"))
    assert {r["session_id"] for r in data["results"]} == {"s-mia"}


@pytest.mark.parametrize("sid", ["s-tom", "s-tom-2", "s-legacy"])
def test_read_and_scroll_refuse_other_peoples_chats(db, sid):
    read = json.loads(session_search(session_id=sid, db=db, owner_user_id="mia"))
    assert read["success"] is False
    scroll = json.loads(
        session_search(session_id=sid, around_message_id=db.tom_msg, db=db, owner_user_id="mia")
    )
    assert scroll["success"] is False


def test_owner_reads_any_chat(db):
    assert json.loads(session_search(session_id="s-tom", db=db))["success"] is True
    assert json.loads(session_search(session_id="s-mia", db=db, owner_user_id="mia"))["success"] is True


def test_untrusted_unresolved_session_sees_no_foreign_chats(db):
    scope = owner_scope_for(None, "member")
    assert _sids(session_search(query="salary", limit=10, db=db, owner_user_id=scope)) == set()
    browse = json.loads(session_search(db=db, limit=10, owner_user_id=scope))
    assert browse.get("results", []) == []
    read = json.loads(session_search(db=db, session_id="s-tom", owner_user_id=scope))
    assert read.get("success") is False
