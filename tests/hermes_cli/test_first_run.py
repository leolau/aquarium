"""First-run setup link (hermes_cli/first_run.py) on a real temp HERMES_HOME.

The token file, its lock and the single-use claim run for real; GoTrue and the
principal store are small in-memory fakes because the point here is the token
boundary, not Postgres (the alias upsert itself is covered by the access tests).
"""
from __future__ import annotations

import asyncio
import json
import os
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import first_run
from hermes_cli.invitations import InvitationError
from hermes_cli.members import MemberConflictError

OWNER = SimpleNamespace(user_id="admin", display="Admin")
PASSWORD = "correct horse battery"


class FakeStore:
    def __init__(self, owner=OWNER, fail_link=False):
        self.owner, self.fail_link, self.aliases = owner, fail_link, {}
        self.app_store = object()

    async def get_owner(self):
        return self.owner

    async def link_alias(self, subject, user_id):
        if self.fail_link:
            raise RuntimeError("db down")
        self.aliases[subject] = user_id


class FakeAdmin:
    def __init__(self, conflict=False):
        self.conflict, self.users, self.deleted = conflict, {}, []

    def create_user(self, *, email, password, display=""):
        if self.conflict:
            raise MemberConflictError("exists")
        uid = f"sub-{len(self.users) + 1}"
        self.users[uid] = {"email": email, "password": password}
        return {"id": uid}

    def delete_user(self, *, user_id):
        self.deleted.append(user_id)
        self.users.pop(user_id, None)


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def _create(token, *, email="owner@example.com", password=PASSWORD, store=None, admin=None):
    return asyncio.run(first_run.create_owner(
        token=token, email=email, password=password,
        store=store or FakeStore(), admin=admin or FakeAdmin(),
    ))


def test_mint_stores_only_a_hash_in_a_private_file(home):
    link = first_run.mint("admin", ttl=3600)
    path = first_run.token_path()
    assert path == home / "auth" / "first_run_token.json"
    raw = path.read_text()
    assert link.token not in raw
    assert json.loads(raw)["owner_id"] == "admin"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert link.url("https://home.example.com/") == f"https://home.example.com/setup#token={link.token}"
    assert first_run.check(link.token)


def test_link_is_single_use_and_creates_the_owner(home):
    link = first_run.mint("admin", ttl=3600)
    store, admin = FakeStore(), FakeAdmin()
    assert _create(link.token, store=store, admin=admin) is True
    assert store.aliases == {"sub-1": "admin"}
    assert admin.users["sub-1"] == {"email": "owner@example.com", "password": PASSWORD}
    assert not first_run.check(link.token)
    assert _create(link.token) is False
    assert not first_run.token_path().exists()
    assert not first_run.token_path().with_suffix(".claimed").exists()


def test_wrong_expired_and_replaced_tokens_are_refused(home):
    link = first_run.mint("admin", ttl=3600)
    assert _create(link.token[:-1] + ("A" if link.token[-1] != "A" else "B")) is False
    assert _create("") is False
    later = datetime.now(timezone.utc) + timedelta(hours=2)
    assert first_run.claim(link.token, now=later) is None
    newer = first_run.mint("admin", ttl=3600)
    assert not first_run.check(link.token) and first_run.check(newer.token)


def test_default_lifetime_is_24_hours_and_configurable():
    assert first_run.ttl_seconds({}) == 24 * 3600
    assert first_run.ttl_seconds({"first_run": {"ttl_hours": 2}}) == 7200
    assert first_run.ttl_seconds({"first_run": {"ttl_hours": "nope"}}) == 24 * 3600
    assert first_run.ttl_seconds({"first_run": {"ttl_hours": -1}}) == 24 * 3600


@pytest.mark.parametrize("email, password", [("not-an-email", PASSWORD), ("owner@example.com", "short")])
def test_form_errors_keep_the_link(home, email, password):
    link = first_run.mint("admin", ttl=3600)
    with pytest.raises(InvitationError):
        _create(link.token, email=email, password=password)
    assert first_run.check(link.token)


def test_taken_email_keeps_the_link(home):
    link = first_run.mint("admin", ttl=3600)
    with pytest.raises(InvitationError, match="already exists"):
        _create(link.token, admin=FakeAdmin(conflict=True))
    assert first_run.check(link.token)


def test_failure_after_account_creation_rolls_back(home):
    link = first_run.mint("admin", ttl=3600)
    admin = FakeAdmin()
    with pytest.raises(RuntimeError):
        _create(link.token, store=FakeStore(fail_link=True), admin=admin)
    assert admin.deleted == ["sub-1"] and admin.users == {}
    assert first_run.check(link.token), "an outage costs a retry, not the link"


def test_token_for_another_owner_is_refused(home):
    link = first_run.mint("someone-else", ttl=3600)
    assert _create(link.token) is False
    assert first_run.check(link.token)


