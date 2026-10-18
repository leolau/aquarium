# Projects (FG-32) — UAT test suite

> **⚠️ SUPERSEDED 2026-08-20 — the Alibaba `hermes-systest` box named below is
> decommissioned.** Production is now a Hetzner box reachable by SSH; see
> [`docs/deployment/PRODUCTION.md`](../deployment/PRODUCTION.md) before running
> anything in this suite. Retarget the instance ID / IP / `aliyun` commands
> below to the current box first.

**This document is self-contained.** It is written for an agent with no session
context, no access to the conversation that produced it, and nobody to ask. Every
instance id, credential path, command, fixture and expectation you need is
in here. Where something genuinely cannot be known in advance (the deployed sha,
which findings are still open on the box), the document tells you how to
*determine* it from the box rather than telling you to ask.

There is no requester to confirm anything with. If a rule here says "forbidden",
it is forbidden. If a precondition fails, record it and stop — do not improvise a
different target, and in particular **do not fall back to a local dev server**:
the whole point of this suite is the deployed system.

**Target:** the live Alibaba Cloud ECS box `hermes-systest`, tracking
`origin/develop`. There is no SSH; the only access path is the `alibaba-cloud`
MCP server's `OOS_RunCommand` tool.

**Prerequisite reading (in this order), before the first command:**

1. `.agents/skills/testing-hermes-systest-box` (the skill) — every trap in it has
   already produced a false result on this box. Non-negotiable.
2. `docs/design/master-plan/feature-groups/FG-32-projects-durable-record.md` — the
   design. All `§n` references below are to it.
3. `docs/reviews/2026-08-17-projects-end-to-end-review.md` — the findings
   (`H1`–`H4`, `M1`–`M3`, `L1`–`L2`, `F1a`–`F7`, `E1`–`E5`) this suite is
   calibrated against.

**Sibling suite:** `docs/testing/uat-hermes-systest.md` covers the *deployment*
(units, privilege model, memory tier, MCP). This suite covers the *Projects
feature*. Do not duplicate its cases; if a unit is down, that is its finding, not
yours — but say so here too, because it invalidates your run.

**What "pass" means here.** This is not a ship gate. At the time of writing, a
long list of review findings was open, so a naive run returns a wall of red that
proves nothing. §3 tells you how to compute, *from the deployed sha*, which
scenarios are **XFAIL** (expected to fail, with the finding id) and which are
not. Your three products are: (a) confirmation of the expected failures, (b) any
**new** failure, with a full repro, and (c) any expected failure that **now
passes** — that means someone fixed it, which is as valuable as a new bug.

**Notation**

| Mark | Meaning |
| --- | --- |
| ⌗ | read-only scenario: touches no state, safe under any circumstances |
| **XFAIL(id)** | expected to fail *if* finding `id` is still open on the deployed sha — see §3 |
| `T…` | scenario ids are prefixed `T` (`TA1`, `TB2`) so they can never be confused with finding ids (`E1`, `M1`, `L2`) |

---

## 1. Scope

| In scope | Out of scope |
| --- | --- |
| `hermes projects` CLI (the operator surface, §14) | Unit tests — they are green in CI and prove nothing about the deployment |
| The HTTP API at `127.0.0.1:9119/api/registry/projects` (§13) | `web/` dashboard (it has no Projects screens) |
| `agent-home` Projects list + detail — the primary UI (D20) | Deployment health (see the sibling suite) |
| Mandatory-field contract, outputs/progress, cadence + cron, autonomy gates, guidance, runs, score, retro/learning, permissions, cross-profile isolation, to-do promotion | Load/performance, browser matrix, i18n |
| Reporting | **Fixing.** Change no product code. If you find yourself editing `hermes_cli/` or `agent-home/`, stop |

**Scenario count: 86** (TA 7 · TB 6 · TC 8 · TD 8 · TE 4 · TF 8 · TG 5 · TH 11 ·
TI 8 · TJ 6 · TK 7 · TL 4 · TM 4 · TZ 4). Your report's counts must add to 86.

---

## 2. Environment: everything you need to connect

### 2.1 The box

```
Instance : i-j6c81aisv2dd8mg17yle
Region   : cn-hongkong
Hostname : hermes-systest
```

Access pattern (every command in this suite goes through this):

```
mcp_tool(command="call_tool", server="alibaba-cloud", tool_name="OOS_RunCommand",
  tool_args='{"RegionId":"cn-hongkong","InstanceIds":["i-j6c81aisv2dd8mg17yle"],
              "Command":"<sh script>"}')
```

If `hostname` does not return `hermes-systest`, **stop**: you are on the wrong
machine. Report `BLOCKED — wrong host, got <x>` and do not write anything. If the
instance id above no longer exists, list instances in `cn-hongkong` through the
same MCP server and look for the host named `hermes-systest`; if there is exactly
one, use it and say so in the report. If there is none or several, stop.

Requirements the skill spells out and this suite depends on: scripts run **as
root under `dash`, not bash** (no `[[ ]]`, no arrays, no `${PIPESTATUS[0]}` — a
bashism kills the rest of the script silently); **a nonzero exit fails the whole
MCP call**, so end every script with `; true`; the MCP call **times out at ~60 s**
while the script keeps running, so launch anything slow with
`nohup … > /tmp/uat/out.txt 2>&1 &` and read the file in the next call; output is
truncated, so `grep`/`head`/`cut -c1-160` on the box.

### 2.2 Paths and the CLI prefix

