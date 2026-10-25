"""Mode-aware, scope-aware tool registry + dev→prod promotion (FG-07).

This is the registry FG-08 (OSS copy + in-house build path) and the dashboard
build on. A **tool** is a user/agent-created capability — primarily an
*in-house system* (decision D3): a new Next.js app running in its **own Node
process**, exposing BOTH a **web UI** (for humans) and a **thin MCP server**
(for the agent). Tools also cover ``remote`` (a cloned OSS system fronted by
MCP) and ``builtin`` (a wrapper row over a shipped capability).

The registry consumes the already-merged Wave-0 contracts — it never
re-implements them:

* **C3 datastore routing.** Every connection is obtained through the injected
  :class:`hermes_cli.datastore.SupabaseAppStore`, whose ``mode`` selects the
  ``app_dev`` / ``app_prod`` schema. Because the ``tools`` table lives *inside*
  the mode's schema, a tool authored in ``dev`` is only visible/runnable from a
  dev session; a channel-forced ``prod`` session (C3 forces channels to prod)
  never sees it. The row also carries an explicit ``mode`` column so a
  materialized record is self-describing.
* **C2 visibility scoping.** Every row carries ``owner_user_id`` +
  ``visibility`` (``shared`` or ``private:<user_id>``). Reads are filtered by
  :func:`hermes_cli.access.scope_filter`; Postgres row-level security
  (:func:`hermes_cli.access.apply_scope_rls`) is the database-level backstop.
  The owner role bypasses scoping and sees/manages every tool.
* **C1 principals.** Creation and management happen *as* a
  :class:`hermes_cli.access.Principal`; a ``viewer`` may not author or mutate a
  tool, and a non-owner may only mutate its own tools.
* **C5 change-log + C6 approval.** Authoring/enable/disable/configure are
  routine dev operations recorded (provenance) by the caller through the FG-12
  :class:`hermes_cli.changes.ChangeLog`; the **risky** dev→prod promotion is
  explicitly approval-gated (contract C6) and records an ``approvals`` +
  ``changes`` + ``promotions`` row into the shared C3 audit tables — the same
  tables :func:`hermes_cli.promote.promote_artifact` and the owner-transfer
  flow write, not a parallel log.

**Cache-safety (AGENTS.md).** Nothing here mutates a live conversation's
system prompt or toolset. A tool's MCP interface is materialized into the FG-11
``mcp_endpoints`` registry, which is only ever resolved for a *future* session
— never spliced into a running conversation's cached prompt/tool schema. Config
lives in ``config.yaml`` / the row's ``config_json``, never in a new
``HERMES_*`` env var (secrets only), which :func:`validate_tool_config`
enforces.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, List, Literal, Mapping, Optional, Sequence
from urllib.parse import urlparse

from hermes_cli.access import (
    SHARED,
    Principal,
    apply_scope_rls,
    normalize_visibility,
    scope_filter,
)

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore


#: Registry table (RLS applied). Lives in the store's mode schema (C3).
TOOLS_TABLE = "tools"

ToolKind = Literal["in_house", "remote", "builtin", "external"]
_TOOL_KINDS: tuple[ToolKind, ...] = ("in_house", "remote", "builtin", "external")

#: Where a vibe-coded app runs (FG-33): ``local`` = on this box (a D3
#: ``in_house`` tool), ``external`` = on a hosting provider (``kind='external'``).
#: ``NULL`` for legacy tools.
ToolHosting = Literal["local", "external"]
_TOOL_HOSTINGS: tuple[ToolHosting, ...] = ("local", "external")

ToolBuildState = Literal["draft", "building", "ready", "failed"]
_TOOL_BUILD_STATES: tuple[ToolBuildState, ...] = (
    "draft", "building", "ready", "failed",
)

ToolIconSource = Literal["generated", "uploaded", "favicon"]
_TOOL_ICON_SOURCES: tuple[ToolIconSource, ...] = ("generated", "uploaded", "favicon")

ToolStatus = Literal["enabled", "disabled"]
_TOOL_STATUSES: tuple[ToolStatus, ...] = ("enabled", "disabled")

#: Default stack for an in-house tool (decision D3).
DEFAULT_IN_HOUSE_STACK = "nextjs-node"

_VALID_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: Tool names that sibling ``/api/tools/<x>`` routes (and FG-33 app routes)
#: would shadow. Compared case-insensitively because the slug becomes a
#: hostname.
RESERVED_TOOL_NAMES: frozenset[str] = frozenset({
    "mcp", "personal-mcp", "toolsets", "changes", "computer-use",
    "apps", "health", "quota",
})

_VALID_SECRET_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_VALID_RELEASE_SHA = re.compile(r"^[0-9a-f]{7,64}$")

# Behavioural config must never be smuggled in as an env var. ``.env`` is for
# secrets only (AGENTS.md); a ``HERMES_*`` key in a tool's config_json is a
# non-secret env var by another name and is rejected.
_ENV_VAR_KEY = re.compile(r"^HERMES_[A-Za-z0-9_]+$", re.IGNORECASE)


class ToolConfigError(ValueError):
    """A tool's ``config_json`` violates the config-vs-env-var contract."""


