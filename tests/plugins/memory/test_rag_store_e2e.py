"""Real-Postgres E2E for the FG-21 P4 RAG tier.

Three classes of guarantee are asserted here, and none of them can be trusted
against a fake store:

* **Access.** Ingestion must not launder a private document into ``shared``, a
  peer must not read another peer's ingested material, and a grant must reach
  exactly one document's chunks. These are ``USING``-clause properties, checked
  through the app filter *and* under a ``NOBYPASSRLS`` role with no app filter at
  all.
* **Hybrid retrieval.** That both arms are wired is only observable on real SQL:
  the lexical arm is a ``tsquery`` and the vector arm is an HNSW scan.
* **Incrementality.** Unchanged text must not be re-embedded; edited text must
  not leave stale chunks behind; a deleted document must be unretrievable.
"""

from __future__ import annotations

import asyncio
import math
import random
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator

import asyncpg
import pytest

from hermes_cli.access import (
    ACCESS_SCHEMA_SQL,
    Principal,
    bind_elevated_reads,
    bind_principal,
)
from hermes_cli.datastore import StoreMode, get_store
from plugins.memory.supabase_pgvector.embedding import HashingEmbedder
from plugins.memory.supabase_pgvector.rag import (
    RAG_CHUNKS_TABLE,
    RAG_DOCUMENTS_TABLE,
    RagStore,
    _vector_scan_settings,
)
from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

_PGVECTOR_IMAGE = (
    "pgvector/pgvector@sha256:"
    "1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
)

OWNER = Principal(user_id="root", display="Root", role="owner")
ADMIN = Principal(user_id="ada", display="Ada", role="admin")
MEMBER = Principal(user_id="mia", display="Mia", role="member")
MEMBER2 = Principal(user_id="moe", display="Moe", role="member")

EVERYONE = (OWNER, ADMIN, MEMBER, MEMBER2)

TENDER = """# Tender 2026-0418

## 1. Background
This tender replaces the 2025 award for civil works in the northern district.

## 2. Submission
Bids close at 17:00 on 4 April 2026 and must be delivered in a sealed envelope.

## 3. Pricing
Prices are firm for 90 days from the closing date.
"""

PRIVATE_NOTE = """# Mia's working note

The margin on the northern district job should not go below eleven percent.
"""


async def _probe_postgres(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    await connection.close()


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the pgvector E2E test")
    daemon = subprocess.run(
        ["docker", "info"], check=False, capture_output=True, text=True
    )
    if daemon.returncode != 0:
        pytest.skip("Docker daemon is unavailable for the pgvector E2E test")

    subprocess.run(
        ["docker", "pull", _PGVECTOR_IMAGE], check=True, capture_output=True
    )
    container = f"hermes-p4-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        [
            "docker", "run", "--detach", "--rm", "--name", container,
            "--env", "POSTGRES_PASSWORD=hermes-test",
            "--env", "POSTGRES_DB=hermes_test",
            "--publish", "127.0.0.1::5432",
            _PGVECTOR_IMAGE,
        ],
        check=True, capture_output=True, text=True,
    )
    try:
        port_result = subprocess.run(
            ["docker", "port", container, "5432/tcp"],
            check=True, capture_output=True, text=True,
        )
        port = port_result.stdout.strip().rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        for _ in range(60):
            try:
                asyncio.run(_probe_postgres(dsn))
                break
            except (OSError, asyncpg.PostgresError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway pgvector Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(
            ["docker", "rm", "--force", container],
            check=False, capture_output=True,
        )


def _config(dsn: str) -> dict:
    return {"datastore": {"supabase_app": {"dsn": dsn}}}


def _rag(dsn: str, *, role_reads: bool, mode: StoreMode = "dev") -> RagStore:
    memory = PgvectorMemoryStore(
        get_store("supabase-app", mode, config=_config(dsn)),
        embedder=HashingEmbedder(dim=256),
        role_reads=role_reads,
    )
    return RagStore(memory)


async def _fresh(dsn: str, *, role_reads: bool = False) -> RagStore:
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_dev CASCADE")
    finally:
        await conn.close()

    store = _rag(dsn, role_reads=role_reads)
    conn = await store._connect()
    try:
        await conn.execute(ACCESS_SCHEMA_SQL)
        for principal in EVERYONE:
            await conn.execute(
                "INSERT INTO principals (user_id, display, role) "
                "VALUES ($1, $2, $3)",
                principal.user_id,
                principal.display,
                principal.role,
            )
    finally:
        await conn.close()
    await store.initialize()
    return store


async def _ingest_corpus(store: RagStore) -> None:
    await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=TENDER,
        visibility="shared",
    )
    await store.ingest(
        MEMBER,
        source_kind="gdrive",
        source_ref="file-mia-note",
        title="Mia's working note",
        text=PRIVATE_NOTE,
    )


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ingest_chunks_a_document_and_keeps_its_sections(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)

    result = await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=TENDER,
        visibility="shared",
    )

    assert not result.skipped
    assert result.chunks == 3
    documents = await store.documents(OWNER)
    assert [doc.source_ref for doc in documents] == ["file-tender-0418"]
    assert documents[0].chunk_count == 3

    conn = await store._connect()
    try:
        sections = await conn.fetch(
            f"SELECT section FROM {RAG_CHUNKS_TABLE} ORDER BY ordinal"
        )
    finally:
        await conn.close()
    assert [row["section"] for row in sections] == [
        "Tender 2026-0418 › 1. Background",
        "Tender 2026-0418 › 2. Submission",
        "Tender 2026-0418 › 3. Pricing",
    ]


