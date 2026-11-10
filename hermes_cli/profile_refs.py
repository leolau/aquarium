"""Short refs for profile-scoped items: ``D88`` to-dos and ``M512`` inbox
messages (FG-36 PR 3).

To-dos (``tasks``) and inbox messages (``inbound_items``) live in each
profile's own Postgres schema, so their registry rows record the profile.
This module is the glue between those async stores and the sync
:mod:`hermes_cli.short_refs` registry:

* :func:`assign` — called by the stores' create paths after the row exists;
* :func:`attach` — lazy ``ensure_refs`` for list/detail payloads;
* :func:`search_target` — a ref typed into a list's search box;
* :func:`resolve_sync` — the ``/api/refs/{ref}`` branch, which re-derives the
  caller's authority **in the ref's profile** and reads through the store's
  own C2-scoped ``get``. Invisible and absent are the same ``None``.
* :func:`todo_items` / :func:`message_items` — the creation-order backfill
  sources, read across every profile on the box.

Registry failures never fail the surrounding create or read: an item without
a ref gets one on its next read.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextvars
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Iterable, Optional, TypeVar
from urllib.parse import quote

from hermes_cli import short_refs

logger = logging.getLogger(__name__)

TODO = "D"
MESSAGE = "M"

#: The verified login subject of the request resolving a ref (``""`` for a
#: sessionless caller), set by ``refs_api`` and read here when the ref lives
#: in another profile than the acting one.
CALLER_SUBJECT: contextvars.ContextVar[str] = contextvars.ContextVar(
    "short_refs_caller_subject", default=""
)

_T = TypeVar("_T")


# ---------------------------------------------------------------------------
# Profile helpers
# ---------------------------------------------------------------------------


def _profile_homes() -> list[tuple[str, Path]]:
    from hermes_cli.profiles import profiles_to_serve

    return [(name, Path(home)) for name, home in profiles_to_serve(multiplex=True)]


def current_profile() -> str:
    """The profile name of the scope this code runs in (``HERMES_HOME``)."""
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home()).resolve()
    try:
        for name, profile_home in _profile_homes():
            if profile_home.resolve() == home:
                return name
    except Exception:  # pragma: no cover - defensive
        logger.debug("short refs: profile list unavailable", exc_info=True)
    from hermes_cli.profiles import get_active_profile_name

    return get_active_profile_name() or "default"


def _profile_home(name: str) -> Optional[Path]:
    for profile, home in _profile_homes():
        if profile == name and home.is_dir():
            return home
    return None


def _epoch(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return int(value.timestamp())
    if isinstance(value, (int, float)):
        return int(value)
    try:
        return int(datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def _run(coro: Awaitable[_T]) -> _T:
    """Run ``coro`` to completion from sync code, inside or outside a loop.

    A fresh thread keeps this safe when the caller's thread already runs an
    event loop; :mod:`hermes_cli.db_pool` hands out pooled connections from
    its own loop, so the separate loop is fine for the stores.
    """
    ctx = contextvars.copy_context()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(ctx.run, asyncio.run, coro).result()


# ---------------------------------------------------------------------------
# Assignment and payloads
# ---------------------------------------------------------------------------


async def assign(kind: str, internal_id: str, created_at: Any = None) -> Optional[str]:
    """Number a just-created item in the current profile; never raises."""
    try:
        profile = current_profile()
        return await asyncio.to_thread(
            short_refs.assign_quietly,
            kind,
            str(internal_id),
            created_at=_epoch(created_at),
            profile=profile,
        )
    except Exception:  # pragma: no cover - defensive: the create already happened
        logger.warning("short refs: could not assign %s ref", kind, exc_info=True)
        return None


async def attach(
    kind: str, payloads: Iterable[dict[str, Any]], *, created_key: str
) -> list[dict[str, Any]]:
    """Add ``ref`` to each payload (an item dict with ``id``), in place."""
    rows = list(payloads)
    if not rows:
        return rows
    try:
        profile = current_profile()
        items = [
            short_refs.RefItem(str(p["id"]), _epoch(p.get(created_key)), profile)
            for p in rows
            if p.get("id")
        ]
        refs = await asyncio.to_thread(short_refs.ensure_refs_quietly, kind, items)
    except Exception:  # pragma: no cover - defensive
        logger.warning("short refs: could not read %s refs", kind, exc_info=True)
        refs = {}
    for p in rows:
        p["ref"] = refs.get(str(p.get("id")))
    return rows


async def search_target(kind: str, query: str) -> tuple[bool, Optional[str]]:
    """Whether ``query`` is a ref of ``kind``, and the internal id it names
    in the current profile (``None`` when it names nothing here)."""
    parsed = short_refs.parse_ref(query)
    if parsed is None or parsed.kind != kind or parsed.run_no is not None:
        return False, None
    try:
        record = await asyncio.to_thread(short_refs.lookup, parsed.base)
    except Exception:
        logger.warning("short refs: lookup of %s failed", parsed.base, exc_info=True)
        return True, None
    if record is None or record.profile != current_profile():
        return True, None
    return True, record.internal_id


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


async def _principal_here(identity: str):
    """The caller's live principal in the currently scoped profile, or None."""
    from hermes_cli.access import PrincipalStore
    from hermes_cli.web_server import _comms_app_store

    if not identity:
        return None
    store = PrincipalStore(_comms_app_store())
    user_id = (await store.resolve_alias(identity)) or identity
    principal = await store.get(user_id)
    if principal is None or not getattr(principal, "active", True):
        return None
    return principal


