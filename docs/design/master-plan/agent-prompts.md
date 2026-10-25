# Parallel Devin cloud-agent prompts

One prompt per feature group. **Launch order = waves** (see
[`README.md` §5](./README.md)). Do **not** start an FG until every FG it is
*blocked by* has merged.

**Phase 1 (FG-01–13):**
- **Wave 0 (foundations, merge first):** FG-13, FG-01, FG-05
- **Wave 1:** FG-03, FG-04, FG-06, FG-11, FG-12
- **Wave 2:** FG-07, FG-08, FG-10
- **Wave 3:** FG-09

**Phase 2 (FG-14–19, reqs 14.0–19.0 — start after Phase-1 `develop` merges):**
- **Wave A (foundations, publish contracts first):** FG-14 (C7), FG-16 (C8)
- **Wave B:** FG-18 (C9), FG-17a (dashboard parity port), FG-15
- **Wave C:** FG-19, FG-17b (dashboard new panels)

- **ON HOLD (not scheduled):** FG-02 (blockchain) — paused per Leo; do not launch until the owner resumes it. No downstream dependents.

**Phase 8 (FG-33 vibe-coded apps — PLAN; start after Leo/Yan answer its open decisions):**
- **Wave P8-A → P8-E**, strictly in order: P8-0 prerequisites/contracts → P8-1 local runtime, database, template → P8-2 Tools page, agent workflow, operations → P8-3 external v1 (Vercel + supabase.com) → P8-4 more providers. Work items inside a phase run in parallel, one PR each, each owning the files listed in FG-33.

Each agent: own branch off `develop`; edit **only its own** `feature-groups/FG-XX-*.md`
(progress checklist + audit log); keep `tests/plan_baseline/` green; add its own
FG tests; run `scripts/run_tests.sh`, `ruff`, `ty` (and web lint/typecheck if it
touches `web/`); open a PR linking its FG doc. The full, always-authoritative
prompt for each FG lives at the bottom of that FG's doc under **"Cloud-agent
prompt"** — the entries below are copies for convenience.

**System testing:** an FG is not done until, after its code is developed, its
**"System testing (system-test box)"** checklist (in its FG doc) passes on the
new hermes-systest ECS (`47.83.199.25`, the dedicated system-test host — never
the prod schema). See
[`README.md` §7.1](./README.md). Coordinate that deploy/run with Leo.

---

## Wave 0

### FG-13 — dev/prod mode + datastore router (C3)
See [`feature-groups/FG-13-dev-prod-mode.md`](./feature-groups/FG-13-dev-prod-mode.md) → *Cloud-agent prompt*.

### FG-01 — multi-user access (C1, C2)
See [`feature-groups/FG-01-multi-user-access.md`](./feature-groups/FG-01-multi-user-access.md) → *Cloud-agent prompt*.

### FG-05 — embedding memory + concurrency
See [`feature-groups/FG-05-embedding-memory-concurrency.md`](./feature-groups/FG-05-embedding-memory-concurrency.md) → *Cloud-agent prompt*.

## Wave 1

### FG-03 — multi-channel redesign (C4)
See [`feature-groups/FG-03-multi-channel-redesign.md`](./feature-groups/FG-03-multi-channel-redesign.md) → *Cloud-agent prompt*.

### FG-04 — goals + priority + measurability
See [`feature-groups/FG-04-goals-priority-measurability.md`](./feature-groups/FG-04-goals-priority-measurability.md) → *Cloud-agent prompt*.

### FG-06 — task discovery + progress
See [`feature-groups/FG-06-task-discovery-progress.md`](./feature-groups/FG-06-task-discovery-progress.md) → *Cloud-agent prompt*.

### FG-11 — agent comms MCP
See [`feature-groups/FG-11-agent-comms-mcp.md`](./feature-groups/FG-11-agent-comms-mcp.md) → *Cloud-agent prompt*.

### FG-12 — change management (C5, C6)
See [`feature-groups/FG-12-change-management.md`](./feature-groups/FG-12-change-management.md) → *Cloud-agent prompt*.

## Wave 2

### FG-07 — tools creation + dashboard
See [`feature-groups/FG-07-tools-creation-dashboard.md`](./feature-groups/FG-07-tools-creation-dashboard.md) → *Cloud-agent prompt*.

