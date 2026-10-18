"""hermes_cli.aquarium_probe — the checks `aquarium doctor` runs inside a release.

Real HTTP against a local server stands in for the model provider and Google;
the runtime-provider resolution and the credential store are swapped for
stand-ins so no real key or database is needed. No secret may reach stdout.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from hermes_cli import aquarium_probe as probe

KEY = "sk-test-SECRET-123"


class _Handler(BaseHTTPRequestHandler):
    status = 200
    seen: list = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        _Handler.seen.append((self.path, {k.lower(): v for k, v in self.headers.items()}))
        self.send_response(_Handler.status)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")


@pytest.fixture
def provider(monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Handler.seen = []
    base = f"http://127.0.0.1:{srv.server_address[1]}/v1"

    def use(**runtime):
        monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider",
                            lambda **kw: {"provider": "openrouter", "base_url": base, "api_key": KEY, **runtime})
    yield use
    srv.shutdown()


def _rows(capsys):
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


def test_model_key_accepted(provider, capsys):
    provider()
    _Handler.status = 200
    assert probe.model_key() == 0
    out = capsys.readouterr().out
    assert KEY not in out
    row = json.loads(out)
    assert row["status"] == "ok"
    path, headers = _Handler.seen[0]
    assert path == "/v1/models" and headers["authorization"] == f"Bearer {KEY}"


def test_model_key_rejected_has_a_fix(provider, capsys):
    provider()
    _Handler.status = 401
    assert probe.model_key() == 1
    (row,) = _rows(capsys)
    assert row["status"] == "fail" and "rejected" in row["message"] and row["fix"]


def test_anthropic_uses_x_api_key(provider, capsys):
    provider(api_mode="anthropic_messages")
    _Handler.status = 200
    assert probe.model_key() == 0
    path, headers = _Handler.seen[0]
    assert path == "/v1/models" and headers["x-api-key"] == KEY and "authorization" not in headers


def test_model_key_missing(monkeypatch, capsys):
    monkeypatch.setattr("hermes_cli.runtime_provider.resolve_runtime_provider",
                        lambda **kw: {"provider": "openrouter", "base_url": "http://x", "api_key": ""})
    assert probe.model_key() == 1
    assert _rows(capsys)[0]["status"] == "fail"


def test_google_reports_each_account_without_secrets(monkeypatch, capsys):
    creds = [
        SimpleNamespace(kind="google-oauth2", name="leo@example.com", owner_user_id="leo",
                        payload={"client_id": "c", "client_secret": "cs", "refresh_token": "GOOD-RT"}),
        SimpleNamespace(kind="google-oauth2", name="amy@example.com", owner_user_id="amy",
                        payload={"client_id": "c", "client_secret": "cs", "refresh_token": "BAD-RT"}),
    ]

    async def fake_list():
        return creds

    def fake_refresh(*, client_id, client_secret, refresh_token):
        if refresh_token == "BAD-RT":
            raise RuntimeError("invalid_grant: Token has been expired or revoked.")
        return {"access_token": "AT"}

    monkeypatch.setattr(probe, "_google_credentials", fake_list)
    monkeypatch.setattr("hermes_cli.google_oauth.refresh_access_token", fake_refresh)
    assert probe.google() == 1
    out = capsys.readouterr().out
    assert "GOOD-RT" not in out and "BAD-RT" not in out and '"cs"' not in out
    rows = [json.loads(line) for line in out.splitlines()]
    assert [r["status"] for r in rows] == ["ok", "fail"]
    assert "amy@example.com" in rows[1]["message"] and "reconnect" in rows[1]["fix"]


def test_google_none_connected(monkeypatch, capsys):
    async def none():
        return []

    monkeypatch.setattr(probe, "_google_credentials", none)
    assert probe.google() == 0
    assert _rows(capsys)[0]["status"] == "ok"


def test_migrate_without_database_only_migrates_config(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text("model: x\n")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setattr("hermes_cli.datastore.get_store",
                        lambda *a, **kw: SimpleNamespace(dsn=None))
    assert probe.migrate() == 0
    rows = _rows(capsys)
    assert [r["check"] for r in rows] == ["config", "database"]
    assert all(r["status"] == "ok" for r in rows)


def test_migrate_reads_the_owner_address_from_stdin(monkeypatch):
    import io

    seen = []
    monkeypatch.setattr(probe, "migrate", lambda admin_dsn="": seen.append(admin_dsn) or 0)
    monkeypatch.setattr("sys.stdin", io.StringIO("HERMES_DB_ADMIN_URL=postgresql://owner@db/x\n"))
    assert probe.main(["migrate", "--dsn-stdin"]) == 0
    assert seen == ["postgresql://owner@db/x"]
