#!/usr/bin/env python3
"""
Google Calendar Poller for Hermes Agent

Polls multiple Google Calendar accounts via the Calendar API.
Uses incremental sync (syncToken) to fetch only changed events.
Stores events, attendees, and schedules reminders in SQLite.
"""

import json
import os
import sqlite3
import sys
import time
import uuid
import re
import traceback
import threading
from collections import namedtuple
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

# The sibling pollers do the same: it puts custom/ on the path so
# `shared.inbound_registration` resolves. Without it the Inbox mirror below
# fails its import and every synced event stops at SQLite.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

DB_PATH = os.environ.get('CALENDAR_DB_PATH', '/opt/data/calendar/calendar_data.db')
CONFIG_PATH = os.environ.get('CALENDAR_CONFIG_PATH', '/opt/data/calendar/config.json')
HEALTH_PORT = int(os.environ.get('CALENDAR_HEALTH_PORT', '7903'))

import google_oauth

#: Calendar consent is the one scope this poller needs; entries without it
#: are refused by the shared helper.
CALENDAR_SCOPE = google_oauth.CALENDAR_SCOPE

TOKEN_URL = 'https://oauth2.googleapis.com/token'
CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3'

# Default reminder lead times by importance (minutes before event)
DEFAULT_REMINDERS = {
    'critical': [1440, 60, 15],
    'normal': [60, 15],
    'low': [15],
}

