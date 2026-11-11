"""FG-37 W4: public one-time secret-link endpoints (hermes_cli/secret_links_api.py).

W1's registry (hermes_cli/secret_requests.py) is built in parallel; these tests
inject an in-memory registry with the documented signatures and semantics
(pending + unexpired lookup, single-use fulfil, owner taken from the row).
"""

from __future__ import annotations

import logging
import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import secret_links_api

TOKEN = "Q" * 43
SECRET = "ghp_VERY_SECRET_value_123"


class FakeRegistry(types.ModuleType):
    def __init__(self):
        super().__init__("hermes_cli.secret_requests")
        self.rows: dict = {}
        self.stored: list = []
        self.lock = threading.Lock()

    def add(self, token, *, home, kind="secret", ttl=900.0, username=None):
        Path(home, "secret_requests.db").touch()
        self.rows[token] = dict(
            id="sr_" + token[:4], home=str(home), owner_user_id="usr_mia", name="github_pat",
            label="GitHub token", purpose="Open the PR", kind=kind, username=username,
            status="pending", expires_at=time.time() + ttl,
        )

    def _row(self, token):
        from hermes_constants import get_hermes_home

        row = self.rows.get(token)
        if not row or row["home"] != str(Path(get_hermes_home()).resolve()):
            return None
        if row["status"] != "pending" or row["expires_at"] <= time.time():
            return None
        return row

    def get_by_token(self, token):
        row = self._row(token)
        return types.SimpleNamespace(**row) if row else None

    def fulfil_by_token(self, token, *, values):
        time.sleep(0.01)
        with self.lock:
            row = self._row(token)
            if row is None:
                raise LookupError("not pending")
            row["status"] = "stored"
            from hermes_constants import get_hermes_home

            self.stored.append((row["owner_user_id"], row["name"], dict(values), str(get_hermes_home())))
            return types.SimpleNamespace(**row)

    def decline(self, ref):
        row = self.rows.get(ref)
        if row and row["status"] == "pending":
            row["status"] = "declined"


@pytest.fixture
def registry(monkeypatch):
    fake = FakeRegistry()
    monkeypatch.setitem(sys.modules, "hermes_cli.secret_requests", fake)
    import hermes_cli

    monkeypatch.setattr(hermes_cli, "secret_requests", fake, raising=False)
    monkeypatch.setattr(
        secret_links_api, "_throttle",
        secret_links_api.RedeemThrottle(max_attempts=10, window_seconds=600.0, ip_max_attempts=30),
    )
    return fake


@pytest.fixture
def home():
    from hermes_constants import get_hermes_home

    h = Path(get_hermes_home()).resolve()
    h.mkdir(parents=True, exist_ok=True)
    return h


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(secret_links_api.router)
    return TestClient(app)


URL = f"/api/secret-links/{TOKEN}"


def _assert_private(resp):
    assert "no-store" in resp.headers["cache-control"]
    assert resp.headers["referrer-policy"] == "no-referrer"
    assert "noindex" in resp.headers["x-robots-tag"]


def test_get_describes_the_request(registry, home, client):
    registry.add(TOKEN, home=home)
    resp = client.get(URL)
    assert resp.status_code == 200
    body = resp.json()
    assert body["label"] == "GitHub token" and body["purpose"] == "Open the PR"
    assert body["kind"] == "secret" and body["username"] is None
    assert body["expires_at"] > time.time()
    assert set(body) == {"ok", "label", "purpose", "kind", "username", "expires_at"}
    _assert_private(resp)


def test_post_stores_once_for_the_owner_and_never_echoes(registry, home, client):
    registry.add(TOKEN, home=home)
    resp = client.post(URL, json={"values": {"value": SECRET}})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "status": "stored", "name": "github_pat"}
    assert SECRET not in resp.text
    _assert_private(resp)
    assert registry.stored == [("usr_mia", "github_pat", {"value": SECRET}, str(home))]

    again = client.post(URL, json={"values": {"value": "other"}})
    assert again.status_code == 404
    assert client.get(URL).status_code == 404
    assert len(registry.stored) == 1


