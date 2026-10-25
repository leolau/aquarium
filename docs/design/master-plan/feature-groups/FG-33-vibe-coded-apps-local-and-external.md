# FG-33 — Vibe-coded apps: local and external

**Wave:** P8 (Phase 8; phases P8-0 → P8-4 below; needs FG-07, FG-08, FG-11, FG-12, FG-13, FG-14, FG-20, FG-31 and FG-32 merged, all of which are) · **Owner agent:** _unassigned_ (design: devin:workflow) · **Status:** PLAN — not started. Twenty-one open decisions are listed for Leo/Yan in §Open decisions; Yan answered 1, 10, 13 and 15 on 2026-10-25 (§Decisions recorded), the rest are still open; every phase is written so it can start once the decisions it names are answered.

## Summary

Let users **vibe code apps inside Aquarium** by talking to the agent, in two
hosting modes, each with its own icon on the agent-home **Tools** page.

**Origin — Yan, 2026-10-25 (verbatim):**

> "I want to allows users to vibe code within Aquarium but with two different
> approaches:
> 1) local app. In this case, the agent will always build with separate next.js
> and use a separate supabase database. Each local app runs on its own nodes.js
> and have its own supabase database instance. And each local app will have its
> own icon inside Tools page;
> 2) external aop. In this case, the agent will use external infrastructure such
> as Vercel, Railway, AWS, Alibaba Cloud and supabase.com to host the solution.
> But it will still have an icon inside the Tools page but it will look
> different from the local app;
> Please create a plan first."

- **Local app.** A Next.js app in its own Node process on this box (D3), with
  its own database (dev and prod copies) — under the recommended B2 topology
  that is its own **Postgres database** in a shared apps cluster, with Supabase
  Auth/REST/Storage **per-app opt-in** rather than a full Supabase instance per
  app (pending open decisions 1 and 2) — served on its own origin behind
  agent-home login. It shows as a solid tile with its own icon under
  "On this box".
- **External app.** The same template deployed to a provider (Vercel first,
  then Railway, AWS Amplify and Alibaba Cloud Function Compute), with its
  database on supabase.com. It shows as an outlined tile with a provider badge
  and a ↗ mark under "Hosted elsewhere".
- **The agent builds both the same way.** The user asks in chat. The agent
  opens an FG-32 Project, scaffolds with an extended `hermes tool new`, and
  writes code through kanban workers using its own file and terminal tools.
  The user previews in agent-home and promotes dev→prod through the existing
  C6-gated `hermes tool promote`.
- **Nothing parallel is invented.** It reuses the FG-07 tool registry and
  scaffolder, the FG-11 `mcp_endpoints` registry, C3 dev/prod, C5 change log,
  C6 approvals, C7 Core guard, C8 traces and cost, FG-31 capacity, FG-32
  Projects, the credential store and the existing root-helper and
  systemd-template patterns. No new core model tool (footprint rung 2: CLI +
  skill, plus one MCP endpoint per app).

This plan merges sixteen research sections (inventory, agent workflow, app
template, local runtime, local database, MCP access, Tools-page UX, external
hosting, five provider deep dives, security, quotas, operations). Where those
sections disagreed, the choice below follows what the code supports today and
the disagreement is listed as an open decision.

## Decisions recorded (Yan, 2026-10-25)

Yan's answers to the first four open decisions (verbatim in the audit log):

1. **Decision 1: its own Supabase *database*, not its own Supabase instance.** Option A (a full stack per app) is out. Each local app gets its own database per mode. The design is B2: a dedicated apps cluster on the same pinned Supabase Postgres image, with one database per app per mode. B (databases inside the existing `supabase-db`) is the fallback if Leo wants no new container. §3.4.
2. **Decision 10: default accounts plus bring-your-own.** Aquarium has one owner-managed **default** account for each of Vercel, Railway, AWS and Alibaba Cloud, plus a default supabase.com org, because every external app's database is on supabase.com (§4). For each external tool, its author picks **default** or **own** account, separately for hosting and for the database. "Own" uses the author's own credential row of the same kind. Leo has to do the signup, billing and token creation for the default accounts himself (P8-3.7 / P8-4.0 ops); the agent cannot create them. §4.2.
3. **Decision 13: a spending cap per project and another per account.** Each external app (= one project; linked to its FG-32 project when there is one) has a monthly cap, and each connected provider account, default or own, has a monthly cap too. Both are enforced by Aquarium. Where the provider offers a hard limit it is also set on the provider. §4.7.
4. **Decision 15: two coder profiles.** New Hermes profiles `internal-coder` (local apps) and `external-coder` (external apps) are the default kanban assignees for an app's build cards. Each tool can override the default with its own `coder_profile`. §10.

## Decisions applied

