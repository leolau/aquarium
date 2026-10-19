"""Google step A: the owner saves and checks the install's OAuth client.

Real routes through the dashboard app against a throwaway ``HERMES_HOME``;
Google's token endpoint is a local HTTP server that answers the way Google
does (``invalid_grant`` for a known client, ``invalid_client`` otherwise).
"""

from __future__ import annotations

import json
import stat
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from urllib.parse import parse_qs

import pytest

GOOD_ID = "1234567890-abcdef.apps.googleusercontent.com"
GOOD_SECRET = "GOCSPX-good-secret"

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)


class _FakeGoogle(BaseHTTPRequestHandler):
    calls: list = []

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()}
        _FakeGoogle.calls.append(form)
        if form.get("client_id") == GOOD_ID and form.get("client_secret") == GOOD_SECRET:
            status, error = 400, "invalid_grant"
        else:
            status, error = 401, "invalid_client"
        payload = json.dumps({"error": error}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GCAL_CLIENT_ID", "GCAL_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)
    import hermes_constants

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def google(monkeypatch):
    from hermes_cli import google_oauth

    server = HTTPServer(("127.0.0.1", 0), _FakeGoogle)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    _FakeGoogle.calls = []
    monkeypatch.setattr(
        google_oauth, "TOKEN_URI", f"http://127.0.0.1:{server.server_port}/token"
    )
    yield _FakeGoogle
    server.shutdown()


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: state["as"].user_id if state["as"] else "",
    )
    return state


@pytest.fixture
def client(home, acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _client_file(home):
    return home / "google-workspace" / "client_secret.json"


ROUTES = [
    ("GET", "/api/google-client", None),
    ("PUT", "/api/google-client", {"client_id": GOOD_ID, "client_secret": GOOD_SECRET}),
    ("POST", "/api/google-client/test", None),
    ("PUT", "/api/google-client/steps", {"steps": {"1": True}}),
]


@pytest.mark.parametrize("who", [ADMIN, MEMBER, VIEWER], ids=["admin", "member", "viewer"])
@pytest.mark.parametrize("method,path,body", ROUTES, ids=[f"{m} {p}" for m, p, _ in ROUTES])
def test_only_the_owner_may_use_step_a(client, acting, google, home, who, method, path, body):
    acting["as"] = who
    resp = client.request(method, path, json=body) if body else client.request(method, path)
    assert resp.status_code == 403, resp.text
    assert not _client_file(home).exists()
    assert google.calls == []


def test_fresh_install_starts_empty(client):
    out = client.get("/api/google-client").json()
    assert out["configured"] is False
    assert out["steps"] == {n: False for n in "12345"}
    assert out["redirect_uri"] == "http://localhost:4321"
    assert "https://mail.google.com/" in out["scopes"]
    assert "openid" in out["scopes"]


def test_paste_saves_0600_file_load_google_client_reads(client, google, home):
    from hermes_cli.google_oauth import load_google_client

    resp = client.put(
        "/api/google-client", json={"client_id": GOOD_ID, "client_secret": GOOD_SECRET}
    )
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["saved"] is True and out["check"] == "ok"
    assert GOOD_SECRET not in resp.text
    assert GOOD_ID not in resp.text  # only a shortened hint goes back
    assert out["client"]["configured"] is True
    assert out["client"]["client_type"] == "installed"
    path = _client_file(home)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_google_client() == (GOOD_ID, GOOD_SECRET)
    assert google.calls[-1]["code"] == "aquarium-client-check"
    assert google.calls[-1]["redirect_uri"] == "http://localhost:4321"


def test_uploaded_web_json_is_kept_as_is(client, google, home):
    doc = {"web": {"client_id": GOOD_ID, "client_secret": GOOD_SECRET, "project_id": "aq"}}
    out = client.put("/api/google-client", json={"client_json": json.dumps(doc)}).json()
    assert out["saved"] is True
    assert json.loads(_client_file(home).read_text()) == doc
    assert out["client"]["client_type"] == "web"


def test_wrong_secret_is_reported_and_nothing_is_written(client, google, home):
    out = client.put(
        "/api/google-client", json={"client_id": GOOD_ID, "client_secret": "GOCSPX-wrong"}
    ).json()
    assert out == {"saved": False, "check": "invalid_client", "client": out["client"]}
    assert not _client_file(home).exists()


@pytest.mark.parametrize(
    "body",
    [
        {"client_id": "not-a-client", "client_secret": GOOD_SECRET},
        {"client_id": GOOD_ID, "client_secret": ""},
        {"client_json": "{not json"},
        {"client_json": json.dumps({"something": {}})},
    ],
)
def test_bad_input_is_refused_before_calling_google(client, google, home, body):
    resp = client.put("/api/google-client", json=body)
    assert resp.status_code == 400
    assert google.calls == []
    assert not _client_file(home).exists()


def test_existing_client_is_done_and_not_overwritten_without_replace(client, google, home):
    """An install that already has a client (the Hetzner box) keeps it."""
    path = _client_file(home)
    path.parent.mkdir(parents=True)
    original = json.dumps({"installed": {"client_id": GOOD_ID, "client_secret": GOOD_SECRET}})
    path.write_text(original)
    status = client.get("/api/google-client").json()
    assert status["configured"] is True and status["source"] == "file"
    other = "999-other.apps.googleusercontent.com"
    resp = client.put("/api/google-client", json={"client_id": other, "client_secret": "x"})
    assert resp.status_code == 409
    assert path.read_text() == original
    assert google.calls == []


def test_replace_keeps_a_backup_of_the_old_client(client, google, home):
    path = _client_file(home)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"installed": {"client_id": "old.apps.googleusercontent.com",
                                              "client_secret": "old"}}))
    out = client.put(
        "/api/google-client",
        json={"client_id": GOOD_ID, "client_secret": GOOD_SECRET, "replace": True},
    ).json()
    assert out["saved"] is True
    backups = list(path.parent.glob("client_secret.json.replaced-*"))
    assert len(backups) == 1
    assert "old.apps" in backups[0].read_text()
    assert stat.S_IMODE(backups[0].stat().st_mode) == 0o600


