# Session hand-off — chunk-reload PWA fix, box memory/Qoder daemons, Canva-quota run resume

For whichever agent/human picks this up next. Written 2026-09-15. Status of
each item is stated explicitly — not everything below is deployed yet.

## What happened, in order

### 1. iOS PWA crash after a deploy → chunk-load auto-reload (PR #410, merged, NOT yet deployed)

- **Report:** the installed iOS PWA for `<agent-home-host>` showed
  "Application error: a client-side exception has occurred" after this
  session ran three production deploys in a row; desktop (freshly loaded)
  was fine. Force-quitting and reopening the PWA fixed it.
- **Diagnosis:** classic stale-bundle problem. The PWA had stayed open
  across a deploy, so it still held references to Next.js content-hashed
  chunk files that no longer exist on the server once a new build lands.
  Not a real bug in the deployed features.
- **Fix built:** `agent-home/src/lib/chunk-reload.ts` (pure detection +
  one-shot reload guard via storage key), `ChunkErrorListener.tsx` (window
  `error`/`unhandledrejection` listeners), `app/global-error.tsx` (this repo
  had **no root error boundary at all** before this — that's why the
  generic dead-end page was all anyone saw), mounted from `layout.tsx`.
  Reloads automatically **exactly once per session**; a persistent failure
  (real bug, not staleness) falls through to a plain fallback page with a
  manual Reload/Try again button instead of looping.
- **Verified:** 10 new unit tests (`chunk-reload.test.ts`), `tsc --noEmit`
  clean, `next build` clean. Full jsdom suite still has the pre-existing
  unrelated `html-encoding-sniffer`/`ERR_REQUIRE_ESM` failures noted in
  earlier hand-offs — not caused by this work.
- **Plan doc:** `plans/2026-09-15-chunk-load-auto-reload.md`.
- **Status:** PR **#410** merged into `develop` (now at commit `e179d2f85`
  on `develop`). **Not deployed to production yet** — production is still
  at `fb6c4dd79` (see #4 below). Whoever deploys `develop` next should
  specifically re-test the iOS PWA recovery path afterward (open PWA, leave
  it open across the deploy, navigate, confirm one silent auto-reload and
  no loop).

### 2. Production memory/swap inspection (informational only, no code)

- Box (`<prod-host>`) was observed with **swap fully used (4.0/4.0
  GiB)** while Hermes itself was healthy (no OOM kills in the logs).
- Root cause was **not Hermes** — the box also runs an unrelated fleet of
  ~21 `qoder-daemon-*.service` systemd units (user `aicoder`, a separate
  coding-agent product called Qoder, `@qoder-ai/qodercli`), consuming
  roughly 4.5–5 GB RSS combined, and the dominant swap consumer.
- No process was touched at this stage — recommendations only. See #3 for
  what was actually done two turns later once the user asked to act on it.

### 3. Qoder daemon fleet — inventoried, documented, then permanently trimmed

- Counted and listed all 22 `qoder-*` systemd units (21 per-repo daemons +
  1 shared `qoder-ttyd` web terminal), with each daemon's live
  `envId`/session URL pulled from its journal
  (`https://qoder.com/agents/session/new?envId=...`).
- Wrote a runbook, **`docs/deployment/qoder-remote-control-daemons.md`**
  (PR #411, merged into `develop`), covering: what these are, the
  `Restart=always` trap (killing the PID does **not** stop it — systemd
  relaunches it ~5s later, only `systemctl stop`/`disable` actually stops
  one), status/envId lookup commands, stop/restart/disable/re-enable
  commands, and the repo-listing one-liners
  (`ls /opt/data/aicoding/repos/`, `find /opt/data -maxdepth 2 -name .git
  -exec dirname {} \;`). Linked from `PRODUCTION.md`'s gotchas list.
- **Action taken on the box, at the user's explicit request:** 18 of the 21
  per-repo daemons were **stopped and permanently disabled**
  (`systemctl disable`, not just `stop` — confirmed via
  `systemctl list-unit-files 'qoder-daemon*'`), keeping only:
  - `qoder-daemon-ai-and-i.service`
  - `qoder-daemon.service` (ai-prentice-4-all, this repo)
  - `qoder-ttyd.service`
  - Effect: swap dropped from 4.0/4.0 GiB used to **1.2/4.0 GiB** used,
    immediately.
  - The 18 disabled: ar-fashion-designer, arfd-portal,
    class-intelligence, diamondbox, diy-client, diy-portal, ebid-mobile,
    ebid-portal, ebid-server, greenfield, learn-word-la-web, learn-word-la,
    next-supabase-cms-template, P-Univ, peeppop-server, peeppop,
    proxy-advisor, snappop-portal, storytellar-webar.
  - Fully reversible: `systemctl enable --now qoder-daemon-<repo>.service`
    per unit (the unit files were left in place, not deleted).
- **Status/known gap:** PR **#411** merged into `develop` before I pushed a
  follow-up commit recording this disable action in the runbook — so
  `develop` as merged was briefly stale relative to the box's real state.
  Fixed with a small follow-up, **PR #412** (cherry-pick of the missed
  commit onto fresh `develop`) — **check whether #412 is merged**; if not,
  merge it so the runbook matches reality.

### 4. `ai-professsional-builder-course-ppt` — resumed the stalled Canva run (production action taken)

- **Report:** the Canva slide-generation project (129 concepts/labs + title
  + thank-you = 131 slides) had "already completed over 100 slides" and
  stopped.
- **Found:** run #1 had auto-failed with
  `outcome=stalled` / `"no card or session progressed this run for over
  2h — likely orphaned..."`. That was a false positive: the
  `execute-canva-prompts` card (`t_5bd01798`) was correctly sitting in
  `triage`, blocked (`block_kind: transient`) by **Canva's daily
  generate-design quota**, not actually stuck. Real progress: **113 of 131
  slides done**, 18 remaining (indices 113–130: labs 12–29 + Thank You).
- **Fix applied — resumed, did not restart:** called the existing
  `projects_run.resume_run()` (built in PR #403 for exactly this class of
  problem) directly on the box against the production DB, mirroring what
  `POST /{slug}/runs/{run_no}/resume` does:
  - Reopened run #1 (`failed`→`running`, cleared the stale
    error/outcome). Every already-`done` card was untouched.
  - Re-promoted the same triage card back to `ready` (not a new card, not
    a new run) — `promoted: ['t_5bd01798']`.
  - **No slide already generated was regenerated.** This is the whole
    point of `resume_run` vs. "Repeat this run".
