"""``scripts/live_access_check.py`` against a real dashboard on a temp HERMES_HOME.

The real FastAPI app runs under uvicorn on a loopback port with the real
dashboard-auth gate, password-login route, cookies, session endpoints and
SQLite ``SessionDB``; the real ``model_tools`` dispatcher, access policy and
``AIAgent`` construction run in-process. Only what needs Supabase is faked:
GoTrue accounts + enrolments (:class:`FakeBox`, behind ``build_members``), the
principal lookup and invitation redemption the app does against them, and the
model call inside a chat turn.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import socket
import threading
import time
from pathlib import Path

import pytest

import scripts.live_access_check as lac

_SECRET = b"live-access-check-test"


def _sign(sub: str, kind: str) -> str:
    raw = json.dumps({
        "sub": sub,
        "kind": kind,
        "exp": int(time.time()) + 3600,
    }).encode()
    return base64.urlsafe_b64encode(
        raw + hmac.new(_SECRET, raw, hashlib.sha256).digest()
    ).decode()


def _unsign(token: str):
    try:
        blob = base64.urlsafe_b64decode(token.encode())
    except Exception:
        return None
    raw, sig = blob[:-32], blob[-32:]
    if not hmac.compare_digest(sig, hmac.new(_SECRET, raw, hashlib.sha256).digest()):
        return None
    return json.loads(raw)


class FakeBox:
    """GoTrue accounts + this profile's enrolments, in memory."""

    def __init__(self):
        from hermes_cli.access import Principal

        self.owner_principal = Principal(user_id="owner-1", display="Leo", role="owner")
        self.accounts = {
            "owner-1": {"email": "leo@example.com", "password": "pw", "banned": False}
        }
        self.enrolled = {"owner-1": self.owner_principal}
        self.invitations: dict = {}
        self.traces: list = []  # (session_key, actor_user_id) minted by the chat endpoint
        self.passwords: list = []
        self._n = 0

    # -- the LiveMembers surface the script uses ---------------------------
    def owner(self):
        return self.owner_principal

    def create(self, actor, *, email, display, role):
        from hermes_cli.access import Principal

        assert actor.role == "owner"
        self._n += 1
        uid = f"uid-{self._n}-{role}"
        self.accounts[uid] = {"email": email, "password": None, "banned": True}
        self.enrolled[uid] = Principal(user_id=uid, display=display, role=role)
        token = f"tok-{uid}"
        self.invitations[token] = uid
        return uid, token

    def delete_member(self, actor, user_id):
        assert actor.role == "owner" and self.enrolled[user_id].role != "owner"
        del self.enrolled[user_id]

    def delete_account(self, user_id):
        self.accounts.pop(user_id, None)

    def accounts_by_email(self):
        return {uid: a["email"] for uid, a in self.accounts.items()}

    def principals(self):
        return list(self.enrolled.values())

    def list_traces(self, principal):
        from types import SimpleNamespace

        return [
            SimpleNamespace(session_key=s, actor_user_id=a)
            for s, a in self.traces
            if a == principal.user_id
        ]


class _Members:
    def __init__(self, box):
        self.box = box
        self.owner = box.owner
        self.create = box.create
        self.delete_member = box.delete_member
        self.delete_account = box.delete_account
        self.accounts = box.accounts_by_email
        self.principals = box.principals
        self.traces = box.list_traces


def _password_provider(box):
    from hermes_cli.dashboard_auth import (
        DashboardAuthProvider,
        InvalidCredentialsError,
        Session,
    )

    class Provider(DashboardAuthProvider):
        name = "fakepw"
        display_name = "Fake password"
        supports_password = True

        def start_login(self, *, redirect_uri):
            raise NotImplementedError

        def complete_login(self, **kwargs):
            raise NotImplementedError

        def _session(self, uid, at, rt):
            return Session(
                user_id=uid,
                email="",
                display_name=uid,
                org_id="",
                provider=self.name,
                expires_at=int(time.time()) + 3600,
                access_token=at,
                refresh_token=rt,
            )

        def complete_password_login(self, *, username, password):
            for uid, acct in box.accounts.items():
                if (
                    acct["email"] == username
                    and acct["password"] == password
                    and not acct["banned"]
                ):
                    return self._session(
                        uid, _sign(uid, "access"), _sign(uid, "refresh")
                    )
            raise InvalidCredentialsError("bad creds")

        def verify_session(self, *, access_token):
            p = _unsign(access_token)
            if not p or p.get("kind") != "access":
                return None
            return self._session(p["sub"], access_token, "")

        def refresh_session(self, *, refresh_token):
            from hermes_cli.dashboard_auth import RefreshExpiredError

            raise RefreshExpiredError("no refresh in tests")

        def revoke_session(self, *, refresh_token):
            return None

    return Provider()


