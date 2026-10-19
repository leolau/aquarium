#!/usr/bin/env python3
"""
Email IMAP Poller for Hermes Agent

Polls multiple Gmail accounts via IMAP, stores new emails in SQLite.
Supports incremental fetch (only new emails since last poll).
"""

import imaplib
import email
import email.header
import email.utils
import json
import sqlite3
import os
import sys
import time
import uuid
import threading
import traceback
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from email.utils import parsedate_to_datetime

DB_PATH = os.environ.get('EMAIL_DB_PATH', '/opt/data/email-messages/email_data.db')
CONFIG_PATH = os.environ.get('EMAIL_CONFIG_PATH', '/opt/data/email-messages/config.json')
# Email data lives in its own DB (split from the shared whatsapp_data.db to
# end write-lock contention across channels).
HEALTH_PORT = 7901

# Make custom/shared importable so the poller can register attachment files.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import google_oauth

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def load_config():
    with open(CONFIG_PATH, encoding='utf-8') as f:
        return json.load(f)

def load_install_accounts():
    """Enabled entries of the install-wide config; none when it is absent
    (fresh installs start with no mailbox)."""
    try:
        config = load_config()
    except FileNotFoundError:
        return []
    return [a for a in config.get('accounts', []) if a.get('enabled', True)]

def load_personal_mailboxes():
    """Every person's own mailbox from the credential store (Get ready 7)."""
    try:
        import asyncio
        from hermes_cli import email_mailboxes
        return asyncio.run(email_mailboxes.all_mailboxes())
    except Exception as e:
        print(f"[poller] Could not read personal mailboxes: {e}")
        return []

def decode_header_value(raw):
    """Decode an email header value (handles encoded words like =?UTF-8?B?...?=)."""
    if not raw:
        return ''
    parts = email.header.decode_header(raw)
    decoded = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded.append(part.decode(charset or 'utf-8', errors='replace'))
        else:
            decoded.append(part)
    return ' '.join(decoded)

def extract_email_body(msg):
    """Extract plain text and HTML body from an email message."""
    text_body = ''
    html_body = ''

    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disp = str(part.get('Content-Disposition', ''))
            if 'attachment' in content_disp:
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or 'utf-8'
                text = payload.decode(charset, errors='replace')
                if content_type == 'text/plain' and not text_body:
                    text_body = text
                elif content_type == 'text/html' and not html_body:
                    html_body = text
            except Exception:
                pass
    else:
        content_type = msg.get_content_type()
        try:
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or 'utf-8'
                text = payload.decode(charset, errors='replace')
                if content_type == 'text/plain':
                    text_body = text
                elif content_type == 'text/html':
                    html_body = text
        except Exception:
            pass

    return text_body, html_body

def extract_attachments(msg):
    """Extract attachment metadata and bytes from an email message.

    Returns ``(metadata, payloads)``: *metadata* is a list of dicts suitable
    for JSON serialisation into the ``attachment_info`` SQLite column
    (name, mimetype, size); *payloads* is a list of dicts with the same keys
    plus ``data`` (the raw attachment bytes) for file registration.
    """
    attachments = []
    payloads = []
    if not msg.is_multipart():
        return attachments, payloads

    for part in msg.walk():
        content_disp = str(part.get('Content-Disposition', ''))
        if 'attachment' in content_disp or 'inline' in content_disp:
            filename = part.get_filename()
            if filename:
                filename = decode_header_value(filename)
                mimetype = part.get_content_type()
                payload = part.get_payload(decode=True)
                size = len(payload) if payload else 0
                attachments.append({
                    'name': filename,
                    'mimetype': mimetype,
                    'size': size
                })
                if payload:
                    payloads.append({
                        'name': filename,
                        'mimetype': mimetype,
                        'data': payload,
                    })
    return attachments, payloads

def extract_thread_id(msg):
    """Extract thread ID from References or In-Reply-To headers."""
    references = msg.get('References', '')
    in_reply_to = msg.get('In-Reply-To', '')

    if references:
        # First message-id in References is typically the thread root
        refs = references.strip().split()
        if refs:
            return refs[0].strip('<>').strip()

    if in_reply_to:
        return in_reply_to.strip('<>').strip()

    # Use own Message-ID as thread root
    msg_id = msg.get('Message-ID', '')
    if msg_id:
        return msg_id.strip('<>').strip()

    return None

