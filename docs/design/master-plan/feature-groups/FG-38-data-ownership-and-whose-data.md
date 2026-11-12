# FG-38 — Data ownership and the "whose data" picker

Every file, incoming email/message/calendar event, memory, RAG document and
2-D memory point belongs to one person, so the system can always say whose it
is. Owners and admins pick whose data a page shows (several people at once);
the default is your own.

## Requirement (from Leo)

> "Files, incomings emails, messages and calendar all belongs to an user.
> Therefore, the system can trace which is the owning user of these data. In
> the files page, owner and admin can select (with multiple selection) of
> viewing who's data. The default is the login user's own data;
> Long term memory (RAG & memory data points) are also owned by the user who
> ingress the files or write the prompt or initiate the cron/projects that
> collected the data. In the 2D memory graph, owner and admin can select (with
> multiple selection) of viewing who's data. The default is the login user's
> own data."
>
> "security and access right is very important"

## Decisions (Leo, 2026-11-12)

1. **Who an admin can pick:** themselves, members and viewers — never another
   admin and never the owner (FG-21's downward-only ladder). The owner picks
   anyone.
2. **When the picker opens up:** only when the owner has turned on
   `memory.sharing.role_reads`. Off (the default) means everyone sees only
   their own data (plus `shared` rows and item grants). The switch already
   covers files and incomings as well as memory (`FileRegistry` /
   `InboundRegistry` take `role_reads`).
3. **Box-wide accounts** (a shared mailbox, the box's WhatsApp number, a
   calendar connected before per-person setup): their arrivals belong to the
   person who connected the account; with no known person they go to the
   owner, and the owner can reassign each account to somebody in Settings.

## Contract (shared by every phase — do not change without updating this doc)

- **Owner vs actor vs account.** `owner_user_id` is whose the content is.
  Audit rows (`changes`, `interactions`, `memory_audit`, …) record who *did*
  something and are never rewritten as ownership. An integration account
  (mailbox, bridge, calendar) has its own owner; what arrives through it
  inherits that owner.
- **Derived data inherits its source's owner.** A RAG document, its chunks and
  their map points belong to the owner of the file/arrival/prompt they came
  from. Only that owner may "remember" or forget it.
- **Runs act as their person.** A chat turn, a scheduled job and a project run
  each carry the principal that started them, so what they read is that
  person's scope and what they write is that person's.
- **`owners=` is a filter, never an identity.** Read endpoints take
  `owners=a,b,c` (comma-separated, validated C1 ids, at most 50). It is ANDed
  onto the caller's own scope predicate and RLS, so it can only narrow:
  naming somebody you may not read returns none of their private rows.
  Cross-person reads it does return are elevated reads, labelled and audited
  as FG-21 describes.
- **`?as=` is owner-only and GET-only.** Narrowing with `?as=` /
  `X-Hermes-User-Id` *becomes* the target principal (role and item grants
  included), which is only safe for the owner, who already reads everything.
  An admin's `?as=` is a 403; a member's is ignored; any non-GET/HEAD ignores
  it. Files, incomings and the memory explorer do not accept `?as=` at all.
- **The UI is not the boundary.** The picker lists only people the caller may
  read, but every API re-checks through the scope predicate and RLS.

## Phases (one PR each)

| Phase | What | Status |
|-------|------|--------|
| P0+P1 | `?as=` owner-only + GET-only; `owners=` filter on `/api/files`, `/api/incomings`, `/api/memory/explorer/rows` and `/projection`; e2e tests over real Postgres | done (#879, #884) |
| P2a | Correct owner at arrival: calendar → who connected it, WhatsApp → who added the bridge (by port), shared mailbox → entry's `owner_user_id` else who saved its credential; attachments/media follow; unknown → install owner, known-but-inactive → dropped | done (#892, #894) |
| P2b | Raw SQLite stores closed to the terminal user (`deploy/hermes-close-data`), not given owner columns: people only see the owner-scoped Postgres copy. One Postgres account→person map (Settings choice → poller config entry → who connected it → install owner), owner-only Settings › Accounts page in agent-home to reassign each account for new arrivals. Email/WhatsApp tool servers stay off until they carry the caller's identity | in progress |
| P3 | Scheduled jobs and project runs store and run as their person (memory/RAG written by them is theirs) | planned |
| P4 | agent-home "Whose data" multi-select on Files and the 2-D memory map (then Incomings, scheduled jobs), default = me, Owner column; a "people I can view" endpoint for the picker | planned |
| P5 | Re-attribute existing rows on the production box — counts first, snapshot, tagged and reversible, only with Leo's yes | planned |
| P6 | Ownership guard test: every app table has `owner_user_id` + visibility + forced RLS, or is on a reviewed allow-list (system/audit tables); transfer/purge covers each one | planned |

Also in scope after P4 (each needs an owner and, where it has a list page, the
picker): chat sessions list, contacts, todos/needs-you, goals/tasks. Owner-only
surfaces: activity/audit logs, backups and exports.

## Progress log

| Date | PR | Notes |
|------|----|-------|
| 2026-11-12 | P0+P1 | `?as=` gated in `_comms_resolve_principal`; `parse_owner_filter` in `hermes_cli/access.py`; `owners=` on files, incomings, memory rows and projection (`owner=` still accepted on rows). |
| 2026-11-12 | P2a | `account_owner`/`_mailbox_cred` in `email_poller.py`, `phone_owner` in `batcher.py`, calendar uses `credentials.owner_user_id`; `register_file(owner_user_id=)`. Inbound key is `(owner_user_id, surface, account_id, external_id)`, so a reassignment makes new rows: P5/P2b must move old ones explicitly. |
| 2026-11-12 | P2b (stores) | Box had `email-messages`, `whatsapp-messages`, `calendar`, `backups`, `restore-*` readable by `hermes-tools` (terminal + file tools). Closed by hand (snapshot first), and `hermes-close-data` now runs on every deploy: 750, group hermes, owner root/hermes. |
