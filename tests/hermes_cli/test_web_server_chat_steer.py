"""Input sent while a turn works: steer / queue / interrupt (agent-home chat).

``POST /api/sessions/{sid}/chat/stream/steer`` hands text to a running turn:
``steer`` writes it into the next tool result (``AIAgent.steer``), ``queue``
runs it as its own turn afterwards and ``interrupt`` stops the turn and runs
it first. Whatever is still owed when a turn ends is started by the server as
the next turn and announced as ``run.chained``.

The first tests run the real ``AIAgent`` loop (fake model client) behind a
real uvicorn server under a temp ``HERMES_HOME``; the chaining tests stub the
turn so its timing is deterministic; access tests drive the registry through
the in-process test client.
"""

from __future__ import annotations

import asyncio
import copy
import json
import socket
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

OWNER = SimpleNamespace(user_id="root", display="Root", role="owner", is_owner=True)
MIA = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VERA = SimpleNamespace(user_id="vera", display="Vera", role="viewer", is_owner=False)
USAGE = {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}


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


@pytest.fixture(autouse=True)
def _fresh_registry():
    from hermes_cli import web_server

    web_server._CHAT_RUNS.clear()
    yield
    web_server._CHAT_RUNS.clear()


@pytest.fixture
def acting(monkeypatch):
    """``acting["as"]`` is the logged-in principal."""
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["as"].user_id)
    return state


@pytest.fixture
def chat():
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session("s-chat", source="agent_home", user_id="root")
        db.ensure_session("s-other", source="agent_home", user_id="root")
        db.ensure_session("s-tom", source="agent_home", user_id="tom")
    finally:
        db.close()
    return "s-chat"


@pytest.fixture
def base(acting, chat):
    import uvicorn

    from hermes_cli.web_server import app

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", lifespan="off")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if server.started:
            break
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(5)


def _client(base):
    import httpx

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN

    return httpx.AsyncClient(
        base_url=base, headers={_SESSION_HEADER_NAME: _SESSION_TOKEN}, timeout=20
    )


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


async def _stream(ac, sid: str, message: str) -> str:
    async with ac.stream("POST", f"/api/sessions/{sid}/chat/stream", json={"message": message}) as r:
        assert r.status_code == 200, (await r.aread()).decode()
        return (await r.aread()).decode()


async def _live_run(ac, sid: str) -> str:
    for _ in range(400):
        run_id = (await ac.get(f"/api/sessions/{sid}/active_run")).json()["run_id"]
        if run_id:
            return run_id
        await asyncio.sleep(0.02)
    raise AssertionError("no live run")


async def _until_idle(ac, sid: str) -> None:
    for _ in range(500):
        if (await ac.get(f"/api/sessions/{sid}/active_run")).json()["run_id"] is None:
            return
        await asyncio.sleep(0.02)
    raise AssertionError("the chain never went idle")


async def _chain_bodies(ac, sid: str, first: str) -> list:
    """The SSE bodies of a turn and of every turn chained after it."""
    bodies = [first]
    while True:
        chained = [d for n, d in _events(bodies[-1]) if n == "run.chained"]
        if not chained:
            return bodies
        r = await ac.post(
            f"/api/sessions/{sid}/chat/stream/attach", json={"run_id": chained[0]["next_run_id"]}
        )
        assert r.status_code == 200
        bodies.append(r.text)


async def _send(ac, sid: str, run_id: str, text: str, mode: str = "steer"):
    return await ac.post(
        f"/api/sessions/{sid}/chat/stream/steer", json={"run_id": run_id, "text": text, "mode": mode}
    )


def _assert_run_ids(body: str) -> None:
    for name, data in _events(body):
        assert data.get("run_id"), f"{name} frame has no run_id"


def _assert_alternates(messages: list) -> None:
    roles = [m["role"] for m in messages if m["role"] in ("user", "assistant")]
    convo = [m["role"] for m in messages if m["role"] != "system"]
    for a, b in zip(convo, convo[1:]):
        assert not (a == b == "user") and not (a == b == "assistant"), convo
    assert roles, messages


