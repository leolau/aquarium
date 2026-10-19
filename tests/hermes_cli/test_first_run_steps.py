"""First-run setup steps (/api/setup/model, /region, /domain) on a real temp HERMES_HOME.

config.yaml, .env, the token file and the done marker are real; only the network
(provider key probe, the one test message, DNS and the HTTPS probe) is replaced.
"""
from __future__ import annotations

import pytest
import yaml

from hermes_cli import first_run, first_run_steps
from tests.hermes_cli.test_first_run import PASSWORD, FakeAdmin, FakeStore

KEY = "sk-or-v1-test-key-not-real"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    return tmp_path


@pytest.fixture
def client(home, monkeypatch):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    store, admin = FakeStore(), FakeAdmin()
    monkeypatch.setattr(web_server, "_setup_owner_deps", lambda: (store, admin, {}))
    monkeypatch.setattr(first_run_steps, "STEP_THROTTLE",
                        first_run.RedeemThrottle(max_attempts=40, window_seconds=300))
    monkeypatch.setattr(web_server, "_probe_provider_credential",
                        lambda key, value: {"ok": value == KEY, "reachable": True, "message": ""})
    calls = []

    def fake_test(scope, task, provider, model, profile):
        from hermes_cli.config import get_env_value, load_config

        cfg = load_config()["model"]
        calls.append(cfg)
        ok = get_env_value("OPENROUTER_API_KEY") == KEY and not getattr(fake_test, "fail", False)
        return {"ok": ok, "model": cfg.get("default"), "latency_ms": 1200,
                "error": f"401 bad key {KEY}" if not ok else ""}

    monkeypatch.setattr(web_server, "_run_model_test_sync", fake_test)
    test_client = TestClient(web_server.app)
    test_client.fake_test, test_client.calls = fake_test, calls
    return test_client


def _config(home):
    path = home / "config.yaml"
    return yaml.safe_load(path.read_text()) if path.exists() else {}


def _env(home):
    path = home / ".env"
    return path.read_text() if path.exists() else ""


STEPS = [
    ("/api/setup/model", {"provider": "openrouter", "api_key": KEY}),
    ("/api/setup/region", {"timezone": "Asia/Hong_Kong", "language": "zh-Hant"}),
    ("/api/setup/domain", {"host": "aquarium.example.com"}),
]


def test_steps_are_public_paths():
    from hermes_cli.dashboard_auth.public_paths import PUBLIC_API_PATHS

    assert {p for p, _ in STEPS} <= PUBLIC_API_PATHS


@pytest.mark.parametrize("path,body", STEPS)
def test_steps_refuse_without_a_minted_token(client, home, path, body):
    # The existing Hetzner box never ran `hermes setup-link`: nothing changes.
    for token in (None, "", "x" * 43):
        payload = dict(body, **({} if token is None else {"token": token}))
        response = client.post(path, json=payload)
        assert response.status_code == 400
        assert response.json()["detail"] == first_run.NEUTRAL_DETAIL
    assert "OPENROUTER_API_KEY" not in _env(home)
    assert "timezone" not in _config(home) or _config(home)["timezone"] == ""


@pytest.mark.parametrize("path,body", STEPS)
def test_steps_refuse_after_the_owner_exists(client, home, path, body):
    link = first_run.mint("admin", ttl=3600)
    created = client.post("/api/setup/owner",
                          json={"token": link.token, "email": "o@example.com", "password": PASSWORD})
    assert created.status_code == 200
    assert first_run_steps.is_done()
    # The used link and a freshly minted one (password reset) both refuse the steps.
    fresh = first_run.mint("admin", ttl=3600)
    assert client.post("/api/setup/check", json={"token": fresh.token}).json() == {
        "ok": True, "steps": False}
    for token in (link.token, fresh.token):
        response = client.post(path, json=dict(body, token=token))
        assert response.status_code == 400
        assert response.json()["detail"] == first_run.NEUTRAL_DETAIL


@pytest.mark.parametrize("path,body", STEPS)
def test_steps_refuse_an_expired_link(client, home, path, body):
    from datetime import datetime, timedelta, timezone

    link = first_run.mint("admin", ttl=60, now=datetime.now(timezone.utc) - timedelta(hours=1))
    response = client.post(path, json=dict(body, token=link.token))
    assert response.status_code == 400


def test_model_step_saves_key_and_recommended_model(client, home):
    link = first_run.mint("admin", ttl=3600)
    response = client.post("/api/setup/model",
                           json={"token": link.token, "provider": "openrouter", "api_key": KEY})
    body = response.json()
    assert response.status_code == 200 and body["ok"] is True
    assert body["model"] == first_run_steps.recommended_model("openrouter") != ""
    assert body["latency_ms"] == 1200
    assert KEY not in response.text
    assert f"OPENROUTER_API_KEY={KEY}" in _env(home)
    model = _config(home)["model"]
    assert model["provider"] == "openrouter"
    assert model["default"] == body["model"]
    # The step does not use up the link: the owner can still be created after it.
    assert first_run.check(link.token)