- **Confirmed live:** dispatcher claimed the card within ~20s — a real
  worker (PID `2434547`) was actively running it, continuing from slide
  index 113 onward. Project's `latest run` shows `running` again.
- **If it stalls on the quota again:** it's the same shape of problem —
  either use the UI's Resume action if it's present for a `transient`
  block (check `RunView.tsx`'s next-action panel; PR #406 explicitly wired
  a rich next-action panel for **checkpoint** holds, but it's worth
  double-checking a `transient`-blocked card triggers an equally clear
  "Resume" affordance rather than reading as a generic stall — if not,
  that's a natural follow-up in the spirit of #406), or repeat the direct
  `resume_run()` call (script pattern below).
- **Reusable script pattern** (not committed anywhere — recreate if
  needed; run as the `hermes` user with `hermes-staging.env` sourced and
  `HERMES_HOME=/opt/data/hermes-home-staging`):

  ```python
  import sys
  sys.path.insert(0, "/opt/data/hermes-agent")
  from hermes_cli import projects_db, projects_run
  from hermes_cli.projects_api import _board_conn

  SLUG, RUN_NO = "ai-professsional-builder-course-ppt", 1
  with projects_db.connect_closing() as conn:
      project = projects_db.get_project(conn, SLUG)
      run = projects_db.get_project_run(conn, project.id, RUN_NO)
      with _board_conn(project) as bconn:
          result = projects_run.resume_run(conn, bconn, project=project, run=run)
      print(result)
  ```

  `resume_run()` refuses (`ValueError`) anything not `failed`/`cancelled` —
  safe to call speculatively if unsure of current state.

## Current production state (as of this hand-off)

```
production commit deployed   fb6c4dd79   (PRs #403–#409; #410/#411/#412 NOT deployed yet)
develop HEAD                  well ahead — includes #410, #411 (partial), #412 (if merged)
```

**Not deployed:** the chunk-reload auto-recovery (#410) and the Qoder
runbook doc (#411/#412 — docs-only, deploy-irrelevant but good to have on
`develop` for the record). If the next session's job includes "deploy
develop to production," #410 is the main functional change riding along;
re-verify the iOS PWA recovery path per item #1 above after that deploy.

**Box-level state, not in git, won't survive a fresh box rebuild without
the runbook being followed manually:** the 18 disabled `qoder-daemon-*`
units (item #3). If this box is ever rebuilt from the captured state
snapshot (`deployment-path.md`'s cold-rebuild procedure), those daemons are
a **separate, unrelated deployment** (`aicoder` user, Qoder's own install)
not covered by Hermes's `deploy_state.py capture` at all — nothing to do
here, just don't be surprised if a rebuilt box has all 21 daemons enabled
again; that's expected, not drift.

**`ai-professsional-builder-course-ppt` run #1 is `running` again**, on
slide ~113/131, worker PID `2434547` at last check. It may hit the Canva
daily quota again before finishing — that is expected and not a bug; see
item #4 for how to resume it again if so.

## Open items for whoever picks this up

1. Confirm **PR #412** merged (the missed second commit to the Qoder
   runbook) — if not, merge it.
2. Decide whether/when to deploy `develop` (→ picks up #410's chunk-reload
   fix) to production, and re-verify the iOS PWA scenario afterward.
3. Watch `ai-professsional-builder-course-ppt` run #1 to completion; if it
   stalls on the Canva quota again, resume it the same way (item #4) — or
   better, wire the UI's Resume action to show clearly for a `transient`
   block if it doesn't already (parallel to what #406 did for checkpoint
   holds).
4. `docs/deployment/PRODUCTION.md`'s "last verified" line predates this
   session — not updated here since none of this session's changes touch
   the Hermes deploy tooling itself (`deploy/`, `deploy_state.py`, etc.),
   which is what that staleness check tracks; the Qoder-daemon note added
   to its gotchas list (item 8) is the only edit made to that file.