def test_env_client_counts_as_configured(client, monkeypatch):
    monkeypatch.setenv("GCAL_CLIENT_ID", GOOD_ID)
    monkeypatch.setenv("GCAL_CLIENT_SECRET", GOOD_SECRET)
    out = client.get("/api/google-client").json()
    assert out["configured"] is True and out["source"] == "env"
    assert client.put(
        "/api/google-client", json={"client_id": GOOD_ID, "client_secret": GOOD_SECRET}
    ).status_code == 409


def test_test_endpoint_checks_the_saved_client(client, google, home):
    assert client.post("/api/google-client/test").json()["check"] == "missing"
    path = _client_file(home)
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"installed": {"client_id": GOOD_ID, "client_secret": "bad"}}))
    out = client.post("/api/google-client/test").json()
    assert out["check"] == "invalid_client"
    assert out["client"]["last_check"]["result"] == "invalid_client"


def test_unreachable_google_saves_nothing(client, home, monkeypatch):
    from hermes_cli import google_oauth

    monkeypatch.setattr(google_oauth, "TOKEN_URI", "http://127.0.0.1:9/token")
    out = client.put(
        "/api/google-client", json={"client_id": GOOD_ID, "client_secret": GOOD_SECRET}
    ).json()
    assert out["saved"] is False and out["check"] == "unreachable"
    assert not _client_file(home).exists()


def test_step_ticks_are_stored_per_install(client):
    out = client.put("/api/google-client/steps", json={"steps": {"1": True, "3": True}}).json()
    assert out["steps"] == {"1": True, "2": False, "3": True, "4": False, "5": False}
    out = client.put("/api/google-client/steps", json={"steps": {"3": False}}).json()
    assert out["steps"]["1"] is True and out["steps"]["3"] is False
    assert client.get("/api/google-client").json()["steps"]["1"] is True
    assert client.put("/api/google-client/steps", json={"steps": {"9": True}}).status_code == 400
    assert client.put("/api/google-client/steps", json={"steps": {"1": "yes"}}).status_code == 400
