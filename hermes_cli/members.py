"""Member management (PR-3) — GoTrue admin create → principal enrolment.

The owner/admin surface for onboarding and managing additional members of the
shared Hermes brain. A "member" is a Supabase Auth (GoTrue) account whose
subject UUID is enrolled as a :class:`~hermes_cli.access.Principal`, so the same
identity that logs in (via the ``supabase`` dashboard-auth provider) is the one
the multi-user RLS layer scopes data to.

Two collaborators, kept apart on purpose:

* :class:`GoTrueAdminClient` owns the account system — it calls GoTrue's
  **admin** endpoints (``/auth/v1/admin/users``) with the *service-role* key to
  create accounts, set/reset passwords, and ban/unban (deactivate/reactivate).
  It never touches Hermes state and never logs a secret or a password.
* :class:`MemberService` orchestrates: it authorises the actor (owner/admin
  only), drives the GoTrue account operation, and mirrors it into the
  :class:`~hermes_cli.access.PrincipalStore` (enrol / set-role). Account
  creation is transactional-ish: if enrolment fails after the GoTrue user is
  created, the GoTrue user is rolled back so a half-created member can't linger.

**Why the service-role key is env-only.** It can mint and delete any account,
so it is a credential — it lives in ``~/.hermes/.env`` (or the process env),
never in ``config.yaml`` and never in a browser. Only server-side code
(this module, the CLI, the owner/admin-guarded API) ever holds it.

**Signup stays closed.** This module is the *only* way accounts are created;
open self-signup is disabled at the GoTrue server
(``GOTRUE_DISABLE_SIGNUP=true``). New members always come through an
owner/admin here.

**FG-26 — what changed, and why.** Creation used to take a password chosen in
the browser and hand it to the admin to relay. Now the account is created
**banned, with a server-generated random password nobody sees**, and the admin
hands over a single-use :mod:`hermes_cli.invitations` link on which the invitee
sets their own password (which is also what unbans them). Three consequences
fall out of the shared-Supabase topology that FG-27 made explicit — all
profiles share one GoTrue, so an *account* is box-wide while *authority* is
per profile:

* An email that already has an account is an **enrolment**, not a conflict:
  somebody joining their second profile gets a ``principals`` row, no
  invitation, and their existing password untouched.
* Creation validates the requested ``profile`` **before** it calls GoTrue, so a
  refusal cannot leave an orphan account behind (FG-28 owns cross-profile
  assignment).
* "Deactivate" is a *per-profile* verb (``principals.active``), not a GoTrue
  ban: banning the shared account would evict the person from every other
  profile at once.
"""

from __future__ import annotations

import csv
import dataclasses
import io
import logging
import secrets
import shutil
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

import httpx

from agent.secret_scope import UnscopedSecretError, get_secret
from hermes_cli.access import ROLES, Principal, PrincipalStore, Role, role_rank
from hermes_cli.invitations import (
    Invitation,
    InvitationError,
    InvitationKind,
    InvitationStore,
    activation_path,
    validate_password,
)
from hermes_cli.ownership import (
    DELETE_STRATEGIES,
    DeleteStrategy,
    OwnershipOutcome,
    resolve_owned_rows,
)

logger = logging.getLogger(__name__)

# httpx timeout for the GoTrue admin round trips.
_ADMIN_TIMEOUT_SEC = 15.0

# GoTrue's ban semantics: a long finite duration bans (blocks login); the
# literal "none" clears the ban. Reversible, unlike deleting the account.
_BAN_DURATION = "876000h"  # ~100 years
_UNBAN_DURATION = "none"

# Roles a member-management actor may assign. ``owner`` is deliberately absent:
# the single owner only changes via the approval-gated ``hermes owner transfer``.
ASSIGNABLE_ROLES: tuple[Role, ...] = ("admin", "member", "viewer")

# Bytes of entropy in the throwaway password a created account carries until its
# invitation is redeemed. It is never displayed, logged, or returned — the
# account is banned until the invitee sets their own, so this value exists only
# because GoTrue requires *some* password at creation.
_PLACEHOLDER_PASSWORD_BYTES = 32

# Page size ceiling for the management list, so a caller cannot ask for the
# whole roster in one request by passing a huge limit.
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50


class MemberError(RuntimeError):
    """A member operation failed (GoTrue rejected it, or state was wrong)."""


class MemberConflictError(MemberError):
    """The account already exists (duplicate email)."""


class MemberProfileMismatchError(MemberError):
    """The requested profile is not the one this process administers.

    Surfaced as **409** by the API. Raised before any account operation runs:
    a process bound to profile A cannot write profile B's ``principals`` (its
    schema is claimed by B, and ``SupabaseAppStore.connect()`` fail-closes), so
    honouring the request is impossible rather than merely unimplemented — and
    creating the shared GoTrue account first would leave an orphan account
    behind on every refusal.
    """


class MemberAuthorizationError(PermissionError):
    """The acting principal is not allowed to manage members."""


def require_member_admin(actor: Principal) -> None:
    """Authorise ``actor`` for member management — owner or admin only.

    Members and viewers may never create, re-role, reset, or deactivate other
    members. This is the single authorization gate every :class:`MemberService`
    mutation and the API/CLI surfaces share.
    """
    if actor.role not in ("owner", "admin"):
        raise MemberAuthorizationError(
            "Only the owner or an admin may manage members "
            f"(actor role: {actor.role})."
        )
    if not actor.active:
        raise MemberAuthorizationError(
            "This enrolment has been deactivated in the current profile."
        )


def require_owner(actor: Principal) -> None:
    """Authorise ``actor`` for an operation that reaches beyond this profile.

    Anything touching the **account** rather than the enrolment (a hard delete,
    a password-affecting operation on somebody else) is owner-only in FG-26.
    The doc's finer rule — "the target is enrolled solely in profiles the actor
    administers" — cannot be evaluated from inside one profile's process, since
    reading another profile's ``principals`` is exactly what FG-27's ownership
    guard prevents; approximating it would be a guess about somebody else's
    profile, so the narrower gate stands until FG-28 provides a cross-profile
    view.
    """
    if actor.role != "owner":
        raise MemberAuthorizationError(
            "Only the owner may perform account-level user operations "
            f"(actor role: {actor.role})."
        )


def administered_profile() -> str:
    """Return the profile name this process administers (``default`` if unnamed)."""
    from hermes_cli.profiles import get_active_profile_name

    return get_active_profile_name()


