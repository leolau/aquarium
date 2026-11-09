"""Session pins + landing pin suggestions.

Real ``SessionDB`` under a throwaway ``HERMES_HOME``; only the principal
resolver and the auxiliary model are stubbed.
"""

from __future__ import annotations

import json
import sqlite3
import time
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_constants
    import hermes_state

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    return tmp_path


@pytest.fixture
def db(tmp_path):
    from hermes_state import SessionDB

    d = SessionDB(db_path=tmp_path / "state.db")
    yield d
    d.close()


def _chat(db, sid, turns, user_id=None, **kw):
    db.create_session(sid, "agent_home", user_id=user_id, **kw)
    for role, text in turns:
        db.append_message(sid, role, text)


HEUR = {
    "enabled": True,
    "use_model": False,
    "max_items": 3,
    "candidates": 8,
    "lookback_days": 14,
    "refresh_hours": 6,
}


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def test_pin_is_idempotent_per_user_and_unpin_reports(db):
    _chat(db, "s1", [("user", "hi"), ("assistant", "hello")])
    first = db.pin_session("ann", "s1", now=100.0)
    assert db.pin_session("ann", "s1", now=200.0) == first == 100.0
    assert db.get_pins("ann") == {"s1": 100.0}
    assert db.get_pins("bob") == {}
    assert db.unpin_session("ann", "s1") is True
    assert db.unpin_session("ann", "s1") is False
    assert db.get_pins("ann") == {}


def test_pin_cap(db):
    for i in range(db.MAX_PINS_PER_USER + 1):
        _chat(db, f"s{i}", [("user", "x")])
    for i in range(db.MAX_PINS_PER_USER):
        db.pin_session("ann", f"s{i}")
    with pytest.raises(ValueError):
        db.pin_session("ann", f"s{db.MAX_PINS_PER_USER}")
    # Re-pinning an already pinned chat is not a new pin.
    db.pin_session("ann", "s0")


def test_pin_survives_compression(db):
    _chat(db, "root", [("user", "long task"), ("assistant", "working")])
    db.end_session("root", "compression")
    _chat(db, "tip", [("user", "continue")], parent_session_id="root")
    assert db.get_compression_root("tip") == "root"
    db.pin_session("ann", "tip", now=5.0)
    assert db.get_pins("ann") == {"root": 5.0}
    rows = db.list_sessions_rich(order_by_last_active=True, root_ids=["root"])
    assert [r.get("_lineage_root_id") or r["id"] for r in rows] == ["root"]
    assert db.unpin_session("ann", "tip") is True


def test_root_ids_filter(db):
    _chat(db, "a", [("user", "x")])
    _chat(db, "b", [("user", "y")])
    assert [r["id"] for r in db.list_sessions_rich(root_ids=["b"])] == ["b"]
    assert db.list_sessions_rich(root_ids=[]) == []


def test_v18_database_migrates_to_v19(tmp_path):
    from hermes_state import SCHEMA_VERSION, SessionDB

    path = tmp_path / "old.db"
    SessionDB(db_path=path).close()
    conn = sqlite3.connect(path)
    conn.execute("DROP TABLE session_pins")
    conn.execute("DROP TABLE session_pin_suggestions")
    conn.execute("UPDATE schema_version SET version = 18")
    conn.commit()
    conn.close()
    d = SessionDB(db_path=path)
    try:
        _chat(d, "s", [("user", "x")])
        assert d.pin_session("u", "s", now=1.0) == 1.0
        d.dismiss_pin_suggestions("u", ["s"])
        version = d._conn.execute("SELECT version FROM schema_version").fetchone()[0]
        assert version == SCHEMA_VERSION >= 19
    finally:
        d.close()


# ---------------------------------------------------------------------------
# Suggestions
# ---------------------------------------------------------------------------


def _seed_review_set(db, user_id=None):
    _chat(db, "unanswered", [("user", "a"), ("assistant", "b"), ("user", "and the deploy?")], user_id)
    _chat(db, "question", [("user", "plan"), ("assistant", "Shall I start on step 2?")], user_id)
    _chat(db, "done", [("user", "2+2"), ("assistant", "4.")], user_id)


def test_heuristic_suggests_unfinished_chats(db):
    from hermes_cli import session_pins

    _seed_review_set(db)
    out = session_pins.get_suggestions(db, None, "ann", settings=HEUR)
    ids = [i["session_id"] for i in out["items"]]
    assert set(ids) == {"unanswered", "question"}
    assert out["source"] == "heuristic" and out["enabled"] and out["generated_at"]
    assert all(i["reason"] for i in out["items"])


