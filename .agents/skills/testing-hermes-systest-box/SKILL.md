---
name: testing-hermes-systest-box
description: "SUPERSEDED 2026-08-20 — the Alibaba 'systest' box this skill describes is decommissioned. Production moved to a Hetzner box reachable by SSH; read production/PRODUCTION.md in the private repo leolau/aquarium-ops before any production action. Kept only for historical/rollback reference — do NOT use OOS_RunCommand against production."
---

# ⚠️ SUPERSEDED — this box is decommissioned, do not act on it ⚠️

**Production migrated off this Alibaba Cloud ECS box on 2026-08-20.** It was
stopped at cutover and its subscription lapsed 2026-08-26. Every fact and
command below (instance ID `i-j6c81aisv2dd8mg17yle`, EIP `47.83.199.25`,
`OOS_RunCommand` as the only access path) describes a server that is **no
longer serving any real traffic**. Running commands against it wastes time
and changes nothing anyone will ever see.

**Before doing anything "live box" related, read
[`production/PRODUCTION.md`](https://github.com/leolau/aquarium-ops/blob/main/production/PRODUCTION.md) in the private repo
`leolau/aquarium-ops`.** Current production is a Hetzner box reached directly
by SSH; the host and access details are only in that file.

No OOS polling, no base64-decoding invocation results, no ~60s MCP call
ceiling — it's a normal SSH session. The full service catalog, deploy
procedure, and health-check commands for the *current* box are in
`PRODUCTION.md` §4–5.7 (leolau/aquarium-ops).

This exact mistake — debugging and redeploying to this decommissioned box
while believing it was production — happened once already and cost a full
session before the real cause was found. See
[`plans/2026-09-25-prod-migration-guardrails.md`](../../../plans/2026-09-25-prod-migration-guardrails.md)
for the incident writeup. If you're reading this skill because it matched a
query about verifying the live deployment, stop here and go to
`PRODUCTION.md` instead — everything past this point is historical.

---

## Historical content below — Alibaba `hermes-systest` box (pre-2026-08-20)

Kept for the pre-migration rollback path noted in `PRODUCTION.md` §6
(Alibaba snapshots retained until the migration is proven stable). Do not
act on anything below without re-verifying against `PRODUCTION.md` first —
paths, unit names, and gotchas may or may not still apply to the Hetzner box.

The Hermes staging/systest deployment does **not** run locally. It lived on an Alibaba Cloud
ECS instance and there was **no SSH**. Everything was driven through the `alibaba-cloud` MCP
server's `OOS_RunCommand` tool.

## Access pattern (historical — do not use against current production)

```
mcp_tool(command="call_tool", server="alibaba-cloud", tool_name="OOS_RunCommand",
  tool_args='{"RegionId":"cn-hongkong","InstanceIds":["<instance-id>"],"Command":"<shell>"}')
```

Instance used historically: `i-j6c81aisv2dd8mg17yle` (region `cn-hongkong`, host `hermes-systest`).
This instance is stopped/decommissioned — do not target it.

### Hard-won rules for OOS_RunCommand

- Commands run **as root** via `RunShellScript`. To test the service account's real behavior you
  must explicitly use `sudo -u hermes -H ...`.
- **A nonzero exit fails the whole MCP call.** Always end scripts with `; true`, or use
  `|| echo FAILED`. This matters most for negative security checks, which are *expected* to fail.
- **The MCP call times out at ~60s**, but the script keeps running on the box. Do NOT assume
  failure — re-poll state in a follow-up call. For anything slow (network CLIs), launch it with
  `nohup ... > /tmp/out.txt 2>&1 &` in one call and read `/tmp/out.txt` in the next.
- Output comes back JSON-escaped inside `LastTriggerOutputs`; very large outputs get truncated,
  so `grep`/`cut -c1-160`/`head` on the box instead of dumping whole files.
- `cwd` for OOS scripts is `/root`. This bites tools that read *relative* config paths — e.g.
  `supabase` looks for `./supabase/config.json` and reports
  `PermissionDenied: FileSystem.access (/root/supabase/config.json)`, which looks like a
  privilege bug but is only a cwd artifact. Always `cd` somewhere sane first.
- Root git needs `-c safe.directory=/opt/data/hermes-agent` (usually already set globally).
- Never print secret values. Grep for key **names** only:
  `grep -c '^SUPABASE_ACCESS_TOKEN=' <file>`, or print `${#VAR}`. Redact long tokens with
  `sed -E 's/[A-Za-z0-9_-]{30,}/***REDACTED***/g'`.

## Layout on the box

| Thing | Path |
|---|---|
| Code checkout (git, tracks `origin/develop`) | `/opt/data/hermes-agent` |
| `HERMES_HOME` | `/opt/data/hermes-home-staging` |
| Agent `.env` (source of `SUPABASE_ACCESS_TOKEN`, `DATABASE_URL`) | `/opt/data/hermes-home-staging/.env` |
| Deploy script (sudo-able) | `/opt/data/deploy-hermes.sh [branch]` |
| Venv | `/opt/data/hermes-agent/.venv` |
| Python interpreter root | `/opt/uv/python/cpython-3.11.15-linux-x86_64-gnu` |
| Service user | `hermes` uid 996 gid 986, home `/opt/data/hermes-user` |
| Sudoers grant | `/etc/sudoers.d/hermes-agent` |
| Unprivileged drop-ins | `/etc/systemd/system/hermes-*.service.d/10-unprivileged.conf` |
| Local Supabase stack (hermes must NOT read) | `/opt/data/supabase/docker/.env` |
| Embedding service (loopback, layer-4 memory) | `/opt/data/hermes-embed` |
| Deployment-state store (git, own read-only deploy key) | `/opt/data/hermes-deploy-state` |
| `agent-home` (the phone app) — same checkout since FG-23 A0 | `/opt/data/hermes-agent/agent-home` |
| `agent-home` secrets (0600, git-ignored, **not** reproducible from git) | `/opt/data/hermes-agent/agent-home/agent-home.env` |
| Logs | `/opt/data/hermes-home-staging/logs/*.log` (confirm per unit with `systemctl show -p StandardOutput <unit>`) |

12 long-running units: `hermes-{dashboard,digest,email-batcher,email-poller,email-triage,escalation,gateway,wa-batcher,wa-bridge-connectar,wa-bridge-personal,wa-triage}.service`
and `agent-home.service`, plus timers/oneshots (`hermes-drift-check`,
`hermes-memory-projection`, `hermes-secret-backup`, `hermes-rag-ingest`).
The long-running set is exactly the **enabled** unit files; timer-invoked
oneshots are `static`:

```bash
systemctl list-unit-files 'hermes-*.service' --state=enabled --no-legend | awk '{print $1}'
```

Use that, not `ls /etc/systemd/system/hermes-*.service` — see "the deploy
script's verdict" below for what a glob over both costs.

## `agent-home` (the phone app), after FG-23 A0

As of 2026-08-05, phases A0/A0.5 are deployed (`develop f4bc8af21`):

```
public       https://<agent-home-host> → Caddy → 127.0.0.1:3100
unit         agent-home.service     User=hermes   (ProtectSystem=strict, ProtectHome=yes)
WorkingDir   /opt/data/hermes-agent/agent-home     ← the main checkout; one git pull moves everything
EnvFile      /opt/data/hermes-agent/agent-home/agent-home.env   (0600, git-ignored)
ExecStart    deploy/start.sh  →  next start   (serves the COMPILED .next bundle)
```

What changed, and what to check:

- **The second clone is gone.** `/opt/data/agent-home-app` (a full second clone
  frozen at PR #62, serving a 2026-07-27 build) is retired to
  `/opt/data/agent-home-app.retired-20260805`. Nothing references it; it is kept
  only as a rollback and can be deleted to reclaim 2.2 GB. Its old unit is at
  `/opt/data/backups/agent-home.service.pre-fg23`.
- **The deploy now builds and restarts it** when `agent-home/` or the root
  `package-lock.json` moves, or when `.next/BUILD_ID` is absent. It still serves
  a *compiled* bundle, so `next start` keeps serving the old build until
  something rebuilds: `BUILD_ID` mtime remains the tell.
- **The state capture covers it.** `deploy_state.py`'s default globs are
  `hermes-*` **and** `agent-home*` (PR #112), and the manifest key is
  `unit_globs` (plural, a list). `--unit-glob` *replaces* the defaults.
- **It runs unprivileged.** `node`/`npm` are `/usr/bin` (no nvm), and `hermes`'s
  home is `/opt/data/hermes-user`, so `ProtectHome=yes` does not hide it.
  `.next` must be writable by `hermes` — a root build followed by a restart
  *before* the `chown` starts the service against root-owned files.
- **`agent-home` is an npm *workspace* of the root `package.json`.** Deps hoist to
  `<checkout>/node_modules` — `next` lives there, not in
  `agent-home/node_modules` (264 KB of link stubs). Install and build **from the
  repo root**: `npm ci && npm run build --workspace agent-home`. Building from
  inside `agent-home/` creates a second, unhoisted dep tree.
- Health without credentials: `GET /login` → 200 and `GET /` → **200**, with the
  unauthenticated root carrying a *client-side* redirect to `/login` (grep the
  body). It is not a 307 — the gate is in the React tree, so a status code alone
  says nothing about whether the app is guarded (re-checked 2026-08-17,
  `dfa32fe3c`). Its API reads go to the dashboard at
  `AGENT_HOME_API_URL=http://127.0.0.1:9119`.
- `AGENT_HOME_DATASTORE_MODE=prod`, but **the memory tier resolves `app_dev`** on
  this box (`app_prod.memories` is the empty 256-dim pre-re-embed leftover).
  Forwarding that mode to a memory endpoint yields a healthy page reporting zero
  rows — the failure PR #107 fixed on the dashboard.

### Verifying an authenticated phone page without the password

`dashboard.basic_auth.password_hash` is scrypt, so the password cannot be read
off the box — but the *provider's signing key* is in the same config, and
`agent-home` bridges that same login. Two steps, no credential needed:

1. Mint an upstream token as the service user:
   `BasicAuthProvider(...)._mint_session(username).access_token`, with
   `username`/`password_hash`/`secret` from `dashboard.basic_auth`. Confirm it
   resolves a principal: `GET 127.0.0.1:9119/api/comms/whoami` →
   `{"configured": true, "principal": {"user_id": "leo_owner", …}}`.
2. Wrap it in an `agent_home_session` cookie: `base64url(JSON) + "." +
   base64url(HMAC-SHA256(payload, AGENT_HOME_SESSION_SECRET))`, payload
   `{hermesToken, principal, issuedAt}` (see `agent-home/src/lib/auth/session.ts`).

Then drive `127.0.0.1:3100` with that cookie. Note the login *subject* is
`admin` while the principal is `leo_owner`; they are linked by
`hermes owner alias admin`, without which every memory call is a 409.

**Server-rendered HTML cannot prove the map.** `MemoryMap` fetches the
projection client-side, so `curl` sees the summary and rows but not a single
`<circle>`. Geometry claims need a browser.

## Running Hermes CLI commands as the service user

`HERMES_HOME` must be passed explicitly; the venv binary is the entry point:

```bash
cd /opt/data/hermes-agent
sudo -u hermes -H HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes skills list
sudo -u hermes -H HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes mcp catalog
```

Note `hermes config get <key>` does **not** exist — use `hermes config path` and read the YAML,
or grep `/opt/data/hermes-home-staging/config.yaml` directly.

**Omitting `HERMES_HOME` does not fail — it answers about the wrong deployment.**
With the variable unset, `get_hermes_home()` falls back to `$HOME/.hermes`, which for
`hermes` is `/opt/data/hermes-user/.hermes`: a real, empty, core-only home. So
`sudo -u hermes -H ./.venv/bin/hermes profile list` shows only `default` (the live
`maintenance` profile invisible) and `hermes datastore show` reports "not configured —
this profile is core-only" on a box that is plainly running on Postgres. Every answer is
internally consistent and about a home nobody uses. `sudo -u hermes -H env
HERMES_HOME=/opt/data/hermes-home-staging ...` is not optional, including inside
`sh -lc`, which does not inherit it either.

Per-profile commands take `--profile <name>` **before** the subcommand
(`hermes --profile maintenance datastore show`) — it is the global profile selector, eaten
before the subparser sees argv, so a trailing `--profile` silently selects rather than
targets (this is what made `hermes goal publish --profile X` publish *from* X; see #207).

Root `git` commands against the live checkout need
`-c safe.directory=/opt/data/hermes-agent` (differing owner), and the same for
`/opt/data/hermes-deploy-state`.

### Memory / layer-4 quick checks

```bash
sudo -u hermes -H HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes memory vectors status
sudo -u hermes -H HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes memory projection status
```

`hermes memory projection fit` is whole-corpus SVD — never run it in a request
path; a nightly timer (`hermes-memory-projection.timer`, ~03:00, `nice`d) owns
it. `numpy` **is** required for PCA and was absent from the deployment until
PR #107; if a fit dies on `import numpy`, install into the venv rather than
assuming the code is wrong.

## Gotchas that produce false results

1. **A port that answers 200 proves nothing about the agent, and no check we have
   watches whether a unit is *running*.** On 2026-08-20 twelve units — gateway,
   digest, escalation, the three email workers, all four WhatsApp units, both
   calendar units — were stopped **and disabled** for 21 hours while
   `agent-home` (`:3100`), the dashboard (`:9119`) and the public `/login` all
   answered normally and `deploy_state.py check` reported no drift (it compares
   unit *file* content, not enable/active state). Start every box visit with
   the enable/active set, per unit, and treat `disabled` as worse than
   `inactive` — a reboot would not restore it:
   ```sh
   for u in $(ls /etc/systemd/system | grep -E '^(hermes-|agent-home).*\.service$'); do
     printf '%-40s %s/%s\n' "$u" "$(systemctl is-enabled $u 2>&1)" "$(systemctl is-active $u 2>&1)"
   done
   ```
   Related: a gateway log line saying `Exiting with code 1 … so systemd
   Restart=on-failure can revive the gateway` is not evidence it was revived —
   systemd does not restart after an explicit `stop`, and cannot restart a
   disabled unit.
2. **`Conflict: terminated by other getUpdates request` means a second instance
   of the same bot token is polling, usually off-box.** Confirm there is only
   one `hermes gateway run` on the box (`ps -ef | grep 'gateway run'`) before
   touching anything: two pollers steal the long-poll from each other, so the
   symptom is erratic replies rather than silence, and restarting the box's
   gateway does not help. Find the other holder of the token.
3. **`Agent Home needs a connection to reach your agent` is not an application
   error.** It is the static `agent-home/public/offline.html`, served by the
   service worker only when the browser's own navigation fetch never completed
   (`sw.js` is network-first for navigations and does not intercept `/api/` or
   `/auth/`). It cannot distinguish a dead phone network from a dead origin,
   and the PWA keeps showing it until one navigation succeeds. Also: Caddy
   keeps **no request log** (`/etc/caddy/Caddyfile` has no `log` directive,
   `/var/log/caddy` is empty), so "did the request reach the box?" is currently
   unanswerable.
4. **`journalctl` is nearly empty and grepping it is vacuous.** Every unit uses
   `StandardOutput=append:<file>`, so journald holds only ~4–6 systemd lines per unit. Always
   grep the **actual log files**. Verify with
   `systemctl show -p StandardOutput <unit>`.
5. **Logs mix pre-/post-migration history.** Old failures reference the old interpreter path
   `/root/.local/share/uv/python/...`; current-era lines reference `/opt/uv/python`. Use that as
   an era marker, and compare line numbers against the last startup banner and
   `systemctl show -p ExecMainStartTimestamp,NRestarts <unit>` before calling something a
   regression.
6. **Check the real process owner**, not the unit file:
   `ps -o user=,uid= -p $(systemctl show -p MainPID --value <unit>)`.
7. **SQLite needs a writable *directory*, not just a writable file** (for `-wal`/`-shm`
   sidecars). Test on a **copy** in `/tmp` chowned to hermes and force an actual commit; never
   write production DBs.
8. **Supabase datastore import path is `hermes_cli.datastore`**, not `tools.datastore`:
   ```python
   from hermes_cli.datastore import get_store
   store = get_store("supabase-app")
   conn = await store.connect()          # coroutine, NOT an async context manager
   n = await conn.fetchval("select count(*) from app_dev.memories")
   await conn.close()
   ```
   Run it with the `.env` sourced: `set -a; . /opt/data/hermes-home-staging/.env; set +a`.
9. **`SUPABASE_ACCESS_TOKEN` is not in hermes' login-shell env.** It lives only in
   `HERMES_HOME/.env`, so a bare `sudo -u hermes -H supabase projects list` will not
   authenticate until that file is sourced.
10. **The layer-4 schema names are not the obvious ones.** `app_prod.memories`
    keys its owner as `owner_user_id` (not `principal_id`), and `principals`
    labels people with `display` (not `display_name`). Guessing either gives an
    `UndefinedColumnError` that reads like a missing table. A bare-Python probe
    also needs the dotenv loaded first
    (`from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()`)
    or the DSN is empty and the failure looks like connectivity.
11. **`hermes profile suggest` answering "no suggestion generated" is usually a
    gate, not a bug.** Generation requires all four: no open suggestion for the
    profile, the monthly clock elapsed (`_generation_due`), **two** skills with
    recorded uses, and one corroborating signal (orphan goals or >1
    participant). This box has never met the skill bar, so FG-30's adoption path
    cannot be exercised without fabricating production rows — which is not
    permitted.
12. **Root-owned files left in `HERMES_HOME` break `hermes` reads far from where
    they were created.** Two (`config.yaml.bak-1786027505`, `uploads/`) broke
    `profile create --clone-all` weeks later. Anything a root command leaves
    behind is a future defect: `chown hermes` it in the same visit.

## Privilege-model checks worth repeating

The migration's stated goal is that a compromised/prompt-injected agent running as `hermes`
cannot reach root. Verify the whole chain, not just the unit files:

- `sudo -u hermes -H sudo -n -l` — grant should be only
  `systemctl {start,stop,restart,status,is-active} hermes-*.service`, nothing else.
- Then ask: **can `hermes` write anything those root-run commands execute?** Check ownership and
  `test -w` as hermes on the deploy script, `start-*.sh` wrappers, unit files/drop-ins, **and
  every `ExecStart` binary**, including inside the venv.
- Known risk area, found real on this box and since remediated: `.venv/bin/pip` and
  `.venv/bin/hermes` were hermes-owned/writable while `deploy-hermes.sh` ran
  `./.venv/bin/pip install -q -e .` **as root**. `.venv` is git-ignored and the script's guard
  uses `git status --porcelain --untracked-files=no`, so a swapped binary was invisible to it.
  Remediation applied: `.venv` is now root-owned (the deploy script's `chown` prunes it), and
  `deploy-hermes.sh` was **removed from the sudoers grant** entirely — root runs deploys out of
  band, because `pip install -e .` executes build hooks out of the hermes-owned source tree.
  Re-verify both on every pass; do not assume. Verify preconditions only — never exploit.
- Negative checks that must be **denied**: reading `/opt/data/supabase/docker/.env`, anything
  under `/root`, `docker ps`, and `test -r /var/run/docker.sock`; `id -nG hermes` must not
  include `docker`.

## Dashboard

Loopback-only on the remote box (`127.0.0.1:9119`) and tunneling/port-opening is typically
forbidden, so **browser/GUI capture is usually impossible** — expect to verify with curl from
the box and to skip screen recording (it would only capture an idle desktop). `/` returns
`302 → /login?next=%2F`; follow with `curl -sL` and assert a 200 with a non-empty body, so you
prove the app serves rather than just redirects.

## Escalation pusher (SQLite row factory) regression

`custom/whatsapp/escalation_pusher.py` and `custom/shared/escalation_pusher_v2.py` must use
`conn.row_factory = _dict_row` (a dict factory), because their formatters call `row.get(...)`
and `sqlite3.Row` has no `.get`. Mirror `tests/custom/test_escalation_pusher_rows.py`: seed a
throwaway `/tmp` DB, load each module by path with `importlib.util`, override `m.DB_PATH`, and
call `format_whatsapp_escalation` / `format_email_escalation` on rows with a `contact_id` so the
contact-lookup branch runs (expect `Ada Lovelace (sister)`). **Always include the adversarial
control**: re-run the same formatter with `row_factory = sqlite3.Row` and assert it raises
`AttributeError`, otherwise the test may be passing vacuously. Never open the production
escalation DB and never let a real Telegram/WhatsApp push fire.

## Testing approval gates / `pre_tool_call` plugins end-to-end (no Telegram account needed)

The Telegram leg usually **cannot** be driven: `telegram.allow_from` pins a single human user id
and the surface is a bot, so a testing agent has no way to send the inbound message or tap the
inline buttons. Do **not** call `getUpdates` to compensate — that steals pending updates from the
live gateway poller. Escalate for a human, and in the meantime drive the *same* machinery
headlessly. This reproduces everything except Telegram's rendering:

```python
import os, threading, time
os.environ["HERMES_HOME"] = "/opt/data/hermes-home-staging"
os.environ["HERMES_GATEWAY_SESSION"] = "1"        # makes _is_gateway_approval_context() true
from hermes_cli.plugins import discover_plugins; discover_plugins()   # loads plugins.enabled
from tools import approval as ap
import model_tools
from tools.mcp_tool import discover_mcp_tools; discover_mcp_tools()   # ~60s, needed for MCP tools

K = "telegram:<user-id>"; captured = []
ap.register_gateway_notify(K, lambda d: captured.append(dict(d)))     # stands in for the adapter

def worker():
    ap.set_current_session_key(K)   # MUST be set inside the thread: threads do NOT inherit contextvars
    box["r"] = model_tools.handle_function_call(tool, args, "task", session_id=K)
# start worker, wait for `captured`, then:
ap.resolve_gateway_approval(K, "once")   # or "deny" — this is what the button tap calls
```

Traps, all of which cost real time to discover:

- **`set_current_session_key` must be called in the worker thread.** `threading.Thread` starts
  with a fresh empty context, so setting it in the main thread silently falls back to `default`
  and the notify_cb is never found.
- **Approvals resolve FIFO per session.** An earlier test that raised a prompt and never answered
  it will swallow the *next* test's `resolve_gateway_approval`, producing a bogus "no result".
  Always answer every prompt and drain between cases:
  `while ap.has_blocking_approval(K): ap.resolve_gateway_approval(K, "deny")`.
- **`discover_mcp_tools()` takes ~60s** and spews Railway OAuth / figma connection tracebacks —
  harmless noise, filter it. Batch several test cases into one process to pay that cost once.
  You can skip it entirely for gate-only tests: `pre_tool_call` fires *before* dispatch, so an
  ungated tool surfaces as `{"error": "Unknown tool: ..."}` — a perfectly good "the gate did not
  fire" signal.
- **Config variants without touching production**: copy just `config.yaml` into a throwaway dir,
  edit with `yaml.safe_dump`, `chown hermes`, and run with `HERMES_HOME=/tmp/th_x`. Use a fresh
  process per variant — config loading is cached.
- The MCP servers need credentials from `HERMES_HOME/.env`; forward them with
  `sudo -u hermes -H --preserve-env=AWS_ACCESS_KEY_ID,... env HERMES_HOME=...`.
- OOS scripts run under **`dash`**, not bash. `read a b < <(...)` process substitution fails with
  `Syntax error: redirection unexpected`. Start the script with `#!/bin/bash` or avoid bashisms.
- **Even root gets `Permission denied` re-writing a `/tmp` probe file you previously chowned to
  `hermes`** (`fs.protected_regular` + sticky dir). Always `rm -f` the file before rewriting it,
  or use a fresh filename per run.
- **Always wrap remote work in `timeout` and background it** (`nohup … &`, poll `/tmp/*.out`), and
  finish with an orphan sweep — `pgrep -af '<probe-name>'` then `pkill -f`. A hung MCP/agent probe
  will otherwise spin a core indefinitely, since nothing on the box reaps it.
- The `write_file` tool's argument is **`path`**, not `file_path`; passing the wrong key returns
  `missing required field 'path'` and can look like a permissions failure.
- Temp `HERMES_HOME` copies usually contain a copy of `.env`. Delete them (`rm -rf /tmp/th_*`) as
  part of cleanup, not just the scripts.

### Driving a REAL agent turn (model picks the tool) instead of calling the tool yourself

`handle_function_call` proves the gate; it does **not** prove the agent's own loop reaches the
gate. For that, build the agent the way oneshot does and let the model choose:

```python
import hermes_cli.oneshot as oneshot
resp, res = oneshot._run_agent("Which GitHub account am I authenticated as? Use your GitHub tools.")
```

- The gate fires inside the real loop at `agent/agent_runtime_helpers.py:1992-2005`, which then
  passes `skip_pre_tool_call_hook=True` downstream (`:2162`) — single fire, by design.
- **`run_oneshot` forces `HERMES_YOLO_MODE=1` and `HERMES_ACCEPT_HOOKS=1`**
  (`hermes_cli/oneshot.py:171`). Free adversarial coverage: every real turn is already a yolo
  test. Calling `_run_agent` directly does *not* set them — set them yourself to match.
- Combine with the gateway approval channel (recipe above), answering from the main thread while
  the agent runs in the worker thread.
- Get the tool trace from `res["messages"]` → `m["tool_calls"][i]["function"]["name"]`, and the
  blocked/returned payload from the `role == "tool"` messages. That is how you prove **no retry**
  (exactly one gated call) and what the model actually saw.
- **Answer every prompt your harness raises.** If the worker raises a prompt and the main loop
  never resolves it, the call just blocks and you will misread a hang as a timeout bug.

### Proving a blocked call never left the box

"The model got an error" is not proof. Count JSON-RPC requests at the transport, in-process:

```python
import httpx, json
REQS=[]
_orig = httpx.AsyncClient.send
async def patched(self, request, **kw):
    if "githubcopilot.com" in request.url.host:
        try: m = json.loads((request.content or b"").decode()).get("method","")
        except Exception: m = ""
        REQS.append((request.url.path, m))
    return await _orig(self, request, **kw)
httpx.AsyncClient.send = patched
```

Run `discover_mcp_tools()` **first**, then `del REQS[:]`, so registration traffic
(`initialize`/`tools/list`, ~7 requests) can never be confused with a tool call. Assert
`method == "tools/call"` count is 0 on deny and ≥1 on approve. Same-input/opposite-answer pairs
are the only non-vacuous form of this test.

For write tools, add an **independent oracle**: verify the side effect from a channel that does
not use the credential under test — e.g. `git ls-remote --heads origin <branch>` from the Devin
box using Devin's own GitHub access. Create on a throwaway `devin/gate-test-<ts>` branch and
delete it with a local `git push origin --delete`; confirm the remote branch count returns to its
starting value.

### What to actually assert about an approval gate

Gate correctness (deny blocks / approve runs / fail-closed) is the easy half and tends to pass.
The half that finds bugs:

- **Is there a non-gated path to the same capability?** This is the real test. A gate on *tool
  names* does not gate *credentials*. Check whether the agent's own process env holds the
  provider credentials (`tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value hermes-gateway)/environ | grep -oE '^[A-Z_]+='`)
  and whether an SDK is importable in the venv (`boto3`, etc.). If so, the ungated `terminal` /
  `execute_code` tools reach the provider directly and the gate is advisory only. Note that
  `terminal`'s own guard trips on `python -c`, but writing a script file first and running it by
  path is ungated — test *that*, not just the one-liner.
- **Timeout knobs: prove which one governs, they have changed over time.** Historically the
  gateway branch dropped `timeout_seconds` and only `approvals.gateway_timeout` mattered; after
  the gateway-approval-timeout fix, **`approvals.tools_timeout` wins and `gateway_timeout` is
  ignored** for plugin-gated tools. Never assume — set the two to *different* values in separate
  throwaway homes and time the block (`tools_timeout: 5` → returns in ~5s with "did not respond
  in time"; `gateway_timeout: 5` alone → still blocking at 80s). A hang here is fail-*closed*,
  not a security bug, but on production config (300s) a missed approval stalls the turn for five
  minutes — worth reporting as an availability finding.
- **Credentials keep getting relocated into `config.yaml`, per server.** AWS keys and the GitHub
  PAT both live as literals in `mcp_servers.<name>.env` / `.headers.Authorization`. `config.yaml`
  is mode 600 owned by `hermes`, so the agent reads its own credentials and calls the provider
  through ungated `write_file` + `terminal` with **zero prompts**. Re-test this for every newly
  gated provider; it is the finding that matters. Quantify the blast radius from response
  metadata only (for GitHub: `x-oauth-scopes`, login, token length) and never perform a write
  with the harvested credential.
- **Per-call vs sticky**: run two concurrent calls (expect two prompts, one answer resolving one),
  and answer `"session"` then call again (expect a re-prompt).
- **Bypass flags cut both ways**: with `tools_respect_bypass: false`, verify `HERMES_YOLO_MODE=1`
  *and* `approvals.mode: off` still gate; then flip the flag true in a temp home and verify it
  *does* skip — otherwise you have not shown the flag is wired rather than dead.

## Verifying the MCP inventory (server count / tool count / "is it actually usable?")

Drive Hermes' real path, not the config file, as `hermes` with `HERMES_HOME` set:

```python
from tools.mcp_tool import (_load_mcp_config, register_mcp_servers,
                            get_mcp_status, _mcp_tool_server_names)
cfg = _load_mcp_config()          # also loads HERMES_HOME/.env and interpolates ${VAR}
names = register_mcp_servers(cfg) # list of every registered tool name
get_mcp_status()                  # per-server connected / tools / status
```

`_mcp_tool_server_names` maps tool → server, which is the reliable way to group tools (prefix
matching is ambiguous when a server name contains underscores; note config name `aws-api` becomes
tool prefix `mcp_aws_api_`). Registration of ~8 servers takes only ~5–10s once caches are warm,
but still run it backgrounded (`nohup … > /tmp/out 2>&1 &`) and poll, because a single hanging
server can blow the ~60s OOS window.

**Traps:**

- **`get_mcp_status()` only reports servers present in the config file.** If you register an
  ad-hoc/temporary server to run an experiment, it will not appear. Read
  `tools.mcp_tool._servers`, `._server_connect_errors` and
  `server._registered_tool_names` directly instead.
- **"Connected" ≠ usable.** Registration only proves `initialize` + `tools/list` succeeded.
  Always call one genuinely read-only tool per server. Real example: `aws_knowledge` connected
  and registered 5 tools, but *every* `tools/call` timed out (300s), while a raw
  `initialize`/`tools/list` POST from the box returned in 0.07s — so the server was reachable and
  the tools were advertised, yet nothing could be executed.
- **Bound the timeout before probing a suspect server**, or one hung call costs 300s:
  `cfg[name] = dict(cfg[name]); cfg[name]['timeout'] = 45`.
- **Distinguish an auth failure from an argument error.** Vercel's `list_projects` requires
  `teamId`; the bare call returns `Input validation error … expected string, received undefined`,
  which is *not* an auth problem. Call `list_teams` first and pass the real id.
- **Don't grep results for `401` naively** — it matches inside ids and epoch timestamps
  (`1774012726`). Check for `"error"` / `unauthorized` and inspect the context before calling it
  an auth failure.
- **Figma without a file key**: call `get_figma_data` with a bogus key. A Figma **API-level 404**
  proves the npx server spawned, loaded modules and reached `api.figma.com`; `ERR_MODULE_NOT_FOUND`
  / `Connection closed` means the `npx` cache under `/opt/data/hermes-user/.npm/_npx/` is
  half-written again (fix: delete that cache dir and re-fetch **as `hermes`**). Say plainly that
  this is weaker than a real read.
- Servers exposing only an approval-gated tool (`aws-api-arprod`/`-egobid` → just `call_aws`)
  cannot be proven usable without a human approval tap. Report **untested**, not passing.

### Proving an HTTP MCP server's credential really travels in the header

`${VAR}` in a `headers:` block is resolved at **connect time** by
`tools/mcp_tool.py:_interpolate_env_vars` (recurses into dicts), called from `_load_mcp_config`.
So a fresh process is the restart-equivalent — you usually do **not** need to restart the gateway.

The discriminator that actually proves the header is load-bearing: register the **same URL twice**
in one process, once with `headers` and once with the block removed, while the token *is* present
in the environment. Expected `railway` → connected/26 tools, `railway_noauth` →
`401 Unauthorized`. If the no-header copy also works, the credential is reaching the server by
some other channel and the header is decorative. Never edit the real `config.yaml` for this.

Also assert the config stores the **template**, not the secret:
`cfg_text.count(token) == 0` and `'${RAILWAY_API_TOKEN}' in cfg_text`.

### Gateway log has no timestamps — slice it by run boundary

`/tmp/gateway.log` is append-only across many restarts and its lines carry **no timestamps**, so
"the failures are at the end of the file" proves nothing. Each gateway start emits
`Stale systemd unit detected`; use it as the run separator:

```bash
LAST=$(grep -an "Stale systemd unit detected" /tmp/gateway.log | tail -1 | cut -d: -f1)
tail -n +$LAST /tmp/gateway.log | grep -acE 'OAuthNonInteractive|Failed to connect to MCP server'
```

Compare the current-run count against the previous run's. Real example: the tail of the log was
full of Railway OAuth failures, but the *current* run had 0 and the previous run had 11 — the
errors were pre-fix. Cross-check with `ExecMainStartTimestamp` vs the `config.yaml` mtime: if the
gateway started **after** the edit with `NRestarts=0`, it already cold-started against the new
config. Also `ps --ppid <gateway pid>` to see which stdio MCP children (`uvx`, `npx`) are alive.

### Where AWS credentials live changes — check both places

They have moved from `HERMES_HOME/.env` to **literal plaintext inside `config.yaml`'s per-server
`env:` blocks**. Consequences to re-test every time:

- `boto3` default chain under the gateway's own env (`/proc/<pid>/environ`, no manual forwarding)
  should raise `NoCredentialsError`.
- **But `config.yaml` is mode 600 owned by `hermes`, the same user the agent runs as** — so the
  agent can read the keys out of its own config and call AWS through the ungated `terminal` tool
  with **no approval prompt**. Always test this second path before concluding the approval gate
  is a boundary. Classify creds by shape (len 20 / len 40) and never print values.

### Bare-Python datastore reads need the dotenv loaded

`datastore.supabase_app.dsn` is `${DATABASE_URL}`. A bare `python -` under `sudo -u hermes` does
**not** load it, and you get a misleading
`asyncpg ClientConfigurationError: invalid DSN … got ''`. Call
`from hermes_cli.env_loader import load_hermes_dotenv; load_hermes_dotenv()` first. This is a
harness artifact, not a deployment defect — same family as the `supabase` relative-cwd trap.

### Ungated destructive MCP tools

`approvals.tools` typically only lists `mcp_aws_api_*call_aws`, so every mutating Railway/Vercel/
Canva tool runs with no prompt. Enumerate them from the registration dump and report; highest risk
are `mcp_railway_set_variables`, `mcp_vercel_update_project_deployment_protection`,
`mcp_railway_railway_agent`, `mcp_railway_redeploy`, `mcp_vercel_deploy_to_vercel`,
`mcp_railway_delete_*`. **Never invoke them** — enumerate and recommend fnmatch patterns instead.

### OOS scripts run under `dash`, not bash

`RunShellScript` executes with `/bin/sh` (dash on Ubuntu). Bashisms die mid-script with
`Bad substitution` and **everything after that point silently never runs** — which looks exactly
like the feature under test hanging or the box being slow. `${PIPESTATUS[0]}`, arrays, and
`[[ ]]` are the usual offenders. Capture an exit code with `cmd > f 2>&1; echo "rc=$?"` instead of
piping. If a script's output stops early, suspect this before suspecting the product.

## Testing scheduled/oneshot systemd checks (drift checks, cron-style units)

Recipe that generalizes to any `Type=oneshot` + `.timer` health check on this box:

- **Force the failure condition without touching production files.** Put a scratch input in
  `/tmp/<dir>` and override the unit with a *reversible* drop-in:
  `/etc/systemd/system/<unit>.d/99-test.conf` containing `ExecStart=` (to clear) then a second
  `ExecStart=` with the extra flag, plus `systemctl daemon-reload`. Afterwards delete the file,
  `rmdir` the directory, reload, and diff `systemctl show -p ExecStart` against the value you
  captured *before* the test. Never edit the deployed checkout or its `pyproject.toml`/`config.yaml`.
- **`SuccessExitStatus=N` is only proven under a real failing exit.** Assert all three of
  `ExecMainStatus=<N>`, `Result=success`, and `systemctl is-failed` ≠ `failed`. A clean run proves
  nothing about it.
- **Timer schedule**: `systemctl show <t>.timer -p Persistent -p TimersCalendar -p NextElapseUSecRealtime -p UnitFileState`
  plus `systemd-analyze calendar "<spec>" --iterations=3`. `Persistent=true` catch-up cannot be
  exercised without faking the clock — report it as *configured*, not *observed*.
- **Unit stdout**: these oneshot units usually use `StandardOutput=journal` (unlike the 11
  long-running `hermes-*` services, which use `append:`), so here `journalctl -u <unit>` really is
  the right place to look. Verify with `systemctl show -p StandardOutput`.

### Verifying Telegram delivery without `getUpdates`

`getUpdates` is banned (it steals updates from the live gateway poller). Use the fact that
**`message_id` is sequential per chat**: send your own probe via `sendMessage`, run the thing under
test, send another probe, and diff the ids. A gap of 1 proves nothing was sent; a gap of 2 proves
exactly one message landed *in that chat*. Send a control pair first to prove the chat is quiet.
`getChat` is read-only and safe — use it to confirm the destination's identity/type. This is much
stronger evidence than "the code printed no error". Prefix probe text so the human can tell test
traffic apart, and make any forced alert self-labelling (e.g. an impossible version floor like
`99.0.0`) so a test alert can never be mistaken for a real one.

Note `TELEGRAM_HOME_CHANNEL` on this box is Leo's **private DM** (`getChat` → `type=private`), and
`TELEGRAM_HOME_CHANNEL_THREAD_ID` / `TELEGRAM_CRON_THREAD_ID` are **empty** — so any
`message_thread_id` logic is inert here and cannot be proven on this deployment.

### Credential-leak checks on error paths

When a URL embeds a token (`https://api.telegram.org/bot<TOKEN>/...`), test the failure paths, not
just the happy one: a bad token (HTTP error) and an unreachable endpoint. `unshare -n <cmd>` is a
clean, non-mutating way to produce a DNS/network failure. Then assert `grep -cF "$REALTOK"` is 0
across stdout, `--json` output, and the journal. `urllib`'s `HTTPError`/`URLError` render only the
code/reason, so they don't leak the URL — but an uncaught non-`OSError` (e.g. `JSONDecodeError`)
would surface a traceback, so check for `Traceback` too.

### "Read-only" checks still write bytecode

Running any repo script as `hermes` creates `__pycache__/*.pyc` in the checkout and venv (owned by
`hermes`). It's gitignored and `git diff` stays empty, so it isn't damage — but don't claim a tool
is strictly non-writing without checking `find <path> -newermt <start>`, and expect these entries.

## Deploying: the script's own verdict, and pushing the state it captures

`/opt/data/deploy-hermes.sh` is an installed *copy* of `deploy/hermes-deploy.sh`.
The drift check hashes it, so after merging a change to that file you must
reinstall the copy or the next check goes red — which is the check working:

```bash
install -o root -g root -m 0750 \
  /opt/data/hermes-agent/deploy/hermes-deploy.sh /opt/data/deploy-hermes.sh
```

- **Read the verdict, not the exit code alone.** Until PR #113 the unit list came
  from `ls /etc/systemd/system/hermes-*.service`, which includes the
  timer-invoked oneshots; `systemctl is-active` on a finished oneshot exits 3, so
  under `set -e` the loop died at the first one — reporting **2 of 13** units and
  exiting 3 on every *successful* deploy. A green deploy now prints
  `deploy OK (<sha>)`; if you don't see that line, the deploy did not finish,
  whatever the exit code says.
- **A deploy must not run the oneshots.** It restarts enabled units only. Check
  `systemctl show -p ExecMainStartTimestamp --value hermes-{drift-check,memory-projection,secret-backup}.service`
  before and after: unchanged is correct. A deploy that fires the secret backup
  and a projection refit is doing three jobs at once.

**The box cannot push the state it captures — this is deliberate (PR #88).**
`/opt/data/hermes-deploy-state`'s deploy key is read-only so a compromised box
cannot rewrite its own audit trail. `capture` commits locally and the `git push`
fails with *"The key you are authenticating with has been marked as read only."*
Finish the job off-box, or the manifest silently stays local (a commit sat
unpushed for a whole deploy cycle this way):

```bash
# on the box
git -C /opt/data/hermes-deploy-state -c safe.directory=... \
  format-patch --stdout origin/main..main
# then apply to an off-box clone and push from there
```

Verify with `git -C ... log --oneline origin/main..main` on the box: empty means
the trail is actually published. The off-box `git am` produces a *different* sha
for the same tree, so afterwards point the box's `main` at `origin/main` (keep the
local commit on a branch, and only after `git diff main origin/main` is empty) —
otherwise the box reports one unpushed commit forever and the check that proves
publication stops meaning anything.

`capture` needs every one of its arguments (`--hermes-home`, `--deploy-script`,
`--secrets-out`, the three `--credential-glob`s — see
`docs/deployment/deployment-path.md`). Called short it exits **2** and writes
nothing, which is how a week passed with no capture: the weekly check then answers
with a dozen findings that all mean "nobody captured", and a real finding hides
among them.

**A unit installed by hand starts life outside every check we have.** The
snapshot is the baseline, so `deploy_state.py check` cannot report a unit it has
never seen: `hermes-calendar-triage.service` was installed on 2026-08-11 without
`User=` and ran as the only root process on the box for a day, silently. After
adding a unit: give it the `10-unprivileged.conf` drop-in, commit the unit under
`deploy/`, and capture.

### The handover document is checked state too

`docs/deployment/README.md` claims to state what is *currently* true of this box.
Nothing kept that honest and it went three deploys stale — including across the
deploy that moved the phone app to a different checkout and a different user. It
is now checked, from the deploy and from the weekly timer:

```bash
cd /opt/data/hermes-agent && ./.venv/bin/python scripts/deploy_state.py handover
#  exit 0  current (or a note: behind HEAD, but nothing it documents changed)
#  exit 1  STALE — deploy/, deploy_state.py, backup_secrets.py or
#          check_runtime_drift.py moved after the doc was last written
```

Stale is measured against that tooling, **not** against `HEAD`: HEAD moves on
every deploy, so a HEAD-equality check reports drift on every deploy forever and
gets muted. When it does fire, re-verify the claims against the box before moving
the `Last verified` line — a fresh date on stale prose is worse than an old date.

## Constraints usually imposed on this box

Read-only by default: no service restarts, no running the deploy script, no edits to `.env` or
the Supabase Docker stack, no production DB writes, no real messages to users. This means some
findings are **not verifiable** — e.g. confirming a startup-time permission warning clears
requires a restart. Say so explicitly instead of guessing. Clean up any `/tmp` probe files and
re-confirm all 12 long-running units are still `active/running` when done.

## Devin Secrets Needed

- `ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET` — consumed by the
  `alibaba-cloud` MCP server; without them there is no access path to the box at all.
- Everything else (Supabase token, DB URL, Telegram creds) already lives on the box in
  `HERMES_HOME/.env`; do not copy those values off the box or print them.
