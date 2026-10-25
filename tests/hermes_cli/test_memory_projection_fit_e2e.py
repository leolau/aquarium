"""Real-Postgres E2E for the projection fit's SQL-side sampling and transform.

``fit_projection`` used to load every embedding into Python even when the PCA
basis was fitted on a sample (prod: 1.67M rows over 56 nightly fits, 8.8 s
each). It now fetches only the sample's vectors, places every row with the
fitted basis inside Postgres, and empties the map with TRUNCATE so a refit
leaves no table of dead tuples behind. These tests pin the coordinates to
the numpy reference so the move into SQL cannot change the map.
"""

from __future__ import annotations

import asyncpg
import numpy as np
import pytest

from hermes_cli import memory_projection
from hermes_cli.memory_projection import _clear_projection, fit_projection
from plugins.memory.supabase_pgvector.rag import RagStore
from plugins.memory.supabase_pgvector.store import (
    PROJECTION_BASIS_TABLE,
    PROJECTION_TABLE,
)
from tests.hermes_cli.test_memory_explorer_e2e import (  # noqa: F401
    _enroll_principals,
    _make_store,
    _reset,
    postgres_dsn,
)
from tests.hermes_cli.test_memory_explorer_e2e import ALICE

_DIM = 256


async def _seed(store, *, memories: int, chunks: int) -> None:
    """Random-vector rows at the store's model; chunks hang off one document."""
    await store.write(ALICE, "anchor memory")
    rag = RagStore(store)
    await rag.initialize()
    await rag.ingest(
        ALICE, source_kind="file", source_ref="seed.txt",
        title="Seed", text="A seed chunk for the projection.",
    )
    conn = await store.connect()
    try:
        vec = (
            f"(SELECT array_agg(random() - 0.5)::real[] "
            f"FROM generate_series(1, {_DIM}) WHERE g IS NOT NULL)::vector"
        )
        await conn.execute(
            f"INSERT INTO memories (owner_user_id, visibility, text, embedding, "
            f" embedding_model, topic) "
            f"SELECT CASE WHEN g % 2 = 0 THEN 'alice' ELSE 'bob' END, 'private', "
            f"'m' || g, {vec}, $1, 't' || (g % 3) "
            f"FROM generate_series(1, $2) g",
            store.model_id, memories - 1,
        )
        doc_id = await conn.fetchval("SELECT id FROM rag_documents LIMIT 1")
        await conn.execute(
            f"INSERT INTO rag_chunks (document_id, owner_user_id, visibility, "
            f" ordinal, text, embedding, embedding_model, fts) "
            f"SELECT $1, 'alice', 'shared', g + 1000, 'c' || g, {vec}, $2, "
            f"to_tsvector('simple', 'c' || g) "
            f"FROM generate_series(1, $3) g",
            doc_id, store.model_id, chunks - 1,
        )
    finally:
        await conn.close()


async def _all_embeddings(store) -> dict[str, np.ndarray]:
    conn = await store.connect()
    try:
        rows = await conn.fetch(
            "SELECT id, embedding FROM memories WHERE embedding_model = $1 "
            "UNION ALL "
            "SELECT id, embedding FROM rag_chunks WHERE embedding_model = $1",
            store.model_id,
        )
    finally:
        await conn.close()
    return {str(r["id"]): np.array(r["embedding"], dtype=np.float64) for r in rows}


async def _map(store):
    conn = await store.connect()
    try:
        points = await conn.fetch(
            f"SELECT id::text AS id, kind, owner_user_id, visibility, topic, x, y "
            f"FROM {PROJECTION_TABLE}"
        )
        basis = await conn.fetchrow(f"SELECT * FROM {PROJECTION_BASIS_TABLE}")
    finally:
        await conn.close()
    return {p["id"]: p for p in points}, basis


class _CountingConnection:
    """Proxy that counts embeddings shipped to Python by ``fetch``."""

    def __init__(self, conn, counter: list[int]) -> None:
        self._conn = conn
        self._counter = counter

    async def fetch(self, query, *args, **kwargs):
        rows = await self._conn.fetch(query, *args, **kwargs)
        if rows and "embedding" in rows[0].keys():
            self._counter[0] += len(rows)
        return rows

    def __getattr__(self, name):
        return getattr(self._conn, name)


async def _prepared_store(dsn: str):
    await _reset(dsn)
    store = _make_store(dsn)
    await store.initialize()
    await _enroll_principals(store)
    return store


@pytest.mark.asyncio
async def test_sql_projection_matches_the_numpy_reference(postgres_dsn):
    store = await _prepared_store(postgres_dsn)
    await _seed(store, memories=40, chunks=60)

    await fit_projection(store, algorithm="pca", sample_size=20000)

    embeddings = await _all_embeddings(store)
    points, basis = await _map(store)
    assert set(points) == set(embeddings)
    assert basis["sample_size"] is None

    # The basis is the PCA of every row (unsampled), up to axis sign.
    matrix = np.vstack(list(embeddings.values()))
    ref_mean = matrix.mean(axis=0)
    _, _, vt = np.linalg.svd(matrix - ref_mean, full_matrices=False)
    import json
    mean = np.array(json.loads(basis["mean"]))
    components = np.array(json.loads(basis["components"]))
    np.testing.assert_allclose(mean, ref_mean, atol=1e-9)
    for axis in range(2):
        assert abs(components[axis] @ vt[axis]) == pytest.approx(1.0, abs=1e-6)

    # Every stored coordinate is (e - mean) . component, as numpy computed it.
    for row_id, emb in embeddings.items():
        expected = (emb - mean) @ components.T
        assert points[row_id]["x"] == pytest.approx(expected[0], abs=1e-4)
        assert points[row_id]["y"] == pytest.approx(expected[1], abs=1e-4)