# ---------------------------------------------------------------------------
# Real AIAgent loop
# ---------------------------------------------------------------------------


def _mock_response(content="", finish_reason="stop", tool_calls=None):
    msg = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=msg, finish_reason=finish_reason)
    return SimpleNamespace(choices=[choice], model="test/model", usage=None)


def _tool_call_response():
    call = SimpleNamespace(
        id="call_1", type="function", function=SimpleNamespace(name="web_search", arguments="{}")
    )
    return _mock_response(finish_reason="tool_calls", tool_calls=[call])


@pytest.fixture
def real_agent(monkeypatch, tmp_path):
    """Turns run the real ``AIAgent`` conversation loop; ``model`` scripts the
    model's replies and records the messages it was sent."""
    import gateway.session_chat as session_chat
    import run_agent
    from run_agent import AIAgent

    model = SimpleNamespace(calls=[], replies=[])
    lock = threading.Lock()

    def _create(**kwargs):
        with lock:
            model.calls.append(copy.deepcopy(kwargs["messages"]))
            reply = model.replies.pop(0)
        return reply() if callable(reply) else reply

    tool_defs = [
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "search",
                "parameters": {"type": "object", "properties": {}},
            },
        }
    ]

    def _build(*, session_db, session_id=None, stream_delta_callback=None,
               tool_start_callback=None, tool_complete_callback=None, **kwargs):
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
    model.tool_entered = threading.Event()
    model.tool_release = threading.Event()

    def _tool(name, args, *a, **kw):
        model.tool_entered.set()
        model.tool_release.wait(10)
        return json.dumps({"results": ["log line"]})

    monkeypatch.setattr(run_agent, "handle_function_call", _tool)
    return model


def test_steer_lands_inside_the_last_tool_result(base, chat, real_agent):
    from agent.prompt_builder import STEER_MARKER_CLOSE, STEER_MARKER_OPEN

    real_agent.replies[:] = [_tool_call_response(), _mock_response("checked auth.log too")]

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "what's in /var/log?"))
            run_id = await _live_run(ac, chat)
            await asyncio.to_thread(real_agent.tool_entered.wait, 10)
            r = await _send(ac, chat, run_id, "also check auth.log")
            assert r.status_code == 200, r.text
            accepted = r.json()
            assert accepted["mode"] == "steer" and accepted["status"] == "pending"
            pending = (await ac.get(f"/api/sessions/{chat}/active_run")).json()["pending"]
            assert [(p["item_id"], p["mode"], p["text"]) for p in pending] == [
                (accepted["item_id"], "steer", "also check auth.log")
            ]
            real_agent.tool_release.set()
            body = await primary
            await _until_idle(ac, chat)
            return accepted, body

    accepted, body = asyncio.run(_scenario())
    names = [n for n, _ in _events(body)]
    assert "run.chained" not in names
    steered = [d for n, d in _events(body) if n == "input.steered"]
    assert [d["item_id"] for d in steered] == [accepted["item_id"]]
    assert names.index("input.accepted") < names.index("input.steered") < names.index("done")
    _assert_run_ids(body)

    # What the model saw next: the same tool result, carrying the steer.
    second = real_agent.calls[1]
    assert second[-1]["role"] == "tool"
    content = second[-1]["content"]
    assert content.startswith('{"results": ["log line"]}')
    assert f"{STEER_MARKER_OPEN}\nalso check auth.log\n{STEER_MARKER_CLOSE}" in content
    _assert_alternates(second)
    assert sum(1 for m in second if m["role"] == "user") == 1

    import hermes_state

    db = hermes_state.SessionDB()
    try:
        stored = db.get_messages_as_conversation(chat)
    finally:
        db.close()
    # A reloaded transcript (and the next turn's history) has the steer too.
    from agent.prompt_builder import format_steer_marker

    tool_rows = [m for m in stored if m["role"] == "tool"]
    assert tool_rows[-1]["content"] == content
    assert tool_rows[-1]["content"].endswith(format_steer_marker("also check auth.log"))
    assert [m["content"] for m in stored if m["role"] == "user"] == ["what's in /var/log?"]


