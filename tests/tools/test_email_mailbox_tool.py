"""email_mailbox tool: the person's own IMAP/SMTP mailboxes (no network)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import tools.email_mailbox_tool as tool
from tools.access_policy import acting_as

PAYLOAD = {
    "imap_host": "imap.corp.example", "imap_port": 993, "imap_security": "ssl",
    "smtp_host": "smtp.corp.example", "smtp_port": 587, "smtp_security": "starttls",
    "username": "ops", "password": "s3cret-pw",
}
RAW = (
    b"From: Ada <ada@example.com>\r\nTo: ops@corp.example\r\n"
    b"Subject: Quote\r\nMessage-ID: <m1@example.com>\r\n"
    b"Date: Mon, 10 Aug 2026 09:30:00 +0000\r\n\r\nthe quote\r\n"
)


def _entry(name="ops@corp.example"):
    return SimpleNamespace(name=name, owner_user_id="u1", payload=dict(PAYLOAD))


@pytest.fixture
def entries(monkeypatch):
    found = [_entry()]

    async def own(principal):
        assert principal.user_id == "u1"
        return found

    import hermes_cli.email_mailboxes as mb

    monkeypatch.setattr(mb, "_own_entries", own)
    return found


@pytest.fixture
def imap(monkeypatch):
    conn = MagicMock()
    conn.select.return_value = ("OK", [b"1"])

    def uid(cmd, *args):
        if cmd == "SEARCH":
            return ("OK", [b"5 7"])
        if cmd == "FETCH":
            return ("OK", [(b"x", RAW)])
        return ("OK", [b""])

    conn.uid.side_effect = uid
    conn.list.return_value = ("OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren) "/" "Archive"'])
    import hermes_cli.email_mailboxes as mb

    monkeypatch.setattr(mb, "open_imap", lambda payload: conn)
    return conn


@pytest.fixture
def smtp(monkeypatch):
    conn = MagicMock()
    monkeypatch.setattr(tool.smtplib, "SMTP", MagicMock(return_value=conn))
    return conn


def _call(**args):
    with acting_as("u1", "member"):
        return json.loads(asyncio.run(tool.email_mailbox_tool(args)))


def test_registered_in_core_toolset():
    from toolsets import _HERMES_CORE_TOOLS, TOOLSETS

    assert "email_mailbox" in _HERMES_CORE_TOOLS
    assert TOOLSETS["email_mailbox"]["tools"] == ["email_mailbox"]


def test_requires_bound_person(entries):
    out = json.loads(asyncio.run(tool.email_mailbox_tool({"action": "list_mailboxes"})))
    assert out["success"] is False


def test_list_never_returns_password(entries):
    out = _call(action="list_mailboxes")
    assert out["mailboxes"][0]["address"] == "ops@corp.example"
    assert "s3cret-pw" not in json.dumps(out)


def test_no_mailbox_explains_settings(entries):
    entries.clear()
    out = _call(action="search")
    assert out["success"] is False and "Settings" in out["error"]


def test_several_mailboxes_need_a_choice(entries, imap):
    entries.append(_entry("sales@corp.example"))
    assert _call(action="search")["success"] is False
    assert _call(action="search", mailbox="Sales@corp.example")["mailbox"] == "sales@corp.example"


def test_search_newest_first(entries, imap):
    out = _call(action="search", query="UNSEEN", limit=5)
    assert [m["uid"] for m in out["messages"]] == ["7", "5"]
    assert out["messages"][0]["subject"] == "Quote"
    imap.select.assert_called_with('"INBOX"', readonly=True)
    assert imap.uid.call_args_list[0].args == ("SEARCH", None, "UNSEEN")


def test_read_returns_body(entries, imap):
    out = _call(action="read", uid="7")
    assert out["message"]["body"].strip() == "the quote"
    assert out["message"]["from"] == "Ada <ada@example.com>"


def test_send_uses_starttls_and_login(entries, smtp):
    out = _call(action="send", to=["bob@example.com"], subject="Hi", body="hello")
    assert out["sent"] is True
    smtp.starttls.assert_called_once()
    smtp.login.assert_called_once_with("ops", "s3cret-pw")
    msg = smtp.send_message.call_args.args[0]
    assert msg["From"] == "ops@corp.example" and msg["To"] == "bob@example.com"


def test_send_requires_recipient(entries, smtp):
    assert _call(action="send", subject="Hi")["success"] is False
    smtp.send_message.assert_not_called()


def test_reply_threads_the_message(entries, imap, smtp):
    out = _call(action="reply", uid="7", body="thanks")
    msg = smtp.send_message.call_args.args[0]
    assert msg["To"] == "Ada <ada@example.com>"
    assert msg["Subject"] == "Re: Quote"
    assert msg["In-Reply-To"] == "<m1@example.com>"
    assert out["in_reply_to"] == "<m1@example.com>"


def test_folders(entries, imap):
    assert _call(action="folders")["folders"] == ["INBOX", "Archive"]


def test_modify_marks_and_moves(entries, imap):
    out = _call(action="modify", uid="7", seen=True, move_to="Archive")
    assert "moved to Archive" in out["changes"]
    imap.uid.assert_any_call("STORE", "7", "+FLAGS", "(\\Seen)")
    imap.uid.assert_any_call("COPY", "7", '"Archive"')
    imap.expunge.assert_called_once()


def test_login_failure_is_plain_and_hides_password(entries, monkeypatch):
    import hermes_cli.email_mailboxes as mb

    def boom(payload):
        raise mb.imaplib.IMAP4.error(b"[AUTHENTICATIONFAILED] Invalid credentials")

    monkeypatch.setattr(mb, "open_imap", boom)
    out = _call(action="search")
    assert out["success"] is False
    assert "s3cret-pw" not in out["error"]
