# Session hand-off — chat/projects perf, blocked-card UX, kanban auto-retry, release + deploy

For whichever agent/human picks this up next. Everything below shipped and
is **live on production** (Hetzner box, `<prod-host>`) as of this
writing, except one explicitly flagged open item at the bottom.

## What happened, in order

1. **Chat + projects performance review** (user-reported: chat interface
   and projects interface felt slow).
   - Found: `ChatPane` re-renders on every streamed token and once a
     second while a turn is in flight; `MessageBubble` wasn't memoized, so
     every message in a long thread re-ran its media-segment regex and a
     full Markdown re-parse (`react-markdown`/`remark-gfm`/`rehype-raw`/
     `rehype-sanitize`) on every one of those re-renders — not just the
     bubble actually streaming.
   - Fix: wrapped `MessageBubble` in `React.memo`
     (`agent-home/src/components/chat/MessageBubble.tsx`).
     `lib/chat/messages.ts`'s `setLastAssistantContent` already preserves
     object identity for every message except the trailing one, so this
     is a real skip, not just a re-render with the same output.
   - Projects interface: reviewed list/detail/live-poller — already
     keyset-paginated, debounced, visibility-gated; no changes needed.
   - Docs: `plans/2026-09-13-chat-projects-performance-review*.md`.
   - Landed via PR **#390** → re-merged as **#391** (a branch got reused
     by another concurrent session between the two; #391 is the one that
     actually merged into `develop`).

2. **Blocked-card missing reason** (user-reported via screenshot: a
   `blocked` project card showed nothing explaining why or what to do).
   - Root cause: `kanban_block` *requires* a `reason` string, stored via
     `kanban_db.block_task()` → `task_runs.summary`. The board-list
     endpoint already attached it (`kanban_db.latest_summaries()`), but
     the **single-card detail** endpoint (`GET /{slug}/cards/{task_id}` /
     `get_card()` in `hermes_cli/projects_api.py`) called
     `kanban_view.task_dict(task)` with **no** `latest_summary` at all —
     the reason a worker was required to give never reached the page.
   - Fix: `get_card()` now fetches `kanban_db.latest_summary()` and passes
     it through. `agent-home`'s `CardDetailView.tsx` now shows a dedicated
     "why blocked + what to do" banner (block-kind label, the reason
     text, a pointer at the existing Edit card / Make ready controls)
     instead of a silently-empty section.
   - Docs: `plans/2026-09-13-blocked-card-missing-reason*.md`.
   - Landed via PR **#392**.

3. **Kanban auto-retry timer** (follow-on from #2: the specific card that
   prompted the report hit Canva's *daily* generation limit — a human
   would otherwise have to notice and manually click "Make ready", often
   right around when the quota would've cleared anyway).
   - Added: `block_task(..., retry_after_seconds=N)` stamps a `retry_at`
     column; `auto_retry_timed_blocks()` unblocks any task whose timer
     has passed, wired into the existing `dispatch_once` tick (no new
     background loop). `kanban_block` tool gained an optional
     `retry_after_seconds` parameter for the model to use. Loop safety is
     the *existing* unblock-loop breaker (`BLOCK_RECURRENCE_LIMIT`) — a
     wrong retry-time guess costs one wasted attempt, not an infinite
     loop, since a same-cause re-block after auto-retry still counts
     toward escalation to `triage`.
   - Notifications (`gateway/kanban_watchers.py`) and CLI output
     (`hermes kanban dispatch`) both surface the new `auto_retry` event.
   - Docs: `plans/2026-09-13-kanban-auto-retry-timer*.md`.
   - Landed via PR **#393**.

4. **Release**: promoted `develop` → `main` via PR **#394** ("Release:
   develop → main (#386–#393 …)"), matching this repo's established
   `Release: develop → main` PR pattern.

5. **Production deploy**: ran `/opt/data/deploy-hermes.sh develop` on the
   Hetzner box over SSH. Pre-flight checked no running kanban tasks, deploy
   tool freshness, and Supabase/systemd health before triggering. Result:
   `deploy OK (04f38aaef)`, all 15 services restarted `active`, health
   check green (11/11 docker healthy, dashboard 302, agent-home 200, embed
   responding). Backup at `/opt/data/backups/deploy-20260913-114659`.
   `agent-home` correctly did NOT rebuild (that diff touched no frontend
   sources — the frontend fix from #392 was already built into `.next`
   from an earlier deploy). Two pre-existing failed units
   (`cloud-init-hotplugd.service`, `hermes-secret-backup.service`) are
   unrelated to this work — did not touch them.

Since then, another concurrent session/agent shipped **Folder Bridge**
(PR #395, docs PR #397) and released it too (PR #398, `develop`→`main`).
As of this note, `origin/main` and `origin/develop` are in sync (0 commits
apart) at `83df0eeca` — this hand-off's work (#390–#394) is a subset of
that history, already fully included.

## What's still open

**The specific live card.** The whole chain above (#2 + #3) was motivated
by one real card — "Execute prompts in Canva" — that hit Canva's daily
limit and sat `blocked` with no explanation, on the project
`ai-professsional-builder-course-ppt`. The auto-retry *feature* is now
live, but it only applies going forward: that card was blocked **before**
the feature shipped, so it has no `retry_at` timer stamped and is still
just sitting `blocked` waiting for a human.

I offered to either (a) check the card's live status and unblock it now
if Canva's quota has actually reset, or (b) stamp a `retry_at` on it
directly so it self-resolves without a manual click — but the user's
session ended (environment/IDE context switched) before they answered.
**Whoever picks this up: ask the user which they want, or just check
`hermes kanban show <card id>` on the Hetzner box (SSH:
`ssh root@<prod-host>`, box details
in `docs/deployment/PRODUCTION.md`) and use judgement** — if the quota has
visibly reset (a day has passed since the block), unblocking it outright
is probably just correct; if unsure, ask first per this repo's own norms
around live production changes.

## Where things stand in this specific worktree

This worktree (`ai-prentice-4-all-amber-lovelace`) is shared with other
concurrent agent sessions — branches and uncommitted working-tree changes
here have been swapped out from under this session multiple times (e.g. a
`fix/chat-messagebubble-memo` branch picked up an unrelated commit from
another session mid-flight; a root `HANDOFF.md` sits modified-but-uncommitted
right now from something else entirely). None of that is this hand-off's
to manage — if you're picking this up in this same worktree, check
`git status` before assuming a clean tree, and don't assume the checked-out
branch reflects only this note's history.

All the actual code from this hand-off is merged and deployed already
(see PR numbers above) — nothing here is uncommitted or unpushed. This
note itself was branched fresh off `origin/develop` to avoid inheriting
any of that other session's in-progress state.