@pytest.fixture
def box(tmp_path, monkeypatch):
    """A running dashboard + fake accounts; yields (box, base_url, home)."""
    home = tmp_path / "hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", home / "state.db")

    import uvicorn
    from fastapi import HTTPException

    import gateway.run as grun
    import hermes_cli.tools_config as tools_config
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from hermes_cli.dashboard_auth.routes import _reset_password_rate_limit

    fake = FakeBox()
    monkeypatch.setattr(lac, "build_members", lambda: _Members(fake))

    async def resolve_principal(request, *, allow_as=False):
        subject = web_server._comms_session_subject(request)
        if not subject:
            return fake.owner_principal
        principal = fake.enrolled.get(subject)
        if principal is None:
            raise HTTPException(status_code=409, detail="not enrolled")
        return principal

    class _Service:
        async def redeem_invitation(self, *, token, password):
            uid = fake.invitations.pop(token, None)
            if uid is None:
                return False
            fake.passwords.append(password)
            fake.accounts[uid].update(password=password, banned=False)
            return True

    def agent_home_trace(principal, session_key):
        fake.traces.append((session_key, principal.user_id))
        return None, None

    def fake_turn(
        *,
        session_db,
        user_message,
        conversation_history,
        session_id,
        principal=None,
        **_,
    ):
        session_db.append_message(session_id, "user", user_message)
        session_db.append_message(session_id, "assistant", "OK")
        return {"final_response": "OK", "session_id": session_id}, {}

    import gateway.session_chat as session_chat

    monkeypatch.setattr(web_server, "_comms_resolve_principal", resolve_principal)
    monkeypatch.setattr(
        web_server, "_comms_user_service", lambda actor=None: _Service()
    )
    monkeypatch.setattr(web_server, "_agent_home_trace", agent_home_trace)
    monkeypatch.setattr(session_chat, "run_session_turn_sync", fake_turn)
    # Agent construction stays real; only its provider/model resolution is pinned.
    monkeypatch.setattr(
        grun,
        "_resolve_runtime_agent_kwargs",
        lambda: {"api_key": "test", "base_url": "https://openrouter.ai/api/v1"},
    )
    monkeypatch.setattr(grun, "_resolve_gateway_model", lambda: "test-model")
    monkeypatch.setattr(grun, "_load_gateway_config", lambda: {})
    monkeypatch.setattr(
        tools_config,
        "_get_platform_tools",
        lambda cfg, platform: {"terminal", "file", "browser", "code_execution"},
    )

    clear_providers()
    register_provider(_password_provider(fake))
    _reset_password_rate_limit()
    monkeypatch.setattr(web_server, "_REDEEM_THROTTLE", None)
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(web_server.app, host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    assert server.started, "dashboard did not start"
    try:
        yield fake, f"http://127.0.0.1:{port}", home
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        clear_providers()


def _run(argv):
    lines: list = []
    code = lac.main(argv, out=lines.append)
    return code, lines, json.loads(lines[-1])


def _tagged(fake):
    return [
        e for e in fake.accounts_by_email().values() if e.startswith(lac.TAG_PREFIX)
    ]


def _seed_unrelated_chat(home):
    from hermes_state import SessionDB

    db = SessionDB()
    db.ensure_session("real-chat", source="agent_home", user_id="someone-real")
    db.close()
    (home / "workspaces" / "someone-real").mkdir(parents=True)


def _session_exists(sid):
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        return db.get_session(sid) is not None
    finally:
        db.close()


def test_full_run_passes_and_leaves_only_what_was_there(box):
    fake, url, home = box
    _seed_unrelated_chat(home)

    code, lines, summary = _run([
        "--base-url",
        url,
        "--auth-provider",
        "fakepw",
        "--include-owner",
        "--skip",
        "e",  # e reports open findings F17/F22; covered in test_live_access_check_gate.py
    ])
    out = "\n".join(lines)

    assert code == 0, out
    assert summary["ok"] and summary["fail"] == 0 and summary["pass"] > 30
    assert summary["cleanup"]["clean"] and not summary["cleanup"]["errors"]
    for check in (
        "[a] member: terminal refused",
        "[b] member: read of another user's folder refused",
        "[c] viewer: member's chat refused",
        "[d] member: turn traced with them as actor",
        "[a] owner: agent runs as the user",
    ):
        assert f"PASS {check}" in out
    # Everything tagged is gone; the owner, an unrelated chat and folder stay.
    assert _tagged(fake) == [] and set(fake.enrolled) == {"owner-1"}
    assert _session_exists("real-chat")
    assert sorted(p.name for p in (home / "workspaces").iterdir()) == ["someone-real"]
    # Exactly the three test users were created and logged in; their passwords never printed.
    assert len(fake.passwords) == 3
    assert not any(pw in out for pw in fake.passwords)


def test_broken_confinement_and_leaky_chat_list_fail_the_run(box, monkeypatch):
    fake, url, home = box
    import tools.access_policy as ap
    from hermes_cli import web_server

    monkeypatch.setattr(
        ap, "files_root", lambda user_id, role: None
    )  # #522 confinement regressed
    monkeypatch.setattr(
        web_server, "_chat_scope_for", lambda principal: None
    )  # #520 regressed

    code, lines, summary = _run([
        "--base-url",
        url,
        "--auth-provider",
        "fakepw",
        "--no-chat-turn",
    ])

    assert code == 1
    failed = set(summary["failed"])
    assert "[b] member: read /etc/hostname refused" in failed
    assert "[b] member: read of another user's folder refused" in failed
    assert "[c] member: viewer's chat not listed" in failed
    assert "[c] member: viewer's chat refused" in failed
    # Failing checks still clean up.
    assert summary["cleanup"]["clean"] and _tagged(fake) == []


def test_turn_traced_as_someone_else_fails(box, monkeypatch):
    fake, url, _ = box
    from hermes_cli import web_server

    def wrong_actor(principal, session_key):
        fake.traces.append((session_key, "owner-1"))
        return None, None

    monkeypatch.setattr(web_server, "_agent_home_trace", wrong_actor)
    code, _, summary = _run(["--base-url", url, "--auth-provider", "fakepw"])

    assert code == 1
    assert "[d] member: turn traced with them as actor" in summary["failed"]


def test_config_override_is_the_expected_policy(box):
    fake, url, home = box
    (home / "config.yaml").write_text(
        "access:\n  roles:\n    member:\n      deny_tools: [terminal]\n"
    )
    code, lines, summary = _run([
        "--base-url",
        url,
        "--auth-provider",
        "fakepw",
        "--no-chat-turn",
        "--skip",
        "e",
    ])
    out = "\n".join(lines)

    assert code == 0, out
    assert (
        "PASS [a] member: denied tools match config.yaml access.roles.member.deny_tools"
        in out
    )
    assert "PASS [a] member: terminal refused" in out


def test_dry_run_changes_nothing(box):
    fake, _, home = box
    before = dict(fake.accounts)
    code, lines, summary = _run(["--dry-run", "--base-url", "http://127.0.0.1:9"])

    assert code == 0 and summary["mode"] == "dry-run"
    assert fake.accounts == before and not (home / "workspaces").exists()
    assert summary["policy"]["viewer"]["files"] == "own folder"
    assert "write_file" in summary["policy"]["viewer"]["deny_tools"]


def test_cleanup_mode_deletes_only_the_named_tag(box):
    fake, _, home = box
    from hermes_cli.access import Principal
    from hermes_state import SessionDB

    _seed_unrelated_chat(home)
    db = SessionDB()
    for ts in ("111", "222"):
        uid = f"left-{ts}"
        tag = f"zz-accesscheck-{ts}"
        fake.accounts[uid] = {
            "email": f"{tag}-member@example.invalid",
            "password": "x",
            "banned": False,
        }
        fake.enrolled[uid] = Principal(
            user_id=uid, display=f"{tag}-member", role="member"
        )
        db.ensure_session(f"s-{ts}", source="agent_home", user_id=uid)
        (home / "workspaces" / uid).mkdir(parents=True)
    # Lookalikes that must survive: not @example.invalid, and a longer tag.
    fake.accounts["real"] = {
        "email": "zz-accesscheck-111-x@example.com",
        "password": "x",
        "banned": False,
    }
    fake.accounts["longer"] = {
        "email": "zz-accesscheck-1111-member@example.invalid",
        "password": "x",
        "banned": False,
    }
    db.close()

    code, _, summary = _run(["--cleanup", "zz-accesscheck-111"])
    assert code == 0 and summary["cleanup"]["found"]["accounts"] == 1
    assert "left-111" not in fake.accounts and "left-111" not in fake.enrolled
    assert not _session_exists("s-111") and _session_exists("s-222")
    assert not (home / "workspaces" / "left-111").exists()

    code, _, summary = _run(["--cleanup", lac.ALL_TAGS])
    assert code == 0
    assert set(fake.accounts) == {"owner-1", "real"} and set(fake.enrolled) == {
        "owner-1"
    }
    assert not _session_exists("s-222") and _session_exists("real-chat")
    assert (home / "workspaces" / "someone-real").exists()


def test_cleanup_dry_run_lists_without_deleting(box):
    fake, _, _ = box
    fake.accounts["left"] = {
        "email": "zz-accesscheck-5-admin@example.invalid",
        "password": "x",
        "banned": False,
    }
    code, _, summary = _run(["--cleanup", lac.ALL_TAGS, "--dry-run"])
    assert code == 0 and summary["cleanup"]["found"]["accounts"] == 1
    assert "left" in fake.accounts


@pytest.mark.parametrize(
    "bad", ["everything", "zz-accesscheck-", "zz-accesscheck-1-member", "%"]
)
def test_cleanup_refuses_anything_but_a_run_tag(bad, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    with pytest.raises(SystemExit):
        lac.main(["--cleanup", bad], out=lambda _: None)


def test_requires_hermes_home(monkeypatch):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    with pytest.raises(SystemExit, match="HERMES_HOME"):
        lac.main(["--dry-run"], out=lambda _: None)
