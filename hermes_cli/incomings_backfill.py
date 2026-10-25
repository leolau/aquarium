"""``hermes incomings backfill`` — replay pipeline arrivals into the registry.

The live hooks in ``custom/`` only mirror what arrives *from now on*. Everything
the pollers and the WhatsApp batcher already wrote to their SQLite predates
them, and that SQLite is the only record of it. This walks those three tables
and upserts each row into the shared registry using the same external ids the
live hooks use, so a backfilled arrival and a live one are the same row —
running it twice changes nothing, and running it after a gap fills only the gap.

It reads the pipeline database read-only. Nothing here writes to SQLite, and
the pipeline is never required to be stopped.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.datastore import get_store
from hermes_cli.inbound_registry import InboundRegistry

#: Where the standalone pipeline keeps its store. The channel split moved
#: email/calendar tables into their own files; the backfill attaches all
#: three read-only so every surface stays reachable from one connection.
DEFAULT_DB_PATH = os.environ.get(
    "MESSAGING_DB_PATH", "/opt/data/whatsapp-messages/messaging_data.db"
)
_EMAIL_DB_PATH = os.environ.get(
    "EMAIL_DB_PATH", "/opt/data/email-messages/email_data.db"
)
_CALENDAR_DB_PATH = os.environ.get(
    "CALENDAR_DB_PATH", "/opt/data/calendar/calendar_data.db"
)

SURFACES = ("whatsapp", "email", "calendar")


def _open_db(path: str) -> sqlite3.Connection:
    """Open the pipeline store read-only, so a backfill cannot corrupt it."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    for alias, aux in (("emaildb", _EMAIL_DB_PATH), ("caldb", _CALENDAR_DB_PATH)):
        if os.path.exists(aux):
            conn.execute(
                f"ATTACH DATABASE 'file:{aux}?mode=ro' AS {alias}"
            )
    conn.row_factory = sqlite3.Row
    return conn


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone()
    return row is not None


