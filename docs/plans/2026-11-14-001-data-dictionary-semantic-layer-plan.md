# Data dictionary (semantic layer) for Supabase data — plan

Status: **planning** · Owner: Yan · Started 2026-11-14

Let the agent answer questions from the data in Aquarium's own Supabase
(site schemas and app data) correctly and safely, using a reviewed **data
dictionary** per data source instead of one skill per table.

## Progress

| Phase | What | Status |
|---|---|---|
| 0 | Evaluation of the "MCP + skills" proposal, decisions, UI mockups | Mockups done, waiting for approval |
| 1 | Safe access and richer discovery | Not started |
| 2 | Dictionary store, versions, sharing, API | Not started |
| 3 | Study → propose, and the `data-questions` skill | Not started |
| 4 | agent-home UI (`/data`) | Not started (mockups ready) |
| 5 | Improve over time: chat suggestions, answer feedback, Needs You | Not started |
| 6 | Schema change check (no model) | Not started |

Log:
- 2026-11-14 — Evaluated the hybrid "MCP for access, skills for semantics"
  proposal against the code (below). Scope and approval rules decided by Yan.
  Figma mockups created on page "Inner — Data dictionary" of the agent-home
  design file (`34Afz0PSb8yqWX8DIkjF32`): 5 desktop screens, 4 phone screens
  and interaction notes.

## 1. Decisions

| # | Decision | By |
|---|---|---|
| D1 | Scope: Aquarium's own Supabase — site schemas (`site_<slug>`) and app data. Other engines (SQL Server, MySQL, …) are out of scope for now. | Yan |
| D2 | The data source's owner approves its dictionary. The owner can share the source with other users. Owner and admin roles always have access. | Yan |
| D3 | No skill per table. One procedure skill; meaning lives in the dictionary (data), next to its data source, with the same access rules. | plan |
| D4 | No new MCP server: access goes through built-in, service-gated code that runs as the signed-in person. | plan |
| D5 | Only approved dictionary versions are used for answers. Everything the agent or a user suggests goes into a draft. | plan |
| D6 | New UI is mocked up in Figma first and approved before code. | Yan |

Open: where the UI lives (`/data` linked from the System hub, as mocked, or a
Dictionary tab on `/sites` plus a separate app-data entry).

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

- Every query runs with a principal bound (`hermes.*` settings) on a role
  that does not bypass RLS. An unbound connection sees every row, so the
  query path refuses to run without a principal.
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
