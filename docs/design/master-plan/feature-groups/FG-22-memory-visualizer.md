# FG-22 — Memory visualizer: a read-only window into layer 4

**Wave:** B (after FG-21 P1–P4) · **Owner agent:** unassigned · **Status:** Plan — ready to implement

## Summary

A **read-only** page on the existing Hermes dashboard that answers three
questions about the layer-4 pgvector tier that nothing today can answer:

1. **How much is in there, and whose is it?** — counts by owner, topic, kind,
   embedding model; growth over time; how much is *ever recalled*.
2. **What is actually in there?** — the rows themselves, searchable by meaning,
   with `uses` / `last_used` so dead weight is visible.
3. **Is the embedding space any good?** — a 2D projection of the vectors, so
   related memories visibly cluster, and a typed query visibly lands inside or
   outside a cluster.

(3) is the reason this exists. After the FG-21 cutover the claim "recall is
semantic now" rests on a handful of probe queries in a deploy log. A projection
makes the claim inspectable by a human in one glance, and it is the only view
that stays useful when RAG ingestion turns 28 rows into tens of thousands of
chunks.

**Non-goals.** No writes, no deletes, no re-embedding from the browser, no
Supabase Studio exposure. Every mutation stays on the CLI where it is
auditable and slow on purpose. This page can only ever *disclose*, which
bounds the worst case to "someone with the dashboard password reads memory
they were already entitled to read".

## Why not just expose Supabase Studio

Considered and rejected. Studio has **no authentication of its own** — anything
that reaches it has read/write on the whole database. It is currently
unreachable by construction (the `supabase-studio` container has no host port
binding at all: `PortBindings: {}`), and putting it behind the dashboard's Caddy
vhost would trade a firewall boundary for a password. An SSH tunnel remains the
break-glass path for an operator who needs raw SQL; it needs no code.

Related finding while surveying, not part of this FG but worth fixing: the
Supabase gateway is published on `0.0.0.0:8000/8443`. External probes time out,
so the Alibaba security group is holding, but the bind is wider than the
protection. Narrow it to loopback.

## 1. What exists today (surveyed, not assumed)

| Thing | Where | Note |
|---|---|---|
| Dashboard server | `hermes_cli/web_server.py` (FastAPI, ~16k lines) | `hermes dashboard --host 0.0.0.0 --port 9119`, fronted by Caddy at `https://<dashboard-host>` |
| Router seam | `app.include_router(_memory_oauth_router)` (`web_server.py:266`), router defined in `hermes_cli/memory_oauth.py` | the precedent for adding endpoints **without** growing the god-file |
| Principal resolution | `_comms_resolve_principal(request, allow_as=True)` (`web_server.py:3072`) | already implements C1 identity binding, the owner/admin-only `?as=` narrowing, and 409 on an unenrolled subject |
| Frontend | `web/` — React + React Router, screens in `web/src/screens/`, routes in `web/src/App.tsx` (`BUILTIN_ROUTES_CORE`, `BUILTIN_NAV_REST`) | `AnalyticsPage.tsx` is the closest existing analogue |
| Charting | **`@observablehq/plot@^0.6.17` is already a dependency** and currently unused in `web/src` | no new frontend dependency is needed for the scatter plot |
| Data access | `PgvectorMemoryStore` (`plugins/memory/supabase_pgvector/store.py`): `query()`, `describe_space()`, `MemoryRecord`, `EmbeddingSpace`; `RagStore` (`rag.py`): `documents()`, `search()` | all principal-scoped and RLS-backed |
| Heavy deps | `tools/lazy_deps.py` — `ensure("<group>", prompt=False)` installs on demand | how `asyncpg` already arrives (`datastore.supabase`) |
| Live state | `app_dev.memories`: 28 rows, `vector(1024)`, all `BAAI/bge-m3`; RAG tables not yet created (`memory.rag` off) | the page must render sensibly at 0, 28, and 100k rows |

## 2. The one rule this feature must not break

**The visualizer reads through the access layer, never around it.**

Every endpoint resolves its principal with `_comms_resolve_principal` and passes
that principal into `PgvectorMemoryStore` / `RagStore`, which apply the C2 scope
filter *and* RLS. Concretely:

