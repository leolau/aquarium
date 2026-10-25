#!/usr/bin/env python3
"""Email poller XOAUTH2 authentication tests (no sockets, no network)."""

import base64
import os
import sqlite3
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'email'))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import email_poller
import google_oauth

CRED = google_oauth.GoogleCredentials(
    'cid', 'sec', 'ref', 'owner-1', 'alice@gmail.com'
)


def _db():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute(
        """CREATE TABLE email_accounts (
            id TEXT PRIMARY KEY, address TEXT, label TEXT,
            last_poll TEXT, last_uid INTEGER, status TEXT)"""
    )
    conn.commit()
    return conn


ACCOUNT = {
    'id': 'gmail1',
    'address': 'alice@gmail.com',
    'imap': {'host': 'imap.gmail.com', 'port': 993, 'tls': True},
    'folders': ['INBOX'],
}


class TestEmailPollerXoauth2(unittest.TestCase):
    def setUp(self):
        email_poller.poll_status['accounts'] = {}
        google_oauth._token_cache.clear()

    @patch.object(email_poller.google_oauth, 'get_access_token', return_value='tok-1')
    @patch.object(email_poller.google_oauth, 'credentials_for_email', return_value=CRED)
    def test_authenticates_with_xoauth2(self, _cred, _tok):
        conn_mock = MagicMock()
        conn_mock.select.return_value = ('OK', [b'0'])
        conn_mock.uid.return_value = ('OK', [b''])
        with patch.object(email_poller.imaplib, 'IMAP4_SSL', return_value=conn_mock):
            new = email_poller.poll_account(ACCOUNT, _db())
        self.assertEqual(new, 0)
        conn_mock.authenticate.assert_called_once()
        mech, responder = conn_mock.authenticate.call_args[0]
        self.assertEqual(mech, 'XOAUTH2')
        decoded = responder(b'').decode()
        self.assertEqual(decoded, 'user=alice@gmail.com\x01auth=Bearer tok-1\x01\x01')
        self.assertEqual(
            email_poller.poll_status['accounts']['gmail1']['auth'], 'xoauth2'
        )

    @patch.object(email_poller.google_oauth, 'credentials_for_email', return_value=None)
    def test_missing_store_entry_skips_account(self, _cred):
        self.assertEqual(email_poller.poll_account(ACCOUNT, _db()), 0)
        self.assertEqual(
            email_poller.poll_status['accounts']['gmail1']['auth'], 'no_credential'
        )

    @patch.object(email_poller.google_oauth, 'invalidate')
    @patch.object(
        email_poller.google_oauth,
        'get_access_token',
        side_effect=['stale', 'fresh'],
    )
    @patch.object(email_poller.google_oauth, 'credentials_for_email', return_value=CRED)
    def test_retries_once_on_auth_failure(self, _cred, tok, invalidate):
        conn_bad = MagicMock()
        conn_bad.authenticate.side_effect = email_poller.imaplib.IMAP4.error('NO')
        conn_good = MagicMock()
        conn_good.select.return_value = ('OK', [b'0'])
        conn_good.uid.return_value = ('OK', [b''])
        with patch.object(
            email_poller.imaplib, 'IMAP4_SSL', side_effect=[conn_bad, conn_good]
        ):
            email_poller.poll_account(ACCOUNT, _db())
        invalidate.assert_called_once_with(CRED)
        self.assertEqual(tok.call_count, 2)
        conn_good.authenticate.assert_called_once()


def _full_db():
    conn = _db()
    conn.execute(
        """CREATE TABLE email_messages (
            id TEXT PRIMARY KEY, account_id TEXT NOT NULL, from_addr TEXT NOT NULL,
            from_name TEXT, to_addrs TEXT, cc_addrs TEXT, subject TEXT,
            body_text TEXT, body_html TEXT, has_attachments INTEGER,
            attachment_info TEXT, message_id TEXT UNIQUE, in_reply_to TEXT,
            thread_id TEXT, folder TEXT DEFAULT 'INBOX',
            received_at TEXT NOT NULL, batch_id TEXT, raw_headers TEXT)"""
    )
    conn.commit()
    return conn


RAW = (
    b'From: Ada <ada@example.com>\r\nTo: alice@gmail.com\r\n'
    b'Subject: Quote\r\nMessage-ID: <rfc-1@mail>\r\n'
    b'Date: Mon, 10 Aug 2026 09:30:00 +0000\r\n\r\nthe quote\r\n'
)


class TestDuplicateMessageNotReRegistered(unittest.TestCase):
    """The same Message-ID in two folders is stored once; INSERT OR IGNORE
    never raises, so the poller must check rowcount before mirroring it."""

    def setUp(self):
        email_poller.poll_status['accounts'] = {}

    @patch.object(email_poller.google_oauth, 'get_access_token', return_value='tok')
    @patch.object(email_poller.google_oauth, 'credentials_for_email', return_value=CRED)
    def test_second_folder_copy_is_skipped(self, _cred, _tok):
        conn_mock = MagicMock()
        conn_mock.select.return_value = ('OK', [b'1'])

        # UIDs are per folder: the All Mail copy has a higher UID than the
        # INBOX one, so it is fetched in the same pass.
        searches = iter([b'7', b'9'])

        def uid(cmd, *args):
            if cmd == 'SEARCH':
                return ('OK', [next(searches)])
            return ('OK', [(b'x (RFC822)', RAW)])

        conn_mock.uid.side_effect = uid
        registered = []
        fake = MagicMock()
        fake.register_item = lambda **kw: registered.append(kw) or 'item-1'
        account = dict(ACCOUNT, folders=['INBOX', '[Gmail]/All Mail'])
        with patch.object(email_poller.imaplib, 'IMAP4_SSL', return_value=conn_mock), \
                patch.dict(sys.modules, {'shared.inbound_registration': fake}):
            new = email_poller.poll_account(account, _full_db())
        self.assertEqual(new, 1)
        self.assertEqual([r['external_id'] for r in registered], ['rfc-1@mail'])


if __name__ == '__main__':
    unittest.main()
