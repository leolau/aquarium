# agent-home browser E2E (Playwright)

Browser-level smoke and regression specs for `agent-home`, under
`agent-home/e2e/` (config: `agent-home/playwright.config.ts`). They drive a
**running** agent-home through Chromium — usually production over an SSH
tunnel right after a deploy. They are not part of `npm test` (Vitest only
includes `src/**`) and CI does not run them.

| Suite | Command | What it covers | Time |
| --- | --- | --- | --- |
| `@smoke` | `npm run --prefix agent-home e2e:smoke` | login/logout; every Coral menu destination renders its marker with no console errors / failed BFF requests; status strip renders + refreshes; one `[smoke]` chat turn (reply starts streaming, then archived); settings; projects list + a project page | ~3–5 min |
| `@regression` | `npm run --prefix agent-home e2e:regression` | `[smoke]` project lifecycle (wizard → readiness → activate → run → run page → archive; delete on a never-run project); to-dos complete/dismiss; inbox, files, memory, capacity; member/viewer refused on admin/owner routes and member management; phone layout (no sideways scroll, menu fits) | ~5–8 min |

Both run on two Chromium projects: `desktop` (1440×900) and `phone`
(390×844, touch). Specs that create data run on `desktop` only.

## Configuration (env)

| Variable | Meaning |
| --- | --- |
| `E2E_BASE_URL` | agent-home origin, default `http://localhost:3100` |
| `SMOKE_ADMIN_EMAIL` / `SMOKE_ADMIN_PASSWORD` | admin test account |
| `SMOKE_MEMBER_EMAIL` / `SMOKE_MEMBER_PASSWORD` | member test account |
| `SMOKE_VIEWER_EMAIL` / `SMOKE_VIEWER_PASSWORD` | viewer test account |
| `E2E_LOGIN_PROVIDER` | login provider option, default `supabase` |
| `E2E_WORKERS` / `E2E_RETRIES` | parallelism (default 1 — prod has a small DB pool) / retries (default 0) |
| `E2E_IGNORE` | extra console/BFF failure patterns to tolerate for one run, one regex per line (e.g. a known bug fixed on develop but not deployed yet) |

A spec that needs a role whose credentials are missing is skipped, not
failed. On the prod box the test credentials live only in
`/root/.aquarium-smoke.env` (mode 600) — never copy them into the repo, a
ticket or a log.

## Run against production after a deploy

From any machine with the repo, Node 20+ and SSH access to the box:

```bash
npm ci --ignore-scripts                       # repo root (npm workspaces)
npx --prefix agent-home playwright install chromium

# 1. Tunnel agent-home (it listens on 127.0.0.1:3100 on the box).
ssh -N -L 3100:127.0.0.1:3100 root@<box> &

# 2. Load the test accounts without echoing them.
install -m 600 /dev/null ~/.aquarium-smoke.env
ssh root@<box> 'cat /root/.aquarium-smoke.env' > ~/.aquarium-smoke.env
set -a; . ~/.aquarium-smoke.env; set +a

# 3. Run.
export E2E_BASE_URL=http://localhost:3100
npm run --prefix agent-home e2e:smoke
npm run --prefix agent-home e2e:regression    # optional, longer, writes [smoke] data

rm ~/.aquarium-smoke.env
```

`http://localhost` is a secure context for Chromium, so the
`__Host-agent_home_session` cookie works through the tunnel.

Useful flags: `--project=desktop` or `--project=phone`, `-g "status strip"`,
`--headed`, `--debug`. Failures keep a screenshot and a trace under
`agent-home/test-results/`; `npx --prefix agent-home playwright show-report
agent-home/playwright-report` (or `show-trace <trace.zip>`) to inspect.

## Data the suites create (and clean up)

Everything a spec creates is named `[smoke] <label> <timestamp>`, and each
spec sweeps `[smoke]` rows in `afterAll` whether it passed or not
(`e2e/support/cleanup.ts`):

- chat conversations → archived;
- to-dos → dismissed (the UI has no delete; dismiss is its delete);
- projects → archived, then deleted where the server allows (a project with
  run history can only be archived, by design).

The smoke chat turn is a real agent turn, so the agent may also write a
memory about it; those are not swept.

## Writing / updating specs

- Shared selectors are in `e2e/support/ui.ts` (page markers per route, Coral
  menu, chat, project actions). Prefer roles/labels and existing
  `data-component` / `data-action` hooks; add a minimal hook only when none
  exists.
- `asRole("admin" | "member" | "viewer")` signs a `describe` in (state saved
  once per run by `e2e/auth.setup.ts`) or skips it.
- The `guard` fixture fails a test on any console error, page error or
  failed `/api/*` response. Explained, known noise goes in `KNOWN_NOISE`
  in `e2e/support/fixtures.ts`, with the reason.
