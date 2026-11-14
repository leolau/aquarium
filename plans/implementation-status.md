# Implementation status

Tracking file for in-flight feature work. Update as phases land.

## Data dictionary — Phase 6: schema change check

Plan: `docs/plans/2026-11-14-001-data-dictionary-semantic-layer-plan.md`
Branch: `devin/1794652805-data-dictionary-plan` (PR #921, draft)
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
