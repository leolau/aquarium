"""``hermes db migrate`` creates agent-home's private media bucket.

agent-home's push store (VAPID keys, device subscriptions) and chat uploads
live in this bucket, and nothing else creates it: a fresh install answered
``/api/notifications/vapid-public-key`` with 502. The fake Storage below
answers exactly as supabase/storage-api does (a missing bucket is a 400 with
``Bucket not found``, a duplicate one a 400 with ``BucketAlreadyExists``).
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Iterator

import pytest

from hermes_cli import db_migrate
from hermes_cli.filestore import SupabaseStorage

REPO = Path(__file__).resolve().parents[2]
SERVICE_KEY = "service-key-for-tests"


class FakeStorage:
    def __init__(self) -> None:
        self.buckets: dict[str, dict] = {}
        self.unavailable = 0  # answer this many requests with 503 (still starting)
        self.requests: list[tuple[str, str]] = []


def _handler(state: FakeStorage):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:
            pass

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _gate(self) -> bool:
            self.requests_entry()
            if self.headers.get("Authorization") != f"Bearer {SERVICE_KEY}":
                self._send(400, {"statusCode": "403", "error": "Unauthorized", "message": "invalid signature"})
                return False
            if state.unavailable:
                state.unavailable -= 1
                self._send(503, {"message": "name resolution failed"})
                return False
            return True

        def requests_entry(self) -> None:
            state.requests.append((self.command, self.path))

        def do_GET(self) -> None:
            if not self._gate():
                return
            name = self.path.removeprefix("/storage/v1/bucket/")
            if name in state.buckets:
                self._send(200, state.buckets[name])
            else:
                self._send(400, {"statusCode": "404", "error": "Bucket not found",
                                 "message": "Bucket not found", "code": "NoSuchBucket"})

        def do_POST(self) -> None:
            if not self._gate():
                return
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if body["id"] in state.buckets:
                self._send(400, {"statusCode": "409", "error": "Duplicate",
                                 "message": "The resource already exists",
                                 "code": "BucketAlreadyExists"})
                return
            state.buckets[body["id"]] = body
            self._send(200, {"name": body["id"]})

    return Handler


@pytest.fixture
def storage() -> Iterator[tuple[FakeStorage, str]]:
    state = FakeStorage()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(state))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield state, f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture(autouse=True)
def _no_ambient_storage(monkeypatch) -> None:
    for key in db_migrate.STORAGE_KEYS:
        monkeypatch.delenv(key, raising=False)


def _env(url: str, **extra: str) -> dict:
    return {"SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": SERVICE_KEY, **extra}


def test_missing_bucket_is_created_private_once(storage) -> None:
    state, url = storage
    client = SupabaseStorage(url=url, service_key=SERVICE_KEY)
    assert asyncio.run(client.ensure_bucket()) is True
    assert asyncio.run(client.ensure_bucket()) is False
    assert state.buckets == {
        "agent-home-media": {"id": "agent-home-media", "name": "agent-home-media", "public": False}
    }


def test_an_existing_bucket_is_left_as_it_is(storage) -> None:
    state, url = storage
    state.buckets["agent-home-media"] = {"id": "agent-home-media", "public": False, "file_size_limit": 5}
    assert asyncio.run(SupabaseStorage(url=url, service_key=SERVICE_KEY).ensure_bucket()) is False
    assert [method for method, _ in state.requests] == ["GET"]
    assert state.buckets["agent-home-media"]["file_size_limit"] == 5


def test_waits_for_a_storage_api_that_is_still_starting(storage) -> None:
    state, url = storage
    state.unavailable = 2
    assert asyncio.run(SupabaseStorage(url=url, service_key=SERVICE_KEY).ensure_bucket(wait=30)) is True
    assert "agent-home-media" in state.buckets


def test_a_wrong_key_is_an_error_not_a_skip(storage) -> None:
    _, url = storage
    with pytest.raises(RuntimeError, match="lookup failed"):
        asyncio.run(SupabaseStorage(url=url, service_key="wrong").ensure_bucket())


def test_migrate_adds_the_bucket_row_and_honours_the_bucket_name(storage) -> None:
    state, url = storage
    rows = db_migrate.migrate(
        config={}, storage_env=_env(url, AGENT_HOME_MEDIA_BUCKET="hsd-media"),
    )
    assert rows == [("box", "storage bucket hsd-media", None)]
    assert list(state.buckets) == ["hsd-media"]


def test_migrate_reads_storage_from_the_environment(storage, monkeypatch) -> None:
    # install-aquarium.sh runs migrate with hermes.env (SUPABASE_URL, the service key) loaded.
    state, url = storage
    for key, value in _env(url).items():
        monkeypatch.setenv(key, value)
    assert db_migrate.migrate(config={}) == [("box", "storage bucket agent-home-media", None)]
    assert list(state.buckets) == ["agent-home-media"]


def test_a_bucket_name_from_either_source_is_kept(storage, monkeypatch) -> None:
    state, url = storage
    monkeypatch.setenv("AGENT_HOME_MEDIA_BUCKET", "hsd-media")
    assert db_migrate.migrate(config={}, storage_env=_env(url)) == [
        ("box", "storage bucket hsd-media", None)
    ]
    assert list(state.buckets) == ["hsd-media"]


def test_deploy_keeps_the_owner_address_intact_without_a_final_newline(tmp_path: Path) -> None:
    script = (REPO / "deploy/hermes-deploy.sh").read_text()
    assert '{ cat "$DB_ADMIN_ENV"; echo; agent_home_storage_env; }' in script
    admin = tmp_path / "db-admin.env"
    admin.write_text("HERMES_DB_ADMIN_URL=postgresql://owner@db/x")  # no trailing newline
    out = subprocess.run(
        ["bash", "-c", 'agent_home_storage_env() { echo SUPABASE_URL=http://s; }\n'
                       f'{{ cat "{admin}"; echo; agent_home_storage_env; }}'],
        capture_output=True, text=True, check=True,
    ).stdout
    assert db_migrate.parse_dsn(out) == "postgresql://owner@db/x"
    assert db_migrate.parse_env(out)["SUPABASE_URL"] == "http://s"


def test_migrate_without_storage_settings_skips_the_bucket() -> None:
    assert db_migrate.migrate(config={}) == []


def test_migrate_reports_an_unreachable_storage(monkeypatch) -> None:
    monkeypatch.setattr(db_migrate, "STORAGE_WAIT_SECONDS", 0)
    rows = db_migrate.migrate(config={}, storage_env=_env("http://127.0.0.1:9"))
    assert rows[0][:2] == ("box", "storage bucket agent-home-media")
    assert "not reachable" in rows[0][2]


def test_cli_reads_storage_from_stdin_and_never_prints_the_key(storage, tmp_path: Path) -> None:
    state, url = storage
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text("model: x\n")
    env = {k: v for k, v in os.environ.items() if k not in db_migrate.STORAGE_KEYS}
    env["HERMES_HOME"] = str(home)
    proc = subprocess.run(
        [sys.executable, "-I", "-m", "hermes_cli.db_migrate", "--dsn-stdin"],
        input=(f"HERMES_DB_ADMIN_URL=postgresql://unused@127.0.0.1:9/x\n"
               f"SUPABASE_URL={url}\nSUPABASE_SERVICE_ROLE_KEY={SERVICE_KEY}\n"),
        env=env, cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    assert "storage bucket agent-home-media" in proc.stdout
    assert SERVICE_KEY not in proc.stdout + proc.stderr
    assert list(state.buckets) == ["agent-home-media"]


def test_deploy_passes_agent_home_storage_settings_to_migrate(tmp_path: Path) -> None:
    """Only the three storage keys, from agent-home's env files, later file winning."""
    script = (REPO / "deploy/hermes-deploy.sh").read_text()
    start = script.index("agent_home_storage_env() {")
    func = script[start:script.index("\n}\n", start) + 3]
    checkout, etc = tmp_path / "agent-home.env", tmp_path / "etc.env"
    checkout.write_text("AGENT_HOME_MEDIA_BUCKET=hsd-media\nSUPABASE_URL=http://old\n")
    etc.write_text("AGENT_HOME_SESSION_SECRET=s\nSUPABASE_URL=http://127.0.0.1:8000\n"
                   "SUPABASE_SERVICE_ROLE_KEY=k\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "systemctl").write_text(
        f"#!/bin/sh\necho '{checkout} (ignore_errors=yes)'\n"
        f"echo '{tmp_path / 'missing.env'} (ignore_errors=yes)'\necho '{etc} (ignore_errors=yes)'\n"
    )
    (bin_dir / "systemctl").chmod(0o755)
    out = subprocess.run(
        ["bash", "-c", f"set -euo pipefail\n{func}\nagent_home_storage_env"],
        env={"PATH": f"{bin_dir}:/usr/bin:/bin"},
        capture_output=True, text=True, check=True,
    ).stdout
    assert db_migrate.parse_env(out) == {
        "AGENT_HOME_MEDIA_BUCKET": "hsd-media",
        "SUPABASE_URL": "http://127.0.0.1:8000",
        "SUPABASE_SERVICE_ROLE_KEY": "k",
    }


def test_installer_migrates_with_the_storage_settings_loaded() -> None:
    script = (REPO / "install-aquarium.sh").read_text()
    app_env = script[script.index('cat > "$APP_ENV" <<ENV'):]
    app_env = app_env[:app_env.index("\nENV\n")]
    assert "\nSUPABASE_URL=" in app_env and "\nSUPABASE_SERVICE_ROLE_KEY=" in app_env
    assert (
        'run_env "$APP/.venv/bin/python" -I -m hermes_cli.db_migrate --dsn-stdin'
        " < /etc/aquarium/db-admin.env" in script
    )
