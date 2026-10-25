# Hermes / ai-prentice-4-all — Master Implementation Plan

> **Status:** PLAN. This document + the per-feature-group
> docs under [`feature-groups/`](./feature-groups/) are the single source of
> truth for the multi-phase build-out — **Phase 1: FG-01–13** (multi-user,
> multi-channel one-brain; largely built + system-tested) and **Phase 2:
> FG-14–19** (requirements 14.0–19.0: Core/Customizable boundary, easy
> onboarding, action tracking, Next.js dashboard, GTS Centre, per-user GTS +
> assignment). Baseline regression tests live in `tests/plan_baseline/`.
>
> **Scope:** turn the single-owner personal Hermes deployment (ai-prentice-4-all) into
> a **multi-user, multi-channel, self-improving agent platform** for an
> organisation (school / company), while respecting the existing architecture's
> hard constraints (prompt-cache safety, one-brain, footprint ladder).

---

## 0. How to read / maintain this plan

- **This README** = cross-cutting decisions, principles, dependency waves,
  parallelisation, testing strategy, governance, and the **edition/audit log**.
- **`feature-groups/FG-XX-*.md`** = one doc per feature group. Each is
  self-contained: reuse map, design, data model, dev/prod + Supabase notes,
  testing requirements, dependencies, wave, definition-of-done, a live
  **progress checklist**, a **per-FG audit log**, and a **ready-to-paste Devin
  cloud-agent prompt**.
- **`agent-prompts.md`** = all cloud-agent prompts in one place.

### Governance / edition tracking (IMPORTANT for parallel agents)
- The **master plan changelog** (§9) is *append-only*. Any change to
  cross-cutting scope, decisions, waves, or contracts adds a row — never
  rewrites history.
- Each feature-group agent edits **only its own `FG-XX-*.md`** (its progress
  checklist + its own audit log). It must **not** edit other FG docs or the
  master changelog except to append one row to §9 when it changes a shared
  contract.
- Every audit entry uses this format:
  `YYYY-MM-DD | edition | author (user / devin:<session>) | FG | change | rationale`.
- Editions are integer, monotonically increasing per document.

---

## 1. Locked decisions (from Leo, this planning session)

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | **Multi-user, NOT multi-tenant.** One shared brain; three-tier visibility: **shared** org knowledge, **per-user private** memory/skills, **owner** sees everything. | Every memory/skill/goal/task/tool/asset row carries `owner` + `visibility` (`shared` \| `private:<user_id>`); reads filtered by requesting principal; owner bypasses. Ownership is transferable (approval-gated). |
| D2 | **Memory consistency = HYBRID.** | Curated durable facts → frozen `MEMORY.md`/`USER.md` snapshot in the prompt (cache-safe). Volatile/coordination state + embeddings → live **queryable store** read/written mid-turn **via a tool call** (never prompt injection). |
| D3 | **OSS integration has two modes.** | **Remote system**: study OSS, clone + host on a *different* machine with minimal/no changes, expose via MCP (≈ design-doc §4.3). **In-house system**: build a *new* tool on the ai-prentice-4-all box, default **Next.js, one Node process per tool**, with **two interfaces: web UI (human) + MCP (agent)**. |
| D4 | **Datastore = bounded hybrid.** | **SQLite** stays for the Hermes *agent core* (SessionDB, kanban, projects, checkpoint, frozen memory files). **Self-hosted Supabase (Postgres + pgvector + GoTrue + Realtime + Storage)** is the datastore for the **new multi-user application layer** (identity/access, embeddings, goals/tasks/tools/change-log, in-house-tool data). |
| D5 | **Dev vs Prod.** | User-developed tools/skills/config start in **dev** (dev DB), promoted to **prod** on confirmation. Provide a **dev Supabase database/schema**. **Incoming channels are PROD-ONLY** (no dev channels). |
| D6 | **Blockchain (2.0) is opt-in + gated.** | DID:ION per user (hosted resolver first); ERC-721 mint per digital asset is the **explicit exception to undo** — **irreversible, must be user-triggered AND user-approved** (agent may never mint autonomously). Ship as plugin + MCP, testnet-first. |
| D7 | **`session_key` gains dimensions.** | `session_key = f(channel identity, account_id, internal user, task)` to maximise prompt-cache locality and isolate `(user, task)` cores. Extends `SessionSource` (adds `account_id`) + the key builder. |
| D8 | **Infra.** | Migrate the ai-prentice-4-all ECS to **`ecs.e-c1m4.xlarge` (4 vCPU / 16 GB)** first, **dedicated ESSD data disk** for Supabase, **EIP** for a stable IP; **in-place resize to `ecs.e-c1m4.2xlarge` (8/32)** when needed (same-family resize, ~5 min stop/start, no data migration). |
| D9 | **Delivery = parallel Devin cloud agents**, one per FG, coordinated in **dependency waves**. Shared contracts merge first (Wave 0). | See §5, §6. |

### Phase-2 locked decisions (reqs 14.0–19.0, from Leo, 2026-07-12)

