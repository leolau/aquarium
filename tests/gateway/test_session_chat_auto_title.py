"""Auto-title for agent-home chats (landing redesign B1).

``run_session_turn_sync(auto_title_db_factory=...)`` titles an untitled
session once after its first exchange, in a background thread with its own
``SessionDB``. Real SQLite under a temp ``HERMES_HOME``; only the agent and the
auxiliary title call are stubbed.
"""

from __future__ import annotations

import threading
import time

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    return tmp_path


@pytest.fixture
def open_db(home):
    import hermes_state

    return lambda: hermes_state.SessionDB(db_path=home / "state.db")


@pytest.fixture
def fake_agent(monkeypatch):
    import gateway.session_chat as session_chat

    captured: dict = {"result": {}}

    class _Agent:
        model = "main-model"
        provider = "main-provider"
        base_url = "u"
        api_key = "k"
        api_mode = "chat_completions"
        session_prompt_tokens = 1
        session_completion_tokens = 2
        session_total_tokens = 3

        def __init__(self, session_id):
            self.session_id = session_id

        def run_conversation(self, *, user_message, conversation_history, task_id):
            captured["history"] = conversation_history
            return {"final_response": f"reply:{user_message}", **captured["result"]}

    monkeypatch.setattr(
        session_chat, "build_session_agent", lambda **kw: _Agent(kw.get("session_id"))
    )
    return captured


@pytest.fixture
def titles(monkeypatch):
    """Stub the auxiliary call; record every invocation."""
    import agent.title_generator as tg

    calls: list = []
    state = {"title": "Planning a Lisbon trip", "before_return": None}

    def _gen(user_message, assistant_response, **kwargs):
        calls.append({"user": user_message, "assistant": assistant_response, **kwargs})
        if state["before_return"]:
            state["before_return"]()
        return state["title"]

    monkeypatch.setattr(tg, "generate_title", _gen)
    return calls, state


def _wait_threads(timeout=5.0):
    deadline = time.monotonic() + timeout
    for t in [t for t in threading.enumerate() if t.name == "auto-title"]:
        t.join(max(0.0, deadline - time.monotonic()))


def _turn(open_db, sid, message="plan a trip to Lisbon", history=None, factory=True):
    from gateway.session_chat import run_session_turn_sync

    db = open_db()
    try:
        return run_session_turn_sync(
            session_db=db,
            user_message=message,
            conversation_history=history or [],
            session_id=sid,
            auto_title_db_factory=open_db if factory else None,
        )
    finally:
        db.close()
        _wait_threads()


def _seed(open_db, sid, title=None):
    db = open_db()
    try:
        db.create_session(sid, source="agent_home")
        if title:
            db.set_session_title(sid, title)
    finally:
        db.close()


def _title(open_db, sid):
    db = open_db()
    try:
        return db.get_session_title(sid)
    finally:
        db.close()


def test_first_exchange_sets_title(open_db, fake_agent, titles):
    calls, _ = titles
    _seed(open_db, "s1")
    result, _usage = _turn(open_db, "s1")

    assert result["final_response"] == "reply:plan a trip to Lisbon"
    assert _title(open_db, "s1") == "Planning a Lisbon trip"
    assert len(calls) == 1
    assert calls[0]["user"] == "plan a trip to Lisbon"
    assert calls[0]["main_runtime"]["model"] == "main-model"
    # The conversation itself is untouched: history forwarded verbatim.
    assert fake_agent["history"] == []


def test_existing_title_is_never_overwritten(open_db, fake_agent, titles):
    calls, _ = titles
    _seed(open_db, "s2", title="My own name")
    _turn(open_db, "s2")
    assert _title(open_db, "s2") == "My own name"
    assert calls == []


def test_rename_during_generation_wins(open_db, fake_agent, titles):
    _calls, state = titles
    _seed(open_db, "s3")

    def _user_renames():
        db = open_db()
        try:
            db.set_session_title("s3", "Renamed by me")
        finally:
            db.close()

    state["before_return"] = _user_renames
    _turn(open_db, "s3")
    assert _title(open_db, "s3") == "Renamed by me"


def test_no_factory_means_no_title_call(open_db, fake_agent, titles):
    calls, _ = titles
    _seed(open_db, "s4")
    _turn(open_db, "s4", factory=False)
    assert calls == []
    assert _title(open_db, "s4") is None


def test_later_exchanges_are_not_titled(open_db, fake_agent, titles):
    calls, _ = titles
    _seed(open_db, "s5")
    history = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
        {"role": "assistant", "content": "d"},
    ]
    _turn(open_db, "s5", history=history)
    assert calls == []


@pytest.mark.parametrize("flag", ["failed", "partial", "interrupted"])
def test_failed_or_partial_turns_are_not_titled(open_db, fake_agent, titles, flag):
    calls, _ = titles
    _seed(open_db, f"s-{flag}")
    fake_agent["result"] = {flag: True}
    _turn(open_db, f"s-{flag}")
    assert calls == []


def test_title_thread_inherits_profile_scope(open_db, fake_agent, titles, tmp_path):
    """The web path enters the profile scope inside the turn thread; the
    title thread must resolve config/secrets under the same profile."""
    from hermes_constants import (
        get_hermes_home,
        reset_hermes_home_override,
        set_hermes_home_override,
    )

    calls, state = titles
    seen: dict = {}
    state["before_return"] = lambda: seen.setdefault("home", str(get_hermes_home()))
    _seed(open_db, "s6")
    profile_home = tmp_path / "profiles" / "research"
    profile_home.mkdir(parents=True)
    token = set_hermes_home_override(str(profile_home))
    try:
        _turn(open_db, "s6")
    finally:
        reset_hermes_home_override(token)
    assert len(calls) == 1
    assert seen["home"] == str(profile_home)
