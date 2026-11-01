"""The shared tag vocabulary: one set of tags across every kind of thing.

Tagging shipped first for chat sessions (``session_tags`` / ``session_tag_map``
in :mod:`hermes_state`, schema v18) — named, coloured tags with tri-state
include/exclude filtering and LLM suggestions. That design is right and this
module does not replace it; it **moves** it, for one reason: those tables live
in the per-box session SQLite with no ``owner_user_id`` or ``visibility``,
while the things users now want to tag (inbound items, files, tasks) live in
the shared Postgres app schema under row-level security. A tag table in one
store cannot label rows in the other without dual-writing across two databases,
which is exactly the split-brain the storage rules forbid.

So the vocabulary moves to Postgres under contract C2, and the assignment
becomes polymorphic — ``(entity_kind, entity_id)`` rather than ``session_id``
— so one vocabulary, one set of colours and one filter UI serve sessions,
incomings and anything added later. Session tagging keeps working through the
same endpoints; :func:`migrate_session_tags` moves the existing rows once.

Two deliberate asymmetries with :mod:`hermes_cli.file_registry`:

* ``entity_id`` is ``TEXT``, not ``UUID``, and carries no foreign key. Session
  ids are hex strings, not UUIDs, and a polymorphic reference cannot be
  constrained to one parent table anyway. The cost is that deletion cleanup is
  the owning registry's job — see :func:`purge_entity`.
* ``tag_assignments`` has no RLS policy of its own. It is reachable only
  through a scoped join to its parent tag, the same shape FG-04 uses for goal
  metrics, so a tag nobody can read has assignments nobody can read.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
# ``List`` rather than ``list`` in return annotations: this class defines a
# method named ``list``, which shadows the builtin inside the class body.
from typing import TYPE_CHECKING, Any, List, Literal, Optional, Sequence

from hermes_cli.access import (
    Principal,
    apply_scope_rls,
    bind_principal,
    is_uuid,
    normalize_visibility,
    scope_filter,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

TAGS_TABLE = "tags"
TAG_ASSIGNMENTS_TABLE = "tag_assignments"

#: The palette the existing tag UI renders (``TagFilterBar``'s ``TAG_BG`` map
#: and ``SessionDB.TAG_COLORS``). Kept identical so a tag created here looks
#: the same everywhere; an unknown colour falls back rather than erroring,
#: matching ``SessionDB.create_tag``.
TAG_COLORS: tuple[str, ...] = ("blue", "red", "green", "amber", "purple", "gray")
DEFAULT_TAG_COLOR = "blue"

#: What a tag can be attached to. Open to extension, but not open-ended: a
#: typo'd kind would silently create assignments nothing ever reads, so the
#: value is checked rather than stored verbatim.
ENTITY_KINDS: tuple[str, ...] = ("session", "inbound", "file", "task")

#: Tag names are short labels, not notes. The cap is generous for a CJK label
#: (where 48 characters is a long phrase) and stops a paragraph being pasted
#: into a filter chip.
MAX_TAG_NAME_CHARS = 48

#: Who attached a tag. ``manual`` is the user acting directly, ``llm`` is an
#: accepted suggestion, and anything else is a skill name — the distinction
#: the session ``source`` column already carries, preserved here.
DEFAULT_SOURCE = "manual"


SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {TAGS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '{DEFAULT_TAG_COLOR}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Case-insensitive uniqueness per owner: "Invoice" and "invoice" are one tag,
-- as they already are in the session store's LOWER(name) lookup. Scoped to the
-- owner so two members do not fight over one shared namespace.
CREATE UNIQUE INDEX IF NOT EXISTS {TAGS_TABLE}_owner_name_idx
    ON {TAGS_TABLE} (owner_user_id, LOWER(name));

CREATE TABLE IF NOT EXISTS {TAG_ASSIGNMENTS_TABLE} (
    tag_id UUID NOT NULL REFERENCES {TAGS_TABLE}(id) ON DELETE CASCADE,
    entity_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL DEFAULT '{DEFAULT_SOURCE}',
    PRIMARY KEY (tag_id, entity_kind, entity_id)
);
-- "What is tagged on this row?" — the lookup every detail view makes.
CREATE INDEX IF NOT EXISTS {TAG_ASSIGNMENTS_TABLE}_entity_idx
    ON {TAG_ASSIGNMENTS_TABLE} (entity_kind, entity_id);
"""


class UnknownEntityKind(ValueError):
    """Raised for an ``entity_kind`` outside :data:`ENTITY_KINDS`."""


