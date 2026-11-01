"""To-dos — the staging layer between what arrives and what gets done.

A to-do is not a seventh task store. It is an FG-06 ``tasks`` row
(:mod:`hermes_cli.task_registry`) with a handful of additive columns, so it
inherits that table's RLS, its ordered progress states, its append-only
``task_transitions`` audit and its GTS edges rather than re-earning them. The
plan is ``docs/plans/2026-08-11-001-todos-staging-layer-plan.md``.

Three properties of the existing schema shape everything here:

* **``normalized_intent`` stays NULL for to-dos.** ``tasks`` carries
  ``UNIQUE (owner_user_id, normalized_intent)`` — FG-06's *one task per
  recurring intent* rule. Two unrelated emails that both say "send the
  invoice" are two to-dos, and routing them through that key would silently
  drop the second. Idempotency is :data:`DEDUPE_INDEX_SQL` instead, a partial
  unique index over **live** rows only, so the same request next month is
  correctly a new to-do rather than a conflict with a completed one.
* **``trigger_state`` / ``completion_state`` are NOT NULL.** A light to-do
  supplies the trivial ladder ``captured → done``; one promoted to real work
  can be given intermediate states through the FG-06 machinery unchanged.
* **``status`` and ``stage`` are written together, never apart.** ``status``
  is FG-06's vocabulary and what the GTS graph reads; ``stage`` is the
  user-facing one and the only place ``staged`` (captured but deliberately not
  notified) can be expressed. :data:`STAGE_STATUS` is the mapping, applied in
  one statement so the two can never disagree.
"""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, List, Literal, Optional, Sequence

from hermes_cli.access import (
    Principal,
    apply_item_grants_rls,
    apply_scope_rls,
    initialize_access,
    normalize_visibility,
    scope_filter,
    ITEM_GRANTS_SCHEMA_SQL,
)
from hermes_cli.task_registry import TASKS_TABLE, TaskRegistryStore

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

log = logging.getLogger(__name__)

TRANSITIONS_TABLE = "task_transitions"


def _parse_outbound_event(to_state: str) -> str:
    """Extract the event name from an ``action:<event>:<channel>`` to_state.

    ``record_outbound`` writes ``to_state = f"action:{event}:{channel}"``
    (e.g. ``action:sent:whatsapp``).  The replay guard in ``todos_cmd._send``
    compares the returned ``event`` against a bare name like ``"sent"``, so
    we parse the structured shape here rather than returning the raw
    ``to_state`` that would never match.
    """
    parts = str(to_state).split(":", 2)
    if len(parts) >= 2 and parts[0] == "action":
        return parts[1]
    return str(to_state)

PROGRESS_STATES_TABLE = "task_progress_states"

#: Grants reuse the ``document`` item kind, as the arrival and file registries
#: do: to the person sharing it, handing over a to-do and handing over the
#: message behind it are one act, and a new kind needs a CHECK migration.
GRANT_ITEM_KIND = "document"

#: The grant clause is a sub-select over ``item_grants``, which has an ``id``
#: of its own, so the row's id has to be table-qualified or the clause matches
#: nothing silently.
GRANT_ID_COLUMN = f"{TASKS_TABLE}.id"

#: The user-facing lifecycle. ``staged`` is the tier that does **not** notify:
#: triage extracts an action item from most batches, so capturing generously
#: is only survivable if most captures stay silent until promoted.
TodoStage = Literal["staged", "open", "working", "done", "dismissed"]
TODO_STAGES: tuple[TodoStage, ...] = (
    "staged",
    "open",
    "working",
    "done",
    "dismissed",
)

#: Stages a to-do can still be acted on in — the scope of de-duplication.
LIVE_STAGES: tuple[TodoStage, ...] = ("staged", "open", "working")

#: FG-06 ``status`` for each stage. Written in the same statement as ``stage``.
STAGE_STATUS: dict[str, str] = {
    "staged": "pending",
    "open": "pending",
    "working": "in_progress",
    "done": "completed",
    "dismissed": "cancelled",
}

#: Mirrors the triage vocabulary so a classification maps across without a
#: translation table nobody remembers to update.
TODO_PRIORITIES: tuple[str, ...] = ("critical", "high", "normal", "low")

