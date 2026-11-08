"""Both agent-home chat endpoints opt their turn into auto-titling, with a DB
factory that opens the requested profile's ``state.db`` (landing B1)."""

from __future__ import annotations

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
def client(monkeypatch):
    from starlette.testclient import TestClient

    from hermes_cli import web_server
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    owner = SimpleNamespace(user_id="root", display="Root Owner", role="owner", is_owner=True)

    async def _fake_principal(request, *, allow_as=False):
        return owner

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def factory_probe(monkeypatch):
    import gateway.session_chat as session_chat

    seen: dict = {}

    def _turn(*, session_db, user_message, conversation_history, session_id=None, **kwargs):
        factory = kwargs.get("auto_title_db_factory")
        seen["factory"] = factory
        if factory is not None:
            db = factory()
            try:
                seen["row"] = db.get_session(session_id)
            finally:
                db.close()
        return (
            {"final_response": "ok", "session_id": session_id},
            {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _turn)
    return seen


def _seed(sid):
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session(sid, source="agent_home")
    finally:
        db.close()


@pytest.mark.parametrize("suffix", ["chat", "chat/stream"])
def test_chat_endpoints_pass_auto_title_factory(client, factory_probe, suffix):
    _seed("s-title")
    resp = client.post(f"/api/sessions/s-title/{suffix}", json={"message": "hi"})
    assert resp.status_code == 200
    _ = resp.text
    assert callable(factory_probe["factory"])
    # The factory opens the same store the turn's session lives in.
    assert factory_probe["row"] and factory_probe["row"]["id"] == "s-title"