def test_disabled_returns_nothing(db):
    from hermes_cli import session_pins

    _seed_review_set(db)
    out = session_pins.get_suggestions(db, None, "ann", settings={**HEUR, "enabled": False})
    assert out["items"] == [] and out["enabled"] is False


def test_short_form_config_gate():
    from hermes_cli import session_pins

    assert session_pins.load_settings({"landing": {"pin_suggestions": False}})["enabled"] is False
    s = session_pins.load_settings({"landing": {"pin_suggestions": {"max_items": "5"}}})
    assert s["max_items"] == 5 and s["enabled"] is True
    from hermes_cli.config import DEFAULT_CONFIG

    assert session_pins.load_settings(DEFAULT_CONFIG) == session_pins.DEFAULT_SETTINGS
    assert "session_review" in DEFAULT_CONFIG["auxiliary"]


def test_dismissed_stay_dismissed_and_pinned_are_excluded(db):
    from hermes_cli import session_pins

    _seed_review_set(db)
    session_pins.get_suggestions(db, None, "ann", settings=HEUR)
    db.dismiss_pin_suggestions("ann", ["unanswered"])
    db.pin_session("ann", "question")
    # New activity in the dismissed chat changes the set and forces a re-review.
    db.append_message("unanswered", "user", "still there?")
    db.set_meta("pin_review:ann", json.dumps({"ran_at": 1.0}))
    out = session_pins.get_suggestions(db, None, "ann", settings=HEUR)
    assert out["items"] == []
    # Another user is unaffected.
    other = session_pins.get_suggestions(db, None, "bob", settings=HEUR)
    assert {i["session_id"] for i in other["items"]} == {"unanswered", "question"}


def test_scope_limits_candidates(db):
    from hermes_cli import session_pins

    _seed_review_set(db, user_id="ann")
    _chat(db, "bobs", [("user", "hi"), ("assistant", "hey"), ("user", "bob asks?")], "bob")
    out = session_pins.get_suggestions(db, "bob", "bob", settings=HEUR)
    assert [i["session_id"] for i in out["items"]] == ["bobs"]


def test_cache_is_reused_until_set_changes(db, monkeypatch):
    from hermes_cli import session_pins

    _seed_review_set(db)
    calls = []
    real = session_pins.run_review
    monkeypatch.setattr(
        session_pins, "run_review", lambda *a, **k: calls.append(1) or real(*a, **k)
    )
    session_pins.get_suggestions(db, None, "ann", settings=HEUR, now=10_000.0)
    session_pins.get_suggestions(db, None, "ann", settings=HEUR, now=10_060.0)
    assert len(calls) == 1
    _chat(db, "new", [("user", "x"), ("assistant", "y"), ("user", "fresh?")])
    # A new chat re-runs only after the floor.
    session_pins.get_suggestions(db, None, "ann", settings=HEUR, now=10_120.0)
    assert len(calls) == 1
    session_pins.get_suggestions(
        db, None, "ann", settings=HEUR, now=10_000.0 + session_pins.NEW_SESSION_FLOOR_S + 1
    )
    assert len(calls) == 2


def _llm_returning(payload, seen):
    def llm(task, messages, **kw):
        seen.append({"task": task, "messages": messages, **kw})
        msg = SimpleNamespace(content=json.dumps(payload))
        return SimpleNamespace(choices=[SimpleNamespace(message=msg)])

    return llm


def test_model_review_is_one_toolless_call_and_validated(db):
    from hermes_cli import session_pins

    _seed_review_set(db)
    before = {s: db.get_messages(s) for s in ("unanswered", "question", "done")}
    seen = []
    cands = session_pins.collect_candidates(db, None, "ann", {**HEUR, "use_model": True}, __import__("time").time())
    n_done = next(i for i, c in enumerate(cands, 1) if c["session_id"] == "done")
    llm = _llm_returning(
        {"suggestions": [
            {"n": n_done, "reason": "Interesting maths", "score": 0.9},
            {"n": 99, "reason": "bogus", "score": 1},
            {"n": 1, "reason": "low", "score": 0.1},
        ]},
        seen,
    )
    src = session_pins.run_review(db, "ann", cands, {**HEUR, "use_model": True}, llm=llm)
    assert src == "model"
    assert len(seen) == 1 and seen[0]["task"] == "session_review"
    assert "tools" not in seen[0]
    assert [m["role"] for m in seen[0]["messages"]] == ["system", "user"]
    rows = [r for r in db.get_pin_suggestion_rows("ann") if r["status"] == "open"]
    assert [(r["session_id"], r["reason"]) for r in rows] == [("done", "Interesting maths")]
    # Nothing was written into any conversation.
    assert {s: db.get_messages(s) for s in before} == before


