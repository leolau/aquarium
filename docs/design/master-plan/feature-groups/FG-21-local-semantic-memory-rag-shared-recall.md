# FG-21 — Local semantic memory (layer 4), RAG, and shared recall across users

**Wave:** 0 (foundation for recall) → A → B · **Owner agent:** unassigned · **Status:** P0–P4 BUILT (§8, §8.1–8.3; all §10 decisions resolved 2026-08-04). **P5 (consolidation) not started**

## Summary

Turn the existing pgvector tier into the agent's **fourth memory layer**: a
**semantic**, **local-only**, **RLS-scoped** store that (a) is recalled
automatically rather than only when the model remembers to ask, (b) backs a
**RAG** corpus over documents/messages/sessions, and (c) is **shared across
users of one instance** — memory belongs to a user, and a higher-privilege
principal (owner, and by explicit right an admin or grantee) can read another
user's memory, with every such read audited.

Three things are wrong today and each is a separate piece of work: the
embeddings are not semantic, nothing reads the store, and the multi-user
identity that access rights depend on is not wired up on the channels people
actually use. This FG fixes them in that order, because each one makes the next
one meaningful.

## Decisions applied

- **D2** hybrid memory (frozen curated snapshot + live queryable tier) — unchanged.
- **D1 / C2** per-user private vs shared vs owner-sees-all — extended, not replaced.
- **D4** pgvector in self-hosted Supabase is the datastore for the application layer.
- **New (proposed, needs owner sign-off — see §10):** *embeddings are computed
  **on the box**; memory text never leaves the deployment for embedding.*

## 1. What is actually live today (measured on `hermes-systest`, 2026-08-04)

| Layer | Mechanism | State |
|---|---|---|
| **1 — curated snapshot** | `MEMORY.md` / `USER.md`, loaded once at session start, byte-stable in the system prompt (`tools/memory_tool.py`) | live, and **at its ceiling** — peak `Memory at 2,029/2,200 chars`, and **6** writes refused with `would exceed the limit` |
| **2 — user profile** | `USER.md` profile block, same snapshot semantics | live |
| **3 — session history** | SessionDB (SQLite + FTS5), reached via `session_search` | live, **keyword-only**: 10 calls in 12 days |
| **4 — live semantic tier** | `memory.provider: supabase_pgvector` → `app_dev.memories`, `vector(256)`, HNSW `vector_cosine_ops` | **table and index exist; 28 rows; never read** |

Supporting facts, all verified on the box rather than assumed:

- Supabase stack: 11 containers up 3 weeks, `vector 0.8.2` installed, DB 16 MB, 1.4 GB on disk.
- `app_prod.interactions`: **2,459 rows** since Jul 22 (387/day), 2,452 from Telegram — the C8 action ledger is healthy and is the natural spine for ingestion.
- `app_dev.memories`: 28 rows, **all** `kind=intent_signal / topic=task_discovery`, **all** `owner_user_id=8756039695`, **all** `visibility=private:8756039695`.
- `memory_query` / `memory_write` are registered (`Memory provider 'supabase_pgvector' registered (2 tools)`) and appear **0 times** in the agent log. The tier is write-only in practice.
- `app_prod.principals` = 1 row (`leo_owner`), **`channel_identities` = 0**, `item_grants` = 0.
- Box: 4 vCPU, 14 GB RAM (≈10 GB available), **no GPU**.

## 2. Findings — the gaps this FG closes

**G1 — the embeddings are not semantic.** `plugins/memory/supabase_pgvector/embedding.py`
is a `HashingEmbedder`: sha256 per token into 256 dimensions, L2-normalised.
Cosine distance therefore measures **vocabulary overlap**, not meaning:
"when is the tender due" does not retrieve "招標截止日期", and does not even
retrieve "RFP deadline". This is deliberate — it is the credential-free default
so the provider works on a fresh box and its tests stay hermetic — and the
module's own docstring names the intended extension point ("a real embedding
model … can be dropped in later … selected from `config.yaml`"). That hook was
never built: `get_embedder()` returns `HashingEmbedder` unconditionally.

**G2 — nothing recalls.** Recall depends entirely on the model choosing to call
`memory_query`. It never has. The provider's `prefetch()` hook is the existing,
cache-safe seam for this: `agent/conversation_loop.py` wraps its output with
`build_memory_context_block()` and appends it to **the current turn's user
message at API-call time only** — the stored message is never mutated and the
system prompt is untouched. Today that hook returns only task-discovery
proposals. Automatic recall belongs there.

**G3 — the identity that access rights depend on is not wired up.** The
provider's `_resolve_principal()` never consults FG-01's `resolve_principal`
or the `principals` table; it falls back to the **gateway user id as
`role=member`**. Consequences, all observable in the data:

- Telegram sessions run as principal `8756039695`, role **member** — *not* owner.
  The "owner sees everything" property is never exercised on the channel that
  carries 99% of traffic.
