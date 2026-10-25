"""Live queryable memory tier backed by Supabase Postgres + pgvector.

This is the *live* half of the D2 hybrid memory model. Where the curated tier
(``tools/memory_tool.py``) is a frozen ``MEMORY.md``/``USER.md`` snapshot loaded
once at session start, this store is read and written **mid-turn via tool
calls** — never spliced into the system prompt — so a fact learned this turn is
recallable immediately without disturbing the cached prompt prefix.

Every row is visibility-scoped by contract **C2**
(:mod:`hermes_cli.access`): it carries ``owner_user_id`` + ``visibility``
(``shared`` or ``private:<user_id>``), reads are filtered by
:func:`~hermes_cli.access.scope_filter`, and Postgres **row-level security**
(:func:`~hermes_cli.access.apply_scope_rls`) is the database-level backstop.
All connections are obtained through contract **C3**
(:class:`hermes_cli.datastore.SupabaseAppStore`), so the ``app_dev`` / ``app_prod``
schema follows the resolved mode. Concurrency across many ``(user, task)``
sessions rides Postgres MVCC — each write is its own transaction on its own
connection, so there is no single-writer bottleneck.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Callable, List, Optional

from hermes_cli.access import (
    GUC_PRINCIPAL_ID,
    GUC_PRINCIPAL_ROLE,
    ITEM_GRANTS_SCHEMA_SQL,
    ITEM_GRANTS_TABLE,
    Principal,
    SHARED,
    apply_item_grants_rls,
    apply_scope_rls,
    bind_elevated_reads,
    bind_principal,
    grant_item,
    initialize_access,
    normalize_visibility,
    reads_by_elevation,
    revoke_item_grant,
    scope_filter,
)

from .embedding import DEFAULT_DIM, HASHING_MODEL_ID, Embedder, get_embedder

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore


#: Name of the scoped table holding live memory rows (RLS applied to it).
MEMORY_TABLE = "memories"

#: Ledger of reads that crossed a user boundary by role (FG-21 P3). Scoped so
#: the person whose memory was read can see it, which is the point: an
#: unobservable downward read is surveillance, not access control.
MEMORY_AUDIT_TABLE = "memory_access_audit"

#: ``item_grants.item_kind`` for a single shared memory row (FG-19 mechanism,
#: FG-21 P3 use). A grant is how access goes *sideways* — to a peer the role
#: ladder deliberately does not reach — and it shares exactly the row it names,
#: never the owner's other private memories.
GRANT_ITEM_KIND = "memory"

#: 2-D projection of each memory/chunk for the memory explorer map (FG-22).
#: Denormalises ``owner_user_id``/``visibility`` so the same C2 scope predicate
#: that governs ``memories`` governs the projection — a derived table that leaked
#: a private row's coordinates would be a way to read a memory's existence and
#: rough topic without the read the scope policy was designed to gate.
PROJECTION_TABLE = "memory_projection"

#: Singleton row holding the fitted PCA/UMAP basis so the query-placement
#: endpoint (V3) can project new text without re-fitting.
PROJECTION_BASIS_TABLE = "memory_projection_basis"

_PROJECTION_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {PROJECTION_TABLE} (
    id            UUID PRIMARY KEY,
    kind          TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    visibility    TEXT NOT NULL,
    topic         TEXT,
    x             REAL NOT NULL,
    y             REAL NOT NULL,
    model         TEXT NOT NULL,
    algorithm     TEXT NOT NULL,
    fitted_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS {PROJECTION_BASIS_TABLE} (
    id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    algorithm   TEXT NOT NULL,
    model       TEXT NOT NULL,
    mean        JSONB NOT NULL,
    components  JSONB NOT NULL,
    sample_size INTEGER,
    fitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

_AUDIT_SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {MEMORY_AUDIT_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reader_user_id TEXT NOT NULL,
    reader_role TEXT NOT NULL,
    subject_user_id TEXT NOT NULL,
    memory_ids UUID[] NOT NULL,
    query TEXT,
    session_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS {MEMORY_AUDIT_TABLE}_subject_idx
    ON {MEMORY_AUDIT_TABLE} (subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS {MEMORY_AUDIT_TABLE}_reader_idx
    ON {MEMORY_AUDIT_TABLE} (reader_user_id, created_at DESC);
"""

#: The audited query is truncated: it exists so the subject can judge *why*
#: their memory was read, not to mirror an entire conversation into a table the
#: reader cannot delete from.
_AUDIT_QUERY_CHARS = 500

