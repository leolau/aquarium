"""Regression tests for the calendar poller's delta-sync cursor.

Production bug (2026-09-29): the full-window request (timeMin/timeMax +
singleEvents) never receives nextSyncToken from Google, so sync_token stayed
NULL forever and every 60s pass reprocessed the entire ~770-event calendar —
unconditional UPDATEs plus a register_item (fresh event loop + PG connect)
per event — ~90% CPU bursts around the clock.

The fix uses `updatedMin` (persisted `last_synced`) as the delta cursor and
skips per-event work when the stored raw_json is unchanged.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

POLLER_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "custom",
    "calendar",
    "calendar_poller.py",
)


@pytest.fixture()
def poller(monkeypatch):
    """Load calendar_poller.py as a module with OAuth + HTTP stubbed."""
    spec = importlib.util.spec_from_file_location("calendar_poller", POLLER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["calendar_poller"] = mod
    spec.loader.exec_module(mod)

    monkeypatch.setattr(mod, "get_access_token", lambda *a, **k: "tok")
    # The per-event Inbox mirror imports shared.inbound_registration lazily;
    # give it a spyable stub so tests can assert it was (not) called.
    registrations = []
    fake_shared = types.ModuleType("shared")
    fake_reg = types.ModuleType("shared.inbound_registration")
    fake_reg.register_item = lambda **kw: registrations.append(kw)
    fake_shared.inbound_registration = fake_reg
    monkeypatch.setitem(sys.modules, "shared", fake_shared)
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", fake_reg)
    attendee_calls = []
    monkeypatch.setattr(
        mod, "sync_attendees", lambda db, eid, att: attendee_calls.append(eid)
    )
    mod._test_registrations = registrations
    mod._test_attendee_calls = attendee_calls
    return mod


@pytest.fixture()
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE calendar_accounts (
            id TEXT PRIMARY KEY, email TEXT, label TEXT,
            sync_token TEXT, last_synced TEXT, enabled INTEGER DEFAULT 1
        );
        CREATE TABLE calendar_events (
            id TEXT PRIMARY KEY, google_event_id TEXT, account_id TEXT,
            calendar_id TEXT, summary TEXT, description TEXT, location TEXT,
            start_time TEXT, end_time TEXT, all_day INTEGER, timezone TEXT,
            status TEXT, organizer_email TEXT, organizer_name TEXT,
            recurring_event_id TEXT, html_link TEXT, conference_link TEXT,
            raw_json TEXT, triaged INTEGER, created_at TEXT, updated_at TEXT
        );
        """
    )
    return conn


def add_account(db, account_id="gcal1", sync_token=None, last_synced=None):
    db.execute(
        "INSERT INTO calendar_accounts (id, sync_token, last_synced) VALUES (?,?,?)",
        (account_id, sync_token, last_synced),
    )
    db.commit()


def make_event(eid="ev1", status="confirmed", summary="Standup"):
    return {
        "id": eid,
        "status": status,
        "summary": summary,
        "start": {"dateTime": "2026-10-01T09:00:00Z"},
        "end": {"dateTime": "2026-10-01T09:30:00Z"},
        "organizer": {"email": "a@b.c", "displayName": "A"},
    }


def api_capture(items, monkeypatch, mod):
    calls = []

    def fake_api(token, path, params=None):
        calls.append(dict(params or {}))
        return {"items": items}  # single page, no nextSyncToken

    monkeypatch.setattr(mod, "gcal_api", fake_api)
    return calls


class TestDeltaCursor:
    def test_updatedmin_used_when_last_synced_fresh(self, poller, db, monkeypatch):
        add_account(
            db,
            last_synced=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
        )
        calls = api_capture([make_event()], monkeypatch, poller)
        poller.sync_events(db, "gcal1", None)
        assert calls[0].get("updatedMin"), "expected updatedMin delta, got %s" % calls[0]
        assert "timeMin" not in calls[0]
        assert "syncToken" not in calls[0]
        assert calls[0]["singleEvents"] is True
        assert calls[0]["showDeleted"] is True

    def test_last_synced_persisted_without_next_sync_token(
        self, poller, db, monkeypatch
    ):
        """THE regression: the pass must save a watermark even when Google
        returns no nextSyncToken, or every subsequent poll is a full resync."""
        add_account(db)
        api_capture([make_event()], monkeypatch, poller)
        poller.sync_events(db, "gcal1", None)
        row = db.execute(
            "SELECT last_synced FROM calendar_accounts WHERE id='gcal1'"
        ).fetchone()
        assert row["last_synced"], "watermark not persisted — next pass full-resyncs"

    def test_full_window_when_last_synced_missing(self, poller, db, monkeypatch):
        add_account(db)
        calls = api_capture([], monkeypatch, poller)
        poller.sync_events(db, "gcal1", None)
        assert "timeMin" in calls[0] and "timeMax" in calls[0]
        assert "updatedMin" not in calls[0]

    def test_full_window_when_last_synced_stale(self, poller, db, monkeypatch):
        add_account(
            db,
            last_synced=(datetime.now(timezone.utc) - timedelta(days=8)).isoformat(),
        )
        calls = api_capture([], monkeypatch, poller)
        poller.sync_events(db, "gcal1", None)
        assert "timeMin" in calls[0], "stale watermark should fall back to full sync"

    def test_synctoken_path_drops_showdeleted(self, poller, db, monkeypatch):
        add_account(db, sync_token="tok123")
        calls = api_capture([], monkeypatch, poller)
        poller.sync_events(db, "gcal1", None)
        assert calls[0]["syncToken"] == "tok123"
        assert "showDeleted" not in calls[0]


