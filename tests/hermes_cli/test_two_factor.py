"""Two-factor login (TOTP + recovery codes) through the real routes.

Drives ``/auth/password-login`` and ``/api/account/*`` through the real
dashboard-auth middleware over a real temp hermes root with a real
``profiles/hr`` home, the real profile registry and the real scope switch. The
principal store is the only stand-in: it answers from whichever profile home
is *scoped at call time*, so a lookup made in the wrong profile is caught.
"""

from __future__ import annotations

import os
import stat
import time
from pathlib import Path
from types import SimpleNamespace

import pyotp
import pytest

from hermes_cli import two_factor
from hermes_cli.access import Principal
from tests.hermes_cli.test_dashboard_auth_password_login import (  # noqa: F401
    gated_app,
    pw_provider,
)


class _ScopedPrincipals:
    """``PrincipalStore`` stand-in keyed by the profile home in scope."""

    rows: dict[Path, dict[str, Principal]] = {}
    aliases: dict[Path, dict[str, str]] = {}

    def __init__(self, _store=None) -> None:
        pass

    @staticmethod
    def _home() -> Path:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()).resolve()

    async def resolve_alias(self, subject: str):
        return _ScopedPrincipals.aliases.get(self._home(), {}).get(subject)

    async def get(self, user_id: str):
        return _ScopedPrincipals.rows.get(self._home(), {}).get(user_id)

    async def get_owner(self):
        here = _ScopedPrincipals.rows.get(self._home(), {}).values()
        return next((p for p in here if p.role == "owner"), None)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    """The box root; ``admin`` (the test login) owns the default profile."""
    import hermes_constants
    from hermes_cli import web_server

    root = tmp_path / "hermes-root"
    (root / "profiles" / "hr").mkdir(parents=True)
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    monkeypatch.setenv("HERMES_HOME", str(root))
    _ScopedPrincipals.rows = {
        root.resolve(): {"admin": Principal("admin", "Admin", "owner")},
        _hr(root).resolve(): {},
    }
    _ScopedPrincipals.aliases = {}
    monkeypatch.setattr("hermes_cli.access.PrincipalStore", _ScopedPrincipals)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: None)
    return root


def _hr(root: Path) -> Path:
    return root / "profiles" / "hr"


def _enrol(root: Path, *, default=None, hr=None) -> None:
    """Replace who is enrolled where (``None`` leaves that profile empty)."""
    _ScopedPrincipals.rows = {
        root.resolve(): dict(default or {}),
        _hr(root).resolve(): dict(hr or {}),
    }


LOGIN = {"provider": "testpw", "username": "admin", "password": "hunter2"}


def _now_code(secret: str, offset: int = 0) -> str:
    return pyotp.TOTP(secret).at(time.time() + offset)


def _sign_in(client, **extra):
    return client.post("/auth/password-login", json={**LOGIN, **extra})


def _turn_on(client) -> tuple[str, list[str]]:
    assert _sign_in(client).status_code == 200
    started = client.post("/api/account/two-factor/start", json={"password": "hunter2"})
    assert started.status_code == 200, started.text
    secret = started.json()["secret"]
    assert started.json()["otpauth_uri"].startswith("otpauth://totp/Aquarium:")
    done = client.post("/api/account/two-factor/confirm", json={"code": _now_code(secret)})
    assert done.status_code == 200, done.text
    return secret, done.json()["recovery_codes"]


# --- nothing changes until someone turns it on -------------------------------


def test_login_without_two_factor_is_unchanged(gated_app, _home):
    resp = _sign_in(gated_app)
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "next": "/"}
    assert not (_home / "auth" / "two_factor").exists()


def test_status_is_off_by_default(gated_app):
    _sign_in(gated_app)
    resp = gated_app.get("/api/account/security")
    assert resp.status_code == 200
    assert resp.json()["two_factor"] == {"enabled": False, "recovery_codes_left": 0}


# --- setup --------------------------------------------------------------------