#: Rows written before provenance existed were produced by the hashing
#: embedder, which is exactly what the column default states. Backfilling them
#: as 'hashing' is a statement of fact, not a guess. Separate from the table
#: DDL because the migration commands need it on its own, before any session
#: has created the rest of the schema.
_PROVENANCE_COLUMN_SQL = f"""
ALTER TABLE {MEMORY_TABLE}
    ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL
    DEFAULT '{HASHING_MODEL_ID}';
"""


def _schema_sql(dim: int) -> str:
    return f"""
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS {MEMORY_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    text TEXT NOT NULL,
    embedding vector({dim}) NOT NULL,
    embedding_model TEXT NOT NULL DEFAULT '{HASHING_MODEL_ID}',
    source_session TEXT,
    topic TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used TIMESTAMPTZ,
    uses INTEGER NOT NULL DEFAULT 0
);

{_PROVENANCE_COLUMN_SQL}

CREATE INDEX IF NOT EXISTS {MEMORY_TABLE}_embedding_idx
    ON {MEMORY_TABLE} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS {MEMORY_TABLE}_visibility_idx
    ON {MEMORY_TABLE} (visibility);
CREATE INDEX IF NOT EXISTS {MEMORY_TABLE}_topic_idx
    ON {MEMORY_TABLE} (topic);
CREATE INDEX IF NOT EXISTS {MEMORY_TABLE}_embedding_model_idx
    ON {MEMORY_TABLE} (embedding_model);
"""


class EmbeddingSpaceMismatch(RuntimeError):
    """The stored vectors were not produced by the configured embedder.

    Raised instead of writing or querying, because both would be wrong in a
    way that leaves no trace: an insert of the wrong width fails with a
    Postgres type error nobody can act on, and a query ranks the new model's
    vector against the old model's column, returning plausible-looking rows in
    a meaningless order. The message names the fix (``hermes memory reembed``)
    rather than the symptom.
    """


@dataclass(frozen=True)
class EmbeddingSpace:
    """What is actually in the vector column right now."""

    column_dim: Optional[int]
    rows_by_model: dict

    @property
    def models(self) -> List[str]:
        return sorted(self.rows_by_model)

    def rows_outside(self, model_id: str) -> int:
        return sum(
            count
            for model, count in self.rows_by_model.items()
            if model != model_id
        )


@dataclass(frozen=True)
class MemoryRecord:
    """One row of live memory, optionally with a similarity ``score``."""

    id: str
    owner_user_id: str
    visibility: str
    kind: str
    text: str
    topic: Optional[str]
    source_session: Optional[str]
    created_at: Optional[datetime]
    score: Optional[float] = None
    #: True when the reader sees this row only because it outranks the owner.
    elevated: bool = False

    @property
    def provenance(self) -> str:
        """Human-readable origin, empty for the reader's own or shared rows.

        A fact read out of somebody else's private memory must arrive labelled.
        Unlabelled, the model presents another person's private note as if it
        were the reader's own, which is how an access right turns into a
        misattribution.
        """
        if not self.elevated:
            return ""
        return f"from {self.owner_user_id}'s memory"

    def as_dict(self) -> dict:
        data = {
            "id": self.id,
            "owner_user_id": self.owner_user_id,
            "visibility": self.visibility,
            "kind": self.kind,
            "text": self.text,
            "topic": self.topic,
            "source_session": self.source_session,
        }
        if self.score is not None:
            data["score"] = round(self.score, 6)
        if self.elevated:
            data["provenance"] = self.provenance
        return data


@dataclass(frozen=True)
class MemoryReadAudit:
    """One recorded cross-user read (FG-21 P3)."""

    id: str
    reader_user_id: str
    reader_role: str
    subject_user_id: str
    memory_ids: List[str]
    query: Optional[str]
    session_id: Optional[str]
    created_at: Optional[datetime]

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "reader_user_id": self.reader_user_id,
            "reader_role": self.reader_role,
            "subject_user_id": self.subject_user_id,
            "memory_ids": list(self.memory_ids),
            "query": self.query,
            "session_id": self.session_id,
            "created_at": (
                self.created_at.isoformat() if self.created_at else None
            ),
        }


def _encode_vector(vector: List[float]) -> bytes:
    """pgvector binary wire format: int16 dim, int16 unused, dim x float4 (big-endian)."""
    values = [float(component) for component in vector]
    return struct.pack(f">HH{len(values)}f", len(values), 0, *values)


def _decode_vector(data: bytes) -> List[float]:
    dim, _unused = struct.unpack_from(">HH", data)
    return list(struct.unpack_from(f">{dim}f", data, 4))


