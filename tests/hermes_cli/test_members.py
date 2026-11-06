"""Tests for member management: GoTrue admin client + FG-26 MemberService.

* :class:`GoTrueAdminClient` — httpx-mocked: request shape (url, service-role
  headers, body), error mapping (409/422 → conflict, 401/403 → service-role
  error, network → MemberError), and list pagination.
* :class:`MemberService` — the FG-26 contract over a fake principal store, a
  fake admin client and a fake invitation store: the owner/admin gate, the
  "never create/assign owner" guard, the required ``profile`` and its 409
  leaving no orphan account, existing-account enrolment, the banned-account +
  invitation activation flow, paging/search/filter totals, self-protection and
  last-admin guards, and the owner-only delete strategies.

The database and invitation SQL paths themselves are covered real against
Postgres in ``test_access_e2e.py`` / ``test_fg26_invitations_e2e.py``.

All HTTP is mocked; no token or password is allowed into an audit payload.
"""

from __future__ import annotations

import dataclasses
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from hermes_cli.access import Principal, Role
from hermes_cli.invitations import (
    Invitation,
    InvitationError,
    MintedInvitation,
)
from hermes_cli.members import (
    GoTrueAdminClient,
    MemberAuthorizationError,
    MemberConflictError,
    MemberError,
    MemberProfileMismatchError,
    MemberService,
    MemberView,
    link_member_channel,
    unlink_member_channel,
    parse_member_csv,
    require_member_admin,
)
from hermes_cli.console_scope import AccountLevelPermissionError
from hermes_cli.members import _account_is_activated
from hermes_cli.profile_registry import ProfileRegistryEntry

_URL = "https://supabase.example.com"
_KEY = "service-role-key-abcdefghijklmnopqrstuvwxyz0123456789"
_SUB = "a1b2c3d4-0000-4000-8000-000000000042"


def _mock_response(status_code: int, body: Any, *, ctype: str = "application/json"):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    if isinstance(body, (dict, list)):
        resp.text = json.dumps(body)
        resp.json = MagicMock(return_value=body)
    else:
        resp.text = str(body)
        resp.json = MagicMock(side_effect=ValueError("not json"))
    resp.headers = {"content-type": ctype}
    return resp


def _client() -> GoTrueAdminClient:
    return GoTrueAdminClient(url=_URL, service_role_key=_KEY)


# ---------------------------------------------------------------------------
# GoTrueAdminClient — construction
# ---------------------------------------------------------------------------


def test_admin_client_requires_url_and_key() -> None:
    with pytest.raises(ValueError):
        GoTrueAdminClient(url="", service_role_key=_KEY)
    with pytest.raises(ValueError):
        GoTrueAdminClient(url=_URL, service_role_key="")


def test_admin_client_rejects_cleartext_non_loopback() -> None:
    with pytest.raises(ValueError):
        GoTrueAdminClient(url="http://supabase.example.com", service_role_key=_KEY)
    # loopback http is allowed (same-box Kong / dev)
    GoTrueAdminClient(url="http://127.0.0.1:8000", service_role_key=_KEY)


def test_admin_client_normalises_trailing_slash() -> None:
    client = GoTrueAdminClient(url=_URL + "/", service_role_key=_KEY)
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(200, {"users": []})
        client.list_users()
    called_url = req.call_args.args[1]
    assert called_url.startswith(_URL + "/auth/v1/admin/users")
    assert "//auth" not in called_url


# ---------------------------------------------------------------------------
# GoTrueAdminClient — create_user
# ---------------------------------------------------------------------------


def test_create_user_request_shape_and_service_role_headers() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(200, {"id": _SUB, "email": "m@x.io"})
        user = client.create_user(
            email="m@x.io", password="temp-pass-123", display="Mia"
        )
    assert user["id"] == _SUB
    method, url = req.call_args.args
    assert method == "POST"
    assert url == f"{_URL}/auth/v1/admin/users"
    headers = req.call_args.kwargs["headers"]
    assert headers["apikey"] == _KEY
    assert headers["Authorization"] == f"Bearer {_KEY}"
    body = req.call_args.kwargs["json"]
    assert body["email"] == "m@x.io"
    assert body["password"] == "temp-pass-123"
    assert body["email_confirm"] is True
    assert body["user_metadata"] == {"display_name": "Mia"}


def test_create_user_duplicate_maps_to_conflict() -> None:
    client = _client()
    for status in (409, 422):
        with patch("hermes_cli.members.httpx.request") as req:
            req.return_value = _mock_response(status, {"msg": "already registered"})
            with pytest.raises(MemberConflictError):
                client.create_user(email="dupe@x.io", password="p")


def test_create_user_missing_id_is_member_error() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(200, {"email": "m@x.io"})
        with pytest.raises(MemberError):
            client.create_user(email="m@x.io", password="p")


def test_create_user_network_error_is_member_error() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.side_effect = httpx.ConnectError("boom")
        with pytest.raises(MemberError):
            client.create_user(email="m@x.io", password="p")


def test_service_role_rejected_maps_to_member_error() -> None:
    client = _client()
    for status in (401, 403):
        with patch("hermes_cli.members.httpx.request") as req:
            req.return_value = _mock_response(status, {"msg": "no"})
            with pytest.raises(MemberError):
                client.create_user(email="m@x.io", password="p")


# ---------------------------------------------------------------------------
# GoTrueAdminClient — list / password / ban / delete
# ---------------------------------------------------------------------------


def test_list_users_paginates_until_short_page() -> None:
    client = _client()
    page1 = {"users": [{"id": f"u{i}", "email": f"{i}@x.io"} for i in range(1000)]}
    page2 = {"users": [{"id": "last", "email": "last@x.io"}]}
    with patch("hermes_cli.members.httpx.request") as req:
        req.side_effect = [
            _mock_response(200, page1),
            _mock_response(200, page2),
        ]
        users = client.list_users(per_page=1000)
    assert len(users) == 1001
    assert users["last"]["email"] == "last@x.io"
    assert req.call_count == 2


def test_set_password_puts_password() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(200, {"id": _SUB})
        client.set_password(user_id=_SUB, password="new-temp-pass")
    method, url = req.call_args.args
    assert method == "PUT"
    assert url == f"{_URL}/auth/v1/admin/users/{_SUB}"
    assert req.call_args.kwargs["json"] == {"password": "new-temp-pass"}


def test_set_banned_uses_long_duration_and_none_to_clear() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(200, {"id": _SUB})
        client.set_banned(user_id=_SUB, banned=True)
        banned_body = req.call_args.kwargs["json"]
        client.set_banned(user_id=_SUB, banned=False)
        unban_body = req.call_args.kwargs["json"]
    assert banned_body["ban_duration"] not in ("", "none")
    assert unban_body["ban_duration"] == "none"