def validate_tool_config(config: object) -> dict:
    """Validate a tool ``config_json`` mapping and return a normalized copy.

    Enforces the AGENTS.md rule that behavioural config lives in
    ``config.yaml`` / ``config_json`` and **never** in a new ``HERMES_*`` env
    var (``.env`` is secrets only). Any key shaped like a ``HERMES_*`` env var —
    at any nesting depth — is rejected. A non-mapping config, or a mapping with
    non-string keys, is also rejected so a malformed row never reaches the store.
    """
    if config is None:
        return {}
    if not isinstance(config, Mapping):
        raise ToolConfigError("Tool config_json must be a JSON object")
    _reject_env_var_keys(config, path="config")
    # Round-trip through JSON so the stored value is plain, ordered data.
    return json.loads(json.dumps(config))


def _reject_env_var_keys(node: object, *, path: str) -> None:
    if isinstance(node, Mapping):
        for key, value in node.items():
            if not isinstance(key, str):
                raise ToolConfigError(f"config key at {path} must be a string")
            if _ENV_VAR_KEY.fullmatch(key):
                raise ToolConfigError(
                    f"config key {key!r} at {path} looks like a HERMES_* env "
                    "var; behavioural config belongs in config.yaml/config_json, "
                    "not a new env var (.env is for secrets only)"
                )
            _reject_env_var_keys(value, path=f"{path}.{key}")
    elif isinstance(node, (list, tuple)):
        for index, item in enumerate(node):
            _reject_env_var_keys(item, path=f"{path}[{index}]")


def _validate_tool_name(name: str) -> None:
    if not _VALID_NAME.fullmatch(name or ""):
        raise ValueError(f"Invalid tool name: {name!r}")
    if name.lower() in RESERVED_TOOL_NAMES:
        raise ValueError(
            f"Tool name {name!r} is reserved (a sibling /api/tools route "
            "would shadow it)"
        )


def _check(value: Optional[str], allowed: tuple[str, ...], field: str) -> None:
    if value is not None and value not in allowed:
        raise ValueError(f"Invalid tool {field}: {value!r}")


def _validate_https_url(value: Optional[str], field: str) -> None:
    if value is None:
        return
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError(f"Tool {field} must be an https:// URL: {value!r}")


