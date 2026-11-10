"""One timeout lookup for every model call, and the owner/admin timeouts API."""

from __future__ import annotations

import textwrap
from types import SimpleNamespace

import pytest

from hermes_cli.timeouts import resolve_model_timeout


def _write_config(home, body: str) -> None:
    (home / "config.yaml").write_text(textwrap.dedent(body), encoding="utf-8")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


PROVIDERS = """\
model:
  provider: deepseek
  default: deepseek-v4-flash
providers:
  opencode-go:
    request_timeout_seconds: 90
    models:
      qwen3.8-max:
        timeout_seconds: 240
  deepseek:
    request_timeout_seconds: 45
"""


# -- resolve_model_timeout ----------------------------------------------------


def test_explicit_beats_everything(home):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout(
        "opencode-go", "qwen3.8-max", explicit=12, task_timeout=300, task_default=120
    ) == 12.0


def test_a_task_timeout_the_user_set_beats_the_provider(home):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout(
        "opencode-go", "qwen3.8-max", task_timeout=300, task_default=120
    ) == 300.0


def test_the_model_then_provider_timeout_beat_the_task_default(home):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout(
        "opencode-go", "qwen3.8-max", task_timeout=120, task_default=120
    ) == 240.0
    assert resolve_model_timeout("opencode-go", "other", task_timeout=120, task_default=120) == 90.0


def test_falls_back_to_the_task_default_then_default(home):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout("unknown", "m", task_timeout=120, task_default=120) == 120.0
    assert resolve_model_timeout("unknown", "m", default=30.0) == 30.0
    assert resolve_model_timeout(None, None) is None


@pytest.mark.parametrize("bad", ["x", 0, -5, None])
def test_bad_values_are_ignored(home, bad):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout("deepseek", None, explicit=bad, task_timeout=bad) == 45.0


# -- auxiliary tasks and fallbacks ----------------------------------------------


def test_aux_task_uses_its_provider_model_timeout(home):
    _write_config(home, PROVIDERS + """\
auxiliary:
  vision:
    provider: opencode-go
    model: qwen3.8-max
""")
    from agent.auxiliary_client import resolve_task_timeout

    assert resolve_task_timeout("vision") == 240.0
    assert resolve_task_timeout("vision", "opencode-go", "qwen3.8-max", explicit=7) == 7.0


def test_aux_task_timeout_set_by_the_user_wins(home):
    _write_config(home, PROVIDERS + """\
auxiliary:
  vision:
    provider: opencode-go
    model: qwen3.8-max
    timeout: 200
""")
    from agent.auxiliary_client import resolve_task_timeout

    assert resolve_task_timeout("vision") == 200.0


def test_auto_task_uses_the_main_model_timeout(home):
    _write_config(home, PROVIDERS)
    from agent.auxiliary_client import resolve_task_timeout

    assert resolve_task_timeout("compression") == 45.0
    assert resolve_task_timeout("profile_suggestion", default=60) == 45.0


def test_unconfigured_task_keeps_its_builtin_default(home):
    _write_config(home, "model:\n  provider: deepseek\n  default: deepseek-v4-flash\n")
    from agent.auxiliary_client import resolve_task_timeout

    assert resolve_task_timeout("vision") == 120.0
    assert resolve_task_timeout("profile_suggestion", default=60) == 60.0


def test_each_fallback_gets_its_own_timeout(home):
    _write_config(home, PROVIDERS + """\
auxiliary:
  vision:
    provider: opencode-go
    model: qwen3.8-max
    fallback_chain:
      - provider: deepseek
        model: deepseek-v4-flash
      - provider: opencode-go
        model: other
        timeout: 33
fallback_providers:
  - provider: opencode-go
    model: qwen3.8-max
""")
    from agent.auxiliary_client import _fallback_timeout

    assert _fallback_timeout("vision", "fallback_chain[0](deepseek)", "deepseek-v4-flash", None) == 45.0
    assert _fallback_timeout("vision", "fallback_chain[1](opencode-go)", "other", None) == 33.0
    assert _fallback_timeout("vision", "fallback_providers[0](opencode-go)", "qwen3.8-max", None) == 240.0
    assert _fallback_timeout("vision", "main-agent(deepseek)", "deepseek-v4-flash", None) == 45.0
    assert _fallback_timeout("vision", "fallback_chain[0](deepseek)", "deepseek-v4-flash", 9) == 9


def test_main_agent_fallback_entry_timeout(home):
    _write_config(home, PROVIDERS)
    assert resolve_model_timeout("deepseek", "deepseek-v4-flash", explicit=None) == 45.0
    assert resolve_model_timeout("deepseek", "deepseek-v4-flash", explicit=15) == 15.0


# -- config helpers -------------------------------------------------------------


