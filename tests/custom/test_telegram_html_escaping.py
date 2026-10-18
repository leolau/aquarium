"""F12: names, subjects and summaries come from outside (a WhatsApp profile
name, an email From/Subject, an LLM summary of untrusted text). They are put
into Telegram ``parse_mode=HTML`` messages and into the callback server's HTML
pages, so they must be escaped: a contact called
``<a href="https://evil.example">Your bank</a>`` must show as text, not as a
clickable link. Real modules, real SQLite, real HTTP for the callback pages."""

import importlib.util
import sqlite3
import sys
import threading
import types
import urllib.request
from http.server import HTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
EVIL = '<a href="https://evil.example">Your bank</a>'
EVIL_ESCAPED = "&lt;a href=&quot;https://evil.example&quot;&gt;Your bank&lt;/a&gt;"

PUSHERS = ["custom/whatsapp/escalation_pusher.py", "custom/shared/escalation_pusher_v2.py"]
CALLBACK_HANDLERS = ["custom/shared/telegram_callback_handler.py", "custom/whatsapp/telegram_callback_handler.py"]
CONTACT_MANAGERS = ["custom/shared/contact_manager.py", "custom/whatsapp/contact_manager.py"]
DIGESTS = ["custom/shared/digest_cron_v2.py", "custom/whatsapp/digest_cron.py"]


def _load(rel):
    sys.path.insert(0, str(REPO_ROOT / Path(rel).parent))
    spec = importlib.util.spec_from_file_location(
        "_t_html_" + rel.replace("/", "_").removesuffix(".py"), REPO_ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _assert_escaped(text):
    assert "<a " not in text and "evil.example\">" not in text, text
    assert EVIL_ESCAPED in text, text


# --- escalation pushers --------------------------------------------------


@pytest.fixture(params=PUSHERS)
def pusher(request, tmp_path):
    module = _load(request.param)
    db_path = tmp_path / "pusher.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE escalations (id INTEGER PRIMARY KEY, channel TEXT, sender_phone TEXT,
            sender_email TEXT, sender_name TEXT, reason TEXT, summary TEXT, priority TEXT,
            source_phone TEXT, contact_id INTEGER, source_msg_id TEXT, status TEXT);
        CREATE TABLE unified_contacts (id INTEGER PRIMARY KEY, display_name TEXT,
            relation TEXT, is_family INTEGER);
        CREATE TABLE contact_handles (id INTEGER PRIMARY KEY, contact_id INTEGER, handle TEXT);
        CREATE TABLE email_messages (id TEXT PRIMARY KEY, subject TEXT);
        CREATE TABLE email_accounts (id TEXT PRIMARY KEY, label TEXT);
        INSERT INTO unified_contacts VALUES (7, '{EVIL}', '{EVIL}', 0);
        INSERT INTO email_messages VALUES ('msg-1', '{EVIL}');
        INSERT INTO email_accounts VALUES ('acct-1', '{EVIL}');
        INSERT INTO escalations VALUES
            (1, 'whatsapp', '+85200000000', NULL, NULL, 'family', '{EVIL}', 'high', 'phone1', 7, NULL, 'pending'),
            (2, 'email', NULL, '{EVIL}', '{EVIL}', 'urgent_business', '{EVIL}', 'high', 'acct-1', 7, 'msg-1', 'pending');
        """
    )
    conn.commit()
    conn.close()
    module.DB_PATH = str(db_path)
    return module


def test_whatsapp_escalation_escapes_contact_and_summary(pusher):
    db = pusher.get_db()
    try:
        text = pusher.format_whatsapp_escalation(db.execute("SELECT * FROM escalations WHERE id = 1").fetchone(), db)
    finally:
        db.close()
    _assert_escaped(text)
    assert "<b>WhatsApp Escalation</b>" in text  # our own formatting still works
    assert text.count(EVIL_ESCAPED) == 3  # name, relation, summary


def test_email_escalation_escapes_every_outside_value(pusher):
    db = pusher.get_db()
    try:
        text = pusher.format_email_escalation(db.execute("SELECT * FROM escalations WHERE id = 2").fetchone(), db)
    finally:
        db.close()
    _assert_escaped(text)
    assert "<b>Email Escalation</b>" in text
    # sender name, relation, email, account label, subject, summary
    assert text.count(EVIL_ESCAPED) == 6


# --- callback handler: Telegram notices + HTML pages ----------------------

_CONTACT_SCHEMA = """
CREATE TABLE unified_contacts (id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
    is_family INTEGER DEFAULT 0, relation TEXT, auto_merged_count INTEGER DEFAULT 0,
    created_at TEXT, updated_at TEXT);
