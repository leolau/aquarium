"""Endpoint tests for the dashboard session-chat + create-session routes.

Real ``SessionDB`` (SQLite under a throwaway ``HERMES_HOME``) exercises the DB
boundary; the C1 principal resolver and the one-brain turn are stubbed so the
tests stay hermetic and focus on the endpoint's contract:

* ``POST /api/sessions`` creates an owner-attributed session row (and rejects
  unsafe ids / conflicts);
* ``POST /api/sessions/{id}/chat`` loads the persisted history and forwards it
  **verbatim** to the shared one-brain runner (no synthetic message, no
  ephemeral system prompt), returns the assistant reply + usage, and 404s an
  unknown session / 400s an empty message.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    try:
        import hermes_constants

        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    except (ImportError, AttributeError):
        pass
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    return tmp_path


@pytest.fixture
def client(monkeypatch):
    try:
        from starlette.testclient import TestClient
    except ImportError:  # pragma: no cover
        pytest.skip("fastapi/starlette not installed")

    from hermes_cli import web_server
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    # Resolve to the enrolled owner without a Postgres principal store.
    owner = SimpleNamespace(user_id="root", display="Root Owner", role="owner", is_owner=True)

    async def _fake_principal(request, *, allow_as=False):
        return owner

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def capture_turn(monkeypatch):
    """Stub the one-brain runner, capturing what the endpoint forwards."""
    import gateway.session_chat as session_chat

    captured: dict = {}

    def _fake_turn(*, session_db, user_message, conversation_history, session_id=None, **kwargs):
        captured["session_db"] = session_db
        captured["user_message"] = user_message
        captured["conversation_history"] = conversation_history
        captured["session_id"] = session_id
        captured["kwargs"] = kwargs
        # Observe the approval surface as the agent thread would see it: the
        # streaming path binds a per-run approval session key and registers a
        # notify callback under it, which is exactly what the non-streaming
        # path omitted (→ the `no_surface` calendar bug).
        from tools import approval as _ap

        key = _ap.get_current_session_key(default="")
        captured["approval_session_key"] = key
        captured["surface_registered"] = key in _ap._gateway_notify_cbs
        captured["gateway_ctx"] = _ap._is_gateway_approval_context()
        return (
            {"final_response": f"echo:{user_message}", "session_id": session_id},
            {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _fake_turn)
    return captured


@pytest.fixture
def trace_probe(monkeypatch):
    """Stub the C8 ledger, keeping the real ``InteractionTrace`` buffer.

    Tracing needs Postgres; the trace object itself doesn't, so minting is
    redirected here and the flushed rows are asserted directly.
    """
    from hermes_cli import interactions

    state: dict = {"flushed": [], "mint": []}

    class _Ledger:
        async def flush(self, trace):
            state["flushed"].append(tuple(trace.events))

    def _fake_create_trace(
        *, config, actor_user_id, session_key, platform, source=None, mode=None,
    ):
        state["mint"].append(
            {
                "actor_user_id": actor_user_id,
                "session_key": session_key,
                "platform": platform,
                "mode": mode,
            }
        )
        trace = interactions.InteractionTrace(
            actor_user_id=actor_user_id,
            session_key=session_key,
            platform=platform,
            mode=mode or "prod",
        )
        state["trace"] = trace
        return trace, _Ledger()

    monkeypatch.setattr(interactions, "create_trace", _fake_create_trace)
    return state


@pytest.fixture
def turn_observes(monkeypatch):
    """Runner stub that emits a `turn` row the way the real loop does."""
    import gateway.session_chat as session_chat
    from hermes_cli.interactions import current_trace, observe

    seen: dict = {}

    def _fake_turn(*, session_db, user_message, conversation_history,
                   session_id=None, **kwargs):
        seen["bound_trace"] = current_trace()
        observe("turn", ref="turn_1", summary="turn")
        return (
            {"final_response": f"echo:{user_message}", "session_id": session_id},
            {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _fake_turn)
    return seen


def _rows(state):
    assert len(state["flushed"]) == 1, "the trace is flushed exactly once"
    return state["flushed"][0]


@pytest.mark.parametrize("path", ["chat", "chat/stream"])
def test_chat_writes_one_agent_home_trace(client, trace_probe, turn_observes, path):
    """agent-home turns land in the C8 ledger as their own platform.

    Before this, only the gateway minted traces, so Activity showed channel
    traffic only and every row was labelled with a channel platform.
    """
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-trace", source="agent_home")
    finally:
        db.close()

    resp = client.post(f"/api/sessions/s-trace/{path}", json={"message": "hi"})
    assert resp.status_code == 200

    assert trace_probe["mint"] == [
        {
            "actor_user_id": "root",
            "session_key": "s-trace",
            "platform": "agent_home",
            "mode": "prod",
        }
    ]
    # The agent thread saw the trace bound, so tool spans join this trace.
    assert turn_observes["bound_trace"] is trace_probe["trace"]

    rows = _rows(trace_probe)
    assert [r.kind for r in rows] == ["inbound", "turn", "outbound"]
    assert {r.trace_id for r in rows} == {trace_probe["trace"].trace_id}
    assert {r.platform for r in rows} == {"agent_home"}
    # inbound → turn → outbound is a single causation chain (FG-16 C8).
    assert rows[0].parent_id is None
    assert rows[1].parent_id == rows[0].id
    assert rows[2].parent_id == rows[1].id


@pytest.mark.parametrize("path", ["chat", "chat/stream"])
def test_chat_survives_trace_failure(client, capture_turn, monkeypatch, path):
    """Tracing is observability: a broken ledger must not fail the turn."""
    from hermes_cli import interactions
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-notrace", source="agent_home")
    finally:
        db.close()

    def _boom(**kwargs):
        raise RuntimeError("supabase-app store is not configured")

    monkeypatch.setattr(interactions, "create_trace", _boom)

    resp = client.post(f"/api/sessions/s-notrace/{path}", json={"message": "hi"})
    assert resp.status_code == 200
    assert "echo:hi" in resp.text
    assert capture_turn["user_message"] == "hi"


def test_create_session_returns_id(client):
    resp = client.post("/api/sessions", json={})
    assert resp.status_code == 200
    data = resp.json()
    assert data["session_id"].startswith("home_")
    assert data["source"] == "agent_home"


def test_create_session_rejects_unsafe_id(client):
    resp = client.post("/api/sessions", json={"id": "../etc/passwd"})
    assert resp.status_code == 400


def test_create_session_conflict(client):
    resp = client.post("/api/sessions", json={"id": "dup-1"})
    assert resp.status_code == 200
    again = client.post("/api/sessions", json={"id": "dup-1"})
    assert again.status_code == 409


def test_chat_empty_message_rejected(client, capture_turn):
    client.post("/api/sessions", json={"id": "s-empty"})
    resp = client.post("/api/sessions/s-empty/chat", json={"message": "   "})
    assert resp.status_code == 400
    assert "message" not in capture_turn  # runner never invoked


def test_chat_unknown_session_404(client, capture_turn):
    resp = client.post("/api/sessions/does-not-exist/chat", json={"message": "hi"})
    assert resp.status_code == 404
    assert "user_message" not in capture_turn


def test_chat_roundtrip_forwards_history_verbatim(client, capture_turn):
    import hermes_state

    # Seed a real alternating transcript in the throwaway SessionDB.
    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-hist", source="agent_home")
        db.append_message("s-hist", "user", "first")
        db.append_message("s-hist", "assistant", "second")
        expected = db.get_messages_as_conversation("s-hist")
    finally:
        db.close()

    resp = client.post("/api/sessions/s-hist/chat", json={"message": "third"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["message"] == {"role": "assistant", "content": "echo:third"}
    assert data["usage"] == {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
    assert data["session_id"] == "s-hist"

    # The endpoint forwarded the persisted history unchanged (cache/alternation
    # safety: no synthetic user turn appended, message passed separately).
    assert capture_turn["conversation_history"] == expected
    assert capture_turn["user_message"] == "third"
    assert capture_turn["session_id"] == "s-hist"
    # No ephemeral system prompt is smuggled through kwargs.
    assert "ephemeral_system_prompt" not in capture_turn["kwargs"]


def test_chat_stream_roundtrip_and_attaches_approval_surface(client, capture_turn):
    """The streamed turn returns SSE and — the fix — attaches a per-run approval
    surface so a gated tool can prompt instead of failing closed (`no_surface`).
    """
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-stream", source="agent_home")
        db.append_message("s-stream", "user", "first")
        expected = db.get_messages_as_conversation("s-stream")
    finally:
        db.close()

    resp = client.post("/api/sessions/s-stream/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["x-hermes-session-id"] == "s-stream"

    body = resp.text
    assert "event: assistant.completed" in body
    assert "echo:hi" in body
    assert "event: run.completed" in body
    assert "event: done" in body

    # History forwarded verbatim (cache/alternation safety), and the message
    # passed separately — same contract as the non-streaming endpoint.
    assert capture_turn["conversation_history"] == expected
    assert capture_turn["user_message"] == "hi"
    # The surface: a per-run key was bound AND a notify_cb registered under it
    # while the turn ran. This is the exact state whose absence returned
    # `no_surface` for the calendar tool in agent-home.
    assert capture_turn["approval_session_key"].startswith("run_")
    assert capture_turn["surface_registered"] is True
    assert capture_turn["gateway_ctx"] is True
    # Provider deltas are wired through to the browser.
    assert callable(capture_turn["kwargs"].get("stream_delta_callback"))

    # …and it is torn down after the turn (no leaked global callback).
    from tools import approval as _ap

    assert capture_turn["approval_session_key"] not in _ap._gateway_notify_cbs


def test_chat_stream_emits_every_delta_in_order(client, monkeypatch):
    """Regression for "only shows the first couple of characters then stopped":
    every provider delta the runner streams must appear as its own
    `assistant.delta` frame, in order, followed by the full completed content.
    (The truncation was a browser-side identity bug, but this pins the server
    contract the client depends on: one frame per delta, not just the first.)
    """
    import hermes_state
    import gateway.session_chat as session_chat

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-multi", source="agent_home")
    finally:
        db.close()

    parts = ["I'm", " powered", " by", " GLM-5.2", "."]

    def _streaming_turn(*, session_db, user_message, conversation_history,
                        session_id=None, stream_delta_callback=None, **kwargs):
        for p in parts:
            stream_delta_callback(p)
        return (
            {"final_response": "".join(parts), "session_id": session_id},
            {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _streaming_turn)

    resp = client.post("/api/sessions/s-multi/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    body = resp.text

    # One delta frame per part, and they arrive in order.
    assert body.count("event: assistant.delta") == len(parts)
    positions = [body.index(f'"delta": "{p}"') for p in parts]
    assert positions == sorted(positions)
    # The completed frame carries the full concatenation.
    assert 'event: assistant.completed' in body
    assert "I'm powered by GLM-5.2." in body
    assert body.index("event: assistant.completed") > positions[-1]


def test_chat_stream_emits_reasoning_and_tool_activity(client, monkeypatch):
    """Long turns must not look frozen: reasoning deltas and tool lifecycle
    events reach the browser as SSE frames, without leaking tool args/results.
    """
    import hermes_state
    import gateway.session_chat as session_chat

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-activity", source="agent_home")
    finally:
        db.close()

    def _active_turn(*, session_db, user_message, conversation_history,
                     session_id=None, reasoning_callback=None,
                     tool_start_callback=None, tool_complete_callback=None,
                     **kwargs):
        assert reasoning_callback is not None
        assert tool_start_callback is not None
        assert tool_complete_callback is not None
        reasoning_callback("checking the run…")
        tool_start_callback("tc1", "execute_code", {"secret": "hunter2"})
        tool_complete_callback("tc1", "execute_code", {"secret": "hunter2"}, "ok")
        return (
            {"final_response": "done", "session_id": session_id},
            {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _active_turn)

    resp = client.post("/api/sessions/s-activity/chat/stream", json={"message": "hi"})
    assert resp.status_code == 200
    body = resp.text

    assert "event: reasoning.delta" in body
    assert "checking the run…" in body
    assert "event: tool.start" in body
    assert "event: tool.complete" in body
    assert '"tool_id": "tc1"' in body
    assert '"name": "execute_code"' in body
    # Args/results never leave the server.
    assert "hunter2" not in body


def test_chat_stream_unknown_session_404(client, capture_turn):
    resp = client.post("/api/sessions/nope/chat/stream", json={"message": "hi"})
    assert resp.status_code == 404
    assert "user_message" not in capture_turn


def test_run_approval_normalizes_choice_and_resolves(client, monkeypatch):
    """The resolve route forwards the user's explicit choice to the existing
    gateway approval mechanism (mapping the UI 'approve' alias to 'once')."""
    from tools import approval as _ap

    calls: dict = {}

    def _fake_resolve(session_key, choice, resolve_all=False):
        calls["session_key"] = session_key
        calls["choice"] = choice
        calls["resolve_all"] = resolve_all
        return 1

    monkeypatch.setattr(_ap, "resolve_gateway_approval", _fake_resolve)

    resp = client.post("/v1/runs/run_abc/approval", json={"choice": "approve"})
    assert resp.status_code == 200
    assert resp.json() == {
        "object": "hermes.run.approval",
        "run_id": "run_abc",
        "choice": "once",
        "resolved": 1,
    }
    assert calls == {"session_key": "run_abc", "choice": "once", "resolve_all": False}


def test_run_approval_rejects_invalid_choice(client, monkeypatch):
    from tools import approval as _ap

    def _boom(*a, **k):  # must never be reached
        raise AssertionError("resolve_gateway_approval called for invalid choice")

    monkeypatch.setattr(_ap, "resolve_gateway_approval", _boom)
    resp = client.post("/v1/runs/run_abc/approval", json={"choice": "maybe"})
    assert resp.status_code == 400


def test_active_run_and_attach_replay_the_turn(monkeypatch):
    """Reload mid-turn: ``active_run`` names the in-flight turn, and a
    reloaded page re-attaches — the attach stream replays the buffered
    events and carries the live tail, so content keeps flowing.

    A real uvicorn server in a thread: the test client's primary stream,
    active probe and attach are genuinely concurrent with the turn.
    """
    import asyncio
    import socket
    import threading
    import time as _time
    from types import SimpleNamespace

    import httpx
    import uvicorn

    import hermes_state
    import gateway.session_chat as session_chat
    from hermes_cli import web_server
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    owner = SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)

    async def _fake_principal(request, *, allow_as=False):
        return owner

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-attach", source="agent_home")
    finally:
        db.close()

    def _slow_turn(*, session_db, user_message, conversation_history,
                   session_id=None, stream_delta_callback=None, **kwargs):
        if stream_delta_callback:
            stream_delta_callback("part one ")
        _time.sleep(1.5)
        return (
            {"final_response": "part one two", "session_id": session_id},
            {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
        )

    monkeypatch.setattr(session_chat, "run_session_turn_sync", _slow_turn)

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(
        uvicorn.Config(
            app, host="127.0.0.1", port=port, log_level="error", lifespan="off"
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        _time.sleep(0.05)
    assert server.started, "uvicorn did not start"

    headers = {_SESSION_HEADER_NAME: _SESSION_TOKEN}
    base = f"http://127.0.0.1:{port}"

    async def _scenario():
        async with httpx.AsyncClient(base_url=base, headers=headers) as ac:
            async with ac.stream(
                "POST", "/api/sessions/s-attach/chat/stream", json={"message": "hi"}
            ) as primary:
                # The in-flight turn is discoverable while it runs…
                run_id = None
                for _ in range(40):
                    active = (await ac.get("/api/sessions/s-attach/active_run")).json()
                    if active["run_id"]:
                        run_id = active["run_id"]
                        break
                    await asyncio.sleep(0.05)
                assert run_id, "the in-flight turn must be discoverable"

                # …a reloaded page re-attaches and receives buffer plus tail.
                async with ac.stream(
                    "POST",
                    "/api/sessions/s-attach/chat/stream/attach",
                    json={"run_id": run_id},
                ) as attach:
                    assert attach.headers["content-type"].startswith(
                        "text/event-stream"
                    )
                    attach_body = (await attach.aread()).decode()
                primary_body = (await primary.aread()).decode()

            assert "part one two" in primary_body
            assert '"delta": "part one "' in attach_body
            assert "event: assistant.completed" in attach_body
            assert "event: done" in attach_body

            # Once finished there is nothing active…
            assert (await ac.get("/api/sessions/s-attach/active_run")).json() == {
                "run_id": None, "pending": []
            }
            # …but the grace-window replay still serves a just-reloaded page.
            again = await ac.post(
                "/api/sessions/s-attach/chat/stream/attach", json={"run_id": run_id}
            )
            assert again.status_code == 200
            assert "event: done" in again.text
            # A run id from another session (or unknown) cannot be attached.
            bad = await ac.post(
                "/api/sessions/s-other/chat/stream/attach", json={"run_id": run_id}
            )
            assert bad.status_code == 404

    try:
        asyncio.run(_scenario())
    finally:
        server.should_exit = True
        thread.join(5)