def test_apply_timeout_sets_and_clears_without_leaving_empty_dicts():
    from hermes_cli.model_timeouts_api import apply_timeout, configured_timeouts

    config = {"providers": {"deepseek": {"base_url": "x"}}}
    apply_timeout(config, "opencode-go", "qwen3.8-max", 240)
    apply_timeout(config, "opencode-go", None, 90)
    apply_timeout(config, "deepseek", None, 45)
    assert configured_timeouts(config) == [
        {"provider": "deepseek", "model": None, "timeout_seconds": 45.0},
        {"provider": "opencode-go", "model": None, "timeout_seconds": 90.0},
        {"provider": "opencode-go", "model": "qwen3.8-max", "timeout_seconds": 240.0},
    ]
    apply_timeout(config, "opencode-go", "qwen3.8-max", None)
    apply_timeout(config, "opencode-go", None, None)
    apply_timeout(config, "deepseek", None, None)
    assert config == {"providers": {"deepseek": {"base_url": "x"}}}


def test_models_in_use_lists_chat_fallbacks_and_tasks():
    from hermes_cli.model_timeouts_api import models_in_use

    config = {
        "model": {"provider": "deepseek", "default": "deepseek-v4-flash"},
        "fallback_providers": [{"provider": "openrouter", "model": "x/y"}],
        "auxiliary": {
            "vision": {"provider": "opencode-go", "model": "qwen3.8-max"},
            "compression": {"provider": "auto", "model": ""},
        },
    }
    assert models_in_use(config) == [
        {"provider": "deepseek", "model": "deepseek-v4-flash", "used_by": ["chat", "compression"]},
        {"provider": "opencode-go", "model": "qwen3.8-max", "used_by": ["vision"]},
        {"provider": "openrouter", "model": "x/y", "used_by": ["fallback"]},
    ]


@pytest.mark.parametrize(
    "provider,model,seconds",
    [("", None, 60), ("bad id", None, 60), ("p", None, 2), ("p", None, 4000), ("p", None, True),
     ("p", None, "60"), ("p", "a\nb", 60), ("p", "m" * 201, 60), (None, None, 60)],
)
def test_validate_change_rejects_bad_input(provider, model, seconds):
    from hermes_cli.model_timeouts_api import validate_change

    with pytest.raises(ValueError):
        validate_change(provider, model, seconds)


def test_validate_change_normalises():
    from hermes_cli.model_timeouts_api import validate_change

    assert validate_change(" opencode-go ", "  ", 240.0) == ("opencode-go", None, 240)
    assert validate_change("p", "m", None) == ("p", "m", None)


# -- routes ------------------------------------------------------------------------


def _person(user_id, role):
    return SimpleNamespace(user_id=user_id, display=user_id, role=role, is_owner=role == "owner")


@pytest.fixture
def acting(monkeypatch, home):
    from hermes_cli import web_server

    state = {"as": _person("amy", "member"), "subject": "amy"}

    async def _fake(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["subject"])
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_members_cannot_read_or_change_timeouts(client, home):
    _write_config(home, PROVIDERS)
    assert client.get("/api/model-timeouts").status_code == 403
    r = client.put("/api/model-timeouts", json={"provider": "deepseek", "timeout_seconds": 60})
    assert r.status_code == 403


def test_admin_sets_and_clears_a_model_timeout(client, acting, home):
    _write_config(home, PROVIDERS)
    acting["as"] = _person("ben", "admin")
    body = client.get("/api/model-timeouts").json()
    assert {"provider": "opencode-go", "model": "qwen3.8-max", "timeout_seconds": 240.0} in body["timeouts"]
    assert body["min_seconds"] == 5 and body["max_seconds"] == 3600

    r = client.put(
        "/api/model-timeouts",
        json={"provider": "deepseek", "model": "deepseek-v4-flash", "timeout_seconds": 75},
    )
    assert r.status_code == 200
    from hermes_cli.config import load_config

    providers = load_config()["providers"]
    assert providers["deepseek"]["models"]["deepseek-v4-flash"]["timeout_seconds"] == 75
    from hermes_cli.timeouts import get_provider_request_timeout

    assert get_provider_request_timeout("deepseek", "deepseek-v4-flash") == 75.0

    r = client.put(
        "/api/model-timeouts",
        json={"provider": "deepseek", "model": "deepseek-v4-flash", "timeout_seconds": None},
    )
    assert r.status_code == 200
    assert "models" not in load_config()["providers"]["deepseek"]


@pytest.mark.parametrize(
    "body", [{"provider": "deepseek"}, {"provider": "deepseek", "timeout_seconds": 1}, {"timeout_seconds": 60}]
)
def test_bad_changes_are_400(client, acting, home, body):
    _write_config(home, PROVIDERS)
    acting["as"] = _person("ben", "owner")
    assert client.put("/api/model-timeouts", json=body).status_code == 400