- a member sees their own rows and shared rows — never a peer's;
- an owner/admin sees a lower role's private rows **only if
  `memory.sharing.role_reads` is on**, and every such read is written to the
  audit ledger in the same transaction, exactly as a chat recall is;
- elevated rows arrive flagged (`MemoryRecord.elevated`) and the UI must label
  them, for the same reason recall labels them: another person's private note
  must never render as if it were yours;
- `?as=` narrowing is owner/admin-only and read-only, and is already
  implemented — reuse it, do not reimplement it.

**A raw `SELECT * FROM memories` anywhere in this feature is a bug**, including
in the projection job. The one deliberate exception is the aggregate counts in
§4.1, which return no row text and are still filtered to the caller's visible
set by the same scope predicate — see the test in §8 that asserts a member's
counts and a member's row list agree.

## 3. Architecture

```
web/src/screens/MemoryPage.tsx        ← new page (read-only)
        │  fetch()
        ▼
hermes_cli/memory_explorer.py         ← new APIRouter, prefix /api/memory/explorer
        │  _comms_resolve_principal(...)  →  Principal
        ▼
PgvectorMemoryStore / RagStore        ← unchanged; scope filter + RLS + audit
        ▼
app_{dev,prod}.memories, .rag_chunks, .memory_projection (new)
```

Nothing in `plugins/memory/**` changes except the projection helpers in §5,
which are additive.

## 4. API

New module `hermes_cli/memory_explorer.py`, mirroring `memory_oauth.py`:

```python
router = APIRouter(prefix="/api/memory/explorer")
```

registered in `web_server.py` beside the existing include. All endpoints are
`GET`, all take an optional `?mode=dev|prod` (default: the configured mode) and
the inherited `?as=` narrowing.

### 4.1 `GET /summary`

```jsonc
{
  "space":   { "column_dim": 1024, "rows_by_model": { "BAAI/bge-m3": 28 },
               "configured_model": "BAAI/bge-m3", "healthy": true },
  "totals":  { "memories": 28, "documents": 0, "chunks": 0 },
  "by_owner":   [ { "owner_user_id": "leo_owner", "rows": 28, "elevated": false } ],
  "by_topic":   [ { "topic": "task_discovery", "rows": 24 } ],
  "by_kind":    [ { "kind": "intent_signal", "rows": 24 } ],
  "growth":     [ { "day": "2026-07-22", "rows": 3 } ],
  "recall_use": { "never_used": 26, "used_7d": 2, "top": [ {"id": "...", "uses": 4} ] }
}
```

`space` comes from `describe_space()` — so the page surfaces a model mismatch
(the state that silently ruins ranking) as a banner rather than leaving it to a
CLI nobody runs. `recall_use` is the honest metric for whether layer 4 earns its
keep: rows written and never read are the failure mode FG-21 P2 existed to fix.

### 4.2 `GET /rows?q=&owner=&topic=&limit=&offset=`

Paginated rows: `id, owner_user_id, visibility, kind, topic, text, created_at,
uses, last_used, elevated, provenance`. With `q`, results are ranked by
`store.query(principal, q, min_score=0.0)` — **floor deliberately 0** here,
because this is an inspection surface and the operator needs to see the near
misses that the recall floor rejects. Include each row's score so the floor is
visible as a line in the UI, not a mystery.

Cap `limit` at 200. Truncate `text` to 2,000 chars with a `truncated` flag.

### 4.3 `GET /projection?dims=2`

```jsonc
{
  "algorithm": "umap",              // or "pca" — see §5
  "computed_at": "2026-08-04T09:00:00Z",
  "stale": false,                   // rows changed since the projection ran
  "points": [ { "id": "…", "x": 1.83, "y": -0.42, "owner_user_id": "leo_owner",
                "topic": "task_discovery", "kind": "intent_signal",
                "elevated": false, "label": "find out when the next tender is due" } ]
}
```

`label` is the first 120 chars — enough for a hover tooltip, and the full text
comes from `/rows` on click, so a 100k-point payload is not 100k documents.