def test_model_step_rejected_key_saves_nothing(client, home):
    link = first_run.mint("admin", ttl=3600)
    response = client.post("/api/setup/model",
                           json={"token": link.token, "provider": "openrouter", "api_key": "sk-wrong"})
    assert response.json() == {"ok": False, "error": "key_rejected"}
    assert "OPENROUTER_API_KEY" not in _env(home)
    assert client.calls == []


def test_model_step_failed_test_restores_previous_key_and_model(client, home):
    from hermes_cli.config import load_config, save_config, save_env_value

    save_env_value("OPENROUTER_API_KEY", "sk-previous")
    cfg = load_config()
    cfg["model"] = {"provider": "openrouter", "default": "previous/model"}
    save_config(cfg)
    client.fake_test.fail = True
    link = first_run.mint("admin", ttl=3600)
    response = client.post("/api/setup/model",
                           json={"token": link.token, "provider": "openrouter", "api_key": KEY})
    body = response.json()
    assert body["ok"] is False and body["error"] == "test_failed"
    assert KEY not in response.text
    assert "OPENROUTER_API_KEY=sk-previous" in _env(home)
    assert _config(home)["model"]["default"] == "previous/model"


def test_model_step_rejects_unknown_provider_and_empty_key(client):
    link = first_run.mint("admin", ttl=3600)
    unknown = client.post("/api/setup/model",
                          json={"token": link.token, "provider": "nous", "api_key": KEY})
    empty = client.post("/api/setup/model",
                        json={"token": link.token, "provider": "openrouter", "api_key": " "})
    assert unknown.status_code == 400 and empty.status_code == 400


def test_region_step_writes_config_yaml_not_env(client, home):
    link = first_run.mint("admin", ttl=3600)
    response = client.post("/api/setup/region", json={
        "token": link.token, "timezone": "Asia/Taipei", "language": "zh-Hant"})
    assert response.status_code == 200
    cfg = _config(home)
    assert cfg["timezone"] == "Asia/Taipei"
    assert cfg["agent_home"]["language"] == "zh-Hant"
    assert "Asia/Taipei" not in _env(home)


@pytest.mark.parametrize("tz,lang", [("Mars/Base", "en"), ("", "en"), ("Asia/Hong_Kong", "fr")])
def test_region_step_rejects_bad_values(client, home, tz, lang):
    link = first_run.mint("admin", ttl=3600)
    response = client.post("/api/setup/region",
                           json={"token": link.token, "timezone": tz, "language": lang})
    assert response.status_code == 400
    assert "timezone" not in _config(home) or _config(home)["timezone"] == ""


def test_domain_step_is_read_only_and_reports(client, home, monkeypatch):
    monkeypatch.setattr(first_run_steps, "server_addresses", lambda: ["203.0.113.7"])
    monkeypatch.setattr(first_run_steps, "resolve",
                        lambda host: ["203.0.113.7"] if host == "aquarium.example.com" else ["198.51.100.1"])
    probed = []
    monkeypatch.setattr(first_run_steps, "https_ready", lambda host: probed.append(host) or True)
    # check_domain binds its defaults at definition time; route through the patched names.
    monkeypatch.setattr(first_run_steps, "check_domain",
                        lambda host, _orig=first_run_steps.check_domain: _orig(
                            host, addresses=first_run_steps.server_addresses(),
                            resolver=first_run_steps.resolve,
                            https_probe=first_run_steps.https_ready))
    link = first_run.mint("admin", ttl=3600)
    before = sorted(p.name for p in home.rglob("*"))
    here = client.post("/api/setup/domain", json={"token": link.token, "host": "https://Aquarium.Example.com/"})
    assert here.json() == {"ok": True, "host": "aquarium.example.com", "resolves": True,
                           "points_here": True, "https_ready": True,
                           "server_addresses": ["203.0.113.7"]}
    elsewhere = client.post("/api/setup/domain", json={"token": link.token, "host": "other.example.com"})
    assert elsewhere.json()["points_here"] is False and elsewhere.json()["https_ready"] is False
    # HTTPS is never probed for a name that does not point here.
    assert probed == ["aquarium.example.com"]
    assert sorted(p.name for p in home.rglob("*")) == before
    bad = client.post("/api/setup/domain", json={"token": link.token, "host": "not a host"})
    assert bad.status_code == 400


@pytest.mark.parametrize("provider", sorted(first_run_steps.SETUP_PROVIDERS))
def test_every_setup_provider_has_a_recommended_model(provider):
    assert first_run_steps.recommended_model(provider)


def test_normalize_host():
    assert first_run_steps.normalize_host("HTTPS://a.Example.com:443/x") == "a.example.com"
    for raw in ("", "localhost", "a..b", "-a.com", "a b.com"):
        assert first_run_steps.normalize_host(raw) == ""
