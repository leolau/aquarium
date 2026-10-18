"""Mode- and profile-aware datastore routing for Hermes core and app state.

The SQLite core store is isolated by construction: it lives inside the
profile's ``HERMES_HOME``.  The Supabase app store is not — every profile
resolves the *same* DSN (one Supabase instance per box is the intended
topology), so the schema name is the only discriminator.  A fixed
``app_prod`` would therefore merge every profile's ``principals``,
``memories`` and ``changes`` into one set, and interleaved rows carry no
provenance column, so they cannot be separated afterwards.

:func:`app_schema` derives the schema from the active profile instead
(``app_prod`` for the default profile — byte-identical to the pre-FG-27 name,
so existing deployments are untouched — and ``app_prod_<profile>`` otherwise).
"""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Mapping, Protocol, overload

from hermes_constants import get_hermes_home
from hermes_cli.config import load_config_readonly

if TYPE_CHECKING:
    import asyncpg

    from hermes_state import SessionDB


StoreKind = Literal["sqlite-core", "supabase-app"]
StoreMode = Literal["dev", "prod"]
ArtifactKind = Literal["tool", "skill", "config", "schema"]

_VALID_SCHEMA = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Postgres truncates identifiers at 63 bytes.  Truncating silently would map
# two long profile names onto one schema, which is the exact failure this
# module exists to prevent, so long names are hashed instead.
_MAX_IDENTIFIER = 63
_DEFAULT_PROFILE = "default"

#: The modes an app datastore exists in.  Both schemas belong to the profile,
#: so anything reasoning about a profile's binding must consider both.
MODES: tuple[StoreMode, ...] = ("prod", "dev")

logger = logging.getLogger(__name__)


class PlatformOrigin(Protocol):
    """Minimal platform-enum contract needed by the mode guard."""

    @property
    def value(self) -> str:
        """Return the platform identifier."""
        ...


class SessionOrigin(Protocol):
    """Minimal session-source contract needed by the mode guard."""

    @property
    def platform(self) -> PlatformOrigin:
        """Return the session's origin platform."""
        ...


def _dsn_missing(dsn: str) -> bool:
    """Empty, or a ``${VAR}`` reference whose variable is not set."""
    return not dsn or dsn.lstrip().startswith("${")


def _terminal_hint() -> str:
    from tools.terminal_db_credentials import hidden_hint

    return hidden_hint()


@dataclass(frozen=True)
class SQLiteCoreStore:
    """Resolved SQLite core store for one Hermes mode."""

    mode: StoreMode
    path: Path

    def connect(self) -> SessionDB:
        """Open the mode's SQLite session database."""
        from hermes_state import SessionDB

        return SessionDB(db_path=self.path)


@dataclass(frozen=True)
class SupabaseAppStore:
    """Resolved Postgres/Supabase application schema for one Hermes mode."""

    mode: StoreMode
    schema: str
    dsn: str

    async def connect(self) -> asyncpg.Connection:
        """Open a connection whose search path is pinned to this store."""
        if _dsn_missing(self.dsn):
            raise RuntimeError(
                "Supabase app datastore is not configured; set "
                "datastore.supabase_app.dsn in config.yaml, preferably as "
                "${DATABASE_URL}." + _terminal_hint()
            )
        if not _VALID_SCHEMA.fullmatch(self.schema):
            raise ValueError(f"Invalid Supabase schema name: {self.schema!r}")

        from tools.lazy_deps import ensure

        ensure("datastore.supabase")

        import asyncpg

        from hermes_cli import db_setup

        connection = await asyncpg.connect(
            self.dsn,
            server_settings={"search_path": self.schema},
            connection_class=db_setup.connection_class(),
        )
        try:
            await db_setup.bind(connection, self.schema)
            await verify_schema_owner(connection, schema=self.schema, dsn=self.dsn)
        except BaseException:
            await connection.close()
            raise
        return connection


Datastore = SQLiteCoreStore | SupabaseAppStore


class SchemaOwnershipError(RuntimeError):
    """Raised when a schema is already claimed by a different profile.

    Fail closed: continuing would interleave two profiles' rows in one set of
    tables, and because those rows carry no provenance column they could not
    be separated again afterwards.
    """