@pytest.mark.asyncio
async def test_unchanged_text_is_not_re_embedded(postgres_dsn: str) -> None:
    """The whole point of the content hash: a nightly re-scan costs nothing.

    Embedding is the expensive step (~300 ms per chunk on the deployed model),
    so a re-scan that re-embedded everything unchanged would make a nightly
    timer unaffordable on a 4-vCPU box shared with the gateway.
    """
    store = await _fresh(postgres_dsn)
    first = await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=TENDER,
    )
    conn = await store._connect()
    try:
        before = await conn.fetchval(
            f"SELECT max(created_at) FROM {RAG_CHUNKS_TABLE}"
        )
    finally:
        await conn.close()

    again = await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=TENDER,
    )

    assert again.skipped and again.reason == "unchanged"
    assert again.document_id == first.document_id
    conn = await store._connect()
    try:
        after = await conn.fetchval(
            f"SELECT max(created_at) FROM {RAG_CHUNKS_TABLE}"
        )
        count = await conn.fetchval(f"SELECT count(*) FROM {RAG_CHUNKS_TABLE}")
    finally:
        await conn.close()
    assert after == before  # the rows were never rewritten
    assert count == 3


@pytest.mark.asyncio
async def test_edited_text_replaces_chunks_rather_than_accumulating(
    postgres_dsn: str,
) -> None:
    """Stale chunks are worse than missing ones: they retrieve as current."""
    store = await _fresh(postgres_dsn)
    await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=TENDER,
    )
    edited = TENDER.replace("17:00 on 4 April 2026", "12:00 on 11 April 2026")

    result = await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-tender-0418",
        title="Tender 2026-0418",
        text=edited,
    )

    assert not result.skipped
    conn = await store._connect()
    try:
        texts = [
            row["text"]
            for row in await conn.fetch(f"SELECT text FROM {RAG_CHUNKS_TABLE}")
        ]
        documents = await conn.fetchval(
            f"SELECT count(*) FROM {RAG_DOCUMENTS_TABLE}"
        )
    finally:
        await conn.close()
    assert documents == 1
    assert any("11 April 2026" in text for text in texts)
    assert not any("4 April 2026" in text for text in texts)


@pytest.mark.asyncio
async def test_a_document_with_no_extractable_text_is_reported_not_stored(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)

    result = await store.ingest(
        OWNER,
        source_kind="gdrive",
        source_ref="file-empty",
        title="Empty",
        text="   \n\n  ",
    )

    assert result.skipped and result.document_id is None
    assert result.reason == "no extractable text"
    assert await store.documents(OWNER) == []


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_search_returns_the_passage_with_a_citation(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)

    hits = await store.search(OWNER, "sealed envelope bids close", top_k=3)

    assert hits
    top = hits[0]
    assert "sealed envelope" in top.text
    assert top.citation == "Tender 2026-0418 › 2. Submission"
    assert top.as_dict()["source_ref"] == "file-tender-0418"