class TestSkipUnchanged:
    def _seed_existing(self, db, event):
        db.execute(
            """INSERT INTO calendar_events
               (id, google_event_id, account_id, calendar_id, summary, status,
                raw_json, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                "row1", event["id"], "gcal1", "primary", event["summary"],
                event["status"], json.dumps(event, sort_keys=True),
                "2026-01-01", "2026-01-01",
            ),
        )
        db.commit()

    def test_unchanged_event_skips_writes(self, poller, db, monkeypatch):
        event = make_event()
        self._seed_existing(db, event)
        api_capture([event], monkeypatch, poller)
        created, updated, cancelled = poller.sync_events(db, "gcal1", None)
        assert (created, updated, cancelled) == (0, 0, 0)
        assert poller._test_registrations == [], "register_item ran for identical event"
        assert poller._test_attendee_calls == [], "sync_attendees ran for identical event"
        row = db.execute("SELECT updated_at FROM calendar_events").fetchone()
        assert row["updated_at"] == "2026-01-01", "unchanged event was rewritten"

    def test_changed_event_updates_and_registers(self, poller, db, monkeypatch):
        old = make_event(summary="Old title")
        self._seed_existing(db, old)
        new = dict(old, summary="New title")
        api_capture([new], monkeypatch, poller)
        created, updated, _ = poller.sync_events(db, "gcal1", None)
        assert updated == 1
        assert len(poller._test_registrations) == 1
        row = db.execute("SELECT summary FROM calendar_events").fetchone()
        assert row["summary"] == "New title"

    def test_cancelled_row_not_rewritten(self, poller, db, monkeypatch):
        event = make_event(status="cancelled")
        self._seed_existing(db, event)
        api_capture([event], monkeypatch, poller)
        _, _, cancelled = poller.sync_events(db, "gcal1", None)
        assert cancelled == 0, "already-cancelled row should not re-mark"

    def test_delta_pass_costs_nothing_when_nothing_changed(
        self, poller, db, monkeypatch
    ):
        """Steady state: updatedMin returns no items → zero per-event work."""
        add_account(
            db,
            last_synced=(datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        )
        api_capture([], monkeypatch, poller)
        created, updated, cancelled = poller.sync_events(db, "gcal1", None)
        assert (created, updated, cancelled) == (0, 0, 0)
        assert poller._test_registrations == []


class TestMirrorOnlyOnChange:
    """raw_json moves on etag / RSVP changes the Inbox never shows; those must
    still update SQLite but not re-register the event in Postgres."""

    def _sync_once(self, poller, db, monkeypatch, event):
        api_capture([event], monkeypatch, poller)
        return poller.sync_events(db, "gcal1", None)

    def test_new_event_registers(self, poller, db, monkeypatch):
        add_account(db)
        self._sync_once(poller, db, monkeypatch, make_event())
        assert len(poller._test_registrations) == 1

    def test_rsvp_only_change_updates_without_registering(
        self, poller, db, monkeypatch
    ):
        add_account(db)
        event = make_event()
        self._sync_once(poller, db, monkeypatch, event)
        poller._test_registrations.clear()

        rsvp = dict(
            event,
            etag='"2"',
            attendees=[{"email": "x@y.z", "responseStatus": "accepted"}],
        )
        _, updated, _ = self._sync_once(poller, db, monkeypatch, rsvp)
        assert updated == 1
        assert poller._test_registrations == []
        row = db.execute("SELECT raw_json FROM calendar_events").fetchone()
        assert json.loads(row["raw_json"])["etag"] == '"2"'
        assert poller._test_attendee_calls[-1] is not None

    @pytest.mark.parametrize(
        "change",
        [
            {"summary": "Retro"},
            {"description": "agenda"},
            {"location": "Room 2"},
            {"start": {"dateTime": "2026-10-02T09:00:00Z"}},
            {"end": {"dateTime": "2026-10-01T10:00:00Z"}},
            {"organizer": {"email": "b@b.c", "displayName": "B"}},
            {"htmlLink": "https://calendar/x"},
            {"recurringEventId": "series-1"},
            {"hangoutLink": "https://meet/abc"},
        ],
    )
    def test_mirrored_change_registers(self, poller, db, monkeypatch, change):
        add_account(db)
        event = make_event()
        self._sync_once(poller, db, monkeypatch, event)
        poller._test_registrations.clear()

        self._sync_once(poller, db, monkeypatch, dict(event, **change))
        assert len(poller._test_registrations) == 1