| Thing | Path |
| --- | --- |
| Checkout (tracks `origin/develop`) | `/opt/data/hermes-agent` |
| `HERMES_HOME` | `/opt/data/hermes-home-staging` |
| Venv entry point | `/opt/data/hermes-agent/.venv/bin/hermes` |
| Agent `.env` | `/opt/data/hermes-home-staging/.env` |
| `config.yaml` | `/opt/data/hermes-home-staging/config.yaml` |
| API (loopback only — `curl` runs **on the box**) | `http://127.0.0.1:9119/api/registry/projects` |
| `agent-home` | `http://127.0.0.1:3100`, public `https://<agent-home-host>` |
| `agent-home` secrets (0600, not in git) | `/opt/data/hermes-agent/agent-home/agent-home.env` |
| Service user | `hermes` |
| This suite's scratch dir | `/tmp/uat` (yours to create and delete) |

**Every `hermes projects …` line below is shorthand.** Expand it to:

```sh
cd /opt/data/hermes-agent && sudo -u hermes -H env \
  HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes projects <args>
```

Three traps that have each produced a wrong answer on this box:

- **Omitting `HERMES_HOME` does not fail** — it answers about
  `/opt/data/hermes-user/.hermes`, a real, empty, core-only home. Every answer
  will look internally consistent and be about a deployment nobody uses. `sh -lc`
  does **not** inherit it either.
- **`--profile` and `--actor` are *global* selectors** and must appear **before**
  the subcommand: `hermes --profile maintenance datastore show`,
  `hermes projects --actor <user> show <slug>`. A trailing `--profile`/`--actor`
  silently selects instead of targeting.
- **`hermes projects` (plural) is this feature; `hermes project` (singular) is the
  unrelated folder-workspace command.** If output looks nothing like Projects,
  check which one you typed before reporting a defect.

### 2.3 Safety rules — non-negotiable

1. **No service restarts. No `deploy-hermes.sh`. No edits to `.env`,
   `config.yaml`, unit files, drop-ins, or the Supabase Docker stack.** If a
   scenario can only be proven by a restart, record `BLOCKED — needs restart`.
2. **Writes are pre-approved only within §2.4's fence.** The owner chose this
   deployment as the target; the fence is what makes that safe.
3. **Namespace everything.** Compute once, at the top of the run:
   `UAT_TAG="UAT-$(date -u +%Y%m%d)"`. Every project's goal and name starts with
   `$UAT_TAG-`; every slug will therefore start `uat-`. **Never touch a project,
   card, cron job, to-do or contact you did not create.**
4. **No real outbound messages.** Contacts use `--platform note --address
   uat@example.invalid`. Never point a contact at a real chat or address.
5. **Never approve an irreversible action.** TF3 *provokes* the gate and asserts
   it held; it never taps Approve. Leave it pending and cancel the run.
6. **Never print secret values.** Grep for key *names*; print `${#VAR}`; redact
   with `sed -E 's/[A-Za-z0-9_-]{30,}/***REDACTED***/g'` before anything leaves
   the box.
7. **Never write a production SQLite file directly.** Read through the CLI/API.
   Where a scenario needs a store (TJ6), copy it to `/tmp/uat`, `chown hermes`,
   and work on the copy — SQLite needs a writable *directory*, not just a
   writable file.

### 2.4 What this run writes, and the teardown that removes it

Writes: rows in the Projects root store (projects, outputs, links, members,
contacts, directives, runs, retros, summaries), kanban cards in the host
profile's board, up to two cron jobs in the host profile, to-dos for TJ1/TJ2,
files under `/tmp/uat`, and `__pycache__` bytecode in the checkout (expected,
gitignored, not damage).

Projects have **no destructive delete** — the record is durable by design. So
teardown is: cancel open runs, remove schedules, write a closing summary saying
`UAT artefact, safe to ignore`, and leave the projects in place. Then prove the
moving parts are gone (`$AUTH` is defined in §2.5):

```sh
cd /opt/data/hermes-agent
H="sudo -u hermes -H env HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/hermes"
for S in $UAT_SLUGS; do                      # the slugs you created, space-separated
  curl -s -o /dev/null -w "sched-del $S %{http_code}\n" \
    -X DELETE "127.0.0.1:9119/api/registry/projects/$S/schedule" -H "$AUTH"
  echo "UAT artefact, safe to ignore" | $H projects summarise "$S" --json | head -c 200
done
$H --profile "$HOST_PROFILE" cron list | grep -c uat- ; echo "^ must be 0"
$H projects list --json | grep -o '"slug": "uat-[^"]*"' | sort
rm -rf /tmp/uat
; true
```

**List every remaining artefact in the report**, with slug and reason. A leftover
cron job is a finding against your own run.

### 2.5 `$AUTH`: minting an API token without the password

`dashboard.basic_auth.password_hash` is scrypt and cannot be reversed, but the
provider's signing key is in the same config, so you can mint a session. Run this
**as `hermes`, inside the venv, with `HERMES_HOME` set** (it reads `config.yaml`):

```sh
cd /opt/data/hermes-agent
sudo -u hermes -H env HERMES_HOME=/opt/data/hermes-home-staging ./.venv/bin/python - <<'PY' > /tmp/uat/token
from plugins.dashboard_auth.basic import (
    BasicAuthProvider, _load_config_basic_auth_section, _resolve, _resolve_secret,
)
sec = _load_config_basic_auth_section()
user = _resolve("HERMES_DASHBOARD_BASIC_AUTH_USERNAME", sec, "username")
pwh  = _resolve("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH", sec, "password_hash")
assert user and pwh, "dashboard.basic_auth is not configured — see the note below"
assert sec.get("secret"), "no stable signing secret — see the note below"
p = BasicAuthProvider(username=user, password_hash=pwh, secret=_resolve_secret(sec))
print(p._mint_session(user).access_token)
PY
chmod 600 /tmp/uat/token
AUTH="Authorization: Bearer $(cat /tmp/uat/token)"
```

