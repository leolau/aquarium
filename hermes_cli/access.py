"""Multi-user access model for the single shared Hermes brain (contracts C1, C2).

This module publishes the two Wave-0 access contracts consumed by later
feature groups (memory, skills, goals, tasks, tools, assets):

* **C1 — principal/identity.** :class:`Principal` binds a system ``user_id`` to
  a single :data:`Role` (``owner`` | ``admin`` | ``member`` | ``viewer``) plus
  the channel identities that map to it. :func:`resolve_principal` is the
  gateway seam that turns an inbound channel identity into a principal, reusing
  ``gateway/pairing.py`` for enrolment. Identities are backed by self-hosted
  Supabase: ``principals.user_id`` **is** the GoTrue subject id, and the
  ``channel_identities`` table maps ``(platform, channel_user_id)`` onto it.

* **C2 — visibility/scoping.** Every scoped row carries ``owner_user_id`` and a
  ``visibility`` of either :data:`SHARED` (readable by all members) or
  ``private:<user_id>`` (readable only by that user). :func:`can_read` and
  :func:`scope_filter` are the app-layer filter; :func:`apply_scope_rls`
  installs the equivalent **Postgres row-level security** so the boundary is
  enforced at the database and cannot be bypassed from the app layer. The owner
  role bypasses the filter and sees everything.

  **Per-item grants (FG-19).** On top of shared/private, a row may be
  *granted* to specific users through the :data:`ITEM_GRANTS_TABLE` — a
  cross-user assignment that does **not** downgrade the row's visibility (the
  owner's *other* private rows stay hidden). :func:`scope_filter` and
  :func:`apply_scope_rls` take an optional ``grant_item_kind`` so a
  grant-scoped table (a GTS goal/task) additionally reads a row when an active
  (``pending``/``accepted``) grant to the requesting principal exists for that
  exact item. This is a narrow extension of the existing C2 helpers, not a
  second access system.

Datastore routing always goes through contract C3
(:func:`hermes_cli.datastore.get_store`) — this module never opens a raw
connection or re-implements mode routing.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import (
    TYPE_CHECKING,
    Callable,
    Dict,
    Literal,
    Mapping,
    Protocol,
    Sequence,
    Tuple,
)

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore


# ---------------------------------------------------------------------------
# C1 — principal / identity model
# ---------------------------------------------------------------------------

Role = Literal["owner", "admin", "member", "viewer"]

ROLES: tuple[Role, ...] = ("owner", "admin", "member", "viewer")

#: Roles that may read every private tier (the owner bypasses scope filtering).
_OWNER_ROLE: Role = "owner"

#: The role assumed for an identity whose principal could not be resolved.
#: ``member`` — the base rung: its own private data plus what is shared, and
#: nothing of anyone else's. An unresolved identity must never land on a role
#: that can read other users' private rows.
_UNRESOLVED_ROLE: Role = "member"

SHARED: Literal["shared"] = "shared"
_PRIVATE_PREFIX = "private:"

_VALID_USER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class ChannelOrigin(Protocol):
    """Minimal inbound-source contract needed to resolve a principal."""

    @property
    def platform(self) -> object:
        """Return the origin platform (an enum exposing ``value``, or a str)."""
        ...

    @property
    def user_id(self) -> str | None:
        """Return the channel-native user identifier, if any."""
        ...


@dataclass(frozen=True)
class Principal:
    """A resolved system user and its single role (contract C1).

    ``user_id`` is the stable system identity — the Supabase GoTrue subject id.
    ``channels`` lists the ``platform:channel_user_id`` identities that map onto
    this principal. Exactly one principal in the shared brain may hold the
    ``owner`` role at a time (enforced by a partial unique index and by the
    approval-gated transfer flow).
    """

    user_id: str
    display: str
    role: Role
    channels: tuple[str, ...] = field(default_factory=tuple)
    created_at: datetime | None = None
    #: Whether this *enrolment* is live in the current profile. A deactivated
    #: enrolment keeps the row (so ``owner_user_id`` attribution and audit
    #: history stay correct) but carries no authority here — and, because
    #: accounts are box-wide under one shared GoTrue, it leaves the person's
    #: login and their other profiles untouched (FG-26 §3.5).
    active: bool = True

    def __post_init__(self) -> None:
        if self.role not in ROLES:
            raise ValueError(f"Unknown role: {self.role!r}")
        if not self.user_id or not self.user_id.strip():
            raise ValueError("Principal.user_id cannot be empty")

    @property
    def is_owner(self) -> bool:
        """Whether this principal holds the single owner role (bypasses scope)."""
        return self.role == _OWNER_ROLE

    @property
    def private_visibility(self) -> str:
        """The ``private:<user_id>`` tag for rows only this principal may read."""
        return private(self.user_id)


def normalize_role(role: object) -> Role:
    """Coerce a possibly-unresolved role onto the C2 ladder.

    Callers hand this whatever the identity seam produced — a real role from the
    ``principals`` table, ``None`` when resolution failed or the identity is not
    enrolled, or a value read from somewhere less trustworthy. Anything that is
    not exactly one of :data:`ROLES` becomes :data:`_UNRESOLVED_ROLE`, so a
    missing or malformed role degrades to base privilege instead of being passed
    through to a reader that would treat an unexpected string as "not a member,
    therefore unrestricted".
    """
    if isinstance(role, str) and role in ROLES:
        return role  # type: ignore[return-value]
    return _UNRESOLVED_ROLE


def private(user_id: str) -> str:
    """Return the ``private:<user_id>`` visibility tag for a user."""
    if not user_id or not user_id.strip():
        raise ValueError("private() requires a non-empty user_id")
    return f"{_PRIVATE_PREFIX}{user_id}"


def parse_private_owner(visibility: str) -> str | None:
    """Return the user id embedded in a ``private:<user_id>`` tag, else ``None``."""
    if isinstance(visibility, str) and visibility.startswith(_PRIVATE_PREFIX):
        owner = visibility[len(_PRIVATE_PREFIX):]
        return owner or None
    return None


def normalize_visibility(visibility: str) -> str:
    """Validate and normalize a visibility tag (``shared`` or ``private:<u>``)."""
    if visibility == SHARED:
        return SHARED
    owner = parse_private_owner(visibility)
    if owner is None:
        raise ValueError(
            f"Invalid visibility {visibility!r}; expected 'shared' or "
            "'private:<user_id>'"
        )
    return private(owner)


# ---------------------------------------------------------------------------
# C2 — per-item grants (FG-19): cross-user assignment as a per-row grant
# ---------------------------------------------------------------------------

#: The per-item grant table (FG-19). A grant is a cross-user share of one
#: specific GTS item — an ``assignee`` (single, may act) or a read-only
#: ``watcher`` — layered on top of the shared/private ``visibility`` tag. It
#: never rewrites ``visibility``, so the owner's *other* private rows stay
#: hidden from the grantee.
ITEM_GRANTS_TABLE = "item_grants"

#: Kinds of item a grant may target: the C9 GTS nodes, plus a single live
#: ``memory`` row (FG-21 P3) and a single ingested ``document`` (P4) so one
#: person can share one row with a peer the role hierarchy deliberately does not
#: reach — the sideways case, granted by an explicit act rather than by rank.
GRANT_ITEM_KINDS: tuple[str, ...] = ("goal", "task", "memory", "document")
#: Grant roles: a single ``assignee`` (may advance progress) + read-only
#: ``watcher``s.
GRANT_TYPES: tuple[str, ...] = ("assignee", "watcher")
#: Grant lifecycle states. Only :data:`GRANT_ACTIVE_STATUSES` confer access.
GRANT_STATUSES: tuple[str, ...] = ("pending", "accepted", "declined", "revoked")
#: The statuses that actually confer read/act access (a declined/revoked grant
#: confers nothing).
GRANT_ACTIVE_STATUSES: tuple[str, ...] = ("pending", "accepted")

_GRANT_KINDS_SQL = ", ".join(f"'{kind}'" for kind in GRANT_ITEM_KINDS)

ITEM_GRANTS_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {ITEM_GRANTS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_kind TEXT NOT NULL CHECK (item_kind IN ({_GRANT_KINDS_SQL})),
    item_id UUID NOT NULL,
    user_id TEXT NOT NULL,
    grant_type TEXT NOT NULL CHECK (grant_type IN ('assignee', 'watcher')),
    granted_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted'
        CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (item_kind, item_id, user_id)
);
CREATE INDEX IF NOT EXISTS {ITEM_GRANTS_TABLE}_grantee_idx
    ON {ITEM_GRANTS_TABLE} (user_id, status);
CREATE INDEX IF NOT EXISTS {ITEM_GRANTS_TABLE}_item_idx
    ON {ITEM_GRANTS_TABLE} (item_kind, item_id);
-- The single-assignee invariant (D15): at most one *active* assignee per item.
CREATE UNIQUE INDEX IF NOT EXISTS {ITEM_GRANTS_TABLE}_single_assignee
    ON {ITEM_GRANTS_TABLE} (item_kind, item_id)
    WHERE grant_type = 'assignee' AND status IN ('pending', 'accepted');

-- A table created before ``memory`` joined GRANT_ITEM_KINDS still carries the
-- old two-value CHECK, and CREATE TABLE IF NOT EXISTS cannot widen it. Replace
-- the constraint so the enum has exactly one source of truth (the tuple above)
-- on a new install and on an existing deployment alike.
ALTER TABLE {ITEM_GRANTS_TABLE}
    DROP CONSTRAINT IF EXISTS {ITEM_GRANTS_TABLE}_item_kind_check;
ALTER TABLE {ITEM_GRANTS_TABLE}
    ADD CONSTRAINT {ITEM_GRANTS_TABLE}_item_kind_check
    CHECK (item_kind IN ({_GRANT_KINDS_SQL}));
"""