def parse_address_list(raw):
    """Parse a comma-separated address list into JSON array."""
    if not raw:
        return '[]'
    addrs = []
    decoded = decode_header_value(raw)
    for name, addr in email.utils.getaddresses([decoded]):
        if addr:
            addrs.append({'name': name, 'address': addr})
    return json.dumps(addrs)


def _register_email_attachments(payloads, *, account_id, conversation,
                                 sender_id, sender_name, message_id,
                                 received_dt, inbound_item_id=None,
                                 owner_user_id=None):
    """Register email attachment bytes in the file registry.

    Best-effort: failures are logged but never raise into the poller path.
    Uses the shared file_registration module which resolves the owner
    principal and calls store_and_register() directly.
    """
    try:
        from shared.file_registration import register_files_batch
    except ImportError:
        print("[poller] file_registration module not available; skipping attachment registration")
        return

    # Ensure received_dt has UTC timezone for the registry.
    if received_dt is not None:
        if received_dt.tzinfo is None:
            received_dt = received_dt.replace(tzinfo=timezone.utc)
    else:
        received_dt = datetime.now(timezone.utc)

    items = [
        {
            'data': p['data'],
            'surface': 'email',
            'filename': p['name'],
            'content_type': p.get('mimetype', 'application/octet-stream'),
            'account_id': account_id,
            'conversation': conversation,
            'sender_id': sender_id,
            'sender_name': sender_name,
            'message_id': message_id,
            'received_at': received_dt,
            'inbound_item_id': inbound_item_id,
        }
        for p in payloads
    ]
    registered = register_files_batch(items, owner_user_id=owner_user_id)
    if registered:
        print(f"[poller] Registered {registered} attachment file(s) from email {message_id}")

