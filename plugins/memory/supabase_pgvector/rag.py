"""RAG tier (FG-21 P4): documents and chunks the agent can retrieve and cite.

Layer 4 (``memories``) holds facts *the agent decided to remember*. This tier
holds material it was never told about — Drive documents, transcripts — chunked
and embedded so a question can find the passage that answers it without anyone
naming the file. Two properties make it more than a table of text:

**Access is inherited, never invented.** A document ingested from someone's Drive
is ``private:<that user>``; its chunks carry the same tag, denormalised so the
policy on ``rag_chunks`` never has to join. Nothing in this module can widen a
document's visibility, because *laundering a private document into ``shared`` by
ingesting it* is the one failure that would be both silent and unrecoverable.
The same C2 predicate, per-item grants and downward role reads that govern
memory govern this tier, enforced twice: in the query and by RLS.

**Retrieval is hybrid on purpose.** Vector search alone cannot find
"Tender 2026-0418" — an identifier carries almost no semantic signal, and the
nearest neighbours of a serial number are other serial numbers. Lexical search
alone cannot find 招標截止日期 from "when is the tender due". Each arm fails a
class of query the other answers, so both run and their ranks are fused
(reciprocal rank fusion, which needs no score calibration between two
incomparable scales).

Re-ingestion is gated on a content hash *and* the embedding model: unchanged text
is not re-embedded, and a model switch is a real change because vectors from two
models are not comparable.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, Dict, List, Optional

from hermes_cli.access import (
    Principal,
    apply_item_grants_rls,
    apply_scope_rls,
    bind_elevated_reads,
    bind_principal,
    grant_item,
    initialize_access,
    ITEM_GRANTS_SCHEMA_SQL,
    normalize_visibility,
    revoke_item_grant,
    scope_filter,
)

from .chunking import (
    DEFAULT_OVERLAP_TOKENS,
    DEFAULT_TARGET_TOKENS,
    chunk_document,
)

if TYPE_CHECKING:
    import asyncpg

#: Ingested source documents (one row per ``(source, ref, owner)``).
RAG_DOCUMENTS_TABLE = "rag_documents"

#: Embeddable spans of a document. Deleting a document cascades its chunks: a
#: document that was withdrawn must lose its right to be recalled.
RAG_CHUNKS_TABLE = "rag_chunks"

#: ``item_grants.item_kind`` for sharing one document (and therefore its chunks)
#: with a peer the role ladder does not reach.
GRANT_ITEM_KIND = "document"

#: Rows pulled from each arm of the hybrid search before fusion. Deeper than
#: ``top_k`` because the point of fusion is that a result the vector arm ranked
#: 9th can still win on lexical agreement.
_ARM_DEPTH = 30

#: Reciprocal-rank-fusion damping. 60 is the value from the original RRF paper;
#: it makes the top few ranks matter without letting rank 1 of one arm outvote
#: agreement between both.
_RRF_K = 60

#: Cosine-similarity floor for the vector arm. An HNSW search *always* returns
#: its ``LIMIT``, so without a floor every question retrieves its least-unrelated
#: passages and the model is handed irrelevant text as though it were evidence.
#: The lexical arm needs no floor: a ``tsquery`` either matches or does not.
DEFAULT_MIN_SCORE = 0.35


#: ``hnsw.ef_search`` for the vector arm: the candidate list must be at least
#: the arm's ``LIMIT``, with headroom for rows the scope filter rejects.
_HNSW_EF_SEARCH = 100


def _pgvector_version(version: Optional[str]) -> tuple:
    parts = []
    for piece in (version or "").split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def _vector_scan_settings(version: Optional[str]) -> Dict[str, str]:
    """``hnsw.*`` settings this pgvector version understands (may be empty)."""
    parsed = _pgvector_version(version)
    settings: Dict[str, str] = {}
    if parsed >= (0, 5):
        settings["hnsw.ef_search"] = str(_HNSW_EF_SEARCH)
    if parsed >= (0, 8):
        settings["hnsw.iterative_scan"] = "relaxed_order"
    return settings


def _schema_sql(dim: int) -> str:
    return f"""
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS {RAG_DOCUMENTS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    source_modified_at TIMESTAMPTZ,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_kind, source_ref, owner_user_id)
);