**If `dashboard.basic_auth.secret` is unset**, the running server generated a
*random per-process* signing key, so a token you mint in a fresh process will not
validate. That is not a defect and you cannot fix it without a restart (which is
forbidden): record every API and UI scenario as
`BLOCKED — no stable dashboard signing secret, cannot mint a session` and run the
CLI-only scenarios. Do not try to guess or reset the password.

Confirm the token resolves a principal before using it — this is scenario TA4:

```sh
curl -s 127.0.0.1:9119/api/comms/whoami -H "$AUTH" | cut -c1-200
# expect {"configured": true, "principal": {"user_id": "leo_owner", …}}
```

Note the login *subject* is `admin` while the principal is `leo_owner`; they are
linked by `hermes owner alias admin`. Record the `user_id` you actually get — §I
needs it, and it is the "owner" role in the matrix.

### 2.6 Driving `agent-home` in a real browser

**The §H findings are client-state bugs. `curl` cannot prove or disprove any of
them** — the panels are React and the whole question is what the DOM does after a
click without a reload. You need a browser.

Mint the cookie (payload shape from `agent-home/src/lib/auth/session.ts`: cookie
name `agent_home_session`, value `b64url(JSON).b64url(HMAC-SHA256(payload,
AGENT_HOME_SESSION_SECRET))`, 12 h max age; `principal` must be the **full
object**, not a string):

```sh
cd /opt/data/hermes-agent/agent-home
# AGENT_HOME_SESSION_SECRET lives in agent-home.env (0600). Do not print it.
sudo -u hermes -H sh -c '
  set -a; . /opt/data/hermes-agent/agent-home/agent-home.env; set +a
  TOKEN="$(cat /tmp/uat/token)" node -e "
    const {createHmac}=require(\"node:crypto\");
    const b=(x)=>Buffer.from(x).toString(\"base64\")
      .replace(/\+/g,\"-\").replace(/\//g,\"_\").replace(/=+$/,\"\");
    const s={hermesToken:process.env.TOKEN,
      principal:{user_id:\"leo_owner\",display:\"leo_owner\",role:\"owner\",
                 channels:[],is_owner:true},
      issuedAt:Math.floor(Date.now()/1000)};
    const p=b(JSON.stringify(s));
    console.log(p+\".\"+b(createHmac(\"sha256\",process.env.AGENT_HOME_SESSION_SECRET)
      .update(p).digest()));
  "' > /tmp/uat/cookie
chmod 600 /tmp/uat/cookie
```

Set `principal.role` to the role the scenario needs (`owner` for §B–§H, the
others for §I) and keep `user_id` consistent with what TA4 returned. Then, in
your browser, open `https://<agent-home-host>`, set the cookie
`agent_home_session` = that value for that host (DevTools → Application →
Cookies, or a CDP/Playwright `addCookies`), and reload. The public host is the
same app with the same secret, so the cookie is valid there.

**Record the browser work.** The recording is the evidence for §H; a still frame
cannot show "nothing happened after the click", which is exactly what several
scenarios are about. Screenshot each assertion as well.

If the public host is unreachable, or the cookie is rejected (you land back on
`/login`), mark every §H scenario `BLOCKED — no browser path to agent-home` and
say which of the two failed. **Do not substitute `curl` and report §H as passed.**

### 2.7 Fixtures — create these before §B

```sh
mkdir -p /tmp/uat && chmod 777 /tmp/uat
cat > /tmp/uat/brief.md <<'MD'
# UAT brief
This project exists only to exercise the Projects feature on the systest box.
It is a test artefact and produces nothing anyone should act on.
MD
cat > /tmp/uat/out.md <<'MD'
UAT delivery artefact. Ignore.
MD
cat > /tmp/uat/playbook.md <<'MD'
# UAT playbook
1. Collect the inputs named in the brief.
2. Draft the artefact.
3. Deliver it against the declared output.
MD
chown -R hermes /tmp/uat
; true
```

`hermes projects create --description` takes a **file path or `-` (stdin)**, not
prose — passing a sentence fails confusingly. Same for `playbook save` and the
stdin-driven `retro --write` / `summarise`.

### 2.8 Where the report goes

```sh
mkdir -p /home/<you>/repos/<checkout>/docs/testing/results   # the dir does not exist yet
```

Write the §6 report to
`docs/testing/results/<yyyy-mm-dd>-projects-uat-run.md` in **your own local
checkout** (not on the box), using the same UTC date as `$UAT_TAG`.

---

## 3. Which failures are expected (compute this — do not assume)

Every finding below was open when this suite was written. Fixes land
continuously, and the box only has them **after a deploy**, so the deployed sha —
not `origin/develop`, not this document — decides what is expected.

For each finding with a "closed by" commit, run on the box:

```sh
cd /opt/data/hermes-agent
git -c safe.directory=/opt/data/hermes-agent merge-base --is-ancestor <fix-sha> HEAD \
  && echo "FIXED-ON-BOX" || echo "STILL-OPEN"
; true
```

- `STILL-OPEN` → the scenario is **XFAIL**: record `FAIL (known: <id>)`, and if it
  *passes* instead, record `PASS (known <id> no longer reproduces)` and say what
  you saw.
- `FIXED-ON-BOX` → the scenario is a **normal expectation**: a failure is a
  **regression** and needs a full repro. Verify the fix, don't assume it.
- No "closed by" commit → still open, XFAIL.

