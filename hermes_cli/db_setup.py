"""Table setup only runs when the connection owns the app schema.

Every store creates its own tables on first use (``CREATE TABLE IF NOT
EXISTS``, ``ALTER TABLE ... ADD COLUMN IF NOT EXISTS``, ``CREATE POLICY``).
Postgres checks privileges *before* it checks "if not exists", so on a
connection that is not the schema owner — the least-privilege ``hermes_app``
role — each of those statements fails even when there is nothing to create.

:meth:`hermes_cli.datastore.SupabaseAppStore.connect` therefore opens every
connection with :func:`connection_class` and calls :func:`bind`. When the
logged-in role owns the schema (the ``postgres`` DSN every box uses today)
nothing changes. When it does not, setup statements are skipped instead of
sent: the schema was set up by ``hermes db migrate`` running as the owner
(:mod:`hermes_cli.db_migrate`), and data statements still run normally.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Tuple

logger = logging.getLogger(__name__)

#: A statement batch that changes the schema rather than its rows. Leading
#: blank lines and ``--`` comments are allowed; ``CREATE TEMP`` tables are not
#: setup (any role may create them) and stay untouched.
_SETUP_SQL = re.compile(
    r"^(?:\s|--[^\n]*\n)*"
    r"(?:CREATE(?!\s+(?:TEMP|TEMPORARY)\b)|ALTER|DROP|COMMENT|GRANT|REVOKE|DO)\b",
    re.IGNORECASE,
)

_SKIPPED = "SKIPPED"

#: ``(server, user, database, schema) -> may run setup``; role ownership does
#: not change while a process runs, and this saves a round trip per connect.
_setup_allowed: Dict[Tuple[str, str, str, str], bool] = {}

_connection_class: Any = None


def is_setup_sql(query: str) -> bool:
    """True for CREATE/ALTER/DROP/COMMENT/GRANT/REVOKE/DO batches."""
    return bool(_SETUP_SQL.match(query or ""))


def connection_class() -> Any:
    """The asyncpg connection class every app-store connection uses."""
    global _connection_class
    if _connection_class is None:
        import asyncpg

        class SetupAwareConnection(asyncpg.Connection):
            """Skips schema setup when the logged-in role cannot do it."""

            _hermes_skip_setup = False

            async def execute(self, query: str, *args: Any, timeout: Any = None) -> str:
                if self._hermes_skip_setup and not args and is_setup_sql(query):
                    logger.debug("not the schema owner; skipped setup: %.80s", query.strip())
                    return _SKIPPED
                return await super().execute(query, *args, timeout=timeout)

        _connection_class = SetupAwareConnection
    return _connection_class


async def can_run_setup(connection: Any, schema: str) -> bool:
    """Whether the logged-in role may create and change tables in ``schema``.

    True for a superuser or a member of the role that owns the schema; for a
    schema that does not exist yet, true when the role may create schemas.
    """
    row = await connection.fetchrow(
        """
        SELECT r.rolsuper,
               n.oid IS NOT NULL AS schema_exists,
               CASE WHEN n.oid IS NULL THEN
                    has_database_privilege(current_database(), 'CREATE')
               ELSE pg_has_role(current_user, n.nspowner, 'USAGE') END AS allowed
        FROM pg_roles r
        LEFT JOIN pg_namespace n ON n.nspname = $1
        WHERE r.rolname = current_user
        """,
        schema,
    )
    if row is None:
        return False
    return bool(row["rolsuper"] or row["allowed"])


async def bind(connection: Any, schema: str) -> bool:
    """Mark ``connection`` to skip setup when it cannot run it; returns allowed."""
    key = (*connection_key(connection), schema)
    allowed = _setup_allowed.get(key) if all(key) else None
    if allowed is None:
        allowed = await can_run_setup(connection, schema)
        if all(key):
            _setup_allowed[key] = allowed
    if not allowed:
        exists = await connection.fetchval(
            "SELECT 1 FROM pg_namespace WHERE nspname = $1", schema
        )
        if not exists:
            raise RuntimeError(
                f"Schema {schema!r} does not exist and this database login "
                f"cannot create it. Run `hermes db migrate` once with the "
                f"admin database address (/etc/aquarium/db-admin.env)."
            )
    if hasattr(connection, "_hermes_skip_setup"):
        connection._hermes_skip_setup = not allowed
    return allowed


def connection_key(connection: Any) -> Tuple[str, str, str]:
    """``(server, user, database)`` of an asyncpg connection, for caching."""
    try:
        addr = connection._addr
        params = connection._params
        return (str(addr), str(params.user), str(params.database))
    except AttributeError:
        return ("", "", "")


async def execute_schema_change(connection: Any, sql: str) -> str:
    """Run DDL that must not be skipped (e.g. a promoted schema migration).

    On a login that does not own the schema this raises instead of silently
    skipping, so the caller cannot report a change that never happened.
    """
    if getattr(connection, "_hermes_skip_setup", False):
        raise PermissionError(
            "This changes the database schema, which only the schema owner may "
            "do; the agent's database login (hermes_app) cannot. Run it as the "
            "owner, e.g. on the server with the address in "
            "/etc/aquarium/db-admin.env."
        )
    return await connection.execute(sql)
