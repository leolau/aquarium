#!/usr/bin/env python3
"""
WhatsApp Unified Batcher

Polls both Bridge A (port 3000) and Bridge B (port 3001) for messages.
- Writes raw messages to SQLite immediately
- Groups messages by sender+source_phone with 5s debounce window
- Emits completed batches as JSON files for downstream triage
- Updates contacts table
"""

import json
import mimetypes
import os
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# Make custom/shared importable so the batcher can register media files.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Paths
CONFIG_PATH = '/opt/data/whatsapp-messages/config.json'
DB_PATH = os.environ.get('MESSAGING_DB_PATH', '/opt/data/whatsapp-messages/messaging_data.db')
MEDIA_DIR = '/opt/data/whatsapp-messages/media'
BATCH_OUTPUT_DIR = '/opt/data/whatsapp-messages/batches'

# Load config
def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)

config = load_config()
BATCH_WINDOW_SEC = config.get('batching', {}).get('window_seconds', 5)
# The bridge's GET /messages drains its queue and answers immediately, so the
# poll loop must pace itself or it spins at the bridge's response rate.
POLL_INTERVAL_SEC = config.get('batching', {}).get('poll_interval_seconds', 1.0)

# Ensure directories
os.makedirs(MEDIA_DIR, exist_ok=True)
os.makedirs(BATCH_OUTPUT_DIR, exist_ok=True)

# Family contacts set for quick lookup
FAMILY_PHONES = set(
    c['phone'] for c in config.get('escalation', {}).get('criteria', {}).get('family_contacts', [])
)

# SQLite connection (per-thread)
_local = threading.local()

def get_db():
    if not hasattr(_local, 'conn'):
        _local.conn = sqlite3.connect(DB_PATH, timeout=10)
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA busy_timeout=5000")
    return _local.conn

# Batching state
_batch_lock = threading.Lock()
_pending_batches = {}  # key: "sender_phone:source_phone" -> { batch_id, messages, timer, ... }


def extract_sender_phone(msg):
    """Extract sender phone from WhatsApp message.
    
    Handles both the bridge's normalized format (senderId, chatId)
    and raw Baileys format (key.remoteJid, key.participant).
    """
    # Bridge normalized format
    sender_id = msg.get('senderId', '')
    if sender_id:
        match = sender_id.split('@')[0] if '@' in sender_id else sender_id
        digits = ''.join(c for c in match if c.isdigit())
        return f'+{digits}' if digits else sender_id

    # Raw Baileys format fallback
    key = msg.get('key', {})
    remote_jid = key.get('remoteJid', '')
    
    if '@g.us' in remote_jid:
        participant = key.get('participant', '') or msg.get('participant', '') or remote_jid
        match = participant.split('@')[0] if '@' in participant else participant
    else:
        match = remote_jid.split('@')[0] if '@' in remote_jid else remote_jid
    
    digits = ''.join(c for c in match if c.isdigit())
    return f'+{digits}' if digits else remote_jid


def extract_chat_id(msg):
    return msg.get('chatId', '') or msg.get('key', {}).get('remoteJid', '')


def is_group_message(msg):
    # Bridge normalized format
    if 'isGroup' in msg:
        return bool(msg['isGroup'])
    # Raw Baileys format fallback
    jid = msg.get('key', {}).get('remoteJid', '')
    return '@g.us' in jid


def extract_text(msg):
    # Bridge normalized format
    body = msg.get('body', '')
    if body:
        return body

    # Raw Baileys format fallback
    m = msg.get('message', {})
    if not m:
        return ''
    return (
        m.get('conversation', '') or
        (m.get('extendedTextMessage', {}) or {}).get('text', '') or
        (m.get('imageMessage', {}) or {}).get('caption', '') or
        (m.get('videoMessage', {}) or {}).get('caption', '') or
        (m.get('documentMessage', {}) or {}).get('fileName', '') or
        ''
    )


def extract_media_info(msg):
    # Bridge normalized format
    if msg.get('hasMedia'):
        media_type = msg.get('mediaType', '') or None
        return media_type, None

    # Raw Baileys format fallback
    m = msg.get('message', {})
    if not m:
        return None, None
    for mtype, key in [('image', 'imageMessage'), ('video', 'videoMessage'),
                       ('audio', 'audioMessage'), ('document', 'documentMessage'),
                       ('sticker', 'stickerMessage')]:
        if key in m:
            return mtype, (m[key] or {}).get('mimetype')
    return None, None


def get_sender_name(msg):
    return msg.get('senderName') or msg.get('pushName') or msg.get('verifiedBizName') or None


