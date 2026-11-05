# agent-home — test plan (routes × roles × features)

Scope: every page route under `agent-home/src/app` (every `page.tsx`, incl. dynamic ones) and
every major feature of the primary UI. For each: what to check, per role,
expected result, privacy assertions, automation level and set.

- **Set**: **Q** = quick smoke (run after every deploy, ~1–2 min, all automated in
  [`scripts/smoke/agent_home_smoke.py`](../../scripts/smoke/agent_home_smoke.py));
  **F** = full regression (before a release / after risky changes).
- **Automation**: **unit** = co-located Vitest (`agent-home/src/**/*.test.ts(x)`) or
  pytest; **HTTP** = the smoke script (stdlib, no browser); **browser** = a human
  or a browser agent driving agent-home.
- **Roles**: anon (logged out) · viewer · member · admin · owner. The smoke test
  accounts are `devin-test-viewer@…`, `devin-test-member@…`, `devin-test@…`
  (admin), all profile `default`; credentials live only in
  `/root/.aquarium-smoke.env` on the box. Owner-only behaviour is checked as
  "admin gets 403"; positive owner checks are manual (no owner test account).

Reused, not duplicated here:

| Suite | Covers |
|---|---|
| [`projects-uat.md`](projects-uat.md) | Full projects lifecycle (create → clarify → board → cards → runs → outputs → done/archive), scenario by scenario. The **F** rows for projects below point at it. |
| [`uat-hermes-systest.md`](uat-hermes-systest.md) | Deployment truth (revision, units, no root, drift), FG-24 memory ownership, box-level checks. Retarget to the Hetzner box ([`PRODUCTION.md`](../deployment/PRODUCTION.md)). |
| [`scripts/live_access_check.py`](../../scripts/live_access_check.py) | Release gate against the Python API with throwaway users: tool limits per role, file confinement, chat privacy/identity, approvals, network folders, secret exposure. Run it in **F** for every access-related change. |

## How to read "expected"

Next.js App Router streams server `redirect()` / `notFound()` *inside an HTTP
200*: a protected page fetched logged out is `200` with
`NEXT_REDIRECT;replace;/login`; a missing dynamic resource is `200` with
`NEXT_HTTP_ERROR_FALLBACK;404`. The smoke script asserts these markers, not the
status. Middleware (`guardAgentHomeRequest`) answers a real JSON `403` for
disallowed origins/methods. Page markers are the existing `data-component`
attributes; every signed-in page renders `RootLayout`, `MobileShell` and
`StatusStrip`.

Role shorthand in tables: **all** = viewer, member, admin, owner;
**mgmt** = admin, owner.

## 1. Page routes (34)

