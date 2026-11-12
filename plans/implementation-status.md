# Implementation status

Tracking file for in-flight feature work. Update as phases land.

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
