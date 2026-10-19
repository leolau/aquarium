"""``hermes db migrate`` — create and update every app table, as the schema owner.

The services and CLI commands also set their tables up on first use, but only
when their database login owns the schema (see :mod:`hermes_cli.db_setup`).
A least-privilege login such as ``hermes_app`` cannot, so this command does it
once per deploy with the owner's address:

    hermes db migrate --dsn-stdin < /etc/aquarium/db-admin.env

``--dsn-stdin`` reads ``HERMES_DB_ADMIN_URL=...`` (or ``DATABASE_URL=...``, or
a bare ``postgresql://`` address) from standard input, so the owner password
never sits in this process's environment where other processes of the same
user could read it. A ``HERMES_APP_DB_PASSWORD=...`` line in the same input
makes ``hermes_app`` a login role with that password. Without it the configured datastore address is used.
Safe to run again: every step is idempotent. Never prints the address.
"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import sys
from typing import Any, Awaitable, Callable, List, Optional, Tuple

Step = Tuple[str, Callable[[Any], Awaitable[Any]]]

_DSN_KEYS = ("HERMES_DB_ADMIN_URL", "DATABASE_URL")
#: hermes_app's login password; with it migrate makes hermes_app a LOGIN role.
APP_PASSWORD_KEY = "HERMES_APP_DB_PASSWORD"
#: agent-home's read-only login (agent_home_app); with it migrate refreshes its grants.
READ_PASSWORD_KEY = "HERMES_APP_READ_DB_PASSWORD"


def parse_env(text: str) -> dict:
    """``KEY=VALUE`` lines of an env-file body; a bare URL lands under ``""``."""
    values: dict = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        if line.startswith(("postgres://", "postgresql://")):
            values.setdefault("", line)
            continue
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip().strip("'\"")
    return values


def parse_dsn(text: str) -> str:
    """The admin address from an env-file body or a bare URL ('' if none)."""
    values = parse_env(text)
    for key in (*_DSN_KEYS, ""):
        if values.get(key):
            return values[key]
    return ""


def _steps(store: Any, config: dict) -> List[Step]:
    """Every table setup, in dependency order; each takes the owner connection."""
    from hermes_cli.access import initialize_access
    from hermes_cli.changes import initialize_changes
    from hermes_cli.credential_store import SupabaseCredentialStore
    from hermes_cli.datastore import initialize_supabase_app
    from hermes_cli.file_registry import FileRegistry
    from hermes_cli.goal_management import GoalManagementService
    from hermes_cli.goal_registry import GoalRegistryStore
    from hermes_cli.gts import GtsCentre
    from hermes_cli.human_comms import NotificationStore
    from hermes_cli.inbound_registry import InboundRegistry
    from hermes_cli.interactions import initialize_interactions
    from hermes_cli.invitations import initialize_invitations
    from hermes_cli.mcp_endpoints import MCPEndpointRegistry
    from hermes_cli.oss_provenance import ProvenanceRegistry
    from hermes_cli.profile_suggestion import ProfileSuggestionStore
    from hermes_cli.seminar_survey import SurveySettings, SurveyStore
    from hermes_cli.skill_promotion import SkillPromotionStore
    from hermes_cli.tags import TagRegistry
    from hermes_cli.task_registry import TaskRegistryStore
    from hermes_cli.todo_store import TodoStore
    from hermes_cli.tools_registry import ToolRegistry
    from plugins.memory.supabase_pgvector.rag import RagStore
    from plugins.memory.supabase_pgvector.store import (
        PgvectorMemoryStore,
        _role_reads_configured,
    )

    role_reads = _role_reads_configured(config)
    memory = PgvectorMemoryStore(store, config=config)

    def init(obj: Any) -> Callable[[Any], Awaitable[Any]]:
        return lambda conn: obj.initialize(connection=conn)

    async def vector(conn: Any) -> None:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")

    async def goal_management(conn: Any) -> None:
        # Opens its own connection; the store already carries the owner DSN.
        await GoalManagementService(store, config=config).initialize()

    return [
        ("app schemas", initialize_supabase_app),
        ("people and logins", initialize_access),
        ("pgvector extension", vector),
        ("change log", initialize_changes),
        ("invitations", initialize_invitations),
        ("interactions", initialize_interactions),
        ("tags", init(TagRegistry(store))),
        ("files", init(FileRegistry(store, role_reads=role_reads))),
        ("inbound items", init(InboundRegistry(store, role_reads=role_reads))),
        ("tools", init(ToolRegistry(store))),
        ("todos", init(TodoStore(store))),
        ("credentials", init(SupabaseCredentialStore(store))),
        ("OSS provenance", init(ProvenanceRegistry(store))),
        ("MCP endpoints", init(MCPEndpointRegistry(store))),
        ("notifications", init(NotificationStore(store, config=config))),
        ("goals", init(GoalRegistryStore(store))),
        ("tasks", init(TaskRegistryStore(store))),
        ("goal/task graph", init(GtsCentre(store))),
        ("goal links", goal_management),
        ("skill promotions", init(SkillPromotionStore(store))),
        ("profile suggestions", init(ProfileSuggestionStore(store))),
        ("seminar survey", init(SurveyStore(store, SurveySettings()))),
        ("memory", init(memory)),
        ("documents (RAG)", init(RagStore(memory))),
    ]


async def migrate_store(
    store: Any, config: dict, *, app_password: str = "", read_password: str = ""
) -> List[Tuple[str, Optional[str]]]:
    """Run every setup step on ``store``; ``[(step, error or None)]``."""
    from hermes_cli import db_setup
    from hermes_cli.access import ensure_app_role

    results: List[Tuple[str, Optional[str]]] = []
    connection = await store.connect()
    try:
        if not await db_setup.bind(connection, store.schema):
            return [(
                "schema owner",
                f"this database login does not own schema {store.schema!r}, so it "
                "cannot create tables; use the admin address "
                "(/etc/aquarium/db-admin.env)",
            )]
        for name, step in _steps(store, config):
            try:
                await step(connection)
            except Exception as error:  # report every step, then fail once
                results.append((name, f"{type(error).__name__}: {error}"))
            else:
                results.append((name, None))
        try:
            # New tables get the least-privilege role's row grants. Membership
            # is skipped: it kills the backend on self-hosted Supabase.
            await ensure_app_role(
                connection, store.schema, grant_membership=False,
                password=app_password or None,
            )
        except Exception as error:
            results.append(("hermes_app grants", f"{type(error).__name__}: {error}"))
        else:
            results.append(("hermes_app grants", None))
        if read_password:
            from hermes_cli.access import ensure_read_role

            try:
                # SELECT on every row-ruled table, including ones made above.
                await ensure_read_role(connection, store.schema, password=read_password)
            except Exception as error:
                results.append(("agent_home_app grants", f"{type(error).__name__}: {error}"))
            else:
                results.append(("agent_home_app grants", None))
    finally:
        await connection.close()
    return results


def migrate(
    admin_dsn: str = "",
    *,
    config: Optional[dict] = None,
    app_password: str = "",
    read_password: str = "",
) -> List[Tuple[str, str, Optional[str]]]:
    """Migrate the prod and dev schemas; ``[(mode, step, error or None)]``."""
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import get_store

    config = config if config is not None else load_config_readonly()
    rows: List[Tuple[str, str, Optional[str]]] = []
    for mode in ("prod", "dev"):
        store = get_store("supabase-app", mode, config=config)
        if not store.dsn:
            continue  # this profile has no Supabase datastore
        if admin_dsn:
            store = dataclasses.replace(store, dsn=admin_dsn)
        for name, error in asyncio.run(
            migrate_store(
                store, config, app_password=app_password,
                read_password=read_password if mode == "prod" else "",
            )
        ):
            rows.append((mode, name, error))
    return rows


def db_migrate_command(args: argparse.Namespace) -> int:
    admin_dsn = app_password = read_password = ""
    if getattr(args, "dsn_stdin", False):
        text = sys.stdin.read()
        admin_dsn = parse_dsn(text)
        # The same file carries the two limited logins' passwords.
        values = parse_env(text)
        app_password = values.get(APP_PASSWORD_KEY, "")
        read_password = values.get(READ_PASSWORD_KEY, "")
        if not admin_dsn:
            print("No database address on standard input "
                  "(expected HERMES_DB_ADMIN_URL=postgresql://...).", file=sys.stderr)
            return 1
    try:
        rows = migrate(admin_dsn, app_password=app_password, read_password=read_password)
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Database migration failed: {error}", file=sys.stderr)
        return 1
    if not rows:
        print("No Supabase datastore configured; nothing to migrate.")
        return 0
    failed = 0
    for mode, name, error in rows:
        if error:
            failed += 1
            print(f"FAILED  {mode:4} {name}: {error}", file=sys.stderr)
        else:
            print(f"ok      {mode:4} {name}")
    if failed:
        print(f"{failed} step(s) failed.", file=sys.stderr)
        return 1
    print("Database tables are up to date.")
    return 0


def register_db_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes db migrate``."""
    parser = subparsers.add_parser(
        "db",
        help="Set up the app database tables (as the schema owner)",
        description="Database maintenance for the Supabase app datastore.",
    )
    sub = parser.add_subparsers(dest="db_command", required=True)
    run = sub.add_parser(
        "migrate",
        help="Create/update every app table and policy; idempotent",
        description=(
            "Create and update every app table, row rule and hermes_app grant, "
            "for the prod and dev schemas. Run with the schema owner's address, "
            "e.g. `hermes db migrate --dsn-stdin < /etc/aquarium/db-admin.env`."
        ),
    )
    run.add_argument(
        "--dsn-stdin",
        action="store_true",
        help="read the owner address (HERMES_DB_ADMIN_URL=...) from standard input",
    )
    run.set_defaults(func=db_migrate_command)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m hermes_cli.db_migrate")
    parser.add_argument("--dsn-stdin", action="store_true")
    return db_migrate_command(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())