def _validate_app_fields(
    principal: Principal,
    kind: str,
    fields: Mapping[str, Any],
) -> dict[str, Any]:
    """Validate the FG-33 app columns passed to :meth:`ToolRegistry.create`.

    Returns a normalized copy. ``kind='external'`` implies (and defaults to)
    ``hosting='external'``; ``hosting='external'`` requires that kind. The
    owner-only runtime knobs (``always_on``, ``limits_json``) are refused for
    any other principal.
    """
    out = dict(fields)
    hosting = out.get("hosting")
    if kind == "external" and hosting is None:
        hosting = out["hosting"] = "external"
    _check(hosting, _TOOL_HOSTINGS, "hosting")
    if (kind == "external") != (hosting == "external") and hosting is not None:
        raise ValueError(
            f"Tool kind {kind!r} does not match hosting {hosting!r}: "
            "provider-hosted apps are kind 'external', local apps stay 'in_house'"
        )
    _check(out.get("build_state"), _TOOL_BUILD_STATES, "build_state")
    _check(out.get("icon_source"), _TOOL_ICON_SOURCES, "icon_source")
    _validate_https_url(out.get("public_url"), "public_url")
    _validate_https_url(out.get("dashboard_url"), "dashboard_url")
    sha = out.get("release_sha")
    if sha is not None and not _VALID_RELEASE_SHA.fullmatch(sha):
        raise ValueError(f"Invalid tool release_sha: {sha!r}")
    profile = out.get("coder_profile")
    if profile is not None:
        from hermes_cli.profiles import validate_profile_name

        validate_profile_name(profile)
    names = out.get("secret_names")
    if names is not None:
        if isinstance(names, str) or not all(
            isinstance(n, str) and _VALID_SECRET_NAME.fullmatch(n) for n in names
        ):
            raise ValueError("Tool secret_names must be a list of secret names")
        out["secret_names"] = list(dict.fromkeys(names))
    if out.get("limits_json") is not None:
        out["limits_json"] = validate_tool_config(out["limits_json"])
    owner_only = [k for k in ("always_on", "limits_json") if out.get(k) is not None]
    if owner_only and not principal.is_owner:
        raise PermissionError(
            f"only the owner may set {', '.join(owner_only)} on a tool"
        )
    return out


def _tools_schema_sql(table: str = TOOLS_TABLE) -> str:
    """DDL creating the ``tools`` registry table (idempotent).

    ``table`` may be schema-qualified (``app_dev.tools``) so the promotion path
    can materialize both the source and target tables regardless of the
    connection's ``search_path``. The visibility index is created unqualified,
    so Postgres places it in the same schema as ``table``.
    """
    index = table.split(".")[-1] + "_visibility_idx"
    return f"""
CREATE TABLE IF NOT EXISTS {table} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('in_house', 'remote', 'builtin', 'external')),
    stack TEXT NOT NULL DEFAULT '',
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('dev', 'prod')),
    status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('enabled', 'disabled')),
    mcp_endpoint_ref TEXT,
    web_url TEXT,
    config_json JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS {index} ON {table} (visibility);
ALTER TABLE {table}
    ADD COLUMN IF NOT EXISTS hosting TEXT
        CHECK (hosting IN ('local', 'external')),
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS icon TEXT,
    ADD COLUMN IF NOT EXISTS icon_color TEXT,
    ADD COLUMN IF NOT EXISTS icon_asset_id TEXT,
    ADD COLUMN IF NOT EXISTS icon_source TEXT
        CHECK (icon_source IN ('generated', 'uploaded', 'favicon')),
    ADD COLUMN IF NOT EXISTS public_url TEXT,
    ADD COLUMN IF NOT EXISTS dashboard_url TEXT,
    ADD COLUMN IF NOT EXISTS repo_path TEXT,
    ADD COLUMN IF NOT EXISTS release_sha TEXT,
    ADD COLUMN IF NOT EXISTS project_slug TEXT,
    ADD COLUMN IF NOT EXISTS build_state TEXT
        CHECK (build_state IN ('draft', 'building', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS always_on BOOLEAN,
    ADD COLUMN IF NOT EXISTS limits_json JSONB,
    ADD COLUMN IF NOT EXISTS secret_names TEXT[],
    ADD COLUMN IF NOT EXISTS coder_profile TEXT;
DO $$
DECLARE con record;
BEGIN
    FOR con IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = '{table}'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%(kind = ANY%'
          AND pg_get_constraintdef(oid) NOT LIKE '%''external''%'
    LOOP
        EXECUTE format('ALTER TABLE {table} DROP CONSTRAINT %I', con.conname);
        EXECUTE 'ALTER TABLE {table} ADD CONSTRAINT ' || quote_ident(con.conname)
            || ' CHECK (kind IN (''in_house'', ''remote'', ''builtin'', ''external''))';
    END LOOP;
END $$;
"""

#: FG-33 app columns (all nullable, additive). ``create`` keeps a stored value
#: when the caller passes ``None``.
_APP_COLUMN_NAMES: tuple[str, ...] = (
    "hosting", "display_name", "description", "icon", "icon_color",
    "icon_asset_id", "icon_source", "public_url", "dashboard_url", "repo_path",
    "release_sha", "project_slug", "build_state", "always_on", "limits_json",
    "secret_names", "coder_profile",
)

