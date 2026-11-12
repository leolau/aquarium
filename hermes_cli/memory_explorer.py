"""HTTP routes for the memory explorer dashboard (FG-22).

Read-only inspection surface for the layer-4 pgvector memory tier. Every
endpoint resolves the C1 principal and scopes reads to the caller's visible
set — a raw ``SELECT * FROM memories`` anywhere in this module is a bug.

Mounted by ``web_server.py`` beside the memory OAuth router.
"""

from __future__ import annotations

import json
import math
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/memory/explorer")

_MAX_TEXT_CHARS = 2000
_MAX_LIMIT = 200

# Drawing budget for the projection map (FG-23 §6), not a page size: the
# default is what a phone can render, the cap is what the wire can carry.
_PROJECTION_LIMIT = 5000
_PROJECTION_MAX_LIMIT = 20000

# Simple in-memory token bucket for query-placement rate limiting (V3).
_query_rate_limit: dict[str, float] = {}
_RATE_LIMIT_SECONDS = 3.0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _memory_store(mode: Optional[str] = None):
    """Create a ``PgvectorMemoryStore`` for the requested schema mode.

    ``mode=None`` defers to ``get_store``, which resolves the instance's
    configured mode. Hard-coding ``prod`` would point the dashboard at a
    schema the agent never writes to on a dev-mode deployment: an empty map
    and an empty table, indistinguishable from having no memories at all.
    """
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store
    from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

    config = load_config() or {}
    resolved_mode = mode if mode in ("dev", "prod") else None
    app_store = get_store("supabase-app", resolved_mode, config=config)
    return PgvectorMemoryStore(app_store, config=config)