| Finding | Effect | Closed by | Scenarios |
| --- | --- | --- | --- |
| H1 | `agent.human_comms` import does not exist (caught broadly) → checkpoint/budget approvals silently never raised | — | TF2, TF4 |
| H2 | synthetic `trace_id`, missing `sum_cost_for_trace` → per-run budget unenforceable, cost unknown | — | TF4, TG5 |
| H3 | `_enabled_toolsets_for_profile` ignores its argument, reads the *calling* process's config → can grant what the host profile disables | — | TF6 |
| H4 | inline spawn omits `profile_home` → run executes in the server's profile while the row records the host profile | — | TF5 |
| M1 | a repeatable project that has never run is not `stalled` | — | TD6 |
| M2 | list filters applied *after* pagination slicing → rows skipped / pages end early | — | TC7 |
| M3 | instance owner/admin who is not a member cannot see contact addresses | — | TI5 |
| L1 | toolsets/skills stored as CSV strings | — | TF6 |
| L2 | imported profile projects can carry NULL goal / no output / no host profile | — | TJ4 |
| F1a | accept-output returned an ack envelope the panel merged as a row → status/button stale | `5afaa8dcf` | TH4 |
| F1b | continue-run envelope read as `data.status` → no state change, `budget_gate` never shown | `5afaa8dcf` | TH5 |
| F1c | add-directive ack cast to a full directive → renders blank until reload | `5afaa8dcf` | TH6 |
| F2 | the Attention filter cannot show a `stalled` project | — | TH8 |
| F3 | `@router.get("/")` → every list/create pays a 307 | — | TB3 |
| F4 | `RunView` never revalidated after a write | `5afaa8dcf` | TH5 |
| F5 | a waiting run can fall out of the five-run brief | — | TH7 |
| F6/F7 | upstream error detail/path leakage; raw 404 body rendered | — | TH9 |
| E1 | accept-output / activate-directive / activate-playbook had no human gate, and the CLI patched the gate out unconditionally | `5afaa8dcf` (adds `_require_human` + `--as-human`) | TI8, TK3, TL4 |
| E2 | `from_todo.profile` recorded but not honoured; failed stage transition leaves the `project_links` row | — | TJ1, TJ2, TJ3 |
| E3 | the events tail has no consumer — nothing polls it | — | TH10 |
| E4 | events tail builds `IN (?,…)` from task ids → breaks past ~999 visible cards | — | TK5 |
| E5 | derived score scans only the latest 25 runs before picking 5 scored ones | — | TL3 |

**Two calibration notes you must carry into the report:**

- **E1 is partly a design disagreement, not only a bug.** After `5afaa8dcf` the
  CLI patches the human seam **only** under an explicit `--as-human` flag, and the
  code comment argues the operator's terminal legitimately *is* the human. The
  contract this suite holds it to (§8.1): a **sessionless/agent** caller must be
  refused, and a human claim must be **explicit**. So: without `--as-human` the
  human verbs must refuse and name the flag; with it they may proceed. An
  *unconditional* patch would be the defect.
- Findings marked `—` may have been fixed after this document was written. That is
  what the `merge-base` check is for. Report what the box does.

---

## 4. Recording a result

One row per scenario, plus for every `FAIL`:

- the **verbatim** command or click path (an agent must be able to paste it);
- observed vs. expected, quoted — JSON body, CLI stdout, HTTP status, screenshot;
- the finding id from §3, or `NEW`;
- severity: **S1** data loss · privilege or profile-boundary breach · contact
  address leak · a capability granted that a profile disables. **S2** a documented
  user action does not work. **S3** wrong state shown, right state stored. **S4**
  cosmetic/wording.

`UNTESTED` and `BLOCKED` are respectable and far more useful than a guess. Never
write `PASS` for something you inferred rather than observed — a skipped case that
reads as a pass is the exact defect class this deployment keeps producing.

---

## 5. Scenarios

### §TA — Preconditions (if TA1–TA5 fail, stop and report)

| ID | Steps | Expected |
| --- | --- | --- |
| TA1 ⌗ | Through `OOS_RunCommand`: `hostname; date -u; true` | Output actually comes back, and the host is `hermes-systest`. **An MCP call that returns nothing is a blocker, not a slow box** — retry once, then report `BLOCKED — no output from OOS_RunCommand`. Nothing below is meaningful without this. |
| TA2 ⌗ | `git -C /opt/data/hermes-agent -c safe.directory=/opt/data/hermes-agent log --oneline -1` | Record the sha. The entire report is relative to it, and §3's `merge-base` checks run against it. |
| TA3 ⌗ | `hermes projects --help` (expanded per §2.2) | Subcommands: list/show/create/link/outputs/contacts/tools/members/cards/card/playbook/guidance/run/runs/score/retro/summarise/doctor, plus the global `--actor` and `--as-human` (§14). Missing `--as-human` means the `5afaa8dcf` fix is not on the box — cross-check §3. |
| TA4 | §2.5, then `curl -s 127.0.0.1:9119/api/comms/whoami -H "$AUTH"` | A principal resolves. Record its `user_id`. If minting is impossible, follow §2.5's blocked path. |
| TA5 ⌗ | `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:9119/api/registry/projects/doctor -H "$AUTH"` | `200`. This is the **collection** doctor (`@router.get("/doctor")` is declared before `/{slug}`, so it is not swallowed as a slug) — not a routing bug. A `404` means the router is not mounted in the *running* process: compare `systemctl show -p ExecMainStartTimestamp hermes-dashboard.service` against the checkout mtime before blaming code. |
| TA6 ⌗ | `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:3100/login`; `stat -c %y /opt/data/hermes-agent/agent-home/.next/BUILD_ID` | `200`; `BUILD_ID` newer than the last `agent-home/` commit on the box. **An older `BUILD_ID` means the UI you are about to test is not the sha from TA2** — say so prominently and do not rebuild (that is a deploy action). |
| TA7 ⌗ | `hermes projects doctor --json`; `hermes profile list`; `systemctl show -p MainPID --value hermes-dashboard.service` then read that process's profile | Record: (a) pre-existing doctor complaints, so they are not later blamed on this run; (b) the store path if the JSON carries one, else find it under `HERMES_HOME` and say how; (c) the **host profile you will use** for §D–§F — prefer a low-traffic profile, never one running live gateways if there is a choice; (d) **the dashboard process's own profile**, which TF5 needs as the comparison. |

