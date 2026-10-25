"""The inbound item registry: every arrival, in one place a browser can read.

WhatsApp messages, emails and calendar events all reach Hermes today and all
land somewhere private to the box that received them — the custom pipeline's
SQLite files (``messaging_data.db`` / ``email_data.db`` / ``calendar_data.db``),
reachable from MCP tools and the Telegram digest
and nowhere else. ``/inbox`` cannot list them because there is nothing shared
to list: the page shows FG-10 approvals and the FG-12 change log, which is why
it looks empty of the mail that actually arrived.

This table is the missing shared read model. It is deliberately a *projection*,
not a second source of truth: the pipeline keeps owning raw payloads, threading
and triage state in SQLite, and mirrors a normalized, principal-scoped summary
here so a user-facing surface has something durable and RLS-safe to page
through. Nothing here parses a mailbox or talks to an API.

Two design points worth knowing before changing anything:

* **Upsert, not append.** Unlike :mod:`hermes_cli.file_registry` — where the
  same file arriving twice is two facts — an email re-polled from IMAP or a
  calendar event that got rescheduled is *one* item that changed. Identity is
  ``(owner_user_id, surface, account_id, external_id)``, so a poller may
  re-register freely and a rescheduled meeting updates in place rather than
  appearing twice.
* **Search is pre-segmented.** ``search_text`` is written by
  :func:`hermes_cli.text_search.searchable`, which expands CJK runs into
  bigrams because Postgres cannot segment Chinese and would otherwise index a
  whole sentence as one lexeme. The tsvector is generated from *that* column,
  never from ``body`` directly — see that module for the full reasoning.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
# ``List`` rather than ``list`` in return annotations: the registry defines a
# method named ``list``, which shadows the builtin inside the class body.
from typing import TYPE_CHECKING, Any, List, Literal, Optional, Sequence

from hermes_cli.access import (
    Principal,
    apply_item_grants_rls,
    apply_scope_rls,
    bind_elevated_reads,
    bind_principal,
    initialize_access,
    normalize_visibility,
    scope_filter,
    ITEM_GRANTS_SCHEMA_SQL,
)
from hermes_cli.tags import TagRegistry
from hermes_cli.text_search import needs_substring_fallback, searchable

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

log = logging.getLogger(__name__)

INBOUND_ITEMS_TABLE = "inbound_items"

#: Grants reuse the ``document`` item kind, as the file registry does: sharing
#: an arrival and sharing what was remembered from it are one act to the person
#: doing it, and a new kind would need its own CHECK migration.
GRANT_ITEM_KIND = "document"

#: Where an item arrived from. Open-ended by design — an adapter passes its own
#: platform name and an unknown one is stored verbatim rather than rejected, so
#: a new channel does not need a migration before its arrivals are recorded.
KNOWN_SURFACES: tuple[str, ...] = (
    "whatsapp",
    "email",
    "calendar",
    "telegram",
    "discord",
    "slack",
    "agent_home",
)

#: What kind of thing arrived. ``message`` covers chat and mail; ``event`` is a
#: calendar entry, which has a start time rather than only an arrival time.
ITEM_KINDS: tuple[str, ...] = ("message", "event", "call", "system")

#: Bodies are stored for search and preview, not archival — the pipeline keeps
#: the full payload. Cutting here bounds both the row and the search index; an
#: email thread with fifty quoted replies is not made more findable by its
#: fiftieth copy of the disclaimer.
MAX_BODY_CHARS = 20_000

#: The page ceiling, matching the file registry's.
MAX_PAGE_SIZE = 200
DEFAULT_PAGE_SIZE = 50


SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {INBOUND_ITEMS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    -- Where it came from.
    surface TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    -- Who and what.
    conversation TEXT,
    conversation_name TEXT,
    sender_id TEXT,
    sender_name TEXT,
    subject TEXT,
    body TEXT NOT NULL DEFAULT '',
    -- When. `occurred_at` is the event's own time (message sent, meeting
    -- starts), which is what a user orders an inbox by; `registered_at` is
    -- when we learned about it, which is what a backfill needs to resume.
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Triage, mirrored from the pipeline so a filter chip does not have to
    -- cross into SQLite to know what is urgent.
    importance TEXT,
    has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    -- Set only once somebody decided this arrival is worth remembering, the
    -- same separation the file registry keeps between a fact and a judgement.
    document_id UUID,
    remembered_at TIMESTAMPTZ,
    remembered_by TEXT,
    -- Pre-segmented search text (CJK runs expanded to bigrams) and the vector
    -- generated from it. `body` is never indexed directly: Postgres has no
    -- Chinese segmentation, so a Chinese sentence would be one lexeme and the
    -- words inside it unfindable.
    search_text TEXT NOT NULL DEFAULT '',
    search_tsv tsvector GENERATED ALWAYS AS
        (to_tsvector('simple', search_text)) STORED
);
-- One row per item, not per sighting: a re-polled email or a rescheduled
-- meeting updates in place. `account_id` defaults to '' rather than NULL so
-- this stays a usable unique key (NULLs never conflict, which would silently
-- let duplicates through for any surface without an account).
CREATE UNIQUE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_identity_idx
    ON {INBOUND_ITEMS_TABLE} (owner_user_id, surface, account_id, external_id);
-- The keyset page: ORDER BY occurred_at DESC, id DESC with a (ts, id) cursor
-- reads straight off this index, so page 100 costs what page 1 costs.
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_owner_occurred_idx
    ON {INBOUND_ITEMS_TABLE} (owner_user_id, occurred_at DESC, id DESC);
-- The same page for a reader whose scope predicate is `TRUE` (the owner, and
-- so every read on a single-user box): with no `owner_user_id` equality the
-- index above cannot supply the order, and each page was a full scan + sort.
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_occurred_idx
    ON {INBOUND_ITEMS_TABLE} (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_surface_idx
    ON {INBOUND_ITEMS_TABLE} (surface);
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_visibility_idx
    ON {INBOUND_ITEMS_TABLE} (visibility);
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_document_idx
    ON {INBOUND_ITEMS_TABLE} (document_id);
CREATE INDEX IF NOT EXISTS {INBOUND_ITEMS_TABLE}_search_idx
    ON {INBOUND_ITEMS_TABLE} USING GIN (search_tsv);
"""

