# FG-36 — Short refs (`P12`, `T345`, `P12-R3`, `C1024`, `D88`, `M512`)

People refer to projects, cards, runs and chats in later prompts. Internal ids
(`t_1a2b3c4d`, UUIDs, 16-hex session ids) are not typeable or memorable, so
every such item gets a **short ref**: a type letter plus a running number that
is unique on the box.

## Requirement (from Leo)

> "Add a display a unique ID for each task/project and chat session (anything
> else you can suggest) so that it becomes easier to reference in the
> other/future prompts. Make sure such unique ID is short enough (I don't want
> a 16 digits ID) so that it is easy to type, remember and reference."

Approved format: **type letter + running number, unique on the box**.

## Format

| Ref | Names | Number source | Scope | PR |
|-----|-------|---------------|-------|----|
| `P12` | project | registry | box-wide | 1 |
| `T345` | project card (kanban task linked to a project) | registry | box-wide (row records the board) | 1 |
| `P12-R3` | run 3 of P12 | **derived**: project ref + existing `project_runs.run_no` | follows the project | 1 |
| `C1024` | chat (conversation) | registry | per profile (row records it) | 2 — built |
| `D88` | to-do | registry | per profile (row records it) | 3 — built |
| `M512` | inbox message | registry | per profile (row records it) | 3 — built |

Rules:

- Parsing is case-insensitive (`p12` = `P12`), surrounding whitespace is
  ignored, numbers have **no leading zeros** (`P012` is not a ref), and a run
  suffix only follows a project (`T3-R1` is not a ref). Python
  `hermes_cli/short_refs.py#parse_ref` and agent-home `src/lib/refs.ts#parseRef`
  are the two (mirrored) parsers.
- A ref is a **display handle**. Internal ids, slugs and URLs stay
  authoritative and keep working everywhere; nothing is renamed.
- A ref is assigned once and **never changes**, including on rename. A
  deleted item's number is never reused.
- Numbers are per kind (`P1` and `T1` can both exist).
- Existing items are numbered in **creation order** by a one-time backfill
  the first time a kind is touched.

## Registry (`hermes_cli/short_refs.py`)

One SQLite file, `short_refs.db`, **beside `projects.db`** in the shared root
(`projects_db_path()`), because projects and kanban are box-wide and the
dashboard, gateway, cron and CLI processes must agree on a number.

```
short_refs(kind, num, internal_id, profile, board, created_at, assigned_at)
  PRIMARY KEY (kind, num)
  UNIQUE (kind, profile, board, internal_id)
short_ref_backfills(kind PRIMARY KEY, done_at)
```

- **Allocation** is `MAX(num)+1` inside `sqlite_util.write_txn()`
  (`BEGIN IMMEDIATE`): concurrent writers serialise on SQLite's write lock, and
  the primary key is the backstop. Tested with parallel processes.
- **`profile`** is `""` for the box-wide kinds (P, T) and the owning profile
  for C, D, M, so a resolver can check authority *in that profile*.
- **API:** `assign()` at create (projects: `projects_db.create_project`; cards:
  `kanban_db.create_task` when the task is linked to a project),
  `ensure_refs()` batch lazy assignment for items created by paths that don't
  call `assign` (every project list/detail and board/card read calls it),
  `lookup(ref)` → `(kind, internal_id, profile, board)`, `run_ref()`.
  `*_quietly` variants never fail the surrounding create/read: a registry
  problem costs the badge, not the project.
- **Backfill**: `BACKFILL_SOURCES` maps a kind to its existing items (`P` →
  projects by `created_at`, `T` → project-linked cards by `created_at`);
  `backfill()` runs once per kind, oldest first, then marks the kind done in
  `short_ref_backfills`. `D` → every profile's to-dos by `created_at`, `M` →
  every profile's inbox messages by `registered_at` (PR 3), `C` → every
  profile's chats (compression roots) by `started_at` (PR 2).

## Surfaces (PR 1)

