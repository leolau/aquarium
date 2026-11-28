# Kanban workers can deliver project outputs + card page shows its run

Date: 2026-11-29

## Why

P7 run 4's deliver card (`t_15426c76`) blocked `capability` after doing
all the real work: `hermes projects outputs <slug> deliver` is refused by
the agent terminal — `deploy/hermes-tools-cli`'s `COMMANDS` allowlist
permits `projects` only with `create`/`playbook`, and `as_requester`
refuses every ticketless `projects` call (workers carry no principal
ticket — they are not chat participants). Run 3 hit the identical wall
(`t_08323930`); both needed a human to hand-record the delivery.

Separately: `retain_delivery` refused `--ref` paths outside the board's
managed roots, yet the artifacts read serves anything under the kanban
home (`_delivery_servable`'s fallback) — so a run's shared working dir
(`auction-work`) was writable-by-deliveries at read time but refused at
record time. Write and read sides disagreed.

## Changes

### `deploy/hermes-tools-cli` — `projects outputs` for card workers

- `COMMANDS["projects"]["subs"]["outputs"]`: `<slug> [list | add <title>
  | deliver <output id>]` with `--spec/--optional/--recurring/--ref/
  --note/--task/--run/--json`. `accept` stays off — a human's act
  (FG-32 §6.1); `outputs add` is agent-proposable per the same doc.
- `KEEP_ENV` gains `HERMES_PROFILE` so `projects_cli`'s card-delivery
  path can attribute the delivery to the worker profile.
- `as_requester(..., worker=...)`: a ticketless `projects outputs` call
  carrying a valid `HERMES_KANBAN_TASK` (KEEP_ENV'd through sudo) passes
  without `--actor` — the CLI then resolves the enrolled **owner**
  principal, matching "agents deliver through this route too"
  (`deliver_output`). `--actor` on this path is refused: a card is not a
  person. Every other `projects` verb still fails closed without a
  ticket. The env marker is an intent check, not a security boundary —
  callers all share the one hermes-tools shell.
- The API already links `task_id` → the card's run inside
  `record_output_delivery`, and `HERMES_KANBAN_TASK` was already in
  KEEP_ENV — the delivery lands under the right run with zero extra flags.

### `projects_outputs_api._delivery_roots` — align write with read

Adds `kanban_db.kanban_home()` to the servability roots. Read-side
`_delivery_servable` has always fallen back to the kanban home for
recorded deliveries (that's how the pre-guard run-2/3 `path` records
still open); now a card can actually *record* a deliverable that lives
in a run's shared working dir.

### `projects_api._card_detail` + `CardDetailView` — run tag

The single-card payload now joins `project_run_cards → project_runs` for
`run_no` (same lookup the board does since #1177), and the card header
renders a `run N` pill next to the ref/status pills — an orphan card
shows none. `ProjectCardDetail` already inherited the field from
`ProjectBoardTask`.

## Tests

- `tests/deploy/test_hermes_tools_cli.py`: allowed argv for outputs
  list/add/deliver (incl. `--actor` on the ticketed path); refused for
  accept/remove/missing args/path-y ids/unknown options; new
  `test_projects_outputs_needs_a_worker_env_or_a_ticket` covering the
  worker carve-out, `--actor` refusal on it, ticketless refusal without
  the marker, and the marker not extending to `playbook`.
- `tests/hermes_cli/test_hermes_projects.py`:
  `test_outputs_deliver_a_shared_workdir_file` — a file under
  `HERMES_KANBAN_HOME` delivers as `link_kind "workspace"`.
- `CardDetailView.approvals.interaction.test.tsx`: `run 4` pill renders,
  and an orphan (`run_no: null`) shows no tag.

## Status

- 2026-11-29 — implemented; shim + projects tests green locally
  (132 passed, 1 docker-e2e skipped), frontend card tests green.
