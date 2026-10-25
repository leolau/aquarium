"""Poll queries on the channel SQLite DBs must be served by an index.

The services open databases created long before these indexes existed, so each
one creates its index on start; these tests build the production schema without
them and check the service adds them and the poll query uses them.
"""

import importlib.util
import runpy
import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
EMAIL_BATCHER = REPO_ROOT / "custom" / "email" / "email_batcher.py"
PUSHERS = {
    "escalation_pusher": REPO_ROOT / "custom" / "whatsapp" / "escalation_pusher.py",
    "escalation_pusher_v2": REPO_ROOT / "custom" / "shared" / "escalation_pusher_v2.py",
}

# Production DDL (pre-index), as read from the live databases.
EMAIL_MESSAGES_DDL = """
CREATE TABLE email_messages ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  from_addr TEXT NOT NULL, from_name TEXT, to_addrs TEXT, cc_addrs TEXT, subject TEXT,
  body_text TEXT, body_html TEXT, has_attachments INTEGER DEFAULT 0, attachment_info TEXT,
  message_id TEXT UNIQUE, in_reply_to TEXT, thread_id TEXT, folder TEXT DEFAULT 'INBOX',
  received_at TEXT NOT NULL, batch_id TEXT, raw_headers TEXT );
CREATE INDEX idx_email_from ON email_messages(from_addr);
CREATE INDEX idx_email_received ON email_messages(received_at);
CREATE INDEX idx_email_thread ON email_messages(thread_id);
"""
ESCALATIONS_DDL = """
CREATE TABLE escalations ( id TEXT PRIMARY KEY, source_phone TEXT, source_msg_id TEXT,
  sender_phone TEXT, reason TEXT, summary TEXT, priority TEXT, status TEXT DEFAULT pending,
  created_at TEXT, delivered_at TEXT, resolved_at TEXT , channel TEXT DEFAULT 'whatsapp',
  sender_email TEXT, sender_name TEXT, contact_id TEXT);
"""


class _StopLoop(BaseException):
    pass


def _load(name, path):
    spec = importlib.util.spec_from_file_location(f"_idx_{name}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _make_db(path, ddl):
    conn = sqlite3.connect(path)
    conn.executescript(ddl)
    conn.commit()
    conn.close()


def _index_names(path, table):
    conn = sqlite3.connect(path)
    try:
        return {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", (table,))}
    finally:
        conn.close()


def _plan(path, sql):
    conn = sqlite3.connect(path)
    try:
        return " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql))
    finally:
        conn.close()


def _stop_after_first_cycle(module, monkeypatch):
    def _sleep(_seconds):
        raise _StopLoop

    monkeypatch.setattr(module.time, "sleep", _sleep)


UNBATCHED_SQL = "SELECT * FROM email_messages WHERE batch_id IS NULL ORDER BY received_at ASC"
PENDING_SQL = "SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at ASC"


@pytest.fixture
def batcher(tmp_path, monkeypatch):
    module = _load("email_batcher", EMAIL_BATCHER)
    db_path = tmp_path / "email_data.db"
    _make_db(db_path, EMAIL_MESSAGES_DDL)
    config = tmp_path / "config.json"
    config.write_text('{"batching": {"window_seconds": 30}}')
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    monkeypatch.setattr(module, "CONFIG_PATH", str(config))
    monkeypatch.setattr(module, "BATCH_DIR", str(tmp_path / "batches"))
    monkeypatch.setattr(module, "PROCESSED_DIR", str(tmp_path / "batches" / "processed"))
    return module, db_path


def test_email_batcher_start_adds_unbatched_index(batcher, monkeypatch):
    module, db_path = batcher
    assert "SCAN email_messages USING INDEX idx_email_received" in _plan(db_path, UNBATCHED_SQL)

    _stop_after_first_cycle(module, monkeypatch)
    with pytest.raises(_StopLoop):
        module.main()

    assert "idx_email_unbatched" in _index_names(db_path, "email_messages")
    assert "USING INDEX idx_email_unbatched" in _plan(db_path, UNBATCHED_SQL)


def test_email_unbatched_index_is_idempotent_and_partial(batcher):
    module, db_path = batcher
    db = module.get_db()
    try:
        module.ensure_indexes(db)
        module.ensure_indexes(db)
        sql = db.execute(
            "SELECT sql FROM sqlite_master WHERE name='idx_email_unbatched'").fetchone()[0]
    finally:
        db.close()
    assert "WHERE batch_id IS NULL" in sql


def test_email_batcher_still_polls_when_table_missing(tmp_path, monkeypatch):
    module = _load("email_batcher_empty", EMAIL_BATCHER)
    config = tmp_path / "config.json"
    config.write_text("{}")
    monkeypatch.setattr(module, "DB_PATH", str(tmp_path / "fresh.db"))
    monkeypatch.setattr(module, "CONFIG_PATH", str(config))
    monkeypatch.setattr(module, "BATCH_DIR", str(tmp_path / "b"))
    monkeypatch.setattr(module, "PROCESSED_DIR", str(tmp_path / "b" / "p"))
    _stop_after_first_cycle(module, monkeypatch)
    with pytest.raises(_StopLoop):
        module.main()


def test_create_email_tables_migration_adds_unbatched_index(tmp_path, monkeypatch):
    db_path = tmp_path / "email_data.db"
    monkeypatch.setenv("EMAIL_DB_PATH", str(db_path))
    runpy.run_path(str(REPO_ROOT / "custom" / "migrations" / "create_email_tables.py"))
    assert "idx_email_unbatched" in _index_names(db_path, "email_messages")


@pytest.fixture(params=sorted(PUSHERS))
def pusher(request, tmp_path, monkeypatch):
    module = _load(request.param, PUSHERS[request.param])
    db_path = tmp_path / "messaging_data.db"
    _make_db(db_path, ESCALATIONS_DDL)
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    monkeypatch.setattr(module, "EMAIL_DB_PATH", str(tmp_path / "email" / "email_data.db"))
    return module, db_path


def test_escalation_pusher_start_adds_status_index(pusher, monkeypatch):
    module, db_path = pusher
    assert "SCAN escalations" in _plan(db_path, PENDING_SQL)

    _stop_after_first_cycle(module, monkeypatch)
    with pytest.raises(_StopLoop):
        module.main()

    assert "idx_escalations_status_created" in _index_names(db_path, "escalations")
    plan = _plan(db_path, PENDING_SQL)
    assert "USING INDEX idx_escalations_status_created" in plan
    assert "TEMP B-TREE" not in plan
    mcp_list = "SELECT * FROM escalations WHERE status = 'delivered' ORDER BY created_at DESC LIMIT 50"
    assert "USING INDEX idx_escalations_status_created" in _plan(db_path, mcp_list)


def test_escalation_index_setup_is_idempotent(pusher):
    module, db_path = pusher
    for _ in range(2):
        db = module.get_db()
        try:
            module.ensure_indexes(db)
        finally:
            db.close()
    assert "idx_escalations_status_created" in _index_names(db_path, "escalations")