#: Where the to-do came from. ``inbound`` carries an ``inbound_items`` id in
#: ``source_ref``; the rest describe themselves in ``source_note``.
TODO_SOURCE_KINDS: tuple[str, ...] = (
    "inbound",
    "analysis",
    "user",
    "agent",
    "cron",
)

#: The trivial two-state ladder a light to-do gets, so the NOT NULL state
#: columns are satisfied without forking the schema for cheap rows.
DEFAULT_TRIGGER_STATE = "captured"
DEFAULT_COMPLETION_STATE = "done"

MAX_TITLE_CHARS = 300
MAX_DESCRIPTION_CHARS = 8_000
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50

#: Default lifetime of an untouched ``staged`` row before the sweep dismisses
#: it. Overridable through ``config.yaml`` at the caller.
DEFAULT_STAGED_EXPIRY_DAYS = 14


MIGRATION_SQL = f"""
ALTER TABLE {TASKS_TABLE}
    ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
    ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_kind TEXT,
    ADD COLUMN IF NOT EXISTS source_ref UUID,
    ADD COLUMN IF NOT EXISTS source_note TEXT,
    ADD COLUMN IF NOT EXISTS dedupe_key TEXT,
    ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS outcome TEXT;

CREATE INDEX IF NOT EXISTS tasks_owner_stage_idx
    ON {TASKS_TABLE} (owner_user_id, stage, priority, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_source_idx
    ON {TASKS_TABLE} (source_kind, source_ref);
CREATE INDEX IF NOT EXISTS tasks_keyset_idx
    ON {TASKS_TABLE} (created_at DESC, id DESC);
"""

#: Kept out of :data:`MIGRATION_SQL` only so the predicate reads once, next to
#: the reason for it: dedupe applies while a to-do is **live**. Completing one
#: and being asked the same thing again next month must produce a new row, not
#: a conflict with a closed one.
DEDUPE_INDEX_SQL = f"""
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedupe_idx
    ON {TASKS_TABLE} (owner_user_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
      AND stage IN ('staged', 'open', 'working');
"""

_SELECT_COLUMNS = (
    "id, owner_user_id, visibility, title, description, trigger_state, "
    "completion_state, current_state, status, origin, stage, priority, "
    "due_at, source_kind, source_ref, source_note, dedupe_key, notified_at, "
    "snoozed_until, closed_at, outcome, created_at, updated_at"
)

_WHITESPACE = re.compile(r"\s+")



def _is_todo_id(todo_id: object) -> bool:
    """Whether *todo_id* can name a row: ``tasks.id`` is a UUID, and handing
    Postgres anything else fails the cast (a 500) instead of matching nothing."""
    try:
        uuid.UUID(str(todo_id))
    except ValueError:
        return False
    return True

class TodoError(Exception):
    """A to-do operation the caller asked for that cannot be honoured."""


@dataclass(frozen=True)
class Todo:
    """One to-do: an FG-06 task row read through the to-do vocabulary."""

    id: str
    owner_user_id: str
    visibility: str
    title: str
    description: str
    stage: str
    status: str
    priority: str
    origin: str
    current_state: str
    trigger_state: str
    completion_state: str
    due_at: Optional[datetime] = None
    source_kind: Optional[str] = None
    source_ref: Optional[str] = None
    source_note: Optional[str] = None
    dedupe_key: Optional[str] = None
    notified_at: Optional[datetime] = None
    snoozed_until: Optional[datetime] = None
    closed_at: Optional[datetime] = None
    outcome: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    #: False when a write collapsed onto an existing live row. The caller that
    #: decides whether to notify needs this: re-running triage over the same
    #: batch must not announce the same to-do twice.
    created: bool = True

    @property
    def is_live(self) -> bool:
        return self.stage in LIVE_STAGES

    def as_dict(self) -> dict[str, Any]:
        def _iso(value: Optional[datetime]) -> Optional[str]:
            return value.isoformat() if value else None

        return {
            "id": self.id,
            "owner_user_id": self.owner_user_id,
            "visibility": self.visibility,
            "title": self.title,
            "description": self.description,
            "stage": self.stage,
            "status": self.status,
            "priority": self.priority,
            "origin": self.origin,
            "current_state": self.current_state,
            "trigger_state": self.trigger_state,
            "completion_state": self.completion_state,
            "due_at": _iso(self.due_at),
            "source_kind": self.source_kind,
            "source_ref": self.source_ref,
            "source_note": self.source_note,
            "notified_at": _iso(self.notified_at),
            "snoozed_until": _iso(self.snoozed_until),
            "closed_at": _iso(self.closed_at),
            "outcome": self.outcome,
            "created_at": _iso(self.created_at),
            "updated_at": _iso(self.updated_at),
        }


