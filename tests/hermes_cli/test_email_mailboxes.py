"""Per-person email mailboxes (Get ready item 7): storage, redaction,
owner-only access and the IMAP + SMTP login test against local fake servers.

Real file credential store under the per-test HERMES_HOME; real imaplib /
smtplib over TLS to localhost.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi import HTTPException

import hermes_cli.email_mailboxes as mb
import hermes_cli.email_mailboxes_api as api
from hermes_cli.access import Principal
from hermes_cli.credential_store import (
    CREDENTIAL_KINDS,
    FileCredentialStore,
    default_credential_store,
)
from tests.hermes_cli.fake_mail_servers import FakeIMAP, FakeSMTP, client_context, make_cert

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="admin")
OWNER = Principal(user_id="owner-1", display="Owner", role="owner")
SECRET = "app-pass-9f2c7a41"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def file_store():
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    return store


@pytest.fixture
def servers(tmp_path, monkeypatch):
    cert, key = make_cert(tmp_path)
    monkeypatch.setattr(mb, "_ssl_context", lambda: client_context(cert))
    imap = FakeIMAP(cert, key, username="alice", password=SECRET)
    smtp = FakeSMTP(cert, key, username="alice", password=SECRET)
    yield imap, smtp
    imap.close()
    smtp.close()


def body(imap_port=993, smtp_port=465, **over):
    doc = {
        "username": "alice", "password": SECRET,
        "imap_host": "localhost", "imap_port": imap_port, "imap_security": "ssl",
        "smtp_host": "localhost", "smtp_port": smtp_port, "smtp_security": "ssl",
        "preset": "other",
    }
    doc.update(over)
    return doc


class _Req:
    def __init__(self, doc=None):
        self._doc = doc

    async def json(self):
        return self._doc


@pytest.fixture
def as_user(monkeypatch):
    current = {"p": ALICE}

    async def _caller(_request):
        return current["p"]

    monkeypatch.setattr(api, "_caller", _caller)

    def switch(principal):
        current["p"] = principal

    return switch


def test_kind_keeps_password_server_side():
    spec = CREDENTIAL_KINDS[mb.KIND]
    assert spec.secret_fields == ("password",)
    assert spec.keep_secrets_on_put and not spec.materialize


def test_save_stores_private_entry_and_never_returns_password(file_store, as_user):
    out = run(api.put_mailbox("Alice@Example.com", _Req(body())))
    assert SECRET not in json.dumps(out)
    view = out["mailbox"]
    assert view["address"] == "alice@example.com"
    assert view["password_set"] is True and view["state"] == "untested"
    stored = run(file_store.get(ALICE, mb.PROVIDER, "alice@example.com"))
    assert stored.payload["password"] == SECRET
    assert stored.visibility == ALICE.private_visibility
    assert stored.services == ["email"]
    listed = run(api.list_mailboxes(_Req()))
    assert SECRET not in json.dumps(listed)
    assert set(listed["presets"]) == {"gmail", "outlook"}


def test_new_mailbox_needs_password(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_mailbox("alice@example.com", _Req(body(password=""))))
    assert err.value.status_code == 400


def test_edit_without_password_keeps_it(file_store, as_user):
    run(api.put_mailbox("alice@example.com", _Req(body())))
    run(api.put_mailbox("alice@example.com", _Req(body(password="", imap_port=1993))))
    stored = run(file_store.get(ALICE, mb.PROVIDER, "alice@example.com"))
    assert stored.payload["password"] == SECRET
    assert stored.payload["imap_port"] == 1993


@pytest.mark.parametrize("over", [
    {"imap_port": "abc"}, {"imap_port": 0}, {"smtp_port": 70000},
    {"imap_host": "bad host"}, {"smtp_security": "none"}, {"preset": "yahoo"},
])
def test_bad_values_rejected(as_user, over):
    with pytest.raises(HTTPException) as err:
        run(api.put_mailbox("alice@example.com", _Req(body(**over))))
    assert err.value.status_code == 400


def test_bad_address_rejected(as_user):
    with pytest.raises(HTTPException) as err:
        run(api.put_mailbox("not-an-address", _Req(body())))
    assert err.value.status_code == 400


@pytest.mark.parametrize("other", [BOB, OWNER])
def test_nobody_else_sees_or_touches_a_mailbox(file_store, as_user, other):
    run(api.put_mailbox("alice@example.com", _Req(body())))
    as_user(other)
    assert run(api.list_mailboxes(_Req()))["mailboxes"] == []
    for call in (
        lambda: api.test_mailbox("alice@example.com", _Req()),
        lambda: api.delete_mailbox("alice@example.com", _Req()),
    ):
        with pytest.raises(HTTPException) as err:
            run(call())
        assert err.value.status_code == 404
    # Saving the same address makes the other person's OWN entry; Alice's
    # password and entry are untouched.
    run(api.put_mailbox("alice@example.com", _Req(body(password="theirs"))))
    assert run(file_store.get(ALICE, mb.PROVIDER, "alice@example.com")).payload["password"] == SECRET
    as_user(ALICE)
    assert len(run(api.list_mailboxes(_Req()))["mailboxes"]) == 1


def test_delete_own_mailbox(file_store, as_user):
    run(api.put_mailbox("alice@example.com", _Req(body())))
    assert run(api.delete_mailbox("alice@example.com", _Req())) == {"deleted": True}
    assert run(api.list_mailboxes(_Req()))["mailboxes"] == []


def test_caller_requires_a_signed_in_person(monkeypatch):
    import hermes_cli.credentials_api as credentials_api

    seen = {}

    async def _principal(_request, *, allow_as):
        seen["allow_as"] = allow_as
        raise HTTPException(401, "sign in")

    monkeypatch.setattr(credentials_api, "_principal", _principal)
    with pytest.raises(HTTPException) as err:
        run(api.list_mailboxes(_Req()))
    assert err.value.status_code == 401 and seen["allow_as"] is False


def test_test_logs_into_imap_and_smtp_without_sending(servers, as_user):
    imap, smtp = servers
    run(api.put_mailbox("alice@example.com", _Req(body(imap.port, smtp.port))))
    view = run(api.test_mailbox("alice@example.com", _Req()))["mailbox"]
    assert view["state"] == "working"
    assert view["last_test"]["imap"] == {"ok": True}
    assert view["last_test"]["smtp"] == {"ok": True}
    assert imap.logins == [("alice", True)] and smtp.logins == [("alice", True)]
    assert not {"MAIL", "RCPT", "DATA"} & set(smtp.commands)
    listed = run(api.list_mailboxes(_Req()))["mailboxes"][0]
    assert listed["state"] == "working"


def test_test_reports_wrong_password_in_plain_words(servers, as_user):
    imap, smtp = servers
    run(api.put_mailbox("alice@example.com", _Req(body(imap.port, smtp.port, password="wrong"))))
    view = run(api.test_mailbox("alice@example.com", _Req()))["mailbox"]
    assert view["state"] == "needs_attention"
    assert view["last_test"]["imap"]["ok"] is False
    assert "Sign-in failed" in view["last_test"]["imap"]["error"]
    assert view["last_test"]["smtp"]["ok"] is False
    assert "wrong" not in json.dumps(view)
    assert not {"MAIL", "RCPT", "DATA"} & set(smtp.commands)


def test_starttls_smtp(tmp_path, monkeypatch, as_user):
    cert, key = make_cert(tmp_path)
    monkeypatch.setattr(mb, "_ssl_context", lambda: client_context(cert))
    imap = FakeIMAP(cert, key, username="alice", password=SECRET)
    smtp = FakeSMTP(cert, key, username="alice", password=SECRET, implicit_tls=False)
    try:
        run(api.put_mailbox("alice@example.com", _Req(body(imap.port, smtp.port, smtp_security="starttls"))))
        view = run(api.test_mailbox("alice@example.com", _Req()))["mailbox"]
        assert view["last_test"]["smtp"] == {"ok": True}
        assert "STARTTLS" in smtp.commands
    finally:
        imap.close()
        smtp.close()


def test_unreachable_server_is_plain(as_user, monkeypatch):
    monkeypatch.setattr(mb, "TIMEOUT_SECONDS", 2)
    run(api.put_mailbox("alice@example.com", _Req(body(1, 1, imap_host="localhost", smtp_host="localhost"))))
    view = run(api.test_mailbox("alice@example.com", _Req()))["mailbox"]
    assert view["last_test"]["imap"]["error"] == "Could not connect to localhost."
    assert view["state"] == "needs_attention"


def test_changing_connection_clears_old_test(servers, as_user):
    imap, smtp = servers
    run(api.put_mailbox("alice@example.com", _Req(body(imap.port, smtp.port))))
    run(api.test_mailbox("alice@example.com", _Req()))
    view = run(api.put_mailbox("alice@example.com", _Req(body(imap.port, smtp.port, username="alice2"))))["mailbox"]
    assert view["last_test"] is None and view["state"] == "untested"
