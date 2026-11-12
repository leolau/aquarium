#!/usr/bin/env python3
"""
Unified Hourly Digest for Hermes Agent

Generates a merged summary of WhatsApp + Email activity every hour
and sends to Telegram. Uses DeepSeek for summary generation.
"""

import json
import os
import sqlite3
import sys
import time
from html import escape as _esc
import uuid
from datetime import datetime, timezone, timedelta
from collections import Counter
from urllib.request import Request, urlopen

_CUSTOM_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _path in (_CUSTOM_DIR, os.path.dirname(_CUSTOM_DIR)):
    if _path not in sys.path:
        sys.path.append(_path)

# Config
WA_CONFIG_PATH = '/opt/data/whatsapp-messages/config.json'
DB_PATH = os.environ.get('MESSAGING_DB_PATH', '/opt/data/whatsapp-messages/messaging_data.db')
# Email tables live in email_data.db; get_db() attaches it so the
# unqualified email_* queries below keep working.
EMAIL_DB_PATH = os.environ.get('EMAIL_DB_PATH', '/opt/data/email-messages/email_data.db')
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_USER_ID = os.environ.get('TELEGRAM_ALLOWED_USERS', '').split(',')[0]
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')

def load_config():
    try:
        with open(WA_CONFIG_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

config = load_config()
DIGEST_INTERVAL_MIN = config.get('digest', {}).get('frequency_minutes', 60)


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    if os.path.exists(EMAIL_DB_PATH) or os.path.isdir(
            os.path.dirname(EMAIL_DB_PATH)):
        conn.execute("ATTACH DATABASE ? AS emaildb", (EMAIL_DB_PATH,))
    return conn


def send_telegram(text, parse_mode='HTML', chat_id=None):
    chat_id = chat_id or TELEGRAM_USER_ID
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        print(f"[digest] No Telegram creds, would send: {text[:100]}")
        return False

    url = f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage'
    payload = {
        'chat_id': chat_id,
        'text': text,
        'parse_mode': parse_mode,
    }

    req = Request(url, data=json.dumps(payload).encode(),
                  headers={'Content-Type': 'application/json'})
    try:
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read().decode())
        return data.get('ok', False)
    except Exception as e:
        print(f"[digest] Telegram error: {e}")
        return False


def call_deepseek(prompt):
    url = 'https://api.deepseek.com/v1/chat/completions'
    payload = {
        'model': 'deepseek-chat',
        'messages': [
            {'role': 'system', 'content': 'You are a concise personal assistant summarizing communication activity across WhatsApp and Email. Be brief but informative. Use bullet points. Group by channel when relevant.'},
            {'role': 'user', 'content': prompt}
        ],
        'temperature': 0.3,
        'max_tokens': 1200,
    }

    req = Request(url, data=json.dumps(payload).encode(),
                  headers={'Content-Type': 'application/json',
                          'Authorization': f'Bearer {DEEPSEEK_API_KEY}'})
    try:
        resp = urlopen(req, timeout=30)
        data = json.loads(resp.read().decode())
        return data['choices'][0]['message']['content']
    except Exception as e:
        print(f"[digest] DeepSeek error: {e}")
        return None


