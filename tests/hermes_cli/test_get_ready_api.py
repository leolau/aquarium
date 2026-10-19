"""P2 "Get ready" checklist API: per-person status, role gates, no secrets.

Real path: a temp ``HERMES_HOME`` with the file credential store; only the
login (principal) and host probes (systemctl for WhatsApp) are stubbed.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")

OWNER = SimpleNamespace(user_id="root", display="Leo", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

SECRET = "sk-or-v1-TOPSECRET-should-never-appear"


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(tmp_path / "email.json"))
    for name in (
        "DATABASE_URL",
        "SUPABASE_DB_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "GCAL_CLIENT_ID",
        "GCAL_CLIENT_SECRET",
        "TELEGRAM_BOT_TOKEN",
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    return home


@pytest.fixture
def acting(monkeypatch, home):
    from hermes_cli import get_ready, web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    async def _people(ctx):
        return [
            get_ready.Person("root", "Leo", "owner"),
            get_ready.Person("ann", "Ann", "admin"),
            get_ready.Person("mia", "Mia", "member"),
            get_ready.Person("amy", "Amy", "viewer", invited_pending=True),
        ]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server, "_comms_session_subject", lambda request: state["as"].user_id
    )
    monkeypatch.setattr(get_ready, "list_people", _people)
    monkeypatch.setattr(get_ready, "whatsapp_bridges", lambda: [])
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _put_vpn(principal, name="office"):
    from hermes_cli.credential_store import FileCredentialStore

    asyncio.run(
        FileCredentialStore().put(
            principal,
            provider="vpn",
            name=name,
            kind="fortinet-vpn",
            payload={"host": "vpn.example.com", "username": "u", "password": SECRET},
            visibility=f"private:{principal.user_id}",
        )
    )


def _items(payload):
    return {row["id"]: row for row in payload["items"]}


def test_owner_sees_all_eleven_items_in_three_groups(client):
    payload = client.get("/api/get-ready").json()
    assert [row["n"] for row in payload["items"]] == list(range(1, 12))
    groups = {row["id"]: row["group"] for row in payload["items"]}
    assert {k for k, g in groups.items() if g == "basics"} == {"owner", "model", "people"}
    assert {k for k, g in groups.items() if g == "safety"} == {"backups", "security"}
    assert payload["can_manage"] is True
    s = payload["summary"]
    assert s["done"] + s["attention"] + s["not_started"] == s["total"] == 11


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_and_viewer_see_only_their_connections(client, acting, who):
    acting["as"] = who
    payload = client.get("/api/get-ready").json()
    assert [row["n"] for row in payload["items"]] == [4, 5, 6, 7, 8, 9]
    assert all(row["per_person"] for row in payload["items"])
    assert payload["can_manage"] is False


def test_fresh_install_starts_empty(client):
    items = _items(client.get("/api/get-ready").json())
    for key in ("model", "google", "whatsapp", "telegram", "email", "tools", "vpn"):
        assert items[key]["status"] == "not_started", key
        assert items[key]["last_test"] is None


def test_vpn_status_is_each_persons_own(client, acting):
    _put_vpn(MEMBER)
    acting["as"] = MEMBER
    assert _items(client.get("/api/get-ready").json())["vpn"]["status"] == "attention"
    acting["as"] = ADMIN
    assert _items(client.get("/api/get-ready").json())["vpn"]["status"] == "not_started"
    acting["as"] = OWNER
    # The owner can read every row, but the checklist shows the owner's own.
    assert _items(client.get("/api/get-ready").json())["vpn"]["status"] == "not_started"


def test_model_key_presence_only_never_the_value(client, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    resp = client.get("/api/get-ready")
    model = _items(resp.json())["model"]
    assert model["status"] == "done"
    assert model["params"] == {"provider": "OpenRouter"}
    assert SECRET not in resp.text


def test_existing_install_wide_settings_count_as_the_owners(client, acting, monkeypatch, home, tmp_path):
    from hermes_cli.config import save_config

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    save_config(
        {"mcp_servers": {"app": {"url": "http://127.0.0.1:9220/mcp"}, "notion": {"url": "https://x"}}},
        strip_defaults=False,
    )
    (tmp_path / "email.json").write_text(
        json.dumps({"accounts": [{"address": "a@example.com", "enabled": True}]})
    )
    items = _items(client.get("/api/get-ready").json())
    assert items["telegram"]["status"] == "done"
    assert items["tools"]["status"] == "done"
    assert items["tools"]["params"] == {"count": 1}
    assert items["email"]["status"] == "done"
    acting["as"] = MEMBER
    items = _items(client.get("/api/get-ready").json())
    for key in ("telegram", "tools", "email", "whatsapp"):
        assert items[key]["status"] == "not_started" and items[key]["coming"], key


@pytest.mark.parametrize("item", ["owner", "model", "people", "backups", "security"])
@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_cannot_test_install_wide_items(client, acting, who, item):
    acting["as"] = who
    assert client.post(f"/api/get-ready/{item}/test").status_code == 403


def test_test_records_last_test_for_that_person_only(client, acting):
    acting["as"] = MEMBER
    resp = client.post("/api/get-ready/vpn/test")
    assert resp.status_code == 200
    body = resp.json()
    assert body["id"] == "vpn" and body["last_test"]["result"] == "bad"
    again = _items(client.get("/api/get-ready").json())["vpn"]
    assert again["last_test"]["at"] == body["last_test"]["at"]
    acting["as"] = ADMIN
    assert _items(client.get("/api/get-ready").json())["vpn"]["last_test"] is None


def test_unknown_item_is_404(client):
    assert client.post("/api/get-ready/nope/test").status_code == 404


def test_model_test_runs_a_real_round_trip(client, monkeypatch):
    from hermes_cli import get_ready

    calls = []
    monkeypatch.setenv("OPENROUTER_API_KEY", SECRET)
    monkeypatch.setattr(get_ready, "_run_model_test", lambda: calls.append(1) or {"ok": True})
    body = client.post("/api/get-ready/model/test").json()
    assert calls == [1]
    assert body["last_test"]["result"] == "ok"
    assert body["last_test"]["detail"] == "test.model_ok"
    monkeypatch.setattr(get_ready, "_run_model_test", lambda: {"ok": False, "error": SECRET})
    resp = client.post("/api/get-ready/model/test")
    assert resp.json()["last_test"]["result"] == "bad"
    assert SECRET not in resp.text


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_people_status_is_owner_admin_only(client, acting, who):
    acting["as"] = who
    assert client.get("/api/get-ready/people").status_code == 403


@pytest.mark.parametrize("who", [OWNER, ADMIN], ids=["owner", "admin"])
def test_people_status_shows_states_not_secrets(client, acting, who):
    _put_vpn(MEMBER)
    acting["as"] = who
    resp = client.get("/api/get-ready/people")
    assert resp.status_code == 200
    assert SECRET not in resp.text and "vpn.example.com" not in resp.text
    rows = {row["user_id"]: row for row in resp.json()["people"]}
    assert rows["mia"]["connections"]["vpn"] == {"state": "set"}
    assert rows["ann"]["connections"]["vpn"] == {"state": "not_set"}
    assert rows["mia"]["connections"]["google"] == {"state": "waiting", "reason": "step_a"}
    assert rows["mia"]["connections"]["telegram"] == {"state": "coming"}
    assert rows["amy"]["invited_pending"] is True
    assert rows[who.user_id]["is_you"] is True


def test_single_user_install_without_datastore_acts_as_owner(client, monkeypatch):
    from hermes_cli import web_server

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no DSN")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    payload = client.get("/api/get-ready").json()
    assert len(payload["items"]) == 11
    assert client.get("/api/get-ready/people").status_code == 200


def test_every_item_has_one_status_provider():
    from hermes_cli import get_ready

    assert set(get_ready.STATUS_PROVIDERS) == set(get_ready.ITEMS_BY_ID)


def test_owner_item_reflects_the_owners_two_factor_login(client, acting):
    import pyotp

    from hermes_cli import two_factor

    items = _items(client.get("/api/get-ready").json())
    assert items["owner"]["status"] == "attention"
    assert items["owner"]["detail"] == "owner.no_2fa" and not items["owner"]["coming"]
    secret = two_factor.start("root", "leo@example.com")["secret"]
    two_factor.confirm("root", pyotp.TOTP(secret).now())
    assert _items(client.get("/api/get-ready").json())["owner"]["status"] == "done"
    acting["as"] = ADMIN
    assert _items(client.get("/api/get-ready").json())["owner"]["status"] == "done"


def test_security_item_uses_security_basics_last_result(client, monkeypatch, home):
    from hermes_cli import security_basics

    items = _items(client.get("/api/get-ready").json())
    assert items["security"]["status"] == "not_started" and not items["security"]["coming"]
    saved = {"checked_at": "2026-10-19T10:00:00+00:00", "status": "attention",
             "passed": 5, "total": 7, "helper": "ok", "checks": []}
    (home / security_basics.STATE_NAME).write_text(json.dumps(saved), encoding="utf-8")
    items = _items(client.get("/api/get-ready").json())
    assert items["security"]["status"] == "attention"
    assert items["security"]["params"] == {"passed": 5, "total": 7}

    monkeypatch.setattr(security_basics, "run_test", lambda: {**saved, "status": "done", "passed": 7})
    body = client.post("/api/get-ready/security/test").json()
    assert body["last_test"]["result"] == "ok"
    assert body["last_test"]["params"] == {"passed": 7, "total": 7}
