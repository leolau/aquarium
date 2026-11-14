# Data dictionary (semantic layer) for Supabase data — plan

Status: **planning** · Owner: Yan · Started 2026-11-14

Let the agent answer questions from the data in Aquarium's own Supabase
(site schemas and app data) correctly and safely, using a reviewed **data
dictionary** per data source instead of one skill per table.

## Progress

| Phase | What | Status |
|---|---|---|
| 0 | Evaluation of the "MCP + skills" proposal, decisions, UI mockups | Done (mockups approved) |
| 1 | Safe access and richer discovery | Done (PR #921, draft) |
| 2 | Dictionary store, versions, sharing, API | Done (PR #921, draft) |
| 3 | Study → propose, and the `data-questions` skill | Done (PR #921, draft) |
| 4 | agent-home UI (`/data`) | Done (PR #921, draft; browser-tested at 390/768/1440 px) |
| 5 | Improve over time: chat suggestions, answer feedback, Needs You | Built (PR #921); browser test in progress |
| 6 | Schema change check (no model) | Not started |

Log:
- 2026-11-14 — Evaluated the hybrid "MCP for access, skills for semantics"
  proposal against the code (below). Scope and approval rules decided by Yan.
  Figma mockups created on page "Inner — Data dictionary" of the agent-home
  design file (`34Afz0PSb8yqWX8DIkjF32`): 5 desktop screens, 4 phone screens
  and interaction notes.
- 2026-11-14 — Mockups approved; Data lives at `/data` (linked from the System
  hub). Phase 1 started: `site_db` action `describe` (tables with row counts,
  or one table's columns with fill, distinct counts and common values).
- 2026-11-14 — Security finding (verified on Postgres 16): a read-only SELECT
  can call `set_config('hermes.principal_role','owner',true)` and then read
  every row under the `hermes_scope_read` rules, because those rules trust
  client-settable settings. Many app tables (projects, runs, …) have no row
  rules, and some hold credentials. So agent-written SQL must never run against
  app tables directly. Site schemas are not affected (own login, own schema).
- 2026-11-14 — D7 decided (private copy). Built `hermes_cli/app_data.py` and
  `site_db` actions `app_describe` / `app_query`; `hermes db migrate` creates
  the sandbox login. Before every question the sandbox login is checked: if it
  can read any table or run a SECURITY DEFINER/dblink function, the question is
  refused. Each area copies at most 50,000 rows. Projects and runs are not
  areas yet: they live in the box's SQLite `projects.db`, not Supabase.
- 2026-11-14 — Phase 1 done: `describe` takes `q` keywords (name, reason,
  column names). Site tables have no `COMMENT ON` text; the design's reasons
  serve instead. App-data tests also pass on Supabase's Postgres image.
- 2026-11-14 — Phase 2 done: `hermes_cli/data_dictionary.py` (tables
  `data_sources`, `data_source_grants`, `data_dictionary_versions`; one open
  draft and one approved version per source) and `/api/data/*`. One app source
  per profile plus one per site; a new site source starts from its approved
  design's reasons as v1. Approve names the draft version and may reject
  tables, which keep their approved text. Restore copies an old version into a
  new approved one. Access: manage (profile owner/admin, source owner, site
  admin), propose and read by grant; site readers read their site's dictionary.
- 2026-11-14 — Phase 3 done: `site_db` actions `dictionary`, `study` and
  `propose_dictionary` (source = site slug or `app`), and the `data-questions`
  skill. Decided with Yan: the app source's dictionary is visible only to the
  instance owner and admins until shared. The "Build dictionary" button
  (Phase 4) will start a chat that runs `study`.
- 2026-11-14 — Phase 4 done in agent-home: `/data` (source list),
  `/data/[id]` (version bar, table list / phone picker, entry, history with
  Restore, Edit sheet, Share sheet, Build dictionary opens `/chat?new=1&draft=`
  unsent), `/data/[id]/review` (current vs proposed per table, accept/reject,
  Approve pinned on phones, Discard). `/api/data/*` BFF proxies, a Data card
  in the System hub, en + zh-Hant strings. Edit covers meaning, row, grain and
  columns; joins, metrics and examples come from chat/study for now.
- 2026-11-14 — Phase 4 browser test (local backend + real Postgres, test
  users) found and fixed: phone Approve bar covered by the launchers, ⓘ hint
  overflowing on phones, and Share saying "Everyone already has access" when
  the people list failed to load. Root `.gitignore` rule `data/` hid
  `agent-home/src/**/data/` from Tailwind's source scan, so their classes were
  never generated; fixed with `!agent-home/src/**/data/`. Known, not fixed:
  not-found pages return HTTP 200 (Next.js streaming), breadcrumbs stay
  English in zh-Hant (as on every page), the source list uses stacked rows,
  not Figma's searchable table. CI green.
- 2026-11-14 — Phase 5 built (details under Phase 5 below). Backend tests incl.
  real Postgres, agent-home tsc, ESLint and Vitest pass. Not deployed.

Next steps (for whoever picks this up):
1. Finish the Phase 5 browser test: answer footer (needs an assistant message
   ending in a `data-answer` block), Yes/No feedback, `data_draft` Needs You
   card and its count in the badge/title.
2. Phase 6: scheduled schema-change check (below).
3. Before deploy: run `hermes db migrate` (creates the sandbox login and the
   dictionary tables), then re-run the `/data` browser test on production.
   Read `production/PRODUCTION.md` in `leolau/aquarium-ops` first.

## 1. Decisions

| # | Decision | By |
|---|---|---|
| D1 | Scope: Aquarium's own Supabase — site schemas (`site_<slug>`) and app data. Other engines (SQL Server, MySQL, …) are out of scope for now. | Yan |
| D2 | The data source's owner approves its dictionary. The owner can share the source with other users. Owner and admin roles always have access. | Yan |
| D3 | No skill per table. One procedure skill; meaning lives in the dictionary (data), next to its data source, with the same access rules. | plan |
| D4 | No new MCP server: access goes through built-in, service-gated code that runs as the signed-in person. | plan |
| D5 | Only approved dictionary versions are used for answers. Everything the agent or a user suggests goes into a draft. | plan |
| D6 | New UI is mocked up in Figma first and approved before code. | Yan |

| D7 | Agent SQL reaches app data through a per-question private copy: app code copies the rows the person may see from approved areas (todos, goals, files, inbox) into temporary tables, and the SQL runs as `aquarium_data_sandbox`, a login that can read no real table. | Yan |
| D8 | The UI lives at `/data`, linked from the System hub. | Yan |

## 2. Evaluation of the "MCP + skills" proposal

| Proposal | What Aquarium already has | Verdict |
|---|---|---|
| MCP server for `list_tables` / `describe_table` / `execute_query` | `site_db` (per-site restricted role, propose/approve design, query) and `mssql_query` (list, describe, bounded read-only query) are built-in, service-gated tools. App data has RLS (`hermes_cli/access.py`) bound to the requesting principal. | Extend built-in code (Footprint Ladder rungs 1–3) |
| Semantics in skills | Skills are shared by everyone on a profile, but data access is per person / per grant | Store the dictionary as data with the source's visibility |
| Generated skills via `skill_manage` | Agent-created skills are guarded and profile-wide | Use propose → approve on the dictionary instead |
| MCP servers publishing skills | Not supported; the MCP client handles tools, resources and prompts | Not used |

Why not a generic database MCP: it holds one database login that reaches
every schema, so per-person and per-site isolation would rest on the model.
The site-to-schema plan rejected a skill-only design for the same reason.

## 3. Security rules (all phases)

- Agent-written SQL never runs against app tables directly: the `hermes.*`
  principal settings are client-settable, so a SELECT can rebind itself as
  owner (see log). App data goes through the D7 mechanism.
- Site schemas keep their per-site read role and `site_source_grants`.
- Read-only transaction, one statement (`SELECT`/`WITH`), parameters instead of
  pasted values, statement timeout, row and byte caps.
- Each query is logged with person, source, dictionary version and row count.
- Credentials never reach the agent terminal.

## 4. Phases

### Phase 1 — Safe access and richer discovery
- A data-source registry covering site schemas and app-data areas, with owner,
  grants and visibility.
- Principal-bound, read-only query path for app data (site schemas reuse
  `site_db`).
- Better `describe`: primary/foreign keys, `COMMENT ON` text, row estimates,
  a few distinct sample values; `list_tables` with search.
- Delivered by extending existing tools, not a new core tool. Tests for RLS
  scoping, unbound refusal, caps and timeouts against a real Postgres.

### Phase 2 — Dictionary store and API
- Tables for dictionaries, versions (draft / approved / superseded), entries
  (table meaning, grain, columns, joins, metrics, verified examples, glossary)
  and source grants (`read` / `propose`).
- Owner approves; owner/admin always have access; grantees by level.
- `/api/data/*` endpoints for list, read, draft edits, approve, restore,
  sharing.

### Phase 3 — Study → propose, and the procedure skill
- When the study runs: at schema creation (the approved site design seeds v1),
  on demand ("Build dictionary"), or when the agent meets an undescribed table
  (it answers from structure, says so, and drafts an entry).
- Tool actions `dictionary` and `propose_dictionary`.
- One `data-questions` skill: read the dictionary, describe, write
  parameterised SQL, check caps, show the query, say which version was used,
  ask when unclear.

### Phase 4 — agent-home UI
- Screens as mocked: Data list, Dictionary, Review draft, Share; phone layouts.
- Back button and breadcrumb on every screen, busy/disabled buttons, ⓘ hints,
  no sideways scrolling at 320 px.

### Phase 5 — Improve over time
- Chat suggestions ("revenue excludes refunds") become draft changes.
- "Was this right?" on answers: Yes saves a suggested verified example; No
  asks for the correction and drafts a fix.
- Needs You cards for drafts ready, schema changes and suggestions.
- Built: answers from data end with a hidden `data-answer` block; agent-home
  shows "Based on … dictionary vN · tables", Show SQL, an undescribed-table
  warning and "Was this right?". Yes calls `POST /api/data/sources/{id}/feedback`
  (propose access), which adds the question and SQL to the table's examples in
  the draft with `origin=feedback`. No asks for the correction in chat. Each open
  draft on a source the caller manages is one `data_draft` Needs You card
  ("N changes · from a chat") linking to its review page; schema-change cards
  come with Phase 6.

### Phase 6 — Schema change check
- Scheduled backend job (no model) compares each schema with its approved
  dictionary, marks changed entries stale, and raises a Needs You item; the
  agent can then propose the update.

### Later (not scheduled)
- Other engines (SQL Server, MySQL, SQLite) as adapters behind one interface.
- Embedding search over large dictionaries.

## 5. Testing
- Unit and real-Postgres tests per phase (scoping, grants, caps, versioning).
- Browser test of the UI at 390, 768 and 1440 px against a faked backend, then
  on production after deploy.