def _media_filename(msg, msg_id, media_type, mimetype):
    """Derive a reasonable filename for a WhatsApp media file."""
    # Try to get the original filename for documents.
    msg_obj = (msg.get('message', msg) if isinstance(msg, dict) else {}) or {}
    doc = msg_obj.get('documentMessage') or {}
    if doc.get('fileName'):
        return doc['fileName']
    ext = mimetypes.guess_extension(mimetype or '') or ''
    if not ext:
        ext_map = {'image': '.jpg', 'video': '.mp4', 'audio': '.mp3',
                   'document': '.bin', 'sticker': '.webp'}
        ext = ext_map.get(media_type or '', '.bin')
    return f"{media_type or 'media'}_{msg_id}{ext}"


def download_media(bridge_port, msg_id):
    """Download media bytes from the bridge.

    Tries ``GET http://localhost:{port}/media/{messageId}``.
    Returns ``(data, content_type)`` or ``(None, None)`` on failure.
    """
    url = f"http://localhost:{bridge_port}/media/{msg_id}"
    try:
        resp = urlopen(url, timeout=30)
        data = resp.read()
        content_type = resp.headers.get('Content-Type', 'application/octet-stream')
        return data, content_type
    except Exception:
        return None, None


def _save_and_register_media(media_data, filename, content_type, msg_id,
                             media_path, db, source_phone, chat_id,
                             sender_phone, sender_name, timestamp,
                             inbound_item_id=None):
    """Save media bytes to MEDIA_DIR, update DB, and register in file registry."""
    try:
        with open(media_path, 'wb') as f:
            f.write(media_data)
        db.execute(
            "UPDATE messages SET media_path = ? WHERE id = ?",
            (media_path, msg_id),
        )
        db.commit()
    except Exception as e:
        print(f"[batcher] Error saving media for {msg_id}: {e}")
        return

    # Register in the file registry (Supabase + file_assets table).
    try:
        from shared.file_registration import register_file
        registered = register_file(
            media_data,
            surface='whatsapp',
            filename=filename,
            content_type=content_type,
            account_id=source_phone,
            conversation=chat_id,
            sender_id=sender_phone,
            sender_name=sender_name or '',
            message_id=msg_id,
            received_at=datetime.fromisoformat(timestamp) if timestamp else None,
            inbound_item_id=inbound_item_id,
        )
        if registered:
            print(f"[batcher] Registered media file: {filename}")
    except ImportError:
        pass  # shared.file_registration not available
    except Exception as e:
        print(f"[batcher] File registration failed for {msg_id}: {e}")


def _epoch_seconds(ts):
    """Unix seconds from a bridge timestamp, or None.

    Baileys hands some messages (e.g. ones the phone re-sent after a failed
    decrypt) a protobuf Long, which serialises as ``{"low", "high", "unsigned"}``.
    """
    if isinstance(ts, dict):
        try:
            low = int(ts.get('low', 0)) & 0xFFFFFFFF
            high = int(ts.get('high', 0))
        except (TypeError, ValueError):
            return None
        if ts.get('unsigned'):
            high &= 0xFFFFFFFF
        return (high << 32) | low
    try:
        return int(ts) if ts else None
    except (TypeError, ValueError):
        return None