#: Links an attachment back to the arrival that carried it, so a file detail
#: page can show "arrived in this email" and an item can list its files.
#: Added separately because ``file_assets`` already exists.
FILE_LINK_SQL = f"""
ALTER TABLE file_assets
    ADD COLUMN IF NOT EXISTS inbound_item_id UUID;
CREATE INDEX IF NOT EXISTS file_assets_inbound_item_idx
    ON file_assets (inbound_item_id);
"""


@dataclass(frozen=True)
class InboundItem:
    """One arrival."""

    id: str
    owner_user_id: str
    visibility: str
    surface: str
    account_id: str
    external_id: str
    kind: str
    conversation: Optional[str]
    conversation_name: Optional[str]
    sender_id: Optional[str]
    sender_name: Optional[str]
    subject: Optional[str]
    body: str
    occurred_at: Optional[datetime]
    ends_at: Optional[datetime]
    registered_at: Optional[datetime]
    updated_at: Optional[datetime]
    importance: Optional[str]
    has_attachments: bool
    metadata: dict[str, Any]
    document_id: Optional[str]
    remembered_at: Optional[datetime]
    remembered_by: Optional[str]

    @property
    def remembered(self) -> bool:
        return self.document_id is not None

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner_user_id": self.owner_user_id,
            "visibility": self.visibility,
            "surface": self.surface,
            "account_id": self.account_id,
            "external_id": self.external_id,
            "kind": self.kind,
            "conversation": self.conversation,
            "conversation_name": self.conversation_name,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "subject": self.subject,
            "body": self.body,
            "occurred_at": (
                self.occurred_at.isoformat() if self.occurred_at else None
            ),
            "ends_at": self.ends_at.isoformat() if self.ends_at else None,
            "registered_at": (
                self.registered_at.isoformat() if self.registered_at else None
            ),
            "importance": self.importance,
            "has_attachments": self.has_attachments,
            "metadata": self.metadata,
            "document_id": self.document_id,
            "remembered_at": (
                self.remembered_at.isoformat() if self.remembered_at else None
            ),
            "remembered_by": self.remembered_by,
            "remembered": self.remembered,
        }


