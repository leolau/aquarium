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
