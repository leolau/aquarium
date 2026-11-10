"""Short refs: box-unique, typeable handles for the things people talk about.

``P12`` a project, ``T345`` a project card, ``P12-R3`` run 3 of P12,
``C1024`` a chat, ``D88`` a to-do, ``M512`` an inbox message. A ref is a
type letter plus a running number that is unique per kind on the box. It is a
display handle on top of the internal ids (project id/slug, ``t_xxxxxxxx``
task ids, session ids, UUIDs), which stay authoritative everywhere; a ref is
assigned once and never changes, even when the item is renamed.

Runs (``R``) have no registry rows: ``P12-R3`` is the project's ref plus the
existing ``project_runs.run_no``.

The registry is one SQLite file next to ``projects.db`` in the shared root
(``short_refs.db``), because projects and kanban are box-wide and every
process on the box (dashboard, gateway, cron, CLI) must agree on a number.
Allocation is ``MAX(num)+1`` inside an IMMEDIATE transaction, so concurrent
writers serialise on SQLite's write lock and never hand out the same number.

Chats, to-dos and inbox messages are per profile: their rows record the
profile so a resolver can check authority in that profile. Projects and
cards are box-wide (``profile`` is ``""``); a card's row records the board
slug its project names (``""`` = the project's default board resolution).

Items are numbered in creation order: the first touch of a kind runs a
one-time backfill over the kind's existing items, oldest first. Items made
by paths that don't call :func:`assign` get a number lazily the next time a
list/detail read calls :func:`ensure_refs`.

Design note: docs/design/master-plan/feature-groups/FG-36-short-refs.md.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Optional

from hermes_cli.sqlite_util import write_txn

logger = logging.getLogger(__name__)

#: kind letter → (name, profile-scoped?)
KINDS: dict[str, tuple[str, bool]] = {
    "P": ("project", False),
    "T": ("card", False),
    "C": ("chat", True),
    "D": ("todo", True),
    "M": ("message", True),
}

#: The derived run suffix: ``P12-R3``.
RUN_KIND = "R"

REGISTRY_FILENAME = "short_refs.db"

_REF_RE = re.compile(r"^\s*([A-Za-z])([1-9][0-9]{0,8})(?:-[Rr]([1-9][0-9]{0,8}))?\s*$")

#: A ref anywhere in free text (search boxes, chat turns): word-bounded so
#: ``MP3`` or ``T1000x`` never match.
REF_IN_TEXT_RE = re.compile(r"(?<![A-Za-z0-9_-])([PTCDMptcdm][1-9][0-9]{0,8}(?:-[Rr][1-9][0-9]{0,8})?)(?![A-Za-z0-9_])")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS short_refs (
    kind         TEXT    NOT NULL,
    num          INTEGER NOT NULL,
    internal_id  TEXT    NOT NULL,
    profile      TEXT    NOT NULL DEFAULT '',
    board        TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER,
    assigned_at  INTEGER NOT NULL,
    PRIMARY KEY (kind, num),
    UNIQUE (kind, profile, board, internal_id)
);

CREATE INDEX IF NOT EXISTS idx_short_refs_item
    ON short_refs(kind, internal_id);

CREATE TABLE IF NOT EXISTS short_ref_backfills (
    kind     TEXT PRIMARY KEY,
    done_at  INTEGER NOT NULL
);
"""


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParsedRef:
    kind: str
    num: int
    #: Set only for ``P12-R3``.
    run_no: Optional[int] = None

    @property
    def base(self) -> str:
        return format_ref(self.kind, self.num)

    def __str__(self) -> str:
        return self.base if self.run_no is None else run_ref(self.base, self.run_no)


def parse_ref(text: str) -> Optional[ParsedRef]:
    """``"p12"`` → ``ParsedRef("P", 12)``; ``"P12-R3"`` adds ``run_no=3``.

    Case-insensitive; no leading zeros (``P012`` is not a ref); a run suffix
    only follows a project. Anything else is ``None``.
    """
    m = _REF_RE.match(str(text or ""))
    if not m:
        return None
    kind = m.group(1).upper()
    if kind not in KINDS:
        return None
    run = m.group(3)
    if run is not None and kind != "P":
        return None
    return ParsedRef(kind, int(m.group(2)), int(run) if run else None)