@dataclass(frozen=True)
class InboundPage:
    """A keyset page: the rows, and the cursor that continues after them.

    ``next_cursor`` is ``None`` at the end of the list. There is no total —
    counting the whole filtered set on every page would reintroduce exactly the
    full scan keyset paging exists to avoid, and an inbox does not need one.
    """

    items: list[InboundItem]
    next_cursor: Optional[str]


def _row_to_item(row: Any) -> InboundItem:
    import json

    raw_meta = row["metadata"]
    if isinstance(raw_meta, str):
        try:
            metadata = json.loads(raw_meta)
        except ValueError:
            metadata = {}
    else:
        metadata = dict(raw_meta or {})
    return InboundItem(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        surface=str(row["surface"]),
        account_id=str(row["account_id"]),
        external_id=str(row["external_id"]),
        kind=str(row["kind"]),
        conversation=row["conversation"],
        conversation_name=row["conversation_name"],
        sender_id=row["sender_id"],
        sender_name=row["sender_name"],
        subject=row["subject"],
        body=str(row["body"]),
        occurred_at=row["occurred_at"],
        ends_at=row["ends_at"],
        registered_at=row["registered_at"],
        updated_at=row["updated_at"],
        importance=row["importance"],
        has_attachments=bool(row["has_attachments"]),
        metadata=metadata,
        document_id=str(row["document_id"]) if row["document_id"] else None,
        remembered_at=row["remembered_at"],
        remembered_by=row["remembered_by"],
    )


def encode_cursor(item: InboundItem) -> str:
    """The opaque "resume after this row" token: its sort key, encoded.

    Opaque so the ordering can change without breaking a client that stored
    one, and so nobody builds a cursor by hand out of a timestamp they guessed.
    """
    import base64

    ts = item.occurred_at.isoformat() if item.occurred_at else ""
    raw = f"{ts}|{item.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    """Inverse of :func:`encode_cursor`. Raises ``ValueError`` when malformed."""
    import base64

    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        ts_text, _, item_id = raw.partition("|")
        return datetime.fromisoformat(ts_text), item_id
    except Exception as exc:  # noqa: BLE001 - one error for every malformation
        raise ValueError(f"Malformed cursor: {cursor!r}") from exc


def build_search_text(
    *,
    subject: Optional[str],
    body: str,
    sender_name: Optional[str],
    conversation_name: Optional[str],
) -> str:
    """The indexed text for one item, CJK-segmented.

    Sender and conversation names are folded in because "everything from Ada"
    and "the tender group chat" are how people actually search an inbox, and a
    separate ILIKE on those columns would not use the index.
    """
    parts = [p for p in (subject, sender_name, conversation_name, body) if p]
    return searchable(" ".join(parts))


def default_registry(mode: Optional[str] = None) -> "InboundRegistry":
    """A registry against the instance's configured schema."""
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store
    from plugins.memory.supabase_pgvector.store import _role_reads_configured

    config = load_config() or {}
    # Narrowed explicitly rather than with a membership test so the literal
    # StoreMode type survives; anything else falls back to the default.
    resolved: Optional[Literal["dev", "prod"]] = None
    if mode == "dev":
        resolved = "dev"
    elif mode == "prod":
        resolved = "prod"
    app_store = get_store("supabase-app", resolved, config=config)
    return InboundRegistry(app_store, role_reads=_role_reads_configured(config))