def _grant_exists_sql(item_kind: str, id_expr: str, user_expr: str) -> str:
    """SQL ``EXISTS`` clause: an active grant of ``item_kind`` to ``user_expr``.

    ``item_kind`` is validated against :data:`GRANT_ITEM_KINDS` and inlined
    (it is a fixed enum, never user input); ``id_expr`` / ``user_expr`` are
    caller-controlled SQL fragments (a validated column reference and either a
    ``$n`` placeholder or a ``current_setting(...)`` call).
    """
    if item_kind not in GRANT_ITEM_KINDS:
        raise ValueError(f"Unknown grant item_kind: {item_kind!r}")
    statuses = ", ".join(f"'{status}'" for status in GRANT_ACTIVE_STATUSES)
    return (
        f"EXISTS (SELECT 1 FROM {ITEM_GRANTS_TABLE} ig "
        f"WHERE ig.item_kind = '{item_kind}' AND ig.item_id = {id_expr} "
        f"AND ig.user_id = {user_expr} AND ig.status IN ({statuses}))"
    )


# ---------------------------------------------------------------------------
# C2 — role hierarchy (FG-21 P3): downward-only elevated reads
# ---------------------------------------------------------------------------

#: The role ladder as ranks, lower number = more privilege. A reader may read a
#: subject's private rows only when its rank is **strictly** lower — reads go
#: *down* the hierarchy, never sideways. Two admins therefore cannot read each
#: other, which is the difference between a hierarchy and a free-for-all among
#: peers; and ``member``/``member`` stays mutually invisible, which is the
#: property C2 already guaranteed and this must not weaken.
ROLE_RANK: dict[Role, int] = {"owner": 0, "admin": 1, "member": 2, "viewer": 3}

#: Roles that can be *above* somebody, i.e. that a downward read can start from.
#: Kept explicit so a future role added to :data:`ROLES` cannot silently acquire
#: elevated reads by sorting above another role.
ELEVATED_READER_ROLES: tuple[Role, ...] = ("owner", "admin", "member")

#: GUC that turns database-level elevated reads on. Absent or anything other
#: than ``'on'`` means off, so a connection that forgets to bind it gets the
#: plain C2 policy — the fail-closed direction.
_GUC_ELEVATION = "hermes.elevated_reads"
_ELEVATION_ON = "on"


def role_rank(role: object) -> int:
    """Rank of ``role`` on the ladder; an unrecognised role gets the last rung.

    Deliberately *not* :func:`normalize_role`, whose unknown-value default is
    ``member`` (the right base privilege for an unresolvable session identity,
    and one rung above the bottom). Here the value is being used to decide
    whether one person reads another's private rows, so an unrecognised role
    must rank least-privileged: it can be read, it cannot read. This also
    matches the ``ELSE`` branch of :func:`_role_rank_sql`, so the app filter and
    the RLS policy agree about a malformed role instead of disagreeing silently.
    """
    if isinstance(role, str) and role in ROLE_RANK:
        return ROLE_RANK[role]  # type: ignore[index]
    return max(ROLE_RANK.values())


def reads_role_below(reader: object, subject: object) -> bool:
    """Whether ``reader``'s role may read ``subject``'s role by hierarchy.

    Strictly downward: ``owner`` reads everyone, ``admin`` reads members and
    viewers but **not** other admins, and nobody reads their own peers. This is
    the role part of the decision only — the caller still has to be a different
    person, and the instance still has to have elevation enabled.
    """
    return role_rank(reader) < role_rank(subject)


def _role_rank_sql(role_expr: str) -> str:
    """SQL expression mapping a role expression onto :data:`ROLE_RANK`.

    Written as a ``CASE`` rather than a helper function so no migration or
    ``CREATE FUNCTION`` privilege is needed for the RLS policy to use it, and so
    the ladder lives in exactly one place in Python. An unrecognised role falls
    through to the least-privileged rank, matching :func:`role_rank`.
    """
    branches = " ".join(
        f"WHEN '{role}' THEN {rank}" for role, rank in ROLE_RANK.items()
    )
    lowest = max(ROLE_RANK.values())
    return f"(CASE {role_expr} {branches} ELSE {lowest} END)"


def _elevated_read_sql(
    owner_expr: str,
    *,
    reader_id_expr: str,
    reader_rank_sql: str,
    principals_table: str = "principals",
) -> str:
    """SQL clause: ``owner_expr`` belongs to somebody the reader ranks above.

    Correlated against the ``principals`` table because the row itself does not
    carry its owner's role — and must not: a role change has to take effect on
    the next read, not be frozen into every row the user ever wrote.
    """
    return (
        f"({owner_expr} <> {reader_id_expr} AND EXISTS ("
        f"SELECT 1 FROM {principals_table} p "
        f"WHERE p.user_id = {owner_expr} "
        f"AND {_role_rank_sql('p.role')} > {reader_rank_sql}))"
    )


# ---------------------------------------------------------------------------
# C2 — visibility / scoping helpers (app-layer filter)
# ---------------------------------------------------------------------------


def can_read(
    principal: Principal,
    visibility: str,
    *,
    granted: bool = False,
) -> bool:
    """Whether ``principal`` may read a row with the given ``visibility``.

    The owner role bypasses the filter (sees everything). ``shared`` rows are
    readable by every member; a ``private:<u>`` row is readable only by ``u``.
    ``granted`` (FG-19) is set by the caller when an active per-item grant to
    ``principal`` exists for the row — a grant confers read access to *that*
    item without touching its ``visibility`` tag.
    """
    if principal.is_owner:
        return True
    if visibility == SHARED:
        return True
    if granted:
        return True
    owner = parse_private_owner(visibility)
    return owner is not None and owner == principal.user_id


def can_read_row(
    principal: Principal,
    row: Mapping[str, object],
    *,
    granted: bool = False,
) -> bool:
    """Convenience wrapper of :func:`can_read` for a row mapping.

    Reads the ``visibility`` key; a missing/empty value is treated as an
    unreadable private-to-nobody row (fail closed) unless the caller is owner
    or holds an active per-item grant (``granted``, FG-19).
    """
    if principal.is_owner or granted:
        return True
    visibility = row.get("visibility")
    if not isinstance(visibility, str) or not visibility:
        return False
    return can_read(principal, visibility)


@dataclass(frozen=True)
class ScopePredicate:
    """A SQL read-visibility predicate + positional params for asyncpg.

    ``sql`` slots into a ``WHERE`` clause; ``params`` are the ``$n`` bind
    values in order. ``start_index`` controls the first placeholder number so
    the predicate composes with a caller's existing parameters.
    """

    sql: str
    params: tuple[str, ...]