def process_message(msg, source_phone, bridge_port=None):
    """Process a single message: write to DB, download media, add to batch."""
    msg_id = msg.get('messageId') or msg.get('key', {}).get('id') or str(uuid.uuid4())
    sender_phone = extract_sender_phone(msg)
    sender_name = get_sender_name(msg)
    chat_id = extract_chat_id(msg)
    is_group = 1 if is_group_message(msg) else 0
    text = extract_text(msg)
    media_type, media_mimetype = extract_media_info(msg)
    
    ts = _epoch_seconds(msg.get('timestamp') or msg.get('messageTimestamp'))
    try:
        timestamp = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        timestamp = datetime.now(timezone.utc).isoformat()
    
    now = datetime.now(timezone.utc).isoformat()
    
    # Write to SQLite immediately
    db = get_db()
    try:
        inserted = db.execute(
            """INSERT OR IGNORE INTO messages 
               (id, source_phone, sender_phone, sender_name, chat_id, is_group, 
                text, media_type, media_path, media_mimetype, timestamp, received_at, batch_id, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (msg_id, source_phone, sender_phone, sender_name, chat_id, is_group,
             text or None, media_type, None, media_mimetype, timestamp, now, None,
             json.dumps(msg))
        )
        db.commit()
        if inserted.rowcount == 0:
            return  # duplicate: OR IGNORE skips it instead of raising
    except sqlite3.IntegrityError:
        return  # duplicate
    except Exception as e:
        print(f"[batcher] DB insert error: {e}")
        return

    # Mirror the message into the shared inbound registry so it reaches the
    # Inbox. After the duplicate early-return above, so a re-delivered message
    # does not re-register; best-effort, so a Postgres blip never costs us the
    # message that SQLite has already accepted.
    inbound_item_id = None
    try:
        from shared.inbound_registration import register_item
        inbound_item_id = register_item(
            surface='whatsapp',
            external_id=msg_id,
            account_id=source_phone,
            conversation=chat_id,
            sender_id=sender_phone,
            sender_name=sender_name or '',
            body=text or '',
            occurred_at=timestamp,
            has_attachments=bool(media_type),
            metadata={'is_group': bool(is_group), 'media_type': media_type},
        )
    except ImportError:
        pass  # shared.inbound_registration not available
    except Exception as e:
        print(f"[batcher] Inbound registration failed for {msg_id}: {e}")

    # Download media from the bridge and register in the file registry.
    # Best-effort: a failed download or registration never blocks
    # message processing.
    #
    # The bridge pre-downloads media via Baileys' downloadMediaMessage() and
    # provides local file paths in the ``mediaUrls`` field on each message.
    # Use those directly instead of trying the non-existent GET /media/{id}
    # endpoint.  Fall back to the legacy HTTP download for bridges that don't
    # pre-download.
    if media_type and bridge_port:
        media_urls = msg.get('mediaUrls') or []
        if media_urls:
            for media_url in media_urls:
                if not os.path.exists(media_url):
                    print(f"[batcher] Media file not found on disk: {media_url}")
                    continue
                try:
                    with open(media_url, 'rb') as f:
                        media_data = f.read()
                except Exception as e:
                    print(f"[batcher] Error reading media file {media_url}: {e}")
                    continue
                media_ct = mimetypes.guess_type(media_url)[0] or 'application/octet-stream'
                filename = os.path.basename(media_url)
                media_path = os.path.join(MEDIA_DIR, filename)
                _save_and_register_media(
                    media_data, filename,
                    media_mimetype or media_ct or 'application/octet-stream',
                    msg_id, media_path, db, source_phone, chat_id,
                    sender_phone, sender_name, timestamp, inbound_item_id,
                )
        else:
            # Fallback: try the bridge's /media/{id} endpoint.
            media_data, media_ct = download_media(bridge_port, msg_id)
            if media_data:
                filename = _media_filename(msg, msg_id, media_type, media_mimetype or media_ct)
                media_path = os.path.join(MEDIA_DIR, filename)
                _save_and_register_media(
                    media_data, filename,
                    media_mimetype or media_ct or 'application/octet-stream',
                    msg_id, media_path, db, source_phone, chat_id,
                    sender_phone, sender_name, timestamp, inbound_item_id,
                )
            else:
                print(f"[batcher] Could not download media for {msg_id} (bridge has no mediaUrls and /media endpoint unavailable)")

    # Update contact
    try:
        db.execute(
            """INSERT INTO contacts (phone, name, is_family, first_seen, last_seen, message_count)
               VALUES (?, ?, ?, ?, ?, 1)
               ON CONFLICT(phone) DO UPDATE SET
                 name = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE contacts.name END,
                 last_seen = ?,
                 message_count = contacts.message_count + 1""",
            (sender_phone, sender_name, 1 if sender_phone in FAMILY_PHONES else 0,
             now, now,
             sender_name, sender_name, sender_name, now)
        )
        db.commit()
    except Exception:
        pass
    
    # Add to batch
    batch_key = f"{sender_phone}:{source_phone}"
    with _batch_lock:
        if batch_key in _pending_batches:
            batch = _pending_batches[batch_key]
            batch['messages'].append({
                'msg_id': msg_id, 'text': text, 'media_type': media_type,
                'timestamp': timestamp, 'sender_name': sender_name,
                'chat_id': chat_id, 'is_group': is_group
            })
            # Cancel old timer, start new one
            if batch.get('timer'):
                batch['timer'].cancel()
            batch['timer'] = threading.Timer(BATCH_WINDOW_SEC, flush_batch, args=[batch_key])
            batch['timer'].daemon = True
            batch['timer'].start()
        else:
            batch_id = str(uuid.uuid4())
            timer = threading.Timer(BATCH_WINDOW_SEC, flush_batch, args=[batch_key])
            timer.daemon = True
            timer.start()
            _pending_batches[batch_key] = {
                'batch_id': batch_id,
                'sender_phone': sender_phone,
                'source_phone': source_phone,
                'messages': [{
                    'msg_id': msg_id, 'text': text, 'media_type': media_type,
                    'timestamp': timestamp, 'sender_name': sender_name,
                    'chat_id': chat_id, 'is_group': is_group
                }],
                'timer': timer,
                'started_at': now,
            }
    
    print(f"[batcher] {source_phone} <- {sender_phone}: {(text or '[media]')[:60]}")


def flush_batch(batch_key):
    """Flush a completed batch to file."""
    with _batch_lock:
        batch = _pending_batches.pop(batch_key, None)
    
    if not batch:
        return
    
    batch_record = {
        'batch_id': batch['batch_id'],
        'sender_phone': batch['sender_phone'],
        'source_phone': batch['source_phone'],
        'message_count': len(batch['messages']),
        'messages': batch['messages'],
        'started_at': batch['started_at'],
        'completed_at': datetime.now(timezone.utc).isoformat(),
        'is_family': batch['sender_phone'] in FAMILY_PHONES,
    }
    
    # Update batch_id on messages in DB
    db = get_db()
    try:
        for m in batch['messages']:
            db.execute("UPDATE messages SET batch_id = ? WHERE id = ?",
                      (batch['batch_id'], m['msg_id']))
        db.commit()
    except Exception as e:
        print(f"[batcher] Error updating batch_id: {e}")
    
    # Write batch file
    batch_file = os.path.join(BATCH_OUTPUT_DIR, f"{batch['batch_id']}.json")
    with open(batch_file, 'w') as f:
        json.dump(batch_record, f, indent=2)
    
    print(f"[batcher] Batch completed: {batch['sender_phone']} on {batch['source_phone']} "
          f"({len(batch['messages'])} msgs) -> {batch_file}")


def poll_bridge(port, source_phone):
    """Continuously poll a bridge for new messages."""
    url = f"http://localhost:{port}/messages"
    consecutive_errors = 0
    
    while True:
        try:
            resp = urlopen(url, timeout=35)
            data = json.loads(resp.read().decode())
            consecutive_errors = 0
            
            if isinstance(data, list) and len(data) > 0:
                for msg in data:
                    try:
                        process_message(msg, source_phone, bridge_port=port)
                    except Exception as e:
                        msg_id = msg.get('messageId') if isinstance(msg, dict) else None
                        print(f"[batcher] Failed to process message {msg_id} from {port}: {e!r} "
                              f"raw={json.dumps(msg, default=str)[:2000]}")
        except (URLError, TimeoutError, json.JSONDecodeError) as e:
            consecutive_errors += 1
            if consecutive_errors <= 3:
                pass  # silent on first few errors
            elif consecutive_errors % 10 == 0:
                print(f"[batcher] Bridge {port} unreachable ({consecutive_errors} errors): {e}")
            time.sleep(2)
        except Exception as e:
            print(f"[batcher] Unexpected error polling {port}: {e}")
            time.sleep(2)
        else:
            time.sleep(POLL_INTERVAL_SEC)


# Health check HTTP server
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            with _batch_lock:
                pending = len(_pending_batches)
            stats = {
                'status': 'running',
                'pending_batches': pending,
                'uptime_seconds': time.time() - START_TIME,
                'batch_window_seconds': BATCH_WINDOW_SEC,
                'phones': [{'id': p['id'], 'port': p['bridge_port']} for p in config['phones']],
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(stats).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def log_message(self, format, *args):
        pass  # suppress access logs


START_TIME = time.time()

def main():
    print(f"[batcher] Starting unified batcher (window: {BATCH_WINDOW_SEC}s)")
    
    # Mark family contacts in DB
    db = get_db()
    for fc in config.get('escalation', {}).get('criteria', {}).get('family_contacts', []):
        try:
            db.execute("UPDATE contacts SET is_family = 1, relation = ? WHERE phone = ?",
                      (fc.get('relation', ''), fc['phone']))
        except Exception:
            pass
    db.commit()
    
    # Start health server
    health_server = HTTPServer((os.environ.get('WA_BATCHER_HEALTH_HOST', '127.0.0.1'), 7900), HealthHandler)
    health_thread = threading.Thread(target=health_server.serve_forever, daemon=True)
    health_thread.start()
    print("[batcher] Health endpoint on port 7900")
    
    # Start polling threads for each enabled phone
    threads = []
    for phone in config['phones']:
        if phone.get('enabled', True):
            t = threading.Thread(
                target=poll_bridge,
                args=(phone['bridge_port'], phone['id']),
                daemon=True,
                name=f"poll-{phone['id']}"
            )
            t.start()
            threads.append(t)
            print(f"[batcher] Polling Bridge ({phone['id']}) on port {phone['bridge_port']}")
    
    # Keep main thread alive
    try:
        while True:
            time.sleep(60)
            # Periodic stats
            with _batch_lock:
                pending = len(_pending_batches)
            db = get_db()
            msg_count = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            print(f"[batcher] Stats: {msg_count} total messages, {pending} pending batches")
    except KeyboardInterrupt:
        print("[batcher] Shutting down...")


if __name__ == '__main__':
    main()