CREATE TABLE contact_handles (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL,
    handle_type TEXT NOT NULL, handle_value TEXT NOT NULL, message_count INTEGER DEFAULT 0);
CREATE TABLE contact_merge_suggestions (id TEXT PRIMARY KEY, new_handle_type TEXT,
    new_handle_value TEXT, new_display_name TEXT, new_contact_id TEXT,
    candidate_contact_id TEXT NOT NULL, status TEXT DEFAULT 'pending', resolved_at TEXT);
CREATE TABLE escalations (id TEXT PRIMARY KEY, contact_id TEXT);
"""


def _seed_merge(db_path):
    conn = sqlite3.connect(db_path)
    conn.executescript(_CONTACT_SCHEMA)
    conn.executemany("INSERT INTO unified_contacts (id, display_name) VALUES (?, ?)",
                     [("target", EVIL), ("source", EVIL)])
    conn.executemany("INSERT INTO contact_handles VALUES (?, ?, 'email', ?, 1)",
                     [("h1", "target", EVIL), ("h2", "source", "x@example.com")])
    conn.executemany(
        "INSERT INTO contact_merge_suggestions (id, new_handle_type, new_handle_value, new_display_name, "
        "new_contact_id, candidate_contact_id) VALUES (?, 'email', 'x@example.com', ?, 'source', 'target')",
        [("sug-merge", EVIL), ("sug-reject", EVIL)])
    conn.commit()
    conn.close()


@pytest.fixture
def serve():
    servers = []

    def _serve(handler):
        server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield _serve
    for server in servers:
        server.shutdown()
        server.server_close()


@pytest.mark.parametrize("handler_rel,cm_rel", list(zip(CALLBACK_HANDLERS, CONTACT_MANAGERS)))
def test_callback_pages_and_notices_escape_contact_names(handler_rel, cm_rel, serve, tmp_path, monkeypatch):
    handler = _load(handler_rel)
    cm = _load(cm_rel)
    db_path = tmp_path / "contacts.db"
    _seed_merge(db_path)
    monkeypatch.setattr(handler, "DB_PATH", str(db_path))
    for mod in (handler, cm):
        monkeypatch.setattr(mod, "TELEGRAM_BOT_TOKEN", "123:bot-token")
    monkeypatch.delenv("CALLBACK_SIGNING_SECRET", raising=False)
    sent = []
    monkeypatch.setattr(handler, "send_telegram", sent.append)
    base = serve(handler.CallbackHandler)
    monkeypatch.setattr(cm, "CALLBACK_SERVER_BASE", base)

    pages = []
    for action, sid in (("merge", "sug-merge"), ("reject", "sug-reject")):
        with urllib.request.urlopen(cm.sign_callback_url(action, sid), timeout=5) as resp:
            assert resp.status == 200
            pages.append(resp.read().decode())

    assert "Contacts Merged" in pages[0] and "Kept Separate" in pages[1]
    for text in pages + sent:
        _assert_escaped(text)
    assert len(sent) == 2
    assert "<b>Merged</b>" in sent[0]


@pytest.mark.parametrize("handler_rel", CALLBACK_HANDLERS)
def test_html_response_escapes_title_and_message(handler_rel):
    page = _load(handler_rel).html_response(EVIL, EVIL)
    assert page.count(EVIL_ESCAPED) == 3  # <title>, <h1>, <p>
    assert "<a " not in page


# --- merge suggestion sent by the contact manager -------------------------


@pytest.mark.parametrize("cm_rel", CONTACT_MANAGERS)
def test_merge_suggestion_escapes_names_handles_and_reason(cm_rel, monkeypatch):
    cm = _load(cm_rel)
    sent = []
    monkeypatch.setattr(cm, "send_telegram", lambda text, reply_markup=None: sent.append(text) or True)
    monkeypatch.setattr(cm, "CALLBACK_SERVER_BASE", "")
    cm.send_merge_confirmation(
        None, "sug-1", EVIL, EVIL,
        {"display_name": EVIL, "relation": EVIL, "is_family": 0},
        [{"handle_type": "email", "handle_value": EVIL, "message_count": 3}],
        EVIL,
    )
    assert len(sent) == 1
    _assert_escaped(sent[0])
    assert sent[0].count(EVIL_ESCAPED) == 6  # new handle, new name, name, relation, handle, reason
    assert "<b>Contact Merge Suggestion</b>" in sent[0]


# --- hourly digest (LLM summary of untrusted messages) --------------------

_DIGEST_SCHEMA = """
CREATE TABLE messages (received_at TEXT, sender_phone TEXT, sender_name TEXT, text TEXT, timestamp TEXT);
CREATE TABLE email_messages (received_at TEXT, from_addr TEXT, from_name TEXT, subject TEXT);
CREATE TABLE wa_tasks (description TEXT, priority TEXT, due_date TEXT, status TEXT, created_at TEXT);
CREATE TABLE email_tasks (description TEXT, priority TEXT, due_date TEXT, status TEXT, created_at TEXT);
CREATE TABLE escalations (channel TEXT, sender_phone TEXT, sender_email TEXT, reason TEXT,
    summary TEXT, status TEXT, created_at TEXT);
