"""The inbound file registry: every file that arrives, with its provenance.

A file reaching Hermes today is read once and forgotten — gateway attachments
are cached under ``cache/documents`` and pruned after a day, and agent-home
uploads land in a private Supabase bucket nobody can list. Neither is a record
of *what arrived, from whom, when*.

This module is that record, and it is deliberately **not** memory. Registering
is a fact ("this file arrived"); ingesting it into the RAG tier is a judgement
("this matters"), made later by the user or by a triage skill. Conflating them
is how a corpus fills up with group-chat stickers, so nothing here embeds
anything or writes to ``rag_documents``; it only stores ``document_id`` once
somebody has decided.

Scoping matches the memory tier exactly — contract C2 visibility, per-item
grants and (where enabled) downward role reads — because a registry with weaker
access than memory would be a way to read somebody's private material by asking
a different table for it.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional, Sequence

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

if TYPE_CHECKING:  # pragma: no cover - typing only
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

#: The registry table. Sits beside ``memories`` / ``rag_documents`` in the same
#: app schema, so one deployment mode covers channels, memory and files alike.
FILE_ASSETS_TABLE = "file_assets"

#: Grants reuse the ``document`` item kind rather than adding a sixth: a share
#: of a file and a share of the document ingested from it are the same act to
#: the person doing it, and a new kind would need its own CHECK migration.
GRANT_ITEM_KIND = "document"

#: Surfaces a file can arrive from. Open-ended by design — an adapter passes its
#: platform name and an unknown one is stored verbatim rather than rejected, so
#: a new channel does not need a migration before its files are recorded.
KNOWN_SURFACES: tuple[str, ...] = (
    "agent_home",
    "telegram",
    "whatsapp",
    "email",
    "calendar",
)

#: Registration ceiling. Above this the bytes are left where they are and no row
#: is written: the registry is a record of correspondence, not a backup target.
MAX_REGISTER_BYTES = 25 * 1024 * 1024

_SLUG = re.compile(r"[^A-Za-z0-9._-]+")


SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {FILE_ASSETS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    -- Provenance: where it came from, who sent it, when.
    surface TEXT NOT NULL,
    account_id TEXT,
    conversation TEXT,
    sender_id TEXT,
    sender_name TEXT,
    message_id TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The file itself.
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_size BIGINT NOT NULL DEFAULT 0,
    sha256 TEXT NOT NULL,
    storage_bucket TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    -- Set only once somebody decided this file is worth remembering.
    document_id UUID,
    remembered_at TIMESTAMPTZ,
    remembered_by TEXT,
    -- The message this file arrived in, when it arrived through a channel
    -- rather than an upload. No foreign key: the two registrations are
    -- independent best-effort writes, so the file must still record itself
    -- when the item's write is the one that failed.
    inbound_item_id UUID
    -- One row per *arrival*, deliberately not per distinct file. The same deck
    -- forwarded by two people in two chats is two events with two answers to
    -- "who sent me this, and when", and collapsing them on the hash would
    -- destroy exactly the provenance this table exists to keep. The bytes are
    -- shared instead: the storage key is content-addressed, so N arrivals of
    -- identical bytes cost one object and N rows pointing at it.
);
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_owner_received_idx
    ON {FILE_ASSETS_TABLE} (owner_user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_surface_idx
    ON {FILE_ASSETS_TABLE} (surface);
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_document_idx
    ON {FILE_ASSETS_TABLE} (document_id);
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_visibility_idx
    ON {FILE_ASSETS_TABLE} (visibility);
-- Finds the sibling arrivals of the same bytes ("where else did this reach
-- me?") and lets a backfill skip an object it has already recorded.
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_owner_sha_idx
    ON {FILE_ASSETS_TABLE} (owner_user_id, sha256);
-- `get_by_storage_path` (project file links) and the storage import's
-- per-object "already registered?" probe look rows up by path alone.
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_storage_path_idx
    ON {FILE_ASSETS_TABLE} (storage_path);
-- For a table created before the Incomings feature shipped. Idempotent, and
-- mirrored in ``inbound_registry`` for the box where only that side is
-- initialised.
ALTER TABLE {FILE_ASSETS_TABLE}
    ADD COLUMN IF NOT EXISTS inbound_item_id UUID;
CREATE INDEX IF NOT EXISTS {FILE_ASSETS_TABLE}_inbound_item_idx
    ON {FILE_ASSETS_TABLE} (inbound_item_id);
"""