@pytest.mark.asyncio
async def test_the_lexical_arm_finds_an_identifier_the_vector_arm_ranks_low(
    postgres_dsn: str,
) -> None:
    """Why hybrid: an identifier carries almost no semantic signal.

    ``2026-0418`` is a string, not a meaning — its nearest neighbours in vector
    space are other numbers. The lexical arm is what makes "quote me tender
    2026-0418" work, and this asserts the arm actually fires rather than being
    dead SQL that the vector arm happens to cover.
    """
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)

    hits = await store.search(OWNER, "2026-0418", top_k=5)

    assert hits
    assert any(hit.lexical_rank is not None for hit in hits)
    assert hits[0].source_ref == "file-tender-0418"


@pytest.mark.asyncio
async def test_agreement_between_both_arms_outranks_one_arm_alone(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)

    hits = await store.search(OWNER, "prices are firm for 90 days", top_k=5)

    assert hits[0].section.endswith("3. Pricing")
    assert hits[0].vector_rank is not None
    assert hits[0].lexical_rank is not None
    # Fused score is the sum of both arms' reciprocal ranks, so a chunk matched
    # by both must score above one matched by a single arm.
    single_arm = [
        hit for hit in hits[1:] if not (hit.vector_rank and hit.lexical_rank)
    ]
    assert all(hits[0].score > hit.score for hit in single_arm)


@pytest.mark.asyncio
async def test_chunks_from_another_embedding_model_are_excluded(
    postgres_dsn: str,
) -> None:
    """Cross-model distances are real numbers with no meaning.

    Ranking them together looks like slightly worse retrieval and is actually
    nonsense, which is why the memory tier excludes them too.
    """
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)
    conn = await store._connect()
    try:
        await conn.execute(
            f"UPDATE {RAG_CHUNKS_TABLE} SET embedding_model = 'other-model'"
        )
    finally:
        await conn.close()

    assert await store.search(OWNER, "sealed envelope", top_k=5) == []


# ---------------------------------------------------------------------------
# Access: the part that must not be trusted to a mock
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ingestion_defaults_to_private_and_cannot_launder(
    postgres_dsn: str,
) -> None:
    """A Drive document ingested for one person does not become instance-wide.

    This is the P4 failure that would be both silent and unrecoverable: a
    private contract, ingested by a nightly job, retrievable by everybody.
    """
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)

    conn = await store._connect()
    try:
        tag = await conn.fetchval(
            f"SELECT visibility FROM {RAG_DOCUMENTS_TABLE} "
            "WHERE source_ref = 'file-mia-note'"
        )
        chunk_tags = await conn.fetch(
            f"SELECT DISTINCT c.visibility FROM {RAG_CHUNKS_TABLE} c "
            f"JOIN {RAG_DOCUMENTS_TABLE} d ON d.id = c.document_id "
            "WHERE d.source_ref = 'file-mia-note'"
        )
    finally:
        await conn.close()
    assert tag == "private:mia"
    # The chunk carries the document's tag, so the two cannot drift apart.
    assert [row["visibility"] for row in chunk_tags] == ["private:mia"]

    peer_hits = await store.search(MEMBER2, "eleven percent margin", top_k=5)
    assert peer_hits == []
    own_hits = await store.search(MEMBER, "eleven percent margin", top_k=5)
    assert own_hits and "eleven percent" in own_hits[0].text


@pytest.mark.asyncio
async def test_role_reads_off_hides_a_members_document_from_an_admin(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn, role_reads=False)
    await _ingest_corpus(store)

    assert await store.search(ADMIN, "eleven percent margin", top_k=5) == []
    # The shared tender is still readable — off means "no elevation", not "no
    # sharing".
    assert await store.search(ADMIN, "sealed envelope", top_k=5)


@pytest.mark.asyncio
async def test_role_reads_on_lets_an_admin_read_a_members_document(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn, role_reads=True)
    await _ingest_corpus(store)

    hits = await store.search(ADMIN, "eleven percent margin", top_k=5)

    assert hits and hits[0].owner_user_id == "mia"
    # And still not sideways: a peer member is unreachable by rank.
    assert await store.search(MEMBER2, "eleven percent margin", top_k=5) == []