class InboundRegistry:
    """Read/write access to :data:`INBOUND_ITEMS_TABLE` under contract C2."""

    def __init__(
        self,
        app_store: "SupabaseAppStore",
        *,
        role_reads: bool = False,
    ) -> None:
        self._store = app_store
        self.role_reads = role_reads
        self.tags = TagRegistry(app_store)

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
        """Create the table, its indexes and its RLS policy. Idempotent."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            await conn.execute(SCHEMA_SQL)
            await initialize_access(conn)
            await conn.execute(ITEM_GRANTS_SCHEMA_SQL)
            await apply_item_grants_rls(conn)
            await apply_scope_rls(
                conn,
                INBOUND_ITEMS_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                role_elevation=self.role_reads,
            )
            await self.tags.initialize(connection=conn)
            # The attachment link needs file_assets to exist; when it does not
            # (an install with no file registry yet) the arrival record is
            # still perfectly usable, so this is not fatal.
            try:
                await conn.execute(FILE_LINK_SQL)
            except Exception as exc:  # noqa: BLE001
                log.debug("inbound registry: file link not applied (%s)", exc)
        finally:
            if own:
                await conn.close()

    async def register(
        self,
        principal: Principal,
        *,
        surface: str,
        external_id: str,
        account_id: str = "",
        kind: str = "message",
        conversation: Optional[str] = None,
        conversation_name: Optional[str] = None,
        sender_id: Optional[str] = None,
        sender_name: Optional[str] = None,
        subject: Optional[str] = None,
        body: str = "",
        occurred_at: Optional[datetime] = None,
        ends_at: Optional[datetime] = None,
        importance: Optional[str] = None,
        has_attachments: bool = False,
        metadata: Optional[dict[str, Any]] = None,
        visibility: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> InboundItem:
        """Record an arrival, or update the one already recorded.

        Identity is ``(owner, surface, account_id, external_id)``. A poller
        re-reading the same mailbox page, or a calendar sync seeing a meeting
        move, updates the existing row: the inbox shows one entry that changed,
        not two that disagree.
        """
        import json

        text = (body or "")[:MAX_BODY_CHARS]
        vis = normalize_visibility(visibility or principal.private_visibility)
        search_text = build_search_text(
            subject=subject,
            body=text,
            sender_name=sender_name,
            conversation_name=conversation_name,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""INSERT INTO {INBOUND_ITEMS_TABLE} (
                        owner_user_id, visibility, surface, account_id,
                        external_id, kind, conversation, conversation_name,
                        sender_id, sender_name, subject, body,
                        occurred_at, ends_at, importance, has_attachments,
                        metadata, search_text)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                            COALESCE($13, NOW()), $14, $15, $16,
                            $17::jsonb, $18)
                    ON CONFLICT (owner_user_id, surface, account_id, external_id)
                    DO UPDATE SET
                        kind = EXCLUDED.kind,
                        conversation = EXCLUDED.conversation,
                        conversation_name = EXCLUDED.conversation_name,
                        sender_id = EXCLUDED.sender_id,
                        sender_name = EXCLUDED.sender_name,
                        subject = EXCLUDED.subject,
                        body = EXCLUDED.body,
                        occurred_at = EXCLUDED.occurred_at,
                        ends_at = EXCLUDED.ends_at,
                        -- A re-poll carries no triage verdict, so it must not
                        -- erase the one the triage agent already wrote.
                        importance = COALESCE(
                            EXCLUDED.importance,
                            {INBOUND_ITEMS_TABLE}.importance
                        ),
                        has_attachments = EXCLUDED.has_attachments,
                        metadata = EXCLUDED.metadata,
                        search_text = EXCLUDED.search_text,
                        updated_at = NOW()
                    RETURNING *""",
                principal.user_id,
                vis,
                surface,
                account_id or "",
                str(external_id),
                kind,
                conversation,
                conversation_name,
                sender_id,
                sender_name,
                subject,
                text,
                occurred_at,
                ends_at,
                importance,
                bool(has_attachments),
                json.dumps(metadata or {}),
                search_text,
            )
        finally:
            if own:
                await conn.close()
        return _row_to_item(row)

    async def get(
        self,
        principal: Principal,
        item_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[InboundItem]:
        """One item, or ``None`` when it does not exist or is not visible."""
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{INBOUND_ITEMS_TABLE}.id",
            role_elevation=self.role_reads,
            owner_column=f"{INBOUND_ITEMS_TABLE}.owner_user_id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                row = await conn.fetchrow(
                    f"""SELECT * FROM {INBOUND_ITEMS_TABLE}
                        WHERE id = $1::uuid AND {predicate.sql}""",
                    item_id,
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return _row_to_item(row) if row else None

    async def list(
        self,
        principal: Principal,
        *,
        query: str = "",
        surfaces: Sequence[str] = (),
        kinds: Sequence[str] = (),
        senders: Sequence[str] = (),
        importance: Sequence[str] = (),
        since: Optional[datetime] = None,
        until: Optional[datetime] = None,
        remembered: Optional[bool] = None,
        has_attachments: Optional[bool] = None,
        include_tags: Sequence[str] = (),
        exclude_tags: Sequence[str] = (),
        tag_match: str = "any",
        limit: int = DEFAULT_PAGE_SIZE,
        cursor: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> InboundPage:
        """A keyset page of visible arrivals, newest first.

        ``query`` runs against the pre-segmented ``search_tsv``, so Chinese
        matches as well as English does. A single CJK character has no bigram
        and cannot be found that way, so those queries fall back to a bounded
        substring scan — the one case where the index cannot help.
        """
        clauses: list[str] = []
        params: list[object] = []

        def add(sql_template: str, *values: object) -> None:
            """Append a clause, numbering its placeholders from the next free slot."""
            start = len(params) + 1
            clauses.append(
                sql_template.format(
                    *[f"${start + offset}" for offset in range(len(values))]
                )
            )
            params.extend(values)

        text = (query or "").strip()
        if text:
            if needs_substring_fallback(text):
                add("body ILIKE {0}", f"%{text}%")
            else:
                add(
                    "search_tsv @@ websearch_to_tsquery('simple', {0})",
                    searchable(text),
                )
        if surfaces:
            add("surface = ANY({0}::text[])", list(surfaces))
        if kinds:
            add("kind = ANY({0}::text[])", list(kinds))
        if senders:
            add(
                "(sender_id = ANY({0}::text[]) OR sender_name = ANY({0}::text[]))",
                list(senders),
            )
        if importance:
            add("importance = ANY({0}::text[])", list(importance))
        if since is not None:
            add("occurred_at >= {0}", since)
        if until is not None:
            add("occurred_at <= {0}", until)
        if remembered is True:
            clauses.append("document_id IS NOT NULL")
        elif remembered is False:
            clauses.append("document_id IS NULL")
        if has_attachments is not None:
            add("has_attachments = {0}", bool(has_attachments))

        own = connection is None
        conn = connection or await self._connect()
        try:
            if include_tags or exclude_tags:
                tag_filter = await self.tags.filter_entity_ids(
                    principal,
                    "inbound",
                    include=include_tags,
                    exclude=exclude_tags,
                    match=tag_match,
                    connection=conn,
                )
                if tag_filter.matches_nothing:
                    return InboundPage([], None)
                if tag_filter.match_ids is not None:
                    add("id = ANY({0}::uuid[])", tag_filter.match_ids)
                if tag_filter.excluded_ids:
                    add("NOT (id = ANY({0}::uuid[]))", tag_filter.excluded_ids)

            if cursor:
                cursor_ts, cursor_id = decode_cursor(cursor)
                # The tuple comparison is what makes this a keyset read: it
                # resolves ties on occurred_at by id, so no row is skipped or
                # repeated when several share a timestamp.
                add("(occurred_at, id) < ({0}, {1}::uuid)", cursor_ts, cursor_id)

            predicate = scope_filter(
                principal,
                start_index=len(params) + 1,
                grant_item_kind=GRANT_ITEM_KIND,
                id_column=f"{INBOUND_ITEMS_TABLE}.id",
                role_elevation=self.role_reads,
                owner_column=f"{INBOUND_ITEMS_TABLE}.owner_user_id",
            )
            clauses.append(predicate.sql)
            params.extend(predicate.params)
            where = " AND ".join(clauses) if clauses else "TRUE"

            page_size = max(1, min(int(limit), MAX_PAGE_SIZE))
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                rows = await conn.fetch(
                    f"""SELECT * FROM {INBOUND_ITEMS_TABLE}
                        WHERE {where}
                        ORDER BY occurred_at DESC, id DESC
                        LIMIT {page_size + 1}""",
                    *params,
                )
        finally:
            if own:
                await conn.close()

        # One row over the page size answers "is there more?" without a second
        # count query; it is fetched and dropped, never shown.
        items = [_row_to_item(r) for r in rows[:page_size]]
        next_cursor = (
            encode_cursor(items[-1]) if len(rows) > page_size and items else None
        )
        return InboundPage(items, next_cursor)

    async def facets(
        self,
        principal: Principal,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> dict[str, List[dict[str, Any]]]:
        """Counts per surface and per importance, for the filter chips.

        Cheap enough to run per page load (both are indexed group-bys over the
        visible set) and worth it: a chip row that offers "calendar" when no
        calendar item exists is a dead end the user has to discover by clicking.
        """
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{INBOUND_ITEMS_TABLE}.id",
            role_elevation=self.role_reads,
            owner_column=f"{INBOUND_ITEMS_TABLE}.owner_user_id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                surface_rows = await conn.fetch(
                    f"""SELECT surface AS value, COUNT(*) AS count
                          FROM {INBOUND_ITEMS_TABLE}
                         WHERE {predicate.sql}
                      GROUP BY surface ORDER BY count DESC, surface""",
                    *predicate.params,
                )
                importance_rows = await conn.fetch(
                    f"""SELECT importance AS value, COUNT(*) AS count
                          FROM {INBOUND_ITEMS_TABLE}
                         WHERE importance IS NOT NULL AND {predicate.sql}
                      GROUP BY importance ORDER BY count DESC, importance""",
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return {
            "surfaces": [
                {"value": r["value"], "count": int(r["count"])} for r in surface_rows
            ],
            "importance": [
                {"value": r["value"], "count": int(r["count"])}
                for r in importance_rows
            ],
        }

    async def mark_remembered(
        self,
        principal: Principal,
        item_id: str,
        *,
        document_id: str,
        remembered_by: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[InboundItem]:
        """Link an arrival to the document ingested from it, and say who decided."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""UPDATE {INBOUND_ITEMS_TABLE}
                           SET document_id = $2::uuid,
                               remembered_at = NOW(),
                               remembered_by = $3,
                               updated_at = NOW()
                         WHERE id = $1::uuid AND owner_user_id = $4
                     RETURNING *""",
                    item_id,
                    document_id,
                    remembered_by,
                    principal.user_id,
                )
        finally:
            if own:
                await conn.close()
        return _row_to_item(row) if row else None

    async def set_importance(
        self,
        principal: Principal,
        *,
        surface: str,
        external_id: str,
        account_id: str = "",
        importance: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Record a triage verdict against an arrival already registered.

        Addressed by the channel's own identity rather than by row id: triage
        runs later, in a different process, and knows the message id it
        classified — not the uuid the registry happened to mint for it.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                status = await conn.execute(
                    f"""UPDATE {INBOUND_ITEMS_TABLE}
                           SET importance = $5, updated_at = NOW()
                         WHERE owner_user_id = $1 AND surface = $2
                           AND account_id = $3 AND external_id = $4""",
                    principal.user_id,
                    surface,
                    account_id or "",
                    external_id,
                    importance,
                )
        finally:
            if own:
                await conn.close()
        return status.rsplit(" ", 1)[-1] != "0"

    async def id_for(
        self,
        principal: Principal,
        *,
        surface: str,
        external_id: str,
        account_id: str = "",
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[str]:
        """The registry id of an arrival, addressed by the channel's identity.

        The counterpart of :meth:`set_importance`'s addressing, for callers
        that need the row id rather than a write: a to-do created by triage
        links back to the message with ``source_ref``, and triage knows the
        message id it read, not the uuid the registry minted.
        """
        predicate = scope_filter(principal, start_index=4)
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""SELECT id FROM {INBOUND_ITEMS_TABLE}
                     WHERE surface = $1 AND account_id = $2
                       AND external_id = $3 AND {predicate.sql}
                     LIMIT 1""",
                surface,
                account_id or "",
                external_id,
                *predicate.params,
            )
            return str(row["id"]) if row else None
        finally:
            if own:
                await conn.close()

    async def link_attachment(
        self,
        principal: Principal,
        item_id: str,
        asset_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Attribute a registered file to the arrival that carried it."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                status = await conn.execute(
                    """UPDATE file_assets
                          SET inbound_item_id = $2::uuid
                        WHERE id = $1::uuid AND owner_user_id = $3""",
                    asset_id,
                    item_id,
                    principal.user_id,
                )
                if status.rsplit(" ", 1)[-1] != "0":
                    await conn.execute(
                        f"""UPDATE {INBOUND_ITEMS_TABLE}
                               SET has_attachments = TRUE, updated_at = NOW()
                             WHERE id = $1::uuid AND owner_user_id = $2""",
                        item_id,
                        principal.user_id,
                    )
        finally:
            if own:
                await conn.close()
        return status.rsplit(" ", 1)[-1] != "0"

    async def attachments(
        self,
        principal: Principal,
        item_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[dict[str, Any]]:
        """The files that arrived with this item, scoped to the reader."""
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column="file_assets.id",
            role_elevation=self.role_reads,
            owner_column="file_assets.owner_user_id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                # A box that has never registered a file has no `file_assets`,
                # and "no attachments" is the honest answer there rather than a
                # 500 on an otherwise working detail page.
                if not await conn.fetchval(
                    "SELECT to_regclass(current_schema() || '.file_assets')"
                ):
                    return []
                rows = await conn.fetch(
                    f"""SELECT id, filename, content_type, byte_size,
                               document_id, received_at
                          FROM file_assets
                         WHERE inbound_item_id = $1::uuid AND {predicate.sql}
                      ORDER BY received_at""",
                    item_id,
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return [
            {
                "id": str(r["id"]),
                "filename": r["filename"],
                "content_type": r["content_type"],
                "byte_size": int(r["byte_size"]),
                "document_id": str(r["document_id"]) if r["document_id"] else None,
                "remembered": r["document_id"] is not None,
            }
            for r in rows
        ]

    async def delete(
        self,
        principal: Principal,
        item_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Remove an arrival and the tag assignments pointing at it.

        The tag cleanup is explicit because ``tag_assignments.entity_id`` is
        polymorphic and cannot carry a foreign key; without it a recycled id
        would inherit a stranger's tags.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                status = await conn.execute(
                    f"DELETE FROM {INBOUND_ITEMS_TABLE} "
                    f"WHERE id = $1::uuid AND owner_user_id = $2",
                    item_id,
                    principal.user_id,
                )
                if status.rsplit(" ", 1)[-1] != "0":
                    await self.tags.purge_entity(
                        "inbound", item_id, connection=conn
                    )
        finally:
            if own:
                await conn.close()
        return status.rsplit(" ", 1)[-1] != "0"


async def register_arrival(
    principal: Principal,
    *,
    surface: str,
    external_id: str,
    registry: Optional[InboundRegistry] = None,
    **fields: Any,
) -> Optional[InboundItem]:
    """Best-effort registration for the pipeline hooks. Never raises.

    Returns ``None`` when the shared store is unreachable or anything else goes
    wrong. An arrival failing to mirror is recoverable by a backfill; a poller
    crashing because Postgres was briefly down would lose the message itself.
    """
    try:
        reg = registry if registry is not None else default_registry()
        return await reg.register(
            principal, surface=surface, external_id=external_id, **fields
        )
    except Exception as exc:  # noqa: BLE001 - mirroring is never fatal
        log.warning(
            "inbound registry: could not register %s/%s (%s)",
            surface,
            external_id,
            exc,
        )
        return None