- The dashboard runs as `leo_owner` (7 ledger rows). **One human, two
  principals, disjoint memory.** A fact learned on Telegram is invisible in the
  dashboard and vice versa.
- A second channel (WhatsApp, email) would mint a *third* identity with its own
  private tier.
- `channel_identities` is empty, so nothing maps a channel identity onto a
  system user — the table designed for exactly this is unused.

**Cross-user memory cannot be built on this.** G3 is the prerequisite, not a
detail.

**G4 — role elevation is all-or-nothing and unaudited.** In `hermes_cli/access.py`,
only `owner` bypasses scoping (`scope_filter` → `TRUE`); **`admin` has no
elevated read at all**. So "a higher-level user can read another user's memory
based on access right" today means *owner sees literally everything* or *nobody
sees anything* — and no record is kept of who read whose private memory.

**G5 — memories are not grant-scoped.** FG-19 built per-item grants
(`item_grants`, grant-aware `can_read` / `scope_filter` / RLS) for GTS items.
`PgvectorMemoryStore.query()` calls `scope_filter(principal)` **without**
`grant_item_kind`, so a memory cannot be shared with one named person the way a
goal can.

**G6 — no RAG corpus.** `memories` holds short single-text rows. There is no
document/chunk model, no ingestion, no chunking, no provenance, and no
citations — so "read that Drive spec and summarise section 3" still requires
you to name the file.

**G7 — no model/dim versioning.** The vector column is `vector(256)` with the
model implied. Changing embedder silently mixes two vector spaces in one
column, at which point cosine ranking is meaningless and the failure is
invisible. Migrating costs nothing today (28 rows) and grows with every row.

**G8 — layer 1 is full and there is no promotion path.** Layer 1 is at
1,864/2,200 chars and the agent is spending turns pruning it. With layer 4
readable, most of that content belongs there, with only durable identity-level
facts kept in the snapshot.

## 3. Target architecture

```
                    ┌─────────────────────────────────────────┐
   turn N  ─────────▶│ prefetch(query)  ── semantic recall     │──▶ <memory-context>
                     │   top-k, RLS-scoped, budgeted           │    appended to the
                     └─────────────────────────────────────────┘    USER turn (cache-safe)
                                    │
   mid-turn ──▶ memory_query / rag_search (tools, appended results)
                                    │
                     ┌──────────────▼───────────────────────────────────┐
                     │ Supabase Postgres (on-box)                        │
                     │  memories(embedding, owner_user_id, visibility)   │  layer 4
                     │  rag_documents / rag_chunks(embedding, source_ref)│  RAG
                     │  item_grants  · principals · channel_identities   │  access
                     │  FORCE'd RLS on every scoped table                │
                     └──────────────▲───────────────────────────────────┘
                                    │  embed(text) over loopback only
                     ┌──────────────┴───────────────┐
                     │ hermes-embed.service (local)  │  no egress, unprivileged
                     │ 127.0.0.1 · model pinned      │
                     └──────────────────────────────┘
```

Invariants that must survive every step below:

1. **Prompt caching is sacred.** Recall arrives as an appended `<memory-context>`
   block on the user turn or as tool results — never in the system prompt.
2. **RLS is the boundary, the app filter is the convenience.** Every new table
   gets `apply_scope_rls`, and every new read path that widens access must widen
   the RLS clause in the same commit (the FG-19 pattern).
3. **Fail closed.** An embedding service that is down must degrade to a
   keyword/hash fallback with a logged warning — never to "no rows found",
   which is indistinguishable from "nothing is known".
4. **Local only.** No text leaves the box to be embedded.

## 4. The embedding service (fixes G1, G7)

### 4.1 Model candidates (CPU-only, bilingual zh/en)

| Model | Params | Dim | Ctx | Notes |
|---|---|---|---|---|
| `multilingual-e5-small` | 118M | 384 | 512 | fastest; weakest on long zh passages |
| `multilingual-e5-base` | 278M | 768 | 512 | good middle; solid zh |
| **`bge-m3`** | 568M | 1024 | 8192 | strongest zh/en of the three, long context, ~2.3 GB resident |
| `Qwen3-Embedding-0.6B` | 600M | 1024 (MRL-truncatable) | 32k | strong multilingual, same vendor family as the current LLM |

**Recommendation: `bge-m3`, subject to measurement.** Long context matters for
RAG chunks and the corpus is bilingual tender/RFP material. But CPU latency on
4 shared vCPUs is the deciding number and I have not measured it yet — so step
P1 is a benchmark on the box (throughput at 512-token chunks, resident memory,
p95 latency for a single query embed) across `bge-m3` and
`multilingual-e5-base`, with the probe set from §7. Pick on the numbers, record
them in this doc's audit log.

### 4.2 Serving

A dedicated **`hermes-embed.service`** bound to `127.0.0.1`, unprivileged,
`NoNewPrivileges`, no egress after model download, `MemoryMax` set so it can
never squeeze the 11 Hermes services. Two viable shapes:

- **Text-Embeddings-Inference container** (CPU image) — same lifecycle as the
  Supabase stack, no new Python deps in the Hermes venv. Preferred.
- **`sentence-transformers` in a small FastAPI app** — fewer moving parts,
  heavier venv, in-process option useful for tests.

The model is pulled once and cached under `/opt/data/`, pinned by revision, and
the unit + revision are captured by `deploy_state.py` so a rebuilt box gets the
same model (the deployment-path work already covers units and manifests).

### 4.3 Config surface (no new env vars — `config.yaml` only)

```yaml
memory:
  provider: supabase_pgvector
  embedding:
    provider: local_http        # local_http | hashing (offline default)
    endpoint: http://127.0.0.1:8791
    model: BAAI/bge-m3
    dim: 1024
    timeout_seconds: 20
    batch_size: 16
```

`hashing` stays the default when nothing is configured, so a fresh clone and
the hermetic test suite behave exactly as they do today.

### 4.4 Model/dim versioning and migration (G7)

- Add `embedding_model TEXT NOT NULL` and `embedding_dim INT NOT NULL` to every
  embedded table; **never** mix models in one ranking. Queries filter on the
  active model, so a model switch degrades to "no rows for this model yet"
  (visible, loud) instead of silently wrong ranking.
- Column type moves `vector(256)` → `vector(<dim>)` in a migration that
  re-embeds existing rows; HNSW index rebuilt per active model.
- A `hermes memory reembed` CLI command does the backfill in batches, resumable,
  reporting progress — the same command used for a future model change.
- The 28 existing rows are `intent_signal` captures with no durable value; they
  are re-embedded rather than discarded so the path is exercised on real rows.

## 5. Layer 4 becomes a memory layer (fixes G2, G8)

1. **Automatic recall in `prefetch()`**: embed the incoming user message,
   `top_k` (default 5) RLS-scoped nearest neighbours above a similarity floor,
   rendered into the existing `<memory-context>` wrapper with a hard character
   budget (default 1,200) and one line per fact including its owner when the
   fact is not the caller's own. Cache-safety is asserted by test, not assumed.
2. **`memory_write` gains automatic capture**: end-of-turn extraction of durable
   facts (via the existing `on_session_end` / `on_pre_compress` hooks) instead of
   only the model's explicit writes, with dedup by cosine similarity ≥ 0.95
   against the same owner's existing rows.
3. **Decay and usefulness**: `uses` / `last_used` are already columns and are
   never updated — increment them on recall, and rank by
   `similarity × recency × log(1+uses)` so stale one-offs sink.
4. **Promotion / demotion between layers** (relieves G8): a scheduled review
   promotes a high-`uses`, high-similarity, owner-approved fact into layer 1 and
   demotes layer-1 lines that layer 4 already covers. Layer 1 stops being a
   manually-pruned 2,200-char budget and becomes the small durable core.

## 6. Shared recall across users (fixes G3, G4, G5)

This is the part Leo called out as most important, and it is mostly *access
work*, not vector work.

### 6.1 P0 — make identity real (G3) — **delivered**

The root cause turned out to be narrower than "resolution is unwired", and
worth recording because it will recur for every user Leo adds:

- `resolve_principal()` **does** consult `channel_identities`; it auto-enrols
  only senders the *pairing* store approved. Leo reaches the gateway through
  `telegram.allow_from`, which authorises without pairing — so he was
  authorised, never enrolled, and `channel_identities` stayed empty. Authz and
  identity are two different gates and only one of them was passed.
- The role never travelled even when a principal *was* resolved: the seam
  stamped `internal_user_id` only, and `agent_init` then hardcoded
  `principal_role="member"`. So enrolment alone could not have produced an
  owner-level session.

What landed:

- `hermes member link-channel <user_id> <platform> <channel_user_id>` — the
  owner/admin surface that states "this handle is this principal", covering
  allow-listed users that pairing never touches. Deliberately GoTrue-free
  (linking is a principal operation, so it must work with no dashboard auth
  configured), refuses an unenrolled `user_id` rather than minting one, and
  validates the platform against the gateway's own enum so a link can't be
  stored in a form intake would never match. `hermes member list` now prints
  each member's linked channels, so an unlinked member is visible.
- `bind_channel_principal` stamps `internal_user_role` from the `principals`
  row alongside `internal_user_id`, and it is threaded
  `InboundEvent → SessionSource → init_agent → memory provider`. Unresolved
  degrades to `member` via `normalize_role()`; nothing is elevated by failure.
- The role is **excluded from session persistence** (`to_dict`/`from_dict`),
  like `delivered_via_upstream_relay`: it decides what a session may read of
  other users' data, so it is re-read from the database every turn rather than
  replayed from a file that could be stale or edited.
- Role management itself needed nothing new: `hermes member add/set-role/...`
  and the owner/admin-gated `/api/comms/members` API already existed.