def test_delete_user_tolerates_404() -> None:
    client = _client()
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(404, "gone")
        client.delete_user(user_id=_SUB)  # no raise
    with patch("hermes_cli.members.httpx.request") as req:
        req.return_value = _mock_response(500, "err")
        with pytest.raises(MemberError):
            client.delete_user(user_id=_SUB)


# ---------------------------------------------------------------------------
# Authorization gate
# ---------------------------------------------------------------------------


def _principal(role: Role, user_id: str = "u1") -> Principal:
    return Principal(user_id=user_id, display="", role=role)


def test_require_member_admin_allows_owner_and_admin() -> None:
    require_member_admin(_principal("owner"))
    require_member_admin(_principal("admin"))


def test_require_member_admin_rejects_member_and_viewer() -> None:
    for role in ("member", "viewer"):
        with pytest.raises(MemberAuthorizationError):
            require_member_admin(_principal(role))  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# MemberService — over fakes
# ---------------------------------------------------------------------------


class _FakeStore:
    """Minimal PrincipalStore stand-in for MemberService orchestration tests.

    Filtering/paging is implemented here the way Postgres does it in
    ``list_principals`` (filter, then slice) so a test that asserts a page's
    contents is asserting the same order of operations as production.
    """

    def __init__(self) -> None:
        self.principals: dict[str, Principal] = {}
        self.enroll_error: Exception | None = None
        self.unenrolled: list[str] = []
        self.app_store = MagicMock()

    async def enroll(
        self, user_id: str, *, display: str = "", role: Role = "member"
    ) -> Principal:
        if self.enroll_error is not None:
            raise self.enroll_error
        p = Principal(user_id=user_id, display=display, role=role)
        self.principals[user_id] = p
        return p

    def _filtered(
        self,
        query: str | None,
        role: Role | None,
        active: bool | None,
        user_ids: list[str] | None = None,
    ) -> list[Principal]:
        rows = list(self.principals.values())
        text = (query or "").strip().lower()
        if text:
            matched = set(user_ids or ())
            rows = [
                p
                for p in rows
                if text in p.display.lower()
                or text in p.user_id.lower()
                or p.user_id in matched
            ]
        if role is not None:
            rows = [p for p in rows if p.role == role]
        if active is not None:
            rows = [p for p in rows if p.active == active]
        return rows

    async def list_principals(
        self,
        *,
        query: str | None = None,
        role: Role | None = None,
        active: bool | None = None,
        user_ids: list[str] | None = None,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[Principal]:
        rows = self._filtered(query, role, active, user_ids)[offset:]
        return rows[:limit] if limit is not None else rows

    async def count_principals(
        self,
        *,
        query: str | None = None,
        role: Role | None = None,
        active: bool | None = None,
        user_ids: list[str] | None = None,
    ) -> int:
        return len(self._filtered(query, role, active, user_ids))

    async def get(self, user_id: str) -> Principal | None:
        return self.principals.get(user_id)

    async def resolve_alias(self, subject: str) -> str | None:
        return None

    async def get_owner(self) -> Principal | None:
        for p in self.principals.values():
            if p.role == "owner":
                return p
        return None

    async def set_role(self, user_id: str, role: Role) -> Principal:
        if user_id not in self.principals:
            raise KeyError(f"No such principal: {user_id}")
        existing = self.principals[user_id]
        if existing.role == "owner":
            raise ValueError("Cannot change the owner's role here")
        updated = Principal(user_id=user_id, display=existing.display, role=role)
        self.principals[user_id] = updated
        return updated

    async def set_display(self, user_id: str, display: str) -> Principal:
        if user_id not in self.principals:
            raise KeyError(f"No such principal: {user_id}")
        existing = self.principals[user_id]
        updated = Principal(
            user_id=user_id,
            display=display,
            role=existing.role,
            active=existing.active,
        )
        self.principals[user_id] = updated
        return updated

    async def set_active(self, user_id: str, active: bool) -> Principal:
        if user_id not in self.principals:
            raise KeyError(f"No such principal: {user_id}")
        existing = self.principals[user_id]
        updated = Principal(
            user_id=user_id,
            display=existing.display,
            role=existing.role,
            active=active,
        )
        self.principals[user_id] = updated
        return updated

    async def unenroll(self, user_id: str) -> None:
        self.unenrolled.append(user_id)
        self.principals.pop(user_id, None)


class _FakeAdmin:
    def __init__(self, *, users: dict[str, dict[str, Any]] | None = None) -> None:
        self.users = users or {}
        self.created: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.passwords: list[str] = []
        self.activated: list[tuple[str, str]] = []
        self.bans: list[tuple[str, bool]] = []

    def create_user(
        self,
        *,
        email: str,
        password: str,
        display: str = "",
        banned: bool = False,
    ) -> dict:
        uid = f"gotrue-{len(self.created)}"
        self.created.append(
            {"email": email, "id": uid, "password": password, "banned": banned}
        )
        self.users[uid] = {
            "id": uid,
            "email": email,
            "banned_until": "2999-01-01T00:00:00Z" if banned else None,
        }
        return {"id": uid, "email": email}

    def list_users(self) -> dict[str, dict[str, Any]]:
        return self.users

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        wanted = email.strip().lower()
        for user in self.users.values():
            if str(user.get("email", "")).strip().lower() == wanted:
                return user
        return None

    def set_password(self, *, user_id: str, password: str) -> None:
        self.passwords.append(user_id)

    def activate_with_password(self, *, user_id: str, password: str) -> None:
        self.activated.append((user_id, password))
        account = self.users.get(user_id)
        if account is not None:
            account["banned_until"] = None

    def set_banned(self, *, user_id: str, banned: bool) -> None:
        self.bans.append((user_id, banned))

    def delete_user(self, *, user_id: str) -> None:
        self.deleted.append(user_id)
        self.users.pop(user_id, None)


class _FakeInvitations:
    """In-memory InvitationStore stand-in (the real one is covered E2E).

    Keeps the two properties the service depends on: minting revokes the
    person's earlier open invitation, and a claim is single-use.
    """

    def __init__(self) -> None:
        self.rows: dict[str, Invitation] = {}
        self.tokens: dict[str, str] = {}
        self.revoked: list[str] = []
        self.released: list[str] = []
        self._n = 0

    async def mint(
        self,
        *,
        user_id: str,
        created_by: str,
        kind: str = "activation",
    ) -> MintedInvitation:
        await self.revoke(user_id=user_id)
        self._n += 1
        invitation = Invitation(
            id=f"inv-{self._n}",
            user_id=user_id,
            kind=kind,  # type: ignore[arg-type]
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=300),
            used_at=None,
            revoked_at=None,
            created_by=created_by,
            created_at=datetime.now(timezone.utc),
        )
        token = f"token-{self._n}"
        self.rows[invitation.id] = invitation
        self.tokens[token] = invitation.id
        return MintedInvitation(invitation, token)

    async def revoke(self, *, user_id: str) -> int:
        open_ids = [
            inv.id
            for inv in self.rows.values()
            if inv.user_id == user_id
            and inv.used_at is None
            and inv.revoked_at is None
        ]
        for inv_id in open_ids:
            row = self.rows[inv_id]
            self.rows[inv_id] = dataclasses.replace(
                row, revoked_at=datetime.now(timezone.utc)
            )
            self.revoked.append(inv_id)
        return len(open_ids)

    async def latest_for_users(self, user_ids: list[str]) -> dict[str, Invitation]:
        latest: dict[str, Invitation] = {}
        for inv in self.rows.values():
            if inv.user_id in user_ids:
                latest[inv.user_id] = inv
        return latest

    async def claim(self, token: str) -> Invitation | None:
        inv_id = self.tokens.get(token)
        if inv_id is None:
            return None
        row = self.rows[inv_id]
        if row.used_at is not None or row.revoked_at is not None:
            return None
        claimed = dataclasses.replace(row, used_at=datetime.now(timezone.utc))
        self.rows[inv_id] = claimed
        return claimed

    async def release(self, invitation_id: str) -> None:
        self.released.append(invitation_id)
        row = self.rows[invitation_id]
        self.rows[invitation_id] = dataclasses.replace(row, used_at=None)