def _parse_ts(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _since_bound(since: Optional[str]) -> Optional[str]:
    """``--since`` as an ISO string comparable with the stored timestamps.

    Accepts either a date/timestamp or a relative ``30d`` / ``12h`` form, which
    is what an operator actually types when repairing a gap.
    """
    if not since:
        return None
    text = since.strip()
    if text and text[-1] in "dh" and text[:-1].isdigit():
        amount = int(text[:-1])
        delta = timedelta(days=amount) if text[-1] == "d" else timedelta(hours=amount)
        return (datetime.now(timezone.utc) - delta).isoformat()
    return text


def _whatsapp_rows(conn: sqlite3.Connection, since: Optional[str]) -> Iterable[dict]:
    if not _has_table(conn, "messages"):
        return []
    sql = "SELECT * FROM messages"
    params: list[Any] = []
    if since:
        sql += " WHERE timestamp >= ?"
        params.append(since)
    sql += " ORDER BY timestamp"
    for row in conn.execute(sql, params):
        yield {
            "surface": "whatsapp",
            "external_id": row["id"],
            "account_id": row["source_phone"] or "",
            "kind": "message",
            "conversation": row["chat_id"],
            "sender_id": row["sender_phone"],
            "sender_name": row["sender_name"],
            "body": row["text"] or "",
            "occurred_at": _parse_ts(row["timestamp"]),
            "has_attachments": bool(row["media_type"]),
            "metadata": {
                "is_group": bool(row["is_group"]),
                "media_type": row["media_type"],
            },
        }


def _email_rows(conn: sqlite3.Connection, since: Optional[str]) -> Iterable[dict]:
    if not _has_table(conn, "email_messages"):
        return []
    sql = "SELECT * FROM email_messages"
    params: list[Any] = []
    if since:
        sql += " WHERE received_at >= ?"
        params.append(since)
    sql += " ORDER BY received_at"
    for row in conn.execute(sql, params):
        yield {
            "surface": "email",
            "external_id": row["message_id"],
            "account_id": row["account_id"] or "",
            "kind": "message",
            "conversation": row["thread_id"] or row["message_id"],
            "sender_id": row["from_addr"],
            "sender_name": row["from_name"],
            "subject": row["subject"],
            # body_text only: the registry is for reading and searching, and
            # the HTML part would bloat the index without adding meaning.
            "body": row["body_text"] or "",
            "occurred_at": _parse_ts(row["received_at"]),
            "has_attachments": bool(row["has_attachments"]),
            "metadata": {
                "to": row["to_addrs"],
                "cc": row["cc_addrs"],
                "folder": row["folder"],
                "in_reply_to": row["in_reply_to"],
            },
        }


def _calendar_rows(conn: sqlite3.Connection, since: Optional[str]) -> Iterable[dict]:
    if not _has_table(conn, "calendar_events"):
        return []
    sql = "SELECT * FROM calendar_events"
    params: list[Any] = []
    if since:
        sql += " WHERE start_time >= ?"
        params.append(since)
    sql += " ORDER BY start_time"
    for row in conn.execute(sql, params):
        yield {
            "surface": "calendar",
            "external_id": row["google_event_id"],
            "account_id": row["account_id"] or "",
            "kind": "event",
            "conversation": row["recurring_event_id"] or row["google_event_id"],
            "conversation_name": row["calendar_id"],
            "sender_id": row["organizer_email"],
            "sender_name": row["organizer_name"],
            "subject": row["summary"],
            "body": row["description"] or "",
            "occurred_at": _parse_ts(row["start_time"]),
            "ends_at": _parse_ts(row["end_time"]),
            "metadata": {
                "location": row["location"],
                "html_link": row["html_link"],
                "conference_link": row["conference_link"],
                "status": row["status"],
                "all_day": bool(row["all_day"]),
            },
        }


_READERS = {
    "whatsapp": _whatsapp_rows,
    "email": _email_rows,
    "calendar": _calendar_rows,
}


async def _link_legacy_files(
    registry: InboundRegistry, principal: Principal
) -> int:
    """Point already-registered attachments at the item they arrived in.

    Files registered before this feature existed carry the same
    ``(surface, account_id, message_id)`` the item now carries as its external
    id, so the two can be matched after the fact. Only unlinked rows are
    touched, so this is safe to re-run.
    """
    conn = await registry._connect()  # noqa: SLF001 - same-package maintenance path
    try:
        if not await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.file_assets')"
        ):
            return 0
        result = await conn.execute(
            """UPDATE file_assets f
                  SET inbound_item_id = i.id
                 FROM inbound_items i
                WHERE f.inbound_item_id IS NULL
                  AND f.owner_user_id = $1
                  AND i.owner_user_id = f.owner_user_id
                  AND i.surface = f.surface
                  AND i.external_id = f.message_id
                  AND COALESCE(i.account_id, '') = COALESCE(f.account_id, '')""",
            principal.user_id,
        )
        return int(str(result).rsplit(" ", 1)[-1] or 0)
    finally:
        await conn.close()


async def _run(
    *,
    db_path: str,
    surfaces: tuple[str, ...],
    since: Optional[str],
    dry_run: bool,
    actor: Optional[str],
) -> int:
    store = get_store("supabase-app", "prod")
    principals = PrincipalStore(store)
    principal = (
        await principals.get(actor) if actor else await principals.get_owner()
    )
    if principal is None:
        print(
            "No principal to attribute arrivals to "
            f"({'unknown --actor' if actor else 'no owner enrolled'}).",
            file=sys.stderr,
        )
        return 1

    try:
        conn = _open_db(db_path)
    except sqlite3.OperationalError as error:
        print(f"Cannot open the pipeline database at {db_path}: {error}", file=sys.stderr)
        return 1

    registry = InboundRegistry(store)
    if not dry_run:
        await registry.initialize()

    bound = _since_bound(since)
    total = 0
    # One Postgres connection for the whole replay: a connect per row was most
    # of a full backfill's cost (tens of thousands of rows on a real box).
    pg = None if dry_run else await registry._connect()  # noqa: SLF001
    try:
        for surface in surfaces:
            count = 0
            for fields in _READERS[surface](conn, bound):
                if not fields.get("external_id"):
                    continue
                count += 1
                if dry_run:
                    continue
                await registry.register(principal, connection=pg, **fields)
            print(f"{surface}: {count} arrival(s)" + (" (dry run)" if dry_run else ""))
            total += count
    finally:
        conn.close()
        if pg is not None:
            await pg.close()

    if not dry_run:
        linked = await _link_legacy_files(registry, principal)
        if linked:
            print(f"linked {linked} previously-registered attachment(s)")
    print(f"{total} arrival(s) {'would be ' if dry_run else ''}registered")
    return 0