### FG-08 — OSS remote + in-house
See [`feature-groups/FG-08-oss-copy-mcp.md`](./feature-groups/FG-08-oss-copy-mcp.md) → *Cloud-agent prompt*.

### FG-10 — human comms (Telegram + web)
See [`feature-groups/FG-10-human-comms.md`](./feature-groups/FG-10-human-comms.md) → *Cloud-agent prompt*.


## Wave 3

### FG-09 — goal management integration
See [`feature-groups/FG-09-goal-management.md`](./feature-groups/FG-09-goal-management.md) → *Cloud-agent prompt*.

---

# Phase 2 (reqs 14.0–19.0)

## Wave A

### FG-14 — Core/Customizable boundary (C7)
See [`feature-groups/FG-14-core-customizable-boundary.md`](./feature-groups/FG-14-core-customizable-boundary.md) → *Cloud-agent prompt*.

### FG-16 — action tracking & traceability (C8)
See [`feature-groups/FG-16-action-tracking-traceability.md`](./feature-groups/FG-16-action-tracking-traceability.md) → *Cloud-agent prompt*.

## Wave B

### FG-18 — GTS Centre (C9)
See [`feature-groups/FG-18-gts-centre.md`](./feature-groups/FG-18-gts-centre.md) → *Cloud-agent prompt*.

### FG-17 — dashboard → Next.js + embedded Telegram + agent webview
See [`feature-groups/FG-17-dashboard-nextjs-face.md`](./feature-groups/FG-17-dashboard-nextjs-face.md) → *Cloud-agent prompt*. (17a parity port in Wave B; 17b new panels in Wave C.)

### FG-15 — easy onboarding
See [`feature-groups/FG-15-easy-onboarding.md`](./feature-groups/FG-15-easy-onboarding.md) → *Cloud-agent prompt*.

## Wave C

### FG-19 — per-user GTS isolation + cross-user assignment
See [`feature-groups/FG-19-gts-per-user-isolation-assignment.md`](./feature-groups/FG-19-gts-per-user-isolation-assignment.md) → *Cloud-agent prompt*.

---

# Phase 8 (FG-33 — vibe-coded apps: local and external)

One prompt per phase; the authoritative copies live at the bottom of [`feature-groups/FG-33-vibe-coded-apps-local-and-external.md`](./feature-groups/FG-33-vibe-coded-apps-local-and-external.md) → *Cloud-agent prompts*. Launch a phase only after every PR of the previous phase has merged and the open decisions it names are answered. Inside a phase, launch one agent per work item.

## FG-33 P8-0 — prerequisites and contracts