def test_unknown_used_expired_and_declined_are_the_same_404(registry, home, client):
    used, expired, declined = "U" * 43, "E" * 43, "D" * 43
    registry.add(used, home=home)
    registry.add(expired, home=home, ttl=-1)
    registry.add(declined, home=home)
    client.post(f"/api/secret-links/{used}", json={"values": {"value": "x"}})
    client.post(f"/api/secret-links/{declined}", json={"decline": True})

    responses = []
    for tok in ("N" * 43, used, expired, declined, "short"):
        for method in ("get", "post"):
            kw = {"json": {"values": {"value": "x"}}} if method == "post" else {}
            responses.append(getattr(client, method)(f"/api/secret-links/{tok}", **kw))
    assert {r.status_code for r in responses} == {404}
    assert len({r.text for r in responses}) == 1
    for r in responses:
        _assert_private(r)


def test_decline_closes_the_request(registry, home, client):
    registry.add(TOKEN, home=home)
    resp = client.post(URL, json={"decline": True})
    assert resp.json() == {"ok": True, "status": "declined"}
    assert registry.rows[TOKEN]["status"] == "declined"
    assert registry.stored == []


@pytest.mark.parametrize(
    "body",
    [{"values": {}}, {"values": {"value": "   "}}, {"values": {"value": 5}}, {"values": {"bogus": "x"}},
     {"values": "x"}, {}, {"values": {"value": "x" * 9000}}],
)
def test_bad_values_are_rejected_and_leave_the_link_usable(registry, home, client, body):
    registry.add(TOKEN, home=home)
    assert client.post(URL, json=body).status_code == 400
    assert client.get(URL).status_code == 200


def test_password_kind_needs_a_password(registry, home, client):
    registry.add(TOKEN, home=home, kind="password", username="mia")
    assert client.get(URL).json()["username"] == "mia"
    assert client.post(URL, json={"values": {"username": "mia"}}).status_code == 400
    ok = client.post(URL, json={"values": {"username": "mia", "password": SECRET}})
    assert ok.status_code == 200 and SECRET not in ok.text


def test_racing_submits_store_exactly_once(registry, home, client):
    registry.add(TOKEN, home=home)
    with ThreadPoolExecutor(max_workers=6) as pool:
        codes = list(pool.map(
            lambda i: client.post(URL, json={"values": {"value": f"v{i}"}}).status_code, range(6)
        ))
    assert sorted(codes) == [200] + [404] * 5
    assert len(registry.stored) == 1


def test_per_ip_rate_limit(registry, home, client):
    codes = [client.get(f"/api/secret-links/{chr(65 + i % 26) * 43}{i}").status_code for i in range(32)]
    assert codes[:30] == [404] * 30
    assert codes[30:] == [429, 429]


def test_per_token_rate_limit(registry, home, client):
    registry.add(TOKEN, home=home)
    codes = [client.get(URL).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10 and codes[10] == 429


def test_token_in_another_profile_is_served_in_that_profile(registry, home, client):
    from hermes_cli.profiles import _get_profiles_root

    other = _get_profiles_root() / "coder"
    other.mkdir(parents=True)
    registry.add(TOKEN, home=other.resolve())
    assert client.get(URL).status_code == 200
    assert client.post(URL, json={"values": {"value": SECRET}}).status_code == 200
    assert registry.stored[0][3] == str(other.resolve())


def test_nothing_secret_is_logged(registry, home, client, caplog):
    registry.add(TOKEN, home=home)
    caplog.set_level(logging.DEBUG)
    client.get(URL)
    client.post(URL, json={"values": {"value": SECRET}})
    assert TOKEN not in caplog.text and SECRET not in caplog.text


def test_access_log_redacts_the_token():
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:5", "GET", f"/api/secret-links/{TOKEN}?x=1", "1.1", 200), None,
    )
    assert secret_links_api.SecretLinkAccessLogFilter().filter(record)
    assert TOKEN not in record.getMessage()
    assert "/api/secret-links/[redacted]" in record.getMessage()
    assert secret_links_api._ACCESS_FILTER in logging.getLogger("uvicorn.access").filters


def test_public_through_the_real_dashboard_auth(registry, home):
    """No session, no token: the dashboard app must let the link route through."""
    from hermes_cli.dashboard_auth.public_paths import is_public_api_path
    from hermes_cli.web_server import app

    assert is_public_api_path(URL)
    assert not is_public_api_path("/api/secret-links/")
    assert not is_public_api_path(f"/api/secret-links/{TOKEN}/extra")
    registry.add(TOKEN, home=home)
    c = TestClient(app)
    assert c.get(URL).status_code == 200
    assert c.get("/api/env").status_code == 401