CREATE TABLE IF NOT EXISTS {RAG_CHUNKS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL
        REFERENCES {RAG_DOCUMENTS_TABLE}(id) ON DELETE CASCADE,
    -- Denormalised so the chunk policy is a predicate on the chunk row itself.
    -- A policy that joined back to the document would have to be satisfiable by
    -- a reader who cannot see the document, which is the wrong shape.
    owner_user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding vector({dim}) NOT NULL,
    embedding_model TEXT NOT NULL,
    token_count INTEGER NOT NULL DEFAULT 0,
    section TEXT,
    -- Lexical index over title + heading path + body, not body alone. A tender
    -- number usually appears in the *title*, so a lexical arm over body text
    -- cannot find the document by its own identifier — the exact case the arm
    -- exists for. Computed at insert time and stored, so the GIN index below
    -- serves the query instead of every row being re-tokenised per search.
    fts tsvector NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS {RAG_CHUNKS_TABLE}_embedding_idx
    ON {RAG_CHUNKS_TABLE} USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS {RAG_CHUNKS_TABLE}_document_idx
    ON {RAG_CHUNKS_TABLE} (document_id);
CREATE INDEX IF NOT EXISTS {RAG_CHUNKS_TABLE}_visibility_idx
    ON {RAG_CHUNKS_TABLE} (visibility);
CREATE INDEX IF NOT EXISTS {RAG_CHUNKS_TABLE}_model_idx
    ON {RAG_CHUNKS_TABLE} (embedding_model);
-- 'simple' rather than 'english': the corpus is bilingual, and a stemmer for
-- one language mangles identifiers ("2026-0418") that the lexical arm exists to
-- catch. Stemming is what the vector arm is for.
CREATE INDEX IF NOT EXISTS {RAG_CHUNKS_TABLE}_fts_idx
    ON {RAG_CHUNKS_TABLE} USING gin (fts);
"""


@dataclass(frozen=True)
class RagDocument:
    """A row of :data:`RAG_DOCUMENTS_TABLE`."""

    id: str
    owner_user_id: str
    visibility: str
    source_kind: str
    source_ref: str
    title: str
    content_hash: str
    embedding_model: str
    chunk_count: int


@dataclass(frozen=True)
class IngestResult:
    """What one ``ingest()`` call did, in terms a caller can report.

    ``skipped`` distinguishes "already current" from "ingested", so a re-scan of
    a Drive account can report how little it had to do instead of looking like it
    re-embedded everything.
    """

    document_id: Optional[str]
    chunks: int
    skipped: bool
    reason: str = ""


@dataclass(frozen=True)
class RagHit:
    """One retrieved chunk, with everything a citation needs."""

    chunk_id: str
    document_id: str
    title: str
    section: str
    source_kind: str
    source_ref: str
    text: str
    owner_user_id: str
    score: float
    vector_rank: Optional[int]
    lexical_rank: Optional[int]

    @property
    def citation(self) -> str:
        """``Title › Section`` — where the passage came from, for the model.

        The chunker already roots a section path at the document title, so the
        title is only prepended when the path does not carry it (a heading-less
        document, or one whose export lost its title).
        """
        if not self.section:
            return self.title or self.source_ref
        if not self.title or self.section.startswith(self.title):
            return self.section
        return f"{self.title} › {self.section}"

    def as_dict(self) -> Dict[str, object]:
        return {
            "text": self.text,
            "citation": self.citation,
            "title": self.title,
            "section": self.section,
            "source_kind": self.source_kind,
            "source_ref": self.source_ref,
            "score": round(self.score, 6),
            "matched": (
                "both"
                if self.vector_rank and self.lexical_rank
                else ("meaning" if self.vector_rank else "exact-text")
            ),
        }


def content_hash(title: str, text: str) -> str:
    """Stable digest of what was ingested, used to skip unchanged documents."""
    digest = hashlib.sha256()
    digest.update((title or "").encode("utf-8"))
    digest.update(b"\0")
    digest.update((text or "").encode("utf-8"))
    return digest.hexdigest()


class RagStore:
    """Ingest, retrieve and forget document chunks under contracts C2/C3.

    Shares the memory tier's embedder and connection contract: the vector space
    is the same one ``memories`` uses, so a model switch is a single migration
    rather than two divergent spaces.
    """

    def __init__(self, memory_store) -> None:
        # Composition rather than inheritance: this tier needs the memory
        # store's embedder, schema routing and vector-codec setup, and nothing
        # about a memory row.
        self._memory = memory_store
        #: ``hnsw.*`` settings applied per search; ``None`` until the pgvector
        #: version has been read once.
        self._vector_scan_settings: Optional[Dict[str, str]] = None

    @property
    def dim(self) -> int:
        return self._memory.dim

    @property
    def model_id(self) -> str:
        return self._memory.model_id

    @property
    def mode(self) -> str:
        return self._memory.mode

    @property
    def role_reads(self) -> bool:
        return self._memory.role_reads

    async def _connect(self) -> "asyncpg.Connection":
        return await self._memory.connect()

    async def _adopt(self, connection: "asyncpg.Connection") -> None:
        """Make a caller-supplied connection usable for vector work."""
        await self._memory.prepare_connection(connection)

    async def initialize(
        self,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> None:
        """Create both tables, their indexes and their RLS policies.

        Idempotent, and it applies the *same* scope policy the memory tier uses:
        C2 plus per-item grants plus (when the instance enables it) downward role
        reads. A RAG tier with weaker access than memory would be a way to read
        somebody's private material by asking a different table for it.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            await conn.execute(_schema_sql(self.dim))
            await initialize_access(conn)
            await conn.execute(ITEM_GRANTS_SCHEMA_SQL)
            await apply_item_grants_rls(conn)
            await apply_scope_rls(
                conn,
                RAG_DOCUMENTS_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                role_elevation=self.role_reads,
            )
            # A grant on the *document* reaches its chunks: the grant clause
            # correlates on `document_id`, so sharing a document shares exactly
            # its own passages and no other document's.
            await apply_scope_rls(
                conn,
                RAG_CHUNKS_TABLE,
                grant_item_kind=GRANT_ITEM_KIND,
                id_column="document_id",
                role_elevation=self.role_reads,
            )
        finally:
            if own:
                await conn.close()

    async def ingest(
        self,
        principal: Principal,
        *,
        source_kind: str,
        source_ref: str,
        title: str,
        text: str,
        visibility: Optional[str] = None,
        source_modified_at=None,
        target_tokens: int = DEFAULT_TARGET_TOKENS,
        overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
        force: bool = False,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> IngestResult:
        """Chunk, embed and store one document, replacing any earlier version.

        Unchanged content is skipped — the hash covers the title and body, and
        the stored ``embedding_model`` is compared too, because vectors from a
        different model are not comparable and so a model switch *is* a content
        change for retrieval purposes.

        ``visibility`` defaults to ``private:<principal>``. It can be set to
        ``shared`` only by an explicit argument: ingestion must never promote a
        private document to instance-wide by accident.
        """
        digest = content_hash(title, text)
        chunks = chunk_document(
            text,
            title=title,
            target_tokens=target_tokens,
            overlap_tokens=overlap_tokens,
        )
        if not chunks:
            return IngestResult(None, 0, True, "no extractable text")

        tag = (
            principal.private_visibility
            if visibility is None
            else normalize_visibility(visibility)
        )
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            existing = await conn.fetchrow(
                f"""
                SELECT id, content_hash, embedding_model, chunk_count
                FROM {RAG_DOCUMENTS_TABLE}
                WHERE source_kind = $1 AND source_ref = $2
                  AND owner_user_id = $3
                """,
                source_kind,
                source_ref,
                principal.user_id,
            )
            if (
                existing is not None
                and not force
                and existing["content_hash"] == digest
                and existing["embedding_model"] == self.model_id
            ):
                return IngestResult(
                    str(existing["id"]),
                    int(existing["chunk_count"]),
                    True,
                    "unchanged",
                )

            vectors = [
                self._memory.embedder.embed(chunk.text) for chunk in chunks
            ]
            async with conn.transaction():
                await bind_principal(conn, principal)
                document_id = await conn.fetchval(
                    f"""
                    INSERT INTO {RAG_DOCUMENTS_TABLE}
                        (owner_user_id, visibility, source_kind, source_ref,
                         title, content_hash, embedding_model, chunk_count,
                         source_modified_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (source_kind, source_ref, owner_user_id)
                    DO UPDATE SET
                        title = EXCLUDED.title,
                        content_hash = EXCLUDED.content_hash,
                        embedding_model = EXCLUDED.embedding_model,
                        chunk_count = EXCLUDED.chunk_count,
                        source_modified_at = EXCLUDED.source_modified_at,
                        ingested_at = NOW()
                    RETURNING id
                    """,
                    principal.user_id,
                    tag,
                    source_kind,
                    source_ref,
                    title,
                    digest,
                    self.model_id,
                    len(chunks),
                    source_modified_at,
                )
                # Replace rather than merge: a re-ingest of edited text has
                # different chunk boundaries, so keeping old ordinals would leave
                # passages that no longer exist in the document retrievable.
                await conn.execute(
                    f"DELETE FROM {RAG_CHUNKS_TABLE} WHERE document_id = $1",
                    document_id,
                )
                await conn.executemany(
                    f"""
                    INSERT INTO {RAG_CHUNKS_TABLE}
                        (document_id, owner_user_id, visibility, ordinal, text,
                         embedding, embedding_model, token_count, section, fts)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                                to_tsvector('simple', $10))
                    """,
                    [
                        (
                            document_id,
                            principal.user_id,
                            tag,
                            chunk.ordinal,
                            chunk.text,
                            vector,
                            self.model_id,
                            chunk.token_count,
                            chunk.section,
                            f"{title}\n{chunk.section}\n{chunk.text}",
                        )
                        for chunk, vector in zip(chunks, vectors)
                    ],
                )
            return IngestResult(str(document_id), len(chunks), False)
        finally:
            if own:
                await conn.close()

    async def search(
        self,
        principal: Principal,
        query: str,
        *,
        top_k: int = 5,
        min_score: float = DEFAULT_MIN_SCORE,
        source_kind: Optional[str] = None,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[RagHit]:
        """Hybrid retrieval over the chunks ``principal`` may read.

        Two arms, fused by reciprocal rank: cosine similarity for meaning and
        paraphrase (including across languages), and a ``tsquery`` for exact
        strings a vector cannot represent — identifiers, part numbers, names.
        Fusion is by *rank* rather than score because the two scales are not
        comparable and normalising them would invent a calibration nobody
        measured.

        ``min_score`` is a cosine-similarity floor on the vector arm only: an
        HNSW search returns its ``LIMIT`` whatever the distances are, so without
        a floor every question retrieves *something* and the model treats
        unrelated text as evidence. A ``tsquery`` either matches or does not, so
        the lexical arm needs no equivalent.

        Chunks embedded by another model are excluded rather than ranked, for the
        same reason as in the memory tier: their distances are real numbers with
        no meaning.
        """
        top_k = max(1, min(int(top_k), 50))
        text = (query or "").strip()
        if not text:
            return []
        embedding = self._memory.embedder.embed(text)
        sql, params = self._search_sql(
            principal,
            embedding,
            text,
            top_k=top_k,
            min_score=min_score,
            source_kind=source_kind,
        )

        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                await self._tune_vector_scan(conn)
                rows = await conn.fetch(sql, *params)
            return [
                RagHit(
                    chunk_id=str(row["id"]),
                    document_id=str(row["document_id"]),
                    title=row["title"] or "",
                    section=row["section"] or "",
                    source_kind=row["source_kind"],
                    source_ref=row["source_ref"],
                    text=row["text"],
                    owner_user_id=row["owner_user_id"],
                    score=float(row["score"]),
                    vector_rank=(
                        int(row["vector_rank"])
                        if row["vector_rank"] is not None
                        else None
                    ),
                    lexical_rank=(
                        int(row["lexical_rank"])
                        if row["lexical_rank"] is not None
                        else None
                    ),
                )
                for row in rows
            ]
        finally:
            if own:
                await conn.close()

    def _search_sql(
        self,
        principal: Principal,
        embedding: List[float],
        text: str,
        *,
        top_k: int,
        min_score: float,
        source_kind: Optional[str],
    ) -> "tuple[str, List[object]]":
        """The hybrid-search statement and its parameters.

        Each arm reads ``rag_chunks`` directly and is referenced exactly once,
        so neither is a materialised "visible rows" CTE that both arms would
        scan in full. That shape is what lets the vector arm be an HNSW
        ``ORDER BY embedding <=> $1 LIMIT n`` scan and the lexical arm a GIN
        bitmap scan on ``fts``. The visibility predicate is applied inside each
        arm, so scope semantics are unchanged.

        The similarity floor is applied *after* the nearest-neighbour ``LIMIT``:
        rows within the floor are a prefix of the distance ordering, so this is
        the same set as filtering first, but it keeps the floor out of the index
        scan (where it would make an iterative scan walk the whole graph looking
        for rows that can never qualify). ``nearest`` is ``MATERIALIZED`` so the
        rank is computed by an explicit sort on the exact distance — with
        ``hnsw.iterative_scan = relaxed_order`` the index may emit slightly out
        of order.
        """
        params: List[object] = [
            embedding,
            self.model_id,
            text,
            max(0.0, min(float(min_score), 1.0)),
        ]
        clauses = [f"{RAG_CHUNKS_TABLE}.embedding_model = $2"]
        next_index = 5
        if source_kind:
            clauses.append(f"d.source_kind = ${next_index}")
            params.append(source_kind)
            next_index += 1
        predicate = scope_filter(
            principal,
            column=f"{RAG_CHUNKS_TABLE}.visibility",
            start_index=next_index,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{RAG_CHUNKS_TABLE}.document_id",
            role_elevation=self.role_reads,
            owner_column=f"{RAG_CHUNKS_TABLE}.owner_user_id",
        )
        clauses.append(predicate.sql)
        params.extend(predicate.params)
        where = " AND ".join(clauses)
        visible_chunks = (
            f"FROM {RAG_CHUNKS_TABLE} "
            f"JOIN {RAG_DOCUMENTS_TABLE} d "
            f"ON d.id = {RAG_CHUNKS_TABLE}.document_id "
            f"WHERE {where}"
        )

        sql = f"""
        WITH nearest AS MATERIALIZED (
            SELECT {RAG_CHUNKS_TABLE}.id,
                   {RAG_CHUNKS_TABLE}.embedding <=> $1 AS distance
            {visible_chunks}
            ORDER BY {RAG_CHUNKS_TABLE}.embedding <=> $1
            LIMIT {_ARM_DEPTH}
        ),
        vector_arm AS (
            SELECT id, ROW_NUMBER() OVER (ORDER BY distance) AS rank
            FROM nearest
            WHERE 1 - distance >= $4
        ),
        lexical_arm AS (
            SELECT {RAG_CHUNKS_TABLE}.id,
                   ROW_NUMBER() OVER (
                       ORDER BY ts_rank_cd(
                           {RAG_CHUNKS_TABLE}.fts,
                           websearch_to_tsquery('simple', $3)
                       ) DESC
                   ) AS rank
            {visible_chunks}
              AND {RAG_CHUNKS_TABLE}.fts @@ websearch_to_tsquery('simple', $3)
            ORDER BY rank
            LIMIT {_ARM_DEPTH}
        ),
        fused AS (
            SELECT COALESCE(va.id, la.id) AS id,
                   va.rank AS vector_rank, la.rank AS lexical_rank,
                   COALESCE(1.0 / ({_RRF_K} + va.rank), 0)
                     + COALESCE(1.0 / ({_RRF_K} + la.rank), 0) AS score
            FROM vector_arm va
            FULL JOIN lexical_arm la ON la.id = va.id
        )
        SELECT c.id, c.document_id, d.title, c.section, d.source_kind,
               d.source_ref, c.text, c.owner_user_id,
               f.vector_rank, f.lexical_rank, f.score
        FROM fused f
        JOIN {RAG_CHUNKS_TABLE} c ON c.id = f.id
        JOIN {RAG_DOCUMENTS_TABLE} d ON d.id = c.document_id
        ORDER BY f.score DESC, c.document_id, c.id
        LIMIT {top_k}
        """
        return sql, params

    async def _tune_vector_scan(self, conn: "asyncpg.Connection") -> None:
        """Keep a filtered HNSW scan from returning fewer rows than its LIMIT.

        HNSW applies the ``WHERE`` clause after the graph search, so with the
        default ``ef_search`` of 40 a scope/model filter that rejects a third
        of the candidates leaves the arm short. pgvector >= 0.8 can keep
        scanning until the LIMIT is met (``hnsw.iterative_scan``); older
        versions only have a wider candidate list. Both settings are
        transaction-local, and are set inside a savepoint so an unknown
        setting degrades to the plain scan instead of aborting the search.
        """
        import asyncpg

        if self._vector_scan_settings is None:
            try:
                async with conn.transaction():
                    version = await conn.fetchval(
                        "SELECT extversion FROM pg_extension "
                        "WHERE extname = 'vector'"
                    )
            except asyncpg.PostgresError:
                version = None
            self._vector_scan_settings = _vector_scan_settings(version)
        settings = self._vector_scan_settings
        if not settings:
            return
        assignments = ", ".join(
            f"set_config('{name}', ${index}, true)"
            for index, name in enumerate(settings, start=1)
        )
        try:
            async with conn.transaction():
                await conn.execute(
                    f"SELECT {assignments}", *settings.values()
                )
        except asyncpg.PostgresError:
            # Remember the failure: retrying on every search would cost a
            # savepoint round trip for a setting this server will never accept.
            self._vector_scan_settings = {}

    async def forget(
        self,
        principal: Principal,
        *,
        source_kind: str,
        source_ref: str,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> int:
        """Delete one of the caller's own documents; returns chunks removed.

        Only the owner may forget a document — an elevated reader deleting
        somebody else's ingested material would be destruction, not access. The
        chunk rows go with it by cascade, so a withdrawn document cannot be
        retrieved from a leftover chunk.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            row = await conn.fetchrow(
                f"""
                DELETE FROM {RAG_DOCUMENTS_TABLE}
                WHERE source_kind = $1 AND source_ref = $2
                  AND owner_user_id = $3
                RETURNING chunk_count
                """,
                source_kind,
                source_ref,
                principal.user_id,
            )
            return int(row["chunk_count"]) if row else 0
        finally:
            if own:
                await conn.close()

    async def share(
        self,
        principal: Principal,
        document_id: str,
        grantee_user_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Grant one user read access to one document (and its chunks).

        Owner-of-the-row only, like a memory grant: somebody who can read a
        document by rank must not be able to redistribute it.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            owner = await conn.fetchval(
                f"SELECT owner_user_id FROM {RAG_DOCUMENTS_TABLE} "
                "WHERE id = $1::uuid",
                document_id,
            )
            if owner is None or str(owner) != principal.user_id:
                return False
            await grant_item(
                conn,
                item_kind=GRANT_ITEM_KIND,
                item_id=document_id,
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
        document_id: str,
        grantee_user_id: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> bool:
        """Revoke a document grant; True if an active one was revoked."""
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            return await revoke_item_grant(
                conn,
                item_kind=GRANT_ITEM_KIND,
                item_id=document_id,
                user_id=grantee_user_id,
                granted_by=principal.user_id,
            )
        finally:
            if own:
                await conn.close()

    async def documents(
        self,
        principal: Principal,
        *,
        source_kind: Optional[str] = None,
        limit: int = 100,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> List[RagDocument]:
        """Documents this principal may read, newest ingest first."""
        limit = max(1, min(int(limit), 1000))
        params: List[object] = []
        clauses: List[str] = []
        next_index = 1
        if source_kind:
            clauses.append(f"source_kind = ${next_index}")
            params.append(source_kind)
            next_index += 1
        predicate = scope_filter(
            principal,
            start_index=next_index,
            grant_item_kind=GRANT_ITEM_KIND,
            id_column=f"{RAG_DOCUMENTS_TABLE}.id",
            role_elevation=self.role_reads,
        )
        clauses.append(predicate.sql)
        params.extend(predicate.params)
        where = " AND ".join(clauses) or "TRUE"
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            async with conn.transaction():
                await bind_principal(conn, principal)
                await bind_elevated_reads(conn, self.role_reads)
                rows = await conn.fetch(
                    f"""
                    SELECT id, owner_user_id, visibility, source_kind,
                           source_ref, title, content_hash, embedding_model,
                           chunk_count
                    FROM {RAG_DOCUMENTS_TABLE}
                    WHERE {where}
                    ORDER BY ingested_at DESC
                    LIMIT {limit}
                    """,
                    *params,
                )
            return [
                RagDocument(
                    id=str(row["id"]),
                    owner_user_id=row["owner_user_id"],
                    visibility=row["visibility"],
                    source_kind=row["source_kind"],
                    source_ref=row["source_ref"],
                    title=row["title"],
                    content_hash=row["content_hash"],
                    embedding_model=row["embedding_model"],
                    chunk_count=int(row["chunk_count"]),
                )
                for row in rows
            ]
        finally:
            if own:
                await conn.close()

    async def ingested_state(
        self,
        principal: Principal,
        source_kind: str,
        *,
        connection: Optional["asyncpg.Connection"] = None,
    ) -> Dict[str, str]:
        """``source_ref -> content_hash`` for the caller's own documents.

        Lets an incremental scan decide what to fetch *before* downloading it —
        the expensive part of ingestion is the network and the embedder, not the
        listing.
        """
        own = connection is None
        conn = connection or await self._connect()
        try:
            if not own:
                await self._adopt(conn)
            rows = await conn.fetch(
                f"""
                SELECT source_ref, content_hash FROM {RAG_DOCUMENTS_TABLE}
                WHERE source_kind = $1 AND owner_user_id = $2
                  AND embedding_model = $3
                """,
                source_kind,
                principal.user_id,
                self.model_id,
            )
            return {row["source_ref"]: row["content_hash"] for row in rows}
        finally:
            if own:
                await conn.close()


__all__ = [
    "GRANT_ITEM_KIND",
    "IngestResult",
    "RAG_CHUNKS_TABLE",
    "RAG_DOCUMENTS_TABLE",
    "RagDocument",
    "RagHit",
    "RagStore",
    "content_hash",
]