def assert_profile_administered(profile: str) -> str:
    """Validate the create form's required ``profile`` against this process.

    Required rather than optional, and never silently coerced to the current
    profile: an admin who picked the wrong profile must be told, because the
    alternative is an account quietly enrolled into the wrong tenant.
    """
    requested = (profile or "").strip()
    if not requested:
        raise MemberError(
            "profile is required — name the profile this user is being "
            "enrolled into."
        )
    current = administered_profile()
    if requested != current:
        raise MemberProfileMismatchError(
            f"This console administers the {current!r} profile and cannot "
            f"enrol into {requested!r}. Cross-profile assignment arrives with "
            "FG-28; until then, run the console for that profile."
        )
    return current


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MemberView:
    """A principal joined with its GoTrue account state, for list/inspect.

    ``email`` / ``active`` come from GoTrue (empty / ``True`` when the account
    is unknown to GoTrue — e.g. the bootstrap owner enrolled before Supabase,
    or a channel-only principal). ``active`` is ``False`` when the account is
    currently banned.
    """

    user_id: str
    display: str
    role: Role
    email: str
    active: bool
    channels: tuple[str, ...]
    #: Whether the *enrolment* is live in this profile (``principals.active``),
    #: as opposed to ``active``, which reports the box-wide account.
    enrolled: bool = True
    #: Lifecycle of this person's most recent invitation, or ``None`` when they
    #: never had one (e.g. enrolled from an existing account). Never the token.
    invitation: Invitation | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "user_id": self.user_id,
            "display": self.display,
            "role": self.role,
            "email": self.email,
            "active": self.active,
            "enrolled": self.enrolled,
            "channels": list(self.channels),
            "is_owner": self.role == "owner",
            "invitation": (
                self.invitation.as_dict() if self.invitation else None
            ),
        }


@dataclass(frozen=True)
class DirectoryEntry:
    """What *any* enrolled principal may see about a colleague (FG-26 §3.1).

    The directory answers "who else is in this profile" — the question a member
    legitimately has when assigning a task or sharing a memory — without
    exposing account administration state (ban status, invitation lifecycle)
    that is the owner/admin's business. It is built from **this profile's**
    ``principals``, never from ``auth.users``: the account table is box-wide, so
    listing it would show people enrolled in other profiles entirely.
    """

    user_id: str
    display: str
    role: Role
    channels: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "user_id": self.user_id,
            "display": self.display,
            "role": self.role,
            "channels": list(self.channels),
        }


@dataclass(frozen=True)
class MemberPage:
    """One page of the management list plus the unpaged total."""

    members: tuple[MemberView, ...]
    total: int
    limit: int
    offset: int

    def as_dict(self) -> dict[str, object]:
        return {
            "members": [m.as_dict() for m in self.members],
            "total": self.total,
            "limit": self.limit,
            "offset": self.offset,
        }


@dataclass(frozen=True)
class CreatedMember:
    """Outcome of a create request — a new account, or an existing enrolment.

    ``invitation_token`` is the **only** place the raw token exists: it is
    returned once, for the response body the admin sees, and is never stored,
    logged, or re-derivable. It is ``None`` when ``enrolled_existing`` is true,
    because somebody who already has an account already has a password.
    """

    principal: Principal
    email: str
    enrolled_existing: bool
    invitation: Invitation | None = None
    invitation_token: str | None = None
    #: The profile the invitation was minted in; its link names it.
    profile: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "ok": True,
            "enrolled_existing": self.enrolled_existing,
            "member": {
                "user_id": self.principal.user_id,
                "display": self.principal.display,
                "role": self.principal.role,
                "email": self.email,
            },
            "invitation": (
                self.invitation.as_dict() if self.invitation else None
            ),
            "invitation_token": self.invitation_token,
            "activation_path": (
                activation_path(self.invitation_token, self.profile)
                if self.invitation_token
                else None
            ),
        }


@dataclass(frozen=True)
class ImportRow:
    """One CSV row's outcome — what it says, and what it did or would do."""

    line: int
    email: str
    display: str = ""
    role: Role = "member"
    planned: str = ""
    user_id: str = ""
    error: str = ""
    #: Present only on an applied row that created an account, and only in the
    #: response the importer receives. Never persisted or logged.
    invitation_token: str | None = None
    profile: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {
            "line": self.line,
            "email": self.email,
            "display": self.display,
            "role": self.role,
            "planned": self.planned,
            "user_id": self.user_id,
            "error": self.error,
            "activation_path": (
                activation_path(self.invitation_token, self.profile)
                if self.invitation_token
                else None
            ),
        }


@dataclass(frozen=True)
class ImportOutcome:
    """The result of a CSV import — a preview, or what was applied."""

    dry_run: bool
    rows: tuple[ImportRow, ...]

    @property
    def failed(self) -> int:
        return sum(1 for row in self.rows if row.error)

    def as_dict(self) -> dict[str, object]:
        return {
            "dry_run": self.dry_run,
            "rows": [row.as_dict() for row in self.rows],
            "total": len(self.rows),
            "failed": self.failed,
        }


def parse_member_csv(csv_text: str) -> list[ImportRow]:
    """Parse ``email[,display[,role]]`` rows, reporting per-row problems.

    Tolerant of a header line and of quoting (a display name with a comma is the
    normal case), and validates the role here rather than at enrolment so a
    dry run can show the problem before anything is created. Never raises: a
    bad row becomes a row with an ``error``, because an import of fifty people
    should report the two that are wrong, not refuse the batch.
    """
    rows: list[ImportRow] = []
    reader = csv.reader(io.StringIO(csv_text or ""))
    for line, fields in enumerate(reader, start=1):
        cells = [cell.strip() for cell in fields]
        if not cells or not any(cells):
            continue
        if line == 1 and cells[0].lower() in ("email", "e-mail", "mail"):
            continue
        email = cells[0]
        display = cells[1] if len(cells) > 1 else ""
        role_text = (cells[2] if len(cells) > 2 else "member") or "member"
        if "@" not in email:
            rows.append(
                ImportRow(
                    line=line,
                    email=email,
                    display=display,
                    error="Not an email address.",
                )
            )
            continue
        if role_text not in ASSIGNABLE_ROLES:
            rows.append(
                ImportRow(
                    line=line,
                    email=email,
                    display=display,
                    error=(
                        f"role must be one of {', '.join(ASSIGNABLE_ROLES)}; "
                        f"got {role_text!r}."
                    ),
                )
            )
            continue
        role: Role = "member"
        for candidate in ASSIGNABLE_ROLES:
            if candidate == role_text:
                role = candidate
        rows.append(
            ImportRow(line=line, email=email, display=display, role=role)
        )
    return rows


def _erase_memory_files(user_id: str) -> list[str]:
    """Erase the curated memory files about ``user_id`` this profile owns.

    This profile's whole participation directory goes (it is this person in
    this profile, and nothing else is in it). Their person-level identity file
    is shared across every profile on the box, so it goes only when this was
    their last participation anywhere — one profile's owner does not get to
    erase who somebody is for profiles they do not run.

    Best-effort by design: an unreadable file must not roll back an enrolment
    that has already been removed, so a failure is logged and reported rather
    than raised.
    """
    from tools.memory_tool import (
        get_memory_dir,
        get_person_memory_dir,
        person_memory_files_on_box,
    )

    erased: list[str] = []
    participation = get_memory_dir(user_id)
    if participation.is_dir():
        try:
            shutil.rmtree(participation)
            erased.append(str(participation))
        except OSError as exc:
            logger.warning("member delete: could not erase %s: %s", participation, exc)

    remaining = [
        curated
        for curated in person_memory_files_on_box(user_id)
        if curated.scope == "participation"
    ]
    if remaining:
        return erased
    person_dir = get_person_memory_dir(user_id)
    if person_dir.is_dir():
        try:
            shutil.rmtree(person_dir)
            erased.append(str(person_dir))
        except OSError as exc:
            logger.warning("member delete: could not erase %s: %s", person_dir, exc)
    return erased


