# Blocked-card banner: run scope, age and the real ask

Date: 2026-11-28

## Why

HSD P7, run 4 open: the status card's "needs you" banner showed
`"Compile latest per-model price table" is blocked / It stopped on an error /
Retry` — which read like a run-4 failure. It wasn't: it was a **Nov-23
board-level card** (never part of any run) that had crashed twice. Meanwhile
the card that *was* blocking run 4 — "Top up inputs", `needs_input`, asking
for a network-drive reconnect that had already happened — sat lower in the
list with no timestamp, so its stale ask read as current.

Three gaps:

- **(a) No age** — a block from six days ago rendered identically to one
  from a minute ago.
- **(b) `needs_input` hid the ask** — the banner said "needs an answer" but
  never showed the worker's own reason text ("reconnect the drive, then
  unblock"), so a stale instruction couldn't read as stale.
- **(c) No run scope** — every board blocked card ranked equally regardless
  of which run (if any) it belonged to, so a week-old orphan outranked the
  open run's real ask.

## Backend — `project_board` (hermes_cli/projects_api.py)

For each `blocked` task on the board, the payload now also carries:

- `blocked_at` — `created_at` of the latest `blocked` `task_events` row;
- `block_reason` — `payload.reason` of that event (what the worker said);
- `run_no` — the project run the card belongs to via `project_run_cards`
  → `project_runs` (latest `run_no`), or `null` for a board-level orphan.

One batched event query + one batched run-link query; only for blocked rows.

## Frontend — `nextAction.ts`

- `blockedItem(card, open, now)`: detail now composes
  `kind text — reason (scope · asked|blocked <age>).`
  - scope: `run N` (in the open run), `run M, not run N` (older run's card),
    `not part of run N` (board-level orphan while a run is open), or `run M`
    (no run open, card still names its run).
  - age: `just now` / `Nh ago` / `Nd ago` — needs_input says "asked", the
    rest say "blocked".
- `needsYouItems`: blocked cards are partitioned — the open run's own
  blocked cards first, then the rest — so the banner's top item is the ask
  actually stalling this run.
- `ProjectBoardTask` gained `blocked_at?`, `block_reason?`, `run_no?`.

## Test plan

- `tests/hermes_cli/test_projects_board_api.py` —
  `test_board_labels_each_blocked_card_with_when_why_and_its_run`: a run-4
  `needs_input` card and a board-level orphan both blocked via
  `kanban_db.block_task`; asserts `run_no` / `block_reason` / `blocked_at`
  on each.
- `nextAction.test.ts` — in-run card outranks an older higher-priority
  orphan; detail contains run tag + reason + "asked Nh ago"; orphan reads
  "not part of run N · blocked Nd ago"; a card from a closed run still
  names its run.
