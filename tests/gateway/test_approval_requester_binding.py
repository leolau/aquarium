"""Security review F7 + F22: who may switch off approvals, and who may answer one.

Every test drives the real gateway handlers (``_handle_message`` or the busy
path ``_handle_active_session_busy_message``) with the real approval queue in
``tools/approval.py``. Only the platform adapter and session store are stubs.

Scenario used throughout: Alice and Bob talk to the agent in the same group
thread, so they share one session. Alice's turn triggers a dangerous command.
"""

from __future__ import annotations

import asyncio
import contextvars
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.config import Platform
from gateway.platforms.base import MessageEvent
from gateway.session import SessionSource
from hermes_cli.access import Principal
from tests.gateway.test_slash_access_dispatch import _make_runner


def _source(user_id: str, *, thread: bool = True) -> SessionSource:
    return SessionSource(
        platform=Platform.DISCORD,
        user_id=user_id,
        chat_id="room1",
        user_name=f"name-{user_id}",
        chat_type="group",
        thread_id="t1" if thread else None,
    )


def _dm(user_id: str) -> SessionSource:
    return SessionSource(
        platform=Platform.DISCORD, user_id=user_id, chat_id=f"dm-{user_id}",
        user_name=f"name-{user_id}", chat_type="dm",
    )


def _event(text: str, source: SessionSource) -> MessageEvent:
    return MessageEvent(text=text, source=source, message_id="m1")


class _StubPrincipalStore:
    """People database stand-in: channel user id -> (internal id, role)."""

    def __init__(self, people: dict[str, tuple[str, str]]) -> None:
        self._people = people
        self._store = self

    async def connect(self):
        return self

    async def close(self) -> None:
        return None

    async def resolve_by_channel(self, platform, channel_user_id, *, connection=None):
        hit = self._people.get(str(channel_user_id))
        if hit is None:
            return None
        return Principal(user_id=hit[0], display="", role=hit[1])


PEOPLE = {
    "alice": ("uid-alice", "member"),
    "bob": ("uid-bob", "member"),
    "olive": ("uid-olive", "owner"),
    "adam": ("uid-adam", "admin"),
    "vic": ("uid-vic", "viewer"),
}


def _runner(*, roles: bool = True, platform_extra: dict | None = None):
    runner = _make_runner(platform_extra=platform_extra or {})
    store = _StubPrincipalStore(PEOPLE) if roles else None
    runner._principal_store_cache = store
    runner._get_principal_store = lambda: store
    runner._reply_anchor_for_event = lambda _e: None
    runner._thread_metadata_for_source = lambda *_a, **_k: None
    adapter = runner.adapters[Platform.DISCORD]
    adapter._send_with_retry = AsyncMock(return_value=SimpleNamespace(success=True))
    adapter._unwrap_ephemeral = lambda r: (r, 0) if isinstance(r, str) else (getattr(r, "text", None), 0)
    return runner


@pytest.fixture(autouse=True)
def _clean_approval_state():
    from tools import approval as mod

    def clear():
        mod._gateway_queues.clear()
        mod._gateway_notify_cbs.clear()
        mod._session_approved.clear()
        mod._session_yolo.clear()
        mod._permanent_approved.clear()
        mod._pending.clear()

    clear()
    yield
    clear()


def _reply_text(reply) -> str:
    return str(getattr(reply, "text", reply) or "")


# ---------------------------------------------------------------------------
# F7 — /yolo (and /memory approval off) need an owner or admin
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["alice", "vic"])
async def test_member_or_viewer_cannot_turn_on_yolo(who):
    from tools.approval import is_session_yolo_enabled

    runner = _runner()
    src = _source(who)
    reply = await runner._handle_message(_event("/yolo", src))

    assert "owner or admin" in _reply_text(reply)
    assert not is_session_yolo_enabled(runner._session_key_for_source(src))


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["olive", "adam"])
async def test_owner_or_admin_can_toggle_yolo(who):
    from tools.approval import is_session_yolo_enabled

    runner = _runner()
    src = _source(who)
    key = runner._session_key_for_source(src)
    await runner._handle_message(_event("/yolo", src))
    assert is_session_yolo_enabled(key)
    await runner._handle_message(_event("/yolo", src))
    assert not is_session_yolo_enabled(key)