@dataclass(frozen=True)
class TagFilter:
    """The id sets a tag filter resolves to.

    Two fields rather than one list because "match these tags" and "but not
    these" compose differently into a caller's query: ``match_ids`` is a
    restriction (``id = ANY``) and is ``None`` when the user selected no
    include tags, meaning *do not restrict*; ``excluded_ids`` is always a
    subtraction (``id <> ALL``). Collapsing them into one list would make an
    empty include set indistinguishable from "nothing matched", which is the
    difference between showing the whole inbox and showing none of it.
    """

    match_ids: Optional[list[str]]
    excluded_ids: list[str]

    @property
    def is_empty(self) -> bool:
        """Whether no filtering was requested at all."""
        return self.match_ids is None and not self.excluded_ids

    @property
    def matches_nothing(self) -> bool:
        """Whether the filter cannot match any row, so the caller can skip it."""
        return self.match_ids is not None and not self.match_ids


@dataclass(frozen=True)
class Tag:
    """One tag in the vocabulary."""

    id: str
    owner_user_id: str
    visibility: str
    name: str
    color: str
    created_at: Optional[datetime]
    #: Populated by :meth:`TagRegistry.list` only; ``None`` elsewhere so a
    #: caller cannot mistake "not counted" for "used by nothing".
    usage_count: Optional[int] = None

    def as_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.id,
            "owner_user_id": self.owner_user_id,
            "visibility": self.visibility,
            "name": self.name,
            "color": self.color,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
        if self.usage_count is not None:
            # The web client's ``SessionTag`` type calls this ``session_count``;
            # both are emitted while that name is still in the UI, so promoting
            # the store did not require touching the chat components.
            payload["usage_count"] = self.usage_count
            payload["session_count"] = self.usage_count
        return payload


def _row_to_tag(row: Any, *, with_count: bool = False) -> Tag:
    return Tag(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        name=str(row["name"]),
        color=str(row["color"]),
        created_at=row["created_at"],
        usage_count=int(row["usage_count"]) if with_count else None,
    )


def normalize_tag_name(name: str) -> str:
    """Trim and bound a tag name, preserving the case the user typed."""
    cleaned = " ".join(str(name).split())
    if not cleaned:
        raise ValueError("tag name cannot be empty")
    return cleaned[:MAX_TAG_NAME_CHARS]


def normalize_color(color: Optional[str]) -> str:
    """Coerce to a known palette entry, as the session store does."""
    return color if color in TAG_COLORS else DEFAULT_TAG_COLOR


def validate_entity_kind(kind: str) -> str:
    if kind not in ENTITY_KINDS:
        raise UnknownEntityKind(
            f"Unknown entity kind: {kind!r} (expected one of {', '.join(ENTITY_KINDS)})"
        )
    return kind


def default_registry(mode: Optional[str] = None) -> "TagRegistry":
    """A registry against the instance's configured schema."""
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    config = load_config() or {}
    # Narrowed explicitly rather than with a membership test so the literal
    # StoreMode type survives; anything else falls back to the default.
    resolved: Optional[Literal["dev", "prod"]] = None
    if mode == "dev":
        resolved = "dev"
    elif mode == "prod":
        resolved = "prod"
    return TagRegistry(get_store("supabase-app", resolved, config=config))