def test_steer_the_turn_did_not_read_becomes_the_next_turn(base, chat, real_agent):
    thinking = threading.Event()
    answer = threading.Event()

    def _slow_final():
        thinking.set()
        answer.wait(10)
        return _mock_response("here is the answer")

    real_agent.replies[:] = [_slow_final, _mock_response("ok, in French then")]

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "summarise the doc"))
            run_id = await _live_run(ac, chat)
            await asyncio.to_thread(thinking.wait, 10)
            r = await _send(ac, chat, run_id, "answer in French")
            assert r.status_code == 200, r.text
            answer.set()
            bodies = await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)
            return r.json(), bodies

    accepted, bodies = asyncio.run(_scenario())
    assert len(bodies) == 2
    first = _events(bodies[0])
    names = [n for n, _ in first]
    assert ("input.deferred", {"item_id": accepted["item_id"], "run_id": first[0][1]["run_id"]}) in first
    chained = next(d for n, d in first if n == "run.chained")
    assert chained["source"] == "steer_leftover"
    assert chained["item_id"] == accepted["item_id"]
    assert chained["text"] == "answer in French"
    assert names.index("input.deferred") < names.index("run.chained") < names.index("done")
    for body in bodies:
        _assert_run_ids(body)

    nxt = real_agent.calls[1]
    assert nxt[-1] == {"role": "user", "content": "answer in French"} or (
        nxt[-1]["role"] == "user" and nxt[-1]["content"] == "answer in French"
    )
    _assert_alternates(nxt)
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        stored = db.get_messages_as_conversation(chat)
    finally:
        db.close()
    assert [(m["role"], m["content"]) for m in stored] == [
        ("user", "summarise the doc"),
        ("assistant", "here is the answer"),
        ("user", "answer in French"),
        ("assistant", "ok, in French then"),
    ]


def test_steer_written_into_an_interrupted_tool_result_runs_after_the_interrupt(
    base, chat, real_agent
):
    from agent.prompt_builder import STEER_MARKER_OPEN

    real_agent.replies[:] = [
        _tool_call_response(),
        _mock_response("looking at nginx"),
        _mock_response("checked auth.log too"),
    ]

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "what's in /var/log?"))
            run_id = await _live_run(ac, chat)
            await asyncio.to_thread(real_agent.tool_entered.wait, 10)
            steer = (await _send(ac, chat, run_id, "also check auth.log")).json()
            stop = (await _send(ac, chat, run_id, "no, look at nginx instead", "interrupt")).json()
            real_agent.tool_release.set()
            bodies = await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)
            return steer, stop, bodies

    steer, stop, bodies = asyncio.run(_scenario())
    assert len(bodies) == 3
    first = _events(bodies[0])
    # The steer reached the tool result but no request carried it: not delivered.
    assert not [d for b in bodies for n, d in _events(b) if n == "input.steered"]
    assert [d["item_id"] for n, d in first if n == "input.deferred"] == [steer["item_id"]]
    chained = [next(d for n, d in _events(b) if n == "run.chained") for b in bodies[:2]]
    assert [(c["item_id"], c["source"]) for c in chained] == [
        (stop["item_id"], "interrupt"), (steer["item_id"], "steer_leftover")
    ]
    assert len(real_agent.calls) == 3
    assert real_agent.calls[1][-1]["content"] == "no, look at nginx instead"
    assert real_agent.calls[2][-1]["content"] == "also check auth.log"
    for call in real_agent.calls:
        _assert_alternates(call)
        assert not any(STEER_MARKER_OPEN in str(m.get("content")) for m in call)

    import hermes_state

    db = hermes_state.SessionDB()
    try:
        stored = db.get_messages_as_conversation(chat)
    finally:
        db.close()
    assert [m["content"] for m in stored if m["role"] == "user"] == [
        "what's in /var/log?", "no, look at nginx instead", "also check auth.log"
    ]
    assert not any(STEER_MARKER_OPEN in str(m.get("content")) for m in stored)