def poll_account(account, db):
    """Poll a single IMAP account for new emails."""
    account_id = account['id']
    address = account['address']
    imap_host = account['imap']['host']
    imap_port = account['imap']['port']
    folders = account.get('folders', ['INBOX'])

    cred = google_oauth.credentials_for_email(
        'email', account.get('google_account') or address,
        required_scope=google_oauth.MAIL_SCOPE,
    )
    if cred is None:
        print(
            f"[poller] WARNING: no credential-store entry with the email "
            f"service for {address} (connect it in Settings and grant the "
            f"Mail scope)"
        )
        poll_status.setdefault('accounts', {}).setdefault(account_id, {})['auth'] = 'no_credential'
        return 0

    # Ensure account exists in DB
    existing = db.execute("SELECT last_uid FROM email_accounts WHERE id = ?", (account_id,)).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO email_accounts (id, address, label, last_poll, last_uid, status) VALUES (?, ?, ?, NULL, 0, 'active')",
            (account_id, address, account.get('label', address))
        )
        db.commit()
        last_uid = 0
    else:
        last_uid = existing['last_uid'] or 0

    def _connect_and_auth():
        if account['imap'].get('tls', True):
            conn = imaplib.IMAP4_SSL(imap_host, imap_port)
        else:
            conn = imaplib.IMAP4(imap_host, imap_port)
        token = google_oauth.get_access_token(cred)
        conn.authenticate(
            'XOAUTH2',
            lambda challenge: google_oauth.xoauth2_string(address, token).encode(),
        )
        return conn

    total_new = 0
    try:
        try:
            mail = _connect_and_auth()
        except imaplib.IMAP4.error as first_error:
            # Stale access token or rotated refresh: invalidate and retry once.
            google_oauth.invalidate(cred)
            print(f"[poller] {address}: XOAUTH2 failed ({first_error}); retrying once")
            mail = _connect_and_auth()
        poll_status.setdefault('accounts', {}).setdefault(account_id, {})['auth'] = 'xoauth2'

        for folder in folders:
            try:
                status, data = mail.select(folder, readonly=True)
                if status != 'OK':
                    print(f"[poller] {address}: Cannot select {folder}")
                    continue

                # Fetch emails with UID > last_uid
                if last_uid > 0:
                    search_criteria = f'UID {last_uid + 1}:*'
                else:
                    # First run: get only recent emails (last 24h)
                    since_date = (datetime.now() - timedelta(days=1)).strftime('%d-%b-%Y')
                    search_criteria = f'SINCE {since_date}'

                status, msg_nums = mail.uid('SEARCH', None, search_criteria)
                if status != 'OK' or not msg_nums[0]:
                    continue

                uids = msg_nums[0].split()
                # Limit to 50 per poll to avoid overload
                uids = uids[:50]

                for uid_bytes in uids:
                    uid = int(uid_bytes)
                    if uid <= last_uid:
                        continue

                    try:
                        status, msg_data = mail.uid('FETCH', uid_bytes, '(RFC822)')
                        if status != 'OK' or not msg_data[0]:
                            continue

                        raw_email = msg_data[0][1]
                        msg = email.message_from_bytes(raw_email)

                        # Extract fields
                        message_id = msg.get('Message-ID', '').strip('<>').strip()
                        if not message_id:
                            message_id = str(uuid.uuid4())

                        from_header = decode_header_value(msg.get('From', ''))
                        from_name, from_addr = email.utils.parseaddr(from_header)
                        if not from_addr:
                            from_addr = from_header

                        subject = decode_header_value(msg.get('Subject', ''))
                        to_addrs = parse_address_list(msg.get('To', ''))
                        cc_addrs = parse_address_list(msg.get('Cc', ''))
                        in_reply_to = msg.get('In-Reply-To', '').strip('<>').strip() or None
                        thread_id = extract_thread_id(msg)

                        text_body, html_body = extract_email_body(msg)
                        attachments, attachment_payloads = extract_attachments(msg)
                        has_attachments = 1 if attachments else 0
                        attachment_info = json.dumps(attachments) if attachments else None

                        # Parse received date
                        date_header = msg.get('Date', '')
                        try:
                            received_dt = parsedate_to_datetime(date_header)
                            received_at = received_dt.isoformat()
                        except Exception:
                            received_dt = None
                            received_at = datetime.now(timezone.utc).isoformat()

                        # Extract key headers for debugging
                        raw_headers = ''
                        for key in ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID',
                                    'In-Reply-To', 'References', 'List-Unsubscribe', 'X-Mailer']:
                            val = msg.get(key, '')
                            if val:
                                raw_headers += f'{key}: {val}\n'

                        # Insert into DB (dedup by message_id)
                        try:
                            db.execute(
                                """INSERT OR IGNORE INTO email_messages
                                   (id, account_id, from_addr, from_name, to_addrs, cc_addrs,
                                    subject, body_text, body_html, has_attachments, attachment_info,
                                    message_id, in_reply_to, thread_id, folder, received_at, batch_id, raw_headers)
                                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)""",
                                (str(uuid.uuid4()), account_id, from_addr, from_name, to_addrs, cc_addrs,
                                 subject, text_body, html_body, has_attachments, attachment_info,
                                 message_id, in_reply_to, thread_id, folder, received_at, raw_headers)
                            )
                            total_new += 1

                            # Mirror the message into the shared inbound
                            # registry. Only the plain-text body: the shared
                            # store is for reading and searching, and copying
                            # marketing HTML into it would bloat the search
                            # index without making anything more findable.
                            inbound_item_id = None
                            try:
                                from shared.inbound_registration import register_item
                                inbound_item_id = register_item(
                                    surface='email',
                                    external_id=message_id,
                                    account_id=account_id,
                                    kind='message',
                                    conversation=thread_id or message_id,
                                    sender_id=from_addr,
                                    sender_name=from_name,
                                    subject=subject,
                                    body=text_body or '',
                                    occurred_at=received_dt or received_at,
                                    has_attachments=bool(attachments),
                                    metadata={
                                        'to': to_addrs,
                                        'cc': cc_addrs,
                                        'folder': folder,
                                        'in_reply_to': in_reply_to,
                                    },
                                )
                            except ImportError:
                                pass
                            except Exception as e:
                                print(f"[poller] Inbound registration failed for {message_id}: {e}")

                            # Register attachment files in the file registry.
                            # Best-effort: failures are logged but never break
                            # email processing.
                            if attachment_payloads:
                                _register_email_attachments(
                                    attachment_payloads,
                                    account_id=account_id,
                                    conversation=thread_id or message_id,
                                    sender_id=from_addr,
                                    sender_name=from_name,
                                    message_id=message_id,
                                    received_dt=received_dt,
                                    inbound_item_id=inbound_item_id,
                                )
                        except sqlite3.IntegrityError:
                            pass  # Duplicate message_id — already stored

                        if uid > last_uid:
                            last_uid = uid

                    except Exception as e:
                        print(f"[poller] {address}: Error fetching UID {uid}: {e}")
                        continue

            except Exception as e:
                print(f"[poller] {address}: Error with folder {folder}: {e}")
                continue

        mail.logout()

    except Exception as e:
        print(f"[poller] {address}: Connection error: {e}")
        traceback.print_exc()
        poll_status.setdefault('accounts', {}).setdefault(account_id, {}).update(
            auth='auth_error', last_auth_error=str(e)[:200]
        )
        db.execute("UPDATE email_accounts SET status = 'error' WHERE id = ?", (account_id,))
        db.commit()
        return 0

    # Update last_poll and last_uid
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        "UPDATE email_accounts SET last_poll = ?, last_uid = ?, status = 'active' WHERE id = ?",
        (now, last_uid, account_id)
    )
    db.commit()

    if total_new > 0:
        print(f"[poller] {address}: {total_new} new emails (last_uid={last_uid})")

    return total_new