def _row_to_todo(row: Any, *, created: bool = True) -> Todo:
    return Todo(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        title=str(row["title"]),
        description=str(row["description"] or ""),
        stage=str(row["stage"]),
        status=str(row["status"]),
        priority=str(row["priority"]),
        origin=str(row["origin"]),
        current_state=str(row["current_state"]),
        trigger_state=str(row["trigger_state"]),
        completion_state=str(row["completion_state"]),
        due_at=row["due_at"],
        source_kind=row["source_kind"],
        source_ref=str(row["source_ref"]) if row["source_ref"] else None,
        source_note=row["source_note"],
        dedupe_key=row["dedupe_key"],
        notified_at=row["notified_at"],
        snoozed_until=row["snoozed_until"],
        closed_at=row["closed_at"],
        outcome=row["outcome"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        created=created,
    )


def normalize_title(title: str) -> str:
    """Collapse a title to its comparable form (for de-duplication)."""
    return _WHITESPACE.sub(" ", (title or "").strip().lower())


def compute_dedupe_key(
    owner_user_id: str,
    *,
    source_kind: Optional[str],
    source_ref: Optional[str],
    title: str,
) -> Optional[str]:
    """The idempotency key for a to-do, or ``None`` when it has no source.

    A user-typed to-do gets no key: typing the same thing twice is a decision,
    not a duplicate. A machine-produced one keys on its source *and* its title,
    so one message that genuinely implies two actions yields two rows while a
    replayed batch yields one.
    """
    if not source_kind:
        return None
    normalized = normalize_title(title)
    if not normalized:
        return None
    digest = hashlib.sha256(
        "\x1f".join(
            [owner_user_id, source_kind, source_ref or "", normalized]
        ).encode("utf-8")
    ).hexdigest()
    return digest[:32]


def validate_stage(stage: str) -> str:
    if stage not in TODO_STAGES:
        raise TodoError(f"Unknown to-do stage: {stage!r}")
    return stage


def validate_priority(priority: str) -> str:
    if priority not in TODO_PRIORITIES:
        raise TodoError(f"Unknown to-do priority: {priority!r}")
    return priority


def validate_source_kind(source_kind: Optional[str]) -> Optional[str]:
    if source_kind is None:
        return None
    if source_kind not in TODO_SOURCE_KINDS:
        raise TodoError(f"Unknown to-do source kind: {source_kind!r}")
    return source_kind


def encode_cursor(todo: Todo) -> str:
    """Opaque keyset cursor: the sort key of the last row on a page."""
    import base64

    created = todo.created_at or datetime.now(timezone.utc)
    raw = f"{created.isoformat()}|{todo.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    """Inverse of :func:`encode_cursor`. Raises ``ValueError`` when malformed."""
    import base64

    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        ts_text, _, todo_id = raw.partition("|")
        return datetime.fromisoformat(ts_text), todo_id
    except Exception as exc:  # noqa: BLE001 - one error for every malformation
        raise ValueError(f"Malformed cursor: {cursor!r}") from exc


def default_store(mode: Optional[str] = None) -> "TodoStore":
    """A store against the instance's configured schema."""
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import get_store

    # Read-only: ``get_store`` only reads it, and this runs per to-do request.
    config = load_config_readonly() or {}
    resolved: Optional[Literal["dev", "prod"]] = None
    if mode == "dev":
        resolved = "dev"
    elif mode == "prod":
        resolved = "prod"
    return TodoStore(get_store("supabase-app", resolved, config=config))


class TodoStore:
    """Read/write access to to-dos, under contract C2."""

    def __init__(self, app_store: "SupabaseAppStore") -> None:
        self._store = app_store

    @property
    def mode(self) -> str:
        return self._store.mode

    async def _connect(self) -> "asyncpg.Connection":
        return await self._store.connect()

    async def initialize(
        self,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Create/extend the tasks table and its policies. Idempotent."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await initialize_access(conn)
            await TaskRegistryStore(self._store).initialize(connection=conn)
            await conn.execute(MIGRATION_SQL)
            await conn.execute(DEDUPE_INDEX_SQL)
            await conn.execute(ITEM_GRANTS_SCHEMA_SQL)
            await apply_item_grants_rls(conn)
            await apply_scope_rls(
                conn,
                TASKS_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
            )
        finally:
            if own:
                await conn.close()

    # -- writing -----------------------------------------------------------

    async def create(
        self,
        principal: Principal,
        *,
        title: str,
        description: str = "",
        stage: str = "open",
        priority: str = "normal",
        due_at: Optional[datetime] = None,
        source_kind: Optional[str] = None,
        source_ref: Optional[str] = None,
        source_note: Optional[str] = None,
        origin: str = "explicit",
        actor: Optional[str] = None,
        visibility: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Todo:
        """Create a to-do, or return the live one it duplicates.

        A collapse is reported through :attr:`Todo.created` rather than raised:
        the triage bridge re-sees batches routinely, and the only caller that
        cares is the one deciding whether to notify.
        """
        clean_title = _WHITESPACE.sub(" ", (title or "").strip())[:MAX_TITLE_CHARS]
        if not clean_title:
            raise TodoError("a to-do needs a title")
        validate_stage(stage)
        validate_priority(priority)
        validate_source_kind(source_kind)
        vis = normalize_visibility(visibility or principal.private_visibility)
        dedupe_key = compute_dedupe_key(
            principal.user_id,
            source_kind=source_kind,
            source_ref=source_ref,
            title=clean_title,
        )

        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {TASKS_TABLE} (
                        owner_user_id, visibility, title, description,
                        trigger_state, completion_state, current_state,
                        status, origin, stage, priority, due_at,
                        source_kind, source_ref, source_note, dedupe_key)
                    VALUES ($1, $2, $3, $4, $5, $6, $5, $7, $8, $9, $10,
                            $11::timestamptz, $12::text, $13::uuid,
                            $14::text, $15::text)
                    ON CONFLICT (owner_user_id, dedupe_key)
                        WHERE dedupe_key IS NOT NULL
                          AND stage IN ('staged', 'open', 'working')
                    DO UPDATE SET
                        -- A re-seen source may carry a better title or a
                        -- raised priority; it must never drag a to-do the
                        -- user already promoted back down to `staged`.
                        title = EXCLUDED.title,
                        description = EXCLUDED.description,
                        priority = EXCLUDED.priority,
                        due_at = COALESCE(
                            EXCLUDED.due_at, {TASKS_TABLE}.due_at
                        ),
                        source_ref = COALESCE(
                            EXCLUDED.source_ref, {TASKS_TABLE}.source_ref
                        ),
                        updated_at = NOW()
                    RETURNING {_SELECT_COLUMNS}, (xmax = 0) AS inserted
                    """,
                    principal.user_id,
                    vis,
                    clean_title,
                    (description or "")[:MAX_DESCRIPTION_CHARS],
                    DEFAULT_TRIGGER_STATE,
                    DEFAULT_COMPLETION_STATE,
                    STAGE_STATUS[stage],
                    origin,
                    stage,
                    priority,
                    due_at,
                    source_kind,
                    source_ref,
                    source_note,
                    dedupe_key,
                )
                created = bool(row["inserted"])
                if created:
                    await conn.executemany(
                        f"""
                        INSERT INTO {PROGRESS_STATES_TABLE}
                            (task_id, ordinal, name)
                        VALUES ($1, $2, $3)
                        ON CONFLICT DO NOTHING
                        """,
                        [
                            (row["id"], 0, DEFAULT_TRIGGER_STATE),
                            (row["id"], 1, DEFAULT_COMPLETION_STATE),
                        ],
                    )
                    await self._record_transition(
                        conn,
                        str(row["id"]),
                        from_stage=None,
                        to_stage=stage,
                        actor=actor or principal.user_id,
                    )
            return _row_to_todo(row, created=created)
        finally:
            if own:
                await conn.close()

    async def set_stage(
        self,
        principal: Principal,
        todo_id: str,
        stage: str,
        *,
        actor: Optional[str] = None,
        outcome: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Todo:
        """Move a to-do to ``stage``, keeping ``status`` in lockstep."""
        validate_stage(stage)
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        closing = stage in ("done", "dismissed")
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                current = await conn.fetchrow(
                    f"""
                    SELECT stage FROM {TASKS_TABLE}
                    WHERE id = $1 AND {predicate.sql}
                    FOR UPDATE
                    """,
                    todo_id,
                    *predicate.params,
                )
                if current is None:
                    raise LookupError("to-do not found or not visible")
                offset = len(predicate.params) + 2
                row = await conn.fetchrow(
                    f"""
                    UPDATE {TASKS_TABLE}
                    SET stage = ${offset}::text,
                        status = ${offset + 1}::text,
                        outcome = COALESCE(${offset + 2}::text, outcome),
                        closed_at = CASE WHEN ${offset + 3}::boolean
                                         THEN NOW() ELSE NULL END,
                        -- Reopening clears the snooze: a to-do the user has
                        -- picked up again must not vanish from the list again
                        -- on a timer they set before.
                        snoozed_until = CASE WHEN ${offset + 3}::boolean
                                             THEN snoozed_until ELSE NULL END,
                        updated_at = NOW()
                    WHERE id = $1 AND {predicate.sql}
                    RETURNING {_SELECT_COLUMNS}
                    """,
                    todo_id,
                    *predicate.params,
                    stage,
                    STAGE_STATUS[stage],
                    outcome,
                    closing,
                )
                await self._record_transition(
                    conn,
                    todo_id,
                    from_stage=str(current["stage"]),
                    to_stage=stage,
                    actor=actor or principal.user_id,
                )
            return _row_to_todo(row)
        finally:
            if own:
                await conn.close()

    async def update(
        self,
        principal: Principal,
        todo_id: str,
        *,
        title: Optional[str] = None,
        description: Optional[str] = None,
        priority: Optional[str] = None,
        due_at: Optional[datetime] = None,
        clear_due_at: bool = False,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Todo:
        """Edit the user-editable fields. Stage changes go through
        :meth:`set_stage` so every one of them leaves an audit row."""
        sets: list[str] = []
        values: list[object] = []
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        next_index = len(predicate.params) + 2

        if title is not None:
            clean = _WHITESPACE.sub(" ", title.strip())[:MAX_TITLE_CHARS]
            if not clean:
                raise TodoError("a to-do needs a title")
            sets.append(f"title = ${next_index}")
            values.append(clean)
            next_index += 1
        if description is not None:
            sets.append(f"description = ${next_index}")
            values.append(description[:MAX_DESCRIPTION_CHARS])
            next_index += 1
        if priority is not None:
            sets.append(f"priority = ${next_index}")
            values.append(validate_priority(priority))
            next_index += 1
        if clear_due_at:
            sets.append("due_at = NULL")
        elif due_at is not None:
            sets.append(f"due_at = ${next_index}")
            values.append(due_at)
            next_index += 1
        if not sets:
            existing = await self.get(principal, todo_id, connection=connection)
            if existing is None:
                raise LookupError("to-do not found or not visible")
            return existing

        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                UPDATE {TASKS_TABLE}
                SET {", ".join(sets)}, updated_at = NOW()
                WHERE id = $1 AND {predicate.sql}
                RETURNING {_SELECT_COLUMNS}
                """,
                todo_id,
                *predicate.params,
                *values,
            )
            if row is None:
                raise LookupError("to-do not found or not visible")
            return _row_to_todo(row)
        finally:
            if own:
                await conn.close()

    async def snooze(
        self,
        principal: Principal,
        todo_id: str,
        until: datetime,
        *,
        actor: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Todo:
        """Hide a to-do from the default view until ``until``.

        ``notified_at`` is cleared so the row is announced once more when it
        comes back — a snooze the user forgot about is the same as a to-do
        that never arrived.
        """
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        offset = len(predicate.params) + 2
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                UPDATE {TASKS_TABLE}
                SET snoozed_until = ${offset}::timestamptz,
                    notified_at = NULL,
                    updated_at = NOW()
                WHERE id = $1 AND {predicate.sql}
                RETURNING {_SELECT_COLUMNS}
                """,
                todo_id,
                *predicate.params,
                until,
            )
            if row is None:
                raise LookupError("to-do not found or not visible")
            await self._record_transition(
                conn,
                todo_id,
                from_stage=str(row["stage"]),
                to_stage=f"snoozed until {until.isoformat()}",
                actor=actor or principal.user_id,
            )
            return _row_to_todo(row)
        finally:
            if own:
                await conn.close()

    async def mark_notified(
        self,
        principal: Principal,
        todo_id: str,
        *,
        at: Optional[datetime] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Stamp ``notified_at``, once. Returns whether this call was the one.

        The stamp is the idempotency guard for the notification sweep: two
        workers, or a retried batch, cannot announce the same to-do twice
        because only one ``UPDATE … WHERE notified_at IS NULL`` matches.
        """
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        offset = len(predicate.params) + 2
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                UPDATE {TASKS_TABLE}
                SET notified_at = COALESCE(${offset}::timestamptz, NOW())
                WHERE id = $1 AND {predicate.sql} AND notified_at IS NULL
                RETURNING id
                """,
                todo_id,
                *predicate.params,
                at,
            )
            return row is not None
        finally:
            if own:
                await conn.close()

    async def expire_staged(
        self,
        principal: Principal,
        *,
        older_than_days: int = DEFAULT_STAGED_EXPIRY_DAYS,
        now: Optional[datetime] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> int:
        """Dismiss ``staged`` rows nobody touched. Returns how many.

        Capturing generously only works if the uninteresting captures go away
        by themselves; the sweep records ``system:expiry`` as the actor so the
        history says what happened rather than the row simply vanishing.
        """
        cutoff = (now or datetime.now(timezone.utc)) - timedelta(
            days=max(0, older_than_days)
        )
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                rows = await conn.fetch(
                    f"""
                    UPDATE {TASKS_TABLE}
                    SET stage = 'dismissed',
                        status = 'cancelled',
                        outcome = COALESCE(outcome, 'expired while staged'),
                        closed_at = NOW(),
                        updated_at = NOW()
                    WHERE stage = 'staged'
                      AND updated_at < $1::timestamptz
                      AND {predicate.sql}
                    RETURNING id
                    """,
                    cutoff,
                    *predicate.params,
                )
                for row in rows:
                    await self._record_transition(
                        conn,
                        str(row["id"]),
                        from_stage="staged",
                        to_stage="dismissed",
                        actor="system:expiry",
                    )
            return len(rows)
        finally:
            if own:
                await conn.close()

    async def record_outbound(
        self,
        principal: Principal,
        todo_id: str,
        *,
        event: str,
        channel: str,
        actor: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Append an outgoing-action decision to the to-do's own history.

        The proposal, the approval and the refusal all belong on the same
        timeline as the stage changes: "we finished this and offered to reply,
        and you said no" is one story, and splitting it across two tables makes
        it unreadable in the one place the user looks. The ``action:`` prefix
        does for these what ``stage:`` does for the rest.
        """
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            visible = await conn.fetchval(
                f"SELECT 1 FROM {TASKS_TABLE} WHERE id = $1 AND {predicate.sql}",
                todo_id,
                *predicate.params,
            )
            if visible is None:
                raise LookupError("to-do not found or not visible")
            await conn.execute(
                f"""
                INSERT INTO {TRANSITIONS_TABLE} (task_id, from_state, to_state, actor)
                VALUES ($1, $2, $3, $4)
                """,
                todo_id,
                "action:new",
                f"action:{event}:{channel}",
                actor,
            )
        finally:
            if own:
                await conn.close()

    async def list_outbound(
        self,
        principal: Principal,
        todo_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> list[dict]:
        """Return outbound-action events for *todo_id*, newest first.

        Used by the ``send`` verb's replay guard: a to-do that already has a
        ``action:sent:*`` transition has been delivered and must not be sent
        again.
        """
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            visible = await conn.fetchval(
                f"SELECT 1 FROM {TASKS_TABLE} WHERE id = $1 AND {predicate.sql}",
                todo_id,
                *predicate.params,
            )
            if visible is None:
                return []
            rows = await conn.fetch(
                f"SELECT to_state, actor, ts "
                f"FROM {TRANSITIONS_TABLE} "
                f"WHERE task_id = $1 AND to_state LIKE 'action:%' "
                f"ORDER BY ts DESC",
                todo_id,
            )
            return [
                {"event": _parse_outbound_event(r["to_state"]), "actor": r["actor"], "at": r["ts"]}
                for r in rows
            ]
        finally:
            if own:
                await conn.close()

    async def record_session(
        self,
        principal: Principal,
        todo_id: str,
        *,
        session_id: str,
        actor: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Record a spawned session pointer in the to-do's transition history.

        Unlike the raw-SQL insert in ``/start``, this goes through the same
        scope-checked path as every other transition, so an RLS-enabled tier
        enforces visibility correctly.
        """
        await self.record_outbound(
            principal,
            todo_id,
            event=f"session:{session_id}",
            channel="spawn",
            actor=actor,
            connection=connection,
        )

    async def _record_transition(
        self,
        conn: "asyncpg.Connection",
        todo_id: str,
        *,
        from_stage: Optional[str],
        to_stage: str,
        actor: str,
    ) -> None:
        """Append one stage change to the FG-06 audit table.

        ``task_transitions`` records progress-state movement with free-text
        names, so stage changes are prefixed rather than given a second table:
        one history, and ``stage:`` tells a reader which kind of change they
        are looking at.
        """
        await conn.execute(
            f"""
            INSERT INTO {TRANSITIONS_TABLE} (task_id, from_state, to_state, actor)
            VALUES ($1, $2, $3, $4)
            """,
            todo_id,
            f"stage:{from_stage}" if from_stage else "stage:new",
            f"stage:{to_stage}",
            actor,
        )

    # -- reading -----------------------------------------------------------

    async def get(
        self,
        principal: Principal,
        todo_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[Todo]:
        if not _is_todo_id(todo_id):
            return None
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                SELECT {_SELECT_COLUMNS} FROM {TASKS_TABLE}
                WHERE id = $1 AND {predicate.sql}
                """,
                todo_id,
                *predicate.params,
            )
            return _row_to_todo(row) if row else None
        finally:
            if own:
                await conn.close()

    async def list(
        self,
        principal: Principal,
        *,
        stages: Optional[Sequence[str]] = None,
        priorities: Optional[Sequence[str]] = None,
        source_kinds: Optional[Sequence[str]] = None,
        source_ref: Optional[str] = None,
        query: Optional[str] = None,
        due_before: Optional[datetime] = None,
        include_snoozed: bool = False,
        now: Optional[datetime] = None,
        limit: int = DEFAULT_PAGE_SIZE,
        cursor: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> tuple[List[Todo], Optional[str]]:
        """A page of to-dos, newest first, plus the cursor for the next one."""
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        clauses = [predicate.sql]
        params: list[object] = list(predicate.params)

        def add(sql_template: str, *values: object) -> None:
            nonlocal params
            placeholders = [f"${len(params) + i + 1}" for i in range(len(values))]
            clauses.append(sql_template.format(*placeholders))
            params.extend(values)

        if stages:
            add("stage = ANY({0}::text[])", [validate_stage(s) for s in stages])
        if priorities:
            add(
                "priority = ANY({0}::text[])",
                [validate_priority(p) for p in priorities],
            )
        if source_kinds:
            add(
                "source_kind = ANY({0}::text[])",
                [validate_source_kind(k) for k in source_kinds],
            )
        if source_ref:
            add("source_ref = {0}::uuid", source_ref)
        if query:
            add(
                "(title ILIKE {0} OR description ILIKE {1})",
                f"%{query}%",
                f"%{query}%",
            )
        if due_before:
            add("(due_at IS NOT NULL AND due_at <= {0}::timestamptz)", due_before)
        if not include_snoozed:
            add(
                "(snoozed_until IS NULL OR snoozed_until <= {0}::timestamptz)",
                now or datetime.now(timezone.utc),
            )
        if cursor:
            when, last_id = decode_cursor(cursor)
            add("(created_at, id) < ({0}::timestamptz, {1}::uuid)", when, last_id)

        page = max(1, min(int(limit or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT {_SELECT_COLUMNS} FROM {TASKS_TABLE}
                WHERE {" AND ".join(clauses)}
                ORDER BY created_at DESC, id DESC
                LIMIT {page + 1}
                """,
                *params,
            )
            items = [_row_to_todo(row) for row in rows[:page]]
            next_cursor = (
                encode_cursor(items[-1]) if len(rows) > page and items else None
            )
            return items, next_cursor
        finally:
            if own:
                await conn.close()

    async def facets(
        self,
        principal: Principal,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> dict[str, List[dict[str, Any]]]:
        """Counts per stage / priority / source, for the filter chips.

        Built from a counts query for the same reason the Incomings chips are:
        a chip that matches nothing is a dead control, and offering one is
        worse than not offering the filter.
        """
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            # One UNION ALL roundtrip instead of three sequential counts;
            # Postgres reuses the $n placeholders across branches, so the
            # scope params are passed once. ::text keeps the branches
            # union-compatible regardless of column type.
            facet_columns = {
                "stages": "stage",
                "priorities": "priority",
                "sources": "source_kind",
            }
            branches = [
                f"""
                SELECT '{facet}' AS facet, {column}::text AS value, COUNT(*) AS count
                FROM {TASKS_TABLE}
                WHERE {predicate.sql} AND {column} IS NOT NULL
                GROUP BY {column}
                """
                for facet, column in facet_columns.items()
            ]
            rows = await conn.fetch(
                " UNION ALL ".join(branches) + " ORDER BY facet, count DESC",
                *predicate.params,
            )
            result: dict[str, List[dict[str, Any]]] = {
                facet: [] for facet in facet_columns
            }
            for row in rows:
                result[row["facet"]].append(
                    {"value": str(row["value"]), "count": int(row["count"])}
                )
            return result
        finally:
            if own:
                await conn.close()

    async def history(
        self,
        principal: Principal,
        todo_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[dict[str, Any]]:
        """The append-only transition history for one to-do."""
        if not _is_todo_id(todo_id):
            return []
        predicate = scope_filter(
            principal,
            column="t.visibility",
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column="t.id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT x.from_state, x.to_state, x.ts, x.actor
                FROM {TRANSITIONS_TABLE} x
                JOIN {TASKS_TABLE} t ON t.id = x.task_id
                WHERE t.id = $1 AND {predicate.sql}
                ORDER BY x.ts ASC, x.id ASC
                """,
                todo_id,
                *predicate.params,
            )
            return [
                {
                    "from": str(row["from_state"]),
                    "to": str(row["to_state"]),
                    "at": row["ts"].isoformat() if row["ts"] else None,
                    "actor": str(row["actor"]),
                }
                for row in rows
            ]
        finally:
            if own:
                await conn.close()

    async def pending_notification(
        self,
        principal: Principal,
        *,
        limit: int = 50,
        now: Optional[datetime] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Todo]:
        """Open to-dos the user has not been told about yet.

        ``staged`` is deliberately absent: it is the stage that does not
        notify, and that is the whole reason it exists.
        """
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=GRANT_ID_COLUMN,
        )
        offset = len(predicate.params) + 1
        own = connection is None
        conn = connection or await self._connect()
        try:
            rows = await conn.fetch(
                f"""
                SELECT {_SELECT_COLUMNS} FROM {TASKS_TABLE}
                WHERE {predicate.sql}
                  AND stage = 'open'
                  AND notified_at IS NULL
                  AND (snoozed_until IS NULL OR snoozed_until <= ${offset}::timestamptz)
                ORDER BY created_at ASC
                LIMIT {max(1, min(int(limit), MAX_PAGE_SIZE))}
                """,
                *predicate.params,
                now or datetime.now(timezone.utc),
            )
            return [_row_to_todo(row) for row in rows]
        finally:
            if own:
                await conn.close()
