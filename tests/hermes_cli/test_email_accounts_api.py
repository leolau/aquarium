"""Coverage for the email-poller account flag API (owner-gated settings
surface over the deployment poller's JSON config). The route functions are
invoked directly with a stubbed owner principal — no FastAPI TestClient, no
database."""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

import hermes_cli.email_accounts_api as api


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def config_path(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(path))
    monkeypatch.setattr(api, "_owner_principal", _no_owner)
    return path


async def _no_owner(_request):
    return None


def _write(path, accounts):
    path.write_text(json.dumps({"accounts": accounts}))


def test_list_reports_missing_config(config_path):
    import asyncio

    out = asyncio.run(api.list_email_accounts(_FakeRequest({})))
    assert out == {"config_present": False, "accounts": []}


def test_list_returns_enabled_flags(config_path):
    import asyncio

    _write(
        config_path,
        [
            {"id": "email1", "address": "a@x.co", "enabled": True},
            {"id": "email2", "address": "b@x.co", "enabled": False},
        ],
    )
    out = asyncio.run(api.list_email_accounts(_FakeRequest({})))
    assert out["config_present"] is True
    assert [a["enabled"] for a in out["accounts"]] == [True, False]


def test_patch_toggles_existing_entry(config_path):
    import asyncio

    _write(
        config_path, [{"id": "email1", "address": "a@x.co", "enabled": True}]
    )
    out = asyncio.run(
        api.set_email_account_polling(
            _FakeRequest({"address": "a@x.co", "enabled": False})
        )
    )
    assert out["account"]["enabled"] is False
    assert json.loads(config_path.read_text())["accounts"][0]["enabled"] is False


def test_patch_enable_creates_gmail_entry(config_path):
    import asyncio

    _write(config_path, [{"id": "email1", "address": "a@x.co"}])
    out = asyncio.run(
        api.set_email_account_polling(
            _FakeRequest({"address": "New@X.co", "enabled": True})
        )
    )
    account = out["account"]
    assert account["id"] == "email2"
    assert account["enabled"] is True
    saved = json.loads(config_path.read_text())["accounts"][1]
    assert saved["address"] == "New@X.co"
    assert saved["imap"]["host"] == "imap.gmail.com"
    assert "credentials_env" not in saved


def test_patch_disable_unknown_address_404s(config_path):
    import asyncio

    _write(config_path, [])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            api.set_email_account_polling(
                _FakeRequest({"address": "ghost@x.co", "enabled": False})
            )
        )
    assert exc.value.status_code == 404


def test_patch_address_case_insensitive(config_path):
    import asyncio

    _write(
        config_path, [{"id": "email1", "address": "A@X.co", "enabled": True}]
    )
    out = asyncio.run(
        api.set_email_account_polling(
            _FakeRequest({"address": "a@x.co", "enabled": False})
        )
    )
    assert out["account"]["enabled"] is False


def test_patch_enable_password_mailbox_copies_servers(config_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    import hermes_cli.email_mailboxes as mb

    async def owner(_request):
        return SimpleNamespace(user_id="owner-1", is_owner=True)

    async def own_entry(principal, address):
        assert principal.user_id == "owner-1"
        return SimpleNamespace(
            name=address,
            owner_user_id="owner-1",
            payload={
                "imap_host": "mail.corp.example", "imap_port": 143,
                "imap_security": "starttls", "smtp_host": "smtp.corp.example",
                "smtp_port": 587, "smtp_security": "starttls", "password": "pw",
            },
        )

    monkeypatch.setattr(api, "_owner_principal", owner)
    monkeypatch.setattr(mb, "_own_entry", own_entry)
    _write(config_path, [])
    out = asyncio.run(
        api.set_email_account_polling(
            _FakeRequest({"address": "ops@corp.example", "enabled": True,
                          "auth": "password"})
        )
    )
    assert out["account"]["auth"] == "password"
    saved = json.loads(config_path.read_text())["accounts"][0]
    assert saved["imap"] == {"host": "mail.corp.example", "port": 143, "tls": False}
    assert saved["smtp"]["host"] == "smtp.corp.example"
    assert saved["owner_user_id"] == "owner-1"
    assert "\"pw\"" not in json.dumps(saved)


def test_patch_password_mailbox_must_exist(config_path, monkeypatch):
    import asyncio

    import hermes_cli.email_mailboxes as mb

    async def missing(principal, address):
        raise mb.MailboxError("no mailbox with that address", 404)

    monkeypatch.setattr(mb, "_own_entry", missing)
    _write(config_path, [])
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            api.set_email_account_polling(
                _FakeRequest({"address": "ops@corp.example", "enabled": True,
                              "auth": "password"})
            )
        )
    assert exc.value.status_code == 404


def test_patch_rejects_unknown_auth(config_path):
    import asyncio

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            api.set_email_account_polling(
                _FakeRequest({"address": "a@x.co", "enabled": True, "auth": "x"})
            )
        )
    assert exc.value.status_code == 400
