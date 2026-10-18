"""CLI for fitting and inspecting the 2-D memory projection (FG-22).

The projection is a *derived* table: every row in ``memories`` (and later
``rag_chunks``) gets an ``(x, y)`` coordinate via PCA or UMAP so the memory
explorer can draw a scatter plot. Fitting is a CLI/timer job, never triggered
by a page load — a user clicking "Memory" should see the last map, not pay
the cost of drawing a new one.

The fit is operator-only and reads all embeddings without RLS: it exists to
*produce* a visualization, not to consume one. The scope policy on the
projection table itself is what prevents a user from seeing a private row's
coordinates.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pickle
import sys

from hermes_cli.config import load_config
from hermes_cli.datastore import get_store
from hermes_constants import get_hermes_home


def _store(mode: str | None):
    """Create a ``PgvectorMemoryStore`` for the requested schema mode."""
    from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

    config = load_config()
    app_store = get_store("supabase-app", mode) if mode else get_store("supabase-app")
    return PgvectorMemoryStore(app_store, config=config)


async def _bind_owner(conn, store) -> None:
    """Read as the owner: the fit and status cover every user's rows.

    Under a login that bypasses row rules (``postgres``) this changes nothing;
    under ``hermes_app`` an unbound connection would see no rows at all.
    """
    from hermes_cli.access import PrincipalStore, bind_principal

    owner = await PrincipalStore(store._store).get_owner(connection=conn)
    if owner is not None:
        await bind_principal(conn, owner, session=True)


async def fit_projection(
    store, *, algorithm: str = "pca", sample_size: int = 20000
) -> None:
    """Compute and write the 2-D projection of every embedding.

    Async so a caller already inside an event loop (a test, or a future
    scheduled job) can await it; ``cmd_projection_fit`` is the sync CLI wrapper.
    """
    from tools.lazy_deps import ensure

    # numpy is not a base dependency (it ships only in the voice extra), so a
    # plain install reaches the fit and dies on the import. Installing here,
    # in an operator CLI job, is the one place it is affordable — the
    # dashboard's own query placement stays numpy-free.
    ensure("memory.projection.pca", prompt=False)

    import numpy as np

    from plugins.memory.supabase_pgvector.rag import RAG_CHUNKS_TABLE
    from plugins.memory.supabase_pgvector.store import (
        MEMORY_TABLE,
        PROJECTION_BASIS_TABLE,
        PROJECTION_TABLE,
    )

    conn = await store.connect()
    try:
        await _bind_owner(conn, store)
        # Check the table exists.
        exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.memories')"
        )
        if not exists:
            print("\n  The memories table does not exist yet.")
            print("  Initialize the schema first (start a session).\n")
            return

        # Load every user's embeddings (bound as the owner above), but only
        # those made by the configured model. Two embedding spaces in one PCA
        # produce a map whose distances mean nothing, and stamping the
        # configured model on it would make that map indistinguishable from a
        # good one. Rows from another model are left out and reported.
        rows = await conn.fetch(
            f"SELECT id, embedding, owner_user_id, visibility, topic "
            f"FROM {MEMORY_TABLE} WHERE embedding_model = $1",
            store.model_id,
        )
        skipped = await conn.fetchval(
            f"SELECT COUNT(*) FROM {MEMORY_TABLE} WHERE embedding_model <> $1",
            store.model_id,
        ) or 0
        if not rows:
            print("\n  No memories to project.")
            if skipped:
                print(
                    f"  {skipped} row(s) were embedded with another model — "
                    f"run 'hermes memory vectors reembed' first."
                )
            print()
            return

        # Load RAG chunks if the table exists (V4).
        chunk_rows = []
        chunk_exists = await conn.fetchval(
            "SELECT to_regclass(current_schema() || '.rag_chunks')"
        )
        if chunk_exists:
            chunk_rows = await conn.fetch(
                f"SELECT id, embedding, owner_user_id, visibility, "
                f"document_id::text AS topic "
                f"FROM {RAG_CHUNKS_TABLE} WHERE embedding_model = $1",
                store.model_id,
            )

        mem_total = len(rows)
        chunk_total = len(chunk_rows)
        total = mem_total + chunk_total
        sampled = total > sample_size
        print(f"\n  algorithm          {algorithm}")
        print(f"  rows              {total}")
        if chunk_total:
            print(f"  chunks            {chunk_total}")
        if skipped:
            print(f"  skipped (model)   {skipped}")

        mem_embeddings = np.array(
            [list(row["embedding"]) for row in rows], dtype=np.float64
        )
        if chunk_rows:
            chunk_embeddings = np.array(
                [list(row["embedding"]) for row in chunk_rows],
                dtype=np.float64,
            )
            embeddings = np.vstack([mem_embeddings, chunk_embeddings])
        else:
            chunk_embeddings = np.empty((0, mem_embeddings.shape[1]))
            embeddings = mem_embeddings

        ids = [str(row["id"]) for row in rows]
        owners = [row["owner_user_id"] for row in rows]
        visibilities = [row["visibility"] for row in rows]
        topics = [row["topic"] for row in rows]

        # ── Compute the projection ──
        umap_ok = False
        if algorithm == "umap":
            try:
                ensure("memory.projection", prompt=False)
                import umap

                reducer = umap.UMAP(n_components=2, random_state=42)
                coords = reducer.fit_transform(embeddings)
                xs = coords[:, 0].tolist()
                ys = coords[:, 1].tolist()
                umap_ok = True
            except Exception as exc:
                print(f"  \u26a0 UMAP failed ({exc}), falling back to PCA")

        if not umap_ok:
            # PCA via SVD (numpy only, no non-numeric dependency)
            if sampled:
                indices = np.random.choice(total, sample_size, replace=False)
                sample_emb = embeddings[indices]
            else:
                sample_emb = embeddings

            mean = sample_emb.mean(axis=0)
            centered_sample = sample_emb - mean
            _, _, vt = np.linalg.svd(centered_sample, full_matrices=False)
            # SVD yields at most rank-many components, so a corpus of one or
            # two rows has fewer than the two axes a plot needs. Pad with a
            # zero axis: the map collapses to a line, which is the honest
            # picture of two points, rather than failing the whole fit.
            components = np.zeros((2, embeddings.shape[1]))
            components[: min(2, vt.shape[0])] = vt[: min(2, vt.shape[0])]

            # Project every row with the fitted basis.
            centered = embeddings - mean
            xs = (centered @ components[0]).tolist()
            ys = (centered @ components[1]).tolist()

        fit_algorithm = "umap" if umap_ok else "pca"
        # jsonb params are sent as JSON text: asyncpg will not encode a bare
        # Python list into it.
        fit_mean = json.dumps([] if umap_ok else mean.tolist())
        fit_components = json.dumps([] if umap_ok else components.tolist())

        # Split coordinates back into memory and chunk sets.
        mem_xs = xs[:mem_total]
        mem_ys = ys[:mem_total]
        chunk_xs = xs[mem_total:]
        chunk_ys = ys[mem_total:]

        # Write all points + basis in one transaction (idempotent,
        # and a failed fit leaves the previous map intact).
        async with conn.transaction():
            await conn.execute(f"DELETE FROM {PROJECTION_TABLE}")
            await conn.executemany(
                f"INSERT INTO {PROJECTION_TABLE} "
                f"(id, kind, owner_user_id, visibility, topic, "
                f" x, y, model, algorithm, fitted_at) "
                f"VALUES ($1, 'memory', $2, $3, $4, $5, $6, $7, $8, NOW())",
                [
                    (
                        ids[i],
                        owners[i],
                        visibilities[i],
                        topics[i],
                        mem_xs[i],
                        mem_ys[i],
                        store.model_id,
                        fit_algorithm,
                    )
                    for i in range(mem_total)
                ],
            )
            if chunk_rows:
                await conn.executemany(
                    f"INSERT INTO {PROJECTION_TABLE} "
                    f"(id, kind, owner_user_id, visibility, topic, "
                    f" x, y, model, algorithm, fitted_at) "
                    f"VALUES ($1, 'chunk', $2, $3, $4, $5, $6, $7, $8, NOW())",
                    [
                        (
                            str(chunk_rows[i]["id"]),
                            chunk_rows[i]["owner_user_id"],
                            chunk_rows[i]["visibility"],
                            chunk_rows[i]["topic"],
                            chunk_xs[i],
                            chunk_ys[i],
                            store.model_id,
                            fit_algorithm,
                        )
                        for i in range(chunk_total)
                    ],
                )
            await conn.execute(
                f"INSERT INTO {PROJECTION_BASIS_TABLE} "
                f"(id, algorithm, model, mean, components, "
                f" sample_size, fitted_at) "
                f"VALUES (1, $1, $2, $3, $4, $5, NOW()) "
                f"ON CONFLICT (id) DO UPDATE SET "
                f"algorithm = EXCLUDED.algorithm, "
                f"model = EXCLUDED.model, "
                f"mean = EXCLUDED.mean, "
                f"components = EXCLUDED.components, "
                f"sample_size = EXCLUDED.sample_size, "
                f"fitted_at = EXCLUDED.fitted_at",
                fit_algorithm,
                store.model_id,
                fit_mean,
                fit_components,
                sample_size if sampled else None,
            )

        if umap_ok:
            # Persisted only once the map it belongs to is committed: a pickle
            # for coordinates that were rolled back would place a typed query
            # into a basis the stored points were never drawn in.
            umap_path = get_hermes_home() / "memory_projection_umap.pkl"
            tmp_path = umap_path.with_suffix(".pkl.tmp")
            with open(tmp_path, "wb") as fh:
                pickle.dump(reducer, fh)
            tmp_path.replace(umap_path)

        print(f"  projected         {total}")
        print(
            f"  sampled           "
            f"{'yes (' + str(sample_size) + ')' if sampled else 'no'}"
        )
        print(f"  model             {store.model_id}")
        print(f"  \u2713 projection written\n")
    finally:
        await conn.close()


def cmd_projection_fit(args: argparse.Namespace) -> None:
    """``hermes memory projection fit`` — sync entry point for the fit."""
    store = _store(getattr(args, "mode", None))
    try:
        asyncio.run(
            fit_projection(
                store,
                algorithm=getattr(args, "algorithm", "pca"),
                sample_size=int(getattr(args, "sample", 20000)),
            )
        )
    except Exception as exc:
        print(f"\n  \u2717 {exc}\n", file=sys.stderr)
        raise SystemExit(1) from exc


def cmd_projection_status(args: argparse.Namespace) -> None:
    """Print algorithm, fitted_at, model, point count, and staleness."""
    from plugins.memory.supabase_pgvector.store import (
        MEMORY_TABLE,
        PROJECTION_BASIS_TABLE,
        PROJECTION_TABLE,
    )

    store = _store(getattr(args, "mode", None))

    async def _status() -> None:
        conn = await store.connect()
        try:
            await _bind_owner(conn, store)
            basis = await conn.fetchrow(
                f"SELECT algorithm, model, sample_size, fitted_at "
                f"FROM {PROJECTION_BASIS_TABLE} WHERE id = 1"
            )
            if not basis:
                print("\n  No projection has been fit yet.")
                print("  Run 'hermes memory projection fit' to create one.\n")
                return

            point_count = await conn.fetchval(
                f"SELECT COUNT(*) FROM {PROJECTION_TABLE}"
            ) or 0

            mem_count = await conn.fetchval(
                f"SELECT COUNT(*) FROM {MEMORY_TABLE}"
            ) or 0

            stale_count = await conn.fetchval(
                f"SELECT COUNT(*) FROM {MEMORY_TABLE} m "
                f"WHERE NOT EXISTS ("
                f"  SELECT 1 FROM {PROJECTION_TABLE} p WHERE p.id = m.id"
                f")"
            ) or 0

            model_mismatch = basis["model"] != store.model_id

            print(f"\n  algorithm          {basis['algorithm']}")
            print(f"  model              {basis['model']}")
            if basis["sample_size"]:
                print(f"  sample             {basis['sample_size']}")
            print(f"  fitted_at          {basis['fitted_at']}")
            print(f"  points             {point_count}")
            print(f"  memories           {mem_count}")
            if stale_count > 0 or model_mismatch:
                parts = []
                if stale_count > 0:
                    parts.append(f"{stale_count} rows without projection")
                if model_mismatch:
                    parts.append("model mismatch")
                print(f"  \u26a0 stale            {', '.join(parts)}")
                print("    Run 'hermes memory projection fit' to update.\n")
            else:
                print("  \u2713 up to date\n")
        finally:
            await conn.close()

    try:
        asyncio.run(_status())
    except Exception as exc:
        print(f"\n  \u2717 {exc}\n", file=sys.stderr)
        raise SystemExit(1) from exc


def cmd_memory_projection(args: argparse.Namespace) -> None:
    """Dispatch ``hermes memory projection <fit|status>``."""
    action = getattr(args, "projection_command", None) or "status"
    try:
        if action == "fit":
            cmd_projection_fit(args)
        elif action == "status":
            cmd_projection_status(args)
        else:
            print(f"Unknown projection action: {action}", file=sys.stderr)
            raise SystemExit(2)
    except SystemExit:
        raise
    except Exception as exc:
        print(f"\n  \u2717 {exc}\n", file=sys.stderr)
        raise SystemExit(1) from exc


def register_projection_subparser(
    memory_sub: argparse._SubParsersAction,
) -> None:
    """Attach ``projection`` under an existing ``hermes memory`` subparser."""
    parser = memory_sub.add_parser(
        "projection",
        help="Fit or inspect the 2-D memory projection map",
        description=(
            "The memory projection is a 2-D scatter plot of every memory's "
            "embedding, projected via PCA (default) or UMAP. Fitting is a "
            "CLI job \u2014 the dashboard reads the last map, it does not pay "
            "the cost of drawing a new one on every page load."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["dev", "prod"],
        default=None,
        help="Datastore mode to act on (default: the configured mode)",
    )
    actions = parser.add_subparsers(dest="projection_command")
    actions.add_parser(
        "status",
        help="Show algorithm, fitted_at, point count, staleness",
    )
    fit = actions.add_parser(
        "fit",
        help="Compute and write the projection (PCA by default)",
    )
    fit.add_argument(
        "--algorithm",
        choices=["pca", "umap"],
        default="pca",
        help="Projection algorithm (default: pca)",
    )
    fit.add_argument(
        "--sample",
        type=int,
        default=20000,
        help="If rows exceed this, fit on a random sample (default: 20000)",
    )