# ---------------------------------------------------------------------------
# Chaining (stubbed turn)
# ---------------------------------------------------------------------------


class _StubAgent:
    def __init__(self, gate, session_id=None):
        self.gate = gate
        self.session_id = session_id
        self.steers: list = []
        self.interrupted = False
        self.steer_delivered_callback = None

    def steer(self, text):
        self.steers.append(text)
        return True

    def interrupt(self, message=None):
        self.interrupted = True
        if self.gate is not None:
            self.gate.set()

    def _drain_pending_steer(self):
        return None


class _Turns:
    def __init__(self):
        self.messages: list = []
        self.histories: list = []
        self.agents: list = []
        self.gates: dict = {}
        self.before_ready = None

    def hold(self, message):
        self.gates[message] = threading.Event()

    def release(self, message):
        self.gates[message].set()

    def __call__(self, *, session_db, user_message, conversation_history,
                 session_id=None, on_agent_ready=None, principal=None, **kwargs):
        agent = _StubAgent(self.gates.get(user_message), session_id)
        self.messages.append(user_message)
        self.histories.append([(m["role"], m["content"]) for m in conversation_history])
        self.agents.append(agent)
        self.principals = getattr(self, "principals", []) + [principal]
        if self.before_ready is not None:
            self.before_ready.wait(10)
        if on_agent_ready is not None:
            on_agent_ready(agent)
        fork = getattr(self, "compress_into", {}).get(user_message)
        if fork:
            # What context compression does mid-turn: end this session and
            # carry on under a continuation child.
            session_db.end_session(session_id, "compression")
            session_db.ensure_session(
                fork, source="agent_home", user_id="root", parent_session_id=session_id
            )
            agent.session_id = fork
            self.compressed.set()
        if agent.gate is not None:
            agent.gate.wait(10)
        reply = "stopped" if agent.interrupted else f"re:{user_message}"
        session_db.append_message(session_id, "user", user_message)
        session_db.append_message(session_id, "assistant", reply)
        return {"final_response": reply, "session_id": session_id}, USAGE


@pytest.fixture
def turns(monkeypatch):
    import gateway.session_chat as session_chat

    t = _Turns()
    monkeypatch.setattr(session_chat, "run_session_turn_sync", t)
    return t


def test_queue_runs_each_message_as_its_own_turn_in_order(base, chat, turns):
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            q1 = (await _send(ac, chat, run_id, "then do A", "queue")).json()
            q2 = (await _send(ac, chat, run_id, "then do B", "queue")).json()
            assert q1["status"] == q2["status"] == "queued"
            pending = (await ac.get(f"/api/sessions/{chat}/active_run")).json()["pending"]
            assert [(p["item_id"], p["mode"]) for p in pending] == [
                (q1["item_id"], "queue"), (q2["item_id"], "queue")
            ]
            turns.release("first")
            bodies = await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)
            return q1, q2, bodies

    q1, q2, bodies = asyncio.run(_scenario())
    assert turns.messages == ["first", "then do A", "then do B"]
    assert all(p is OWNER for p in turns.principals)
    # Each chained turn sees everything persisted before it.
    assert turns.histories[1] == [("user", "first"), ("assistant", "re:first")]
    assert turns.histories[2][-2:] == [("user", "then do A"), ("assistant", "re:then do A")]
    assert len(bodies) == 3
    chained = [next(d for n, d in _events(b) if n == "run.chained") for b in bodies[:2]]
    assert [(c["item_id"], c["source"], c["text"]) for c in chained] == [
        (q1["item_id"], "queue", "then do A"),
        (q2["item_id"], "queue", "then do B"),
    ]
    for body in bodies:
        names = [n for n, _ in _events(body)]
        if "run.chained" in names:
            assert names.index("run.chained") < names.index("done")
        _assert_run_ids(body)
    accepted = [d for n, d in _events(bodies[0]) if n == "input.accepted"]
    assert [(a["item_id"], a["mode"], a["text"]) for a in accepted] == [
        (q1["item_id"], "queue", "then do A"), (q2["item_id"], "queue", "then do B")
    ]