### §TB — Creation and the mandatory contract (§2.2)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TB1 | §2.2 | `hermes projects create "$UAT_TAG-golden path record" --description /tmp/uat/brief.md --output "Weekly digest" --host-profile $HOST_PROFILE --json` | Created. `goal` echoed; `name` **defaulted from the goal** and ≤60 chars; one declared output; host profile recorded; `status=planning`; a derived `progress` present. Record the slug into `$UAT_SLUGS`. |
| TB2 | §2.2 | Run the four negative cases **through the API**, because the CLI declares `--description`/`--output` as argparse-required and would refuse before the store ever sees them: `POST /api/registry/projects` with (a) no `goal`, (b) no `description`, (c) `outputs: []`, (d) no host profile. Then repeat (b) and (c) through the CLI too | Each refused with a message **naming the missing field** (422/409, not 500). The CLI's argparse refusal is acceptable *as well as*, not instead of, the store's — report both. Note separately whether omitting `--host-profile` (which defaults to `"default"`) differs from passing `--host-profile ''`. |
| TB3 | **XFAIL(F3)** | `curl -s -o /dev/null -w '%{http_code}' 127.0.0.1:9119/api/registry/projects -H "$AUTH"` (no trailing slash) | Expected `200`. With F3 open: `307` to `/`. Record the redirect chain (`-w '%{http_code} %{redirect_url}'`). |
| TB4 | §1.1 | `PATCH /{slug}` with only `name`, then with only `goal`; then a 61-char name and a 161-char goal | The two fields move independently — editing `goal` never rewrites `name`. Both caps (60 / 160) refused with 422. |
| TB5 ⌗ | §1.1 | `hermes projects show <slug>` on a project with no audience/score/plan/contacts/files/memories/tools/skills | Optional fields are **absent**: no empty headings, no literal `None`/`null`/`[]` in the human rendering. |
| TB6 | §2.2, §3.1 | `create … --cadence repeatable` with no playbook | Creation succeeds; **scheduling** is what gets refused later (TD4). If creation itself is refused, quote §3.1 and report the mismatch. |

### §TC — Outputs and progress (§2.3, §9)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TC1 | §2.3 | `outputs <slug> add "Second artefact" --spec "one PDF"`, then `outputs <slug> list` | Both outputs listed, status `declared`. |
| TC2 | §2.3 | `outputs <slug> deliver <id> --ref /tmp/uat/out.md`, then `list` | `delivered`, ref stored. **Delivery is not acceptance** — nothing about progress may treat it as accepted. |
| TC3 | §2.3 | `outputs <slug> accept <id> --as-human` (add `--as-human`; see §3 note on E1), then `show <slug> --json` | `accepted`, the acceptor recorded, and the response says whether closure is offered. Without `--as-human` it must refuse and name the flag (see TI8). |
| TC4 | §2.3 | `DELETE /{slug}/outputs/{id}` on the **last** non-optional output | Refused (409/422) naming the invariant: a project always keeps ≥1 declared output. |
| TC5 ⌗ | §9 | Compare `progress` before and after TC3 | The ladder is ordered and **labelled**: an accepted output outranks the card ratio, and the response says which rung produced the number. |
| TC6 ⌗ | §9 | A project with cards but no accepted output | Progress falls back to the card rollup, labelled as such — never presented as output progress. |
| TC7 | **XFAIL(M2)** | Create ≥3 `uat-` projects with mixed status, then `GET /?status=active&limit=2`, then page with the returned `next_cursor` (keyset over `(created_at, id)`; the body is `{"items": […], "next_cursor": …}`) | Every matching row is returned exactly once. With M2 open, filtering happens after slicing: assert on `items` length vs. `next_cursor` presence — pages come back short, or `next_cursor` is null while matching rows remain. |
| TC8 ⌗ | §9 | `projects list --health attention` and `--health stalled` | Health is derived on read; both filters return coherent, non-overlapping-in-meaning sets. Cross-check with TH8. |

### §TD — Cadence and the schedule (§3)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TD1 | §3.2 | On a repeatable project: `playbook <slug> save /tmp/uat/playbook.md`, `playbook <slug> activate <rev> --as-human`, then `PUT /{slug}/schedule {"schedule":"0 6 * * 1"}` | 200; `hermes --profile $HOST_PROFILE cron list` shows **exactly one** job for the project; both halves of the link stored; `next_run_at` populated. |
| TD2 ⌗ | §3.2 | `show <slug> --json` vs. `cron list` immediately after TD1 | `next_run_at` is a cache and agrees with cron. Disagreement is a finding. |
| TD3 | §3.2 | `DELETE /{slug}/schedule` | Job gone from the host profile's cron store **and** both link halves cleared. No orphan job (this is also part of teardown). |
| TD4 | §3.1 | `PUT /{slug}/schedule` on a repeatable project with **no active playbook** | 409 naming the missing precondition — not 500, not silent success. |
| TD5 | §3.1 | With a schedule in place, `DELETE /{slug}/profiles/{host_profile}` | Scheduling pauses and the project is marked `stalled`; no job keeps firing into a profile the project no longer names. |
| TD6 | **XFAIL(M1)** | A repeatable project created and never run: `projects list --health stalled` | Expected: it appears — nothing has ever produced output. With M1 open, never-run repeatables are not marked stalled. |
| TD7 ⌗ | §3 | One-off, repeatable and standing projects side by side in `list`/`show` | Cadence drives closure: a one-off can close on acceptance; a **standing** project shows review age, never a completion percentage (§9). |
| TD8 ⌗ | §3.2 | `projects doctor --json` after TD1–TD5 | Every complaint it reports is either explained by a scenario above or is a finding. Diff against the TA7 baseline. |