@pytest.fixture
def audit_events() -> Any:
    """Capture identity audit events instead of writing C5, and expose them.

    Every service test runs with this active, so an assertion that a token
    never reaches the audit trail can read what would have been recorded.
    """
    events: list[dict[str, Any]] = []

    async def _record(
        *,
        store: Any,
        actor_user_id: str,
        action: str,
        user_id: str,
        payload: Any = None,
        config: Any = None,
    ) -> None:
        events.append(
            {
                "actor": actor_user_id,
                "action": action,
                "user_id": user_id,
                "payload": dict(payload or {}),
            }
        )

    with patch("hermes_cli.identity_audit.record_identity_event", _record):
        yield events


@pytest.fixture(autouse=True)
def administered_default() -> Any:
    """Pin the administered profile so ``profile`` validation is deterministic."""
    with patch("hermes_cli.members.administered_profile", return_value="default"):
        yield


def _profile_entry(name: str, home: Path) -> ProfileRegistryEntry:
    return ProfileRegistryEntry(
        name=name,
        hermes_home=home,
        is_default=(name == "default"),
        served=True,
        base_url="" if name == "default" else f"/p/{name}/",
        schema="app_prod" if name == "default" else f"app_prod_{name}",
        has_env=False,
        gateway_running=False,
    )


def _service(
    store: _FakeStore,
    admin: _FakeAdmin,
    invitations: _FakeInvitations | None = None,
    *,
    profiles: dict[str, tuple[Path, _FakeStore]] | None = None,
) -> MemberService:
    """A service over fakes on a real profile registry.

    By default the box has one profile — the per-test ``HERMES_HOME`` — whose
    ``principals`` are ``store``; pass ``profiles`` for a multi-profile box.
    """
    if profiles is None:
        profiles = {"default": (Path(os.environ["HERMES_HOME"]), store)}
    by_home = {home: profile_store for home, profile_store in profiles.values()}
    for home in by_home:
        home.mkdir(parents=True, exist_ok=True)
    return MemberService(
        store,  # type: ignore[arg-type]
        admin,  # type: ignore[arg-type]
        invitations=invitations or _FakeInvitations(),  # type: ignore[arg-type]
        store_factory=lambda home: by_home[home],
        registry=[_profile_entry(name, home) for name, (home, _) in profiles.items()],
    )


def _pending_account(user_id: str = _SUB) -> dict[str, Any]:
    """A GoTrue account as FG-26 creates it: banned, never signed in."""
    return {
        "id": user_id,
        "email": "mia@x.io",
        "banned_until": "2999-01-01T00:00:00Z",
        "last_sign_in_at": None,
    }


# -- creation ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_member_creates_banned_account_and_mints_invitation(
    audit_events: list[dict[str, Any]],
) -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    invitations = _FakeInvitations()
    svc = _service(store, admin, invitations)
    created = await svc.create_member(
        _principal("owner"),
        email="new@x.io",
        profile="default",
        display="New",
        role="member",
    )
    assert created.enrolled_existing is False
    assert created.principal.role == "member"
    assert created.principal.user_id in store.principals
    # Created banned, with a server-side password the admin never chose or saw.
    account = admin.created[0]
    assert account["banned"] is True
    assert len(account["password"]) >= 12
    # The raw token is returned exactly once, and never lands in the audit log.
    assert created.invitation_token == "token-1"
    assert any(e["action"] == "user.create" for e in audit_events)
    assert "token-1" not in json.dumps(audit_events)


@pytest.mark.asyncio
async def test_create_member_enrolls_existing_account_without_invitation(
    audit_events: list[dict[str, Any]],
) -> None:
    """A shared ``auth.users`` makes a known email a second enrolment.

    The person keeps the password they already use elsewhere, so no invitation
    is minted and no account write happens at all.
    """
    admin = _FakeAdmin(users={_SUB: {"id": _SUB, "email": "mia@x.io"}})
    store = _FakeStore()
    invitations = _FakeInvitations()
    svc = _service(store, admin, invitations)
    created = await svc.create_member(
        _principal("owner"), email="mia@x.io", profile="default", role="viewer"
    )
    assert created.enrolled_existing is True
    assert created.invitation is None and created.invitation_token is None
    assert created.principal.user_id == _SUB
    assert admin.created == [] and admin.passwords == []
    assert invitations.rows == {}
    assert [e["action"] for e in audit_events] == ["user.enroll_existing"]


@pytest.mark.asyncio
async def test_create_member_refuses_somebody_already_enrolled_here(
    audit_events: list[dict[str, Any]],
) -> None:
    """Enrolment is an upsert, so a silent success would change nothing.

    The requested role would not be applied and a suspended row would stay
    suspended, while the console reported that the person had been added.
    """
    admin = _FakeAdmin(users={_SUB: {"id": _SUB, "email": "mia@x.io"}})
    store = _FakeStore()
    await store.enroll(_SUB, display="Mia", role="member")
    svc = _service(store, admin)

    with pytest.raises(MemberError) as excinfo:
        await svc.create_member(
            _principal("owner"), email="mia@x.io", profile="default", role="admin"
        )
    assert "already enrolled" in str(excinfo.value)
    assert store.principals[_SUB].role == "member"
    assert audit_events == []

    # A suspended enrolment says so, and points at the action that restores it
    # (which is audited as a restore rather than hidden inside a create).
    await store.set_active(_SUB, False)
    with pytest.raises(MemberError) as suspended:
        await svc.create_member(
            _principal("owner"), email="mia@x.io", profile="default"
        )
    assert "suspended" in str(suspended.value)
    assert store.principals[_SUB].active is False