### 4.4 `POST /projection/query`

The only non-GET, and it writes nothing: body `{ "text": "…" }`, response
`{ "x": …, "y": …, "nearest": [ {"id": …, "score": …} ] }`. It embeds the text
with the configured embedder and places it in the **existing** projection (§5),
so the operator can see where their question lands. Rate-limit it — it costs an
embedding call (~0.2 s on the box) — and it must never persist the query text.

## 5. The projection

This is the part with real design content; the rest is CRUD-shaped.

**Computing UMAP on every page load is not an option.** UMAP over 100k × 1,024
floats is minutes of CPU on a box whose 4 vCPUs are shared with the live
gateway. So:

**Storage.** A new table, created by the same `initialize()` path as the other
layer-4 tables:

```sql
CREATE TABLE IF NOT EXISTS memory_projection (
    id            UUID PRIMARY KEY,     -- memories.id or rag_chunks.id
    kind          TEXT NOT NULL,        -- 'memory' | 'chunk'
    x             REAL NOT NULL,
    y             REAL NOT NULL,
    model         TEXT NOT NULL,        -- embedding model the projection was fit on
    algorithm     TEXT NOT NULL,        -- 'umap' | 'pca'
    fitted_at     TIMESTAMPTZ NOT NULL
);
```

Row-level security must mirror `memories`: **a projection point is as
disclosive as the row it projects** — cluster membership plus a hover label is
the content. Apply the same scope RLS rather than inventing a second policy,
and add the negative test (§8) that a member cannot read another member's
points.

**Fitting.** A CLI command, not an HTTP handler:

```bash
hermes memory projection fit  [--mode dev] [--algorithm umap|pca] [--sample N]
hermes memory projection status
```

Run it after ingestion, and from a systemd timer once RAG makes the corpus
grow nightly (`nice`d and idle-IO, same posture as the ingestion job). The
endpoint only ever *reads* the table; a page load never fits.

**Algorithm.** `umap-learn` behind `tools/lazy_deps.py` (new group
`memory.projection`), because it is a heavy dependency (numba, llvmlite) that
most deployments will never use. **PCA via numpy is the fallback and the
default when `umap-learn` is absent** — it is worse at showing cluster
structure but has no dependency, is deterministic, and is genuinely better for
the `POST /projection/query` case because projecting a *new* point into a fitted
PCA basis is a matrix multiply, while UMAP needs `transform()` and the fitted
model in memory.

Practical consequence for the implementer: **persist whatever is needed to place
a new point without refitting.** For PCA that is the component matrix and the
mean vector (store as a small side table or a JSON blob next to the projection);
for UMAP it is a pickled model on disk, which is version-fragile — so if
`umap-learn` is the fitted algorithm and its model cannot be loaded, the query
endpoint must degrade to "nearest neighbours, no dot" rather than lie about a
position.

**Staleness, honestly.** `stale: true` when rows exist that have no projection
point, or when the fitted `model` differs from the configured embedder. The UI
says "12 memories added since this map was drawn" — it must not silently draw a
partial picture, which is the same class of failure as ranking across embedding
spaces.

**Sampling.** Above `--sample` (default 20,000) points, fit on a random sample
and place the rest by nearest-neighbour interpolation, or simply cap and label
the map "sampled". Never silently drop points.

## 6. Frontend

`web/src/screens/MemoryPage.tsx`, registered in `web/src/App.tsx`:
`BUILTIN_ROUTES_CORE["/memory"] = MemoryPage` and a `BUILTIN_NAV_REST` entry
(`labelKey: "memory"`, icon `Brain` from lucide-react). Add the title mapping in
`web/src/lib/resolve-page-title.ts` and the i18n key alongside the existing
screens. Follow `AnalyticsPage.tsx` for data-loading and empty-state shape.

Three sections on one page:

1. **Header strip** — model, dimensions, row counts, and a **warning banner**
   when `space.rows_by_model` has more than one entry or the configured model
   is absent, naming `hermes memory vectors reembed` as the fix.