def test_interrupt_stops_the_turn_and_runs_first(base, chat, turns):
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            queued = (await _send(ac, chat, run_id, "later", "queue")).json()
            stop = (await _send(ac, chat, run_id, "no, do this instead", "interrupt")).json()
            assert stop["status"] == "queued"
            bodies = await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)
            return queued, stop, bodies

    queued, stop, bodies = asyncio.run(_scenario())
    assert turns.agents[0].interrupted
    assert turns.messages == ["first", "no, do this instead", "later"]
    chained = [next(d for n, d in _events(b) if n == "run.chained") for b in bodies[:2]]
    assert [(c["item_id"], c["source"]) for c in chained] == [
        (stop["item_id"], "interrupt"), (queued["item_id"], "queue")
    ]


def test_steer_before_the_agent_exists_is_held_then_applied(base, chat, turns):
    turns.before_ready = threading.Event()
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            r = (await _send(ac, chat, run_id, "keep it short")).json()
            assert r["status"] == "pending"
            turns.before_ready.set()
            for _ in range(200):
                if turns.agents and turns.agents[0].steers:
                    break
                await asyncio.sleep(0.02)
            turns.release("first")
            bodies = await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)
            return r, bodies

    r, bodies = asyncio.run(_scenario())
    assert turns.agents[0].steers == ["keep it short"]
    # The stub never drains the steer, so it is owed as the next turn.
    first = _events(bodies[0])
    assert [d["item_id"] for n, d in first if n == "input.deferred"] == [r["item_id"]]
    chained = next(d for n, d in first if n == "run.chained")
    assert (chained["item_id"], chained["source"]) == (r["item_id"], "steer_leftover")
    assert turns.messages == ["first", "keep it short"]


def test_order_is_interrupt_then_leftover_steer_then_queue(base, chat, turns):
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            for _ in range(200):
                if turns.agents:
                    break
                await asyncio.sleep(0.02)
            await _send(ac, chat, run_id, "q1", "queue")
            await _send(ac, chat, run_id, "s1", "steer")
            await _send(ac, chat, run_id, "i1", "interrupt")
            await _chain_bodies(ac, chat, await primary)
            await _until_idle(ac, chat)

    asyncio.run(_scenario())
    assert turns.messages == ["first", "i1", "s1", "q1"]


def test_send_while_working_and_input_after_finish_are_409(base, chat, turns):
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            busy = await ac.post(f"/api/sessions/{chat}/chat/stream", json={"message": "second"})
            assert busy.status_code == 409
            assert busy.json() == {"detail": "turn_in_progress", "run_id": run_id}
            # Another conversation is not blocked by this one.
            other = await ac.post("/api/sessions/s-other/chat/stream", json={"message": "hey"})
            assert other.status_code == 200
            turns.release("first")
            await primary
            await _until_idle(ac, chat)
            late = await _send(ac, chat, run_id, "too late", "queue")
            assert late.status_code == 409
            assert late.json()["detail"] == "run_finished"
            again = await ac.post(f"/api/sessions/{chat}/chat/stream", json={"message": "second"})
            assert again.status_code == 200

    asyncio.run(_scenario())
    assert turns.messages.count("second") == 1


