---
title: "feat: landing Incomings tab + running strip (part A) and per-project Skills (part B)"
status: part A approved — implementation in progress; part B awaiting decisions 6–8
date: 2026-11-11
type: feature
origin: >
  user request — "Landing page: left side panel, besides the chat sessions, add 1 more tab: Incomings which are all the
  scanned IM messages, emails and calendar event that the triage has already processed and flagged it needs users's
  attention; On the top, add a horizontal sessions to list all the actively running cards (the same as cron job, tasks,
  chat sessions, cards in projects) and a number of scheduled cards (this number/button is clickable and will bring user
  to the projects page); Projects page: for each project, I need an ui to allow user to view all the skills that have been
  used in this project so far, a way to work with AI to further improve these skills or create new skills"; then
  "break this plan down into two parts: a) landing page; b) projects page; Update the plan with multiple child sessions
  per part and save it. Run part (a) with multiple child sessions for max speed."
depends_on:
  - hermes_cli/inbound_registry.py, hermes_cli/incomings_api.py, triage_handlers (stamp_inbox_importance)
  - hermes_cli/activity_running.py, hermes_cli/projects_api.py (_list_sync)
  - hermes_cli/skill_ledger.py, hermes_cli/skills_usage_api.py, skills improve (Skills Lab)
  - agent-home/src/components/landing/** (TopBar, ChatsSidebar, WorkPanel), components/inbox/**, components/projects/**, components/skills/**
---

# Landing Incomings + running strip (A) and per-project Skills (B)

A clickable mockup was reviewed before this plan (screens: Landing, Projects › Scheduled, Project › Skills, Phone).
Style rules for all UI work: agent-home tokens in `globals.css`, the 280 px / 320 px landing columns, `TopBar`,
`ProjectTabsNav`, `InboxTabs`-style tabs, existing row/chip primitives; en + zh-Hant i18n for every new string.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Which arrivals "need you" | escalated by triage, **or** triage created a to-do, **or** a critical calendar event (default; Leo did not override) |
| 2 | What clears an item | only an explicit **Done** / **Dismiss** (Remember / to-do / reply do not clear) |
| 3 | Profiles with no triage source | show the tab, with an explanation in the empty state |
| 4 | Right panel "Working in the background" | keep it beside the new strip for now; WorkPanel stops polling separately |
| 5 | What "Scheduled N" counts | active project schedules + cards parked in `scheduled` (+ standalone scheduled jobs, admins only); split in the tooltip |
| — | Re-flag a cleared item | yes, when a new triage verdict ranks higher (e.g. a cleared meeting rescheduled into a conflict) |
| — | Out of scope for A | Telegram/escalations write-back, triage for personal mailboxes, to-dos started in a chat shown as running, project-less kanban cards |
| 6 | Who sees the project Skills tab | **open** — recommended: any project reader sees names + counts; Improve/Create need Skills `lab`/`manage` |
| 7 | Saving an AI-created skill | **open** — recommended: disabled draft-only skill trialled first (+~1 day) |
| 8 | Improve evidence scope | **open** — recommended: this project highlighted + summary of other uses |

---

## Part A — Landing page

### A.1 Incomings tab (left panel)
`Chats | Incomings (N)` switch under the New-chat button (`role="tablist"`, persisted with
`usePersistentState("aquarium.landing.leftTab")`, deep link `/?panel=incomings`). Incomings lists items where
`attention_at IS NOT NULL AND attention_cleared_at IS NULL`, grouped **Urgent** (reason `escalated` with high/urgent
priority, or `critical_event`) / **Needs a look** (the rest), filter chips All / Messages / Email / Calendar with counts,
each row: surface glyph, sender, subject/excerpt, relative time, triage reason line, hover/kebab actions (Done, Ask in
chat). Desktop: clicking a row opens the detail in the centre column of Home (reuse `IncomingDetailView` content) with
Reply with AI (new chat hand-off), Make a to-do, Remember, Add to project, Done (+ Undo toast), "Open in Inbox".
Phone: the Chats drawer gets the same switch; a tap opens `/inbox/{id}?from=landing` (back → `/`). Footer link
"Open Inbox →". Count hook polls like `useNeedsYou` (15 s while visible, keep last good, keyed by profile) and feeds the
tab badge and collapsed rail.

**API contract (shared by A3 and A4):**
- `inbound_items` gains `attention_at TIMESTAMPTZ`, `attention_reason TEXT ('escalated'|'todo'|'critical_event')`,
  `attention_cleared_at TIMESTAMPTZ`, `attention_cleared_by TEXT`, `attention_outcome TEXT ('done'|'dismissed')`;
  partial index on open items; `register` upserts never touch them; one-off backfill from `importance` + open inbound to-dos.
- `IncomingItem` gains `attention_at`, `attention_reason`, `attention_priority` (`urgent|high|medium|low|null`),
  `attention_cleared_at`, `attention_outcome`, `todo_count` (all nullable/optional).
- `GET /api/registry/incomings?attention=open|cleared|any` (default `any` = unchanged behaviour; `open` sorts newest first).
- `GET /api/registry/incomings/attention-count` → `{"count": 7, "urgent": 2, "by_surface": {"email": 4, "whatsapp": 2, "calendar": 1}}` (count capped at 99).
- `POST /api/registry/incomings/{id}/attention` body `{"action":"clear","outcome":"done"|"dismissed"}` or `{"action":"reopen"}` → the updated item; 400 bad body, 404 invisible; only the item owner may write.
- BFF mirrors: `GET /api/incomings?attention=`, `GET /api/incomings/attention-count`, `POST /api/incomings/{id}/attention` (signed-in, via `apiClientForRequest()` so `?profile=` is added).

### A.2 Running strip + Scheduled button
A ~44 px row under the 56 px header (`hidden lg:flex`): "Running N · W waiting", chip scroller (kind icon, name,
elapsed, status dot; waiting → long-running → running; each chip links to `item.href`), ‹ › edge buttons, pinned right
**◷ Scheduled N** → `/projects?view=project&schedule=set` with tooltip "3 projects · 2 cards · 1 job · next in 2h".
Hidden when nothing runs and nothing is scheduled; "Nothing running right now" + button when only scheduled. Stale →
`opacity-60`. Phone keeps `MobileActivityStrip` plus a compact ◷ N link and an "N scheduled → Projects" footer.
`HealthPill` drops its Scheduled metric. `WorkPanel` takes `activity` from props (one poll per page). Projects gets a
"Scheduled" filter chip (soonest first) and a "N cards scheduled" badge on rows.

**API contract (shared by A2 and A5):**
- `GET /api/activity/scheduled` (signed-in) → `{"total": 6, "projects": 3, "cards": 2, "cron_jobs": 1, "next_run_at": 1762850000|null}`; same permission helpers as `/api/activity/running` (`_can_read`, enrolled profiles, private cards owner-only, `cron_jobs` admins only else 0).
- `GET /api/registry/projects?schedule=set` → active projects with a schedule, ordered by next run asc; each project item gains optional `scheduled_cards: number` and `next_run_at`.
- BFF `GET /api/activity/running` → `{items, scheduled: ScheduledSummary | null}` (scheduled leg failure → `null`, not 502; same cache key).

### A.3 Child sessions for part A (run in parallel, one PR each into `develop`)
| Session | Scope | Depends on |
|---|---|---|
| **A1** | Security scoping fix for the cron jobs listing (details in the private ops tracker) + tests | — |
| **A2** | Backend: `scheduled_summary` + `GET /api/activity/scheduled`, `_list_sync ?schedule=set` (+ `scheduled_cards`, `next_run_at`), route-authorization entries, Python tests | contract A.2 |
| **A3** | Backend: `inbound_items` attention columns + backfill, `InboundRegistry.flag_attention/clear_attention/reopen_attention`, triage reason stamping + re-flag rule, the 3 routes, route-authorization, Python tests (incl. Docker-PG e2e) | contract A.1 |
| **A4** | Frontend: Incomings (BFF routes, client, types, `LeftPanelTabs`, `IncomingsPanel`, compact row, centre-column detail, mobile drawer, `/inbox/{id}?from=landing`, Done/Reopen on detail page, count hook, i18n, vitest) | contract A.1 (mock it) |
| **A5** | Frontend: running strip (BFF merge, client, types, `RunningStrip`, `ScheduledButton`, TopBar, HealthPill, WorkPanel single poll, mobile link, Projects "Scheduled" chip + badge, i18n, vitest/E2E) | contract A.2 (mock it) |

Merge order: A1 → A2/A3 → A4/A5 (frontends rebase on the backend PRs; conflicts expected only in `types/index.ts`,
`lib/api/client.ts`, i18n JSON and `route-roles.json`). Deploy to Hetzner + HSD after all five merge and smoke-test.
Estimate ≈ 7–8 dev-days of work, ~1 day wall-clock in parallel.

---

## Part B — Projects page (per-project Skills) — not started

New 5th tab group `overview | work | files | skills | setup` (`ProjectSkillsTab`): window select (30/90 days); stats
(skills used, times used, worked first time, worth improving); retro-suggested new skills ("Turn it into a skill" /
Dismiss); per-skill rows (uses, last used, worked/partial/failed bar, Preloaded / Created-here pills, "Uses" drill-down
reusing `SkillUsagePanel` filtered to the project, **Improve with AI**, link to `/skills/<name>`); "Preloaded but
unused". **Improve with AI** = side sheet reusing the Skills Lab improve chat, seeded with this project's runs (+ summary
elsewhere, decision 8), saving a draft version. **New skill with AI** = sheet: describe, tick cards to learn from, AI
drafts SKILL.md, refine in chat, Create (decision 7), optional "Preload in this project's runs".

**Contract:** `GET /api/registry/projects/{slug}/skills?days=90` →
`{window_days, totals:{skills, uses, first_time_success_rate, worth_improving}, skills:[{name, profile, category, source, version, uses, outcomes:{success, partial, failed}, rated_down, last_used_at, preloaded, created_here, trend}], unused_preloaded:[name], candidates:[{id, name, run, preview}]}`;
`GET /api/skills/usage/detail?...&project=<slug>`; `POST /api/skills/improve/start {..., project}`;
`POST /api/skills/create/start {profile, project?, goal?, candidate_id?, card_ids?}` + `POST /api/skills/create/message`.

### B.1 Child sessions for part B (start after decisions 6–8)
| Session | Scope | Depends on |
|---|---|---|
| **B1** | Backend: ledger project filter + index, `GET /api/registry/projects/{slug}/skills`, `?project=` on usage detail, candidates `dismissed_at`, permissions, tests | decision 6 |
| **B2** | Frontend: Skills tab group, stats, rows, drill-down sheet, unused, candidates, i18n, mobile, vitest | B1 contract (mock it) |
| **B3** | Full-stack: project-scoped Improve (seed `## This project` block, session tag `skill-improve-project:<slug>`, sheet using a hook extracted from `SkillImprovePanel`) | decision 8; B2 for the entry button |
| **B4** | Full-stack: Create skill with AI (`skills/create/*`, shared lab-session machinery, sheet, save + optional preload) | decision 7; B2 for the entry button |

B1–B4 can run in parallel against the contract; merge B1 → B2 → B3/B4. Estimate ≈ 5–6.5 dev-days, ~1 day wall-clock.

---

## Appendix A-1 — Incomings tab research

Repo `leolau/aquarium` @ `develop` 01ff13fd7. Scope: the left panel gets a **Chats | Incomings** tab switch. Incomings lists WhatsApp/email/calendar arrivals that triage flagged as needing the user, and the list empties as the user handles them.
Legend: **[V]** = checked in code, **[I]** = my inference.

### 1. What exists today (reusable)

| Piece | Where | Notes |
|---|---|---|
| Left panel shell | `components/landing/LandingLayout.tsx` (`sidebar` slot, `<aside id="landing-sidebar" aria-label="Chats">`, `PanelRail` label `t("panels.chats")`) | [V] 280px column, collapses to a 48px rail; collapse state lives in `useLandingPanels.ts` (`aquarium.landing.chatsCollapsed`). |
| Desktop list | `chats/ChatsSidebar.tsx` → `ChatsPanel.tsx` | [V] `ChatsPanel` holds NewChatButton, search, pinned/recent `<nav aria-label="Chats">`, "All chats" footer link. Props come from `LandingClient.tsx` (`chats = {profile: currentProfile, …}`). |
| Mobile list | `chats/ChatsDrawer.tsx` (full-height dialog, title "Chats") opened from the dock "Chats" button in `LandingClient.tsx` | [V] Renders nothing while closed, so nothing is fetched. |
| Inbox list + row | `components/inbox/IncomingsList.tsx`, `IncomingRow.tsx` (`surfaceGlyph`, `relativeWhen`, `timeRange`, `excerpt`, importance pill), `IncomingsFilters.tsx` | [V] Keyset paging over `GET /api/incomings`. Rows link to `/inbox/{id}?from=…`. |
| Detail page | `app/inbox/[id]/page.tsx` + `IncomingDetailView.tsx` | [V] Actions: "Remember this" (`POST /api/incomings/{id}/remember`), "To-dos from this" (`/todos?source_ref={id}&stage=…`), "Add to project" (`AddToProjectSheet`). `inboxBackHref(from)` only accepts a `?…` query, so Back always goes to `/inbox`. |
| BFF | `app/api/incomings/route.ts` (+ `[id]`, `facets`, `[id]/remember`, `[id]/tags`) → `HermesApiClient.incomings()` in `lib/api/client.ts` | [V] All are `signed-in` in `lib/auth/route-roles.json`. |
| Python API | `hermes_cli/incomings_api.py` (`list_incomings`, `incomings_facets`, `get_incoming`, `tag_incoming`, `remember_incoming`) | [V] `_comms_resolve_principal(allow_as=True)`; filters `importance`, `remembered`, `tag`/`exclude_tag`, `since`/`until`, keyset `cursor`, no total. |
| Store | `hermes_cli/inbound_registry.py` `InboundRegistry` (`list`, `facets`, `set_importance`, `id_for`, `mark_remembered`), table `inbound_items` | [V] C2-scoped through `scope_filter` + RLS. Schema is idempotent `SCHEMA_SQL` run by `initialize()` (`ADD COLUMN IF NOT EXISTS` style is already used for `file_assets`). |
| Triage → registry | `custom/shared/triage_handlers.py` `_triage_importance` / `stamp_inbox_importance` → `custom/shared/inbound_registration.py` `mark_importance` → `set_importance` | [V] Best-effort; it runs after the SQLite writes. |
| Triage → to-dos | `custom/shared/todo_registration.py` (`source_kind="inbound"`, `source_ref` = registry id via `id_for`, `stage="open" if notify else "staged"`, max 3 per batch) | [V] `GET /api/registry/todos?source_ref=` exists (`todos_api.list_todos`). |
| Badge/poll pattern | `lib/landing/needsYou.ts` `useNeedsYou` (15s poll while visible, refetch on focus, seen-set in localStorage) | [V] A good template for the tab badge. |
| Profile scoping | `hermes_cli/profile_route_scope.py` `require_profile_scope` (app-wide, FG-28 B4) + `HermesApiClient` adding `?profile=` (`apiClientForRequest`) | [V] `/api/registry/incomings*` is not under `BOX_WIDE_PREFIXES`, so a `?profile=hr` call re-resolves the caller in `hr` and holds `hr`'s app store. New routes in that module get this for free. |

### 2. What "needs the user's attention" means today (findings)

1. **`importance` mixes three vocabularies [V].** `_triage_importance` returns `escalation_priority` (`high|medium|low`, or `urgent` if missing) when `escalate` is true. Otherwise it returns `importance` (calendar: `critical|normal|low`) or, failing that, `classification`. WhatsApp classifications: `task|reminder|note|urgent_business|sales_opportunity|informational|ignorable`. Email classifications: `urgent_business|meeting|task|invoice|sales_opportunity|informational|newsletter|notification|personal|spam`. So `importance=low` can mean "escalated, low priority" or "unimportant calendar event". The column cannot answer "needs you?" by itself.
2. **The real triage signals [V]:** `escalate=true` (also written to SQLite `escalations` with status `pending→delivered→resolved`, and pushed to Telegram), and to-dos created by triage (`tasks` rows with `source_kind='inbound'`, `source_ref=<item id>`, stage `open` when `notify`, else `staged`).
3. **No handled/read/dismissed state on `inbound_items` [V].** Only `remembered_at` and tags exist. SQLite `escalations.status='resolved'` is set only by the WhatsApp/email MCP servers and is not mirrored [V].
4. **Gaps [V]:** personal mailboxes (`email_poller._register_personal_message`) bypass triage entirely, so they never get a verdict. `mark_importance` always resolves the *install owner* (`_resolve_owner`), so it can only stamp the owner's rows. Standalone triage writes into the default profile's schema [I: the pollers run under the default `HERMES_HOME`]. So in a named profile the tab will normally be empty (see Q4).

### 3. Proposed design

**Rule (one place, server side):** an item is in Incomings when `attention_at IS NOT NULL AND attention_cleared_at IS NULL`.

#### 3.1 DB (`inbound_items`, added to `SCHEMA_SQL`, idempotent)
```sql
ALTER TABLE inbound_items
  ADD COLUMN IF NOT EXISTS attention_at         TIMESTAMPTZ, -- triage flagged it
  ADD COLUMN IF NOT EXISTS attention_reason     TEXT,        -- 'escalated' | 'todo' | 'critical_event'
  ADD COLUMN IF NOT EXISTS attention_cleared_at TIMESTAMPTZ, -- user handled it
  ADD COLUMN IF NOT EXISTS attention_cleared_by TEXT,
  ADD COLUMN IF NOT EXISTS attention_outcome    TEXT;        -- 'done' | 'dismissed' | 'todo' | 'remembered' | 'replied'
CREATE INDEX IF NOT EXISTS inbound_items_attention_idx
  ON inbound_items (occurred_at DESC, id DESC)
  WHERE attention_at IS NOT NULL AND attention_cleared_at IS NULL;
```
- Upsert (`register`) must not touch these columns, so a re-poll keeps both the flag and the cleared state. `_REGISTER_COLS` excludes them [V: it is an explicit tuple].
- Backfill once [I: optional]: `attention_at = updated_at` where `importance IN ('urgent','high','critical')`, plus rows referenced by an open/staged inbound to-do. Without it the tab starts empty until new arrivals come in.

#### 3.2 Pipeline
- `triage_handlers.stamp_inbox_importance` also computes `attention_reason`: `escalate` → `escalated`; calendar `importance=='critical'` → `critical_event`; any to-do created for the batch → `todo`. It passes the reason to a widened `mark_importance(..., attention_reason=)`, which calls a new `InboundRegistry.flag_attention(principal, surface, external_id, account_id, reason)`. That sets `attention_at = COALESCE(attention_at, NOW())` and keeps the first reason.
- A **new** triage verdict on an already-cleared item (for example, a rescheduled meeting that becomes critical again) re-flags it: `attention_cleared_at = NULL` only when the new reason ranks higher. See Q3.

#### 3.3 Python API (`hermes_cli/incomings_api.py`)
| Route | Change | Shape |
|---|---|---|
| `GET /api/registry/incomings` | new `attention=open\|cleared\|any` (default `any` = unchanged) | `{items:[IncomingItem + attention_at, attention_reason, attention_cleared_at, attention_outcome, todo_count], next_cursor}` |
| `GET /api/registry/incomings/attention-count` | **new**, cheap `COUNT(*)` on the partial index, capped at 99 | `{count: 7, by_surface: {email: 4, whatsapp: 2, calendar: 1}}` |
| `POST /api/registry/incomings/{id}/attention` | **new**, write (`allow_as=False`) | body `{action: "clear", outcome: "done"\|"dismissed"}` or `{action: "reopen"}` → updated item; 404 if invisible (same as `get_incoming`) |
| `POST /api/registry/incomings/{id}/remember` | also clears with `outcome="remembered"` (see Q2) | unchanged |

- Writes follow `mark_remembered`'s rule: `owner_user_id = principal.user_id`. A grantee can read the item but cannot clear it [I: matches the existing remember semantics; see Q5].
- `todo_count` comes from one batched `SELECT source_ref, COUNT(*) FROM tasks WHERE source_kind='inbound' AND source_ref = ANY($1) AND stage IN ('staged','open','working')` per page [I: needs a TodoStore helper; the index `(source_kind, source_ref)` exists V].
- Register the new routes in `tests/hermes_cli/test_route_authorization.py` (SIGNED_IN set, next to the existing incomings lines 171-177).

#### 3.4 BFF (`agent-home/src/app/api/incomings/…`)
- `route.ts`: pass `attention` through.
- New `attention-count/route.ts` (GET) and `[id]/attention/route.ts` (POST). Add both to `lib/auth/route-roles.json` as `signed-in`. Use `apiClientForRequest()` so `?profile=` is added automatically. Write the POST like the `remember` route.
- `HermesApiClient`: `incomingsAttentionCount()`, `setIncomingAttention(id, body)`. Add the fields to `IncomingItem` in `types/index.ts`.

#### 3.5 Frontend
- **`chats/LeftPanelTabs.tsx` (new):** a two-tab `role="tablist"` ("Chats" / "Incomings · 7") styled like `InboxView`'s `InboxTabs` (accent count pill), 44px min height. The selected tab is remembered with `usePersistentState("aquarium.landing.leftTab")`. Deep link `/?panel=incomings` [I].
- **`ChatsSidebar.tsx`:** renders `LeftPanelTabs`, then either `ChatsPanel` or `IncomingsPanel`. NewChatButton and search stay inside `ChatsPanel`, so they only show on the Chats tab.
- **`incomings/IncomingsPanel.tsx` (new, under `components/landing/`):** a compact list (`attention=open`, `limit=30`). It has surface chips (All/Email/WhatsApp/Calendar, counts from `by_surface`), section headers "Today / Earlier" (export `ChatsPanel`'s private `SectionHeader` or copy its style), an empty state ("Nothing needs you — triage will put anything important here"), and a footer link "All incomings →" to `/inbox` (mirrors "All chats").
- **`incomings/IncomingCompactRow.tsx` (new):** reuses `surfaceGlyph`, `relativeWhen`, `excerpt`, `timeRange` and `RefBadge` from `IncomingRow.tsx`. It adds a reason pill ("Escalated · high", "To-do", "Critical event") and a hover/kebab menu modelled on `SessionRow`. Menu items:
  - **Done** / **Dismiss** → `POST …/attention`, optimistic removal, with Undo via `useUndoToast` from `components/ui/UndoToast.tsx` (same as chat archive).
  - **Ask in chat** → a new chat prefilled with a prompt such as "About M512 (email from Alice, 'Q3 invoice'): …", via `chatHandOffUrl(text)` in `components/landing/startChat.ts` [V].
  - **Create to-do** → `POST /api/todos` with `source_kind=inbound, source_ref=id`, then clear with `outcome="todo"`.
  - **Remember** → existing remember route.
- **Row click** opens `/inbox/{id}?from=landing`. `inboxBackHref` must learn `from=landing` → `/` (today it only accepts `?…`) [V]. `IncomingDetailView` gets the same Done/Dismiss/Reopen buttons.
- **`useIncomingsAttention` (new, `lib/landing/`):** polls `attention-count` like `useNeedsYou` (15s while visible, refetch on focus, keep last good), keyed by `currentProfile`. It drives the tab badge and the collapsed `PanelRail` (dot + count).
- `LandingLayout`: the aside `aria-label` and the rail label become "Chats & incomings" (new `landing.panels.*` i18n keys in `en` and `zh-Hant`).

#### 3.6 Profiles
- Each profile is its own island: every call goes through `apiClientForRequest()`, so `require_profile_scope` targets the profile's own app store. The count hook and the list are keyed and refetched on `currentProfile`, like `useLandingChats`.
- No cross-profile aggregation; profiles are independent by design (AGENTS.md).

#### 3.7 Mobile (< lg)
- `ChatsDrawer` gets the same `LeftPanelTabs` at the top. The title becomes the selected tab's name.
- The dock "Chats" button shows the incomings count pill. `/?panel=incomings` opens the drawer on that tab.
- Row actions sit behind a 44px kebab (no hover on touch). Swipe-to-clear is out of scope [I].
- The detail page is already mobile (`MobileShell`).

### 4. Tests
- **Python:**
  - `tests/hermes_cli/test_inbound_registry_e2e.py` (Docker PG): flag → listed; clear → gone; a re-poll upsert keeps flag and cleared state; a grantee can't clear; a malformed id returns None (`is_uuid`).
  - `tests/hermes_cli/test_incomings_api.py`: `attention` param parsing, count shape, POST validation (400 bad action, 404 invisible).
  - `tests/custom/test_triage_inbox_importance.py`: reason mapping (escalate / critical calendar / to-do created / informational → no flag).
  - `test_route_authorization.py` entries.
- **agent-home vitest:**
  - `LeftPanelTabs` (switch, persisted tab, badge).
  - `IncomingsPanel` (empty, error + retry, chips, Done + Undo, profile change refetches).
  - Extend `chats/__tests__/ChatsPanel.test.tsx` "ChatsDrawer" for tabs, and `LandingLayout.test.tsx` for the rail count.
  - BFF `route.test.ts` for the two new routes (401, passthrough, `?profile=`).
  - An `inboxBackHref` unit test.
- **E2E (`agent-home/e2e/regression`):** seed one flagged arrival, see it in the tab, mark it done, the badge decrements, reload, it is still gone.

### 5. Open questions for Leo
1. **Which items count as "needs you"?**
   - (a) Recommended: escalated + to-do created + critical calendar event.
   - (b) Escalated only, matching what Telegram alerts you about today.
   - (c) Everything not `ignorable/newsletter/spam/notification`. Example: (c) would also list "informational" WhatsApp chatter such as "ok see you then". (a) would not.
2. **Does acting on an item clear it?**
   - (a) Remember / create a to-do / reply clears it automatically.
   - (b) Only an explicit Done/Dismiss clears it. Example: under (a), creating "Pay invoice INV-22" removes the email from Incomings because the to-do now tracks it; under (b) both stay until you press Done.
3. **Re-flagging:** if a cleared meeting is later rescheduled into a conflict (a new critical verdict), should it come back? Example: you dismissed Monday's 10:00 sync, then it moves onto your dentist slot. Return it (recommended) or keep it cleared.
4. **Named profiles:** triage only writes to the default profile (owner). Options:
   - (a) Hide the Incomings tab in profiles with no triage source.
   - (b) Show the tab with an explanation in its empty state.
   - (c) Later: route arrivals per profile (separate feature). Example: in `hr` the tab would otherwise always read "0".
5. **Shared items:** a teammate granted access to your mailbox items — should they see them in *their* Incomings and be able to clear them? Recommended: only the owner sees and clears them; grantees use `/inbox`.
6. **Personal mailboxes** skip triage today, so they never appear. Should this feature also run triage on them (bigger: per-person `mark_importance` + owner resolution), or ship without them?
7. **Telegram sync:** should Done in Aquarium also resolve the SQLite `escalations` row, so digests stop mentioning it? This needs a small write-back from the API into the pipeline DB [I: they are on the same box today].

### 6. Effort (one engineer-equivalent)
| Part | Est. |
|---|---|
| DB columns + registry methods + backfill + e2e tests | 0.5 d |
| Triage reason stamping + tests | 0.5 d |
| Python routes + BFF routes + types + route-auth/roles | 0.5 d |
| Tabs, IncomingsPanel, compact row, actions, count hook, i18n | 1.5 d |
| Mobile drawer/dock, detail-page Done/Reopen, back-link | 0.5 d |
| Vitest + E2E + prod check | 0.5-1 d |
| **Total** | **~4-4.5 days** (+1-2 d if Q6 personal-mailbox triage or Q7 write-back are in scope) |


## Appendix A-2 — Running strip research

Feature: a horizontal strip across the top of the landing page listing everything actively running (cron jobs, tasks, chat sessions, cards in projects), plus a clickable **Scheduled N** button that opens the Projects page.
Checked against `develop` @ `01ff13fd7` (2026-11-11). Research only, nothing built. **Inference** = my reading of the code, not something I ran.

### 1. What already exists (verified)

| Piece | Where | Notes |
|---|---|---|
| Feed of running items | `GET /api/activity/running` → `activity_running()` in `hermes_cli/web_server.py` (~L13145), logic in `hermes_cli/activity_running.py` (`chat_items`, `project_items`, `_running_cards`, `cron_items`, `finalize`) | Rows `{kind: chat\|project_run\|card\|cron, id, name, started_at, href, profile, status: running\|waiting}`, newest first, `MAX_ITEMS = 50`. Each row is scoped like the page it links to (more in §4). |
| Its BFF route | `agent-home/src/app/api/activity/running/route.ts` | Wraps the list as `{items}`. Caches 10 s per token hash + role (`unstable_cache`). Upstream failure returns 502 so clients keep their last good rows. `route-roles.json`: `"GET /api/activity/running": "signed-in"`. |
| Type | `ActivityItem`, `ActivityRunning` in `agent-home/src/types/index.ts` (~L3056) | |
| Poll hook #1 | `useActivityRunning()` in `components/ui/useActivityRunning.ts` | 15 s poll, re-reads on focus, module-level `lastGood` cache, 1 s clock. Exports `ACTIVITY_GLYPH`, `activityTiming`, `activityLabel`, `fmtElapsed`, `LONG_RUN_MS` (30 min). Used by `LandingClient` (L59) → `TopBarView`. |
| Poll hook #2 | `useRunningActivity()` in `components/landing/work/useRunningActivity.ts`, built on `usePolled` | Has its **own** cache. Used by `WorkPanel`. |
| Desktop chip strip (unused) | `components/ui/ActivityStrip.tsx` → `ActivityStrip()` | A one-row, sideways-scrolling chip strip with ‹ › buttons, `ResizeObserver` edge detection and an amber long-run tint. **No `<ActivityStrip>` is rendered anywhere today.** Only its re-exports are imported (by `WorkRow.tsx`). Shipped in #686, dropped from the shell by the new landing page (#750). |
| Mobile strip | `components/landing/topbar/MobileActivityStrip.tsx` (`lg:hidden` inside `TopBarView`) | Shows "4 working · 1 waiting · names…" and expands to `ActivityList`. |
| Right-panel list | `components/landing/work/WorkPanel.tsx` (`WorkPanelView`, `sortWork`, `WORK_ROWS_MAX = 6`) + `WorkRow.tsx` (`KIND_ICON`, `KIND_LABEL`, `workStatus`, `WorkStatusPill`) | Section "Working in the background" inside `LandingWorkPanel` (320 px aside, under Needs you). "View all" links to `/projects`. |
| "Scheduled N / M" | `HealthPill.tsx` (L46, L184 popover, L298 bar metric `hidden xl:inline-flex`) from `useStatusSummary()` → `app/api/status/summary/route.ts` (`cron_enabled`/`cron_total` from `client.cronJobs()`) | Counts cron jobs. See finding F1. |
| Landing frame | `LandingLayout.tsx`: `topBar` slot above a `lg:grid` of 280 px / 1fr / 320 px (`SIDEBAR_WIDTH`, `ASIDE_WIDTH`) | The new strip goes in the `topBar` slot. No layout change needed. |
| Project schedules | `hermes_cli/projects_schedule.py` | A project's schedule is a cron job in its host profile's store. Project row has `schedule`, `cron_job_id` and `next_run_at`. `next_run_at` is a display cache refreshed on read ("never make a scheduling decision from it"). The list already returns it (`ProjectRow.tsx` L72 shows "next …"). |
| Scheduled cards | `kanban_db.VALID_STATUSES` includes `scheduled`; `kanban_db.schedule_task()` | A card parked "waiting on time, not human input". Not dispatchable until `unblock_task`. Set by `hermes kanban schedule` (`kanban.py _cmd_schedule`) and `plugins/kanban/dashboard/plugin_api.py`. Board lane "Up next" (`board/model.ts LANES`) folds triage/todo/scheduled/ready together. |
| Projects filters | `components/projects/filters.ts` (`FILTER_CHIPS`, `filtersFromParams`/`filtersToParams`); server `_list_sync` in `hermes_cli/projects_api.py` | Views: active, repeatable (`cadence=repeatable`), standing, attention, paused, done, all, archived. **There is no "scheduled" filter.** `?view=project` forces Project mode over the saved Task/Project preference (`viewModeServer.ts`, `isProjectViewMode(forced)`). |
| Scoping helpers | `projects_api._can_read`, `_member_role_sync`, `_instance_admin`, `_enrolled_profiles`; card visibility `principal.private_visibility` | Reuse these as they are. |
| Existing tests | `tests/hermes_cli/test_activity_running.py`, `app/api/activity/running/route.test.ts`, `WorkPanel.test.tsx`, `MobileActivityStrip.test.tsx`, `TopBar.test.tsx` (L99 asserts exactly 1 `/api/activity/running` fetch), `tests/hermes_cli/test_route_authorization.py` (`SIGNED_IN` set) | |

#### What "tasks" covers in Leo's list (verified unless marked)
- **One-off Task-mode tasks** are projects (`projects_api` "Task mode: one request -> a one-off project", `_quick_task_job`). Their runs show as `project_run` and their cards as `card`. **Already covered.**
- **To-dos promoted to a card** (`todos_api.promote_todo` creates a project card with `project_id`): the card shows up while it is `running`. **Covered.**
- **To-dos started with `session:true`** (`todos_api.start_todo`): these spawn a seeded session on a `threading.Thread`. They are not in `_CHAT_RUNS` (the only write is `web_server.py` L12692), so they are **not covered**. The to-do's `working` stage is the user saying "I'm on it", not an agent running.
- **Kanban cards with no project**: excluded by `_running_cards` (`t.project_id IS NOT NULL`). agent-home has no page to link them to; I found no kanban route under `app/` (inference). **Not covered.**
- **Gateway channel chats** (Telegram etc.): excluded on purpose (module docstring: `last_active` only means "recently active").

### 2. Findings to fix first

- **F1 – a scoping issue in the cron jobs listing** is tracked privately and fixed by child session A1; the Scheduled button must not use the health-pill count.
- **F2 – two polls of the same feed on the landing page.** `TopBarView` uses `useActivityRunning` and `WorkPanel` uses `useRunningActivity`. They have separate caches, so the browser sends 2 requests every 15 s. The BFF 10 s cache usually absorbs the upstream cost. Fix it in this work: pass `LandingClient`'s `activity` into the work panel instead of the second hook.

### 3. Proposed design

#### 3.1 Desktop (≥ `lg`)
- **Where:** a new `RunningStrip` row inside `TopBarView`, directly under the 56 px `<header>`, `hidden lg:flex`. It mirrors where `MobileActivityStrip` sits.
- **Height:** about 40 px. Same `border-b border-[var(--color-border)] bg-[var(--color-bg)]` as the header.
- **Contents, left to right:**
  - label "Running · N", plus " · W waiting" in `--color-warn-text`;
  - a chip scroller reused from `ActivityStrip` (snap-x, hidden scrollbar, ‹ › edge buttons). Each chip has:
    - the kind icon from `WorkRow` `KIND_ICON` (`MessageIcon`/`FolderIcon`/`PlayIcon`/`ClockIcon`);
    - the truncated name (`max-w-[14rem]`);
    - the elapsed time (`fmtElapsed`);
    - a status dot with the `WorkRow` `STATUS` tones (Running = accent, Needs you = warn, Long-running = warn-text);
    - `title={activityLabel(item)}` (that label includes the profile);
    - a link to `item.href`.
  - Chips are sorted with `sortWork`: waiting first, then long runs.
  - **Pinned on the right:** a `ClockIcon` "Scheduled N" button (`rounded-[var(--radius-full)]` pill, same style as the "Aquarium dashboard" link). It is a `<Link>` to `/projects?view=project&schedule=set` (§3.4). Tooltip: "3 projects · 2 cards · 1 job · next in 2h".
- **Empty state:** when there are 0 running items and 0 scheduled, hide the strip. When there are 0 running but some scheduled, show "Nothing running right now" plus the button, so the button is always reachable.
- **Stale reads:** `opacity-60`, keep the last good rows. Same as the existing components.
- **Right panel:** recommend keeping "Working in the background" for now (open question Q1). It has room for meta and status pills, and the strip is the at-a-glance view.
- **Health pill:** drop the "Scheduled" metric from `HealthPill` (bar + popover) and replace it with the new button, which has the correct scope.

#### 3.2 Mobile (< `lg`)
- Keep `MobileActivityStrip` ("N working · names…", tap to expand).
- Add a compact "◷ N" Scheduled link at the right end of the collapsed row: a 44 px target, outside the expand `<button>`.
- The expanded list (`ActivityList`) gets a footer link "N scheduled → Projects".
- No horizontal chip scroller on phones. The one-line summary already exists and was designed for this size (landing-redesign README L42).

#### 3.3 Backend / BFF changes
1. **New `scheduled_summary(principal, enrolled)` in `hermes_cli/activity_running.py`.** It reads by status and only permission-checks the projects that matched, the same pattern as `project_items`:
   - `projects`: `SELECT id FROM projects WHERE archived=0 AND status='active' AND cron_job_id IS NOT NULL`, then `_can_read`. `next_run` is the min of `next_run_at`. That field is display-only, which is fine for a count (inference).
   - `cards`: generalise `_running_cards(principal)` to `_cards_with_status(principal, status)`. Count `status='scheduled'` cards on their project's own board (same `board_slug` check), with the same private-visibility filter and `_can_read`.
   - `cron_jobs`: only for `_instance_admin`. Count enabled jobs that are not linked to any project, per profile, via `_call_cron_for_profile(name,"list_jobs",False)` or a cheaper jobs.json read. Members get 0; jobs linked to their projects are already counted under `projects`.
2. **Response shape (additive). Keep the Python list route unchanged** and add a sibling route:

```
GET /api/activity/scheduled          (SIGNED_IN; add to test_route_authorization.SIGNED_IN)
200 {"total": 6, "projects": 3, "cards": 2, "cron_jobs": 1, "next_run_at": 1762850000 | null}
```

3. **BFF:** extend `app/api/activity/running/route.ts` to call both upstreams in parallel inside the existing `unstable_cache` key, and return `{items, scheduled: ScheduledSummary | null}`.
   - A failed scheduled leg gives `scheduled: null`, not a 502. A failed items leg stays a 502.
   - One browser poll, no new fan-out, no new `route-roles.json` entry.
   - Add `client.activityScheduled()` in `lib/api/client.ts`.
   - Add `ScheduledSummary` and `scheduled?` to `ActivityRunning` in `types/index.ts`.
4. **Projects filter.** `_list_sync` gets an optional `schedule` param: `set` means `cron_job_id` is set and status is active. The view orders by `next_run_at` asc (add `next_run` to the sort keys, or sort client-side; inference: server sort keeps paging correct).
   - `filters.ts`: add `ProjectListView` `"scheduled"` with label "Scheduled", mapped to `schedule=set`.
   - Scheduled **cards** don't fit a project filter. In the same view, give each project row a badge "2 cards scheduled" (open question Q3).

#### 3.4 Frontend changes (files)
- **New** `components/landing/topbar/RunningStrip.tsx` (+ `.test.tsx`). Presentational `RunningStripView({items, now, stale, scheduled})` built from `ActivityStrip`'s scroller and `WorkRow`'s icons/tones. Move the shared chip/scroller into it and delete the unused `ActivityStrip()` component, keeping its re-exports in `useActivityRunning.ts` (inference: safe, no other renderer).
- **New** `components/landing/topbar/ScheduledButton.tsx` (`compact` variant for mobile).
- `TopBar.tsx`: render `RunningStrip` (`hidden lg:flex`) after `<header>`, and pass `activity.scheduled` to `MobileActivityStrip`.
- `useActivityRunning.ts`: keep `scheduled` from the payload in `lastGood` and return it in `ActivityRunningState`.
- `HealthPill.tsx`: remove the `scheduled` reading and the bar metric.
- `LandingClient.tsx` / `LandingWorkPanel.tsx` / `WorkPanel.tsx`: `WorkPanel` takes `activity` as props (fixes F2). Keep `useRunningActivity` only if another page still uses it; otherwise delete it.
- `components/projects/filters.ts`, `ProjectsFilters.tsx`, `ProjectRow.tsx` (badge), `app/projects/page.tsx` (pass `schedule`), `lib/api/client.ts` `projects({schedule})`.
- i18n: new keys in the landing/projects namespaces (`useT("landing")` / `getT("projects")`).

### 4. Permissions and profile scoping
- **No new rules.**
  - Chats: `_chat_scope_for` in the run's own profile (FG-28 D3).
  - Runs and cards: `_can_read` with `_enrolled_profiles` (shared projects need an active enrolment in one of the project's profiles).
  - Private cards: the owner only.
  - Standalone cron: admins only.
  - The scheduled count uses exactly the same helpers, so a chip or count never points at a page the caller would get a 403/404 on.
- **Across profiles:** the feed covers every profile the caller is enrolled in, not only the current session profile. Each row carries `profile` and `href` includes `?profile=` for chats (`_chat_href`). Profiles stay independent: no row is visible because of membership in a *different* profile. Q2 asks whether the strip should narrow to the current profile.
- **BFF cache:** the key already includes the token hash and role, so results are never shared across principals. The scheduled leg joins the same key.

### 5. Tests
- **Python** `tests/hermes_cli/test_activity_running.py`:
  - a member's scheduled count includes their readable active scheduled project and excludes a stranger's private project, an archived project and a paused project;
  - a `scheduled` card counts only on its project's own board, and someone else's private scheduled card is excluded;
  - standalone cron jobs count for an admin only;
  - route test for `GET /api/activity/scheduled` (401 without a token, `[]`-style zero summary without the multi-user datastore);
  - add the route to `SIGNED_IN` in `test_route_authorization.py`.
- **Python** `test_projects_api.py`: `?schedule=set` lists only active projects with a cron link and respects `_can_read`.
- **BFF** `route.test.ts`: `scheduled` is merged in; a scheduled-leg failure gives 200 with `scheduled:null`; an items failure is still a 502; the cache key is unchanged per principal.
- **Components:**
  - `RunningStrip.test.tsx`: chip order (waiting → long → running), href and title, stale dim, hidden when everything is empty, button text and href;
  - `TopBar.test.tsx`: still exactly 1 activity fetch, even with WorkPanel mounted (F2);
  - `MobileActivityStrip.test.tsx`: Scheduled link;
  - `HealthPill.test.tsx`: no Scheduled reading;
  - a `filters` codec round-trip for `scheduled`.
- **E2E** `e2e/regression/mobile.spec.ts` + `areas.spec.ts`: the strip is visible on desktop, and the Scheduled button lands on `/projects?view=project&schedule=set` with the "Scheduled" chip selected.

### 6. Open questions for Leo
- **Q1 – Strip vs the right panel "Working in the background".**
  - (a) Keep both: the strip for a glance, the panel for detail.
  - (b) Remove the work section from the panel, so the right panel is Needs-you only.
  - (c) Keep the panel, but show the strip only when the right panel is collapsed.

  Example: 9 items running. In (a) they appear in the strip and as 6 rows in the panel. In (b) they appear in the strip only. **Recommend (a)** for the first release, then revisit.
- **Q2 – Profile scope.** Should the strip show work from every profile you're enrolled in (today's behaviour, with a profile badge) or only the profile you're in?

  Example: you're in `writer`, and a `default` project run is going. In (a) it shows as "Market research · default". In (b) it is hidden. **Recommend (a)**: background work in another profile is still yours to watch.
- **Q3 – What counts as a "scheduled card".**
  - (a) Projects with an active schedule only.
  - (b) (a) plus kanban cards parked in `scheduled`.
  - (c) (b) plus standalone cron jobs (admins).

  Example: "Weekly report" (every Monday), plus 2 cards parked until Friday, plus a nightly backup cron. That reads (a) Scheduled 1, (b) 3, (c) 4. **Recommend (c) for admins and (b) for members**, with the split in the tooltip.
- **Q4 – Where the button lands.**
  - (a) A new "Scheduled" filter chip on `/projects`, sorted by next run.
  - (b) The existing "Repeatable" chip (`cadence=repeatable`, no new filter). It includes repeatable projects with no schedule and misses scheduled cards.

  **Recommend (a).**
- **Q5 – Uncovered "tasks".** Should to-dos started with "Start in a chat" (`start_todo` `session:true`) and project-less kanban cards show in the strip? Both need new tracking: register the spawned to-do session in `_CHAT_RUNS`, or add a project-less card source with somewhere to link to.

  Example: you click Start on to-do D88. Today it never appears as running. **Recommend a follow-up PR**, not part of this one.

### 7. Rough effort
| PR | Scope | Estimate |
|---|---|---|
| 1 | A1: private scoping fix + tests | 0.5 day |
| 2 | Backend `scheduled_summary` + route + `_list_sync ?schedule=set` + Python tests | 1 day |
| 3 | BFF merge + types + `RunningStrip`/`ScheduledButton` + TopBar/HealthPill/WorkPanel changes (F2) + mobile link + Projects "Scheduled" chip + unit and E2E tests | 1.5–2 days |

**Total:** about 3–3.5 human days, about one Devin session, after the mockup is approved. Q1–Q4 answers change the scope only slightly. Q5 would add about 1 day.


## Appendix B — Project skills research

Repo `leolau/aquarium` @ `develop` 01ff13fd7 (2026-11-11). UI = `agent-home/`. Facts below were checked in code; **(inference)** marks anything I did not prove.

### 1. What already exists (reuse)

| Piece | Where | Notes |
|---|---|---|
| Project tabs | `agent-home/src/components/projects/tabs/groups.ts` (`PROJECT_GROUPS`, `GROUP_SECTIONS`, `groupOf`), `tabs/types.ts` (`PROJECT_TABS`, `ProjectTabProps`), `tabs/ProjectTabsNav.tsx` | 4 groups Overview/Work/Files/Setup; nav already `overflow-x-auto` (mobile-safe). Badges via `tabBadges` in `ProjectDetailView.tsx`. Labels in `i18n/messages/{en,zh-Hant}/projects.json` → `tabs.*`. |
| Section rendering | `ProjectDetailView.tsx` (`TAB_COMPONENT[section]`, `canLead` = instance admin / owner / `lead`) | A new section = one component + one map entry. One-off projects open in Task view first (`task/ProjectViewSwitch.tsx`); Project mode is where this lands. |
| Project's own skills list | `components/projects/panels/ToolsPanel.tsx` (Setup → Settings) → BFF `PATCH /api/projects/[slug]/tools` → `PATCH /api/registry/projects/{slug}/tools` (`projects_api.patch_tools_route`, gated `_require_write`) | `project.skills` (CSV) = skills **preloaded into every run**, resolved against the *host* profile, capped by `projects.max_skills` (`projects_run.py` ~L1250–1292). Free-text CSV editing today. |
| Usage ledger | `hermes_cli/skill_ledger.py`: `skill_events` (`skill_name, version_id, trigger, session_id, kanban_task_id, kanban_run_id, kanban_board, project_slug, user_id, profile, outcome, rating, note`); `summary(days,name)`, `events(name,days,limit,cursor)` | DB is **per profile**: `ledger_path() = get_hermes_home()/skill_ledger.db`. Kanban workers run with the assignee profile's `HERMES_HOME` (`kanban_db.py` ~L8532–8543), so a project's uses are spread over the ledgers of every profile that ran its cards. |
| project_slug fill | `skill_ledger._resolve_pending` | Filled lazily from kanban `tasks.project_id` → `projects.slug`, **only for card uses**. No `record_use` call site passes `project_slug` (`skill_commands.py`, `skill_bundles.py`, `skills_tool.py`, `cron/scheduler.py`), so project chats/Ask are not attributed. No index on `project_slug`. |
| Usage routes | `hermes_cli/skills_usage_api.py`: `GET /api/skills/usage`, `GET /api/skills/usage/detail` (`_decorate` resolves chat/card/project titles), `POST .../feedback`; all `SKILLS_LAB` | No project filter. BFF `app/api/skills/usage/route.ts`, `usage/detail/route.ts` gate with `requireSkillPermission("lab", profile)`. |
| Improve chat | `hermes_cli/skills_improve_api.py`: `POST /start {name, goal?, profile?}`, `POST /message`, `GET /sessions?name=`; `build_seed`, `_usage_section`, `lock_down_agent` (drops `skill_manage`, writes, terminal…), `extract_draft` (```` ```skill-draft ````) | Seed is prepended to the first user turn → system prompt byte-stable (cache-safe). Sessions found by tag `skill-improve:<name>`. UI `components/skills/SkillImprovePanel.tsx` (props `name, profile, content, onOpenTab`; evidence from `/api/skills/usage/detail`). |
| Drafts | `POST /api/skills/versions/draft` → `skills_versions_api.create_skill_draft` → `tools/skill_versions.create_draft` | `_require_skill(name)` → **404 for a skill that doesn't exist yet**, so drafts can only improve existing skills. |
| New skill | `NewSkillModal.tsx` → `POST /api/skills {name, content, category?, profile?}` (`manage`) | Writes a live skill immediately. |
| Retro skill candidates | `projects_db.project_skill_candidates (id, project_id, run_no, name, body, created_at)`; written by `POST /{slug}/runs/{run_no}/retro` proposals `kind: "skill"`; `list_skill_candidates()` | **No route or UI reads them today** — natural seed for "create skill". |
| Permissions | `tools/skills_access.py` (rows `use, view, agent_edit, manage, lab`; defaults owner/admin all, **member/viewer `view/manage/lab` = false**); `route_roles.SKILLS_VIEW/MANAGE/LAB`; BFF `lib/skills/permissions-server.ts` (`requireSkillPermission`, `getSkillPermissionsOrNone`); `GET /api/access/skills/me` (#834/#835) | Per profile, read from that profile's `config.yaml`; owner always passes. |
| Project access | `projects_api._require_read` (404 if not readable: admin, owner, member row, or shared + enrolled in a project profile), `_require_write` (`_can_write`: lead/owner/instance admin), `_enrolled_profiles` | Project profiles: `ProjectDetail.profiles: ProjectProfileRow[]` (`role: host|…`), `host_profile`. |
| Profile scoping | `web_server._profile_scope(profile)`, `_chat_principal(request, profile)` (re-resolves caller in target profile, 403 if not enrolled), `profile_route_scope.require_profile_scope` | Reuse; never merge permissions across profiles. |

### 2. UX placement (recommendation)

New 5th tab group **Skills** (`overview | work | files | skills | setup`), one section `skills`. Reason: it is evidence + action, not configuration; Setup is already 3 sections. ToolsPanel stays in Setup, but gains a "Manage in Skills tab" link. Badge = number of unreviewed retro candidates.

Tab content (`ProjectSkillsTab`):
1. **Header strip**: window select (30/90 days), counts: skills used · card uses · success rate; buttons **Create skill with AI** and (lead) **Edit preloaded skills**.
2. **Skills used in this project** table/cards, grouped by profile when the project has >1 profile: name, profile chip, uses, success/partial/failed bar, last used, sparkline (`trend`), "Preloaded" pill if in `project.skills`, actions **View runs**, **Improve with AI**.
3. **Preloaded but unused** (in `project.skills`, 0 uses in window) — hint to remove.
4. **Suggested by retros** (skill candidates): name, "from run N", preview, **Create with AI** / **Dismiss**.
5. Drill-down "View runs" = a Sheet reusing `SkillUsagePanel` filtered to the project (cards/runs list with outcome + rating).

"Improve with AI" → `/skills/<name>?tab=improve&profile=<p>&project=<slug>` (existing page; a dismissible "Evidence: project <name>" chip). "Create with AI" → a Sheet with the same chat UI as Improve (shared hook extracted from `SkillImprovePanel`), seeded with this project.

### 3. Backend / BFF changes

#### 3.1 Ledger (`hermes_cli/skill_ledger.py`)
- `summary(..., project: str | None = None)` and `events(..., project=None)` add `AND project_slug = ?`; `by_version` too.
- New `CREATE INDEX IF NOT EXISTS idx_skill_events_project_ts ON skill_events(project_slug, ts)` in `_SCHEMA` (idempotent; no column change).
- New `project_rollup(slug, days)` = `summary(days, project=slug)` (thin; keeps one code path).

#### 3.2 New `GET /api/registry/projects/{slug}/skills?days=90` (`projects_api.py`, new `projects_skills_api.py` router to keep the god-file from growing)
Gate: `_require_read` (404 semantics). Then for each `p` in `project.profiles ∩ enrolled(caller)` (admins: all project profiles): resolve caller in `p` (`_chat_principal`-style re-resolve), check `skills_access.allows(role_in_p, "lab", cfg_p)` (owner passes); only then `with _profile_scope(p): skill_ledger.summary(days, project=slug)`. Response:
```json
{ "days": 90,
  "profiles": [{"profile": "default", "role": "host", "can_lab": true, "can_manage": false},
               {"profile": "sales", "role": "member", "can_lab": false, "hidden": true}],
  "skills": [{"name": "docx-editing", "profile": "default", "uses": 14, "tasks": 9,
              "success": 10, "partial": 2, "failure": 1, "unknown": 1, "success_rate": 0.77,
              "last_used_at": 1762832000.0, "trend": [{"day": "2026-11-10", "uses": 2}],
              "preloaded": true}],
  "preloaded_unused": ["quotation-rewrite"],
  "candidates": [{"id": "skc_…", "run_no": 4, "name": "vendor-po-checklist",
                  "preview": "first 280 chars", "created_at": 1762800000}] }
```
- `preloaded` = name in `parse_csv_field(project.skills)` and profile == host profile.
- Candidates: `projects_db.list_skill_candidates`; return full `body` only to callers with `lab` in the host profile.
- Run the fan-out in `asyncio.to_thread` (ledger reads + `_resolve_pending` are sync I/O; memory: avoid sync I/O on the loop). Bound to project profiles (small).
- Register in `tests/hermes_cli/test_route_authorization.py` as HANDLER_CHECKED; BFF `app/api/projects/[slug]/skills/route.ts` via `withPrincipal` + `client.projectSkills(slug, days)`; add `"GET /api/projects/[slug]/skills": "signed-in"` to `lib/auth/route-roles.json`.

#### 3.3 Project filter on existing usage detail
`GET /api/skills/usage/detail?name&profile&project=<slug>` → `events(..., project=)`. Must also check the caller can read the project (otherwise `lab` holders could probe titles of private projects by slug) — call the same `_can_read` helper. BFF `usage/detail/route.ts` forwards `project` (validate slug regex).

#### 3.4 Improve scoped to a project
- `POST /api/skills/improve/start {name, profile?, goal?, project?}`: when `project` given, check project read, then `_usage_section(name, project=slug)` and `build_seed(..., project={name, goal, recent_cards})` adds a `## This project` block (goal/brief, last N card titles + outcomes that used the skill) and tells the agent to cite only this project's runs. Still a one-time seed in the first user turn — cache-safe.
- Tag the session also `skill-improve-project:<slug>`; `GET /sessions?name&project=` filters on it so the Skills tab can show "2 improve chats".
- Drafts unchanged: saved via `/versions/draft` with `session_id` (credited `agent:<sid>`), activation via Versions tab.

#### 3.5 Create skill with AI (new)
- `POST /api/skills/create/start {profile, project?, goal?, candidate_id?}` → same machinery as improve (new `TAG_PREFIX "skill-create:"`, `lock_down_agent`, `extract_draft`), seed = project brief/goal, top successful cards (titles + result summaries), the candidate body if given, plus the SKILL.md template rules (frontmatter `name/description`). `POST /api/skills/create/message` = reuse `improve_message` with the tag check generalised (refactor `_improve_skill_of` → `_lab_session_kind`).
- Saving: drafts can't exist without a skill (`_require_skill`). Options in Q3. Default proposal: **Save** = `POST /api/skills` (needs `manage`) with the extracted draft, then version history starts with that baseline; users with `lab` but not `manage` get "Copy draft" + "Ask an admin".
- Optional third step **Preload in this project** = existing `PATCH /tools` with `skills: [...current, new]` (needs `_can_write`; 422 if not in host profile).

### 4. Frontend components

| File | Change |
|---|---|
| `tabs/groups.ts`, `tabs/types.ts` | add group `skills` → section `skills`; `PROJECT_TAB_LABEL.skills`. `?tab=skills` deep link works via existing `isProjectGroup`. |
| `tabs/SkillsTab.tsx` (new) + `ProjectDetailView.tsx` `TAB_COMPONENT` | fetch `/api/projects/{slug}/skills?days=`; states loading/empty ("No skills recorded yet — skills appear after the first card run")/forbidden-profile notice ("1 profile hidden: you can't open the Skills Lab in *sales*"). |
| `components/projects/skills/ProjectSkillRow.tsx` (new) | reuse `SkillUsageSignal` + outcome badge styles from `SkillUsagePanel.tsx`; links built with `skillHref(name, profile, "", "tab=improve&project=…")` (`skill-links.ts`). |
| `SkillUsagePanel.tsx`, `SkillImprovePanel.tsx`, `SkillPage.tsx` | accept optional `project` prop (from `?project=`), append to evidence/sessions/start URLs, show chip to clear. |
| `components/skills/useLabChat.ts` (new, extracted from `SkillImprovePanel`) + `projects/skills/CreateSkillSheet.tsx` | shared chat/draft state; Sheet (`components/ui/Sheet`, `wide`) with name/category, chat, draft diff vs empty, Save / Preload. |
| `ToolsPanel.tsx` | skills field becomes a chip picker from `/api/skills?profile=<host>` (reuse `ChipInput.tsx`) — optional, Q5. |
| i18n | `projects.json` en + zh-Hant: `tabs.skills`, tab copy. |

### 5. Permissions & profile scoping
- Tab visible to anyone who can read the project; data rows only for profiles where the caller has `lab` (per-profile `skills_access`, owner always). Profiles stay independent: same skill name in two profiles = two rows, never merged; no cross-profile config inheritance.
- Improve/Create chat: `lab` in that profile (existing `SKILLS_LAB` dependency + `_chat_principal`). Save new skill: `manage`. Activate version: `lab` (existing). Preload into project: project `_can_write`. Archived project: read-only (reuse `_refuse_if_archived` for Preload / candidate dismiss).
- BFF: every new route runs `requireSkillPermission` / `withPrincipal` first; Python re-checks (authority).

### 6. Mobile
- `ProjectTabsNav` already scrolls sideways; 5 short labels fit at 375 px (inference — check zh-Hant).
- Skills table → stacked cards below `md`; sparkline hidden below `sm`; actions in a row of ≥44 px buttons (memory: 44 px min-height gotcha).
- Improve/Create reuse existing `lg:grid-cols-[…_340px]` → evidence stacks below chat on mobile; Create Sheet goes full-height on mobile (Sheet default — verify).

### 7. Tests
- Python: `test_skill_ledger.py` — project filter on `summary/events/by_version`, index created on existing DB. New `test_projects_skills_api.py` — 404 for unreadable project; fan-out over 2 profiles with ledgers in each `HERMES_HOME`; profile without `lab` hidden; unenrolled profile skipped; `preloaded`/`preloaded_unused`; candidates body withheld without `lab`. `test_skills_improve_api.py` — project seed only cites project events; project tag; `/sessions?project=`; start with unreadable project → 404. Create-flow tests mirroring improve (tool lockdown, draft extraction, save needs `manage`). `test_route_authorization.py` entries.
- agent-home (vitest): route tests for `/api/projects/[slug]/skills` and `project` forwarding on usage/detail + improve/start; `route-roles.json` test; `SkillsTab` render states (empty / multi-profile / hidden profile / candidates); `ProjectTabsNav` 5 groups + `?tab=skills`; `SkillImprovePanel` project chip. `scripts/smoke/agent_home_smoke.py` unchanged unless a new page is added (memory: every `page.tsx` needs a PageSpec).
- Playwright e2e (optional): project with one completed card using a skill → tab shows it → Improve opens with chip.

### 8. Open questions for Leo
1. **Who sees the Skills tab data?** Today `lab` is owner/admin only by default, so project members see nothing. (a) keep `lab` (members see "ask an admin"); (b) project members with `view` see names + counts, `lab` needed for runs and Improve; (c) any project reader sees names + counts. Example: Mary is a project *member*, role member in *default* → (a) empty, (b) only if admin ticks "view" for members, (c) sees "docx-editing · 14 uses · 77%".
2. **What counts as "used in this project"?** Today only card runs. Should project chats/Ask/quick-task chats count? Example: Leo asks the project chat "draft the PO" and the agent loads `docx-editing` — (a) not counted (no change), (b) counted by passing `project_slug` from the project chat context into `record_use` (extra plumbing).
3. **Saving an AI-created skill** (drafts need an existing skill): (a) Save = create live skill now (`manage` required); (b) new "draft-only" skill state (folder created disabled, first version a draft, trial from Versions) — safer, ~1 extra day; (c) save as a project skill candidate only, admin promotes later.
4. **Improve evidence scope**: (a) only this project's runs; (b) this project highlighted + global usage summarised (recommended — a fix for one project shouldn't break others). Example: `quotation-rewrite` fails 3× here but succeeds 40× elsewhere.
5. **Edit the preloaded list here?** (a) read-only pills + link to Setup; (b) toggle "Preload in runs" per row (writes `PATCH /tools`, lead only); also replace the CSV box with a picker. Example: lead clicks "Preload" on `vendor-po-checklist` after creating it.
6. **Retro candidates**: show + "Create with AI"/"Dismiss" (needs a `dismissed_at` column on `project_skill_candidates`), or show read-only?
7. **Multi-profile projects**: one list with profile chips (recommended) or a profile switcher like the Skills page?

### 9. Effort (rough)
| Slice | Effort |
|---|---|
| Ledger filter + index + `/projects/{slug}/skills` + BFF + tests | 1–1.5 d |
| Skills tab UI (list, unused, candidates, drill-down Sheet, i18n, mobile) | 1.5–2 d |
| Project-scoped Improve (seed, tag, `?project=` on panels) | 1 d |
| Create with AI (routes, shared chat hook, Sheet, save/preload) | 1.5–2 d (+1 d for Q3 option b) |
| **Total** | **~5–6.5 dev-days** (≈1–2 Devin sessions); ship as 3 PRs: view → improve → create. |

