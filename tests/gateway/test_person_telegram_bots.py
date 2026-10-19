"""Per-person Telegram bots in the gateway (gateway/person_telegram_bots.py):
which entries run, who may talk to a person's bot, which person a message is
handled as, which bot a reply leaves through, and that adding/removing one
person's bot leaves every other bot alone. Entries live in the real file
credential store under the test HERMES_HOME; adapters are fakes."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock

from gateway.config import Platform
from gateway.person_telegram_bots import desired_person_bots
from gateway.session import SessionSource
from hermes_cli.access import Principal
from hermes_cli.credential_store import default_credential_store

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="admin")
ALICE_TOKEN = "111111111:AAalice" + "a" * 28
BOB_TOKEN = "222222222:AAbob" + "b" * 30
INSTALL_TOKEN = "999999999:AAinstall" + "i" * 26
ALICE_TG, BOB_TG = "5001", "5002"


def save(principal, token, linked=None):
    payload = {"token": token, "bot_id": token.split(":")[0]}
    if linked:
        payload["linked_user_id"] = linked
    asyncio.run(
        default_credential_store().put(
            principal, provider="telegram", name="bot", kind="telegram-bot",
            payload=payload, visibility=f"private:{principal.user_id}",
        )
    )


class FakePrincipalStore:
    async def get(self, user_id):
        return {"alice": ALICE, "bob": BOB}.get(user_id)


def make_runner(monkeypatch):
    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    install = MagicMock(name="install-bot")
    runner.adapters = {Platform.TELEGRAM: install}
    runner.session_store = None
    runner._busy_text_mode = None
    runner._running = True
    runner.created = []
    runner.disconnected = []
    runner.handled = []

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
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", INSTALL_TOKEN)
    return runner, install


def dm(account_id, user_id, chat_type="dm"):
    return SessionSource(
        platform=Platform.TELEGRAM, chat_id=user_id, chat_type=chat_type,
        user_id=user_id, account_id=account_id,
    )


def test_only_linked_entries_run_and_never_the_install_bot():
    entries = [
        SimpleNamespace(owner_user_id="alice", kind="telegram-bot", payload={"token": ALICE_TOKEN, "linked_user_id": ALICE_TG}),
        SimpleNamespace(owner_user_id="bob", kind="telegram-bot", payload={"token": BOB_TOKEN}),
        SimpleNamespace(owner_user_id="carol", kind="telegram-bot", payload={"token": INSTALL_TOKEN, "linked_user_id": "1"}),
    ]
    specs = desired_person_bots(entries, install_token=INSTALL_TOKEN)
    assert list(specs) == ["tgbot:111111111"]
    assert specs["tgbot:111111111"].owner_user_id == "alice"


def test_a_bot_saved_by_two_people_does_not_run():
    entries = [
        SimpleNamespace(owner_user_id=o, kind="telegram-bot", payload={"token": ALICE_TOKEN, "linked_user_id": t})
        for o, t in (("alice", ALICE_TG), ("bob", BOB_TG))
    ]
    assert desired_person_bots(entries) == {}


def test_fresh_install_runs_no_person_bot(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner.created == [] and runner._person_bots() == {}


def test_reconcile_starts_one_isolated_bot_per_person(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    bots = runner._person_bots()
    assert set(bots) == {"tgbot:111111111", "tgbot:222222222"}
    alice_cfg = bots["tgbot:111111111"].config
    assert alice_cfg.token == ALICE_TOKEN
    assert alice_cfg.extra["allow_from"] == [ALICE_TG]
    assert alice_cfg.extra["force_polling"] is True
    assert runner.adapters == {Platform.TELEGRAM: install}


def test_removing_one_bot_leaves_the_others_running(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    alice_bot = runner._person_bots()["tgbot:111111111"]
    bob_bot = runner._person_bots()["tgbot:222222222"]
    asyncio.run(default_credential_store().delete(BOB, "telegram", "bot"))
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner.disconnected == [bob_bot]
    assert runner._person_bots() == {"tgbot:111111111": alice_bot}
    assert len(runner.created) == 2
    install.disconnect.assert_not_called()
    # Adding Bob back starts only Bob's bot.
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert len(runner.created) == 3 and runner._person_bots()["tgbot:111111111"] is alice_bot


def test_unlinking_stops_the_bot(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    save(ALICE, ALICE_TOKEN)
    asyncio.run(runner._reconcile_person_telegram_bots())
    assert runner._person_bots() == {}


def test_only_the_linked_telegram_id_in_a_private_chat_is_authorized(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    # Bob's Telegram id is on the install-wide allowlist: still not Alice's bot.
    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", f"{ALICE_TG},{BOB_TG}")
    assert runner._is_user_authorized(dm("tgbot:111111111", ALICE_TG)) is True
    assert runner._is_user_authorized(dm("tgbot:111111111", BOB_TG)) is False
    assert runner._is_user_authorized(dm("tgbot:111111111", ALICE_TG, "group")) is False
    assert runner._is_user_authorized(dm("tgbot:222222222", BOB_TG)) is False
    assert runner._person_bot_authorization(dm(None, BOB_TG)) is None


def test_message_to_alices_bot_is_handled_only_as_alice(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    save(BOB, BOB_TOKEN, BOB_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    handler = runner._make_person_bot_message_handler("tgbot:111111111")
    # The adapter would stamp its own account; a sender cannot pick another.
    forged = dm("tgbot:222222222", ALICE_TG)
    forged.internal_user_id = "bob"
    forged.internal_user_role = "admin"
    assert asyncio.run(handler(SimpleNamespace(source=forged))) == "ok"
    (source,) = runner.handled
    assert source.account_id == "tgbot:111111111"
    assert source.internal_user_id == "alice" and source.internal_user_role == "member"
    # Bob writing to Alice's bot is dropped, never handled as anyone.
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, BOB_TG)))) is None
    assert len(runner.handled) == 1


def test_inactive_owner_is_not_served(monkeypatch):
    runner, _ = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())

    class Inactive:
        async def get(self, user_id):
            return Principal(user_id="alice", display="A", role="member", active=False)

    runner._get_principal_store = lambda: Inactive()
    handler = runner._make_person_bot_message_handler("tgbot:111111111")
    assert asyncio.run(handler(SimpleNamespace(source=dm(None, ALICE_TG)))) is None
    assert runner.handled == []


def test_replies_leave_through_the_receiving_bot(monkeypatch):
    runner, install = make_runner(monkeypatch)
    save(ALICE, ALICE_TOKEN, ALICE_TG)
    asyncio.run(runner._reconcile_person_telegram_bots())
    alice_bot = runner._person_bots()["tgbot:111111111"]
    assert runner._source_adapter(dm("tgbot:111111111", ALICE_TG)) is alice_bot
    assert runner._source_adapter(dm(None, ALICE_TG)) is install
    # A stopped person bot never falls back to the install bot.
    assert runner._source_adapter(dm("tgbot:222222222", BOB_TG)) is None