def test_remove_withdraws_only_unstarted_items(base, chat, turns):
    turns.hold("first")
    turns.hold("B")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            a = (await _send(ac, chat, run_id, "A", "queue")).json()
            b = (await _send(ac, chat, run_id, "B", "queue")).json()
            url = f"/api/sessions/{chat}/chat/stream/queue/remove"
            assert (await ac.post(url, json={"run_id": run_id, "item_id": a["item_id"]})).json() == {"removed": True}
            assert (await ac.post(url, json={"run_id": run_id, "item_id": a["item_id"]})).json() == {"removed": False}
            pending = (await ac.get(f"/api/sessions/{chat}/active_run")).json()["pending"]
            assert [p["item_id"] for p in pending] == [b["item_id"]]
            turns.release("first")
            first_body = await primary
            for _ in range(200):
                if "B" in turns.messages:
                    break
                await asyncio.sleep(0.02)
            # B has started: it can no longer be withdrawn, even via the old run id.
            gone = await ac.post(url, json={"run_id": run_id, "item_id": b["item_id"]})
            assert gone.json() == {"removed": False}
            turns.release("B")
            await _until_idle(ac, chat)
            return a, first_body

    a, first_body = asyncio.run(_scenario())
    assert turns.messages == ["first", "B"]
    assert [d["item_id"] for n, d in _events(first_body) if n == "input.removed"] == [a["item_id"]]


def test_remove_follows_the_chain_to_the_run_that_holds_the_queue(base, chat, turns):
    turns.hold("first")
    turns.hold("A")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            await _send(ac, chat, run_id, "A", "queue")
            b = (await _send(ac, chat, run_id, "B", "queue")).json()
            turns.release("first")
            await primary
            for _ in range(200):
                if "A" in turns.messages:
                    break
                await asyncio.sleep(0.02)
            url = f"/api/sessions/{chat}/chat/stream/queue/remove"
            r = await ac.post(url, json={"run_id": run_id, "item_id": b["item_id"]})
            assert r.json() == {"removed": True}
            turns.release("A")
            await _until_idle(ac, chat)

    asyncio.run(_scenario())
    assert turns.messages == ["first", "A"]


def test_stop_discards_what_was_queued(base, chat, turns):
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            for _ in range(200):
                if turns.agents:
                    break
                await asyncio.sleep(0.02)
            q = (await _send(ac, chat, run_id, "later", "queue")).json()
            await ac.post(f"/api/sessions/{chat}/chat/stream/cancel", json={"run_id": run_id})
            body = await primary
            await _until_idle(ac, chat)
            return q, body

    q, body = asyncio.run(_scenario())
    assert turns.messages == ["first"]
    events = _events(body)
    assert "run.chained" not in [n for n, _ in events]
    assert [d["item_id"] for n, d in events if n == "input.removed"] == [q["item_id"]]


# ---------------------------------------------------------------------------
# Validation and access (registry + in-process client)
# ---------------------------------------------------------------------------


@pytest.fixture
def client(acting, chat):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


class _RecordingAgent:
    def __init__(self):
        self.steers: list = []
        self.interrupts = 0

    def steer(self, text):
        self.steers.append(text)
        return True

    def interrupt(self, message=None):
        self.interrupts += 1


def _register(run_id: str, session_id: str, *, agent=None, profile=None, done=False) -> dict:
    from hermes_cli import web_server

    entry = {
        "session_id": session_id,
        "buffer": [],
        "subs": [],
        "done": done,
        "agent": agent,
        "cancel_requested": False,
        "profile": profile,
        "started_at": time.time(),
        "input_lock": threading.Lock(),
        "inputs_closed": done,
        "interrupt_requested": False,
        "steer_held": [],
        "steer_inflight": [],
        "queued": [],
        "next_run_id": None,
    }
    entry["publish"] = entry["buffer"].append
    web_server._CHAT_RUNS[run_id] = entry
    return entry


def _steer(client, sid, run_id, text="hi", mode="steer", **extra):
    return client.post(
        f"/api/sessions/{sid}/chat/stream/steer",
        json={"run_id": run_id, "text": text, "mode": mode, **extra},
    )


