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
from tests.hermes_cli.test_fg28_chat_profile_auth import SUBJECT_HEADER, box, client  # noqa: F401

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


def _imap(env, who, address, password=SECRET):
    run(env.store.put(
        who, provider="imap", name=address, kind="email-imap", services=["email"],
        payload={"address": address, "username": address, "password": password,
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


def status(monkeypatch, who) -> dict:
    async def _caller(_request):
        return who

    monkeypatch.setattr(api, "_caller", _caller)
    out = run(api.get_triage_status(SimpleNamespace(query_params={}), target=None))
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

    out = status(monkeypatch, LEO)
    assert out["profile"] is None
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


def test_custom_overlay_skills_alone_count(env, monkeypatch):
    folder = env.skills / "calendar-triage" / "custom"
    folder.mkdir(parents=True)
    (folder / "mine.md").write_text("# mine\n")
    _google(env, LEO, "leo@gmail.com", "calendar")
    _write(env.cal_cfg, {"triage": _triage("calendar", env)})
    _calendar_db(env, [("primary", "leo@gmail.com", "Leo", 1)])
    k = kinds(status(monkeypatch, LEO))["calendar"]
    assert k["skills_present"] is True
    assert k["status"] == ts.SET_UP and k["missing"] == []


def test_legacy_whatsapp_session_dir_outside_hermes_home(env, monkeypatch, tmp_path):
    _skill(env, "whatsapp")
    legacy = tmp_path / "platforms" / "whatsapp" / "session-phone1"
    legacy.mkdir(parents=True)
    (legacy / "creds.json").write_text(json.dumps({"me": {"id": "85298765432:3@s.whatsapp.net"}}))
    _write(env.wa_cfg, {"triage": _triage("whatsapp", env), "phones": [
        {"id": "phone1", "bridge_port": 3000, "session_dir": str(legacy), "enabled": True}]})
    k = kinds(status(monkeypatch, LEO))["whatsapp"]
    assert k["status"] == ts.SET_UP
    phone = k["accounts"][0]
    assert phone["credential"] is True and phone["number"] == "+852****5432"
    assert not (env.home / "whatsapp" / "session-phone1").exists()


def test_shared_address_only_the_polled_owner_is_set_up(env, monkeypatch):
    """Report what runs: the poller logs in with one credential per address."""
    from custom import google_oauth
    from custom.email import email_poller

    for kind in ("email", "calendar"):
        _skill(env, kind)
    for who in (AMY, LEO):
        _google(env, who, "team@example.com", "email", "calendar")
        _imap(env, who, "shared@corp.example", password=f"{SECRET}-{who.user_id}")
        _imap(env, who, "owned@corp.example", password=f"{SECRET}-{who.user_id}")
    _write(env.email_cfg, {"triage": _triage("email", env), "accounts": [
        {"id": "team", "address": "team@example.com"},
        {"id": "shared", "address": "shared@corp.example", "auth": "password"},
        {"id": "owned", "address": "owned@corp.example", "auth": "password", "owner_user_id": "leo"}]})
    _write(env.cal_cfg, {"triage": _triage("calendar", env)})
    _calendar_db(env, [("team", "team@example.com", "Team", 1)])

    def pw_owner(account):
        return email_poller._mailbox_payload(account)["password"].rsplit("-", 1)[1]

    # Whose credential the real pollers pick for each account.
    polled = {
        "team@example.com": google_oauth.credentials_for_email("email", "team@example.com").owner_user_id,
        "shared@corp.example": pw_owner({"address": "shared@corp.example"}),
        "owned@corp.example": pw_owner({"address": "owned@corp.example", "owner_user_id": "leo"}),
    }
    cal_owner = google_oauth.credentials_for_email("calendar", "team@example.com").owner_user_id
    assert polled["owned@corp.example"] == "leo"

    for who in (AMY, LEO):
        k = kinds(status(monkeypatch, who))
        got = {a["address"]: (a["credential"], a["polled_by_other"]) for a in k["email"]["accounts"]}
        assert got == {
            addr: (owner == who.user_id, owner != who.user_id) for addr, owner in polled.items()
        }, who.user_id
        assert k["email"]["status"] == (
            ts.SET_UP if who.user_id in polled.values() else ts.PARTLY_SET_UP
        )
        cal = k["calendar"]
        if cal_owner == who.user_id:
            assert cal["status"] == ts.SET_UP and cal["missing"] == []
        else:
            assert cal["status"] == ts.PARTLY_SET_UP
            assert cal["missing"] == [ts.OTHER_POLLED]
            assert cal["accounts"][0]["polled_by_other"] is True

    # Someone without a credential for the address still doesn't see it.
    ben = Principal(user_id="ben", display="Ben", role="member")
    assert kinds(status(monkeypatch, ben))["calendar"]["accounts"] == []


def _box_paths(monkeypatch, tmp_path) -> SimpleNamespace:
    """Box-wide pipeline config for the cross-profile tests (``box`` fixture)."""
    data = tmp_path / "data"
    paths = SimpleNamespace(
        data=data,
        cal_cfg=data / "calendar" / "config.json",
        cal_db=data / "calendar" / "calendar_data.db",
        wa_cfg=data / "whatsapp-messages" / "config.json",
        skills=data / "skills",
    )
    monkeypatch.setenv("CALENDAR_CONFIG_PATH", str(paths.cal_cfg))
    monkeypatch.setenv("CALENDAR_DB_PATH", str(paths.cal_db))
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(data / "email-messages" / "config.json"))
    monkeypatch.delenv("WHATSAPP_BRIDGES", raising=False)
    monkeypatch.setattr(ts, "WHATSAPP_CONFIG_PATH", str(paths.wa_cfg))
    monkeypatch.setattr(owners, "_installed_bridge_ports", lambda: {})
    monkeypatch.setattr(ts, "unit_states", lambda units: {})
    return paths


def test_profile_param_reads_the_target_profiles_setup(box, client, monkeypatch, tmp_path):
    """``?profile=hr`` is scoped to hr: hr's credential store, hr's identity."""
    paths = _box_paths(monkeypatch, tmp_path)
    _skill(paths, "calendar")
    _write(paths.cal_cfg, {"triage": _triage("calendar", paths)})
    _calendar_db(paths, [("primary", "leo@hr.example", "Leo", 1)])
    hr_store = SimpleNamespace(store=FileCredentialStore(box["hr"] / "credentials"))
    _google(hr_store, Principal("leo", "Leo", "member"), "leo@hr.example", "calendar")

    def cal(resp):
        assert resp.status_code == 200, resp.text
        assert REFRESH not in resp.text and CLIENT_SECRET not in resp.text
        return kinds(resp.json())["calendar"]

    in_hr = client.get("/api/triage/status?profile=hr", headers={SUBJECT_HEADER: "leo"})
    assert in_hr.json()["profile"] == "hr"
    k = cal(in_hr)
    assert k["status"] == ts.SET_UP and k["accounts"][0]["credential"] is True

    # The acting (default) profile has no such credential: not hr's data.
    here = client.get("/api/triage/status", headers={SUBJECT_HEADER: "leo"})
    assert here.json()["profile"] is None
    assert cal(here)["status"] == ts.PARTLY_SET_UP

    # hr's member Dan holds no credential for it, and a non-enrollee is refused.
    assert cal(client.get("/api/triage/status?profile=hr", headers={SUBJECT_HEADER: "dan"}))["accounts"] == []
    assert client.get("/api/triage/status?profile=hr", headers={SUBJECT_HEADER: "bob"}).status_code == 403


def test_whatsapp_reads_the_target_profiles_bridges(box, client, monkeypatch, tmp_path):
    """Bridge owners and sessions come from the profile ``?profile=`` scopes to."""
    paths = _box_paths(monkeypatch, tmp_path)
    _skill(paths, "whatsapp")
    _write(paths.wa_cfg, {"triage": _triage("whatsapp", paths), "phones": [
        {"id": "root1", "bridge_port": 3002, "enabled": True},
        {"id": "hr1", "bridge_port": 3003, "enabled": True}]})
    for home, name, port, number in (
        (box["root"], "root1", 3002, "85211110000"),
        (box["hr"], "hr1", 3003, "85222220000"),
    ):
        _write(home / "whatsapp" / "bridge-owners.json", {name: {"user_id": "leo", "port": port}})
        _wa_session(SimpleNamespace(home=home), name, number=number)

    def wa(query, subject="leo"):
        resp = client.get(f"/api/triage/status{query}", headers={SUBJECT_HEADER: subject})
        assert resp.status_code == 200, resp.text
        return resp, kinds(resp.json())["whatsapp"]

    resp, k = wa("?profile=hr")
    assert [(a["id"], a["number"], a["credential"]) for a in k["accounts"]] == [
        ("hr1", "+852****0000", True)]
    assert k["status"] == ts.SET_UP
    assert "root1" not in resp.text and "1111" not in resp.text

    # hr1 is recorded by hr, so the acting profile never treats it as its own
    # unowned legacy phone.
    resp, k = wa("")
    assert [(a["id"], a["number"], a["credential"]) for a in k["accounts"]] == [
        ("root1", "+852****0000", True)]
    assert "hr1" not in resp.text and "2222" not in resp.text

    # Dan is hr's admin but owns no bridge there: nothing of Leo's leaks.
    resp, k = wa("?profile=hr", subject="dan")
    assert k["accounts"] == [] and "hr1" not in resp.text


def test_naming_the_acting_profile_returns_its_name(box, client, monkeypatch, tmp_path):
    from hermes_cli.profile_registry import get_profile_registry

    _box_paths(monkeypatch, tmp_path)
    acting = next(e.name for e in get_profile_registry() if e.hermes_home.resolve() == box["root"].resolve())
    resp = client.get(f"/api/triage/status?profile={acting}", headers={SUBJECT_HEADER: "leo"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["profile"] == acting
    assert client.get("/api/triage/status", headers={SUBJECT_HEADER: "leo"}).json()["profile"] is None


def test_another_profiles_phone_never_shows_as_legacy(box, client, monkeypatch, tmp_path):
    """hr's owner sees neither default's recorded phone nor box-wide legacy ones."""
    paths = _box_paths(monkeypatch, tmp_path)
    monkeypatch.setattr(owners, "_installed_bridge_ports", lambda: {"root1": 3002, "spare": 3009})
    _skill(paths, "whatsapp")
    _write(paths.wa_cfg, {"triage": _triage("whatsapp", paths), "phones": [
        {"id": "root1", "name": "Leo phone", "number": "85211110000", "bridge_port": 3002, "enabled": True},
        {"id": "spare", "name": "Front desk", "number": "85299990000", "bridge_port": 3009, "enabled": True}]})
    _write(box["root"] / "whatsapp" / "bridge-owners.json", {"root1": {"user_id": "leo", "port": 3002}})
    _wa_session(SimpleNamespace(home=box["root"]), "root1", number="85211110000")

    resp = client.get("/api/triage/status?profile=hr", headers={SUBJECT_HEADER: "hana"})
    assert resp.status_code == 200, resp.text
    assert kinds(resp.json())["whatsapp"]["accounts"] == []
    for leaked in ("Leo phone", "1111", "Front desk", "9999"):
        assert leaked not in resp.text

    # The acting profile's owner still owns the unrecorded legacy phone.
    resp = client.get("/api/triage/status", headers={SUBJECT_HEADER: "leo"})
    got = [a["id"] for a in kinds(resp.json())["whatsapp"]["accounts"]]
    assert got == ["root1", "spare"]


def test_can_edit_follows_the_role_in_the_addressed_profile(box, client, monkeypatch, tmp_path):
    _box_paths(monkeypatch, tmp_path)
    who = {
        ("leo", ""): True,         # owner of default
        ("bob", ""): False,        # member of default
        ("leo", "?profile=hr"): False,  # member in hr
        ("dan", "?profile=hr"): True,   # admin in hr
    }
    for (subject, query), expected in who.items():
        resp = client.get(f"/api/triage/status{query}", headers={SUBJECT_HEADER: subject})
        assert resp.status_code == 200, resp.text
        assert resp.json()["can_edit"] is expected, (subject, query)


def test_triage_skill_files_view_edit_history(box, client, monkeypatch, tmp_path):
    paths = _box_paths(monkeypatch, tmp_path)
    skill = _skill(paths, "email")
    (skill.parent / "escalation-rules.md").write_text("# rules v1\n")
    _write(paths.data / "email-messages" / "config.json", {"triage": _triage("email", paths)})
    target = str(skill.parent / "escalation-rules.md")
    q = {"kind": "email", "path": target}

    def get(subject, url="/api/triage/skill-file", **params):
        return client.get(url, params={**q, **params}, headers={SUBJECT_HEADER: subject})

    def put(subject, content, query=""):
        return client.put(f"/api/triage/skill-file{query}", json={**q, "content": content},
                          headers={SUBJECT_HEADER: subject})

    # Members view.
    r = get("bob")
    assert r.status_code == 200 and r.json()["content"] == "# rules v1\n" and r.json()["can_edit"] is False
    # Only listed triage files are addressable.
    outside = tmp_path / "secret.md"
    outside.write_text("nope")
    for bad in ({"path": str(outside)}, {"path": str(skill.parent / ".." / "secret.md")}, {"kind": "sms"}):
        assert get("leo", **bad).status_code == 404
    assert client.put("/api/triage/skill-file", json={**q, "path": str(outside), "content": "x"},
                      headers={SUBJECT_HEADER: "leo"}).status_code == 404
    assert outside.read_text() == "nope"

    # The server refuses members and viewers, in the addressed profile.
    assert put("bob", "member edit").status_code == 403
    assert put("leo", "hr member edit", "?profile=hr").status_code == 403
    assert (skill.parent / "escalation-rules.md").read_text() == "# rules v1\n"

    # Owners and admins edit; History keeps the pre-edit text and each save.
    r = put("leo", "# rules v2\n")
    assert r.status_code == 200, r.text
    assert put("dan", "# rules v3\n", "?profile=hr").status_code == 200
    assert (skill.parent / "escalation-rules.md").read_text() == "# rules v3\n"
    versions = get("bob", url="/api/triage/skill-file/history").json()["versions"]
    assert [v["content"] for v in versions] == ["# rules v3\n", "# rules v2\n", "# rules v1\n"]
    assert [v["author"] for v in versions] == ["user:dan", "user:leo", "system"]
    # History lives beside the file but is never loaded as a skill file.
    status = client.get("/api/triage/status", headers={SUBJECT_HEADER: "leo"}).json()
    files = [f["name"] for s in kinds(status)["email"]["skills"] for f in s["files"]]
    assert sorted(files) == ["SKILL.md", "escalation-rules.md"]


def _triage_file(tmp_path, text="# rules v1\n"):
    folder = tmp_path / "skills" / "email-triage"
    folder.mkdir(parents=True)
    file = folder / "escalation-rules.md"
    file.write_text(text)
    return file


def test_save_leaves_the_file_unchanged_when_history_cannot_be_recorded(box, client, monkeypatch, tmp_path):
    """Recording the version fails (``.versions`` can't be created): 500, file untouched."""
    paths = _box_paths(monkeypatch, tmp_path)
    skill = _skill(paths, "email")
    target = skill.parent / "escalation-rules.md"
    target.write_text("# rules v1\n")
    _write(paths.data / "email-messages" / "config.json", {"triage": _triage("email", paths)})
    (skill.parent / ts.VERSIONS_DIR).write_text("not a folder")

    r = client.put("/api/triage/skill-file", json={"kind": "email", "path": str(target), "content": "# rules v2\n"},
                   headers={SUBJECT_HEADER: "leo"})
    assert r.status_code == 500, r.text
    assert target.read_text() == "# rules v1\n"
    assert ts.file_history(target) == []
    assert sorted(p.name for p in skill.parent.iterdir()) == [ts.VERSIONS_DIR, "SKILL.md", "escalation-rules.md"]


def test_a_failed_append_is_rolled_back_and_the_file_kept(tmp_path, monkeypatch):
    """The History write itself fails midway: no partial version, file untouched."""
    file = _triage_file(tmp_path)
    ts.write_triage_file(file, "# rules v2\n", author="user:leo")
    hist = file.parent / ts.VERSIONS_DIR / f"{file.name}.jsonl"
    before = hist.read_bytes()

    real_fsync = ts.os.fsync

    def broken_fsync(fd):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(ts.os, "fsync", broken_fsync)
    with pytest.raises(ts.SkillFileError) as err:
        ts.write_triage_file(file, "# rules v3\n", author="user:leo")
    monkeypatch.setattr(ts.os, "fsync", real_fsync)
    assert err.value.status == 500
    assert file.read_text() == "# rules v2\n"
    assert hist.read_bytes() == before
    assert [v["content"] for v in ts.file_history(file)] == ["# rules v2\n", "# rules v1\n"]
    assert [p.name for p in file.parent.iterdir() if p.name.startswith(".escalation")] == []


def test_a_failed_swap_rolls_history_back(tmp_path, monkeypatch):
    """Recorded, then the file can't be replaced: the version is withdrawn."""
    file = _triage_file(tmp_path)

    def broken_replace(src, dst):
        raise OSError(13, "Permission denied")

    monkeypatch.setattr(ts.os, "replace", broken_replace)
    with pytest.raises(ts.SkillFileError):
        ts.write_triage_file(file, "# rules v2\n", author="user:leo")
    assert file.read_text() == "# rules v1\n"
    assert ts.file_history(file) == []
    assert [p.name for p in file.parent.iterdir() if p.name.startswith(".escalation")] == []


def test_every_saved_text_has_a_matching_history_entry(tmp_path):
    file = _triage_file(tmp_path)
    for n in (2, 3):
        version = ts.write_triage_file(file, f"# rules v{n}\n", author="user:leo")
        assert file.read_text() == version["content"] == ts.file_history(file)[0]["content"]
    assert [v["content"] for v in ts.file_history(file)] == ["# rules v3\n", "# rules v2\n", "# rules v1\n"]