def scope_filter(
    principal: Principal,
    *,
    column: str = "visibility",
    start_index: int = 1,
    grant_item_kind: str | None = None,
    id_column: str = "id",
    role_elevation: bool = False,
    owner_column: str = "owner_user_id",
) -> ScopePredicate:
    """Return the read-visibility predicate for ``principal`` (contract C2).

    The owner role bypasses scoping (``TRUE`` with no params). A non-owner sees
    ``shared`` rows plus its own ``private:<user_id>`` rows. The predicate is
    parameterized to keep it injection-safe when composed into an asyncpg query.

    When ``grant_item_kind`` (FG-19) is given, the predicate also matches a row
    whose ``id_column`` has an active per-item grant to ``principal`` — the
    "assigned/granted to me" clause. This never widens access to the owner's
    *other* private rows: the grant is correlated to the row's own id. The
    grant clause binds one extra positional param (the principal's user id) at
    ``start_index + 1``, so a caller composing further placeholders must offset
    by 2 rather than 1.

    With ``role_elevation`` (FG-21 P3) the predicate additionally matches rows
    owned by someone the principal ranks **strictly above** on the role ladder —
    the downward-only hierarchy read. It is off by default and must stay that
    way: it is the one clause here that lets one person read another's private
    rows by role rather than by their own act, so it is enabled deliberately,
    per table, by a caller that also audits the read. Like the grant clause it
    binds the principal's user id as one extra param.
    """
    if not _VALID_COLUMN.fullmatch(column):
        raise ValueError(f"Invalid column name for scope_filter: {column!r}")
    if principal.is_owner:
        return ScopePredicate("TRUE", ())
    placeholder = f"${start_index}"
    clauses = [f"{column} = 'shared'", f"{column} = {placeholder}"]
    params: tuple[str, ...] = (principal.private_visibility,)
    if grant_item_kind is not None:
        if not _VALID_COLUMN.fullmatch(id_column):
            raise ValueError(f"Invalid id_column for scope_filter: {id_column!r}")
        if "." not in id_column:
            # The grant clause is a sub-select over item_grants, which has its
            # own `id` column, so an unqualified name binds to *that* one and the
            # clause silently matches nothing. A caller would see grants that
            # never confer access and no error anywhere.
            raise ValueError(
                f"id_column must be table-qualified for the grant clause "
                f"(got {id_column!r}; use '<table>.{id_column}')"
            )
        grant_placeholder = f"${start_index + 1}"
        clauses.append(
            _grant_exists_sql(grant_item_kind, id_column, grant_placeholder)
        )
        params = (principal.private_visibility, principal.user_id)
    if role_elevation and principal.role in ELEVATED_READER_ROLES:
        if not _VALID_COLUMN.fullmatch(owner_column):
            raise ValueError(f"Invalid owner_column for scope_filter: {owner_column!r}")
        id_placeholder = f"${start_index + len(params)}"
        clauses.append(
            _elevated_read_sql(
                owner_column,
                reader_id_expr=id_placeholder,
                reader_rank_sql=str(role_rank(principal.role)),
            )
        )
        params = (*params, principal.user_id)
    sql = "(" + " OR ".join(clauses) + ")"
    return ScopePredicate(sql, params)


def reads_by_elevation(
    principal: Principal,
    row: Mapping[str, object],
    *,
    owner_role: object,
) -> bool:
    """Whether ``principal`` sees this row **only** because it ranks above.

    Used to label and audit a read rather than to permit it: a row the reader
    could already see (its own, or ``shared``) is not an elevated read even when
    the reader outranks its owner, and auditing it as one would bury the reads
    that matter in noise.
    """
    owner_user_id = row.get("owner_user_id")
    if not isinstance(owner_user_id, str) or owner_user_id == principal.user_id:
        return False
    if row.get("visibility") == SHARED:
        return False
    return reads_role_below(principal.role, owner_role)


_VALID_COLUMN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
#: A column name a policy builder will qualify itself, so it must NOT already
#: carry a table prefix: passing ``"memory_projection.id"`` where ``"id"`` is
#: expected yields ``memory_projection.memory_projection.id``, which Postgres
#: rejects only when the policy is created — long after the typo.
_VALID_BARE_COLUMN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_VALID_SCHEMA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# ---------------------------------------------------------------------------
# Database schema (Supabase app layer) — principals, identities, RLS
# ---------------------------------------------------------------------------

# Row-level security keys the read decision off two GUCs that mirror the JWT
# claims PostgREST/GoTrue would expose (``request.jwt.claims``): the requesting
# principal id and role. On the deployed stack these come from the verified
# access token; in direct-asyncpg tests they are set via :func:`bind_principal`.
_GUC_ID = "hermes.principal_id"
_GUC_ROLE = "hermes.principal_role"

#: Public names of the two GUCs, for modules writing their own RLS policy over a
#: table this module doesn't know about (e.g. the memory audit ledger, whose
#: read rule is reader-or-subject rather than C2 visibility). Exported so such a
#: policy references the same GUCs as :func:`bind_principal` instead of
#: re-typing the strings and silently drifting.
GUC_PRINCIPAL_ID = _GUC_ID
GUC_PRINCIPAL_ROLE = _GUC_ROLE

