"""FG-26 — single-use, short-lived invitation tokens for account activation.

An invitation is how somebody the owner/admin just created gets a password:
the admin hands over one link, the invitee opens it and sets their own
password. It replaces the browser-generated temporary password the Users
console used to relay by hand, which meant an admin-chosen secret travelled
through a chat window and stayed valid until someone changed it.

What that costs, and how it is paid for here:

* The token is 32 random bytes (:func:`mint_token`) and **only its SHA-256
  hash is stored** — a database leak yields hashes, and a hash cannot activate
  an account. The raw token exists in exactly one response body, once.
* It is **single-use**: redemption is an atomic ``UPDATE ... RETURNING`` that
  claims the row, so two concurrent redeems cannot both win. A redeem whose
  account operation then fails releases the claim rather than burning the link.
* It is **short-lived** (``invitations.ttl_seconds`` in ``config.yaml``,
  default 300s) and **revocable**, and minting a new one for the same person
  revokes their earlier open invitations — a regenerated link must invalidate
  the one that leaked, not sit alongside it.
* Verification is a hash lookup plus :func:`hmac.compare_digest` on the stored
  digest, so a token that collides on the index still has to match in constant
  time.
* The stored hash is **bound to the profile** the token was minted in
  (:func:`hash_token`, ``v2:<profile>:<token>``), and the link names that
  profile (:func:`activation_path`). The name only routes the lookup; a link
  presented under another profile's name matches no row there. Bare v1 hashes
  from before the binding are honoured in the default profile only.
* Every lookup failure returns ``None``. The caller cannot distinguish
  "unknown", "expired", "used" or "revoked", which is what keeps the
  unauthenticated redeem endpoint from being an existence oracle.

The table lives in the **administered profile's** schema (FG-27), so an
invitation is scoped to the profile it enrols into even though the GoTrue
account it activates is box-wide.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Callable, Literal, Mapping

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

logger = logging.getLogger(__name__)

#: Entropy per token. ``secrets.token_urlsafe(32)`` yields 43 URL-safe chars.
TOKEN_BYTES = 32

#: Kinds of invitation. ``activation`` is the first password for a created
#: account; ``recovery`` is the self-service reset of an existing one. Same
#: mechanism, different default TTL — a reset is usually not handed over live.
InvitationKind = Literal["activation", "recovery"]
INVITATION_KINDS: tuple[InvitationKind, ...] = ("activation", "recovery")

#: Defaults for ``invitations.ttl_seconds`` / ``invitations.recovery_ttl_seconds``
#: in ``config.yaml``. Five minutes assumes the admin is with the invitee or in
#: a live chat with them, which is why "Regenerate link" is part of the feature.
DEFAULT_TTL_SECONDS = 300
DEFAULT_RECOVERY_TTL_SECONDS = 3600

#: Minimum length of a password an invitee may set. Enforced server-side, on
#: the only path that can set one.
MIN_PASSWORD_LENGTH = 12

#: Redeem attempts allowed per IP and per token within one window, and the
#: window itself. Generous enough that a person fumbling a password policy is
#: never locked out, tight enough that guessing is not a strategy.
REDEEM_MAX_ATTEMPTS = 10
REDEEM_WINDOW_SECONDS = 300.0

#: Cap on throttle buckets held in memory before expired ones are swept.
_THROTTLE_MAX_KEYS = 4096

#: GUC that lets the unauthenticated redeem path read one invitation row under
#: the FORCEd read policy. There is no principal to bind on that request — the
#: token *is* the authorisation — so the policy needs a seam that only
#: server-side code holding a database connection can open. The token check
#: itself is the security boundary; the policy is defence in depth that keeps
#: the table out of every authenticated list query.
GUC_REDEEM = "hermes.invitation_redeem"
_REDEEM_ON = "on"

_KINDS_SQL = ", ".join(f"'{kind}'" for kind in INVITATION_KINDS)

INVITATIONS_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES principals(user_id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'activation' CHECK (kind IN ({_KINDS_SQL})),
    token_hash BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by TEXT NOT NULL REFERENCES principals(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash_idx
    ON invitations (token_hash);
CREATE INDEX IF NOT EXISTS invitations_user_idx
    ON invitations (user_id, created_at DESC);
"""


