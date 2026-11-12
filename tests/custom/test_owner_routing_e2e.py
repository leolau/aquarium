"""Escalations and digests reach each item's person, and only them (FG-38 P3).

Real path: a real Postgres people store and inbound registry, the real
pusher/digest modules against temp SQLite stores, and the Telegram HTTP call
captured at ``urlopen``.
"""

import asyncio
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import asyncpg
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

from hermes_cli.access import PrincipalStore  # noqa: E402
from hermes_cli.datastore import get_store, initialize_supabase_app  # noqa: E402
from tests.hermes_cli.test_account_owners_e2e import postgres_dsn  # noqa: E402,F401

BOX_CHAT = "111"


def _load(path, name, monkeypatch, tmp_path):
    monkeypatch.setenv("MESSAGING_DB_PATH", str(tmp_path / "messaging.db"))
    monkeypatch.setenv("EMAIL_DB_PATH", str(tmp_path / "email.db"))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", BOX_CHAT)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sent = []

    class _Ok:
        def read(self):
            return b'{"ok": true}'

    def _urlopen(req, timeout=10):
        payload = json.loads(req.data.decode())
        sent.append((str(payload["chat_id"]), payload["text"]))
        return _Ok()

    monkeypatch.setattr(module, "urlopen", _urlopen)
    return module, sent


def _stores(tmp_path):
    db = sqlite3.connect(tmp_path / "messaging.db")
    db.executescript(
        """
        CREATE TABLE escalations (
            id TEXT PRIMARY KEY, source_phone TEXT, source_msg_id TEXT,
            sender_phone TEXT, reason TEXT, summary TEXT, priority TEXT,
            status TEXT, created_at TEXT, delivered_at TEXT, channel TEXT,
            sender_email TEXT, sender_name TEXT, contact_id INTEGER);
        CREATE TABLE messages (
            id TEXT PRIMARY KEY, source_phone TEXT, sender_phone TEXT,
            sender_name TEXT, text TEXT, timestamp INTEGER, received_at TEXT);
        CREATE TABLE wa_tasks (
            id TEXT, source_phone TEXT, source_msg_id TEXT, description TEXT,
            due_date TEXT, status TEXT, priority TEXT, created_at TEXT);
        CREATE TABLE unified_contacts (id INTEGER PRIMARY KEY);
        CREATE TABLE contact_merge_suggestions (status TEXT);
        INSERT INTO contact_merge_suggestions VALUES ('pending');
        """
    )
    db.commit()
    db.close()
    email = sqlite3.connect(tmp_path / "email.db")
    email.executescript(
        """
        CREATE TABLE email_messages (
            id TEXT PRIMARY KEY, account_id TEXT, message_id TEXT,
            from_addr TEXT, from_name TEXT, subject TEXT, received_at TEXT);
        CREATE TABLE email_tasks (
            id TEXT, account_id TEXT, source_email_id TEXT, description TEXT,
            due_date TEXT, status TEXT, priority TEXT, created_at TEXT);
        """
    )
    email.commit()
    email.close()


def _write(tmp_path, sql, rows, db="messaging.db"):
    conn = sqlite3.connect(tmp_path / db)
    conn.executemany(sql, rows)
    conn.commit()
    conn.close()


