"""FG-37: a streamed agent-home turn surfaces ``secret.request`` over SSE.

The fake agent calls the real ``request_secret`` tool; the test answers the
popup the way the browser does (the registry ``fulfil``) and checks the event
carries metadata only, the run status reads ``waiting_for_secret`` while it
blocks, and the tool result names the secret without its value.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from hermes_cli import secret_requests as sr
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore
from hermes_state import SessionDB

VALUE = "ghp_" + "StreamSecret" * 3
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
    return tmp_path


@pytest.fixture
def adapter(home):
    db = SessionDB(home / "state.db")
    adapter = APIServerAdapter(PlatformConfig(enabled=True))
    adapter._session_db = db
    yield adapter
    db.close()


class _SecretAgent:
    session_prompt_tokens = session_completion_tokens = session_total_tokens = 0

    def __init__(self, session_id, observed):
        self.session_id = session_id
        self._observed = observed

    def run_conversation(self, user_message, conversation_history, task_id):
        from tools.access_policy import acting_as
        from tools.secret_request_tool import request_secret_tool

        with acting_as("mia", "member"):
            out = request_secret_tool(
                name="github-pat", label="GitHub PAT", purpose="Push the fix", timeout=10
            )
        self._observed["result"] = out
        return {"final_response": out, "session_id": self.session_id}


def _events(buffer: str):
    for block in buffer.split("\n\n"):
        name = data = None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if name:
            yield name, data


@pytest.mark.asyncio
async def test_session_chat_stream_emits_secret_request(adapter, monkeypatch):
    session_id = adapter._session_db.create_session("home_secret", "api_server")
    observed = {}
    monkeypatch.setattr(
        adapter, "_create_agent", lambda **kw: _SecretAgent(kw.get("session_id"), observed)
    )
    app = web.Application()
    app.router.add_post("/api/sessions/{session_id}/chat/stream", adapter._handle_session_chat_stream)

    async with TestClient(TestServer(app)) as cli:
        resp = await cli.post(f"/api/sessions/{session_id}/chat/stream", json={"message": "push it"})
        assert resp.status == 200
        buffer, event = "", None
        while event is None:
            chunk = await asyncio.wait_for(resp.content.read(512), timeout=10)
            assert chunk, buffer
            buffer += chunk.decode()
            event = next((d for n, d in _events(buffer) if n == "secret.request"), None)
        assert event["request_id"].startswith("sr_")
        assert event["name"] == "github-pat" and event["kind"] == "secret"
        assert event["message_id"] and event["expires_at"] > 0
        assert [r["status"] for r in adapter._run_statuses.values()] == ["waiting_for_secret"]

        await asyncio.get_running_loop().run_in_executor(
            None, lambda: sr.fulfil(event["request_id"], principal=MIA, values={"value": VALUE})
        )
        while True:
            chunk = await asyncio.wait_for(resp.content.read(512), timeout=10)
            if not chunk:
                break
            buffer += chunk.decode()

    names = [n for n, _ in _events(buffer)]
    assert "secret.resolved" in names and "run.completed" in names
    assert json.loads(observed["result"]) == {"status": "stored", "secret": "github-pat", "kind": "secret"}
    assert VALUE not in buffer


@pytest.mark.asyncio
async def test_run_agent_surface_does_not_outlive_the_run(adapter, monkeypatch):
    from tools import secret_request_tool as tool

    observed = {}
    monkeypatch.setattr(
        adapter, "_create_agent", lambda **kw: _SecretAgent(kw.get("session_id"), observed)
    )
    seen = []

    def notify(event):
        seen.append(event)
        sr.decline(event["request_id"])

    await adapter._run_agent(
        user_message="x",
        conversation_history=[],
        session_id="home_2",
        gateway_session_key="home_2",
        gateway_notify_cb=lambda _d: None,
        approval_session_key="run_2",
        secret_notify_cb=notify,
    )
    assert json.loads(observed["result"]) == {"status": "declined"}
    assert len(seen) == 1
    assert tool._surface_for("run_2") is None