def test_dashboard_password_follows_the_owner(home):
    from hermes_cli.config import load_config, save_config
    from plugins.dashboard_auth.basic import BasicAuthProvider, _verify_password, hash_password

    config = load_config()
    config["dashboard"] = {"basic_auth": {"username": "admin", "password_hash": hash_password("placeholder-x"),
                                          "secret": "s" * 32}}
    save_config(config)
    provider = BasicAuthProvider(username="admin", password_hash=hash_password("placeholder-x"), secret=b"k" * 32)
    from hermes_cli.dashboard_auth import registry

    registry._providers.pop(provider.name, None)
    registry.register_provider(provider)
    try:
        link = first_run.mint("admin", ttl=3600)
        assert _create(link.token) is True
        stored = load_config()["dashboard"]["basic_auth"]["password_hash"]
        assert _verify_password(PASSWORD, stored)
        provider.complete_password_login(username="admin", password=PASSWORD)
    finally:
        registry._providers.pop(provider.name, None)


def test_no_dashboard_basic_auth_is_left_alone(home):
    from hermes_cli.config import load_config

    link = first_run.mint("admin", ttl=3600)
    assert _create(link.token) is True
    basic = (load_config().get("dashboard") or {}).get("basic_auth") or {}
    assert not basic.get("username") and not basic.get("password_hash")


# ------------------------------------------------------------------ HTTP endpoints
@pytest.fixture
def client(home, monkeypatch):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    store, admin = FakeStore(), FakeAdmin()
    monkeypatch.setattr(web_server, "_setup_owner_deps", lambda: (store, admin, {}))
    monkeypatch.setattr(first_run, "THROTTLE", first_run.RedeemThrottle(max_attempts=3, window_seconds=300))
    test_client = TestClient(web_server.app)
    test_client.store, test_client.admin = store, admin
    return test_client


def test_endpoints_are_public_paths():
    from hermes_cli.dashboard_auth.public_paths import PUBLIC_API_PATHS

    assert {"/api/setup/check", "/api/setup/owner"} <= PUBLIC_API_PATHS


def test_endpoints_refuse_everything_without_a_minted_token(client):
    # An existing install that never ran `hermes setup-link`.
    for path, body in [("/api/setup/check", {"token": "x" * 43}),
                       ("/api/setup/owner", {"token": "x" * 43, "email": "a@b.co", "password": PASSWORD}),
                       ("/api/setup/owner", {})]:
        response = client.post(path, json=body)
        assert response.status_code == 400
        assert response.json()["detail"] == first_run.NEUTRAL_DETAIL
    assert client.admin.users == {}


def test_owner_endpoint_end_to_end(client):
    link = first_run.mint("admin", ttl=3600)
    assert client.post("/api/setup/check", json={"token": link.token}).json() == {"ok": True, "steps": True}
    weak = client.post("/api/setup/owner", json={"token": link.token, "email": "o@example.com", "password": "x"})
    assert weak.status_code == 400 and "at least" in weak.json()["detail"]
    ok = client.post("/api/setup/owner", json={"token": link.token, "email": "o@example.com", "password": PASSWORD})
    assert ok.status_code == 200 and ok.json() == {"ok": True}
    assert client.store.aliases == {"sub-1": "admin"}
    again = client.post("/api/setup/owner", json={"token": link.token, "email": "p@example.com", "password": PASSWORD})
    assert again.status_code == 400 and again.json()["detail"] == first_run.NEUTRAL_DETAIL


def test_owner_endpoint_is_rate_limited_per_token(client):
    link = first_run.mint("admin", ttl=3600)
    for _ in range(3):
        client.post("/api/setup/check", json={"token": link.token})
    blocked = client.post("/api/setup/owner", json={"token": link.token, "email": "o@example.com", "password": PASSWORD})
    assert blocked.status_code == 400 and blocked.json()["detail"] == first_run.NEUTRAL_DETAIL
    assert client.admin.users == {} and first_run.check(link.token)


def test_cli_is_registered():
    import argparse

    parser = argparse.ArgumentParser()
    first_run.register_setup_link_subparser(parser.add_subparsers())
    args = parser.parse_args(["setup-link", "--origin", "https://home.example.com"])
    assert args.func is first_run.setup_link_command and args.origin == "https://home.example.com"


def test_cli_prints_a_working_link(home, monkeypatch, capsys):
    from hermes_cli import owner

    monkeypatch.setattr(owner, "_prod_store", lambda: FakeStore())
    args = SimpleNamespace(origin="https://home.example.com", ttl_hours=0)
    assert first_run.setup_link_command(args) == 0
    url = capsys.readouterr().out.strip()
    assert url.startswith("https://home.example.com/setup#token=")
    assert first_run.check(url.split("#token=", 1)[1])
    monkeypatch.setattr(owner, "_prod_store", lambda: FakeStore(owner=None))
    assert first_run.setup_link_command(args) == 1
    assert os.path.exists(first_run.token_path())
