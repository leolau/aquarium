"""FG-37 ``request_secret``: the agent gets a status and a name, never a value.

Runs the real tool against the real registry and file credential store in a
temp HERMES_HOME; only the surface (popup / link sender) is a test double that
answers the request the way the browser or link page would.
"""

from __future__ import annotations

import json
import threading

import pytest

from hermes_cli import secret_requests as sr
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore
from tools import secret_request_tool as tool
from tools.access_policy import acting_as
from tools.approval import reset_current_session_key, set_current_session_key

VALUE = "sk-" + "TopSecretValue" * 3
MIA = Principal(user_id="mia", display="Mia", role="member")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_constants
    from hermes_cli import credential_store

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    store = FileCredentialStore(tmp_path / "credentials")
    monkeypatch.setattr(credential_store, "default_credential_store", lambda *a, **k: store)
    monkeypatch.setattr(sr, "POLL_SECONDS", 0.05)
    yield tmp_path


@pytest.fixture
def run_key():
    key = "run_secret_test"
    token = set_current_session_key(key)
    yield key
    tool.unregister_secret_surface(key)
    reset_current_session_key(token)


def _call(timeout=5, **kw):
    args = dict(name="openai-key", label="OpenAI API key", purpose="Call the API")
    args.update(kw)
    with acting_as("mia", "member"):
        return json.loads(tool.request_secret_tool(timeout=timeout, **args))


def _answer_with(action):
    events, resolved = [], []

    def notify(event):
        events.append(event)
        threading.Thread(target=action, args=(event["request_id"],)).start()

    return events, resolved, notify, lambda rid, status: resolved.append((rid, status))


def test_registered_in_core_and_api_server_toolsets():
    from tools.registry import registry
    from toolsets import resolve_toolset

    assert "request_secret" in registry.get_all_tool_names()
    assert "request_secret" in resolve_toolset("hermes-api-server")
    assert "request_secret" in resolve_toolset("secrets")


def test_stored_returns_name_only(home, run_key):
    events, resolved, notify, done = _answer_with(
        lambda rid: sr.fulfil(rid, principal=MIA, values={"value": VALUE})
    )
    tool.register_secret_surface(run_key, notify, done)
    out = _call()
    assert out == {"status": "stored", "secret": "openai-key", "kind": "secret"}
    assert VALUE not in json.dumps(out)
    (event,) = events
    assert set(event) == {"request_id", "name", "label", "purpose", "kind", "username", "expires_at"}
    assert event["name"] == "openai-key" and event["label"] == "OpenAI API key"
    assert resolved == [(event["request_id"], "stored")]
    req = sr.get_request(event["request_id"])
    assert req.owner_user_id == "mia" and req.run_id == run_key and req.channel == "agent-home"


def test_declined(home, run_key):
    _e, _r, notify, done = _answer_with(lambda rid: sr.decline(rid))
    tool.register_secret_surface(run_key, notify, done)
    assert _call() == {"status": "declined"}


def test_expired(home, run_key):
    tool.register_secret_surface(run_key, lambda _e: None)
    assert _call(timeout=0.2) == {"status": "expired"}


def test_unavailable_without_surface(home, run_key):
    out = _call()
    assert out["status"] == "unavailable" and "Settings" in out["hint"]
    assert "openai-key" in out["hint"]


def _link_sender(sent, *, deliver=True):
    """Stand-in for gateway.secret_links.make_link_sender: opens the request with a link."""

    def sender(**ask):
        req, token = sr.open_request(
            owner_user_id="mia", profile="default", session_key="tg:1", channel="telegram",
            with_link=True, **ask,
        )
        sent.append((ask, req, token))
        if not deliver:
            sr.decline(req.id)
            return {"status": "unavailable", "hint": "Secure links are not set up."}
        threading.Thread(target=sr.fulfil_by_token, args=(token,), kwargs={"values": {"value": VALUE}}).start()
        return {"status": "sent", "request_id": req.id, "message": "secure link sent"}

    return sender


def test_messaging_turn_uses_gateway_link_sender(home, run_key):
    from gateway import secret_links

    sent = []
    secret_links.register_secret_link_sender(run_key, _link_sender(sent))
    try:
        out = _call()
    finally:
        secret_links.unregister_secret_link_sender(run_key)
    assert out == {"status": "stored", "secret": "openai-key", "kind": "secret"}
    (ask, req, token), = sent
    assert ask["name"] == "openai-key" and ask["run_id"] == run_key and ask["ttl_seconds"] == 5
    assert sr.get_request(req.id).status == "stored"
    assert token not in json.dumps(out) and VALUE not in json.dumps(out)


def test_link_sender_unavailable_passes_hint(home, run_key):
    from gateway import secret_links

    secret_links.register_secret_link_sender(run_key, _link_sender([], deliver=False))
    try:
        out = _call()
    finally:
        secret_links.unregister_secret_link_sender(run_key)
    assert out == {"status": "unavailable", "hint": "Secure links are not set up."}


def test_bad_name_is_a_tool_error(home, run_key):
    tool.register_secret_surface(run_key, lambda _e: None)
    with acting_as("mia", "member"):
        out = json.loads(tool.request_secret_tool(name="Has Spaces", label="x", purpose="y"))
    assert "error" in out