_COLUMN_NAMES: tuple[str, ...] = (
    "id", "name", "kind", "stack", "owner_user_id", "visibility", "mode",
    "status", "mcp_endpoint_ref", "web_url", "config_json",
) + _APP_COLUMN_NAMES

_COLUMNS = ", ".join(_COLUMN_NAMES)

#: Columns ``promote_tool`` does NOT copy from dev: prod mints its own id,
#: tags the row ``prod`` and always lands it ``disabled``.
_PROMOTE_EXEMPT: frozenset[str] = frozenset({"id", "mode", "status"})
_PROMOTED_COLUMNS: tuple[str, ...] = tuple(
    c for c in _COLUMN_NAMES if c not in _PROMOTE_EXEMPT
)


@dataclass(frozen=True)
class Tool:
    """One registered tool, scoped + mode-tagged."""

    id: str
    name: str
    kind: ToolKind
    stack: str
    owner_user_id: str
    visibility: str
    mode: str
    status: ToolStatus
    mcp_endpoint_ref: Optional[str]
    web_url: Optional[str]
    config_json: dict
    hosting: Optional[ToolHosting] = None
    display_name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    icon_color: Optional[str] = None
    icon_asset_id: Optional[str] = None
    icon_source: Optional[ToolIconSource] = None
    public_url: Optional[str] = None
    dashboard_url: Optional[str] = None
    repo_path: Optional[str] = None
    release_sha: Optional[str] = None
    project_slug: Optional[str] = None
    build_state: Optional[ToolBuildState] = None
    always_on: Optional[bool] = None
    limits_json: Optional[dict] = None
    secret_names: Optional[tuple[str, ...]] = None
    coder_profile: Optional[str] = None

    @property
    def enabled(self) -> bool:
        return self.status == "enabled"

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "stack": self.stack,
            "owner_user_id": self.owner_user_id,
            "visibility": self.visibility,
            "mode": self.mode,
            "status": self.status,
            "enabled": self.enabled,
            "mcp_endpoint_ref": self.mcp_endpoint_ref,
            "web_url": self.web_url,
            "config_json": dict(self.config_json),
            **{name: getattr(self, name) for name in _APP_COLUMN_NAMES},
            "limits_json": (
                dict(self.limits_json) if self.limits_json is not None else None
            ),
            "secret_names": (
                list(self.secret_names) if self.secret_names is not None else None
            ),
        }


