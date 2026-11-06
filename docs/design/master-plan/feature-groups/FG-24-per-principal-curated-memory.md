# FG-24 — Per-principal curated memory (memory layers 1–2 become per-user)

**Wave:** P6-A (Phase-6) · **Owner agent:** _unassigned_ · **Status:** DONE — implemented, deployed and system-tested on `hermes-systest` 2026-08-12 (**amended 2026-08-10** — see "Person level vs participation level" below). The follow-ups about the *rest of the box* not knowing the new layout are closed (reset/delete/clone 2026-08-16; doctor, dashboard and Journey graph 2026-11-01) — see "Closed — the layout outside the memory tool"

## Summary

Today memory layers 1–2 (`MEMORY.md` + `USER.md`) are **profile-scoped**: one
pair of files under `$HERMES_HOME/memories`, frozen into the system prompt at
session start, shared verbatim by every principal in the deployment, on a
single shared character budget (2200 / 1375) that is **already at its ceiling**
(peak 2029 chars, writes refused). In a one-owner deployment this is correct.
With hundreds of principals in one profile it is incoherent: a file whose
stated purpose is "what the agent knows about *the user*" cannot serve 500
different users, and every personal fact competes for the same budget.

This FG splits the curated tier in two: a **shared** block (org/class knowledge,
owner/admin-writable, everyone reads) and a **per-principal** block (this user's
own curated facts, their own budget, invisible to everyone else). Both are
frozen at session start exactly as today, so the prompt-cache invariant is
untouched.

## The prompt-cache question — resolved, with evidence

The original constraint (recorded in D2 and repeated in the FG-01 rationale)
was that curated memory must stay instance-wide because *per-user prompt blocks
would fragment the upstream prompt cache*. **Re-examined against the current
code, that constraint does not hold**:

1. `agent/prompt_caching.py` implements a single layout, `system_and_3`: **four
   `cache_control` breakpoints — the whole system prompt, plus the last three
   non-system messages.** There is no breakpoint at the end of the `stable`
   tier, so a partial system-prompt prefix is never independently cacheable.
2. `agent/system_prompt.py` already appends, as the last element of the
   `volatile` tier, a line containing `Conversation started: <date>` and
   (when `pass_session_id`) `Session ID: <session_id>`, plus model/provider.

Together these mean **the system prompt is already unique per session**, so
cross-user or cross-session prefix sharing does not exist today and cannot be
lost by this change.

The invariant that *does* matter — the system prompt must be **byte-identical
for every turn within one conversation** — is fully preserved: `MemoryStore`
is constructed once in `agent_init` and `load_from_disk()` captures a frozen
snapshot; reading a *different* file per principal is exactly as stable as
reading the same one. Mid-session writes continue to change disk only, never
the live prompt.

**No change to D2 is required; this FG records the narrower reading:** curated
memory must be *frozen per session*, not *identical across sessions*.


## Amendment (2026-08-10) — person level vs participation level

**This FG as written puts *all* per-user memory inside the profile. That is
wrong for one of the two organisational shapes ai4all must serve.**