# (dsn, schema, slug) triples verified in this process.  The marker is
# immutable once claimed, so a success can be cached; a *failure* is never
# cached, so it is re-raised on every attempt.
_verified_schemas: set[tuple[str, str, str]] = set()


def _platform_name(source: SessionOrigin) -> str:
    return source.platform.value.lower()


def _short_hash(value: str) -> str:
    """Return a short, stable, identifier-safe digest of ``value``."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def _profile_slug(profile: str) -> str:
    """Return an identifier-safe, collision-free slug for a profile name.

    Profile names allow ``-`` (``^[a-z0-9][a-z0-9_-]{0,63}$``) which is not
    valid in an unquoted schema identifier.  Substituting ``_`` alone would
    map ``p-1`` and ``p_1`` onto one schema, so any name that is not already
    identifier-safe carries a digest of the original.
    """
    safe = re.sub(r"[^a-z0-9_]", "_", profile.lower())
    if safe != profile or not safe or safe[0].isdigit():
        safe = f"{safe}_{_short_hash(profile)}"
    return safe


def profile_schema_slug(profile: str) -> str:
    """Return the schema slug a *named* profile resolves to.

    The default profile keeps its own name (its schemas are the unsuffixed
    historical ones), every other name is made identifier-safe.
    """
    if profile == _DEFAULT_PROFILE:
        return _DEFAULT_PROFILE
    return _profile_slug(profile)


def active_profile_slug() -> str:
    """Return the schema slug for the profile this call is running under.

    Resolution goes through :func:`hermes_cli.profiles.get_active_profile_name`,
    which reads ``HERMES_HOME`` — including the context-local override a
    multiplexed gateway sets per turn — so callers need no changes.

    A ``HERMES_HOME`` that is neither the default home nor a known profile
    directory resolves to ``"custom"`` there, which is *not* unique: two
    unrelated homes would collide on one schema.  Those are disambiguated by
    a digest of the resolved path.
    """
    from hermes_cli.profiles import get_active_profile_name

    name = get_active_profile_name()
    if name == _DEFAULT_PROFILE:
        return _DEFAULT_PROFILE
    if name == "custom":
        return f"custom_{_short_hash(str(get_hermes_home().resolve()))}"
    return _profile_slug(name)


def app_schema(mode: StoreMode, *, profile: str | None = None) -> str:
    """Return the app schema name for ``mode`` under ``profile``.

    The default profile keeps the historical ``app_dev``/``app_prod`` names
    exactly, so an existing single-profile deployment sees no change and needs
    no migration.  Every other profile gets its own schema.
    """
    base = "app_dev" if mode == "dev" else "app_prod"
    slug = profile if profile is not None else active_profile_slug()
    if slug == _DEFAULT_PROFILE:
        return base
    if profile is not None:
        slug = _profile_slug(slug)
    schema = f"{base}_{slug}"
    if len(schema) > _MAX_IDENTIFIER:
        keep = _MAX_IDENTIFIER - len(base) - 1 - 13
        schema = f"{base}_{slug[:keep]}_{_short_hash(slug)}"
    if not _VALID_SCHEMA.fullmatch(schema):  # pragma: no cover - defensive
        raise ValueError(f"Derived an invalid schema name: {schema!r}")
    return schema


def _config_get(
    config: Mapping[str, object],
    *keys: str,
    default: object,
) -> object:
    node: object = config
    for key in keys:
        if not isinstance(node, dict):
            return default
        for candidate_key, candidate_value in node.items():
            if candidate_key == key:
                node = candidate_value
                break
        else:
            return default
    return node


def resolve_mode(
    requested: StoreMode | str | None = None,
    *,
    source: SessionOrigin | None = None,
    config: Mapping[str, object] | None = None,
) -> StoreMode:
    """Resolve a datastore mode, forcing all channel sessions to production.

    Local CLI and dashboard callers may request ``dev`` explicitly. When no
    request is supplied, ``datastore.mode`` is read from ``config.yaml`` and
    defaults to ``prod``. Any non-local ``SessionSource`` is a channel origin
    and resolves to ``prod`` regardless of the requested or configured mode.
    """
    if source is not None and _platform_name(source) not in {
        "local",
        "api_server",
    }:
        return "prod"

    loaded_config = config if config is not None else load_config_readonly()
    candidate = requested
    if candidate is None:
        candidate = _config_get(
            loaded_config,
            "datastore",
            "mode",
            default="prod",
        )
    if candidate == "dev":
        return "dev"
    if candidate == "prod":
        return "prod"
    raise ValueError(f"Invalid datastore mode: {candidate!r}")


@overload
def get_store(
    kind: Literal["sqlite-core"],
    mode: StoreMode | None = None,
    *,
    source: SessionOrigin | None = None,
    config: Mapping[str, object] | None = None,
) -> SQLiteCoreStore: ...


@overload
def get_store(
    kind: Literal["supabase-app"],
    mode: StoreMode | None = None,
    *,
    source: SessionOrigin | None = None,
    config: Mapping[str, object] | None = None,
) -> SupabaseAppStore: ...


def get_store(
    kind: StoreKind,
    mode: StoreMode | None = None,
    *,
    source: SessionOrigin | None = None,
    config: Mapping[str, object] | None = None,
) -> Datastore:
    """Return the typed datastore target for ``kind`` and resolved ``mode``.

    ``sqlite-core`` resolves to ``state.db`` in production and the disposable
    ``state.dev.db`` in development. ``supabase-app`` resolves to the
    profile-derived ``app_prod``/``app_dev`` schema (see :func:`app_schema`).
    Mode defaults to ``prod`` and channel origins are always forced to
    ``prod``.
    """
    loaded_config = config if config is not None else load_config_readonly()
    resolved_mode = resolve_mode(mode, source=source, config=loaded_config)

    if kind == "sqlite-core":
        filename = "state.dev.db" if resolved_mode == "dev" else "state.db"
        return SQLiteCoreStore(resolved_mode, get_hermes_home() / filename)
    if kind == "supabase-app":
        base_dsn = _config_get(
            loaded_config,
            "datastore",
            "supabase_app",
            "dsn",
            default="",
        )
        dsn = _config_get(
            loaded_config,
            "datastore",
            "overrides",
            resolved_mode,
            "supabase_app",
            "dsn",
            default="",
        )
        if not dsn:
            dsn = base_dsn
        if not isinstance(dsn, str):
            raise ValueError("Supabase app datastore DSN must be a string")
        return SupabaseAppStore(resolved_mode, app_schema(resolved_mode), dsn)
    raise ValueError(f"Unknown datastore kind: {kind!r}")


async def connection_schema(connection: asyncpg.Connection) -> str:
    """Return the schema a connection's unqualified DDL/DML lands in.

    :meth:`SupabaseAppStore.connect` pins ``search_path`` to exactly one
    schema, so this is that schema.
    """
    raw = await connection.fetchval("SELECT current_setting('search_path', true)")
    first = str(raw or "").split(",")[0].strip().strip('"')
    if not _VALID_SCHEMA.fullmatch(first):
        raise ValueError(f"Connection has no single app schema on its search_path: {raw!r}")
    return first


async def ensure_app_schema(
    connection: asyncpg.Connection,
    *,
    schema: str | None = None,
) -> str:
    """Create the app schema this connection writes into, and claim it.

    Unqualified DDL lands in the connection's pinned ``search_path``. For a
    profile whose derived schema does not exist yet, Postgres rejects that DDL
    with "no schema has been selected to create in" — a message that names
    neither the schema nor the profile. Creating the schema at the point of use
    keeps every entry path working, instead of only the ones that happen to run
    :func:`initialize_supabase_app` first.
    """
    target = schema or await connection_schema(connection)
    if not _VALID_SCHEMA.fullmatch(target):
        raise ValueError(f"Invalid Supabase schema name: {target!r}")
    await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {target};")
    await claim_schema_owner(connection, schema=target)
    return target


async def claim_schema_owner(
    connection: asyncpg.Connection,
    *,
    schema: str | None = None,
    force: bool = False,
) -> None:
    """Record which profile owns ``schema``, if it is not already claimed.

    The marker is what makes a schema collision *detectable*.  Without it two
    profiles pointed at one schema look exactly like one profile with two
    connections — every ``CREATE ... IF NOT EXISTS`` succeeds, every insert
    succeeds, and the damage is only visible as another profile's rows
    appearing in a listing.
    """
    target = schema or app_schema("prod")
    if not _VALID_SCHEMA.fullmatch(target):
        raise ValueError(f"Invalid Supabase schema name: {target!r}")
    await connection.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {target}.schema_owner (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            profile_slug TEXT NOT NULL,
            hermes_home TEXT NOT NULL,
            claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    conflict = (
        "DO UPDATE SET profile_slug = EXCLUDED.profile_slug, "
        "hermes_home = EXCLUDED.hermes_home, claimed_at = NOW()"
        if force
        else "DO NOTHING"
    )
    await connection.execute(
        f"""
        INSERT INTO {target}.schema_owner (singleton, profile_slug, hermes_home)
        VALUES (TRUE, $1, $2)
        ON CONFLICT (singleton) {conflict};
        """,
        active_profile_slug(),
        str(get_hermes_home().resolve()),
    )
    _verified_schemas.clear()


async def connect_for_publish(
    store: SupabaseAppStore,
    *,
    profile: str,
) -> asyncpg.Connection:
    """Open a connection into *another* profile's schema, for publishing only.

    Every other datastore path is deliberately unable to do this: profiles are
    isolated, and :func:`verify_schema_owner` fails closed precisely so one
    profile cannot end up writing into another's tables. FG-29's downward
    publish is the one sanctioned crossing — the owner copying the entity goal
    into each profile so a sub-goal can ladder into it — so it gets one
    narrow, explicitly named door rather than a general escape hatch.

    The ownership check is not skipped here, it is *inverted*: instead of
    "this schema must belong to me", the requirement is "this schema must
    belong to the profile I was asked to publish into". A typo in a profile
    name therefore fails with a mismatch instead of silently seeding a fresh
    schema that no profile will ever read.
    """
    target = app_schema(store.mode, profile=profile)
    if not _VALID_SCHEMA.fullmatch(target):
        raise ValueError(f"Invalid Supabase schema name: {target!r}")
    if _dsn_missing(store.dsn):
        raise RuntimeError(
            "Supabase app datastore is not configured; set "
            "datastore.supabase_app.dsn in config.yaml." + _terminal_hint()
        )

    from tools.lazy_deps import ensure

    ensure("datastore.supabase")

    import asyncpg as _asyncpg

    from hermes_cli import db_setup

    connection = await _asyncpg.connect(
        store.dsn,
        server_settings={"search_path": target},
        connection_class=db_setup.connection_class(),
    )
    try:
        await db_setup.bind(connection, target)
        marker = await connection.fetchval(
            "SELECT to_regclass($1)", f"{target}.schema_owner"
        )
        if marker is not None:
            row = await connection.fetchrow(
                f"SELECT profile_slug FROM {target}.schema_owner LIMIT 1"
            )
            expected = _profile_slug(profile) if profile != _DEFAULT_PROFILE else profile
            if row is not None and str(row["profile_slug"]) != expected:
                raise SchemaOwnershipError(
                    f"Schema {target!r} is claimed by profile "
                    f"{row['profile_slug']!r}, not by {profile!r}. Refusing to "
                    f"publish into it: the copy would land where no profile "
                    f"reads it, or on top of another profile's rows."
                )
    except BaseException:
        await connection.close()
        raise
    return connection


async def verify_schema_owner(
    connection: asyncpg.Connection,
    *,
    schema: str,
    dsn: str = "",
) -> None:
    """Fail closed when ``schema`` belongs to a different profile.

    An unclaimed schema (no marker table, or no row) is accepted: it is either
    a pre-FG-27 deployment or a schema about to be initialised, and refusing
    those would brick working installs.  A marker naming a *different* profile
    is never accepted.
    """
    slug = active_profile_slug()
    key = (dsn, schema, slug)
    if key in _verified_schemas:
        return
    if not _VALID_SCHEMA.fullmatch(schema):
        raise ValueError(f"Invalid Supabase schema name: {schema!r}")
    # ``to_regclass`` returns NULL for a missing relation instead of raising,
    # so an unclaimed schema costs one round trip and never aborts a caller's
    # transaction the way a failed SELECT would.
    marker = await connection.fetchval(
        "SELECT to_regclass($1)", f"{schema}.schema_owner"
    )
    if marker is None:
        return
    row = await connection.fetchrow(
        f"SELECT profile_slug, hermes_home FROM {schema}.schema_owner LIMIT 1"
    )
    if row is None:
        return
    owner, owner_home = row["profile_slug"], row["hermes_home"]
    home = str(get_hermes_home().resolve())
    if owner != slug:
        raise SchemaOwnershipError(
            f"Schema {schema!r} is claimed by profile {owner!r} at "
            f"HERMES_HOME {owner_home!r}, but this process is profile "
            f"{slug!r} at {home!r}. Refusing to continue: writing here would "
            f"interleave two profiles' rows in one set of tables, and they "
            f"carry no provenance column to separate them again. "
            f"Check datastore.supabase_app.dsn and HERMES_HOME. If this "
            f"deployment legitimately moved, re-claim the schema with: "
            f"UPDATE {schema}.schema_owner SET profile_slug = '{slug}', "
            f"hermes_home = '{home}';"
        )
    if owner_home != home:
        # Two deployments whose HERMES_HOME sits outside ``~/.hermes`` both
        # resolve to the "default" profile, so the slug cannot tell them
        # apart — but a moved or relocated home is the far likelier cause,
        # and refusing that would brick a working install.  Warn, don't fail.
        logger.warning(
            "Schema %s was claimed from HERMES_HOME %s but this process runs "
            "from %s. Same profile name, different home — harmless if the "
            "deployment moved, data-mixing if these are two deployments "
            "sharing one DSN.",
            schema,
            owner_home,
            home,
        )
    _verified_schemas.add(key)


async def initialize_supabase_app(connection: asyncpg.Connection) -> None:
    """Create this profile's C3 application schemas and contract tables."""
    dev = app_schema("dev")
    prod = app_schema("prod")
    await connection.execute(
        f"""
        CREATE SCHEMA IF NOT EXISTS {dev};
        CREATE SCHEMA IF NOT EXISTS {prod};

        CREATE TABLE IF NOT EXISTS {dev}.artifact_definitions (
            kind TEXT NOT NULL,
            ref TEXT NOT NULL,
            definition JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (kind, ref)
        );

        CREATE TABLE IF NOT EXISTS {prod}.artifact_definitions (
            kind TEXT NOT NULL,
            ref TEXT NOT NULL,
            definition JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (kind, ref)
        );

        CREATE TABLE IF NOT EXISTS {prod}.approvals (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_ref TEXT NOT NULL,
            actor TEXT NOT NULL,
            decision TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS {prod}.changes (
            id TEXT PRIMARY KEY,
            trace_id TEXT,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            actor TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('dev', 'prod')),
            target_kind TEXT NOT NULL,
            CHECK (target_kind IN ('data', 'config', 'code')),
            op JSONB NOT NULL,
            inverse_op JSONB,
            reversible BOOLEAN NOT NULL,
            approval_ref TEXT NOT NULL REFERENCES {prod}.approvals(id),
            backup_ref TEXT
        );
        ALTER TABLE {prod}.changes
            ADD COLUMN IF NOT EXISTS trace_id TEXT;
        CREATE INDEX IF NOT EXISTS changes_trace_id_idx
            ON {prod}.changes (trace_id);
        CREATE INDEX IF NOT EXISTS changes_ts_idx
            ON {prod}.changes (ts DESC);

        CREATE TABLE IF NOT EXISTS {prod}.promotions (
            id TEXT PRIMARY KEY,
            artifact_kind TEXT NOT NULL,
            artifact_ref TEXT NOT NULL,
            from_mode TEXT NOT NULL CHECK (from_mode = 'dev'),
            to_mode TEXT NOT NULL CHECK (to_mode = 'prod'),
            approval_ref TEXT NOT NULL REFERENCES {prod}.approvals(id),
            change_ref TEXT NOT NULL REFERENCES {prod}.changes(id),
            actor TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    await claim_schema_owner(connection, schema=dev)
    await claim_schema_owner(connection, schema=prod)

    from hermes_cli.interactions import initialize_interactions

    await initialize_interactions(connection)
