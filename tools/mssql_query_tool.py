"""Query the signed-in person's own SQL Server databases.

The agent-side half of Settings -> In&Out -> SQL Server databases
(``hermes_cli/mssql_connections.py``). The password stays in the credential
store (``mssql`` entries are never materialised into the terminal); this tool
connects in-process and only ever acts for the person the tool call is bound
to. Service-gated: it only appears when the driver (the ``mssql`` extra) is
installed.

Read-only by default (one SELECT/WITH, rolled back). A write runs only when
the connection's owner switched on ``allow_writes`` AND the person approves
the exact statement in the chat.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Mapping, Optional

from tools.registry import registry

ACTIONS = ("list_connections", "list_tables", "describe", "query")

SCHEMA = {
    "name": "mssql_query",
    "description": (
        "Query the signed-in person's own Microsoft SQL Server databases added under "
        "Settings -> In&Out -> SQL Server databases. Actions: list_connections; "
        "list_tables (schema, name, type); describe (columns of one table); "
        "query (one T-SQL SELECT/WITH statement; at most 500 rows, 30 s). "
        "Use @name placeholders with params instead of pasting values into sql. "
        "Queries are read-only; set write=true only for a connection that allows "
        "writes, and the person must approve the statement first."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "connection": {
                "type": "string",
                "description": "Connection name; optional when the person has exactly one.",
            },
            "table": {
                "type": "string",
                "description": "describe: table or view, optionally schema-qualified (dbo.Orders).",
            },
            "sql": {"type": "string", "description": "query: one T-SQL statement."},
            "params": {
                "type": "object",
                "description": "query: values for @name placeholders in sql.",
            },
            "max_rows": {"type": "integer", "description": "query: row cap (<= 500)."},
            "write": {
                "type": "boolean",
                "description": "query: run a data-changing statement (needs approval).",
            },
        },
        "required": ["action"],
    },
}

_LIST_TABLES_SQL = (
    "SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, TABLE_TYPE AS type "
    "FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME"
)
_DESCRIBE_SQL = (
    "SELECT COLUMN_NAME AS name, DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS max_length, "
    "IS_NULLABLE AS nullable, COLUMN_DEFAULT AS [default] "
    "FROM INFORMATION_SCHEMA.COLUMNS "
    "WHERE TABLE_SCHEMA = %(schema)s AND TABLE_NAME = %(table)s ORDER BY ORDINAL_POSITION"
)


class MssqlToolError(Exception):
    pass


def check_mssql_requirements() -> bool:
    from hermes_cli.mssql_connections import driver_available

    return driver_available()


def _result(**data: Any) -> str:
    return json.dumps({"success": True, **data}, ensure_ascii=False, default=str)


def _error(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _principal():
    from hermes_cli.access import Principal, normalize_role
    from tools.access_policy import current_principal

    user_id, role = current_principal()
    if not user_id:
        raise MssqlToolError("no signed-in person is bound to this request")
    return Principal(user_id=user_id, display=user_id, role=normalize_role(role))


def _pick(entries: list, name: Optional[str]):
    if not entries:
        raise MssqlToolError(
            "no SQL Server connection is set up; add one in Settings -> In&Out"
        )
    if name:
        wanted = str(name).strip().casefold()
        for entry in entries:
            if entry.name.casefold() == wanted:
                return entry
        raise MssqlToolError("no SQL Server connection with that name")
    if len(entries) > 1:
        raise MssqlToolError(
            "several SQL Server connections are set up; pass connection= one of "
            + ", ".join(e.name for e in entries)
        )
    return entries[0]


def _split_table(table: Any) -> tuple:
    text = str(table or "").strip()
    if not text:
        raise MssqlToolError("describe needs table=")
    parts = [p.strip().strip("[]") for p in text.split(".")]
    if len(parts) == 1:
        return "dbo", parts[0]
    if len(parts) == 2 and all(parts):
        return parts[0], parts[1]
    raise MssqlToolError("table must be name or schema.name")


def _approve_write(entry: Any, sql: str) -> Optional[str]:
    """Ask the chat's user before a write; error text unless approved."""
    try:
        from tools.approval import request_elicitation_consent_detailed

        decision, reason = request_elicitation_consent_detailed(
            f"SQL Server '{entry.name}' ({entry.payload.get('database')}):\n{sql[:4000]}",
            f"The agent wants to change data in the SQL Server database '{entry.name}'.",
            surface="mssql-write",
        )
    except Exception:  # noqa: BLE001 - fail closed
        decision, reason = "error", "error"
    if decision == "accept":
        return None
    return (
        f"The write to '{entry.name}' was not approved ({reason}), so it did not run. "
        "Ask the person before trying again."
    )