def format_ref(kind: str, num: int) -> str:
    return f"{kind}{int(num)}"


def run_ref(project_ref: Optional[str], run_no: Optional[int]) -> Optional[str]:
    """``("P12", 3)`` → ``"P12-R3"``; ``None`` when either part is missing."""
    if not project_ref or not run_no:
        return None
    return f"{project_ref}-R{int(run_no)}"


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def registry_path(projects_path: Optional[Path] = None) -> Path:
    """``short_refs.db`` beside the projects DB (default: the shared root's)."""
    if projects_path is None:
        from hermes_cli.projects_db import projects_db_path

        projects_path = projects_db_path()
    return Path(projects_path).with_name(REGISTRY_FILENAME)


def projects_path_of(conn: sqlite3.Connection) -> Optional[Path]:
    """The file behind a projects-DB connection (``None`` for ``:memory:``)."""
    try:
        for row in conn.execute("PRAGMA database_list").fetchall():
            if row[1] == "main" and row[2]:
                return Path(row[2])
    except sqlite3.Error:
        pass
    return None


_INITIALIZED: set[str] = set()
_BACKFILLED: set[tuple[str, str]] = set()


def connect(projects_path: Optional[Path] = None) -> sqlite3.Connection:
    path = registry_path(projects_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30)
    try:
        conn.row_factory = sqlite3.Row
        from hermes_state import apply_wal_with_fallback

        apply_wal_with_fallback(conn, db_label=REGISTRY_FILENAME)
        conn.execute("PRAGMA busy_timeout=30000")
        key = str(path.resolve())
        if key not in _INITIALIZED:
            conn.executescript(SCHEMA_SQL)
            _INITIALIZED.add(key)
    except Exception:
        conn.close()
        raise
    return conn


def _check_kind(kind: str) -> str:
    k = str(kind or "").upper()
    if k not in KINDS:
        raise ValueError(f"unknown ref kind {kind!r}")
    return k


def _scope(kind: str, profile: Optional[str], board: Optional[str]) -> tuple[str, str]:
    """Normalise the ``(profile, board)`` key: a profile only for
    profile-scoped kinds, a board only for cards."""
    scoped = KINDS[kind][1]
    if scoped and not profile:
        raise ValueError(f"{KINDS[kind][0]} refs need the item's profile")
    return (str(profile) if scoped else "", str(board or "") if kind == "T" else "")


@dataclass(frozen=True)
class RefItem:
    """One item to number: its internal id and creation time (epoch s)."""

    internal_id: str
    created_at: Optional[int] = None
    profile: Optional[str] = None
    board: Optional[str] = None


@dataclass(frozen=True)
class RefRecord:
    ref: str
    kind: str
    num: int
    internal_id: str
    profile: Optional[str]
    board: Optional[str]


def _record(row) -> RefRecord:
    return RefRecord(
        ref=format_ref(row["kind"], row["num"]),
        kind=row["kind"],
        num=int(row["num"]),
        internal_id=row["internal_id"],
        profile=row["profile"] or None,
        board=row["board"] or None,
    )


def _existing(conn, kind: str, keys: list[tuple[str, str, str]]) -> dict[tuple[str, str, str], str]:
    out: dict[tuple[str, str, str], str] = {}
    ids = sorted({k[2] for k in keys})
    for start in range(0, len(ids), 500):
        chunk = ids[start : start + 500]
        marks = ",".join("?" * len(chunk))
        for row in conn.execute(
            f"SELECT num, internal_id, profile, board FROM short_refs "
            f"WHERE kind = ? AND internal_id IN ({marks})",
            (kind, *chunk),
        ):
            out[(row["profile"], row["board"], row["internal_id"])] = format_ref(kind, row["num"])
    return out


