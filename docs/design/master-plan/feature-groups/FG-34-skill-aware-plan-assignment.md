# FG-34 — Skill-aware plan assignment (every card goes to the best-suited profile, and the plan says why)

**Wave:** P9-A (after FG-32) · **Owner agent:** devin (for Yan) · **Status:** PLAN — decisions answered 2026-11-08; implementation W1–W5 below

## Summary

A project plan should send each step to the profile best equipped to do it,
and the plan should tell the user who does what and why:

> **Who does what** — researcher: 3 steps · writer: 2 steps · host (Aquarium): 1 step
>
> 1. Collect competitor pricing → **researcher** · strong fit — has `web-research`, `citation`; finished 14 of 15 research cards
> 2. Draft the report → **writer** · strong fit — has `docx`, `report-writing`
> 3. Send to the client → **Aquarium (host)** · no good fit — no profile has an email skill; consider adding one

## What exists today (measured against `develop` @ `be913f378`)

| Path | What it knows about profiles | Gap |
|---|---|---|
| Project plan drafter (`hermes_cli/projects_api.py` `_PLAN_DRAFT_SYSTEM`, `_plan_draft_prompt`, `_normalise_draft_steps`, `_plan_draft_job_kwargs`) | **Nothing.** The prompt has no roster and does not ask for an assignee, so every step falls back to the host profile (`project.host_profile`). | Planner is blind to profiles. |
| Re-plan (`projects_run.handle_parked_cards` → `projects_api.start_replan_draft`) | Same drafter, same gap. | Same. |
| Kanban decomposer (`hermes_cli/kanban_decompose.py` `_build_roster`, `_SYSTEM_PROMPT`) | Name + one free-text description per profile. | No skills, no tools, no track record; the reason is not kept. |
| Run start (`projects_run.check_step_assignees`, `instantiate_run_cards`) | Refuses an assignee outside `project_profiles`. | Keeps only the name; the reason is lost. |
| Plan UI (`agent-home/src/components/projects/panels/PlanPanel.tsx`, `tabs/PlanTab.tsx`, `task/TaskView.tsx`) | Shows `→ <profile>`; the editor lists `profiles: string[]`. | No reason, fit, summary, or manual-change marker. |
| Profile metadata (`hermes_cli/profiles.py` `read_profile_meta`, `hermes_cli/profile_describer.py`) | `description` (+ `description_auto`) in `profile.yaml`, generated from installed skills. | Not combined with skills/tools/track record anywhere. |
| Track record (`kanban_db` `task_runs.profile`, `outcome`) | Every card run records the profile and its outcome. | Never read as a routing signal. |

## Decisions (Yan, 2026-11-08)

1. **Roster scope: profiles the signed-in user can access.** The planner may pick any profile the user who asked for the plan can use — not only profiles already attached to the project. Concretely: box `owner`/`admin` → every served profile (`profiles_to_serve`); anyone else → profiles where they hold an **active** principals row (`projects_api._enrolled_profiles`, `console_scope.enrolled_profiles`), **plus** profiles already attached to the project. When an approved plan names a profile the project does not have, approving/activating the plan attaches it (`projects_db.add_project_profile`, `added_by` = approver) **only if the approver can access it**; otherwise activation fails with a clear message. Background re-plans (no request principal) use the **project owner's** accessible set.
2. **Past results are a signal.** Each profile's track record — card runs completed / blocked / failed over the last 90 days and its most recent completed card titles — is shown to the planner next to its skills and description.

Kept unchanged: `check_step_assignees` stays the last safety check at run start; a missing or invalid pick falls back to the host profile (project plans) or `kanban.default_assignee` (decomposer), now **with a visible reason**.

## Shared contracts (all work items code against these; do not change them without the parent)

### C-1 Capability card — `hermes_cli/profile_capabilities.py` (new, W1)

```python
def capability_card(name: str, *, board_conn=None, now: int | None = None) -> dict
def capability_roster(names: Iterable[str], *, board_conn=None, now: int | None = None) -> list[dict]
async def accessible_profile_names(principal, *, project=None) -> list[str]   # decision 1
def accessible_profile_names_for_user(user_id: str | None, *, project=None) -> list[str]  # sync, for background re-plans
def roster_prompt_block(roster: list[dict], *, max_skills: int = 40) -> str  # compact text for LLM prompts
```

A card (JSON-serialisable; missing data degrades to empty, never raises):

```json
{
  "name": "researcher",
  "display_name": "researcher",
  "description": "Finds and cites sources…",
  "description_auto": true,
  "skills": [{"name": "web-research", "category": "research"}],
  "toolsets": ["web", "browser", "file"],
  "model": "anthropic/claude-sonnet-4",
  "track_record": {
    "window_days": 90,
    "completed": 14, "blocked": 1, "failed": 0,
    "recent": [{"title": "Collect EU pricing", "outcome": "completed", "ended_at": 1793900000}]
  }
}
```

Skills come from the profile's installed skills dir (category = parent folder),
toolsets from `projects_run._enabled_toolsets_for_profile`, description from
`profiles.read_profile_meta`. Track record reads `task_runs` (`profile`,
`outcome`, `ended_at`) joined to `tasks.title`; `failed` counts `crashed`,
`timed_out`, `spawn_failed`, `gave_up`. `roster_prompt_block` is the single
text form every planner prompt uses, so the planner, re-plan and decomposer
see identical facts.

### C-2 Assignable-profiles API (W1)

`GET /api/registry/projects/{slug}/assignable-profiles` (read access to the project) →
`{"profiles": [<capability card> + {"in_project": bool, "is_host": bool}]}`, ordered host first, then project profiles, then the rest by name.