def _role_reads_configured(config: Optional[dict]) -> bool:
    """Read ``memory.sharing.role_reads`` (default off).

    Off by default because turning it on is the difference between "each user's
    memory is their own" and "anyone senior can read it". That is an instance
    policy, so it is stated once in ``config.yaml`` rather than inferred from a
    role happening to exist.
    """
    memory = (config or {}).get("memory")
    sharing = memory.get("sharing") if isinstance(memory, dict) else None
    if not isinstance(sharing, dict):
        return False
    return bool(sharing.get("role_reads", False))


async def _apply_audit_rls(conn: "asyncpg.Connection") -> None:
    """Scope the audit ledger to the reader, the subject, and the owner role.

    The subject clause is the one that matters: a member can see every time
    somebody senior read their private memory. Without it the feature is a
    one-way mirror.
    """
    await conn.execute(
        f"""
        ALTER TABLE {MEMORY_AUDIT_TABLE} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE {MEMORY_AUDIT_TABLE} FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS hermes_memory_audit_read ON {MEMORY_AUDIT_TABLE};
        CREATE POLICY hermes_memory_audit_read ON {MEMORY_AUDIT_TABLE}
            FOR SELECT
            USING (
                current_setting('{GUC_PRINCIPAL_ROLE}', true) = 'owner'
                OR reader_user_id = current_setting('{GUC_PRINCIPAL_ID}', true)
                OR subject_user_id = current_setting('{GUC_PRINCIPAL_ID}', true)
            );
        """
    )


def _resolve_visibility(principal: Principal, visibility: Optional[str]) -> str:
    """Map a requested ``shared``/``private`` intent onto a concrete C2 tag.

    ``private`` (without a user) becomes the caller's own
    ``private:<user_id>`` — a principal can only create rows private to
    *itself*. A fully-qualified ``private:<u>`` or ``shared`` is validated and
    passed through.
    """
    if visibility is None or visibility == "private":
        return principal.private_visibility
    return normalize_visibility(visibility)