def _row_to_tool(row: "asyncpg.Record") -> Tool:
    config = row["config_json"]
    if isinstance(config, str):
        config = json.loads(config)
    limits = row["limits_json"]
    if isinstance(limits, str):
        limits = json.loads(limits)
    secret_names = row["secret_names"]
    return Tool(
        id=str(row["id"]),
        name=str(row["name"]),
        kind=str(row["kind"]),  # type: ignore[arg-type]
        stack=str(row["stack"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        mode=str(row["mode"]),
        status=str(row["status"]),  # type: ignore[arg-type]
        mcp_endpoint_ref=row["mcp_endpoint_ref"],
        web_url=row["web_url"],
        config_json=dict(config or {}),
        hosting=row["hosting"],
        display_name=row["display_name"],
        description=row["description"],
        icon=row["icon"],
        icon_color=row["icon_color"],
        icon_asset_id=row["icon_asset_id"],
        icon_source=row["icon_source"],
        public_url=row["public_url"],
        dashboard_url=row["dashboard_url"],
        repo_path=row["repo_path"],
        release_sha=row["release_sha"],
        project_slug=row["project_slug"],
        build_state=row["build_state"],
        always_on=row["always_on"],
        limits_json=dict(limits) if limits is not None else None,
        secret_names=tuple(secret_names) if secret_names is not None else None,
        coder_profile=row["coder_profile"],
    )


def _resolve_visibility(principal: Principal, visibility: Optional[str]) -> str:
    """Map a requested visibility intent onto a concrete C2 tag.

    ``None`` / ``"private"`` becomes the caller's own ``private:<user_id>`` — a
    principal can only author a tool private to *itself*. ``"shared"`` or a
    fully-qualified ``private:<u>`` is validated and passed through, but a
    non-owner may not create/manage a row private to *another* user.
    """
    if visibility is None or visibility == "private":
        return principal.private_visibility
    resolved = normalize_visibility(visibility)
    if resolved != SHARED and not principal.is_owner:
        if resolved != principal.private_visibility:
            raise PermissionError(
                "A non-owner may only manage 'shared' or its own 'private' tools"
            )
    return resolved


def _assert_can_write(principal: Principal, tool: Tool) -> None:
    """A non-owner principal may only mutate a tool it owns (C2)."""
    if principal.is_owner:
        return
    if tool.owner_user_id != principal.user_id:
        raise PermissionError(
            f"{principal.user_id} may not manage tool {tool.name!r}"
        )


class ToolRegistry:
    """Async CRUD over the C2-scoped, C3-routed ``tools`` table.

    The registry never opens a raw connection — it always routes through the
    injected contract-C3 :class:`SupabaseAppStore`, whose ``mode`` selects the
    ``app_dev`` / ``app_prod`` schema (and therefore which tools exist).
    """

    def __init__(self, store: "SupabaseAppStore") -> None:
        self._store = store

    @property
    def mode(self) -> str:
        return self._store.mode

    @property
    def store(self) -> "SupabaseAppStore":
        """The injected contract-C3 store (same mode as this registry)."""
        return self._store

    async def _connect(self) -> "asyncpg.Connection":
        connection = await self._store.connect()
        await connection.execute(
            f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"'
        )
        return connection

    async def initialize(
        self,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Create the registry table + its RLS policy. Idempotent."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(_tools_schema_sql())
            await apply_scope_rls(conn, TOOLS_TABLE)
        finally:
            if own:
                await conn.close()

    async def create(
        self,
        principal: Principal,
        name: str,
        kind: ToolKind,
        *,
        stack: str = "",
        config: Optional[Mapping[str, object]] = None,
        visibility: Optional[str] = None,
        status: ToolStatus = "disabled",
        mcp_endpoint_ref: Optional[str] = None,
        web_url: Optional[str] = None,
        hosting: Optional[ToolHosting] = None,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        icon_color: Optional[str] = None,
        icon_asset_id: Optional[str] = None,
        icon_source: Optional[ToolIconSource] = None,
        public_url: Optional[str] = None,
        dashboard_url: Optional[str] = None,
        repo_path: Optional[str] = None,
        release_sha: Optional[str] = None,
        project_slug: Optional[str] = None,
        build_state: Optional[ToolBuildState] = None,
        always_on: Optional[bool] = None,
        limits_json: Optional[Mapping[str, object]] = None,
        secret_names: Optional[Sequence[str]] = None,
        coder_profile: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tool:
        """Create (or update-in-place) a tool as ``principal``.

        A ``viewer`` may not author tools. The tool's ``mode`` is the store's
        mode, so it lands in the matching schema and only sessions of that mode
        resolve it. ``config`` is validated against the no-``HERMES_*`` contract.
        Reserved names (:data:`RESERVED_TOOL_NAMES`) are refused. On an update
        in place, an FG-33 app field passed as ``None`` keeps its stored value.
        """
        if principal.role == "viewer":
            raise PermissionError("viewer principals may not create tools")
        _validate_tool_name(name)
        if kind not in _TOOL_KINDS:
            raise ValueError(f"Invalid tool kind: {kind!r}")
        if status not in _TOOL_STATUSES:
            raise ValueError(f"Invalid tool status: {status!r}")
        normalized_config = validate_tool_config(config)
        resolved_visibility = _resolve_visibility(principal, visibility)
        if not stack and kind in ("in_house", "external"):
            stack = DEFAULT_IN_HOUSE_STACK
        app = _validate_app_fields(principal, kind, {
            "hosting": hosting, "display_name": display_name,
            "description": description, "icon": icon, "icon_color": icon_color,
            "icon_asset_id": icon_asset_id, "icon_source": icon_source,
            "public_url": public_url, "dashboard_url": dashboard_url,
            "repo_path": repo_path, "release_sha": release_sha,
            "project_slug": project_slug, "build_state": build_state,
            "always_on": always_on, "limits_json": limits_json,
            "secret_names": secret_names, "coder_profile": coder_profile,
        })
        if app["limits_json"] is not None:
            app["limits_json"] = json.dumps(app["limits_json"], sort_keys=True)
        app_values = [app[c] for c in _APP_COLUMN_NAMES]
        app_casts = {"limits_json": "::jsonb", "secret_names": "::text[]"}
        app_params = ", ".join(
            f"${12 + i}{app_casts.get(c, '')}"
            for i, c in enumerate(_APP_COLUMN_NAMES)
        )
        app_updates = "".join(
            f",\n                    {c} = COALESCE(EXCLUDED.{c}, {TOOLS_TABLE}.{c})"
            for c in _APP_COLUMN_NAMES
        )

        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                INSERT INTO {TOOLS_TABLE} ({_COLUMNS})
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                        {app_params})
                ON CONFLICT (name) DO UPDATE SET
                    kind = EXCLUDED.kind,
                    stack = EXCLUDED.stack,
                    visibility = EXCLUDED.visibility,
                    status = EXCLUDED.status,
                    mcp_endpoint_ref = EXCLUDED.mcp_endpoint_ref,
                    web_url = EXCLUDED.web_url,
                    config_json = EXCLUDED.config_json{app_updates},
                    updated_at = NOW()
                WHERE {TOOLS_TABLE}.owner_user_id = EXCLUDED.owner_user_id
                RETURNING {_COLUMNS}
                """,
                f"tol_{uuid.uuid4().hex}",
                name,
                kind,
                stack,
                principal.user_id,
                resolved_visibility,
                self._store.mode,
                status,
                mcp_endpoint_ref,
                web_url,
                json.dumps(normalized_config, sort_keys=True),
                *app_values,
            )
            if row is None:
                # The name exists but is owned by someone else — the conflict
                # UPDATE's WHERE filtered it out. Do not leak the other owner.
                raise PermissionError(
                    f"Tool {name!r} is owned by another principal"
                )
            return _row_to_tool(row)
        finally:
            if own:
                await conn.close()

    async def get(
        self,
        name: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[Tool]:
        """Return the tool named ``name`` in this mode, else ``None``.

        Unscoped lookup by unique name; callers honouring C2 should read via
        :meth:`list_for_principal` or check visibility before mutating.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"SELECT {_COLUMNS} FROM {TOOLS_TABLE} WHERE name = $1",
                name,
            )
            return _row_to_tool(row) if row is not None else None
        finally:
            if own:
                await conn.close()

    async def get_for_principal(
        self,
        principal: Principal,
        name: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[Tool]:
        """Return a named tool only when ``principal`` may read it (C2)."""
        predicate = scope_filter(principal, start_index=2)
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                SELECT {_COLUMNS} FROM {TOOLS_TABLE}
                WHERE name = $1 AND {predicate.sql}
                """,
                name,
                *predicate.params,
            )
            return _row_to_tool(row) if row is not None else None
        finally:
            if own:
                await conn.close()

    async def list_for_principal(
        self,
        principal: Principal,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Tool]:
        """Return every tool ``principal`` may see (contract C2).

        A non-owner sees ``shared`` tools plus its own ``private`` ones; the
        owner sees all. The result is already mode-scoped by the store's schema.
        """
        predicate = scope_filter(principal, start_index=1)
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT {_COLUMNS} FROM {TOOLS_TABLE}
                WHERE {predicate.sql}
                ORDER BY name
                """,
                *predicate.params,
            )
            return [_row_to_tool(row) for row in rows]
        finally:
            if own:
                await conn.close()

    async def _load_writable(
        self,
        conn: "asyncpg.Connection",
        principal: Principal,
        name: str,
    ) -> Tool:
        row = await conn.fetchrow(
            f"SELECT {_COLUMNS} FROM {TOOLS_TABLE} WHERE name = $1",
            name,
        )
        if row is None:
            raise KeyError(f"No such tool: {name}")
        tool = _row_to_tool(row)
        _assert_can_write(principal, tool)
        return tool

    async def set_enabled(
        self,
        principal: Principal,
        name: str,
        enabled: bool,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tool:
        """Enable or disable a tool the principal owns (or owner-role bypass)."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self._load_writable(conn, principal, name)
            status: ToolStatus = "enabled" if enabled else "disabled"
            row = await conn.fetchrow(
                f"""
                UPDATE {TOOLS_TABLE}
                SET status = $2, updated_at = NOW()
                WHERE name = $1
                RETURNING {_COLUMNS}
                """,
                name,
                status,
            )
            return _row_to_tool(row)
        finally:
            if own:
                await conn.close()

    async def set_config(
        self,
        principal: Principal,
        name: str,
        config: Mapping[str, object],
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tool:
        """Replace a tool's ``config_json`` (validated) for the owner principal."""
        normalized_config = validate_tool_config(config)
        own = connection is None
        conn = connection or await self._connect()
        try:
            await self._load_writable(conn, principal, name)
            row = await conn.fetchrow(
                f"""
                UPDATE {TOOLS_TABLE}
                SET config_json = $2::jsonb, updated_at = NOW()
                WHERE name = $1
                RETURNING {_COLUMNS}
                """,
                name,
                json.dumps(normalized_config, sort_keys=True),
            )
            return _row_to_tool(row)
        finally:
            if own:
                await conn.close()

    async def delete(
        self,
        principal: Principal,
        name: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tool:
        """Delete a tool the principal owns (or owner-role bypass)."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            tool = await self._load_writable(conn, principal, name)
            await conn.execute(
                f"DELETE FROM {TOOLS_TABLE} WHERE name = $1", name
            )
            return tool
        finally:
            if own:
                await conn.close()


# ---------------------------------------------------------------------------
# Approval-gated dev→prod promotion (contracts C5 + C6)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ToolPromotionResult:
    """References emitted by one successful tool promotion (dev→prod)."""

    promotion_ref: str
    approval_ref: str
    change_ref: str
    tool_name: str


def _new_ref(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _request_promotion_approval(
    name: str,
    *,
    approval_callback: Any = None,
) -> bool:
    from tools.approval import prompt_dangerous_approval

    choice = prompt_dangerous_approval(
        f"hermes tool promote {name}",
        "promote a tool from dev to prod",
        allow_permanent=False,
        approval_callback=approval_callback,
    )
    return choice in ("once", "session", "always")


async def promote_tool(
    prod_store: "SupabaseAppStore",
    name: str,
    *,
    actor: str,
    approved: bool = False,
    approval_callback: Any = None,
) -> ToolPromotionResult:
    """Promote one tool definition from ``app_dev`` to ``app_prod`` (C6-gated).

    Reads the dev tool row, requests explicit operator approval (contract C6,
    via ``tools.approval.prompt_dangerous_approval``), then — in one
    transaction — upserts the tool into ``app_prod.tools`` and records an
    ``approvals`` + ``changes`` (target_kind ``code``) + ``promotions`` row into
    the shared C3 audit tables. No application data is copied; only the tool's
    definition/config crosses the boundary. The promoted tool lands
    ``disabled`` so an operator explicitly enables it in prod.
    """
    from hermes_cli.changes import initialize_changes
    from hermes_cli.datastore import app_schema

    _validate_tool_name(name)
    if prod_store.mode != "prod":
        raise ValueError("Tool promotion requires a prod Supabase app store")

    connection = await prod_store.connect()
    try:
        # initialize_changes runs initialize_supabase_app (C3 base tables) then
        # idempotently adds the FG-12 change columns (actor_user_id/visibility).
        await initialize_changes(connection)
        # Materialize both the source (dev) and target (prod) registry tables
        # regardless of the connection's search_path, so promotion works even
        # if dev authoring hasn't run against this exact connection.
        dev, prod = app_schema("dev"), app_schema("prod")
        await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {dev}")
        await connection.execute(f"CREATE SCHEMA IF NOT EXISTS {prod}")
        await connection.execute(_tools_schema_sql(f"{dev}.{TOOLS_TABLE}"))
        await connection.execute(_tools_schema_sql(f"{prod}.{TOOLS_TABLE}"))

        source = await connection.fetchrow(
            f"""
            SELECT {_COLUMNS} FROM {dev}.{TOOLS_TABLE} WHERE name = $1
            """,
            name,
        )
        if source is None:
            raise KeyError(f"Dev tool not found: {name}")
        tool = _row_to_tool(source)
        # Every column except _PROMOTE_EXEMPT is copied verbatim from the dev
        # row, so a new column cannot silently drop on promotion.
        promoted_values = [source[c] for c in _PROMOTED_COLUMNS]
        insert_columns = ", ".join(("id", "mode", "status") + _PROMOTED_COLUMNS)
        insert_params = ", ".join(
            f"${i + 2}" for i in range(len(_PROMOTED_COLUMNS))
        )
        # The prod row's owner is kept on re-promotion (as before FG-33).
        update_set = ",\n                    ".join(
            f"{c} = EXCLUDED.{c}"
            for c in _PROMOTED_COLUMNS
            if c not in ("name", "owner_user_id")
        )

        if not approved and not _request_promotion_approval(
            name, approval_callback=approval_callback
        ):
            raise PermissionError("Promotion approval was denied")

        approval_ref = _new_ref("apr")
        change_ref = _new_ref("chg")
        promotion_ref = _new_ref("prm")

        async with connection.transaction():
            existing = await connection.fetchrow(
                f"""
                SELECT {_COLUMNS} FROM {prod}.{TOOLS_TABLE} WHERE name = $1
                """,
                name,
            )
            operation = "replace" if existing is not None else "add"
            if existing is None:
                inverse_op: dict[str, object] = {
                    "op": "remove",
                    "path": f"/tools/{name}",
                }
            else:
                inverse_op = {
                    "op": "replace",
                    "path": f"/tools/{name}",
                    "value": _row_to_tool(existing).as_dict(),
                }
            forward_op = [
                {
                    "op": operation,
                    "path": f"/tools/{name}",
                    "value": tool.as_dict(),
                }
            ]
            await connection.execute(
                f"""
                INSERT INTO {prod}.approvals
                    (id, action, target_ref, actor, decision)
                VALUES ($1, 'tool.promote', $2, $3, 'approved')
                """,
                approval_ref,
                f"tool:{name}",
                actor,
            )
            await connection.execute(
                f"""
                INSERT INTO {prod}.{TOOLS_TABLE} ({insert_columns})
                VALUES ($1, 'prod', 'disabled', {insert_params})
                ON CONFLICT (name) DO UPDATE SET
                    {update_set},
                    updated_at = NOW()
                """,
                f"tol_{uuid.uuid4().hex}",
                *promoted_values,
            )
            await connection.execute(
                f"""
                INSERT INTO {prod}.changes
                    (id, actor, actor_user_id, mode, target_kind, op,
                     inverse_op, reversible, approval_ref, backup_ref,
                     visibility)
                VALUES ($1, $2, $3, 'prod', 'code', $4::jsonb, $5::jsonb, TRUE,
                        $6, NULL, $7)
                """,
                change_ref,
                actor,
                actor,
                json.dumps(forward_op, sort_keys=True),
                json.dumps([inverse_op], sort_keys=True),
                approval_ref,
                tool.visibility,
            )
            await connection.execute(
                f"""
                INSERT INTO {prod}.promotions
                    (id, artifact_kind, artifact_ref, from_mode, to_mode,
                     approval_ref, change_ref, actor)
                VALUES ($1, 'tool', $2, 'dev', 'prod', $3, $4, $5)
                """,
                promotion_ref,
                name,
                approval_ref,
                change_ref,
                actor,
            )
    finally:
        await connection.close()

    return ToolPromotionResult(
        promotion_ref=promotion_ref,
        approval_ref=approval_ref,
        change_ref=change_ref,
        tool_name=name,
    )


__all__ = [
    "TOOLS_TABLE",
    "DEFAULT_IN_HOUSE_STACK",
    "RESERVED_TOOL_NAMES",
    "ToolKind",
    "ToolHosting",
    "ToolBuildState",
    "ToolIconSource",
    "ToolStatus",
    "Tool",
    "ToolConfigError",
    "ToolRegistry",
    "ToolPromotionResult",
    "promote_tool",
    "validate_tool_config",
]