def incomings_backfill_command(args: argparse.Namespace) -> int:
    surfaces = tuple(
        s.strip() for s in (args.surface or ",".join(SURFACES)).split(",") if s.strip()
    )
    unknown = [s for s in surfaces if s not in _READERS]
    if unknown:
        print(f"Unknown surface(s): {', '.join(unknown)}", file=sys.stderr)
        return 2
    try:
        return asyncio.run(
            _run(
                db_path=args.db,
                surfaces=surfaces,
                since=args.since,
                dry_run=args.dry_run,
                actor=args.actor,
            )
        )
    except (RuntimeError, ValueError) as error:
        print(f"Backfill failed: {error}", file=sys.stderr)
        return 1


async def _remember(*, item_id: str, actor: Optional[str]) -> int:
    from hermes_cli.incomings_api import RememberError, remember_item

    store = get_store("supabase-app", "prod")
    principals = PrincipalStore(store)
    principal = (
        await principals.get(actor) if actor else await principals.get_owner()
    )
    if principal is None:
        print(
            "No principal to remember as "
            f"({'unknown --actor' if actor else 'no owner enrolled'}).",
            file=sys.stderr,
        )
        return 1

    registry = InboundRegistry(store)
    item = await registry.get(principal, item_id)
    if item is None:
        # Invisible and absent are the same answer here, as they are over HTTP.
        print(f"No arrival {item_id} visible to {principal.user_id}.", file=sys.stderr)
        return 1
    if item.document_id:
        print(f"Already remembered as document {item.document_id}.")
        return 0

    try:
        remembered = await remember_item(principal, registry, item)
    except RememberError as error:
        print(f"Could not remember {item_id}: {error}", file=sys.stderr)
        return 1
    print(f"Remembered as document {remembered.document_id}.")
    return 0


def incomings_remember_command(args: argparse.Namespace) -> int:
    """``hermes incomings remember <id>`` — ingest an arrival into memory."""
    try:
        return asyncio.run(_remember(item_id=args.item_id, actor=args.actor))
    except (RuntimeError, ValueError) as error:
        print(f"Remember failed: {error}", file=sys.stderr)
        return 1


def register_incomings_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes incomings`` and its sub-actions."""
    parser = subparsers.add_parser(
        "incomings",
        help="Query and manage the unified inbox of arrivals (WhatsApp, email, calendar)",
        description=(
            "The registry behind /inbox. Arrivals are mirrored live by the "
            "pipeline hooks; list/search/show query them, backfill replays "
            "the ones that predate the hooks, and remember ingests one into "
            "memory."
        ),
    )
    sub = parser.add_subparsers(dest="incomings_command", required=True)

    backfill = sub.add_parser(
        "backfill",
        help="Replay pipeline SQLite arrivals into the shared registry",
    )
    backfill.add_argument(
        "--db",
        default=DEFAULT_DB_PATH,
        help=f"Pipeline SQLite path (default: {DEFAULT_DB_PATH})",
    )
    backfill.add_argument(
        "--surface",
        default=None,
        help=f"Comma-separated subset of {', '.join(SURFACES)} (default: all)",
    )
    backfill.add_argument(
        "--since",
        default=None,
        help="Only arrivals at or after this time (ISO, or a '30d' / '12h' form)",
    )
    backfill.add_argument(
        "--actor",
        default=None,
        help="Principal to attribute arrivals to (default: the enrolled owner)",
    )
    backfill.add_argument(
        "--dry-run",
        action="store_true",
        help="Count what would be registered without writing anything",
    )
    backfill.set_defaults(func=incomings_backfill_command)

    remember = sub.add_parser(
        "remember",
        help="Ingest one arrival into the memory tier",
        description=(
            "Registering an arrival is a fact; remembering it is a judgement. "
            "The document keeps a reference back to the message it came from."
        ),
    )
    remember.add_argument("item_id", help="Inbound item id (as shown at /inbox)")
    remember.add_argument(
        "--actor",
        default=None,
        help="Principal to remember as (default: the enrolled owner)",
    )
    remember.set_defaults(func=incomings_remember_command)

    # Read-only query verbs (list / search / show) live in their own module;
    # they attach to the same `sub` so `hermes incomings` stays one surface.
    from hermes_cli.incomings_query import register_incomings_query_verbs

    register_incomings_query_verbs(sub)
