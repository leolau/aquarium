"""/api/backups/offsite — Get ready item 10, owner only.

Real path: the router runs the real ``deploy/aquarium.py offsite <verb>`` (instead of
``sudo -n /usr/local/sbin/aquarium``) against a fake root, with a fake systemctl and a local
S3 server (moto). Checks the role gate, that secrets never come back, and the page states.
"""
from __future__ import annotations

import json
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

boto3 = pytest.importorskip("boto3")
moto_server = pytest.importorskip("moto.server")

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy" / "aquarium.py"

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)
KEY_ID, SECRET = "AKIATESTKEY9876", "s3cr3t-NEVER-SHOWN"

ROUTES = [
    ("GET", "/api/backups/offsite", None),
    ("PUT", "/api/backups/offsite", {"provider": "other", "bucket": "abc", "key_id": "abcd", "secret": "x"}),
    ("DELETE", "/api/backups/offsite", None),
    ("POST", "/api/backups/offsite/test", None),
    ("POST", "/api/backups/offsite/run", None),
    ("POST", "/api/backups/offsite/restore-test", None),
]


@pytest.fixture(scope="module")
def s3_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
    srv.start()
    yield f"http://127.0.0.1:{port}"
    srv.stop()


@pytest.fixture
def root(tmp_path, monkeypatch):
    """A fake box: the helper runs for real under AQUARIUM_TEST_PREFIX."""
    from hermes_cli import backup_offsite_api

    root = tmp_path / "root"
    (root / "etc/aquarium").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls.log"
    calls.write_text("")
    fake = bin_dir / "systemctl"
    fake.write_text(f"#!/bin/sh\necho \"systemctl $*\" >> {calls}\nexit 0\n")
    fake.chmod(0o755)
    monkeypatch.setenv("AQUARIUM_TEST_PREFIX", str(root))
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setattr(backup_offsite_api, "_helper_argv",
                        lambda verb: [sys.executable, str(CLI), "offsite", verb])
    return SimpleNamespace(root=root, calls=calls)


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
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.mark.parametrize("who", [ADMIN, MEMBER, VIEWER], ids=["admin", "member", "viewer"])
@pytest.mark.parametrize("method,path,body", ROUTES, ids=[f"{m} {p}" for m, p, _ in ROUTES])
def test_only_the_owner_may_touch_backups(client, acting, root, who, method, path, body):
    acting["as"] = who
    resp = client.request(method, path, json=body) if body else client.request(method, path)
    assert resp.status_code == 403, resp.text
    assert root.calls.read_text() == ""
    assert not (root.root / "etc/aquarium/offsite.env").exists()


def test_without_the_helper_the_page_says_unavailable(client, monkeypatch):
    from hermes_cli import backup_offsite_api

    monkeypatch.setattr(backup_offsite_api, "_helper_argv", lambda verb: ["/nonexistent/aquarium", verb])
    resp = client.get("/api/backups/offsite")
    assert resp.status_code == 200 and resp.json()["state"] == "unavailable"
    assert client.post("/api/backups/offsite/run").status_code == 503
    # sudo refusing (no rule installed, e.g. the existing box) looks the same
    monkeypatch.setattr(backup_offsite_api, "_helper_argv", lambda verb: ["/bin/false"])
    assert client.get("/api/backups/offsite").json()["state"] == "unavailable"


def test_not_configured_runs_nothing(client, root):
    st = client.get("/api/backups/offsite").json()
    assert st["available"] is True and st["state"] == "not_configured" and st["target"] is None
    resp = client.post("/api/backups/offsite/run")
    assert resp.status_code == 400 and "no offsite storage" in resp.json()["detail"]
    assert "start" not in root.calls.read_text()


def test_owner_sets_up_storage_and_never_sees_the_secret_again(client, root, s3_url):
    s3 = boto3.client("s3", endpoint_url=s3_url, region_name="us-east-1",
                      aws_access_key_id=KEY_ID, aws_secret_access_key=SECRET)
    s3.create_bucket(Bucket="owner-backups")
    body = {"provider": "other", "endpoint": s3_url, "bucket": "owner-backups", "key_id": KEY_ID,
            "secret": SECRET}
    bad = client.put("/api/backups/offsite", json=dict(body, bucket="missing-bucket"))
    assert bad.status_code == 400 and "bucket was not found" in bad.json()["detail"]
    resp = client.put("/api/backups/offsite", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["new_key"] and data["status"]["state"] == "needs_first_backup"
    assert data["status"]["target"]["key_id_hint"] == "…9876"
    st = client.get("/api/backups/offsite")
    for text in (st.text, json.dumps(data["status"])):
        assert SECRET not in text and KEY_ID not in text
    assert "new_key" not in client.put("/api/backups/offsite", json=dict(body, secret="")).json()
    run = client.post("/api/backups/offsite/run")
    assert run.status_code == 202 and run.json()["started"] is True
    assert run.json()["status"]["state"] == "running"
    assert "start --no-block hermes-offsite-backup.service" in root.calls.read_text()
    again = client.post("/api/backups/offsite/run")
    assert again.status_code == 202 and again.json()["started"] is False
    assert client.post("/api/backups/offsite/test").json()["last_check"]["ok"] is True
    gone = client.delete("/api/backups/offsite")
    assert gone.status_code == 200 and gone.json()["state"] == "not_configured"


@pytest.mark.parametrize("raw,state", [
    ({"configured": True}, "needs_first_backup"),
    ({"configured": True, "running": {"kind": "backup"}}, "running"),
    ({"configured": True, "last_backup": {"ok": False}, "last_good_backup": {"ok": True, "at": "2099-01-01T00:00:00+00:00"}},
     "backup_failed"),
    ({"configured": True, "last_good_backup": {"ok": True, "at": "2000-01-01T00:00:00+00:00"}}, "backup_late"),
    ({"configured": True, "last_good_backup": {"ok": True, "at": "2000-01-01T00:00:00+00:00"},
      "schedule": {"enabled": False}}, "needs_restore_test"),
    ({"configured": True, "last_good_backup": {"ok": True, "at": "2099-01-01T00:00:00+00:00"},
      "last_restore_test": {"ok": False}}, "restore_test_failed"),
    ({"configured": True, "last_good_backup": {"ok": True, "at": "2099-01-01T00:00:00+00:00"},
      "last_restore_test": {"ok": True}}, "ok"),
])
def test_page_state(raw, state):
    from hermes_cli.backup_offsite_api import _view

    assert _view(raw)["state"] == state