class PgvectorMemoryStore:
    """Async CRUD + semantic recall over the C2-scoped ``memories`` table.

    The store never opens a raw connection itself — it always routes through
    the injected contract-C3 :class:`SupabaseAppStore`, whose ``mode`` selects
    the ``app_dev`` / ``app_prod`` schema.
    """

    def __init__(
        self,
        store: "SupabaseAppStore",
        *,
        embedder: Optional[Embedder] = None,
        config: Optional[dict] = None,
        role_reads: Optional[bool] = None,
    ) -> None:
        self._store = store
        # An explicit embedder wins (tests, callers that already resolved one);
        # otherwise `memory.embedding` in config.yaml decides, defaulting to the
        # credential-free hashing embedder.
        self._embedder = embedder or get_embedder(DEFAULT_DIM, config=config)
        self._role_reads = role_reads if role_reads is not None else (
            _role_reads_configured(config)
        )

    @property
    def role_reads(self) -> bool:
        """Whether downward-only role reads are enabled on this instance."""
        return self._role_reads

    @property
    def mode(self) -> str:
        return self._store.mode

    @property
    def dim(self) -> int:
        return self._embedder.dim

    @property
    def model_id(self) -> str:
        """The vector space this store reads and writes."""
        return self._embedder.model_id

    @property
    def embedder(self) -> Embedder:
        """The resolved embedder, so sibling tiers share one vector space.

        The RAG tier (FG-21 P4) embeds with *this* embedder rather than
        resolving its own: two tiers on two models would each be internally
        consistent and mutually meaningless, and one re-embed would fix only
        half the instance.
        """
        return self._embedder

    async def _prepare_connection(
        self, connection: "asyncpg.Connection"
    ) -> "asyncpg.Connection":
        """Make ``vector`` usable on ``connection`` (own or caller-injected).

        pgvector may be installed in a schema other than the app schema (a
        standard self-hosted Supabase installs it into ``public``). The
        ``vector`` type, its cast, the ``<=>`` operator, and the ``hnsw``
        ``vector_cosine_ops`` opclass only resolve when that schema is on the
        search path, and the asyncpg codec must be registered against the
        schema the type actually lives in — otherwise the connection fails
        with ``type "vector" does not exist`` / ``operator class ... does not
        exist`` even though the extension is present. This runs on *every*
        connection the store touches — including one handed in by a caller
        such as :class:`GoalManagementService` — so no code path can end up
        with the app schema pinned but the vector schema missing. Idempotent.
        """
        await connection.execute(
            f'CREATE SCHEMA IF NOT EXISTS "{self._store.schema}"'
        )
        await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        # Keep the app schema first so scoped tables/RLS still land there.
        vector_schema = await connection.fetchval(
            """
            SELECT n.nspname
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
            WHERE e.extname = 'vector'
            """
        ) or self._store.schema
        if vector_schema != self._store.schema:
            await connection.execute(
                "SELECT set_config('search_path', $1, false)",
                f'"{self._store.schema}", "{vector_schema}"',
            )
        await connection.set_type_codec(
            "vector",
            schema=vector_schema,
            encoder=_encode_vector,
            decoder=_decode_vector,
            format="binary",
        )
        return connection

    async def _connect(self) -> "asyncpg.Connection":
        connection = await self._store.connect()
        return await self._prepare_connection(connection)

    async def connect(self) -> "asyncpg.Connection":
        """A vector-ready connection on this store's schema (caller closes it)."""
        return await self._connect()

    async def prepare_connection(
        self, connection: "asyncpg.Connection"
    ) -> "asyncpg.Connection":
        """Make a caller-owned connection vector-ready. Idempotent."""
        return await self._prepare_connection(connection)

    async def initialize(
        self,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Create the ``memories`` table, vector index, and RLS policy.

        Idempotent — safe to call at the start of every session.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            await conn.execute(_schema_sql(self.dim))
            # Both the read filter and the policy rank a row's owner by looking
            # its role up in `principals` (never by trusting a role copied into
            # the row), and the grant clause reads `item_grants`. Creating both —
            # idempotently, the same DDL contract C1/FG-19 own — means the tier
            # works on a schema where only the memory store has run, instead of
            # depending on which component happened to initialize first.
            await initialize_access(conn)
            await conn.execute(ITEM_GRANTS_SCHEMA_SQL)
            await apply_item_grants_rls(conn)
            await apply_scope_rls(
                conn,
                MEMORY_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                role_elevation=self._role_reads,
            )
            await conn.execute(_AUDIT_SCHEMA_SQL)
            await _apply_audit_rls(conn)
            # Projection table (FG-22) — derived, but carries the same C2
            # scope predicate so the map cannot leak a private row's location.
            await conn.execute(_PROJECTION_SCHEMA_SQL)
            await apply_scope_rls(
                conn,
                PROJECTION_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                role_elevation=self._role_reads,
            )
            await self._assert_space_usable(conn)
        finally:
            if own:
                await conn.close()

    async def _add_provenance_column(self, conn: "asyncpg.Connection") -> None:
        """Make sure ``embedding_model`` exists before anything reads it.

        A deployment whose table predates provenance gains the column when the
        agent next initializes. The migration commands are what an operator
        runs *first*, before any session has opened, so they cannot assume
        that has happened: without this they fail on a raw "column does not
        exist" rather than reporting the very state they exist to fix.

        Deliberately not ``initialize()``: that asserts the column width is
        usable, which is false by construction mid-cutover — exactly when
        ``reembed`` must run.
        """
        if not await self._table_exists(conn):
            return
        await conn.execute(_PROVENANCE_COLUMN_SQL)

    async def _table_exists(self, conn: "asyncpg.Connection") -> bool:
        return (
            await conn.fetchval(
                "SELECT to_regclass(current_schema() || '.' || $1)",
                MEMORY_TABLE,
            )
            is not None
        )

    async def _column_dim(self, conn: "asyncpg.Connection") -> Optional[int]:
        """Width the ``embedding`` column is actually declared with.

        ``CREATE TABLE IF NOT EXISTS`` cannot widen an existing column, so a
        table created under a 256-dim embedder keeps ``vector(256)`` no matter
        what the configuration now says. pgvector encodes the width in
        ``atttypmod``.
        """
        return await conn.fetchval(
            """
            SELECT a.atttypmod
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1
              AND a.attname = 'embedding'
              AND n.nspname = current_schema()
            """,
            MEMORY_TABLE,
        )

    async def describe_space(
        self,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> EmbeddingSpace:
        """Report the column width and the row count per embedding model.

        Read with RLS bypassed on purpose: this counts rows to decide whether a
        migration is needed, and answering "how many rows are in the old space"
        with only the caller's own rows would understate the work and leave
        other users' rows stranded in an unqueryable space.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            if not await self._table_exists(conn):
                return EmbeddingSpace(column_dim=None, rows_by_model={})
            await self._add_provenance_column(conn)
            rows = await conn.fetch(
                f"SELECT embedding_model, COUNT(*) AS n "
                f"FROM {MEMORY_TABLE} GROUP BY embedding_model"
            )
            return EmbeddingSpace(
                column_dim=await self._column_dim(conn),
                rows_by_model={
                    str(row["embedding_model"]): int(row["n"]) for row in rows
                },
            )
        finally:
            if own:
                await conn.close()

    async def _assert_space_usable(self, conn: "asyncpg.Connection") -> None:
        """Fail loudly when the column cannot hold this embedder's vectors.

        Checked once per session at initialize() rather than per write, so the
        provider reports itself unavailable with an actionable message instead
        of every memory_write failing with a Postgres type error.
        """
        column_dim = await self._column_dim(conn)
        if column_dim is None or column_dim <= 0 or column_dim == self.dim:
            return
        raise EmbeddingSpaceMismatch(
            f"{MEMORY_TABLE}.embedding is vector({column_dim}) but the "
            f"configured embedder ({self.model_id}) produces {self.dim} "
            "dimensions. Existing vectors cannot be compared with new ones. "
            "Run 'hermes memory reembed' to rewrite every row into the new "
            "space, or restore the previous memory.embedding settings."
        )

    async def reembed(
        self,
        *,
        batch_size: int = 16,
        progress: Optional[Callable[[int, int], None]] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> int:
        """Re-embed every row with the configured embedder. Returns row count.

        The whole rewrite is one transaction: a half-migrated column is the
        state this feature exists to prevent, so either every row is in the new
        space or none is. When the width changes, the column is replaced
        (pgvector cannot alter ``vector(N)`` in place) and the HNSW index is
        rebuilt afterwards, since an index built over the old width would
        otherwise be silently dropped with the column.

        Embedding happens *before* the transaction opens: a model that needs
        300 ms per row would otherwise hold a write transaction open across
        minutes of CPU while live sessions block on it.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            if not await self._table_exists(conn):
                return 0
            await self._add_provenance_column(conn)
            rows = await conn.fetch(
                f"SELECT id, text FROM {MEMORY_TABLE} ORDER BY created_at"
            )
            if not rows:
                await self._replace_vector_column(conn)
                return 0

            ids: List[object] = []
            vectors: List[List[float]] = []
            for start in range(0, len(rows), max(1, batch_size)):
                chunk = rows[start : start + max(1, batch_size)]
                embedded = self._embedder.embed_batch(
                    [str(row["text"]) for row in chunk]
                )
                ids.extend(row["id"] for row in chunk)
                vectors.extend(embedded)
                if progress is not None:
                    progress(len(ids), len(rows))

            async with conn.transaction():
                await self._replace_vector_column(conn)
                await conn.executemany(
                    f"UPDATE {MEMORY_TABLE} "
                    "SET embedding = $2, embedding_model = $3 WHERE id = $1",
                    [
                        (row_id, vector, self.model_id)
                        for row_id, vector in zip(ids, vectors)
                    ],
                )
            return len(ids)
        finally:
            if own:
                await conn.close()

    async def _replace_vector_column(self, conn: "asyncpg.Connection") -> None:
        """Make ``embedding`` a ``vector(self.dim)`` column, index included."""
        column_dim = await self._column_dim(conn)
        if column_dim == self.dim:
            return
        await conn.execute(
            f"ALTER TABLE {MEMORY_TABLE} DROP COLUMN embedding"
        )
        await conn.execute(
            f"ALTER TABLE {MEMORY_TABLE} "
            f"ADD COLUMN embedding vector({self.dim})"
        )
        await conn.execute(
            f"CREATE INDEX IF NOT EXISTS {MEMORY_TABLE}_embedding_idx "
            f"ON {MEMORY_TABLE} USING hnsw (embedding vector_cosine_ops)"
        )

    async def write(
        self,
        principal: Principal,
        text: str,
        *,
        kind: str = "fact",
        topic: Optional[str] = None,
        visibility: Optional[str] = None,
        source_session: Optional[str] = None,
        dedup_threshold: float = 0.0,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> MemoryRecord:
        """Persist one memory row owned by ``principal`` and return it.

        ``visibility`` defaults to the caller's own ``private:<user_id>`` tier;
        pass ``"shared"`` to write org-visible knowledge. The row's embedding is
        computed from ``text`` via the configured embedder.

        With ``dedup_threshold`` above 0, a near-identical memory the caller
        already owns is returned instead of inserting another copy. Automatic
        capture re-states the same fact every time the user rephrases a standing
        request, and a store full of paraphrases makes recall return five
        versions of one thing instead of five things.
        """
        clean = (text or "").strip()
        if not clean:
            raise ValueError("Cannot write empty memory text")
        resolved_visibility = _resolve_visibility(principal, visibility)
        embedding = self._embedder.embed(clean)

        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            duplicate = await self._find_duplicate(
                conn,
                principal=principal,
                visibility=resolved_visibility,
                text=clean,
                embedding=embedding,
                threshold=float(dedup_threshold),
            )
            if duplicate is not None:
                return duplicate
            row = await conn.fetchrow(
                f"""
                INSERT INTO {MEMORY_TABLE}
                    (owner_user_id, visibility, kind, text, embedding,
                     embedding_model, topic, source_session)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id, owner_user_id, visibility, kind, text, topic,
                          source_session, created_at
                """,
                principal.user_id,
                resolved_visibility,
                kind,
                clean,
                embedding,
                self.model_id,
                topic,
                source_session,
            )
            return _row_to_record(row)
        finally:
            if own:
                await conn.close()

    async def _find_duplicate(
        self,
        conn: "asyncpg.Connection",
        *,
        principal: Principal,
        visibility: str,
        text: str,
        embedding: List[float],
        threshold: float,
    ) -> Optional[MemoryRecord]:
        """Return the caller's existing near-identical memory, if any.

        Dedup is opt-in per write. Some writers *need* repeats: task discovery
        counts how many times an intent recurs before proposing a task, so
        collapsing identical rows would make a standing request never cross its
        threshold. Only callers that state a threshold get dedup.

        Within those callers, exact text is deduplicated first — it is the same
        fact by definition, and it costs one indexed comparison. Vector
        similarity is only consulted for a non-degenerate embedding: the
        hashing embedder maps
        token-less text (any Chinese sentence) to the zero vector, whose cosine
        distance to every row is undefined, and treating that as "identical to
        everything" would silently discard every such memory after the first.
        """
        if threshold <= 0.0:
            return None
        exact = await conn.fetchrow(
            f"""
            SELECT id, owner_user_id, visibility, kind, text, topic,
                   source_session, created_at, NULL::float AS score
            FROM {MEMORY_TABLE}
            WHERE owner_user_id = $1 AND visibility = $2 AND text = $3
            LIMIT 1
            """,
            principal.user_id,
            visibility,
            text,
        )
        if exact is not None:
            return _row_to_record(exact)
        if not any(component != 0.0 for component in embedding):
            return None
        near = await conn.fetchrow(
            f"""
            SELECT id, owner_user_id, visibility, kind, text, topic,
                   source_session, created_at,
                   1 - (embedding <=> $4) AS score
            FROM {MEMORY_TABLE}
            WHERE owner_user_id = $1 AND visibility = $2
              AND embedding_model = $3
            ORDER BY embedding <=> $4
            LIMIT 1
            """,
            principal.user_id,
            visibility,
            self.model_id,
            embedding,
        )
        if near is None:
            return None
        record = _row_to_record(near)
        if record.score is not None and record.score >= threshold:
            return record
        return None

    async def get(
        self,
        principal: Principal,
        memory_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Optional[MemoryRecord]:
        """Return one memory when ``principal`` may read it (contract C2)."""
        predicate = scope_filter(
            principal,
            start_index=2,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{MEMORY_TABLE}.id",
            role_elevation=self._role_reads,
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            row = await conn.fetchrow(
                f"""
                SELECT id, owner_user_id, visibility, kind, text, topic,
                       source_session, created_at, NULL::float AS score
                FROM {MEMORY_TABLE}
                WHERE id = $1 AND {predicate.sql}
                """,
                memory_id,
                *predicate.params,
            )
            return _row_to_record(row) if row is not None else None
        finally:
            if own:
                await conn.close()

    async def query(
        self,
        principal: Principal,
        query_text: str,
        *,
        top_k: int = 10,
        kind: Optional[str] = None,
        topic: Optional[str] = None,
        min_score: float = 0.0,
        record_use: bool = False,
        session_id: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[MemoryRecord]:
        """Return the ``top_k`` rows most similar to ``query_text``.

        Results are scoped to what ``principal`` may read (contract C2): a
        non-owner sees ``shared`` rows plus its own ``private`` rows; the owner
        sees everything. Ranking is cosine similarity on the embedding.

        Rows embedded by a *different* model are excluded rather than ranked.
        Their distance to this query is arithmetically valid and semantically
        meaningless, so including them would mix real matches with noise that
        looks exactly like a match — the failure mode this tier must not have.
        ``min_score`` drops weak neighbours: an HNSW search always returns
        ``top_k`` rows, so without a floor an unrelated question still recalls
        the least-unrelated memories.

        **Cross-user reads (FG-21 P3).** With ``memory.sharing.role_reads`` on,
        the scope also matches rows owned by somebody this principal ranks
        strictly above (``owner > admin > member > viewer``) — never sideways,
        never upward. Any row surfaced that way (including one the owner role
        sees by bypass) is marked ``elevated``, carries a ``from <user>'s
        memory`` provenance label, and is written to
        :data:`MEMORY_AUDIT_TABLE` in the same transaction as the read: an
        elevated read that isn't recorded must not be a read that happened.
        """
        top_k = max(1, min(int(top_k), 100))
        embedding = self._embedder.embed(query_text or "")

        params: List[object] = [embedding]
        clauses: List[str] = []
        next_index = 2
        clauses.append(f"embedding_model = ${next_index}")
        params.append(self.model_id)
        next_index += 1
        if kind:
            clauses.append(f"kind = ${next_index}")
            params.append(kind)
            next_index += 1
        if topic:
            clauses.append(f"topic = ${next_index}")
            params.append(topic)
            next_index += 1

        predicate = scope_filter(
            principal,
            start_index=next_index,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{MEMORY_TABLE}.id",
            role_elevation=self._role_reads,
        )
        clauses.append(predicate.sql)
        params.extend(predicate.params)

        where = " AND ".join(clauses)
        # The owner's role comes from `principals`, not from the row: a role
        # change has to take effect on the next read rather than being frozen
        # into every row that user ever wrote.
        sql = f"""
            SELECT {MEMORY_TABLE}.id, owner_user_id, visibility, kind, text,
                   topic, source_session, {MEMORY_TABLE}.created_at,
                   1 - (embedding <=> $1) AS score,
                   (SELECT pr.role FROM principals pr
                     WHERE pr.user_id = {MEMORY_TABLE}.owner_user_id)
                       AS owner_role
            FROM {MEMORY_TABLE}
            WHERE {where}
            ORDER BY embedding <=> $1
            LIMIT {top_k}
        """

        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            async with conn.transaction():
                # The GUCs are transaction-local, so binding them has to happen
                # inside the same transaction as the read for the database-level
                # policy to see them.
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self._role_reads)
                rows = await conn.fetch(sql, *params)
                records = [
                    _row_to_record(
                        row,
                        elevated=reads_by_elevation(
                            principal,
                            row,
                            owner_role=row["owner_role"],
                        ),
                    )
                    for row in rows
                ]
                floor = float(min_score)
                if floor > 0.0:
                    records = [
                        record
                        for record in records
                        if record.score is not None and record.score >= floor
                    ]
                if record_use and records:
                    await self._record_use(
                        conn, [record.id for record in records]
                    )
                await self._audit_elevated(
                    conn,
                    principal=principal,
                    records=records,
                    query_text=query_text,
                    session_id=session_id,
                )
            return records
        finally:
            if own:
                await conn.close()

    async def _audit_elevated(
        self,
        conn: "asyncpg.Connection",
        *,
        principal: Principal,
        records: List[MemoryRecord],
        query_text: str,
        session_id: Optional[str],
    ) -> None:
        """Record one audit row per subject whose memory this read surfaced.

        Grouped by subject rather than per memory row so the person reading
        their own audit sees "the owner searched X and saw 3 of my memories",
        which is one event, instead of three rows they have to reassemble.
        """
        subjects: dict = {}
        for record in records:
            if record.elevated:
                subjects.setdefault(record.owner_user_id, []).append(record.id)
        await self.audit_elevated_reads(
            conn,
            principal=principal,
            subjects=subjects,
            query_text=query_text,
            session_id=session_id,
        )

    async def audit_elevated_reads(
        self,
        conn: "asyncpg.Connection",
        *,
        principal: Principal,
        subjects: dict,
        query_text: str,
        session_id: Optional[str] = None,
    ) -> None:
        """Record one audit row per subject, given ``{subject: [memory_id]}``.

        Public because a cross-person read is not only a recall: the memory
        explorer surfaces the same rows by browsing, and a read of another
        person's memory that leaves no trace is the one thing this ledger
        exists to prevent. Callers must invoke it in the same transaction as
        the read.
        """
        if not subjects:
            return
        await conn.executemany(
            f"""
            INSERT INTO {MEMORY_AUDIT_TABLE}
                (reader_user_id, reader_role, subject_user_id, memory_ids,
                 query, session_id)
            VALUES ($1, $2, $3, $4::uuid[], $5, $6)
            """,
            [
                (
                    principal.user_id,
                    principal.role,
                    subject,
                    memory_ids,
                    (query_text or "")[:_AUDIT_QUERY_CHARS],
                    session_id,
                )
                for subject, memory_ids in sorted(subjects.items())
            ],
        )

    async def share(
        self,
        principal: Principal,
        memory_id: str,
        grantee_user_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Grant ``grantee_user_id`` read access to one memory the caller owns.

        Returns False when the caller does not own that row. Only the *owner of
        the row* may share it — not somebody who merely read it by rank. An
        admin who could re-share a member's private memory would turn a scoped
        downward read into an unbounded redistribution right, and the member
        would have no way to take it back.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            owner = await conn.fetchval(
                f"SELECT owner_user_id FROM {MEMORY_TABLE} WHERE id = $1::uuid",
                memory_id,
            )
            if owner is None or str(owner) != principal.user_id:
                return False
            await grant_item(
                conn,
                item_kind=GRANT_ITEM_KIND,
                item_id=memory_id,
                user_id=grantee_user_id,
                granted_by=principal.user_id,
            )
            return True
        finally:
            if own:
                await conn.close()

    async def unshare(
        self,
        principal: Principal,
        memory_id: str,
        grantee_user_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Revoke a memory grant. Returns whether an active grant was revoked.

        Revoked rather than deleted: the record that the row *was* shared for a
        period is part of the audit trail, and only :data:`GRANT_ACTIVE_STATUSES`
        confer access.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            return await revoke_item_grant(
                conn,
                item_kind=GRANT_ITEM_KIND,
                item_id=memory_id,
                user_id=grantee_user_id,
                granted_by=principal.user_id,
            )
        finally:
            if own:
                await conn.close()

    async def read_audit(
        self,
        principal: Principal,
        *,
        limit: int = 50,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[MemoryReadAudit]:
        """Elevated reads this principal may see: its own, and reads *of* it.

        Deliberately not filtered by role: a viewer must be able to see who
        read their memory, so the subject clause applies to everyone. The same
        rule is enforced by RLS on the ledger, so a caller that reaches the
        table another way gets the same answer.
        """
        limit = max(1, min(int(limit), 500))
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._prepare_connection(conn)
            async with conn.transaction():
                await bind_principal(conn, principal)
                rows = await conn.fetch(
                    f"""
                    SELECT id, reader_user_id, reader_role, subject_user_id,
                           memory_ids, query, session_id, created_at
                    FROM {MEMORY_AUDIT_TABLE}
                    WHERE $1 = 'owner'
                       OR reader_user_id = $2
                       OR subject_user_id = $2
                    ORDER BY created_at DESC
                    LIMIT {limit}
                    """,
                    principal.role,
                    principal.user_id,
                )
            return [
                MemoryReadAudit(
                    id=str(row["id"]),
                    reader_user_id=str(row["reader_user_id"]),
                    reader_role=str(row["reader_role"]),
                    subject_user_id=str(row["subject_user_id"]),
                    memory_ids=[str(value) for value in row["memory_ids"]],
                    query=row["query"],
                    session_id=row["session_id"],
                    created_at=row["created_at"],
                )
                for row in rows
            ]
        finally:
            if own:
                await conn.close()

    async def _record_use(
        self, conn: "asyncpg.Connection", memory_ids: List[str]
    ) -> None:
        """Count a recall against the rows it surfaced.

        Only automatic recall records use, so ``uses``/``last_used`` mean "this
        row was put in front of the model" rather than "someone searched". P5's
        promotion/demotion decisions rest on that distinction.
        """
        await conn.execute(
            f"UPDATE {MEMORY_TABLE} "
            "SET uses = uses + 1, last_used = NOW() "
            "WHERE id = ANY($1::uuid[])",
            list(memory_ids),
        )


def _row_to_record(
    row: "asyncpg.Record",
    *,
    elevated: bool = False,
) -> MemoryRecord:
    score = row.get("score")
    return MemoryRecord(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        visibility=str(row["visibility"]),
        kind=str(row["kind"]),
        text=str(row["text"]),
        topic=row["topic"],
        source_session=row["source_session"],
        created_at=row["created_at"],
        score=float(score) if score is not None else None,
        elevated=elevated,
    )


__all__ = [
    "MEMORY_AUDIT_TABLE",
    "MEMORY_TABLE",
    "PROJECTION_BASIS_TABLE",
    "PROJECTION_TABLE",
    "EmbeddingSpace",
    "EmbeddingSpaceMismatch",
    "MemoryReadAudit",
    "MemoryRecord",
    "PgvectorMemoryStore",
    "SHARED",
]
