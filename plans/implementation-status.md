# Implementation status

Tracking file for in-flight feature work. Update as phases land.

## Fleet page: per-box layout switch, only where a fleet is configured

Plan: `plans/2026-11-28-fleet-page.md`
Status: **implemented** — updated 2026-11-28

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `aquarium fleet probe/status/job/switch` in `deploy/aquarium.py` + `deploy/sudoers.d/aquarium-fleet` + ROOT_COPIES | done |
| 2 | `hermes_cli/fleet_api.py` (OWNER-gated, password re-check, scrubbing) + router registration | done |
| 3 | agent-home: types, client, route-roles, BFF routes, sections/`hasFleet`, Fleet page + FleetView, i18n en+zh-Hant | done |
| 4 | tests (deploy helper, API, vitest) + RELEASES.md + this file | done |
| 5 | ops setup on the managing box (fleet key, fleet.json, sudoers, dashboard restart) | pending — aquarium-ops |

## New Hetzner instance: ProxyAdvisor (CX43, release install)

Plan: `plans/2026-11-27-hetzner-proxyadvisor-instance.md`
Status: **installed, pending handover** — updated 2026-11-27

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Hetzner project `ProxyAdvisor` + API token + hcloud context | done (user console step) |
| 2 | Fresh SSH keypair, firewall (22/80/443), CX43 in nbg1 — `46.224.198.234` | done |
| 3 | Aquarium v0.2.18 signed-release install (`--channel stable`, domain-less); SSH password auth disabled | done |
| 4 | Owner setup link consumed; model provider key added | pending (handover) |
| 5 | Domain added later → re-run installer with `--home-domain`/`--dashboard-domain` | pending (org supplies domain) |

Note: `curl | bash` piping truncated the installer mid-script (stdin eaten);
always download `install-aquarium.sh` to a file and run it from disk.

## Project detail: Runs step workspace (redesign PR2)

Plan: `plans/2026-11-27-project-runs-workspace.md`
Status: **implemented** — updated 2026-11-27

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Shared helpers extracted (`runData.ts`, `runUi.tsx`, `ComparePanel.tsx`); `ExecutionRuns.tsx` deleted | done |
| 2 | `RunsWorkspace` master-detail: rail + selected run + progress/ETA + card rows with assignee join | done |
| 3 | Inline approval (waiting_on_you + board `pending_approvals`, real approvals POST), per-run output tiles + Download all, grade stars/note/self-score/compare-with-prev | done |
| 4 | `STEP_PARTS.runs` → [runs, outputs] (dashboard/iterations folded); i18n en+zh-Hant; tests; tsc/eslint/vitest/ratchet green | done |

## Project detail: 4-step spine (redesign PR1)

Plan: `plans/2026-11-27-project-detail-spine.md`
Status: **implemented** — updated 2026-11-27

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `PROJECT_STEPS`/`STEP_PARTS` model; `ProjectSpine` (number+pill+sub+warn dot, phone chat view); `ProjectTabsNav`/`ProjectPartsNav` deleted | done |
| 2 | Header status sentence + Start run / Latest outputs buttons; Log into ⋯ sheet; old `?tab=` → step+part mapping | done |
| 3 | Requirements warn = open clarify count (replaces Planning badge); i18n en+zh-Hant; tests rewritten; tsc/eslint/vitest/ratchet green | done |

## Project detail: sub-tabs inside Planning / Execution

Plan: `plans/2026-11-25-project-part-tabs.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `ProjectPartsNav` second tab row; parts mounted-but-hidden except active; `part` state + `selectPart`; `?tab=dashboard` → part deep-link | done |
| 2 | Tests (sub-tab row, deep-link, Log without row); `tsc`/`eslint`/projects suite | done |

## Run status wording: Finished vs project Done

Plan: `plans/2026-11-25-run-status-wording.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `status.done` label → Finished (en + zh-Hant); Iteration sub "awaiting review" when outputs await acceptance; test | done |

## Deliveries: refuse paths the Outputs page can never open