- **API payloads:** `ref` on project list/detail rows, board tasks, card
  detail; `ref` (`P12-R3`) and `project_ref` on run brief/list/detail rows;
  `ref` on a run's cards. Project search (`q`) matches a project ref, and a
  project ref is accepted wherever a project slug is.
- **Resolver:** `GET /api/refs/{ref}` → `{ref, kind, id, title, status, url,
  …}`. It reuses the projects read gate (`_load_ctx_sync` + `_can_read`) and
  the private-card rule (`_card_visible`). **Not found and not allowed are the
  same 404** ("ref not found"), so a ref never confirms that something hidden
  exists.
- **agent-home:** BFF `GET /api/refs/[ref]` (`signed-in`), `/go/[ref]`
  redirect page (in-app paths only), `RefBadge` (tap to copy) on project
  rows, the project header, board tiles, card detail and the run header; a ref
  typed into the projects search shows an "Open P12" jump.
- **CLI + skill:** `hermes ref <ref> [--actor] [--json]` prints the same
  resolution as the API (Footprint Ladder rung 2 — no new model tool);
  documented in `skills/productivity/projects/SKILL.md`.

## PR 2 — chats (`C`) and ref mentions (built)

- **One ref per conversation.** Compression ends a session row and continues
  under a new id (`parent_session_id`), so a `C` row keys on the
  conversation's **compression root** (`SessionDB.get_compression_root`) and
  records its profile (sessions live in each profile's `state.db`). The
  resolver walks forward to the live tip (`get_compression_tip`), the session
  the chat list shows. A branch is its own conversation (own ref); delegate
  subagent runs and `tool` children are never numbered. Code:
  `hermes_cli/chat_refs.py`.
- **Assignment:** `POST /api/sessions` (agent-home's new chat) assigns at
  create and returns `ref`. Gateway, CLI, cron, project-run and to-do
  sessions are created on many paths, so they are numbered lazily by the
  reads (`ensure_refs`): `GET /api/sessions`, `/api/profiles/sessions`,
  `/api/sessions/{id}` and `/api/sessions/search` all carry `ref`.
  Backfill (`BACKFILL_SOURCES["C"]`) numbers every profile's existing chats
  box-wide in `started_at` order.
- **Search:** a `C` ref typed into `/api/sessions/search` leads with that
  chat when it lives in the searched profile; the agent-home sidebar filter
  matches a chat ref exactly (`c1` never matches `C10`).
- **Resolver authority:** `refs_api.resolve_for_request` authorises a
  profile-scoped kind **in the item's profile**: the caller is re-resolved
  there with the chat routes' own `_chat_principal` (FG-28: not enrolled /
  suspended → no principal), then the chat routes' visibility rule applies
  (`_chat_scope_for`: the owner sees every chat, anyone else only their own).
  Not visible, other profile and missing are the same 404. D and M keep their
  own re-resolution inside `profile_refs` (`CALLER_SUBJECT`). `hermes ref C<n>` acts as the CLI actor in every profile.
- **URL:** `/chat?session=<tip>&profile=<profile>`; `/go/C1024` redirects
  there, and the chat page switches profile on arrival.
- **agent-home:** the ref shows on session chips (`SessionTabs`), sidebar
  rows (`SessionRow`, copyable `RefBadge`), the inline chat header
  (`LandingChatView`), above the transcript (`ChatConversationView`) and in
  the conversation details (`SessionModal`).
- **Mentions** (`hermes_cli/ref_mentions.py`): when the sender's typed text
  names refs (`REF_IN_TEXT_RE`), the agent-home chat turn endpoints
  (`/api/sessions/{id}/chat` and `/chat/stream`) resolve each through
  `resolve_for_request` under the turn's principal and append one line per
  visible ref to **that same user turn**:

  ```
  compare P12 with C1024

  [Referenced items]
  - P12 · project · Monday digest · active · /projects/monday-digest
  - C1024 · chat · Q3 budget · open · /chat?session=…&profile=default
  ```

  The block is persisted with the turn, so later turns replay it
  byte-identically (prompt caching); the system prompt and past turns are
  never touched and no synthetic message is added. Unresolvable or hidden
  refs are skipped silently, at most `MAX_EXPANDED` (5) distinct refs expand,
  and kinds are generic (D and M expand through their own resolvers). The
  sender's bubble hides the block (`stripRefMentions`).
- **Why the Python chat entry, not the BFF:** the BFF would need one extra
  round trip per ref and could not reuse the per-profile chat authority the
  Python routes already hold. The gateway and CLI are *not* wired: a gateway
  sender only becomes a principal inside the channel-binding seam (often with
  no principal store at all), and the CLI is the operator's own terminal;
  there `hermes ref` (documented in the projects skill) covers lookups. Wiring
  them is additive: call `ref_mentions.expand_with` with a resolver bound to
  that surface's principal.

## PR 3 — to-dos (`D`) and inbox messages (`M`)

To-dos live in Postgres `tasks` (`hermes_cli/todo_store.py`) and inbox
messages in `inbound_items` (`hermes_cli/inbound_registry.py`), both in each
profile's own app schema. `hermes_cli/profile_refs.py` is the glue between
those async stores and the sync registry; the rows record the profile.

- **Assignment** at the stores' single write paths, after the row exists:
  `TodoStore.create` (a newly inserted row — a deduped collapse onto a live
  to-do gets no second number), which covers the to-dos API, `hermes todos
  add` and the triage bridge; `InboundRegistry.register`, which covers the
  gateway mirror, the email/IMAP pollers and `hermes incomings backfill`
  (a re-polled arrival keeps its ref). `profile_refs.assign` never fails the
  write.
- **Backfill** (`todo_items`, `message_items`): every profile from
  `profiles_to_serve(multiplex=True)`, each read in that profile's scope with
  an owner-role binding (the tables' RLS is FORCEd, and the registry numbers
  every row whoever may see it). A profile whose datastore is unreachable is
  skipped and its rows are numbered lazily on read.
- **Payloads:** `ref` on to-do list/detail/create and inbox list/detail
  (`profile_refs.attach` = `ensure_refs` in the current profile).
- **Search:** a `D`/`M` ref typed into the to-dos / inbox search (`q`) puts
  that item first on the first page, read through the store's own scoped
  `get` (nothing is pinned when the ref names nothing visible in this
  profile); the text still runs as an ordinary search, as project search does
  since #820, so "M3" in a mail subject is still found.
- **Resolver:** `D`/`M` read through `TodoStore.get` / `InboundRegistry.get`
  (C2 scope + RLS) **in `record.profile`**. In the acting profile the caller's
  principal is used as the to-do / inbox routes use it; for another profile
  the caller is re-resolved there (verified login subject, else the
  principal's user id → alias → live principal), never that profile's owner.
  Not enrolled, suspended, invisible and absent are all the same 404. The
  response carries `profile`; `url` is `/todos/<id>` / `/inbox/<id>`.
- **agent-home:** `RefBadge` on to-do and inbox rows and detail pages;
  `RefJump` ("Open D88") under both search boxes; `/go/D88`, `/go/M512`.
- **CLI:** `hermes ref D88` / `hermes ref M512` (prints the profile);
  documented in the todos and incomings skills.

## Decisions made in PR 1

- **`T` covers project cards only.** Agent-home shows (and the resolver can
  authorise) cards through their project; a bare kanban task outside any
  project has no agent-home page, so numbering it would hand out refs that can
  only ever 404. Extending `T` to all kanban tasks later is additive.
- **Refs are not reused** after a delete; a gap in the sequence is fine.

## Decisions made in PR 3

- **Creation order for inbox messages is `registered_at`** (when the box
  learned of the arrival), not `occurred_at`: a backfill of last year's mail
  is numbered after this morning's live messages, and a number never depends
  on a sender's clock.
- **A ref opens in the session's profile.** agent-home's `/todos/<id>` and
  `/inbox/<id>` pages read in the profile the session is on, so `/go/D88` for
  a to-do in another profile resolves (and names that profile) but its page
  answers not-found until the user switches profile. Carrying the profile
  through the redirect is a follow-up once those pages take one.