- **D1 / C1 / C2** — every app row carries `owner_user_id` + `visibility`; private apps are invisible cross-user; the owner sees all; the *requesting* principal (not the enrolled owner) authors the row.
- **D3** — in-house = Next.js, one Node process per tool, web UI + MCP. Local apps follow it with one stated extension: each app runs **two** instances of the same unit template, dev and prod (D5), and the dev instance is idle-stopped (§3.3), so it is one Node process per app **per mode**. D3 does not address dev/prod; proposed **D21** records this. External apps keep the same code and change only where it runs, which D3 does not cover yet, so this plan proposes **D21** (open decision 20).
- **D4** — self-hosted Supabase/Postgres stays the datastore for Aquarium-hosted data, including local apps (whose data never goes into Aquarium's `app_dev`/`app_prod`). External apps put their data on provider-hosted Supabase (supabase.com, §4), which D4 does not cover; proposed **D21** (open decision 20) explicitly scopes D4 to Aquarium-hosted data, pending Leo/Yan.
- **D5 / C3 / FG-13** — every app has dev and prod (database, process or provider target). Promotion moves code and schema migrations, never data. Channels stay prod-only.
- **D10 / C7 / FG-14** — app source under `$HERMES_HOME/tools/<slug>` is Customizable. The templates, root helpers, units, hosting adapters and quota policy are Core.
- **D16 / D20** — all UI is in `agent-home/`. No privileged key reaches a browser.
- **C5 / C6 / C8** — every lifecycle act is a C5 change. Publishing, prod migrations, paid resources, deletes and spend-cap raises need C6 approval. Every provider call and every cost is a C8 row.
- **FG-31** — owns the box-level "too many apps" verdict.
- **FG-32** — a build is a Project run, and the app is a `code` output of that project.
- **AGENTS.md principles** — prompt-cache safety (new app MCP tools reach the agent only in the next chat), footprint ladder (no new core tool), no new non-secret `HERMES_*` env vars, behaviour/invariant tests.

## Reuse map

| anchor | what it already provides | what FG-33 changes |
|---|---|---|
| `hermes_cli/tools_registry.py` | `tools` table per mode (`kind IN ('in_house','remote','builtin')`, `owner_user_id`, `visibility`, `status`, `mcp_endpoint_ref`, `web_url`, `config_json`), C2 scoping + FORCE RLS, `validate_tool_config` (no `HERMES_*`), C6-gated `promote_tool` (writes `approvals` + `changes` + `promotions`; lands disabled) | additive columns, `kind='external'`, reserved names, `promote_tool` runs a per-hosting promotion plan and round-trips every column |
| `hermes_cli/tool_scaffold.py` + `hermes_cli/tool_cmd.py::_cmd_new` | writes a Next.js 15.1.6 app + stdio `mcp/server.mjs` (one `ping`) + `tool.config.json` into `$HERMES_HOME/tools/<name>`; port = hash into 4300–4699 (`resolve_port`); registers endpoint + disabled row; `_record_provenance` (C5) | templates move to files under `hermes_cli/app_templates/`, pinned to agent-home's versions, `git init`, HTTP MCP in-app, helper-allocated ports |
| `skills/software-development/create-in-house-tool/SKILL.md` | the agent's route into the scaffolder | new sibling skill `vibe-code-app` drives the whole flow |
| `hermes_cli/mcp_endpoints.py` | `mcp_endpoints` (`kind ∈ {in_house, remote}`, transports `stdio`/`http`), `resolve_server_configs()` | wired into chat start for the first time; transport auth fixed; `enabled`, `app_kind`, `secret_ref`, `forward_principal` columns |
| `tools/personal_mcp.py` (`choose_for_session`, `apply_to_agent`) | the cache-safe "pin a chat's MCP set in `sessions.model_config`" pattern; fail-soft connect | copied for registry endpoints |
| `app-mcp/` (`mcp_auth.py`, `ticket.py`, `guard.py`, `server.py::_caller`) | loopback Streamable-HTTP MCP with bearer token + forwarded principal; HMAC ticket pattern; `app_act` verb guard | per-app bearer/principal pattern; ticket pattern reused for forward_auth and for the requester ticket; guard gains deny markers |
| `deploy/hermes-wa-bridge@.service` + `deploy/hermes-wa-bridge-add` + `deploy/sudoers.d/hermes-wa-bridge` | one systemd instance per thing, a root helper with one validated argument, free-port picking | template for `aquarium-app@.service` + `aquarium-app-helper` |
| `deploy/hermes-vpn-helper` | stdlib root helper that validates an untrusted JSON spec | shape of `aquarium-app-helper` |
| `deploy/hermes-embed.service` (resource caps: `MemoryMax=3G`, `CPUQuota=300%`, `Nice=10`); `agent-home/deploy/agent-home.service` (hardening example only — it sets no resource caps) | caps and hardening; secrets in `/etc/aquarium/*.env` root 0600 | copied into the app units |
| `deploy/hermes-tools-setup`, `hermes-tools-exec`, `hermes-tools-cli`, `hermes-tools-shim` | agent terminal as uid `hermes-tools`, `tools/` group-rw, an allowlist of `hermes` subcommands (`tool new` allows only `--shared`) | new enum-validated flags and subcommands |
| `deploy/aquarium.py` (`make_backup`, restore, `CREATE DATABASE` for scratch restores) | root-run backup/restore; dumps only `-d postgres` today | `apps db` verbs; per-app databases in the backup manifest |
| `hermes_cli/db_migrate.py`, `hermes_cli/access.py` | least-privilege LOGIN/NOBYPASSRLS roles (`hermes_app`, `agent_home_app`); DDL runs as root at deploy | the per-app role recipe |
| `hermes_cli/credential_store.py` | `CREDENTIAL_KINDS` / `KindSpec(materialize=False)` secrets that never reach agent terminals; per-principal, redacted on read | hosting credential kinds |
| `hermes_cli/oss_acquisition.py::HostRunner` (Protocol; implementation `hermes_cli/oss_host.py::SSHHostRunner`), `oss_provenance.py` | FG-08 off-box host protocol + provenance (`host`, `commit_sha`) | shape reused for `HostingAdapter`; provenance records provider + SHA |
| `hermes_cli/human_comms.py::NotificationStore`, `hermes_cli/consent.py::evaluate_approval` | durable C6 approvals (`reversible=False` is never auto-approved), proactive asks with dedupe | all FG-33 gates and alerts |
| `hermes_cli/capacity.py` (FG-31) | memory/CPU/disk/session headroom verdict | adds apps-slice and app-disk bounds |
| `hermes_cli/projects_db.py`, `projects_run.py`, `hermes_cli/kanban.py` (FG-32) | projects, runs, `project_links`, `project_outputs.kind='code'`, deliveries `link_kind='url'`, `toolsets` filter, budget approval, kanban `--workspace dir:` | the build workflow; no new table for the link |
| `scripts/deploy_state.py` (`DEFAULT_UNIT_GLOBS = ("hermes-*", "agent-home*")`), `scripts/check_runtime_drift.py` | drift capture and Telegram operator alerts | app template unit added to the globs; `app doctor` reconciliation |
| agent-home `app/tools/page.tsx`, `components/tools/ToolsRegistry.tsx`, `useProjectAction`/`ActionButton`, `components/projects/rawFetchGuard.test.ts`, `/api/files/[id]/content`, `lib/auth/route-roles.json` | the read-only Tools list, the idempotent mutation pattern, sandboxed file serving, BFF role table | the icon grid and the actions sheet |
| `docs/design/coral-app-framework.md` §5 | reserved `AppManifest.kind: "webview"` and `category: "custom"` launcher entries | later phase reads `tools` rows instead of a parallel `internal_apps` table |

## Design

### 0. What exists today and what is missing

Verified on `develop`:

- **Scaffold, no runtime.** `hermes tool new` writes the app and registers it,
  but nothing installs, builds, starts or supervises it. The README tells a
  human to run `npm run dev`. `deploy/` has no unit for tools.
- **Ports collide.** `resolve_port` hashes the name into 400 ports with no
  collision check, so 20 apps have a ~38% chance of a clash. `web_url` is
  `http://127.0.0.1:<port>`, which no phone can open.
- **Stale pins.** The scaffold pins `next 15.1.6`/`react 19.0.0`; agent-home
  pins `next 15.5.20`. 15.1.6 predates the middleware auth-bypass fix
  (CVE-2025-29927, fixed in 15.2.3).
- **App MCPs never reach a chat.** `mcp_endpoints.resolve_server_configs()` has
  no caller on the session start path (`tools/`, `agent/`, `gateway/`,
  `run_agent.py`, `hermes_cli/mcp_startup.py`); the live client reads only
  `config.yaml` `mcp_servers`. The `http` transport stores `auth: str`, but
  `tools/mcp_tool.py` reads `config["auth"]` as the auth *type* (`oauth`), and
  rows cannot carry headers or an `enabled` flag.
- **The stdio MCP runs as the gateway uid.** The gateway spawns `node
  mcp/server.mjs` as `hermes`. `_build_safe_env` filters the environment, but
  agent-written JS could still read `$HERMES_HOME/.env` and `/proc/*/environ`.
- **Authorship is the owner's.** Through `hermes-tools-cli` (`--as` refused),
  `tool_cmd._resolve_operator` falls back to the enrolled owner. The dashboard's
  `_resolve_tool_operator` does the same.
- **The Core guard has holes this feature would widen.** `agent/core_boundary.py`
  guards only `tools/file_operations.py` writes and says the raw terminal is not
  covered. `core_manifest.yaml` does not list `agent-home/**`, `app-mcp/**` or
  `deploy/**`, although D16 calls agent-home Core. The repo cannot show
  whether prod sets `terminal.run_as: hermes-tools` (default `""` in
  `hermes_cli/config.py`).
- **Secrets.** `tools/environments/local.py` strips `POSTGRES_PASSWORD`,
  `HERMES_DB_ADMIN_URL` and the JWT secrets from agent shells, but not
  `DATABASE_URL`. It deliberately lets the AWS SDK chain through.
  `optional-skills/devops/supabase-cli` passes the account-wide
  `SUPABASE_ACCESS_TOKEN` into agent terminals via `tools/env_passthrough.py`.
- **The approval guard does not know the new verbs.** `app-mcp/app_mcp/guard.py`
  already makes consent controls user-only for both `app_act` and
  `app_act_destructive`: `CONSENT_WORDS` covers approve/approval/re-approve/
  allow/deny/grant/authorize/trust/consent/acknowledge, and a page can mark a
  region with `data-appmcp-deny` (snapshot `denied: true`, `is_user_only`,
  security review F17/F18). But "deploy", "make live", "redeploy" and "unlink"
  are in no list, so `app_act` could press a new "Make live" or "Redeploy"
  button; and "publish"/"delete" are only in `DESTRUCTIVE_WORDS`, which
  `app_act_destructive` (behind tool approval) can still press.
- **Backups miss per-app databases.** `deploy/aquarium.py::make_backup` dumps
  only `-d postgres` plus globals; a second database or a second stack would go
  unbacked-up.
- **Deploy restart set.** `deploy/hermes-deploy.sh` restarts every *enabled*
  `hermes-*.service` (plus `app-mcp`, and `agent-home` on change). A unit named
  `hermes-app@…` would be restarted on every Core deploy, so app units must not
  use that prefix.
- **Placement trap.** The root `package.json` `workspaces` includes `apps/*` and
  the deploy runs `npm ci` at the repo root; and the checkout is root-owned
  (F13). App code must never live in the repo's `apps/`.
- **Tools page.** Server-rendered, read-only text rows (`ToolRow`: name, On/Off
  `Pill`, `KIND_LABEL`), no icon, link, health, actions, tests or i18n. Registry
  writes (`PUT …/enabled|config`, `POST …/promote`) are `_TOOLS_MANAGER` (admin)
  and have no BFF route.
- **Nothing deploys to a provider.** `optional-mcps/vercel` and
  `optional-mcps/railway` let chat *inspect* those accounts, and `skills/software-development/railway-cli` uses an account
  token. There is no Supabase/hosting credential kind and no adapter.
- **qoder / opencode-web** on the box are hand-installed and not in `deploy/`.
  Nothing in the repo references qoder. `skills/autonomous-ai-agents/opencode`
  drives the OpenCode CLI.

### 1. The user flow (request → running app)

1. **Intake.** The user says "build me an app that…" in `/chat`, or taps
   "Build a local app" / "Build a hosted app" on `/tools`, which opens a chat
   with a starter prompt. The new skill
   `skills/software-development/vibe-code-app/SKILL.md` has the agent:
   - propose a Project (`hermes projects create`, declared output "running
     app v1", kind `code`); the human confirms (FG-32 rule 2);
   - ask **one** `clarify` question for the hosting mode, with **Local**
     pre-selected unless the user mentions a public URL, custom domain, heavy
     traffic or a named provider (open decision 16);
   - for External, pick the provider (default Vercel + supabase.com).

   The choices go into the registry row, so later chats read them instead of
   asking again.
2. **Admission.** `hermes_cli/app_quota.py::check_admission(principal,
   'create')` returns `ok | needs_approval | refused(reason)` (§6).
3. **Scaffold.** `hermes tool new <slug> --template nextjs-supabase --hosting
   local|external [--provider vercel|railway|aws_amplify|alibaba_fc]` (§2). It writes the
   tree into `$HERMES_HOME/tools/<slug>`, runs `git init` (branches `main` +
   `dev`), registers a disabled `app_dev.tools` row and an `mcp_endpoints` row,
   and for local apps asks the root helper to provision the dev database and
   allocate a port.
4. **Build loop.** The chat session is the orchestrator. Each slice of work is
   a **kanban card** on the project's board with `--workspace
   dir:$HERMES_HOME/tools/<slug>`, run by a dispatcher-spawned Hermes worker
   assigned to the app's **coder profile** (`internal-coder` for local, `external-coder` for
   external, or the tool's `coder_profile` override, §10), using **its own** terminal and file tools. Why kanban: it survives a gateway
   restart (`delegate_task` does not), shows on `/projects/[slug]`, logs to
   `kanban/logs/<task>.log`, and runs as `hermes-tools` inside the path C7/C2
   already cover. One-line tweaks may be done inline (FG-32 `mode:'inline'`).
   OpenCode stays an opt-in through its skill, only when the user asks, because
   its writes bypass `tools/file_operations.py` and its model spend is outside
   C8. The box's `opencode-web`/`qoder-*` services are not wired into the agent
   (later an "open in editor" link for humans). **Each card's definition of
   done:** `npm ci && npm run check` (tsc, eslint, vitest, `npm audit`, `next
   build`), an MCP `initialize → tools/list → tools/call` handshake against the
   dev instance (the same check as `tests/hermes_cli/test_fg07_tool_scaffold.py`),
   and a `browser_navigate` screenshot of the dev URL attached to the card.
   Every card ends in a commit on `dev`.
5. **Preview and feedback.** `hermes tool build <slug> --mode dev` produces a
   release from the `dev` HEAD and (local) starts the dev instance, or
   (external) creates a provider preview deployment. The user opens the dev
   tile (or `/tools/[name]`), and typed feedback lands as a card comment
   (`task_comments`) when a card is running, otherwise as an FG-32
   `project_directives(kind='feedback')`. Nothing is injected into a running
   prompt.
6. **Promote.** `hermes tool promote <slug>` stays the single verb.
   `promote_tool` keeps the C6 approval and then runs a hosting-specific plan
   (§3.7 local, §4.5 external). Prod lands disabled until the user turns it on,
   as today. Tag `vN` on `main`.
7. **Use.** The tile opens the app. The agent gets the app's MCP tools in the
   **next** chat where the app is attached (§5).
8. **Change later.** "Change X in my app" from any chat triggers the skill: it
   reads the registry row and the project's guidance, last retro and score
   (FG-32 rule 5), opens a new run with cards on `dev`, gets preview sign-off,
   then promotes.

### 2. The app template (both modes)

- **Files, not strings.** Move the scaffold templates from inline Python
  strings into `hermes_cli/app_templates/{minimal,nextjs-supabase}/`, rendered
  with `{{name}}`/`{{port}}` substitution only, and ship them through
  `[tool.setuptools.package-data]` in `pyproject.toml`. `minimal` must render
  byte-identical output so today's FG-07 tests and the `create-in-house-tool`
  skill keep passing.
- **One CLI, enum flags.** `scaffold_in_house_tool(name, root, *,
  template="minimal", hosting="local", provider=None)`;
  `hermes tool new <name> --template nextjs-supabase --hosting local|external
  [--provider vercel|railway|aws_amplify|alibaba_fc]`. The flags are added to
  `deploy/hermes-tools-cli` as enum choices, never paths. A separate `hermes app
  …` command was rejected (two registry paths, two allowlist entries).
- **Pins follow agent-home's resolved versions.** `agent-home/package.json`
  pins `next` (15.5.20) but gives `react` only as a range (`^19.2.4`), so it is
  not a pin source. The scaffold writes the exact versions **resolved in the
  root `package-lock.json`** for the agent-home workspace (today `next`
  15.5.20, `react`/`react-dom` 19.2.7, hoisted under `node_modules/`), and a
  test asserts exact equality with the lockfile. `@supabase/supabase-js`, `@supabase/ssr`, `pg` are pinned. A
  committed `package-lock.json`, `"engines": {"node": ">=22 <23"}`, `.nvmrc`.
- **The app code is the same for both modes.** `hosting` only changes the
  `deploy/` files, `next.config` `output`, and where env values come from.

| Path (`nextjs-supabase`) | Purpose |
|---|---|
| `package.json`, `package-lock.json` | scripts `dev`/`build`/`start`/`test`/`check` (`check` = tsc + eslint + vitest + `npm audit` + `next build`) |
| `next.config.mjs` | `output: 'standalone'` (local and container hosts); default on Vercel |
| `lib/db.ts` | server-only `pg` Pool from `DATABASE_URL` that reconnects (survives a `supabase-db` restart); works under every database option |
| `lib/supabase/{server,client}.ts`, `middleware.ts` | `@supabase/ssr` cookie clients; active only when `NEXT_PUBLIC_SUPABASE_URL` is set |
| `lib/auth.ts` | one `getUser()` seam, mode from the manifest: `aquarium` (principal header injected by the forward_auth front door, §3.5), `supabase` (GoTrue session), `none` |
| `supabase/migrations/<ts>_init.sql`, `supabase/config.toml` | Supabase CLI layout from day one, so a local app can later move to supabase.com unchanged; forward-only |
| `app/api/health/route.ts` | `{ok, name, version, hosting, mode, db: ok\|error\|none, migration}`, `force-dynamic`, 1 s `select 1`, no secrets |
| `app/api/mcp/route.ts` | Streamable-HTTP MCP inside the app's own Node process (§5), bearer-checked; replaces the gateway-spawned stdio `mcp/server.mjs` |
| `app/icon.png` | Next.js metadata icon, generated from initials + a name-hashed palette hue; the agent may replace it; snapshotted to Storage at registration (§7) |
| `tests/health.test.ts`, `tests/mcp.test.mjs` | vitest + a `node:test` MCP handshake mirroring the Python FG-07 test |
| `.env.example`, `.gitignore`, `AGENTS.md` | names only; `.env*`/`.next`/`node_modules` ignored; app rules (`data-component` on roots, forward-only migrations, never edit `.env`) |
| `deploy/local/unit.json` or `deploy/external/{vercel.json,railway.json,Dockerfile}` | inputs the root helper / hosting adapter read; limits are validated against policy, never trusted |

**Manifest.** `tool.config.json` stays the one manifest, non-secret keys only,
so `validate_tool_config` still applies: `name, stack, template_version,
hosting, provider, health_path, icon, auth, db.migrations, mcp.transport,
env[]` (names). `_cmd_new` copies it into the row's `config_json.app`.

**Env contract** (no `HERMES_*` names; `.env` = secrets only):

| Var | Local source | External source |
|---|---|---|
| `DATABASE_URL` | per-app role DSN, delivered by systemd `LoadCredential=` from `/etc/aquarium/apps/<slug>/` (root 0600); dev DSN also in `.env.local` so the agent can test against disposable dev data | provider env, set to the supabase.com **Supavisor pooler** URL (`*.pooler.supabase.com:6543`; the direct host is IPv6-only) |
| `NEXT_PUBLIC_SUPABASE_URL`, `…_PUBLISHABLE_KEY` | only if the app opted into per-app Supabase APIs (§3.4) | supabase.com project settings |
| `SUPABASE_SECRET_KEY` | same, server-only | provider env, server-only; adapters refuse `NEXT_PUBLIC_*` for secret values |
| `APP_MCP_TOKEN` | per-app bearer via `LoadCredential=` | `materialize=False` credential, copied to provider env |
| `PORT`, `APP_MODE`, `APP_PUBLIC_URL` | helper-written | provider |

Provider deploy tokens never go into an app's env.

**Core.** `hermes_cli/app_templates/**` and `hermes_cli/tool_scaffold.py` join
`core_manifest.yaml`, so the runtime agent cannot change what every future app
inherits. Each app's own copy stays Customizable. Template upgrades for existing
apps are an opt-in, C5-tracked `template_version` diff in the last phase.

### 3. Local apps

#### 3.1 Layout

```
$HERMES_HOME/tools/<slug>/          # source, git repo, edited by the agent as hermes-tools (Customizable)
/var/lib/aquarium-apps/<slug>/      # root-owned, read-only to the runtime uid
  releases/<sha>/                   # .next/standalone + public + .next/static
  dev  -> releases/<sha>
  prod -> releases/<sha>            # moved only by promote
  cache/<mode>/                     # writable .next/cache
/etc/aquarium/apps/<slug>/          # root 0600: <mode>.env (PORT…), credentials (DSN, APP_MCP_TOKEN, user secrets)
```

The source stays where `hermes tool new` already writes it (`hermes-tools`
group-rw per `deploy/hermes-tools-setup`), never the repo's `apps/` workspace.
A running app executes a **built artifact** the agent cannot write, so no agent
edit reaches a running prod app without a recorded build.

#### 3.2 Build

`hermes tool build <slug> --mode dev` → `sudo aquarium-app-helper build
<spec>`. The helper `git archive`s the SHA into a temp dir and runs `npm ci
--ignore-scripts && next build` under `systemd-run
--slice=aquarium-build.slice -p MemoryMax=2G -p CPUQuota=200% -p Nice=15` as a
throwaway `DynamicUser`, with egress only to `registry.npmjs.org`. A `flock`
gives **one shared build/live-edit slot box-wide** (`next build` peaks at an
estimated 1–2 GB); the `next dev` live-edit session (§3.3) takes the same lock
in the same slice, so a build and a live-edit never run at once.
Supply-chain gate: a committed lockfile is required; `tools/osv_check.py` runs
over the whole lockfile in a **fail-closed** mode (it is fail-open for
`npx`/`uvx` today); dependency-count and size ceilings; new direct dependencies
appear as a lockfile diff in the C6 promote approval. Logs go to the journal;
`hermes tool logs` returns a capped tail.

#### 3.3 Process: one templated unit per instance

`deploy/aquarium-app@.service`, instance `<slug>-<mode>`. The prefix is
deliberately **not** `hermes-*`, so `hermes-deploy.sh` and `aquarium update`
never restart user apps (pinned by a regression test).

```
[Service]
DynamicUser=yes
EnvironmentFile=/etc/aquarium/apps/%i.env          # PORT, HOSTNAME=127.0.0.1, APP_MODE
LoadCredential=db:/etc/aquarium/apps/…             # DSN, APP_MCP_TOKEN, user secrets
WorkingDirectory=/var/lib/aquarium-apps/<slug>/<mode>
ExecStart=/usr/bin/node server.js
Environment=NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
Slice=aquarium-apps.slice
MemoryHigh=384M MemoryMax=512M CPUQuota=50% CPUWeight=20 TasksMax=128 Nice=10
ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes NoNewPrivileges=yes
InaccessiblePaths=/opt/data/hermes-home-staging /opt/data/hermes-agent /etc/aquarium /var/run/docker.sock /root
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6  SystemCallFilter=@system-service  UMask=0077
Restart=on-failure RestartSec=5 StartLimitBurst=5
```

- **One hard FG-33 memory ceiling.** systemd nests slices by name, so
  `aquarium-apps.slice`, `aquarium-build.slice` and `aquarium-db.slice` are
  children of a parent `aquarium.slice` with `MemoryMax=6G` (`MemoryHigh=5.5G`).
  The kernel enforces the 6 GB total whatever the children do:
  - `aquarium-apps.slice`: `MemoryMax=3G`, `CPUQuota=200%`, `CPUWeight=20` —
    running app instances;
  - `aquarium-build.slice`: `MemoryMax=2G` — the one shared build/live-edit
    slot, serialised by one `flock`;
  - `aquarium-db.slice`: `MemoryMax=1G` — the apps compose project (apps
    Postgres cluster + opt-in sidecars), attached with compose `cgroup_parent:
    aquarium-db.slice` (needs dockerd's systemd cgroup driver; P8-0 row 0.7
    verifies it on the box).

  3 + 2 + 1 = 6 GB of the ~9 GB available, leaving **≥ 3 GB reserved** for
  FG-31 conversation growth, the gateway, `hermes-embed` (its own 3 GB cap) and
  the shared Supabase stack. A runaway app cannot starve any of them.
- **Per-app uid via `DynamicUser`** (open decision 5). The alternatives — all
  apps as `hermes-tools`, or one shared `aquarium-app` user — let one app read
  another's files and env.
- **Egress** (P8-2): one nftables table owned by the helper matches `socket
  cgroupv2 "aquarium-apps.slice/…"`. Loopback is deny-by-default except the DB
  pooler port and the app's own listener (127.0.0.1 hosts every control plane:
  dashboard 9119, app-mcp 9220/9221, embed 8791, Kong 8000, pooler 6543).
  Internet egress is deny-by-default; per-app host allowlists are C6-approved.
  `IPAddressDeny=` alone cannot do this because it filters by IP, not port.
  P8-1 ships with `IPAddressDeny=any IPAddressAllow=localhost` as the interim.
- **Ports**: the helper allocates with the `hermes-wa-bridge-add` algorithm —
  prod 4300–4499, dev 4500–4699 — clear of 3000+ (WhatsApp bridges), 3100, 8791,
  9119, 9221. The box (unit env files) is the source of truth; the registry
  mirrors it. `resolve_port` is deprecated.
- **Dev vs prod**: the dev instance runs the latest dev release, is started on
  demand and idle-stopped after 20–30 min (socket activation via
  `systemd-socket-proxyd --exit-idle-time`, systemd 255 on Noble; cold start ~1–3 s,
  unmeasured). At most **one** `next dev` live-edit session box-wide; it runs in the
  shared build/live-edit slot (`aquarium-build.slice`, same `flock`, 15-min
  lifetime), never alongside a build. Prod is always-on by default; an owner-only
  `always_on=false` lets prod sleep too (open decision 7).

#### 3.4 Database — its own Supabase database (decision 1: database, not instance)

Yan's words leave a real choice. Costs on probe-cx43-nbg1 (~9 GB RAM available,
44 GB disk free at 70% used). RAM figures are **estimates of idle RSS for the
pinned images** (`deploy/install/supabase-images.lock`) and must be measured
with `docker stats` in P8-0 before anything is committed. Each option is ×2
per app (dev + prod, D5).

| Option | Isolation | Extra RAM per app (dev+prod) | Capacity on this box | Supabase features | End-user auth |
|---|---|---|---|---|---|
| **A** Full Supabase docker stack per app and mode (~11–12 containers each) | strongest: own cluster, roles, JWT secret, WAL | ~1.1–1.9 GB per stack → **~2.2–3.8 GB per app** (trimmed: ~0.6–1.0 GB per stack) | **2–3 apps** | all | own GoTrue |
| **B** Database per app per mode inside the existing `supabase-db` + a NOBYPASSRLS login role | separate catalog; roles, WAL, connections, disk shared with Aquarium | tens of MB | RAM: not the limit; **disk-bound: ~5–6 apps** at §6 defaults (same as B2) | Postgres only via shared stack; the shared PostgREST/GoTrue serve `postgres` only | Aquarium identity via forward_auth |
| **B2** One dedicated **apps cluster** (`supabase-apps-db`, same pinned postgres digest, own volume and superuser, docker-network only) holding a database per app per mode; per-app GoTrue + PostgREST sidecars **opt-in** | separate catalog; app roles never coexist with `supabase_admin`/`hermes_app`; a bad `DROP DATABASE` cannot reach `postgres`; own `max_connections` | ~250–400 MB once; +~0.1–0.2 GB per app only if sidecars are on (+80–150 MB/mode for Storage), all inside the capped apps compose project (§6) | **disk-bound: ~5–6 apps** at §6 defaults (RAM-bound: ~10); see §6 admission number | Postgres always; Auth + REST opt-in; Storage opt-in; Realtime not offered until a spike | Aquarium identity by default; own GoTrue when opted in |
| **C** Schema + role per app in the shared `postgres` DB | weakest: shares `auth.users`, JWT secret, anon key, PostgREST | ~0 | many | REST only by editing `PGRST_DB_SCHEMAS` and restarting `rest` | app users become Aquarium accounts (conflicts with closed signup and FG-26 §3.5) |
| **D** Plain Postgres DB, no Supabase APIs | like B | ~0 | many | none | app-local library |

Capacity here uses the **one admission number** derived in §6
(min(RAM slice / `MemoryHigh`, disk headroom / per-app disk), an estimate until
P8-0 row 0.7 measures it): **~6 local apps** on this box as it is today, bound by
disk, not RAM. Growing past that needs more disk (open decision 21).

**Decision 1 (Yan): its own Supabase database, not its own instance → B2**, with Supabase APIs opt-in per app
(open decision 2) and **A** available only as a per-app upgrade on a resized or
second box. C is rejected as a default (one anon key and one `auth.users`
across Aquarium and every app undoes D16). B is acceptable if Leo prefers zero
new containers, at the cost of putting app roles and app load on Aquarium's own
cluster and giving the provisioner superuser-equivalent rights there. D drops
the "Supabase" Yan asked for and the migration layout that lets an app graduate
to supabase.com.

**Design under B2:**

- **Naming.** `lapp_<id>_<mode>`, `<id>` derived from the slug the way
  `datastore._profile_slug` derives identifiers, with a hash suffix. Roles per
  database: `…_owner` (owns the DB, runs migrations), `…_rw` (the app's runtime
  login, NOBYPASSRLS), `…_ro` (read-only, used by the MCP `data_query`), and,
  only with sidecars, `…_auth` and `…_authenticator`. Every role gets
  `CONNECTION LIMIT` (5–10) and `statement_timeout`; `REVOKE CONNECT … FROM
  PUBLIC` on every database.
- **Provisioner (Core, root-only).** `aquarium apps db
  {create,migrate,status,suspend,drop}` in `deploy/aquarium.py` (installed as
  `/usr/local/sbin/aquarium`, already the backup/restore helper), behind exact
  argv in `deploy/sudoers.d/aquarium-apps`. It validates the slug, and refuses
  any prod verb unless the referenced `approval_ref` exists and is approved in
  the app schema's `approvals` table (the rows `promote_tool` writes). The agent
  never holds CREATEDB/CREATEROLE. `create` makes the DB, roles and grants,
  bootstraps `pgcrypto`/`uuid-ossp`, writes the DSNs to
  `/etc/aquarium/apps/<slug>/` (root 0600), and (sidecars only) mints a per-app
  JWT secret and starts `aquarium-app-<id>-<mode>-{auth,rest}` containers with
  `mem_limit`. It never copies Aquarium's `SUPABASE_JWT_SECRET`,
  `POSTGRES_PASSWORD` or the `db-admin.env` DSN; a test asserts no app env file
  contains any value from Aquarium's Supabase `.env`.
- **Migrations.** The agent writes `supabase/migrations/*.sql`; the provisioner
  applies them as `…_owner` on every dev build, and to prod only inside
  `promote_tool`, after the approval, with a pre-migration `pg_dump` as
  `backup_ref` and a C5 `target_kind=code` change carrying the migration hashes.
- **Quotas.** Default 500 MB–1 GB per DB (decision 8). Postgres has no size
  quota, so a timer records `pg_database_size`; over quota the role goes
  read-only (`ALTER ROLE … SET default_transaction_read_only = on`) and the
  owner is notified; `suspend` sets `CONNECTION LIMIT 0`.
- **Backups.** `make_backup` loops over the `lapp_%` databases on the apps
  cluster (`db/apps/<slug>.dump`, manifest `db.apps[]`); restore and
  `restore-test` gain per-DB support so one app can be restored without touching
  Aquarium. A test asserts every `app_databases` row is in the latest manifest.
- **Upstream drift.** GoTrue/storage-api run their own migrations against a
  non-`postgres` DB with non-default role names; this is a P8-0 spike and a CI
  job re-runs it on every `SUPABASE_COMMIT` bump.

#### 3.5 Front door: own origin, behind agent-home login

| Option | Problems |
|---|---|
| Path `home.leolau.ai-and-i.io/apps/<slug>/` (Next `basePath`) | the app's JS runs on agent-home's origin and can call the BFF with the user's session cookie — a stored XSS on the main UI; `basePath` baked in at build |
| **Own origin per app** (recommended) | `<slug>.<apps-domain>` (prod), `<slug>--dev.<apps-domain>` (dev); needs a DNS record and per-host HTTP-01 certs (apt Caddy has no DNS plugin, so no wildcard cert) |

The hand-maintained `/etc/caddy/Caddyfile` gets **one** human-added line,
`import /etc/caddy/apps.d/*.caddy`. `aquarium-app-helper route|unroute` writes
one block per instance, runs `caddy validate`, and reloads. The helper refuses
to write a block without `forward_auth` to a new agent-home route
(`/api/apps/auth`) that checks the session and C2 `can_read` on the registry
row, then injects `X-Aquarium-Principal` (short-lived ticket, the
`app-mcp/app_mcp/ticket.py` pattern). An anonymous public URL is a separate,
C6-approved **publish** act. Which domain is open decision 4: a separate
registrable domain avoids being same-site with agent-home cookies; a subdomain
of `leolau.ai-and-i.io` is cheaper. The include file is added to
`backup_sources()` and to the drift check.

#### 3.6 Secrets per app

Users enter app secrets in an agent-home form, never in chat. The helper writes
them to `/etc/aquarium/apps/<slug>/` and the unit receives them with
`LoadCredential=` (`$CREDENTIALS_DIRECTORY`). The agent sees secret **names**
only (`tools.secret_names`). Prod values are unreadable by `hermes` and
`hermes-tools`; dev DB values may be readable so the agent can test.
`/etc/aquarium/apps/` joins the `hermes-secret-backup` bundle.

#### 3.7 Local promotion plan (inside `promote_tool`, after C6)

1. tag `vN` on `main` (fast-forward from `dev`);
2. `aquarium apps db migrate --mode prod --approval <ref>` (pg_dump first);
3. `aquarium-app-helper build` of that SHA if not already built, then point the
   `prod` symlink at it and restart `aquarium-app@<slug>-prod`;
4. copy the tools row, the linked `mcp_endpoints` row and its `secret_ref` to
   `app_prod` (today only `tools` columns are copied);
5. C5 change with `inverse_op` = previous SHA (one symlink flip; migrations are
   forward-only, so a schema rollback is a new migration), plus a `promotions`
   row. The FG-20 audit (ed.11) found the FG-12 undo engine refuses
   `promote_tool`'s JSON-Patch `inverse_op` with a 409, so the inverse shape must
   be one the engine accepts.

Prod lands **disabled** until the user enables it, unchanged.

#### 3.8 Root helper

`deploy/aquarium-app-helper` — stdlib-only Python in the `hermes-vpn-helper`
style: a validated JSON spec on stdin, verbs `allocate|build|start|stop|restart|
route|unroute|set-secret|logs|status|publish|unpublish|remove`. It is the
**only** component that writes units' env files, nft rules, Caddy includes and
`/etc/aquarium/apps`. It is called via sudo from `hermes` only (the Python API
and `hermes_cli/app_runtime.py`), never from `hermes-tools`. The agent reaches
it only through allowlisted `hermes tool …` verbs, which go through
`hermes-tools-cli` → `hermes` → API checks. Helper, units, slice and sudoers are
Core.

### 4. External apps

#### 4.1 Adapter layer

A new Core package `hermes_cli/hosting/` holds `base.py` (protocol + `PROVIDERS`
registry mirroring `CREDENTIAL_KINDS`) and one module per provider. Adapters run
**in-process in the Python API** and call provider REST/GraphQL APIs over
`httpx`; they never shell out to vendor CLIs in the agent terminal, so tokens
never reach an agent shell. Shape (merging the FG-08 `HostRunner` Protocol in
`hermes_cli/oss_acquisition.py` — implemented by `oss_host.py::SSHHostRunner` — with the
provider sections):

```python
class HostingAdapter(Protocol):
    provider: str; credential_kind: str
    def plan(self, spec) -> HostingPlan                 # resources, est. monthly USD, public?
    async def ensure_project(self, cred, spec) -> ProviderRef
    async def set_env(self, cred, ref, env, target) -> None   # write-only; refuses NEXT_PUBLIC_* secrets
    async def deploy(self, cred, ref, source, target) -> DeployRef
    async def promote(self, cred, ref, approved_deploy) -> DeployRef
    async def status(self, cred, ref, deploy) -> DeployStatus
    async def logs(self, cred, ref, deploy, since) -> list[LogLine]   # redacted, capped
    async def rollback(self, cred, ref, to_deploy) -> DeployRef
    async def add_domain(self, cred, ref, host) -> DnsInstructions
    async def suspend(self, cred, ref) -> None ; async def resume(...)
    async def usage(self, cred, ref, period) -> UsageReport | None
    async def teardown(self, cred, ref, *, keep_data: bool) -> None
```

The agent reaches adapters only through `hermes tool deploy|status|logs|promote|
suspend` (allowlisted) and agent-home buttons; `teardown` is never on the agent
allowlist. Provider-hosted MCPs (Vercel, Supabase, Railway) stay **read-only /
inspect** in chat and are never the deploy path, because they bypass the C6
spend and publish gates.

#### 4.2 Credentials and accounts

- New `KindSpec`s, all `materialize=False`, `keep_secrets_on_put=True`, with
  validators: `vercel-token` (team-scoped; `token`, `team_id`),
  `supabase-management` (OAuth refresh token or a PAT on a dedicated org;
  `org_slug`), `supabase-project` (per-app keys, pooler URL), `railway-token`
  (workspace token; per-env project tokens derived), `aws-hosting` (bootstrap
  key limited to `sts:AssumeRole` into `AquariumHostingDeployer` with
  `ExternalId`, 1 h sessions), `alibaba-cloud` (RAM user limited to
  `sts:AssumeRole`, 900 s sessions with an inline session policy). Add a
  `hosting` service so an entry is used only after its owner opts it in.
- **Default or own account (decision 10, Yan).** Every external tool row
  stores `account_source` (`default`|`own`) for hosting and
  `db_account_source` for its supabase.com database. The author chooses in the
  build clarify step and on the tool sheet. `default` resolves
  `credential_ref` to the owner-managed default account for that provider
  (a `hosting_accounts` row with `is_default`). `own` resolves it to the
  author's own credential row of the same kind, which they connect in
  Settings → Connected accounts, and only they can use it. Changing the
  account of a live app counts as a redeploy to a new target: C6, with
  the data-move warning. Members can use the default accounts only within the
  caps of §4.7.
- **Whose default accounts (decision 10).** v1 uses **dedicated,
  owner-managed Aquarium accounts per provider** (a Vercel `aquarium-apps` team,
  a Supabase org, a Railway workspace, an AWS Organizations member account, an
  Alibaba International-site account in `cn-hongkong`), so the blast radius of a
  leaked token and of a workspace-wide hard limit is contained and Leo's
  existing projects are out of reach. Credentials are owned by the owner
  principal; members' apps deploy into these accounts under per-app quotas.
  Bring-your-own accounts are in v1 too (above), using the same kinds.
- Connecting happens in agent-home **Settings → Connected accounts**
  (`ConnectedAccounts.tsx`, new "Hosting" group); the agent has no path to it.
- **Fix the existing leaks first:** move `optional-skills/devops/supabase-cli`'s
  `SUPABASE_ACCESS_TOKEN` off env passthrough once the adapter lands, and never
  put any hosting credential in a service env (the AWS chain passes
  `_sanitize_subprocess_env`).

#### 4.3 Providers

Order (open decision 11): **Vercel + supabase.com first**, Railway second, AWS
Amplify third, Alibaba Cloud fourth. API names are from the provider sections
and must be re-verified against vendor docs at build time (P8-3 first task).

| Provider | Deploy | Dev → prod | Domains | Status / logs | Teardown | Cost guard |
|---|---|---|---|---|---|---|
| **Vercel** | REST, no git: `POST /v2/files` (`x-vercel-digest`) then `POST /v13/deployments` with `projectSettings.framework="nextjs"`, `?teamId=` | dev = Preview deployment; promote = `POST /v13/deployments` with `deploymentId=<approved preview>`, `target=production` (exactly what was approved goes live) | `*.vercel.app` first; delegated `apps.<domain>` CNAMEs later, C6 per domain | `GET /v13/deployments/{id}` `readyState`, `GET /v3/deployments/{id}/events`; keep Standard Protection, use Protection Bypass for Automation for health checks | `DELETE /v9/projects/{id}` | Hobby is non-commercial only → Pro on the dedicated team with a Spend Management cap; `max_deploys_per_day` policy |
| **supabase.com** (DB for every external app) | Management API: `POST /v1/projects`, `GET …/api-keys`, `PATCH …/config/auth` (`site_url`, `uri_allow_list` per host); migrations via `supabase db push --db-url <pooler>` run by the adapter | open decision 12: **two projects** (dev, prod) — works on any plan and mirrors C3 — vs a persistent branch (Pro, ~USD 10/mo each) | n/a | `GET /v1/projects/{ref}` `status`; ~120 req/min limit | `pause` (reversible) vs `DELETE` (irreversible) | Free = 2 active projects, pauses after ~7 days idle → Pro org with spend cap for anything shared; Free only for prototypes with a "may pause" badge |
| **Railway** | GraphQL v2 (`projectCreate` → `serviceCreate` → deploy) from a GitHub repo or `railway up` fallback; denials arrive as HTTP 200 with `errors[]` | one environment per mode; promote deploys the exact dev SHA to `production` | Railway domain + CNAME | deployment status + logs queries; API 1000 req/h Hobby / 10000 Pro | `projectDelete` (irreversible) after suspend + `pg_dump` | usage hard limits are **workspace-wide** (take all workloads offline), no per-project cap → dedicated workspace, Aquarium per-app budget, workspace limit = 1.5× sum of budgets; Serverless sleep for dev |
| **AWS** | **Amplify Hosting** SSR (App Runner is closed to new customers; Amplify supports Next.js 12–15 and has **no zip deploy for SSR**, so it needs a private GitHub repo per app + the per-region Amplify GitHub App + a fine-grained PAT) | branches `dev`/`main`; promote = merge + `StartJob` | `amplifyapp.com` first; `CreateDomainAssociation` later | `GetJob`, CloudWatch `FilterLogEvents`, 14-day retention | `DeleteApp` (2 approvals) | dedicated member account; AWS Budget at 50/80% + deny action at 100%; CloudFormation `deploy/aws/aquarium-hosting.yaml` with a permissions boundary |
| **Alibaba Cloud** | **Function Compute 3.0** custom container (scales to zero) with the image built on the box (cgroup-capped, one at a time) and pushed to ACR; SAE opt-in for always-warm | functions `aq-<slug>-dev` / `-prod` | custom domain mandatory (default FC domain forces downloads); one wildcard CNAME by Leo | FC status, SLS logs with TTL | delete function + ACR repo; tag sweep must return zero | budgets are **alert-only** → concurrency caps (dev 5 / prod 20), lower approval threshold; `cn-hongkong` on an International-site account needs no ICP; mainland later |

The database for any external app is supabase.com via its adapter (not the
Vercel Marketplace integration, not Railway Postgres by default, not RDS), and
**never** the box's Supabase/Kong. Keeping Kong/Supabase off the public
internet is **FG-33's own security requirement** (§Security); FG-20 Design §6
only notes that a Vercel-hosted agent-home would need Supabase/Kong publicly
reachable, and leaves that as an option, not a rule.
Railway Postgres is allowed for plain-Postgres apps if Leo wants a single bill.

#### 4.4 Gates

Durable `NotificationStore` approvals with `reversible=False`, so
`evaluate_approval` never auto-answers them; the helper and adapters refuse any
mutating spec without an `approval_ref`:

1. connect an account — user, in Settings; no agent path;
2. first paid resource / first deploy — body shows `plan()` estimate, provider, region, public URL;
3. production / make public — the existing `promote_tool` approval;
4. custom domain;
5. raise a spend cap;
6. teardown / database delete — with the data-loss warning; AWS/Railway/supabase.com delete takes 2 approvals (FG-08 off-box rail).

Status polls, logs, redeploys of an approved preview and rollbacks are ungated
but C5/C8-recorded. Each provider call is a C8 `tool_call`; estimated and
provider-reported spend are C8 `cost` rows tagged `app=<slug>`. A linked FG-32
project's `budget_usd_per_run` applies to deploy runs.

#### 4.5 External promotion plan (inside `promote_tool`, after C6)

1. `supabase db push --dry-run` against prod is shown in the approval; then the real push;
2. adapter `promote()` (Vercel: promote the approved preview; Railway: deploy the dev SHA to `production`; Amplify: merge `dev`→`main` + `StartJob`; FC: deploy the dev image digest to `-prod`);
3. register / copy the `xa-<slug>` `http` endpoint into prod `mcp_endpoints`;
4. C5 change with `inverse_op` = redeploy of the previous READY deployment; `app_deployments` row.

#### 4.6 Status and spend sync

`aquarium-hosting-poll.timer` (non-`hermes-*` prefix, oneshot without
`[Install]`, matching the timers-only convention) refreshes deploy status every
5–15 min, raises an owner inbox item on `error`, pauses provisioning at 100% of
budget, and once a day pulls billing where a billing-scope token exists (Vercel
usage, Railway usage, AWS Cost Explorer, Alibaba BSS, Supabase). Cost is shown
as "provider-reported, up to 48 h late", or "not available" — never estimated.
An auth failure shows the tile as `unknown`, not `down`. It also lists provider
resources tagged `aquarium:app` that have no registry row (orphans).

#### 4.7 Spend caps: per project and per account (decision 13)

- **Per project.** `tool_hosting.spend_cap_usd` is the monthly cap for one
  external app (its hosting and its supabase.com projects together). When the app
  is linked to an FG-32 project, the project shows it, and
  `budget_usd_per_run` still bounds a single deploy run. It defaults to the
  owner-set value in `/etc/aquarium/app-quotas.yaml` (sections proposed
  USD 20–50) and cannot be 0 for a paid resource.
- **Per account.** `hosting_accounts.monthly_cap_usd` caps everything Aquarium
  deploys into one provider account, default or own. A tool's cap cannot be
  set higher than what is left of its account's cap. Where the provider offers
  it, the account cap is also set on the provider: Vercel Spend Management,
  Railway workspace hard limit, Supabase spend cap, or an AWS Budgets deny
  action. Alibaba only has alert-only budgets, so its cap is enforced by
  Aquarium alone, together with concurrency caps.
- **Enforcement.** Admission (`app_quota.check_admission`) refuses a paid
  create or deploy if the estimate would pass either cap. The status/spend poll
  (§4.6) warns at 80%, and at 100% suspends the app's dev targets and blocks
  new deploys of that app (project cap) or of every app in that account
  (account cap). Prod stays up unless the owner chooses "suspend prod too",
  because a hard stop is the provider's hard limit. Raising either cap is a C6
  approval (§4.4 gate 5), and only the account's owner can raise an own
  account's cap.

### 5. Agent access to each app (MCP)

- **One endpoint per app** through the existing registry: names `la-<slug>`
  (local) and `xa-<slug>` (external), so tools come out as `mcp_la_<slug>_*` /
  `mcp_xa_<slug>_*` and never collide with app-mcp's reserved `app` server.
  `mcp_endpoints.kind` stays `in_house` (our code); the new `app_kind` column
  carries `local|external`.
- **Transport.** Streamable HTTP served by the app's own Node process at
  `/api/mcp` (open decision 6): local = `http://127.0.0.1:<port>/api/mcp`,
  external = `https://…/api/mcp` (Vercel via `mcp-handler`). This removes the
  gateway-uid stdio spawn and keeps D3's one process. Auth: a per-app bearer
  token (local: minted by the helper, delivered by `LoadCredential`; external:
  `materialize=False` credential copied to provider env); the endpoint row holds
  only a `secret_ref`. With `forward_principal: true` the app receives the
  chat user (as app-mcp's `_meta.aquarium_principal_user_id`) and maps it to its
  own RLS; unknown users get read-only or nothing. MCP OAuth 2.1
  (`tools/mcp_oauth_manager.py`) is optional later.
- **Transport fix.** `transport.auth` becomes the auth *type* (`bearer|oauth`)
  plus `headers_ref`/`secret_ref`; `_validate_transport`/`to_server_config` and
  their tests change; the app-mcp special case (`_add_app_mcp_token`,
  `_is_app_mcp_server`) is generalised to per-endpoint `secret_ref` +
  `forward_principal`.
- **Chat start, cache-safe.** New `apply_registry_endpoints(agent)` modelled on
  `personal_mcp.apply_to_agent`: resolves the principal's **enabled** endpoints
  for the session's mode, fixes the set in `sessions.model_config._registry_mcp`
  on the first agent build, fail-soft `CONNECT_TIMEOUT`/`RETRY_AFTER`. Enabling,
  rebuilding or promoting an app takes effect in the **next** chat (agent-home
  already says "takes effect on next connect").
- **Which apps a chat gets (open decision 17).** Recommendation: apps attached
  to the active FG-32 project's `toolsets` plus apps the user explicitly
  enabled — 20 apps × 5 tools ≈ 100 schemas otherwise. `tools/list_changed` from
  `la-*`/`xa-*` servers is logged, not applied to live chats. The building
  session tests its app over the terminal (`curl`, handshake), never by
  hot-adding tools.
- **Standard tool set in the template:**

| tool | effect | default gate |
|---|---|---|
| `app_info`, `app_health` | version/SHA/mode, DB ping | none |
| `data_schema`, `data_query` | read-only via the `…_ro` role, output capped by `max_result_chars` | none for the owner; gated when the app is `shared` (untrusted output) |
| `action_<verb>` | app-defined mutations, annotated `destructiveHint` | enforced by the 0.5 gate in `tools/mcp_tool.py` (`destructiveHint` **or** an `action_` name on `la-*`/`xa-*` servers), independent of any plugin; `approvals.tools: mcp_la_<slug>_action_*` is also written as an extra layer, effective only if the opt-in `plugins/tool-approval` is enabled |
| `logs_tail` (local) | capped journal tail via the helper | none |

- **Annotation gate.** Additive change in `tools/mcp_tool.py::_register_server_tools`:
  for `la-*`/`xa-*` servers, any tool with `destructiveHint` or an `action_`
  name goes through `tools.approval` before it runs (adds gates, never removes
  one). This is **the** enforcement for app mutations: it does not depend on
  the opt-in `plugins/tool-approval` plugin or on `approvals.tools` in
  `config.yaml` (Customizable), which stay only as an extra layer. C8 traces every call; mutating actions emit C5
  `target_kind=data`.
- **Other users' agents.** `private:<owner>` apps resolve only for the owner;
  `shared` apps resolve for members, with the caller forwarded. Infra operations
  (logs, env, redeploys) are not app MCP tools; they go through `hermes tool …`.

### 6. Quotas and capacity

- **Policy lives outside the agent's reach.** `core_manifest.yaml` classes
  behavioural `config.yaml` as Customizable, so quotas there would be advisory to
  the actor they limit. Defaults go in a root-owned
  `/etc/aquarium/app-quotas.yaml` (template in `deploy/install/`); owner
  overrides go in an owner-only `quota_overrides` table written only by `PUT
  /api/quotas/{user_id}` (C5 + C8). The sections that proposed `config.yaml` are
  overruled on this point.
- **One admission function.** `hermes_cli/app_quota.py::check_admission(principal,
  action)` for `create|start|build|promote|provision-external`, called by the
  CLI, the API routes and re-checked by the helper. Soft breaches raise a C6
  approval to the owner; box-wide breaches are refused naming the binding
  constraint (FG-31 style). Usage is read live (`systemctl show -p
  MemoryCurrent`, `du`, `pg_database_size()`).
- **Starting defaults (open decision 8; calibrate on the system-test box as
  FG-31 was):**

| limit | per app | per member | box-wide |
|---|---|---|---|
| local apps registered / running | – | 3 / 2 (dev+prod copies share it) | **admission number N ≈ 6** (below); stop admitting at N or at FG-31 `watch`, whichever comes first |
| RAM | `MemoryHigh=384M` / `MemoryMax=512M` | 1 GB running total | parent `aquarium.slice MemoryMax=6G` (kernel-enforced) = `aquarium-apps.slice` 3 GB + one shared build/live-edit slot 2 GB (`aquarium-build.slice`, one `flock`) + apps compose project 1 GB (`aquarium-db.slice`: cluster 512M, sidecars share the other ~512M, so ~2–4 apps can opt in). **Reserved headroom ≥ 3 GB** of the ~9 GB available for FG-31 sessions, gateway, embed and Supabase; admission refuses `start`/`build` when `aquarium.slice` `MemoryCurrent` + the request would pass 6 GB or box `MemAvailable` would fall below the 3 GB reserve |
| CPU | `CPUQuota=50%`, `CPUWeight=20` | – | slice `CPUQuota=200%` |
| disk (repo + `node_modules` + releases) | 1.5 GB | 4 GB | FG-31 disk bound (watch at 80% ≈ 15 GB more growth, not 44 GB) |
| DB size / connections | 500 MB / 5 | 1 GB | apps cluster `max_connections` |
| external apps | – | 5 | – |
| external spend | provider hard cap mandatory | monthly USD cap 0 until the owner sets one; `approval_usd` 0 (every paid resource needs approval) | – |

  Owner/admin get higher defaults via a `roles:` map; nothing is unlimited
  unless the owner says so. Per-user spend = LLM C8 `cost` rows by
  `actor_user_id` + external rows; one combined number shown, two caps; 80%
  notifies, 100% pauses provisioning ("ask, don't kill", FG-32).
- **Estimates to calibrate** (none measured): idle prod `next start`
  standalone ~80–150 MB RSS; `next dev` 0.5–1 GB; build 1–2 GB peak; release
  50–150 MB; build-time `node_modules` 0.3–0.6 GB per app.
- **The admission number (one figure, used in §3.4, here and open decision 1).**
  N = min(RAM-bound, disk-bound), an **estimate until P8-0 row 0.7 measures
  it**:
  - *RAM-bound:* `aquarium-apps.slice` 3 GB / `MemoryHigh` 384 MB ≈ **8**
    running app instances (dev instances are idle-stopped, so ~6 apps' prod
    instances plus one or two dev previews). `MemoryMax` 512 MB is the per-app
    ceiling, not the sizing figure; the slice cap, not the sum of per-app caps,
    is binding. Sidecar RAM counts against the 1 GB `aquarium-db.slice`, and
    everything together against the 6 GB `aquarium.slice`.
  - *Disk-bound:* ~15 GB of growth before FG-31's 80% watch line / (1.5 GB
    repo + `node_modules` + releases + 2 × 500 MB dev/prod DBs ≈ 2.5 GB per app)
    ≈ **6** apps. Three members at their 4 GB disk + 1 GB DB caps (15 GB) would
    also reach the watch line on their own.
  - **N ≈ 6**, disk-bound. Under A it is 2–3 apps total (RAM-bound). Raising N
    means more disk or a smaller per-app footprint (open decision 21), not more
    RAM.
- **Capacity.** `hermes_cli/capacity.py` gains `apps_rss_bytes`,
  `apps_disk_bytes` and the apps compose project's usage against `aquarium-db.slice`'s 1 GB, plus `aquarium.slice` `MemoryCurrent` against 6 GB, so the FG-31 verdict can
  name "local apps" as the binding constraint. `check_admission` enforces both numbers in the RAM row above (6 GB FG-33
  ceiling, 3 GB box reserve, the reserve set in the root quota file as
  `box.reserved_mb: 3072`) and re-checks inside the helper, so the reserve is
  enforced, not advisory.
- **Bypass.** An agent running `npm run dev` in its terminal escapes the slice;
  with `run_as: hermes-tools` the quota timer flags `next` processes outside
  `aquarium-apps.slice`.

### 7. Tools page (agent-home)

- **Layout (mobile-first).** Three sections: **On this box** (local apps),
  **Hosted elsewhere** (external apps), **Helpers & services** (today's
  `ToolRow` list for other `in_house`/`remote`/`builtin`, unchanged). App
  sections are a home-screen grid: 4 columns at 320 px, `sm:grid-cols-6`,
  `lg:grid-cols-8`; 64 px icon, two-line label, ≥44 px tap targets; disabled
  apps keep the `<details>` "Turned off (n)" pattern.
- **Telling the two kinds apart** — by shape, badge and text, never colour alone:

| | Local app (`AppIcon data-kind="local"`) | External app (`data-kind="external"`) |
|---|---|---|
| Shape | filled rounded square (squircle) with the app's own icon | circle with a 2 px outline ring on a surface-2 fill |
| Corner badge | small "box" mark (served from this Aquarium) | provider mark: Vercel, Railway, AWS, Alibaba Cloud, supabase.com, or a globe |
| Label suffix | none | `↗` (leaves Aquarium) |
| Sheet sub-label | "Runs on this box · own database" | "Hosted on Vercel · DB on supabase.com" |

  Provider marks are bundled monochrome SVGs (`agent-home/public/providers/`,
  `currentColor`), never hotlinked, after a brand-guideline check.
- **Icons.** Sources in order: `uploaded` (a `file_assets` id; PNG/WebP/JPEG
  ≤256 KB, SVG refused), `favicon` (a one-time snapshot: local = the scaffold's
  `app/icon.png` copied at registration; external = one same-host fetch, 2 s,
  ≤256 KB, no off-host redirects), `generated` (monogram or emoji on one of 8
  palette tokens hashed from the name — the Projects `icon`/`color` convention).
  Rendered through `/api/files/[id]/content`, so the sandbox headers apply and a
  tile renders while the app is down.
- **Health dot** (derived on read, FG-32 §9 principle; text in `aria-label`):
  green running, amber building/degraded, red down/failed, grey off, striped
  dev-only, hollow `unknown`. The server renders the grid; the client fills dots
  from **one** `GET /api/tools?include=health` (registry read once, parallel
  probes, 30 s cache) — today's per-tool probe does a full `list_for_principal`
  + DDL per call. Local reads `tool_runtime` (§9); external reads adapter status
  + a public-URL probe that refuses private ranges and off-host redirects (SSRF).
- **Opening.** A ready tile opens the app URL in a new tab
  (`rel="noopener noreferrer"`); a not-ready tile opens the details sheet. No
  iframe in P8-2: `frame-src 'self'` would need per-app widening, hosted
  providers send `X-Frame-Options`, and same-origin embedding is ruled out by
  §3.5. A later embedded view (local apps on their own origin) would be a Coral
  `webview` manifest.
- **Actions** (`⋯` button → `ToolActionsSheet`; every write via
  `useProjectAction` + `ActionButton`; destructive via `ConfirmDialog`; hidden
  when the caller may not do them):

| Action | local | external | Gate |
|---|---|---|---|
| Open | ✓ | ✓ | – |
| Turn on / off | start/stop process | hide from launcher (provider untouched) | C5 |
| Restart | ✓ | – | C5 |
| Redeploy | – | ✓ | C6 |
| Provider console (`dashboard_url`) | – | ✓ | – |
| Make live (`promote_tool`) | ✓ | ✓ | C6 (existing) |
| Change icon | ✓ | ✓ | C5 |
| Ask the agent to change it | ✓ | ✓ | opens `/chat` with a prefilled prompt |
| Logs | ✓ | ✓ | owner/admin |
| Delete / Unlink | delete (archive first, §9) | unlink row only (teardown is a separate C6 act) | C6 + ConfirmDialog |

- **Empty/edge states.** No apps: one card with "Build a local app" / "Build a
  hosted app" chat deep-links. `build_state='building'`: skeleton tile linking to
  the FG-32 run. Admin "Live / In development" toggle (`client.tools(mode)`),
  dev tiles dashed with a "Dev" chip. A quota strip ("Local apps 2/3 running ·
  0.7/1 GB RAM · $4.20/$20 this month").
- **`/tools/[name]`** detail page: status, URLs (dev/prod), last run/card,
  deployments, logs tail, feedback box (→ `task_comments` or
  `project_directives(kind='feedback')`), MCP status ("takes effect in next
  chat").
- **Components** (`components/tools/`, each root with `data-component`):
  `AppGrid`, `AppTile`, `AppIcon`, `ProviderBadge`, `HealthDot`,
  `ToolActionsSheet`, `IconPicker`, `QuotaStrip`, `appIconColor.ts`; i18n
  namespace `tools.json` (`en`, `zh-Hant`). BFF under
  `agent-home/src/app/api/tools/apps/[name]/…` (the `apps/` namespace cannot
  collide with `/api/tools/mcp/[name]`), each listed in
  `lib/auth/route-roles.json`. Unknown kinds fall back to the text row, so an
  old UI against a new backend is safe.
- **Coral launcher.** "Pin to launcher" turns a `tools` row into a `category:
  "custom"` `AppManifest` via a **new** BFF route `/api/apps`, reading
  `tools` rows instead of the separate `internal_apps` table. Both the route and
  the table are described in `coral-app-framework.md` §5.2 as Phase-2 work and
  neither exists today; P8-4 item 4.5 builds the route.

### 8. Ownership, roles and approvals

| Act | Who | Gate |
|---|---|---|
| Create a dev app (row `private:<user>`) | member+ | admission |
| Start/stop/restart/build **dev** | the app's owner, admin | C5 (pre-approved, like `enable`) |
| Share with members (`visibility=shared`) | the app's owner, admin | C6 |
| Make live (prod), prod start/stop | owner/admin of the instance (open decision 9) | C6, approved in agent-home, not via `app_act` |
| Publish an anonymous public URL | owner/admin | C6 |
| Add an egress host | the app's owner, admin | C6 |
| External paid resource, spend-cap raise, domain | owner/admin | C6 |
| Delete / archive / purge / teardown | the app's owner, admin | C6 (2 approvals for external delete); dump/archive first (`backup_ref`) |

Viewers may only open shared apps. FG-32 project membership grants **read**,
never publish or delete. Every act emits C5 and C8.

- **The requester, not the owner.** A gateway-minted, short-lived HMAC
  **principal ticket** (the `app-mcp/app_mcp/ticket.py` pattern) is passed to
  the agent shell like `HERMES_KANBAN_TASK` (`env_keep` in `hermes-tools-cli`).
  `hermes-tools-cli` verifies it and uses it as `--as`. An agent shell cannot
  forge it; without a valid ticket, `tool new` fails closed instead of falling
  back to the owner. The dashboard routes use the caller, not
  `_resolve_tool_operator`, and members may manage their own private apps (today
  all registry mutations are admin-only `_TOOLS_MANAGER`).
- **Human-only approvals.** `app-mcp/app_mcp/guard.py` adds `deploy`,
  `publish`, `make live`, `redeploy` and `unlink` to `CONSENT_WORDS` (user-only
  for `app_act` **and** `app_act_destructive`), and every new FG-33 approve /
  make-live / delete / teardown control carries the existing `data-appmcp-deny`
  marker. "delete" stays only in `DESTRUCTIVE_WORDS`, so a Delete button without
  the marker would still be pressable by `app_act_destructive`; the marker is
  what makes it human-only.

### 9. Operations

- **Deploy survival.** App units are outside the `hermes-*` glob; after a deploy,
  `aquarium-app-helper status --all` **prints** app problems without failing the
  deploy. Regression tests assert `hermes-deploy.sh` `UNITS` and
  `aquarium.py::service_units()` never include `aquarium-app@*`.
- **Monitoring.** `aquarium-apps-watch.timer` (5 min, oneshot, no `[Install]`):
  `systemctl is-active` + `GET /api/health` per local app, cgroup RSS/CPU,
  hourly `du`, `pg_database_size`, writes `tool_runtime`. The Tools page reads
  that instead of probing live.
- **Alerts, no new channel.** The app owner gets a `NotificationStore`
  `proactive_ask` with `dedupe_key=app-down:<slug>` after 3 consecutive failures
  (~15 min), honouring quiet hours. The instance owner gets Telegram via
  `check_runtime_drift.notify()` (moved to `scripts/lib/`) for box-level
  conditions: >3 apps down, a crash loop hitting `StartLimitBurst`, capacity
  `constrained`.
- **Logs.** journald per unit with `LogRateLimitIntervalSec`; BFF →
  `/api/tools/{name}/logs` → helper; C2-scoped to owner/admin.
- **Drift.** Add `aquarium-app@.service`, `aquarium-app-build@.service`,
  `aquarium-apps.slice` and the timers to `DEFAULT_UNIT_GLOBS` (template only;
  instances change with users). `hermes tool doctor` reconciles registry rows ×
  unit instances × app databases × Caddy includes × ports and reports orphans
  either way; it runs inside the weekly `hermes-drift-check`. A
  `aquarium-apps-reconcile` pass makes the box match the registry after a reboot.
- **Backups.** Source is in the existing `HERMES_HOME` tar; add `.next` and old
  releases to `SKIP_DIRS`. Databases per §3.4. `/etc/aquarium/apps/` and the
  Caddy include join the secret backup / `backup_sources()`.
- **Lifecycle** (`tool_runtime.lifecycle_state`): `active → idle` (no visit for
  14 days; visits from Caddy access logs) `→ stopped` (auto after 30 days idle,
  7 for dev; 72 h notice; reversible, no approval) `→ archived` (owner-approved
  or 90 days stopped: self-contained `aquarium-app-<slug>-<ts>.tar.gz.gpg` with
  code, DB dump and row; then `node_modules` and the DB are dropped; C6) `→
  purged` (after backup `keep_days`; C6). External: dev suspended after 7 days
  idle where the provider supports it; teardown only on approval.
- **Export.** `hermes tool export <slug> --to supabase` (create project, replay
  migrations, copy Storage objects, move the app's auth users if it had its own
  GoTrue, re-point env, flip the row to `external` with C5) — later phase.

### 10. Coder profiles (decision 15)

- Two new Hermes profiles (`hermes_cli/profiles.py`: each is its own
  HERMES_HOME with `config.yaml`, `SOUL.md`, skills and memory):
  - **`internal-coder`**: builds local apps. Its skills are the template, the
    apps-cluster migrations, `hermes tool build|start|logs`, and the local
    definition of done (§1 step 4). It has no hosting credential kinds.
  - **`external-coder`**: builds external apps. It has the same coding skills,
    plus the hosting adapters' allowlisted verbs (`deploy --target preview`,
    status, logs) and supabase.com migrations through the adapter. It never
    holds raw provider tokens (credentials stay `materialize=False`, §4.2).
- Both are created from versioned definitions in the repo (SOUL, config
  overlay, skill list) by an ops step, `hermes profile create <name>` plus
  the overlay, on the system-test box first. Neither profile gets a channel
  or gateway of its own; they only run as kanban workers.
- **Assignment.** `hermes_cli/app_coder.py::coder_profile_for(tool)` returns
  `tools.coder_profile` if set, otherwise `internal-coder` or
  `external-coder` by `hosting`. The `vibe-code-app` skill (2.3) creates every
  build card with `--assignee <that profile>`. The override is set on the tool
  sheet or with `hermes tool set <slug> --coder-profile <name>`, can only name
  an existing profile, and is a C5 change. The override is owner/admin-only
  for shared tools, and the tool's author can set it for private ones.
- **Why profiles:** model, prompt and skills for coding are tuned once per mode
  and kept out of the main assistant's prompt (prompt-cache safety).
  Kanban already routes cards by assignee profile
  (`hermes_cli/kanban_db.py` `assignee`).

## Data model

All additive (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, constraint swap for the
CHECK), applied to both `app_dev` and `app_prod` through `_tools_schema_sql` /
`hermes db migrate`, C2 RLS mirroring `tools`. `promote_tool`'s explicit column
list is extended, and a test asserts promote round-trips **every** `_COLUMNS`
field so future columns cannot silently drop.

**`tools`** — `kind` CHECK widens to `('in_house','remote','builtin','external')`
(open decision 3; local apps stay `in_house` = D3). New nullable columns:

| column | meaning |
|---|---|
| `hosting TEXT CHECK IN ('local','external')` | NULL for legacy tools |
| `display_name`, `description` | tile label and sheet text |
| `icon`, `icon_color`, `icon_asset_id`, `icon_source CHECK IN ('generated','uploaded','favicon')` | Projects-style icon + `file_assets` ref |
| `public_url`, `dashboard_url` | browser-facing URL (https; local must be on the apps domain) and provider console; `web_url` keeps meaning "internal probe address" |
| `repo_path`, `release_sha` | source tree and current release |
| `project_slug` | optional FG-32 link (mirrors `project_links(kind='tool')`) |
| `build_state CHECK IN ('draft','building','ready','failed')` | coarse state for the tile |
| `always_on BOOL`, `limits_json JSONB` | owner-only; effective limits materialised by the helper |
| `secret_names TEXT[]` | names only |
| `coder_profile TEXT` | NULL = default by `hosting` (`internal-coder` / `external-coder`, §10); otherwise an existing profile name |

Reserved names refused: `mcp, personal-mcp, toolsets, changes, computer-use,
apps, health, quota` (sibling routes would shadow them). Name uniqueness stays
`UNIQUE(name)` per mode in v1 because the slug becomes a hostname; per-owner
names would need a host scheme change.

**New tables** (C3 mode-scoped):

```sql
-- local app database binding (no secrets; written only by the provisioner)
app_databases(id PK, tool_id FK→tools ON DELETE RESTRICT, mode, cluster DEFAULT 'apps'  -- 'apps'|'dedicated'
  , db_name UNIQUE, features JSONB DEFAULT '["postgres"]', api_base_url, status CHECK IN
  ('provisioning','ready','suspended','dropped','failed'), quota_mb, last_size_mb,
  last_backup_ref, applied_migrations JSONB, created_at, dropped_at, UNIQUE(tool_id, mode));

-- external hosting binding (no secrets; credentials resolve via credential_ref at call time)
tool_hosting(tool_id PK FK→tools ON DELETE RESTRICT, provider CHECK IN ('vercel','railway','aws_amplify','alibaba_fc') /* = PROVIDERS keys = CLI --provider */,
  credential_ref, provider_project_id, region, db_provider CHECK IN ('supabase_com','railway_pg'),
  db_credential_ref, db_project_refs JSONB /* {dev,prod} */, domains JSONB, spend_cap_usd NUMERIC /* per-project monthly cap, §4.7 */,
  account_source CHECK IN ('default','own'), db_account_source CHECK IN ('default','own'),
  state CHECK IN ('draft','provisioning','live','failed','suspended','torn_down'));

-- one row per build/release/deploy, local and external
app_deployments(id PK, tool_id FK, mode, target /* preview|production|dev|prod */, source_sha,
  provider_deployment_id, url, ready_state, error, actor_user_id, approval_ref, change_ref, trace_id, created_at);

-- latest runtime facts (written by the watch / poll timers)
tool_runtime(tool_id PK FK, runtime CHECK IN ('local','external'), unit, port, health CHECK IN
  ('ok','degraded','down','unknown'), consecutive_failures, health_checked_at, rss_bytes, disk_bytes,
  db_bytes, last_visit_at, lifecycle_state CHECK IN ('active','idle','stopped','archived','purged'),
  runtime_state CHECK IN ('stopped','building','starting','running','failed','idle_stopped','over_quota'),
  state_changed_at);

app_usage_samples(tool_id, ts, mem_bytes, cpu_ns, disk_bytes, db_bytes)   -- 31-day retention
quota_overrides(user_id, key, value, set_by, approval_ref, change_ref, ts) -- owner-only writes

-- connected provider accounts (no secrets; the token is the credential row)
hosting_accounts(id PK, provider /* PROVIDERS keys + 'supabase_com' */, owner_user_id, is_default BOOL,
  credential_ref, monthly_cap_usd NUMERIC NOT NULL, provider_cap_set BOOL, month_spend_usd, spend_synced_at,
  UNIQUE(provider) WHERE is_default)
```

No new audit table: C5 `changes` (`target_kind` `code`/`config`/`data`), C6
`approvals`, `promotions`, C8 `interactions` (`tool_call`, `cost`) are reused.

**`mcp_endpoints`** — `enabled BOOL DEFAULT true` (kept in sync with
`tools.status`), `app_kind CHECK IN ('local','external')`, `secret_ref`,
`forward_principal BOOL DEFAULT false`; `transport.auth` = auth type,
`transport.headers_ref`.

**Credential kinds** — §4.2.

**API** (Python, proxied by agent-home BFF; every write honours
`Idempotency-Key`, which requires adding `/api/tools/` and `/api/quotas/` to
`hermes_cli/projects_idempotency.py` `_covers`, or the header is silently
ignored):

- `GET /api/tools?include=health`; `GET /api/tools/{name}`; `GET /api/tools/{name}/runtime|logs|deployments|database|mcp`; `GET /api/tools/quota`
- `POST /api/tools/{name}/{build|start|stop|restart|deploy|redeploy|favicon-refresh|feedback}`; `PUT /api/tools/{name}/{icon|mcp|secrets|egress|visibility}`; `POST /api/tools/{name}/promote` (extended); `DELETE /api/tools/{name}` (C6)
- `PUT /api/quotas/{user_id}` (owner-only)
- agent-home: `GET /api/apps/auth` (forward_auth target, ticket-verified)

**CLI** (`hermes tool …`; `hermes-tools-cli` allowlist in brackets): `new
--template --hosting --provider` [yes, enums], `build|start|stop|restart|logs|
status|preview` [yes; prod variants require the API's C6], `deploy --target
preview` [yes], `promote` [yes, unchanged], `doctor` [yes, read-only],
`delete|archive|purge|teardown|export` [no].

## Dev/Prod + Supabase

- **Registry rows**: `app_dev.tools` / `app_prod.tools` via C3, unchanged model; dev tiles visible only in dev mode or to admins with the toggle.
- **Local apps**: `lapp_<id>_dev` / `lapp_<id>_prod` databases on the apps cluster (B2), `aquarium-app@<slug>-dev` / `-prod` units, `dev`/`prod` release symlinks. Promotion = tag + prod migrations + symlink flip + restart. Never data.
- **External apps**: dev = provider preview/dev environment + supabase.com dev project; prod = production target + prod project. Promotion = adapter `promote()` + `db push`. Never data.
- **Aquarium's own schemas** (`app_dev`, `app_prod`, `app_prod_<profile>`) and the FG-27 `schema_owner` guard are untouched; no app data lives there.
- **Channels** stay prod-only (D5); an app's MCP is resolved per session mode.
- **App end-user auth**: default Aquarium identity via forward_auth (`auth: aquarium`); per-app GoTrue only when the app opts into sidecars or is external (`auth: supabase`). Never reuse `AGENT_HOME_SESSION_SECRET` or Aquarium's JWT secret.

## Security

**Attacker model:** agent-written code (prompt-injected, hallucinated or a
malicious dependency), running with whatever its process can reach. Assets on
the box: gateway credentials (`$HERMES_HOME/.env`, `auth/`,
`/etc/aquarium/*.env`), Aquarium data (`app_prod`, `state.db`, kanban/projects
SQLite), other users' apps, loopback control planes, box capacity. Off box:
the provider accounts and their spend.

| Risk | Control |
|---|---|
| Agent shell reads every secret | **Hard prerequisite:** `terminal.run_as: hermes-tools` confirmed on prod; `DATABASE_URL` added to the strip list in `tools/environments/local.py` |
| Agent edits the main UI or its own limits via the raw terminal | human PR adds `agent-home/**`, `app-mcp/**`, `deploy/**`, `hermes_cli/app_templates/**`, `hermes_cli/tool_scaffold.py`, `hermes_cli/hosting/**`, `hermes_cli/app_quota.py`, `hermes_cli/app_runtime.py` to `core_manifest.yaml` (and `_FALLBACK_CORE_GLOBS`); uid separation is the real boundary, C7 is defence in depth |
| App code runs as the gateway uid | stdio MCP replaced by HTTP in the app's own `DynamicUser` process |
| App reads another app's files or Aquarium's | `DynamicUser`, `ProtectSystem=strict`, `InaccessiblePaths`, built artifacts root-owned, secrets via `LoadCredential` |
| App reaches loopback control planes / exfiltrates | nftables per-cgroup egress, deny-by-default; C6 allowlists |
| App JS steals the agent-home session | own origin per app; never same-origin under `home.` |
| Private app exposed to the internet | helper refuses a Caddy block without `forward_auth`; public = C6 publish |
| Box Supabase/Kong reachable from external apps | FG-33 requirement: the box's Supabase (Kong 8000/8443, pooler 5432/6543) stays off the public internet; external apps get their database only from supabase.com; no adapter or template ever writes the box's Supabase URL/keys into a provider env |
| Agent self-approves | new verbs in `guard.py` `CONSENT_WORDS` + existing `data-appmcp-deny` marker on every FG-33 approval/delete control; approvals are `reversible=False` NotificationStore items |
| Owner impersonation | HMAC principal ticket; fail closed |
| Supply chain | lockfile required, `npm ci --ignore-scripts`, fail-closed OSV over the lockfile, sandboxed build unit, egress only to npm |
| Shared Postgres exhaustion | separate apps cluster, `CONNECTION LIMIT`, `statement_timeout`, size timer |
| Provider token leak | `materialize=False`, in-process adapters, STS short-lived creds, dedicated accounts, never in env or `.env` |
| Runaway bills | provider-side hard cap / budget action is a precondition of connecting; C6 for paid resources |
| SSRF via probes and favicon fetches | https only, resolve and refuse private ranges, no off-host redirects, admin-only URL edits |
| Prompt injection via app data | `data_query` capped and gated when shared; output treated as untrusted |
| Hand-edited Caddy drift | one import line; helper validates; drift check covers the include |
| Supabase keys in client bundles | adapters refuse `NEXT_PUBLIC_*` for secret values; template lints for it |

## Operations

Summarised from §9: app units survive Core deploys; a 5-min watch timer feeds
health, usage and lifecycle; owner alerts via NotificationStore and box alerts
via the existing Telegram path; journald logs behind owner/admin BFF routes;
drift check covers the templates and `tool doctor` reconciles instances; per-app
databases and secrets join the backups; idle → stopped → archived → purged
lifecycle with C6 on the irreversible steps; external status/spend sync timer
with orphan detection. Runbooks (DNS record and Caddy import line, apps cluster
install, provider accounts, AWS CloudFormation stack, Alibaba RAM/ACR/SLS
setup) go to the private `leolau/aquarium-ops` repo, not the public repo, per
the existing rule that public docs carry no host/IP/key details.

## Testing requirements

- **Unit (Python, `tests/hermes_cli/`):** template rendering per hosting (file shape, no secrets in written files, `minimal` byte-identical); exact pin equality with the agent-home workspace's resolved versions in the root `package-lock.json`; manifest validation; reserved names; promote round-trips every `_COLUMNS` field; `check_admission` arithmetic (ok/needs_approval/refused, owner exempt); lifecycle state machine incl. dev/prod timers; slug/port validation; `mcp_endpoints` transport validation and `to_server_config`; `apply_registry_endpoints` pins the set per session and ignores mid-chat changes; `destructiveHint` gate only adds gates; hosting adapters against recorded fixtures (no live calls in CI) incl. Railway `errors[]` on HTTP 200; credential kinds never reach `credentials-materialized/`; `tool doctor` orphan detection.
- **Negative access (C2):** private app invisible cross-user (registry, runtime, logs, deployments, MCP resolution); viewer cannot author; member cannot promote/publish/delete; project membership grants read only; app A's role cannot `CONNECT` to app B's database or to the Aquarium cluster; app env files contain no Aquarium Supabase secret; `hermes`/`hermes-tools` cannot read prod app env; `tool new` without a principal ticket fails closed; `app_act` cannot press approval buttons.
- **Script/deploy (`tests/deploy/`, `tests/scripts/`, stubbed `systemctl` as in `tests/scripts/test_hermes_deploy_verification.py`):** `UNITS` and `service_units()` never include `aquarium-app@*`; sudoers files pass `visudo -c` (`test_sudoers_rules.py`); helpers reject traversal slugs and specs without `approval_ref` for prod verbs; route helper refuses a block without `forward_auth`; `make_backup` lists every registered app DB.
- **E2E (throwaway Postgres, as `test_fg07_tools_registry_e2e.py`):** scaffold → provision dev DB → build → start → health + MCP handshake over HTTP with bearer → enable → promote (approval + change + prod migration) → prod reachable; external flow against mocked provider HTTP; archive → restore into a new slug and compare row counts.
- **agent-home (vitest, co-located):** `ToolsRegistry.test.tsx` (sections, empty states, unknown kind falls back), `AppIcon.test.tsx` (kinds differ by shape and badge, not only colour; `aria-label` has kind + health), `appIconColor.test.ts` (deterministic, in palette — invariant, not snapshot), `ToolActionsSheet.test.tsx` (no Restart on external, no Redeploy/console on local), BFF route tests (role + `Idempotency-Key` forwarded, real upstream envelope through the state update — the FG-32 §20.3 gap), `route-roles.test.ts` entries; widen `rawFetchGuard.test.ts` to scan `components/tools/`.
- **Template's own tests:** `npm run check` in a CI job that scaffolds, `npm ci`s and runs it.
- **Baseline:** `tests/plan_baseline/` green; `scripts/run_tests.sh`, `ruff`, `ty`; agent-home lint/typecheck/vitest clean. Behaviour/invariant tests only (AGENTS.md principle 5).

## System testing (system-test box)

**Required step after each phase's development** (part of its Definition of
Done), on a **system-test box that mirrors prod — never prod**. Which box that
is is open decision 18: FG docs still name the Alibaba `hermes-systest` ECS,
while prod is now the Hetzner CX43; restarting `supabase-db` and running
deploys must never happen on prod. Use a staging schema (`app_staging`) and a
staging SQLite core (README §7.1). Acceptance checklist:

- **P8-0:** measured `docker stats` numbers and the GoTrue/PostgREST-on-`lapp_*` spike recorded in this doc's audit log; with `run_as: hermes-tools`, the agent shell cannot read `$HERMES_HOME/.env` or `DATABASE_URL`; `app_act` cannot press an approval; a registered app MCP appears in a **new** chat and not in the current one.
- **P8-1:** scaffold a local app from chat; dev DB provisioned; build in the build slice; dev instance reachable on its own origin only after agent-home login; MCP over HTTP with bearer; promote (approval + change + prod migration) → prod instance running, dev and prod databases distinct; `deploy-hermes.sh develop` leaves `ActiveEnterTimestamp` of every app unchanged; `kill -9` → restart; `supabase-db` restart → apps recover; quota refusal names the constraint.
- **P8-2:** Tools page shows local tiles (solid + box badge) with live health dots on a phone viewport; actions sheet per kind; a member's private app is invisible to another member; permanently broken app → one owner notification within ~15 min, no duplicate; idle → stopped with a clock override; archive (approval) → restore; drift check reports no false drift and does report an injected orphan DB.
- **P8-3:** connect a sandbox Vercel team and supabase.com org in Settings; create an external app (C6 with cost estimate); preview deploy; promote to production (dry-run in approval); outlined tile with Vercel badge and ↗; status and "not available"/provider cost on the tile; teardown (2 approvals) leaves no tagged resources.
- **P8-4:** the same create→deploy dev→promote→poll→teardown on throwaway Railway, AWS (member account) and Alibaba (`cn-hongkong`) resources; tag sweeps return zero.
- **Gate:** a phase is not complete until its checklist passes on the system-test box (on top of the per-PR gate).

## Phased delivery plan

Phases run in order; work items inside a phase run **in parallel**, one PR
each against `develop`, each owning the files listed (no two items in a phase
own the same file). Items marked *human* are PRs a human must author or apply
(Core changes and box operations). Every item edits only its own row in this
doc's Progress checklist and appends one audit-log row.

### Phase P8-0 — Prerequisites and contracts (Wave P8-A)

Answer open decisions 1, 3, 5, 6, 10, 18, 19, 20 first.

| # | Work item | Owns |
|---|---|---|
| 0.1 *human* | Core boundary: add `agent-home/**`, `app-mcp/**`, `deploy/**`, `hermes_cli/app_templates/**`, `hermes_cli/tool_scaffold.py`, `hermes_cli/hosting/**`, `hermes_cli/app_quota.py`, `hermes_cli/app_runtime.py` to `core_manifest.yaml` and the fallback list | `core_manifest.yaml`, `agent/core_boundary.py`, `tests/agent/test_core_boundary.py` |
| 0.2 *human/ops* | Confirm `terminal.run_as: hermes-tools` on prod; strip `DATABASE_URL` (and any app DSN names) from agent shells | `tools/environments/local.py`, `tests/tools/test_local_env_blocklist.py` |
| 0.3 | app-mcp guard: add `deploy`/`publish`/`make live`/`redeploy`/`unlink` to the existing `CONSENT_WORDS` (approve/allow/deny/grant/authorize/consent are already there); first list existing agent-home controls named "Publish" that `app_act_destructive` can press today and record them in the PR, because moving `publish` makes them user-only. The `data-appmcp-deny` markers on the new buttons are added by the items that build them (2.1, 2.7, 3.6); `delete` stays in `DESTRUCTIVE_WORDS` only, so those buttons must carry the marker | `app-mcp/app_mcp/guard.py`, `app-mcp/tests/test_guard.py` |
| 0.4 | Requester principal ticket: gateway mints, `hermes-tools-cli` verifies and maps to `--as`, `tool_cmd._resolve_operator` fails closed; dashboard tool routes act as the caller | `hermes_cli/principal_ticket.py` (new), `deploy/hermes-tools-cli`, `hermes_cli/tool_cmd.py` (operator resolution only), `hermes_cli/web_server.py` (`/api/tools*` caller resolution only), `tests/hermes_cli/test_fg33_principal_ticket.py`; ***human:*** the gateway mint point in `gateway/session_chat.py` (`build_session_agent`, one call to `principal_ticket.mint`) — `gateway/**` is Core, so the agent prepares this as a PR for a human |
| 0.5 | Registry MCP at chat start + transport fix: `apply_registry_endpoints`, `enabled`/`app_kind`/`secret_ref`/`forward_principal`, auth-type semantics, `destructiveHint` gate, `list_changed` next-chat-only for `la-*`/`xa-*` | `hermes_cli/mcp_endpoints.py`, `tools/registry_mcp.py` (new), `tools/mcp_tool.py`, `agent/agent_init.py` (one `apply_registry_endpoints` call next to the existing `tools.personal_mcp.apply_to_agent` call), `tests/tools/test_fg33_registry_mcp.py` |
| 0.6 | Registry schema: `kind='external'`, new `tools` columns, reserved names, promote round-trip test, `Tool`/`ToolKind` TS mirror | `hermes_cli/tools_registry.py`, `agent-home/src/types/index.ts`, `tests/hermes_cli/test_fg07_tools_registry_e2e.py` |
| 0.7 *ops* | Measure idle RSS (`docker stats`) for `supabase-db` and a GoTrue+PostgREST pair at the pinned digests; spike GoTrue v2.197 / storage-api v1.81 against a non-`postgres` DB with per-app roles; Realtime tenant check; record numbers in this doc | this doc (audit log + §3.4 table) |

### Phase P8-1 — Local runtime, database and template (Wave P8-B; after P8-0)

Needs open decisions 1, 2, 4, 5, 7, 8.

| # | Work item | Owns |
|---|---|---|
| 1.1 | Template files + `scaffold_in_house_tool(template=, hosting=, provider=)` keyword interface (the CLI flags themselves are wired by 1.4, which consumes this interface), exact pins from the root `package-lock.json` (agent-home workspace's resolved versions), `git init` (`main`/`dev`), HTTP `/api/mcp`, health route, icon, `supabase/migrations`, package-data | `hermes_cli/app_templates/**` (new), `hermes_cli/tool_scaffold.py`, `pyproject.toml` (package-data only), `tests/hermes_cli/test_fg07_tool_scaffold.py`, `tests/hermes_cli/test_fg33_template.py` |
| 1.2 | Runtime units + root helper: `aquarium-app@.service`, `aquarium-app-build@.service`, `aquarium-apps.slice`, `aquarium-build.slice`, `aquarium-app-helper` (allocate/build/start/stop/restart/route/unroute/set-secret/logs/status/remove), and **all** of `deploy/sudoers.d/aquarium-apps` — including the exact-argv lines for 1.3's `aquarium apps db create|migrate|status|suspend|drop`, landed first as an interface PR | `deploy/aquarium-app@.service`, `deploy/aquarium-app-build@.service`, `deploy/aquarium-apps.slice`, `deploy/aquarium-build.slice`, `deploy/aquarium-app-helper`, `deploy/sudoers.d/aquarium-apps`, `deploy/aquarium.slice` and `deploy/aquarium-db.slice` (new; the 6 GB parent and the 1 GB compose slice, §3.3), the install path: `deploy/install/lib.sh` (new `aq_install_app_runtime`: installs every `deploy/aquarium-*.{service,timer,slice}` by glob plus the helpers to `/usr/local/sbin` and `visudo -cqf` + `install -m 440` of the sudoers file, so later-phase units need no installer edit), `install-aquarium.sh` (one call to it), `deploy/hermes-deploy.sh` (a STALE warning block like the `hermes-tools`/`hermes-backup` ones, comparing the installed helper, units/slices and `/etc/sudoers.d/aquarium-apps` against the repo by the same glob), `tests/deploy/test_aquarium_app_helper.py`, `tests/deploy/test_aquarium_app_install.py` |
| 1.3 | Apps cluster + DB provisioner + backups: `supabase-apps-db` in the install layout, `aquarium apps db create|migrate|status|suspend|drop` (sudoers argv consumed from 1.2), per-DB backup/restore | `deploy/install/apps-db/**` (new), `deploy/aquarium.py`, `tests/deploy/test_aquarium_apps_db.py` |
| 1.4 | Python runtime layer + CLI verbs + API routes: `app_runtime.py` (wraps helpers), `hermes tool build|start|stop|restart|logs|status|preview|doctor`, the `tool new --template/--hosting/--provider` argparse flags (passed to 1.1's scaffold interface) and the matching `COMMANDS["new"]` allowlist in `deploy/hermes-tools-cli`, the other allowlist entries, the one `app.include_router(...)` line mounting 1.6's `quotas_api` router, `/api/tools/{name}/{build,start,stop,restart,logs,runtime,database}`, `DELETE`, local promotion plan in `promote_tool`, `app_databases`/`app_deployments`/`tool_runtime` tables | `hermes_cli/app_runtime.py` (new), `hermes_cli/app_store.py` (new; tables), `hermes_cli/tool_cmd.py`, `deploy/hermes-tools-cli`, `hermes_cli/web_server.py` (`/api/tools*` block + the single quotas router-mount line), `hermes_cli/tools_registry.py` (`promote_tool` only), `tests/hermes_cli/test_fg33_local_e2e.py` |
| 1.5 | Front door: agent-home forward_auth route (ticket + C2 `can_read`), principal header contract, Caddy include example | `agent-home/src/app/api/apps/auth/route.ts`, `agent-home/src/lib/apps/**` (new), `agent-home/deploy/Caddyfile.agent-home` (example import line + comment), `agent-home/src/lib/auth/route-roles.json` (one entry) |
| 1.6 | Quota policy: `app_quota.py`, root policy template, `quota_overrides`, `PUT /api/quotas/{user_id}` | `hermes_cli/app_quota.py` (new), `deploy/install/app-quotas.yaml.example` (new), `hermes_cli/quotas_api.py` (new router; mounted by 1.4), `tests/hermes_cli/test_fg33_quota.py` |
| 1.7 *ops* | Runbook in `leolau/aquarium-ops`: DNS record(s), the one Caddy import line, apps cluster install, `/etc/aquarium/app-quotas.yaml`, and the one-time root install on the existing prod box (it was not installed by the new `aq_install_app_runtime`): `visudo -cf` + `install -m 440` of `deploy/sudoers.d/aquarium-apps`, `install -m 755` of `aquarium-app-helper`/`aquarium-app-egress` to `/usr/local/sbin`, unit/slice files to `/etc/systemd/system`, `systemctl daemon-reload`; afterwards `deploy-hermes.sh` STALE warnings flag drift | private ops repo |

Coordination: 1.4 consumes 1.1/1.2/1.3/1.6 interfaces (scaffold kwargs, helper
spec + sudoers argv, `aquarium apps db` argv, `quotas_api.router`); land those as
small interface PRs first, or have 1.4 stub them behind
`app_runtime.HelperClient`.

### Phase P8-2 — Tools page, agent workflow, operations (Wave P8-C; after P8-1)

Needs open decisions 9, 15, 16, 17.

| # | Work item | Owns |
|---|---|---|
| 2.1 | Tools page v2: `AppGrid`/`AppTile`/`AppIcon`/`ProviderBadge`/`HealthDot`/`ToolActionsSheet`/`IconPicker`/`QuotaStrip`, i18n, `/tools/[name]`, BFF routes | `agent-home/src/components/tools/**`, `agent-home/src/app/tools/**`, `agent-home/src/app/api/tools/apps/[name]/route.ts` (GET, DELETE), `agent-home/src/app/api/tools/apps/[name]/{enabled,icon,favicon,feedback,start,stop,restart,build,logs,promote,egress,visibility,mcp}/route.ts` (and co-located `route.test.ts`), `agent-home/public/providers/**`, `agent-home/src/i18n/messages/{en,zh-Hant}/tools.json`, `agent-home/src/lib/auth/route-roles.json` (all P8-2 entries, including 2.7's `tools/apps/[name]/secrets`), `agent-home/src/components/projects/rawFetchGuard.test.ts` |
| 2.2 | Backend for the UI — owns **every** `/api/tools*` Python route in P8-2: moves 1.4's routes into the router, adds `GET /api/tools?include=health` (batch, 30 s cache, SSRF rules), `GET /api/tools/{name}`, `GET /api/tools/{name}/mcp`, `GET /api/tools/quota`, `PUT /api/tools/{name}/{icon,secrets,egress,mcp,visibility}` (secrets/egress call the helper via `app_runtime`), `POST …/{favicon-refresh,feedback}`, idempotency coverage, and the one `include_router` line for 2.4's lifecycle router | `hermes_cli/tools_api.py` (new router, moved out of `web_server.py`'s block), `hermes_cli/app_runtime.py` (`set_secret`/`set_egress` helper-client methods only), `hermes_cli/web_server.py` (`/api/tools*` block only — removing it and mounting `tools_api` and 2.4's `app_lifecycle_api`), `hermes_cli/projects_idempotency.py`, `tests/hermes_cli/test_fg33_tools_api.py` |
| 2.3 | Agent workflow: `vibe-code-app` skill (intake → project → clarify hosting → scaffold → kanban cards with the definition of done → preview → promote → update-later); update `create-in-house-tool` to point at it | `skills/software-development/vibe-code-app/**` (new), `skills/software-development/create-in-house-tool/SKILL.md` |
| 2.4 | Monitoring + alerts + lifecycle: `aquarium-apps-watch` timer, `app_watch.py`, NotificationStore alerts, Telegram helper move, lifecycle transitions, archive/purge/restore verbs (CLI + API, C6), and the `tool doctor` hook in the weekly drift check | `deploy/aquarium-apps-watch.service`, `deploy/aquarium-apps-watch.timer`, `hermes_cli/app_watch.py` (new), `hermes_cli/app_lifecycle_api.py` (new router: `POST /api/tools/{name}/{archive,purge,restore}`; mounted by 2.2), `hermes_cli/tool_cmd.py` (`archive|purge|restore` verbs only), `deploy/hermes-tools-cli` (keeps the three verbs off `COMMANDS`, with a refusal test), `scripts/lib/notify.py` (new), `scripts/check_runtime_drift.py`, `tests/hermes_cli/test_fg33_watch.py`, `tests/hermes_cli/test_fg33_lifecycle.py` |
| 2.5 | Capacity + drift globs + backup coverage: `capacity.py` apps bounds (incl. the apps compose cap), `DEFAULT_UNIT_GLOBS`, `SKIP_DIRS`, Caddy include in `backup_sources()` (the drift-check `tool doctor` hook is 2.4's) | `hermes_cli/capacity.py`, `scripts/deploy_state.py`, `deploy/aquarium.py` (`SKIP_DIRS`/`backup_sources()` only), `tests/scripts/test_deploy_state.py`, `tests/hermes_cli/test_fg33_capacity.py` |
| 2.6 | Egress + supply chain: helper-owned nftables table per cgroup, allowlisting proxy, C6 egress flow (the `PUT …/egress` route is 2.2's); fail-closed OSV mode over a lockfile | `deploy/aquarium-app-egress` (new), `deploy/sudoers.d/aquarium-apps` (the `aquarium-app-egress` argv lines only), `tools/osv_check.py`, `tests/deploy/test_aquarium_app_egress.py`, `tests/tools/test_osv_check.py` |
| 2.7 | Secrets form: agent-home secret entry (values never shown to the agent) → BFF → 2.2's `PUT /api/tools/{name}/secrets` → helper `set-secret`; Save button carries `data-appmcp-deny` | `agent-home/src/components/apps-secrets/**` (new), `agent-home/src/app/api/tools/apps/[name]/secrets/route.ts` (its `route-roles.json` entry is added by 2.1) |
| 2.8 | Projects link: app ↔ project (`project_links(kind='tool')`, `project_outputs kind='code'` deliveries `link_kind=url`), project `toolsets` attach `mcp-la-<slug>` | `hermes_cli/projects_links_apps.py` (new helper used by the skill), `tests/hermes_cli/test_fg33_project_link.py` |
| 2.9 | Coder profiles (§10): versioned `internal-coder` / `external-coder` definitions (SOUL, config overlay, skill list), `coder_profile_for`, the `tool set --coder-profile` verb, and the install runbook step | `deploy/profiles/internal-coder/**` (new), `deploy/profiles/external-coder/**` (new), `hermes_cli/app_coder.py` (new), `tests/hermes_cli/test_fg33_coder_profiles.py` (new); the `tool set` argparse lines in `hermes_cli/tool_cmd.py` are added through 2.4, which owns that file in P8-2 |

### Phase P8-3 — External apps v1: Vercel + supabase.com (Wave P8-D; after P8-2)

Needs open decisions 10, 11, 12, 13, 14.

| # | Work item | Owns |
|---|---|---|
| 3.1 | Verify current vendor APIs (Vercel deployments/env/domains/protection, Supabase Management API + OAuth) and record them; hosting base: `HostingAdapter`, `PROVIDERS`, `tool_hosting` table, CLI `tool deploy|status|logs` + allowlist, Python routes `POST /api/tools/{name}/{deploy,redeploy}` and `GET /api/tools/{name}/deployments`, external promotion plan in `promote_tool`, C5/C8 wiring | `hermes_cli/hosting/base.py`, `hermes_cli/tools_api.py` (deploy/redeploy/deployments routes only — the only P8-3 owner of this file), `hermes_cli/hosting/store.py`, `hermes_cli/hosting/__init__.py`, `hermes_cli/tool_cmd.py` (deploy verbs), `deploy/hermes-tools-cli`, `hermes_cli/tools_registry.py` (`promote_tool` external branch), `docs/design/hosting-provider-apis.md` (new), `tests/hermes_cli/test_fg33_hosting_base.py` |
| 3.2 | Default-or-own account choice per external tool (decision 10) and `hosting_accounts` with per-account caps (decision 13); Credential kinds + Settings: `vercel-token`, `supabase-management`, `supabase-project`, `hosting` service, OAuth start/complete for Supabase; Settings → Connected accounts "Hosting" group; move `supabase-cli` PAT off env passthrough | `hermes_cli/credential_store.py`, `hermes_cli/credentials_api.py`, `agent-home/src/components/settings/ConnectedAccounts.tsx`, `optional-skills/devops/supabase-cli/SKILL.md`, `tests/hermes_cli/test_fg33_credential_kinds.py` |
| 3.3 | Vercel adapter (REST file upload, preview/production, env, protection bypass, rollback, teardown) | `hermes_cli/hosting/vercel.py`, `tests/hermes_cli/hosting/test_vercel.py` |
| 3.4 | supabase.com adapter (projects dev/prod, keys, auth config, `db push` via pooler, pause/restore/delete) | `hermes_cli/hosting/supabase_com.py`, `tests/hermes_cli/hosting/test_supabase_com.py` |
| 3.5 | Per-project and per-account caps (§4.7); Status/spend timer + orphans: `aquarium-hosting-poll`, budget 80/100%, provider cost as C8 rows | `deploy/aquarium-hosting-poll.service`, `deploy/aquarium-hosting-poll.timer`, `hermes_cli/hosting/poll.py`, `tests/hermes_cli/hosting/test_poll.py` |
| 3.6 | Tools page external states: outlined tile data, deployments panel, Redeploy/console actions, connected-account empty state | `agent-home/src/components/tools/external/**` (new), `agent-home/src/app/api/tools/apps/[name]/{deployments,deploy,redeploy}/route.ts`, `agent-home/src/lib/auth/route-roles.json` (these three entries); Redeploy/teardown buttons carry `data-appmcp-deny` |
| 3.7 *ops* | Default accounts (decision 10): Leo creates the Vercel `aquarium-apps` team (Pro + Spend Management cap) and the supabase.com org (OAuth app or dedicated PAT); runbook in the ops repo | private ops repo |

### Phase P8-4 — More providers, lifecycle extras, launcher (Wave P8-E; after P8-3)

| # | Work item | Owns |
|---|---|---|
| 4.0 | Provider registration (lands first, small interface PR): `railway-token`, `aws-hosting`, `alibaba-cloud` credential kinds (`materialize=False`) and `PROVIDERS` entries for `railway`/`aws_amplify`/`alibaba_fc` pointing at the module paths 4.1–4.3 will fill | `hermes_cli/credential_store.py`, `hermes_cli/hosting/base.py` (`PROVIDERS` only), `hermes_cli/hosting/__init__.py`, `tests/hermes_cli/test_fg33_credential_kinds.py` |
| 4.1 | Railway adapter (GraphQL v2, dedicated workspace, env per mode, `errors[]`/Retry-After, suspend → dump → delete), using 4.0's `railway-token` kind | `hermes_cli/hosting/railway.py`, `tests/hermes_cli/hosting/test_railway.py` |
| 4.2 | AWS Amplify adapter (4.0's `aws-hosting` kind) + CloudFormation (deployer role, permissions boundary, compute role, Budget + deny action) + opt-in GitHub repo per app | `hermes_cli/hosting/aws_amplify.py`, `deploy/aws/aquarium-hosting.yaml`, `tests/hermes_cli/hosting/test_aws_amplify.py` |
| 4.3 | Alibaba FC 3.0 adapter (`cn-hongkong`, STS, ACR push from a capped on-box build, SLS, concurrency caps, idle-dev sweep), using 4.0's `alibaba-cloud` kind | `hermes_cli/hosting/alibaba_fc.py`, `tests/hermes_cli/hosting/test_alibaba_fc.py` |
| 4.4 | Export local → supabase.com and template upgrades (`template_version` diff, opt-in, C5), CLI `tool export|upgrade` and `POST /api/tools/{name}/{export,upgrade}` (C6) | `hermes_cli/app_export.py` (new), `hermes_cli/app_template_upgrade.py` (new), `hermes_cli/tool_cmd.py` (`export|upgrade` verbs only), `deploy/hermes-tools-cli` (keeps `export` off `COMMANDS`, with a refusal test), `hermes_cli/tools_api.py` (export/upgrade routes only), `tests/hermes_cli/test_fg33_export.py`, `tests/hermes_cli/test_fg33_template_upgrade.py` |
| 4.5 | Coral launcher pin (`category: "custom"` manifests from `tools` rows); optional embedded `webview` for local apps on their own origin; "open in editor" link to the box's opencode-web/qoder for humans | `agent-home/src/components/coral/coral-apps.ts`, `agent-home/src/app/api/apps/route.ts` (new — the Coral Phase-2 `/api/apps` merge in `coral-app-framework.md` §5.2 is not implemented; this builds it from `tools` rows, no `internal_apps` table), `agent-home/src/lib/auth/route-roles.json` (one entry), `agent-home/src/components/tools/OpenInEditor.tsx`, `agent-home/src/app/api/apps/route.test.ts` |

## Open decisions for Leo/Yan

Each has options and a recommendation an implementer can proceed on once
confirmed. None is silently picked. Note that under the B2 recommendation a
local app's default is its own **Postgres database**, with Supabase Auth/REST/
Storage per-app opt-in (decisions 1 and 2) — a departure from the literal
"own supabase database instance" that Leo/Yan should confirm.

1. **What "its own supabase database instance" means for a local app.** **Decided (Yan, 2026-10-25): "its own supabase DB", not its own instance. A is out; B2 is the design, with B as the fallback.** Options as analysed: (A) full Supabase docker stack per app and mode — ~2.2–3.8 GB RAM per app (estimate), **2–3 apps** on this box; (B) a database + NOBYPASSRLS role per app per mode inside the existing `supabase-db` — tens of MB, but app roles/WAL/connections sit on Aquarium's cluster and the provisioner needs superuser there; (B2) a dedicated apps Postgres cluster (~250–400 MB once, inside a 1 GB-capped apps compose project (`aquarium-db.slice`, inside the 6 GB `aquarium.slice` ceiling)) holding a database per app per mode, Supabase APIs opt-in per app — capacity is **~6 apps, disk-bound** (the §6 admission number, an estimate until P8-0 row 0.7; B is the same); (C) schema + role in the shared DB — shares `auth.users`, JWT secret, anon key; (D) plain Postgres, no Supabase. **Recommend B2**, A only as a per-app upgrade on a bigger or second box, numbers re-measured in P8-0.
2. **Supabase APIs and end-user auth for local apps.** Per-app GoTrue + PostgREST sidecars for every app (~0.1–0.2 GB per app) vs opt-in per app with Aquarium identity via forward_auth as the default. **Recommend opt-in**; Postgres always; Storage opt-in; no Realtime until a spike shows per-app tenants work on v2.143.3.
3. **Registry shape.** (a) keep `kind='in_house'` for both and add only a `hosting` column; (b) add `kind='external'` for provider-hosted apps, local stays `in_house` (+ `hosting`); (c) new kinds `local_app`/`external_app`; (d) reuse `remote`. **Recommend (b)** — `remote` already means FG-08 third-party OSS, and (c) renames D3's local case for no gain.
4. **Local app URL scheme and domain.** Path `/apps/<slug>` under `home.leolau.ai-and-i.io` (no DNS/Caddy churn, but app JS shares agent-home's origin and cookies) vs own origin per app. And which domain: a subdomain of `leolau.ai-and-i.io` (same-site with agent-home) vs a separate registrable domain. **Recommend own origin on a separate domain** if Leo can buy/point one; otherwise `*.apps.leolau.ai-and-i.io` with per-host HTTP-01 certs. Needs Leo for DNS.
5. **Runtime identity for local apps.** systemd `DynamicUser` per instance, a persistent `aq-app-<slug>` user per app, one shared apps user, or the existing `hermes-tools`. **Recommend `DynamicUser`** with root-owned built artifacts (nothing to clean up; per-app isolation).
6. **Local app MCP transport.** HTTP `/api/mcp` inside the app's own Next.js process vs keep the gateway-spawned stdio `mcp/server.mjs`. **Recommend HTTP in-app** (D3 one process; no app code as the gateway uid).
7. **Dev preview and idle policy.** Build-based dev preview started on demand + idle-stop (20–30 min) + one box-wide `next dev` live-edit slot, vs always-on `next dev` per app; prod always-on vs socket-activated. **Recommend build-based dev with idle-stop, one live-edit slot, prod always-on** (owner may opt a prod app into sleep).
8. **Quota defaults and where policy lives.** `config.yaml` (agent-editable, so advisory) vs root-owned `/etc/aquarium/app-quotas.yaml` + owner-only `quota_overrides`. **Recommend the root file**, with the §6 starting values (3 registered / 2 running local apps per member, 512 MB / 50% CPU per app, 1 GB RAM / 4 GB disk / 1 GB DB per member, apps slice 3 GB, 6 GB FG-33 ceiling, 3 GB box reserve) calibrated on the system-test box.
9. **Who may do what.** Members create and run private dev apps; prod, public URLs, sharing, paid resources and deletes need owner/admin + C6 — vs keeping all registry mutations admin-only as today. **Recommend the member-dev / admin-prod split** (§8).
10. **External accounts and credentials.** **Decided (Yan, 2026-10-25): default Vercel, Railway, AWS and Alibaba Cloud accounts (plus the default supabase.com org); each external tool's author chooses default or their own account (§4.2).** Options as analysed: Dedicated owner-managed Aquarium accounts per provider with tokens in `materialize=False` credential kinds used only by in-process adapters, vs each user's own accounts, vs root-only token files under `/etc/aquarium/providers`. **Recommend dedicated owner-managed accounts in v1**, bring-your-own later via the same kinds.
11. **Provider order.** **Recommend Vercel + supabase.com first**, then Railway, AWS Amplify (App Runner is closed to new customers; Amplify SSR needs a GitHub repo per app), Alibaba FC 3.0 in `cn-hongkong` (no ICP; mainland later with a China-site account).
12. **supabase.com dev/prod mapping.** Two projects per app (any plan; mirrors C3) vs a persistent dev branch (Pro; ~USD 10/mo per branch) vs dev/prod schemas in one project. The research sections disagreed. **Recommend two projects**, branching later; confirm the cost of a second project.
13. **External spend policy.** **Decided (Yan, 2026-10-25): a cap for each project and for each account (§4.7).** Options as analysed: **Recommend:** provider-side hard cap/budget action mandatory before connecting (Vercel Spend Management, Railway workspace hard limit, Supabase spend cap, AWS Budgets deny action); `approval_usd` = 0 so every paid resource needs approval; per-member monthly cap 0 until the owner sets one; Alibaba (alert-only budgets) only with concurrency caps. Confirm the default per-app budget (sections proposed USD 20–50).
14. **Per-app git remote.** Local git repo always (`main`/`dev`, tags `vN`) vs also pushing to a GitHub org. **Recommend local by default**, GitHub only on user opt-in through C6 or when the provider needs it (AWS Amplify, optionally Railway); Leo names the org.
15. **Who writes the code.** **Decided (Yan, 2026-10-25): new `internal-coder` and `external-coder` profiles, used by default and overridable per tool (§10).** Options as analysed: Dispatcher-spawned kanban workers with Hermes' own file/terminal tools (+ inline for tiny edits, OpenCode opt-in) vs wiring the box's `opencode-web`/`qoder-daemon` into the agent. **Recommend kanban workers**; keep opencode-web/qoder as a human "open in editor" link only.
16. **Default hosting mode.** **Recommend Local pre-selected** in one clarify question, switching to External only when the user mentions a public URL, custom domain, scale or a named provider.
17. **Which app MCPs a chat gets.** Every enabled app the principal can see vs apps attached to the active project plus explicitly enabled ones. **Recommend project-attached + explicit**; `list_changed` applies next chat only; app read tools ungated for the owner and gated when shared.
18. **System-test host.** The Alibaba `hermes-systest` ECS still named in FG docs vs a small Hetzner box mirroring prod. **Recommend a Hetzner system-test box**; restarting `supabase-db` and deploy-survival tests must never run on prod.
19. **Prerequisites before any local app ships.** **Recommend** Leo confirms `terminal.run_as: hermes-tools` on prod and approves the human PR adding `agent-home/**`, `app-mcp/**`, `deploy/**` and the FG-33 Core paths to `core_manifest.yaml` (P8-0 items 0.1/0.2). Without these, a vibe-coding worker could edit the main UI or read every secret.
20. **Record a locked decision D21.** D3 has two modes (remote OSS, in-house); external hosting of agent-built apps on third-party PaaS is a third. **Recommend adding D21** ("vibe-coded apps: local = D3 in-house with its own database, one Node process per app per mode (dev idle-stopped); external = same template on approved providers, C6-gated spend") to README §1 when this plan is accepted. D21 also **scopes D4**: "D4's self-hosted Supabase applies to Aquarium-hosted data; external apps use provider-hosted Supabase (supabase.com)". Both the D3 extension and the D4 scoping are pending Leo/Yan.
21. **Disk headroom for local apps.** At §6 defaults (~2.5 GB per app) only ~6 apps fit before FG-31's 80% watch line on the 150 GB disk (44 GB free). Options: (a) attach a Hetzner Cloud Volume (e.g. 100 GB, a few EUR/month) mounted for `/var/lib/aquarium-apps`, the apps cluster volume and build caches; (b) lower per-app disk (shared npm cache, prune releases to 2, 250 MB DBs) to reach ~10; (c) accept ~6. **Recommend (a)** before P8-1 ships if more than a handful of apps is expected, with (b)'s release pruning regardless; Leo owns the Hetzner change.

## Dependencies

- **Blocked by:** FG-07 (registry, scaffolder), FG-08 (`hermes_cli/oss_acquisition.py::HostRunner` Protocol, `oss_host.py::SSHHostRunner`, provenance shape), FG-11 (`mcp_endpoints`), FG-12 (C5/C6), FG-13 (C3), FG-14 (C7), FG-16 (C8), FG-20 (agent-home), FG-31 (capacity), FG-32 (Projects, runs, kanban workspaces) — all merged. Open decisions 1, 3, 5, 6, 10, 18, 19, 20 block P8-0/P8-1.
- **Touches:** FG-01/FG-26 (roles), FG-27 (schemas untouched by design), Coral launcher (`docs/design/coral-app-framework.md` §5).
- **Blocks:** nothing scheduled.

## Definition of Done

- Per phase: tests green + `tests/plan_baseline/` green + `ruff`/`ty` + agent-home lint/typecheck/vitest clean; new web components carry `data-component`; no new non-secret `HERMES_*` env vars; no new core model tool; Core paths listed in `core_manifest.yaml`; that phase's system-test checklist passes on the system-test box.
- Feature: a member can ask in chat for an app and get (local) a Next.js app in its own Node process with its own dev and prod database, reachable only after login on its own origin, or (external) the same template on Vercel with supabase.com; both appear on `/tools` with distinct icons; promotion is C6-gated and C5-logged and moves no data; the agent can use each app over MCP from the next chat; quotas, backups, monitoring and teardown cover every app; every open decision above is answered and recorded in README §1/§9.

## Progress checklist

- [ ] P8-0.1 Core boundary PR (human)
- [ ] P8-0.2 `run_as: hermes-tools` confirmed; `DATABASE_URL` stripped
- [ ] P8-0.3 app-mcp guard deny markers
- [ ] P8-0.4 Requester principal ticket
- [ ] P8-0.5 Registry MCP at chat start + transport fix
- [ ] P8-0.6 Registry schema (`external`, columns, reserved names, round-trip)
- [ ] P8-0.7 Measurements + GoTrue/PostgREST spike recorded
- [ ] P8-1.1 Template files + scaffold flags
- [ ] P8-1.2 Runtime units + `aquarium-app-helper`
- [ ] P8-1.3 Apps cluster + DB provisioner + backups
- [ ] P8-1.4 `app_runtime` + CLI verbs + API + local promotion
- [ ] P8-1.5 Front door (forward_auth, Caddy include)
- [ ] P8-1.6 Quota policy + admission
- [ ] P8-1.7 Ops runbook (DNS, Caddy import, apps cluster)
- [ ] P8-1 system test passed
- [ ] P8-2.1 Tools page v2
- [ ] P8-2.2 Tools API (batch health, icons, feedback, idempotency)
- [ ] P8-2.3 `vibe-code-app` skill
- [ ] P8-2.4 Monitoring, alerts, lifecycle
- [ ] P8-2.5 Capacity + drift + backup coverage
- [ ] P8-2.6 Egress policy + fail-closed supply chain
- [ ] P8-2.7 Secrets form
- [ ] P8-2.8 Projects link
- [ ] P8-2.9 Coder profiles (`internal-coder`, `external-coder`)
- [ ] P8-2 system test passed
- [ ] P8-3.1 Vendor API verification + hosting base
- [ ] P8-3.2 Credential kinds + Settings hosting group
- [ ] P8-3.3 Vercel adapter
- [ ] P8-3.4 supabase.com adapter
- [ ] P8-3.5 Status/spend poll + orphans
- [ ] P8-3.6 Tools page external states
- [ ] P8-3.7 Provider accounts set up (ops)
- [ ] P8-3 system test passed
- [ ] P8-4.0 Provider registration (credential kinds + `PROVIDERS`)
- [ ] P8-4.1 Railway adapter
- [ ] P8-4.2 AWS Amplify adapter
- [ ] P8-4.3 Alibaba FC adapter
- [ ] P8-4.4 Export + template upgrades
- [ ] P8-4.5 Coral launcher pin / editor link
- [ ] P8-4 system test passed

## Audit log

| Date | Edition | Author | FG | Change | Rationale |
|------|---------|--------|----|--------|-----------|
| 2026-10-25 | 1 | devin:workflow | FG-33 | Created FG doc (PLAN): merged sixteen research sections (inventory, agent workflow, template, local runtime, local database, MCP access, Tools UX, external hosting, Vercel/Railway/AWS/Alibaba/supabase.com deep dives, security, quotas, operations) into one design, five phases with file-owned work items, and twenty open decisions. Contradictions resolved toward what the code supports: app units named `aquarium-app@` (a `hermes-*` unit would be restarted by `hermes-deploy.sh`), own origin per app (path routing shares agent-home's cookies), quota policy in a root-owned file (`config.yaml` is Customizable), source stays in `$HERMES_HOME/tools/<slug>` (repo `apps/` is an npm workspace), HTTP MCP in-app (stdio runs as the gateway uid), one `hermes tool` CLI. | Yan: "I want to allows users to vibe code within Aquarium but with two different approaches … Please create a plan first." |
| 2026-10-25 | 2 | devin:workflow | FG-33 | Review fixes: corrected citations (`hermes-embed.service` caps vs `agent-home.service` hardening; `HostRunner` lives in `oss_acquisition.py`; deploy-verification test path; FG-20 §6 is not a privacy rule); pins taken from the resolved `package-lock.json`; one admission number (N ≈ 6, disk-bound, estimate) used in §3.4/§6/decision 1, apps compose project capped at 1.5 GB and counted; D21 now scopes D4; Summary states the B2 Postgres-default; new open decision 21 (disk headroom); file ownership made disjoint (flags/allowlist and quotas mount → 1.4, all sudoers → 1.2, drift hook → 2.4, `deploy/aquarium.py` → 2.5, `web_server.py` for 0.4/2.2, `agent/agent_init.py` for 0.5, gateway mint marked human, secrets route renamed under `tools/apps/`, route-roles entries for 3.6/4.5, new 4.0 for provider registration). | Reviewer findings on edition 1. |
| 2026-10-25 | 3 | devin:workflow | FG-33 | Second review fixes: `guard.py` already has `CONSENT_WORDS` + `data-appmcp-deny` (0.3 narrowed to the new verbs); dropped the unsupported Vercel `buy_*` claim; `/api/apps` marked new (Coral Phase-2 not implemented); hard 6 GB `aquarium.slice` ceiling with a 3 GB box reserve enforced by admission, build and live-edit share one slot; disjoint route ownership (2.1 vs 2.7; `tools_api.py` owned by 2.2 in P8-2, 3.1 in P8-3, 4.4 in P8-4); CLI/API/test files on 2.4 and 4.4; install path + drift warning on 1.2 and root install steps on 1.7; provider ids `vercel`/`railway`/`aws_amplify`/`alibaba_fc` everywhere; `tools/mcp_tool.py` gate is the enforcement and `approvals.tools` an extra layer; D3 dev + prod units stated; FG-33 added to README §5 | — |
| 2026-10-25 | 4 | devin (for Yan) | FG-33 | Recorded Yan's answers to open decisions 1, 10, 13 and 15: own Supabase database, not instance (B2); default Vercel/Railway/AWS/Alibaba Cloud accounts (+ default supabase.com org), default-or-own per external tool; a spend cap per project and per account (§4.7, `hosting_accounts`); `internal-coder` / `external-coder` profiles with per-tool `coder_profile` override (§10, new item 2.9). | Yan: "1. sorry, not its own supabase instance, I meant its own supabase DB; 2. create a default vercel, railway, AWS and Alibaba Cloud accounts. And for each external tool, author can decide to use the default one or to use their own accounts; 3. yes, please create a cap for each project and for each account; 4. create a new profile as an internal coder and another one as the external coder. Each tool will use these as default or can override it;" |

## Cloud-agent prompts (one per phase)

> **[FG-33 P8-0 — Prerequisites and contracts. Start after Leo/Yan answer FG-33 open decisions 1, 3, 5, 6, 10, 18, 19, 20.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item. Read `AGENTS.md`, `docs/design/master-plan/README.md` and `docs/design/master-plan/feature-groups/FG-33-vibe-coded-apps-local-and-external.md` (this doc) in full. Implement Phase P8-0 items 0.3–0.6 (0.1, 0.2 and 0.7 are human/ops: prepare 0.1 as a PR for a human to review, never apply Core changes through the agent's own file tools). Own **only** the files listed for your item. 0.3: add `deploy`/`publish`/`make live`/`redeploy`/`unlink` to the existing `CONSENT_WORDS` in `app-mcp/app_mcp/guard.py` (approve/allow/deny/grant/authorize/consent are already there; the `data-appmcp-deny` page marker already exists) so neither `app_act` nor `app_act_destructive` can press them; list existing "Publish" controls this affects in the PR. `delete` stays only in `DESTRUCTIVE_WORDS`, so every new Delete/teardown button must carry `data-appmcp-deny` (added by 2.1/2.7/3.6). 0.4: a gateway-minted HMAC principal ticket (pattern `app-mcp/app_mcp/ticket.py`) verified by `deploy/hermes-tools-cli` and mapped to `--as`; `tool_cmd._resolve_operator` fails closed without it; dashboard `/api/tools*` routes act as the caller; the mint call in `gateway/session_chat.py` is Core, so prepare it as a separate PR for a human. 0.5: wire `mcp_endpoints.resolve_server_configs` into chat start (one call in `agent/agent_init.py`, next to `personal_mcp.apply_to_agent`) via `apply_registry_endpoints` modelled on `tools/personal_mcp.py` (pin the set in `sessions.model_config._registry_mcp`; next-chat-only); fix `transport.auth` to mean the auth type; add `enabled`, `app_kind`, `secret_ref`, `forward_principal`; additive gate in `tools/mcp_tool.py` that routes `destructiveHint` or `action_*` tools of `la-*`/`xa-*` servers through `tools.approval` — the enforcement, independent of the opt-in `plugins/tool-approval`; `list_changed` from `la-*`/`xa-*` logged only. 0.6: widen `tools.kind` to include `external`, add the FG-33 Data-model columns, reserved names, and a test that `promote_tool` round-trips every `_COLUMNS` field; mirror types in `agent-home/src/types/index.ts`. Never break prompt caching; no new core model tool; no new non-secret `HERMES_*` env vars; behaviour/invariant tests only. Run `scripts/run_tests.sh`, `ruff`, `ty` (and agent-home lint/typecheck/vitest if touched). Update only your row in FG-33's Progress checklist and append one audit-log row. Open a PR linking FG-33. Not done until the P8-0 system-test checklist passes on the system-test box — coordinate with Leo.

> **[FG-33 P8-1 — Local runtime, database and template. Start after every P8-0 PR has merged and open decisions 1, 2, 4, 5, 7, 8 are answered.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (1.1–1.6; 1.7 is ops). Read `AGENTS.md`, the master-plan README and FG-33 §2, §3, §6, Data model, Security. Own **only** your item's files. 1.1: move scaffold templates to `hermes_cli/app_templates/{minimal,nextjs-supabase}/` (package-data; `minimal` byte-identical), add the `template/hosting/provider` scaffold keyword interface (flags are 1.4's), exact pins taken from the root `package-lock.json` resolved versions for the agent-home workspace (test asserts exact equality), `git init` with `main`/`dev`, HTTP MCP at `app/api/mcp/route.ts` with bearer, `/api/health`, generated `app/icon.png`, `supabase/migrations`. 1.2: `deploy/aquarium-app@.service` (DynamicUser, slice, caps, hardening as in FG-33 §3.3 — never a `hermes-*` name), build unit + slices under a parent `aquarium.slice` `MemoryMax=6G` (apps 3G, shared build/live-edit 2G, compose 1G), the install path (`aq_install_app_runtime` in `deploy/install/lib.sh` by glob, one call in `install-aquarium.sh`, a STALE drift warning in `deploy/hermes-deploy.sh`), stdlib root helper `deploy/aquarium-app-helper` in the `hermes-vpn-helper` style with a validated JSON spec, port allocation as `hermes-wa-bridge-add`, Caddy include writer that refuses blocks without `forward_auth`, sudoers with exact argv. 1.3: the apps Postgres cluster and `aquarium apps db create|migrate|status|suspend|drop` in `deploy/aquarium.py` (per-app roles, CONNECTION LIMIT, statement_timeout, REVOKE CONNECT, root-0600 DSNs, prod verbs require an approved `approval_ref`), and per-DB backup/restore. 1.4: `hermes_cli/app_runtime.py`, `hermes tool build|start|stop|restart|logs|status|preview|doctor`, the `tool new --template/--hosting/--provider` flags + `COMMANDS["new"]` allowlist, other allowlist entries, the one router-mount line for 1.6's `quotas_api`, `/api/tools/{name}/…` routes, `app_databases`/`app_deployments`/`tool_runtime`, and the local promotion plan inside `promote_tool` (tag, prod migration with pg_dump, symlink flip, restart, copy endpoint row; inverse_op the FG-12 engine accepts). 1.5: agent-home `/api/apps/auth` forward_auth route (ticket + C2 `can_read`). 1.6: `hermes_cli/app_quota.py` reading root-owned `/etc/aquarium/app-quotas.yaml` + owner-only `quota_overrides`; admission refuses `start`/`build` past the 6 GB `aquarium.slice` ceiling or below the 3 GB box reserve. Tests per FG-33 Testing requirements (incl. stubbed-systemctl deploy tests, `visudo -c`, C2 negatives, throwaway-Postgres E2E). Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-1 system-test checklist passes on the system-test box (never prod) — coordinate with Leo.

> **[FG-33 P8-2 — Tools page, agent workflow, operations. Start after every P8-1 PR has merged and open decisions 9, 15, 16, 17 are answered.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (2.1–2.9). Read `AGENTS.md`, the README and FG-33 §1, §5, §7, §8, §9. Own **only** your item's files. 2.1: agent-home `/tools` as an icon grid — "On this box" (solid squircle + box badge), "Hosted elsewhere" (outlined circle + provider badge + ↗), "Helpers & services" (today's rows) — with `AppIcon`/`AppTile`/`AppGrid`/`ProviderBadge`/`HealthDot`/`ToolActionsSheet`/`IconPicker`/`QuotaStrip`, `data-component` on every root, `tools.json` i18n (en, zh-Hant), `/tools/[name]`, the BFF routes enumerated in FG-33 row 2.1 (not 2.7's `secrets` or 3.6's deploy routes) with `route-roles.json` entries, `data-appmcp-deny` on approve/make-live/delete buttons, all writes via `useProjectAction`/`ActionButton`; widen `rawFetchGuard.test.ts` to `components/tools/`. 2.2: owns every `/api/tools*` Python route in P8-2 (moved into `hermes_cli/tools_api.py`): `GET /api/tools?include=health` (one registry read, parallel probes, 30 s cache, SSRF rules), `GET /api/tools/{name}`, `…/mcp`, `GET /api/tools/quota`, `PUT …/{icon,secrets,egress,mcp,visibility}`, favicon/feedback routes, mounting 2.4's lifecycle router; add `/api/tools/` to `projects_idempotency._covers`. 2.3: `skills/software-development/vibe-code-app/SKILL.md` — intake → FG-32 project → one clarify for hosting (Local default) → scaffold → kanban cards with `--workspace dir:` and the definition of done (`npm run check`, MCP handshake, screenshot) → preview → promote → update-later. 2.4: `aquarium-apps-watch` timer, NotificationStore alerts (dedupe), Telegram helper in `scripts/lib/`, lifecycle with C6 for archive/purge, `archive|purge|restore` in `tool_cmd.py` (kept off the `hermes-tools-cli` allowlist) and `hermes_cli/app_lifecycle_api.py`. 2.4 also adds the `tool doctor` hook to the weekly drift check. 2.5: capacity bounds, drift globs, `SKIP_DIRS`/`backup_sources()` in `deploy/aquarium.py`. 2.6: helper-owned nftables egress + fail-closed OSV. 2.7: secrets form at `src/app/api/tools/apps/[name]/secrets/route.ts` (2.1 adds its `route-roles.json` entry). 2.8: project ↔ app links. 2.9: the `internal-coder` / `external-coder` profile definitions and `coder_profile_for` (FG-33 §10); the skill (2.3) assigns every build card to that profile. Run the full gate incl. agent-home vitest; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-2 system-test checklist passes on the system-test box — coordinate with Leo.

> **[FG-33 P8-3 — External apps v1: Vercel + supabase.com. Start after every P8-2 PR has merged, open decisions 10–14 are answered and Leo has created the Vercel team and supabase.com org (item 3.7).]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (3.1–3.6). Read `AGENTS.md`, the README and FG-33 §4, §5, Security. Own **only** your item's files. 3.1 first: verify the current Vercel and Supabase Management APIs against vendor docs and record them in `docs/design/hosting-provider-apis.md`; add `hermes_cli/hosting/base.py` (`HostingAdapter`, `PROVIDERS`), `tool_hosting`, `hermes tool deploy|status|logs` (allowlisted; `teardown` never allowlisted), `POST /api/tools/{name}/{deploy,redeploy}` + `GET …/deployments` in `hermes_cli/tools_api.py`, and the external branch of `promote_tool` (dry-run in the approval, adapter `promote()`, `xa-<slug>` http endpoint to prod). 3.2: `vercel-token`, `supabase-management`, `supabase-project` kinds (`materialize=False`, validators), a `hosting` service, Settings → Connected accounts "Hosting" group; take `SUPABASE_ACCESS_TOKEN` off env passthrough. 3.3: Vercel adapter — REST file upload, preview = dev, promote the approved preview to production, env per target (`sensitive`), protection bypass for probes, rollback as inverse_op, teardown. 3.4: supabase.com adapter — dev and prod projects, keys, auth `site_url`/allow list, `db push` via the pooler, pause/restore/delete. 3.5: `aquarium-hosting-poll` timer (status, budget 80/100%, provider cost as C8 rows, orphans). 3.6: external tile states and BFF `deployments`/`deploy`/`redeploy` routes (Python side is 3.1's, in `tools_api.py`). Adapters run in-process, never in the agent shell; every mutation C5, every call C8; durable `reversible=False` approvals per FG-33 §4.4; mocked-HTTP tests only in CI. Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-3 system-test checklist passes against sandbox accounts — coordinate with Leo.

> **[FG-33 P8-4 — More providers, lifecycle extras, launcher. Start after every P8-3 PR has merged and Leo has set up the Railway workspace, AWS member account and Alibaba `cn-hongkong` account.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (4.0–4.5; 4.0 lands first). Read `AGENTS.md`, the README and FG-33 §4.3 (provider table), §9, Open decisions 11–14. Own **only** your item's files. 4.1: Railway adapter on GraphQL v2 (dedicated workspace token, project tokens per env, `errors[]` on HTTP 200, Retry-After, no retry of mutations, suspend → pg_dump → `projectDelete` with 2 approvals). 4.2: AWS Amplify adapter (STS AssumeRole with ExternalId, branches `dev`/`main`, GitHub repo per app on opt-in, Budget + deny action via `deploy/aws/aquarium-hosting.yaml`, `DeleteApp` with 2 approvals, tag sweep). 4.3: Alibaba FC 3.0 adapter (`cn-hongkong`, STS 900 s, capped on-box image build → ACR, concurrency caps, idle-dev sweep, mandatory custom domain). 4.4: `hermes tool export <slug> --to supabase` and opt-in template upgrades (`tool_cmd.py` verbs kept off the allowlist, `tools_api.py` export/upgrade routes, `tests/hermes_cli/test_fg33_export.py` + `test_fg33_template_upgrade.py`). 4.5: Coral launcher pin from `tools` rows via a new BFF `src/app/api/apps/route.ts` (the Coral Phase-2 `/api/apps` merge is not implemented yet; no `internal_apps` table) and a human "open in editor" link. 4.0 alone adds the `railway-token`/`aws-hosting`/`alibaba-cloud` credential kinds (`materialize=False`) to `hermes_cli/credential_store.py` and the `PROVIDERS` entries in `hermes_cli/hosting/`; 4.1–4.3 own only their adapter module and tests. Mocked-SDK/HTTP tests in CI; one live smoke per provider on throwaway resources with a zero-resource tag sweep. Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-4 system-test checklist passes — coordinate with Leo.