async def mssql_query_tool(args: Mapping[str, Any], **_kw: Any) -> str:
    from hermes_cli import mssql_connections as mssql

    action = str(args.get("action") or "")
    if action not in ACTIONS:
        return _error(f"action must be one of {', '.join(ACTIONS)}")
    payload: Mapping[str, Any] = {}
    try:
        principal = _principal()
        entries = await mssql.own_entries(principal)
        if action == "list_connections":
            return _result(connections=[mssql.connection_summary(e)[1] for e in entries])
        entry = _pick(entries, args.get("connection"))
        payload = entry.payload
        write = False
        params = None
        max_rows = mssql.MAX_ROWS
        if action == "list_tables":
            sql = _LIST_TABLES_SQL
        elif action == "describe":
            schema, table = _split_table(args.get("table"))
            sql, params = _DESCRIBE_SQL, {"schema": schema, "table": table}
        else:
            sql = str(args.get("sql") or "").strip()
            if not sql:
                raise MssqlToolError("query needs sql=")
            raw_params = args.get("params")
            if raw_params is not None and not isinstance(raw_params, Mapping):
                raise MssqlToolError("params must be an object")
            params = dict(raw_params) if raw_params else None
            if params:
                sql = _named_placeholders(sql, params)
            try:
                max_rows = int(args.get("max_rows") or mssql.MAX_ROWS)
            except (TypeError, ValueError):
                raise MssqlToolError("max_rows must be a number") from None
            write = bool(args.get("write"))
            if write:
                if not payload.get("allow_writes"):
                    raise MssqlToolError(
                        f"'{entry.name}' is read-only; its owner can allow writes in "
                        "Settings -> In&Out"
                    )
                mssql.check_write(sql)
                refusal = await asyncio.to_thread(_approve_write, entry, sql)
                if refusal:
                    return _error(refusal)
            else:
                mssql.check_read_only(sql)
        ip = await mssql.route_for(principal, entry, agent=True)
        result = await asyncio.to_thread(
            mssql.execute, payload, sql, params=params, write=write, ip=ip, max_rows=max_rows,
        )
        return _result(connection=entry.name, **result)
    except (MssqlToolError, mssql.MssqlError) as exc:
        return _error(mssql.scrub(str(exc), payload))
    except Exception as exc:  # noqa: BLE001 - driver/network errors, scrubbed
        return _error(mssql.plain_error(exc, payload))


def _named_placeholders(sql: str, params: Mapping[str, Any]) -> str:
    """T-SQL ``@name`` -> python-tds ``%(name)s`` for the given params."""
    import re

    for key in params:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", str(key)):
            raise MssqlToolError("param names must be letters, digits and _")
    names = sorted(params, key=len, reverse=True)
    pattern = re.compile(r"@(" + "|".join(re.escape(n) for n in names) + r")\b")
    return pattern.sub(lambda m: f"%({m.group(1)})s", sql.replace("%", "%%"))


registry.register(
    name="mssql_query",
    toolset="mssql",
    schema=SCHEMA,
    handler=mssql_query_tool,
    check_fn=check_mssql_requirements,
    is_async=True,
    emoji="🗄️",
)
