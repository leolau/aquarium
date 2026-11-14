"""Agent SQL over Aquarium's own app data (data-dictionary plan, decision D7).

The app tables' row rules trust ``hermes.*`` settings that any SQL can change
with ``set_config``, so agent-written SQL never runs against them. Instead,
for each question:

1. App code reads the rows the signed-in person may see from the chosen areas,
   with the same :func:`hermes_cli.access.scope_filter` the stores use.
2. Those rows go into temporary tables on a connection logged in as
   :data:`SANDBOX_ROLE`, which can read no real table (checked every time).
3. The agent's one SELECT runs there, read-only, capped and timed out.
4. The connection closes and the copies are gone.
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from hermes_cli import site_sources as ss
from hermes_cli.access import Principal, bind_principal, scope_filter

SANDBOX_ROLE = "aquarium_data_sandbox"
#: Rows one area may copy for one question. Above it the question is refused,
#: never answered from a partial copy.
AREA_ROW_CAP = 50_000

#: Column types a temp table keeps as they are; anything else is copied as text.
_KEPT_TYPES = {
    "text", "uuid", "boolean", "integer", "bigint", "smallint", "numeric",
    "double precision", "real", "date", "timestamp with time zone",
    "timestamp without time zone", "jsonb",
}


@dataclass(frozen=True)
class Area:
    name: str
    table: str
    label: str
    columns: Tuple[str, ...]
    grant_item_kind: Optional[str] = None


def _areas() -> Dict[str, Area]:
    from hermes_cli import file_registry, goal_registry, inbound_registry, todo_store

    def cols(text: str) -> Tuple[str, ...]:
        return tuple(c.strip() for c in text.split(",") if c.strip())

    items = (
        Area("todos", todo_store.TASKS_TABLE, "To-dos", cols(todo_store._SELECT_COLUMNS),
             todo_store.GRANT_ITEM_KIND),
        Area("goals", goal_registry.GOALS_TABLE, "Goals", cols(goal_registry.GOAL_COLUMNS)),
        Area(
            "files", file_registry.FILE_ASSETS_TABLE, "Files",
            cols("id, owner_user_id, visibility, surface, conversation, sender_name, received_at, "
                 "filename, content_type, byte_size, document_id, remembered_at"),
            file_registry.GRANT_ITEM_KIND,
        ),
        Area(
            "inbox", inbound_registry.INBOUND_ITEMS_TABLE, "Inbox",
            cols("id, owner_user_id, visibility, surface, kind, conversation_name, sender_name, "
                 "subject, body, occurred_at, ends_at, registered_at, updated_at, importance, "
                 "has_attachments, document_id"),
            inbound_registry.GRANT_ITEM_KIND,
        ),
    )
    return {a.name: a for a in items}


def schema() -> Dict[str, Tuple[str, ...]]:
    """The queryable surface the app dictionary documents: ``{area: (columns,)}``."""
    return {a.name: a.columns for a in _areas().values()}


def _app_store() -> Any:
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import get_store

    return get_store("supabase-app", "prod", config=load_config_readonly() or {})


def _choose(names: Sequence[str]) -> List[Area]:
    known = _areas()
    picked = [str(n).strip().lower() for n in names or () if str(n).strip()]
    if not picked:
        raise ss.SiteError(f"areas= is required, from: {', '.join(known)}")
    unknown = [n for n in picked if n not in known]
    if unknown:
        raise ss.SiteError(f"unknown area {unknown[0]!r}; areas: {', '.join(known)}")
    return [known[n] for n in dict.fromkeys(picked)]


async def _columns(conn: Any, schema: str, area: Area) -> List[Tuple[str, str]]:
    rows = await conn.fetch(
        "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type "
        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
        "JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped "
        "ORDER BY a.attnum",
        schema, area.table,
    )
    found = {r["name"]: r["type"] for r in rows}
    if not found:
        raise ss.SiteError(f"area {area.name!r} has no table on this install", 404)
    out = []
    for name in area.columns:
        if name in found:
            kind = found[name]
            out.append((name, kind if kind in _KEPT_TYPES else "text"))
    return out


async def _copy_out(
    principal: Principal, areas: Sequence[Area], store: Any
) -> List[Tuple[Area, List[Tuple[str, str]], List[Tuple[Any, ...]]]]:
    """Rows of each area ``principal`` may read, as the stores' own filter decides."""
    copies = []
    conn = await store.connect()
    try:
        async with conn.transaction(readonly=True):
            await bind_principal(conn, principal)
            for area in areas:
                columns = await _columns(conn, store.schema, area)
                predicate = scope_filter(
                    principal,
                    grant_item_kind=area.grant_item_kind,
                    id_column=f"{area.table}.id",
                )
                select = ", ".join(
                    f"{area.table}.{ss._ident(n)}" + ("::text" if t in ("text", "jsonb") else "")
                    for n, t in columns
                )
                rows = await conn.fetch(
                    f"SELECT {select} FROM {ss._ident(store.schema)}.{area.table} "
                    f"WHERE {predicate.sql} LIMIT {AREA_ROW_CAP + 1}",
                    *predicate.params,
                )
                if len(rows) > AREA_ROW_CAP:
                    raise ss.SiteError(
                        f"{area.label} has more than {AREA_ROW_CAP:,} rows you can see; "
                        "narrow the question to fewer areas or ask an admin"
                    )
                copies.append((area, columns, [tuple(r.values()) for r in rows]))
    finally:
        await conn.close()
    return copies