In a one-person company the founder is CEO, CTO, CMO and CFO — one person
participating in four sub-goal profiles (FG-29 §5). Under the design below,
their identity facts ("prefers concise answers", "based in Hong Kong", "two
children") would be written four times and then **drift apart**, so the same
person would be modelled slightly differently by each of their own instruments.

Split by *what the fact is about*, not by where it was learned:

| level | file | scope | example |
|---|---|---|---|
| **person** | `USER.md` | shared across that person's participations | "prefers concise answers; based in Hong Kong" |
| **participation** | `memories/users/<user_id>/MEMORY.md` | one profile only | "the Q3 cashflow model lives in …" |

One person, one profile-of-self, N working memories. The isolation that matters
— what the founder is *doing* in finance staying out of the product instrument —
is preserved; what is duplicated and drifting today is eliminated.

The unit of isolation is therefore **participation = (person × profile)**, not
"user in profile". Everything below applies at the participation level except
`USER.md`, which is person-level.

Rationale is recorded in FG-29's audit log (edition 2).

## Decisions applied

- **D2 (hybrid memory consistency)** — unchanged. Curated durable facts stay a
  frozen prompt snapshot; volatile state stays tool-call-queried.
- **D1 (multi-user, three-tier visibility)** — this FG brings memory layers 1–2
  into line with it. They are currently the only tier that ignores C2.
- Consumes **C1** (`Principal`) and **C2** semantics (shared vs. private), but
  adds **no new contract** — the per-user split is expressed with the
  principal that `agent_init` already has.

## Reuse map

- `tools/memory_tool.py` — `get_memory_dir()`, `MemoryStore`,
  `load_from_disk()`, `_system_prompt_snapshot`, `format_for_system_prompt()`,
  `_file_lock()`, `_sanitize_entries_for_snapshot()`. All reused; the change is
  a **scope parameter**, not a new store.
- `agent/agent_init.py:1245` — where `MemoryStore` is constructed. The
  principal identity is **already** threaded to this point: `agent._user_id`
  exists, and `principal_user_id` / `principal_role` are already passed into
  the memory-provider init kwargs a few lines below. No new plumbing.
- `agent/system_prompt.py` `volatile_parts` — where the blocks are appended.
- `hermes_cli/access.py` C1 `Principal` + `_validate_user_id` (the `user_id`
  charset guard is what makes a `user_id` safe as a **path component**).

## Design / approach

### 1. Directory layout

```
<root>/persons/<user_id>/USER.md         # person level — shared across their participations
$HERMES_HOME/memories/                  # $HERMES_HOME is the PROFILE's home
    MEMORY.md                           # shared org/class knowledge (existing file, unchanged path)
    USER.md                             # DEPRECATED at instance scope — see migration
    users/
        <user_id>/MEMORY.md             # this participation's working memory
```

**Deviation from the layout first sketched above (`users/<user_id>/USER.md`),
as required by the 2026-08-10 amendment.** `USER.md` is *person* level, and
`$HERMES_HOME` is *profile* level, so a per-user file under the profile home
would reintroduce exactly the N-drifting-copies problem the amendment removes.
Identity therefore lives one level up, outside any profile home, at
`<root>/persons/<user_id>/USER.md`, where `<root>` is derived from the
*effective* home (`<root>/profiles/<name>` → `<root>`), so a multiplexed
gateway turn scoped with `set_hermes_home_override()` resolves it too.
Consequence: there is no shared `USER.md` tier and therefore **three** snapshot
blocks, not four (see §2).

`users/<user_id>/` is safe as a path because `_validate_user_id` already
restricts `user_id` to `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` on every write
path — no separators, no traversal. The resolver must still `resolve()` and
assert containment under `memories/users/` (defence in depth, fail-closed).

### 2. Scope parameter

`get_memory_dir(user_id: str | None = None) -> Path` — `None` returns the
shared directory (today's behaviour, so every existing caller and test is
unaffected); a `user_id` returns the per-principal directory.

`MemoryStore(..., user_id: str | None = None, role: str | None = None)`
resolves all tiers: `load_from_disk()` reads the shared `MEMORY.md`, the
participation `MEMORY.md` and the person `USER.md`, and captures **three**
snapshot blocks — `shared`, `memory`, `user`.

**Deviation:** the four-block shape (`shared_memory`, `shared_user`, `memory`,
`user`) assumed a shared *identity* file. The amendment makes identity
per-person, so `shared_user` has no referent and is not created — an empty
fourth block would be speculative surface.

`role` is the C2 role `agent_init` already resolved for the principal; it is
what §4's authority check consults. With `user_id is None` the store is the
pre-FG-24 single-principal store: the two original files, and no shared block.

### 3. Prompt assembly

`volatile_parts` gains the shared block first, then the per-principal block:

```
SHARED MEMORY (known by everyone in this profile)   …org/class knowledge…
MEMORY (your personal notes)                        …this participation's facts…
USER PROFILE (who the user is)                      …this person's identity…
```

(The existing block headers are kept verbatim for the two original tiers —
changing them would break the byte-identity guarantee below.)

Ordering is fixed and deterministic. When `user_id is None` (local CLI, no
identity) the per-principal blocks are absent and the output is
**byte-identical to today** — regression-locked by a baseline test.

### 4. Write routing + authority

| write | target file | who |
|---|---|---|
| `memory(action=add\|update\|remove, target=user)` | per-principal `USER.md` | the principal themself |
| `memory(... target=memory)` | per-principal `MEMORY.md` | the principal themself |
| `memory(... target=shared)` | shared `MEMORY.md` | **owner / admin only** |

Authority is checked in `MemoryStore.authorize_write()` and again at the tool
entry point *before* the write-approval gate, so a refused shared write is
refused and audited immediately rather than staged and rejected at approve
time. A staged write records the scope it was authored in (`user_id`, `role`),
because approval frequently happens from a context with no principal bound
(Desktop GUI, gateway `/memory approve`) — without it an approved
participation write would land in the profile-wide files.

With no principal bound, `target=shared` is **refused** rather than aliased to
`target=memory`: in a single-principal session `memory` already *is* the
profile's shared file, and two live entry lists pointing at one file is how
lost-update bugs start. The refusal message says exactly that.

`target=shared` is a new value. A non-owner/admin attempt is **refused with a
clear message** (not silently redirected), and the refusal is audited via C5 —
same shape *and the same emitter* as the existing Core write-guard refusal
(C7): `agent/core_boundary.emit_audit_event()` was extracted from
`record_core_denied()` so both write a durable JSONL row
(`$HERMES_HOME/audit/memory_authority.jsonl`) and forward to the FG-12 change
log / FG-16 trace sinks when registered. No DB is required for the audit, so
the refusal path cannot fail because Postgres is down. The agent must not be
able to talk its way into writing the shared block on a member's behalf.

### 5. Budgets

Each principal gets their **own** `memory_char_limit` / `user_char_limit`
(defaults unchanged). The shared block keeps its own budget. This dissolves the
current shared-ceiling contention: 500 principals × ~3.5 KB ≈ 2 MB on disk,
irrelevant, and each user's consolidation pressure is independent.

Config gains `memory.shared_memory_char_limit` (default: today's 2200) so the
shared block can be tightened once personal facts move out of it.

### 6. Concurrency

Per-principal files **reduce** contention: today 500 writers would serialise on
one `MEMORY.md.lock`. The existing `_file_lock` + atomic `os.replace` are reused
per file, unchanged.

### 7. Security

`_sanitize_entries_for_snapshot` (threat-pattern scan at snapshot-build time)
applies to the per-principal blocks unchanged — same code path. **This matters
more than before**: previously only the owner could write curated memory; now
any member can write content that lands in *their own* system prompt. The scan
already blocks injection/promptware patterns; the new test matrix must prove a
member cannot (a) poison another user's prompt, or (b) poison the shared block.

### 8. Relationship to layer 4

This FG covers curated (layer 1–2) memory only. The complementary piece —
surfacing a user's *semantic* (layer 4, pgvector) memories at session start via
the cache-safe `prefetch()` seam — is FG-21 P2 and stays there. FG-24 makes the
curated tier per-user; FG-21 makes the semantic tier actually get read. Neither
depends on the other.

## Data model

**No database change.** Curated memory stays a filesystem artifact of the
profile (D2/D4: SQLite + files for the agent core, Supabase for the application
layer). Moving it to Postgres was considered and rejected for this FG: it would
put a network round-trip on the session-start path, and the access control it
would buy is already provided by the filesystem split (a principal's session
only ever opens its own directory).

## Migration

1. The existing `memories/MEMORY.md` **stays where it is** and becomes the
   shared block. Zero data movement, and a single-user deployment behaves
   identically.
2. The existing instance-scoped `memories/USER.md` describes **the owner**. On
   the first owner-scoped session, its entries are written to
   `<root>/persons/<owner_id>/USER.md` verbatim and the original is renamed to
   `USER.md.pre-fg24` (kept as the backup). One-shot, idempotent (the rename
   removes the source; an existing person file is never overwritten), logged,
   and skipped entirely for non-owner principals so a member's session can
   never adopt the owner's identity as its own.
3. Per-principal files are created lazily on first write. A user with no file
   contributes no block.

## Dev/Prod + Supabase

Not applicable — no `app_*` tables. The per-principal directories live inside
the profile's `HERMES_HOME` and are covered by the existing backup path.

## Testing requirements

- **Baseline (required):** with `user_id=None`, `build_system_prompt()` output
  is byte-identical to pre-change for the same inputs (extends
  `tests/plan_baseline/`).
- **Cache invariant (required):** within one session, the assembled system
  prompt is byte-stable across turns after a mid-session memory write — the
  existing invariant, re-asserted for the per-user path.
- Snapshot isolation: two `MemoryStore`s for two principals produce disjoint
  blocks; user A's entries never appear in user B's snapshot.
- Path containment: a crafted `user_id` cannot escape `memories/users/`
  (belt-and-braces over `_validate_user_id`).
- Authority: `target=shared` refused for `member`/`viewer`, allowed for
  owner/instance-admin, refusal audited (C5).
- Threat scan applies to per-principal entries; a poisoned per-user entry is
  replaced by `[BLOCKED: …]` in that user's snapshot only.
- Budgets are independent: filling user A's `MEMORY.md` does not refuse a write
  by user B or to the shared block.
- Migration: idempotent; running twice does not duplicate the owner's profile;
  original preserved.
- Concurrency: parallel writes by two principals do not block or interleave.
- **Real resolution path (real Postgres, not mocks):** principals enrolled in
  two profiles' derived schemas, resolved through `bind_channel_principal`
  (C1), then the store built from the resolved identity — person A's working
  memory in profile X is unreachable from profile Y and from person B, and the
  authority matrix follows the role the `principals` table actually holds.
- **Load-bearing injection:** a real `AIAgent` turn with the provider call
  intercepted, asserting on the `system` message of the outgoing payload — so
  the tests fail if the blocks are rendered but never reach the model.

## System testing (system-test box)

Required before promotion, on `hermes-systest` against `app_dev`:
- ≥2 enrolled principals; each adds a curated fact; each session's prompt shows
  their own block and the shared block, and **not** the other's — verified from
  the real assembled prompt, not a unit stub.
- A member's `target=shared` write is refused on the live box and audited.
- Owner's existing memory survives the migration verbatim.

## Dependencies

- **Blocked by:** none (C1 already provides everything needed).
- **Blocks:** nothing hard. Ships independently of FG-25.
- **Related:** FG-21 (layer-4 recall, P2 `prefetch`), FG-05 (pgvector tier).

## Definition of Done

Baseline + cache-invariant tests green; per-principal isolation proven;
`target=shared` authority enforced + audited; migration idempotent;
`scripts/run_tests.sh`, `ruff`, `ty` clean; system-test checklist passed.

## Progress checklist

- [x] `get_memory_dir(user_id)` + `get_person_memory_dir(user_id)` + `MemoryStore(user_id=…, role=…)` + three-block snapshot
- [x] `agent_init` passes the resolved principal; `system_prompt` renders shared + participation + person
- [x] `target=shared` write path + owner/admin authority + C5 refusal audit
- [x] Independent budgets + `memory.shared_memory_char_limit` config
- [x] Migration (owner `USER.md` → `persons/<owner>/`, idempotent)
- [x] Tests: baseline byte-identity, cache invariant, isolation, containment, authority, threat-scan, budgets, concurrency, migration, real-Postgres resolution path, load-bearing injection
- [x] System test on `hermes-systest` passed — 2026-08-12, two enrolled
      principals (the live owner plus a temporary member, since deactivated),
      against real `MemoryStore` code in a copy of the live Hermes home.
      Evidence: each session rendered its own participation block and the shared
      block and neither saw the other's participation fact; the person-level
      block reached only its own person; the member's `target=shared` write was
      refused with the audited wording and landed in
      `audit/memory_authority.jsonl` as `memory_shared_write_denied` with the
      actor and role; the owner's `memories/USER.md` migrated to
      `persons/<owner>/USER.md` with every entry intact and the legacy file kept
      as `.pre-fg24` (the migration round-trips through the entry serialiser, so
      the copy differs from the original by a trailing newline).
- [x] Unscoped sessions: resolve the principal from the login user, else the
      setup/pairing binding, else ask once and remember (owner's decision,
      2026-08-12; implemented 2026-08-13 in `hermes_cli/principal_binding.py`).
      The ladder is: remembered binding → login subject (through
      `principal_aliases`, falling back to the subject itself) → the sole
      enrolled principal (the person who set the box up) → ask, but only when a
      terminal is attached, so a cron job or poller never blocks on a prompt.
      The answer is remembered per profile in `local_principal.json` and is
      re-validated every session: a binding whose person was un-enrolled is
      forgotten, and a role change is re-read rather than frozen into the file
      (a demoted admin must not keep shared-block authority).
      **Fails closed where it cannot resolve:** with two or more principals
      enrolled and no binding, `MemoryStore(unresolved_principal=True)` refuses
      every write target with an audited
      `memory_unresolved_write_denied` row and tells the caller to run
      `hermes member local-principal --set <user_id>`. Reads are untouched — a
      background job still sees what the profile shares. A deployment with one
      principal, or none reachable (no database configured), keeps the
      pre-FG-24 single-user path exactly as before.
- [x] Legacy maintenance paths know the FG-24 layout — reset, delete and
      `--clone-all` (2026-08-16), then `hermes doctor`, the dashboard memory
      status and the Journey graph (2026-11-01). See "Closed — the layout
      outside the memory tool".

## Closed — the layout outside the memory tool

Found on `develop` at `3afc06225` (2026-08-16): `tools/memory_tool.py` was the
only module that knew a participation or person file existed. Each finding and
its fix:

1. **Reset could not erase a person's curated memory** — fixed 2026-08-16
   (`9654eed6f`, `d82dafc79`). `hermes memory reset` and
   `POST /api/memory/reset` erase the caller's participation + person files
   through `curated_memory_files()` / `erase_curated_file()`, take the shared
   block only for `SHARED_WRITE_ROLES`, and list what they leave in place;
   member purge erases the departing person's files.
2. **`--clone-all` copied other people's participation memory** — fixed
   2026-08-16: `memories/users/` and `persons/` are excluded.
3. **`hermes doctor` and the dashboard showed only the two shared files** —
   fixed 2026-11-01: doctor lists per-user notes and person profiles (people,
   chars); `GET /api/memory` adds `per_person`, and System → Memory shows it
   with reset buttons named for what they erase.
4. **The Journey graph (desktop, TUI `/journey`, `hermes journey`) read and
   edited only `memories/MEMORY.md` + `memories/USER.md`** — found and fixed
   2026-11-01. `agent.learning_graph.memory_sources()` shows the profile's
   shared notes (`memory:shared:*`, editable by owner/admin only) plus the
   viewer's *own* participation notes and person profile; nobody else's file
   is listed. The viewer is the logged-in dashboard session, else the same
   local-principal ladder the agent uses; unresolved with several people
   enrolled shows the shared block read-only. A box with no principals keeps
   the pre-FG-24 two-file view.

## Audit log

| Date | Edition | Author | Change | Rationale |
|------|---------|--------|--------|-----------|
| 2026-11-01 | 6 | devin (for Leo) | Closed the last open item: doctor, dashboard memory status and the Journey graph now follow the FG-24 layout; "Open" section rewritten as "Closed" | Re-review of `develop` found the Journey graph (not in the original list) still read only the two shared files |
| 2026-08-16 | 5 | devin (for Leo) | Phase-6 close-out: status corrected to DONE, and the "legacy maintenance paths" item re-read against `develop` and rewritten as three named findings | The header still said `PLAN — not started` four days after the live system test, which is the one error that invites a cold agent to rebuild something already running on the box. Re-checking the follow-up item made it bigger than the "maintenance/UX" note it carried: `hermes memory reset` and the dashboard's reset unlink only the two pre-FG-24 files while promising a blank slate, FG-26's hard delete deliberately does not cascade to files, so **no surface erases a person's curated memory at all**; and `--clone-all` copies `memories/` whole, handing every principal's participation memory to a profile that may enrol different people. Recorded, not fixed — the erase semantics are the owner's call (what should a reset destroy?), and `--clone-all`'s scope is a behaviour change. |
| 2026-08-13 | 4 | devin (for Leo) | Implemented the unscoped-session ladder (`hermes_cli/principal_binding.py`, `agent/agent_init.py`, `MemoryStore(unresolved_principal=…)`, `hermes member local-principal`). Scoped it to curated memory only. | The owner's answer resolves *identity*, so the tempting move was to set the session's principal globally — but `_internal_user_id` also keys session continuity (C4), todos and goals, and a locally-inferred principal changing a session key would silently split conversations. FG-24 owns memory, so the binding is applied where the hole is and the wider question stays with FG-28's identity forwarding. The remaining decision was what to do when the ladder ends without an answer: refusing *all* writes (not just `shared`) is the only honest option, because in an unscoped store `memory` **is** the shared file — a "safe" fallback to the person's own block does not exist to fall back to. Reads stay open so the digest and pollers keep their context. |
| 2026-08-12 | 3 | devin (for Leo) | Reviewed and system-tested on `hermes-systest`. Ticked the system-test item with its evidence and recorded the unscoped-session decision as the one open item. | Isolation, authority, the audited refusal and migration fidelity all hold live. The unscoped-session hole is a policy question the owner has now answered (resolve by login, else the setup/pairing binding, else ask once and remember), so it is written down as work rather than left as a review finding. |
| 2026-08-11 | 3 | devin (for Leo) | Implemented. Recorded three deviations: person identity lives at `<root>/persons/<user_id>/USER.md` (not under the profile home), three snapshot blocks instead of four (no `shared_user` tier exists after the amendment), and `target=shared` is refused rather than aliased in an unscoped session. | The amendment makes identity person-level while `$HERMES_HOME` is profile-level; storing `USER.md` under the profile home would recreate the drifting-copies problem the amendment exists to remove, and a `shared_user` block would have no referent. |
| 2026-08-10 | 1 | devin (for Leo) | Created FG doc | Scale-out to hundreds of principals in one profile makes an instance-wide `USER.md` incoherent and its shared 2200-char budget a hard blocker (already at 2029, writes refused). Investigation of `prompt_caching.py` (single `system_and_3` layout, one system breakpoint) and `system_prompt.py` (per-session `Session ID` line already in the volatile tier) shows the "per-user memory breaks the prompt cache" constraint does not hold — the prompt is already unique per session, and the real invariant (byte-stable within a conversation) is preserved by the existing frozen-snapshot mechanism. |

## Cloud-agent prompt

> **[Phase-6 Wave A — independent; may run in parallel with FG-25]** Repo
> `leolau/aquarium`, branch off `develop`. Read
> `docs/design/master-plan/README.md`, `AGENTS.md`, and this doc (FG-24). Split
> curated memory layers 1–2 into a **shared** block and a **per-principal**
> block. Add a `user_id` scope parameter to `get_memory_dir()` and
> `MemoryStore` (`None` ⇒ today's shared paths, byte-identical behaviour —
> regression-lock it); per-principal files live at
> `$HERMES_HOME/memories/users/<user_id>/{MEMORY,USER}.md`. `load_from_disk()`
> captures four frozen snapshot blocks; `agent/system_prompt.py` renders shared
> then per-user in the `volatile` tier. `agent/agent_init.py:1245` already has
> the principal in scope — pass it, do **not** add new plumbing. Add
> `target=shared`, writable by **owner/instance-admin only**, refusal audited
> via C5. Independent char budgets + `memory.shared_memory_char_limit`.
> One-shot idempotent migration of the owner's `USER.md` into
> `users/<owner_id>/`. **Do not** move curated memory into Postgres and **do
> not** touch `prompt_caching.py`. The system prompt must stay byte-identical
> across turns within a session (assert it) and byte-identical to pre-change
> when `user_id is None`. Tests: baseline, cache invariant, cross-principal
> snapshot isolation, path containment, `target=shared` authority + audit,
> threat-scan on per-user entries, independent budgets, concurrent writes,
> idempotent migration. Run `scripts/run_tests.sh`, `ruff`, `ty`. Edit ONLY
> this FG doc. Open a PR linking this doc.