@dataclass(frozen=True)
class FileAsset:
    """One registered file."""

    id: str
    owner_user_id: str
    visibility: str
    surface: str
    account_id: Optional[str]
    conversation: Optional[str]
    sender_id: Optional[str]
    sender_name: Optional[str]
    message_id: Optional[str]
    received_at: Optional[datetime]
    filename: str
    content_type: str
    byte_size: int
    sha256: str
    storage_bucket: str
    storage_path: str
    document_id: Optional[str]
    remembered_at: Optional[datetime]
    remembered_by: Optional[str]
    inbound_item_id: Optional[str] = None

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
            "conversation": self.conversation,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "message_id": self.message_id,
            "received_at": (
                self.received_at.isoformat() if self.received_at else None
            ),
            "filename": self.filename,
            "content_type": self.content_type,
            "byte_size": self.byte_size,
            "sha256": self.sha256,
            "storage_path": self.storage_path,
            "document_id": self.document_id,
            "remembered_at": (
                self.remembered_at.isoformat() if self.remembered_at else None
            ),
            "remembered_by": self.remembered_by,
            "remembered": self.remembered,
            "inbound_item_id": self.inbound_item_id,
        }


def _row_to_asset(row: Any) -> FileAsset:
    return FileAsset(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        surface=str(row["surface"]),
        account_id=row["account_id"],
        conversation=row["conversation"],
        sender_id=row["sender_id"],
        sender_name=row["sender_name"],
        message_id=row["message_id"],
        received_at=row["received_at"],
        filename=str(row["filename"]),
        content_type=str(row["content_type"]),
        byte_size=int(row["byte_size"]),
        sha256=str(row["sha256"]),
        storage_bucket=str(row["storage_bucket"]),
        storage_path=str(row["storage_path"]),
        document_id=str(row["document_id"]) if row["document_id"] else None,
        remembered_at=row["remembered_at"],
        remembered_by=row["remembered_by"],
        inbound_item_id=(
            str(row["inbound_item_id"]) if row["inbound_item_id"] else None
        ),
    )


def content_digest(data: bytes) -> str:
    """SHA-256 of the bytes — the identity of a file, independent of its name."""
    return hashlib.sha256(data).hexdigest()


def slug(value: str) -> str:
    """Filesystem/URL-safe fragment for a storage key."""
    cleaned = _SLUG.sub("-", (value or "").strip()).strip("-.")
    return cleaned[:120] or "file"


def storage_key(
    owner_user_id: str,
    surface: str,
    digest: str,
    filename: str,
    *,
    received_at: Optional[datetime] = None,
) -> str:
    """Where the bytes live in the bucket.

    Purely a function of owner and content — not of surface or arrival time —
    so the same file forwarded over three channels occupies one object while
    still producing three rows. That is the whole deduplication story: bytes
    are shared, provenance never is.

    The owner prefix keeps one person's material under one path (the bucket's
    own policies are written that way), and the two-character fan-out stops a
    heavy user's files from landing in a single unlistable directory.

    ``surface`` and ``received_at`` are accepted and unused: callers pass what
    they know, and a future layout may want them without a signature change.
    """
    return (
        f"{slug(owner_user_id)}/files/{digest[:2]}/"
        f"{digest[:16]}-{slug(filename)}"
    )