### §TE — Cards and the board (§10, §12)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TE1 | §10 | `card add <slug> "$UAT_TAG card A"`, then `cards <slug>`, then `hermes --profile $HOST_PROFILE kanban` | Card created in the host profile's board, linked to the project, visible from both sides. |
| TE2 ⌗ | §12 | `GET /{slug}/board` as each role available (see §I) | Board reads always carry the principal; an unreadable project answers **404**, never 403. |
| TE3 | §4 | Set `max_in_progress` to 1 (`PATCH /{slug}/autonomy` or the documented field — say which), then try to promote two cards | The second promotion is refused or queued; the cap is enforced at the `triage → todo` gate, not only in the UI. |
| TE4 | §7 | Cancel a run that has unstarted cards (see TF7) | Unstarted cards archived; work already in flight is not killed. |

### §TF — Runs, autonomy and the gates (§4, §7)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TF1 ⌗ | §7 | `run <slug> --dry-run --json`; diff `cards <slug>` before/after | Prints the cards it *would* create and the compiled guidance block, and creates nothing. |
| TF2 | **XFAIL(H1)** | Autonomy `supervised`; `run <slug> --trigger manual`; then look for the approval in the **notification store** (`hermes_cli.human_comms`), not the log | Expected: a checkpoint notification exists and the successor card waits in triage until `continue`. With H1 open the seam import fails and is swallowed, so **no approval is ever raised**. Evidence must be the notification store. |
| TF3 | §4 | Autonomy `autonomous`; drive the run to an irreversible action | The action is still approval-gated at **every** autonomy level. **Do not approve.** Assert the gate exists, leave it pending, cancel the run. No gate ⇒ **S1**. |
| TF4 | **XFAIL(H1+H2)** | Set a very low `budget_usd_per_run`, run, inspect the run row | Expected: the run pauses at the budget gate, `budget_gate` is exposed, `continue` resumes it. With H2 open, `trace_id` is synthetic and `run_cost` imports a symbol that does not exist, so the budget cannot bind. |
| TF5 | **XFAIL(H4)** | `run <slug> --trigger manual` where the project's host profile ≠ the dashboard process's profile (recorded in TA7); then compare **where the spawned session actually ran** (its profile home) against the profile the run row claims | They must match. With H4 open the inline spawn omits `profile_home`, so work happens in the server's profile while the row claims the host profile. The run row alone is not evidence — find the session's home. |
| TF6 | **XFAIL(H3, L1)** | `tools <slug> set --toolsets <a toolset the host profile DISABLES>`, then run | The run spawns **without** it: project tools narrow, never grant (invariant 14). With H3 open the profile argument is ignored and the calling process's config is read. **If it grants, this is S1.** Also note whether toolsets/skills round-trip as CSV strings (L1). |
| TF7 | §7 | `POST /{slug}/runs/{run_no}/cancel` | Returns the updated run row; unstarted cards archived; the cancelled run stays in the record (runs are never deleted). |
| TF8 ⌗ | §7 | `runs <slug> --json` after TF1–TF7 | One row per occurrence with trigger and an outcome judged **against the declared outputs** (`delivered`/`partial`/`no_output`) — not against card completion. |

### §TG — Guidance (§5)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TG1 | §5 | With a run open, `guidance <slug> add "always cite the source"`; inspect the open run's prompt; then start a second run | Absent from the first run's prompt, present in the second. The system prompt is frozen for a conversation's life and prompt caching is sacred. A mid-run change is **S1**. |
| TG2 ⌗ | §5 | Add directives past the documented cap | Cap enforced; newest-first ordering; each directive carries author and date. |
| TG3 | §5 | `guidance <slug> retire <id>`, then start a run | Retired directive absent from the new prompt, still visible in the record as retired. |
| TG4 | §5, §6 | Leave a proactive ask unanswered, then try to run | The run blocks on the unanswered ask instead of proceeding without the answer. |
| TG5 | **XFAIL(H2)** | `runs <slug> --json`, look at cost | With no ledger binding, cost must read **"not recorded"** — never `$0.00`, which would claim a free run. |

### §TH — agent-home UI (needs §2.6's browser + recording)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TH1 ⌗ | §15 | Open the Projects list | The `uat-` projects appear with goal, cadence, status, progress, health; the progress label matches the API's rung. |
| TH2 ⌗ | §15 | Open a project's detail page | The design's five groups in order: commitment · method · cast · work · record. Empty optional fields are absent, not blank-labelled. |
| TH3 ⌗ | §15 | Detail page of a scheduled project | Cadence, next run and host profile shown; **nothing implies a directive can affect a run already in flight**. |
| TH4 | **XFAIL(F1a)** | Click **Accept** on a delivered output; **do not reload** | Row flips to `accepted`, deliveries survive, the Accept button goes, any closure notice appears. With F1a open the row stays `delivered` with the button live until reload. Screenshot before / after / after-reload. |
| TH5 | **XFAIL(F1b, F4)** | Click **Continue** on a waiting run; **do not reload** | The run's state changes and any `budget_gate` holding it is rendered. With F1b/F4 open the click appears to do nothing. |
| TH6 | **XFAIL(F1c)** | Add a directive from the Guidance panel; **do not reload** | It renders with body, author and date. With F1c open it renders blank until reload. |
| TH7 | **XFAIL(F5)** | With ≥6 runs, one of them waiting, open the detail page | The waiting run is always visible — it is the one needing a human. With F5 open it can fall out of the five-run brief. |
| TH8 | **XFAIL(F2)** | Filter the list by **Attention** with a `stalled` project present | Stalled projects are reachable from the list UI (under Attention or a separate, visible filter). With F2 open the chip cannot show them. |
| TH9 | **XFAIL(F6, F7)** | Request a project the session cannot read; and force an upstream error | A 404 renders as a human "not found" page; **no upstream path, internal detail or stack reaches the browser**. Capture the exact rendered body. Leakage is **S1**. |
| TH10 | **XFAIL(E3)** | Change project state via the CLI, then watch the open detail page for ~2 minutes, touching nothing | The page picks the change up — the events tail exists for exactly this. With E3 open nothing polls it and the page only refreshes after a local write. **Record the two minutes**; a still frame proves nothing. |
| TH11 | §15 | For every UI write above, reload and compare with the API | After reload, UI state matches the API. A discrepancy that **survives** reload is worse than F1x and is a **NEW** finding. |

