---
title: "feat: site-to-schema — study a source site and keep its content in a per-site database schema"
status: approved — implementation in progress
date: 2026-11-10
type: feature
origin: >
  Leo — "A new skills for studying and extracting webpage content from a source site and turn it
  into internal database schema ... given a login URL and login credentials, it will first study
  the site without login, then, login and study the rest of the site and come up with a database
  schema to store all the information about this site. ... fixed and variable. For fixed content
  ... versioning ... For variable content ... check and insert/update new data overtime. It should
  also recommend or ask users for clarification if it should assume the data can be added
  incrementally or must recheck from scratch."
depends_on:
  - skills/research/auth-web-crawler (login + crawl building block)
  - hermes_cli/access.py (ensure_read_role, grant_item), hermes_cli/datastore_binding.py (SchemaClaim)
  - hermes_cli/credential_store.py (saved logins)
  - agent-home Settings (role-gated options), menu registry / per-role nav
---

# Site-to-schema

## 1. Decisions (from Leo)

| # | Decision |
|---|---|
| D1 | General feature for every install. First real test site: HSDOS WMS (`https://hsdos.eshf-it.com/`) on the HSD install (`home.hsd.hangsengdev.com`). |
| D2 | One new database schema per source site (`site_<slug>`). The requester owns it and can grant access to other users. |
| D3 | Who may create a site: owner + admin by default; configurable in Settings by owner/admin (`sites.create_roles`). |
| D4 | Access = access to the data by any means **inside Aquarium**: agent-home Sites page (browse, filter, CSV/XLSX export) and the agent (chat). No direct database port is opened. |
| D5 | The agent decides fixed vs variable. Paginated, table, list or collection data is variable; the rest is fixed. Each decision carries a reason. |
| D6 | The agent stops for approval of the design before creating tables or loading data. |
| D7 | Refresh is configurable per site / per entity: manual "Refresh now" and an optional schedule. Incremental where a reliable date/ID/cursor exists, full re-check otherwise; the agent asks when unsure. |
| D8 | Content that disappears is marked removed (`_removed_at`), never deleted. Columns are never dropped automatically. |
| D9 | No crawl limits are imposed by the feature; use of the data is the user's responsibility. Crawling stays read-only on the source: only login, search, filter, date-range and pagination submissions; never save/add/edit/delete/logout/change-password. |
| D10 | The site login is saved in the box's credential store so the backend can refresh on its own (no AI in the refresh loop). |

## 2. Architecture

```
 study (agent + skill)                       refresh (backend, no LLM)
 ─────────────────────                       ─────────────────────────
 public crawl → login → explore     ┌──────► recipe runner (Playwright) ──► records
       │                            │                                         │
       ▼                            │                                         ▼
 design.json + recipe.json ──approve┘                          SiteWriter (hermes_cli/site_sources)
       │                                                                      │
       ▼                                                                      ▼
 site_db tool ───────────────────────────────────────────────►  schema site_<slug> (restricted role)
                                                                              ▲
 agent-home /sites  ◄── /api/sites/* (role + grant checked) ──────────────────┘
```

Why harness code and not a skill only: per-site schemas, per-site restricted DB roles and
owner/grantee enforcement must be server-side; a skill would need the full database password,
which reaches every other schema.

## 3. Contracts (shared by all workstreams)

### 3.1 App tables (app database, `public`)
- `site_sources(id uuid pk, slug text unique, name, base_url, login_url, credential_ref text, owner_user_id, profile, status [draft|studying|awaiting_approval|active|paused|error], schema_name, db_role, schedule_cron text null, default_refresh_mode [incremental|full], created_at, updated_at)`
- `site_source_grants(site_id, user_id, grant [read|admin], granted_by, created_at, revoked_at)`; the owner is implicit admin. Box admins/owners can see every site.

### 3.2 Per-site schema `site_<slug>` (created by the harness, owned by role `site_<slug>_rw`)
- `_meta(key text pk, value jsonb)` — site id, design version.
- `_designs(version int pk, design jsonb, recipe jsonb, status [proposed|approved|superseded], proposed_at, approved_by, approved_at)`
- `_runs(id uuid pk, mode [incremental|full], trigger [manual|schedule|agent], started_at, finished_at, status [running|ok|partial|error], pages int, inserted int, updated int, removed int, versions int, error text, detail jsonb)`
- `_fixed_versions(entity text, content_key text, version int, content_hash text, payload jsonb, valid_from timestamptz, valid_to timestamptz null, run_id uuid, primary key(entity, content_key, version))`
- One table per **variable** entity, named from the design, with the design's typed columns plus standard columns:
  `_key text primary key, _hash text, _payload jsonb, _first_seen timestamptz, _last_seen timestamptz, _removed_at timestamptz null, _run_id uuid`
