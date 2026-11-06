"""FG-28 item 4 / decision D2 — the GoTrue admin credentials are box-wide.

The service-role key is the credential an admin console turn uses to call
GoTrue. There is one GoTrue per box (accounts are box-wide, authority is
profile-local), so its URL and keys are deployment-level, not profile secrets:
a request scoped to a profile whose ``.env`` carries no Supabase keys — or a
different copy of them — still reaches the one auth server, instead of
answering 503 on every console route and activation link in that profile.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent.profile_runtime import profile_runtime_scope
from agent.secret_scope import (
    reset_secret_scope,
    set_multiplex_active,
    set_secret_scope,
)
from hermes_cli.members import (
    _resolve_service_role_key,
    _resolve_url,
    load_admin_client,
)


@pytest.fixture(autouse=True)
def _reset_multiplex() -> None:
    # Multiplex is a process-global; restore it so one test's flag cannot leak
    # into another (the same care the secret_scope module takes internally).
    set_multiplex_active(False)
    yield
    set_multiplex_active(False)


def test_service_role_key_falls_back_to_env_when_single_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "env-key")
    assert _resolve_service_role_key() == "env-key"


@pytest.mark.parametrize("multiplex", [False, True])
def test_a_profile_without_supabase_keys_still_reaches_the_box_gotrue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, multiplex: bool
) -> None:
    monkeypatch.delenv("HERMES_DASHBOARD_SUPABASE_URL", raising=False)
    monkeypatch.delenv("HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("HERMES_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_URL", "https://auth.box.example")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "box-key")
    hr = tmp_path / "profiles" / "hr"
    hr.mkdir(parents=True)
    (hr / ".env").write_text("ANTHROPIC_API_KEY=hr-only\n")
    set_multiplex_active(multiplex)

    with profile_runtime_scope(hr):
        assert _resolve_url({}) == "https://auth.box.example"
        assert _resolve_service_role_key() == "box-key"
        assert load_admin_client() is not None


def test_a_profile_env_cannot_point_the_box_at_another_gotrue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("HERMES_SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "box-key")
    monkeypatch.setenv("SUPABASE_URL", "https://auth.box.example")
    token = set_secret_scope(
        {
            "SUPABASE_SERVICE_ROLE_KEY": "profile-key",
            "SUPABASE_URL": "https://elsewhere.example",
        }
    )
    try:
        assert _resolve_service_role_key() == "box-key"
        assert _resolve_url({}) == "https://auth.box.example"
    finally:
        reset_secret_scope(token)


# ── D-1: fail-closed secrets in the multi-profile dashboard process ─────────


@pytest.fixture
def box(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A real hermes root; ``profiles/hr`` is created by the tests that need it."""
    import hermes_constants
    from agent import secret_scope

    root = tmp_path / "hermes-root"
    root.mkdir()
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    yield root
    secret_scope.set_environ_home(None)


def _add_profile(root: Path, name: str, env: str = "") -> Path:
    home = root / "profiles" / name
    home.mkdir(parents=True)
    (home / "config.yaml").write_text("{}\n")
    (home / ".env").write_text(env)
    return home


def test_a_single_profile_dashboard_reads_the_environment_as_before(box: Path) -> None:
    from agent.secret_scope import get_secret, is_multiplex_active
    from hermes_cli import web_server

    with web_server._dashboard_secret_isolation({}) as armed:
        assert armed is False
        assert is_multiplex_active() is False
        assert get_secret("NOT_SET_ANYWHERE") is None


def test_config_arms_isolation_on_a_single_profile_box(box: Path) -> None:
    from agent.secret_scope import is_multiplex_active
    from hermes_cli import web_server

    cfg = {"dashboard": {"multiplex_profiles": True}}
    with web_server._dashboard_secret_isolation(cfg) as armed:
        assert armed is True
        assert is_multiplex_active() is True
    assert is_multiplex_active() is False


def test_the_dashboard_lifespan_arms_isolation_when_the_box_has_two_profiles(
    box: Path,
) -> None:
    from fastapi.testclient import TestClient

    from agent.secret_scope import is_multiplex_active
    from hermes_cli import web_server

    _add_profile(box, "hr")
    with TestClient(web_server.app):
        assert is_multiplex_active() is True
    assert is_multiplex_active() is False