@pytest.fixture
def people(postgres_dsn, tmp_path, monkeypatch):  # noqa: F811
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(
        f"datastore:\n  supabase_app:\n    dsn: {postgres_dsn}\n"
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    config = {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}

    async def _setup():
        conn = await asyncpg.connect(postgres_dsn, ssl=False)
        try:
            await conn.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
            await initialize_supabase_app(conn)
        finally:
            await conn.close()
        from hermes_cli.human_comms import NotificationStore
        from hermes_cli.inbound_registry import InboundRegistry

        app = get_store("supabase-app", "prod", config=config)
        await InboundRegistry(app).initialize()
        notifications = NotificationStore(app, config=config)
        if hasattr(notifications, "initialize"):
            await notifications.initialize()
        store = PrincipalStore(app)
        await store.enroll("leo", display="Leo", role="owner")
        await store.enroll("sam", display="Sam")
        await store.link_channel("sam", "telegram", "999")
        await store.enroll("kit", display="Kit")
        await store.enroll("gone", display="Gone")

    asyncio.run(_setup())
    from shared import inbound_registration as registration

    monkeypatch.setattr(registration, "_owner_resolved", False)
    monkeypatch.setattr(registration, "_owner_last_attempt", 0.0)
    for surface, account, external, owner in (
        ("whatsapp", "phone1", "w-leo", "leo"),
        ("whatsapp", "phone1", "w-sam", "sam"),
        ("whatsapp", "phone1", "w-kit", "kit"),
        ("whatsapp", "phone1", "w-gone", "gone"),
        ("email", "email2", "<m-sam@x>", "sam"),
    ):
        assert registration.register_item(
            surface=surface, account_id=account, external_id=external,
            body="hi", owner_user_id=owner,
        ), (external, owner)
    # Gone's message arrived while they were still here; they left afterwards.
    asyncio.run(
        PrincipalStore(get_store("supabase-app", "prod", config=config)).set_active(
            "gone", False
        )
    )
    _stores(tmp_path)
    return postgres_dsn


def _notified(dsn):
    async def _read():
        conn = await asyncpg.connect(dsn, ssl=False)
        try:
            rows = await conn.fetch("SELECT owner_user_id FROM app_prod.notifications")
        finally:
            await conn.close()
        return sorted(r["owner_user_id"] for r in rows)

    return asyncio.run(_read())


@pytest.mark.parametrize(
    "path",
    ["custom/whatsapp/escalation_pusher.py", "custom/shared/escalation_pusher_v2.py"],
)
def test_each_escalation_reaches_only_its_person(people, tmp_path, monkeypatch, path):
    module, sent = _load(ROOT / path, f"_pusher_{Path(path).stem}", monkeypatch, tmp_path)
    _write(tmp_path, "INSERT INTO email_messages (id, account_id, message_id) VALUES (?, ?, ?)",
           [("row-7", "email2", "<m-sam@x>")], db="email.db")
    _write(
        tmp_path,
        """INSERT INTO escalations (id, channel, source_phone, source_msg_id, reason,
               summary, priority, status, created_at)
           VALUES (?, ?, ?, ?, 'urgent', ?, 'high', 'pending', ?)""",
        [
            ("e1", "whatsapp", "phone1", "w-leo", "for leo", "2026-11-12T00:00:01"),
            ("e2", "whatsapp", "phone1", "w-sam", "for sam", "2026-11-12T00:00:02"),
            ("e3", "whatsapp", "phone1", "w-kit", "for kit", "2026-11-12T00:00:03"),
            ("e4", "whatsapp", "phone1", "w-gone", "for gone", "2026-11-12T00:00:04"),
            ("e5", "email", "email2", "row-7", "sam mail", "2026-11-12T00:00:05"),
            ("e6", "whatsapp", "phone1", "w-never-registered", "legacy", "2026-11-12T00:00:06"),
        ],
    )
    module.process_pending_escalations()

    by_chat = {}
    for chat, text in sent:
        by_chat.setdefault(chat, []).append(text)
    assert set(by_chat) == {BOX_CHAT, "999"}
    assert [("for leo" in t, "legacy" in t) for t in by_chat[BOX_CHAT]] == [
        (True, False), (False, True)]
    assert len(by_chat["999"]) == 2 and all("leo" not in t for t in by_chat["999"])
    assert not any("for kit" in t or "for gone" in t for t in sum(by_chat.values(), []))
    assert _notified(people) == ["kit"], "Kit has no Telegram: told in agent-home"
    conn = sqlite3.connect(tmp_path / "messaging.db")
    status = dict(conn.execute("SELECT id, status FROM escalations"))
    conn.close()
    assert status == {"e1": "delivered", "e2": "delivered", "e3": "delivered",
                      "e4": "no_recipient", "e5": "delivered", "e6": "delivered"}


def test_an_unknown_owner_keeps_the_escalation_pending(tmp_path, monkeypatch):
    module, sent = _load(ROOT / "custom/whatsapp/escalation_pusher.py", "_pusher_down",
                         monkeypatch, tmp_path)
    _stores(tmp_path)
    _write(tmp_path,
           """INSERT INTO escalations (id, channel, source_phone, source_msg_id,
                  reason, summary, priority, status, created_at)
              VALUES ('e1', 'whatsapp', 'phone1', 'w-sam', 'r', 's', 'high',
                      'pending', '2026-11-12')""", [()])
    from shared import owner_routing

    def _down(_arrivals):
        raise owner_routing.LookupUnavailable("postgres is down")

    monkeypatch.setattr(owner_routing, "resolve_people", _down)
    module.process_pending_escalations()
    conn = sqlite3.connect(tmp_path / "messaging.db")
    assert conn.execute("SELECT status FROM escalations").fetchone() == ("pending",)
    conn.close()
    assert sent == [], "never guessed to the box chat"


def _digest_rows(tmp_path):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc).isoformat()
    _write(tmp_path,
           """INSERT INTO messages (id, source_phone, sender_phone, sender_name, text,
                  timestamp, received_at) VALUES (?, 'phone1', ?, ?, ?, 1, ?)""",
           [("w-leo", "852001", "Ann", "leo's secret", now),
            ("w-sam", "852002", "Bob", "sam's secret", now),
            ("w-gone", "852003", "Cat", "gone's secret", now)])
    _write(tmp_path,
           """INSERT INTO email_messages (id, account_id, message_id, from_addr,
                  from_name, subject, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)""",
           [("row-7", "email2", "<m-sam@x>", "d@x", "Dee", "sam's mail", now)], db="email.db")