async def store_and_register(
    principal: Principal,
    data: bytes,
    *,
    surface: str,
    filename: str,
    content_type: str = "application/octet-stream",
    account_id: Optional[str] = None,
    conversation: Optional[str] = None,
    sender_id: Optional[str] = None,
    sender_name: Optional[str] = None,
    message_id: Optional[str] = None,
    received_at: Optional[datetime] = None,
    inbound_item_id: Optional[str] = None,
    registry: Optional["FileRegistry"] = None,
    storage: Optional[Any] = None,
) -> Optional[FileAsset]:
    """Put the bytes in the bucket and record the arrival. Best-effort.

    Returns ``None`` — never raises — when Storage is unconfigured, the file is
    over :data:`MAX_REGISTER_BYTES`, or anything else goes wrong. A file
    arriving is not a reason for the conversation it arrived in to fail, and a
    missing registry row is recoverable by a backfill; a dropped message is not.
    """
    import logging

    log = logging.getLogger(__name__)
    if not data or len(data) > MAX_REGISTER_BYTES:
        return None
    try:
        store = storage
        if store is None:
            from hermes_cli.filestore import SupabaseStorage

            store = SupabaseStorage.from_env()
        reg = registry if registry is not None else default_registry()
        digest = content_digest(data)
        key = storage_key(
            principal.user_id,
            surface,
            digest,
            filename,
            received_at=received_at,
        )
        await store.upload(key, data, content_type=content_type)
        return await reg.register(
            principal,
            surface=surface,
            filename=filename,
            content_type=content_type,
            byte_size=len(data),
            sha256=digest,
            storage_bucket=store.bucket,
            storage_path=key,
            account_id=account_id,
            conversation=conversation,
            sender_id=sender_id,
            sender_name=sender_name,
            message_id=message_id,
            received_at=received_at,
            inbound_item_id=inbound_item_id,
        )
    except Exception as exc:  # noqa: BLE001 - registration is never fatal
        log.warning("file registry: could not register %r (%s)", filename, exc)
        return None


def default_registry(mode: Optional[str] = None) -> "FileRegistry":
    """A registry against the instance's configured schema."""
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store
    from plugins.memory.supabase_pgvector.store import _role_reads_configured

    config = load_config() or {}
    resolved = mode if mode in ("dev", "prod") else None
    app_store = get_store("supabase-app", resolved, config=config)
    # The same switch the memory tier reads, so files and memories agree about
    # whether a role may read downward at all.
    return FileRegistry(app_store, role_reads=_role_reads_configured(config))