@pytest.mark.asyncio
async def test_create_member_refuses_foreign_profile_before_touching_gotrue(
    audit_events: list[dict[str, Any]],
) -> None:
    """A 409 must not leave an orphan account behind.

    The account table is shared box-wide, so a rejected create that had already
    reached GoTrue would leave an account nobody's principals row references —
    which is why the profile check runs before any account operation.
    """
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    with pytest.raises(MemberProfileMismatchError) as excinfo:
        await svc.create_member(
            _principal("owner"), email="x@x.io", profile="other-tenant"
        )
    assert "FG-28" in str(excinfo.value)
    assert admin.created == [] and admin.deleted == []
    assert store.principals == {}
    assert audit_events == []


@pytest.mark.asyncio
async def test_create_member_requires_profile() -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    with pytest.raises(MemberError):
        await svc.create_member(_principal("owner"), email="x@x.io", profile="")
    assert not admin.created


@pytest.mark.asyncio
async def test_create_member_requires_admin() -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    for role in ("member", "viewer"):
        with pytest.raises(MemberAuthorizationError):
            await svc.create_member(
                _principal(role),  # type: ignore[arg-type]
                email="x@x.io",
                profile="default",
            )
    assert not admin.created  # never touched GoTrue


@pytest.mark.asyncio
async def test_create_member_rejects_owner_role() -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    with pytest.raises(MemberError):
        await svc.create_member(
            _principal("owner"),
            email="x@x.io",
            profile="default",
            role="owner",  # type: ignore[arg-type]
        )
    assert not admin.created


@pytest.mark.asyncio
async def test_create_member_rolls_back_gotrue_on_enroll_failure() -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    store.enroll_error = RuntimeError("db down")
    svc = _service(store, admin)
    with pytest.raises(RuntimeError):
        await svc.create_member(
            _principal("admin"), email="x@x.io", profile="default"
        )
    # The freshly created GoTrue account is deleted so no orphan lingers.
    assert admin.deleted == [admin.created[0]["id"]]


@pytest.mark.asyncio
async def test_create_member_rolls_back_account_and_enrolment_if_mint_fails() -> None:
    """An account that exists but can never be activated is worse than none."""
    store, admin = _FakeStore(), _FakeAdmin()
    invitations = _FakeInvitations()

    async def _boom(**_kwargs: Any) -> MintedInvitation:
        raise InvitationError("no")

    invitations.mint = _boom  # type: ignore[method-assign]
    svc = _service(store, admin, invitations)
    with pytest.raises(InvitationError):
        await svc.create_member(
            _principal("owner"), email="x@x.io", profile="default"
        )
    created_id = admin.created[0]["id"]
    assert store.unenrolled == [created_id]
    assert admin.deleted == [created_id]


# -- CSV import --------------------------------------------------------------


def test_parse_member_csv_reports_bad_rows_without_failing_the_batch() -> None:
    rows = parse_member_csv(
        "email,display,role\n"
        "a@x.io,Ann,admin\n"
        "not-an-email,Bob,member\n"
        'c@x.io,"Cee, Jr.",viewer\n'
        "d@x.io,Dee,owner\n"
    )
    assert [r.email for r in rows] == ["a@x.io", "not-an-email", "c@x.io", "d@x.io"]
    assert rows[0].role == "admin" and not rows[0].error
    assert "email" in rows[1].error
    assert rows[2].display == "Cee, Jr." and rows[2].role == "viewer"
    # 'owner' is not assignable here, and the row says so rather than raising.
    assert "role must be one of" in rows[3].error


@pytest.mark.asyncio
async def test_import_members_dry_run_creates_nothing() -> None:
    admin = _FakeAdmin(users={_SUB: {"id": _SUB, "email": "mia@x.io"}})
    store, invitations = _FakeStore(), _FakeInvitations()
    svc = _service(store, admin, invitations)
    outcome = await svc.import_members(
        _principal("owner"),
        csv_text="new@x.io,New,member\nmia@x.io,Mia,viewer\n",
        profile="default",
        dry_run=True,
    )
    assert outcome.dry_run is True
    assert [r.planned for r in outcome.rows] == [
        "create account + invite",
        "enrol existing account (no invitation)",
    ]
    assert admin.created == [] and store.principals == {}


@pytest.mark.asyncio
async def test_import_members_applies_and_reports_per_row_failures(
    audit_events: list[dict[str, Any]],
) -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin, _FakeInvitations())
    outcome = await svc.import_members(
        _principal("owner"),
        csv_text="a@x.io,Ann,admin\nbroken,Bob,member\nc@x.io,Cee,viewer\n",
        profile="default",
        dry_run=False,
    )
    assert outcome.failed == 1
    good = [r for r in outcome.rows if not r.error]
    assert [r.email for r in good] == ["a@x.io", "c@x.io"]
    # An applied row carries its one-time link as a path, not a bare token.
    assert all(
        str(r.as_dict()["activation_path"]).startswith("/activate/")
        for r in good
    )
    assert len(admin.created) == 2


# -- reads ------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_members_joins_account_state_and_pages() -> None:
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    admin = _FakeAdmin(
        users={_SUB: {"id": _SUB, "email": "mia@x.io", "banned_until": None}}
    )
    svc = _service(store, admin)
    page = await svc.list_members(_principal("owner"))
    by_id = {m.user_id: m for m in page.members}
    assert page.total == 2 and page.offset == 0
    # Owner enrolled before Supabase → unknown to GoTrue → blank email, active.
    assert by_id["leo_owner"].email == ""
    assert by_id["leo_owner"].active is True
    assert by_id[_SUB].email == "mia@x.io"
    assert by_id[_SUB].active is True

    second = await svc.list_members(_principal("owner"), limit=1, offset=1)
    assert second.total == 2
    assert [m.user_id for m in second.members] == [_SUB]


@pytest.mark.asyncio
async def test_list_members_search_and_filters_are_applied_with_the_total() -> None:
    """A filtered page's ``total`` must describe the filtered set.

    Otherwise the console renders "1-25 of 300" over a three-row result and its
    pagination walks off the end of the data.
    """
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Ann", role="admin"),
        "u2": Principal(user_id="u2", display="Bob", role="member"),
        "u3": Principal(user_id="u3", display="Bobbie", role="member", active=False),
    }
    svc = _service(store, _FakeAdmin())

    matched = await svc.list_members(_principal("owner"), query="bob")
    assert matched.total == 2
    assert {m.user_id for m in matched.members} == {"u2", "u3"}

    admins = await svc.list_members(_principal("owner"), role="admin")
    assert admins.total == 1 and admins.members[0].user_id == "u1"

    inactive = await svc.list_members(_principal("owner"), active=False)
    assert inactive.total == 1
    assert inactive.members[0].user_id == "u3"
    assert inactive.members[0].enrolled is False


