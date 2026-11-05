"""/api/software-upgrade — Settings → Software upgrade (agent-home).

Owner starts and rolls back; admins read; members/viewers get 403 everywhere and the
root helper is never run for them. The status test runs the real
``deploy/aquarium.py upgrade status`` against an empty fake root; the others feed the
router helper answers. Also: release selection, release-note highlights, job shaping.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import software_upgrade_api as su

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy" / "aquarium.py"

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

READS = [("GET", "/api/software-upgrade", None), ("GET", "/api/software-upgrade/job", None),
         ("POST", "/api/software-upgrade/check", None)]
WRITES = [("POST", "/api/software-upgrade/start", {"version": "v1.1.0", "password": "pw"}),
          ("POST", "/api/software-upgrade/rollback", {"password": "pw"})]

STATUS = {
    "ok": True,
    "installed": {"layout": "release", "version": "v1.0.0", "commit": None, "branch": None,
                  "channel": "stable", "installed_at": "2026-10-01T10:00:00+00:00", "by": "Leo",
                  "label": "v1.0.0"},
    "job": {"id": "j1", "kind": "upgrade", "from": "v0.9.0", "to": "v1.0.0", "by": "Leo",
            "phase": "finished", "result": "failed", "alive": False, "backup": "/var/backups/x.gpg",
            "error": "build failed in /opt/aquarium/releases/.v1.0.0.partial/agent-home",
            "steps": [{"key": "download", "state": "done"}, {"key": "build", "state": "failed"}],
            "log": ["npm ERR! at /opt/aquarium/releases/v1.0.0/node_modules/x", "token=abc123 ok"]},
    "history": [{"id": "j1", "kind": "upgrade", "from": "v0.9.0", "to": "v1.0.0", "by": "Leo",
                 "result": "ok", "seconds": 61, "has_backup": True}],
    "releases_checked_at": "2026-11-05T01:00:00+00:00",
    "rollback": {"to": "v0.9.0"},
}
RELEASES = {"ok": True, "checked_at": "2026-11-05T02:00:00+00:00", "error": "", "releases": [
    {"tag": "v1.2.0-beta.1", "prerelease": True, "packaged": True, "notes": ""},
    {"tag": "v1.1.0", "name": "Spring", "prerelease": False, "packaged": True,
     "url": "https://github.com/leolau/aquarium/releases/tag/v1.1.0",
     "notes": "## Highlights\n- **Faster chats** (#12)\n## Fixes\n- [Upload](https://x) no longer fails\n"},
    {"tag": "v1.0.1", "prerelease": False, "packaged": False, "notes": ""},
    {"tag": "v0.9.0", "prerelease": False, "packaged": True, "url": "javascript:alert(1)", "notes": ""},
    {"tag": "nightly", "prerelease": False, "packaged": True, "notes": ""},
]}


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(web_server, "_comms_session_subject",
                        lambda request: state["as"].user_id if state["as"] else "")
    return state


@pytest.fixture
def helper(monkeypatch):
    """Records helper calls; answers from ``answers``."""
    calls = []
    answers = {"status": STATUS, "releases": RELEASES, "check": RELEASES,
               "start": {"ok": True, "started": True, "status": STATUS},
               "rollback": {"ok": True, "started": True, "status": STATUS}}

    def fake(verb, payload=None, timeout=60):
        calls.append((verb, payload))
        return answers[verb]

    monkeypatch.setattr(su, "_call", fake)
    return SimpleNamespace(calls=calls, answers=answers)


@pytest.fixture
def password_ok(monkeypatch):
    seen = []

    async def fake(request, password):
        seen.append(password)
        if password != "pw":
            from fastapi import HTTPException
            raise HTTPException(400, "That password is not right.")
        return "Owner"

    monkeypatch.setattr(su, "_confirm_owner", fake)
    return seen


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _send(client, method, path, body):
    return client.request(method, path, json=body) if body else client.request(method, path)


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
@pytest.mark.parametrize("method,path,body", READS + WRITES, ids=[f"{m} {p}" for m, p, _ in READS + WRITES])
def test_members_and_viewers_get_nothing(client, acting, helper, who, method, path, body):
    acting["as"] = who
    assert _send(client, method, path, body).status_code == 403
    assert helper.calls == []


@pytest.mark.parametrize("method,path,body", WRITES, ids=[f"{m} {p}" for m, p, _ in WRITES])
def test_admin_cannot_upgrade_or_roll_back(client, acting, helper, password_ok, method, path, body):
    acting["as"] = ADMIN
    assert _send(client, method, path, body).status_code == 403
    assert helper.calls == [] and password_ok == []


@pytest.mark.parametrize("method,path,body", READS, ids=[f"{m} {p}" for m, p, _ in READS])
def test_admin_reads(client, acting, helper, method, path, body):
    acting["as"] = ADMIN
    assert _send(client, method, path, body).status_code == 200


def test_status_has_no_paths_or_secrets(client, helper):
    body = client.get("/api/software-upgrade").json()
    text = json.dumps(body)
    assert "/opt/" not in text and "/var/" not in text and "abc123" not in text and "backup\"" not in text
    assert body["installed"] == {"version": "v1.0.0", "label": "v1.0.0", "commit": None, "kind": "release",
                                 "channel": "stable", "installed_at": "2026-10-01T10:00:00+00:00", "by": "Leo"}
    assert body["job"]["running"] is False and body["job"]["result"] == "failed"
    assert body["rollback_to"] == "v0.9.0" and body["checked_at"] == "2026-11-05T02:00:00+00:00"
    rel = body["releases"]
    # stable channel: no pre-release; release install: only packaged releases
    assert [r["tag"] for r in rel["newer"]] == ["v1.1.0"] and rel["latest"] == "v1.1.0"
    assert [r["tag"] for r in rel["older"]] == ["v0.9.0"] and rel["older"][0]["url"] == ""
    assert rel["newer"][0]["highlights"] == [{"title": "Highlights", "items": ["Faster chats"]},
                                             {"title": "Fixes", "items": ["Upload no longer fails"]}]


def test_owner_starts_with_the_password(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 202 and resp.json()["started"] is True
    assert helper.calls == [("start", {"version": "v1.1.0", "by": "Owner"})]


def test_wrong_password_starts_nothing(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "nope"})
    assert resp.status_code == 400 and "password" in resp.json()["detail"]
    assert helper.calls == []


def test_bad_version_is_refused_before_the_password(client, helper, password_ok):
    resp = client.post("/api/software-upgrade/start", json={"version": "latest && id", "password": "pw"})
    assert resp.status_code == 400 and password_ok == [] and helper.calls == []


def test_helper_refusal_is_shown_without_paths(client, helper, password_ok):
    helper.answers["start"] = {"ok": False, "error": "lock held by /run/aquarium.lock"}
    resp = client.post("/api/software-upgrade/start", json={"version": "v1.1.0", "password": "pw"})
    assert resp.status_code == 400 and "/run" not in resp.json()["detail"]


def test_rollback_needs_the_password_too(client, helper, password_ok):
    assert client.post("/api/software-upgrade/rollback", json={}).status_code == 422
    assert client.post("/api/software-upgrade/rollback", json={"password": "pw"}).status_code == 202
    assert helper.calls == [("rollback", {"by": "Owner"})]


def test_without_the_helper_the_page_says_unavailable(client, monkeypatch):
    monkeypatch.setattr(su, "_helper_argv", lambda verb: ["/nonexistent/aquarium", verb])
    assert client.get("/api/software-upgrade").json()["available"] is False
    monkeypatch.setattr(su, "_helper_argv", lambda verb: ["/bin/false"])  # sudo refused
    assert client.get("/api/software-upgrade").json()["available"] is False


def test_real_helper_status_on_an_empty_box(client, tmp_path, monkeypatch):
    monkeypatch.setenv("AQUARIUM_TEST_PREFIX", str(tmp_path))
    monkeypatch.setattr(su, "_helper_argv", lambda verb: [sys.executable, str(CLI), "upgrade", verb])
    body = client.get("/api/software-upgrade/job").json()
    assert body["available"] is True and body["job"] is None and body["history"] == []
    assert str(tmp_path) not in json.dumps(body)


# --------------------------------------------------------------------------- password re-check


def _request(session):
    return SimpleNamespace(state=SimpleNamespace(session=session), headers={},
                           client=SimpleNamespace(host="10.0.0.9"))


class _Provider:
    supports_password = True

    def __init__(self, user_id="root"):
        self.user_id, self.calls = user_id, []

    def complete_password_login(self, *, username, password):
        from hermes_cli.dashboard_auth.base import InvalidCredentialsError
        self.calls.append(username)
        if password != "right":
            raise InvalidCredentialsError("no")
        return SimpleNamespace(user_id=self.user_id)


@pytest.fixture
def provider(monkeypatch, acting):
    from hermes_cli import dashboard_auth
    from hermes_cli.dashboard_auth import routes

    p = _Provider()
    monkeypatch.setattr(dashboard_auth, "get_provider", lambda name: p if name == "supabase" else None)
    monkeypatch.setattr(routes, "_pw_attempts", type(routes._pw_attempts)(routes._pw_attempts.default_factory))
    return p


SESSION = SimpleNamespace(user_id="root", email="owner@example.com", provider="supabase", display_name="O")


def test_confirm_owner_checks_the_signed_in_users_password(provider):
    import asyncio

    assert asyncio.run(su._confirm_owner(_request(SESSION), "right")) == "Owner"
    assert provider.calls == ["owner@example.com"]
    with pytest.raises(Exception) as exc:
        asyncio.run(su._confirm_owner(_request(SESSION), "wrong"))
    assert exc.value.status_code == 400


def test_confirm_owner_refuses_someone_elses_password(provider):
    import asyncio

    provider.user_id = "someone-else"
    with pytest.raises(Exception) as exc:
        asyncio.run(su._confirm_owner(_request(SESSION), "right"))
    assert exc.value.status_code == 400


def test_confirm_owner_needs_a_password_login(provider):
    import asyncio

    for session in (None, SimpleNamespace(**{**vars(SESSION), "provider": "github"})):
        with pytest.raises(Exception) as exc:
            asyncio.run(su._confirm_owner(_request(session), "right"))
        assert exc.value.status_code == 403


def test_confirm_owner_is_rate_limited(provider):
    import asyncio

    codes = []
    for _ in range(12):
        try:
            asyncio.run(su._confirm_owner(_request(SESSION), "wrong"))
        except Exception as exc:  # noqa: BLE001
            codes.append(exc.status_code)
    assert codes[:10] == [400] * 10 and codes[10:] == [429, 429]


# --------------------------------------------------------------------------- selection + shaping


def test_version_order():
    tags = ["v1.10.0", "v1.2.0", "v1.2.0-beta.2", "v1.2.0-beta.10", "v1.2.0-rc.1", "v2.0.0"]
    assert sorted(tags, key=su.version_key) == [
        "v1.2.0-beta.2", "v1.2.0-beta.10", "v1.2.0-rc.1", "v1.2.0", "v1.10.0", "v2.0.0"]
    assert su.version_key("1.2.3") is None and su.version_key("v1.2") is None


def test_beta_channel_and_checkout_without_a_version():
    rels = RELEASES["releases"]
    beta = su.select_releases(rels, "v1.0.0", "beta")
    assert [r["tag"] for r in beta["newer"]] == ["v1.2.0-beta.1", "v1.1.0", "v1.0.1"]
    assert beta["latest"] == "v1.2.0-beta.1"
    branch = su.select_releases(rels, None, "stable")  # a develop checkout: every release is a target
    assert [r["tag"] for r in branch["newer"]] == ["v1.1.0", "v1.0.1", "v0.9.0"] and branch["older"] == []
    newest = su.select_releases(rels, "v1.1.0", "stable")
    assert newest["newer"] == [] and newest["latest"] is None


def test_job_steps_and_running_state():
    job = su._job_view({"id": "x", "phase": "running", "alive": True, "kind": "rollback",
                        "steps": [{"key": "backup", "state": "done"}, {"key": "download", "state": "running"},
                                  "junk"]})
    assert job["running"] is True and job["kind"] == "rollback"
    assert [(s["key"], s["state"]) for s in job["steps"]] == [("backup", "done"), ("download", "running")]
    died = su._job_view({"phase": "finished", "result": "interrupted", "alive": False})
    assert died["running"] is False and died["result"] == "interrupted"


def test_scrub():
    assert su.scrub("cp /opt/data/hermes-agent/x.py to /tmp/y failed") == "cp … to … failed"
    assert su.scrub("password=hunter2 and SECRET=abc") == "password=… and SECRET=…"
    assert su.scrub("https://github.com/leolau/aquarium/releases ok") == "https://github.com/leolau/aquarium/releases ok"
