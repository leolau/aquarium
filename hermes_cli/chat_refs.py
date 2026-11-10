"""Chat short refs (``C1024``, FG-36 PR 2).

A chat is a **conversation**, not a ``sessions`` row: compression ends a row
and continues the conversation under a new session id (``parent_session_id``
→ the compressed row). The registry therefore keys a ``C`` ref on the
conversation's compression root (:meth:`SessionDB.get_compression_root`) and
the resolver walks forward to the live tip (:meth:`get_compression_tip`), the
same projection the chat list uses. A branch is its own conversation and gets
its own ref; delegate subagent runs and tool children are not chats.

Sessions live in each profile's ``state.db``, so a ``C`` row records its
profile. Numbers stay box-wide like every other kind.

Assignment: ``POST /api/sessions`` (agent-home's new chat) assigns at create;
every other creation path (gateway, CLI, cron, project runs, to-dos) gets its
number lazily from the list/detail reads (``ensure_refs``), and existing
chats are numbered by the one-time backfill in ``started_at`` order.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path
from typing import Iterable, Optional

from hermes_cli import short_refs
from hermes_cli.short_refs import RefItem

logger = logging.getLogger(__name__)


def profile_homes() -> list[tuple[str, Path]]:
    """``(name, HERMES_HOME)`` of every profile on the box."""
    from hermes_cli.profile_registry import get_profile_registry

    try:
        return [(e.name, Path(e.hermes_home)) for e in get_profile_registry()]
    except Exception:
        logger.warning("chat_refs: profile registry unavailable", exc_info=True)
        from hermes_constants import get_hermes_home

        return [("default", Path(get_hermes_home()))]


def acting_profile_name() -> str:
    """The name of the profile this process serves (its ``HERMES_HOME``)."""
    from hermes_constants import get_hermes_home

    here = Path(get_hermes_home()).resolve()
    for name, home in profile_homes():
        try:
            if home.resolve() == here:
                return name
        except OSError:
            continue
    return "default"


def profile_home(name: str) -> Optional[Path]:
    return next((home for n, home in profile_homes() if n == name), None)


def open_db(profile: str):
    """A ``SessionDB`` on ``profile``'s ``state.db``, or ``None``."""
    from hermes_state import SessionDB

    home = profile_home(profile)
    if home is None or not (home / "state.db").exists():
        return None
    return SessionDB(db_path=home / "state.db")


def _root_conversations(db_path: Path) -> list[tuple[str, Optional[float]]]:
    """Every chat in one ``state.db``: listable rows minus delegate runs."""
    from hermes_state import _LISTABLE_CHILD_SQL, _delegate_from_json

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    try:
        return conn.execute(
            f"SELECT s.id, s.started_at FROM sessions s "
            f"WHERE {_LISTABLE_CHILD_SQL} "
            f"AND {_delegate_from_json('s.model_config')} IS NULL "
            f"AND COALESCE(s.source, '') != 'tool'"
        ).fetchall()
    finally:
        conn.close()


def backfill_items(projects_path: Optional[Path] = None) -> list[RefItem]:
    """``BACKFILL_SOURCES["C"]``: every profile's chats, by ``started_at``."""
    items: list[RefItem] = []
    for name, home in profile_homes():
        db_path = home / "state.db"
        if not db_path.exists():
            continue
        try:
            for sid, started in _root_conversations(db_path):
                items.append(RefItem(sid, int(started) if started else None, profile=name))
        except Exception:
            logger.warning("chat_refs: backfill skipped profile %r", name, exc_info=True)
    return items


def _created(value) -> Optional[int]:
    try:
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def attach_refs(rows: Iterable[dict], profile: str) -> None:
    """Set ``row["ref"]`` on chat-list rows (one batch; never fails the list).

    A projected compression row carries ``_lineage_root_id``; any other row
    is its own root.
    """
    rows = [r for r in rows if isinstance(r, dict) and r.get("id")]
    if not rows:
        return
    roots = {id(r): str(r.get("_lineage_root_id") or r["id"]) for r in rows}
    refs = short_refs.ensure_refs_quietly(
        "C",
        [RefItem(roots[id(r)], _created(r.get("started_at")), profile=profile) for r in rows],
    )
    for r in rows:
        r["ref"] = refs.get(roots[id(r)])


def ref_for_session(db, session_id: str, profile: str) -> Optional[str]:
    """The ref of the conversation ``session_id`` belongs to (any segment)."""
    try:
        root = db.get_compression_root(session_id)
        row = db.get_session(root) or {}
    except Exception:
        logger.warning("chat_refs: could not walk %s", session_id, exc_info=True)
        return None
    return short_refs.ensure_refs_quietly(
        "C", [RefItem(root, _created(row.get("started_at")), profile=profile)]
    ).get(root)


def assign_new(session_id: str, profile: str) -> Optional[str]:
    """Number a chat at create; a registry failure costs only the badge."""
    return short_refs.assign_quietly("C", session_id, profile=profile)