@pytest.mark.asyncio
async def test_list_members_searches_the_email_the_console_displays() -> None:
    """Searching an address must find the row that shows that address.

    Email lives in GoTrue, not in the profile schema, so the SQL predicate
    (display + user_id) could never match one: on the box, typing the email a
    console row was displaying returned an empty roster.
    """
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Ann", role="admin"),
        "u2": Principal(user_id="u2", display="Bob", role="member"),
    }
    admin = _FakeAdmin(
        users={
            "u1": {"id": "u1", "email": "ann@example.com"},
            "u2": {"id": "u2", "email": "bob@other.test"},
        }
    )
    svc = _service(store, admin)

    exact = await svc.list_members(_principal("owner"), query="bob@other.test")
    assert exact.total == 1 and exact.members[0].user_id == "u2"

    domain = await svc.list_members(_principal("owner"), query="@example.com")
    assert domain.total == 1 and domain.members[0].user_id == "u1"

    # The local part, with no ``@`` — the half of an address people remember.
    local = await svc.list_members(_principal("owner"), query="bob@")
    assert local.total == 1 and local.members[0].user_id == "u2"

    # An address nobody holds matches nobody — not the whole roster.
    missing = await svc.list_members(_principal("owner"), query="nope@nope.io")
    assert missing.total == 0 and missing.members == ()

    # A non-email query still searches display/user_id in Postgres.
    by_name = await svc.list_members(_principal("owner"), query="ann")
    assert by_name.total == 1 and by_name.members[0].user_id == "u1"


@pytest.mark.asyncio
async def test_list_members_search_matches_a_name_or_an_address() -> None:
    """One search box: the email join widens the search, it does not replace it.

    A fragment that is somebody's display name and somebody else's address must
    return both rows — filtering to the email matches would have hidden the
    person whose *name* matched.
    """
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Ada", role="admin"),
        "u2": Principal(user_id="u2", display="Grace", role="member"),
    }
    admin = _FakeAdmin(
        users={
            "u1": {"id": "u1", "email": "al@corp.example"},
            "u2": {"id": "u2", "email": "ada.hopper@corp.example"},
        }
    )
    svc = _service(store, admin)

    page = await svc.list_members(_principal("owner"), query="ada")
    assert page.total == 2
    assert {m.user_id for m in page.members} == {"u1", "u2"}


@pytest.mark.asyncio
async def test_list_members_exposes_invitation_status_but_never_a_token() -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    invitations = _FakeInvitations()
    await invitations.mint(user_id=_SUB, created_by="leo_owner")
    svc = _service(store, _FakeAdmin(), invitations)
    page = await svc.list_members(_principal("owner"))
    invitation = page.members[0].as_dict()["invitation"]
    assert isinstance(invitation, dict)
    assert invitation["status"] == "open"
    assert "token" not in json.dumps(page.as_dict())


@pytest.mark.asyncio
async def test_list_members_requires_admin() -> None:
    svc = _service(_FakeStore(), _FakeAdmin())
    for role in ("member", "viewer"):
        with pytest.raises(MemberAuthorizationError):
            await svc.list_members(_principal(role))  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_list_members_marks_banned_inactive() -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(
        users={
            _SUB: {
                "id": _SUB,
                "email": "mia@x.io",
                "banned_until": "2999-01-01T00:00:00Z",
            }
        }
    )
    svc = _service(store, admin)
    page = await svc.list_members(_principal("admin"))
    assert page.members[0].active is False


@pytest.mark.asyncio
async def test_directory_is_visible_to_members_and_hides_admin_state() -> None:
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        "u2": Principal(user_id="u2", display="Bob", role="member"),
        "u3": Principal(user_id="u3", display="Gone", role="member", active=False),
    }
    svc = _service(store, _FakeAdmin())
    entries, total = await svc.directory(_principal("viewer"))
    assert total == 2
    payload = [e.as_dict() for e in entries]
    assert {str(p["user_id"]) for p in payload} == {"leo_owner", "u2"}
    # No email, ban state or invitation lifecycle in a member-visible view.
    assert set(payload[0]) == {"user_id", "display", "role", "channels"}


# -- invitations -------------------------------------------------------------


@pytest.mark.asyncio
async def test_issue_invitation_regenerates_and_revokes_the_previous_link(
    audit_events: list[dict[str, Any]],
) -> None:
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Leo", role="owner"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    invitations = _FakeInvitations()
    svc = _service(store, _FakeAdmin(users={_SUB: _pending_account()}), invitations)
    first, first_token = await svc.issue_invitation(
        _principal("owner"), user_id=_SUB
    )
    second, second_token = await svc.issue_invitation(
        _principal("owner"), user_id=_SUB
    )
    assert first_token != second_token
    assert invitations.revoked == [first.id]
    assert second.status() == "open"
    assert first_token not in json.dumps(audit_events)


@pytest.mark.asyncio
async def test_issue_invitation_requires_admin_and_an_enrolled_target() -> None:
    store = _FakeStore()
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberAuthorizationError):
        await svc.issue_invitation(_principal("member"), user_id=_SUB)
    with pytest.raises(MemberError):
        await svc.issue_invitation(_principal("owner"), user_id="ghost")


def test_account_is_activated_only_leaves_pending_for_banned_never_signed_in() -> None:
    pending = _pending_account()
    assert not _account_is_activated(pending)
    # Signed in once, even if banned since: a live account.
    assert _account_is_activated({**pending, "last_sign_in_at": "2026-01-01T00:00:00Z"})
    # Ban lifted (activated, or an existing account enrolled here).
    assert _account_is_activated({**pending, "banned_until": None})
    assert _account_is_activated({**pending, "banned_until": "none"})
    # No account: nothing an activation link could legitimately do.
    assert _account_is_activated(None)


