---
title: "handoff: To-dos ed.2 / Projects — what was fixed, how it was verified, and the traps that hid the bugs"
status: handoff — S1–S6 closed and verified; two named gaps remain open by design
date: 2026-08-14
type: session handoff
target_repo: ai-prentice-4-all
verified_against: develop @ f605f8088 (re-checked; the S1–S6 code is unchanged since 9eaabbb95)
history:
  - 9eaabbb95 develop — S1–S6 all verified fixed (fourth pass)
  - e45af7c1d main — released and deployed to the ECS systest box
companions:
  - docs/plans/2026-08-14-001-todos-ed2-implementation-review.md (the review; item-by-item detail)
  - docs/plans/2026-08-13-001-todos-and-projects-design-revision.md (the design being reviewed)
---

# Handoff — To-dos ed.2 review cycle

Read the review doc for per-item detail. This document is the part that is *not* in the
review: how the defects were found, how to re-run the checks, and which conclusions are
load-bearing for anyone touching this code next.

---

## 1. Where things stand

`docs/plans/2026-08-14-001-todos-ed2-implementation-review.md` went through four passes:

| pass | baseline | outcome |
|---|---|---|
| 1st | `develop @ 7e30a4424` | 20 findings against the ed.2 feature commit `f8bda1702` (#226) |
| 2nd | `develop @ 2e3b21ea5` | fixes #235/#238 closed 14; **6 did not close** (S1–S6), one regressed |
| 3rd | `develop @ 31e5133c2` | S1–S6 hold in code; S1's SQL had still never run against a database → tests added (#248) |
| 4th | `develop @ 9eaabbb95` | all six confirmed; S4's *cause* removed by the root Projects store (#251) |

Re-checked while writing this: at `develop @ f605f8088` the S1–S6 code is byte-identical to
the fourth pass. The only later change in this area is `todos_api.promote_todo` mapping
`ArchivedProjectError` → HTTP 409 (Projects Block 4f), which does not touch any of the six.

Released as #249 (`main`) and deployed to the ECS systest box: `deploy OK (e45af7c1d)`.

---

## 2. The one thing to carry forward

**Every one of the six second-pass defects was covered by a green test.** The tests mocked
the seam the bug lived in:

```python
store.list_outbound = AsyncMock(return_value=[])   # hid S1 entirely
kanban_db.create_task = Mock(...)                  # hid the promote 500 in the first pass
```

S1 is the sharpest case: `hermes todos send` was broken for *every* send, not just replays,
and the suite was green. It had two independent defects stacked, and either one alone still
fails the whole command:

1. `list_outbound()` selected/ordered by `created_at`; `task_transitions` has no such column
   (it is `ts` — `hermes_cli/task_registry.py`). Real Postgres:
   `asyncpg.exceptions.UndefinedColumnError: column "created_at" does not exist`, uncaught by `_run`.
2. Even with the column fixed, the replay guard compares `event == "sent"` while
   `record_outbound()` writes `to_state = "action:sent:whatsapp"` — so the guard could never
   fire. Hence `_parse_outbound_event()`.

Both were invisible to mocks and both are now caught: reverting either half turns
`tests/hermes_cli/test_todo_store_e2e.py` red (verified by actually reverting each).

**Rule for this subsystem:** anything crossing a real boundary — SQL, RLS/visibility,
Next.js caching, process environment, the Kanban writer — needs a real-path test. Mocking
the boundary tests only that the call was made.

---

## 3. The six fixes, and why they are shaped that way

- **S1 — outbound trail.** `list_outbound()` reads `ts` and normalizes `action:<event>:<...>`
  down to the bare event via `_parse_outbound_event()`. `session` pointers stay distinct from
  `sent`, so a spawned session is not mistaken for a delivery. Principal visibility preserved.
- **S2 — memory-doc lookup.** Needs **both** `bind_principal()` *and* `scope_filter()`. The
  earlier fix swapped `scope_filter` out for `bind_principal`, which widened the lookup:
  `rag_documents` has no effective RLS policy in this repo, so the bound GUCs are inert. Bind
  for the future, filter for today.
- **S3 — `MobileShell` badge cache.** Resolve cookies/session *outside* `unstable_cache`
  (Next 15 rejects `cookies()` inside it) and pass `hermesToken` as an argument so it becomes
  part of the cache key. Keying on a constant string served one principal's open count to
  another.
- **S4 — cross-profile promote.** First mitigation deleted the orphan card when `project_id`
  failed to resolve. The real fix was #251 moving the Projects store to the shared root
  (`kanban_home()/projects.db`), so promotion resolves the project regardless of profile;
  `kanban_db.list_tasks(project_id=…)` accepts an ID or a slug. The cleanup path stays as a
  backstop.
- **S5 — `--account`.** Fail-closed: `_send()` refuses an approval carrying `--account`
  because `send_message_tool._handle_send()` reads only `target`/`message` and drops the
  account key. A refusal, *not* multi-account routing (see §5).
- **S6 — session workdir.** `spawn_seeded_session()` no longer mutates process-global
  `os.environ["TERMINAL_CWD"]` (contextvars do not isolate `os.environ`, so concurrent
  sessions clobbered each other). It calls `set_session_cwd()` on a `ContextVar`, read back
  by `agent/runtime_cwd.resolve_agent_cwd()`. Partial — see §5.

---

## 4. How to re-verify (commands, not prose)

```bash
cd /home/ubuntu/repos/ai-prentice-4-all && source .venv/bin/activate

# targeted suites — 75 passed at 9eaabbb95
timeout 600 python -m pytest \
  tests/hermes_cli/test_todos_cmd.py \
  tests/hermes_cli/test_todos_ed2.py \
  tests/hermes_cli/test_todos_promote.py \
  tests/hermes_cli/test_todo_store_e2e.py \
  tests/hermes_cli/test_projects_root_store.py \
  tests/hermes_cli/test_kanban_project_link.py -q

ruff check hermes_cli/todos_cmd.py hermes_cli/todos_api.py hermes_cli/todo_store.py \
  hermes_cli/kanban_db.py hermes_cli/projects_db.py agent/seeded_session.py
```

`test_todo_store_e2e.py` brings up Postgres in Docker itself and **skips** when Docker is
absent — a skip is not a pass, so check the summary line, and run it on a box with Docker
when touching the store's SQL. The S1 cases are
`test_the_outbound_trail_reads_back_with_parsed_events` and
`test_the_outbound_trail_is_invisible_to_another_principal`.

Two useful techniques from this session:

- **Reverting the fix** is how you prove a regression test earns its place. Restore the file
  from a backup copy afterwards — do not leave a mutated working tree behind.
- **Throwaway probes** against a temp SQLite board are the fastest way to check Kanban/Projects
  behaviour. Signature traps that cost time: `Principal(user_id=…, display=…, role=…)` has no
  `profile` kwarg; `projects_db.create_project()` returns an **ID string**, not an object (call
  `get_project()` after); `kanban_db.create_task()` takes `project_id=`, not `project=`.
  Delete probe files when done (`tests/hermes_cli/test_zz_tmp_*` should never be committed).

---

## 5. Open, by design — not defects

1. **Multi-account sends are refused, not routed.** To lift S5's refusal, thread the account
   through `send_message_tool._handle_send()` (currently `args["target"]` / `args["message"]`
   only; the `account` at line ~1311 is platform config, not an arg) and then the platform
   adapter. Until then, leave the refusal in place — silently delivering by the wrong account
   is the worse failure.
2. **`_SESSION_CWD` is not read by the execution tools.** `resolve_agent_cwd()` is consulted
   by `agent/prompt_builder.py`, `agent/coding_context.py`, `agent/codex_runtime.py` and
   `gateway/session_context.py`, but `tools/terminal_tool.py`, `tools/file_tools.py`,
   `tools/code_execution_tool.py` and `tools/delegate_tool.py` still read
   `os.environ["TERMINAL_CWD"]` directly. Harmless while nobody passes `workdir`; it will bite
   the first caller that does. The follow-up is mechanical: route those reads through
   `resolve_agent_cwd()`.
3. **Never exercised live.** `hermes todos facets/list` run clean against the systest box's
   Postgres but return empty — nothing has triaged into to-dos there. So a real `send` and a
   real `promote` have never run against production data. Both are potentially irreversible
   (an outbound message; a board write), so they need seeded data and an explicit go-ahead.
4. **Unrelated red test on `develop`**, deliberately untouched:
   `agent-home/.../server-client-boundary.test.ts` flags `app/users/page.tsx` importing
   `PAGE_SIZE` from a `use client` module — from FG-26 (`f3613dccf`), predating this review.

---

## 6. Design invariants worth not re-litigating

Settled in ed.2/ed.2a (#206, #221) and upheld by the implementation:

- A **to-do** is one decision the user owes; a **project card** is multi-session work being
  executed. Neither is the other's list. To-dos are profile-scoped FG-06 rows
  (`staged → open → working → done | dismissed`, where `working` means *taken up*, not done);
  projects live on the shared-root Kanban board.
- **Promote is the only seam**, one-way and human-only: no heuristics, no auto-created project,
  no dispatch. It lands the card in `triage` (never `ready`), maps priority onto Kanban's
  integer scale, writes a `project_links` row (`kind='todo'`, owning profile, ref) as the
  provenance pointer, and moves the to-do to `working` — not `done`. There is deliberately no
  `project_id` column on the to-do store; the pointer lives on the project side. Promotion
  grants no access: cross-profile reads re-authorize under the caller's principal.
- **Approved sends** are single-use: find the approval by `dedupe_key = "todo-action:<id>"`,
  require answered **and** granted, refuse pending/denied/missing/routing-mismatched, take the
  body from the approval row (never argv), deliver via `send_message_tool`, record `sent` or
  `failed`.
- **`spawn_seeded_session()`** is thick on shared plumbing, thin on caller policy. It does not
  decide who waits: cron waits, HTTP `/start` detaches. `skip_memory` stays a parameter —
  cron `True`, a to-do session `False`.
- CLI actor flag is **`--actor`** (matching `goal_tree_cmd.py`), not `--as`.
- No seventh to-dos store; no new non-secret `HERMES_*` env vars; `agent-home/` is the
  user-facing UI and `web/` the operator/admin one.

## 7. Systest box, for the next deploy

Region `cn-hongkong`, instance `i-j6c81aisv2dd8mg17yle`, reached with Alibaba Cloud MCP
`OOS_RunCommand`. Checkout `/opt/data/hermes-agent`, `HERMES_HOME=/opt/data/hermes-home-staging`,
service user `hermes`, agent-home at `https://<agent-home-host>` (loopback `127.0.0.1:3100`;
dashboard `127.0.0.1:9119`). Deploy with `/opt/data/deploy-hermes.sh develop` and trust its own
`deploy OK (<sha>)` line. The agent-home build overruns the OOS request window — that is not a
failure, poll for the verdict. Afterwards check every enabled long-running unit is active, that
one-shot timer timestamps are *unchanged*, and that both HTTP endpoints answer 200. Do not print
secrets. See the `testing-hermes-systest-box` skill for the access path.