Still open in P0's scope: the 28 existing rows still carry
`owner_user_id=8756039695`. Linking the channel makes *new* rows land on
`leo_owner`, which splits the history rather than joining it, so the migration
is a deliberate, separately-verified data change — not a side effect of a code
deploy.

### 6.2 Access model for memory (G4, G5)

Keep C2 exactly as it is and extend it in the two ways it was designed to be
extended:

| Need | Mechanism | New? |
|---|---|---|
| my own memory | `visibility = private:<uid>` | no |
| instance-wide knowledge | `visibility = shared` | no |
| owner reads anyone | `principal.is_owner` bypass | no |
| **admin reads a member's memory** | **role-scoped elevation, downward only**: `scope_filter` gains a rung comparison over `owner > admin > member > viewer`, mirrored in RLS | **yes** |
| **one named person reads one memory** | `item_grants(item_kind='memory')` + `grant_item_kind='memory'` on the memory read paths | **yes** (reuses FG-19) |
| **a team shares a tier** | `visibility = team:<team_id>` + `team_members` | **not wanted** — the role ladder covers it (§10.5) |

Non-negotiables:

- **Every cross-principal read is audited.** A new C8 interaction kind
  (`memory_read_elevated`) records reader, owner, memory ids, and the query that
  surfaced them. Unaudited owner-bypass is the current behaviour and is not
  acceptable in a multi-user instance — if the owner can read a member's private
  memory, the member must be able to see that it happened.
- **Reads go down the ladder only, never sideways.** An admin reads members and
  viewers; an admin does **not** read another admin. Peer-level reads are the
  difference between a hierarchy and a free-for-all, and are not granted by
  role (an explicit `item_grants` row remains the way to share with a peer).
- **One person belongs to one role, and memory is one pool per person** keyed on
  `owner_user_id`. A Hermes profile is the *role's* shared configuration
  (layers 1–2: `MEMORY.md` / `USER.md`); layer 4 is the person. Several people
  on one profile therefore share behaviour and keep separate private memory —
  and no one's private memory sits in a profile file the whole role reads.
- **Elevation is opt-in per instance** and defaults off, so a single-user
  deployment behaves exactly as today.
