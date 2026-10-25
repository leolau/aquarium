"""Runtime tables for FG-33 local apps: ``app_databases``, ``app_deployments``, ``tool_runtime``.

They live in each mode schema next to ``tools`` (C3), so ``app_dev`` holds the
dev rows of dev tools and ``app_prod`` the prod rows of prod tools. None of
them holds a secret: DSNs and tokens stay with the root helpers in
``/etc/aquarium/apps/``.

The tables have no ``owner_user_id``/``visibility`` of their own. Every caller
first resolves the tool through :class:`~hermes_cli.tools_registry.ToolRegistry`
for the principal (C2), then reads or writes these rows by ``tool_id``.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

DB_STATUSES = ("provisioning", "ready", "suspended", "dropped", "failed")
HEALTH_STATES = ("ok", "degraded", "down", "unknown")
LIFECYCLE_STATES = ("active", "idle", "stopped", "archived", "purged")
RUNTIME_STATES = (
    "stopped", "building", "starting", "running", "failed", "idle_stopped", "over_quota",
)

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS app_databases (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE RESTRICT,
    mode TEXT NOT NULL CHECK (mode IN ('dev', 'prod')),
    cluster TEXT NOT NULL DEFAULT 'apps',
    db_name TEXT NOT NULL UNIQUE,
    features JSONB NOT NULL DEFAULT '["postgres"]'::jsonb,
    api_base_url TEXT,
    status TEXT NOT NULL CHECK (status IN
        ('provisioning', 'ready', 'suspended', 'dropped', 'failed')),
    quota_mb INTEGER,
    last_size_mb INTEGER,
    last_backup_ref TEXT,
    applied_migrations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    dropped_at TIMESTAMPTZ,
    UNIQUE (tool_id, mode)
);
ALTER TABLE app_databases ADD COLUMN IF NOT EXISTS archive_ref TEXT;
ALTER TABLE app_databases ADD COLUMN IF NOT EXISTS archive_bytes BIGINT;
ALTER TABLE app_databases ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS app_deployments (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('dev', 'prod')),
    target TEXT NOT NULL CHECK (target IN ('preview', 'production', 'dev', 'prod')),
    source_sha TEXT,
    provider_deployment_id TEXT,
    url TEXT,
    ready_state TEXT,
    error TEXT,
    actor_user_id TEXT,
    approval_ref TEXT,
    change_ref TEXT,
    trace_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS app_deployments_tool_idx
    ON app_deployments (tool_id, created_at DESC);
CREATE TABLE IF NOT EXISTS tool_runtime (
    tool_id TEXT PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
    runtime TEXT NOT NULL CHECK (runtime IN ('local', 'external')),
    unit TEXT,
    port INTEGER,
    health TEXT NOT NULL DEFAULT 'unknown'
        CHECK (health IN ('ok', 'degraded', 'down', 'unknown')),
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    health_checked_at TIMESTAMPTZ,
    rss_bytes BIGINT,
    disk_bytes BIGINT,
    db_bytes BIGINT,
    last_visit_at TIMESTAMPTZ,
    lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN
        ('active', 'idle', 'stopped', 'archived', 'purged')),
    runtime_state TEXT NOT NULL DEFAULT 'stopped' CHECK (runtime_state IN
        ('stopped', 'building', 'starting', 'running', 'failed', 'idle_stopped',
         'over_quota')),
    state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

_RUNTIME_FIELDS = (
    "runtime", "unit", "port", "health", "consecutive_failures", "health_checked_at",
    "rss_bytes", "disk_bytes", "db_bytes", "last_visit_at", "lifecycle_state",
    "runtime_state",
)


def _json(value: Any) -> Any:
    if isinstance(value, (str, bytes, bytearray)):
        return json.loads(value)
    return value


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


@dataclass(frozen=True)
class AppDatabase:
    id: str
    tool_id: str
    mode: str
    db_name: str
    status: str
    cluster: str = "apps"
    features: List[str] = field(default_factory=lambda: ["postgres"])
    quota_mb: Optional[int] = None
    last_size_mb: Optional[int] = None
    last_backup_ref: Optional[str] = None
    applied_migrations: List[Any] = field(default_factory=list)
    #: The copy ``apps db archive`` took when the app was archived (restore reloads it).
    archive_ref: Optional[str] = None
    archive_bytes: Optional[int] = None
    archived_at: Optional[datetime] = None

    def as_dict(self) -> dict:
        return {
            "id": self.id, "tool_id": self.tool_id, "mode": self.mode,
            "cluster": self.cluster, "db_name": self.db_name, "status": self.status,
            "features": list(self.features), "quota_mb": self.quota_mb,
            "last_size_mb": self.last_size_mb, "last_backup_ref": self.last_backup_ref,
            "applied_migrations": list(self.applied_migrations),
            "archive_ref": self.archive_ref, "archive_bytes": self.archive_bytes,
            "archived_at": _iso(self.archived_at),
        }


def _row_to_db(row: "asyncpg.Record") -> AppDatabase:
    return AppDatabase(
        id=row["id"], tool_id=row["tool_id"], mode=row["mode"], db_name=row["db_name"],
        status=row["status"], cluster=row["cluster"],
        features=list(_json(row["features"]) or []), quota_mb=row["quota_mb"],
        last_size_mb=row["last_size_mb"], last_backup_ref=row["last_backup_ref"],
        applied_migrations=list(_json(row["applied_migrations"]) or []),
        archive_ref=row["archive_ref"], archive_bytes=row["archive_bytes"],
        archived_at=row["archived_at"],
    )


class AppStore:
    """Async access to the FG-33 runtime tables in one mode schema (C3)."""

    def __init__(self, store: "SupabaseAppStore") -> None:
        self._store = store

    @property
    def mode(self) -> str:
        return self._store.mode

    async def _with(self, fn, connection=None):
        if connection is not None:
            return await fn(connection)
        conn = await self._store.connect()
        try:
            await conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"')
            return await fn(conn)
        finally:
            await conn.close()

    async def initialize(self, *, connection: Optional["asyncpg.Connection"] = None) -> None:
        """Create the tables (after ``tools``, which they reference). Idempotent."""
        from hermes_cli.tools_registry import _tools_schema_sql

        async def _run(conn):
            await conn.execute(_tools_schema_sql())
            await conn.execute(_SCHEMA_SQL)

        await self._with(_run, connection)

    # -- databases ---------------------------------------------------------

    async def upsert_database(
        self,
        tool_id: str,
        mode: str,
        db_name: str,
        *,
        status: str,
        last_backup_ref: Optional[str] = None,
        applied_migrations: Optional[List[Any]] = None,
        quota_mb: Optional[int] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> AppDatabase:
        if status not in DB_STATUSES:
            raise ValueError(f"Invalid app database status: {status!r}")
        migrations = None if applied_migrations is None else json.dumps(applied_migrations)

        async def _run(conn):
            row = await conn.fetchrow(
                """
                INSERT INTO app_databases
                    (id, tool_id, mode, db_name, status, last_backup_ref,
                     applied_migrations, quota_mb, dropped_at)
                VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '[]'::jsonb), $8,
                        CASE WHEN $5 = 'dropped' THEN NOW() END)
                ON CONFLICT (tool_id, mode) DO UPDATE SET
                    db_name = EXCLUDED.db_name,
                    status = EXCLUDED.status,
                    last_backup_ref = COALESCE(EXCLUDED.last_backup_ref,
                                               app_databases.last_backup_ref),
                    applied_migrations = COALESCE($7::jsonb,
                                                  app_databases.applied_migrations),
                    quota_mb = COALESCE(EXCLUDED.quota_mb, app_databases.quota_mb),
                    dropped_at = EXCLUDED.dropped_at
                RETURNING *
                """,
                f"adb_{uuid.uuid4().hex}", tool_id, mode, db_name, status,
                last_backup_ref, migrations, quota_mb,
            )
            return _row_to_db(row)

        return await self._with(_run, connection)

    async def record_archive(
        self, tool_id: str, mode: str, *, archive_ref: str, archive_bytes: Optional[int],
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[AppDatabase]:
        """Remember the archive copy of a database and mark it suspended."""
        async def _run(conn):
            row = await conn.fetchrow(
                "UPDATE app_databases SET status = 'suspended', archive_ref = $3, "
                "archive_bytes = $4, archived_at = NOW(), last_backup_ref = $3 "
                "WHERE tool_id = $1 AND mode = $2 RETURNING *",
                tool_id, mode, archive_ref, archive_bytes,
            )
            return _row_to_db(row) if row is not None else None

        return await self._with(_run, connection)

    async def get_database(
        self, tool_id: str, mode: str, *, connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[AppDatabase]:
        async def _run(conn):
            row = await conn.fetchrow(
                "SELECT * FROM app_databases WHERE tool_id = $1 AND mode = $2",
                tool_id, mode,
            )
            return _row_to_db(row) if row is not None else None

        return await self._with(_run, connection)

    async def list_databases(
        self, *, connection: Optional["asyncpg.Connection"] = None,
    ) -> List[AppDatabase]:
        async def _run(conn):
            rows = await conn.fetch("SELECT * FROM app_databases ORDER BY db_name")
            return [_row_to_db(r) for r in rows]

        return await self._with(_run, connection)

    # -- deployments -------------------------------------------------------

    async def record_deployment(
        self,
        tool_id: str,
        *,
        mode: str,
        target: str,
        source_sha: Optional[str],
        actor_user_id: Optional[str],
        ready_state: str,
        url: Optional[str] = None,
        error: Optional[str] = None,
        approval_ref: Optional[str] = None,
        change_ref: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> str:
        ref = f"dep_{uuid.uuid4().hex}"

        async def _run(conn):
            await conn.execute(
                """
                INSERT INTO app_deployments
                    (id, tool_id, mode, target, source_sha, url, ready_state, error,
                     actor_user_id, approval_ref, change_ref)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                """,
                ref, tool_id, mode, target, source_sha, url, ready_state,
                (error or None) and error[:2000], actor_user_id, approval_ref, change_ref,
            )
            return ref

        return await self._with(_run, connection)

    async def list_deployments(
        self, tool_id: str, *, limit: int = 20,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Dict[str, Any]]:
        async def _run(conn):
            rows = await conn.fetch(
                """
                SELECT * FROM app_deployments WHERE tool_id = $1
                ORDER BY created_at DESC, id DESC LIMIT $2
                """,
                tool_id, max(1, min(int(limit), 200)),
            )
            return [{k: _iso(v) for k, v in dict(r).items()} for r in rows]

        return await self._with(_run, connection)

    async def latest_approval_ref(
        self, tool_id: str, *, connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[str]:
        """The approval of the last successful promotion that produced this row."""
        async def _run(conn):
            return await conn.fetchval(
                """
                SELECT approval_ref FROM app_deployments
                WHERE tool_id = $1 AND approval_ref IS NOT NULL AND error IS NULL
                ORDER BY created_at DESC, id DESC LIMIT 1
                """,
                tool_id,
            )

        return await self._with(_run, connection)

    # -- runtime -----------------------------------------------------------

    async def set_runtime(
        self, tool_id: str, *, connection: Optional["asyncpg.Connection"] = None,
        **fields: Any,
    ) -> Dict[str, Any]:
        unknown = set(fields) - set(_RUNTIME_FIELDS)
        if unknown:
            raise ValueError(f"Unknown tool_runtime fields: {sorted(unknown)}")
        if fields.get("runtime_state") not in (None, *RUNTIME_STATES):
            raise ValueError(f"Invalid runtime_state: {fields['runtime_state']!r}")
        if fields.get("health") not in (None, *HEALTH_STATES):
            raise ValueError(f"Invalid health: {fields['health']!r}")
        fields.setdefault("runtime", "local")
        cols = list(fields)
        params = ", ".join(f"${i + 2}" for i in range(len(cols)))
        updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
        changed = (
            ", state_changed_at = CASE WHEN tool_runtime.runtime_state "
            "IS DISTINCT FROM EXCLUDED.runtime_state THEN NOW() "
            "ELSE tool_runtime.state_changed_at END"
            if "runtime_state" in cols else ""
        )

        async def _run(conn):
            row = await conn.fetchrow(
                f"""
                INSERT INTO tool_runtime (tool_id, {', '.join(cols)})
                VALUES ($1, {params})
                ON CONFLICT (tool_id) DO UPDATE SET {updates}{changed}
                RETURNING *
                """,
                tool_id, *[fields[c] for c in cols],
            )
            return {k: _iso(v) for k, v in dict(row).items()}

        return await self._with(_run, connection)

    async def get_runtime(
        self, tool_id: str, *, connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[Dict[str, Any]]:
        async def _run(conn):
            row = await conn.fetchrow("SELECT * FROM tool_runtime WHERE tool_id = $1", tool_id)
            return {k: _iso(v) for k, v in dict(row).items()} if row is not None else None

        return await self._with(_run, connection)

    # -- the tools row's coarse build fields --------------------------------

    async def set_tool_build(
        self, tool_id: str, build_state: str, *, release_sha: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        async def _run(conn):
            await conn.execute(
                """
                UPDATE tools SET build_state = $2,
                    release_sha = COALESCE($3, release_sha), updated_at = NOW()
                WHERE id = $1
                """,
                tool_id, build_state, release_sha,
            )

        await self._with(_run, connection)

    async def forget_tool(
        self, tool_id: str, *, connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Remove a tool's runtime rows. Refuses while a database is not dropped."""
        async def _run(conn):
            live = await conn.fetchval(
                "SELECT db_name FROM app_databases WHERE tool_id = $1 AND status <> 'dropped'",
                tool_id,
            )
            if live:
                raise RuntimeError(f"app database {live} is not dropped yet")
            await conn.execute("DELETE FROM app_databases WHERE tool_id = $1", tool_id)
            await conn.execute("DELETE FROM app_deployments WHERE tool_id = $1", tool_id)
            await conn.execute("DELETE FROM tool_runtime WHERE tool_id = $1", tool_id)

        await self._with(_run, connection)


__all__ = [
    "AppDatabase",
    "AppStore",
    "DB_STATUSES",
    "HEALTH_STATES",
    "LIFECYCLE_STATES",
    "RUNTIME_STATES",
]