#: One account's OAuth material (client pair + refresh token + store identity).
GoogleCredentials = google_oauth.GoogleCredentials


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def load_config():
    """Load calendar config. Falls back to env-var-based defaults if no config file."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return {}


def get_access_token(account_id, credentials):
    """A valid access token for the account; caching + refresh live in the helper."""
    return google_oauth.get_access_token(credentials)


def gcal_api(access_token, path, params=None):
    """Make a Google Calendar API request."""
    url = f'{CALENDAR_API_BASE}{path}'
    if params:
        url += '?' + urlencode(params)

    req = Request(url)
    req.add_header('Authorization', f'Bearer {access_token}')
    req.add_header('Accept', 'application/json')

    try:
        with urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        body = e.read().decode()
        print(f"[calendar] API error {e.code}: {body}")
        raise


def extract_conference_link(event):
    """Extract video conference link from event data."""
    # Check conferenceData first (structured)
    conf_data = event.get('conferenceData', {})
    for entry_point in conf_data.get('entryPoints', []):
        if entry_point.get('entryPointType') == 'video':
            return entry_point.get('uri', '')

    # Check hangoutLink
    hangout = event.get('hangoutLink', '')
    if hangout:
        return hangout

    # Check description and location for Zoom/Teams/Meet links
    text = (event.get('description', '') or '') + ' ' + (event.get('location', '') or '')
    patterns = [
        r'https?://[a-z0-9]+\.zoom\.us/j/\S+',
        r'https?://meet\.google\.com/\S+',
        r'https?://teams\.microsoft\.com/\S+',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(0)

    return ''


def parse_event_time(event):
    """Parse event start/end times. Returns (start_iso, end_iso, all_day, tz)."""
    start = event.get('start', {})
    end = event.get('end', {})

    if 'date' in start:
        # All-day event
        return start['date'], end.get('date', start['date']), True, start.get('timeZone', '')
    else:
        return (
            start.get('dateTime', ''),
            end.get('dateTime', ''),
            False,
            start.get('timeZone', '')
        )


def sync_events(db, account_id, credentials, calendar_id='primary'):
    """Sync events from a single calendar using incremental sync."""
    access_token = get_access_token(account_id, credentials)
    now = datetime.now(timezone.utc)

    # Get existing sync token + last-pass watermark
    account = db.execute(
        "SELECT sync_token, last_synced FROM calendar_accounts WHERE id = ?",
        (account_id,)
    ).fetchone()

    sync_token = account['sync_token'] if account else None
    last_synced = None
    if account and account['last_synced']:
        try:
            last_synced = datetime.fromisoformat(account['last_synced'])
            if last_synced.tzinfo is None:
                last_synced = last_synced.replace(tzinfo=timezone.utc)
        except ValueError:
            last_synced = None

    all_events = []
    page_token = None
    new_sync_token = None

    # Google rejects a pageToken whose request does not repeat the query it
    # was issued for ("Invalid page token value"), so the window is built once
    # and every page reuses it — a calendar with more than one page of events
    # used to fail on page two and sync nothing.
    # showDeleted surfaces cancelled/deleted events as status='cancelled'
    # items so the DB marks them — without it they silently vanish from the
    # response and stale 'confirmed' rows persist forever.
    base_params = {'maxResults': 250, 'singleEvents': True, 'showDeleted': True}
    if sync_token:
        # syncToken responses carry deletion tombstones already; it can't be
        # combined with an explicit showDeleted (nor several other filters).
        base_params['syncToken'] = sync_token
        base_params.pop('showDeleted', None)
    elif last_synced and (now - last_synced) < timedelta(days=7):
        # Delta sync via updatedMin. Google never returns nextSyncToken for the
        # timeMax'd full-window request below, so sync_token stays NULL forever
        # and every pass reprocessed the entire calendar (~90% CPU). updatedMin
        # keeps singleEvents expansion but returns only events modified since
        # the last pass — a steady-state poll sees ~0 items. The 5min overlap
        # covers clock skew between our write and Google's `updated` stamps.
        base_params['updatedMin'] = (
            last_synced - timedelta(minutes=5)
        ).isoformat()
    else:
        # Full sync: get events from 30 days ago to 365 days ahead. Also the
        # weekly safety net — catches permanent deletions a delta can't see.
        base_params['timeMin'] = (now - timedelta(days=30)).isoformat()
        base_params['timeMax'] = (now + timedelta(days=365)).isoformat()
        base_params['orderBy'] = 'startTime'

    while True:
        params = dict(base_params)
        if page_token:
            params['pageToken'] = page_token

        try:
            result = gcal_api(access_token, f'/calendars/{calendar_id}/events', params)
        except HTTPError as e:
            if e.code == 410:
                # Sync token expired — do a full sync
                print(f"[calendar] Sync token expired for {account_id}, doing full sync")
                db.execute(
                    "UPDATE calendar_accounts SET sync_token = NULL WHERE id = ?",
                    (account_id,)
                )
                db.commit()
                return sync_events(db, account_id, credentials, calendar_id)
            raise

        items = result.get('items', [])
        all_events.extend(items)

        page_token = result.get('nextPageToken')
        if not page_token:
            new_sync_token = result.get('nextSyncToken')
            break

    # Process events
    created = 0
    updated = 0
    cancelled = 0

    for event in all_events:
        google_event_id = event.get('id', '')
        status = event.get('status', 'confirmed')
        raw = json.dumps(event, sort_keys=True)

        if status == 'cancelled':
            # Mark as cancelled in DB — skip rows already cancelled so a
            # full resync doesn't rewrite (and recount) them every pass.
            rows = db.execute(
                """UPDATE calendar_events SET status = 'cancelled', updated_at = ?
                   WHERE google_event_id = ? AND account_id = ? AND status != 'cancelled'""",
                (now.isoformat(), google_event_id, account_id)
            ).rowcount
            if rows > 0:
                cancelled += 1
            continue

        start_time, end_time, all_day, tz = parse_event_time(event)
        conference_link = extract_conference_link(event)
        organizer = event.get('organizer', {})

        # Check if event already exists — and whether the payload changed.
        # An unchanged event must not run the per-event work below: during a
        # full resync (weekly safety net) ~770 identical events would each pay
        # an UPDATE + register_item (fresh event loop + Postgres connect) +
        # sync_attendees — that per-event cost is what burned ~90% CPU.
        existing = db.execute(
            "SELECT id, status, raw_json FROM calendar_events WHERE google_event_id = ? AND account_id = ?",
            (google_event_id, account_id)
        ).fetchone()

        if existing and existing['raw_json'] == raw and existing['status'] == status:
            continue

        event_id = existing['id'] if existing else str(uuid.uuid4())

        if existing:
            # Update existing event
            db.execute(
                """UPDATE calendar_events SET
                    summary = ?, description = ?, location = ?,
                    start_time = ?, end_time = ?, all_day = ?, timezone = ?,
                    status = ?, organizer_email = ?, organizer_name = ?,
                    recurring_event_id = ?, html_link = ?, conference_link = ?,
                    raw_json = ?, updated_at = ?
                   WHERE id = ?""",
                (
                    event.get('summary', ''),
                    event.get('description', ''),
                    event.get('location', ''),
                    start_time, end_time, int(all_day), tz,
                    status,
                    organizer.get('email', ''),
                    organizer.get('displayName', ''),
                    event.get('recurringEventId', ''),
                    event.get('htmlLink', ''),
                    conference_link,
                    raw,
                    now.isoformat(),
                    event_id
                )
            )
            updated += 1
        else:
            # Insert new event
            db.execute(
                """INSERT INTO calendar_events
                   (id, google_event_id, account_id, calendar_id,
                    summary, description, location,
                    start_time, end_time, all_day, timezone,
                    status, organizer_email, organizer_name,
                    recurring_event_id, html_link, conference_link,
                    raw_json, triaged, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                (
                    event_id, google_event_id, account_id, calendar_id,
                    event.get('summary', ''),
                    event.get('description', ''),
                    event.get('location', ''),
                    start_time, end_time, int(all_day), tz,
                    status,
                    organizer.get('email', ''),
                    organizer.get('displayName', ''),
                    event.get('recurringEventId', ''),
                    event.get('htmlLink', ''),
                    conference_link,
                    raw,
                    now.isoformat(), now.isoformat()
                )
            )
            created += 1

        # Mirror into the shared inbound registry, on both the create and the
        # update branch: the upsert keys on the Google event id, so a
        # rescheduled meeting moves in the Inbox instead of appearing twice.
        try:
            from shared.inbound_registration import register_item
            register_item(
                surface='calendar',
                external_id=google_event_id,
                account_id=account_id,
                kind='event',
                conversation=event.get('recurringEventId') or google_event_id,
                conversation_name=calendar_id,
                sender_id=organizer.get('email', ''),
                sender_name=organizer.get('displayName', ''),
                subject=event.get('summary', ''),
                body=event.get('description', '') or '',
                occurred_at=start_time,
                ends_at=end_time,
                metadata={
                    'location': event.get('location', ''),
                    'html_link': event.get('htmlLink', ''),
                    'conference_link': conference_link,
                    'status': status,
                    'all_day': bool(all_day),
                },
            )
        except ImportError:
            pass
        except Exception as e:
            print(f"[calendar] Inbound registration failed for {google_event_id}: {e}")

        # Sync attendees
        sync_attendees(db, event_id, event.get('attendees', []))

    # Persist the watermark every pass — last_synced is what makes the next
    # poll a cheap updatedMin delta. sync_token only when Google issued one.
    if new_sync_token:
        db.execute(
            "UPDATE calendar_accounts SET sync_token = ?, last_synced = ? WHERE id = ?",
            (new_sync_token, now.isoformat(), account_id)
        )
    else:
        db.execute(
            "UPDATE calendar_accounts SET last_synced = ? WHERE id = ?",
            (now.isoformat(), account_id)
        )

    db.commit()
    return created, updated, cancelled