def _collect(db, since):
    """Everything in the window, each row with the arrival it came from."""
    def rows(sql, args=()):
        try:
            return db.execute(sql, args).fetchall()
        except sqlite3.Error:
            return []

    items = {'wa': [], 'email': [], 'tasks': [], 'escalations': []}
    for m in rows(
        """SELECT id, source_phone, sender_phone, sender_name, text FROM messages
           WHERE received_at >= ? ORDER BY timestamp DESC""", (since,)):
        items['wa'].append((('whatsapp', m['source_phone'] or '', m['id']), m))
    for e in rows(
        """SELECT account_id, message_id, from_addr, from_name, subject
           FROM email_messages WHERE received_at >= ?
           ORDER BY received_at DESC""", (since,)):
        items['email'].append((('email', e['account_id'] or '', e['message_id'] or ''), e))
    for t in rows(
        """SELECT source_phone, source_msg_id, description, priority, due_date
           FROM wa_tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50"""):
        items['tasks'].append((('whatsapp', t['source_phone'] or '', t['source_msg_id'] or ''), t))
    for t in rows(
        """SELECT t.account_id, m.message_id, t.description, t.priority, t.due_date
           FROM email_tasks t LEFT JOIN email_messages m ON m.id = t.source_email_id
           WHERE t.status = 'pending' ORDER BY t.created_at DESC LIMIT 50"""):
        items['tasks'].append((('email', t['account_id'] or '', t['message_id'] or ''), t))
    for x in rows(
        """SELECT e.channel, e.source_phone, e.source_msg_id, m.message_id,
                  e.sender_phone, e.sender_email, e.reason, e.summary, e.status
           FROM escalations e LEFT JOIN email_messages m
             ON e.channel = 'email' AND m.id = e.source_msg_id
           WHERE e.created_at >= ? ORDER BY e.created_at DESC""", (since,)):
        channel = x['channel'] or 'whatsapp'
        external = (x['message_id'] if channel == 'email' else None) or x['source_msg_id'] or ''
        items['escalations'].append(((channel, x['source_phone'] or '', external), x))
    return items


def _by_person(items):
    """``(owner, [(person, items)])``: one bucket per person, only their items.

    ``owner`` is ``None`` on a single-user install, where one bucket holds
    everything and goes to the box chat as before.
    """
    from shared import owner_routing

    arrivals = [a for group in items.values() for a, _ in group]
    owner, people = owner_routing.resolve_people(arrivals)
    if owner is None:
        return None, [(None, {k: [r for _, r in v] for k, v in items.items()})]
    buckets = {}
    for kind, group in items.items():
        for arrival, row in group:
            for person in people.get(arrival) or []:
                entry = buckets.setdefault(
                    person.user_id, (person, {k: [] for k in items}))
                entry[1][kind].append(row)
    return owner, list(buckets.values())


def _compose(mine, now, pending_merges):
    """The digest text for one person's items; ``None`` when there is nothing."""
    wa, emails, tasks, escalations = (
        mine['wa'], mine['email'], mine['tasks'], mine['escalations'])
    if not wa and not emails and not tasks:
        return None
    wa_senders = Counter((m['sender_phone'], m['sender_name']) for m in wa if m['sender_phone'])
    email_senders = Counter((e['from_addr'], e['from_name']) for e in emails)
    context_parts = [
        f"Time period: Last {DIGEST_INTERVAL_MIN} minutes",
        f"Total messages: {len(wa) + len(emails)} (WhatsApp: {len(wa)}, Email: {len(emails)})",
    ]
    if wa:
        context_parts.append("\n--- WHATSAPP ---")
        context_parts.append("Top senders:")
        for (phone, name), cnt in wa_senders.most_common(5):
            context_parts.append(f"  - {name or phone}: {cnt} msgs")
        sample = [m for m in wa if m['text']][:5]
        if sample:
            context_parts.append("Recent messages:")
            for m in sample:
                context_parts.append(f"  - {m['sender_name'] or 'Unknown'}: {(m['text'] or '')[:80]}")
    if emails:
        context_parts.append("\n--- EMAIL ---")
        context_parts.append("Top senders:")
        for (addr, name), cnt in email_senders.most_common(5):
            context_parts.append(f"  - {name or addr}: {cnt} emails")
        sample = [e for e in emails if e['subject'] is not None][:5]
        if sample:
            context_parts.append("Recent emails:")
            for e in sample:
                context_parts.append(f"  - {e['from_name'] or 'Unknown'}: {e['subject']}")
    if tasks:
        context_parts.append(f"\n--- PENDING TASKS ({len(tasks)}) ---")
        for t in tasks[:5]:
            context_parts.append(f"  - [{t['priority']}] {t['description']} (due: {t['due_date'] or 'none'})")
    if escalations:
        context_parts.append(f"\n--- ESCALATIONS ({len(escalations)}) ---")
        for e in escalations:
            tag = 'Email' if e['channel'] == 'email' else 'WA'
            context_parts.append(f"  - [{tag}] {e['reason']}: {(e['summary'] or '')[:80]} [{e['status']}]")

    prompt = "\n".join(context_parts)
    prompt += "\n\nGenerate a brief hourly digest summary (4-6 bullet points max). Group by channel if both have activity. Focus on what needs attention."
    summary = call_deepseek(prompt)
    if not summary:
        parts = []
        if wa:
            parts.append(f"WhatsApp: {len(wa)} messages")
        if emails:
            parts.append(f"Email: {len(emails)} emails")
        if tasks:
            parts.append(f"{len(tasks)} pending task(s)")
        summary = " | ".join(parts) if parts else "No significant activity"

    digest_msg = (
        f"\U0001f4cb <b>Hourly Digest</b>\n"
        f"<i>{now.strftime('%H:%M UTC')} | WA: {len(wa)} msgs, Email: {len(emails)} emails</i>\n\n"
        f"{_esc(summary)}"
    )
    if pending_merges > 0:
        digest_msg += f"\n\n\U0001f517 {pending_merges} pending contact merge suggestion(s)"
    return digest_msg, summary