@pytest.mark.asyncio
async def test_first_activation_of_an_account_created_here_still_works(
    audit_events: list[dict[str, Any]],
) -> None:
    store = _FakeStore()
    store.principals = {
        "leo_admin": Principal(user_id="leo_admin", display="Admin", role="admin")
    }
    admin = _FakeAdmin()
    svc = _service(store, admin)
    created = await svc.create_member(
        _principal("admin", "leo_admin"), email="mia@x.io", profile="default"
    )
    user_id = created.principal.user_id

    # The admin missed the first link and regenerates it.
    _invitation, token = await svc.issue_invitation(
        _principal("admin", "leo_admin"), user_id=user_id
    )
    assert await svc.redeem_invitation(token=token, password="correct-horse-battery")
    assert admin.activated == [(user_id, "correct-horse-battery")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "account",
    [
        {"banned_until": None},
        {"last_sign_in_at": "2026-01-01T00:00:00Z"},
    ],
    ids=["ban-lifted", "signed-in-then-banned"],
)
async def test_issue_invitation_refuses_an_activated_account(account) -> None:
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Leo", role="owner"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    invitations = _FakeInvitations()
    svc = _service(
        store, _FakeAdmin(users={_SUB: {**_pending_account(), **account}}), invitations
    )
    for kind in ("activation", "recovery"):
        with pytest.raises(MemberAuthorizationError, match="Forgot password"):
            await svc.issue_invitation(_principal("owner"), user_id=_SUB, kind=kind)
    assert invitations.rows == {}


@pytest.mark.asyncio
async def test_a_reset_request_lets_an_admin_send_a_recovery_link_only() -> None:
    """Self-service reset: the holder asks, the console hands over the link."""
    store = _FakeStore()
    store.principals = {
        "u1": Principal(user_id="u1", display="Leo", role="owner"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    admin = _FakeAdmin(users={_SUB: {**_pending_account(), "banned_until": None}})
    invitations = _FakeInvitations()
    svc = _service(store, admin, invitations)
    assert await svc.request_password_reset(email="mia@x.io") is not None

    invitation, token = await svc.issue_invitation(_principal("owner"), user_id=_SUB)
    assert invitation.kind == "recovery"
    assert await svc.redeem_invitation(token=token, password="correct-horse-battery")

    # The request is spent with the link; another link needs another request.
    with pytest.raises(MemberAuthorizationError):
        await svc.issue_invitation(_principal("owner"), user_id=_SUB)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("actor_role", "target_role", "allowed"),
    [
        ("admin", "owner", False),
        ("admin", "admin", False),
        ("admin", "member", True),
        ("admin", "viewer", True),
        ("owner", "admin", True),
    ],
)
async def test_issue_invitation_only_goes_down_the_role_ladder(
    actor_role: Role, target_role: Role, allowed: bool
) -> None:
    store = _FakeStore()
    store.principals = {
        "actor": Principal(user_id="actor", display="Actor", role=actor_role),
        _SUB: Principal(user_id=_SUB, display="Mia", role=target_role),
    }
    invitations = _FakeInvitations()
    svc = _service(store, _FakeAdmin(users={_SUB: _pending_account()}), invitations)
    actor = _principal(actor_role, "actor")
    if allowed:
        await svc.issue_invitation(actor, user_id=_SUB)
        assert len(invitations.rows) == 1
    else:
        with pytest.raises(MemberAuthorizationError):
            await svc.issue_invitation(actor, user_id=_SUB)
        assert invitations.rows == {}


@pytest.mark.asyncio
async def test_issue_invitation_refuses_a_target_enrolled_where_the_actor_is_not_admin(
    tmp_path: Path,
) -> None:
    """An hr admin must not mint a link for someone who also works in engineers."""
    hr, engineers = _FakeStore(), _FakeStore()
    hr.principals = {
        "hr-admin": Principal(user_id="hr-admin", display="CFO", role="admin"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    engineers.principals = {
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    invitations = _FakeInvitations()
    svc = _service(
        hr,
        _FakeAdmin(users={_SUB: _pending_account()}),
        invitations,
        profiles={
            "hr": (tmp_path / "hr", hr),
            "engineers": (tmp_path / "engineers", engineers),
        },
    )
    actor = _principal("admin", "hr-admin")
    with pytest.raises(AccountLevelPermissionError, match="engineers"):
        await svc.issue_invitation(actor, user_id=_SUB)
    assert invitations.rows == {}

    # Administering both profiles is enough authority.
    engineers.principals["hr-admin"] = Principal(
        user_id="hr-admin", display="CFO", role="admin"
    )
    await svc.issue_invitation(actor, user_id=_SUB)
    assert len(invitations.rows) == 1


@pytest.mark.asyncio
async def test_redeem_refuses_an_activation_link_for_an_activated_account(
    audit_events: list[dict[str, Any]],
) -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(
        users={_SUB: {**_pending_account(), "last_sign_in_at": "2026-01-01T00:00:00Z"}}
    )
    invitations = _FakeInvitations()
    minted = await invitations.mint(user_id=_SUB, created_by="leo_owner")
    svc = _service(store, admin, invitations)

    assert not await svc.redeem_invitation(
        token=minted.token, password="correct-horse-battery"
    )
    assert admin.activated == []
    assert not any(e["action"] == "user.activate" for e in audit_events)
    # The link is spent, not handed back for another try.
    assert invitations.released == []
    assert not await svc.redeem_invitation(
        token=minted.token, password="correct-horse-battery"
    )


@pytest.mark.asyncio
async def test_redeem_still_honours_a_recovery_link_for_an_activated_account() -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(users={_SUB: {**_pending_account(), "banned_until": None}})
    invitations = _FakeInvitations()
    minted = await invitations.mint(
        user_id=_SUB, created_by="leo_owner", kind="recovery"
    )
    svc = _service(store, admin, invitations)
    assert await svc.redeem_invitation(
        token=minted.token, password="correct-horse-battery"
    )
    assert admin.activated == [(_SUB, "correct-horse-battery")]


@pytest.mark.asyncio
async def test_redeem_invitation_sets_password_unbans_and_is_single_use(
    audit_events: list[dict[str, Any]],
) -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(
        users={
            _SUB: {
                "id": _SUB,
                "email": "mia@x.io",
                "banned_until": "2999-01-01T00:00:00Z",
            }
        }
    )
    invitations = _FakeInvitations()
    minted = await invitations.mint(user_id=_SUB, created_by="leo_owner")
    svc = _service(store, admin, invitations)

    assert await svc.redeem_invitation(
        token=minted.token, password="correct-horse-battery"
    )
    assert admin.activated == [(_SUB, "correct-horse-battery")]
    assert admin.users[_SUB]["banned_until"] is None
    assert any(e["action"] == "user.activate" for e in audit_events)
    assert "correct-horse-battery" not in json.dumps(audit_events)

    # A second redemption of the same link fails — indistinguishably.
    assert not await svc.redeem_invitation(
        token=minted.token, password="correct-horse-battery"
    )


@pytest.mark.asyncio
async def test_redeem_invitation_is_false_for_every_bad_token() -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    invitations = _FakeInvitations()
    svc = _service(store, _FakeAdmin(), invitations)

    # Unknown, and revoked, both answer identically.
    assert not await svc.redeem_invitation(token="nope", password="password-1234")
    minted = await invitations.mint(user_id=_SUB, created_by="leo_owner")
    await invitations.revoke(user_id=_SUB)
    assert not await svc.redeem_invitation(
        token=minted.token, password="password-1234"
    )


@pytest.mark.asyncio
async def test_redeem_invitation_rejects_weak_password_without_burning_link() -> None:
    """A password the policy refuses is a form error, not a spent invitation."""
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(users={_SUB: _pending_account()})
    invitations = _FakeInvitations()
    minted = await invitations.mint(user_id=_SUB, created_by="leo_owner")
    svc = _service(store, admin, invitations)

    with pytest.raises(InvitationError):
        await svc.redeem_invitation(token=minted.token, password="short")
    assert invitations.released == [minted.invitation.id]
    assert admin.activated == []
    # The link still works with an acceptable password.
    assert await svc.redeem_invitation(
        token=minted.token, password="a-long-enough-password"
    )


@pytest.mark.asyncio
async def test_redeem_invitation_rejects_password_equal_to_email() -> None:
    store = _FakeStore()
    store.principals = {_SUB: Principal(user_id=_SUB, display="Mia", role="member")}
    admin = _FakeAdmin(users={_SUB: {**_pending_account(), "email": "mia@example.io"}})
    invitations = _FakeInvitations()
    minted = await invitations.mint(user_id=_SUB, created_by="leo_owner")
    svc = _service(store, admin, invitations)
    with pytest.raises(InvitationError):
        await svc.redeem_invitation(
            token=minted.token, password="mia@example.io"
        )
    assert admin.activated == []


@pytest.mark.asyncio
async def test_request_password_reset_is_silent_for_unknown_email() -> None:
    """The reset endpoint must not become an account-existence oracle."""
    store, admin = _FakeStore(), _FakeAdmin()
    invitations = _FakeInvitations()
    svc = _service(store, admin, invitations)
    assert await svc.request_password_reset(email="nobody@x.io") is None
    assert invitations.rows == {}


@pytest.mark.asyncio
async def test_request_password_reset_ignores_accounts_enrolled_elsewhere() -> None:
    """An account exists box-wide; a *reset here* needs an enrolment here."""
    admin = _FakeAdmin(users={_SUB: {"id": _SUB, "email": "mia@x.io"}})
    store, invitations = _FakeStore(), _FakeInvitations()
    svc = _service(store, admin, invitations)
    assert await svc.request_password_reset(email="mia@x.io") is None
    assert invitations.rows == {}


@pytest.mark.asyncio
async def test_request_password_reset_mints_a_recovery_invitation() -> None:
    admin = _FakeAdmin(users={_SUB: {"id": _SUB, "email": "mia@x.io"}})
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        _SUB: Principal(user_id=_SUB, display="Mia", role="member"),
    }
    invitations = _FakeInvitations()
    svc = _service(store, admin, invitations)
    invitation = await svc.request_password_reset(email="mia@x.io")
    assert invitation is not None and invitation.kind == "recovery"


# -- updates and self-protection --------------------------------------------


@pytest.mark.asyncio
async def test_set_member_role_guards_and_maps_errors() -> None:
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        "a1": Principal(user_id="a1", display="A", role="admin"),
        "m1": Principal(user_id="m1", display="M", role="member"),
    }
    svc = _service(store, _FakeAdmin())

    updated = await svc.set_member_role(
        _principal("owner", "leo_owner"), user_id="m1", role="admin"
    )
    assert updated.role == "admin"

    # Cannot re-role the owner via this path.
    with pytest.raises(MemberError):
        await svc.set_member_role(
            _principal("owner", "leo_owner"), user_id="leo_owner", role="admin"
        )
    # Cannot assign owner.
    with pytest.raises(MemberError):
        await svc.set_member_role(
            _principal("owner", "leo_owner"),
            user_id="a1",
            role="owner",  # type: ignore[arg-type]
        )
    # Unknown principal.
    with pytest.raises(MemberError):
        await svc.set_member_role(
            _principal("owner", "leo_owner"), user_id="ghost", role="member"
        )


@pytest.mark.asyncio
async def test_set_member_role_refuses_self_demotion() -> None:
    store = _FakeStore()
    store.principals = {
        "a1": Principal(user_id="a1", display="A", role="admin"),
        "a2": Principal(user_id="a2", display="B", role="admin"),
    }
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberError):
        await svc.set_member_role(
            _principal("admin", "a1"), user_id="a1", role="member"
        )
    assert store.principals["a1"].role == "admin"


@pytest.mark.asyncio
async def test_last_admin_cannot_be_demoted_deactivated_or_deleted() -> None:
    """A profile with no live administrator can only be fixed from the CLI."""
    store = _FakeStore()
    store.principals = {
        "a1": Principal(user_id="a1", display="A", role="admin"),
        "m1": Principal(user_id="m1", display="M", role="member"),
    }
    owner = _principal("owner", "leo_owner")
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberError):
        await svc.set_member_role(owner, user_id="a1", role="member")
    with pytest.raises(MemberError):
        await svc.set_member_active(owner, user_id="a1", active=False)
    assert store.principals["a1"].role == "admin"