- `_changes(id bigserial, entity, key, run_id, op [insert|update|remove|restore|version], before jsonb, after jsonb, at timestamptz)`

### 3.3 Design document (`design.json`)
```json
{"version": 1, "site": "hsdos", "timezone": "Asia/Hong_Kong",
 "entities": [
   {"name": "rma_cases", "kind": "variable", "reason": "paginated search results table",
    "source": {"page": "/rma", "via": "search form"},
    "key": ["rma_no"],
    "columns": [{"name": "rma_no", "type": "text"}, {"name": "created_on", "type": "date"}],
    "refresh": {"mode": "incremental", "cursor": "created_on", "full_every": "P7D"},
    "question": null},
   {"name": "rma_reasons", "kind": "fixed", "reason": "small reference table",
    "source": {"page": "/administraion", "via": "RMA Reason Table"},
    "key": ["code"], "columns": [...], "refresh": {"mode": "full"}}
 ]}
```
`question` holds a clarification for the user when the agent cannot decide incremental vs full.
`timezone` (optional IANA name, default `UTC`) is the zone of the site's wall-clock times: the
writer stores a timestamp without an offset as that local time; one with an offset keeps it.

### 3.4 Extraction recipe (`recipe.json`)
Declarative, deterministic steps per entity, executed by the runner with no LLM:
`login` (url, username field, password field, submit, success check) and per entity a list of steps:
`goto`, `click` (selector/text), `fill` (selector, value | `{{cursor}}` | `{{today}}` | `{{date-N}}`),
`submit`, `wait`, `extract_table` (row selector, column→selector/header map), `extract_fields`
(fixed pages), `paginate` (next selector or page param, stop condition). Forbidden step targets
(save/add/edit/delete/logout/change password) are rejected by the runner.

### 3.5 Python interfaces
- `hermes_cli/site_sources.py` (workstream A): registry CRUD, `provision_schema(site)`, `apply_design(site, version)` (create/alter tables, additive only), grants, `SiteWriter`:
  `begin_run(mode, trigger) -> run`, `upsert(entity, records)`, `record_fixed(entity, key, payload)`,
  `finish_run(run, full_entities=[...])` (marks unseen rows removed only for entities refreshed in full), `query(site, sql, params)` (read-only, restricted role, `search_path=site_<slug>`).
- `hermes_cli/site_recipe_runner.py` (workstream B): `run_recipe(recipe, credential, *, entities=None, mode, cursors) -> Iterator[ExtractedItem]` where `ExtractedItem = (entity, kind, key, payload)`.
- Agent tool `site_db` (workstream A): `list_sites`, `get_design`, `propose_design(design, recipe)`, `query(sql)`, `refresh(entities?, mode?)`, `run_status`. No `apply` — approval happens in agent-home or by the owner saying so in chat (tool `approve_design` only for site owner/admin principals).

### 3.6 REST (`hermes_cli/web_server.py`, proxied by agent-home BFF)
- `GET/POST /api/sites`, `GET/PATCH/DELETE(=pause) /api/sites/{id}`
- `GET /api/sites/{id}/designs`, `POST /api/sites/{id}/designs/{v}/approve`
- `GET/POST/DELETE /api/sites/{id}/grants`
- `POST /api/sites/{id}/refresh` `{entities?, mode?}`; `GET /api/sites/{id}/runs`
- `GET /api/sites/{id}/tables`, `GET /api/sites/{id}/tables/{entity}?q=&page=&include_removed=`
- `GET /api/sites/{id}/tables/{entity}/export?format=csv|xlsx`
- `GET /api/sites/{id}/history/{entity}/{key}`
- Settings: `sites.create_roles` (default `["owner","admin"]`).
Every route checks principal + site grant server-side; non-grantees get 404.

## 4. Workstreams

| WS | Scope | PR |
|---|---|---|
| A | Registry, schema/role provisioning, grants, `SiteWriter`, `site_db` tool, REST, Settings option, scheduler + Refresh now (calls `run_recipe`) | backend |
| B | Skill `skills/research/site-to-schema/` (study → classify → design + recipe → approval → first load), `site_recipe_runner.py` with a local fixture site for tests | skill + runner |
| C | agent-home `/sites` page: list, detail (design approval, tables, history, removed rows, runs, sharing, schedule, export), menu entry; mockup first | UI |
| D | Integration on HSD: save HSDOS login, study, approve, first load, scheduled refresh, access checks | test |

## 5. Testing
- Unit: design → DDL (additive only), writer semantics (insert/update/version/remove/restore), removal only on full runs, grant checks on every route, forbidden recipe steps.
- Fixture site (local HTTP server mimicking a login + paginated table + reference page) for runner and end-to-end.
- Live: HSDOS on the HSD box, read-only.