def generate_digest():
    """An hourly digest of WhatsApp + Email activity, one per person (FG-38 P3).

    Each person gets only the messages, tasks and escalations that arrived as
    theirs, on their own Telegram or in their agent-home notifications.
    """
    from shared import owner_routing

    db = get_db()
    now = datetime.now(timezone.utc)
    since = (now - timedelta(minutes=DIGEST_INTERVAL_MIN)).isoformat()
    try:
        items = _collect(db, since)
        try:
            owner, buckets = _by_person(items)
        except owner_routing.LookupUnavailable as e:
            print(f"[digest] Whose items these are is unknown, skipping this round: {e}")
            return
        try:
            pending_merges = db.execute(
                "SELECT COUNT(*) FROM contact_merge_suggestions WHERE status = 'pending'"
            ).fetchone()[0]
        except sqlite3.Error:
            pending_merges = 0
        sent = 0
        for person, mine in buckets:
            is_owner = owner is None or person.user_id == owner.user_id
            composed = _compose(mine, now, pending_merges if is_owner else 0)
            if composed is None:
                continue
            digest_msg, summary = composed
            if person is None:
                told = send_telegram(digest_msg, parse_mode='HTML')
            else:
                told = owner_routing.deliver(
                    person, owner, digest_msg,
                    send=send_telegram,
                    title="Hourly digest",
                    dedupe_key=f"digest:{person.user_id}:{now.strftime('%Y%m%d%H%M')}",
                )
            if not told:
                continue
            sent += 1
            scope = 'all' if person is None else person.user_id
            wa_tasks = sum(1 for t in mine['tasks'] if 'source_msg_id' in t.keys())
            for sql, args in (
                ("""INSERT INTO wa_digests (id, scope, content, message_count, task_count, sent_at, channel)
                    VALUES (?, ?, ?, ?, ?, ?, 'telegram')""",
                 (str(uuid.uuid4()), scope, summary, len(mine['wa']), wa_tasks, now.isoformat())),
                ("""INSERT INTO email_digests (id, scope, content, email_count, task_count, sent_at, channel)
                    VALUES (?, ?, ?, ?, ?, ?, 'telegram')""",
                 (str(uuid.uuid4()), scope, summary, len(mine['email']),
                  len(mine['tasks']) - wa_tasks, now.isoformat())),
            ):
                try:
                    db.execute(sql, args)
                except sqlite3.Error:
                    pass
        db.commit()
        if not sent:
            print(f"[digest] No activity in last {DIGEST_INTERVAL_MIN}min, skipping digest")
        else:
            print(f"[digest] Sent {sent} digest(s)")
    finally:
        db.close()


def main():
    print(f"[digest] Starting unified digest (WhatsApp + Email, interval: {DIGEST_INTERVAL_MIN}min)")

    while True:
        try:
            generate_digest()
        except Exception as e:
            print(f"[digest] Error: {e}")
            import traceback
            traceback.print_exc()

        time.sleep(DIGEST_INTERVAL_MIN * 60)


if __name__ == '__main__':
    main()