@pytest.mark.asyncio
async def test_set_member_active_is_profile_local_not_a_ban() -> None:
    """Deactivation must not revoke the person's access to other profiles."""
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        "m1": Principal(user_id="m1", display="M", role="member"),
    }
    admin = _FakeAdmin()
    svc = _service(store, admin)
    updated = await svc.set_member_active(
        _principal("owner", "leo_owner"), user_id="m1", active=False
    )
    assert updated.active is False
    assert admin.bans == []  # the box-wide account is untouched


@pytest.mark.asyncio
async def test_set_member_active_and_display_require_admin() -> None:
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    with pytest.raises(MemberAuthorizationError):
        await svc.set_member_active(_principal("member"), user_id="m1", active=False)
    with pytest.raises(MemberAuthorizationError):
        await svc.set_member_display(_principal("viewer"), user_id="m1", display="X")
    assert not admin.bans


@pytest.mark.asyncio
async def test_set_member_active_refuses_self_deactivation() -> None:
    store = _FakeStore()
    store.principals = {
        "a1": Principal(user_id="a1", display="A", role="admin"),
        "a2": Principal(user_id="a2", display="B", role="admin"),
    }
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberError):
        await svc.set_member_active(
            _principal("admin", "a1"), user_id="a1", active=False
        )


@pytest.mark.asyncio
async def test_deactivated_admin_cannot_manage() -> None:
    """An enrolment that was switched off must not keep its authority."""
    store, admin = _FakeStore(), _FakeAdmin()
    svc = _service(store, admin)
    suspended = Principal(
        user_id="a1", display="A", role="admin", active=False
    )
    with pytest.raises(MemberAuthorizationError):
        await svc.create_member(suspended, email="x@x.io", profile="default")
    assert not admin.created