def sync_attendees(db, event_id, attendees):
    """Sync attendees for a calendar event."""
    # Remove existing attendees
    db.execute("DELETE FROM calendar_attendees WHERE event_id = ?", (event_id,))

    for attendee in attendees:
        db.execute(
            """INSERT INTO calendar_attendees
               (id, event_id, email, display_name, response_status, organizer, self)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                str(uuid.uuid4()),
                event_id,
                attendee.get('email', ''),
                attendee.get('displayName', ''),
                attendee.get('responseStatus', 'needsAction'),
                int(attendee.get('organizer', False)),
                int(attendee.get('self', False)),
            )
        )


def credentials_for_account(account, account_config):
    """Resolve one account's OAuth material, or ``None`` if it has none.

    The unified credential store is the source (an entry must opt the account
    into the ``calendar`` service); until PR5 the helper also falls back to
    the legacy per-account workspace files.
    """
    creds = google_oauth.credentials_for_email(
        'calendar', account['email'], required_scope=CALENDAR_SCOPE
    )
    if creds:
        return creds
    print(
        f"[calendar] {account['id']} ({account['email']}): no credential-store "
        "entry with the calendar service"
    )
    return None


def poll_all_accounts(db, config):
    """Poll all enabled calendar accounts."""
    accounts = db.execute(
        "SELECT * FROM calendar_accounts WHERE enabled = 1"
    ).fetchall()

    cal_config = config.get('calendar', {})
    account_configs = {a['id']: a for a in cal_config.get('accounts', [])}

    total_created = 0
    total_updated = 0
    total_cancelled = 0

    for account in accounts:
        acc_config = account_configs.get(account['id'], {})
        credentials = credentials_for_account(account, acc_config)

        if not credentials:
            print(
                f"[calendar] Skipping {account['id']} ({account['email']}): no "
                "credential-store entry with the calendar service"
            )
            continue

        calendars = acc_config.get('calendars', ['primary'])
        for cal_id in calendars:
            try:
                created, updated, cancelled = sync_events(
                    db, account['id'], credentials, cal_id
                )
                total_created += created
                total_updated += updated
                total_cancelled += cancelled

                if created or updated or cancelled:
                    print(f"[calendar] {account['email']}/{cal_id}: "
                          f"+{created} new, ~{updated} updated, -{cancelled} cancelled")
            except Exception as e:
                print(f"[calendar] Error syncing {account['email']}/{cal_id}: {e}")
                traceback.print_exc()

    return total_created, total_updated, total_cancelled


class HealthHandler(BaseHTTPRequestHandler):
    """Health check endpoint."""
    poll_count = 0
    last_poll = None
    last_error = None

    def do_GET(self):
        if self.path == '/health':
            status = {
                'status': 'ok',
                'service': 'calendar-poller',
                'poll_count': HealthHandler.poll_count,
                'last_poll': HealthHandler.last_poll,
                'last_error': HealthHandler.last_error,
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(status).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def start_health_server():
    """Start health check HTTP server in a background thread."""
    server = HTTPServer((os.environ.get('CALENDAR_HEALTH_HOST', '127.0.0.1'), HEALTH_PORT), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"[calendar] Health check: http://localhost:{HEALTH_PORT}/health")


def main():
    config = load_config()
    poll_interval = config.get('calendar', {}).get('poll_interval_seconds', 60)

    start_health_server()
    print(f"[calendar] Starting calendar poller (interval: {poll_interval}s)")

    while True:
        try:
            db = get_db()
            created, updated, cancelled = poll_all_accounts(db, config)
            db.close()

            HealthHandler.poll_count += 1
            HealthHandler.last_poll = datetime.now(timezone.utc).isoformat()
            HealthHandler.last_error = None

            if created or updated or cancelled:
                print(f"[calendar] Poll #{HealthHandler.poll_count}: "
                      f"+{created} new, ~{updated} updated, -{cancelled} cancelled")

        except Exception as e:
            HealthHandler.last_error = str(e)
            print(f"[calendar] Poll error: {e}")
            traceback.print_exc()

        time.sleep(poll_interval)


if __name__ == '__main__':
    main()