_REACH_SQL = """
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname !~ '^pg_(temp|toast)'
      AND has_schema_privilege(n.oid, 'USAGE')
      AND has_any_column_privilege(c.oid, 'SELECT')) AS tables,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND has_schema_privilege(n.oid, 'USAGE')
      AND has_function_privilege(p.oid, 'EXECUTE')
      AND (p.prosecdef OR p.proname LIKE 'dblink%')) AS functions
"""


async def _sandbox(dsn: str) -> Any:
    import asyncpg

    password = ss._role_password(SANDBOX_ROLE, create=False)
    if not password:
        raise ss.SiteError(
            "app data questions aren't set up on this box; run `hermes db migrate`", 503
        )
    conn = await asyncpg.connect(
        ss.role_dsn(dsn, SANDBOX_ROLE, password),
        server_settings={
            "search_path": "pg_temp",
            "statement_timeout": str(ss.QUERY_TIMEOUT_MS),
            "application_name": "hermes-app-data",
        },
    )
    try:
        reach = await conn.fetchrow(_REACH_SQL)
        if reach["tables"] or reach["functions"]:
            raise ss.SiteError(
                f"refused: the {SANDBOX_ROLE} login can reach {reach['tables']} table(s) and "
                f"{reach['functions']} privileged function(s); an admin must revoke them",
                503,
            )
        # COPY is binary. jsonb arrives as JSON text (see _copy_out).
        await conn.set_type_codec(
            "jsonb",
            encoder=lambda text: b"\x01" + text.encode(),
            decoder=lambda data: json.loads(data[1:]),
            schema="pg_catalog",
            format="binary",
        )
    except BaseException:
        await conn.close()
        raise
    return conn


async def _load(conn: Any, copies: Sequence[Tuple[Area, List[Tuple[str, str]], List[Tuple[Any, ...]]]]) -> None:
    for area, columns, rows in copies:
        body = ", ".join(f"{ss._ident(n)} {t}" for n, t in columns)
        await conn.execute(f"CREATE TEMP TABLE {ss._ident(area.name)} ({body})")
        if rows:
            await conn.copy_records_to_table(
                area.name, records=rows, columns=[n for n, _ in columns]
            )


async def query(
    principal: Optional[Principal],
    areas: Sequence[str],
    sql: str,
    *,
    max_rows: int = ss.MAX_QUERY_ROWS,
    store: Any = None,
) -> Dict[str, Any]:
    """Run one agent SELECT over private copies of ``areas`` for ``principal``."""
    import asyncpg

    if principal is None or not principal.user_id:
        raise ss.SiteError("no signed-in person is bound to this request")
    sql = ss.check_select(sql)
    chosen = _choose(areas)
    max_rows = max(1, min(int(max_rows or ss.MAX_QUERY_ROWS), ss.MAX_QUERY_ROWS))
    store = store or _app_store()
    copies = await _copy_out(principal, chosen, store)
    conn = await _sandbox(store.dsn)
    try:
        await _load(conn, copies)
        try:
            async with conn.transaction(readonly=True):
                stmt = await conn.prepare(sql)
                columns = [a.name for a in stmt.get_attributes()]
                cursor = await stmt.cursor()
                rows = await cursor.fetch(max_rows + 1)
        except asyncpg.PostgresError as exc:
            raise ss.SiteError(f"query failed: {exc}") from exc
    finally:
        await conn.close()
    truncated = len(rows) > max_rows
    rows = rows[:max_rows]
    return {
        "areas": [a.name for a in chosen],
        "columns": columns,
        "rows": [[ss.jsonable(v) for v in r.values()] for r in rows],
        "row_count": len(rows),
        "truncated": truncated,
    }


async def describe(principal: Optional[Principal], *, store: Any = None) -> List[Dict[str, Any]]:
    """Each area: its table name for SQL, its columns and how many rows the person sees."""
    if principal is None or not principal.user_id:
        raise ss.SiteError("no signed-in person is bound to this request")
    store = store or _app_store()
    areas = list(_areas().values())
    out = []
    conn = await store.connect()
    try:
        async with conn.transaction(readonly=True):
            await bind_principal(conn, principal)
            for area in areas:
                try:
                    columns = await _columns(conn, store.schema, area)
                except ss.SiteError:
                    continue
                predicate = scope_filter(
                    principal, grant_item_kind=area.grant_item_kind, id_column=f"{area.table}.id"
                )
                rows = await conn.fetchval(
                    f"SELECT count(*) FROM {ss._ident(store.schema)}.{area.table} "
                    f"WHERE {predicate.sql}",
                    *predicate.params,
                )
                out.append({
                    "area": area.name,
                    "label": area.label,
                    "table": area.name,
                    "rows": rows,
                    "columns": [{"name": n, "type": t} for n, t in columns],
                })
    finally:
        await conn.close()
    return out


async def ensure_sandbox_role(conn: Any, *, password: Optional[str] = None) -> None:
    """``hermes db migrate`` step: the :data:`SANDBOX_ROLE` login.

    No table grants at all: it only needs to log in and make temp tables.
    """
    from hermes_cli.access import _quote_literal

    secret = password or ss._role_password(SANDBOX_ROLE, create=False) or secrets.token_urlsafe(32)
    literal = _quote_literal(secret)
    if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", SANDBOX_ROLE):
        await conn.execute(f"ALTER ROLE {SANDBOX_ROLE} PASSWORD {literal}")
    else:
        await conn.execute(
            f"CREATE ROLE {SANDBOX_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE "
            f"NOINHERIT PASSWORD {literal}"
        )
    database = await conn.fetchval("SELECT current_database()")
    await conn.execute(f'GRANT CONNECT, TEMPORARY ON DATABASE "{database}" TO {SANDBOX_ROLE}')
    ss._store_role_password(SANDBOX_ROLE, secret)