class InvitationError(RuntimeError):
    """An invitation operation could not be completed."""


@dataclass(frozen=True)
class Invitation:
    """One invitation row — never carrying the token, only its lifecycle.

    :meth:`as_dict` is what list endpoints serialise: expiry and the three
    state timestamps, so an admin can see that a link is outstanding without
    the response ever being able to activate an account.
    """

    id: str
    user_id: str
    kind: InvitationKind
    expires_at: datetime
    used_at: datetime | None
    revoked_at: datetime | None
    created_by: str
    created_at: datetime

    @classmethod
    def from_row(cls, row: Mapping[str, object]) -> "Invitation":
        kind = str(row["kind"])
        if kind not in INVITATION_KINDS:
            raise InvitationError(f"Unknown invitation kind stored: {kind!r}")
        return cls(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            kind=kind,  # type: ignore[arg-type]
            expires_at=_as_dt(row["expires_at"]),
            used_at=_optional_dt(row.get("used_at")),
            revoked_at=_optional_dt(row.get("revoked_at")),
            created_by=str(row["created_by"]),
            created_at=_as_dt(row["created_at"]),
        )

    def status(self, *, now: datetime | None = None) -> str:
        """``used`` | ``revoked`` | ``expired`` | ``open``."""
        if self.used_at is not None:
            return "used"
        if self.revoked_at is not None:
            return "revoked"
        reference = now or datetime.now(self.expires_at.tzinfo)
        if self.expires_at <= reference:
            return "expired"
        return "open"

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "user_id": self.user_id,
            "kind": self.kind,
            "status": self.status(),
            "expires_at": self.expires_at.isoformat(),
            "used_at": self.used_at.isoformat() if self.used_at else None,
            "revoked_at": (
                self.revoked_at.isoformat() if self.revoked_at else None
            ),
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat(),
        }


@dataclass(frozen=True)
class MintedInvitation:
    """A freshly minted invitation plus the raw token — shown exactly once."""

    invitation: Invitation
    token: str


def mint_token() -> str:
    """Return a fresh URL-safe invitation token (:data:`TOKEN_BYTES` random bytes)."""
    return secrets.token_urlsafe(TOKEN_BYTES)


#: The profile a legacy ``/activate/<token>`` link (and a v1 hash) belongs to.
DEFAULT_PROFILE = "default"


def activation_path(token: str, profile: str | None = None) -> str:
    """Return the relative activation path for ``token`` minted in ``profile``.

    Relative on purpose: the absolute link is composed by the surface that
    knows its own public origin (the ``agent-home`` BFF, from the request), so
    the Python layer needs no configured public URL and cannot mint a link
    pointing at the wrong host.

    A named profile travels in the path (``/activate/<profile>/<token>``) so
    redemption runs in the profile whose ``invitations`` table holds the row;
    the default profile keeps the legacy ``/activate/<token>`` shape. The
    profile is routing metadata, not a grant: the stored hash binds the token
    to it (:func:`hash_token`), so a link presented under another name fails.
    """
    name = (profile or "").strip()
    if name and name != DEFAULT_PROFILE:
        return f"/activate/{name}/{token}"
    return f"/activate/{token}"


def hash_token(token: str, profile: str | None = None) -> bytes:
    """Return the SHA-256 digest stored in place of ``token``.

    With ``profile`` this is the v2 digest, ``sha256("v2:<profile>:<token>")``,
    which binds the token to the profile it was minted in. Without it, the v1
    digest of the bare token — what links minted before the binding stored,
    still honoured in the default profile until they expire.
    """
    material = token if profile is None else f"v2:{profile}:{token}"
    return hashlib.sha256(material.encode("utf-8")).digest()


def token_digests(token: str, profile: str) -> tuple[bytes, ...]:
    """Every digest under which ``token`` may be stored in ``profile``.

    The v2 digest for ``profile``, plus the legacy v1 digest in the default
    profile only (where every pre-binding link was minted).
    """
    digests = (hash_token(token, profile),)
    if profile == DEFAULT_PROFILE:
        digests += (hash_token(token),)
    return digests


