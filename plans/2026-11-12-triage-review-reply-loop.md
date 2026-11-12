---
title: "feat: Triage → Work → Draft → Review → Reply loop"
status: approved — in implementation
date: 2026-11-12
type: feature
target_repo: ai-prentice-4-all (aquarium)
depends_on:
  - docs/plans/2026-08-11-001-todos-staging-layer-plan.md
  - docs/plans/2026-08-13-001-todos-and-projects-design-revision.md
  - docs/design/TRIAGE_SKILLS_SYSTEM.md
---

# Triage → Work → Draft → Review → Reply loop

## The workflow

1. User sets up triage channels (email or WhatsApp).
2. User sets up triage skills that classify messages; for the most important
   ones the skill creates a work task — e.g. draft a quotation automatically —
   and notifies the user when the draft is completed.
3. The user is notified on the landing page and over messaging that a draft is
   ready for review.
4. The user logs in, reviews the draft, and makes minor adjustments.
5. The user lets the agent reply via email or IM (same account the message
   arrived on — C4).

## What already exists (verified 2026-11-12)

- `custom/` pipeline: multi-account IMAP poller, WhatsApp bridge batchers,
  skill-driven triage agents (hot-reloaded `.md` layers), `wa_tasks`/
  `email_tasks` extraction, `register_todo` bridge into the principal-scoped
  to-do store, escalation + digest pushers to Telegram.
- To-dos: staged→open→working→done lifecycle, dedupe, `/todos` page,
  `POST /todos/{id}/start {session:true}` → `spawn_seeded_session`,
  `/todos/{id}/promote` → project card.
- Notifications: FG-10 `NotificationStore`, Inbox approvals tab, in-app bell,
  web push (`plugins/platforms/app/push`), Telegram push, project-run
  checkpoint approvals.
- Outbound seam: `todo_outbound.propose` raises an irreversible approval
  carrying `hermes todos send ...`; `todos_cmd._send` delivers via
  `send_message_tool` (email SMTP adapter, WhatsApp bridge `/send`,
  `WHATSAPP_BRIDGES` named bridges).

## Gaps this plan closes

| # | Gap | Evidence |
|---|-----|----------|
| G1 | No auto-start of work from triage — "Work on this" is human-clicked | `todos_api.start_todo` requires POST |
| G2 | No notification when a work session finishes / draft ready | `record_session` stores a pointer only |
| G3 | No draft artifact linked to the to-do | no draft convention; `file_registry` is inbound-only |
| G4 | Approving a proposal does NOT send — `answer()` settles the row, the `hermes todos send` command is never executed | `human_comms.answer`; §9 follow-up never shipped |
| G5 | `--account` sends are refused — C4 same-account routing not honored | `todos_cmd._send` refuses when `--account` set; `send_message_tool._handle_send` discards `account` |
| G6 | Approval answer can't carry feedback back into work | answer stored verbatim, no routing |
| G7 | Messaging push is Telegram-only | `push_todo` → `escalation_pusher_v2.send_telegram` |
| G8 | WhatsApp channel has no agent-home setup surface (email does) | `ConnectedAccounts.tsx` only lists "email" |

### Design decisions (user-confirmed 2026-11-12)

- Auto-start is **capability + skill-driven**: a new `work_request` field in the
  triage response schema lets the skill decide what deserves work and whether
  it auto-starts; a config kill-switch (`triage.auto_work`) gates it.
- The draft is **both** a file artifact (view/edit in agent-home) and a live
  session (chat-based adjustment).
- Approving **executes the send inline**; a free-text answer routes back as
  work feedback.
- Plan + status docs live in `plans/` and are checked in.

## Implementation steps (≈30 min each)

### Milestone A — auto-work + completion notify

1. `plans/` docs + `implementation-status.md` scaffolding.
2. `work_request` field in `custom/skills/{whatsapp,email,calendar}-triage/response-schema.md`.
3. `@register('work_request')` handler in `custom/shared/triage_handlers.py`
   → `register_todo` with work instructions; `auto_start` honored when
   `triage.auto_work` config gate is on.
4. `hermes_cli/todo_work.py` — shared launcher extracted from
   `todos_api._spawn` (prompt build, seeded session, `record_session`),
   reused by the HTTP route and the triage handler.
5. Completion hook: new `review` to-do stage (`todo_store.py`,
   `STAGE_STATUS`, agent-home `STAGE_LABEL`) + FG-10 `proactive_ask`
   notification "Draft ready for review" deep-linking `/todos/{id}`.
6. Messaging push for draft-ready via `send_message_tool` to a configured
   `notify.im_target` (WhatsApp/Telegram) + web push.

### Milestone B — draft artifact

7. Draft convention: session writes `DRAFT.md` + `REPLY.txt` under
   `$HERMES_HOME/drafts/todo_<id>/`; new `work_result` JSON column on `tasks`
   captures paths + summary.
8. `GET/PATCH /api/todos/{id}/draft` in `web_server.py` + agent-home BFF route.
9. `TodoDetailView` draft panel (view + inline edit → PATCH) + `TodoRow`
   "draft ready" badge; session link retained for chat adjustment.

### Milestone C — reply execution

10. Account-aware send: `_handle_send` honors `account` — WhatsApp →
    `phones[].bridge_port` (or `WHATSAPP_BRIDGES` name); email → custom
    `config.json` account SMTP + `credentials_env`; `subject` passed through
    (email plugin `_standalone_send` reads `extra.password_env`/`extra.subject`).
11. `todo_outbound.execute_proposal(todo_id)` — the `_send` core as a
    reusable coroutine; `todos_cmd._send` delegates; account refusal removed.
12. `comms_answer_notification`: `answer == "approved"` on a proposal →
    `execute_proposal` inline; free text → relaunch work with feedback,
    todo back to `working`.
13. `ApprovalsList` approve + free-text feedback UI; send outcome shown.

### Milestone D — setup UX + E2E

14. `GET /api/triage-channels` (accounts, bridges, enabled, auto_work flag)
    + Settings panel — WhatsApp visible alongside email.
15. Triage skills viewer (read-only: loaded skill files + flags per channel).
16. `custom/tests/test_triage_loop_e2e.py` full-loop test; docs +
    `plans/implementation-status.md` update.

## Invariants kept

- System proposes, only the user sends — approval still `reversible=False`.
- No new core model tools; everything lands in custom/, hermes_cli, agent-home.
- `auto_work` config-gated (default off) until observed on the box.
- Send keeps approval-state validation + replay guard (single-use approval).
