"""The email poller reads each person's own mailbox and files mail only as
that person (Get ready item 7). The install-wide config keeps its path.

Real poller code, real credential store under the per-test HERMES_HOME, a
local fake IMAP server over TLS; only the Supabase-backed registry calls
(``register_arrival`` / person lookup) are captured in-process.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom" / "email"))
sys.path.insert(0, str(ROOT / "custom"))

import email_poller  # noqa: E402
import hermes_cli.email_mailboxes as mb  # noqa: E402
import hermes_cli.inbound_registry as inbound_registry  # noqa: E402
import shared.inbound_registration as inbound_registration  # noqa: E402
from hermes_cli.access import Principal  # noqa: E402
from tests.hermes_cli.fake_mail_servers import FakeIMAP, client_context, make_cert, rfc822  # noqa: E402

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
SECRET = "app-pass-9f2c7a41"


class _Item:
    def __init__(self, n):
        self.id = f"item-{n}"


@pytest.fixture
def registry(monkeypatch):
    calls = []
    people = {"alice": ALICE, "bob": BOB}
    state = {"up": True}

    async def register_arrival(principal, **kwargs):
        if not state["up"]:
            return None
        calls.append((principal.user_id, kwargs))
        return _Item(len(calls))

    async def resolve_person(user_id):
        return people.get(user_id)

    async def no_owner():
        raise AssertionError("per-person mail must never resolve the install owner")

    monkeypatch.setattr(inbound_registry, "register_arrival", register_arrival)
    monkeypatch.setattr(inbound_registration, "resolve_person", resolve_person)
    monkeypatch.setattr(inbound_registration, "_resolve_owner", no_owner)
    return calls, state, people


@pytest.fixture
def imap(tmp_path, monkeypatch):
    cert, key = make_cert(tmp_path)
    monkeypatch.setattr(mb, "_ssl_context", lambda: client_context(cert))
    server = FakeIMAP(cert, key, username="alice", password=SECRET, messages={
        1: rfc822("Quote for October", msg_id="m1@example.com"),
        2: rfc822("Invoice", msg_id="m2@example.com"),
    })
    yield server
    server.close()


def save(principal, port, address="alice@example.com", password=SECRET):
    return asyncio.run(mb.save(principal, address, {
        "username": "alice", "password": password,
        "imap_host": "localhost", "imap_port": port,
        "smtp_host": "localhost", "smtp_port": 465,
    }))


def test_fresh_install_has_no_mailbox(tmp_path, monkeypatch):
    monkeypatch.setattr(email_poller, "CONFIG_PATH", str(tmp_path / "missing.json"))
    assert email_poller.load_install_accounts() == []
    assert email_poller.load_personal_mailboxes() == []


def test_install_wide_config_still_read(tmp_path, monkeypatch):
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"accounts": [
        {"id": "gmail1", "address": "owner@gmail.com", "imap": {"host": "imap.gmail.com", "port": 993}},
        {"id": "gmail2", "address": "off@gmail.com", "enabled": False, "imap": {"host": "imap.gmail.com", "port": 993}},
    ]}))
    monkeypatch.setattr(email_poller, "CONFIG_PATH", str(path))
    assert [a["id"] for a in email_poller.load_install_accounts()] == ["gmail1"]


def test_personal_mail_filed_only_as_that_person(imap, registry):
    calls, _, _ = registry
    save(ALICE, imap.port)
    creds = email_poller.load_personal_mailboxes()
    assert [(c.owner_user_id, c.name) for c in creds] == [("alice", "alice@example.com")]
    assert email_poller.poll_personal_mailbox(creds[0]) == 2
    assert [c[0] for c in calls] == ["alice", "alice"]
    assert [c[1]["subject"] for c in calls] == ["Quote for October", "Invoice"]
    assert calls[0][1]["account_id"] == "alice@example.com"
    assert calls[0][1]["surface"] == "email"
    assert "EXAMINE" in imap.commands  # read-only: never marks mail as read
    state = mb.poll_state("alice", "alice@example.com")
    assert state["ok"] is True and state["last_uid"] == 2

    # Next poll only picks up new mail.
    imap.messages[3] = rfc822("Follow-up", msg_id="m3@example.com")
    assert email_poller.poll_personal_mailbox(creds[0]) == 1
    assert [c[1]["subject"] for c in calls][-1] == "Follow-up"


def test_registry_down_keeps_cursor_for_retry(imap, registry):
    calls, state, _ = registry
    save(ALICE, imap.port)
    cred = email_poller.load_personal_mailboxes()[0]
    state["up"] = False
    assert email_poller.poll_personal_mailbox(cred) == 0
    assert mb.poll_state("alice", "alice@example.com")["last_uid"] == 0
    state["up"] = True
    assert email_poller.poll_personal_mailbox(cred) == 2


def test_removed_person_mail_goes_to_nobody(imap, registry):
    calls, _, people = registry
    save(ALICE, imap.port)
    del people["alice"]
    cred = email_poller.load_personal_mailboxes()[0]
    assert email_poller.poll_personal_mailbox(cred) == 0
    assert calls == []


def test_wrong_password_recorded_as_needs_attention(imap, registry):
    save(ALICE, imap.port, password="wrong")
    cred = email_poller.load_personal_mailboxes()[0]
    assert email_poller.poll_personal_mailbox(cred) == 0
    state = mb.poll_state("alice", "alice@example.com")
    assert state["ok"] is False and "Sign-in failed" in state["error"]
    view = asyncio.run(mb.list_mine(ALICE))[0]
    assert view["state"] == "needs_attention"
    assert "wrong" not in json.dumps(view)


def test_install_wide_address_not_filed_twice(imap, registry):
    calls, _, _ = registry
    save(ALICE, imap.port)
    cred = email_poller.load_personal_mailboxes()[0]
    assert email_poller.poll_personal_mailbox(cred, {"alice@example.com"}) == 0
    assert calls == [] and imap.logins == []


def test_two_people_each_get_their_own(imap, registry):
    calls, _, _ = registry
    save(ALICE, imap.port)
    save(BOB, imap.port, address="bob@example.com")
    for cred in email_poller.load_personal_mailboxes():
        email_poller.poll_personal_mailbox(cred)
    owners = {(c[0], c[1]["account_id"]) for c in calls}
    assert owners == {("alice", "alice@example.com"), ("bob", "bob@example.com")}
    assert os.environ.get("HERMES_HOME")