def test_steer_hands_text_to_the_agent_and_buffers_the_event(client, chat):
    agent = _RecordingAgent()
    entry = _register("run_live", chat, agent=agent)
    r = _steer(client, chat, "run_live", "  look at the tests  ")
    assert r.status_code == 200
    body = r.json()
    assert body["run_id"] == "run_live" and body["mode"] == "steer" and body["status"] == "pending"
    assert agent.steers == ["look at the tests"]
    assert entry["buffer"] == [
        ("input.accepted", {"item_id": body["item_id"], "mode": "steer", "text": "look at the tests", "run_id": "run_live"})
    ]
    active = client.get(f"/api/sessions/{chat}/active_run").json()
    assert active["run_id"] == "run_live"
    assert [(p["item_id"], p["mode"], p["text"]) for p in active["pending"]] == [
        (body["item_id"], "steer", "look at the tests")
    ]
    assert isinstance(active["pending"][0]["created_at"], (int, float))


@pytest.mark.parametrize("text,mode", [("", "steer"), ("   ", "queue"), ("x", "shout")])
def test_empty_text_or_bad_mode_is_400(client, chat, text, mode):
    agent = _RecordingAgent()
    _register("run_live", chat, agent=agent)
    assert _steer(client, chat, "run_live", text, mode).status_code == 400
    assert agent.steers == [] and agent.interrupts == 0


def test_unknown_or_foreign_run_is_404(client, chat):
    agent = _RecordingAgent()
    _register("run_other", "s-other", agent=agent)
    assert _steer(client, chat, "run_missing").status_code == 404
    assert _steer(client, chat, "run_other").status_code == 404
    remove = client.post(
        f"/api/sessions/{chat}/chat/stream/queue/remove", json={"run_id": "run_other", "item_id": "x"}
    )
    assert remove.status_code == 404
    assert agent.steers == []


def test_finished_run_is_409_run_finished(client, chat):
    _register("run_done", chat, agent=_RecordingAgent(), done=True)
    r = _steer(client, chat, "run_done", "more", "queue")
    assert r.status_code == 409
    assert r.json()["detail"] == "run_finished"


def test_queue_is_capped_like_the_gateway(client, chat):
    from gateway.run import GatewayRunner

    _BUSY_QUEUE_MAX_PENDING = GatewayRunner._BUSY_QUEUE_MAX_PENDING

    entry = _register("run_live", chat, agent=_RecordingAgent())
    for i in range(_BUSY_QUEUE_MAX_PENDING):
        assert _steer(client, chat, "run_live", f"m{i}", "queue").status_code == 200
    over = _steer(client, chat, "run_live", "one more", "queue")
    assert over.status_code == 409
    assert over.json()["detail"] == "queue_full"
    assert [i["text"] for i in entry["queued"]] == [f"m{i}" for i in range(_BUSY_QUEUE_MAX_PENDING)]


def test_a_run_from_another_profile_is_not_reachable(client, chat):
    agent = _RecordingAgent()
    _register("run_work", chat, agent=agent, profile="work")
    assert _steer(client, chat, "run_work").status_code == 404
    assert client.get(f"/api/sessions/{chat}/active_run").json() == {"run_id": None, "pending": []}
    assert agent.steers == []


@pytest.mark.parametrize("who", [MIA, VERA], ids=["member", "viewer"])
def test_someone_elses_run_is_rejected_like_cancel(client, acting, who):
    agent = _RecordingAgent()
    entry = _register("run_tom", "s-tom", agent=agent)
    acting["as"] = who
    cancel = client.post("/api/sessions/s-tom/chat/stream/cancel", json={"run_id": "run_tom"})
    assert cancel.status_code == 404
    for mode in ("steer", "queue", "interrupt"):
        r = _steer(client, "s-tom", "run_tom", "let me in", mode)
        assert r.status_code == cancel.status_code
        assert r.json() == cancel.json()
    entry["queued"].append({"item_id": "inp_x", "mode": "queue", "text": "t", "created_at": 0})
    remove = client.post(
        "/api/sessions/s-tom/chat/stream/queue/remove", json={"run_id": "run_tom", "item_id": "inp_x"}
    )
    assert remove.status_code == cancel.status_code
    assert agent.steers == [] and agent.interrupts == 0
    assert [i["item_id"] for i in entry["queued"]] == ["inp_x"]
    assert entry["buffer"] == []

    # The conversation's owner is let through.
    acting["as"] = OWNER
    assert _steer(client, "s-tom", "run_tom", "owner note").status_code == 200


