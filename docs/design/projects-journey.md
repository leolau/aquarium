# Projects journey — "what do I click next?"

Owner complaint: *"from creating a project to finishing it, user needs to know
exactly which button to click at which phase, and needs to scroll and find
these buttons."*

The next-step logic already existed (`dashboard/nextAction.ts`, readiness,
derive) — it was simply rendered too low: the Dashboard tab's hero sat under
the header card, the live-status bar and the ask box, while the header and the
live bar carried their own, partly duplicate, Run now / Activate / Continue
buttons. This document is the lifecycle audit (step 1) and the resulting
layout (step 2).

## Audit — before → after

Measured against the code and a mocked local render (390px phone, 1366px
desktop). "Scroll" is screen-heights at 390px from the top of the page.

| Phase | What the user must do | Where the button was | Clicks / scrolls (before) | Now |
| --- | --- | --- | --- | --- |
| Create | Fill the 4-step wizard | Projects list → **New project** → `NewProjectForm` | 4 steps + Create; lands on the plan/scope tab with no orientation | Unchanged wizard; first landing shows a one-time hint on the journey bar |
| Readiness · outputs | Declare at least one output | Header `ReadinessChecklist` link → Outputs tab; the add form is below the list | 1 click + find the form (≈1 scroll) | Bar line "N of M ready — next: declare an output" → opens Outputs, scrolls to + rings `#add-output` |
| Readiness · profile | Pick a profile to run on | Checklist link → Settings / People | 1 click + scroll to the panel | Bar line → `#panel-people` |
| Readiness · plan | Draft / activate a plan (or let the agent ask scope first) | Checklist link → Plan tab; Dashboard hero "Let the agent ask" | 1 click, hero ≈2 scrolls down | Bar primary (scope / plan action) or bar line → `#panel-plan` |
| Readiness · schedule | Set the schedule (repeatable) | Checklist link → Settings | 1 click + scroll | Bar line → `#panel-settings` |
| Activate | Set status Active | Header **Activate**, checklist "Activate it", hero | 1 click, but 3 places and the checklist text pointed at "the top of this page" | Bar primary **Activate** (or the bar's inline Activate when a softer step ranks first) |
| Start run | Start iteration N | Header **Run now**, `LiveStatusBar` **Start**, hero **Start iteration N** | 1 click, 3 competing buttons | Bar primary only |
| Cards / approvals | Approve the agent's triage cards | Dashboard hero "Approve N cards & resume work"; Board → Triage | Hero ≈2 scrolls on phone, or tab + per-card clicks | Bar primary (same batched `approve_cards` mutation) |
| Running | Nothing — watch | Header "Run N in progress" link; `LiveStatusBar` | 0 | Bar "Running" + "Watch run N"; live bar keeps the stop controls |
| Waiting (checkpoint) | Continue the run | Header **Continue run N**, `LiveStatusBar` **Continue**, hero | 1 click, 3 duplicates | Bar primary only |
| Blocked card | Retry / unblock | Dashboard hero / Needs-you row; Board | ≈2 scrolls, or Board tab | Bar primary **Retry**; other blocked cards stay in Needs you |
| Failed / stalled run | Resume or retry | Dashboard hero | ≈2 scrolls | Bar primary |
| Review outputs | Open outputs, accept or request a change | Hero "Review outputs" → Outputs tab; Accept per output | ≈2 scrolls + tab + per-output Accept | Bar primary → Outputs tab; Accept stays per output (item-level) |
| Accept → done | Mark the project done | `⋯` lifecycle menu, or hero when everything is accepted | Hidden in `⋯` or ≈2 scrolls | Bar primary **Mark done** (lead-only; reason shown to others) |
| Done | Nothing; reopen/archive if wanted | `⋯` menu | — | Bar "Done" highlighted; `⋯` keeps Reopen / Archive |
| Paused | Re-activate | Header **Activate**, checklist | 1 click | Bar "Ready" + **Activate** |
| needs_completion | Fill the missing fields | Checklist links | 1 click per gap + scrolls | Bar "Set up" + guided line |
| Archived | Nothing (read-only) | `⋯` → Unarchive | — | Bar "Done"; no action |

## Layout

1. **Title card** — name, health, `⋯` lifecycle menu, category, meta line.
   No Run now / Activate / Continue.
2. **Journey bar** (sticky, phone + desktop), directly under the title:
   `Set up → Ready → Running → Review → Done`, current step highlighted;
   headline; **one** primary button = `nextAction().primary` through
   `DashActionButton` → `useProjectAction` (no new mutation path); inline
   disabled reason (`primaryBlockedReason`, mirrors `_can_write` /
   `_can_member_act`); the existing `confirmedText()` line after each action,
   kept while the bar advances; guided readiness line.
3. **Details card** — compact toolbar (Add · Edit · Summarise), collapsible
   **About** (goal, usage, summary) and a collapsed "Before it can run · N of
   M ready" checklist.
4. `LiveStatusBar` with `ownsNextStep={false}`: not sticky, no Start /
   Continue and no "Next for you" line (stop controls stay) — the page has one
   voice for the next step.
5. Ask / change box, tabs. The Dashboard tab drops `NextActionHero`; its
   Needs-you list marks the bar's item "↑ above".

## Derivation

`journeyPhase(project, readiness, nextAction)` in `dashboard/journey.ts` is
pure:

- `archived` / `done` → **Done**
- waiting / stalled / failed / working run, triage approvals, blocked cards →
  **Running**
- delivered-not-accepted outputs, or everything accepted (Mark done) →
  **Review**
- never ran and readiness gaps (outputs, plan, scope, activation),
  `needs_completion` → **Set up**
- runnable but not started, or re-activation after a run → **Ready**

The list chip (`projectNextStep`) uses only `ProjectListItem` fields (status,
health, output rollup, card rollup) — no per-row fetches — so it is
deliberately coarser than the bar.