### C-3 Step assignment fields (playbook `steps` JSON and run cards)

Each plan step (stored in `project_playbook.steps`, no migration needed) gains:

| field | type | meaning |
|---|---|---|
| `assignee` | str | unchanged: the profile name |
| `assignee_reason` | str ≤ 240 chars | one sentence naming the matching skill/tool/track record, or why it fell back |
| `fit` | `"strong" \| "partial" \| "none"` | planner's own fit rating; `none` ⇒ fallback |
| `matched_skills` | list[str] | skills/toolsets from that profile's card that justify the pick (validated against the card; unknown names dropped) |
| `assigned_by` | `"planner" \| "fallback" \| "manual"` | who chose it; any hand edit in the plan editor or card editor sets `manual` |
| `suggested_profile` | str \| null | optional, only with `fit: "none"`: a short role name the user could create/add (free text, never auto-created) |

Old steps without these fields render exactly as today. Run cards carry the
same fields so the card view can show them (W4 decides the storage — task
metadata/event — and exposes them on the card API as `assignment: {…C-3 fields}`).

### C-4 Planner output

The drafter's JSON per step adds `assignee`, `assignee_reason`, `fit`,
`matched_skills`, optional `suggested_profile`. The prompt tells the model:
pick from the roster by skills, tools, description and track record (not the
name); prefer a profile whose track record shows it completes this kind of
work; when nothing fits, use `null` + `fit: "none"` and say what is missing.

## Work items

Parallel where the graph allows; each is one PR on `develop`.

```
W1 capability cards + access + API ──┬──> W2 project planner + re-plan + activation attach
                                     └──> W3 kanban decomposer
W4 card persistence + manual marker (contract C-3 only) ──┐
W5 Plan UI (contracts C-2/C-3 only, mocked API in tests) ─┴──> W6 cross-review
```

- **W1 — Capability cards, access set, API.** New `hermes_cli/profile_capabilities.py` (C-1) and the C-2 route in `projects_api.py`. Tests: card from a fixture profile (skills, toolsets, description), track record counts/window from a fixture `task_runs`, access set for admin / enrolled member / non-enrolled user (+ project profiles), prompt block size cap.
- **W2 — Project planner, re-plan, activation.** `_PLAN_DRAFT_SYSTEM`, `_plan_draft_prompt`, `_plan_draft_job_kwargs`, `_normalise_draft_steps`, `start_plan_draft`/`start_replan_draft` and their callers (`projects_api.py`, `projects_clarify_api.py`, `projects_run.py`): put `roster_prompt_block` of the accessible roster into the prompt, validate picks against the accessible set, write C-3 fields (`assigned_by: planner|fallback`), fall back to host with a reason. Plan activation/run start attaches newly named accessible profiles (decision 1) before `check_step_assignees`. Tests with a stubbed model: correct pick kept, unknown pick → fallback with reason, inaccessible pick → fallback, `matched_skills` filtered to the card, activation attaches an accessible profile and refuses an inaccessible one, re-plan uses the owner's set.
- **W3 — Kanban decomposer.** `kanban_decompose.py`: `_build_roster` uses `capability_roster`; prompt uses `roster_prompt_block`; output gains `assignee_reason`/`fit`/`matched_skills`; the reason is recorded on each child task (task comment/event, visible in the card) and fallback says why. Tests mirror W2.
- **W4 — Card persistence and manual marker.** `projects_run.instantiate_run_cards` copies C-3 fields onto each card; card read API returns `assignment`; card edit (`projects_api` card PATCH) and playbook step edits set `assigned_by: "manual"`, clear `fit`/`matched_skills`, and keep the previous planner pick as `planner_assignee` for the UI. Tests: plan → run → card keeps fields; manual edit marks it.
- **W5 — Plan and card UI.** `PlanPanel.tsx`, `PlanTab.tsx`, `TaskView.tsx` (+ the plan-draft view): a "Who does what" summary above the steps (profile → step count, with no-fit count); per step a profile chip, fit badge and the reason, with matched skills as small tags; a warning row for `fit: "none"` showing `suggested_profile`; a "changed by you" marker for `manual`; a hint when the chosen profile has no description. The step editor's assignee picker loads C-2 and shows each profile's description/top skills/track record. Older steps without the fields render as today. Vitest + interaction tests.
- **W6 — Cross-review.** Merge W1–W5 locally, fix integration breaks, run the Python projects/kanban tests and agent-home tests, report merge order. The parent ticks the checklist below.

## Checklist

- [x] W1 capability cards + access set + assignable-profiles API (#763)
- [x] W2 project planner + re-plan + activation attach (#770)
- [x] W3 kanban decomposer (#769)
- [x] W4 card persistence + manual marker (#765)
- [x] W5 Plan and card UI (#764)
- [x] W6 cross-review (#775); pre-existing `develop` failures fixed in #767, #768
- [ ] Live check on a real project (draft a plan with ≥ 2 accessible profiles; confirm picks, reasons and the summary)

## Known limits (after W1–W6)

- Track records count runs on the project's own board (or the default board), not every board on the box.
- The access set includes attached profiles whose directory no longer exists; `check_step_assignees` stays the final check.
- After a hand edit, `assignee_reason` and `suggested_profile` still describe the planner's original pick; a step that fell back to the host (assignee null) gets no `planner_assignee`.
- The no-description hint shows in plan views only, not on the card view.

## Non-goals

No new profile-creation flow (FG-30 owns profile lifecycle; FG-34 only suggests a role), no deterministic scoring model replacing the planner (the planner decides; the code validates and explains), no change to who may run a card under which profile beyond decision 1.