class TagRegistry:
    """Read/write access to the tag vocabulary and its assignments (C2)."""

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
        """Create the tables and the vocabulary's RLS policy. Idempotent."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(SCHEMA_SQL)
            await apply_scope_rls(conn, TAGS_TABLE)
        finally:
            if own:
                await conn.close()

    async def ensure(
        self,
        principal: Principal,
        name: str,
        *,
        color: Optional[str] = None,
        visibility: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tag:
        """Find-or-create a tag by name, case-insensitively.

        Create-or-find rather than create: the session store already behaves
        this way, and it is what lets "add tag 'invoice'" work from a chip, a
        skill and the API without any of them checking first.
        """
        clean = normalize_tag_name(name)
        vis = normalize_visibility(visibility or principal.private_visibility)
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""INSERT INTO {TAGS_TABLE}
                            (owner_user_id, visibility, name, color)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (owner_user_id, LOWER(name)) DO UPDATE
                            SET name = {TAGS_TABLE}.name
                        RETURNING *""",
                    principal.user_id,
                    vis,
                    clean,
                    normalize_color(color),
                )
        finally:
            if own:
                await conn.close()
        return _row_to_tag(row)

    async def list(
        self,
        principal: Principal,
        *,
        entity_kind: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Tag]:
        """The visible vocabulary, ordered by name, with usage counts.

        ``entity_kind`` narrows the count (and drops unused tags) so a filter
        chip row can offer only tags that would actually match something —
        the equivalent of the file registry's surface facets.
        """
        params: list[object] = []
        if entity_kind is not None:
            validate_entity_kind(entity_kind)
            params.append(entity_kind)
            count_sql = (
                f"(SELECT COUNT(*) FROM {TAG_ASSIGNMENTS_TABLE} a "
                f"WHERE a.tag_id = t.id AND a.entity_kind = $1)"
            )
        else:
            count_sql = (
                f"(SELECT COUNT(*) FROM {TAG_ASSIGNMENTS_TABLE} a "
                f"WHERE a.tag_id = t.id)"
            )
        predicate = scope_filter(principal, start_index=len(params) + 1)
        params.extend(predicate.params)
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                rows = await conn.fetch(
                    f"""SELECT t.*, {count_sql} AS usage_count
                          FROM {TAGS_TABLE} t
                         WHERE {predicate.sql}
                      ORDER BY t.name""",
                    *params,
                )
        finally:
            if own:
                await conn.close()
        return [_row_to_tag(r, with_count=True) for r in rows]

    async def for_entity(
        self,
        principal: Principal,
        entity_kind: str,
        entity_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[Tag]:
        """Tags attached to one row, ordered by name."""
        validate_entity_kind(entity_kind)
        predicate = scope_filter(principal, start_index=3)
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                rows = await conn.fetch(
                    f"""SELECT t.*
                          FROM {TAGS_TABLE} t
                          JOIN {TAG_ASSIGNMENTS_TABLE} a ON a.tag_id = t.id
                         WHERE a.entity_kind = $1 AND a.entity_id = $2
                           AND {predicate.sql}
                      ORDER BY t.name""",
                    entity_kind,
                    str(entity_id),
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return [_row_to_tag(r) for r in rows]

    async def assign(
        self,
        principal: Principal,
        entity_kind: str,
        entity_id: str,
        name: str,
        *,
        color: Optional[str] = None,
        source: str = DEFAULT_SOURCE,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Tag:
        """Attach a tag (creating it when new) to a row. Idempotent."""
        validate_entity_kind(entity_kind)
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                tag = await self.ensure(
                    principal, name, color=color, connection=conn
                )
                await conn.execute(
                    f"""INSERT INTO {TAG_ASSIGNMENTS_TABLE}
                            (tag_id, entity_kind, entity_id, source)
                        VALUES ($1::uuid, $2, $3, $4)
                        ON CONFLICT (tag_id, entity_kind, entity_id)
                        DO NOTHING""",
                    tag.id,
                    entity_kind,
                    str(entity_id),
                    source or DEFAULT_SOURCE,
                )
        finally:
            if own:
                await conn.close()
        return tag

    async def unassign(
        self,
        principal: Principal,
        entity_kind: str,
        entity_id: str,
        tag_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Detach one tag from one row. ``True`` when something was removed."""
        validate_entity_kind(entity_kind)
        if not is_uuid(tag_id):
            return False
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                # The tag sub-select is scoped, so a member cannot detach a tag
                # they cannot see — the write mirrors the read policy rather
                # than trusting the caller to have checked.
                status = await conn.execute(
                    f"""DELETE FROM {TAG_ASSIGNMENTS_TABLE} a
                         WHERE a.tag_id = $1::uuid
                           AND a.entity_kind = $2
                           AND a.entity_id = $3
                           AND EXISTS (
                               SELECT 1 FROM {TAGS_TABLE} t
                                WHERE t.id = a.tag_id
                                  AND t.owner_user_id = $4
                           )""",
                    tag_id,
                    entity_kind,
                    str(entity_id),
                    principal.user_id,
                )
        finally:
            if own:
                await conn.close()
        return status.rsplit(" ", 1)[-1] != "0"

    async def delete(
        self,
        principal: Principal,
        tag_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Remove a tag from the vocabulary; assignments cascade."""
        if not is_uuid(tag_id):
            return False
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                status = await conn.execute(
                    f"DELETE FROM {TAGS_TABLE} "
                    f"WHERE id = $1::uuid AND owner_user_id = $2",
                    tag_id,
                    principal.user_id,
                )
        finally:
            if own:
                await conn.close()
        return status.rsplit(" ", 1)[-1] != "0"

    async def filter_entity_ids(
        self,
        principal: Principal,
        entity_kind: str,
        *,
        include: Sequence[str] = (),
        exclude: Sequence[str] = (),
        match: str = "any",
        connection: Optional["asyncpg.Connection"] = None,
    ) -> "TagFilter":
        """Resolve a tag filter to the id sets a caller can apply.

        Semantics are the ones ``SessionDB.filter_session_ids_by_tags``
        already established: ``match='any'`` is OR across the included tags,
        ``'all'`` is AND, and ``exclude`` drops a row carrying any excluded
        tag. An empty selection yields an empty :class:`TagFilter` so the
        caller can skip the join entirely.
        """
        validate_entity_kind(entity_kind)
        includes = [n.strip().lower() for n in include if str(n).strip()]
        excludes = [n.strip().lower() for n in exclude if str(n).strip()]
        if not includes and not excludes:
            return TagFilter(None, [])

        predicate = scope_filter(principal, start_index=2)
        base_params: list[object] = [entity_kind, *predicate.params]
        next_idx = len(base_params) + 1

        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                if includes:
                    having = ""
                    if match == "all":
                        having = (
                            f"HAVING COUNT(DISTINCT LOWER(t.name)) = ${next_idx + 1}"
                        )
                    rows = await conn.fetch(
                        f"""SELECT a.entity_id
                              FROM {TAG_ASSIGNMENTS_TABLE} a
                              JOIN {TAGS_TABLE} t ON t.id = a.tag_id
                             WHERE a.entity_kind = $1
                               AND {predicate.sql}
                               AND LOWER(t.name) = ANY(${next_idx}::text[])
                          GROUP BY a.entity_id
                          {having}""",
                        *base_params,
                        includes,
                        *([len(set(includes))] if match == "all" else []),
                    )
                    ids: Optional[list[str]] = [
                        str(r["entity_id"]) for r in rows
                    ]
                else:
                    # Exclusion only: nothing to restrict to, so the caller
                    # keeps its own candidate set and only subtracts.
                    ids = None

                if not excludes:
                    return TagFilter(ids, [])
                removed = await conn.fetch(
                    f"""SELECT DISTINCT a.entity_id
                          FROM {TAG_ASSIGNMENTS_TABLE} a
                          JOIN {TAGS_TABLE} t ON t.id = a.tag_id
                         WHERE a.entity_kind = $1
                           AND {predicate.sql}
                           AND LOWER(t.name) = ANY(${next_idx}::text[])""",
                    *base_params,
                    excludes,
                )
                excluded_ids = {str(r["entity_id"]) for r in removed}
        finally:
            if own:
                await conn.close()

        if ids is None:
            return TagFilter(None, sorted(excluded_ids))
        # Applying the exclusion here rather than handing back both sets keeps
        # the caller's query to a single `id = ANY` when includes are present.
        return TagFilter([eid for eid in ids if eid not in excluded_ids], [])

    async def purge_entity(
        self,
        entity_kind: str,
        entity_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Drop every assignment for a deleted row.

        ``entity_id`` is polymorphic and therefore has no foreign key, so the
        registry that owns the row must call this when it deletes one. Without
        it, a recycled id would inherit a stranger's tags.
        """
        validate_entity_kind(entity_kind)
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(
                f"DELETE FROM {TAG_ASSIGNMENTS_TABLE} "
                f"WHERE entity_kind = $1 AND entity_id = $2",
                entity_kind,
                str(entity_id),
            )
        finally:
            if own:
                await conn.close()


async def migrate_session_tags(
    registry: TagRegistry,
    principal: Principal,
    rows: Sequence[dict[str, Any]],
) -> int:
    """Import session tags from the SQLite store into the shared vocabulary.

    ``rows`` are ``{"name", "color", "session_id", "source"}`` mappings read
    from ``session_tags`` joined to ``session_tag_map``. Idempotent: both the
    vocabulary insert and the assignment insert are conflict-tolerant, so a
    re-run after a partial migration completes it rather than duplicating.

    This is the doctor's one-time move, deliberately kept out of the runtime
    read path: once it has run, nothing reads the SQLite tag tables again.
    """
    migrated = 0
    for row in rows:
        name = str(row.get("name") or "").strip()
        session_id = str(row.get("session_id") or "").strip()
        if not name or not session_id:
            continue
        await registry.assign(
            principal,
            "session",
            session_id,
            name,
            color=row.get("color"),
            source=str(row.get("source") or DEFAULT_SOURCE),
        )
        migrated += 1
    return migrated
