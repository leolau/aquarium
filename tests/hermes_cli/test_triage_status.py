"""GET /api/triage/status — the signed-in person's triage setup.

Real paths throughout: the file credential store under the per-test
HERMES_HOME, real email/WhatsApp/calendar config files, a real calendar
SQLite DB, real skill folders and bridge-owners.json. Only the caller
resolution and ``systemctl`` are stubbed.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

import hermes_cli.triage_status as ts
import hermes_cli.triage_status_api as api
from hermes_cli import wa_bridge_owners as owners
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore, default_credential_store

LEO = Principal(user_id="leo", display="Leo", role="owner")
AMY = Principal(user_id="amy", display="Amy", role="member")
SECRET = "app-pass-9f2c7a41"
REFRESH = "1//refresh-token-secret"
CLIENT_SECRET = "GOCSPX-client-secret"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("WHATSAPP_BRIDGES", raising=False)
    data = tmp_path / "data"
    paths = SimpleNamespace(
        home=home,
        email_cfg=data / "email-messages" / "config.json",
        wa_cfg=data / "whatsapp-messages" / "config.json",
        cal_cfg=data / "calendar" / "config.json",
        cal_db=data / "calendar" / "calendar_data.db",
        skills=data / "skills",
    )
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(paths.email_cfg))
    monkeypatch.setenv("CALENDAR_CONFIG_PATH", str(paths.cal_cfg))
    monkeypatch.setenv("CALENDAR_DB_PATH", str(paths.cal_db))
    monkeypatch.setattr(ts, "WHATSAPP_CONFIG_PATH", str(paths.wa_cfg))
    monkeypatch.setattr(owners, "_installed_bridge_ports", lambda: {})
    monkeypatch.setattr(ts, "unit_states", lambda units: {u: "active" for u in units})
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    paths.store = store
    return paths


def _write(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc))


def _triage(kind: str, env) -> dict:
    return {"skills_dirs": [str(env.skills / f"{kind}-triage")]}


def _skill(env, kind: str, name: str = "SKILL.md") -> Path:
    folder = env.skills / f"{kind}-triage"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(f"# {kind} triage\n")
    return folder / name


def _google(env, who, email, *services):
    run(env.store.put(
        who, provider="google", name=email, kind="google-oauth2", services=list(services),
        payload={"client_id": "cid", "client_secret": CLIENT_SECRET,
                 "refresh_token": REFRESH, "token_uri": "https://oauth2.googleapis.com/token"},
    ))


def _imap(env, who, address):
    run(env.store.put(
        who, provider="imap", name=address, kind="email-imap", services=["email"],
        payload={"address": address, "username": address, "password": SECRET,
                 "imap_host": "imap.example.com", "imap_port": 993,
                 "smtp_host": "smtp.example.com", "smtp_port": 465},
    ))


def _calendar_db(env, rows):
    env.cal_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(env.cal_db)
    conn.execute(
        "CREATE TABLE calendar_accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, "
        "label TEXT, sync_token TEXT, last_synced TEXT, enabled INTEGER DEFAULT 1)"
    )
    conn.executemany("INSERT INTO calendar_accounts (id, email, label, enabled) VALUES (?,?,?,?)", rows)
    conn.commit()
    conn.close()


def _wa_session(env, name, number="85291234567"):
    d = env.home / "whatsapp" / f"session-{name}"
    d.mkdir(parents=True)
    (d / "creds.json").write_text(json.dumps({"me": {"id": f"{number}:7@s.whatsapp.net"}}))


def status(monkeypatch, who, profile=None) -> dict:
    async def _caller(_request):
        return who

    monkeypatch.setattr(api, "_caller", _caller)
    out = run(api.get_triage_status(SimpleNamespace(), profile=profile))
    dumped = json.dumps(out)
    for secret in (SECRET, REFRESH, CLIENT_SECRET):
        assert secret not in dumped
    return out


def kinds(out) -> dict:
    return {k["kind"]: k for k in out["kinds"]}


def test_nothing_configured(env, monkeypatch):
    out = kinds(status(monkeypatch, LEO))
    assert set(out) == {"email", "whatsapp", "calendar"}
    for k in out.values():
        assert k["status"] == ts.NOT_SET_UP
        assert k["missing"] == ["account"]
        assert k["accounts"] == []
        assert k["config"]["present"] is False
        assert k["skills_present"] is False
        assert k["setup_links"] and all(link["href"].startswith("/settings/") for link in k["setup_links"])
    # No config = the pipelines' built-in skill folders are what they'd read.
    assert [s["path"] for s in out["calendar"]["skills"] if s["layer"] == "base"] == [
        "/opt/data/skills/calendar-triage"
    ]


def test_skill_present_but_channel_missing(env, monkeypatch):
    for kind, cfg in (("email", env.email_cfg), ("whatsapp", env.wa_cfg), ("calendar", env.cal_cfg)):
        skill = _skill(env, kind)
        _write(cfg, {"triage": _triage(kind, env), "accounts": [], "phones": []})
        disabled = skill.parent / "old.md.disabled"
        disabled.write_text("off")
    out = kinds(status(monkeypatch, LEO))
    for kind, k in out.items():
        assert k["status"] == ts.NOT_SET_UP, kind
        assert k["missing"] == ["account"]
        assert k["skills_present"] is True
        base = next(s for s in k["skills"] if s["layer"] == "base")
        assert base["path"] == str(env.skills / f"{kind}-triage")
        assert base["files"] == [
            {"name": "SKILL.md", "path": str(env.skills / f"{kind}-triage" / "SKILL.md"), "present": True}
        ]
        custom = next(s for s in k["skills"] if s["layer"] == "custom")
        assert custom == {"name": f"{kind}-triage/custom", "path": str(env.skills / f"{kind}-triage" / "custom"),
                          "layer": "custom", "present": False, "files": []}


def test_configured(env, monkeypatch):
    for kind in ("email", "whatsapp", "calendar"):
        _skill(env, kind)
    _google(env, LEO, "leo@gmail.com", "email", "calendar")
    _imap(env, LEO, "leo@corp.example")
    _write(env.email_cfg, {"triage": _triage("email", env), "accounts": [
        {"id": "gmail", "address": "leo@gmail.com", "enabled": True},
        {"id": "corp", "address": "leo@corp.example", "auth": "password", "owner_user_id": "leo"},
    ]})
    owners.record_owner("leo", "leo", port=3002)
    _wa_session(env, "leo")
    _write(env.wa_cfg, {"triage": _triage("whatsapp", env), "phones": [
        {"id": "phone1", "name": "Leo", "number": "85291234567", "bridge_port": 3002,
         "session_dir": str(env.home / "whatsapp" / "session-leo"), "enabled": True},
    ]})
    _write(env.cal_cfg, {"triage": _triage("calendar", env)})
    _calendar_db(env, [("primary", "leo@gmail.com", "Leo", 1)])

    out = status(monkeypatch, LEO, profile="hr")
    assert out["profile"] == "hr"
    k = kinds(out)
    assert {n: v["status"] for n, v in k.items()} == {n: ts.SET_UP for n in k}
    assert all(v["missing"] == [] for v in k.values())
    assert [(a["address"], a["auth"], a["credential"]) for a in k["email"]["accounts"]] == [
        ("leo@gmail.com", "xoauth2", True), ("leo@corp.example", "password", True)]
    phone = k["whatsapp"]["accounts"][0]
    assert phone["number"] == "+852****4567" and phone["credential"] is True
    assert k["calendar"]["accounts"][0]["address"] == "leo@gmail.com"
    assert k["email"]["services"][0] == {"unit": "hermes-email-poller.service", "state": "active"}


def test_partly_set_up_when_credential_missing(env, monkeypatch):
    _skill(env, "calendar")
    _write(env.cal_cfg, {"triage": _triage("calendar", env)})
    _calendar_db(env, [("primary", "leo@gmail.com", "Leo", 1)])
    k = kinds(status(monkeypatch, LEO))["calendar"]
    assert k["status"] == ts.PARTLY_SET_UP and k["missing"] == ["credential"]
    # An unowned legacy row is the install owner's alone, never a member's.
    assert kinds(status(monkeypatch, AMY))["calendar"]["status"] == ts.NOT_SET_UP


def test_own_mailbox_not_on_triage_is_partial(env, monkeypatch):
    _skill(env, "email")
    _imap(env, AMY, "amy@corp.example")
    _write(env.email_cfg, {"triage": _triage("email", env), "accounts": []})
    k = kinds(status(monkeypatch, AMY))["email"]
    assert k["status"] == ts.PARTLY_SET_UP and k["missing"] == ["triage"]
    assert k["accounts"][0]["in_triage"] is False


def test_other_users_mailbox_not_counted(env, monkeypatch):
    _skill(env, "email")
    _skill(env, "calendar")
    _imap(env, LEO, "leo@corp.example")
    _google(env, LEO, "leo@gmail.com", "email", "calendar")
    _write(env.email_cfg, {"triage": _triage("email", env), "accounts": [
        {"id": "gmail", "address": "leo@gmail.com"},
        {"id": "corp", "address": "leo@corp.example", "auth": "password", "owner_user_id": "leo"},
    ]})
    _write(env.cal_cfg, {"triage": _triage("calendar", env)})
    _calendar_db(env, [("primary", "leo@gmail.com", "Leo", 1)])
    owners.record_owner("leo", "leo", port=3002)
    _wa_session(env, "leo")
    _skill(env, "whatsapp")
    _write(env.wa_cfg, {"triage": _triage("whatsapp", env), "phones": [
        {"id": "phone1", "bridge_port": 3002, "enabled": True}]})

    amy = status(monkeypatch, AMY)
    dumped = json.dumps(amy)
    assert "leo@" not in dumped and "4567" not in dumped
    assert {k["kind"]: k["status"] for k in amy["kinds"]} == {
        "email": ts.NOT_SET_UP, "whatsapp": ts.NOT_SET_UP, "calendar": ts.NOT_SET_UP}
    assert kinds(status(monkeypatch, LEO))["email"]["status"] == ts.SET_UP