**Seeding §TH:** TH4 needs a delivered-not-accepted output (TC2 on a second
output), TH5/TH7 need a **waiting** run, TH8 needs a `stalled` project (TD5
produces one). A waiting run is exactly what TF2/TF4 fail to produce while H1/H2
are open — so if you could not create one, mark TH5 and TH7
`UNTESTED — no waiting run reachable (H1/H2)` rather than guessing. That
contingency is itself a reportable consequence of H1.

### §TI — Permissions and privacy (§12)

Prefer **real principals**. If the box has only the owner (likely), drive the
matrix through `hermes projects --actor <user> …` (global flag, before the
subcommand) and/or a cookie minted with a different `principal.role`, and state
plainly in the report which surface produced each row — a CLI-level check is
weaker evidence than an HTTP session and must not be reported as equivalent.

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TI1 ⌗ | §12 | Read and write a `uat-` project as owner, lead, member, viewer, non-member, and a member of a *different* project | The §12 matrix holds, verb by verb. Tabulate it. |
| TI2 ⌗ | §12 | Any read of a project the principal cannot see | **404**, and the body reveals nothing about existence. A 403 here is a finding. |
| TI3 ⌗ | §12 | `viewer` reads a project with contacts (add one with `--platform note --address uat@example.invalid`) | `contacts[].address` is **omitted**, not blanked — an empty string a client renders is still a leak. Present ⇒ **S1**. |
| TI4 | §12 | `viewer` attempts every write verb: patch, outputs add/deliver/accept, card add, run, score, guidance add, activate, schedule | Every one refused. Enumerate them all; one permitted write is **S1**. |
| TI5 | **XFAIL(M3)** | Instance owner/admin who is **not** a project member reads contacts | Per §12 they may see addresses. With M3 open they cannot. Low severity — the failure direction is safe. |
| TI6 ⌗ | §12 | Same actor + verb through CLI and API, compared | Identical answers. The CLI must go through the same gate, not around it. |
| TI7 ⌗ | §11 | A project in profile X and one in profile Y | No response joins across profiles; cross-profile reads are bounded and principal-filtered. A row from the other profile is **S1**. |
| TI8 | **XFAIL(E1)** | Accept an output, activate a directive and activate a playbook revision as (a) a **sessionless** caller (no interactive subject — e.g. the API with no session), (b) the CLI **without** `--as-human`, (c) the CLI **with** `--as-human` | (a) and (b) refused 403, and the CLI error **names `--as-human`**; (c) permitted, with the verified subject riding the `by`/`scored_by` provenance. With E1 open there is no gate at all and the CLI patches it out unconditionally. Cite the harness at `hermes_cli/projects_cli.py:60-96`. Ungated ⇒ **S1**. |

### §TJ — To-do promotion and profile import (§10, §11)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TJ1 | **XFAIL(E2)** | Create a to-do in `$HOST_PROFILE`, then `card add <slug> "<title>" --from-todo <id>` | Card created, to-do linked, provenance recorded, visible from both sides. |
| TJ2 | **XFAIL(E2)** | Same with a to-do in a **different** profile (`from_todo.profile` set) | Either 422 refusing unsupported foreign-profile promotion, or a genuinely profile-aware, principal-filtered read. With E2 open the profile is recorded and ignored — the default store is read, so it resolves the *wrong* to-do or none. **Use a throwaway to-do you created.** |
| TJ3 | **XFAIL(E2)** | Force the stage transition to fail after card creation (e.g. promote into a board state that refuses it) | Full rollback: no card **and** no `project_links` row. With E2 open the card is deleted and the link row survives — prove the leftover row, then remove it in teardown and say so. |
| TJ4 | **XFAIL(L2)** | Inspect an already-imported profile's projects (do **not** run an import on the live box if it would move production data; say so if you skip) | Imported rows still satisfy the mandatory contract; slug collisions get a suffix and keep provenance. With L2 open, NULL goal / no outputs / no host profile can arrive. |
| TJ5 ⌗ | §11 | In one throwaway shell, set `HERMES_PROJECTS_DB=/tmp/uat/scratch-projects.db` and create a project | The root override is honoured and the live store is untouched (confirm by listing both). |
| TJ6 ⌗ | §11 | Copy the root store to `/tmp/uat`, `chown hermes`, and run the migration path twice against the copy | Idempotent — the second run is a no-op. **Never against the live store.** |

`HERMES_PROJECTS_DB` may be used **only** in TJ5 and TK5, and only pointing into
`/tmp/uat`. Never export it in a shell that then touches the live store.