| # | Decision | Consequence |
|---|----------|-------------|
| D10 | **Core is immutable to the runtime agent AND to end users; only human devs change Core (via repo/PR).** | A repo-committed `core_manifest.yaml` + a **hard runtime write-guard** at the agent's file/terminal chokepoint refuses any agent write to a Core path (fail-closed, no user/config override). Prevents a user from talking the LLM into breaking the system. Everything else (plugins/skills/tools/behavioural `config.yaml`/`app_*` data) is **Customizable** and change-tracked (C5). Publishes **C7**. (FG-14) |
| D11 | **Every interaction is traceable end-to-end via one `trace_id`; the trace is observability-only (cache-safe), RLS-scoped, retention-capped.** | Append-only `interactions` ledger joins inbound→turn→tool→outbound + linked change/cost/approval on one id; **never** injected into the prompt; user sees own, owner sees all; retention/rollup bounds growth. Extends C5 + cost tracking; publishes **C8**. (FG-16) |
| D12 | **Dashboard standardizes on Next.js (App Router) — frontend-only migration over the existing Python API backend.** All new in-house tools stay **Next.js + Node** (D3). | Port `web/` Vite→Next.js feature-for-feature against the unchanged `/api/*` backend (re-run FG-07/10 acceptance). Dashboard = the system "face": Core-area view, embedded Telegram chat, agent webview, tool link/icons. Dashboard + backend are Core (C7). (FG-17) |
| D13 | **Telegram is both a native channel (app) and the dashboard-embedded conversational UI**; both hit the same FG-03 one-brain backend. WhatsApp/email/other channels stay live. | Embedded web-Telegram (or a dashboard-native chat bound to the same bot/session) routes through the same gateway/session as the Telegram app. (FG-17) |
| D14 | **GTS Centre is a Core tool** unifying goals/tasks/skills; its implementation + governing rules are immutable to user/agent (only data is mutable, within its authority rules). | Extends FG-04 goals + FG-06 tasks + skills (no new store): **M:N** task↔goals & skill↔tasks, **hierarchical** goals/tasks with priorities, **user-only** top-level goals + evaluation methods, **agent** sub-goals/tasks, **auto-computed score 0–100** with priority-weighted rollup. Publishes **C9**. (FG-18) |
| D15 | **GTS is per-user isolated; owner sees all; cross-user assignment is a per-item grant (single assignee + optional watchers).** | An assigned item stays private to its creator but the assignee gets scoped access to *that item only* (no leak of the owner's other private GTS). Extends C2 with per-row grants + RLS; top-level goals not assignable; assignee can advance progress but not change eval method/reassign/delete; full C5/C8 audit. (FG-19) |

### Phase-3 locked decisions (from Leo, 2026-07-11)

| # | Decision | Consequence |
|---|----------|-------------|
| D16 | **`agent-home` — a new, mobile-first Next.js app — becomes the user-facing face; the system is a fixed three-tier stack: Next.js UI + Python AI layer (API) + Supabase (storage/DB).** All Phase-2 features move into it; the existing `web/` becomes the operator/admin console. | New `agent-home/` (App Router, mobile-first, PWA) via a **BFF pattern**: the `agent-home` server holds the C1 principal context, proxies agent/authority ops to the Python `/api/*` (one-brain chat, CDP webview, GTS authority, readiness, Core manifest, tool promote), and does **server-side** Supabase reads with the principal's RLS context (+ RLS-scoped Realtime). Browser never gets a privileged Supabase key or bypasses C1/C2/C6/C8. `agent-home` is **Core (C7)**. No new contract — a new surface over C1/C2/C3/C5/C6/C7/C8/C9. (FG-20) |
| D20 | **`agent-home` is THE key and main UI of the product — the dashboard (`web/`) is not.** Unless a request explicitly names another surface, **all UI work is done in `agent-home/`.** | Every new user-facing screen, redesign, UX/mobile/polish change and new feature surface lands in `agent-home/`. `web/` is frozen as the operator/admin console and only changes when a request explicitly says "dashboard" (or an operator-only surface has no `agent-home` equivalent). Applies retroactively to all Phase-2/Phase-3 FGs: where an FG names the dashboard as its surface, read `agent-home` unless the item is operator-only. (Leo, 2026-08-10) |

Cost context (see chat): current 2/4 box ≈ **$36/mo**; target 4/16 ≈ **$137/mo + ~$15 disk**; 8/32 ≈ **$266–317/mo**.

---

## 2. Architectural principles (the review bar — from `AGENTS.md`)

Every FG must obey these or it will not merge:

0. **`agent-home` is the main UI (D20).** All UI improvements go into
   `agent-home/` unless the request explicitly names another surface. The
   `web/` dashboard is the secondary operator/admin console.
1. **Prompt caching is sacred.** The system prompt must stay **byte-stable
   within a conversation**. Never inject fresh memory/goals/tools into the
   system prompt mid-conversation, never hot-swap a live conversation's
   toolset, never reorder/edit past messages. Surface new knowledge via
   **appended tool-call results** or **appended continuation messages**
   (this is exactly what `hermes_cli/goals.py` does today — the reference
   pattern). The one sanctioned exception is context compression.
2. **One brain, one profile.** All channels/users share `HERMES_HOME=/opt/data`
   — one skill store, one memory store, one session DB. Multi-user is an
   **access-control layer over the shared brain**, not separate profiles.
3. **Footprint ladder.** New capability arrives at the **highest (least core)**
   rung that works: extend existing code → CLI+skill → service-gated tool
   (`check_fn`) → plugin → MCP server → (last resort) new core tool. Almost
   nothing here should become a new *core model tool*.
4. **Extend, don't duplicate.** Reuse the primitives listed per FG. Do not add
   a 4th goal/task store, a 2nd approval framework, etc.
5. **Behavior/invariant tests, not change-detector tests.** Assert how data
   must relate; do not freeze current values (counts, model lists, config
   versions). Exercise real paths against a temp `HERMES_HOME`.
6. **`.env` = secrets only.** All behavioural config in `config.yaml` /
   Supabase, never new `HERMES_*` env vars for non-secrets.

---

## 3. Feature groups (index)

### Phase 1 — FG-01–13 (multi-user, multi-channel one-brain)

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [01](./feature-groups/FG-01-multi-user-access.md) | Multi-users with access rights; single transferable owner | **0** | `gateway/authz_mixin.py`, `gateway/pairing.py`, `dashboard_auth/`, Supabase GoTrue + RLS |
| [02](./feature-groups/FG-02-blockchain-did-erc721.md) | Blockchain per user: DID:ION + ERC-721 assets | **HOLD** | `optional-skills/blockchain/evm`, MCP rung, approval gates |
| [03](./feature-groups/FG-03-multi-channel-redesign.md) | Multi-channel redesign (one brain, all channels) | 1 | `gateway/`, `gateway/session.py`, `custom/*`, design docs #1/#2 |
| [04](./feature-groups/FG-04-goals-priority-measurability.md) | Goals with priority + measurability/progress | 1 | `hermes_cli/goals.py` (`GoalState`/`GoalContract`/judge) |
| [05](./feature-groups/FG-05-embedding-memory-concurrency.md) | Embedding memory with concurrency | **0** | `tools/memory_tool.py`, `plugins/memory/*`, Supabase pgvector |
| [06](./feature-groups/FG-06-task-discovery-progress.md) | Task discovery & progress tracking | 1 | `tools/todo_tool.py`, `tools/kanban_tools.py`, `projects_db.py` |
| [07](./feature-groups/FG-07-tools-creation-dashboard.md) | Tools creation & configuration + Dashboard | 2 | `hermes_cli/tools_config.py`, `hermes mcp`, `web/`, catalog |
| [08](./feature-groups/FG-08-oss-copy-mcp.md) | Copy OSS capability + MCP (remote & in-house) | 2 | design §4.3, terminal sandbox backends, `hermes mcp` |
| [09](./feature-groups/FG-09-goal-management.md) | Management of goals: memory + tasks + tools | 3 | FG-04/05/06/07 + `mcp_serve.py` |
| [10](./feature-groups/FG-10-human-comms.md) | Human comms: Telegram + web app | 2 | `gateway/` telegram, `clarify_gateway`, `approval`, `web/` |
| [11](./feature-groups/FG-11-agent-comms-mcp.md) | Agent comms: MCP | 1 | `mcp_serve.py`, `tools/mcp_tool.py`, catalog |
| [12](./feature-groups/FG-12-change-management.md) | Change management (data/config/code) + undo/redo/approve/backup | 1 | `tools/checkpoint_manager.py`, `approval`, `write_approval`, `backup.py` |
| [13](./feature-groups/FG-13-dev-prod-mode.md) | Dev vs Prod mode + dev SQLite/Supabase (channels prod-only) | **0** | `hermes_constants.py`, `hermes_state.py`, `config.yaml` |

### Phase 2 — FG-14–19 (reqs 14.0–19.0)

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [14](./feature-groups/FG-14-core-customizable-boundary.md) | Core vs Customizable boundary + protection (C7) | **A** | `core_manifest.yaml` (new), file/terminal write chokepoint, `changes.py` (C5) |
| [16](./feature-groups/FG-16-action-tracking-traceability.md) | Action tracking & traceability (C8) | **A** | `hermes_logging.py`, SessionDB, cost-tracker, `changes.py`, `plugins/observability/` |
| [15](./feature-groups/FG-15-easy-onboarding.md) | Easy onboarding (readiness score) | **B** | `hermes setup`, `config.yaml onboarding:`, `hermes tools`, FG-01/13 |
| [18](./feature-groups/FG-18-gts-centre.md) | GTS Centre (Goals→Tasks→Skills), a Core tool (C9) | **B** | `goal_registry.py`+`goals.py` (FG-04), `tasks`/kanban/todo (FG-06), skills |
| [17](./feature-groups/FG-17-dashboard-nextjs-face.md) | Dashboard = the face → Next.js + embedded Telegram + agent webview | **B→C** | `web/` (port Vite→Next.js), `web_server.py`/`/api/*`, `dashboard_auth`, CDP browser, FG-07 |
| [19](./feature-groups/FG-19-gts-per-user-isolation-assignment.md) | Per-user GTS isolation + cross-user assignment | **C** | FG-18 C9, C2 `can_read`/`scope_filter`+RLS, FG-10 (C6) |

### Phase 3 — FG-20 (mobile-first `agent-home`)

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [20](./feature-groups/FG-20-agent-home-nextjs-supabase.md) | `agent-home` — mobile-first Next.js face (Next.js UI + Python AI layer + Supabase) | **A→B→C** (Phase-3) | Python `/api/*` (AI layer), Supabase (`app_*` + Storage), `access.py`/`interactions.py`/`gts.py` (C1/C2/C8/C9), `web/` panels as functional reference, `data-component` plugin |

### Phase 4 — FG-21 (semantic recall over the shared brain)

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [21](./feature-groups/FG-21-local-semantic-memory-rag-shared-recall.md) | Local semantic memory (layer 4), RAG, and shared recall across users | **0→A→B** (Phase-4) | `plugins/memory/supabase_pgvector/` (FG-05), `hermes_cli/access.py` C2 + `item_grants` (FG-01/FG-19), `interactions.py` C8 audit (FG-16), Supabase pgvector (D4) |

### Phase 5 — FG-22, FG-23 (seeing the memory tier)

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [22](./feature-groups/FG-22-memory-visualizer.md) | Read-only memory visualizer on the operator dashboard | **V1→V4** (Phase-5) | `hermes_cli/memory_explorer.py` over FG-21's store, `_comms_resolve_principal` C1, `memory_projection` under the same C2 RLS as `memories`, `web/` SPA + `@observablehq/plot` |
| [23](./feature-groups/FG-23-memory-on-agent-home.md) | The memory visualizer on `agent-home` (the phone) | **A0→A5** (Phase-5) | FG-22's `/api/memory/explorer/*` endpoints (unchanged), FG-20 BFF (`HermesApiClient`, `requirePrincipal`, `MobileShell`), `deploy/hermes-deploy.sh` + `deploy_state.py` |

### Phase 6 — FG-24–31 (from one profile to an entity pursuing one goal)

Phase 1 built multi-user for a handful of principals in one profile. Phase 6 is
what an organisation of 500 actually needs: personal curated memory, a way to
express *sets* of people, and an administration surface that does not require a
CLI. FG-24 and FG-29 are independent and may run in parallel. FG-27 is a
**prerequisite**: it closes a silent cross-profile data-merge footgun before
FG-26 adds identity-bearing tables to the shared schema — and, since FG-25 was
deferred, it is also what makes "the users of *this* profile" a real set, so
FG-26 is scoped by profile rather than by group.

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [27](./feature-groups/FG-27-profile-scoped-datastore-isolation.md) | Profile-scoped app-layer datastore isolation (close the shared-schema footgun) | **P6-0** — **DONE**, deployed and system-tested on `hermes-systest` 2026-08-11 | `hermes_cli/datastore.py` C3 router (`get_store`, `initialize_supabase_app`), `hermes_cli/profiles.py` (`_CLONE_CONFIG_FILES`, `get_active_profile_name`), `hermes_constants.set_hermes_home_override` |
| [24](./feature-groups/FG-24-per-principal-curated-memory.md) | Per-principal curated memory (memory layers 1–2 become per-user) | **P6-A** — **DONE**, deployed and system-tested on `hermes-systest` 2026-08-11 | `tools/memory_tool.py` (`get_memory_dir`, `MemoryStore`, frozen snapshot), `agent/agent_init.py` (principal already in scope), `agent/system_prompt.py` volatile tier |
| [25](./feature-groups/FG-25-group-scopes-multi-dimensional.md) | ~~Group scopes: multi-dimensional, hierarchical audiences + scoped admin~~ (**DEFERRED** — profiles carry cohort structure; C10 stays reserved) | ~~P6-A~~ **deferred** | `hermes_cli/access.py` C2 (`scope_filter`/`apply_scope_rls`/`bind_principal`), FG-19 `item_grants` clause pattern, FG-21 elevation GUC + `memory_access_audit` |
| [26](./feature-groups/FG-26-users-groups-admin-console.md) | Users admin console + invitation activation (rescoped 2026-08-12: groups out with FG-25; profile assignment settled) | **P6-B** — **DONE**, deployed and system-tested on `hermes-systest` 2026-08-12 | `hermes_cli/members.py` (`MemberService`, `GoTrueAdminClient`), `/api/comms/members*`, FG-20 BFF + `MembersView.tsx`, C5/C8 |
| [29](./feature-groups/FG-29-goal-tree-and-insight-promotion.md) | Goal tree + **skill** promotion (the ai4all spine: goals flow down by lifetime tier, skills flow up) | **P6-A′** — **DONE**, deployed and system-tested on `hermes-systest` 2026-08-11 | `hermes_cli/goal_registry.py` (`goals`/`goal_metrics`/`goal_progress` — already shipped by FG-04/FG-09), `hermes_cli/goal_management.py` one-service-four-frontends, `agent/system_prompt.py` stable+volatile tiers, FG-24 snapshot freeze, `agent/background_review.py` self-improvement loop + `skills.external_dirs` (already read-only to curators) |
| [28](./feature-groups/FG-28-multi-profile-administration.md) | Multi-profile administration + **one gateway for all profiles** | **P6-C** — **IN PROGRESS**: item 1 done (the multiplexed-`os.environ` credential leaks, #219 + #220); nothing gates the rest | `hermes_cli/profiles.py` (`profiles_to_serve`), `_comms_resolve_principal` C1 (already 409s for unenrolled subjects), per-profile `principals` as the entitlement list, FG-20 BFF |
| [30](./feature-groups/FG-30-profile-lifecycle-and-suggestion.md) | Profile lifecycle: suggest, adopt, retire (start with one profile; the loop proposes more) | **P6-D** — **DONE**, deployed and system-tested on `hermes-systest` 2026-08-16 (#250/#253/#262/#265); its clock is `hermes-review-pass.timer` (#268/#269) | `hermes_cli/profiles.py` (`create_profile` already takes `description`/`clone_config`, `delete_profile`, export/import, `profile.yaml`), `hermes_cli/profile_describer.py` aux-LLM "what this profile is good at", `agent/background_review.py` + `tools/skill_usage.py` evidence, FG-29 digest + promotion |
| [31](./feature-groups/FG-31-capacity-headroom-indicator.md) | Capacity headroom indicator ("when should I upgrade the box?") | **P6-E** — **DONE**, deployed and calibrated on `hermes-systest` 2026-08-16 (#260/#264); box-wide **cap** enforcement is an open decision for Leo | `hermes_cli/active_sessions.py` (leases + `max_concurrent_sessions`, shipped), `gateway/run.py` `_running_agents`, `hermes_state.py` WAL busy/retry paths, `hermes status`/`doctor`, FG-29 digest |

#### Phase-6 close-out pass — 2026-08-16 (`develop` @ `3afc06225`)

Every Phase-6 checklist read against the shipped code rather than against the
previous doc. FG-30 and FG-31 close the phase and the master plan; FG-28 is the
only FG still in progress and was **not** touched by this pass (another agent
is in it). What the pass found:

- **Four status headers were lying in the direction that costs most.** FG-24,
  FG-27 and FG-29 each still read `PLAN — not started` while being
  implemented, deployed and system-tested weeks earlier, and FG-31 read
  "awaiting the calibration load run" after the run. The header is the first
  line a cold agent reads, and "not started" is an invitation to rebuild
  something that is live on the box.
- **FG-30's checklist still pointed at a branch.** Three items said the work
  existed "on `feat/fg30-remaining-tasks`" after #262 merged it — the
  stranded-artifact shape that hid T1–T3 for two days, and the same one as
  **#234, referenced by the FG-28 material and closed without ever merging**.
  A doc that names a branch instead of a PR ages into a false claim the moment
  the branch is deleted.
- **Two code findings, both about the box not knowing what the code knows.**
  FG-24's per-principal memory has no erase path and `--clone-all` copies other
  people's participation memory into a new profile (FG-24 §"Open — the layout
  is not known outside the memory tool"); the weekly digest silently drops
  three of its six sections when they fail (FG-29 §"Open — the digest can lose
  a section without saying so"). Neither is a regression: both are surfaces
  that predate the feature and were never revisited when it landed.

The pass has now run five times and found a stale claim every time. That is
the argument for running it at the end of a phase rather than trusting the
checkboxes: the docs are written by whoever *finished* a piece of work, and
nobody is assigned to notice when a neighbouring change makes their sentence
false.

### Phase 7 — FG-32 (the durable record of a piece of work)

Phase 6 gave the entity its goals, its profiles and its people. Phase 7 gives
it a place to keep **work**: a Project holds the owner's fifteen fields, the
cards that execute it, and one row per occurrence, so a piece of work can be
reviewed, repeated and learnt from. It adds no engine — schedules are `hermes
cron` jobs in the host profile, sequencing is kanban parent links, asks are
FG-10 + a to-do, cost is the C8 ledger — and no new core model tool: the agent
reaches Projects through a CLI verb plus a skill (footprint rung 2).

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [32](./feature-groups/FG-32-projects-durable-record.md) | Projects: the durable record of a piece of work (fifteen fields · cadence · autonomy · guidance · runs · retro/learning) | **P7-A** — **IMPLEMENTED**, steps 1–11 merged (#251/#252/#254/#258/#259/#261/#263/#266/#271/#275/#276/#279/#280); **not** deployed or system-tested, and the end-to-end review (FG-32 §20, [`docs/reviews/2026-08-13-projects-steps-1-8-review.md`](../../reviews/2026-08-13-projects-steps-1-8-review.md)) has open defects | `hermes_cli/kanban_db.py` execution substrate, `hermes_cli/projects_db.py` (`board_slug`, `project_profiles`, `project_links`), `hermes_cli/todo_store.py`, `hermes_cli/human_comms.py` FG-10 approvals/asks, `cron/jobs.py` + `cron/scheduler.py` profile-scoped schedule engine, `agent/background_review.py` skills loop, `interactions.py` C8 `kind='cost'`, FG-27 isolation, FG-28 host profiles, FG-29 goals/promotion |


### Phase 8 — FG-33 (vibe-coded apps: local and external)

Phase 7 gave work a durable record. Phase 8 lets a user **vibe code an app**
by talking to the agent, in two hosting modes that each get an icon on the
agent-home Tools page: a **local app** (Next.js in its own Node process on
this box, with its own dev and prod database, served on its own origin behind
agent-home login) and an **external app** (the same template on Vercel,
Railway, AWS or Alibaba Cloud, with its database on supabase.com). It adds no
parallel registry, approval or audit path — it extends the FG-07 registry and
scaffolder, FG-11 `mcp_endpoints`, C3/C5/C6/C7/C8, FG-31 and FG-32 — and no new
core model tool. Twenty-one open decisions (FG-33 §Open decisions) are with Leo/Yan,
the first being what "its own supabase database instance" means on this box.

| FG | Title | Wave | Primary reuse anchors |
|----|-------|------|-----------------------|
| [33](./feature-groups/FG-33-vibe-coded-apps-local-and-external.md) | Vibe-coded apps: local (own Next.js + Node process + own Postgres database; Supabase APIs per-app opt-in under the recommended B2, pending FG-33 open decisions 1–2) and external (Vercel/Railway/AWS/Alibaba Cloud + supabase.com), distinct icons on Tools | **P8** — **PLAN**, phases P8-0 → P8-4 | `hermes_cli/tools_registry.py` + `tool_scaffold.py`/`tool_cmd.py` (FG-07), `hermes_cli/mcp_endpoints.py` (FG-11), `tools/personal_mcp.py`, `deploy/hermes-wa-bridge@.service` + `hermes-wa-bridge-add` + `hermes-vpn-helper` (root-helper pattern), `deploy/aquarium.py` backups, `hermes_cli/credential_store.py` (`materialize=False`), `hermes_cli/oss_acquisition.py::HostRunner` + `oss_host.py::SSHHostRunner` (FG-08), `hermes_cli/capacity.py` (FG-31), `hermes_cli/projects_db.py`/kanban (FG-32), agent-home `components/tools/` |

---

## 4. Cross-cutting shared contracts (Wave 0 — must merge FIRST)

These are the seams every later FG consumes. They are small, additive, and
land before any parallel feature work so agents don't collide on the god-files
(`cli.py`, `run_agent.py`, `hermes_state.py`, `gateway/run.py`).

- **C1 — Principal/identity model** (FG-01). `Principal{user_id, role∈{owner,admin,member,viewer}, ...}`; a `resolve_principal(source)` seam in the gateway; `owner` transfer op. Backed by Supabase GoTrue.
- **C2 — Visibility/scoping helper** (FG-01 + FG-05). `visibility ∈ {shared, private:<user_id>}` + `can_read(principal, row)` / `scope_filter(principal)` used by memory, skills, goals, tasks, tools, assets.
- **C3 — Datastore router** (FG-13 + FG-04-DB). One accessor that returns the correct connection/schema for **(mode: dev|prod)** and **(store: sqlite-core | supabase-app)**. Everything DB-touching goes through it. Channels force `mode=prod`.
- **C4 — `SessionSource.account_id` + extended `session_key`** (FG-03 + D7). Additive field; `build_session_key` folds in `account_id` (+ user/task where applicable) while remaining **byte-identical for existing single-account callers** (regression-locked by `tests/plan_baseline/test_session_key_baseline.py`).
- **C5 — Change-event schema** (FG-12). Append-only `changes(id, ts, actor, mode, target_kind∈{data,config,code}, op, inverse_op|null, reversible:bool, approval_ref, backup_ref)`; every mutating capability emits one.
- **C6 — Approval/consent policy object** (FG-10 + FG-12 + FG-06/04). One policy surface (reuse `tools/approval.py` + `write_approval.py`) with quiet-hours/rate-limit/consent, shared by proactive messaging (4.1/6.1), change approvals (12), and action gating.

Wave-0 agents publish these as typed interfaces + docstrings + baseline tests
**before** Wave-1 agents start.

### Phase-2 contracts (published by FG-14/16/18; consumed by the rest)

- **C7 — Core/Customizable boundary** (FG-14). A repo-committed `core_manifest.yaml` (globs) + a **hard runtime write-guard** at the agent's file/terminal write chokepoint: any agent write whose resolved path is Core is **refused** (fail-closed, escape-safe, no user/config override) and audited. Applies to the runtime LLM agent only; human dev/git/`hermes update` unaffected. Customizable writes emit C5.
- **C8 — Interaction trace** (FG-16). Append-only `interactions(id, trace_id, parent_id, ts, actor_user_id, session_key, platform, kind∈{inbound,turn,tool_call,tool_result,outbound,approval,change,cost,error,core_denied}, ref, summary, payload_ref, mode)`; one `trace_id` per originating interaction joins messages+tools+changes(C5)+cost; **cache-safe** (never prompt-injected), **RLS-scoped** (owner sees all), retention/rollup-capped. Reuses logging/SessionDB/cost-tracker/`changes.py`/observability plugin.
- **C9 — GTS graph** (FG-18; assignment extended by FG-19). Unified nodes + typed edges over FG-04 goals + FG-06 tasks + skills: hierarchical goals/tasks (`parent_*_id`, cycle-safe) with priorities, **M:N** `task_goals`/`task_skills`, user-owned `evaluation_methods` (agent-immutable), auto-computed `score` (0–100, priority-weighted rollup). FG-19 adds `assignee_user_id` (tasks + sub-goals only) + `item_grants` (single assignee + watchers) extending C2.

### Phase-6 contract (published by FG-25 — **reserved, not implemented**: FG-25 is deferred and FG-26 no longer consumes C10)

- **C10 — Group scope** (FG-25; extends C2). `visibility ∈ {shared, group:<group_id>, private:<user_id>}`. Groups are a **forest of typed dimensions** — `groups(id, key, dimension, parent_id, elevation_enabled)` with a same-dimension-parent + acyclicity invariant and a materialised `group_closure` — plus `group_members(group_id, user_id, group_role∈{admin,member})`. **Read inheritance goes up** (audience = my groups + ancestors); **admin scope goes down** (groups I admin + descendants). Both are expanded **once per transaction** by `bind_principal()` into the `hermes.principal_groups` / `hermes.principal_admin_scope` GUCs and tested by array membership in the policy — never a recursive CTE per row; an unbound GUC degrades to plain C2 (fail-closed). Reading a **team** row via admin scope is not audited; reading a **person's** `private:` row is per-group-opt-in elevation and is **always** audited with `via_group_id`. Group elevation compares **group** roles, not instance roles.

---

## 5. Dependency graph & waves (for parallel development)

```
WAVE 0 (foundations — merge before anything else; can run 3 agents in parallel,
         but they co-own C1–C6 so land them as small contract PRs first)
  ├─ FG-13  dev/prod mode + datastore router (C3)              ─┐
  ├─ FG-01  multi-user identity/access (C1, C2)                 ├─ contracts C1–C6
  └─ FG-05  embedding memory + concurrency (C2 uses, pgvector)  ─┘

WAVE 1 (core capabilities — parallel; each owns a distinct subsystem)
  ├─ FG-03  multi-channel redesign      (needs C3, C4; needs D2 memory model)
  ├─ FG-04  goals + priority + metrics  (needs C2, C3)
  ├─ FG-06  task discovery + progress   (needs C2, C3; feeds from FG-03 convo)
  ├─ FG-11  agent comms MCP             (needs C1 for auth)
  └─ FG-12  change management           (needs C3, C5; publishes C6 approval)

WAVE 2 (needs Wave 1 + C6 approval frozen — parallel)
  ├─ FG-07  tools creation + dashboard  (needs C3, C5, C6; web/)
  ├─ FG-08  OSS remote + in-house       (needs C6, FG-07 tool-registry, sandbox)
  └─ FG-10  human comms webapp parity   (needs C1, C6, web/)

WAVE 3 (integration)
  └─ FG-09  goal management = memory+tasks+tools across sources/telegram/webapp/MCP
             (needs FG-04, 05, 06, 07, 10, 11)

ON HOLD (not scheduled — resume only on explicit owner go-ahead)
  └─ FG-02  blockchain DID + ERC-721    (would be Wave 2; needs C1, C6; plugin+MCP)
```

### Phase 2 (reqs 14.0–19.0) — waves (start after Phase-1 `develop` is merged)

```
WAVE A (Phase-2 foundations — parallel; publish contracts first, like Wave 0)
  ├─ FG-14  Core/Customizable boundary (C7)   (needs C5/FG-12, C2/FG-01)
  └─ FG-16  action tracking & trace (C8)       (needs C1/C2, C5, C3)

WAVE B (parallel; each owns a distinct subsystem)
  ├─ FG-18  GTS Centre (C9)                    (needs FG-04, FG-06, C2, C5/C6, C3; FG-14 marks engine Core)
  ├─ FG-17a dashboard frontend Vite→Next.js    (parity port over existing /api/* — can start immediately)
  └─ FG-15  easy onboarding (CLI-first)        (needs FG-01, FG-13; dashboard wizard rides FG-17)

WAVE C (integration — after Wave B)
  ├─ FG-19  per-user GTS isolation + assignment (needs FG-18 C9, C2/roles, C6/FG-10)
  └─ FG-17b dashboard new panels               (Core-area view + embedded Telegram + agent webview +
             GTS Centre UI + trace view + onboarding wizard — needs FG-14/16/18/19/15)
```

**Phase-2 parallelization (mirrors §6):** FG-14, FG-16, and FG-17a (parity
port) are independent and can run as **three parallel agents immediately** after
Phase-1 `develop` merges; FG-18 and FG-15 join in Wave B (deps are already
merged Phase-1 FGs). Wave C (FG-19 + FG-17b integration panels) starts once
FG-18/16/14 land. As in Wave 0, **publish the new contracts (C7/C8/C9) as small
interface PRs first** so Wave-B/C agents don't collide on the god-files. Each
agent works on its own branch, edits only its FG doc, keeps baseline green, and
re-runs the affected system-test checklists (FG-17 must re-run FG-07/10).

### Phase 3 (FG-20 `agent-home`) — waves (start after Phase-2 `develop` is merged + owner confirms FG-20 open decisions)

```
WAVE A (Phase-3 foundations — parallel; publish the data/auth seam first)
  ├─ FG-20/A1  agent-home Next.js skeleton      (App Router, Tailwind, mobile shell + bottom-nav,
  │            PWA, supabase-js, data-component, build/CI, on-box Caddy route)
  └─ FG-20/A2  auth + data-access foundation    (C1 principal bridge → server-side Supabase RLS
               context; typed Python-API client; shared types) — SMALL INTERFACE PR FIRST

WAVE B (parallel; each owns a distinct feature area — reads Supabase, authority via Python API)
  ├─ FG-20/B1  GTS Centre (graph, scores, assignment + watchers)   (C9/FG-18/19)
  ├─ FG-20/B2  Core-area view + interaction-trace timeline          (C7/FG-14 + C8/FG-16)
  └─ FG-20/B3  onboarding wizard + readiness + tools registry       (FG-15 + FG-07)

WAVE C (agent-coupled + polish — parallel)
  ├─ FG-20/C1  agent chat pane (one-brain via API) + Supabase Storage attachments/media  (FG-03/D13)
  ├─ FG-20/C2  agent webview (CDP + C6 consent + C8 trace)                                (FG-17b)
  └─ FG-20/C3  comms/notifications + change undo/redo + mobile/PWA polish + system test    (FG-10/12)
```

**Phase-3 parallelization (mirrors §6):** A1 (skeleton) and A2 (auth/data seam)
run as two parallel agents; **A2 publishes its auth/data-access foundation as a
small interface PR first** (like Wave 0's contracts) so the Wave-B/C agents
share one Supabase-context + API-client seam instead of colliding. Once A merges,
Wave B fans out to three agents (each a distinct feature area), then Wave C to
three (chat / webview / comms+polish). Every agent works on its own branch, edits
only the FG-20 doc, keeps baseline + web build green, preserves the one-brain
chat path (cache-safe), and re-runs the negative-access RLS + C6 checks. The
existing `web/` operator console is left intact.

### Phase 6 (FG-24–31 scale-out) — waves (start after Phase-5 `develop` is merged; FG-26's "assign profile" question is **resolved** — see §8)

```
WAVE P6-0 — DONE (deployed, system-tested 2026-08-11)
  └─ FG-27  profile-scoped datastore isolation  (C3 router + profile clone; no new
                                                 contract, no shape change)

WAVE P6-A — DONE (both deployed, system-tested 2026-08-11)
  ├─ FG-24  per-principal curated memory        (needs C1 only; touches tools/memory_tool.py,
  │         agent/agent_init.py, agent/system_prompt.py — no DB change)
  └─ FG-29  goal tree + skill promotion        (extends the SHIPPED FG-04/FG-09 registry with
            parent_goal_id + a LIFETIME tier: only entity/profile/participant may
            reach a prompt, operational stays tool-appended per FG-09, and tier
            changes apply next session. Up-flow rides the SHIPPED self-improvement
            loop: skills promoted into a shared skills.external_dirs tier.
            Also amends FG-24: person-level USER.md, participation-level memory.)

  (FG-25 group scopes — DEFERRED. Profiles are sub-goal instruments and people
   participate in several, so cohorts no longer need hierarchical groups.)

WAVE P6-B — DONE (deployed, system-tested 2026-08-12)
  └─ FG-26  Users & Goals console + invitations (needs FG-20 BFF, C5, C8; also carries the
            list_principals N+1 fix the roster needs at N=500)
            RESCOPED 2026-08-12: no groups pages (FG-25 deferred); the roster and
            directory are scoped to the administered profile; the create form's
            profile field is required and a foreign profile is refused (FG-28)

WAVE P6-C — IN PROGRESS, nothing gating it (item 1 done: the multiplexed-os.environ
         credential leaks, #219 + #220. ARCHITECTURE DECIDED 2026-08-13: ONE process
         serving every profile, scoped per request — fan-out is a rejected alternative
         and the get_secret migration is its gate)
  └─ FG-28  One console over the goal tree, scoped to the participations the caller
            holds — plus the ONE-GATEWAY-FOR-ALL-PROFILES consolidation
            (gateway.multiplex_profiles; the mechanism and its fail-closed
            context-local secret scope already exist — the work is finishing
            the get_secret() migration: 6 of ~2,250 env reads done, and an
            unmigrated os.getenv returns the WRONG profile's value silently).

WAVE P6-D — DONE (deployed, system-tested 2026-08-16; the review loop's clock,
         hermes-review-pass.timer, shipped with it — before that nothing on the
         box ever called generation, so the FG's headline behaviour had never run)
  └─ FG-30  profile lifecycle: suggest / adopt / retire
            (a deployment starts with ONE profile; the weekly digest proposes new
            sub-goal instruments from clustered skills+goals; adoption seeds only
            the sub-goal, the published entity goal and PROMOTED skills — never
            the parent's memory, which no heuristic can split honestly. Adopted
            profiles start CHANNEL-LESS so a BotFather trip never blocks a
            suggestion. Retire/merge + idle detection exist so suggestion does
            not become sprawl. Also seeds a DEFAULT entity goal editable in
            agent-home settings — an edit is a publication event, not a text box.)

WAVE P6-E — DONE (deployed, calibrated on the box 2026-08-16: conversation_cost_mb
         250 → 20, measured. The per-profile cap is left as it was — making it
         box-wide is a behaviour change and Leo's call)
  └─ FG-31  capacity headroom indicator
            (Hermes IS concurrent — asyncio + thread pool, cross-process session
            leases with a cap, SQLite in WAL. What bounds it is capacity in two
            places: SQLite's SINGLE WRITER serialises writes, and each ACTIVE
            conversation holds a live agent in RAM. So registered users are cheap
            and simultaneous conversations are not. This surfaces the need for
            runtime scale-out in advance instead of pre-building it, and names
            the binding constraint — including when a bigger box would NOT help.)

WAVE P7-A — IMPLEMENTED, not yet deployed or system-tested (steps 1–11 merged;
         open defects in FG-32 §20)
  └─ FG-32  Projects: the durable record of a piece of work
            (A Project holds the owner's fifteen fields, the cards that execute
            it, and one row per occurrence, so work can be reviewed, REPEATED and
            learnt from. Three axes carry the brief: cadence (one-off /
            repeatable / standing), autonomy (manual / supervised / autonomous,
            enforced at the existing triage→todo gate with max_in_progress and a
            per-run budget), and guidance (durable attributed directives compiled
            into the NEXT run's seed prompt — never mid-conversation, because the
            system prompt is frozen for a conversation's life). Adds no engine
            and no core tool: cron in the host profile, kanban links, FG-10 asks,
            the C8 ledger, and a CLI verb + skill for the agent's route in.)

WAVE P8-A → P8-E — PLAN (after Leo/Yan answer FG-33's open decisions; the
         phases run strictly in order, items inside a phase in parallel)
  └─ FG-33  Vibe-coded apps: local and external
            P8-0 prerequisites + contracts → P8-1 local runtime, DB, template →
            P8-2 Tools page, agent workflow, operations → P8-3 external v1
            (Vercel + supabase.com) → P8-4 Railway / AWS / Alibaba Cloud.
            Builds on FG-07, 08, 11, 13, 14, 20, 31, 32.
```

**Phase-6 parallelization:** FG-24 and FG-29 share no files and can run as two
agents immediately. FG-26 must not start before FG-29 merges — the console
renders the goal tree and the insight-promotion queue, and retrofitting those
into a finished users/groups console costs more than sequencing them. Runtime scale-out (gateway workers
sharded by session key, `SessionDB` off SQLite, per-principal rate/cost quotas,
the D8 8/32 resize) is **separate work, not part of Phase 6**: Phase 6 makes the
*access model* serve thousands of registered principals, while concurrent-session
capacity remains an open runtime item (§8).

> **FG-02 (blockchain) is ON HOLD** per Leo (2026-07-11). It is excluded from
> the wave schedule and will not be launched until the owner explicitly
> resumes it. All other FGs proceed as scheduled. FG-02 has **no downstream
> dependents** (nothing in Waves 0–3 or FG-09 depends on it), so holding it
> does not block any other feature group.

**Ordering rules for agents:**
- An FG agent may start only when **all its "blocked-by" FGs have merged** (see
  each FG doc's *Dependencies* section).
- Within a wave, agents work in **separate modules/plugins**; edits to shared
  god-files must go through the Wave-0 contract seams, not ad-hoc.
- FG-03 must define/merge `account_id` (C4) early in Wave 1 because FG-06 and
  FG-09 build on the per-`(user,task)` session shape.

---

## 6. Parallel Devin cloud agents

Each FG doc ends with a **ready-to-paste prompt**; all are collected in
[`agent-prompts.md`](./agent-prompts.md). To launch:

- **Manual:** open a new Devin session, paste the FG prompt. Start only FGs
  whose dependencies are merged (respect the waves).
- **Automatic (offered after this plan PR merges):** the orchestrator session
  can spawn child sessions **wave-by-wave** — Wave 0 first, then fan out.
  Never launch all 13 at once; Waves 1–3 depend on Wave-0 contracts.

Every agent must: work on its own branch, edit only its FG doc, keep the
baseline suite green, add its own FG tests, run lint+typecheck, open a PR that
links back to its FG doc.

---

## 7. Testing strategy

Follows the repo's harness (`scripts/run_tests.sh`, per-file isolation,
hermetic `HERMES_HOME`, CI: `tests.yml` / `typecheck.yml` (ty) / `lint.yml`
(ruff `PLW1514`)) and doctrine (invariant/behavior tests, real E2E vs temp
`HERMES_HOME`, **no change-detector tests**).

- **Baseline regression suite (`tests/plan_baseline/`, delivered with this plan):**
  pins the invariants of the primitives every FG extends, so any FG that
  regresses a reuse anchor fails immediately. Current coverage:
  - `test_session_key_baseline.py` — `build_session_key` determinism + per-chat / per-user isolation + namespace shape (locks C4: FG-03 must keep these byte-stable for single-account callers).
  - `test_goal_state_baseline.py` — `GoalState`/`GoalContract` JSON round-trip, defaults, back-compat load of old rows (locks FG-04's base).
  - `test_todo_store_baseline.py` — todo status vocabulary + transition/merge semantics + prompt-injection of only pending/in-progress (locks FG-06's base).
- **Per-FG tests (each FG delivers):** unit + at least one **real-path E2E**
  against a temp `HERMES_HOME` (and a throwaway Postgres/Supabase schema where
  the FG touches the app DB). Multi-user FGs must include a **negative access
  test** (a `private:<other>` row is NOT visible to a different member; owner
  sees it).
- **Definition of Done (every FG):** new FG tests green **AND** full baseline
  suite still green **AND** `ruff`/`ty` clean, before the FG is marked complete
  in its doc. "Enough testing coverage to confirm the new feature group works
  without bugs and did not cause regression" (Leo) is enforced by this gate.

Run: `scripts/run_tests.sh tests/plan_baseline/` (fast) and the FG's own path.

### 7.1 System testing environment (the new ECS)

There are **three** distinct places tests run — keep them separate:

| Layer | Where it runs | When | Data |
|-------|---------------|------|------|
| Baseline + per-FG unit/E2E | each Devin agent's VM + **CI** (per PR) | continuously, during development | temp `HERMES_HOME` + **throwaway** Postgres schema |
| **System / integration testing** | **the new ai-prentice-4-all ECS** (`hermes-systest`, `i-j6c81aisv2dd8mg17yle`, `ecs.e-c1m4.xlarge` 4 vCPU/16 GB, cn-hongkong-b, EIP `47.83.199.25`) as the dedicated **system-test host** | **after EACH feature group's development completes** (a required step in that FG's Definition of Done) | **staging** Supabase schema (`app_staging`) + a staging SQLite core on the box — **never the prod schema** |
| Production | **the same new ECS for now** (`app_prod` schema + prod `state.db` on the same box; promote to a larger/dedicated box later per D8) | after an FG's system test passes and it is promoted | prod Supabase (`app_prod`) + prod `state.db` |

**Why the new box:** the existing 2 vCPU/4 GB ai-prentice-4-all ECS is too small for
the new self-hosted-Supabase design, so a **new 4/16 box** (`ecs.e-c1m4.xlarge`,
100 GB ESSD data disk mounted at `/opt/data`, stable EIP `47.83.199.25`) is the
dedicated **system-test host** — and, for now, also hosts production (staging
`app_staging` and prod `app_prod` are separate Supabase schemas + separate
SQLite cores on the one box, isolated via contract C3). It is **not** a
development box. Every feature group, once its code is developed and its per-PR
unit/E2E + baseline gate is green, is deployed here and exercised **end-to-end
on the real stack** before that FG is considered done. Same-family in-place
resize to 8/32 (~5 min, no data migration — D8), or split prod onto its own box
later, when load requires it.

**How the per-FG system test works (repeated for every FG):**
1. The FG's PR passes CI (baseline + its own unit/E2E, `ruff`/`ty`).
2. The FG is deployed to the new ECS in **staging mode** (`mode=dev`/
   `staging` via contract C3; `app_staging` Supabase schema + staging SQLite
   core) on top of the already-merged FGs.
3. Run **this FG's "System testing (system-test box)" acceptance checklist** (see
   its FG doc) against the real deployed stack — real GoTrue/RLS, real pgvector,
   real channel adapters bound to **test** accounts, real Telegram + web app,
   real MCP endpoints.
4. **Definition-of-Done gate:** the FG is not complete/promotable until its
   system-test checklist is green (on top of the per-PR gate). Only then is it
   promoted to production (`app_prod` + prod `state.db`, on the same box for now).

**Ordering note:** because each FG's system test runs on the *cumulative*
deployed stack, an FG whose live behaviour depends on a not-yet-merged FG
verifies what it can in isolation and re-runs the cross-FG checks once its
dependency lands (see each FG's *Dependencies*). Cross-surface end-to-end
coverage is owned by **FG-09**.

**Resource caveat:** the full self-hosted Supabase bundle + Node tools + a
staging *and* prod stack on the 4/16 box is tight; run each FG's system test
**sequentially** (not all channels/tools hot at once), keep staging workloads
transient, and in-place-resize to 8/32 (same-family, ~5 min, no data migration
— D8) or split prod onto its own box when load requires it.

---

## 8. Risks / open items carried into implementation

- **RESOLVED 2026-08-12 (was: blocks FG-26's create-user form) — "assign
  profile" on user creation.** Leo's rule: **the owner/admin selects which
  profile a new user belongs to.** The three readings previously tabulated in
  FG-26 are obsolete; they predate the shared-Supabase decision. Because all
  profiles share one GoTrue and one `auth.users`, an *account* is already
  box-wide and "which profile" is simply which profile's `principals` table gets
  the row — no cross-profile identity store is required. The remaining
  constraint is FG-27's ownership guard: a process running as profile A cannot
  open B's schema, by design. So **FG-26 ships the picker scoped to the
  administered profile** (required field, foreign values refused with 409 rather
  than ignored, and no orphan GoTrue account left behind) and **cross-profile
  assignment is FG-28's**, where the control plane entitled to several schemas is
  built. Rejected: a special owner-only cross-profile route in FG-26 — a second
  privileged door weeks before the first one is built properly.
- **Concurrent-session capacity is the real scale ceiling, and Phase 6 does not
  address it.** Phase 6 makes the *access model* serve thousands of registered
  principals (per-row scoping, queries independent of N). The runtime does not
  follow: a live `AIAgent` per active session, `SessionDB` on single-writer
  SQLite, no per-principal rate or cost cap (only a global
  `max_concurrent_sessions`), all on a 4 vCPU / 14 GB box that also runs
  Supabase. Realistic shape today: **thousands registered, order tens
  concurrent.** Hundreds *simultaneously active* needs sharded gateway workers,
  `SessionDB` on Postgres, per-principal quotas, and the D8 resize — separate
  work, larger than FG-24 and FG-29 combined. **FG-31 makes the approach of that
  ceiling visible in advance** rather than pre-building the scale-out; see the
  fuller account of what is and is not concurrent below.
- **The invitation redeem endpoint is the highest-value new attack surface** —
  it is unauthenticated and grants account control. Mitigations are specified in
  FG-26 (hash-only storage, single use, 5-minute TTL, constant-time compare,
  per-IP/per-token rate limiting, uniform failure responses, `no-referrer` on
  the activate route) and every one of them is a required test, not an
  implementation detail.
- **5 minutes is short for an asynchronous handover.** It is what the owner
  asked for and it is the right default for a link relayed over chat, but it
  will expire during any store-and-forward delivery — so "Regenerate link" is
  part of the feature, and email/IdP delivery is the eventual answer.
- **Explicit group membership does not survive 4-figure headcount by itself** —
  at that size membership should come from the IdP (SCIM/OIDC group sync writing
  the same FG-25 tables). Deferred out of FG-25 v1 deliberately; revisit before
  any deployment above a few hundred principals.
- **FG-25 changes FG-21 P3 elevation semantics.** Group elevation compares
  `group_members.group_role`, not instance roles, because in a correctly
  configured deployment every team lead is instance-role `member` (instance
  `admin` outranks every member *globally*, which would make group scoping
  decorative). The instance-wide `role_reads` switch is retained but deprecated;
  a deployment that assigns instance `admin` to team leads has silently
  bypassed the group model, so `hermes member add --role admin` should warn.
- **Profile isolation at the app layer is conventional, not structural
  (FG-27).** `get_store()` hard-codes the app schema to `app_dev`/`app_prod`, so
  two profiles are isolated only because each `config.yaml` happens to carry a
  distinct DSN — and `hermes profile create --clone`, the documented "start from
  my default" path, copies `config.yaml` verbatim. Two profiles then share one
  `principals`/`memories`/`changes` set with no error, no log line and no
  on-disk symptom. RLS does not help: it scopes rows correctly inside a database
  both profiles treat as their own. FG-27 Layers 1+3 are sequenced **before**
  FG-25/FG-26 add `groups`/`invitations`, because an invitation redeemable in
  the wrong profile is a much worse failure than a merged memory row.
- **The shared kanban board has no identity namespace.** `tasks` carries
  `owner_user_id` and `visibility` (C2's vocabulary) on a board that is shared
  across profiles *by design*, but `principals` is per profile — so the same
  `user_id` denotes different people in different profiles and nothing
  reconciles them. Harmless while one human uses it; a real ambiguity once
  several multi-user profiles share a board.
- **Anything that couples profiles together fights an explicit design
  intent.** `AGENTS.md` records profiles as "independent islands on purpose"
  and cites a closed PR that added cross-profile config inheritance. A
  multi-profile administration console is therefore a **deliberate reversal**;
  it is argued on its own merits in FG-28 rather than slipped in as an FG-26
  convenience. FG-28's answer is to couple only a *control plane* (a registry
  at the shared root, the shape already accepted for `kanban.db`) and leave the
  runtimes independent.
- **One shared Supabase makes the FG-27 collision certain, not merely
  possible.** All profiles share one Supabase instance (decided 2026-08-10),
  therefore one Postgres, therefore **the same DSN by design** — so with the
  hard-coded `app_prod` the second profile merges into the first the moment it
  connects, and no configuration avoids it. FG-27 Layer 3 (profile-derived
  schemas) is consequently the *enabling mechanism* for multiple profiles, not a
  hardening measure, and FG-27's build order becomes **3 → 1 → 2**. Layer 2 is
  re-scoped: "share the database, never the schema."
- **Global accounts, local authority (FG-26 §3.5 / FG-28).** With one shared
  GoTrue, an *account* is box-wide while *authority* is per profile.
  `MemberService` performs ban / delete / password-reset through the GoTrue
  admin API with the shared service-role key, gated only by
  `require_member_admin` against the **current** profile — so an `hr` admin can
  ban an account enrolled in `engineers` and revoke their access there. The
  profile boundary holds for data and not at all for accounts. Split the verbs
  (enrolment-level vs account-level) before FG-26 ships its deactivate/delete
  UI, or that UI must be rebuilt. Symmetrically, every profile process holds a
  key that can mint accounts valid everywhere.
- **`HERMES_HOME` is context-local; `os.environ` is not (FG-28).** A profile's
  app DSN resolves as `dsn: ${DATABASE_URL}`, and `_expand_env_vars` reads the
  **process-global** `os.environ` while `reload_env()` writes to it. So one
  process serving several profiles cannot give them different `DATABASE_URL`s,
  service-role keys or model API keys — whichever `.env` loaded last wins for
  all of them, and with ~2,250 env call sites there is no context-local seam to
  fix it behind. **Weakened by the shared-Supabase decision:** the DSN and
  service-role key are now the *same value* in every profile, so this is no
  longer a correctness blocker for the datastore — what survives is per-profile
  secrets that genuinely differ (model API keys) plus the fact that the property
  holds only by coincidence and nothing enforces it. **Superseded 2026-08-13:** the
  context-local seam now exists — `set_secret_scope` plus a fail-closed
  `get_secret`, extended to a spawned child's environment in #219/#220 — so FG-28
  builds **one process, profile-scoped per request** and fan-out is recorded as a
  rejected alternative. Verifying the exposure was FG-28's first task, and it was
  real: four paths, fixed.
- **The owner fallback becomes an escalation vector on any console route
  (FG-28).** `_comms_resolve_principal` resolves a request with no interactive
  session to the enrolled **owner** — correct today, where sessionless callers
  are internal only. Add a console acting in a profile the caller picked, and a
  dropped identity no longer denies the request, it executes it as the *target
  profile's owner*. FG-28 requires verifying the caller's original GoTrue token
  inside the target profile's scope and refusing owner-fallback there, with a
  negative test — and the one-process decision makes this **more** dangerous, not
  less, because the hop looks like a function call rather than a service call.
- **The `get_secret()` migration is asymmetric, and that asymmetry is the
  risk (FG-28).** `agent/secret_scope.py` gives the multiplexing gateway a
  context-local, fail-closed secret scope that never mutates `os.environ` — an
  unscoped `get_secret()` read *raises*. But an unmigrated **`os.getenv`** read
  does not raise; it silently returns whichever profile's value the process
  environment happens to hold. Only **6** call sites use `get_secret()` against
  ~2,250 direct env reads, so `gateway.multiplex_profiles` must not be enabled
  with per-profile-distinct bot tokens or model keys until the credential paths
  reachable from a gateway turn are audited and migrated. **This migration is now
  the gate on FG-28's architecture rather than a caveat beside it:** with one
  process serving every profile (decided 2026-08-13), it is what the process
  boundary used to provide for free.
- **Goal lifetime is the sharpest edge in FG-29.** Goals range from years
  ("improve learning outcomes for 500 students") to minutes ("draft this week's
  homework"), and putting a short-lived one anywhere near the system prompt
  would invalidate the prefix cache mid-conversation. FG-29 therefore treats the
  tier as a *commitment about mutability*: only `entity`/`profile`/`participant`
  may reach a prompt, `operational` stays tool-appended exactly as FG-09 has it
  today, and **a tier change takes effect at the next session, never
  mid-conversation**. That enforcement is the feature; implemented as a
  convention rather than a build-time check, this FG becomes a cache regression.
- **Skill promotion is the one path that intentionally crosses profile
  isolation (FG-29).** Approval must be owner-only — a profile admin approving
  their own promotion would write into every other profile's context — the
  approved artefact is the SKILL.md **bytes**, pinned by hash, because a skill
  distilled from a class's sessions can carry traces of the students in it, and
  no `private:<user>`-derived content may cross without recorded consent.
  Everything else in Phase 6 works to keep profiles apart; this one feature
  deliberately does not, so it carries the strictest gate. The shared tier
  itself needs no new mechanism: `skills.external_dirs` is already read-only to
  autonomous curation, so a profile's own loop cannot write into it by accident.
- **Per-user memory that is not per-participation drifts (FG-24, amended).** An
  OPC founder participating in four sub-goal profiles would hold four copies of
  their own identity facts, diverging over time. Person-level `USER.md` is
  shared across a person's participations; only working memory is per profile.
- **Profile suggestion without retirement is sprawl (FG-30).** Every profile is
  another memory, another channel and another thing the person must remember to
  address, so a mechanism that only proposes new ones degrades the product it is
  trying to make easy. Retire/merge, idle detection, a cap on suggestions per
  digest, and never re-proposing a dismissed suggestion on the same evidence are
  part of the feature, not follow-ups.
- **Splitting a profile's memory is not automatable (FG-30).** Deciding which
  memory card belongs to the parent and which to the new profile is a judgement
  no heuristic makes well and nobody will do by hand; a half-migrated memory is
  worse than none because neither side can be trusted. FG-30 therefore inherits
  only the unambiguous parts (sub-goal, promoted skills, person-level `USER.md`)
  and leaves history with the parent — lossy on purpose.
- **A bot token needs a human at BotFather (FG-30).** If adopting a suggested
  profile requires a credential trip, the routine act the feature depends on
  stops happening. Adopted profiles start channel-less and earn a channel on a
  deliberate commit; the gateway's same-token collision detection makes the
  "just reuse the parent's token" shortcut fail loudly.
- **The shared skill library is a stable-tier cost with no natural bound
  (FG-29 §8).** Skills are listed in the stable prompt tier, so an org library
  that only grows is a tax on every turn in every profile. Approval does not
  bound it — a threshold before a human is asked, a hard cap, and *competitive*
  promotion (a new skill displaces the weakest resident, which is demoted but
  retained locally) are what turn the tier into something that improves rather
  than accumulates.
- **Sibling goals can conflict, and the system must not resolve it (FG-29 §9).**
  The CFO instrument's cashflow goal and the CTO instrument's quality spend
  contradict while both correctly serve their sub-goals. Detection is cheap once
  goals share a comparable measure; *resolution* is the owner's judgement, and a
  system that silently reprioritised one sub-goal would be setting the entity's
  strategy on its own. Alert immediately, never on the digest — a conflict found
  a week late has already cost a week.
- **An unmeasured goal becomes decoration (FG-29 §7).** The whole structure rests
  on the owner believing the goals are live. Long-lived goals without a primary
  metric must be reported *stale* rather than displayed at 0%, and `source_query`
  is the existing seam for the ones that can measure themselves.
- **Concurrency is capacity, not a coding gap — and Phase 6 does not change it
  (FG-31).** Verified in the code: the gateway runs an asyncio loop with a
  thread pool for turns, `hermes_cli/active_sessions.py` already provides
  cross-process session leases with a `max_concurrent_sessions` cap that refuses
  politely, and `SessionDB` runs SQLite in **WAL** so readers never block. Two
  bounds remain, both capacity: SQLite's **single writer** serialises
  simultaneous writes (latency, never corruption), and each **active
  conversation** holds a live agent in RAM to keep its prompt cache warm. So
  registered users are nearly free while *simultaneous* conversations are the
  real cost, and hundreds at once is untested. FG-31 makes the headroom visible
  instead of pre-building the scale-out (sharded workers, `SessionDB` off
  SQLite, per-principal quotas), which remains separate work.
- **Goal text is operator-supplied text entering the system prompt (FG-29)** and
  is therefore an injection surface. It must run through the same
  `_scan_context_content` path SOUL.md uses, and be budget-capped so it cannot
  displace the rest of the prompt.
- **Supabase resource budget** on a 4/16 box with the full bundle + Node tools
  + concurrent cores — monitor; resize to 8/32 (D8) if RAM-bound.
- **Multi-user vs upstream Hermes divergence** — keep the access layer as an
  additive seam so upstream merges stay tractable.
- **Proactive messaging (4.1/6.1)** must ride C6 (quiet-hours/rate-limit/
  consent) or it becomes spam; also guard against self-generated task loops.
- **ERC-721 irreversibility** (D6) is explicitly outside undo (12.1).
- **`alibabacloud` MCP server currently fails to init** — infra used the
  `aliyun` CLI instead; flagged separately.
- **FG-03 live-gateway wiring IMPLEMENTED (code); live channel round-trip
  pending creds.** `gateway/run.py` now enriches each inbound turn with the C4
  identity (`_enrich_channel_source_identity`: receiving `account_id` +
  sender→internal `Principal`) at the `_handle_message_with_agent` chokepoint,
  before the session-key / cached-`AIAgent` lookup, so multi-channel one-brain /
  per-internal-user isolation is active at runtime (gated to a no-op when the
  app-DB DSN is unset). It reuses the gateway's existing per-session-serial /
  cross-session-parallel cached-agent dispatch instead of adding a second
  `InboundRouter` queue (see *Design decision* in the FG-03 doc). Only Telegram
  is live-tested so far; the **live WhatsApp/email round-trip still needs the
  channel creds** (email = old-box Gmail IMAP app-passwords; WhatsApp = QR
  bind). Status + checklist: *Gateway migration* in
  `feature-groups/FG-03-multi-channel-redesign.md`.
  - **Update (2026-07-12):** live **read-only** validation completed on the
    system-test box — Telegram full round-trip (inbound→DeepSeek→egress) +
    approval parity; WhatsApp (personal `85251922892` + ConnectAR `85296660978`,
    resumed sessions, read-only) and email (Gmail IMAP, read-only) confirmed
    resolving through the migrated C4 identity path. Auto-reply/SMTP send NOT
    tested (owner: read-only for now). Old ECS WhatsApp bridges stopped +
    sessions neutralized (renamed `*.disabled-20260712`). **Prod not promoted**
    (owner deferred — more features/testing first).
- **Phase 2 (reqs 14.0–19.0) added (2026-07-12):** FG-14–19 planned (see §1
  D10–D15, §3, §4 C7–C9, §5 Phase-2 waves). Key constraints carried in: the
  Core write-guard (C7) must be fail-closed with no user override; the
  interaction trace (C8) must stay cache-safe + RLS-scoped + retention-capped;
  the Next.js dashboard is a **frontend-only** migration (keep the Python API)
  and must re-run FG-07/10 acceptance to prove no regression; GTS Centre (C9)
  must **extend** FG-04/06 (no new store) with user-only top-level goals +
  evaluation methods and auto-computed scores; cross-user assignment (D15) adds
  per-item grants to C2 without leaking the owner's other private data.

---

## 9. Master plan changelog (append-only)

| Date | Edition | Author | Scope | Change | Rationale |
|------|---------|--------|-------|--------|-----------|
| 2026-07-11 | 1 | devin:8cec0d47 (for Leo) | all | Initial master plan + 13 FG docs + baseline tests | Kickoff of the 13-FG build-out; decisions D1–D9 locked in planning session |
| 2026-07-11 | 2 | devin:8cec0d47 (for Leo) | testing | Added §7.1 + a "System testing" section to every FG doc, as a required Definition-of-Done step after each FG's development | Leo: use a dedicated ai-prentice-4-all ECS as the system-test host, exercised after every feature group's development (per-FG, not a single post-all-waves pass) |
| 2026-07-12 | 5 | devin:8cec0d47 (for Leo) | FG-03 | Documented the outstanding **gateway migration** (Shape-1 `InboundRouter`/producers → live `gateway/run.py`) as an executable checklist in FG-03; added a §8 open item. Clarified WhatsApp/email are not yet live at runtime (only Telegram was live-tested) | Leo: migrate the live gateway to the one-brain router first, then live WhatsApp/email round-trips; make it followable/verifiable by future agents |
| 2026-07-11 | 3 | devin:8cec0d47 (for Leo) | infra/testing | System-test host = a **new** 4/16 ECS (`hermes-systest`, `i-j6c81aisv2dd8mg17yle`, EIP `47.83.199.25`, 100 GB ESSD at `/opt/data`), which also hosts prod for now (`app_staging` vs `app_prod` schemas + separate SQLite cores via C3); retitled the FG section to "System testing (system-test box)" | Leo: the existing 2/4 box is too small for the new self-hosted-Supabase design; provisioned the new box and pointed system testing (and, for now, prod) at it |
| 2026-07-11 | 4 | devin:8cec0d47 (for Leo) | scope | **FG-02 (blockchain DID + ERC-721) put ON HOLD** — removed from the Wave-2 schedule; will not be launched until the owner explicitly resumes it. All other FGs proceed. | Leo: hold the blockchain implementation but go ahead with the rest. FG-02 has no downstream dependents, so holding it blocks nothing. |
| 2026-07-12 | 7 | devin:8cec0d47 (for Leo) | scope/Phase-2 | **Added Phase 2 (reqs 14.0–19.0):** new decisions **D10–D15**, contracts **C7 (Core/Customizable boundary), C8 (interaction trace), C9 (GTS graph)**, index rows + docs for **FG-14–19**, a Phase-2 wave/parallelization plan (§5), and a §8 update recording the completed live read-only WhatsApp/email/Telegram validation (prod not promoted). Frontend-only Next.js dashboard migration (keep Python API); GTS Centre extends FG-04/06 (no new store); single-assignee cross-user assignment via per-item grants. | Leo: study reqs 14–19 and revise the plan without regressions; standardize dashboard on Next.js; keep multi-channel one-brain; hard-block the runtime agent from Core; full interaction tracing; per-user GTS + assignment. Decisions confirmed in session (Next.js frontend-only, single assignee + watchers, full trace + retention/cache-safe/access-scoped). |
| 2026-07-11 | 6 | devin:8cec0d47 (for Leo) | FG-03 | **Implemented the FG-03 live-gateway wiring.** `gateway/run.py` now enriches each inbound turn with the C4 identity (receiving `account_id` + sender→internal `Principal`) at the `_handle_message_with_agent` chokepoint before session-key/cached-`AIAgent` lookup, reusing the existing per-session-serial / cross-session-parallel cached-agent dispatch (no second `InboundRouter` queue). Gated → byte-stable no-op when the app-DB DSN is unset. Added `tests/gateway/test_live_gateway_identity_wiring.py`; updated the §8 open item + FG-03 status/checklist. Live WhatsApp/email round-trip still pending channel creds. | Leo: migrate the live gateway to the one-brain router first, then live WhatsApp/email round-trips. |
| 2026-07-12 | 8 | devin:eaf2cdff (for Leo) | FG-16 / C5 / C8 | Published the additive C8 interaction ledger in C3-routed `app_dev`/`app_prod`, and added nullable `trace_id` linkage to C5 change rows. | One gateway-minted correlation id now joins interaction, change, and cost observations without altering prompt bytes or adding a model-facing tool. |
| 2026-07-13 | 10 | devin (for Leo) | FG-18 / C9 | **Refined C9 with the observe/measure goal-evaluation model** (additive to the existing `evaluation_methods`; no new store). Every goal is *observable* but not always *measurable*: `method_json` gains an explicit `measurable` flag, a typed `observation {source: internal\|external\|ask, prompt, ref?}` (external requires a db/api/mcp `ref`), and a measurable-only `scoring {prompt}` that programmatically computes the clamped 0–100 score over a new additive `observed_state` column via a clean evaluator seam (`GtsScoreEvaluator`/`ScoringRequest`; deterministic default, no external calls). Non-measurable goals keep an observation + qualitative status, take no auto-score, and are excluded from priority-weighted parent rollups. Authority unchanged — the observation prompt, `measurable` flag, and scoring prompt are user-owned (agent refused + audited via C8 `core_denied` + durable JSONL); recording observed state is data (agent-allowed). Cache-safe; `hermes_cli/gts.py` stays Core. | Give measurable goals a user-authored, programmatic scoring path over observed state while keeping non-measurable goals qualitative, within the existing GTS structures and the C7/C9 authority boundary. ECS system-test box + prod promotion remain separate gated steps owned by Leo. |
| 2026-07-04 | 11 | devin:3c64bcf2 (for Leo) | FG-19 / C2 / C9 | **Completed FG-19 per-user GTS isolation + per-item cross-user assignment** (extends C2 + C9; no new access/store system). Per-item `item_grants(item_kind,item_id,user_id,grant∈{assignee,watcher},status)` — single active assignee (partial-unique) + read-only watchers — with a grant-aware `can_read`/`scope_filter` **and** FORCE'd Postgres RLS "granted-to-me" clause so an assignee/watcher sees ONLY the assigned item, never the owner's other private GTS; owner still sees all (+ `list_goals_for_user` browse). Assign/reassign/accept/decline/revoke lifecycle, owner-only assignment/eval-method/reassign/revoke, assignee-may-advance-progress/add-sub-tasks, top-level goals not assignable, agent-initiated assignment gated on C6, full C5+C8 audit; score stays auto-computed (FG-18 rollup). **Fixed a latent grant-clause bug**: the app-layer `scope_filter` correlated its grant `EXISTS` on an unqualified `id` that resolved to `item_grants.id` inside the sub-select (never matched) — the 3 GTS read call sites now pass a table-qualified `id_column`, mirroring the already-correct RLS clause. Added real-Postgres E2E `tests/hermes_cli/test_fg19_assignment_e2e.py` (lifecycle + score rollup + RLS negative-access + authority + C6 + audit). | Phase-2 req 19.0 DoD: real-path E2E for the access-control/datastore change; verify behavioral invariants (RLS isolation, authority, audit) not snapshots. ECS system-test box + prod promotion remain separate gated steps owned by Leo. |
| 2026-07-04 | 12 | devin (for Leo) | FG-17b / C6 / C7 / C8 | **Implemented FG-17b dashboard new panels** on top of merged FG-19 (frontend + backend, no API rewrite). Read-only **Core-area** projection (`/api/core/manifest` → `CorePage`: boundary health/globs/self-protection/denials + FG-12 change log + FG-16 trace). **GTS Centre** now renders merged FG-19 assignment — `/api/gts/graph` exposes each node's `assignee_user_id` + per-item `grants` (assignee/watchers, scoped by item_grants RLS) with `assignment={enabled:true,scheme:"per-user"}`, and `GtsCentrePage` shows assignee/watcher badges. **Agent webview** (`hermes_cli/webview.py` + `/api/webview/*` + `WebviewPage`): default-deny, session-scoped consent, read-only vs interactive, credentialed/destructive/off-scope **escalation → C6 approval**, C8 `InteractionLedger` tracing, per-user opaque UUID5 browser-profile dirs, over the existing `tools/browser_cdp_tool` CDP toolset; fixed a `NameError: uuid` in the escalation path. **Embedded Telegram** pane (`TelegramPage`) — doc-sanctioned native-chat fallback that reuses the existing one-brain `/chat` (TUI→`tui_gateway`→`AIAgent`) since the official web-widget can't embed under dashboard auth. **Tool link/icon registration** reused the existing dashboard-plugin manifest system (no new surface, Footprint-Ladder rung 1). Tests: `test_webview.py` (8) + real-FastAPI+Postgres `test_fg17b_dashboard_e2e.py` (7: default-deny/allow/escalate/approval/traces/isolation/Core/GTS+FG-19) + web vitest helpers; web lint(0 err)/typecheck/build green, `ruff` clean, FG-19 E2E still green. | Phase-2 req 17.0 FG-17b: land the new panels + consent-gated agent webview on the merged FG-19 base, tested on real paths, without duplicating chat/agent or growing the core waist. ECS system-test box + prod promotion remain separate gated steps owned by Leo. |
| 2026-07-04 | 13 | devin:3c64bcf2 (for Leo) | infra/prod | **Production cutover to the strong box.** `https://<dashboard-host>` now served by the 4/16 `hermes-systest` box (`47.83.199.25`) running current `develop` + FG-17 dashboard: Cloudflare DNS (A record repointed 8.217.86.90→47.83.199.25, DNS-only), Caddy + Let's Encrypt HTTPS → `127.0.0.1:9119`, password-gated dashboard, raw port 9119 not exposed. Telegram `@ai_prentice_systest_01_bot` now an always-on `hermes-gateway.service` on this box only (old box poller stopped → dual-poll conflict ended). All 10 targeted FGs (03/04/05/08/11/12/16/18/15/17) promoted to `app_prod` (9→25 tables, RLS, audit rows, backups + functional smoke). Old 2/4 box (`8.217.86.90`) stopped but intact for rollback. Operational note (no design change) captured in [`../SESSION-HANDOFF-2026-07-prod-cutover.md`](../SESSION-HANDOFF-2026-07-prod-cutover.md). Open follow-up: rotate the exposed dashboard owner password. | Leo: put the public product on the stronger hardware (D8), serve current code + FG-17, keep auth + single Telegram poller, retain rollback. |
| 2026-07-13 | 14 | devin:8cec0d47 (for Leo) | docs | **Corrected stale FG status headers + prod-cutover "remaining FGs" list to match `develop`.** FG-01/06/07/10/13/14/19 headers still read "Not started" despite being implemented + merged (PRs #12/#18/#20/#19/#9/#27/#35); updated each to "Implemented — merged to `develop`; ECS system-test/prod-promotion owner-gated". Fixed §8 item 6 of `SESSION-HANDOFF-2026-07-prod-cutover.md`, which had listed those FGs as un-written work: all 19 FGs are implemented + merged except FG-02 (on hold); only 10 were promoted to `app_prod` in the cutover, so the real remaining work for FG-01/06/07/09/10/13/14/19 is the owner-gated system-test + promotion, not code. Docs-only, no code/behavior change. | Keep the plan's status metadata truthful so the next agent/human doesn't re-implement already-merged feature groups. |
| 2026-07-11 | 16 | devin:8cec0d47 (for Leo) | Phase-3 plan / FG-20 | **Added Phase-3 plan: `agent-home` — a new mobile-first Next.js app** (`docs/.../feature-groups/FG-20-agent-home-nextjs-supabase.md`). Locks the three-tier architecture (**D16**): **Next.js UI + Python AI layer (`/api/*`) + Supabase (Postgres + Storage + RLS)**. `agent-home` becomes the user-facing face and hosts **all Phase-2 features** (GTS Centre + assignment, onboarding, Core-area view, interaction trace, one-brain chat, agent webview, tools) in a mobile-first/PWA UI; the existing `web/` stays as the operator/admin console. Uses a **BFF pattern** — the `agent-home` server holds the C1 principal context, proxies agent/authority ops to the Python API, and does server-side Supabase reads with the principal's RLS context (+ RLS-scoped Realtime); the browser never gets a privileged Supabase key or bypasses C1/C2/C6/C8. **No new contract** (new surface over C1/C2/C3/C5/C6/C7/C8/C9), no new core model tools, no new non-secret `HERMES_*` env vars, one-brain chat unchanged (cache-safe). Added a Phase-3 wave/parallelization plan (A skeleton+auth seam → B GTS/Core+trace/onboarding+tools → C chat/webview/comms+polish). Docs-only, no code. **Open decisions flagged for owner** (auth-identity bridge vs GoTrue; deploy on-box vs Vercel; `web/` fate; app location) — implementation gated on confirmation. | Leo: the current dashboard isn't mobile-friendly/is hard to use — build a purpose-built mobile Next.js face on the fixed Next.js + Python + Supabase stack and move all the new features into it. |
| 2026-07-11 | 15 | devin:8cec0d47 (for Leo) | naming | **Project renamed "ai-prentice" → "ai-prentice-4-all".** GitHub repo renamed `leolau/hermes-agent` → `leolau/aquarium` (GitHub auto-redirects old URLs). Product-name references updated across the master plan, per-FG docs, and hand-off docs; the per-FG cloud-agent-prompt repo slugs were repointed `leolau/hermes-agent` → `leolau/aquarium`. Left untouched: the upstream **Hermes** framework identifiers (`hermes_cli/`, the `hermes` CLI, `HERMES_HOME`, package imports, `/opt/data/hermes-agent` paths) and live-infra identifiers (Telegram bot `@ai_prentice_systest_01_bot`, ECS instance names `hermes-systest`/`ai-prentice`/`ai-prentice-agentdoc`, example test hostnames `ai-prentice-2`). Docs/naming-only, no behavior change. | Leo: standardise on the product name "ai-prentice-4-all" everywhere without breaking the running framework or production infra. |
| 2026-07-12 | 9 | devin:b9d4f38f (for Leo) | FG-18 / C9 | Implemented the unified GTS graph (`hermes_cli/gts.py` `GtsCentre`), **extending** FG-04 `goals` + FG-06 `tasks` (+ existing skills) in C3-routed `app_dev`/`app_prod` — additive `parent_*_id`/`level`/`priority`/`score`/`evaluation_method_ref` columns plus `skills_registry`, `task_goals`, `task_skills`, `evaluation_methods`; no new goal/task store. Authority is fail-closed (user-only top-level goals + evaluation methods; agent refused + audited via C8 `core_denied` + durable JSONL + optional C5 sink); scores are always computed, clamped 0–100, and roll up by priority weight; cycle-safe hierarchy; cache-safe surfacing (`render_gts_block`, never mutates the system prompt). Engine marked Core (`core_manifest.yaml` + `agent/core_boundary.py`). | Phase-2 req 18.0: publish C9 as one graph over the existing stores with a hard user/agent authority boundary and computed rollup scores, without breaking prompt-cache or the Core waist. ECS system-test box + prod promotion remain separate gated steps owned by Leo. |
| 2026-07-30 | 17 | devin:bbf60d09 (for Leo) | infra/mcp | **Writable design + cloud MCP access on the live box.** Canva/Vercel/Railway wired natively (open dynamic client registration) and AWS Knowledge without credentials; writable **Figma** is a skill bridging Claude Code, because Figma `403`s uncatalogued OAuth clients and a PAT can never write canvas. Durable **Railway** access is the `railway-cli` skill + account API token: Railway drops `offline_access`, rejects its own DCR-issued `client_secret` (`invalid_client`), and refuses device-code to self-registered clients, so its MCP token expires hourly with no refresh. Two Hermes bugs fixed along the way — endpoint preflight rejected POST-only MCP servers (PR #67), and the OAuth authorization URL lost every parameter when the authorization endpoint already carried a query (PR #68). Vercel's `buy_*` tools excluded from the agent's toolset. Operational note (no design change) in [`../SESSION-HANDOFF-2026-07-mcp-integrations.md`](../SESSION-HANDOFF-2026-07-mcp-integrations.md). | Leo: give ai-prentice write-capable design tools and real deployment/cloud reach, natively where a provider allows it and via a skill where it does not. |
| 2026-08-10 | 19 | devin (for Leo) | UI surface / D20 | **Locked D20: `agent-home` is the key and main UI; the `web/` dashboard is not.** All UI improvements — new screens, redesigns, UX/mobile/polish, new user-facing features — are done in `agent-home/` unless a request explicitly names another surface; `web/` stays the operator/admin console. Recorded as principle 0 in §2, as decision D20 in §1, in `README.md`, `AGENTS.md`, `agent-home/README.md`, `docs/design/architecture-design-number-one.md`, and in FG-20. Docs-only, no code change. | Leo: "the key and main UI is the agent-home, not dashboard. Unless explicitly specify, otherwise, all UI improvements are done in the agent-home." |
| 2026-08-04 | 18 | devin (for Leo) | FG-21 / memory / C2 | **Added FG-21: local semantic memory (layer 4), RAG, and shared recall across users.** Survey of the live box found the pgvector tier is real (HNSW, `vector 0.8.2`) but its embeddings are a hashing bag-of-words (not semantic), `memory_query` has never been called (write-only tier), and `_resolve_principal` never consults the `principals` table — so Telegram runs as `member 8756039695` while the dashboard runs as `leo_owner`, one human with two disjoint private memories and `channel_identities` empty. Plan: on-box embedding service (no text leaves the deployment) + model/dim versioning, automatic recall through the cache-safe `prefetch()` seam, identity enrolment as the prerequisite for cross-user access, audited role/grant-based elevation over C2 (reusing FG-19 `item_grants`), and a `rag_documents`/`rag_chunks` corpus with hybrid retrieval and citations. Docs-only; implementation gated on the open decisions in FG-21 §10. | Leo: local embeddings, must be semantic, use as the 4th memory layer, support RAG, and share memory across users of one instance with higher-privilege access by right |
| 2026-08-05 | 19 | devin (for Leo) | FG-23 / FG-22 / infra | **Added FG-23: move the memory visualizer onto `agent-home` (the phone).** No new data path — FG-22's `/api/memory/explorer/*` endpoints stay the single seam, consumed through the FG-20 BFF, so C1 principal scoping, C2 RLS on `memory_projection` and the C8 elevated-read audit are inherited rather than reimplemented (the plan explicitly forbids `agent-home`'s direct `pg` path for memory: correctly scoped by RLS but silently unaudited). The survey of the live box, not the repo, set the plan's shape: `agent-home` **is** already serving `<agent-home-host>` but from a **second checkout** (`/opt/data/agent-home-app`, at PR #62) that `deploy-hermes.sh` never updates, with a build dated 2026-07-27, as `root`, and with its unit outside `deploy_state.py`'s `hermes-*` capture glob — so a merged page would appear on the dashboard and never on the phone, undetected. Phase A0 (deployment path + state coverage) is therefore the feature, not preparation. Also decided: omit `mode` so the API resolves the memory tier's own schema (`AGENT_HOME_DATASTORE_MODE=prod` would render a healthy page reporting zero memories, since the live tier is `app_dev`), inline SVG instead of a charting dependency in a phone PWA, and a deterministic sampled `/projection` before Drive ingestion turns 37 dots into tens of thousands. Docs-only. | Leo: put the memory visualization in the agent home instead of the dashboard |
| 2026-08-10 | 20 | devin (for Leo) | Phase-6 plan / FG-24 / FG-25 / FG-26 / C10 | **Added Phase 6 — scaling one profile to hundreds of principals**, with three new FG docs and one new contract. **FG-24** makes curated memory layers 1–2 per-principal (shared block + per-user block): investigation of `agent/prompt_caching.py` (a single `system_and_3` layout with one breakpoint at the end of the whole system prompt) and `agent/system_prompt.py` (a per-session `Session ID`/timestamp line already at the tail of the `volatile` tier) established that **the system prompt is already unique per session**, so the long-standing "per-user curated memory would fragment the prompt cache" constraint does not hold — the invariant that matters (byte-stable *within* a conversation) is preserved by the existing frozen-snapshot mechanism. Also unblocks the shared 2200-char ceiling, already at 2029 with writes being refused. **FG-25** publishes **C10**, a group tier for C2 — hierarchical, multi-dimensional audiences with group-scoped admins — designed to serve a school (`cohort` dimension) and a medium business (`org` × `project` dimensions) with the same primitives; one brain, groups partition visibility only (D1). Key design points recorded there: read inheritance runs **up** while admin scope runs **down**; both are pre-expanded into GUCs so RLS never runs a recursive CTE per row; audit fires for reading *people*, not *teams*; and group elevation must compare **group** roles because in a correct deployment every team lead is instance-role `member` (instance-role comparison would refuse every elevation). **FG-26** replaces the flat `/members` page with a Users + Groups console and swaps admin-relayed temporary passwords for **hashed, single-use, 5-minute invitation links** (accounts created banned until activation). Rejected alternatives are recorded in the FG docs: one profile per class/team (that is the multi-tenant model D1 rejects), bulk `item_grants` as a stand-in for groups, intersection scopes, and GoTrue `admin/generate_link` for invitations. **Open decision flagged for the owner:** the "assign profile on user creation" requirement — a profile is an isolated brain, not a user attribute, so as stated it implies cross-profile identity (a separate FG). Docs-only, no code. | Leo: items 3 (per-user memory) and 4 (groups) are the show-stoppers for running one profile with hundreds — and in the general case thousands — of login users, covering both a school ("Students") and a medium business ("Engineers"), with multi-layered/multi-dimensional org topologies, an audited both-sides ledger for any read into a member's private data, and an administration UI for users, groups and invitation-based activation. |
| 2026-08-10 | 21 | devin (for Leo) | FG-27 / profile isolation / risks | **Added FG-27 — profile-scoped app-layer datastore isolation**, sequenced as a Phase-6 **prerequisite** (P6-0) ahead of FG-25/FG-26. Found while scoping multi-profile administration: `get_store()` hard-codes the app schema to `app_dev`/`app_prod`, so a profile's data is addressed by `(dsn, "app_prod")` and the **only** discriminator is a DSN string in that profile's `config.yaml`. `hermes profile create --clone` — the documented "start from my default" path — copies `config.yaml` verbatim (`_CLONE_CONFIG_FILES = ["config.yaml", ".env", "SOUL.md"]`, no mention of `dsn`), so the recommended workflow produces two "isolated" profiles sharing one `principals`/`memories`/`memory_projection`/`changes`/`item_grants` set. Nothing detects it (concurrent connections to one schema are what a legitimate single profile looks like; `initialize_supabase_app()` is `IF NOT EXISTS`) and nothing on disk shows it (`state.db`, `memories/`, `config.yaml`, `skills/` are genuinely separate). RLS does not help — it scopes rows correctly inside a database both profiles treat as their own. Three layers specified, cheapest first: a fail-closed `schema_owner` claim/verify marker, `--clone` no longer copying the app DSN blindly, and profile-derived schema names (`app_prod_<profile>`, default profile byte-identical) resolved through `get_active_profile_name()` so a multiplexed gateway turn scoped with `set_hermes_home_override()` picks the right schema with no caller changes. Prevention is prioritised over migration because interleaved rows carry no provenance column and **cannot** be disentangled automatically. Also recorded three new §8 risks: this footgun, the shared kanban board's missing identity namespace (`tasks.owner_user_id`/`visibility` use C2's vocabulary on a deliberately cross-profile board while `principals` is per profile), and the fact that any multi-profile administration console is a **deliberate reversal** of the "profiles are independent islands on purpose" intent recorded in `AGENTS.md` and must be argued in its own FG. Docs-only, no code. | Leo asked whether each profile has its own SQLite and Supabase DB. SQLite yes, by construction; Supabase only by convention — which surfaced the footgun. He then asked for it as a separate FG. Sequenced first because FG-25/FG-26 add exactly the identity-bearing tables (`groups`, `invitations`) whose cross-profile leakage would be most damaging: an invitation redeemable in the wrong profile is far worse than a merged memory row. |
| 2026-08-10 | 22 | devin (for Leo) | FG-28 / multi-profile administration | **Added FG-28 — one administrator managing users in several profiles** (owner assigns `engineers`+`testers` to the CTO and `hr` to the CFO), with users still belonging to exactly one profile and no user-visible data crossing a boundary. Two findings shaped it. **(a) The entitlement model needs no new tables.** The Supabase dashboard-auth provider verifies GoTrue's access token and uses the `sub` claim as the identity, and `hermes_cli/access.py` uses that same UUID as `principal.user_id` — so with one shared GoTrue, "CTO may administer `engineers`" means exactly "CTO has an `admin` row in `engineers`' `principals`". The per-profile `principals` table *is* the per-profile grant: already RLS-protected, already fail-closed (absence of a row is absence of authority), and `_comms_resolve_principal` already returns 409 for an authenticated-but-unenrolled subject rather than falling back to owner. **(b) The architecture is forced by the process environment.** `set_hermes_home_override()` is a `contextvar`, but `_expand_env_vars` resolves `dsn: ${DATABASE_URL}` from the process-global `os.environ` and `reload_env()` writes to it — so one process cannot hold per-profile secrets (DSN, service-role key, model keys), and with ~2,250 env call sites there is no context-local seam. FG-28 therefore **fans out to per-profile processes** rather than multiplexing in-process: the process boundary is what keeps secrets apart, and only a control-plane profile registry is shared (the shape already accepted for `kanban.db`). Recorded the sharpest hole: `_comms_resolve_principal`'s owner fallback for sessionless requests is correct today but becomes an escalation to *the target profile's owner* the moment a console→profile-API hop exists, so FG-28 requires forwarding the caller's original GoTrue token and refusing owner-fallback on console routes, with a negative test. Also flagged that the **gateway already multiplexes profiles in one process** and may therefore already be exposed to (b) — verifying that is FG-28's first task and outranks the feature if confirmed. Sequenced as P6-C after FG-26 and gated on FG-27 Layers 1+3, which turn a wrong-DSN resolution from a silent merge into a detectable error, and on one open decision: whether all profiles share a single GoTrue. | Leo: "the owner can assign Engineers profile and Testers profile to admin CTO, and HR profile to admin CFO … Is this a big scope change? Does it allow access to cross profile?" Answer: no cross-profile access for users, and medium scope — but it is a deliberate reversal of the "profiles are independent islands on purpose" intent in `AGENTS.md`, so it gets its own FG and its own argument rather than riding along with FG-26. |
| 2026-08-13 | 24 | devin (for Leo) | FG-28's runtime shape decided: one process serving every profile, scoped per request | The `os.environ` constraint that made fan-out a recommendation here is gone — `set_secret_scope` is context-local, `get_secret` fails closed, and #219/#220 extended the correction to a spawned child's environment. Leo then found that the FG doc was asking for two mutually exclusive runtimes: fan-out to per-profile HTTP APIs cannot coexist with the one-gateway consolidation the same FG carries, because with `multiplex_profiles` on the port-binding platforms are a hard startup error for a secondary profile and the default profile serves the rest under `/p/<profile>/`. Decided in favour of one process, with the cost written down rather than waved away: the process boundary was what made “authority re-derived at the destination” structural, so the `get_secret` migration is now the **gate** on the architecture, and the two-profiles-one-process secret-isolation test is load-bearing. |
| 2026-08-10 | 23 | devin (for Leo) | Shared-Supabase decision propagated through FG-26/27/28 | Leo confirmed **all profiles share one Supabase instance**. Three consequences recorded. **(1) FG-28's entitlement model is confirmed** — one GoTrue means one subject namespace, so a per-profile `principals` row is a sufficient per-profile grant with no new authority tables, and the shared kanban `owner_user_id` ambiguity closes incidentally. **(2) FG-27 changes shape** — one Supabase is one Postgres, so every profile has the same DSN *by design* and the shared-schema collision stops being a footgun and becomes the guaranteed outcome: the second profile merges into the first on contact, with no configuration that avoids it. Layer 3 (profile-derived schemas) is promoted from "the real fix" to **the enabling mechanism for having more than one profile at all**; build order becomes **3 → 1 → 2**; Layer 1 is unaffected because its marker keys on the schema rather than the DSN; and Layer 2 as written is now *wrong* — blanking the cloned DSN would break the intended topology — so it is re-scoped from "don't share the database" to "share the database, never the schema". **(3) A new hole, the sharpest one: global accounts, local authority.** With `auth.users` shared, `MemberService`'s ban/delete/password-reset run through the GoTrue admin API with the shared service-role key gated only by `require_member_admin` against the *current* profile, so an `hr` admin can ban an account enrolled in `engineers`. FG-26 gains §3.5 splitting **enrolment-level** verbs (add/remove/re-role the principals row — confined to the acting profile) from **account-level** verbs (ban/delete/reset — box-wide), makes profile-context "deactivate" mean *un-enrol*, and requires owner (or a target enrolled solely in profiles the actor administers) for account-level operations. Symmetrically, every profile process holding that key means one compromised process is a box-wide account compromise, which is the strongest argument for account operations living behind FG-28's control plane. Also corrected FG-28's `os.environ` finding honestly: with a shared Supabase the DSN and service-role key are identical across profiles, so it is no longer a correctness blocker for the datastore — fan-out drops from hard requirement to strong recommendation, justified by per-profile model keys and by the property holding only through an unenforced coincidence. | Leo: "all profile shares the same supabase instance. How does it affect the design?" |
| 2026-08-10 | 24 | devin (for Leo) | Domain model corrected: profiles are sub-goal instruments — FG-29 added, FG-25 deferred, FG-28 reframed, one gateway adopted | Leo restated what ai4all is: a system helping **one entity** (individual, OPC, family, SME, school) achieve **one ultimate goal**, where a **profile is the instrument for a sub-goal** with matching behavioural characteristics, and **people participate in as many profiles as their work spans** — supplying real-world input, acting on output, and contributing know-how back. Four changes follow. **(1)** The reframing retires the "a user belongs to exactly one profile" premise I had been designing against: it was an imported constraint, not one the system imposes, since one shared GoTrue subject can hold a `principals` row in several profiles with separate memory in each. The multi-cohort case (a teacher on two classes, an engineer on two projects) therefore needs no new machinery. **(2) FG-25 (group scopes) is deferred** — profiles now carry the cohort structure hierarchical groups were designed to express, and it was the most expensive item in Phase 6 while buying isolation *by policy* where profiles give it *by construction*. C10 stays reserved; groups remain right for scoping *within* one large profile. **(3) FG-29 added as the spine**, after correcting an error of mine: I had told Leo there was no goal object in Hermes, when FG-04/FG-09 shipped a full registry (`goals`, `goal_metrics`, `goal_progress`, `goal_asks`, `goal_links`, C2-scoped, four front-ends). What it lacks is hierarchy (no `parent_goal_id`), reach across profiles, any presence in the system prompt (verified absent — a deliberate FG-09 cache-safety choice, right for operational goals and wrong for long-term ones), and any upward path for knowledge. FG-29 adds two flows: **goals down** by publish-with-revision (copy, not live inheritance, per the closed-PR precedent in `AGENTS.md`) for coherence, and **insights up** via owner-approved `insight_candidates` for compounding — without which 500 users produce 500 disconnected conversations. **(4) One gateway for all profiles adopted** into FG-28 on Leo's request and measured evidence (150 MB per gateway daemon, ~225 MB per console, ~3.7 GB idle at ten profiles against 9.6 GB available). Reading the code corrected a second claim of mine: `agent/secret_scope.py` already solves the process-global-environment problem for the gateway path, so the work is finishing the `get_secret()` migration rather than building the mechanism. | Leo: "a profile is an infrastructure defined to help to improve on sub-goal with similar behavioural characteristics … what would be the best way to organize these different parts into a single, user-friendly and effective solution, ai4all?" plus "Please put into the plan to support one gateway for all profiles running on the same box." |
| 2026-08-10 | 25 | devin (for Leo) | FG-29 edition 2: goal **lifetime** made load-bearing; up-flow rebuilt on the shipped self-improvement loop; FG-24 amended for participation-level memory | Three corrections from Leo, each of which made the plan smaller by reusing something already shipped. **(1) Goal lifetime is the distinction the system must not get wrong.** Goals range from years to minutes, and Leo flagged that some "come and go in every session or even in the middle of a session." FG-29 now treats the tier as a *commitment about mutability* rather than a label: only `entity`/`profile`/`participant` may reach a prompt, `operational` stays tool-appended exactly as FG-09 has it, and **a tier change applies at the next session, never mid-conversation**, because the prompt is frozen for the session's life. This preserves FG-09's cache rule where it is right instead of overriding it, and it is what makes the stable-tier PURPOSE block defensible rather than a cache regression. The ladder deliberately spans both lifetimes — a short-lived goal declares its parent — so the agent can always resolve *which long-term goal does this serve*, and can notice when the honest answer is "none". **(2) The up-flow already exists as the skills loop.** Edition 1 proposed a free-text `insight_candidates` table; Leo pointed out that Hermes already studies its history and distils skills, and that this loop is a main reason he is building on Hermes and keeping profiles. Rebuilt on it: `agent/background_review.py` produces the know-how, so the only missing piece is *crossing the profile boundary*. The shared library needs no new mechanism either — `skills.external_dirs` already exists and is **read-only to autonomous curation** (`agent/skill_utils.is_external_skill_path`), exactly the property promotion requires, since a profile's own curator then cannot write into the org tier by accident and the audited path is the only way in. Promoting *skills* rather than prose also means the shared tier accumulates executable, tested artefacts instead of opinions. **(3) Both organisational shapes are one mechanism** — participation = (person × profile) covers many-people-one-sub-goal (SME/school/family) and one-person-many-sub-goals (OPC, where the founder is CEO+CTO+CMO+CFO). The OPC case exposed a real flaw in FG-24: putting *all* per-user memory inside the profile would duplicate the founder's identity facts across four profiles and let them drift, so FG-24 is amended — person-level `USER.md` shared across a person's participations, participation-level working memory isolated per profile. Three open questions left with the owner: OPC message routing (one channel per profile vs one entry point that infers the sub-goal), auto-approving promotion in single-principal deployments, and whether owner review of SKILL.md text is a sufficient privacy gate for skills distilled from minors' sessions. | Leo: "some goals are very long term and don't change very often but some goals are very short-lived … The system must be careful with this distinction." · "The existing Hermes infrastructure already support self-improving … this should be the 'Insight flows up'." · "in a One-Person-Company (OPC) the CEO is also the CTO is also the CMO is also the CFO." |
| 2026-08-10 | 26 | devin (for Leo) | Promotion becomes a weekly two-stage review; **FG-30 added** — profiles get a lifecycle instead of being static | Leo closed FG-29's three open questions, and one answer turned out to be a new capability. **(1) Weekly cadence** for skill promotion means human approval is affordable, so the single-principal auto-approve path is dropped: one always-audited code path beats the saved minute, and batching suits a loop that already runs asynchronously and writes locally — only the *crossing* needs a human. **(2) Two-stage approval** — the origin profile's reviewer (the teacher) then the owner — is stronger than the owner-only gate and splits the judgement by who can actually make it: only the teacher can tell whether a skill carries traces of their students; only the owner can tell whether it belongs to the whole entity. **(3)** The routing answer — a channel per profile, but *starting from one or two* because "the human may not know what kind of profile does he/she needs", with the system suggesting more over time — invalidated an assumption running through every Phase-6 doc: that sub-goal structure is known up front. It isn't; it is discovered by doing the work. **FG-30** makes profile creation an output of the same learning loop FG-29 uses for skills, and addresses the three holes that opens: a BotFather trip would block the routine act of adopting a suggestion (adopted profiles start **channel-less** and earn a channel on commit); suggestion without a retire/merge path becomes sprawl, which is expensive when each profile is another memory and another thing to remember; and splitting a parent profile's memory is a judgement no heuristic makes well, so adoption deliberately inherits only the unambiguous parts (sub-goal, published entity goal, **promoted** skills, person-level `USER.md`) — which incidentally gives skill promotion a second purpose, since a promoted skill is what each new instrument starts life with. | Leo: "How often does the skill promotion happen, if once a day or once a week, it is ok to let the human to approve the system suggested promotion" · "Yes, teacher needs to review before promotion" · "the system should be able to start with just one profile or a couple of profiles and the ability to suggest more profiles to add over time, as part of the learning and promotion" |
| 2026-08-10 | 27 | devin (for Leo) | Goals get one comparable measure; skills get a score+threshold+capped library; sibling conflict alerts; first goal seeded in settings; **FG-31 added** for capacity headroom | Leo's answers to the five remaining holes. **(1) Quantified skills with a threshold** — approval was only deciding whether a skill *may* cross, never whether it is good, and since skills sit in the **stable** prompt tier an unbounded shared library taxes every turn in every profile. Scoring reuses signals already recorded (`tools/skill_usage.py`, curator/provenance, metric movement, dwell time), and the cap plus *competitive* promotion is the part that matters: without it the tier grows monotonically; with it a new skill must displace the weakest resident, so the tier improves and promotion is a lease rather than a freehold. **(2) Immediate conflict notification** — the tree assumed alignment, but tension between siblings is exactly what an owner needs; deliberately detect-and-notify only, since a system that silently reprioritised would be setting the entity's strategy, and immediate rather than digest because a week-late conflict has already cost a week of divergent work. **(3) One shared quantitative measure per goal** turned out to enable both: `goal_metrics` shipped in FG-04 but nothing was canonical, so no two goals could be compared, no child's progress could roll into its parent, no skill could be credited and no antagonism detected. A designated `primary_metric` with direction-aware normalisation supplies all four; unmeasured long-lived goals are reported **stale** rather than sitting at 0%. **(4)** The first entity goal is **seeded from a default and edited in `agent-home` settings** — a seeded generic goal invites replacement where a blank field invites being skipped, and the settings page is a writer into the goal tree (an edit bumps the publish revision). Invitation delivery via the owner's own channel is recorded as a **decision**, with its cost written down: a relayed link lives in chat scrollback, so "the user set their own password" is not an integrity property this deployment can claim. **(5)** Leo's concurrency question resolved a caveat I had been repeating: checking the code shows Hermes **is** concurrent (asyncio + thread pool, cross-process leases with a cap, SQLite in WAL), and what remains is capacity in two specific places — SQLite's single writer, and one live agent in RAM per *active conversation*. So registered users are cheap, simultaneous conversations are not, and **FG-31** surfaces headroom (naming the binding constraint, and saying plainly when a bigger box would not help) instead of pre-building the runtime scale-out. | Leo: "we need a way to quantify the skills and only show up for approval if it exceed the threshold" · "If there is a sub-goal conflicts, need to notify the user immediately" · "Share the same quantitative measure for each goal" · "The first goal can come from the system default, but also must be configurable at the settings page in the agent-home" · "we need a simple performance indicator to remind the owner when is the time to upgrade the hardware" |
| 2026-08-12 | 28 | devin (for Leo) | FG-26 rescoped off the deferred FG-25; **"assign profile" resolved**; C10 marked reserved-not-implemented | Two stale premises would have been discovered by whoever picked up FG-26, both fixed here. **(1) FG-26 still rendered FG-25.** The groups tier was deferred on 2026-08-10, but FG-26's "Blocked by" still named it and 4 of its 15 checklist items — group CRUD, group-admin, `elevation_enabled`, the `/me/access` elevation ledger — were written against tables that will not exist, so the implementer would either have built the deferred model or guessed. Those items are removed *and enumerated* in a "Removed with FG-25" table naming where each went, group filters become **profile** scope, and this README's C10 section is relabelled reserved-not-implemented so the contract is not read as a shipped seam. `/me/access` is deliberately held back with FG-25 rather than shipped alone: a ledger of an elevation mechanism that does not exist is worse than no page, because it reads as "nobody has looked at your data". **(2) "Assign profile" is resolved**: Leo's rule is that the **owner/admin selects the profile** a new user belongs to. The A/B/C readings this plan carried were obsolete — they predate the shared-Supabase decision, under which one GoTrue and one `auth.users` make an *account* box-wide, so "which profile" is just which `principals` table gets the row and no cross-profile identity store is needed. The live constraint is instead FG-27's ownership guard: a process running as profile A cannot open B's schema, by design and fail-closed. Leo chose to ship the picker **scoped to the administered profile** and hand cross-profile assignment to **FG-28**, which builds the control plane entitled to several schemas, over adding an owner-only cross-profile route inside FG-26 — a second privileged door weeks before the first one is built properly, and one that would have to be unbuilt again. Two consequences are written into FG-26 because both are silent-failure shaped: a `profile` naming another profile must be **refused with 409 before anything is created**, not ignored, and must leave no orphan GoTrue account; and with one shared `auth.users`, "every account on the box" and "the people enrolled in this brain" are different sets, so listing the former in a profile console is a data-exposure bug rather than a copy nit. Also recorded: adding an existing account to a second profile is an **enrolment** — no new invitation, password untouched — which is the common case under this topology and a dead end if the form treats a duplicate email as an error. | Leo, this session: *"owner/admin select which profile a new user should belong to"*, then option 1 (current profile now, real picker with FG-28) when asked when the cross-profile picker should work. The rescope itself was the pass I had flagged twice as blocking FG-26. |
| 2026-10-25 | 29 | devin:workflow (for Yan) | FG-33 | **Phase 8 added: FG-33 vibe-coded apps (local and external), status PLAN.** New FG doc with design, data model, five dependency phases (P8-0 → P8-4) with file-owned work items, per-phase system tests and cloud-agent prompts; indexed in §3, §5 (waves P8-A → P8-E) and `agent-prompts.md`. Proposes **D21** (external hosting of agent-built apps), which would extend **D3** and scope **D4** to Aquarium-hosted data (external apps use supabase.com) — both touched only as proposals, pending Leo/Yan; no contract changes. Twenty-one open decisions are listed. | Yan: "I want to allows users to vibe code within Aquarium but with two different approaches … Please create a plan first." The chief open question is what "its own supabase database instance" means on this box: a full Supabase stack per app fits only 2–3 apps in ~9 GB of free RAM, so the recommendation is a database per app per mode in one dedicated, memory-capped apps Postgres cluster (B2) with Supabase APIs per-app opt-in — which departs from the literal wording and is left for Leo/Yan to confirm; capacity is then disk-bound (~6 apps before FG-31's watch line), hence a disk decision. The work is phased so contracts and the Core-boundary prerequisites land before any agent-written code runs on the box, and so items inside a phase own disjoint files and can run as parallel agents. |
| 2026-10-25 | 30 | devin (for Yan) | FG-33 | Yan answered FG-33 open decisions 1, 10, 13, 15: own Supabase database per local app (not instance); default provider accounts with default-or-own per external tool; spend caps per project and per account; `internal-coder` / `external-coder` profiles with per-tool override. | FG-33 §Decisions recorded |
