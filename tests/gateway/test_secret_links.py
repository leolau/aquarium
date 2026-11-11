"""FG-37 W4: one-time secret links sent over messaging (gateway/secret_links.py)."""

from __future__ import annotations

import asyncio
import sys
import threading
import types
from types import SimpleNamespace

import pytest

from gateway import secret_links
from gateway.config import Platform
from gateway.platforms.base import SendResult
from gateway.session import SessionSource

PUBLIC = {"agent_home": {"public_url": "https://aquarium.example.test/"}}
TOKEN = "tok_" + "A" * 40


class FakeRegistry(types.ModuleType):
    """Stands in for W1's hermes_cli.secret_requests (documented signatures)."""

    def __init__(self):
        super().__init__("hermes_cli.secret_requests")
        self.opened: list = []
        self.declined: list = []

    def open_request(self, **kw):
        self.opened.append(kw)
        req = SimpleNamespace(id="sr_0123456789abcdef", expires_at=1_000_900.0, **kw)
        return req, (TOKEN if kw.get("with_link") else None)

    def decline(self, ref):
        self.declined.append(ref)


@pytest.fixture
def registry(monkeypatch):
    fake = FakeRegistry()
    monkeypatch.setitem(sys.modules, "hermes_cli.secret_requests", fake)
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "secret_requests", fake, raising=False)
    return fake


@pytest.fixture
def loop():
    lp = asyncio.new_event_loop()
    t = threading.Thread(target=lp.run_forever, daemon=True)
    t.start()
    yield lp
    lp.call_soon_threadsafe(lp.stop)
    t.join(2)
    lp.close()


class FakeAdapter:
    def __init__(self, ok=True):
        self.sent: list = []
        self.ok = ok
        self.paused: list = []

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        self.sent.append((chat_id, content, metadata))
        return SendResult(success=self.ok, message_id="m1")

    def pause_typing_for_chat(self, chat_id):
        self.paused.append(chat_id)


def _source(platform=Platform.TELEGRAM, *, internal_user_id="usr_mia", chat_type="dm"):
    return SessionSource(
        platform=platform,
        chat_id="chat-1",
        chat_type=chat_type,
        user_id="tg-42",
        internal_user_id=internal_user_id,
    )


def _sender(source, adapter, loop, config=PUBLIC):
    return secret_links.make_link_sender(
        source=source,
        adapter=adapter,
        chat_id=source.chat_id,
        loop=loop,
        session_key="agent:main:telegram:dm:chat-1",
        profile="default",
        config_loader=lambda: config,
    )


ASK = dict(name="github_pat", label="GitHub token", purpose="Open the PR for you")


@pytest.mark.parametrize("platform", [Platform.TELEGRAM, Platform.WHATSAPP, Platform.EMAIL])
def test_linked_dm_gets_a_one_time_link_and_the_model_only_a_placeholder(registry, loop, platform):
    adapter = FakeAdapter()
    result = _sender(_source(platform), adapter, loop)(**ASK)

    assert result["status"] == "sent"
    assert result["message"] == "secure link sent"
    assert result["request_id"] == "sr_0123456789abcdef"
    assert TOKEN not in repr(result) and "/secret/" not in repr(result)

    [opened] = registry.opened
    assert opened["with_link"] is True
    assert opened["owner_user_id"] == "usr_mia"
    assert opened["channel"] == platform.value
    assert opened["ttl_seconds"] == 900
    assert opened["name"] == "github_pat"

    [(chat_id, text, _meta)] = adapter.sent
    assert chat_id == "chat-1"
    assert f"https://aquarium.example.test/secret/{TOKEN}" in text
    assert "GitHub token" in text and "15 minutes" in text
    # Plain text: nothing a plain-text email or WhatsApp would show as markup.
    assert "**" not in text and "<" not in text and "](" not in text
    assert adapter.paused == ["chat-1"]


def test_unlinked_sender_is_refused_without_opening_a_request(registry, loop):
    adapter = FakeAdapter()
    result = _sender(_source(internal_user_id=None), adapter, loop)(**ASK)
    assert result["status"] == "unavailable"
    assert registry.opened == [] and adapter.sent == []


def test_group_chat_is_refused(registry, loop):
    adapter = FakeAdapter()
    result = _sender(_source(chat_type="group"), adapter, loop)(**ASK)
    assert result["status"] == "unavailable"
    assert registry.opened == [] and adapter.sent == []


@pytest.mark.parametrize(
    "url",
    ["", "http://aquarium.example.test", "aquarium.example.test", "https://", "https://x.test/?a=1",
     "https://x.test/#f", "https://user:pw@x.test", "https://x .test", "javascript:alert(1)"],
)
def test_public_url_must_be_https(registry, loop, url):
    adapter = FakeAdapter()
    result = _sender(_source(), adapter, loop, {"agent_home": {"public_url": url}})(**ASK)
    assert result["status"] == "unavailable"
    assert registry.opened == [] and adapter.sent == []


def test_public_base_url_keeps_a_path_prefix():
    cfg = {"agent_home": {"public_url": " https://x.test/aq/ "}}
    assert secret_links.public_base_url(cfg) == "https://x.test/aq"
    assert secret_links.public_base_url({}) is None


def test_failed_delivery_closes_the_request(registry, loop):
    adapter = FakeAdapter(ok=False)
    result = _sender(_source(), adapter, loop)(**ASK)
    assert result["status"] == "unavailable"
    assert registry.declined == ["sr_0123456789abcdef"]


def test_agent_home_turns_never_get_links(registry, loop):
    result = _sender(_source(Platform.API_SERVER), FakeAdapter(), loop)(**ASK)
    assert result["status"] == "unavailable"
    assert registry.opened == []


def test_sender_lifecycle_is_per_session_key(registry, loop):
    from tools.approval import reset_current_session_key, set_current_session_key

    key = "agent:main:telegram:dm:chat-1"
    assert secret_links.send_secret_link(key, **ASK)["status"] == "unavailable"
    adapter = FakeAdapter()
    secret_links.register_secret_link_sender(key, _sender(_source(), adapter, loop))
    tok = set_current_session_key(key)
    try:
        assert secret_links.send_secret_link(**ASK)["status"] == "sent"
    finally:
        reset_current_session_key(tok)
        secret_links.unregister_secret_link_sender(key)
    assert secret_links.get_secret_link_sender(key) is None


def test_gateway_turn_registers_and_unregisters_the_sender():
    """run.py wires the sender next to the approval notifier for every turn."""
    import inspect

    from gateway import run

    src = inspect.getsource(run)
    reg = src.index("register_secret_link_sender(\n")
    assert src.index("register_gateway_notify(_approval_session_key") < reg
    assert src.index("unregister_secret_link_sender(_approval_session_key)") > reg