def test_another_profiles_home_without_its_scope_fails_closed_in_the_dashboard(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent.secret_scope import UnscopedSecretError, get_secret
    from hermes_cli import web_server
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setenv("DEEPSEEK_API_KEY", "root-key")
    hr = _add_profile(box, "hr", "DEEPSEEK_API_KEY=hr-key\n")
    with web_server._dashboard_secret_isolation({}):
        # The dashboard's own profile — startup, background jobs, executor
        # threads — still reads its environment.
        assert get_secret("DEEPSEEK_API_KEY") == "root-key"
        token = set_hermes_home_override(str(hr))
        try:
            with pytest.raises(UnscopedSecretError):
                get_secret("DEEPSEEK_API_KEY")
        finally:
            reset_hermes_home_override(token)
        with profile_runtime_scope(hr):
            assert get_secret("DEEPSEEK_API_KEY") == "hr-key"


def test_supabase_keys_resolve_in_a_profile_with_no_env_in_the_dashboard(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_cli import web_server
    from plugins.dashboard_auth import supabase as supabase_auth

    monkeypatch.setenv("SUPABASE_URL", "https://auth.box.example")
    monkeypatch.setenv("SUPABASE_JWT_SECRET", "box-jwt")
    monkeypatch.delenv("HERMES_DASHBOARD_SUPABASE_URL", raising=False)
    monkeypatch.delenv("HERMES_DASHBOARD_SUPABASE_JWT_SECRET", raising=False)
    hr = _add_profile(box, "hr")
    with web_server._dashboard_secret_isolation({}), profile_runtime_scope(hr):
        assert _resolve_url({}) == "https://auth.box.example"
        assert (
            supabase_auth._resolve(
                {}, "url", "HERMES_DASHBOARD_SUPABASE_URL", "SUPABASE_URL"
            )
            == "https://auth.box.example"
        )
        assert (
            supabase_auth._resolve(
                {}, "jwt_secret", "HERMES_DASHBOARD_SUPABASE_JWT_SECRET", "SUPABASE_JWT_SECRET"
            )
            == "box-jwt"
        )


class _CapturingClient:
    seen: list[str] = []

    def __init__(self, *a, **kw) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url, headers=None, json=None):
        import httpx

        _CapturingClient.seen.append(headers["Authorization"])
        body = {"choices": [{"message": {"content": '{"suggestions": []}'}}]}
        return httpx.Response(200, json=body, request=httpx.Request("POST", url))


@pytest.mark.parametrize("armed", [False, True])
def test_tag_suggestions_use_the_scoped_profiles_model_key(
    box: Path, monkeypatch: pytest.MonkeyPatch, armed: bool
) -> None:
    import asyncio

    import httpx

    from hermes_cli import web_server

    monkeypatch.setenv("DEEPSEEK_API_KEY", "root-key")
    monkeypatch.setattr(httpx, "AsyncClient", _CapturingClient)
    _CapturingClient.seen = []
    hr = _add_profile(box, "hr", "DEEPSEEK_API_KEY=hr-key\n")
    cfg = {"dashboard": {"multiplex_profiles": armed}}
    with web_server._dashboard_secret_isolation(cfg) if armed else _null():
        asyncio.run(web_server._llm_tag_suggest("p"))
        with profile_runtime_scope(hr):
            asyncio.run(web_server._llm_tag_suggest("p"))
    assert _CapturingClient.seen == ["Bearer root-key", "Bearer hr-key"]


def test_a_profile_config_request_reads_that_profiles_credentials(
    box: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_cli import web_server
    from hermes_cli.config import get_env_value_prefer_dotenv

    monkeypatch.setenv("ELEVENLABS_API_KEY", "root-key")
    _add_profile(box, "hr")
    with web_server._dashboard_secret_isolation({}):
        with web_server._config_profile_scope("hr"):
            assert get_env_value_prefer_dotenv("ELEVENLABS_API_KEY") is None
        assert get_env_value_prefer_dotenv("ELEVENLABS_API_KEY") == "root-key"


def _null():
    from contextlib import nullcontext

    return nullcontext()