def test_start_needs_the_current_password(gated_app):
    _sign_in(gated_app)
    resp = gated_app.post("/api/account/two-factor/start", json={"password": "nope"})
    assert resp.status_code == 400
    assert not two_factor.is_enabled("admin")


def test_wrong_confirm_code_does_not_turn_it_on(gated_app):
    _sign_in(gated_app)
    gated_app.post("/api/account/two-factor/start", json={"password": "hunter2"})
    resp = gated_app.post("/api/account/two-factor/confirm", json={"code": "000000"})
    assert resp.status_code == 400
    assert not two_factor.is_enabled("admin")


def test_setup_gives_ten_codes_and_stores_only_hashes_0600(gated_app, _home):
    secret, codes = _turn_on(gated_app)
    assert len(codes) == 10 and len(set(codes)) == 10
    status = gated_app.get("/api/account/security").json()["two_factor"]
    assert status == {"enabled": True, "recovery_codes_left": 10}
    files = list((_home / "auth" / "two_factor").glob("*.json"))
    assert len(files) == 1
    raw = files[0].read_text()
    assert "admin" in raw  # user id kept, but no recovery code in clear
    assert not any(code in raw for code in codes)
    if os.name == "posix":
        assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
        assert stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700


# --- sign-in --------------------------------------------------------------------


def test_sign_in_asks_for_a_code_and_sets_no_cookie(gated_app):
    secret, _codes = _turn_on(gated_app)
    gated_app.cookies.clear()
    resp = _sign_in(gated_app)
    assert resp.status_code == 200
    assert resp.json() == {"ok": False, "two_factor_required": True}
    assert "set-cookie" not in {k.lower() for k in resp.headers}
    assert gated_app.get("/api/account/security").status_code == 401


