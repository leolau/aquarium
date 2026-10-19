"""Per-person Telegram bots: the ``/api/telegram-bot`` routes and the
``telegram-bot`` credential kind (Get ready item 6). Telegram itself is faked
at ``telegram_bot_api.telegram_call``; the credential store is the real file
backend under the test HERMES_HOME."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from hermes_cli import credentials_api, telegram_bot_api
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore, default_credential_store

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
ALICE_TOKEN = "111111111:AAalice" + "a" * 28
BOB_TOKEN = "222222222:AAbob" + "b" * 30
INSTALL_TOKEN = "999999999:AAinstall" + "i" * 26


class FakeTelegram:
    def __init__(self) -> None:
        self.bots = {
            ALICE_TOKEN: {"id": 111111111, "username": "alice_helper_bot", "first_name": "Alice helper"},
            BOB_TOKEN: {"id": 222222222, "username": "bob_helper_bot", "first_name": "Bob helper"},
            INSTALL_TOKEN: {"id": 999999999, "username": "install_bot", "first_name": "Install"},
        }
        self.updates: dict = {}
        self.calls: list = []

    async def __call__(self, token, method, params=None):
        self.calls.append((token, method, params))
        if token not in self.bots:
            raise telegram_bot_api.TelegramCallError("Unauthorized")
        if method == "getMe":
            return self.bots[token]
        if method == "getUpdates":
            if params and "offset" in params:
                self.updates[token] = []
                return []
            return list(self.updates.get(token, []))
        raise AssertionError(method)

    def press_start(self, token, url, *, from_id, chat_type="private"):
        code = url.split("?start=", 1)[1]
        self.updates.setdefault(token, []).append(
            {
                "update_id": 10 + len(self.updates.get(token, [])),
                "message": {
                    "text": f"/start {code}",
                    "chat": {"id": from_id, "type": chat_type},
                    "from": {"id": from_id, "username": f"user{from_id}"},
                },
            }
        )


@pytest.fixture
def tg(monkeypatch):
    fake = FakeTelegram()
    monkeypatch.setattr(telegram_bot_api, "telegram_call", fake)
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)

    async def no_channel_owner(owner, tg_id):
        return False

    monkeypatch.setattr(telegram_bot_api, "_channel_owned_by_someone_else", no_channel_owner)
    return fake


@pytest.fixture
def client(monkeypatch, tg):
    assert isinstance(default_credential_store(), FileCredentialStore)
    holder = {"principal": ALICE}

    async def fake_principal(request, *, allow_as):
        return holder["principal"]

    monkeypatch.setattr(credentials_api, "_principal", fake_principal)
    app = FastAPI()
    app.include_router(credentials_api.router)
    app.include_router(telegram_bot_api.router)
    c = TestClient(app)
    c.holder = holder  # type: ignore[attr-defined]
    return c


def entries():
    return asyncio.run(default_credential_store().resolve_by_kind("telegram-bot", provider="telegram"))


def link(client, tg, token, *, from_id):
    url = client.post("/api/telegram-bot/link/start").json()["link_url"]
    tg.press_start(token, url, from_id=from_id)
    return client.post("/api/telegram-bot/link/check")


def test_fresh_install_has_no_bot(client):
    assert client.get("/api/telegram-bot").json() == {"configured": False, "linked": False}
    assert entries() == []


def test_save_tests_with_getme_and_never_returns_token(client, tg):
    res = client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    assert res.status_code == 200
    body = res.json()
    assert body["configured"] and body["bot_username"] == "alice_helper_bot"
    assert body["last_test_ok"] is True and body["linked"] is False
    assert (ALICE_TOKEN, "getMe", None) in tg.calls
    for resp in (
        res,
        client.get("/api/telegram-bot"),
        client.post("/api/telegram-bot/test"),
        client.get("/api/credentials"),
        client.get("/api/credentials/telegram/bot"),
    ):
        assert ALICE_TOKEN not in resp.text
        assert ALICE_TOKEN.split(":", 1)[1] not in resp.text
    (cred,) = entries()
    assert cred.owner_user_id == "alice" and cred.visibility == "private:alice"
    assert cred.payload["token"] == ALICE_TOKEN


@pytest.mark.parametrize("token", ["", "nope", "123:short", "abc:" + "x" * 35])
def test_bad_token_shape_rejected(client, token):
    res = client.put("/api/telegram-bot", json={"token": token})
    assert res.status_code == 400 and res.json()["detail"] == "invalid_token"
    assert entries() == []


def test_token_telegram_rejects_is_not_saved(client):
    res = client.put("/api/telegram-bot", json={"token": "333333333:AA" + "z" * 33})
    assert res.status_code == 400 and res.json()["detail"] == "telegram_rejected"
    assert entries() == []


def test_install_bot_token_cannot_be_claimed(client, monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", INSTALL_TOKEN)
    res = client.put("/api/telegram-bot", json={"token": INSTALL_TOKEN})
    assert res.status_code == 409 and res.json()["detail"] == "install_bot"


def test_someone_elses_bot_cannot_be_claimed(client):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    client.holder["principal"] = BOB
    res = client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    assert res.status_code == 409 and res.json()["detail"] == "bot_in_use"


def test_each_person_sees_and_manages_only_their_own_bot(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    client.holder["principal"] = BOB
    assert client.get("/api/telegram-bot").json()["configured"] is False
    assert client.post("/api/telegram-bot/test").status_code == 404
    assert client.post("/api/telegram-bot/link/start").status_code == 404
    client.delete("/api/telegram-bot")
    assert [c.owner_user_id for c in entries()] == ["alice"]


def test_link_records_the_telegram_id_that_pressed_start(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    start = client.post("/api/telegram-bot/link/start").json()
    assert start["link_url"].startswith("https://t.me/alice_helper_bot?start=")
    assert start["link_pending"] is True
    assert client.post("/api/telegram-bot/link/check").json()["linked"] is False
    tg.press_start(ALICE_TOKEN, start["link_url"], from_id=5001)
    body = client.post("/api/telegram-bot/link/check").json()
    assert body["linked"] is True and body["linked_username"] == "user5001"
    (cred,) = entries()
    assert cred.payload["linked_user_id"] == "5001"
    assert "link_code_hash" not in cred.payload
    code = start["link_url"].split("=", 1)[1]
    assert code not in json.dumps(cred.payload)


def test_wrong_code_or_group_chat_does_not_link(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    url = client.post("/api/telegram-bot/link/start").json()["link_url"]
    tg.press_start(ALICE_TOKEN, url + "x", from_id=6001)
    tg.press_start(ALICE_TOKEN, url, from_id=6002, chat_type="group")
    assert client.post("/api/telegram-bot/link/check").json()["linked"] is False
    assert "linked_user_id" not in entries()[0].payload


def test_a_telegram_account_linked_by_another_person_is_refused(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    assert link(client, tg, ALICE_TOKEN, from_id=5001).json()["linked"] is True
    client.holder["principal"] = BOB
    client.put("/api/telegram-bot", json={"token": BOB_TOKEN})
    res = link(client, tg, BOB_TOKEN, from_id=5001)
    assert res.status_code == 409 and res.json()["detail"] == "telegram_account_in_use"


def test_install_channel_link_of_another_person_is_refused(client, tg, monkeypatch):
    async def owned_by_other(owner, tg_id):
        return tg_id == "7001"

    monkeypatch.setattr(telegram_bot_api, "_channel_owned_by_someone_else", owned_by_other)
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    assert link(client, tg, ALICE_TOKEN, from_id=7001).status_code == 409


def test_new_token_for_another_bot_clears_the_link(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    link(client, tg, ALICE_TOKEN, from_id=5001)
    assert client.put("/api/telegram-bot", json={"token": ALICE_TOKEN}).json()["linked"] is True
    assert client.put("/api/telegram-bot", json={"token": BOB_TOKEN}).json()["linked"] is False


def test_unlink_and_remove(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    link(client, tg, ALICE_TOKEN, from_id=5001)
    assert client.delete("/api/telegram-bot/link").json()["linked"] is False
    assert "linked_user_id" not in entries()[0].payload
    assert client.delete("/api/telegram-bot").json()["configured"] is False
    assert entries() == []


def test_failed_test_is_reported_without_the_token(client, tg):
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    del tg.bots[ALICE_TOKEN]
    body = client.post("/api/telegram-bot/test").json()
    assert body["last_test_ok"] is False and body["last_test_error"] == "Unauthorized"


def test_generic_credentials_api_cannot_write_a_telegram_bot(client):
    forged = {"kind": "telegram-bot", "payload": {"token": ALICE_TOKEN, "linked_user_id": "5001"}}
    assert client.put("/api/credentials/telegram/bot", json=forged).status_code == 409
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    other_kind = {"kind": "api-key", "payload": {"api_key": "x"}}
    assert client.put("/api/credentials/telegram/bot", json=other_kind).status_code == 409
    assert entries()[0].kind == "telegram-bot"


def test_changes_touch_the_gateway_marker(client):
    from hermes_constants import get_hermes_home

    marker = get_hermes_home() / telegram_bot_api.CHANGE_MARKER
    client.put("/api/telegram-bot", json={"token": ALICE_TOKEN})
    assert marker.exists()
    first = marker.read_text()
    client.delete("/api/telegram-bot")
    assert marker.read_text() != first