@pytest.mark.asyncio
async def test_sampled_fit_ships_only_the_sample_and_projects_every_row(
    postgres_dsn, monkeypatch
):
    store = await _prepared_store(postgres_dsn)
    await _seed(store, memories=50, chunks=250)
    shipped = [0]
    real_connect = store.connect

    async def counting_connect():
        return _CountingConnection(await real_connect(), shipped)

    monkeypatch.setattr(store, "connect", counting_connect)
    await fit_projection(store, algorithm="pca", sample_size=40)
    monkeypatch.setattr(store, "connect", real_connect)

    assert shipped[0] == 40, "only the sample's vectors may leave the database"
    points, basis = await _map(store)
    assert basis["sample_size"] == 40
    kinds = [p["kind"] for p in points.values()]
    assert kinds.count("memory") == 50
    assert kinds.count("chunk") == 250
    # Labels/scope columns are carried over from the source rows unchanged.
    conn = await store.connect()
    try:
        memory_rows = {
            str(r["id"]): r for r in await conn.fetch(
                "SELECT id, owner_user_id, visibility, topic FROM memories"
            )
        }
        chunk_rows = {
            str(r["id"]): r for r in await conn.fetch(
                "SELECT id, owner_user_id, visibility, document_id::text AS topic "
                "FROM rag_chunks"
            )
        }
    finally:
        await conn.close()
    for row_id, point in points.items():
        source = memory_rows.get(row_id) or chunk_rows[row_id]
        assert point["kind"] == ("memory" if row_id in memory_rows else "chunk")
        for column in ("owner_user_id", "visibility", "topic"):
            assert point[column] == source[column]


@pytest.mark.asyncio
async def test_sampled_refit_draws_the_same_map(postgres_dsn):
    store = await _prepared_store(postgres_dsn)
    await _seed(store, memories=30, chunks=120)

    await fit_projection(store, algorithm="pca", sample_size=25)
    first_points, first_basis = await _map(store)
    await fit_projection(store, algorithm="pca", sample_size=25)
    second_points, second_basis = await _map(store)

    assert first_basis["components"] == second_basis["components"]
    assert {k: (p["x"], p["y"]) for k, p in first_points.items()} == {
        k: (p["x"], p["y"]) for k, p in second_points.items()
    }


@pytest.mark.asyncio
async def test_refit_leaves_no_dead_tuples(postgres_dsn):
    store = await _prepared_store(postgres_dsn)
    await _seed(store, memories=200, chunks=800)

    await fit_projection(store, algorithm="pca", sample_size=100)
    conn = await store.connect()
    try:
        size_after_one = await conn.fetchval(
            f"SELECT pg_relation_size('{PROJECTION_TABLE}')"
        )
        for _ in range(4):
            await fit_projection(store, algorithm="pca", sample_size=100)
        size_after_five = await conn.fetchval(
            f"SELECT pg_relation_size('{PROJECTION_TABLE}')"
        )
        count = await conn.fetchval(f"SELECT COUNT(*) FROM {PROJECTION_TABLE}")
    finally:
        await conn.close()
    # DELETE + reinsert grew the heap by one full map per refit until vacuum.
    assert size_after_five == size_after_one
    assert count == 1000


@pytest.mark.asyncio
async def test_clear_falls_back_to_delete_without_truncate_privilege(postgres_dsn):
    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS proj_priv CASCADE")
        await conn.execute("CREATE SCHEMA proj_priv")
        await conn.execute("CREATE TABLE proj_priv.points (id int)")
        await conn.execute("INSERT INTO proj_priv.points SELECT generate_series(1, 5)")
        await conn.execute(
            "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles "
            "WHERE rolname = 'proj_no_truncate') THEN "
            "CREATE ROLE proj_no_truncate; END IF; END $$"
        )
        await conn.execute("GRANT USAGE ON SCHEMA proj_priv TO proj_no_truncate")
        await conn.execute(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON proj_priv.points "
            "TO proj_no_truncate"
        )
        async with conn.transaction():
            await conn.execute("SET LOCAL ROLE proj_no_truncate")
            await _clear_projection(conn, "proj_priv.points")
            await conn.execute("INSERT INTO proj_priv.points VALUES (42)")
        assert await conn.fetchval("SELECT array_agg(id) FROM proj_priv.points") == [42]
    finally:
        await conn.execute("DROP SCHEMA IF EXISTS proj_priv CASCADE")
        await conn.close()


def test_sample_sql_hashes_ids_before_touching_vectors():
    sql = memory_projection._sample_sql([
        memory_projection._Source("memories", "memory", "topic"),
        memory_projection._Source("rag_chunks", "chunk", "document_id::text"),
    ])
    picked, fetch = sql.split(") SELECT", 1)
    assert "embedding" not in picked.split("WHERE embedding_model")[0]
    assert "ORDER BY hashtext(id::text), id LIMIT $2" in picked
    assert fetch.count("JOIN") == 2
