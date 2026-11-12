"""``hermes todos`` — the operator surface for to-dos.

Deliberately a CLI command rather than a model tool: the to-do store is
read/written by the page, the HTTP API, and the triage bridge, but the agent
itself — the thing the whole repo is about — has no route in until this
exists. Rung 2 on the footprint ladder: a CLI command plus a skill, no new
core tool, no self-HTTP.

Every verb but ``send`` maps 1:1 onto a ``TodoStore`` method that already
exists. ``send`` closes the dangling reference ``todo_outbound.command_for()``
already writes into every outgoing approval's ``command`` field — a printed
command the CLI would reject with ``invalid choice`` is a broken promise in a
trust surface.

The plan is ``docs/plans/2026-08-13-001-todos-and-projects-design-revision.md``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shlex
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from hermes_cli.access import Principal, PrincipalStore
from hermes_cli.todo_store import (
    DEFAULT_STAGED_EXPIRY_DAYS,
    TODO_PRIORITIES,
    TODO_STAGES,
    TodoError,
    TodoStore,
    default_store,
)

#: Where the standalone pipeline keeps its store (same convention as
#: ``incomings_backfill``).
import os as _os

DEFAULT_DB_PATH = _os.environ.get(
    "MESSAGING_DB_PATH", "/opt/data/whatsapp-messages/messaging_data.db"
)
#: The channel split moved ``email_tasks`` to its own DB; the replay command
#: attaches it read-only so both legacy tables stay reachable.
_EMAIL_DB_PATH = _os.environ.get(
    "EMAIL_DB_PATH", "/opt/data/email-messages/email_data.db"
)


# ---------------------------------------------------------------------------
# Principal resolution — the same shape as goal_tree_cmd._resolve
# ---------------------------------------------------------------------------

async def _resolve(actor: Optional[str]) -> tuple[TodoStore, Principal]:
    store = default_store()
    principals = PrincipalStore(store._store)  # noqa: SLF001 - same-package
    principal = (
        await principals.get(actor) if actor else await principals.get_owner()
    )
    if principal is None:
        raise RuntimeError(
            "unknown --actor" if actor else "no owner is enrolled yet"
        )
    await store.initialize()
    return store, principal


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _csv(value: str) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def _when(value: Optional[str], *, field: str = "when") -> Optional[datetime]:
    if not value or not str(value).strip():
        return None
    try:
        parsed = datetime.fromisoformat(
            str(value).strip().replace("Z", "+00:00")
        )
    except ValueError:
        print(f"{field} is not an ISO timestamp: {value}", file=sys.stderr)
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _print_json(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


async def _source_item(
    principal: Principal, todo: Any
) -> Optional[dict[str, Any]]:
    """The arrival this to-do came from, best-effort (never raises)."""
    if todo.source_kind != "inbound" or not todo.source_ref:
        return None
    try:
        from hermes_cli.inbound_registry import default_registry

        item = await default_registry().get(principal, str(todo.source_ref))
    except Exception:
        return None
    return item.as_dict() if item is not None else None


# ---------------------------------------------------------------------------
# Read verbs
# ---------------------------------------------------------------------------

async def _list(
    store: TodoStore,
    principal: Principal,
    *,
    stages: Optional[list[str]],
    priorities: Optional[list[str]],
    source_kinds: Optional[list[str]],
    query: Optional[str],
    limit: int,
    json_mode: bool,
) -> int:
    items, next_cursor = await store.list(
        principal,
        stages=stages,
        priorities=priorities,
        source_kinds=source_kinds,
        query=query,
        limit=limit,
    )
    if json_mode:
        _print_json(
            {
                "items": [t.as_dict() for t in items],
                "next_cursor": next_cursor,
            }
        )
    else:
        if not items:
            print("No to-dos.")
        for t in items:
            due = f"  due {t.due_at:%d %b}" if t.due_at else ""
            print(f"[{t.stage:>9}] [{t.priority:>8}] {t.title}{due}")
    return 0


async def _show(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    json_mode: bool,
) -> int:
    todo = await store.get(principal, todo_id)
    if todo is None:
        print(f"No to-do {todo_id} visible to you.", file=sys.stderr)
        return 1
    history = await store.history(principal, todo_id)
    source = await _source_item(principal, todo)
    if json_mode:
        payload = todo.as_dict()
        payload["history"] = history
        payload["source"] = source
        _print_json(payload)
    else:
        print(todo.title)
        print(f"  Stage: {todo.stage}  Priority: {todo.priority}")
        if todo.due_at:
            print(f"  Due: {todo.due_at:%a %d %b %Y}")
        if todo.source_note:
            print(f"  From: {todo.source_note}")
        if todo.outcome:
            print(f"  Outcome: {todo.outcome}")
        if source:
            subj = source.get("subject") or source.get("sender_name") or "(untitled)"
            print(f"  Arrival: {subj}")
        if history:
            print("  History:")
            for step in history:
                print(f"    {step['from']} -> {step['to']}  {step['actor']}")
    return 0


async def _facets(
    store: TodoStore,
    principal: Principal,
    json_mode: bool,
) -> int:
    result = await store.facets(principal)
    if json_mode:
        _print_json(result)
    else:
        for key, values in result.items():
            print(f"{key}:")
            for v in values:
                print(f"  {v['value']:>12}  {v['count']}")
    return 0


# ---------------------------------------------------------------------------
# Write verbs
# ---------------------------------------------------------------------------

async def _add(
    store: TodoStore,
    principal: Principal,
    *,
    title: str,
    description: str,
    priority: str,
    due_at: Optional[datetime],
    stage: str,
    json_mode: bool,
) -> int:
    todo = await store.create(
        principal,
        title=title,
        description=description,
        stage=stage,
        priority=priority,
        due_at=due_at,
        source_kind="user",
        origin="explicit",
        actor=f"user:{principal.user_id}",
    )
    if json_mode:
        _print_json(todo.as_dict())
    else:
        verb = "Created" if todo.created else "Updated (already exists)"
        print(f"{verb}: {todo.title} ({todo.id}) [{todo.stage}]")
    return 0


async def _stage(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    stage: str,
    outcome: Optional[str],
    json_mode: bool,
) -> int:
    todo = await store.set_stage(
        principal,
        todo_id,
        stage,
        outcome=outcome,
        actor=f"user:{principal.user_id}",
    )
    if json_mode:
        _print_json(todo.as_dict())
    else:
        print(f"{todo.title} -> {todo.stage}")
    return 0


async def _done(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    outcome: Optional[str],
    propose_reply: bool,
    json_mode: bool,
) -> int:
    todo = await store.set_stage(
        principal,
        todo_id,
        "done",
        outcome=outcome,
        actor=f"user:{principal.user_id}",
    )
    payload = todo.as_dict()
    if propose_reply:
        proposal = await _try_propose(principal, todo, outcome)
        if proposal is not None:
            payload["proposal"] = proposal
    if json_mode:
        _print_json(payload)
    else:
        print(f"{todo.title} -> done")
        if propose_reply and "proposal" in payload:
            if "error" in payload["proposal"]:
                print(f"  proposal failed: {payload['proposal']['error']}")
            else:
                ch = payload["proposal"]["action"]["channel"]
                print(f"  proposed reply on {ch}")
    return 0


async def _try_propose(
    principal: Principal,
    todo: Any,
    outcome: Optional[str],
) -> Optional[dict[str, Any]]:
    """Raise an FG-10 approval for a reply, best-effort (never raises)."""
    from hermes_cli.todo_notifier import default_stores
    from hermes_cli.todo_outbound import OutboundError, parse_action, propose

    arrival = await _source_item(principal, todo)
    body = outcome or "(completed)"
    try:
        action = parse_action({"body": body}, arrival=arrival)
    except OutboundError as exc:
        return {"error": str(exc)}
    try:
        todo_store, notifications = default_stores()
        proposal = await propose(
            todo_store, notifications, principal, todo, action
        )
    except Exception:
        return {"error": "the outgoing action could not be proposed"}
    return proposal.as_dict()


async def _snooze(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    until: datetime,
    json_mode: bool,
) -> int:
    todo = await store.snooze(
        principal, todo_id, until=until, actor=f"user:{principal.user_id}"
    )
    if json_mode:
        _print_json(todo.as_dict())
    else:
        print(f"{todo.title} snoozed until {until.isoformat()}")
    return 0


async def _expire(
    store: TodoStore,
    principal: Principal,
    days: int,
    dry_run: bool,
    json_mode: bool,
) -> int:
    if dry_run:
        items, _ = await store.list(
            principal, stages=["staged"], limit=200
        )
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        count = sum(
            1 for t in items if t.updated_at and t.updated_at < cutoff
        )
        if json_mode:
            _print_json({"would_dismiss": count, "dry_run": True})
        else:
            print(f"{count} staged to-do(s) would be dismissed (dry run).")
        return 0
    count = await store.expire_staged(principal, older_than_days=days)
    if json_mode:
        _print_json({"dismissed": count})
    else:
        print(f"Dismissed {count} staged to-do(s).")
    return 0


# ---------------------------------------------------------------------------
# start — the session spawn (Part 1.2)
# ---------------------------------------------------------------------------

async def _start(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    *,
    want_session: bool,
    json_mode: bool,
) -> int:
    """Move to ``working`` and optionally spawn a seeded session."""
    todo = await store.set_stage(
        principal, todo_id, "working",
        actor=f"user:{principal.user_id}",
    )
    payload = todo.as_dict()

    if not want_session:
        payload["session_id"] = None
        payload["spawned"] = False
        if json_mode:
            _print_json(payload)
        else:
            print(f"{todo.title} -> working")
        return 0

    # Build the seed prompt and spawn on a detached thread.
    import contextvars
    import threading
    from datetime import datetime, timezone

    prompt_parts = [f"# {todo.title}"]
    if todo.description:
        prompt_parts.append(todo.description)
    if todo.source_note:
        prompt_parts.append(f"(From {todo.source_note})")
    arrival = await _source_item(principal, todo)
    if arrival and arrival.get("body"):
        prompt_parts.append(f"\n---\nSource message:\n{arrival['body'][:2000]}")
    prompt = "\n\n".join(prompt_parts)

    _session_id = (
        f"todo_{todo_id}_"
        f"{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
    )

    from hermes_constants import get_hermes_home
    _profile_home = str(get_hermes_home())
    _ctx = contextvars.copy_context()

    def _spawn():
        from agent.seeded_session import spawn_seeded_session
        spawn_seeded_session(
            prompt,
            origin="todo",
            session_id=_session_id,
            profile_home=_profile_home,
            skip_memory=False,
            context=_ctx,
            trusted_local=True,
        )

    # The CLI is the foreground — join the thread so the interpreter
    # doesn't tear it down on exit. Only the HTTP /start endpoint detaches.
    _thread = threading.Thread(target=_spawn)
    _thread.start()
    _thread.join()

    payload["session_id"] = _session_id
    payload["spawned"] = True
    if json_mode:
        _print_json(payload)
    else:
        print(f"{todo.title} -> working (session {_session_id})")
    return 0


# ---------------------------------------------------------------------------
# send — the verb the shipped code already names (Part 1.1b)
# ---------------------------------------------------------------------------

#: Exit codes for the send gate (distinct from 0/1/2 so a script can tell).
_SEND_PENDING = 3
_SEND_MISSING = 4
_SEND_DENIED = 5
_SEND_ROUTING = 6


async def _send(
    store: TodoStore,
    principal: Principal,
    todo_id: str,
    *,
    channel: str,
    target: str,
    account: Optional[str],
    thread: Optional[str],
    subject: Optional[str] = None,
    json_mode: bool = False,
) -> int:
    """Deliver an approved outgoing action.

    The body comes from the approval row, never from argv: a body on the
    command line would let an approved routing decision carry unapproved text.
    """
    from hermes_cli.human_comms import NotificationStore

    notifications = NotificationStore(store._store)
    dedupe_key = f"todo-action:{todo_id}"
    approval = await notifications.get_by_dedupe_key(dedupe_key, principal)

    if approval is None:
        msg = f"No outgoing approval for to-do {todo_id}."
        if json_mode:
            _print_json({"error": msg})
        else:
            print(msg, file=sys.stderr)
        return _SEND_MISSING
    if approval.is_pending:
        msg = f"Approval for to-do {todo_id} is still pending."
        if json_mode:
            _print_json({"error": msg})
        else:
            print(msg, file=sys.stderr)
        return _SEND_PENDING
    if not approval.granted:
        msg = f"Approval for to-do {todo_id} was denied."
        if json_mode:
            _print_json({"error": msg})
        else:
            print(msg, file=sys.stderr)
        return _SEND_DENIED

    # Require the routing in argv to match the approval's command.
    cmd_parts = shlex.split(approval.command)
    cmd_routing = _parse_command_routing(cmd_parts)
    if cmd_routing is None:
        msg = "Could not parse the approval's command."
        if json_mode:
            _print_json({"error": msg, "command": approval.command})
        else:
            print(msg, file=sys.stderr)
        return _SEND_MISSING

    mismatches: list[str] = []
    if cmd_routing["channel"] != channel:
        mismatches.append("channel")
    if cmd_routing["target"] != target:
        mismatches.append("target")
    if (cmd_routing["account"] or None) != (account or None):
        mismatches.append("account")
    if (cmd_routing["thread"] or None) != (thread or None):
        mismatches.append("thread")
    if (cmd_routing.get("subject") or None) != (subject or None):
        mismatches.append("subject")
    if mismatches:
        msg = (
            f"Routing does not match the approved action "
            f"({', '.join(mismatches)})."
        )
        if json_mode:
            _print_json({"error": msg, "approved": cmd_routing})
        else:
            print(msg, file=sys.stderr)
        return _SEND_ROUTING

    # The routing checked out — the shared executor does the rest (body from
    # the approval row, replay guard, account-aware delivery, audit).
    from hermes_cli.todo_outbound import execute_proposal

    outcome = await execute_proposal(store, principal, todo_id)

    if json_mode:
        _print_json(outcome)
    else:
        if outcome.get("event") == "sent":
            print(f"Sent on {channel}.")
        elif outcome.get("event") == "failed":
            print(
                f"Failed: {outcome.get('result', {}).get('error', 'unknown')}",
                file=sys.stderr,
            )
        else:
            print(outcome.get("detail") or outcome.get("error"), file=sys.stderr)
    if outcome.get("event") == "sent":
        return 0
    return _SEND_MISSING if outcome.get("error") else 1


# Kept as an alias — the implementation moved to
# ``todo_outbound.parse_command_routing`` so the web approval path and this
# verb parse the same command the same way (``--subject`` included).
from hermes_cli.todo_outbound import (  # noqa: E402
    parse_command_routing as _parse_command_routing,
)


# ---------------------------------------------------------------------------
# backfill — replay old pipeline task rows into the to-do store (Q4)
# ---------------------------------------------------------------------------

_TRIAGE_PRIORITY_MAP = {
    "critical": "critical",
    "urgent": "critical",
    "high": "high",
    "medium": "normal",
    "normal": "normal",
    "low": "low",
}


async def _backfill(
    store: TodoStore,
    principal: Principal,
    *,
    since: Optional[str],
    db_path: str,
    dry_run: bool,
    json_mode: bool,
) -> int:
    """Replay old ``wa_tasks``/``email_tasks`` rows as to-dos.

    Those rows were extracted under a bar that did not exist; the default is
    *start empty* (Q4). This command is the deliberate, dated sweep that
    remains available.
    """
    try:
        conn = sqlite3.connect(
            f"file:{db_path}?mode=ro", uri=True, timeout=30
        )
        conn.row_factory = sqlite3.Row
        if _os.path.exists(_EMAIL_DB_PATH):
            conn.execute(
                "ATTACH DATABASE ? AS emaildb",
                (f"file:{_EMAIL_DB_PATH}?mode=ro",),
            )
    except sqlite3.OperationalError as exc:
        print(f"Cannot open {db_path}: {exc}", file=sys.stderr)
        return 1

    bound = since
    total = 0
    tables = ("wa_tasks", "email_tasks")
    try:
        for table in tables:
            has = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if not has:
                continue

            sql = f"SELECT * FROM {table}"
            params: list[Any] = []
            if bound:
                sql += " WHERE created_at >= ?"
                params.append(bound)
            sql += " ORDER BY created_at"

            count = 0
            for row in conn.execute(sql, params):
                if not row["description"]:
                    continue
                count += 1
                if dry_run:
                    continue
                priority = _TRIAGE_PRIORITY_MAP.get(
                    str(row["priority"] or "").strip().lower(), "normal"
                )
                due_at = _when(row["due_date"], field="due_date")
                source_note = None
                if table == "wa_tasks":
                    phone = row["source_phone"] or ""
                    source_note = f"whatsapp:{phone}" if phone else "whatsapp"
                else:
                    acct = row["account_id"] or ""
                    source_note = f"email:{acct}" if acct else "email"

                await store.create(
                    principal,
                    title=str(row["description"]),
                    stage="staged",
                    priority=priority,
                    due_at=due_at,
                    source_kind="inbound",
                    source_note=source_note,
                    origin="triage",
                    actor="system:backfill",
                )
            label = "would be " if dry_run else ""
            print(f"{table}: {count} task(s) {label}imported")
            total += count
    finally:
        conn.close()

    if json_mode:
        _print_json(
            {"imported": total, "dry_run": dry_run}
        )
    else:
        suffix = " (dry run)" if dry_run else ""
        print(f"{total} task(s) imported{suffix}.")
    return 0


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------

def _run(coro) -> int:
    try:
        return asyncio.run(coro)
    except (TodoError, PermissionError, RuntimeError, ValueError) as error:
        print(f"{error}", file=sys.stderr)
        return 1


async def _dispatch(args: argparse.Namespace) -> int:
    actor = args.actor
    store, principal = await _resolve(actor)
    action = args.todos_command

    if action == "list":
        return await _list(
            store,
            principal,
            stages=_csv(args.stage) or None,
            priorities=_csv(args.priority) or None,
            source_kinds=_csv(args.source_kind) or None,
            query=args.q or None,
            limit=args.limit,
            json_mode=args.json,
        )
    if action == "show":
        return await _show(
            store, principal, args.todo_id, json_mode=args.json
        )
    if action == "add":
        return await _add(
            store,
            principal,
            title=args.title,
            description=args.why or "",
            priority=args.priority,
            due_at=_when(args.due, field="due"),
            stage=args.stage,
            json_mode=args.json,
        )
    if action == "stage":
        return await _stage(
            store,
            principal,
            args.todo_id,
            args.new_stage,
            outcome=args.outcome,
            json_mode=args.json,
        )
    if action == "done":
        return await _done(
            store,
            principal,
            args.todo_id,
            outcome=args.outcome,
            propose_reply=args.propose_reply,
            json_mode=args.json,
        )
    if action == "start":
        return await _start(
            store,
            principal,
            args.todo_id,
            want_session=args.session,
            json_mode=args.json,
        )
    if action == "snooze":
        until = _when(args.until, field="until")
        if until is None:
            print("--until is required and must be an ISO timestamp.", file=sys.stderr)
            return 2
        return await _snooze(
            store, principal, args.todo_id, until, json_mode=args.json
        )
    if action == "facets":
        return await _facets(store, principal, json_mode=args.json)
    if action == "expire":
        return await _expire(
            store,
            principal,
            days=args.days,
            dry_run=args.dry_run,
            json_mode=args.json,
        )
    if action == "send":
        return await _send(
            store,
            principal,
            args.todo_id,
            channel=args.channel,
            target=args.to,
            account=args.account,
            thread=args.thread,
            subject=args.subject,
            json_mode=args.json,
        )
    if action == "backfill":
        return await _backfill(
            store,
            principal,
            since=args.since,
            db_path=args.db,
            dry_run=args.dry_run,
            json_mode=args.json,
        )
    print(f"Unknown todos action: {action}", file=sys.stderr)
    return 2


def todos_command(args: argparse.Namespace) -> int:
    return _run(_dispatch(args))


def register_todos_subparser(
    subparsers: argparse._SubParsersAction,
) -> None:
    """Register ``hermes todos`` beside ``incomings`` and ``goal``."""
    parser = subparsers.add_parser(
        "todos",
        help="To-dos: the staging layer between what arrives and what gets done",
        description=(
            "The to-do list behind /todos. Triage extracts action items from "
            "arrivals; this is the operator surface — read, add, promote, "
            "finish, and send the replies an approval authorized."
        ),
    )
    parser.add_argument(
        "--actor",
        default=None,
        help="Principal to act as (default: the enrolled owner)",
    )
    sub = parser.add_subparsers(dest="todos_command", required=True)

    # -- reads -------------------------------------------------------------

    listing = sub.add_parser("list", help="A page of to-dos, newest first")
    listing.add_argument(
        "--stage",
        default="",
        help=f"Comma-separated subset of {', '.join(TODO_STAGES)}",
    )
    listing.add_argument(
        "--priority", default="", help="Comma-separated priority filter"
    )
    listing.add_argument(
        "--source-kind", default="", help="Comma-separated source filter"
    )
    listing.add_argument("-q", "--q", default="", help="Text search")
    listing.add_argument("--limit", type=int, default=50, help="Page size")
    listing.add_argument(
        "--json", action="store_true", help="Machine-readable JSON output"
    )

    show = sub.add_parser("show", help="One to-do + history + the source arrival")
    show.add_argument("todo_id")
    show.add_argument("--json", action="store_true")

    facets = sub.add_parser("facets", help="Counts per stage / priority / source")
    facets.add_argument("--json", action="store_true")

    # -- writes ------------------------------------------------------------

    add = sub.add_parser("add", help="Create a to-do")
    add.add_argument("title", help="What needs deciding")
    add.add_argument("--why", default="", help="Longer description")
    add.add_argument(
        "--priority",
        default="normal",
        choices=list(TODO_PRIORITIES),
    )
    add.add_argument("--due", default=None, help="ISO date or timestamp")
    add.add_argument(
        "--stage", default="open", choices=["staged", "open"]
    )
    add.add_argument("--json", action="store_true")

    stage = sub.add_parser("stage", help="Move a to-do along its lifecycle")
    stage.add_argument("todo_id")
    stage.add_argument(
        "new_stage", choices=list(TODO_STAGES), help="Target stage"
    )
    stage.add_argument("--outcome", default=None, help="Recorded on the transition")
    stage.add_argument("--json", action="store_true")

    done = sub.add_parser("done", help="Finish a to-do, optionally proposing a reply")
    done.add_argument("todo_id")
    done.add_argument("--outcome", default=None, help="What was resolved")
    done.add_argument(
        "--propose-reply",
        action="store_true",
        help="Raise an FG-10 approval for an outgoing reply",
    )
    done.add_argument("--json", action="store_true")

    start = sub.add_parser(
        "start",
        help="Move to working, optionally spawning a session",
    )
    start.add_argument("todo_id")
    start.add_argument(
        "--session",
        action="store_true",
        help="Spawn a seeded agent session for this to-do",
    )
    start.add_argument("--json", action="store_true")

    snooze = sub.add_parser("snooze", help="Hide a to-do until a chosen moment")
    snooze.add_argument("todo_id")
    snooze.add_argument("--until", required=True, help="ISO timestamp")
    snooze.add_argument("--json", action="store_true")

    expire = sub.add_parser("expire", help="Dismiss staged to-dos nobody touched")
    expire.add_argument("--days", type=int, default=DEFAULT_STAGED_EXPIRY_DAYS)
    expire.add_argument("--dry-run", action="store_true")
    expire.add_argument("--json", action="store_true")

    # -- send (Part 1.1b) --------------------------------------------------

    send = sub.add_parser(
        "send",
        help="Deliver an approved outgoing action for this to-do",
        description=(
            "The body comes from the approval row, never from argv. The "
            "routing must match what was approved. A pending or denied "
            "approval refuses."
        ),
    )
    send.add_argument("todo_id")
    send.add_argument("--channel", required=True, help="Egress platform")
    send.add_argument("--to", required=True, help="Target conversation")
    send.add_argument("--account", default=None, help="Sending account id")
    send.add_argument("--thread", default=None, help="Thread id")
    send.add_argument("--subject", default=None, help="Message subject (email)")
    send.add_argument("--json", action="store_true")

    # -- backfill (Q4) -----------------------------------------------------

    backfill = sub.add_parser(
        "backfill",
        help="Replay old pipeline task rows as to-dos",
        description=(
            "The default is start-empty (Q4): old rows were extracted under a "
            "bar that did not exist. This is the deliberate, dated sweep."
        ),
    )
    backfill.add_argument(
        "--since",
        default=None,
        help="Only rows at or after this time (ISO or YYYY-MM-DD)",
    )
    backfill.add_argument(
        "--db",
        default=DEFAULT_DB_PATH,
        help=f"Pipeline SQLite path (default: {DEFAULT_DB_PATH})",
    )
    backfill.add_argument("--dry-run", action="store_true")
    backfill.add_argument("--json", action="store_true")

    parser.set_defaults(func=todos_command)


__all__ = ["todos_command", "register_todos_subparser"]