def _register_personal_message(msg, *, owner_user_id, address, folder):
    """File one message from a person's own mailbox as that person only.

    Nothing goes into the shared email_messages table: the batcher, triage
    and email MCP read it as the install owner. Returns False when the
    registry could not take it (the caller retries on the next poll).
    """
    from shared.inbound_registration import register_item

    message_id = msg.get('Message-ID', '').strip('<>').strip() or str(uuid.uuid4())
    from_header = decode_header_value(msg.get('From', ''))
    from_name, from_addr = email.utils.parseaddr(from_header)
    from_addr = from_addr or from_header
    subject = decode_header_value(msg.get('Subject', ''))
    to_addrs = parse_address_list(msg.get('To', ''))
    cc_addrs = parse_address_list(msg.get('Cc', ''))
    in_reply_to = msg.get('In-Reply-To', '').strip('<>').strip() or None
    thread_id = extract_thread_id(msg)
    text_body, _html = extract_email_body(msg)
    attachments, attachment_payloads = extract_attachments(msg)
    try:
        received_dt = parsedate_to_datetime(msg.get('Date', ''))
    except Exception:
        received_dt = None
    item_id = register_item(
        surface='email',
        external_id=message_id,
        account_id=address,
        kind='message',
        conversation=thread_id or message_id,
        sender_id=from_addr,
        sender_name=from_name,
        subject=subject,
        body=text_body or '',
        occurred_at=received_dt or datetime.now(timezone.utc),
        has_attachments=bool(attachments),
        metadata={'to': to_addrs, 'cc': cc_addrs, 'folder': folder,
                  'in_reply_to': in_reply_to},
        owner_user_id=owner_user_id,
    )
    if item_id is None:
        return False
    if attachment_payloads:
        _register_email_attachments(
            attachment_payloads,
            account_id=address,
            conversation=thread_id or message_id,
            sender_id=from_addr,
            sender_name=from_name,
            message_id=message_id,
            received_dt=received_dt,
            inbound_item_id=item_id,
            owner_user_id=owner_user_id,
        )
    return True