def invitation_ttl_seconds(
    config: Mapping[str, object] | None,
    *,
    kind: InvitationKind = "activation",
) -> int:
    """Return the configured TTL in seconds for ``kind``.

    Behavioural setting, so it lives in ``config.yaml`` under ``invitations``
    (``ttl_seconds`` / ``recovery_ttl_seconds``) rather than an environment
    variable. A missing, unparseable or non-positive value falls back to the
    default rather than producing an invitation that never expires.
    """
    default = (
        DEFAULT_TTL_SECONDS
        if kind == "activation"
        else DEFAULT_RECOVERY_TTL_SECONDS
    )
    settings: Mapping[str, object] = config if config is not None else {}
    section: object = settings.get("invitations")
    if not isinstance(section, Mapping):
        return default
    key = "ttl_seconds" if kind == "activation" else "recovery_ttl_seconds"
    values: Mapping[str, object] = {
        str(name): value for name, value in section.items()
    }
    raw: object = values.get(key)
    if raw is None:
        return default
    try:
        value = int(str(raw))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def validate_password(password: str, *, email: str = "") -> str:
    """Return ``password`` if it satisfies the server-side policy, else raise.

    Enforced here because this module owns the only path on which an invitee
    sets a password; a browser-side check is a hint, not a rule.
    """
    candidate = password or ""
    if len(candidate) < MIN_PASSWORD_LENGTH:
        raise InvitationError(
            f"The password must be at least {MIN_PASSWORD_LENGTH} characters."
        )
    if email and candidate.strip().lower() == email.strip().lower():
        raise InvitationError("The password cannot be the email address.")
    return candidate


class RedeemThrottle:
    """Fixed-window attempt counter for the unauthenticated redeem endpoint.

    Two buckets, because they stop different attacks: **per IP** bounds how fast
    one host can guess tokens at all, and **per token** bounds how many attempts
    a single link tolerates, so a leaked link cannot be brute-forced for its
    password field from a botnet of addresses.

    In-process and therefore per worker — deliberately, since the alternative is
    a shared store on the one path that must work before a user has any
    credentials. A token has 256 bits of entropy and a five-minute life; this
    limiter exists to make guessing pointless in logs and load terms, not to be
    the only thing standing between an attacker and an account.
    """

    def __init__(
        self,
        *,
        max_attempts: int = 10,
        window_seconds: float = 300.0,
        now: "Callable[[], float] | None" = None,
        ip_max_attempts: int | None = None,
    ) -> None:
        self._max = max(1, int(max_attempts))
        self._ip_max = (
            self._max if ip_max_attempts is None else max(1, int(ip_max_attempts))
        )
        self._window = float(window_seconds)
        self._now = now or time.monotonic
        self._buckets: dict[str, tuple[float, int]] = {}

    def allow(self, *, ip: str, token: str) -> bool:
        """Count one attempt; return ``False`` once a bucket is exhausted.

        The token is keyed by its **hash**, never its raw value, so the limiter's
        state cannot become a place where live tokens sit in memory as strings.
        """
        buckets = [
            (f"ip:{ip or 'unknown'}", self._ip_max),
            (f"tok:{hash_token(token or '').hex()}", self._max),
        ]
        # Evaluate both buckets so an attempt counts against the token even when
        # the IP bucket is already exhausted (and vice versa).
        return all([self._hit(key, limit) for key, limit in buckets])

    def _hit(self, key: str, limit: int) -> bool:
        now = self._now()
        started, count = self._buckets.get(key, (now, 0))
        if now - started >= self._window:
            started, count = now, 0
        count += 1
        self._buckets[key] = (started, count)
        if len(self._buckets) > _THROTTLE_MAX_KEYS:
            self._evict(now)
        return count <= limit

    def _evict(self, now: float) -> None:
        """Drop expired buckets so a token-spraying attack cannot grow memory."""
        self._buckets = {
            key: value
            for key, value in self._buckets.items()
            if now - value[0] < self._window
        }


async def initialize_invitations(connection: "asyncpg.Connection") -> None:
    """Create the ``invitations`` table + its RLS policy in this schema.

    Idempotent, and ordered after :func:`hermes_cli.access.initialize_access`
    because the table's foreign keys point at ``principals``.
    """
    from hermes_cli.access import initialize_access

    await initialize_access(connection)
    await connection.execute(INVITATIONS_SCHEMA_SQL)
    await apply_invitations_rls(connection)