Plan: `plans/2026-11-25-deliver-refuse-unopenable-paths.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `retain_delivery` — any local abs path: scratch → kept copy; missing → 422; servable under managed roots + delivering card's `workspace_path` → `workspace`; else 422; `link_kind="path"` → 422 | done |
| 2 | `deliver_output` passes `task_id`; tests (4 new cases) | done |

## Upgrade pre-flight checks: live progress

Plan: `plans/2026-11-25-upgrade-check-progress.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `aquarium.py` — `UPGRADE_CHECK` progress file; running/ok/fail rows; release sub-notes; `status` serves `"check"` | done |
| 2 | `software_upgrade_api.py` — `check_view` in status/job answers; helper timeout now lands in `preflight.error` | done |
| 3 | `SoftwareUpgradeView` — poll `/job` 2 s while check POST in flight; merge live rows; show `result.error` | done |

### Not yet verified

- A real stalled check naming its culprit row (needs this build on the box; HSD is a git checkout → update the checkout on the box, the UI upgrade can't self-deliver past its own hung check).

## Deploy syncs the aquarium admin command

Plan: `plans/2026-11-25-deploy-syncs-aquarium-admin-command.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `hermes-deploy.sh` installs `deploy/aquarium.py` → `/usr/local/sbin/aquarium` when it exists and differs; reports (not installs) when missing | done |
| 2 | `RELEASES.md` contract updated (admin command is the one auto-synced root copy on checkouts) | done |

### Not yet verified

- Sync branch on a real deploy (both boxes were hand-synced this session, so the next deploy is the no-op path).

## agent-home graceful shutdown

Plan: `plans/2026-11-25-agent-home-graceful-shutdown.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `deploy/graceful-shutdown.mjs` — socket tracking, stop-accepting + closeIdleConnections + 10 s drain + 15 s hard exit | done |
| 2 | `deploy/server.mjs` custom server (replaces `next start`); `start.sh` execs it; `TimeoutStopSec=20s` in unit | done |
| 3 | vitest 4 cases; live smoke on box :3199 — held request exits at 10.1 s clean | done |

### Not yet verified

- Real deploy/`aquarium update` end-to-end (`journalctl -u agent-home` should show `[graceful-shutdown]` + ~10 s stop).
- Unit file reinstalled on the box for `TimeoutStopSec` (`deploy/hermes-deploy.sh` does not re-copy units).

## Needs-you: card source labels + source/owner filters

Plan: `plans/2026-11-25-needs-you-source-filters.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `with_project_names()` in `needs_you.py` fills `context.project_name`; wired into `/api/needs-you` | done |
| 2 | `context.project_name` + missing `data_schema`/`data_health` added to `NeedsYouSource`/`NeedsYouEntry` | done |
| 3 | `needsYouFilter.ts` model: `sourceGroupOf` (6 buckets), `whoOf` (me/team/person), `facetsOf`, `applyFilter` | done |
| 4 | Collapsible filter row on `NeedsYouPanelView` (source + who chips, facet counts, "Showing X of N · Reset", filter-empty state) | done |
| 5 | Card source line (`Project · <name>` or kind label) on `NeedsYouItem`; `suggestedOrigin` tag on `SuggestedTaskCard` for non-inbound todos | done |
| 6 | i18n keys (`filter.*`, `sources.*`, `suggestedOrigin.*`) en + zh-Hant | done |
| 7 | Tests: `needsYouFilter.test.ts`, panel/item test updates, `test_needs_you.py` cases | done |

### Verified

- `pytest tests/hermes_cli/test_needs_you.py` — 35 passed.
- `agent-home` vitest on landing/suggested-tasks/inbox/lib suites — 313 passed; `tsc --noEmit` and eslint clean on touched files.

### Not yet verified

- Deployed browser check of the filter row and card source lines against a live backend.

## Needs-you: Snooze + Dismiss on notification cards

Plan: `plans/2026-11-25-needs-you-snooze-dismiss.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `notifications.snoozed_until` + `NotificationStore.snooze` (C2-gated, conditional update); `list_pending` hides rows until the stamp (`include_snoozed` opt-out) | done |
| 2 | `dismiss` action on notification entries without a settle verb; `notification_id` on entries; `POST …/snooze` route; `context.snoozed` keeps dedupe coverage, `finalize` drops them | done |
| 3 | BFF: `client.snoozeNotification`, `…/[notificationId]/snooze/route.ts`, `route-roles.json`; `post` moved to `src/lib/post.ts` (import cycle) | done |
| 4 | `SnoozeButton` + `NotificationActions` on the card and in `EntryActions`; `snooze` in the Does-section; i18n en + zh-Hant | done |
| 5 | Tests: `test_needs_you.py` action lists, `test_human_comms_e2e.py` snooze cases, `NeedsYouItem.test.tsx` gate/post cases | done |

### Verified

- `pytest tests/hermes_cli/test_needs_you.py test_human_comms.py` — 46 passed; e2e skips without docker (CI runs it).
- `vitest` full suite green (incl. route-roles + hint-ratchet after rebasing on #1107); `tsc --noEmit` + eslint clean.

### Not yet verified

- Live roundtrip (snooze leaves the panel and returns; dismiss settles permanently) and deploy.

## Context-length learning & app-mcp semantics (incident 2026-11-25)

Plans: `plans/2026-11-25-context-length-learning-and-compression-loop.md`,
`plans/2026-11-25-app-mcp-semantic-layer.md`
Status: **A–C done** (context-length learning + compression dampeners); D in progress — updated 2026-11-25

| Item | Scope | Status |
|------|-------|--------|
| A | Upward context-length learning in `update_from_response` (+ `model@base_url` cache write, explicit-config wins) | **done** — `get_probe_tier_above`, `learn_context_length_upward`, gateway hygiene mirror, `compression.learned_context` |
| B | Per-turn LLM-compression cap (~3) + one deterministic no-summary pass + <5% non-convergence suppression | **done** — `compression.max_turn_llm_passes` / `turn_llm_budget_ms`, `ContextCompressor.begin_turn` |
| C | Preflight prefers `last_real_prompt_tokens`; prune before summary; `compress_passes`/`compress_ms` in turn-timing lines + drift-check flagging | **done** — `hermes compression advise` → Needs-You (`deploy/hermes-compression-advise.timer`, not installed); optional `hermes selftest latency` canary done (`deploy/hermes-selftest-latency.timer`, not installed; `selftest.latency.enabled` default false) |
| D | app-mcp `section`/`hint` snapshot fields; `data-appmcp-hint` convention + ratchet vitest; coverage-ledger drift sweeper; `/` help.py suggested-tasks entry | in progress (see below) |

### app-mcp semantic layer — `plans/2026-11-25-app-mcp-semantic-layer.md`

| Phase | Scope | Status |
|-------|-------|--------|
| A | `section` + `hint` on `AppMcpElement` (`sectionOf`/`hintOf` in `snapshot.ts`), carried through `app_describe_page`; section in the last-active awareness line (`state.ts`) | done |
| B | `data-appmcp-hint` on SuggestedTaskCard + NeedsYouDetails (Work / Snooze / each duration / Dismiss); ratchet vitest `hint-ratchet.test.ts` + baseline; `/` guide in `help.py` covers Needs you + suggested tasks | done |
| C | Coverage ledger: append-only `coverage-ledger.jsonl` in `$STATE_DIRECTORY` (`/var/lib/app-mcp`), else `$HERMES_HOME/app-mcp/`, `(page, role, name) → hinted?`, updated per snapshot (`app_mcp/ledger.py`) | done |
| C | Nightly sweep of ledger gaps (unhinted controls + unguided pages) into an owner Needs-You card (`app_mcp/sweep.py`, `deploy/hermes-appmcp-hint-sweep.timer`); ledger write grant via `StateDirectory=app-mcp` drop-in (`deploy/app-mcp-ledger.conf`); installed by `install-aquarium.sh` and `aquarium update` on boxes that run app-mcp | done |
| D | pytest route-guide guard: every `PAGES` route and every agent-home `page.tsx` route has a guide (`UNGUIDED_ROUTES` allowlist only shrinks) | done |


## Suggested-task Snooze duration options

Plan: `plans/2026-11-25-suggested-task-snooze-options.md`
Status: **implemented** — updated 2026-11-25

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `SNOOZE_OPTIONS` (1 min / 1 day / 1 week) + `snoozeUntil(ms)` in `channels.ts` | done |
| 2 | Snooze popover menu on `SuggestedTaskCard` + `NeedsYouDetails` | done |
| 3 | Notice text, i18n (en + zh-Hant), tests updated | done |

### Verified

- `agent-home` `tsc -p . --noEmit` clean; vitest 13/13 on touched suites; eslint clean.

### Not yet verified

- Deployed browser check (menu opens above the button on phone widths).

## Data dictionary — Phase 6: schema change check

Plan: `docs/plans/2026-11-14-001-data-dictionary-semantic-layer-plan.md`
Merged into `develop` via #921 (2026-11-15). Not deployed: see "Deploy" in the plan.
Status: **implemented** — updated 2026-11-15

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `schema_checked_at`/`schema_drift` columns + `schema_diff`/`check_source`/`schema_check_tick`/`schema_check_loop` in `data_dictionary.py` | done |
| 2 | Instant re-check hooks: `apply_design` → `recheck_site`; `approve`/`restore` → best-effort re-check | done |
| 3 | `data_schema` Needs You cards + hourly sweep in the web server lifespan | done |
| 4 | `site_db` dictionary/study drift output + `data-questions` skill note | done |
| 5 | agent-home: drift pill (list), warn banner + `stale` entry pill (detail), en/zh-Hant | done |
| 6 | Unit + real-Postgres tests; `tsc` + vitest | done |

### Verified

- `pytest tests/hermes_cli/test_data_schema_check.py test_needs_you.py` — pass.
- `pytest test_data_dictionary_api.py test_site_db_tool.py test_site_sources*.py` — pass.
- PG test `test_schema_check_flags_drift_and_approve_rechecks` written
  (`HERMES_TEST_SITE_PG_DSN` not set locally — runs in CI).
- `agent-home` `tsc -p . --noEmit` clean; vitest `src/components/data` + `src/i18n` — 92/92 pass.

### Not yet verified

- Live sweep on the box (needs deploy + `hermes db migrate` for the new columns).
- Browser check of the drift banner at 390/768/1440 px.

## Landing Continue chip

Plan: `plans/2026-11-13-landing-continue-chip.md`
Status: **implemented** — updated 2026-11-13

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | `useResumeChat` hook (latest user-started chat, coalesced fetch) | done |
| 2 | `ContinueChip` under the greeting subline + `onOpenChat` prop | done |
| 3 | `LandingClient` wiring (`openSession` → inline open) | done |
| 4 | Composer tests + typecheck + lint | done |

### Verified

- `agent-home` vitest on composer/client/chats-panel suites — 41/41 pass.
- `tsc -p . --noEmit` clean; eslint clean on touched files.

### Not yet verified

- Visual check in a running dev server against real session data.

## Triage → Work → Draft → Review → Reply loop (develop port)

Plan: `plans/2026-11-12-triage-review-reply-loop.md`
Branch: `devin/port-triage-review-loop` (off `origin/develop`)
Status: **implemented — PR #898 open against develop** — updated 2026-11-12

Originally built on `main` (see `devin/triage-loop-main-snapshot`); ported to
`develop` because both deployments (Hetzner `hermes` via `deploy-hermes.sh
develop`, HSD via the agent-home software-upgrade release flow) track
`develop`.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | plans/ docs + status scaffolding | done |
| 2 | `work_request` response-schema field (3 channels) | done |
| 3 | `work_request` handler + `triage.auto_work` gate (`custom/shared/triage_handlers.py`) | done |
| 4 | `hermes_cli/todo_work.py` launcher; `start_todo` delegates (keeps develop's `internal_user_*` spawn args) | done |
| 5 | `review` stage (`todo_store.py`) + draft-ready notification in launcher | done |
| 6 | Messaging push via `notify.im_target` in launcher | done |
| 7 | `drafts/todo_<id>/` + `work_result JSONB` + `set_work_result()` | done |
| 8 | Draft GET/PATCH (`todos_api.py`) + BFF `api/todos/[id]/draft` + route-roles | done |
| 9 | `TodoDraftPanel` + `TodoRow` badge + `review` in stage maps/filters | done |
| 10 | Account-aware send (`_account_pconfig`; kept develop's `wa_bridge_owners` check) | done |
| 11 | `execute_proposal` + `_send` delegation + `--subject` | done |
| 12 | `_settle_todo_proposal`: execute-on-approve + feedback relaunch | done |
| 13 | Approvals UX: Revise field (`ProposalFeedback`) + action outcome notice | done |
| 14 | Triage surface — **reconciled**: `auto_work` added to develop's existing `GET /api/triage/status` + `TriageCard` pill (no parallel API) | done |
| 15 | Skills viewer — develop's existing TriageCard skill-file view/edit/history covers it | done |
| 16 | E2E test (`custom/tests/test_review_reply_loop.py`, 12 cases) + docs | done |

### Port deltas vs the main build

- `spawn_seeded_session` keeps develop's `internal_user_id`/`internal_user_role`.
- Develop's `_whatsapp_bridge_send_denied` + `bridge_ports()` kept intact;
  account routing composes with both (fail-closed when unresolvable).
- `_parse_command_routing` in `todos_cmd` is now an alias of the shared one.
- Guard-test compliance: draft routes declared in `route-roles.json`;
  `ActionButton` used in `TodoDraftPanel`/`ProposalFeedback`.
- `TodoDraftPanel`/`filters.ts`/`STAGE_ORDER`/`DEFAULT_STAGES` include `review`.

### Verified (on this branch)

- `custom/tests/test_review_reply_loop.py` — 12/12 pass.
- `tests/hermes_cli/test_todo_store.py` + `test_todo_outbound.py` +
  `test_triage_todos.py` + `test_triage_inbox_importance.py` — pass
  (`LIVE_STAGES` assertion updated for `review`).
- `agent-home` `tsc -p . --noEmit` — clean; `route-roles` + `busy-button`
  guard tests pass; full vitest run pending CI.
- `python -m py_compile` on all touched Python files — clean.

### Not yet verified

- Live loop on the box (needs deploy + `triage.auto_work` config flip).

## Known follow-ups (not in scope)

- WhatsApp bridge QR onboarding stays box-side.
- `send_message_tool` account support beyond email/WhatsApp.

## 2026-11-27 — Project detail redesign PR3: Start run dialog

- `StartRunSheet` per the approved mockup (frame `1:277`): plan-version
  select wired to the real `playbook_rev` API, iteration-batch row over
  current inputs (`N inputs · K new since R{m}`), input chips, and an
  estimate from prior runs' duration/cost + `checkpoint` step count.
- Header "Start run" opens the dialog; on success it selects the Runs
  step. Approximations: no batch entity exists (single info row), cost
  read defensively from the runs record endpoint.
- Verified: tsc, eslint, projects suite 1100 green, hint-ratchet green.
- Plan: `plans/2026-11-27-project-start-run-dialog.md`.

## 2026-11-27 — Project detail redesign PR4: Requirements doc editor

- `RequirementsDoc` per the mockup: labelled doc (Goal/Sources/Audience/
  Done when) + source chips + add row (dropzone + link), agent-proposed
  directives as accept/reject rows, Save→PATCH diff only, and a shared
  `VersionRail` (v1=first draft + one row per landed change).
- `reqdoc` is now the Requirements step's top part; clarify stays below;
  `?tab=inputs` lands on the doc.
- Approximations in the plan file: vN derived from change count, no
  plan-lineage field, no folder/VPN link kinds.
- Verified: tsc, eslint, projects suite 1103 green, ratchet green.
- Plan: `plans/2026-11-27-project-requirements-doc.md`.

## 2026-11-27 — Project detail redesign PR5: Plan step

- `PlanStep` per the mockup: stale-requirements banner (real timestamp
  compare vs `activated_at`), toolbar w/ Steps⇄Diff toggle (`planDiff` +
  `PlanDiffView`), step rows w/ assignee pill + `Why:` reason +
  checkpoint `Needs approval`, Edit → full `PlanPanel`, `Make cards` →
  Cards step, and the shared `VersionRail` w/ runs grouped by
  `playbook_rev` in USED BY.
- Approximations: no per-step source chips (not stored), Make cards
  navigates, no `from Req vN` lineage. `PlanTab` deleted.
- Verified: tsc, eslint, projects suite 1106 green, ratchet green.
- Plan: `plans/2026-11-27-project-plan-step.md`.
| 2026-11-27 | PR6 — Cards step: Kanban⇄Graph + 300px detail panel (CardsStep; BoardView stays for BoardPanel/page) | plans/2026-11-27-project-cards-step.md |
| 2026-11-27 | PR7 — Agent co-author panel: context strip, suggestions, proposal diff card, rail needs-you badge; Start-run primary only on Runs (#1144 dec. 3) | plans/2026-11-27-project-agent-panel.md |
| 2026-11-27 | PR8 — Compare runs: Swap/Open R, self-score + approvals rows, accent diff tint, what-changed bullets | plans/2026-11-27-project-compare-runs.md |
| 2026-11-27 | Backend gaps decided (Yan): explicit req versions + agent proposals, named iteration batches, hybrid compare summary, agent_progress timeline events | plans/2026-11-27-projects-backend-gaps.md |
| 2026-11-27 | B1 — iteration batches: table + batch_id on runs, picker in Start-run dialog, batch in run meta + compare (#1148) | plans/2026-11-27-projects-backend-gaps.md |
| 2026-11-27 | B2–B4 — requirement versions + plan lineage, agent_progress Working checklist, compare "agent's read" link | plans/2026-11-27-projects-req-versions-progress.md |
| 2026-11-27 | Deployed develop @ d823bf951 to the box; follow-up fixes: B1–B4 follow-through gaps (i18n/zh-Hant, BFF route-roles, rawFetch) #1152, Start-run footer scroll #1153; route-auth declarations #1150 | plans/2026-11-27-projects-req-versions-progress.md |
| 2026-11-27 | Releases: v0.2.19 published (tag moved to fixed commit), superseded by v0.2.20 (Latest) — HSD upgrades via software-upgrade page; no data migration needed on either box | — |
| 2026-11-27 | Repo transferred leolau/aquarium → ai-Aquarium/aquarium; refs updated in #1157, old signing identity still accepted | — |
| 2026-11-27 | C1 — Project header dedupe: one meta line (category inline), one attention pill w/ needs-you count, ONE ⋯ menu (lifecycle + More merged), JourneyBar+LiveStatusBar flattened into one status card | plans/2026-11-27-project-detail-cleanup.md |
| 2026-11-28 | C2 — Requirements long lists: collapsible counted DocSections (persisted), sources >8 become grouped compact rows with search + kind filters + "Show all N" (#1162) | plans/2026-11-27-project-detail-cleanup.md |
| 2026-11-28 | C3 — Title band: header + toolbar merged into a full-width band above both columns (title left w/ Add/Edit/Summarise + About beneath; meta+pills and actions stacked right). PageHeader gains `titleSrOnly`; band lives in ProjectDetailView, spans over the chat column | plans/2026-11-27-project-detail-cleanup.md |
| 2026-11-28 | Fix: legacy `path`/`workspace` output deliveries outside the managed roots (e.g. `auction-work/`) open + download again — read-side serves refs under the kanban home; missing files now flag instead of dead Open | — |
| 2026-11-28 | Iterations restore + Run note: `iterations` rejoins STEP_PARTS.runs (Standing instructions / iteration history reachable again — they were orphaned by the step-nav redesign); Start-run dialog gains "Note for this run" → `project_runs.note` → `### This run only` in the compiled guidance (one-off, never a directive) | plans/2026-11-28-run-note-iterations-restore.md |
| 2026-11-28 | Blocked-card banner: board payload gains `blocked_at`/`block_reason`/`run_no`; needs-you items label each block with its run scope ("not part of run 4"), its ask ("asked 6d ago" + reason), and rank the open run's own blocked cards first | plans/2026-11-28-blocked-banner-run-scope.md |
