"""FG-37 W5: secret prompt end to end over the real seams.

Real ``FileCredentialStore``, real request registry (``secret_requests.db``),
the real dashboard app, the real ``AIAgent`` loop and tool dispatch, the real
gateway link sender and the real terminal. Only the model is scripted.
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import re
import socket
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import secret_requests as sr
from hermes_cli.credential_store import FileCredentialStore

VALUE = "ghp_" + "Fg37RealSeamValue" * 2
LINK_VALUE = "link-" + "Fg37MessagingValue" * 2
OWNER = SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)
TOM = SimpleNamespace(user_id="tom", display="Tom", role="member", is_owner=False)
PUBLIC = {"agent_home": {"public_url": "https://aquarium.example.test"}}


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_constants
    import hermes_state
    from hermes_cli import credential_store, secret_links_api

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    store = FileCredentialStore(tmp_path / "credentials")
    asyncio.run(store.initialize())
    from hermes_cli import credentials_api

    for module in (credential_store, credentials_api):
        monkeypatch.setattr(module, "default_credential_store", lambda *a, **k: store)
    monkeypatch.setattr(sr, "POLL_SECONDS", 0.05)
    monkeypatch.setattr(
        secret_links_api, "_throttle",
        secret_links_api.RedeemThrottle(max_attempts=10, window_seconds=600.0, ip_max_attempts=30),
    )
    from hermes_cli import web_server

    web_server._CHAT_RUNS.clear()
    yield tmp_path
    web_server._CHAT_RUNS.clear()


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["as"].user_id)
    return state


@pytest.fixture
def server(acting):
    import uvicorn

    from hermes_cli.web_server import app

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")
    )
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.05)
    assert srv.started
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(5)


@pytest.fixture
def terminal(home, monkeypatch):
    from tools import terminal_tool

    monkeypatch.setattr(terminal_tool, "_last_activity", {})
    monkeypatch.setattr(terminal_tool, "_task_env_overrides", {})
    monkeypatch.setattr(terminal_tool, "_start_cleanup_thread", lambda: None)
    monkeypatch.setattr(terminal_tool, "_get_env_config", lambda: {
        "env_type": "local", "cwd": str(home), "timeout": 30, "lifetime_seconds": 3600,
    })
    monkeypatch.setattr(terminal_tool, "_check_all_guards", lambda *a, **k: {"approved": True})
    envs: dict = {}
    monkeypatch.setattr(terminal_tool, "_active_environments", envs)
    yield
    for env in list(envs.values()):
        env.cleanup()


def _call(name, args, call_id):
    fn = SimpleNamespace(name=name, arguments=json.dumps(args))
    return SimpleNamespace(id=call_id, type="function", function=fn)


def _reply(content="", tool_call=None):
    msg = SimpleNamespace(content=content, tool_calls=[tool_call] if tool_call else None)
    finish = "tool_calls" if tool_call else "stop"
    return SimpleNamespace(
        choices=[SimpleNamespace(message=msg, finish_reason=finish)], model="test/model", usage=None
    )


@pytest.fixture
def model(monkeypatch):
    """The real AIAgent loop; only the provider call is scripted."""
    import gateway.session_chat as session_chat
    import model_tools  # noqa: F401  (registers the built-in tools)
    from run_agent import AIAgent
    from tools.registry import registry

    tool_defs = registry.get_definitions({"request_secret", "terminal"}, quiet=True)
    assert {d["function"]["name"] for d in tool_defs} == {"request_secret", "terminal"}
    scripted = SimpleNamespace(calls=[], replies=[])
    lock = threading.Lock()

    def _create(**kwargs):
        with lock:
            scripted.calls.append(copy.deepcopy(kwargs["messages"]))
            return scripted.replies.pop(0)

    def _build(*, session_db, session_id=None, stream_delta_callback=None,
               tool_start_callback=None, tool_complete_callback=None, principal=None, **kwargs):
        identity = {
            "internal_user_id": principal.user_id,
            "internal_user_role": principal.role,
        } if principal is not None else {}
        with (
            patch("run_agent.get_tool_definitions", return_value=tool_defs),
            patch("run_agent.check_toolset_requirements", return_value={}),
            patch("run_agent.OpenAI"),
            patch("agent.model_metadata.fetch_model_metadata", return_value={}),
        ):
            agent = AIAgent(
                api_key="test-key",
                base_url="https://openrouter.ai/api/v1",
                quiet_mode=True,
                skip_context_files=True,
                skip_memory=True,
                platform="api_server",
                session_db=session_db,
                session_id=session_id,
                tool_start_callback=tool_start_callback,
                tool_complete_callback=tool_complete_callback,
                **identity,
            )
        agent.client = MagicMock()
        agent.client.chat.completions.create.side_effect = _create
        agent._cached_system_prompt = "You are helpful."
        agent._use_prompt_caching = False
        agent._disable_streaming = True
        agent.tool_delay = 0
        agent.compression_enabled = False
        agent.save_trajectories = False
        return agent

    monkeypatch.setattr(session_chat, "build_session_agent", _build)
    monkeypatch.setattr(session_chat, "schedule_auto_title", lambda **kwargs: None)
    return scripted


def _events(body: str) -> list:
    out = []
    for frame in body.split("\n\n"):
        name = data = None
        for line in frame.splitlines():
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if name:
            out.append((name, data))
    return out


def _client(base, *, signed_in=True):
    import httpx

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    headers = {_SESSION_HEADER_NAME: _SESSION_TOKEN} if signed_in else {}
    return httpx.AsyncClient(base_url=base, headers=headers, timeout=30)


def _stored_bytes(home: Path) -> dict:
    """Every file of the home except the credential store itself."""
    out = {}
    for path in home.rglob("*"):
        if path.is_file() and "credentials" not in path.relative_to(home).parts:
            out[str(path.relative_to(home))] = path.read_bytes()
    return out


def _assert_nowhere(value: str, home: Path, *texts: str) -> None:
    for text in texts:
        assert value not in text
    leaked = [name for name, data in _stored_bytes(home).items() if value.encode() in data]
    assert leaked == []


def test_agent_home_popup_round_trip(home, server, acting, model, terminal, caplog):
    caplog.set_level(logging.DEBUG)
    import hermes_state

    db = hermes_state.SessionDB()
    db.ensure_session("s-secret", source="agent_home", user_id="root")
    db.close()
    model.replies[:] = [
        _reply(tool_call=_call("request_secret", {
            "name": "github-pat", "label": "GitHub PAT", "purpose": "Push the fix",
        }, "call_ask")),
        _reply(tool_call=_call("terminal", {
            "command": "printf 'tok=%s\\n' \"$GH_TOKEN\"",
            "secret_env": {"GH_TOKEN": "github-pat"},
        }, "call_use")),
        _reply("Pushed."),
    ]
    answers = {}

    async def _answer(ask):
        url = f"/api/secret-requests/{ask['request_id']}"
        async with _client(server) as other:
            acting["as"] = TOM
            denied = await other.post(url, json={"values": {"value": VALUE}})
            acting["as"] = OWNER
            stored = await other.post(url, json={"values": {"value": VALUE}})
            replay = await other.post(url, json={"values": {"value": VALUE}})
        return {"ask": ask, "other": denied, "owner": stored, "replay": replay}

    async def _scenario():
        async with _client(server) as ac:
            body = ""
            async with ac.stream(
                "POST", "/api/sessions/s-secret/chat/stream", json={"message": "push the fix"}
            ) as resp:
                assert resp.status_code == 200
                async for chunk in resp.aiter_text():
                    body += chunk
                    asks = [d for n, d in _events(body) if n == "secret.request"]
                    if answers or not asks:
                        continue
                    answers.update(await _answer(asks[0]))
            return body

    body = asyncio.run(_scenario())
    events = _events(body)
    ask = answers["ask"]
    assert ask["request_id"].startswith("sr_") and ask["name"] == "github-pat"
    assert ask["kind"] == "secret" and ask["label"] == "GitHub PAT" and ask["expires_at"] > time.time()
    assert ask["run_id"] and ask["message_id"]
    assert answers["other"].status_code == 403
    assert answers["owner"].status_code == 200
    assert answers["owner"].json()["status"] == "stored"
    assert answers["replay"].status_code == 409
    assert ("secret.resolved", {"request_id": ask["request_id"], "status": "stored",
                                "run_id": ask["run_id"]}) in events

    tool_results = {m["tool_call_id"]: m["content"] for m in model.calls[-1] if m["role"] == "tool"}
    assert json.loads(tool_results["call_ask"]) == {
        "status": "stored", "secret": "github-pat", "kind": "secret"
    }
    used = json.loads(tool_results["call_use"])
    assert "tok=***" in used["output"] and used.get("exit_code") == 0

    creds = b"".join(p.read_bytes() for p in (home / "credentials").rglob("*") if p.is_file())
    assert VALUE.encode() in creds  # it was stored, so the absence checks below mean something
    _assert_nowhere(VALUE, home, body, json.dumps(model.calls), caplog.text,
                    *(json.dumps(a.json()) for a in (answers["other"], answers["owner"], answers["replay"])))


class _Adapter:
    def __init__(self):
        self.sent: list = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        from gateway.platforms.base import SendResult

        self.sent.append((chat_id, content))
        return SendResult(success=True, message_id="m1")

    def pause_typing_for_chat(self, chat_id):
        pass


@pytest.fixture
def gateway_loop():
    lp = asyncio.new_event_loop()
    t = threading.Thread(target=lp.run_forever, daemon=True)
    t.start()
    yield lp
    lp.call_soon_threadsafe(lp.stop)
    t.join(2)
    lp.close()


def _link_turn(adapter, loop, key="agent:main:telegram:dm:chat-1"):
    from gateway import secret_links
    from gateway.config import Platform
    from gateway.session import SessionSource

    source = SessionSource(
        platform=Platform.TELEGRAM, chat_id="chat-1", chat_type="dm",
        user_id="tg-42", internal_user_id="mia",
    )
    secret_links.register_secret_link_sender(key, secret_links.make_link_sender(
        source=source, adapter=adapter, chat_id="chat-1", loop=loop,
        session_key=key, profile="default", config_loader=lambda: PUBLIC,
    ))
    return key


def _token(adapter) -> str:
    [(_chat, text)] = adapter.sent
    match = re.search(r"https://aquarium\.example\.test/secret/([A-Za-z0-9_-]+)", text)
    assert match, text
    return match.group(1)


def test_messaging_link_round_trip(home, gateway_loop, caplog):
    caplog.set_level(logging.DEBUG)
    from fastapi.testclient import TestClient

    from gateway import secret_links
    from hermes_cli import web_server
    from tools.access_policy import acting_as
    from tools.approval import reset_current_session_key, set_current_session_key
    from tools.secret_list_tool import resolve_secret_env
    from tools.secret_request_tool import request_secret_tool

    adapter = _Adapter()
    key = _link_turn(adapter, gateway_loop)
    out = {}

    def _turn():
        token = set_current_session_key(key)
        try:
            with acting_as("mia", "member"):
                out["result"] = request_secret_tool(
                    name="erp-key", label="ERP API key", purpose="Sync invoices", timeout=30
                )
        finally:
            reset_current_session_key(token)

    turn = threading.Thread(target=_turn)
    turn.start()
    try:
        for _ in range(200):
            if adapter.sent:
                break
            time.sleep(0.05)
        token = _token(adapter)
        public = TestClient(web_server.app)  # no session header: the page is public
        meta = public.get(f"/api/secret-links/{token}")
        assert meta.status_code == 200
        assert meta.json()["label"] == "ERP API key" and meta.json()["kind"] == "secret"
        assert meta.headers["cache-control"].startswith("no-store")
        assert meta.headers["referrer-policy"] == "no-referrer"
        first = public.post(f"/api/secret-links/{token}", json={"values": {"value": LINK_VALUE}})
        second = public.post(f"/api/secret-links/{token}", json={"values": {"value": "again"}})
        turn.join(10)
    finally:
        secret_links.unregister_secret_link_sender(key)
    assert first.status_code == 200 and first.json() == {"ok": True, "status": "stored", "name": "erp-key"}
    assert second.status_code == 404
    assert public.get(f"/api/secret-links/{token}").status_code == 404
    assert json.loads(out["result"]) == {"status": "stored", "secret": "erp-key", "kind": "secret"}
    assert token not in out["result"] and "/secret/" not in out["result"]
    with acting_as("mia", "member"):
        assert resolve_secret_env({"ERP_KEY": "erp-key"}) == {"ERP_KEY": LINK_VALUE}
    with acting_as("tom", "member"), pytest.raises(Exception):
        resolve_secret_env({"ERP_KEY": "erp-key"})
    _assert_nowhere(LINK_VALUE, home, out["result"], caplog.text, first.text, second.text)
    assert token not in caplog.text


def test_expired_link_is_gone(home):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    req, token = sr.open_request(
        owner_user_id="mia", profile="default", session_key="k", run_id=None, name="late",
        label="Late", purpose="", kind="secret", channel="telegram", ttl_seconds=0.2,
        with_link=True,
    )
    public = TestClient(web_server.app)
    assert public.get(f"/api/secret-links/{token}").status_code == 200
    time.sleep(0.3)
    assert public.get(f"/api/secret-links/{token}").status_code == 404
    assert public.post(f"/api/secret-links/{token}", json={"values": {"value": "x"}}).status_code == 404
    assert sr.get_request(req.id).status in {sr.PENDING, sr.EXPIRED}


def test_password_link_without_a_username_asks_again(home):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    req, token = sr.open_request(
        owner_user_id="mia", profile="default", session_key="k", run_id=None, name="erp-login",
        label="ERP login", purpose="", kind="password", channel="telegram", with_link=True,
    )
    public = TestClient(web_server.app)
    url = f"/api/secret-links/{token}"
    missing = public.post(url, json={"values": {"password": "pw-123456"}})
    assert missing.status_code == 400
    assert sr.get_request(req.id).status == sr.PENDING
    done = public.post(url, json={"values": {"username": "mia", "password": "pw-123456"}})
    assert done.status_code == 200 and done.json()["status"] == "stored"


def test_only_the_two_token_routes_are_public(home):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    anon = TestClient(web_server.app)
    token = "Q" * 43
    assert anon.get(f"/api/secret-links/{token}").status_code == 404
    for path in (f"/api/secret-links/{token}/x", "/api/secret-links/", "/api/secret-links",
                 "/api/secret-requests/sr_0123456789abcdef", "/api/credentials"):
        assert anon.get(path).status_code == 401, path
    assert anon.post("/api/secret-requests/sr_0123456789abcdef", json={"decline": True}).status_code == 401


def test_bad_secret_name_from_the_model_is_an_error_not_unavailable(home, gateway_loop):
    from gateway import secret_links

    adapter = _Adapter()
    key = _link_turn(adapter, gateway_loop, key="agent:main:telegram:dm:chat-2")
    try:
        result = secret_links.get_secret_link_sender(key)(name="Bad Name!", label="x")
    finally:
        secret_links.unregister_secret_link_sender(key)
    assert result["status"] == "error" and adapter.sent == []


def test_the_tool_waits_as_long_as_the_link_lives():
    from tools import secret_request_tool

    assert secret_request_tool.DEFAULT_TIMEOUT_SECONDS == sr.DEFAULT_TTL_SECONDS


def test_volunteered_secret_is_usable_by_name(home, monkeypatch, caplog):
    """Composer lock button: an ordinary member saves a secret, then secret_env uses it.

    The agent-home BFF turns ``visibility: "private"`` into ``private:<caller>``.
    """
    caplog.set_level(logging.DEBUG)
    from fastapi.testclient import TestClient

    from hermes_cli import web_server
    from tools.access_policy import acting_as
    from tools.secret_list_tool import resolve_secret_env

    mia = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)

    async def _fake_principal(_request, *, allow_as=False):
        return mia

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    resp = client.put("/api/credentials/secret/npm-token", json={
        "kind": "secret", "payload": {"value": VALUE}, "visibility": "private:mia",
    })
    assert resp.status_code in (200, 201), resp.text
    assert VALUE not in resp.text
    with acting_as("mia", "member"):
        assert resolve_secret_env({"NPM_TOKEN": "npm-token"}) == {"NPM_TOKEN": VALUE}
    with acting_as("tom", "member"), pytest.raises(Exception):
        resolve_secret_env({"NPM_TOKEN": "npm-token"})
    _assert_nowhere(VALUE, home, caplog.text)