async def apply_invitations_rls(connection: "asyncpg.Connection") -> None:
    """FORCE row-level security on ``invitations`` (owner / creator / redeem).

    A ``FORCE``d read policy so even the table owner sees a row only when the
    bound principal is the owner role or the invitation's ``created_by`` — the
    doc's rule — plus the :data:`GUC_REDEEM` seam the unauthenticated redeem
    path opens for exactly one lookup. Writes are unrestricted by policy and
    gated in the service above (there is no user-facing SQL path).
    """
    from hermes_cli.access import GUC_PRINCIPAL_ID, GUC_PRINCIPAL_ROLE

    await connection.execute(
        f"""
        ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
        ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS hermes_invitation_read ON invitations;
        CREATE POLICY hermes_invitation_read ON invitations
            FOR SELECT
            USING (
                current_setting('{GUC_PRINCIPAL_ROLE}', true) = 'owner'
                OR created_by = current_setting('{GUC_PRINCIPAL_ID}', true)
                OR current_setting('{GUC_REDEEM}', true) = '{_REDEEM_ON}'
            );
        """
    )


class InvitationStore:
    """Mint / regenerate / revoke / redeem invitations in one profile's schema."""

    def __init__(
        self,
        store: "SupabaseAppStore",
        *,
        config: Mapping[str, object] | None = None,
        profile: str = DEFAULT_PROFILE,
    ) -> None:
        self._store = store
        self._config = config or {}
        #: The profile whose schema ``store`` reaches; new tokens are bound to
        #: it and lookups accept only digests bound to it.
        self.profile = profile or DEFAULT_PROFILE

    async def mint(
        self,
        *,
        user_id: str,
        created_by: str,
        kind: InvitationKind = "activation",
        ttl_seconds: int | None = None,
        connection: "asyncpg.Connection | None" = None,
    ) -> MintedInvitation:
        """Mint an invitation for ``user_id``, revoking their earlier open ones.

        Regeneration and first issue are the same operation: an outstanding
        link for the same person and kind is revoked in the same transaction,
        so a link that leaked cannot be redeemed after the admin replaces it.
        """
        if kind not in INVITATION_KINDS:
            raise InvitationError(f"Unknown invitation kind: {kind!r}")
        ttl = ttl_seconds if ttl_seconds is not None else invitation_ttl_seconds(
            self._config, kind=kind
        )
        if ttl <= 0:
            raise InvitationError("The invitation TTL must be positive.")
        token = mint_token()
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_invitations(conn)
            async with conn.transaction():
                await self._revoke_open(conn, user_id=user_id, kind=kind)
                row = await conn.fetchrow(
                    """
                    INSERT INTO invitations
                        (user_id, kind, token_hash, expires_at, created_by)
                    VALUES ($1, $2, $3, NOW() + make_interval(secs => $4), $5)
                    RETURNING id, user_id, kind, expires_at, used_at,
                              revoked_at, created_by, created_at
                    """,
                    user_id,
                    kind,
                    hash_token(token, self.profile),
                    float(ttl),
                    created_by,
                )
            return MintedInvitation(Invitation.from_row(row), token)
        finally:
            if own:
                await conn.close()

    async def revoke(
        self,
        *,
        user_id: str,
        kind: InvitationKind | None = None,
        connection: "asyncpg.Connection | None" = None,
    ) -> int:
        """Revoke every open invitation for ``user_id``; return how many."""
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_invitations(conn)
            return await self._revoke_open(conn, user_id=user_id, kind=kind)
        finally:
            if own:
                await conn.close()

    async def latest_for_users(
        self,
        user_ids: list[str],
        *,
        kind: InvitationKind | None = None,
        connection: "asyncpg.Connection | None" = None,
    ) -> dict[str, Invitation]:
        """Return each user's most recent invitation (never its token).

        One grouped query rather than one per row, for the same reason the
        channel lookup is grouped: a console page must not scale its query
        count with its page size.
        """
        if not user_ids:
            return {}
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_invitations(conn)
            rows = await conn.fetch(
                """
                SELECT DISTINCT ON (user_id)
                       id, user_id, kind, expires_at, used_at, revoked_at,
                       created_by, created_at
                FROM invitations
                WHERE user_id = ANY($1::text[])
                  AND ($2::text IS NULL OR kind = $2)
                ORDER BY user_id, created_at DESC
                """,
                user_ids,
                kind,
            )
            return {
                str(row["user_id"]): Invitation.from_row(row) for row in rows
            }
        finally:
            if own:
                await conn.close()

    async def inspect(
        self,
        token: str,
        *,
        connection: "asyncpg.Connection | None" = None,
    ) -> Invitation | None:
        """Return the redeemable invitation ``token`` names, else ``None``.

        Read-only validation for the activation page: it decides whether to
        render a set-password form or the neutral "no longer valid" card. Every
        failure — unknown, tampered, expired, used, revoked — is ``None``.
        """
        digests = token_digests(token or "", self.profile)
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_invitations(conn)
            async with conn.transaction():
                await _bind_redeem(conn)
                row = await conn.fetchrow(
                    """
                    SELECT id, user_id, kind, token_hash, expires_at, used_at,
                           revoked_at, created_by, created_at
                    FROM invitations
                    WHERE token_hash = ANY($1::bytea[])
                      AND used_at IS NULL
                      AND revoked_at IS NULL
                      AND expires_at > NOW()
                    """,
                    list(digests),
                )
            if row is None or not _digest_matches(row["token_hash"], digests):
                return None
            return Invitation.from_row(row)
        finally:
            if own:
                await conn.close()

    async def claim(
        self,
        token: str,
        *,
        connection: "asyncpg.Connection | None" = None,
    ) -> Invitation | None:
        """Atomically mark ``token`` used and return it, else ``None``.

        The single-use guarantee: the ``UPDATE`` matches only an unused,
        unrevoked, unexpired row, so of two concurrent redeems exactly one gets
        a row back. The caller performs the account operation afterwards and
        calls :meth:`release` if it fails, so a GoTrue outage does not consume
        somebody's only link.
        """
        digests = token_digests(token or "", self.profile)
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_invitations(conn)
            async with conn.transaction():
                await _bind_redeem(conn)
                row = await conn.fetchrow(
                    """
                    UPDATE invitations SET used_at = NOW()
                    WHERE token_hash = ANY($1::bytea[])
                      AND used_at IS NULL
                      AND revoked_at IS NULL
                      AND expires_at > NOW()
                    RETURNING id, user_id, kind, token_hash, expires_at,
                              used_at, revoked_at, created_by, created_at
                    """,
                    list(digests),
                )
            if row is None or not _digest_matches(row["token_hash"], digests):
                return None
            return Invitation.from_row(row)
        finally:
            if own:
                await conn.close()

    async def release(
        self,
        invitation_id: str,
        *,
        connection: "asyncpg.Connection | None" = None,
    ) -> None:
        """Undo a :meth:`claim` whose account operation failed."""
        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await conn.execute(
                "UPDATE invitations SET used_at = NULL WHERE id = $1::uuid",
                invitation_id,
            )
        finally:
            if own:
                await conn.close()

    # -- internals ---------------------------------------------------------

    async def _revoke_open(
        self,
        connection: "asyncpg.Connection",
        *,
        user_id: str,
        kind: InvitationKind | None,
    ) -> int:
        rows = await connection.fetch(
            """
            UPDATE invitations SET revoked_at = NOW()
            WHERE user_id = $1
              AND used_at IS NULL
              AND revoked_at IS NULL
              AND ($2::text IS NULL OR kind = $2)
            RETURNING id
            """,
            user_id,
            kind,
        )
        return len(rows)


async def _bind_redeem(connection: "asyncpg.Connection") -> None:
    """Open the redeem seam in the RLS policy for this transaction only."""
    await connection.execute(
        "SELECT set_config($1, $2, true)", GUC_REDEEM, _REDEEM_ON
    )


def _digest_matches(stored: object, digests: tuple[bytes, ...]) -> bool:
    """Constant-time comparison of the stored digest against each candidate."""
    if not isinstance(stored, (bytes, bytearray, memoryview)):
        return False
    value = bytes(stored)
    return any([hmac.compare_digest(value, digest) for digest in digests])


def _as_dt(value: object) -> datetime:
    if not isinstance(value, datetime):
        raise InvitationError("Invitation row is missing a timestamp")
    return value


def _optional_dt(value: object) -> datetime | None:
    return value if isinstance(value, datetime) else None