@dataclass(frozen=True)
class DeletedMember:
    """Outcome of a hard delete: the enrolment removed + what its data did."""

    user_id: str
    ownership: OwnershipOutcome
    #: Curated memory files erased (``purge`` only), as display paths.
    memory_files_erased: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, object]:
        return {
            "ok": True,
            "user_id": self.user_id,
            "ownership": self.ownership.as_dict(),
            "memory_files_erased": list(self.memory_files_erased),
        }


# ---------------------------------------------------------------------------
# GoTrue admin client
# ---------------------------------------------------------------------------


class GoTrueAdminClient:
    """Thin wrapper over GoTrue's admin user API (service-role authenticated).

    All calls carry the service-role key in both the ``apikey`` header and the
    ``Authorization: Bearer`` header (GoTrue requires the bearer to be a
    service-role JWT for ``/admin`` routes). Errors map to :class:`MemberError`
    (or :class:`MemberConflictError` for a duplicate email); no response body,
    key, or password is ever logged.
    """

    def __init__(
        self,
        *,
        url: str,
        service_role_key: str,
        timeout: float = _ADMIN_TIMEOUT_SEC,
    ) -> None:
        if not url:
            raise ValueError("url is required")
        if not service_role_key:
            raise ValueError("service_role_key is required")
        self._base = url.rstrip("/")
        self._require_https_or_loopback(self._base)
        self._key = service_role_key
        self._timeout = timeout

    # ---- account operations ------------------------------------------------

    def create_user(
        self,
        *,
        email: str,
        password: str,
        display: str = "",
        email_confirm: bool = True,
        banned: bool = False,
    ) -> dict[str, Any]:
        """Create a confirmed GoTrue account and return its user object.

        ``email_confirm=True`` marks the address confirmed so no email round
        trip is needed. ``banned=True`` (FG-26) creates the account already
        banned, which is what makes "created but not yet activated" a state the
        *account system* enforces: until the invitation is redeemed the random
        password is unusable even if it were somehow guessed, and there is no
        window in which a fresh account can log in.
        A duplicate email raises :class:`MemberConflictError`.
        """
        user_metadata: dict[str, str] = {}
        if display:
            user_metadata["display_name"] = display
        body: dict[str, Any] = {
            "email": email,
            "password": password,
            "email_confirm": email_confirm,
        }
        if banned:
            body["ban_duration"] = _BAN_DURATION
        if user_metadata:
            body["user_metadata"] = user_metadata
        response = self._request("POST", "/auth/v1/admin/users", json=body)
        if response.status_code in (409, 422):
            raise MemberConflictError(
                f"An account already exists for {email!r}."
            )
        user = self._ok_json(response, "create user")
        if not isinstance(user.get("id"), str) or not user["id"]:
            raise MemberError("GoTrue create-user response missing 'id'.")
        return user

    def list_users(self, *, per_page: int = 1000) -> dict[str, dict[str, Any]]:
        """Return ``{user_id: user_object}`` for every GoTrue account.

        Paginates until GoTrue returns a short page. Used to join account state
        (email, banned) onto the enrolled principals.
        """
        users: dict[str, dict[str, Any]] = {}
        page = 1
        while True:
            query = urllib.parse.urlencode({"page": page, "per_page": per_page})
            response = self._request(
                "GET", f"/auth/v1/admin/users?{query}"
            )
            payload = self._ok_json(response, "list users")
            batch = payload.get("users")
            if not isinstance(batch, list) or not batch:
                break
            for user in batch:
                if isinstance(user, dict) and isinstance(user.get("id"), str):
                    users[user["id"]] = user
            if len(batch) < per_page:
                break
            page += 1
        return users

    def find_user_by_email(self, email: str) -> dict[str, Any] | None:
        """Return the account for ``email``, or ``None``.

        Needed because an existing email is an enrolment rather than an error
        (all profiles share one ``auth.users``), and the enrolment needs the
        account's subject UUID. GoTrue's admin list endpoint supports a filter,
        but the match is substring-ish across releases, so the exact
        case-insensitive comparison is made here rather than trusted upstream.
        """
        query = urllib.parse.urlencode(
            {"filter": email, "page": 1, "per_page": 100}
        )
        response = self._request("GET", f"/auth/v1/admin/users?{query}")
        payload = self._ok_json(response, "find user")
        candidates = payload.get("users")
        wanted = email.strip().lower()
        if isinstance(candidates, list):
            for user in candidates:
                if not isinstance(user, dict):
                    continue
                if str(user.get("email", "") or "").strip().lower() == wanted:
                    return user
        # Older GoTrue builds ignore ``filter``; fall back to a full scan rather
        # than reporting "no account" and then failing on a duplicate insert.
        for user in self.list_users().values():
            if str(user.get("email", "") or "").strip().lower() == wanted:
                return user
        return None

    def set_password(self, *, user_id: str, password: str) -> None:
        """Set an account's password (the invitation-redemption path)."""
        response = self._request(
            "PUT",
            f"/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
            json={"password": password},
        )
        self._ok_json(response, "set password")

    def activate_with_password(self, *, user_id: str, password: str) -> None:
        """Set the password **and** clear the ban in one admin call.

        One request rather than two so a redeemed invitation cannot leave the
        account in the half-activated state a failure between them would
        produce (password set, still banned — with the single-use token already
        consumed).
        """
        response = self._request(
            "PUT",
            f"/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
            json={"password": password, "ban_duration": _UNBAN_DURATION},
        )
        self._ok_json(response, "activate account")

    def set_banned(self, *, user_id: str, banned: bool) -> None:
        """Ban (deactivate) or unban (reactivate) a member's account.

        Banning blocks login without destroying the account, so history and
        any owned rows stay intact and the member can be reactivated.
        """
        duration = _BAN_DURATION if banned else _UNBAN_DURATION
        response = self._request(
            "PUT",
            f"/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
            json={"ban_duration": duration},
        )
        self._ok_json(response, "set banned")

    def delete_user(self, *, user_id: str) -> None:
        """Delete a GoTrue account (used to roll back a failed enrolment)."""
        response = self._request(
            "DELETE",
            f"/auth/v1/admin/users/{urllib.parse.quote(user_id)}",
        )
        if response.status_code not in (200, 204, 404):
            raise MemberError(
                f"GoTrue delete-user failed ({response.status_code})."
            )

    # ---- internals ---------------------------------------------------------

    def _request(
        self, method: str, path: str, *, json: Any | None = None
    ) -> httpx.Response:
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        try:
            return httpx.request(
                method,
                f"{self._base}{path}",
                json=json,
                headers=headers,
                timeout=self._timeout,
            )
        except httpx.RequestError as exc:
            raise MemberError(
                f"Supabase admin endpoint unreachable: {exc}"
            ) from exc

    def _ok_json(self, response: httpx.Response, what: str) -> dict[str, Any]:
        if response.status_code == 401 or response.status_code == 403:
            raise MemberError(
                f"GoTrue rejected the service-role key on {what} "
                f"({response.status_code}); check the service_role_key."
            )
        if response.status_code not in (200, 201):
            raise MemberError(
                f"GoTrue {what} failed ({response.status_code})."
            )
        ctype = response.headers.get("content-type", "")
        if "application/json" not in ctype:
            return {}
        try:
            body = response.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}

    @staticmethod
    def _require_https_or_loopback(url: str) -> None:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme == "https":
            return
        if parsed.scheme == "http" and (parsed.hostname or "") in (
            "localhost",
            "127.0.0.1",
            "::1",
        ):
            return
        raise ValueError(
            f"Supabase url must be https:// (or http on localhost), got {url!r}"
        )