### §TK — Record, events and summary (§8, §11)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TK1 | §8 | `retro <slug> <run_no> --write` (stdin) with `--propose playbook=…`, `--propose directive=…`, `--propose skill=…` | Retro stored; at most 3 proposals; **all land inactive**. |
| TK2 ⌗ | §8.2 | Inspect the proposals | A playbook revision needs lead/admin activation; a directive needs member activation; a skill proposal records project/run provenance and leaves the loop to `agent/background_review.py`. |
| TK3 | **XFAIL(E1)** | Activate a proposed directive as a sessionless caller, and via the CLI without `--as-human` | Both refused — activation is a human act (§8.2). |
| TK4 | §11 | `GET /{slug}/events`, then again with `since=<latest_event_id>` | The second call returns only what is new; the cursor never replays or skips. |
| TK5 | **XFAIL(E4)** | The same on a project with **>999 visible cards**, built in a `/tmp/uat` scratch store via `HERMES_PROJECTS_DB` (never in the live store) | Works. With E4 open the tail builds `IN (?,…)` from task ids and hits SQLite's variable limit. If you cannot build 1000 cards safely, mark `UNTESTED` and cite the code path — do not guess. |
| TK6 | §11 | `summarise <slug>` (stdin) | The rolling summary is stored and rendered where the design says. |
| TK7 ⌗ | §8 | `show <slug> --json` at the end of the run | The record holds the whole history — every run, score, retro, directive and accepted output — in one read. The test: **a reviewer given only this JSON can tell what happened.** Say whether that is true. |

### §TL — Score (§8.1)

| ID | Maps to | Steps | Expected |
| --- | --- | --- | --- |
| TL1 | §8.1 | `score <slug> <run_no> 4 --note "…" --as-human`; then `0` and `6`; then re-score the same run | 1–5 accepted; out-of-range refused; a score is editable and the edit is recorded. |
| TL2 ⌗ | §8.1 | Compare the human score with the run's own self-score | Both visible, side by side, never merged — the divergence is the learning signal. |
| TL3 | **XFAIL(E5)** | Score five runs, add ≥25 unscored runs, read the project score; then re-score an old run | The derived score averages the latest **five scored** runs, and re-scoring moves it. With E5 open only the latest 25 runs are scanned, so the scores vanish. |
| TL4 | **XFAIL(E1)** | `score` as a sessionless caller, and via the CLI without `--as-human` | Refused. With E1 open the CLI patches `_interactive_subject` unconditionally (`hermes_cli/projects_cli.py:60-96`) so the agent's own invocation counts as human. **S1** if ungated. |

### §TM — Regression sweep (run last, before teardown)

| ID | Steps | Expected |
| --- | --- | --- |
| TM1 ⌗ | `hermes --profile $HOST_PROFILE kanban`, `todo list`, `cron list`, `goal list` | Projects added rows and changed nothing about how these behave. Projects depends on them; none of them know about Projects. |
| TM2 ⌗ | `systemctl list-unit-files 'hermes-*.service' --state=enabled --no-legend \| awk '{print $1}'` plus `agent-home.service`; then `systemctl is-active` each | Every enabled long-running unit still `active/running` (the skill's closing rule). Report the count you observed rather than asserting a number — it has changed over time. |
| TM3 ⌗ | `git -C /opt/data/hermes-agent -c safe.directory=/opt/data/hermes-agent status --porcelain --untracked-files=no` | Empty. This run changed no deployed file. `__pycache__` is expected and gitignored. |
| TM4 | §2.4 teardown, then `projects list --json` and `cron list` | No `uat-` cron job remains; `/tmp/uat` removed; every remaining `uat-` project listed in the report with a reason. |

### §TZ — Honesty checks on your own run

| ID | Steps | Expected |
| --- | --- | --- |
| TZ1 | Re-read §3 and your result table | Every `FAIL (known: id)` has a matching `STILL-OPEN` merge-base check, and every `FIXED-ON-BOX` finding whose scenario failed is reclassified as a **regression**, not a known defect. |
| TZ2 | Count | executed + BLOCKED + UNTESTED = **86**; PASS + FAIL(known) + FAIL(NEW) = executed. If they do not add up, find what you skipped. |
| TZ3 | Grep your own report | No token, password, DSN or long random string survived. `sed -E 's/[A-Za-z0-9_-]{30,}/***REDACTED***/g'` over the report as a final pass. |
| TZ4 | For each `PASS` on a UI scenario | You have a screenshot or recording frame for it. If not, it is `UNTESTED`. |

---

## 6. Report template

Write to `docs/testing/results/<yyyy-mm-dd>-projects-uat-run.md`:

```markdown
# Projects UAT — run <yyyy-mm-dd>

Instance: i-j6c81aisv2dd8mg17yle (hermes-systest, cn-hongkong)
Deployed sha: <TA2>          agent-home BUILD_ID: <TA6 timestamp>
Access: alibaba-cloud OOS_RunCommand (no SSH)      UAT_TAG: <UAT-yyyymmdd>
Host profile used: <x>       Dashboard process profile: <y>
Surfaces exercised: CLI ☐  API ☐  agent-home browser ☐   (unchecked ⇒ why)
Findings FIXED-ON-BOX at this sha: <ids>     STILL-OPEN: <ids>

## Verdict
<Two sentences: is the deployed Projects feature usable for its purpose, and
what is the single thing most in the way.>

## Result table
| ID | Result | Finding | Severity | Evidence |
|------|--------|---------|----------|----------|
| TA1  | PASS   |         |          | hostname=hermes-systest |
…
Result ∈ PASS / FAIL (known: id) / FAIL (NEW) / BLOCKED / UNTESTED
Counts: executed <n> · PASS <n> · FAIL-known <n> · FAIL-new <n> · BLOCKED <n> · UNTESTED <n> (= 86)

## New findings
### N1 — <title>   [S1|S2|S3|S4]
Repro: <verbatim commands / click path>
Observed: <quoted>     Expected: <FG-32 §>
Evidence: <path / screenshot / recording timestamp>

## Known findings: confirmed / no longer reproducing
<per §3 id: confirmed (scenario) | NOW PASSES — what you observed>

## Not verifiable on this deployment
<scenario id → why: restart forbidden, no second principal, no browser path,
no stable signing secret, could not reach 1000 cards, …>

## Artefacts left on the box
<slug / cron job / to-do / file → why it remains and how to remove it>

## Suite defects
<Anything in projects-uat.md that was wrong, ambiguous or unrunnable, with the
correction. The next run should not rediscover it.>
```