def test_sign_in_with_wrong_password_never_reveals_two_factor(gated_app):
    _turn_on(gated_app)
    gated_app.cookies.clear()
    resp = gated_app.post("/auth/password-login", json={**LOGIN, "password": "x"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid credentials"


def test_sign_in_with_app_code_works_once(gated_app):
    secret, _codes = _turn_on(gated_app)
    gated_app.cookies.clear()
    code = _now_code(secret, 30)
    ok = _sign_in(gated_app, code=code)
    assert ok.status_code == 200 and ok.json()["ok"] is True
    gated_app.cookies.clear()
    replay = _sign_in(gated_app, code=code)
    assert replay.status_code == 401


def test_sign_in_with_recovery_code_uses_it_up(gated_app):
    _secret, codes = _turn_on(gated_app)
    gated_app.cookies.clear()
    assert _sign_in(gated_app, code=codes[0].lower()).status_code == 200
    left = gated_app.get("/api/account/security").json()["two_factor"]["recovery_codes_left"]
    assert left == 9
    gated_app.cookies.clear()
    assert _sign_in(gated_app, code=codes[0]).status_code == 401


def test_wrong_codes_are_rate_limited(gated_app):
    secret, _codes = _turn_on(gated_app)
    gated_app.cookies.clear()
    for _ in range(two_factor.MAX_FAILURES):
        assert _sign_in(gated_app, code="111111").status_code == 401
    locked = _sign_in(gated_app, code=_now_code(secret, 30))
    assert locked.status_code == 429


def test_another_person_without_two_factor_is_not_asked(gated_app, monkeypatch):
    _turn_on(gated_app)

    async def _someone_else(session):
        return "mia"

    monkeypatch.setattr(two_factor, "principal_id_for_session", _someone_else)
    gated_app.cookies.clear()
    assert _sign_in(gated_app).json()["ok"] is True


# --- turn off / new codes -----------------------------------------------------


def test_turn_off_needs_password_and_code(gated_app):
    secret, _codes = _turn_on(gated_app)
    no_code = gated_app.post("/api/account/two-factor/disable", json={"password": "hunter2"})
    assert no_code.status_code == 400
    bad_pw = gated_app.post(
        "/api/account/two-factor/disable", json={"password": "x", "code": _now_code(secret, 30)}
    )
    assert bad_pw.status_code == 400
    assert two_factor.is_enabled("admin")
    ok = gated_app.post(
        "/api/account/two-factor/disable",
        json={"password": "hunter2", "code": _now_code(secret, 30)},
    )
    assert ok.status_code == 200
    assert not two_factor.is_enabled("admin")
    gated_app.cookies.clear()
    assert _sign_in(gated_app).json()["ok"] is True


def test_new_recovery_codes_replace_the_old_ones(gated_app):
    secret, old = _turn_on(gated_app)
    resp = gated_app.post(
        "/api/account/two-factor/recovery-codes",
        json={"password": "hunter2", "code": _now_code(secret, 30)},
    )
    assert resp.status_code == 200
    new = resp.json()["recovery_codes"]
    assert len(new) == 10 and not set(new) & set(old)
    gated_app.cookies.clear()
    assert _sign_in(gated_app, code=old[1]).status_code == 401
    gated_app.cookies.clear()
    assert _sign_in(gated_app, code=new[1]).status_code == 200


def test_change_password_checks_current_password_and_code(gated_app):
    secret, _codes = _turn_on(gated_app)
    body = {"current_password": "hunter2", "new_password": "a-long-new-password"}
    assert gated_app.post("/api/account/password", json={**body, "current_password": "x"}).status_code == 400
    assert gated_app.post("/api/account/password", json=body).status_code == 400  # code missing
    short = {**body, "new_password": "short", "code": _now_code(secret, 30)}
    resp = gated_app.post("/api/account/password", json=short)
    assert resp.status_code == 400 and "12" in resp.json()["detail"]


def test_account_routes_need_a_sign_in(gated_app):
    assert gated_app.get("/api/account/security").status_code == 401
    assert gated_app.post("/api/account/two-factor/start", json={}).status_code == 401


# --- module-level ----------------------------------------------------------------


def test_pending_setup_expires(_home, monkeypatch):
    started = two_factor.start("u1", "u1@example.com")
    later = time.time() + two_factor.PENDING_TTL_SECONDS + 60
    monkeypatch.setattr(two_factor.time, "time", lambda: later)
    with pytest.raises(two_factor.TwoFactorError):
        two_factor.confirm("u1", pyotp.TOTP(started["secret"]).now())
    assert not two_factor.is_enabled("u1")


def test_any_enabled_ignores_unconfirmed_setups(_home):
    two_factor.start("u2", "u2")
    assert two_factor.any_enabled() is False


# --- account-level: one record per login at the box root (FG-28 B5) -----------


def test_an_hr_only_login_manages_two_factor_and_must_enter_a_code(gated_app, _home):
    _enrol(_home, hr={"admin": Principal("admin", "Admin", "member")})
    secret, codes = _turn_on(gated_app)
    assert gated_app.get("/api/account/security").json()["two_factor"]["enabled"] is True
    assert list((_home / "auth" / "two_factor").glob("*.json"))
    assert not (_hr(_home) / "auth").exists()

    gated_app.cookies.clear()
    assert _sign_in(gated_app).json() == {"ok": False, "two_factor_required": True}
    assert _sign_in(gated_app, code=_now_code(secret, 30)).json()["ok"] is True

    recovery = gated_app.post(
        "/api/account/two-factor/recovery-codes",
        json={"password": "hunter2", "code": codes[0]},
    )
    assert recovery.status_code == 200
    off = gated_app.post(
        "/api/account/two-factor/disable",
        json={"password": "hunter2", "code": recovery.json()["recovery_codes"][0]},
    )
    assert off.status_code == 200
    assert not two_factor.is_enabled("admin")


def test_a_login_enrolled_nowhere_is_not_linked_to_a_person(gated_app, _home):
    _enrol(_home)
    assert _sign_in(gated_app).status_code == 200
    assert gated_app.get("/api/account/security").status_code == 409
    assert gated_app.get("/api/me/preferences").status_code == 409


def test_a_login_suspended_in_every_profile_cannot_manage_it(gated_app, _home):
    _enrol(_home, hr={"admin": Principal("admin", "Admin", "admin", active=False)})
    assert _sign_in(gated_app).status_code == 200
    assert gated_app.get("/api/account/security").status_code == 403


def test_an_hr_only_login_keeps_its_preferences_at_the_root(gated_app, _home):
    from hermes_cli import user_prefs

    _enrol(_home, hr={"admin": Principal("admin", "Admin", "member")})
    assert _sign_in(gated_app).status_code == 200
    saved = gated_app.put("/api/me/preferences", json={"language": "zh-Hant"})
    assert saved.status_code == 200, saved.text
    assert gated_app.get("/api/me/preferences").json()["language"] == "zh-Hant"
    assert user_prefs.get_language("admin") == "zh-Hant"
    assert list((_home / "auth" / "user_prefs").glob("*.json"))
    assert not (_hr(_home) / "auth").exists()


def test_a_request_scoped_to_another_profile_uses_the_root_record(_home):
    from agent.profile_runtime import profile_runtime_scope

    with profile_runtime_scope(_hr(_home)):
        started = two_factor.start("u1", "u1@example.com")
        two_factor.confirm("u1", pyotp.TOTP(started["secret"]).now())
        assert two_factor.is_enabled("u1")
    assert two_factor.is_enabled("u1") and two_factor.any_enabled()
    assert len(list((_home / "auth" / "two_factor").glob("*.json"))) == 1
    assert not (_hr(_home) / "auth").exists()


@pytest.mark.asyncio
async def test_the_account_id_comes_from_the_default_profile_in_any_scope(_home):
    from agent.profile_runtime import profile_runtime_scope

    _ScopedPrincipals.aliases = {_home.resolve(): {"sub-1": "owner-1"}}
    owner = SimpleNamespace(user_id="sub-1", provider="supabase")
    hr_only = SimpleNamespace(user_id="sub-2", provider="supabase")
    with profile_runtime_scope(_hr(_home)):
        assert await two_factor.principal_id_for_session(owner) == "owner-1"
        assert await two_factor.principal_id_for_session(hr_only) == "sub-2"
    assert await two_factor.principal_id_for_session(owner) == "owner-1"
    assert await two_factor.principal_id_for_session(SimpleNamespace(user_id="")) == ""


def test_an_existing_owner_record_still_verifies(gated_app, _home):
    """Owner records written before FG-28 B5 sit at the default home (the root),
    keyed by the alias-resolved principal id; nothing needs migrating."""
    _ScopedPrincipals.aliases = {_home.resolve(): {"admin": "owner-1"}}
    _enrol(_home, default={"owner-1": Principal("owner-1", "Owner", "owner")})
    started = two_factor.start("owner-1", "owner", home=_home)
    two_factor.confirm("owner-1", _now_code(started["secret"]), home=_home)

    assert _sign_in(gated_app).json() == {"ok": False, "two_factor_required": True}
    assert _sign_in(gated_app, code=_now_code(started["secret"], 30)).json()["ok"] is True
    assert gated_app.get("/api/account/security").json()["two_factor"]["enabled"] is True


def test_records_under_a_named_profile_process_home_are_still_read(_home, monkeypatch):
    """A process launched with a named profile as ``HERMES_HOME`` kept its
    records there; they stay readable, and turning it off removes both."""
    legacy_home = _hr(_home)
    started = two_factor.start("u3", "u3", home=legacy_home)
    two_factor.confirm("u3", pyotp.TOTP(started["secret"]).now(), home=legacy_home)
    monkeypatch.setenv("HERMES_HOME", str(legacy_home))

    assert two_factor.is_enabled("u3") and two_factor.any_enabled()
    two_factor.regenerate_recovery_codes("u3")
    assert list((_home / "auth" / "two_factor").glob("*.json"))
    two_factor.disable("u3")
    assert not two_factor.is_enabled("u3") and not two_factor.any_enabled()
