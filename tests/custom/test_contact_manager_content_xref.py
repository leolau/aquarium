"""F5: a known phone/email quoted in the body of a message from an unknown
sender must only produce a merge *suggestion* for the owner, never an
auto-merge into the existing (possibly trusted) contact."""

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
_SCHEMA = """
CREATE TABLE unified_contacts (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, is_family INTEGER DEFAULT 0,
    is_vip INTEGER DEFAULT 0, relation TEXT, company TEXT, notes TEXT,
    auto_merged_count INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE contact_handles (
    id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, handle_type TEXT NOT NULL,
    handle_value TEXT NOT NULL, display_name TEXT, source TEXT, first_seen TEXT,
    last_seen TEXT, message_count INTEGER DEFAULT 0, UNIQUE(handle_type, handle_value));
CREATE TABLE contact_merge_suggestions (
    id TEXT PRIMARY KEY, new_handle_type TEXT NOT NULL, new_handle_value TEXT NOT NULL,
    new_display_name TEXT, new_contact_id TEXT, candidate_contact_id TEXT NOT NULL,
    correlation_reason TEXT, confidence TEXT, status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL, resolved_at TEXT, telegram_message_id TEXT);
CREATE TABLE escalations (id TEXT PRIMARY KEY, contact_id TEXT);
"""


def _load(rel):
    spec = importlib.util.spec_from_file_location(f"_cm_{rel.replace('/', '_')}", REPO_ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(params=["custom/shared/contact_manager.py", "custom/whatsapp/contact_manager.py"])
def cm(request, monkeypatch):
    sys.path.insert(0, str(REPO_ROOT / "custom" / "shared"))
    module = _load(request.param)
    sent = []
    monkeypatch.setattr(module, "send_telegram", lambda text, reply_markup=None: sent.append(text) or True)
    module._sent = sent
    return module


@pytest.fixture
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    yield conn
    conn.close()


def _owner(cm, db):
    contact_id, action = cm.process_new_handle(db, "email", "leo@example.com", "Leo Lau", "email")
    assert action == "created"
    cm.process_new_handle(db, "phone", "85291234567", "Leo L", "whatsapp")
    # attach the phone handle to the same contact the way a confirmed merge would
    db.execute("UPDATE contact_handles SET contact_id = ? WHERE handle_value = '85291234567'", (contact_id,))
    db.execute("DELETE FROM unified_contacts WHERE id != ?", (contact_id,))
    db.execute("DELETE FROM contact_merge_suggestions")
    db.commit()
    cm._sent.clear()
    return contact_id


def _handle_contact(db, value):
    return db.execute("SELECT contact_id FROM contact_handles WHERE handle_value = ?", (value,)).fetchone()[0]


@pytest.mark.parametrize("body", [
    "Hi, please cc leo@example.com on this invoice",
    "Call me back, or reach Leo on +852 9123-4567",
])
def test_known_handle_in_body_suggests_instead_of_auto_merging(cm, db, body):
    owner_id = _owner(cm, db)

    contact_id, action = cm.process_new_handle(
        db, "email", "attacker@evil.test", "Totally Unrelated", "email", body)

    assert action == "suggested"
    assert contact_id != owner_id
    assert _handle_contact(db, "attacker@evil.test") == contact_id
    owner = db.execute("SELECT auto_merged_count FROM unified_contacts WHERE id = ?", (owner_id,)).fetchone()
    assert owner["auto_merged_count"] == 0
    row = db.execute("SELECT candidate_contact_id, confidence, correlation_reason FROM contact_merge_suggestions").fetchone()
    assert row["candidate_contact_id"] == owner_id
    assert row["confidence"] == "medium"
    assert "found in message content" in row["correlation_reason"]
    assert len(cm._sent) == 1  # owner gets the Merge / Keep Separate prompt


def test_exact_unique_name_match_still_auto_merges(cm, db):
    owner_id = _owner(cm, db)

    contact_id, action = cm.process_new_handle(
        db, "email", "leo.lau@work.test", "Leo Lau", "email", "body mentions leo@example.com")

    assert (contact_id, action) == (owner_id, "auto_merged")
    assert _handle_contact(db, "leo.lau@work.test") == owner_id