ACCESS_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS principals (
    user_id TEXT PRIMARY KEY,
    display TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enrolment state (FG-26). Deactivating somebody in a profile console must be
-- a *per-profile* verb: with one shared GoTrue an account is box-wide, so
-- banning it would revoke their access in every other profile too. Additive so
-- a deployment created before FG-26 gains the column without a migration.
ALTER TABLE principals
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Exactly-one-owner invariant: at most one principal may hold the owner role.
CREATE UNIQUE INDEX IF NOT EXISTS principals_single_owner
    ON principals (role) WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS channel_identities (
    platform TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES principals(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (platform, channel_user_id)
);
CREATE INDEX IF NOT EXISTS channel_identities_user
    ON channel_identities (user_id);

-- Login-subject aliases: map an auth provider's stable subject id (e.g. a
-- Supabase/GoTrue ``sub`` UUID) onto an existing principal whose ``user_id``
-- is *not* that subject. New members are enrolled with their subject *as* the
-- user_id and need no alias; this table exists for principals enrolled before
-- the auth provider (the bootstrap owner) so their web login still resolves to
-- them without re-keying historical rows.
CREATE TABLE IF NOT EXISTS principal_aliases (
    alias_subject TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES principals(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS principal_aliases_user
    ON principal_aliases (user_id);
"""


async def initialize_access(connection: asyncpg.Connection) -> None:
    """Create the C1 principal/identity tables in the connection's schema.

    Idempotent. The connection's ``search_path`` selects the profile's dev or
    prod schema (contract C3), so the same DDL yields schema parity across dev
    and prod as FG-01 requires. That schema is created here if it does not
    exist yet: a profile's derived schema (FG-27) comes into being on first
    contact, and this is the first thing most entry paths execute.
    """
    from hermes_cli.datastore import ensure_app_schema

    key, _, oids = await _probe_access_schema(connection)
    if key is not None and oids is not None and _access_initialized.get(key) == oids:
        return
    await ensure_app_schema(connection)
    await connection.execute(ACCESS_SCHEMA_SQL)
    if key is None and not all(_connection_server(connection)):
        return
    # Re-probe even when the first probe had no key: a schema that did not
    # exist yet has no ``current_schema()`` until the DDL above created it.
    after_key, _, after = await _probe_access_schema(connection)
    if after_key is not None and after is not None:
        _access_initialized[after_key] = after


#: Relations :data:`ACCESS_SCHEMA_SQL` and the schema claim create. Their OIDs
#: fingerprint an initialised schema: a dropped or recreated schema/table gets
#: new OIDs (or none), so the cached state below can never go stale silently.
_ACCESS_RELATIONS = (
    "schema_owner",
    "principals",
    "principals_single_owner",
    "channel_identities",
    "channel_identities_user",
    "principal_aliases",
    "principal_aliases_user",
)

_ACCESS_PROBE_SQL = (
    "SELECT current_setting('search_path', true) AS search_path, "
    "current_schema() AS schema, ARRAY["
    + ", ".join(
        f"to_regclass(quote_ident(current_schema()) || '.{name}')::oid"
        for name in _ACCESS_RELATIONS
    )
    + "] AS oids"
)

#: ``(server, user, database, schema, profile, home) -> relation OIDs`` for
#: schemas whose access DDL already ran in this process. The DDL is idempotent,
#: but re-running it per connection was the top statement in production
#: (``ALTER TABLE ... ADD COLUMN IF NOT EXISTS`` takes an exclusive lock).
_access_initialized: Dict[Tuple[str, ...], Tuple[int, ...]] = {}


def reset_access_cache() -> None:
    """Forget which schemas :func:`initialize_access` has set up (tests, resets)."""
    _access_initialized.clear()


def _connection_server(connection: asyncpg.Connection) -> Tuple[str, str, str]:
    from hermes_cli import db_setup

    return db_setup.connection_key(connection)


async def _probe_access_schema(
    connection: asyncpg.Connection,
) -> Tuple[Tuple[str, ...] | None, str, Tuple[int, ...] | None]:
    """One catalog round trip: the cache key and the access relations' OIDs.

    The key is ``None`` when the connection cannot be identified (a fake in
    unit tests) or its ``search_path`` is not one existing schema; callers then
    run the full DDL as before. OIDs are ``None`` while any relation is missing.
    """
    from hermes_cli.datastore import active_profile_slug
    from hermes_constants import get_hermes_home

    server = _connection_server(connection)
    if not all(server):
        return None, "", None
    row = await connection.fetchrow(_ACCESS_PROBE_SQL)
    if row is None:
        return None, "", None
    pinned = str(row["search_path"] or "").split(",")[0].strip().strip('"')
    schema = str(row["schema"] or "")
    if not schema or pinned != schema:
        return None, schema, None
    key = (
        *server,
        schema,
        active_profile_slug(),
        str(get_hermes_home().resolve()),
    )
    raw = list(row["oids"] or ())
    if len(raw) != len(_ACCESS_RELATIONS) or any(o is None for o in raw):
        return key, schema, None
    return key, schema, tuple(int(o) for o in raw)


async def apply_scope_rls(
    connection: asyncpg.Connection,
    table: str,
    *,
    grant_item_kind: str | None = None,
    id_column: str = "id",
    role_elevation: bool = False,
    owner_column: str = "owner_user_id",
) -> None:
    """Enforce contract-C2 visibility on ``table`` via Postgres RLS.

    ``table`` must carry ``owner_user_id`` and ``visibility`` columns. Installs
    a ``FORCE``d row-level-security read policy so that — even for the table
    owner — a session sees a row only when the bound principal is the owner
    role, the row is ``shared``, or the row is that principal's own
    ``private:<user_id>``. This is the database-level mirror of
    :func:`scope_filter`; the app-layer filter is defense in depth on top.

    When ``grant_item_kind`` (FG-19) is given, the policy gains the
    database-level "granted to me" clause: a row of ``table`` is also visible
    when an active per-item grant to the bound principal exists for that exact
    ``id_column`` — the Postgres mirror of :func:`scope_filter`'s grant clause.
    Re-invoking this (the grant-aware call replaces the plain policy) is safe
    because the policy is dropped and recreated.

    ``role_elevation`` (FG-21 P3) adds the database mirror of
    :func:`scope_filter`'s downward-only hierarchy clause: a row owned by
    somebody the bound principal ranks strictly above is also visible — but
    **only while** the :data:`_GUC_ELEVATION` GUC is bound ``on`` by
    :func:`bind_elevated_reads`. Installing the policy therefore does not by
    itself grant anyone anything; a connection that never binds the GUC reads
    exactly what plain C2 allows. Two gates, both of which must be deliberate.
    """
    if not _VALID_COLUMN.fullmatch(table):
        raise ValueError(f"Invalid table name: {table!r}")
    grant_clause = ""
    if grant_item_kind is not None:
        if not _VALID_BARE_COLUMN.fullmatch(id_column):
            raise ValueError(
                f"Invalid id_column: {id_column!r} — pass the bare column "
                f"name; the policy qualifies it with {table!r} itself"
            )
        grant_clause = "\n                OR " + _grant_exists_sql(
            grant_item_kind,
            f"{table}.{id_column}",
            f"current_setting('{_GUC_ID}', true)",
        )
    elevation_clause = ""
    if role_elevation:
        if not _VALID_BARE_COLUMN.fullmatch(owner_column):
            raise ValueError(
                f"Invalid owner_column: {owner_column!r} — pass the bare "
                f"column name; the policy qualifies it with {table!r} itself"
            )
        elevated = _elevated_read_sql(
            f"{table}.{owner_column}",
            reader_id_expr=f"current_setting('{_GUC_ID}', true)",
            reader_rank_sql=_role_rank_sql(
                f"current_setting('{_GUC_ROLE}', true)"
            ),
        )
        elevation_clause = (
            "\n                OR (current_setting"
            f"('{_GUC_ELEVATION}', true) = '{_ELEVATION_ON}' AND {elevated})"
        )
    await connection.execute(
        f"""
        ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE {table} FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS hermes_scope_read ON {table};
        CREATE POLICY hermes_scope_read ON {table}
            FOR SELECT
            USING (
                current_setting('{_GUC_ROLE}', true) = 'owner'
                OR visibility = 'shared'
                OR visibility = 'private:' || current_setting('{_GUC_ID}', true){grant_clause}{elevation_clause}
            );
        """
    )


async def apply_item_grants_rls(connection: asyncpg.Connection) -> None:
    """Enforce read RLS on the FG-19 :data:`ITEM_GRANTS_TABLE`.

    A ``FORCE``d read policy so a session sees a grant row only when it is the
    owner role, the grantee (``user_id``), or the granter (``granted_by``).
    This keeps the grant ledger itself scoped, and — because the goal/task
    read policies reference this table in a correlated sub-select — it lets a
    grantee's own grant satisfy those policies without exposing anyone else's
    grants.
    """
    await connection.execute(
        f"""
        ALTER TABLE {ITEM_GRANTS_TABLE} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE {ITEM_GRANTS_TABLE} FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS hermes_grant_read ON {ITEM_GRANTS_TABLE};
        CREATE POLICY hermes_grant_read ON {ITEM_GRANTS_TABLE}
            FOR SELECT
            USING (
                current_setting('{_GUC_ROLE}', true) = 'owner'
                OR user_id = current_setting('{_GUC_ID}', true)
                OR granted_by = current_setting('{_GUC_ID}', true)
            );
        """
    )


async def grant_item(
    connection: asyncpg.Connection,
    *,
    item_kind: str,
    item_id: str,
    user_id: str,
    granted_by: str,
) -> None:
    """Give ``user_id`` read access to exactly one row of ``item_kind``.

    The row-specific counterpart to a role read: it shares the item it names and
    nothing else the granter owns. Reactivates an existing grant rather than
    inserting a second one, so re-sharing after a revoke is one row with a
    history instead of a duplicate.

    Callers are responsible for checking that ``granted_by`` may share the item
    (ownership is table-specific and lives with the table).
    """
    if item_kind not in GRANT_ITEM_KINDS:
        raise ValueError(f"Unknown grant item_kind: {item_kind!r}")
    await connection.execute(
        f"""
        INSERT INTO {ITEM_GRANTS_TABLE}
            (item_kind, item_id, user_id, grant_type, granted_by, status)
        VALUES ($1, $2::uuid, $3, 'watcher', $4, 'accepted')
        ON CONFLICT (item_kind, item_id, user_id) DO UPDATE
            SET status = 'accepted', granted_by = EXCLUDED.granted_by,
                updated_at = NOW()
        """,
        item_kind,
        item_id,
        user_id,
        granted_by,
    )


async def revoke_item_grant(
    connection: asyncpg.Connection,
    *,
    item_kind: str,
    item_id: str,
    user_id: str,
    granted_by: str,
) -> bool:
    """Withdraw one grant made by ``granted_by``; True if one was active.

    Revoked, never deleted: that the row *was* shared for a period is part of the
    audit trail, and only :data:`GRANT_ACTIVE_STATUSES` confer access, so
    keeping the history costs nothing at read time.
    """
    if item_kind not in GRANT_ITEM_KINDS:
        raise ValueError(f"Unknown grant item_kind: {item_kind!r}")
    revoked = await connection.fetchval(
        f"""
        UPDATE {ITEM_GRANTS_TABLE} SET status = 'revoked', updated_at = NOW()
        WHERE item_kind = $1 AND item_id = $2::uuid AND user_id = $3
          AND granted_by = $4 AND status = ANY($5::text[])
        RETURNING id
        """,
        item_kind,
        item_id,
        user_id,
        granted_by,
        list(GRANT_ACTIVE_STATUSES),
    )
    return revoked is not None


async def bind_principal(
    connection: asyncpg.Connection,
    principal: Principal,
    *,
    session: bool = False,
) -> None:
    """Bind ``principal`` to the connection for the length of the transaction.

    Sets the ``hermes.principal_id`` / ``hermes.principal_role`` GUCs the RLS
    policy reads. Uses ``set_config(..., is_local => true)`` so the binding is
    scoped to the current transaction, mirroring how a per-request JWT scopes
    ``request.jwt.claims`` on the deployed PostgREST/GoTrue stack.

    ``session=True`` binds for the whole connection instead; only for a
    connection the caller opened and closes itself (an operator job), never a
    pooled one.
    """
    local = not session
    await connection.execute(
        "SELECT set_config($1, $2, $5), set_config($3, $4, $5)",
        _GUC_ID,
        principal.user_id,
        _GUC_ROLE,
        principal.role,
        local,
    )


async def bind_elevated_reads(
    connection: asyncpg.Connection,
    enabled: bool,
) -> None:
    """Turn database-level downward reads on for this transaction (FG-21 P3).

    Separate from :func:`bind_principal` on purpose. Binding a principal is what
    every request does; asking to read *other people's* private rows is a
    distinct decision made by one code path that also writes the audit trail,
    and keeping it a separate call means no request acquires elevation just by
    identifying itself. Transaction-local, like the principal binding, so it
    cannot leak onto a pooled connection's next user.
    """
    await connection.execute(
        "SELECT set_config($1, $2, true)",
        _GUC_ELEVATION,
        _ELEVATION_ON if enabled else "off",
    )


#: The least-privilege application role. It has DML on the app schema but is
#: ``NOBYPASSRLS``/``NOSUPERUSER``, so the C2 read policies actually fire when a
#: request runs under it (``SET LOCAL ROLE``). The privileged login role that
#: owns the schema keeps doing DDL/migrations; only request-serving paths drop
#: to this role after binding a principal.
APP_ROLE_NAME = "hermes_app"


#: The dedicated request-serving *login* role for read-only surfaces (e.g. the
#: ``agent-home`` Next.js app). Unlike :data:`APP_ROLE_NAME` this role is
#: ``LOGIN`` and is connected to *directly* — no ``SET ROLE`` and, crucially, no
#: ``GRANT <role> TO CURRENT_USER`` role-membership statement, which faults the
#: event trigger on some managed Postgres builds (see :func:`ensure_app_role`).
READ_ROLE_NAME = "agent_home_app"


def _quote_literal(value: str) -> str:
    """Quote a string as a Postgres literal (DDL like ``PASSWORD`` can't bind).

    ``standard_conforming_strings`` is on by default, so only the single quote
    needs escaping. NUL/newline are rejected outright rather than escaped.
    """
    if "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError("password may not contain NUL or newline characters")
    return "'" + value.replace("'", "''") + "'"


async def ensure_app_role(
    connection: asyncpg.Connection,
    schema: str,
    *,
    role_name: str = APP_ROLE_NAME,
    grant_membership: bool = True,
    password: str | None = None,
) -> None:
    """Provision the least-privilege, non-BYPASSRLS app role (idempotent).

    With ``password`` the role becomes a ``LOGIN`` role a service connects to
    directly (no ``SET ROLE``, so no membership grant is needed). Every table
    with row-level security also gets write rules for the role — the read
    rules are ``FOR SELECT`` only, and without a matching rule Postgres refuses
    every insert/update/delete from a role that does not bypass RLS. Reads
    stay scoped by the read rules; updates and deletes still only reach rows
    the read rule shows (Postgres applies the SELECT rule to their WHERE).

    Creates ``role_name`` (``NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE``),
    grants it ``USAGE`` on ``schema`` and DML on the schema's current + future
    tables/sequences, and (when ``grant_membership``) grants membership to the
    current (privileged) login role so a request-serving connection can
    ``SET LOCAL ROLE`` to it.

    This is the DB half of the security foundation: the RLS policies installed
    by :func:`apply_scope_rls` are inert against a ``BYPASSRLS`` connection, so
    a request must run its queries under this role for the database to enforce
    C2 visibility as defense-in-depth on top of the app-layer
    :func:`scope_filter`.

    ``grant_membership=False`` skips only the ``GRANT {role} TO CURRENT_USER``
    statement. That statement faults the ``ddl_command_end`` event trigger on
    some managed Postgres builds (notably self-hosted Supabase), terminating the
    backend. On such builds provision a *login* serving role with
    :func:`ensure_read_role` and connect to it directly instead of dropping to
    a ``NOLOGIN`` role via ``SET ROLE``.
    """
    if not _VALID_COLUMN.fullmatch(role_name):
        raise ValueError(f"Invalid role name: {role_name!r}")
    if not _VALID_SCHEMA.fullmatch(schema):
        raise ValueError(f"Invalid schema name: {schema!r}")
    await connection.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role_name}')
            THEN
                CREATE ROLE {role_name}
                    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
            END IF;
        END $$;
        GRANT USAGE ON SCHEMA {schema} TO {role_name};
        GRANT SELECT, INSERT, UPDATE, DELETE
            ON ALL TABLES IN SCHEMA {schema} TO {role_name};
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {schema} TO {role_name};
        ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {role_name};
        ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
            GRANT USAGE, SELECT ON SEQUENCES TO {role_name};
        """
    )
    await apply_app_write_policies(connection, schema, role_name=role_name)
    if password:
        literal = _quote_literal(password)
        # Password/LOGIN-only ALTER: restating the other attributes needs
        # superuser on some builds, and CREATE above already set them.
        await connection.execute(f"ALTER ROLE {role_name} WITH LOGIN PASSWORD {literal};")
        current_db = await connection.fetchval("SELECT current_database()")
        await connection.execute(f'GRANT CONNECT ON DATABASE "{current_db}" TO {role_name};')
    if grant_membership:
        await connection.execute(f"GRANT {role_name} TO CURRENT_USER;")


async def apply_app_write_policies(
    connection: asyncpg.Connection,
    schema: str,
    *,
    role_name: str = APP_ROLE_NAME,
) -> None:
    """Give ``role_name`` the rules it needs on every RLS table in ``schema``.

    - insert/update/delete rules: the read rules are ``FOR SELECT`` only, and
      without a write rule Postgres refuses every write from a non-bypass role.
      Separate rules per command on purpose: a ``FOR ALL`` rule would also be
      a read rule.
    - ``hermes_app_unbound_read``: a connection that has not bound a principal
      (background jobs, and writes whose ``RETURNING`` row Postgres checks
      against the read rules) sees rows as ``postgres`` does today. A request
      that binds a principal stays scoped by the read rules. This adds no
      reach for someone holding the password: they could already bind
      ``principal_role=owner`` themselves (the binding is a client setting).

    Re-run after new RLS tables appear (``hermes db migrate`` does, last).
    """
    if not _VALID_COLUMN.fullmatch(role_name):
        raise ValueError(f"Invalid role name: {role_name!r}")
    if not _VALID_SCHEMA.fullmatch(schema):
        raise ValueError(f"Invalid schema name: {schema!r}")
    await connection.execute(
        f"""
        DO $$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT c.relname AS rn
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = '{schema}'
                    AND c.relkind = 'r'
                    AND c.relrowsecurity
            LOOP
                EXECUTE format('DROP POLICY IF EXISTS hermes_app_insert ON %I.%I', '{schema}', r.rn);
                EXECUTE format('DROP POLICY IF EXISTS hermes_app_update ON %I.%I', '{schema}', r.rn);
                EXECUTE format('DROP POLICY IF EXISTS hermes_app_delete ON %I.%I', '{schema}', r.rn);
                EXECUTE format('DROP POLICY IF EXISTS hermes_app_unbound_read ON %I.%I', '{schema}', r.rn);
                EXECUTE format(
                    'CREATE POLICY hermes_app_unbound_read ON %I.%I FOR SELECT TO {role_name} '
                    'USING (coalesce(current_setting(%L, true), %L) = %L)',
                    '{schema}', r.rn, '{_GUC_ID}', '', '');
                EXECUTE format(
                    'CREATE POLICY hermes_app_insert ON %I.%I FOR INSERT TO {role_name} WITH CHECK (true)',
                    '{schema}', r.rn);
                EXECUTE format(
                    'CREATE POLICY hermes_app_update ON %I.%I FOR UPDATE TO {role_name} USING (true) WITH CHECK (true)',
                    '{schema}', r.rn);
                EXECUTE format(
                    'CREATE POLICY hermes_app_delete ON %I.%I FOR DELETE TO {role_name} USING (true)',
                    '{schema}', r.rn);
            END LOOP;
        END $$;
        """
    )


async def ensure_read_role(
    connection: asyncpg.Connection,
    schema: str,
    *,
    password: str,
    role_name: str = READ_ROLE_NAME,
    extra_schemas: tuple[str, ...] = (),
) -> None:
    """Provision a read-only ``LOGIN`` serving role (idempotent, crash-safe).

    Creates ``role_name`` as ``LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB
    NOCREATEROLE NOINHERIT`` and grants it ``CONNECT`` on the current database,
    ``USAGE`` on ``schema`` (plus ``extra_schemas``), and ``SELECT`` **only on
    tables that have ``FORCE`` row-level security** — so a table without RLS is
    unreadable (fail-closed) rather than fully exposed to this non-BYPASSRLS
    role. A request-serving process (e.g. ``agent-home``) connects *as* this
    role directly, so Postgres RLS enforces C2 visibility on its reads.

    Unlike :func:`ensure_app_role` this never issues a role-membership grant,
    which is what crashes the event trigger on some managed Postgres builds.

    Re-run after promoting new RLS-forced tables to extend the SELECT grants;
    the password is reset on every run (attribute changes are avoided on the
    idempotent path because altering role attributes needs superuser on some
    builds).
    """
    if not _VALID_COLUMN.fullmatch(role_name):
        raise ValueError(f"Invalid role name: {role_name!r}")
    schemas = (schema, *extra_schemas)
    for name in schemas:
        if not _VALID_SCHEMA.fullmatch(name):
            raise ValueError(f"Invalid schema name: {name!r}")
    if not password:
        raise ValueError("read role requires a non-empty password")
    literal = _quote_literal(password)
    attrs = "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT"
    exists = await connection.fetchval(
        "SELECT 1 FROM pg_roles WHERE rolname = $1", role_name
    )
    if exists:
        # Password-only ALTER: restating attributes needs superuser on some
        # builds, and the attributes are already correct from CREATE.
        await connection.execute(f"ALTER ROLE {role_name} PASSWORD {literal};")
    else:
        await connection.execute(
            f"CREATE ROLE {role_name} {attrs} PASSWORD {literal};"
        )
    current_db = await connection.fetchval("SELECT current_database()")
    await connection.execute(
        f'GRANT CONNECT ON DATABASE "{current_db}" TO {role_name};'
    )
    schema_list = ", ".join(f"'{name}'" for name in schemas)
    await connection.execute(
        f"""
        GRANT USAGE ON SCHEMA {", ".join(schemas)} TO {role_name};
        DO $$
        DECLARE r record;
        BEGIN
            FOR r IN
                SELECT n.nspname AS ns, c.relname AS rn
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname IN ({schema_list})
                    AND c.relkind = 'r'
                    AND c.relrowsecurity
                    AND c.relforcerowsecurity
            LOOP
                EXECUTE format(
                    'GRANT SELECT ON %I.%I TO {role_name}', r.ns, r.rn
                );
            END LOOP;
        END $$;
        """
    )


# ---------------------------------------------------------------------------
# Principal store (C1 persistence + owner transfer)
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def validate_user_id(user_id: str) -> str:
    """Return ``user_id`` stripped, or raise ``ValueError`` if it is not a C1 id.

    The charset (``^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$``) excludes path
    separators and ``..``, which is what makes a ``user_id`` usable as a
    single filesystem path component (FG-24 per-participation memory).
    """
    user_id = (user_id or "").strip()
    if not _VALID_USER_ID.fullmatch(user_id):
        raise ValueError(f"Invalid user_id: {user_id!r}")
    return user_id


#: Historical private alias — callers inside this module predate the public name.
_validate_user_id = validate_user_id


def _row_to_principal(
    row: Mapping[str, object],
    channels: tuple[str, ...] = (),
) -> Principal:
    active = row.get("active")
    return Principal(
        user_id=str(row["user_id"]),
        display=str(row["display"] or ""),
        role=_coerce_role(row["role"]),
        channels=channels,
        created_at=_coerce_dt(row.get("created_at")),
        active=True if active is None else bool(active),
    )


def _principal_filters(
    query: str | None,
    role: Role | None,
    active: bool | None = None,
    user_ids: Sequence[str] | None = None,
) -> tuple[str, list[object]]:
    """Build the shared ``WHERE`` clause for listing/counting principals.

    Search matches ``display`` or ``user_id`` case-insensitively. Email lives
    in GoTrue, not here, so an email search is applied by the caller that holds
    the account join (``MemberService``): it resolves the addresses the same
    text matched to ``user_ids`` and passes them here, which keeps this
    predicate inside the profile's own schema.

    ``user_ids`` **widens** the search rather than narrowing it — one search box
    matching a display name, an id or an address — so it is only consulted when
    there is text to match, and an empty list simply adds nothing.
    """
    clauses: list[str] = []
    params: list[object] = []
    text = (query or "").strip()
    if text:
        params.append(f"%{text}%")
        matched = f"display ILIKE ${len(params)} OR user_id ILIKE ${len(params)}"
        if user_ids is not None:
            params.append([str(u) for u in user_ids])
            matched += f" OR user_id = ANY(${len(params)}::text[])"
        clauses.append(f"({matched})")
    if role is not None:
        params.append(role)
        clauses.append(f"role = ${len(params)}")
    if active is not None:
        params.append(active)
        clauses.append(f"active = ${len(params)}")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    return where, params


def _coerce_role(value: object) -> Role:
    for role in ROLES:
        if value == role:
            return role
    raise ValueError(f"Unknown role loaded from store: {value!r}")


def _coerce_dt(value: object) -> datetime | None:
    return value if isinstance(value, datetime) else None


@dataclass(frozen=True)
class TransferResult:
    """References emitted by one successful ownership transfer."""

    from_user_id: str
    to_user_id: str
    approval_ref: str
    change_ref: str


class PrincipalStore:
    """Async CRUD + owner-transfer over the Supabase ``principals`` table.

    Every method routes through the contract-C3 :class:`SupabaseAppStore`; the
    store's ``mode`` selects the ``app_dev`` / ``app_prod`` schema. Ownership
    lives in prod (auth is prod), so :meth:`transfer_owner` requires a prod
    store and records its approval + change-event there.
    """

    def __init__(self, store: SupabaseAppStore) -> None:
        self._store = store

    @property
    def mode(self) -> str:
        return self._store.mode

    @property
    def app_store(self) -> SupabaseAppStore:
        """The C3 store (and therefore the profile schema) this store writes to.

        Exposed so a collaborator that must reach *other* tables in the same
        profile schema — the FG-26 invitation table, the ownership sweep a hard
        delete runs — uses the same store instead of resolving a second one and
        risking a different profile.
        """
        return self._store

    async def _channels_for(
        self,
        connection: asyncpg.Connection,
        user_id: str,
    ) -> tuple[str, ...]:
        rows = await connection.fetch(
            """
            SELECT platform, channel_user_id
            FROM channel_identities
            WHERE user_id = $1
            ORDER BY platform, channel_user_id
            """,
            user_id,
        )
        return tuple(f"{r['platform']}:{r['channel_user_id']}" for r in rows)

    async def _channels_by_user(
        self,
        connection: asyncpg.Connection,
        user_ids: list[str],
    ) -> dict[str, tuple[str, ...]]:
        """Return ``{user_id: channels}`` for ``user_ids`` in **one** query.

        The per-principal :meth:`_channels_for` is correct but costs one round
        trip each, so listing a 500-person profile issued 501 queries (FG-26).
        Grouping in Postgres keeps the ordering the single-user path produces
        (``platform``, then ``channel_user_id``) so the two agree row for row.
        """
        if not user_ids:
            return {}
        rows = await connection.fetch(
            """
            SELECT user_id,
                   ARRAY_AGG(platform || ':' || channel_user_id
                             ORDER BY platform, channel_user_id) AS channels
            FROM channel_identities
            WHERE user_id = ANY($1::text[])
            GROUP BY user_id
            """,
            user_ids,
        )
        return {
            str(row["user_id"]): tuple(str(c) for c in (row["channels"] or ()))
            for row in rows
        }

    async def enroll(
        self,
        user_id: str,
        *,
        display: str = "",
        role: Role = "member",
        connection: asyncpg.Connection | None = None,
    ) -> Principal:
        """Create (or return) a principal. New users default to ``member``.

        Enrolling the very first principal as ``owner`` bootstraps the single
        owner; a second ``owner`` enrolment raises via the partial unique index.
        """
        user_id = _validate_user_id(user_id)
        if role not in ROLES:
            raise ValueError(f"Unknown role: {role!r}")

        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                """
                INSERT INTO principals (user_id, display, role)
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id) DO UPDATE SET display = principals.display
                RETURNING user_id, display, role, created_at, active
                """,
                user_id,
                display,
                role,
            )
            channels = await self._channels_for(conn, user_id)
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def get(
        self,
        user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal | None:
        """Return the principal for ``user_id`` (with channels), else ``None``."""
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                """
                SELECT user_id, display, role, created_at, active
                FROM principals WHERE user_id = $1
                """,
                user_id,
            )
            if row is None:
                return None
            channels = await self._channels_for(conn, user_id)
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def list_principals(
        self,
        *,
        query: str | None = None,
        role: Role | None = None,
        active: bool | None = None,
        user_ids: Sequence[str] | None = None,
        limit: int | None = None,
        offset: int = 0,
        connection: asyncpg.Connection | None = None,
    ) -> list[Principal]:
        """Return the enrolled principals (owner first), with channels.

        Ordered owner → admin → member → viewer, then by enrolment time, so a
        management UI/CLI lists the most privileged accounts first.

        ``query`` matches display name or ``user_id`` case-insensitively, and
        ``limit``/``offset`` page the result **in Postgres** — a 500-person
        roster must not be read whole to render one page. Channels are loaded
        with a single grouped query for the page (see :meth:`_channels_by_user`).
        """
        if role is not None and role not in ROLES:
            raise ValueError(f"Unknown role: {role!r}")
        if limit is not None and limit < 0:
            raise ValueError("limit cannot be negative")
        if offset < 0:
            raise ValueError("offset cannot be negative")
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            where, params = _principal_filters(query, role, active, user_ids)
            sql = f"""
                SELECT user_id, display, role, created_at, active
                FROM principals
                {where}
                ORDER BY
                    CASE role
                        WHEN 'owner' THEN 0
                        WHEN 'admin' THEN 1
                        WHEN 'member' THEN 2
                        ELSE 3
                    END,
                    created_at,
                    user_id
                """
            if limit is not None:
                params.append(limit)
                sql += f" LIMIT ${len(params)}"
            if offset:
                params.append(offset)
                sql += f" OFFSET ${len(params)}"
            rows = await conn.fetch(sql, *params)
            channels = await self._channels_by_user(
                conn, [str(row["user_id"]) for row in rows]
            )
            return [
                _row_to_principal(row, channels.get(str(row["user_id"]), ()))
                for row in rows
            ]
        finally:
            if own_connection:
                await conn.close()

    async def count_principals(
        self,
        *,
        query: str | None = None,
        role: Role | None = None,
        active: bool | None = None,
        user_ids: Sequence[str] | None = None,
        connection: asyncpg.Connection | None = None,
    ) -> int:
        """Count the principals :meth:`list_principals` would return unpaged.

        The page-count a paginated console needs; kept next to the list so the
        two share :func:`_principal_filters` and cannot disagree about what a
        search matches.
        """
        if role is not None and role not in ROLES:
            raise ValueError(f"Unknown role: {role!r}")
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            where, params = _principal_filters(query, role, active, user_ids)
            total = await conn.fetchval(
                f"SELECT COUNT(*) FROM principals {where}", *params
            )
            return int(total or 0)
        finally:
            if own_connection:
                await conn.close()

    async def set_active(
        self,
        user_id: str,
        active: bool,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal:
        """Deactivate or reactivate an enrolment **in this profile only**.

        The per-profile counterpart to a GoTrue ban: the row survives, so rows
        the person owns keep a resolvable ``owner_user_id`` and the audit trail
        stays attributed, but they hold no authority here until reactivated. The
        owner enrolment cannot be deactivated — a profile with no owner has no
        principal the machine-operator surface can resolve.
        """
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            current = await conn.fetchrow(
                "SELECT role FROM principals WHERE user_id = $1", user_id
            )
            if current is None:
                raise KeyError(f"No such principal: {user_id}")
            if current["role"] == _OWNER_ROLE and not active:
                raise ValueError(
                    "Cannot deactivate the owner's enrolment; transfer "
                    "ownership first ('hermes owner transfer')."
                )
            row = await conn.fetchrow(
                """
                UPDATE principals SET active = $2 WHERE user_id = $1
                RETURNING user_id, display, role, created_at, active
                """,
                user_id,
                active,
            )
            channels = await self._channels_for(conn, user_id)
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def set_display(
        self,
        user_id: str,
        display: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal:
        """Rename a principal's display name in this profile."""
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                """
                UPDATE principals SET display = $2 WHERE user_id = $1
                RETURNING user_id, display, role, created_at, active
                """,
                user_id,
                display,
            )
            if row is None:
                raise KeyError(f"No such principal: {user_id}")
            channels = await self._channels_for(conn, user_id)
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def unenroll(
        self,
        user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> bool:
        """Delete a principal row (and its channel identities) from this profile.

        The hard half of a hard delete: callers must already have resolved what
        happens to the rows the person owns, because ``ON DELETE CASCADE``
        reaches ``channel_identities`` and ``principal_aliases`` and nothing
        else — memories, files and GTS items would be left pointing at a
        ``user_id`` no principal answers to. Refuses the owner.
        """
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            current = await conn.fetchrow(
                "SELECT role FROM principals WHERE user_id = $1", user_id
            )
            if current is None:
                return False
            if current["role"] == _OWNER_ROLE:
                raise ValueError(
                    "Cannot delete the owner; transfer ownership first "
                    "('hermes owner transfer')."
                )
            await conn.execute(
                "DELETE FROM principals WHERE user_id = $1", user_id
            )
            return True
        finally:
            if own_connection:
                await conn.close()

    async def set_role(
        self,
        user_id: str,
        role: Role,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal:
        """Change an enrolled principal's role (never touching ``owner``).

        Guards the single-owner invariant: this path refuses to *grant* the
        ``owner`` role and refuses to change the *current owner's* role — both
        go through the approval-gated :meth:`transfer_owner` instead, so the
        partial unique index can never be tripped from member management. Raises
        :class:`KeyError` for an unknown principal.
        """
        user_id = _validate_user_id(user_id)
        if role not in ROLES:
            raise ValueError(f"Unknown role: {role!r}")
        if role == _OWNER_ROLE:
            raise ValueError(
                "Cannot promote to owner here; use 'hermes owner transfer'."
            )
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            current = await conn.fetchrow(
                "SELECT role FROM principals WHERE user_id = $1", user_id
            )
            if current is None:
                raise KeyError(f"No such principal: {user_id}")
            if current["role"] == _OWNER_ROLE:
                raise ValueError(
                    "Cannot change the owner's role here; use "
                    "'hermes owner transfer' to hand off ownership first."
                )
            row = await conn.fetchrow(
                """
                UPDATE principals SET role = $2 WHERE user_id = $1
                RETURNING user_id, display, role, created_at, active
                """,
                user_id,
                role,
            )
            channels = await self._channels_for(conn, user_id)
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def link_channel(
        self,
        user_id: str,
        platform: str,
        channel_user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> None:
        """Map an inbound ``(platform, channel_user_id)`` onto a principal."""
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            await conn.execute(
                """
                INSERT INTO channel_identities (platform, channel_user_id, user_id)
                VALUES ($1, $2, $3)
                ON CONFLICT (platform, channel_user_id)
                DO UPDATE SET user_id = EXCLUDED.user_id
                """,
                platform,
                channel_user_id,
                user_id,
            )
        finally:
            if own_connection:
                await conn.close()

    async def unlink_channel(
        self,
        user_id: str,
        platform: str,
        channel_user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> bool:
        """Drop the ``(platform, channel_user_id)`` mapping if it points at ``user_id``.

        Matching on all three columns means a stale handle in the caller's view
        cannot remove a mapping that has since been re-pointed at somebody else.
        Returns whether a row was removed.
        """
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            status = await conn.execute(
                """
                DELETE FROM channel_identities
                WHERE platform = $1 AND channel_user_id = $2 AND user_id = $3
                """,
                platform,
                channel_user_id,
                user_id,
            )
        finally:
            if own_connection:
                await conn.close()
        return status.endswith(" 1")

    async def link_alias(
        self,
        alias_subject: str,
        user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> None:
        """Map an auth-provider login subject onto an existing principal.

        ``alias_subject`` is the stable subject the auth provider puts in the
        verified session (e.g. a Supabase/GoTrue ``sub`` UUID). ``user_id`` is
        the principal it should resolve to. Re-linking the same subject
        repoints it (idempotent upsert). The principal must already exist (the
        FK enforces this).
        """
        alias_subject = (alias_subject or "").strip()
        if not alias_subject:
            raise ValueError("alias_subject cannot be empty")
        user_id = _validate_user_id(user_id)
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            await conn.execute(
                """
                INSERT INTO principal_aliases (alias_subject, user_id)
                VALUES ($1, $2)
                ON CONFLICT (alias_subject)
                DO UPDATE SET user_id = EXCLUDED.user_id
                """,
                alias_subject,
                user_id,
            )
        finally:
            if own_connection:
                await conn.close()

    async def resolve_alias(
        self,
        alias_subject: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> str | None:
        """Return the principal ``user_id`` a login subject aliases to, else None.

        A subject with no alias row resolves to ``None`` — the caller then
        treats the subject *itself* as the principal ``user_id`` (the common
        case: a member enrolled with their subject as their user_id).
        """
        alias_subject = (alias_subject or "").strip()
        if not alias_subject:
            return None
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                "SELECT user_id FROM principal_aliases WHERE alias_subject = $1",
                alias_subject,
            )
            return str(row["user_id"]) if row is not None else None
        finally:
            if own_connection:
                await conn.close()

    async def resolve_by_channel(
        self,
        platform: str,
        channel_user_id: str,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal | None:
        """Return the principal mapped to a channel identity, else ``None``."""
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                """
                SELECT p.user_id, p.display, p.role, p.created_at, p.active
                FROM channel_identities ci
                JOIN principals p ON p.user_id = ci.user_id
                WHERE ci.platform = $1 AND ci.channel_user_id = $2
                """,
                platform,
                channel_user_id,
            )
            if row is None:
                return None
            channels = await self._channels_for(conn, str(row["user_id"]))
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def get_owner(
        self,
        *,
        connection: asyncpg.Connection | None = None,
    ) -> Principal | None:
        """Return the current single owner principal, if one exists."""
        own_connection = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            row = await conn.fetchrow(
                """
                SELECT user_id, display, role, created_at, active
                FROM principals WHERE role = 'owner'
                """
            )
            if row is None:
                return None
            channels = await self._channels_for(conn, str(row["user_id"]))
            return _row_to_principal(row, channels)
        finally:
            if own_connection:
                await conn.close()

    async def transfer_owner(
        self,
        new_owner_user_id: str,
        *,
        actor: str,
        approved: bool = False,
        approval_callback: Callable[..., str] | None = None,
        demote_to: Role = "admin",
    ) -> TransferResult:
        """Atomically move the single owner role to ``new_owner_user_id``.

        Approval-gated (contract C6): the current owner must approve. The
        transfer demotes the outgoing owner (to ``demote_to``, default
        ``admin``) and promotes the target in one transaction, so the
        exactly-one-owner invariant never breaks. A C5 change-event + C6
        approval row are recorded in ``app_prod``.
        """
        new_owner_user_id = _validate_user_id(new_owner_user_id)
        if demote_to not in ROLES or demote_to == "owner":
            raise ValueError(f"Invalid demote_to role: {demote_to!r}")
        if self._store.mode != "prod":
            raise ValueError("Ownership transfer requires a prod app store")

        from hermes_cli.datastore import app_schema, initialize_supabase_app

        connection = await self._store.connect()
        try:
            await initialize_supabase_app(connection)
            await initialize_access(connection)

            current = await connection.fetchrow(
                "SELECT user_id FROM principals WHERE role = 'owner'"
            )
            if current is None:
                raise ValueError(
                    "No current owner to transfer from; enroll an owner first"
                )
            from_user_id = str(current["user_id"])
            if from_user_id == new_owner_user_id:
                raise ValueError(
                    f"{new_owner_user_id!r} is already the owner"
                )
            target = await connection.fetchrow(
                "SELECT user_id FROM principals WHERE user_id = $1",
                new_owner_user_id,
            )
            if target is None:
                raise KeyError(
                    f"Target principal not enrolled: {new_owner_user_id}"
                )

            if not approved and not _request_transfer_approval(
                from_user_id,
                new_owner_user_id,
                approval_callback=approval_callback,
            ):
                raise PermissionError("Ownership transfer approval was denied")

            approval_ref = f"apr_{uuid.uuid4().hex}"
            change_ref = f"chg_{uuid.uuid4().hex}"
            op = [
                {
                    "op": "transfer_owner",
                    "path": "/principals/owner",
                    "from": from_user_id,
                    "to": new_owner_user_id,
                }
            ]
            inverse_op = [
                {
                    "op": "transfer_owner",
                    "path": "/principals/owner",
                    "from": new_owner_user_id,
                    "to": from_user_id,
                }
            ]

            async with connection.transaction():
                # Demote the outgoing owner FIRST so the partial unique index
                # never sees two owners mid-transfer.
                await connection.execute(
                    "UPDATE principals SET role = $2 WHERE user_id = $1",
                    from_user_id,
                    demote_to,
                )
                await connection.execute(
                    "UPDATE principals SET role = 'owner' WHERE user_id = $1",
                    new_owner_user_id,
                )
                await connection.execute(
                    f"""
                    INSERT INTO {app_schema("prod")}.approvals
                        (id, action, target_ref, actor, decision)
                    VALUES ($1, 'owner.transfer', $2, $3, 'approved')
                    """,
                    approval_ref,
                    f"owner:{new_owner_user_id}",
                    actor,
                )
                await connection.execute(
                    f"""
                    INSERT INTO {app_schema("prod")}.changes
                        (id, actor, mode, target_kind, op, inverse_op,
                         reversible, approval_ref, backup_ref)
                    VALUES ($1, $2, 'prod', 'data', $3::jsonb, $4::jsonb,
                            TRUE, $5, NULL)
                    """,
                    change_ref,
                    actor,
                    json.dumps(op, sort_keys=True),
                    json.dumps(inverse_op, sort_keys=True),
                    approval_ref,
                )
        finally:
            await connection.close()

        return TransferResult(
            from_user_id=from_user_id,
            to_user_id=new_owner_user_id,
            approval_ref=approval_ref,
            change_ref=change_ref,
        )


def _request_transfer_approval(
    from_user_id: str,
    to_user_id: str,
    *,
    approval_callback: Callable[..., str] | None,
) -> bool:
    from tools.approval import prompt_dangerous_approval

    choice = prompt_dangerous_approval(
        f"hermes owner transfer {to_user_id}",
        (
            f"transfer the single owner role from {from_user_id} to "
            f"{to_user_id} (irrevocable without a second transfer)"
        ),
        allow_permanent=False,
        approval_callback=approval_callback,
    )
    return choice in ("once", "session")


# ---------------------------------------------------------------------------
# resolve_principal — the gateway seam (contract C1)
# ---------------------------------------------------------------------------


def _platform_value(source: ChannelOrigin) -> str:
    platform = source.platform
    value = getattr(platform, "value", platform)
    return str(value).lower()


async def resolve_principal(
    source: ChannelOrigin,
    *,
    store: PrincipalStore,
    auto_enroll_if_paired: bool = True,
    is_paired: Callable[[str, str], bool] | None = None,
) -> Principal | None:
    """Map an inbound channel identity to a :class:`Principal` (contract C1).

    Resolution order:

    1. An existing ``channel_identities`` row wins.
    2. Otherwise, if ``auto_enroll_if_paired`` and the user is pairing-approved
       (``gateway/pairing.py`` via ``is_paired``), enrol them as ``member`` and
       link the channel identity.
    3. Otherwise return ``None`` (unenrolled / unauthorized).

    A **suspended** enrolment (``active`` false, FG-26 §3.5) resolves to
    ``None`` — the same answer as an identity nobody enrolled. Suspension is
    profile-local by design (the shared account and the person's other profiles
    survive), so it has to be enforced where a profile grants authority; a
    suspended principal returned here would keep its role and keep acting on
    every channel.

    Pairing/authorization stays owned by ``gateway/pairing.py`` +
    ``gateway/authz_mixin.py``; this seam only maps an already-authorized
    identity onto a system principal.
    """
    channel_user_id = source.user_id
    if not channel_user_id:
        return None
    platform = _platform_value(source)

    connection = await store._store.connect()
    try:
        existing = await store.resolve_by_channel(
            platform, channel_user_id, connection=connection
        )
        if existing is not None:
            return existing if existing.active else None
        if not auto_enroll_if_paired:
            return None
        if is_paired is None:
            is_paired = _default_is_paired
        if not is_paired(platform, channel_user_id):
            return None
        display = str(getattr(source, "user_name", "") or "")
        principal = await store.enroll(
            channel_user_id,
            display=display,
            role="member",
            connection=connection,
        )
        await store.link_channel(
            principal.user_id,
            platform,
            channel_user_id,
            connection=connection,
        )
        # Re-read so the returned principal carries the linked channel. The
        # enrol above is an upsert, so a suspended enrolment stays suspended
        # and pairing cannot be used to walk around a suspension.
        fresh = await store.get(principal.user_id, connection=connection)
        if fresh is not None and not fresh.active:
            return None
        return fresh
    finally:
        await connection.close()


def _default_is_paired(platform: str, channel_user_id: str) -> bool:
    from gateway.pairing import PairingStore

    return PairingStore().is_approved(platform, channel_user_id)