async def _read_todo(principal, todo_id: str) -> Optional[dict[str, Any]]:
    from hermes_cli.todo_store import default_store

    todo = await default_store().get(principal, todo_id)
    if todo is None:
        return None
    return {
        "kind": "todo",
        "id": todo.id,
        "title": todo.title,
        "status": todo.stage,
        "url": f"/todos/{quote(todo.id, safe='')}",
    }


async def _read_message(principal, item_id: str) -> Optional[dict[str, Any]]:
    from hermes_cli.inbound_registry import default_registry

    item = await default_registry().get(principal, item_id)
    if item is None:
        return None
    title = (
        (item.subject or "").strip()
        or (item.sender_name or "").strip()
        or (item.sender_id or "").strip()
        or "(untitled)"
    )
    return {
        "kind": "message",
        "id": item.id,
        "title": title,
        "status": item.surface,
        "url": f"/inbox/{quote(item.id, safe='')}",
    }


_READERS = {TODO: _read_todo, MESSAGE: _read_message}


async def resolve(record: short_refs.RefRecord, principal, subject: str = "") -> Optional[dict]:
    """``record`` as ``principal`` sees it, checked in ``record.profile``.

    In the acting profile the caller's principal is used as-is (the same one
    the to-do / inbox routes use). In another profile the caller is
    re-resolved there — verified subject first, else the principal's user id —
    and must hold a live enrolment; never that profile's owner.
    """
    reader = _READERS.get(record.kind)
    if reader is None or not record.profile:
        return None
    from hermes_cli.console_scope import _scoped_to

    acting = current_profile()
    home = _profile_home(record.profile)
    if home is None:
        return None
    with _scoped_to(home):
        try:
            who = (
                principal
                if record.profile == acting
                else await _principal_here(subject or principal.user_id)
            )
            if who is None:
                return None
            found = await reader(who, record.internal_id)
        except Exception:
            logger.warning("short refs: could not resolve %s", record.ref, exc_info=True)
            return None
    if found is None:
        return None
    return {"ref": record.ref, **found, "profile": record.profile}


def resolve_sync(parsed, record, principal, enrolled) -> Optional[dict]:
    """``refs_api.RESOLVERS`` entry for D and M."""
    return _run(resolve(record, principal, CALLER_SUBJECT.get()))


# ---------------------------------------------------------------------------
# Backfill sources — every profile's rows, oldest first
# ---------------------------------------------------------------------------

_BACKFILL_READER = "short-refs-backfill"


async def _profile_rows(kind: str) -> list[tuple[str, Any]]:
    """``(id, created)`` for every row of ``kind`` in the scoped profile."""
    from hermes_cli.access import Principal, bind_principal

    if kind == TODO:
        from hermes_cli.todo_store import TASKS_TABLE, default_store

        store, table, created = default_store(), TASKS_TABLE, "created_at"
    else:
        from hermes_cli.inbound_registry import INBOUND_ITEMS_TABLE, default_registry

        store, table, created = default_registry(), INBOUND_ITEMS_TABLE, "registered_at"
    conn = await store._connect()  # noqa: SLF001 - same package
    try:
        has_column = await conn.fetchval(
            """SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = $1 AND column_name = $2""",
            table,
            "stage" if kind == TODO else created,
        )
        if has_column is None:
            return []
        async with conn.transaction():
            # The registry numbers every row, whoever may see it; FORCEd RLS
            # only shows them all to an owner-role binding.
            await bind_principal(
                conn, Principal(user_id=_BACKFILL_READER, display=_BACKFILL_READER, role="owner")
            )
            rows = await conn.fetch(f"SELECT id, {created} AS created FROM {table}")
    finally:
        await conn.close()
    return [(str(r["id"]), r["created"]) for r in rows]


def _items_for(kind: str) -> list[short_refs.RefItem]:
    from hermes_cli.console_scope import _scoped_to

    items: list[short_refs.RefItem] = []
    for profile, home in _profile_homes():
        if not home.is_dir():
            continue

        async def _read(home=home):
            with _scoped_to(home):
                return await _profile_rows(kind)

        try:
            rows = _run(_read())
        except Exception:
            logger.warning(
                "short refs: %s backfill skipped profile %r", kind, profile, exc_info=True
            )
            continue
        items.extend(short_refs.RefItem(iid, _epoch(created), profile) for iid, created in rows)
    return items


def todo_items(projects_path: Optional[Path] = None) -> list[short_refs.RefItem]:
    return _items_for(TODO)


def message_items(projects_path: Optional[Path] = None) -> list[short_refs.RefItem]:
    return _items_for(MESSAGE)