| # | Route | Check (markers) | anon | viewer / member | admin / owner | Privacy assertion | Auto | Set |
|---|---|---|---|---|---|---|---|---|
| 1 | `/` | home cards `PrincipalCard`, `ProjectsHomeCard`, `LogoutButton` | → `/login` | renders, own name | renders | principal card shows the caller only | HTTP | Q |
| 2 | `/login` | `LoginForm`; bad password refused, no cookie | renders | → `/` | → `/` | error does not reveal whether the account exists | HTTP + unit | Q |
| 3 | `/setup` | `SetupChecking` (first-run setup probe) | renders | renders (no shell) | renders | no secrets/config values in HTML | HTTP | F |
| 4 | `/activate/[token]` | bogus token → `ActivateForm` (redeem fails on submit); real invite → sets password | renders | renders | renders | token never echoed back; redeemed token can't be reused | HTTP (bogus) / browser (real) | F |
| 5 | `/survey/[token]` | bogus → `SurveyLinkInvalid` | renders | renders | renders | invalid token reveals nothing about the survey | HTTP | F |
| 6 | `/fb/[token]` | feedback link page | → `/login` | renders shell | renders | another user's feedback token shows nothing of theirs | HTTP (shell) / browser | F |
| 7 | `/onboarding` | `OnboardingWizard` | → `/login` | renders | renders | — | HTTP | F |
| 8 | `/chat` | `ChatPane`, `Composer`, `ProfilePicker`, `SessionTabs` | → `/login` | renders | renders | session tabs list only own chats | HTTP + browser | Q |
| 9 | `/projects` | `ProjectsList`, `ProjectsFilters`, `NewProjectAction` | → `/login` | renders, only visible projects | renders, shared + own | private/unshared projects of others absent | HTTP | Q |
| 10 | `/projects/new` | `NewProjectForm` | → `/login` | renders (viewer: create refused server-side) | renders | — | HTTP + browser | F |
| 11 | `/projects/[slug]` | `ProjectDetailView` (`--write` creates one); missing slug → 404 page | → `/login` | own/shared only; others → 404 | renders | unlisted slug → 404, not 403 | HTTP | Q (404) / F |
| 12 | `/projects/[slug]/cards/[id]` | card detail, run history | → `/login` | visible project only | renders | card of an invisible project → 404 | browser ([projects-uat](projects-uat.md)) | F |
| 13 | `/projects/[slug]/runs/[runNo]` | run detail, outputs | → `/login` | visible project only | renders | same as 12 | browser ([projects-uat](projects-uat.md)) | F |
| 14 | `/todos` | `TodosList` | → `/login` | own/granted only | renders | others' to-dos absent | HTTP | Q |
| 15 | `/todos/[id]` | detail + history; missing → 404 page | → `/login` | own/granted; others → 404 | renders | invisible == absent (404) | HTTP (404) / browser | F |
| 16 | `/inbox` | `InboxView` | → `/login` | own arrivals | renders | others' incomings absent | HTTP | Q |
| 17 | `/inbox/[id]` | detail; missing → 404 page | → `/login` | own; others → 404 | renders | invisible == absent | HTTP (404) / browser | F |
| 18 | `/files` | `FilesView`, `FilesTabs` | → `/login` | own files | renders | other users' files absent | HTTP | Q |
| 19 | `/files/browse` | `BrowseView`, `FilesTabs` | → `/login` | own places only | renders | can't list outside own places (`/api/browse/list` w/o params = 400) | HTTP + live_access_check (b) | F |
| 20 | `/files/bridge` | `FilesTabs`, folder bridge | → `/login` | renders | renders | — | HTTP | F |
| 21 | `/bridge` | bridge landing | → `/login` | renders | renders | — | HTTP | F |
| 22 | `/memory` | `MemoryView` | → `/login` | own rows | renders | FG-24: can't erase memory about others ([systest B](uat-hermes-systest.md)) | HTTP + browser | Q |
| 23 | `/graph` | `GtsCentreView` | → `/login` | renders | renders | — | HTTP | F |
| 24 | `/core` | `CoreAreaView` | → `/login` | renders | renders | — | HTTP | F |
| 25 | `/activity` | `TraceTimeline` | → `/login` | own traces | renders | others' traces absent | HTTP | F |
| 26 | `/activity/[traceId]` | missing → `TraceDetailError` | → `/login` | own trace only | renders | another user's trace id → error, no content | HTTP (missing) / browser | F |
| 27 | `/capacity` | `CapacityView` | → `/login` | renders | renders | — | HTTP | F |
| 28 | `/models` | `ModelsView` | → `/login` | renders | renders (+ pin/fallback edit) | — | HTTP + browser | Q |
| 29 | `/tools` | `ToolsRegistry` | → `/login` | renders | renders | — | HTTP | Q |
| 30 | `/tools/[name]` | missing → `ToolsError`; real → tool detail | → `/login` | renders | renders | — | HTTP (missing) / browser | F |
| 31 | `/settings` | `SettingsView`, `AccountSecurity` | → `/login` | own account | renders + admin sections | — | HTTP | Q |
| 32 | `/settings/tools` | `ToolsSettings`, `RoleLimitsSection` | → `/login` | renders read-only | editable | role-limit edits refused for non-mgmt (API 403) | HTTP + browser | F |
| 33 | `/settings/get-ready` | `GetReadyView` | → `/login` | own checklist | + people list | `/api/get-ready/people` 403 for viewer/member | HTTP | F |
| 34 | `/profiles/suggestions` | `ProfileSuggestionsView` | → `/login` | renders | renders | — | HTTP | F |
| 35 | `/webview` | `WebviewConsole` | → `/login` | renders | renders | session bound to caller | HTTP | F |
| 36 | `/users` | `UsersView`, `DirectoryPanel`; mgmt adds `CreateUserForm`, `UsersList`; others `UsersReadOnlyNotice` | → `/login` | read-only directory | full roster + create/import | `CreateUserForm`/`CsvImportPanel`/`UserRow`/`IdentityActivityPanel` never in viewer/member HTML; directory carries no e-mail | HTTP | Q |
| 37 | `/members` | legacy alias | → `/users` | → `/users` | → `/users` | — | HTTP | F |
| 38 | `/not-available` | `NotAvailableForRole` (middleware rewrites a menu item hidden from the caller's role here; URL unchanged) | → `/login` | renders | renders | hidden page's data never rendered; matching APIs answer 403 | HTTP | F |
| 39 | `/profiles` | `ProfilesView` (owner/admin); others `NotAvailableForRole` | → `/login` | not available | card grid + editor + new-profile dialog | no filesystem paths in HTML; `/api/profiles*` 403 for viewer/member | HTTP + browser | F |
| 40 | `/skills` | `SkillsView` (owner/admin); others `NotAvailableForRole` | → `/login` | not available | installed skills + Skills hub | `/api/skills*` 403 for viewer/member | HTTP + browser | F |

One row per `page.tsx` (the "34 routes" in the brief predates a few additions;
the tree has 40 today). `tests/scripts/test_agent_home_smoke.py` fails if a
`page.tsx` is added without a smoke `PageSpec`, so this table and the script
stay in step.

## 2. BFF `/api/*` reads (role matrix)

The authoritative policy is [`route-roles.json`](../../agent-home/src/lib/auth/route-roles.json)
(public / signed-in / admin / owner / internal). The smoke script's `APIS`
table mirrors it for every read-only GET that needs no path parameter:

| Class | anon | viewer | member | admin | owner | Examples |
|---|---|---|---|---|---|---|
| signed-in | 401 | 200 | 200 | 200 | 200 | `/api/status/summary`, `/api/chat/sessions`, `/api/projects`, `/api/todos`, `/api/files`, `/api/memory/rows`, `/api/models/overview`, `/api/activity/running`, `/api/settings/menu` |
| signed-in, needs a query param | 401 | 400 | 400 | 400 | 400 | `/api/chat/messages`, `/api/browse/list`, `/api/files/by-path` |
| admin | 401 | 403 | 403 | 200 | 200 | `/api/comms/members`, `/api/get-ready/people`, `/api/profiles`, `/api/security-basics`, `/api/skills`, `/api/settings/apps/{github,limits,storage}`, `/api/tools/personal-mcp/people` |
| owner | 401 | 403 | 403 | 403 | 200 | `/api/google-client`, `/api/backups/offsite` |
| internal | 401 | 401 | 401 | 401 | 401 | `/api/notifications/config` (server-to-server only) |
| missing resource | 401 | 404 | 404 | 404 | 404 | `/api/projects/<missing>`, `/api/todos/<missing>`, `/api/incomings/<missing>` |

Q runs the signed-in core + every admin/owner denial; F runs all of them.
Unit coverage: route handlers' co-located `route.test.ts`, the route-role
registry test, and `tests/hermes_cli/test_route_authorization.py` for the Python side.

## 3. Features

| Feature | What to check | Per role | Privacy assertion | Auto | Set |
|---|---|---|---|---|---|
| Login / logout | password login sets `__Host-agent_home_session` (Secure, HttpOnly); bad password → 4xx and no cookie; logout clears the session; anon pages → `/login` | all roles log in; anon redirected | session cookie never readable by JS; status cache keyed by `sha256(token)`, never the raw token | HTTP (Q), unit (`lib/auth`, `api/session/*`) | Q |
| Coral menu | menu opens from every page (`CoralHost`), entries follow the registry; mgmt-only entries hidden for viewer/member | viewer/member: no Users-admin/Settings-apps entries; mgmt: all | hidden entries' routes still enforce server-side (API 403) | unit (menu registry), browser | F |
| Status strip | `StatusStrip` on every signed-in page; `/api/status/summary`: cpu/mem/disk 0–100, tokens ≥0, counts ≥0, `cron_enabled ≤ cron_total`, `collected_at` fresh, `build` set; served build == checkout `HEAD` (or no agent-home change since) | all signed-in; `upload_storage` only for mgmt | member payload carries no admin-only storage data | HTTP (Q), unit (`api/status/summary`) | Q |
| Chat | create (`/api/chat/new`), send, stream, rename, archive/unarchive (`?archived=only`), search (`/sessions/search`), tags (`/sessions/tags`), filters, profile switch (`ProfilePicker`, `/api/chat/profiles`) | all can chat; viewer per tool limits | list = own chats only; another user's session id → 404 on messages (`--write` checks member + viewer); profile switch stays within allowed profiles | HTTP (`--write`: create/rename/archive/read/delete), [live_access_check](../../scripts/live_access_check.py) (c, d), browser for streaming | Q (`--write`) / F |
| Projects create → done | create (`[smoke]` private project), detail/board/runs/changes/directives/playbook/events/doctor reads, list, page renders, archive + `purge=smoke` delete; full flow in [projects-uat](projects-uat.md) | member/admin create; viewer refused | private project: member/viewer → 404 and not listed; admin-visible but unlisted slugs → 404 for member/viewer (read-only probe) | HTTP (`--write`), browser ([projects-uat](projects-uat.md)) | Q (`--write`) / F |
| Todos | list, facets, detail, stage changes | own/granted | invisible == absent (404) | HTTP, unit | Q (list) / F |
| Inbox | list, facets, open an arrival, convert to to-do | own | others' incomings absent | HTTP, browser | Q (list) / F |
| Files | list, surfaces, browse places, by-path, upload, remember | own | live_access_check (b): no read of another user's folder or system files | HTTP, live_access_check | Q (list) / F |
| Memory | projection + rows render; edit/forget own rows | own | FG-24 ([systest B](uat-hermes-systest.md)) | HTTP, browser | Q (rows) / F |
| Capacity | `CapacityView` renders; indicators sane | all | — | HTTP | F |
| Models | overview/options/pinned/fallback/performance; pin + fallback edit (mgmt) | read: all; edit: mgmt | — | HTTP, browser | Q (overview) / F |
| Tools | registry, tool detail, personal MCP list + catalog; settings/tools role limits | read: all; personal-mcp/people + limit edits: mgmt | member can't see others' personal MCP servers | HTTP, live_access_check (a) | Q (registry) / F |
| Settings | account security, apps (github/limits/storage: mgmt), get-ready, credentials, telegram bot, email | own; mgmt for apps | credential values never returned (only `set`/`last4`) | HTTP, browser | Q (account) / F |
| Members / users | `/users` directory for all, roster/create/CSV import for mgmt, `/members` → `/users` | viewer/member read-only notice; mgmt manage | no e-mails in directory; admin-only components absent from member/viewer HTML; `/api/comms/members*` 403 | HTTP | Q |
| Onboarding / setup | `/setup` first-run probe, `/onboarding` wizard, `/activate/[token]` invite redemption, get-ready checklist | anon for setup/activate | invite tokens single-use; setup leaks no config | HTTP (render), browser (real invite: see `live_access_check` provisioning) | F |

## 4. Running

- **Quick (after every deploy)**: see “Post-deploy smoke test” in
  [`agent-home/README.md`](../../agent-home/README.md#post-deploy-smoke-test).
  `--quick` limits pages/APIs to the **Q** rows; the default run covers every
  automated **HTTP** row; `--write` adds the project/chat lifecycle.
- **Full regression**: default + `--write` smoke, then
  `scripts/live_access_check.py` on a test install, then [projects-uat](projects-uat.md)
  and the browser rows above.
- Unit: `npm run --prefix agent-home test`; pytest for `tests/hermes_cli/` and
  `tests/scripts/test_agent_home_smoke.py`.

### Test-data cleanup (`purge=smoke`)

`--write` and the browser suites remove the `[smoke]` projects they create
with `DELETE /api/projects/<slug>?confirm=<slug>&purge=smoke` (BFF →
`DELETE /api/registry/projects/<slug>`), so a run leaves nothing behind. The
purge is refused unless the project is archived, is test data by name
(`[smoke]…` name or `smoke-…` slug), the caller is a verified human who
created it (instance owner/admin or project lead is not enough), no run is
queued/running/waiting, and `confirm` names the slug. It deletes the project
and its `project_*` rows, its board's cards and each run's chat session, clears
the active pointer, detaches the schedule, and writes a `project_purged` line
to `$HERMES_HOME/logs/dashboard-auth.log`. Every other project keeps the plain
delete, which refuses anything with history. Tests:
`tests/hermes_cli/test_projects_api_smoke_purge.py`.
