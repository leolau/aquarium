"""Per-person WhatsApp bridges in the gateway (gateway/person_whatsapp_bridges.py).

Real files under a temp HERMES_HOME (bridge-owners.json, session dirs with
creds.json / qr.txt); systemd and the WhatsApp adapter are fakes, so no bridge
or WhatsApp message is involved. Checks which bridges are read, which person a
message is handled as, that nobody else reaches a person's chats through their
bridge, that unrecorded bridges (the batcher's) are never read, and that a
stopped bridge goes quiet without a restart.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import gateway.person_whatsapp_bridges as pwb
from gateway.config import Platform
from gateway.session import SessionSource, build_session_key
from hermes_cli import wa_bridge_owners as owners
from hermes_cli.access import Principal

AMY = Principal(user_id="amy", display="Amy", role="member")
BOB = Principal(user_id="bob", display="Bob", role="admin")
AMY_NO, BOB_NO, LEO_NO = "85298765432", "85255550000", "85291234567"


class FakePrincipalStore:
    async def get(self, user_id, connection=None):
        return {"amy": AMY, "bob": BOB}.get(user_id)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    wa = tmp_path / "whatsapp"
    for name, number in (("amy", AMY_NO), ("bob", BOB_NO), ("personal", LEO_NO), ("connectar", "85290000002")):
        (wa / f"session-{name}").mkdir(parents=True)
        (wa / f"session-{name}" / "creds.json").write_text(json.dumps({"me": {"id": f"{number}:2@s.whatsapp.net"}}))
    owners.record_owner("amy", "amy", port=3002)
    owners.record_owner("bob", "bob", port=3003)
    active = {"amy": True, "bob": True, "personal": True, "connectar": True}
    monkeypatch.setattr(pwb, "_unit_active", lambda n: active.get(n, False))
    return SimpleNamespace(wa=wa, active=active)


def make_runner(main_adapter=None):
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    runner.adapters = {Platform.WHATSAPP: main_adapter} if main_adapter else {}
    runner.session_store = None
    runner._busy_text_mode = None
    runner._running = True
    runner.created, runner.disconnected, runner.handled = [], [], []

    def create(platform, config):
        adapter = MagicMock(name=config.extra["account_id"])
        adapter.config = config
        runner.created.append(adapter)
        return adapter

    async def connect(adapter, platform, **_):
        return True

    async def disconnect(adapter, platform):
        runner.disconnected.append(adapter)

    async def handle(event):
        runner.handled.append(event.source)
        return "ok"

    runner._create_adapter = create
    runner._connect_adapter_with_timeout = connect
    runner._safe_adapter_disconnect = disconnect
    runner._handle_message = handle
    runner._get_principal_store = lambda: FakePrincipalStore()
    runner._handle_active_session_busy_message = MagicMock()
    return runner


def event(sender, chat=None, chat_type="dm"):
    src = SessionSource(
        platform=Platform.WHATSAPP, chat_id=f"{chat or sender}@s.whatsapp.net",
        chat_type=chat_type, user_id=f"{sender}@s.whatsapp.net",
    )
    return SimpleNamespace(source=src, text="hi")


def run(coro):
    return asyncio.run(coro)


def handler_for(runner, account_id):
    adapter = runner._person_wa_adapters()[account_id]
    return adapter.set_message_handler.call_args.args[0]


def test_only_recorded_bridges_are_read(home):
    runner = make_runner()
    run(runner._reconcile_person_whatsapp_bridges())
    assert set(runner._person_wa_adapters()) == {"wabridge:amy", "wabridge:bob"}
    extra = runner._person_wa_adapters()["wabridge:amy"].config.extra
    assert extra["bridge_port"] == 3002 and extra["external_bridge"] is True
    assert extra["dm_policy"] == "allowlist" and extra["allow_from"] == [AMY_NO]
    assert extra["group_policy"] == "disabled"
    # personal/connectar (no person recorded) stay with the custom batcher.
    assert not any("personal" in a or "connectar" in a for a in runner._person_wa_adapters())


def test_amys_message_is_handled_as_amy(home):
    runner = make_runner()
    run(runner._reconcile_person_whatsapp_bridges())
    run(handler_for(runner, "wabridge:amy")(event(AMY_NO)))
    (src,) = runner.handled
    assert (src.internal_user_id, src.internal_user_role) == ("amy", "member")
    assert src.account_id == "wabridge:amy"
    assert runner._source_adapter(src) is runner._person_wa_adapters()["wabridge:amy"]
    assert runner._person_wa_authorization(src) is True
    assert "amy" in build_session_key(src)


def test_nobody_else_reaches_amys_chats_through_her_bridge(home):
    runner = make_runner()
    run(runner._reconcile_person_whatsapp_bridges())
    amy_handler = handler_for(runner, "wabridge:amy")
    run(amy_handler(event(BOB_NO)))  # Bob writes to Amy's number
    run(amy_handler(event(AMY_NO, chat=BOB_NO)))  # Amy types in a customer chat
    run(amy_handler(event(BOB_NO, chat="120363000000@g", chat_type="group")))
    assert runner.handled == []
    src = event(BOB_NO).source
    src.account_id = "wabridge:amy"
    assert runner._person_wa_authorization(src) is False
    check = runner._person_wa_adapters()["wabridge:amy"].set_authorization_check.call_args.args[0]
    assert check(f"{AMY_NO}@s.whatsapp.net", "dm") is True
    assert check(f"{BOB_NO}@s.whatsapp.net", "dm") is False
    # Bob's own bridge handles Bob as Bob, never as Amy.
    run(handler_for(runner, "wabridge:bob")(event(BOB_NO)))
    assert [s.internal_user_id for s in runner.handled] == ["bob"]


def test_stopped_or_unlinked_bridge_goes_quiet_without_restart(home):
    runner = make_runner()
    run(runner._reconcile_person_whatsapp_bridges())
    amy_adapter = runner._person_wa_adapters()["wabridge:amy"]
    amy_handler = handler_for(runner, "wabridge:amy")
    home.active["amy"] = False
    run(runner._reconcile_person_whatsapp_bridges())
    assert "wabridge:amy" not in runner._person_wa_adapters()
    assert amy_adapter in runner.disconnected
    run(amy_handler(event(AMY_NO)))
    assert runner.handled == []
    # Back up: listened to again. Unlinked (QR pending): quiet again.
    home.active["amy"] = True
    run(runner._reconcile_person_whatsapp_bridges())
    assert "wabridge:amy" in runner._person_wa_adapters()
    (home.wa / "session-amy" / "qr.txt").write_text("2@x")
    run(runner._reconcile_person_whatsapp_bridges())
    assert "wabridge:amy" not in runner._person_wa_adapters()
    assert "wabridge:bob" in runner._person_wa_adapters()


def test_fresh_install_reads_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    runner = make_runner()
    run(runner._reconcile_person_whatsapp_bridges())
    assert runner._person_wa_adapters() == {} and runner.created == []


def test_bridge_the_main_adapter_reads_is_not_read_twice(home):
    main = SimpleNamespace(_bridge_port=3002)
    runner = make_runner(main)
    run(runner._reconcile_person_whatsapp_bridges())
    assert set(runner._person_wa_adapters()) == {"wabridge:bob"}


def test_settings_changes_mark_the_gateway(home):
    marker = home.wa / owners.CHANGE_MARKER
    assert not marker.exists()
    owners.mark_changed()
    assert marker.exists()