def test_the_live_run_is_found_after_compression_forks_the_session(base, chat, turns):
    import hermes_state

    from hermes_cli.web_server import _resolved_chat_session_id

    # The conversation was already compressed once: the client keeps its root
    # id, the next turn runs under the continuation.
    db = hermes_state.SessionDB()
    try:
        db.end_session(chat, "compression")
        db.ensure_session("s-chat-2", source="agent_home", user_id="root", parent_session_id=chat)
    finally:
        db.close()
    assert _resolved_chat_session_id(chat) == "s-chat-2"
    turns.compressed = threading.Event()
    turns.compress_into = {"first": "s-chat-3"}
    turns.hold("first")

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            await asyncio.to_thread(turns.compressed.wait, 10)
            assert _resolved_chat_session_id(chat) == "s-chat-3"
            again = await ac.post(f"/api/sessions/{chat}/chat/stream", json={"message": "second"})
            active = (await ac.get(f"/api/sessions/{chat}/active_run")).json()
            steered = await _send(ac, chat, run_id, "keep going")
            steered_tip = await _send(ac, "s-chat-3", run_id, "and this")
            turns.release("first")
            await primary
            await _until_idle(ac, chat)
            return run_id, again, active, steered, steered_tip

    run_id, again, active, steered, steered_tip = asyncio.run(_scenario())
    assert again.status_code == 409
    assert again.json() == {"detail": "turn_in_progress", "run_id": run_id}
    assert active["run_id"] == run_id
    assert steered.status_code == 200, steered.text
    assert steered_tip.status_code == 200, steered_tip.text
    assert turns.agents[0].steers == ["keep going", "and this"]
    # The stub never reads them, so they run next — in the same conversation.
    assert turns.messages == ["first", "keep going\nand this"]


def test_a_chain_that_cannot_start_hands_every_input_back(base, chat, turns, monkeypatch):
    import hermes_state

    turns.hold("first")
    broken = threading.Event()
    real_load = hermes_state.SessionDB.get_messages_as_conversation

    def _load(self, *a, **kw):
        if broken.is_set():
            raise RuntimeError("disk gone")
        return real_load(self, *a, **kw)

    monkeypatch.setattr(hermes_state.SessionDB, "get_messages_as_conversation", _load)

    async def _scenario():
        async with _client(base) as ac:
            primary = asyncio.create_task(_stream(ac, chat, "first"))
            run_id = await _live_run(ac, chat)
            a = (await _send(ac, chat, run_id, "second", "queue")).json()
            b = (await _send(ac, chat, run_id, "third", "queue")).json()
            broken.set()
            turns.release("first")
            body = await primary
            await _until_idle(ac, chat)
            broken.clear()
            after = await _stream(ac, chat, "fourth")
            return a, b, body, after

    a, b, body, after = asyncio.run(_scenario())
    events = _events(body)
    names = [n for n, _ in events]
    assert "run.chained" not in names
    removed = [d for n, d in events if n == "input.removed"]
    assert [(d["item_id"], d["text"], d["reason"]) for d in removed] == [
        (a["item_id"], "second", "chain_failed"), (b["item_id"], "third", "chain_failed")
    ]
    assert "error" in names and names.index("error") < names.index("done")
    _assert_run_ids(body)
    # The conversation is not left looking busy.
    assert turns.messages == ["first", "fourth"]
    assert "done" in [n for n, _ in _events(after)]