@pytest.mark.asyncio
async def test_a_grant_shares_one_document_and_no_others(
    postgres_dsn: str,
) -> None:
    """The sideways case: peer-to-peer sharing is an act, not a rank."""
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)
    await store.ingest(
        MEMBER,
        source_kind="gdrive",
        source_ref="file-mia-second",
        title="Mia's other note",
        text="# Other\n\nThe supplier for the eleven percent job is Kowloon Steel.\n",
    )
    documents = {doc.source_ref: doc.id for doc in await store.documents(MEMBER)}

    shared = await store.share(MEMBER, documents["file-mia-note"], "moe")

    assert shared
    hits = await store.search(MEMBER2, "eleven percent", top_k=10)
    assert [hit.source_ref for hit in hits] == ["file-mia-note"]
    # The grant is row-specific: the owner's other private document stays hidden
    # even though it matches the same query.
    assert all(hit.source_ref != "file-mia-second" for hit in hits)

    assert await store.unshare(MEMBER, documents["file-mia-note"], "moe")
    assert await store.search(MEMBER2, "eleven percent", top_k=10) == []


@pytest.mark.asyncio
async def test_only_the_owner_may_share_or_forget_a_document(
    postgres_dsn: str,
) -> None:
    """An elevated reader is not a redistributor, and not a deleter."""
    store = await _fresh(postgres_dsn, role_reads=True)
    await _ingest_corpus(store)
    mia_doc = (await store.documents(MEMBER))[0]

    assert await store.share(ADMIN, mia_doc.id, "moe") is False
    assert await store.forget(
        ADMIN, source_kind="gdrive", source_ref="file-mia-note"
    ) == 0
    # Mia's document is still there and still hers.
    assert await store.search(MEMBER, "eleven percent margin", top_k=5)


@pytest.mark.asyncio
async def test_forget_removes_the_document_and_its_chunks(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)

    removed = await store.forget(
        OWNER, source_kind="gdrive", source_ref="file-tender-0418"
    )

    assert removed == 3
    assert await store.search(OWNER, "sealed envelope", top_k=5) == []
    conn = await store._connect()
    try:
        orphans = await conn.fetchval(
            f"SELECT count(*) FROM {RAG_CHUNKS_TABLE}"
        )
    finally:
        await conn.close()
    # Cascade, not a soft delete: a withdrawn document must not be retrievable
    # from a leftover chunk.
    assert orphans == 1  # only Mia's note remains


# ---------------------------------------------------------------------------
# Raw RLS: the same matrix with no app-layer filter at all
# ---------------------------------------------------------------------------