> **[FG-33 P8-0 — Prerequisites and contracts. Start after Leo/Yan answer FG-33 open decisions 1, 3, 5, 6, 10, 18, 19, 20.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item. Read `AGENTS.md`, `docs/design/master-plan/README.md` and `docs/design/master-plan/feature-groups/FG-33-vibe-coded-apps-local-and-external.md` (this doc) in full. Implement Phase P8-0 items 0.3–0.6 (0.1, 0.2 and 0.7 are human/ops: prepare 0.1 as a PR for a human to review, never apply Core changes through the agent's own file tools). Own **only** the files listed for your item. 0.3: add `deploy`/`publish`/`make live`/`redeploy`/`unlink` to the existing `CONSENT_WORDS` in `app-mcp/app_mcp/guard.py` (approve/allow/deny/grant/authorize/consent are already there; the `data-appmcp-deny` page marker already exists) so neither `app_act` nor `app_act_destructive` can press them; list existing "Publish" controls this affects in the PR. `delete` stays only in `DESTRUCTIVE_WORDS`, so every new Delete/teardown button must carry `data-appmcp-deny` (added by 2.1/2.7/3.6). 0.4: a gateway-minted HMAC principal ticket (pattern `app-mcp/app_mcp/ticket.py`) verified by `deploy/hermes-tools-cli` and mapped to `--as`; `tool_cmd._resolve_operator` fails closed without it; dashboard `/api/tools*` routes act as the caller; the mint call in `gateway/session_chat.py` is Core, so prepare it as a separate PR for a human. 0.5: wire `mcp_endpoints.resolve_server_configs` into chat start (one call in `agent/agent_init.py`, next to `personal_mcp.apply_to_agent`) via `apply_registry_endpoints` modelled on `tools/personal_mcp.py` (pin the set in `sessions.model_config._registry_mcp`; next-chat-only); fix `transport.auth` to mean the auth type; add `enabled`, `app_kind`, `secret_ref`, `forward_principal`; additive gate in `tools/mcp_tool.py` that routes `destructiveHint` or `action_*` tools of `la-*`/`xa-*` servers through `tools.approval` — the enforcement, independent of the opt-in `plugins/tool-approval`; `list_changed` from `la-*`/`xa-*` logged only. 0.6: widen `tools.kind` to include `external`, add the FG-33 Data-model columns, reserved names, and a test that `promote_tool` round-trips every `_COLUMNS` field; mirror types in `agent-home/src/types/index.ts`. Never break prompt caching; no new core model tool; no new non-secret `HERMES_*` env vars; behaviour/invariant tests only. Run `scripts/run_tests.sh`, `ruff`, `ty` (and agent-home lint/typecheck/vitest if touched). Update only your row in FG-33's Progress checklist and append one audit-log row. Open a PR linking FG-33. Not done until the P8-0 system-test checklist passes on the system-test box — coordinate with Leo.

## FG-33 P8-1 — local runtime, database and template

> **[FG-33 P8-1 — Local runtime, database and template. Start after every P8-0 PR has merged and open decisions 1, 2, 4, 5, 7, 8 are answered.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (1.1–1.6; 1.7 is ops). Read `AGENTS.md`, the master-plan README and FG-33 §2, §3, §6, Data model, Security. Own **only** your item's files. 1.1: move scaffold templates to `hermes_cli/app_templates/{minimal,nextjs-supabase}/` (package-data; `minimal` byte-identical), add the `template/hosting/provider` scaffold keyword interface (flags are 1.4's), exact pins taken from the root `package-lock.json` resolved versions for the agent-home workspace (test asserts exact equality), `git init` with `main`/`dev`, HTTP MCP at `app/api/mcp/route.ts` with bearer, `/api/health`, generated `app/icon.png`, `supabase/migrations`. 1.2: `deploy/aquarium-app@.service` (DynamicUser, slice, caps, hardening as in FG-33 §3.3 — never a `hermes-*` name), build unit + slices under a parent `aquarium.slice` `MemoryMax=6G` (apps 3G, shared build/live-edit 2G, compose 1G), the install path (`aq_install_app_runtime` in `deploy/install/lib.sh` by glob, one call in `install-aquarium.sh`, a STALE drift warning in `deploy/hermes-deploy.sh`), stdlib root helper `deploy/aquarium-app-helper` in the `hermes-vpn-helper` style with a validated JSON spec, port allocation as `hermes-wa-bridge-add`, Caddy include writer that refuses blocks without `forward_auth`, sudoers with exact argv. 1.3: the apps Postgres cluster and `aquarium apps db create|migrate|status|suspend|drop` in `deploy/aquarium.py` (per-app roles, CONNECTION LIMIT, statement_timeout, REVOKE CONNECT, root-0600 DSNs, prod verbs require an approved `approval_ref`), and per-DB backup/restore. 1.4: `hermes_cli/app_runtime.py`, `hermes tool build|start|stop|restart|logs|status|preview|doctor`, the `tool new --template/--hosting/--provider` flags + `COMMANDS["new"]` allowlist, other allowlist entries, the one router-mount line for 1.6's `quotas_api`, `/api/tools/{name}/…` routes, `app_databases`/`app_deployments`/`tool_runtime`, and the local promotion plan inside `promote_tool` (tag, prod migration with pg_dump, symlink flip, restart, copy endpoint row; inverse_op the FG-12 engine accepts). 1.5: agent-home `/api/apps/auth` forward_auth route (ticket + C2 `can_read`). 1.6: `hermes_cli/app_quota.py` reading root-owned `/etc/aquarium/app-quotas.yaml` + owner-only `quota_overrides`; admission refuses `start`/`build` past the 6 GB `aquarium.slice` ceiling or below the 3 GB box reserve. Tests per FG-33 Testing requirements (incl. stubbed-systemctl deploy tests, `visudo -c`, C2 negatives, throwaway-Postgres E2E). Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-1 system-test checklist passes on the system-test box (never prod) — coordinate with Leo.

## FG-33 P8-2 — Tools page, agent workflow, operations

> **[FG-33 P8-2 — Tools page, agent workflow, operations. Start after every P8-1 PR has merged and open decisions 9, 15, 16, 17 are answered.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (2.1–2.9). Read `AGENTS.md`, the README and FG-33 §1, §5, §7, §8, §9. Own **only** your item's files. 2.1: agent-home `/tools` as an icon grid — "On this box" (solid squircle + box badge), "Hosted elsewhere" (outlined circle + provider badge + ↗), "Helpers & services" (today's rows) — with `AppIcon`/`AppTile`/`AppGrid`/`ProviderBadge`/`HealthDot`/`ToolActionsSheet`/`IconPicker`/`QuotaStrip`, `data-component` on every root, `tools.json` i18n (en, zh-Hant), `/tools/[name]`, the BFF routes enumerated in FG-33 row 2.1 (not 2.7's `secrets` or 3.6's deploy routes) with `route-roles.json` entries, `data-appmcp-deny` on approve/make-live/delete buttons, all writes via `useProjectAction`/`ActionButton`; widen `rawFetchGuard.test.ts` to `components/tools/`. 2.2: owns every `/api/tools*` Python route in P8-2 (moved into `hermes_cli/tools_api.py`): `GET /api/tools?include=health` (one registry read, parallel probes, 30 s cache, SSRF rules), `GET /api/tools/{name}`, `…/mcp`, `GET /api/tools/quota`, `PUT …/{icon,secrets,egress,mcp,visibility}`, favicon/feedback routes, mounting 2.4's lifecycle router; add `/api/tools/` to `projects_idempotency._covers`. 2.3: `skills/software-development/vibe-code-app/SKILL.md` — intake → FG-32 project → one clarify for hosting (Local default) → scaffold → kanban cards with `--workspace dir:` and the definition of done (`npm run check`, MCP handshake, screenshot) → preview → promote → update-later. 2.4: `aquarium-apps-watch` timer, NotificationStore alerts (dedupe), Telegram helper in `scripts/lib/`, lifecycle with C6 for archive/purge, `archive|purge|restore` in `tool_cmd.py` (kept off the `hermes-tools-cli` allowlist) and `hermes_cli/app_lifecycle_api.py`. 2.4 also adds the `tool doctor` hook to the weekly drift check. 2.5: capacity bounds, drift globs, `SKIP_DIRS`/`backup_sources()` in `deploy/aquarium.py`. 2.6: helper-owned nftables egress + fail-closed OSV. 2.7: secrets form at `src/app/api/tools/apps/[name]/secrets/route.ts` (2.1 adds its `route-roles.json` entry). 2.8: project ↔ app links. 2.9: the `internal-coder` / `external-coder` profile definitions and `coder_profile_for` (FG-33 §10); the skill (2.3) assigns every build card to that profile. Run the full gate incl. agent-home vitest; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-2 system-test checklist passes on the system-test box — coordinate with Leo.

## FG-33 P8-3 — external apps v1 (Vercel + supabase.com)

> **[FG-33 P8-3 — External apps v1: Vercel + supabase.com. Start after every P8-2 PR has merged, open decisions 10–14 are answered and Leo has created the Vercel team and supabase.com org (item 3.7).]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (3.1–3.6). Read `AGENTS.md`, the README and FG-33 §4, §5, Security. Own **only** your item's files. 3.1 first: verify the current Vercel and Supabase Management APIs against vendor docs and record them in `docs/design/hosting-provider-apis.md`; add `hermes_cli/hosting/base.py` (`HostingAdapter`, `PROVIDERS`), `tool_hosting`, `hermes tool deploy|status|logs` (allowlisted; `teardown` never allowlisted), `POST /api/tools/{name}/{deploy,redeploy}` + `GET …/deployments` in `hermes_cli/tools_api.py`, and the external branch of `promote_tool` (dry-run in the approval, adapter `promote()`, `xa-<slug>` http endpoint to prod). 3.2: `vercel-token`, `supabase-management`, `supabase-project` kinds (`materialize=False`, validators), a `hosting` service, Settings → Connected accounts "Hosting" group; take `SUPABASE_ACCESS_TOKEN` off env passthrough. 3.3: Vercel adapter — REST file upload, preview = dev, promote the approved preview to production, env per target (`sensitive`), protection bypass for probes, rollback as inverse_op, teardown. 3.4: supabase.com adapter — dev and prod projects, keys, auth `site_url`/allow list, `db push` via the pooler, pause/restore/delete. 3.5: `aquarium-hosting-poll` timer (status, budget 80/100%, provider cost as C8 rows, orphans). 3.6: external tile states and BFF `deployments`/`deploy`/`redeploy` routes (Python side is 3.1's, in `tools_api.py`). Adapters run in-process, never in the agent shell; every mutation C5, every call C8; durable `reversible=False` approvals per FG-33 §4.4; mocked-HTTP tests only in CI. Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-3 system-test checklist passes against sandbox accounts — coordinate with Leo.

## FG-33 P8-4 — more providers, lifecycle extras, launcher

> **[FG-33 P8-4 — More providers, lifecycle extras, launcher. Start after every P8-3 PR has merged and Leo has set up the Railway workspace, AWS member account and Alibaba `cn-hongkong` account.]** Repo `leolau/aquarium`, branch off `develop`, one PR per work item (4.0–4.5; 4.0 lands first). Read `AGENTS.md`, the README and FG-33 §4.3 (provider table), §9, Open decisions 11–14. Own **only** your item's files. 4.1: Railway adapter on GraphQL v2 (dedicated workspace token, project tokens per env, `errors[]` on HTTP 200, Retry-After, no retry of mutations, suspend → pg_dump → `projectDelete` with 2 approvals). 4.2: AWS Amplify adapter (STS AssumeRole with ExternalId, branches `dev`/`main`, GitHub repo per app on opt-in, Budget + deny action via `deploy/aws/aquarium-hosting.yaml`, `DeleteApp` with 2 approvals, tag sweep). 4.3: Alibaba FC 3.0 adapter (`cn-hongkong`, STS 900 s, capped on-box image build → ACR, concurrency caps, idle-dev sweep, mandatory custom domain). 4.4: `hermes tool export <slug> --to supabase` and opt-in template upgrades (`tool_cmd.py` verbs kept off the allowlist, `tools_api.py` export/upgrade routes, `tests/hermes_cli/test_fg33_export.py` + `test_fg33_template_upgrade.py`). 4.5: Coral launcher pin from `tools` rows via a new BFF `src/app/api/apps/route.ts` (the Coral Phase-2 `/api/apps` merge is not implemented yet; no `internal_apps` table) and a human "open in editor" link. 4.0 alone adds the `railway-token`/`aws-hosting`/`alibaba-cloud` credential kinds (`materialize=False`) to `hermes_cli/credential_store.py` and the `PROVIDERS` entries in `hermes_cli/hosting/`; 4.1–4.3 own only their adapter module and tests. Mocked-SDK/HTTP tests in CI; one live smoke per provider on throwaway resources with a zero-resource tag sweep. Run the full gate; update your checklist row + one audit row; PR linking FG-33. Not done until the P8-4 system-test checklist passes — coordinate with Leo.

---

## Orchestration note (automatic launch)
The orchestrator session can spawn these as **child sessions wave-by-wave**:
launch Wave 0 (3 agents) → wait for their PRs to merge (contracts C1–C6 land) →
launch Wave 1 (5 agents) → Wave 2 (3 agents) → Wave 3 (1 agent). Never launch
all at once — Waves 1–3 build on Wave-0 contracts and would collide on the
god-files otherwise. **FG-02 (blockchain) is on hold** and is not part of this
sequence until the owner resumes it.

**Phase 2:** after Phase-1 `develop` is merged, run the same pattern — Wave A
(FG-14, FG-16) publishes contracts C7/C8 first (plus FG-17a's parity port can
start in parallel), then Wave B (FG-18, FG-15 + FG-17a), then Wave C (FG-19,
FG-17b). Publish C7/C8/C9 as small interface PRs before Wave-B/C consumers to
avoid god-file collisions. FG-17 must re-run the FG-07/FG-10 system tests.