# -- deletion ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_member_is_owner_only_and_requires_a_strategy() -> None:
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        "m1": Principal(user_id="m1", display="M", role="member"),
    }
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberAuthorizationError):
        await svc.delete_member(
            _principal("admin", "a1"), user_id="m1", strategy="purge"
        )
    with pytest.raises(MemberError):
        await svc.delete_member(
            _principal("owner", "leo_owner"),
            user_id="m1",
            strategy="whatever",  # type: ignore[arg-type]
        )
    assert store.unenrolled == []


@pytest.mark.asyncio
async def test_delete_member_refuses_self_owner_and_missing_successor() -> None:
    store = _FakeStore()
    store.principals = {
        "leo_owner": Principal(user_id="leo_owner", display="Leo", role="owner"),
        "m1": Principal(user_id="m1", display="M", role="member"),
    }
    owner = _principal("owner", "leo_owner")
    svc = _service(store, _FakeAdmin())
    with pytest.raises(MemberError):
        await svc.delete_member(owner, user_id="leo_owner", strategy="purge")
    with pytest.raises(MemberError):
        await svc.delete_member(owner, user_id="ghost", strategy="purge")
    # strategy=transfer without a named inheritor is refused rather than guessed
    with pytest.raises(MemberError):
        await svc.delete_member(owner, user_id="m1", strategy="transfer")
    assert store.unenrolled == []


def test_member_view_as_dict_flags_owner() -> None:
    view = MemberView(
        user_id="leo_owner",
        display="Leo",
        role="owner",
        email="",
        active=True,
        channels=("telegram:1",),
    )
    d = view.as_dict()
    assert d["is_owner"] is True
    assert d["channels"] == ["telegram:1"]
    assert d["invitation"] is None


# ---------------------------------------------------------------------------
# link_member_channel — the allow-list identity gap
# ---------------------------------------------------------------------------


class _LinkStore(_FakeStore):
    """Fake store that also records channel links."""

    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str, str]] = []

    async def get(self, user_id: str) -> Principal | None:
        return self.principals.get(user_id)

    async def link_channel(
        self, user_id: str, platform: str, channel_user_id: str
    ) -> None:
        self.links.append((user_id, platform, channel_user_id))
        existing = self.principals[user_id]
        self.principals[user_id] = Principal(
            user_id=existing.user_id,
            display=existing.display,
            role=existing.role,
            channels=existing.channels + (f"{platform}:{channel_user_id}",),
        )

    async def unlink_channel(
        self, user_id: str, platform: str, channel_user_id: str
    ) -> bool:
        handle = f"{platform}:{channel_user_id}"
        existing = self.principals[user_id]
        self.principals[user_id] = Principal(
            user_id=existing.user_id,
            display=existing.display,
            role=existing.role,
            channels=tuple(c for c in existing.channels if c != handle),
        )
        return handle in existing.channels


def _link_store_with(role: Role = "owner", user_id: str = "leo_owner") -> _LinkStore:
    store = _LinkStore()
    store.principals[user_id] = Principal(user_id=user_id, display="", role=role)
    return store


@pytest.mark.asyncio
async def test_link_member_channel_links_and_returns_refreshed_principal() -> None:
    store = _link_store_with()
    principal = await link_member_channel(
        store,  # type: ignore[arg-type]
        _principal("owner"),
        user_id="leo_owner",
        platform="telegram",
        channel_user_id="8756039695",
    )
    assert store.links == [("leo_owner", "telegram", "8756039695")]
    # The returned principal carries the new channel, so a caller can show the
    # mapping it just made rather than the pre-link state.
    assert principal.channels == ("telegram:8756039695",)


@pytest.mark.asyncio
async def test_unlink_member_channel_removes_only_that_handle() -> None:
    store = _link_store_with()
    for handle in ("8756039695", "111"):
        await link_member_channel(
            store,  # type: ignore[arg-type]
            _principal("owner"),
            user_id="leo_owner",
            platform="telegram",
            channel_user_id=handle,
        )
    principal = await unlink_member_channel(
        store,  # type: ignore[arg-type]
        _principal("admin"),
        user_id="leo_owner",
        platform="Telegram",
        channel_user_id=" 8756039695 ",
    )
    assert principal.channels == ("telegram:111",)
    assert "leo_owner" in store.principals


@pytest.mark.asyncio
async def test_unlink_member_channel_refuses_handle_not_linked_here() -> None:
    store = _link_store_with()
    with pytest.raises(MemberError):
        await unlink_member_channel(
            store,  # type: ignore[arg-type]
            _principal("owner"),
            user_id="leo_owner",
            platform="telegram",
            channel_user_id="8756039695",
        )
    for role in ("member", "viewer"):
        with pytest.raises(MemberAuthorizationError):
            await unlink_member_channel(
                store,  # type: ignore[arg-type]
                _principal(role),  # type: ignore[arg-type]
                user_id="leo_owner",
                platform="telegram",
                channel_user_id="8756039695",
            )


@pytest.mark.asyncio
async def test_link_member_channel_requires_owner_or_admin() -> None:
    store = _link_store_with()
    for role in ("member", "viewer"):
        with pytest.raises(MemberAuthorizationError):
            await link_member_channel(
                store,  # type: ignore[arg-type]
                _principal(role),  # type: ignore[arg-type]
                user_id="leo_owner",
                platform="telegram",
                channel_user_id="8756039695",
            )
    assert store.links == []


@pytest.mark.asyncio
async def test_link_member_channel_refuses_unenrolled_principal() -> None:
    store = _link_store_with()
    with pytest.raises(MemberError):
        await link_member_channel(
            store,  # type: ignore[arg-type]
            _principal("owner"),
            user_id="leo_ownr",  # typo
            platform="telegram",
            channel_user_id="8756039695",
        )
    # A typo must not create a principal that inbound traffic then feeds.
    assert store.links == []
    assert "leo_ownr" not in store.principals


@pytest.mark.asyncio
async def test_link_member_channel_rejects_unknown_platform() -> None:
    store = _link_store_with()
    with pytest.raises(MemberError):
        await link_member_channel(
            store,  # type: ignore[arg-type]
            _principal("owner"),
            user_id="leo_owner",
            platform="telegramm",
            channel_user_id="8756039695",
        )
    assert store.links == []


@pytest.mark.asyncio
async def test_link_member_channel_normalizes_platform_case() -> None:
    """The stored platform must match ``source.platform.value`` at intake.

    A row stored as ``Telegram`` would never be found by a lookup for
    ``telegram``, so the link would silently do nothing.
    """
    store = _link_store_with()
    await link_member_channel(
        store,  # type: ignore[arg-type]
        _principal("owner"),
        user_id="leo_owner",
        platform="  TELEGRAM ",
        channel_user_id=" 8756039695 ",
    )
    assert store.links == [("leo_owner", "telegram", "8756039695")]