# ---------------------------------------------------------------------------
# Member service (authorises + orchestrates GoTrue ↔ PrincipalStore)
# ---------------------------------------------------------------------------


class MemberService:
    """Owner/admin user management over GoTrue + the principal store.

    Every mutation runs :func:`require_member_admin` (or :func:`require_owner`
    for the account-level ones) on the acting principal first, then performs the
    account operation and mirrors it into the :class:`PrincipalStore`. The
    service never creates or transfers the owner — that stays with
    ``hermes owner``.

    The actor is always the principal the request *authenticated as*: resolution
    with ``allow_as=False`` happens at the API seam, so an ``?as=`` narrowing
    can never make an admin the author of somebody else's write.
    """

    def __init__(
        self,
        store: PrincipalStore,
        admin: GoTrueAdminClient,
        *,
        config: Mapping[str, object] | None = None,
        invitations: InvitationStore | None = None,
        store_factory: Any = None,
        registry: Any = None,
    ) -> None:
        self._store = store
        self._admin = admin
        self._config = config or {}
        self._invitations = invitations
        # FG-28 account-level guard inputs: how to read another profile's
        # ``principals`` and which profiles exist. ``None`` means production
        # (the scoped app store, the box's profile registry).
        self._store_factory = store_factory
        self._registry = registry

    @property
    def invitations(self) -> InvitationStore:
        """The invitation store for **this** profile's schema (lazily built).

        Lazy so a GoTrue-only operation still works on a store that cannot
        reach an app schema, and derived from ``PrincipalStore.app_store`` so an
        invitation can never land in a different profile's schema than the
        principal it invites.
        """
        if self._invitations is None:
            self._invitations = InvitationStore(
                self._store.app_store, config=self._config, profile=self.profile
            )
        return self._invitations

    @property
    def profile(self) -> str:
        """The profile this service administers — the one its links carry."""
        return administered_profile()

    # -- reads ---------------------------------------------------------------

    async def list_members(
        self,
        actor: Principal,
        *,
        limit: int = DEFAULT_PAGE_SIZE,
        offset: int = 0,
        query: str | None = None,
        role: Role | None = None,
        active: bool | None = None,
    ) -> MemberPage:
        """One page of this profile's roster, joined with account state.

        Paged, searched and filtered **in Postgres** (:meth:`list_principals`),
        because the previous implementation read every principal and every
        GoTrue account on each render — fine for a household, not for the
        hundreds of users this console is now for.

        ``active`` filters on the *enrolment* (this profile's ``principals``),
        not the box-wide account: "who is deactivated here" is the question an
        admin of this profile can actually answer.

        An email search is resolved here rather than in SQL, because email is
        the one identifier the console *displays* and the profile schema does
        not hold: ``principals`` knows a ``user_id`` and a display name. Typing
        an address matched nothing at all until this join existed. It widens the
        one search box rather than replacing it, so a fragment that is a name to
        one person and an address to another finds both.
        """
        require_member_admin(actor)
        limit = max(1, min(int(limit or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
        offset = max(0, int(offset or 0))
        if role is not None and role not in ROLES:
            raise MemberError(f"Unknown role filter: {role!r}")

        accounts = self._accounts_or_empty()
        user_ids = _ids_matching_email(accounts, query)
        principals = await self._store.list_principals(
            query=query,
            role=role,
            active=active,
            user_ids=user_ids,
            limit=limit,
            offset=offset,
        )
        total = await self._store.count_principals(
            query=query, role=role, active=active, user_ids=user_ids
        )
        invitations = await self.invitations.latest_for_users(
            [p.user_id for p in principals]
        )
        views = tuple(
            _member_view(
                principal,
                accounts.get(principal.user_id),
                invitations.get(principal.user_id),
            )
            for principal in principals
        )
        return MemberPage(
            members=views, total=total, limit=limit, offset=offset
        )

    async def directory(
        self,
        actor: Principal,
        *,
        limit: int = MAX_PAGE_SIZE,
        offset: int = 0,
        query: str | None = None,
    ) -> tuple[list[DirectoryEntry], int]:
        """The colleague directory — visible to **every** enrolled principal.

        No management gate: a member who cannot see who else is in the profile
        cannot assign a task or share a memory. The gate that does apply is the
        profile boundary — the rows come from this profile's ``principals``.
        """
        if actor.role not in ROLES:
            raise MemberAuthorizationError("An enrolled principal is required.")
        limit = max(1, min(int(limit or MAX_PAGE_SIZE), MAX_PAGE_SIZE))
        offset = max(0, int(offset or 0))
        principals = await self._store.list_principals(
            query=query, active=True, limit=limit, offset=offset
        )
        total = await self._store.count_principals(query=query, active=True)
        entries = [
            DirectoryEntry(
                user_id=p.user_id,
                display=p.display,
                role=p.role,
                channels=p.channels,
            )
            for p in principals
        ]
        return entries, total

    # -- creation ------------------------------------------------------------

    async def create_member(
        self,
        actor: Principal,
        *,
        email: str,
        profile: str,
        display: str = "",
        role: Role = "member",
    ) -> CreatedMember:
        """Enrol somebody into this profile, minting an invitation if new.

        Order matters and is the point of this method:

        1. Authorise, validate the role, and validate ``profile`` — a foreign
           profile is refused here, **before** any account exists, so a refusal
           cannot strand an orphan GoTrue account (the failure mode worth
           designing against, since the account table is shared box-wide).
        2. If the email already has an account, enrol *that* subject: no
           invitation, no password change. Somebody joining their second
           profile keeps the credentials they already use.
        3. Otherwise create the account **banned, with a random password nobody
           ever sees**, enrol it (rolling the account back if enrolment fails),
           and mint the one-time invitation whose redemption both sets their
           password and lifts the ban.
        """
        require_member_admin(actor)
        email = (email or "").strip()
        if not email:
            raise MemberError("email is required")
        if role not in ASSIGNABLE_ROLES:
            raise MemberError(
                f"role must be one of {ASSIGNABLE_ROLES}; got {role!r}. "
                "(The owner is set via 'hermes owner'.)"
            )
        assert_profile_administered(profile)

        existing = self._admin.find_user_by_email(email)
        if existing is not None:
            existing_id = str(existing["id"])
            enrolled = await self._store.get(existing_id)
            if enrolled is not None:
                # Enrolment is an upsert, so this would have reported success
                # while changing nothing — not the requested role, and not a
                # suspended row's `active`. Restoring or re-roling somebody
                # already here is their row's job, where it is audited as what
                # it is.
                suspended = (
                    " Their enrolment is suspended; restore it from their row."
                    if not enrolled.active
                    else ""
                )
                raise MemberError(
                    f"{email} is already enrolled in this profile as "
                    f"{enrolled.role}.{suspended}"
                )
            principal = await self._enroll(
                existing_id, display=display or email, role=role
            )
            await self._audit(
                actor,
                "user.enroll_existing",
                principal.user_id,
                {"email": email, "role": role},
            )
            return CreatedMember(
                principal=principal,
                email=email,
                enrolled_existing=True,
            )

        user = self._admin.create_user(
            email=email,
            password=_random_password(),
            display=display,
            banned=True,
        )
        user_id = str(user["id"])
        try:
            principal = await self._enroll(
                user_id, display=display or email, role=role
            )
        except Exception:
            # Roll back the freshly created account so a failed enrolment
            # doesn't leave an orphan GoTrue user that can log in with no
            # principal (which the resolver would 409 on).
            self._rollback_account(user_id)
            raise
        try:
            minted = await self.invitations.mint(
                user_id=user_id, created_by=actor.user_id
            )
        except Exception:
            # Same reasoning one step later: an account that exists with a
            # random password and no way to activate is unusable, so undo both.
            await self._store.unenroll(user_id)
            self._rollback_account(user_id)
            raise
        await self._audit(
            actor,
            "user.create",
            user_id,
            {
                "email": email,
                "role": role,
                "invitation_id": minted.invitation.id,
                "expires_at": minted.invitation.expires_at.isoformat(),
            },
        )
        return CreatedMember(
            principal=principal,
            email=email,
            enrolled_existing=False,
            invitation=minted.invitation,
            invitation_token=minted.token,
            profile=self.profile,
        )

    async def import_members(
        self,
        actor: Principal,
        *,
        csv_text: str,
        profile: str,
        dry_run: bool = True,
    ) -> ImportOutcome:
        """Enrol a batch from CSV (``email,display,role``), optionally dry.

        ``dry_run`` is the default because a bulk enrolment is the operation
        most likely to be attempted with the wrong column order or a stale
        export; the caller previews what each row would do, then re-submits to
        apply. A row that fails is reported and skipped — one malformed line
        must not abandon the other forty-nine halfway through.
        """
        require_member_admin(actor)
        assert_profile_administered(profile)
        rows = parse_member_csv(csv_text)
        results: list[ImportRow] = []
        for row in rows:
            if row.error:
                results.append(row)
                continue
            if dry_run:
                results.append(
                    dataclasses.replace(row, planned=await self._plan(row))
                )
                continue
            try:
                created = await self.create_member(
                    actor,
                    email=row.email,
                    profile=profile,
                    display=row.display,
                    role=row.role,
                )
            except (MemberError, PermissionError, InvitationError) as exc:
                results.append(dataclasses.replace(row, error=str(exc)))
                continue
            results.append(
                dataclasses.replace(
                    row,
                    planned=(
                        "enrolled existing account"
                        if created.enrolled_existing
                        else "created + invited"
                    ),
                    user_id=created.principal.user_id,
                    invitation_token=created.invitation_token,
                    profile=created.profile,
                )
            )
        return ImportOutcome(dry_run=dry_run, rows=tuple(results))

    async def _plan(self, row: ImportRow) -> str:
        """Describe what applying ``row`` would do, for the dry-run preview."""
        try:
            account = self._admin.find_user_by_email(row.email)
        except MemberError:
            return "unknown (GoTrue unreachable)"
        if account is None:
            return "create account + invite"
        principal = await self._store.get(str(account.get("id") or ""))
        if principal is not None:
            return "already enrolled — no change"
        return "enrol existing account (no invitation)"

    # -- invitations ---------------------------------------------------------

    async def issue_invitation(
        self,
        actor: Principal,
        *,
        user_id: str,
        kind: InvitationKind = "activation",
    ) -> tuple[Invitation, str]:
        """Mint (or regenerate) an invitation and return it with its raw token.

        The regenerate action behind the console's "Regenerate link": the
        previous link is revoked in the same transaction, so the five-minute
        window an admin missed does not leave two live links behind.

        Redeeming the link sets the **box-wide** password and lifts the ban, so
        handing its token to an admin is an account-level act (FG-28 D4). It is
        refused (:class:`MemberAuthorizationError` /
        :class:`~hermes_cli.console_scope.AccountLevelPermissionError`, both
        403) unless:

        - the actor strictly outranks the target (``ROLE_RANK``): an admin
          never mints for the owner or a peer admin;
        - the target is enrolled only in profiles the actor administers
          (:func:`~hermes_cli.console_scope.guard_account_level_op`);
        - the account has never been activated — a person who has signed in
          resets their own password instead: only once they have asked for a
          reset (an open self-service ``recovery`` request, the console's
          "Send reset link") is a link minted for them, and then always as
          ``recovery``.
        """
        require_member_admin(actor)
        principal = await self._store.get(user_id)
        if principal is None:
            raise MemberError(f"No enrolled principal {user_id!r}.")
        if role_rank(actor.role) >= role_rank(principal.role):
            raise MemberAuthorizationError(
                f"A {actor.role} cannot issue a sign-in link for a "
                f"{principal.role}; only someone who outranks them can."
            )
        await self._guard_account_level_op(actor, principal.user_id)
        if _account_is_activated(self._account(principal.user_id)):
            if not await self._reset_requested(principal.user_id):
                raise MemberAuthorizationError(
                    "This person has already activated their account, so an "
                    "admin cannot issue them a link. Ask them to use \"Forgot "
                    "password\" on the sign-in page; you can then send their "
                    "reset link here."
                )
            kind = "recovery"
        minted = await self.invitations.mint(
            user_id=principal.user_id, created_by=actor.user_id, kind=kind
        )
        await self._audit(
            actor,
            "user.invitation",
            principal.user_id,
            {
                "kind": kind,
                "invitation_id": minted.invitation.id,
                "expires_at": minted.invitation.expires_at.isoformat(),
            },
        )
        return minted.invitation, minted.token

    async def revoke_invitation(
        self, actor: Principal, *, user_id: str
    ) -> int:
        """Revoke every open invitation for ``user_id``; return how many."""
        require_member_admin(actor)
        revoked = await self.invitations.revoke(user_id=user_id)
        if revoked:
            await self._audit(
                actor, "user.invitation_revoke", user_id, {"revoked": revoked}
            )
        return revoked

    async def request_password_reset(self, *, email: str) -> Invitation | None:
        """Mint a recovery invitation for ``email``, if it is enrolled here.

        **Unauthenticated and deliberately opaque**: the caller is told nothing
        about the outcome, because the honest answer ("no such account", "not
        enrolled in this profile") is exactly the enumeration oracle a login
        page must not offer. The link is *not* returned to the requester either
        — it is minted for an admin to hand over — so this endpoint cannot be
        used to take over an account by asking nicely.
        """
        account = None
        try:
            account = self._admin.find_user_by_email((email or "").strip())
        except MemberError as exc:
            logger.warning("password reset: account lookup failed: %s", exc)
            return None
        if account is None:
            return None
        user_id = str(account.get("id") or "")
        principal = await self._store.get(user_id) if user_id else None
        if principal is None:
            return None
        owner = await self._store.get_owner()
        minted = await self.invitations.mint(
            user_id=principal.user_id,
            created_by=owner.user_id if owner else principal.user_id,
            kind="recovery",
        )
        await self._audit(
            principal,
            "user.reset_requested",
            principal.user_id,
            {"invitation_id": minted.invitation.id},
        )
        return minted.invitation

    async def redeem_invitation(
        self, *, token: str, password: str
    ) -> bool:
        """Activate an account from ``token``: set the password, lift the ban.

        Returns ``True`` on success and ``False`` for **every** failure mode —
        unknown, tampered, expired, used, revoked, or not enrolled — so the
        unauthenticated endpoint above it can answer identically in all of
        them. The single-use claim happens first and is released if the account
        operation fails, so an outage costs a retry rather than the link.
        """
        invitation = await self.invitations.claim(token)
        if invitation is None:
            return False
        principal = await self._store.get(invitation.user_id)
        if principal is None:
            await self.invitations.release(invitation.id)
            return False
        if invitation.kind == "activation":
            try:
                account = self._account(invitation.user_id)
            except MemberError:
                await self.invitations.release(invitation.id)
                raise
            if _account_is_activated(account):
                # A stale or admin-minted activation link must never reset a
                # live account's password. The claim stays consumed (the link
                # is dead either way) and the answer is the same as any other
                # bad token.
                return False
        email = self._account_email(invitation.user_id)
        try:
            validate_password(password, email=email)
        except InvitationError:
            # A rejected password must not consume the link: the invitee is
            # mid-form, not an attacker with a valid token.
            await self.invitations.release(invitation.id)
            raise
        try:
            self._admin.activate_with_password(
                user_id=invitation.user_id, password=password
            )
        except MemberError:
            await self.invitations.release(invitation.id)
            raise
        if not principal.active:
            await self._store.set_active(invitation.user_id, True)
        await self._audit(
            principal,
            (
                "user.activate"
                if invitation.kind == "activation"
                else "user.password_reset"
            ),
            invitation.user_id,
            {"invitation_id": invitation.id, "kind": invitation.kind},
        )
        return True

    # -- updates -------------------------------------------------------------

    async def set_member_role(
        self, actor: Principal, *, user_id: str, role: Role
    ) -> Principal:
        """Change a member's role (never the owner's; never *to* owner).

        Refuses to change the actor's **own** role: self-demotion is either a
        mistake or an attempt to escape a restriction, and the owner/last-admin
        guard below cannot protect a profile whose only admin demoted himself.
        """
        require_member_admin(actor)
        if role not in ASSIGNABLE_ROLES:
            raise MemberError(
                f"role must be one of {ASSIGNABLE_ROLES}; got {role!r}."
            )
        if user_id == actor.user_id:
            raise MemberError(
                "You cannot change your own role; ask another owner or admin."
            )
        if role != "admin":
            await self._assert_not_last_admin(user_id, what="demote")
        try:
            principal = await self._store.set_role(user_id, role)
        except KeyError as exc:
            raise MemberError(str(exc)) from exc
        except ValueError as exc:
            raise MemberError(str(exc)) from exc
        await self._audit(actor, "user.role", user_id, {"role": role})
        return principal

    async def set_member_display(
        self, actor: Principal, *, user_id: str, display: str
    ) -> Principal:
        """Rename a member in this profile."""
        require_member_admin(actor)
        try:
            principal = await self._store.set_display(user_id, display)
        except KeyError as exc:
            raise MemberError(str(exc)) from exc
        await self._audit(actor, "user.display", user_id, {"display": display})
        return principal

    async def set_member_active(
        self, actor: Principal, *, user_id: str, active: bool
    ) -> Principal:
        """Deactivate or reactivate an enrolment **in this profile**.

        Not a GoTrue ban. Under one shared account system, banning would revoke
        the person's access to every profile they belong to — an admin here has
        authority over this profile's roster, not over somebody else's tenant.
        """
        require_member_admin(actor)
        if user_id == actor.user_id and not active:
            raise MemberError(
                "You cannot deactivate your own enrolment; ask another owner "
                "or admin."
            )
        if not active:
            await self._assert_not_last_admin(user_id, what="deactivate")
        try:
            principal = await self._store.set_active(user_id, active)
        except KeyError as exc:
            raise MemberError(str(exc)) from exc
        except ValueError as exc:
            raise MemberError(str(exc)) from exc
        await self._audit(
            actor,
            "user.active" if active else "user.deactivate",
            user_id,
            {"active": active},
        )
        return principal

    async def delete_member(
        self,
        actor: Principal,
        *,
        user_id: str,
        strategy: DeleteStrategy,
        transfer_to: str | None = None,
    ) -> DeletedMember:
        """Remove an enrolment and resolve the rows it owns. Owner-only.

        ``strategy`` is required by the API rather than defaulted, because both
        answers destroy something: ``transfer`` moves a person's private rows to
        somebody else's eyes, ``purge`` deletes them. Guessing on the caller's
        behalf is how data disappears quietly.

        The box-wide GoTrue **account is deliberately left alone**: deleting it
        would sign the person out of every other profile they are enrolled in,
        which is not this console's authority to decide. What this removes is
        their enrolment here.

        Under ``purge`` the curated memory files about this person in *this*
        profile go too, and their cross-profile identity file goes when this
        was their last participation on the box. Rows without files was the
        wrong half: the files are the half the system prompt reads, so a
        purged person could keep being described to the agent by name.
        """
        require_owner(actor)
        if strategy not in DELETE_STRATEGIES:
            raise MemberError(
                "strategy is required and must be one of "
                f"{DELETE_STRATEGIES} — state what happens to the rows and "
                "files this user owns."
            )
        if user_id == actor.user_id:
            raise MemberError("You cannot delete your own enrolment.")
        target = await self._store.get(user_id)
        if target is None:
            raise MemberError(f"No enrolled principal {user_id!r}.")
        if target.role == "owner":
            raise MemberError(
                "The owner cannot be deleted; transfer ownership first "
                "('hermes owner transfer')."
            )
        await self._assert_not_last_admin(user_id, what="delete")

        successor = (transfer_to or "").strip() or (
            actor.user_id if strategy == "purge" else ""
        )
        if strategy == "transfer" and not successor:
            raise MemberError(
                "transfer_to is required with strategy=transfer — name the "
                "principal who inherits this user's rows."
            )
        if successor != actor.user_id:
            inheritor = await self._store.get(successor)
            if inheritor is None:
                raise MemberError(
                    f"No enrolled principal {successor!r} to inherit the rows."
                )

        store = self._store.app_store
        connection = await store.connect()
        try:
            outcome = await resolve_owned_rows(
                connection,
                schema=store.schema,
                user_id=user_id,
                strategy=strategy,
                successor_user_id=successor,
            )
        finally:
            await connection.close()
        await self.invitations.revoke(user_id=user_id)
        await self._store.unenroll(user_id)
        erased = _erase_memory_files(user_id) if strategy == "purge" else []
        await self._audit(
            actor,
            "user.delete",
            user_id,
            {
                "strategy": strategy,
                "successor": successor,
                "memory_files_erased": erased,
                **outcome.as_dict(),
            },
        )
        return DeletedMember(
            user_id=user_id, ownership=outcome, memory_files_erased=erased
        )

    # -- internals -----------------------------------------------------------

    async def _enroll(
        self, user_id: str, *, display: str, role: Role
    ) -> Principal:
        try:
            return await self._store.enroll(user_id, display=display, role=role)
        except ValueError as exc:
            raise MemberError(str(exc)) from exc

    def _rollback_account(self, user_id: str) -> None:
        try:
            self._admin.delete_user(user_id=user_id)
        except MemberError:
            logger.warning(
                "member create: enrolment failed AND GoTrue rollback failed "
                "for a new account; a manual cleanup may be needed."
            )

    def _accounts_or_empty(self) -> dict[str, dict[str, Any]]:
        try:
            return self._admin.list_users()
        except MemberError:
            # GoTrue may be briefly unreachable; still return the principals
            # (management is principal-first) with unknown account state.
            logger.warning(
                "member list: GoTrue account state unavailable; listing "
                "principals without email/active."
            )
            return {}

    def _account(self, user_id: str) -> dict[str, Any] | None:
        """The GoTrue account for ``user_id`` (``None`` if there is none).

        Raises :class:`MemberError` when GoTrue is unreachable, so a caller
        deciding whether an account-level act is safe fails closed.
        """
        return self._admin.list_users().get(user_id)

    async def _reset_requested(self, user_id: str) -> bool:
        """Whether ``user_id``'s latest invitation is an open reset request."""
        latest = (await self.invitations.latest_for_users([user_id])).get(user_id)
        return (
            latest is not None
            and latest.kind == "recovery"
            and latest.status() == "open"
        )

    async def _guard_account_level_op(
        self, actor: Principal, user_id: str
    ) -> None:
        from hermes_cli.console_scope import (
            guard_account_level_op,
            principal_store_factory,
        )

        await guard_account_level_op(
            actor,
            user_id,
            store_factory=self._store_factory or principal_store_factory(),
            registry=self._registry,
        )

    def _account_email(self, user_id: str) -> str:
        try:
            accounts = self._admin.list_users()
        except MemberError:
            return ""
        account = accounts.get(user_id)
        return str(account.get("email", "") or "") if account else ""

    async def _assert_not_last_admin(self, user_id: str, *, what: str) -> None:
        """Refuse an act that would leave the profile with no live admin.

        Counts owner and admin enrolments that are still active: a profile
        whose last administrator is demoted, deactivated or deleted has nobody
        who can undo it, and recovering it needs box-level CLI access.
        """
        target = await self._store.get(user_id)
        if target is None or target.role not in ("owner", "admin"):
            return
        admins = [
            p
            for p in await self._store.list_principals(role="admin")
            if p.active
        ]
        owners = [
            p
            for p in await self._store.list_principals(role="owner")
            if p.active and p.user_id != user_id
        ]
        remaining = [p for p in admins if p.user_id != user_id] + owners
        if not remaining:
            raise MemberError(
                f"Refusing to {what} the last administrator of this profile; "
                "promote another admin first."
            )

    async def _audit(
        self,
        actor: Principal,
        action: str,
        user_id: str,
        payload: Mapping[str, object],
    ) -> None:
        from hermes_cli.identity_audit import record_identity_event

        await record_identity_event(
            store=self._store.app_store,
            actor_user_id=actor.user_id,
            action=action,
            user_id=user_id,
            payload=payload,
            config=self._config,
        )


def _random_password() -> str:
    """A password for an account nobody will ever log into with it.

    Created accounts are banned until their invitation is redeemed, at which
    point the invitee's own password replaces this one. It is generated
    server-side and never returned, logged, or displayed — which is the whole
    point of deleting the browser's ``generatePassword`` path.
    """
    return f"Hz-{secrets.token_urlsafe(_PLACEHOLDER_PASSWORD_BYTES)}"


def _ids_matching_email(
    accounts: Mapping[str, Mapping[str, Any]],
    query: str | None,
) -> list[str] | None:
    """The account ids whose email contains ``query``; ``None`` if no query.

    Any fragment is tried against the address, not only one carrying an ``@``:
    an admin looking for ``ada.lovelace@corp.example`` types ``ada``, and the
    local part is the half of an address people actually remember.

    The ids *widen* the roster search (see :func:`_principal_filters`), so an
    empty result is not "no matches" — the display-name predicate still runs.
    """
    text = (query or "").strip().lower()
    if not text:
        return None
    return [
        user_id
        for user_id, account in accounts.items()
        if text in str(account.get("email") or "").lower()
    ]


def _member_view(
    principal: Principal,
    account: dict[str, Any] | None,
    invitation: Invitation | None,
) -> MemberView:
    email = ""
    account_active = True
    if account is not None:
        email = str(account.get("email", "") or "")
        account_active = not _is_banned(account)
    return MemberView(
        user_id=principal.user_id,
        display=principal.display,
        role=principal.role,
        email=email,
        active=account_active,
        channels=principal.channels,
        enrolled=principal.active,
        invitation=invitation,
    )


async def link_member_channel(
    store: PrincipalStore,
    actor: Principal,
    *,
    user_id: str,
    platform: str,
    channel_user_id: str,
) -> Principal:
    """Map an inbound ``(platform, channel_user_id)`` onto an enrolled principal.

    The C1 seam auto-enrols a *paired* channel sender, but a person who reaches
    the gateway through a configured allow-list (``telegram.allow_from`` and
    friends) is authorised without ever pairing — so nothing links their channel
    handle to the principal that owns their data, and their session runs on the
    raw handle with no role. This is the owner/admin surface that states the
    mapping explicitly, and it is deliberately GoTrue-free: linking a channel is
    a principal operation, so it must work on a deployment that has no
    dashboard-auth configured at all.

    Refuses an unenrolled ``user_id`` rather than creating one, so a typo cannot
    silently mint a principal that inbound traffic then accumulates data under.
    """
    require_member_admin(actor)
    platform = _normalize_platform(platform)
    channel_user_id = str(channel_user_id or "").strip()
    if not channel_user_id:
        raise MemberError("channel_user_id is required")
    principal = await store.get(user_id)
    if principal is None:
        raise MemberError(
            f"No principal enrolled for {user_id!r}. Enrol the member first "
            "('hermes member add', or 'hermes owner init' for the owner)."
        )
    await store.link_channel(principal.user_id, platform, channel_user_id)
    refreshed = await store.get(principal.user_id)
    return refreshed if refreshed is not None else principal


async def unlink_member_channel(
    store: PrincipalStore,
    actor: Principal,
    *,
    user_id: str,
    platform: str,
    channel_user_id: str,
) -> Principal:
    """Remove a ``(platform, channel_user_id)`` mapping from an enrolled principal.

    The inverse of :func:`link_member_channel`. Nothing else is touched: the
    principal, its data and any other channels stay; messages from the handle
    simply resolve to the raw channel identity again. Refuses a handle that is
    not currently linked to ``user_id`` so a stale view cannot detach a mapping
    that has since been re-pointed at someone else.
    """
    require_member_admin(actor)
    platform = _normalize_platform(platform)
    channel_user_id = str(channel_user_id or "").strip()
    if not channel_user_id:
        raise MemberError("channel_user_id is required")
    principal = await store.get(user_id)
    if principal is None:
        raise MemberError(f"No principal enrolled for {user_id!r}.")
    if f"{platform}:{channel_user_id}" not in principal.channels:
        raise MemberError(
            f"{platform}:{channel_user_id} is not linked to {principal.user_id}."
        )
    await store.unlink_channel(principal.user_id, platform, channel_user_id)
    refreshed = await store.get(principal.user_id)
    return refreshed if refreshed is not None else principal


def _normalize_platform(platform: str) -> str:
    """Validate a platform name against the gateway's own enum.

    The stored value has to be byte-identical to what ``resolve_principal``
    looks up at intake (``source.platform.value``), so an unknown or
    differently-cased name is rejected here rather than producing a row that
    silently never matches.
    """
    from gateway.config import Platform

    candidate = str(platform or "").strip().lower()
    if not candidate:
        raise MemberError("platform is required")
    valid = {p.value for p in Platform}
    if candidate not in valid:
        raise MemberError(
            f"Unknown platform {platform!r}. Expected one of: "
            f"{', '.join(sorted(valid))}."
        )
    return candidate


def _account_is_activated(account: dict[str, Any] | None) -> bool:
    """Whether a GoTrue account has left the FG-26 pending-activation state.

    An account this console creates starts **banned and never signed in**
    (``create_user(banned=True)``); redeeming its activation link lifts the
    ban. So an account is pending only while both hold: it has no
    ``last_sign_in_at`` *and* it is still banned. Anything else — signed in
    once (even if banned since), or never banned (activated, or an existing
    account enrolled here) — is a live account whose password belongs to its
    holder. A missing account is treated as activated: there is nothing an
    activation link could legitimately do for it.
    """
    if account is None:
        return True
    if str(account.get("last_sign_in_at") or "").strip():
        return True
    return not _is_banned(account)


def _is_banned(account: dict[str, Any]) -> bool:
    """Whether a GoTrue user object is currently banned.

    GoTrue exposes ``banned_until`` (an RFC3339 timestamp) on the admin user
    object; a non-empty, non-"none" value means the account is banned. We treat
    any present value conservatively as banned rather than parsing the instant,
    because deactivation always writes a far-future ban.
    """
    value = account.get("banned_until")
    if not isinstance(value, str):
        return False
    value = value.strip().lower()
    return bool(value) and value not in ("none", "null")


# ---------------------------------------------------------------------------
# Config resolution — service-role key is env-only (a credential)
# ---------------------------------------------------------------------------


def _load_supabase_auth_section() -> dict[str, Any]:
    """Return ``dashboard.supabase_auth`` from config.yaml, or ``{}``.

    Reused for the GoTrue base ``url`` — the same non-secret surface the
    ``supabase`` dashboard-auth provider reads.
    """
    try:
        from hermes_cli.config import cfg_get, load_config

        cfg = load_config()
    except Exception as exc:  # noqa: BLE001 — broad catch is intentional
        logger.debug(
            "members: load_config() raised %s; env-only configuration", exc
        )
        return {}
    section = cfg_get(cfg, "dashboard", "supabase_auth", default=None)
    return section if isinstance(section, dict) else {}


def _scoped_secret(env_name: str) -> str:
    """Read a credential env var through the active profile scope (FG-28).

    ``get_secret`` honours the per-profile secret scope a multiplexed console
    turn installs, so an admin action scoped to profile B resolves B's key
    rather than the process default. When multiplexing is on but no scope is
    active — a console route that has not yet entered its target profile's
    scope — it fails closed: returning empty so the caller refuses the action
    (``load_admin_client`` → ``None`` → 503) rather than authenticating as
    another profile. Single-profile deployments are unchanged: multiplexing
    is off, so ``get_secret`` falls back to ``os.environ`` exactly as before.
    """
    try:
        return (get_secret(env_name) or "").strip()
    except UnscopedSecretError:
        logger.warning(
            "members: %s read with no profile secret scope active while "
            "multiplexing is on; refusing to return another profile's value. "
            "Scope the request to a profile before resolving admin credentials.",
            env_name,
        )
        return ""


def _resolve_url(section: dict[str, Any]) -> str:
    for env_name in ("HERMES_DASHBOARD_SUPABASE_URL", "SUPABASE_URL"):
        env = _scoped_secret(env_name)
        if env:
            return env
    return str(section.get("url", "") or "").strip()


def _resolve_service_role_key() -> str:
    """The service-role key — env only (never config.yaml / never a browser)."""
    for env_name in (
        "HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY",
        "HERMES_SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SERVICE_KEY",
    ):
        env = _scoped_secret(env_name)
        if env:
            return env
    return ""


def load_admin_client() -> Optional[GoTrueAdminClient]:
    """Build a :class:`GoTrueAdminClient` from config/env, or ``None``.

    Returns ``None`` (rather than raising) when the GoTrue ``url`` or the
    service-role key is absent, so callers can surface a clean "member
    management isn't configured" state instead of a stack trace.
    """
    section = _load_supabase_auth_section()
    url = _resolve_url(section)
    key = _resolve_service_role_key()
    if not url or not key:
        return None
    try:
        return GoTrueAdminClient(url=url, service_role_key=key)
    except ValueError as exc:
        logger.warning("members: admin client construction failed: %s", exc)
        return None


ADMIN_UNCONFIGURED_MESSAGE = (
    "Member management is not configured. Set the Supabase GoTrue url "
    "(dashboard.supabase_auth.url or HERMES_DASHBOARD_SUPABASE_URL / "
    "SUPABASE_URL) and the service-role key in the environment "
    "(HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY — "
    "a credential, never config.yaml)."
)