def _insert_missing(conn, kind: str, items: list[RefItem]) -> None:
    """Number ``items`` not yet in the registry, oldest first. Caller holds
    the write transaction."""
    keyed = []
    for it in items:
        profile, board = _scope(kind, it.profile, it.board)
        keyed.append(((profile, board, str(it.internal_id)), it))
    have = _existing(conn, kind, [k for k, _ in keyed])
    todo: dict[tuple[str, str, str], RefItem] = {}
    for key, it in keyed:
        if key not in have and key not in todo:
            todo[key] = it
    if not todo:
        return
    ordered = sorted(
        todo.items(),
        key=lambda kv: (kv[1].created_at is None, kv[1].created_at or 0, kv[0][2]),
    )
    top = conn.execute(
        "SELECT COALESCE(MAX(num), 0) AS m FROM short_refs WHERE kind = ?", (kind,)
    ).fetchone()["m"]
    now = int(time.time())
    for offset, ((profile, board, iid), it) in enumerate(ordered, start=1):
        conn.execute(
            "INSERT INTO short_refs "
            "(kind, num, internal_id, profile, board, created_at, assigned_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (kind, int(top) + offset, iid, profile, board, it.created_at, now),
        )


# ---------------------------------------------------------------------------
# Backfill — existing items, numbered in creation order, once per kind
# ---------------------------------------------------------------------------


def _project_items(projects_path: Optional[Path]) -> list[RefItem]:
    from hermes_cli import projects_db

    with projects_db.connect_closing(projects_path) as conn:
        rows = conn.execute("SELECT id, created_at FROM projects").fetchall()
    return [RefItem(r["id"], r["created_at"]) for r in rows]


def _card_items(projects_path: Optional[Path]) -> list[RefItem]:
    """Every project card on every board a project uses."""
    from hermes_cli import kanban_db, projects_db

    with projects_db.connect_closing(projects_path) as conn:
        boards = {
            r["board_slug"] or ""
            for r in conn.execute("SELECT DISTINCT board_slug FROM projects")
        }
    items: list[RefItem] = []
    for board in sorted(boards):
        try:
            with kanban_db.connect_closing(board=board or None) as bconn:
                for r in bconn.execute(
                    "SELECT id, created_at FROM tasks WHERE project_id IS NOT NULL"
                ):
                    items.append(RefItem(r["id"], r["created_at"], board=board))
        except Exception:
            logger.warning("short_refs: card backfill skipped board %r", board, exc_info=True)
    return items


def _todo_items(projects_path: Optional[Path]) -> list[RefItem]:
    """Every profile's to-dos (Postgres ``tasks``), via ``profile_refs``."""
    from hermes_cli.profile_refs import todo_items

    return todo_items(projects_path)


def _message_items(projects_path: Optional[Path]) -> list[RefItem]:
    """Every profile's inbox messages (``inbound_items``), via ``profile_refs``."""
    from hermes_cli.profile_refs import message_items

    return message_items(projects_path)


#: Existing-item sources per kind. Chats (C) add theirs when they are wired.
BACKFILL_SOURCES: dict[str, Callable[[Optional[Path]], list[RefItem]]] = {
    "P": _project_items,
    "T": _card_items,
    "D": _todo_items,
    "M": _message_items,
}