def test_each_person_gets_a_digest_of_only_their_items(people, tmp_path, monkeypatch):
    module, sent = _load(ROOT / "custom/whatsapp/digest_cron.py", "_digest", monkeypatch, tmp_path)
    monkeypatch.setattr(module, "call_deepseek", lambda prompt: prompt)
    _digest_rows(tmp_path)
    module.generate_digest()

    texts = dict(sent)
    assert set(texts) == {BOX_CHAT, "999"}
    assert "leo&#x27;s secret" in texts[BOX_CHAT] and "sam" not in texts[BOX_CHAT]
    assert "WA: 1 msgs, Email: 1 emails" in texts["999"]
    assert "leo" not in texts["999"] and "gone" not in texts["999"]
    assert "contact merge" in texts[BOX_CHAT] and "contact merge" not in texts["999"]
    assert not any("gone&#x27;s" in t for t in texts.values())


def test_a_single_user_install_keeps_one_digest_to_the_box_chat(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    module, sent = _load(ROOT / "custom/whatsapp/digest_cron.py", "_digest1", monkeypatch, tmp_path)
    monkeypatch.setattr(module, "call_deepseek", lambda prompt: prompt)
    _stores(tmp_path)
    _digest_rows(tmp_path)
    module.generate_digest()
    assert [chat for chat, _ in sent] == [BOX_CHAT]
    assert "WA: 3 msgs, Email: 1 emails" in sent[0][1]


def test_a_todo_push_goes_to_its_person_s_telegram_only(monkeypatch):
    import types

    from shared import escalation_pusher_v2, todo_registration

    monkeypatch.setenv("TELEGRAM_ALLOWED_USERS", BOX_CHAT)
    chats = []
    monkeypatch.setattr(
        escalation_pusher_v2, "send_telegram",
        lambda text, parse_mode="HTML", chat_id=None: chats.append(chat_id) or True,
    )
    owner = types.SimpleNamespace(user_id="leo", channels=[])
    monkeypatch.setattr(todo_registration, "_owner_principal", owner)
    note = types.SimpleNamespace(body="")
    sam = types.SimpleNamespace(user_id="sam", channels=["telegram:999"])
    kit = types.SimpleNamespace(user_id="kit", channels=[])

    assert todo_registration.push_todo("t", note, person=sam) is True
    assert todo_registration.push_todo("t", note, person=owner) is True
    assert todo_registration.push_todo("t", note, person=kit) is False
    assert chats == ["999", BOX_CHAT], "Kit's to-do never reaches the box chat"


@pytest.mark.parametrize(
    "path",
    ["custom/whatsapp/escalation_pusher.py", "custom/shared/escalation_pusher_v2.py"],
)
def test_a_failed_send_to_one_person_does_not_retell_the_others(
    people, tmp_path, monkeypatch, path
):
    from shared import inbound_registration as registration

    for owner in ("sam", "leo"):
        assert registration.register_item(
            surface="whatsapp", account_id="phone1", external_id="w-both",
            body="hi", owner_user_id=owner,
        )
    module, sent = _load(ROOT / path, f"_retry_{Path(path).stem}", monkeypatch, tmp_path)
    _write(tmp_path,
           """INSERT INTO escalations (id, channel, source_phone, source_msg_id,
                  reason, summary, priority, status, created_at)
              VALUES ('e1', 'whatsapp', 'phone1', 'w-both', 'urgent', 'for both',
                      'high', 'pending', '2026-11-12')""", [()])
    captured = module.urlopen
    box_down = [True]

    def _flaky(req, timeout=10):
        if box_down[0] and str(json.loads(req.data.decode())["chat_id"]) == BOX_CHAT:
            raise OSError("telegram is down")
        return captured(req, timeout)

    monkeypatch.setattr(module, "urlopen", _flaky)

    def _status():
        conn = sqlite3.connect(tmp_path / "messaging.db")
        try:
            return conn.execute("SELECT status FROM escalations").fetchone()[0]
        finally:
            conn.close()

    module.process_pending_escalations()
    assert [chat for chat, _ in sent] == ["999"] and _status() == "pending"
    module.process_pending_escalations()
    assert [chat for chat, _ in sent] == ["999"], "Sam is not told twice"
    box_down[0] = False
    module.process_pending_escalations()
    assert [chat for chat, _ in sent] == ["999", BOX_CHAT] and _status() == "delivered"


def test_a_busy_person_s_tasks_do_not_hide_anyone_else_s(people, tmp_path, monkeypatch):
    module, sent = _load(ROOT / "custom/whatsapp/digest_cron.py", "_digest_tasks",
                         monkeypatch, tmp_path)
    monkeypatch.setattr(module, "call_deepseek", lambda prompt: prompt)
    _write(tmp_path,
           """INSERT INTO wa_tasks (id, source_phone, source_msg_id, description,
                  status, priority, created_at) VALUES (?, 'phone1', ?, ?, 'pending', 'high', ?)""",
           [("t-leo", "w-leo", "leo old task", "2026-11-01")]
           + [(f"t{i}", "w-sam", f"sam task {i}", f"2026-11-12T00:{i:02d}") for i in range(60)])
    module.generate_digest()

    texts = dict(sent)
    assert "leo old task" in texts[BOX_CHAT] and "sam task" not in texts[BOX_CHAT]
    assert "PENDING TASKS (60)" in texts["999"]