def test_model_failure_falls_back_to_heuristic(db):
    from hermes_cli import session_pins

    _seed_review_set(db)

    def broken(**kw):
        raise RuntimeError("no auxiliary provider configured")

    cands = session_pins.collect_candidates(db, None, "ann", HEUR, __import__("time").time())
    assert session_pins.run_review(db, "ann", cands, {**HEUR, "use_model": True}, llm=broken) == "heuristic"
    assert {r["session_id"] for r in db.get_pin_suggestion_rows("ann")} == {"unanswered", "question"}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch):
    from starlette.testclient import TestClient

    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    owner = SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)

    async def _fake_principal(request, *, allow_as=False):
        return owner

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_pin_routes_and_pinned_at_on_list(client, tmp_path):
    from hermes_state import SessionDB

    d = SessionDB()
    _chat(d, "s1", [("user", "hi")])
    _chat(d, "s2", [("user", "yo")])
    d.close()

    r = client.post("/api/sessions/s1/pin", json={"pinned": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["session_id"] == "s1" and isinstance(body["pinned_at"], float)
    again = client.post("/api/sessions/s1/pin", json={"pinned": True}).json()
    assert again["pinned_at"] == body["pinned_at"]

    rows = {s["id"]: s for s in client.get("/api/sessions").json()["sessions"]}
    assert rows["s1"]["pinned_at"] == body["pinned_at"]
    assert rows["s2"]["pinned_at"] is None
    only = client.get("/api/sessions?pinned=only").json()
    assert [s["id"] for s in only["sessions"]] == ["s1"] and only["total"] == 1

    off = client.post("/api/sessions/s1/pin", json={"pinned": False}).json()
    assert off == {"session_id": "s1", "pinned_at": None}
    assert client.post("/api/sessions/nope/pin", json={"pinned": True}).status_code == 404


def test_suggestion_routes(client, monkeypatch):
    from hermes_cli import session_pins
    from hermes_state import SessionDB

    monkeypatch.setattr(session_pins, "load_settings", lambda config=None: dict(HEUR))
    d = SessionDB()
    _seed_review_set(d)
    d.close()
    out = client.get("/api/sessions/pin-suggestions").json()
    assert {i["session_id"] for i in out["items"]} == {"unanswered", "question"}
    r = client.post("/api/sessions/pin-suggestions/dismiss", json={"session_ids": ["unanswered"]})
    assert r.status_code == 200 and r.json()["dismissed"] == ["unanswered"]
    out = client.get("/api/sessions/pin-suggestions").json()
    assert [i["session_id"] for i in out["items"]] == ["question"]


def test_only_chats_are_suggested(db):
    """Project runs and board-card worker sessions are never pin candidates."""
    from hermes_cli import session_pins

    _seed_review_set(db)
    unanswered = [("user", "a"), ("assistant", "b"), ("user", "and then?")]
    _chat(db, "card-worker", unanswered, cwd="/srv/hermes/kanban/workspaces/t_abc")
    db._execute_write(lambda c: c.execute("UPDATE sessions SET source = 'cli' WHERE id = 'card-worker'"))
    db.create_session("project-run", "projects:demo:run-1")
    for role, text in unanswered:
        db.append_message("project-run", role, text)

    candidates = session_pins.collect_candidates(db, None, "ann", HEUR, now=time.time())
    ids = {c["session_id"] for c in candidates}
    assert {"card-worker", "project-run"}.isdisjoint(ids)
    assert {"unanswered", "question", "done"} <= ids
    out = session_pins.get_suggestions(db, None, "ann", settings=HEUR)
    assert {i["session_id"] for i in out["items"]} == {"unanswered", "question"}


def test_is_chat():
    from hermes_cli.session_pins import is_chat

    assert is_chat({"source": "agent_home", "cwd": "/home/me"})
    assert is_chat({"source": "telegram"})
    assert not is_chat({"source": "projects:demo:run-3"})
    assert not is_chat({"source": "cron"})
    assert not is_chat({"source": "cli", "cwd": "/x/kanban/boards/ops/workspaces/t_1"})
