"""The WhatsApp batcher survives odd bridge timestamps without losing messages.

Baileys gives some inbound messages (e.g. ones the phone re-sent after the
linked device failed to decrypt them) a protobuf Long ``messageTimestamp``,
which reaches the batcher as ``{"low", "high", "unsigned"}``. ``GET /messages``
has already drained the bridge's queue by then, so a message that raises must
not take the rest of the poll's messages down with it.
"""

import json
import sqlite3
import sys
import types
from datetime import datetime, timezone

import pytest

from tests.custom.test_wa_batcher_poll_interval import _StopLoop, _load

SURVEY_TEXT = "I want to do the survey and get the presentation link."
LONG_TS = {"low": 1790766223, "high": 0, "unsigned": True}


@pytest.fixture
def batcher(tmp_path, monkeypatch):
    db_path = tmp_path / "messages.db"
    conn = sqlite3.connect(db_path)
    conn.execute(
        """CREATE TABLE messages (
               id TEXT PRIMARY KEY, source_phone TEXT, sender_phone TEXT,
               sender_name TEXT, chat_id TEXT, is_group INTEGER, text TEXT,
               media_type TEXT, media_path TEXT, media_mimetype TEXT,
               timestamp TEXT, received_at TEXT, batch_id TEXT, raw_json TEXT)"""
    )
    conn.execute(
        """CREATE TABLE contacts (
               phone TEXT PRIMARY KEY, name TEXT, is_family INTEGER,
               first_seen TEXT, last_seen TEXT, message_count INTEGER)"""
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("MESSAGING_DB_PATH", str(db_path))
    registry = types.SimpleNamespace(register_item=lambda **_: None)
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", registry)
    module = _load(tmp_path, batching={"window_seconds": 3600})
    yield module, db_path
    with module._batch_lock:
        for batch in module._pending_batches.values():
            batch["timer"].cancel()


def _bridge_message(msg_id, chat, timestamp):
    return {
        "messageId": msg_id,
        "chatId": f"{chat}@lid",
        "senderId": f"{chat}@lid",
        "senderName": "Attendee",
        "isGroup": False,
        "body": SURVEY_TEXT,
        "timestamp": timestamp,
    }


def _stored(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return dict(conn.execute("SELECT id, timestamp FROM messages").fetchall())
    finally:
        conn.close()


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (LONG_TS, 1790766223),
        ({"low": -1, "high": 0, "unsigned": True}, 0xFFFFFFFF),
        ({"low": 0, "high": 1, "unsigned": False}, 1 << 32),
        (1790766223, 1790766223),
        ("1790766223", 1790766223),
        (None, None),
        ({"low": "x"}, None),
        ([1], None),
    ],
)
def test_epoch_seconds(batcher, raw, expected):
    module, _ = batcher
    assert module._epoch_seconds(raw) == expected


def test_long_timestamp_message_is_stored(batcher):
    module, db_path = batcher
    module.process_message(_bridge_message("M1", "61650413588712", LONG_TS), "phone2")

    expected = datetime.fromtimestamp(1790766223, tz=timezone.utc).isoformat()
    assert _stored(db_path) == {"M1": expected}


def test_one_bad_message_does_not_drop_the_rest_of_the_poll(batcher):
    module, db_path = batcher
    payload = json.dumps([
        _bridge_message("M1", "111", 1790766220),
        _bridge_message("M2", "222", LONG_TS),
        _bridge_message("M3", "333", 1790766230),
    ]).encode()
    real_process = module.process_message

    def flaky_process(msg, source_phone, bridge_port=None, **kw):
        if msg["messageId"] == "M1":
            raise RuntimeError("boom")
        real_process(msg, source_phone, bridge_port=bridge_port, **kw)

    class _Resp:
        def read(self):
            return payload

    polls = []

    def fake_urlopen(url, timeout=None):
        polls.append(url)
        if len(polls) > 1:
            raise _StopLoop
        return _Resp()

    module.process_message = flaky_process
    module.urlopen = fake_urlopen
    module.time.sleep = lambda _seconds: None
    with pytest.raises(_StopLoop):
        module.poll_bridge({"bridge_port": 3001, "id": "phone2"})

    assert set(_stored(db_path)) == {"M2", "M3"}