async def _reader_dsn(postgres_dsn: str) -> str:
    """A DSN for a role that cannot bypass RLS.

    ``postgres`` is ``BYPASSRLS``, so a policy test run as ``postgres`` proves
    nothing: it would pass with no policy installed at all. Everything below runs
    as ``app_reader``, the shape of the request role on the deployed stack.

    Called *after* the schema is (re)created, because ``_fresh`` drops the schema
    and grants do not survive their objects.

    ``item_grants`` and ``principals`` are readable because the chunk policy
    itself queries them in correlated sub-selects — exactly as
    ``ensure_app_role()`` grants them in production.
    """
    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_roles WHERE rolname = 'app_reader'
                ) THEN
                    CREATE ROLE app_reader LOGIN PASSWORD 'reader-test'
                        NOBYPASSRLS;
                END IF;
            END $$;
            """
        )
        await conn.execute("GRANT USAGE ON SCHEMA app_dev TO app_reader")
        await conn.execute("GRANT USAGE ON SCHEMA public TO app_reader")
        for table in (
            RAG_DOCUMENTS_TABLE,
            RAG_CHUNKS_TABLE,
            "item_grants",
            "principals",
        ):
            await conn.execute(
                f"GRANT SELECT ON app_dev.{table} TO app_reader"
            )
    finally:
        await conn.close()
    _, _, tail = postgres_dsn.partition("@")
    return f"postgresql://app_reader:reader-test@{tail}"


async def _raw_visible(
    dsn: str,
    principal: Principal,
    *,
    elevated: bool,
) -> set[str]:
    """Rows a bare ``SELECT *`` returns — the policy, with no filter helping."""
    conn = await asyncpg.connect(dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_dev, public")
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, elevated)
            rows = await conn.fetch(
                f"SELECT source_ref FROM {RAG_DOCUMENTS_TABLE}"
            )
            chunks = await conn.fetch(f"SELECT text FROM {RAG_CHUNKS_TABLE}")
        return {row["source_ref"] for row in rows} | {
            "chunk" for _ in chunks if chunks
        }
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_rls_alone_hides_a_peers_document(postgres_dsn: str) -> None:
    store = await _fresh(postgres_dsn, role_reads=True)
    await _ingest_corpus(store)
    reader_dsn = await _reader_dsn(postgres_dsn)

    visible = await _raw_visible(reader_dsn, MEMBER2, elevated=True)

    # Even asking for elevation, a member cannot reach a peer member.
    assert "file-mia-note" not in visible
    assert "file-tender-0418" in visible  # shared


@pytest.mark.asyncio
async def test_rls_alone_grants_the_admin_only_while_elevation_is_bound(
    postgres_dsn: str,
) -> None:
    """Two gates. The policy is installed; the GUC is the second key.

    A code path that reads without binding elevation under-reads (safe). There is
    no path that over-reads by forgetting something.
    """
    store = await _fresh(postgres_dsn, role_reads=True)
    await _ingest_corpus(store)
    reader_dsn = await _reader_dsn(postgres_dsn)

    assert "file-mia-note" not in await _raw_visible(
        reader_dsn, ADMIN, elevated=False
    )
    assert "file-mia-note" in await _raw_visible(
        reader_dsn, ADMIN, elevated=True
    )


@pytest.mark.asyncio
async def test_rls_alone_honours_a_document_grant_on_the_chunk_table(
    postgres_dsn: str,
) -> None:
    """A grant on the document must reach its chunks, and only its chunks.

    The chunk policy correlates the grant on ``document_id``; an unqualified
    column here would silently bind to ``item_grants.id`` and confer nothing —
    the P3 bug, which is why this is asserted at the database level.
    """
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)
    mia_doc = (await store.documents(MEMBER))[0]
    await store.share(MEMBER, mia_doc.id, "moe")
    reader_dsn = await _reader_dsn(postgres_dsn)

    conn = await asyncpg.connect(reader_dsn, ssl=False)
    try:
        await conn.execute("SET search_path TO app_dev, public")
        async with conn.transaction():
            await bind_principal(conn, MEMBER2)
            await bind_elevated_reads(conn, False)
            chunks = await conn.fetch(
                f"SELECT text, document_id FROM {RAG_CHUNKS_TABLE}"
            )
    finally:
        await conn.close()

    granted = [row for row in chunks if str(row["document_id"]) == mia_doc.id]
    assert granted, "the granted document's chunks must be visible"
    assert all(
        str(row["document_id"]) == mia_doc.id
        or "eleven percent" not in row["text"]
        for row in chunks
    )


# ---------------------------------------------------------------------------
# Query shape: both arms must be able to use their indexes
# ---------------------------------------------------------------------------

def test_vector_scan_settings_follow_the_pgvector_version() -> None:
    assert _vector_scan_settings(None) == {}
    assert _vector_scan_settings("0.4.4") == {}
    assert _vector_scan_settings("0.7.4") == {"hnsw.ef_search": "100"}
    assert _vector_scan_settings("0.8.0") == {
        "hnsw.ef_search": "100",
        "hnsw.iterative_scan": "relaxed_order",
    }
    assert "hnsw.iterative_scan" in _vector_scan_settings("1.0.0-dev")


_SHAPE_DIM = 256


def _clustered_vector(rng: random.Random, centre: list[float]) -> list[float]:
    raw = [c + rng.gauss(0.0, 0.5) for c in centre]
    norm = math.sqrt(sum(x * x for x in raw))
    return [x / norm for x in raw]


async def _bulk_corpus(store: RagStore, *, chunks_per_doc: int = 12) -> list[float]:
    """Insert a filtered-heavy corpus directly; returns a query vector.

    Two thirds of the chunks are either another embedding model or another
    member's private rows, so a post-filtered HNSW scan with the default
    ``ef_search`` returns fewer rows than the arm's LIMIT.
    """
    rng = random.Random(1729)
    centre = [rng.gauss(0.0, 1.0) for _ in range(_SHAPE_DIM)]
    owners = [
        ("root", "shared", store.model_id, "gdrive"),
        ("mia", "private:mia", store.model_id, "gdrive"),
        ("moe", "private:moe", store.model_id, "transcript"),
        ("moe", "private:moe", store.model_id, "gdrive"),
        ("root", "shared", "other-model", "gdrive"),
        ("ada", "private:ada", "other-model", "gdrive"),
    ]
    conn = await store._connect()
    try:
        for index in range(60):
            owner, visibility, model, kind = owners[index % len(owners)]
            document_id = await conn.fetchval(
                f"""
                INSERT INTO {RAG_DOCUMENTS_TABLE} (owner_user_id, visibility,
                    source_kind, source_ref, title, content_hash,
                    embedding_model, chunk_count)
                VALUES ($1, $2, $3, $4, $5, 'h', $6, $7) RETURNING id
                """,
                owner, visibility, kind, f"ref-{index}", f"Doc {index}",
                model, chunks_per_doc,
            )
            await conn.executemany(
                f"""
                INSERT INTO {RAG_CHUNKS_TABLE} (document_id, owner_user_id,
                    visibility, ordinal, text, embedding, embedding_model,
                    section, fts)
                VALUES ($1, $2, $3, $4, $5, $6, $7, '',
                        to_tsvector('simple', $5))
                """,
                [
                    (
                        document_id, owner, visibility, ordinal,
                        f"tender clause {index} part {ordinal} "
                        + ("pricing firm" if ordinal % 3 == 0 else "background"),
                        _clustered_vector(rng, centre), model,
                    )
                    for ordinal in range(chunks_per_doc)
                ],
            )
        await conn.execute(
            "INSERT INTO item_grants (item_kind, item_id, user_id, grant_type, "
            "granted_by, status) SELECT 'document', id, 'mia', 'watcher', "
            "owner_user_id, 'accepted' FROM rag_documents "
            "WHERE source_ref = 'ref-2'"
        )
        await conn.execute(f"ANALYZE {RAG_CHUNKS_TABLE}; ANALYZE {RAG_DOCUMENTS_TABLE}")
    finally:
        await conn.close()
    return _clustered_vector(rng, centre)


async def _drop_filter_indexes(store: RagStore) -> None:
    """Leave HNSW as the only ordered path for the vector arm.

    On a few hundred rows a btree on a filter column plus a sort is genuinely
    cheaper, so the planner would otherwise never pick the graph scan here.
    """
    conn = await store._connect()
    try:
        await conn.execute(
            f"DROP INDEX {RAG_CHUNKS_TABLE}_model_idx, "
            f"{RAG_CHUNKS_TABLE}_visibility_idx, "
            f"{RAG_CHUNKS_TABLE}_document_idx"
        )
    finally:
        await conn.close()


async def _fetch_search(
    store: RagStore,
    principal: Principal,
    sql: str,
    params: list,
    *,
    planner: str,
    tune: bool,
    explain: bool = False,
) -> list:
    conn = await store._connect()
    try:
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)
            await conn.execute(planner)
            if tune:
                await store._tune_vector_scan(conn)
            prefix = "EXPLAIN (COSTS OFF) " if explain else ""
            return await conn.fetch(prefix + sql, *params)
    finally:
        await conn.close()


#: The test corpus is small enough that the planner rightly prefers a scan,
#: so each arm's index is forced separately: HNSW is an ordered index scan,
#: GIN only ever a bitmap scan.
_FORCE_HNSW = "SET LOCAL enable_seqscan = off; SET LOCAL enable_bitmapscan = off"
_FORCE_GIN = "SET LOCAL enable_seqscan = off; SET LOCAL enable_indexscan = off"
_EXACT = (
    "SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off"
)


@pytest.mark.asyncio
async def test_search_arms_use_the_hnsw_and_gin_indexes(postgres_dsn: str) -> None:
    """The arms must be index-capable, not scans over a materialised CTE.

    The old shape shared one ``visible`` CTE between both arms, which Postgres
    materialises, so no amount of planner pressure reached either index.
    """
    store = await _fresh(postgres_dsn)
    query = await _bulk_corpus(store)
    await _drop_filter_indexes(store)
    for principal in (OWNER, MEMBER):
        sql, params = store._search_sql(
            principal, query, "pricing firm",
            top_k=5, min_score=0.0, source_kind=None,
        )
        plans = {}
        for name, planner in (("hnsw", _FORCE_HNSW), ("gin", _FORCE_GIN)):
            plans[name] = "\n".join(
                row[0]
                for row in await _fetch_search(
                    store, principal, sql, params,
                    planner=planner, tune=True, explain=True,
                )
            )
        assert (
            f"Index Scan using {RAG_CHUNKS_TABLE}_embedding_idx" in plans["hnsw"]
        ), plans["hnsw"]
        assert (
            f"Bitmap Index Scan on {RAG_CHUNKS_TABLE}_fts_idx" in plans["gin"]
        ), plans["gin"]


@pytest.mark.asyncio
@pytest.mark.parametrize("role_reads", [False, True])
async def test_index_search_matches_an_exact_scan(
    postgres_dsn: str, role_reads: bool
) -> None:
    """Scope, ranks and fusion through the indexes are the brute-force ones.

    The lexical arm is exact by construction (GIN only answers ``@@``), so its
    plan must reproduce the exact result row for row. HNSW is approximate, so
    the vector plan is held to a recall floor instead, and to the property
    the post-filter used to break: the arm still fills its LIMIT when most
    candidates are filtered out (2/3 here; 5/6 with ``source_kind``).
    """
    store = await _fresh(postgres_dsn, role_reads=role_reads)
    query = await _bulk_corpus(store)
    await _drop_filter_indexes(store)
    seen = 0
    for principal in (OWNER, ADMIN, MEMBER):
        for source_kind in (None, "transcript"):
            case = (principal.user_id, source_kind)
            sql, params = store._search_sql(
                principal, query, "pricing firm",
                top_k=50, min_score=0.0, source_kind=source_kind,
            )
            exact = await _fetch_search(
                store, principal, sql, params, planner=_EXACT, tune=False,
            )
            seen += len(exact)
            lexical = await _fetch_search(
                store, principal, sql, params, planner=_FORCE_GIN, tune=True,
            )
            assert [tuple(row) for row in lexical] == [
                tuple(row) for row in exact
            ], case

            # A term nothing contains isolates the vector arm (<= 30 rows,
            # so the final LIMIT cuts nothing).
            sql, params = store._search_sql(
                principal, query, "no-such-term",
                top_k=50, min_score=0.0, source_kind=source_kind,
            )
            exact = await _fetch_search(
                store, principal, sql, params, planner=_EXACT, tune=False,
            )
            vector = await _fetch_search(
                store, principal, sql, params, planner=_FORCE_HNSW, tune=True,
            )
            exact_ids = {row["id"] for row in exact}
            vector_ids = {row["id"] for row in vector}
            assert len(vector) == len(exact), case
            assert len(vector_ids & exact_ids) >= 0.9 * len(exact_ids), case
            assert [row["vector_rank"] for row in vector] == list(
                range(1, len(vector) + 1)
            ), case
    assert seen, "the corpus must give the comparison something to compare"


@pytest.mark.asyncio
async def test_a_filtered_hnsw_arm_needs_the_scan_settings(
    postgres_dsn: str,
) -> None:
    """Without the settings a post-filtered HNSW scan comes back short."""
    store = await _fresh(postgres_dsn)
    query = await _bulk_corpus(store)
    await _drop_filter_indexes(store)
    sql, params = store._search_sql(
        MEMBER, query, "no-such-term",
        top_k=50, min_score=0.0, source_kind=None,
    )
    plain = await _fetch_search(
        store, MEMBER, sql, params, planner=_FORCE_HNSW, tune=False,
    )
    tuned = await _fetch_search(
        store, MEMBER, sql, params, planner=_FORCE_HNSW, tune=True,
    )
    assert len(plain) < 30
    assert len(tuned) == 30


@pytest.mark.asyncio
async def test_iterative_scan_is_set_for_the_search_transaction(
    postgres_dsn: str,
) -> None:
    store = await _fresh(postgres_dsn)
    conn = await store._connect()
    try:
        async with conn.transaction():
            await store._tune_vector_scan(conn)
            ef_search = await conn.fetchval("SHOW hnsw.ef_search")
            iterative = await conn.fetchval(
                "SELECT current_setting('hnsw.iterative_scan', true)"
            )
        after = await conn.fetchval("SHOW hnsw.ef_search")
    finally:
        await conn.close()
    assert ef_search == "100"
    assert iterative == "relaxed_order"
    assert after != "100"  # SET LOCAL: nothing leaks past the search


@pytest.mark.asyncio
async def test_an_unknown_scan_setting_degrades_instead_of_failing(
    postgres_dsn: str,
) -> None:
    """A server that rejects a setting still answers, without the setting."""
    store = await _fresh(postgres_dsn)
    await _ingest_corpus(store)
    store._vector_scan_settings = {"work_mem": "not-a-size"}

    hits = await store.search(OWNER, "sealed envelope bids close", top_k=3)

    assert hits and "sealed envelope" in hits[0].text
    assert store._vector_scan_settings == {}
