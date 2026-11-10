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
| `C1024` | chat (conversation) | registry | per profile | 2 |
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
  every profile's inbox messages by `registered_at` (PR 3); C adds its source
  in its PR.

## Surfaces (PR 1)

- **API payloads:** `ref` on project list/detail rows, board tasks, card
  detail; `ref` (`P12-R3`) and `project_ref` on run brief/list/detail rows;
  `ref` on a run's cards. Project search (`q`) matches a project ref, and a
  project ref is accepted wherever a project slug is.
- **Resolver:** `GET /api/refs/{ref}` → `{ref, kind, id, title, status, url,
  …}`. It reuses the projects read gate (`_load_ctx_sync` + `_can_read`) and
  the private-card rule (`_card_visible`). **Not found and not allowed are the
  same 404** ("ref not found"), so a ref never confirms that something hidden
  exists. Reserved kinds (C, D, M) answer 404 until their PR.
- **agent-home:** BFF `GET /api/refs/[ref]` (`signed-in`), `/go/[ref]`
  redirect page (in-app paths only), `RefBadge` (tap to copy) on project
  rows, the project header, board tiles, card detail and the run header; a ref
  typed into the projects search shows an "Open P12" jump.
- **CLI + skill:** `hermes ref <ref> [--actor] [--json]` prints the same
  resolution as the API (Footprint Ladder rung 2 — no new model tool);
  documented in `skills/productivity/projects/SKILL.md`.

## PR 2 — chats (`C`), not built here

- Sessions live in each profile's `state.db` (`hermes_state.py`), so a `C`
  row records the profile. **Compression** ends a session and starts a new
  session id with `parent_session_id`; the ref belongs to the
  **conversation**, so the registry row keys on the conversation's root
  session id and the resolver walks `parent_session_id` to the newest
  descendant (or the new session inherits the ref at compression time). A
  chat never gets a second `C` number because it was compressed.
- Resolver authority: the caller must be allowed to see that session in that
  profile (the existing sessions/chat visibility rules), else 404.
- **Mentions:** when a user's message contains visible refs (`P12`, `C1024`,
  …, word-bounded — `short_refs.REF_IN_TEXT_RE`), agent-home attaches a one-line
  description of each visible item **to that user turn only**. It never
  edits the system prompt or past turns (prompt caching), never inserts a
  synthetic message (role alternation), and silently skips refs the sender
  may not see.

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
- **Search:** a `D`/`M` ref typed into the to-dos / inbox search (`q`) returns
  exactly that item through the store's own scoped `get` — or nothing, when
  the ref names nothing in this profile. Other filters are ignored for a ref.
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