@pytest.mark.asyncio
async def test_anyone_may_turn_yolo_back_off():
    """Turning approvals back ON is always safe, so a member can do it."""
    from tools.approval import enable_session_yolo, is_session_yolo_enabled

    runner = _runner()
    src = _source("alice")
    key = runner._session_key_for_source(src)
    enable_session_yolo(key)
    await runner._handle_message(_event("/yolo", src))
    assert not is_session_yolo_enabled(key)


@pytest.mark.asyncio
async def test_slash_allowlist_cannot_hand_yolo_to_a_non_admin():
    """Even if the operator lets plain users run /yolo, the safety gate holds."""
    from tools.approval import is_session_yolo_enabled

    runner = _runner(
        roles=False,
        platform_extra={"group_allow_admin_from": ["olive"], "group_user_allowed_commands": ["yolo"]},
    )
    src = _source("bob")
    reply = await runner._handle_message(_event("/yolo", src))
    assert "owner or admin" in _reply_text(reply)
    assert not is_session_yolo_enabled(runner._session_key_for_source(src))

    owner = _source("olive")
    await runner._handle_message(_event("/yolo", owner))
    assert is_session_yolo_enabled(runner._session_key_for_source(owner))


@pytest.mark.asyncio
async def test_single_user_install_without_roles_keeps_yolo():
    """No people database and no admin list: behaves exactly as before."""
    from tools.approval import is_session_yolo_enabled

    runner = _runner(roles=False)
    src = _dm("solo")
    await runner._handle_message(_event("/yolo", src))
    assert is_session_yolo_enabled(runner._session_key_for_source(src))


@pytest.mark.asyncio
async def test_member_cannot_turn_off_memory_write_approval(monkeypatch, tmp_path):
    import gateway.run as gr

    monkeypatch.setattr(gr, "_hermes_home", tmp_path)
    runner = _runner()
    runner._evict_cached_agent = lambda _k: None
    reply = await runner._handle_message(_event("/memory approval off", _source("alice")))
    assert "owner or admin" in _reply_text(reply)
    assert not (tmp_path / "config.yaml").exists()

    await runner._handle_message(_event("/memory approval off", _source("olive")))
    assert "write_approval: false" in (tmp_path / "config.yaml").read_text()


# ---------------------------------------------------------------------------
# F22 — an approval belongs to the person whose turn asked for it
# ---------------------------------------------------------------------------


def _queue_real_approval(session_key: str, *, platform_id: str, internal_id: str | None):
    """Run the real ``_await_gateway_decision`` as an agent turn for one person.

    Returns (thread, result_box). The thread blocks until someone answers.
    """
    from gateway.session_context import set_session_vars
    from tools import approval as mod
    from tools.access_policy import acting_as

    box: dict = {}

    def turn():
        set_session_vars(platform="discord", user_id=platform_id, session_key=session_key)
        with acting_as(internal_id, "member"):
            box["result"] = mod._await_gateway_decision(
                session_key, lambda _d: None,
                {"command": "rm -rf /tmp/x", "description": "delete", "pattern_keys": []},
                timeout_seconds=10,
            )

    th = threading.Thread(target=contextvars.Context().run, args=(turn,), daemon=True)
    th.start()
    for _ in range(200):
        if mod._gateway_queues.get(session_key):
            break
        time.sleep(0.01)
    assert mod._gateway_queues.get(session_key), "approval was never queued"
    return th, box


def _pending_entry(session_key):
    from tools import approval as mod

    return mod._gateway_queues[session_key][0]