class FileRegistry:
    """Read/write access to :data:`FILE_ASSETS_TABLE` under contract C2."""

    def __init__(
        self,
        app_store: "SupabaseAppStore",
        *,
        role_reads: bool = False,
    ) -> None:
        self._store = app_store
        self.role_reads = role_reads

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
                FILE_ASSETS_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                role_elevation=self.role_reads,
            )
        finally:
            if own:
                await conn.close()

    async def register(
        self,
        principal: Principal,
        *,
        surface: str,
        filename: str,
        content_type: str,
        byte_size: int,
        sha256: str,
        storage_bucket: str,
        storage_path: str,
        account_id: Optional[str] = None,
        conversation: Optional[str] = None,
        sender_id: Optional[str] = None,
        sender_name: Optional[str] = None,
        message_id: Optional[str] = None,
        received_at: Optional[datetime] = None,
        inbound_item_id: Optional[str] = None,
        visibility: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> FileAsset:
        """Record one arrival — always a new row.

        Sending the same file three times yields three rows, because three
        people sending you the same contract at three moments is three facts.
        Only the bytes are shared (one content-addressed object); provenance
        never is.
        """
        vis = normalize_visibility(visibility or principal.private_visibility)
        own = connection is None
        conn = connection or await self._connect()
        try:
            row = await conn.fetchrow(
                f"""INSERT INTO {FILE_ASSETS_TABLE} (
                        owner_user_id, visibility, surface, account_id,
                        conversation, sender_id, sender_name, message_id,
                        received_at, filename, content_type, byte_size,
                        sha256, storage_bucket, storage_path, inbound_item_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                            COALESCE($9, NOW()), $10, $11, $12, $13, $14, $15,
                            $16::uuid)
                    RETURNING *""",
                principal.user_id,
                vis,
                surface,
                account_id,
                conversation,
                sender_id,
                sender_name,
                message_id,
                received_at,
                filename,
                content_type or "application/octet-stream",
                int(byte_size),
                sha256,
                storage_bucket,
                storage_path,
                inbound_item_id,
            )
        finally:
            if own:
                await conn.close()
        return _row_to_asset(row)

    async def get(
        self,
        principal: Principal,
        asset_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[FileAsset]:
        """One file, or ``None`` when it does not exist or is not visible."""
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{FILE_ASSETS_TABLE}.id",
            role_elevation=self.role_reads,
            owner_column=f"{FILE_ASSETS_TABLE}.owner_user_id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                row = await conn.fetchrow(
                    f"""SELECT * FROM {FILE_ASSETS_TABLE}
                        WHERE id = $1::uuid AND {predicate.sql}""",
                    asset_id,
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return _row_to_asset(row) if row else None

    async def get_by_storage_path(
        self,
        principal: Principal,
        storage_path: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[FileAsset]:
        """The newest visible row stored at *storage_path*, or ``None``.

        The same bytes can carry several provenance rows (dedup), so the
        most recent visible one wins. Same visibility predicate as
        :meth:`get` — invisible == absent.
        """
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{FILE_ASSETS_TABLE}.id",
            role_elevation=self.role_reads,
            owner_column=f"{FILE_ASSETS_TABLE}.owner_user_id",
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                row = await conn.fetchrow(
                    f"""SELECT * FROM {FILE_ASSETS_TABLE}
                        WHERE storage_path = $1 AND {predicate.sql}
                        ORDER BY received_at DESC NULLS LAST, id DESC""",
                    storage_path,
                    *predicate.params,
                )
        finally:
            if own:
                await conn.close()
        return _row_to_asset(row) if row else None

    async def list(
        self,
        principal: Principal,
        *,
        query: str = "",
        surfaces: Sequence[str] = (),
        remembered: Optional[bool] = None,
        limit: int = 50,
        offset: int = 0,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> tuple[list[FileAsset], int]:
        """A page of visible files, newest first, plus the unpaged total.

        ``query`` matches filename and sender name — substring, case-insensitive.
        Deliberately not full-text over content: most registered files are
        images and voice notes with no text at all, and a search box that
        silently ignores them would be worse than one that never claimed to.
        """
        clauses: list[str] = []
        params: list[object] = []
        idx = 1
        if query.strip():
            clauses.append(
                f"(filename ILIKE ${idx} OR COALESCE(sender_name, '') ILIKE ${idx})"
            )
            params.append(f"%{query.strip()}%")
            idx += 1
        if surfaces:
            clauses.append(f"surface = ANY(${idx}::text[])")
            params.append(list(surfaces))
            idx += 1
        if remembered is True:
            clauses.append("document_id IS NOT NULL")
        elif remembered is False:
            clauses.append("document_id IS NULL")

        predicate = scope_filter(
            principal,
            start_index=idx,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{FILE_ASSETS_TABLE}.id",
            role_elevation=self.role_reads,
            owner_column=f"{FILE_ASSETS_TABLE}.owner_user_id",
        )
        clauses.append(predicate.sql)
        params.extend(predicate.params)
        where = " AND ".join(clauses)

        limit_val = max(1, min(int(limit), 200))
        offset_val = max(0, int(offset))

        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                rows = await conn.fetch(
                    f"""SELECT * FROM {FILE_ASSETS_TABLE}
                        WHERE {where}
                        ORDER BY received_at DESC
                        LIMIT {limit_val} OFFSET {offset_val}""",
                    *params,
                )
                total = await conn.fetchval(
                    f"SELECT COUNT(*) FROM {FILE_ASSETS_TABLE} WHERE {where}",
                    *params,
                )
        finally:
            if own:
                await conn.close()
        return [_row_to_asset(r) for r in rows], int(total or 0)

    async def mark_remembered(
        self,
        principal: Principal,
        asset_id: str,
        *,
        document_id: str,
        remembered_by: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[FileAsset]:
        """Link a file to the document ingested from it, and say who decided.

        ``remembered_by`` is ``'user'`` or the name of the skill that judged it
        important, so the audit line answers "why is this in my memory" without
        guessing.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""UPDATE {FILE_ASSETS_TABLE}
                           SET document_id = $2::uuid,
                               remembered_at = NOW(),
                               remembered_by = $3
                         WHERE id = $1::uuid AND owner_user_id = $4
                     RETURNING *""",
                    asset_id,
                    document_id,
                    remembered_by,
                    principal.user_id,
                )
        finally:
            if own:
                await conn.close()
        return _row_to_asset(row) if row else None