2. **Map** — `@observablehq/plot` dot mark, colour by topic (or owner when
   `?as=`/role reads make several owners visible), hover for the label, click to
   select. A query box calls `POST /projection/query` and draws the result as a
   distinct mark with its nearest neighbours highlighted. **The recall floor
   should be drawable**: when a query is placed, dim the points scoring below
   `memory.recall.min_score` — that is the picture that explains why the floor
   is 0.65 far better than the paragraph in the deployment doc does.
3. **Table** — the rows behind the map: text, owner, topic, `uses`,
   `last_used`, score when searching. Rows the caller sees only by elevation
   render with the provenance label and a distinct style; do not hide the
   distinction.

Empty state matters: with `memory.rag` off and no ingestion, this page shows 28
memories and zero documents. It should say so plainly and link to the runbook,
not render an empty chart that looks broken.

## 7. Phasing

| Phase | Deliverable | Depends on |
|---|---|---|
| **V1** | `/summary` + `/rows` + the header strip and table. No projection. | nothing beyond FG-21 P2 |
| **V2** | `memory_projection` table, `hermes memory projection fit` (PCA), `/projection`, the map. | V1 |
| **V3** | `umap-learn` via lazy deps, `POST /projection/query`, floor visualisation. | V2 |
| **V4** | RAG chunks on the same map (colour by document), document list, `stale` timer. | FG-21 P4 ingestion actually run |

V1 is independently useful — it answers "how much is in there and what is never
recalled" — and it is the half that has no CPU cost. Ship it first.

## 8. Tests

Real Postgres, following `tests/plugins/memory/test_memory_vector_space_e2e.py`
(throwaway pgvector container fixture) and `tests/hermes_cli/test_web_server*.py`
for the HTTP layer.

Access control, which is the whole risk surface:

- a member's `/rows` excludes another member's private rows — asserted both
  through the endpoint **and** with a raw `SELECT` under a Postgres role that
  cannot bypass RLS;
- a member's `/summary` counts equal the number of rows that member can list —
  no count leaks the existence of rows the caller cannot see;
- `?as=` as a member is ignored; as an owner it narrows and cannot escalate;
- with `role_reads` **off**, an owner's `/rows` contains no member rows; with it
  **on**, it does, each flagged `elevated`, and an audit row exists afterwards;
- `/projection` points obey the same matrix (this is the test most likely to be
  skipped and the one that matters — a point is content);
- an unenrolled authenticated subject gets 409, not owner access.

Behaviour:

- `/summary` on an uninitialized schema returns zeros, not a 500 — the same
  lesson as `hermes memory vectors status` before PR #102;
- mixed-model rows set the warning field;
- `stale` is true after writing a row post-fit;
- `projection fit` is idempotent and transactional — a failed fit leaves the
  previous map intact and readable;
- `POST /projection/query` persists nothing (assert row counts unchanged).

## 9. Risks

| Risk | Mitigation |
|---|---|
| The page becomes a way to read memory the access rules forbid | every read goes through `_comms_resolve_principal` + the store; RLS negative tests in §8; no raw SQL for row content |
| A UMAP fit starves the live gateway | fitting is a CLI/timer job, `nice`d, never triggered by a page load; PCA default |
| Adding `umap-learn` bloats every install | lazy deps group, absent by default, PCA fallback |
| The map implies structure that is not there | label the algorithm, the sample size and the staleness on the page; a 2D projection of 1,024 dims *always* distorts — say so in the UI, once |
| Elevated rows render as the viewer's own | reuse `MemoryRecord.provenance`; test asserts the label is present |
| Scaling to 100k chunks | server-side pagination, projection precomputed and capped, labels truncated to 120 chars |

## 10. Acceptance

- With `memory.rag` off and 28 memories, `/memory` loads in under a second and
  correctly reports 28 rows, one model, zero documents.
- Turning on `role_reads` with a second enrolled member changes what the page
  shows, and produces audit rows the member can see via
  `hermes memory sharing --as <member> audit`.
- After `hermes memory projection fit`, the map visibly separates the tender
  memories from the AWS ones, and typing `招標截止日期是幾時` places a point
  inside the tender cluster — the same fact the FG-21 cutover proved with
  numbers, now proved with a picture.