def backfill(kind: str, *, projects_path: Optional[Path] = None, force: bool = False) -> int:
    """Number the kind's existing items in creation order, once.

    Returns how many refs were added. Sources are read outside the write
    lock; the marker is re-checked under it, so two processes racing here
    number every item exactly once.
    """
    kind = _check_kind(kind)
    key = (str(registry_path(projects_path)), kind)
    source = BACKFILL_SOURCES.get(kind)
    if source is None:
        return 0
    conn = connect(projects_path)
    try:
        if not force and conn.execute(
            "SELECT 1 FROM short_ref_backfills WHERE kind = ?", (kind,)
        ).fetchone():
            _BACKFILLED.add(key)
            return 0
        items = source(projects_path)
        with write_txn(conn):
            if not force and conn.execute(
                "SELECT 1 FROM short_ref_backfills WHERE kind = ?", (kind,)
            ).fetchone():
                return 0
            before = conn.execute(
                "SELECT COUNT(*) AS n FROM short_refs WHERE kind = ?", (kind,)
            ).fetchone()["n"]
            _insert_missing(conn, kind, items)
            conn.execute(
                "INSERT OR REPLACE INTO short_ref_backfills (kind, done_at) VALUES (?, ?)",
                (kind, int(time.time())),
            )
            after = conn.execute(
                "SELECT COUNT(*) AS n FROM short_refs WHERE kind = ?", (kind,)
            ).fetchone()["n"]
        _BACKFILLED.add(key)
        return int(after) - int(before)
    finally:
        conn.close()


def _ensure_backfilled(kind: str, projects_path: Optional[Path]) -> None:
    if (str(registry_path(projects_path)), kind) in _BACKFILLED:
        return
    try:
        backfill(kind, projects_path=projects_path)
    except Exception:
        logger.warning("short_refs: %s backfill failed", kind, exc_info=True)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def ensure_refs(
    kind: str,
    items: Iterable[RefItem],
    *,
    projects_path: Optional[Path] = None,
) -> dict[str, str]:
    """Refs for ``items`` keyed by internal id, numbering any that lack one.

    The batch the list/detail reads call: a pure read when every item is
    already numbered, one short write transaction otherwise.
    """
    kind = _check_kind(kind)
    items = list(items)
    if not items:
        return {}
    _ensure_backfilled(kind, projects_path)
    conn = connect(projects_path)
    try:
        keys = []
        for it in items:
            profile, board = _scope(kind, it.profile, it.board)
            keys.append((profile, board, str(it.internal_id)))
        have = _existing(conn, kind, keys)
        if any(k not in have for k in keys):
            with write_txn(conn):
                _insert_missing(conn, kind, items)
            have = _existing(conn, kind, keys)
        return {k[2]: have[k] for k in keys if k in have}
    finally:
        conn.close()


def assign(
    kind: str,
    internal_id: str,
    *,
    created_at: Optional[int] = None,
    profile: Optional[str] = None,
    board: Optional[str] = None,
    projects_path: Optional[Path] = None,
) -> str:
    """The item's ref, assigning the next number if it has none (idempotent)."""
    item = RefItem(internal_id, created_at if created_at is not None else int(time.time()), profile, board)
    return ensure_refs(kind, [item], projects_path=projects_path)[str(internal_id)]


def assign_quietly(kind: str, internal_id: str, **kwargs) -> Optional[str]:
    """:func:`assign` for create paths: a registry failure never fails the
    create — the item gets its number on the next read instead."""
    try:
        return assign(kind, internal_id, **kwargs)
    except Exception:
        logger.warning("short_refs: could not assign %s ref to %s", kind, internal_id, exc_info=True)
        return None


def ensure_refs_quietly(kind: str, items: Iterable[RefItem], **kwargs) -> dict[str, str]:
    """:func:`ensure_refs` for read paths: a registry failure means no
    ``ref`` field, never a failed read."""
    try:
        return ensure_refs(kind, items, **kwargs)
    except Exception:
        logger.warning("short_refs: could not read %s refs", kind, exc_info=True)
        return {}


def lookup(ref: str, *, projects_path: Optional[Path] = None) -> Optional[RefRecord]:
    """``"p12"`` → the registry row (kind, internal id, profile, board).

    A run ref resolves to its project's row; the caller reads ``run_no``
    from :func:`parse_ref`. Unknown refs are ``None``.
    """
    parsed = parse_ref(ref)
    if parsed is None:
        return None
    _ensure_backfilled(parsed.kind, projects_path)
    conn = connect(projects_path)
    try:
        row = conn.execute(
            "SELECT * FROM short_refs WHERE kind = ? AND num = ?",
            (parsed.kind, parsed.num),
        ).fetchone()
    finally:
        conn.close()
    return _record(row) if row else None