- **RLS mirrors every widening** in the same commit, with a negative test per
  path (member cannot read another member; admin can only when elevation is
  enabled; grantee sees only the granted row and none of the owner's others).
- Recall output **labels provenance** when a fact is not the caller's own
  ("from <user>'s memory") — a shared brain that silently blends other people's
  facts into an answer is a privacy problem *and* a correctness problem.

## 7. RAG (fixes G6)

### 7.1 Data model

```sql
CREATE TABLE rag_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    visibility     TEXT NOT NULL,          -- C2, inherited by every chunk
    source_kind    TEXT NOT NULL,          -- gdrive | gdoc | email | whatsapp | session | file | skill
    source_ref     TEXT NOT NULL,          -- stable id (Drive file id, message id, session key)
    title          TEXT NOT NULL DEFAULT '',
    content_hash   TEXT NOT NULL,          -- re-ingest only when it changes
    ingested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_kind, source_ref, owner_user_id)
);

CREATE TABLE rag_chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL,           -- denormalised for RLS
    visibility    TEXT NOT NULL,
    ordinal       INT  NOT NULL,
    text          TEXT NOT NULL,
    embedding     vector(<dim>) NOT NULL,
    embedding_model TEXT NOT NULL,
    token_count   INT NOT NULL,
    section       TEXT,                    -- heading path, for citations
    UNIQUE (document_id, ordinal)
);
```

RLS on both, by the same C2 predicate as `memories`, plus the grant clause.
Deleting a document cascades its chunks and its right to be recalled.

### 7.2 Ingestion

- **Sources, in the order they pay off**: (1) Google Drive/Docs the agent can
  already read — the tender/RFP corpus; (2) session transcripts from SessionDB;
  (3) the `app_prod.interactions` ledger summaries; (4) email; (5) WhatsApp
  archives.
- **Chunking**: heading-aware, ~512 tokens with ~64 overlap, keeping the heading
  path in `section` so a citation reads `Indy Project Proposal › 3. Scope`.
- **Incremental**: `content_hash` gates re-embedding; a nightly systemd timer
  (same shape as the existing backup/drift timers) re-scans and re-embeds only
  what changed.
- **Access inheritance**: a document ingested from a user's Drive is
  `private:<that user>` unless explicitly shared. Ingestion must never launder a
  private document into `shared`.
- **Approval boundary preserved**: ingestion reads Drive through the same
  approval-gated Workspace tools; a scheduled ingest runs under the documented
  cron approval mode, never by bypassing the gate.

### 7.3 Retrieval

- **Hybrid**: vector (`<=>` on HNSW) + lexical (`pg_trgm` / FTS) with
  reciprocal-rank fusion. Pure vector loses exact identifiers ("Tender
  2026-0418"); pure lexical loses paraphrase and cross-language. Both are
  cheap here.
- One new tool, `rag_search`, returning text + document title + section +
  score, so the model can cite. Results are appended messages (cache-safe).
  It is a **provider tool** (like `memory_query`), not a new core tool — the
  footprint ladder rung for this is "extend the existing provider".
- **Answer-with-citations** is the acceptance target: the answer names the
  document and section, and a wrong citation is a test failure.

### 7.4 Recall quality probes (the measurable acceptance gate)

A fixed bilingual probe set committed with the code, each probe naming the row
or chunk that *must* be in the top-3:

| Query | Must retrieve | Fails today because |
|---|---|---|
| "when is the next tender due" | the 招標 deadline chunk | no shared vocabulary |
| "投標文件要求" | the RFP requirements section | different language |
| "Tender 2026-0418" | that exact document | vector-only misses ids → hybrid |
| "what did Leo decide about backups" | the age/backup decision memory | not ingested yet |
| a member querying another member's private note | **nothing** | negative access |

Report `recall@3` before and after. "It feels better" is not a result.

### 7.5 P1 benchmark result (measured on the box, 2026-08-04)

`ecs.e-c1m4.xlarge`, 4 vCPU shared with the gateway and Supabase, CPU only. One
process per model so RSS is that model's own footprint.

```
model                          dim  load_s  RSS_MB  1x_p50  1x_p95  16x_ms  R@1   R@3
hashing (incumbent)            256     0.0       0    0.04    0.26     0.5  .167  .667
BAAI/bge-m3                   1024     9.8    1577  296.71  408.61  1421.3  1.0   1.0
intfloat/multilingual-e5-base   768     9.7     742   78.22   83.48   466.6  1.0   1.0
```

Two results matter more than the ranking:

**1. The incumbent is worse than "not semantic" — for Chinese it does not rank at
all.** Both Chinese probes embed to the **zero vector** (the tokenizer is
`[a-z0-9]+`), so every cosine distance is 0.0 and the "nearest neighbours" are
whatever order the rows came back in. The original plan's recall@3 of 0.667 was
flattering an artifact; scoring recall@1 and flagging degenerate queries is what
exposed it. `R@1 = 0.167` is the honest number.

**2. Recall did not decide the model — input window did.** Both candidates scored
1.0 on the bilingual set (10 documents is too easy to separate them), so a second
probe put the answer at the end of an ~11,900-character document, against a decoy
document and a padding-only document:

```
query: "when is the tender submission deadline"

BAAI/bge-m3         (window 8192)        e5-base          (window 512)
  0.7186  fact at the START                0.9150  fact at the START
  0.5645  fact at the END    <-- found     0.7824  padding only
  0.4817  decoy fact at the END            0.7824  fact at the END
  0.4765  padding only                     0.7824  decoy fact at the END
```

e5-base's last three scores are **identical to four decimals**: it never read past
512 tokens, so a document containing the answer and one containing only
boilerplate are the same vector to it. For all-of-Drive RAG that is a correctness
limit, not a slowdown — the answer becomes unretrievable.

**Selected: `bge-m3`**, pinned at revision `5617a9f61b028005a4858fdac845db406aefb181`.
The cost is stated rather than buried: ~300 ms per single embed against ~78 ms,
and 2.0 GB resident against 0.9 GB. Sub-512-token chunking would let e5-base
compete, but it would make chunk-boundary placement load-bearing for
correctness, and boundaries are what ingestion pipelines get wrong.

Operational verification on the box, running as `hermes` against the committed
server code: `/health` reports the pinned revision; two bilingual texts return
1,024-dim L2-normalised vectors in 0.42 s; a request naming a *different* model
is refused with 409 and nothing is embedded; the listener is `127.0.0.1:8791`
only.

## 8. Work breakdown (each phase is a PR)

| # | Phase | Contents | Gate |
|---|---|---|---|
| **P0** | Identity is real — **done** | `hermes member link-channel`; role stamped by `bind_channel_principal` and threaded to the memory provider; role never persisted | one human = one principal across channels; unresolved → `member`; negative-access tests unchanged |
| **P0b** | Existing rows — **done** | 28 rows migrated `8756039695` → `leo_owner`; `telegram:8756039695` linked; pre-migration `pg_dump` kept and restore-verified into a scratch schema first | embeddings byte-identical to the pre-migration copy; 0 rows left behind; unlinked sender still resolves to nothing |
| **P1** | Embedding service — **done, numbers in §7.5** | `scripts/embedding_server.py` + tracked `deploy/hermes-embed.service` (loopback, unprivileged, revision-pinned); `local_http` embedder behind `memory.embedding.*`; hashing stays default | benchmark recorded; wrong-model and wrong-width requests refused, not stored |
| **P2** | Semantic layer 4 — **done, §8.1** | `embedding_model` per row; mismatch refused at startup; `hermes memory vectors status/reembed` (one transaction, index rebuilt); automatic recall in `prefetch()` with budget; `uses`/`last_used`; opt-in dedup | cross-model rows excluded from recall, not ranked; failed re-embed leaves the old space intact; prompt-prefix byte-stability test green |
| **P3** | Shared recall — **done, §8.2** | role-scoped downward elevation (`memory.sharing.role_reads`, default off) + matching RLS; `item_grants` extended with a `memory` kind; provenance labels; audit ledger readable by reader *and* subject; `hermes memory sharing audit/share` | full negative-access matrix (member/member, admin/admin, admin→member off and on, grantee, unbound elevation) asserted at the **RLS** level as well as the app level |
| **P4** | RAG — **storage, retrieval and Drive ingestion done, §8.3** | `rag_documents` / `rag_chunks` + RLS; heading-aware chunking; hybrid vector+lexical retrieval with citations; all-of-Drive ingestion (staged, nightly timer); `rag_search` tool; `hermes memory rag` | answer-with-citation; no private→shared laundering (test); session/interaction ingestion still open |
| **P5** | Consolidation | layer-1 promotion/demotion; email/WhatsApp ingestion (teams dropped — §10.5) | layer 1 back under budget without losing facts |

Nothing here needs a new core tool, a new `HERMES_*` env var for behaviour, or a
change to the frozen-snapshot semantics.

### 8.1 P2 as built

Three decisions here were not obvious from the plan and are worth recording,
because each one exists to prevent an *invisible* failure:

1. **Provenance is per row, and mismatches are refused rather than ranked.**
   Cosine distance between two models' vectors is a well-formed number with no
   meaning, so a mixed column returns plausible rows in a meaningless order and
   looks entirely healthy. Recall therefore filters on `embedding_model`, and a
   *dimension* change refuses at `initialize()` with the remedy in the message —
   the alternative was an asyncpg type error on every write, which names the
   symptom and not the cause. Rows written before the column existed are
   backfilled as `hashing`, which is a statement of fact: that is what embedded
   them.

2. **The re-embed is one transaction, and embedding happens outside it.**
   All-or-nothing, because a half-migrated column is the exact state this phase
   exists to prevent; and embedded up-front, because holding a write transaction
   open across minutes of CPU at ~300 ms per row would block live sessions
   behind the migration. pgvector cannot widen `vector(N)` in place, so the
   column is replaced and the HNSW index rebuilt — without that rebuild, recall
   silently degrades to a sequential scan.

3. **Dedup is opt-in per write, not global.** This was found by a failing test,
   not by design: task discovery decides a standing request is a task by
   *counting how often the same intent recurs*, so collapsing identical rows
   made a request the user repeated three times never cross its threshold. An
   improvement to one writer had quietly disabled a different feature. Only
   callers that pass a threshold (the `memory_write` tool, at 0.97) get dedup,
   and dedup is per owner — two people knowing the same fact is two memories.

Automatic recall is budgeted (`top_k`, `min_score`, `max_chars`, plus a minimum
query length so "ok" does not spend a search) and reaches the model through the
existing `prefetch()` seam, which `conversation_loop.py` appends to the current
user message at API-call time from a copy. The cached prefix and the stored
conversation are untouched.

`min_score` is load-bearing rather than cosmetic: an HNSW search always returns
`top_k` rows, so without a floor every turn recalls its least-unrelated
memories. On the current hashing vectors an unrelated question still scores
~0.2 on an incidental shared token.

Still true after P2: the live column is **256-dim hashing**. Cutover is a
deliberate two-step act on the box — edit `memory.embedding`, then
`hermes memory vectors reembed` — and until it is run, `local_http` is
configured-but-not-cut-over.

### 8.2 P3 as built

The decision was **read down only** (§10.2) and **one person = one role** (§10.5),
so the whole access rule is a rank comparison: `owner > admin > member > viewer`,
readable strictly downward. What that left to design was everything around it.

1. **The subject's role is looked up, never carried on the row.** The elevated
   clause is a correlated `EXISTS` against `principals`, in both the app filter
   and the policy. Copying a role onto each memory would be faster and wrong: a
   demotion has to take effect on the next read, not on rows written afterwards.
   An owner nobody enrolled ranks *last*, so an unknown role can be read and
   cannot read — the same `ELSE` branch in SQL as in Python, asserted against a
   real Postgres so the two cannot drift.

2. **Two independent gates, and the second is per transaction.** Installing the
   policy grants nobody anything: the elevated branch is dead unless
   `hermes.elevated_reads` is bound `on` for that transaction, by the one code
   path that also writes the audit row. A path that forgets the binding
   *under*-reads. A GUC bound on an instance where `role_reads` is off does
   nothing at all, because the branch was never compiled into the policy.

3. **The audit is visible to the person who was read.** `memory_access_audit`
   records reader, role, subject, row ids, the (truncated) query and the session,
   is written in the *same transaction* as the read, and its own policy admits
   the owner, the reader, or the subject. `hermes memory sharing --as <user>
   audit` shows both directions. This also closes a pre-P3 gap: the owner-role
   bypass previously read every private row and left no trace, which is
   tolerable with one user and not with several.

4. **Provenance, so a fact is never mis-attributed.** An elevated row recalls as
   `(topic, from mia's memory) …`. Without the label the model reads another
   person's private fact as if the user in front of it had said so.

5. **Sideways sharing is an act, not a rank.** `item_grants` gained a `memory`
   kind, so one person can share exactly one row with a peer the ladder does not
   reach — revocably, and without touching the row's `private:` tag. Only the
   *owner of the row* may share it: an elevated reader who could re-share would
   turn a scoped read into redistribution the subject cannot take back.

One latent bug surfaced while wiring the grant clause and is fixed for the GTS
callers too: `item_grants` has its own `id` column, so an unqualified
`id_column` bound to *that* one, making the sub-select always false — a grant
that silently conferred nothing, with no error anywhere. `scope_filter` now
refuses an unqualified `id_column`.

Still off by default. Enabling it on the box is a config change plus a review,
and it is worth noting the ladder is currently a hierarchy of one: `leo_owner`
is the only enrolled principal, so nothing changes behaviourally until a second
person is enrolled.

### 8.3 P4 as built

Storage, retrieval and Drive ingestion. Session-transcript and interaction-ledger
ingestion are deliberately *not* in this phase — the Drive corpus is what makes
retrieval useful today, and each new source is its own extraction and retention
question.

1. **Documents inherit nothing from the account that could see them.** A file
   merely shared *with* a Google account is not a file the instance may read, so
   ingestion writes `private:<ingesting principal>` and there is no
   “ingest as shared” switch. Access afterwards is memory's access, exactly:
   downward role read, or an explicit per-document grant. `item_grants` gained a
   `document` kind for the sideways case, and the CHECK constraint is replaced on
   every `initialize()` so a deployment created before the kind existed widens
   rather than rejecting.

2. **A grant on a document reaches its chunks, and only its chunks.** The chunk
   policy correlates the grant sub-select on `document_id` rather than on the
   chunk's own id — without that, sharing a document would confer access to
   nothing (its chunks are not the granted row) and the failure would be silent.
   Asserted at the RLS level under a `NOBYPASSRLS` role, not just through the app
   filter.

3. **The lexical arm indexes title + heading path + body, not body alone.** A
   tender number lives in the *title*; a lexical arm over body text therefore
   could not find a document by its own identifier — precisely the case the arm
   exists for. The `tsvector` is computed at insert time and stored, so the GIN
   index serves the query instead of every row being re-tokenised per search.
   `'simple'`, not `'english'`: the corpus is bilingual and a stemmer mangles
   identifiers.

4. **The vector arm has a similarity floor; the lexical arm needs none.** An HNSW
   search always returns its `LIMIT`, so without a floor every question retrieves
   its least-unrelated passages and the model is handed irrelevant text as
   evidence — the same lesson as automatic recall in P2. A `tsquery` either
   matches or does not. The floor comes from config, never from the model: a floor
   the model can set is a floor it will set to zero when it wants more results.

5. **Chunking is heading-aware and multilingual.** ~512-token chunks with ~64
   tokens of sentence-boundary overlap, never spanning a heading, with the heading
   path kept as the citation (`Tender 2026-0418 › 2. Submission`). Token
   estimation counts CJK characters as ~1 token and Latin text as ~1 per 4
   characters, because a character-count budget silently produces 3× oversized
   chunks for Chinese.

6. **Ingestion is bounded, resumable, and honest about what it cannot read.**
   `--limit` counts documents ingested or confirmed unchanged — not files listed,
   so a folder of photographs cannot consume a run's budget. Unchanged content is
   detected by hash and costs nothing, so a nightly pass that has caught up is
   nearly free and an interrupted run resumes. A model change counts as a content
   change, because vectors are only comparable within one model. PDFs and images
   are skipped and counted, rather than stored as decoded bytes: a chunk of
   mojibake still retrieves, and a citation to garbage is worse than none.

7. **“All of Drive” is three flags, and two of them are the ones people miss.**
   `includeItemsFromAllDrives`, `supportsAllDrives` and `corpora=allDrives`;
   without them Drive returns only files the account *owns*, which looks like a
   working ingestion. Accounts are discovered from the Workspace MCP credential
   directory rather than config, so connecting an account is completing consent,
   and naming an account with no credential file is an error rather than a silent
   no-op. The Drive client is stdlib-only: `hermes-agent[google]` is an optional
   extra, and a nightly timer should not fail on a box where it was never
   installed.

8. **`rag_search` is off by default.** Enabling it adds a tool schema to every API
   call for the life of a conversation; on an empty corpus it can only answer
   “nothing found”. Ingest first, then set `memory.rag.enabled`.

Operational detail is in `docs/deployment/rag-ingestion.md`; the units are tracked
at `deploy/hermes-rag-ingest.{service,timer}` so drift shows up in the weekly
check.

## 9. Operational plan

- **Resources**: 4 vCPU / ~10 GB free today, of which the embedding service
  takes **2.0 GB** resident for `bge-m3` (measured, not estimated). `MemoryMax` on the unit; ingestion runs
  `nice`d off-peak so a backfill can never starve the gateway.
- **Storage**: 1,024 dims ≈ 4 KB/vector. 100k chunks ≈ 400 MB + index — trivial
  against 83 GB free.
- **Backups**: vectors are regenerable and are **excluded** from the encrypted
  credential bundle; the source documents and the `memories` rows are what
  matter. Add a `pg_dump` of the `app_*` schemas to the daily job — today the
  bundle covers credentials only, so **the memory rows themselves are in no
  backup**.
- **Deployment path**: new unit + config keys captured by `deploy_state.py`
  (`capture` → PR → merge), so a rebuilt box brings the embedding service and
  the model pin back with it. Weekly drift check covers them automatically.
- **Security**: service is loopback-only and unprivileged; model files are
  root-owned and read-only to the service; no egress after the pull; nothing
  new is exposed to the agent's shell.

## 10. Open decisions for the owner

All five are **decided** (Leo, 2026-08-04):

1. **Model** — **resolved: `bge-m3`** (§7.5). It cleared the latency bar at
   ~300 ms per single embed, and the long-document probe showed
   `multilingual-e5-base` cannot see past 512 tokens — for RAG that is a
   correctness limit, not a slower answer.
2. **Elevation policy** — **by role**, not grant-only. Downward only: a role
   reads every rung below it and never its peers. `item_grants` stays for
   sharing sideways or with one named person.
3. **Audit visibility** — **yes**. A member can see that a higher-privilege
   principal read their private memory, which makes the `memory_read_elevated`
   audit load-bearing rather than decorative.
4. **Ingestion scope for P4** — **all of Drive**, both accounts, including
   "Shared with me". Staged newest-first so current tenders are searchable
   before the backfill completes, and every chunk keeps its Drive file id so a
   folder can be un-indexed with one delete.
5. **Teams** — **not needed**. The role ladder covers the hierarchy; `team:<id>`
   is dropped from P5 rather than deferred.

## 11. Testing requirements

- **Invariants, not snapshots**: assert that a private row is unreadable by a
  non-grantee *through RLS on a real Postgres*, not that a helper returns a
  fixed string.
- **Cache-safety**: system-prompt prefix byte-stable across a turn that recalls
  and a turn that ingests.
- **Concurrency**: N writers + readers across `(user, task)` sessions; no lost
  writes, no cross-session bleed (extends the existing FG-05 concurrency test).
- **Negative access matrix**: member↛member, admin↛member with elevation off,
  admin→member with elevation on, grantee→one row only, owner→all with audit row
  written.
- **Degradation**: embedding service down → logged fallback, not silent empty
  recall.
- **Recall quality**: the §7.4 probe set, with `recall@3` reported in CI output.
- **Real E2E** for every access/datastore change, per `AGENTS.md`.

## 12. Dependencies

- **Builds on**: FG-01 (C1/C2 identity + roles), FG-05 (the pgvector tier being
  extended), FG-13 (C3 dev/prod routing), FG-19 (per-item grants + grant-aware
  RLS), FG-16 (C8 audit ledger).
- **Unblocks**: retrieval-grounded answers for FG-09/FG-18 (goal/task context),
  and the mobile face in FG-20 showing "what the agent knows about me".
- **Note**: FG-05's own ECS system-test checklist is still open; P2 here
  subsumes and completes it.

## Audit log

| Date | Edition | Author | Change | Rationale |
|------|---------|--------|--------|-----------|
| 2026-08-04 | 2 | devin | Folded in Leo's five decisions (local model on measured numbers; elevation **by role, downward only**; audit visible to the member; **all of Drive** incl. Shared-with-me; **no teams** — one person, one role, one memory pool, profile = role config) and recorded the delivered P0: the identity split was `telegram.allow_from` authorising without pairing (so enrolment never happened) *plus* a hardcoded `principal_role="member"` that discarded the role even when it did | Leo answered §10 and asked for the role model to be the basis of cross-user memory; P0 shipped as `hermes member link-channel` + role propagation |
| 2026-08-04 | 1 | devin | Created FG-21 from a live survey of `hermes-systest`: measured the pgvector tier (28 rows, hashing embeddings, 0 reads), the identity split (Telegram `8756039695` as `member` vs `leo_owner`, `channel_identities` empty), and the absent RAG corpus; planned local semantic embeddings, layer-4 recall, cross-user shared recall with audited elevation, and RAG | Leo: local embeddings, must be semantic, use as the 4th memory layer, support RAG, and share memory across users of one instance with higher-privilege access by right |