@pytest.mark.asyncio
async def test_entry_records_who_asked():
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, _ = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")
    entry = _pending_entry(key)
    assert (entry.requester_id, entry.requester_user_id) == ("alice", "uid-alice")
    from tools.approval import resolve_gateway_approval
    resolve_gateway_approval(key, "deny")
    th.join(5)


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["/approve", "/approve all", "/deny", "/approve session"])
async def test_other_participant_cannot_answer_my_approval(text):
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    assert key == runner._session_key_for_source(_source("bob")), "thread must be shared"
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")

    reply = await runner._handle_message(_event(text, _source("bob")))

    assert "someone else" in _reply_text(reply)
    assert not _pending_entry(key).event.is_set()

    await runner._handle_message(_event("/approve", _source("alice")))
    th.join(5)
    assert box["result"]["choice"] == "once"


@pytest.mark.asyncio
async def test_requester_can_approve_own_command():
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")
    await runner._handle_message(_event("/approve", _source("alice")))
    th.join(5)
    assert box["result"]["choice"] == "once"


@pytest.mark.asyncio
@pytest.mark.parametrize("who", ["olive", "adam"])
async def test_owner_or_admin_can_answer_anyones_approval(who):
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")
    await runner._handle_message(_event("/deny", _source(who)))
    th.join(5)
    assert box["result"]["choice"] == "deny"


@pytest.mark.asyncio
async def test_member_cannot_always_approve_in_shared_thread():
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")

    reply = await runner._handle_message(_event("/approve always", _source("alice")))
    assert "owner or admin" in _reply_text(reply)
    assert not _pending_entry(key).event.is_set()

    await runner._handle_message(_event("/approve always", _source("olive")))
    th.join(5)
    assert box["result"]["choice"] == "always"


@pytest.mark.asyncio
async def test_member_can_still_always_approve_in_own_dm():
    runner = _runner()
    src = _dm("alice")
    key = runner._session_key_for_source(src)
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")
    await runner._handle_message(_event("/approve always", src))
    th.join(5)
    assert box["result"]["choice"] == "always"


@pytest.mark.asyncio
async def test_approval_from_a_turn_with_no_sender_is_answerable_as_before():
    """Cron/background turns record nobody, so any allowed user can answer."""
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, box = _queue_real_approval(key, platform_id="", internal_id=None)
    await runner._handle_message(_event("/approve", _source("bob")))
    th.join(5)
    assert box["result"]["choice"] == "once"


# ---------------------------------------------------------------------------
# F22 — plain-text "yes"/"always" while the agent waits (busy path)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("text", ["yes", "always", "no"])
def test_plain_text_reply_from_other_participant_is_refused(text):
    runner = _runner()
    key = runner._session_key_for_source(_source("alice"))
    th, box = _queue_real_approval(key, platform_id="alice", internal_id="uid-alice")

    handled = asyncio.run(
        runner._handle_active_session_busy_message(_event(text, _source("bob")), key)
    )
    assert handled is True
    assert not _pending_entry(key).event.is_set()

    asyncio.run(runner._handle_active_session_busy_message(_event("yes", _source("alice")), key))
    th.join(5)
    assert box["result"]["choice"] == "once"


def test_plain_text_always_cannot_skip_slash_gating():
    """``/approve`` is admin-only here, so typing "always" must not get around it."""
    runner = _runner(roles=False, platform_extra={"allow_admin_from": ["olive"]})
    src = _dm("bob")
    key = runner._session_key_for_source(src)
    th, box = _queue_real_approval(key, platform_id="bob", internal_id=None)

    for text in ("always", "yes", "approve session"):
        asyncio.run(runner._handle_active_session_busy_message(_event(text, src), key))
        assert not _pending_entry(key).event.is_set(), text
    sent = runner.adapters[Platform.DISCORD]._send_with_retry.await_args.kwargs["content"]
    assert "admin" in sent.lower()

    from tools.approval import resolve_gateway_approval
    resolve_gateway_approval(key, "deny")
    th.join(5)