CREATE TABLE unified_contacts (id TEXT);
CREATE TABLE contact_merge_suggestions (status TEXT);
INSERT INTO messages VALUES ('9999-01-01', '+85200000000', 'Mallory', 'hello', '9999-01-01');
"""


@pytest.mark.parametrize("rel", DIGESTS)
def test_digest_escapes_llm_summary_and_todos(rel, tmp_path, monkeypatch):
    digest = _load(rel)
    db_path = tmp_path / "digest.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(_DIGEST_SCHEMA)
    conn.commit()
    conn.close()
    monkeypatch.setattr(digest, "DB_PATH", str(db_path))
    monkeypatch.setattr(digest, "EMAIL_DB_PATH", str(tmp_path / "missing" / "email.db"), raising=False)
    monkeypatch.setattr(digest, "call_deepseek", lambda prompt: EVIL)
    monkeypatch.setattr(digest, "collect_open_todos", lambda *a, **k: [EVIL], raising=False)
    monkeypatch.setattr(digest, "sweep_todo_notifications", lambda: 0, raising=False)
    sent = []
    monkeypatch.setattr(digest, "send_telegram", lambda text, parse_mode="HTML": sent.append(text) or True)

    digest.generate_digest()

    assert len(sent) == 1
    _assert_escaped(sent[0])
    assert "<b>Hourly Digest</b>" in sent[0]


# --- high-priority to-do push ---------------------------------------------


def test_todo_push_escapes_title_and_body(monkeypatch):
    sys.path.insert(0, str(REPO_ROOT / "custom"))
    registration = _load("custom/shared/todo_registration.py")
    sent = []
    fake = types.ModuleType("shared.escalation_pusher_v2")
    fake.send_telegram = lambda text, parse_mode="HTML": sent.append(text) or True
    monkeypatch.setitem(sys.modules, "shared.escalation_pusher_v2", fake)

    assert registration.push_todo(EVIL, types.SimpleNamespace(body=EVIL)) is True
    assert len(sent) == 1
    _assert_escaped(sent[0])
    assert sent[0].count(EVIL_ESCAPED) == 2