def poll_personal_mailbox(cred, install_addresses=()):
    """Poll one person's own mailbox (password login, INBOX, read-only)."""
    from hermes_cli import email_mailboxes as mb

    owner, address, payload = cred.owner_user_id, cred.name, cred.payload
    state = mb.poll_state(owner, address)
    now = datetime.now(timezone.utc).isoformat()
    if address.lower() in install_addresses:
        # Already read by the install-wide config; don't file it twice.
        mb.record_poll(owner, address, {**state, 'at': now, 'ok': True,
                                        'error': None, 'new_count': 0,
                                        'skipped': 'install-wide'})
        return 0
    try:
        mail = mb.open_imap(payload)
    except Exception as e:
        mb.record_poll(owner, address, {**state, 'at': now, 'ok': False,
                                        'error': mb.plain_error(e, payload['imap_host'])})
        return 0
    new_count, error = 0, None
    uidvalidity = state.get('uidvalidity')
    last_uid = int(state.get('last_uid') or 0)
    try:
        status, _ = mail.select('INBOX', readonly=True)
        if status != 'OK':
            raise RuntimeError('cannot open INBOX')
        _, values = mail.response('UIDVALIDITY')
        current = (values[0].decode() if values and values[0] else '')
        if current != uidvalidity:
            uidvalidity, last_uid = current, 0
        if last_uid > 0:
            criteria = f'UID {last_uid + 1}:*'
        else:
            criteria = 'SINCE ' + (datetime.now() - timedelta(days=1)).strftime('%d-%b-%Y')
        status, found = mail.uid('SEARCH', None, criteria)
        uids = [int(u) for u in found[0].split()] if status == 'OK' and found and found[0] else []
        for uid in sorted(u for u in uids if u > last_uid)[:50]:
            status, msg_data = mail.uid('FETCH', str(uid), '(RFC822)')
            if status != 'OK' or not msg_data or not isinstance(msg_data[0], tuple):
                last_uid = uid
                continue
            msg = email.message_from_bytes(msg_data[0][1])
            if not _register_personal_message(msg, owner_user_id=owner,
                                              address=address, folder='INBOX'):
                error = 'New mail could not be filed yet; it will be retried.'
                break
            new_count += 1
            last_uid = uid
    except Exception as e:
        print(f"[poller] personal mailbox: error ({type(e).__name__})")
        error = 'Reading the mailbox failed; it will be retried.'
    finally:
        try:
            mail.logout()
        except Exception:
            pass
    mb.record_poll(owner, address, {
        'uidvalidity': uidvalidity, 'last_uid': last_uid, 'at': now,
        'ok': error is None, 'error': error, 'new_count': new_count,
    })
    return new_count


# Health check server
poll_status = {'last_poll': None, 'accounts': {}, 'running': True}

class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(poll_status, default=str).encode())

    def log_message(self, format, *args):
        pass

def start_health_server():
    server = HTTPServer((os.environ.get('EMAIL_HEALTH_HOST', '127.0.0.1'), HEALTH_PORT), HealthHandler)
    server.serve_forever()


def main():
    print(f"[poller] Email IMAP Poller starting...")
    print(f"[poller] DB: {DB_PATH}")
    print(f"[poller] Config: {CONFIG_PATH}")

    # Start health server
    health_thread = threading.Thread(target=start_health_server, daemon=True)
    health_thread.start()
    print(f"[poller] Health server on port {HEALTH_PORT}")

    accounts = load_install_accounts()
    personal = load_personal_mailboxes()
    print(f"[poller] Active accounts: {len(accounts)}")
    for a in accounts:
        print(f"[poller]   {a['id']}: {a['address']} (poll every {a.get('poll_interval_seconds', 60)}s)")
    print(f"[poller] Personal mailboxes: {len(personal)}")

    if not accounts and not personal:
        print("[poller] No enabled accounts. Waiting for config update...")
        while True:
            time.sleep(60)
            accounts = load_install_accounts()
            personal = load_personal_mailboxes()
            if accounts or personal:
                break

    poll_status['accounts'] = {a['id']: {'address': a['address'], 'last_poll': None, 'new_count': 0} for a in accounts}

    while True:
        accounts = load_install_accounts()
        personal = load_personal_mailboxes()

        db = get_db()
        for account in accounts:
            try:
                new_count = poll_account(account, db)
                now = datetime.now(timezone.utc).isoformat()
                poll_status['accounts'][account['id']] = {
                    'address': account['address'],
                    'last_poll': now,
                    'new_count': new_count
                }
                poll_status['last_poll'] = now
            except Exception as e:
                print(f"[poller] Error polling {account['address']}: {e}")
                traceback.print_exc()
        db.close()

        install_addresses = {str(a.get('address', '')).lower() for a in accounts}
        personal_errors = 0
        for cred in personal:
            try:
                poll_personal_mailbox(cred, install_addresses)
            except Exception as e:
                personal_errors += 1
                print(f"[poller] Error polling a personal mailbox: {type(e).__name__}")
        poll_status['personal'] = {'mailboxes': len(personal), 'errors': personal_errors}

        # Sleep for the shortest poll interval
        min_interval = min((a.get('poll_interval_seconds', 60) for a in accounts), default=60)
        time.sleep(min_interval)

if __name__ == '__main__':
    main()