async def _resolve_principal(request: Request, *, allow_as: bool = False):
    """Resolve the C1 principal (lazy import to avoid circular)."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=allow_as)


def _owner_filter(*values: str) -> list[str]:
    """``owner=`` / ``owners=`` as a list of user ids, or a 400."""
    from hermes_cli.access import parse_owner_filter

    try:
        return parse_owner_filter(*values)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _truncate(text: str) -> tuple[str, bool]:
    """Truncate text to ``_MAX_TEXT_CHARS``, returning (text, truncated)."""
    if len(text) > _MAX_TEXT_CHARS:
        return text[:_MAX_TEXT_CHARS], True
    return text, False


def _empty_summary(store) -> dict:
    """Summary shape with zeros, for an uninitialized schema."""
    return {
        "space": {
            "column_dim": None,
            "rows_by_model": {},
            "configured_model": store.model_id,
            "healthy": True,
        },
        "totals": {"memories": 0, "documents": 0, "chunks": 0},
        "by_owner": {},
        "by_topic": {},
        "by_kind": {},
        "growth": [],
        "recall_use": {"never_used": 0, "used_7d": 0, "top": []},
    }


# ---------------------------------------------------------------------------
# V1: Summary + Rows
# ---------------------------------------------------------------------------

@router.get("/summary")
async def get_summary(request: Request, mode: Optional[str] = None):
    """Summary of the memory tier: space, totals, breakdowns, growth, recall.

    Returns zeros (not 500) when the schema is uninitialized.
    """
    principal = await _resolve_principal(request)
    store = _memory_store(mode)

    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        reads_by_elevation,
        scope_filter,
    )

    conn = await store.connect()
    try:
        # Check if the memories table exists at all.
        mem_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.memories')"
        )
        if not mem_exists:
            return _empty_summary(store)

        # Embedding space info (bypasses RLS — counts all rows for migration).
        space = await store.describe_space(connection=conn)
        configured_model = store.model_id
        healthy = (
            space.rows_outside(configured_model) == 0
            if space.rows_by_model
            else True
        )

        # Scope predicate for this principal (C2).
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind="memory",
            id_column="memories.id",
            role_elevation=store.role_reads,
        )
        psql = predicate.sql
        pparams = predicate.params

        # ── Totals ──
        total_memories = await conn.fetchval(
            f"SELECT COUNT(*) FROM memories WHERE {psql}", *pparams
        ) or 0

        # ── By owner ──
        by_owner_rows = await conn.fetch(
            f"SELECT owner_user_id, COUNT(*) AS n "
            f"FROM memories WHERE {psql} GROUP BY owner_user_id",
            *pparams,
        )
        by_owner = {str(r["owner_user_id"]): int(r["n"]) for r in by_owner_rows}

        # ── By topic ──
        by_topic_rows = await conn.fetch(
            f"SELECT COALESCE(topic, '(none)') AS topic, COUNT(*) AS n "
            f"FROM memories WHERE {psql} GROUP BY topic",
            *pparams,
        )
        by_topic = {str(r["topic"]): int(r["n"]) for r in by_topic_rows}

        # ── By kind ──
        by_kind_rows = await conn.fetch(
            f"SELECT kind, COUNT(*) AS n "
            f"FROM memories WHERE {psql} GROUP BY kind",
            *pparams,
        )
        by_kind = {str(r["kind"]): int(r["n"]) for r in by_kind_rows}

        # ── Growth — daily counts for last 30 days ──
        growth_rows = await conn.fetch(
            f"SELECT DATE(created_at) AS day, COUNT(*) AS n "
            f"FROM memories WHERE {psql} "
            f"AND created_at > NOW() - INTERVAL '30 days' "
            f"GROUP BY day ORDER BY day",
            *pparams,
        )
        growth = [
            {"day": str(r["day"]), "count": int(r["n"])} for r in growth_rows
        ]

        # ── Recall use ──
        recall_row = await conn.fetchrow(
            f"SELECT "
            f"COUNT(*) FILTER (WHERE uses = 0) AS never_used, "
            f"COUNT(*) FILTER (WHERE last_used > NOW() - INTERVAL '7 days') AS used_7d "
            f"FROM memories WHERE {psql}",
            *pparams,
        )
        # The most-recalled rows carry their *text*, so this one is a content
        # read: bound to the policy and audited when it surfaces someone else's
        # memory, exactly like ``/rows``.
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)
            top_rows = await conn.fetch(
                f"SELECT memories.id, text, uses, last_used, owner_user_id, "
                f"(SELECT pr.role FROM principals pr "
                f"  WHERE pr.user_id = memories.owner_user_id) AS owner_role "
                f"FROM memories WHERE {psql} "
                f"ORDER BY uses DESC, last_used DESC NULLS LAST LIMIT 5",
                *pparams,
            )
            elevated_subjects: dict[str, list] = {}
            for r in top_rows:
                if reads_by_elevation(principal, r, owner_role=r["owner_role"]):
                    elevated_subjects.setdefault(
                        str(r["owner_user_id"]), []
                    ).append(str(r["id"]))
            await store.audit_elevated_reads(
                conn,
                principal=principal,
                subjects=elevated_subjects,
                query_text="(memory explorer: summary top-recalled)",
            )
        top = []
        for r in top_rows:
            text, truncated = _truncate(str(r["text"]))
            top.append({
                "id": str(r["id"]),
                "text": text,
                "truncated": truncated,
                "uses": int(r["uses"]),
                "last_used": r["last_used"].isoformat() if r["last_used"] else None,
            })

        # ── RAG totals ──
        total_documents = 0
        total_chunks = 0
        doc_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.rag_documents')"
        )
        if doc_exists:
            doc_pred = scope_filter(
                principal,
                start_index=1,
                grant_item_kind="document",
                id_column="rag_documents.id",
                role_elevation=store.role_reads,
            )
            total_documents = await conn.fetchval(
                f"SELECT COUNT(*) FROM rag_documents WHERE {doc_pred.sql}",
                *doc_pred.params,
            ) or 0
        chunk_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.rag_chunks')"
        )
        if chunk_exists:
            chunk_pred = scope_filter(
                principal,
                start_index=1,
                grant_item_kind="document",
                id_column="rag_chunks.document_id",
                role_elevation=store.role_reads,
            )
            total_chunks = await conn.fetchval(
                f"SELECT COUNT(*) FROM rag_chunks WHERE {chunk_pred.sql}",
                *chunk_pred.params,
            ) or 0

        return {
            "space": {
                "column_dim": space.column_dim,
                "rows_by_model": space.rows_by_model,
                "configured_model": configured_model,
                "healthy": healthy,
            },
            "totals": {
                "memories": total_memories,
                "documents": total_documents,
                "chunks": total_chunks,
            },
            "by_owner": by_owner,
            "by_topic": by_topic,
            "by_kind": by_kind,
            "growth": growth,
            "recall_use": {
                "never_used": int(recall_row["never_used"] or 0) if recall_row else 0,
                "used_7d": int(recall_row["used_7d"] or 0) if recall_row else 0,
                "top": top,
            },
        }
    finally:
        await conn.close()


@router.get("/rows")
async def get_rows(
    request: Request,
    q: str = "",
    owner: str = "",
    owners: str = "",
    topic: str = "",
    kind: str = "",
    limit: int = 200,
    offset: int = 0,
    mode: Optional[str] = None,
):
    """Paginated memory rows, optionally filtered by semantic search.

    Without ``q``: simple paginated ``SELECT`` with scope filter, ordered by
    ``created_at DESC``. With ``q``: uses ``store.query(principal, q,
    min_score=0.0, top_k=limit)`` — floor deliberately 0 for inspection.
    """
    owner = _owner_filter(owner, owners)
    principal = await _resolve_principal(request)
    store = _memory_store(mode)

    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        reads_by_elevation,
        scope_filter,
    )

    limit_val = max(1, min(int(limit), _MAX_LIMIT))
    offset_val = max(0, int(offset))

    conn = await store.connect()
    try:
        # Check if the table exists.
        mem_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.memories')"
        )
        if not mem_exists:
            return {"rows": [], "total": 0, "limit": limit_val, "offset": offset_val}

        if kind == "chunk":
            chunks_exist = await conn.fetchval(
                "SELECT to_regclass(current_schema() || '.rag_chunks')"
            )
            if not chunks_exist:
                return {
                    "rows": [],
                    "total": 0,
                    "limit": limit_val,
                    "offset": offset_val,
                }
            return await _rows_chunks(
                store, principal, conn, owner, topic, limit_val, offset_val
            )
        elif q:
            return await _rows_with_query(
                store, principal, conn, q, owner, topic, kind, limit_val, offset_val
            )
        else:
            return await _rows_without_query(
                store, principal, conn, owner, topic, kind, limit_val, offset_val
            )
    finally:
        await conn.close()


async def _rows_with_query(
    store, principal, conn, q, owner, topic, kind, limit_val, offset_val
):
    """Semantic-search rows via ``store.query`` and enrich with uses/last_used."""
    from hermes_cli.access import bind_elevated_reads, bind_principal

    records = await store.query(
        principal,
        q,
        min_score=0.0,
        top_k=limit_val,
        kind=kind or None,
        topic=topic or None,
        connection=conn,
    )
    # Owner filter is not supported by store.query — apply in Python.
    if owner:
        records = [r for r in records if r.owner_user_id in owner]

    # Fetch uses/last_used for the returned records (RLS-bound transaction).
    uses_map: dict[str, tuple[int, Any]] = {}
    if records:
        ids = [r.id for r in records]
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)
            uses_rows = await conn.fetch(
                "SELECT id, uses, last_used FROM memories "
                "WHERE id = ANY($1::uuid[])",
                ids,
            )
            uses_map = {
                str(r["id"]): (int(r["uses"]), r["last_used"])
                for r in uses_rows
            }

    rows_out = []
    for record in records:
        text, truncated = _truncate(record.text)
        uses, last_used = uses_map.get(record.id, (0, None))
        rows_out.append({
            "id": record.id,
            "owner_user_id": record.owner_user_id,
            "visibility": record.visibility,
            "kind": record.kind,
            "topic": record.topic,
            "text": text,
            "truncated": truncated,
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "uses": uses,
            "last_used": last_used.isoformat() if last_used else None,
            "elevated": record.elevated,
            "provenance": record.provenance,
            "score": record.score,
            "source_session": record.source_session,
        })
    return {
        "rows": rows_out,
        "total": len(rows_out),
        "limit": limit_val,
        "offset": offset_val,
    }


async def _rows_without_query(
    store, principal, conn, owner, topic, kind, limit_val, offset_val
):
    """Paginated SELECT with scope filter, ordered by created_at DESC."""
    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        reads_by_elevation,
        scope_filter,
    )

    clauses: List[str] = []
    params: List[object] = []
    next_idx = 1

    if owner:
        clauses.append(f"owner_user_id = ANY(${next_idx}::text[])")
        params.append(owner)
        next_idx += 1
    if topic:
        clauses.append(f"topic = ${next_idx}")
        params.append(topic)
        next_idx += 1
    if kind:
        clauses.append(f"kind = ${next_idx}")
        params.append(kind)
        next_idx += 1

    predicate = scope_filter(
        principal,
        start_index=next_idx,
        grant_item_kind="memory",
        id_column="memories.id",
        role_elevation=store.role_reads,
    )
    clauses.append(predicate.sql)
    params.extend(predicate.params)

    where = " AND ".join(clauses) if clauses else "TRUE"

    # Inside one transaction with the GUCs bound, so the database policy is a
    # second gate on the app predicate above — and so any elevated row this
    # browse surfaces is audited in the same transaction as the read.
    async with conn.transaction():
        await bind_principal(conn, principal)
        await bind_elevated_reads(conn, store.role_reads)
        rows = await conn.fetch(
            f"""SELECT memories.id, owner_user_id, visibility, kind, text,
                      topic, created_at, uses, last_used, source_session,
                      (SELECT pr.role FROM principals pr
                        WHERE pr.user_id = memories.owner_user_id) AS owner_role
                FROM memories
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT {limit_val} OFFSET {offset_val}""",
            *params,
        )

        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM memories WHERE {where}", *params
        ) or 0

        elevated_subjects: dict[str, list] = {}
        for row in rows:
            if reads_by_elevation(principal, row, owner_role=row["owner_role"]):
                elevated_subjects.setdefault(
                    str(row["owner_user_id"]), []
                ).append(str(row["id"]))
        await store.audit_elevated_reads(
            conn,
            principal=principal,
            subjects=elevated_subjects,
            query_text="(memory explorer: browsed rows)",
        )

    rows_out = []
    for row in rows:
        text, truncated = _truncate(str(row["text"]))
        elevated = reads_by_elevation(
            principal, row, owner_role=row["owner_role"]
        )
        provenance = ""
        if elevated:
            provenance = f"from {row['owner_user_id']}'s memory"
        rows_out.append({
            "id": str(row["id"]),
            "owner_user_id": str(row["owner_user_id"]),
            "visibility": str(row["visibility"]),
            "kind": str(row["kind"]),
            "topic": row["topic"],
            "text": text,
            "truncated": truncated,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "uses": int(row["uses"]),
            "last_used": row["last_used"].isoformat() if row["last_used"] else None,
            "elevated": elevated,
            "provenance": provenance,
            "score": None,
            "source_session": row["source_session"],
        })
    return {
        "rows": rows_out,
        "total": total,
        "limit": limit_val,
        "offset": offset_val,
    }


async def _rows_chunks(
    store, principal, conn, owner, topic, limit_val, offset_val
):
    """Paginated RAG chunk rows, scope-filtered (V4).

    When ``?kind=chunk`` is passed to ``/rows``, reads from ``rag_chunks``
    joined with ``rag_documents`` for the title. Returns chunk-specific
    fields (``document_id``, ``document_title``, ``section``, ``ordinal``)
    in addition to the standard row shape.
    """
    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        is_uuid,
        reads_by_elevation,
        scope_filter,
    )

    # A malformed ``?document=`` (citation link) names no document: an empty
    # page, not a failed ``::uuid`` cast.
    if topic and not is_uuid(topic):
        return {"rows": [], "total": 0, "limit": limit_val, "offset": offset_val}

    clauses: List[str] = []
    params: List[object] = []
    next_idx = 1

    if owner:
        clauses.append(f"rag_chunks.owner_user_id = ANY(${next_idx}::text[])")
        params.append(owner)
        next_idx += 1
    # ``topic`` is used as a document_id filter for chunks.
    if topic:
        clauses.append(f"rag_chunks.document_id = ${next_idx}::uuid")
        params.append(topic)
        next_idx += 1

    # Qualified columns: the join with ``rag_documents`` puts a second
    # ``visibility`` and ``owner_user_id`` in scope, and an unqualified
    # predicate is an ambiguous-column error at query time.
    predicate = scope_filter(
        principal,
        column="rag_chunks.visibility",
        start_index=next_idx,
        grant_item_kind="document",
        id_column="rag_chunks.document_id",
        role_elevation=store.role_reads,
        owner_column="rag_chunks.owner_user_id",
    )
    clauses.append(predicate.sql)
    params.extend(predicate.params)

    where = " AND ".join(clauses) if clauses else "TRUE"

    # Guard the file_assets join so a box without the table still works.
    files_exist = await conn.fetchval(
        "SELECT to_regclass(current_schema() || '.file_assets')"
    )
    file_join = (
        "LEFT JOIN file_assets fa "
        "ON fa.document_id = rag_chunks.document_id"
        if files_exist
        else ""
    )
    file_col = (
        "fa.id AS file_asset_id"
        if files_exist
        else "NULL AS file_asset_id"
    )

    async with conn.transaction():
        await bind_principal(conn, principal)
        await bind_elevated_reads(conn, store.role_reads)
        rows = await conn.fetch(
            f"""SELECT rag_chunks.id, rag_chunks.document_id,
                       rag_chunks.owner_user_id, rag_chunks.visibility,
                       rag_chunks.ordinal, rag_chunks.text, rag_chunks.section,
                       rag_chunks.created_at,
                       rag_documents.title AS document_title,
                       rag_documents.source_kind, rag_documents.source_ref,
                       (SELECT pr.role FROM principals pr
                         WHERE pr.user_id = rag_chunks.owner_user_id)
                           AS owner_role,
                       {file_col}
                FROM rag_chunks
                LEFT JOIN rag_documents
                       ON rag_documents.id = rag_chunks.document_id
                {file_join}
                WHERE {where}
                ORDER BY rag_chunks.created_at DESC
                LIMIT {limit_val} OFFSET {offset_val}""",
            *params,
        )

        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM rag_chunks WHERE {where}", *params
        ) or 0

    rows_out = []
    for row in rows:
        text, truncated = _truncate(str(row["text"]))
        elevated = reads_by_elevation(
            principal, row, owner_role=row["owner_role"]
        )
        provenance = ""
        if elevated:
            provenance = f"from {row['owner_user_id']}'s memory"
        rows_out.append({
            "id": str(row["id"]),
            "owner_user_id": str(row["owner_user_id"]),
            "visibility": str(row["visibility"]),
            "kind": "chunk",
            "topic": str(row["document_id"]) if row["document_id"] else None,
            "text": text,
            "truncated": truncated,
            "created_at": row["created_at"].isoformat() if row["created_at"] else None,
            "uses": 0,
            "last_used": None,
            "elevated": elevated,
            "provenance": provenance,
            "score": None,
            # Chunk-specific fields
            "document_id": str(row["document_id"]) if row["document_id"] else None,
            "document_title": str(row["document_title"] or ""),
            "section": row["section"],
            "ordinal": int(row["ordinal"]),
            "source_kind": row["source_kind"],
            "source_ref": row["source_ref"],
            "file_asset_id": (
                str(row["file_asset_id"]) if row["file_asset_id"] else None
            ),
        })
    return {
        "rows": rows_out,
        "total": total,
        "limit": limit_val,
        "offset": offset_val,
    }


# ---------------------------------------------------------------------------
# V2: Projection map
# ---------------------------------------------------------------------------

@router.get("/projection")
async def get_projection(
    request: Request,
    mode: Optional[str] = None,
    limit: Optional[int] = None,
    owners: str = "",
):
    """2-D projection of every memory's embedding, scope-filtered.

    Returns ``{ algorithm: null, points: [], stale: true }`` when no
    projection has been fit yet (not 500). ``stale`` is true when rows
    exist without projection points, or the fitted model differs from the
    configured embedder.

    FG-23 §6: the point set is deterministically downsampled when it exceeds
    ``limit`` (default 5 000, hard cap 20 000) so the phone never receives
    megabytes of JSON. Sampling uses ``ORDER BY hashtext(id::text)`` — never
    ``random()`` — so a refetch does not reshuffle the map. The sample is
    applied **after** the scope predicate, so a principal's own rows can
    never be crowded out by rows they may not see. ``/projection/query``'s
    nearest list stays exact (runs over all rows).

    ``owners`` (comma-separated) keeps only those people's points, within what
    the caller may already read — the map's "whose data" picker.
    """
    owner_ids = _owner_filter(owners)
    principal = await _resolve_principal(request)
    store = _memory_store(mode)

    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        reads_by_elevation,
        scope_filter,
    )
    from plugins.memory.supabase_pgvector.rag import RAG_CHUNKS_TABLE
    from plugins.memory.supabase_pgvector.store import (
        MEMORY_TABLE,
        PROJECTION_BASIS_TABLE,
        PROJECTION_TABLE,
    )

    conn = await store.connect()
    try:
        # Check if the projection table exists at all.
        proj_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.memory_projection')"
        )
        if not proj_exists:
            return {"algorithm": None, "computed_at": None, "stale": True, "points": []}

        basis = await conn.fetchrow(
            f"SELECT algorithm, model, sample_size, fitted_at "
            f"FROM {PROJECTION_BASIS_TABLE} WHERE id = 1"
        )
        if not basis:
            return {"algorithm": None, "computed_at": None, "stale": True, "points": []}

        # Scope predicate on the projection table (C2). Qualified to the ``p``
        # alias because the label join brings two more ``visibility`` columns
        # (memories, rag_chunks) into scope.
        predicate = scope_filter(
            principal,
            column="p.visibility",
            start_index=1,
            grant_item_kind="memory",
            id_column="p.id",
            role_elevation=store.role_reads,
            owner_column="p.owner_user_id",
        )
        where_sql = predicate.sql
        where_params = list(predicate.params)
        if owner_ids:
            where_params.append(owner_ids)
            where_sql = (
                f"({where_sql}) AND p.owner_user_id = "
                f"ANY(${len(where_params)}::text[])"
            )

        # The chunk label join only exists once RAG has been initialized: with
        # ``memory.rag`` off there is no ``rag_chunks`` table, and joining it
        # unconditionally fails the whole map.
        chunks_exist = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.rag_chunks')"
        )
        chunk_label = "LEFT(c.text, 120)" if chunks_exist else "NULL"
        # Guard the file_assets join so a box without the table still works.
        files_exist = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.file_assets')"
        )
        # A chunk's citation is its document, so the label join carries the
        # document row too: without it a clicked chunk says only "chunk".
        file_join_clause = (
            " LEFT JOIN file_assets fa ON fa.document_id = c.document_id"
            if files_exist
            else ""
        )
        chunk_join = (
            f"LEFT JOIN {RAG_CHUNKS_TABLE} c ON c.id = p.id "
            "LEFT JOIN rag_documents d ON d.id = c.document_id"
            + file_join_clause
            if chunks_exist
            else ""
        )
        file_col = (
            ", fa.id AS file_asset_id"
            if chunks_exist and files_exist
            else ", NULL AS file_asset_id"
        )
        chunk_columns = (
            "c.section, c.document_id, d.title AS document_title, "
            "d.source_kind, d.source_ref"
            + file_col
            if chunks_exist
            else (
                "NULL AS section, NULL AS document_id, "
                "NULL AS document_title, NULL AS source_kind, "
                "NULL AS source_ref, NULL AS file_asset_id"
            )
        )

        # Sampling (FG-23 §6): count total scope-visible rows, then if they
        # exceed the limit, fetch a deterministic subset via hashtext. Clamped
        # low as well as high, like ``/rows``: ``LIMIT 0`` draws an empty map
        # and flags it ``sampled``, which reads as "no memories", and a
        # negative limit is a Postgres error reachable from a query string.
        limit_val = max(
            1,
            min(
                int(limit) if limit is not None else _PROJECTION_LIMIT,
                _PROJECTION_MAX_LIMIT,
            ),
        )

        # A dot's position plus its hover label *is* the memory, so the map is
        # read under the same two gates as a row: policy bound in-transaction,
        # and every elevated point audited before it is returned.
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)

            total_points = await conn.fetchval(
                f"SELECT COUNT(*) FROM {PROJECTION_TABLE} p "
                f"WHERE {where_sql}",
                *where_params,
            ) or 0

            sampled = total_points > limit_val
            if sampled:
                next_idx = len(where_params) + 1
                order_limit = (
                    f"ORDER BY hashtext(p.id::text) LIMIT ${next_idx}"
                )
                fetch_params = [*where_params, limit_val]
            else:
                order_limit = "ORDER BY p.fitted_at DESC"
                fetch_params = list(where_params)

            rows = await conn.fetch(
                f"""SELECT p.id, p.x, p.y, p.owner_user_id, p.topic, p.kind,
                          p.visibility, m.source_session,
                          {chunk_columns},
                          COALESCE(
                            LEFT(m.text, 120),
                            {chunk_label}
                          ) AS label,
                          (SELECT pr.role FROM principals pr
                            WHERE pr.user_id = p.owner_user_id) AS owner_role
                    FROM {PROJECTION_TABLE} p
                    LEFT JOIN {MEMORY_TABLE} m ON m.id = p.id
                    {chunk_join}
                    WHERE {where_sql}
                    {order_limit}""",
                *fetch_params,
            )

            elevated_subjects: dict[str, list] = {}
            for row in rows:
                if (
                    row["kind"] == "memory"
                    and reads_by_elevation(
                        principal, row, owner_role=row["owner_role"]
                    )
                ):
                    elevated_subjects.setdefault(
                        str(row["owner_user_id"]), []
                    ).append(str(row["id"]))
            await store.audit_elevated_reads(
                conn,
                principal=principal,
                subjects=elevated_subjects,
                query_text="(memory explorer: projection map)",
            )

        points = []
        for row in rows:
            elevated = reads_by_elevation(
                principal, row, owner_role=row["owner_role"]
            )
            provenance = ""
            if elevated:
                provenance = f"from {row['owner_user_id']}'s memory"
            points.append({
                "id": str(row["id"]),
                "x": float(row["x"]),
                "y": float(row["y"]),
                "owner_user_id": str(row["owner_user_id"]),
                "topic": row["topic"],
                "kind": str(row["kind"]),
                "elevated": elevated,
                "provenance": provenance,
                "label": str(row["label"] or ""),
                "source_session": row["source_session"],
                "document_id": (
                    str(row["document_id"]) if row["document_id"] else None
                ),
                "document_title": row["document_title"],
                "section": row["section"],
                "source_kind": row["source_kind"],
                "source_ref": row["source_ref"],
                "file_asset_id": (
                    str(row["file_asset_id"]) if row["file_asset_id"] else None
                ),
            })

        # Staleness: rows without projection, or model mismatch.
        mem_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.memories')"
        )
        stale = False
        unprojected = 0
        if mem_exists:
            unprojected = await conn.fetchval(
                f"SELECT COUNT(*) FROM {MEMORY_TABLE} m "
                f"WHERE NOT EXISTS ("
                f"  SELECT 1 FROM {PROJECTION_TABLE} p WHERE p.id = m.id"
                f")"
            ) or 0
            if unprojected > 0:
                stale = True
        if basis["model"] != store.model_id:
            stale = True

        result: dict = {
            "algorithm": basis["algorithm"],
            "computed_at": basis["fitted_at"].isoformat() if basis["fitted_at"] else None,
            "stale": stale,
            "unprojected_count": unprojected,
            "points": points,
        }
        if sampled:
            result["sampled"] = True
            result["total_points"] = total_points
        return result
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# V3: Query placement
# ---------------------------------------------------------------------------

@router.post("/projection/query")
async def post_projection_query(request: Request, mode: Optional[str] = None):
    """Place a query text on the projection map and find nearest memories.

    Embeds the text, projects it into the existing PCA/UMAP basis, and returns
    the 2-D coordinates plus the nearest points. **Never persists the query
    text** — this is an inspection aid, not a memory write. Rate-limited to 1
    request per 3 seconds per principal.
    """
    import time

    principal = await _resolve_principal(request)

    # Rate limit: 1 request per _RATE_LIMIT_SECONDS per principal.
    now = time.time()
    last = _query_rate_limit.get(principal.user_id, 0.0)
    if now - last < _RATE_LIMIT_SECONDS:
        raise HTTPException(status_code=429, detail="Rate limited")
    _query_rate_limit[principal.user_id] = now

    body = await request.json()
    text = (body.get("text") or "").strip()
    raw_owners = body.get("owners")
    if isinstance(raw_owners, list):
        raw_owners = ",".join(str(o) for o in raw_owners)
    owner_ids = _owner_filter(raw_owners if isinstance(raw_owners, str) else "")
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    store = _memory_store(mode)

    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        scope_filter,
    )
    from plugins.memory.supabase_pgvector.store import (
        PROJECTION_BASIS_TABLE,
        PROJECTION_TABLE,
    )

    conn = await store.connect()
    try:
        # Check if a basis exists.
        basis = await conn.fetchrow(
            f"SELECT algorithm, model, mean, components "
            f"FROM {PROJECTION_BASIS_TABLE} WHERE id = 1"
        )
        if not basis:
            raise HTTPException(
                status_code=409,
                detail="No projection has been fit yet. Run 'hermes memory projection fit'.",
            )

        # Embed the query text (never persisted — no INSERT, no UPDATE).
        embedding = store.embedder.embed(text)

        # Scope predicate for nearest-neighbor search.
        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind="memory",
            id_column=f"{PROJECTION_TABLE}.id",
            role_elevation=store.role_reads,
        )

        # Load projection points for nearest-neighbor computation.
        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)
            # The same people as the map: nearest points come from what it shows.
            where_sql, where_params = predicate.sql, list(predicate.params)
            if owner_ids:
                where_params.append(owner_ids)
                where_sql = (
                    f"({where_sql}) AND {PROJECTION_TABLE}.owner_user_id = "
                    f"ANY(${len(where_params)}::text[])"
                )
            rows = await conn.fetch(
                f"SELECT id, x, y FROM {PROJECTION_TABLE} WHERE {where_sql}",
                *where_params,
            )

        # Project the query embedding into the 2-D basis.
        degraded = False
        x: float | None = None
        y: float | None = None

        if basis["algorithm"] == "umap":
            try:
                import pickle

                from hermes_constants import get_hermes_home

                umap_path = get_hermes_home() / "memory_projection_umap.pkl"
                with open(umap_path, "rb") as fh:
                    reducer = pickle.load(fh)
                coords = reducer.transform([list(embedding)])
                x = float(coords[0][0])
                y = float(coords[0][1])
            except Exception:
                # UMAP model can't load — degrade gracefully.
                degraded = True
                x = None
                y = None
        else:
            # PCA: project using the stored mean and components. ``jsonb``
            # comes back as JSON text, so it is decoded rather than wrapped.
            # Two dot products and a 2-D sort below are plain Python on
            # purpose: numpy is not a base dependency, and a page request is
            # the wrong place to discover that (or to install it).
            mean = json.loads(basis["mean"])
            components = json.loads(basis["components"])
            if len(mean) > 0 and len(components) >= 2:
                centered = [v - m for v, m in zip(embedding, mean)]
                x = float(sum(c * w for c, w in zip(centered, components[0])))
                y = float(sum(c * w for c, w in zip(centered, components[1])))

        # Find nearest neighbors.
        nearest = []
        if rows and x is not None and y is not None:
            scored = sorted(
                (
                    (math.dist((row["x"], row["y"]), (x, y)), str(row["id"]))
                    for row in rows
                ),
                key=lambda pair: pair[0],
            )
            nearest = [
                {"id": row_id, "score": float(1.0 / (1.0 + distance))}
                for distance, row_id in scored[:5]
            ]
        elif degraded:
            # UMAP can't load — fall back to semantic search for nearest.
            try:
                records = await store.query(
                    principal, text, min_score=0.0, top_k=5, connection=conn
                )
                nearest = [
                    {"id": r.id, "score": r.score}
                    for r in records
                    if r.score is not None
                    and (not owner_ids or getattr(r, "owner_user_id", None) in owner_ids)
                ]
            except Exception:
                pass  # No basis, no semantic search — return empty nearest.

        result: dict = {
            "x": x,
            "y": y,
            "nearest": nearest,
        }
        if degraded:
            result["degraded"] = True
        return result
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# V4: RAG chunks + documents
# ---------------------------------------------------------------------------

@router.get("/documents")
async def get_documents(request: Request, mode: Optional[str] = None):
    """List RAG documents, scope-filtered to the caller's visible set.

    Returns ``{ documents: [], total: 0 }`` when the RAG schema is not
    initialized.
    """
    principal = await _resolve_principal(request)
    store = _memory_store(mode)

    from hermes_cli.access import (
        bind_elevated_reads,
        bind_principal,
        scope_filter,
    )

    conn = await store.connect()
    try:
        doc_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.rag_documents')"
        )
        if not doc_exists:
            return {"documents": [], "total": 0}

        predicate = scope_filter(
            principal,
            start_index=1,
            grant_item_kind="document",
            id_column="rag_documents.id",
            role_elevation=store.role_reads,
        )

        # The file_assets join is guarded so a box without the table still
        # returns documents — the registry shipped after the first deployments.
        files_exist = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.file_assets')"
        )
        file_join = (
            "LEFT JOIN file_assets fa ON fa.document_id = rag_documents.id"
            if files_exist
            else ""
        )
        file_col = (
            "fa.id AS file_asset_id"
            if files_exist
            else "NULL AS file_asset_id"
        )

        async with conn.transaction():
            await bind_principal(conn, principal)
            await bind_elevated_reads(conn, store.role_reads)
            rows = await conn.fetch(
                f"""SELECT rag_documents.id, rag_documents.owner_user_id,
                           rag_documents.visibility, rag_documents.source_kind,
                           rag_documents.source_ref, rag_documents.title,
                           rag_documents.chunk_count, rag_documents.ingested_at,
                           {file_col}
                    FROM rag_documents
                    {file_join}
                    WHERE {predicate.sql}
                    ORDER BY ingested_at DESC""",
                *predicate.params,
            )

        documents = [
            {
                "id": str(row["id"]),
                "owner_user_id": str(row["owner_user_id"]),
                "visibility": str(row["visibility"]),
                "source_kind": str(row["source_kind"]),
                "source_ref": str(row["source_ref"]),
                "title": str(row["title"]),
                "chunk_count": int(row["chunk_count"]),
                "ingested_at": row["ingested_at"].isoformat() if row["ingested_at"] else None,
                "file_asset_id": (
                    str(row["file_asset_id"]) if row["file_asset_id"] else None
                ),
            }
            for row in rows
        ]

        return {"documents": documents, "total": len(documents)}
    finally:
        await conn.close()
