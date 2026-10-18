# Session Hand-off — agent-home (FG-20) built + deployed (2026-07)

> **Purpose:** let the next agent (or human) resume without re-deriving state.
> This note is **operational** — the design source of truth remains
> [`master-plan/README.md`](./master-plan/README.md) (decisions D1–D16,
> contracts C1–C9, FG index, gates, append-only §9 changelog) and
> [`FG-20-agent-home-nextjs-supabase.md`](./master-plan/feature-groups/FG-20-agent-home-nextjs-supabase.md).
> The prior operational note
> [`SESSION-HANDOFF-2026-07-prod-cutover.md`](./SESSION-HANDOFF-2026-07-prod-cutover.md)
> still holds for the base prod-box/DNS/TLS/gateway facts — **read it first**;
> this file layers the **agent-home** state on top and records the newer frontier.
>
> Author: devin:8cec0d47 (for Leo). Product name: **ai-prentice-4-all** (built on Hermes).

---

## 0. TL;DR of current state

- **agent-home is BUILT and LIVE.** The new mobile-first Next.js PWA
  (**FG-20**) is deployed on the prod box and reachable at
  **<https://<agent-home-host>>** (HTTPS via Caddy/Let's Encrypt → Next on
  `127.0.0.1:3100`). All of Wave A/B/C landed and merged to `develop`.
- **Two front-ends coexist** (Decision 3A): `agent-home` = the user/mobile face
  (all Phase-2 user panels); `web/` (served at `<dashboard-host>`) stays the
  operator/admin console. Both hit the **same** Python API + Supabase.
- **Repo renamed** `leolau/hermes-agent` → **`leolau/aquarium`** (old
  URLs auto-redirect). Local checkout is still `/home/ubuntu/repos/hermes-agent`.
- **Dashboard owner password was rotated** (the earlier exposed-in-chat item is
  resolved; plaintext never stored — scrypt hash + fresh signing secret).
- **Multi-user is COMPLETE + verified in prod (2026-07-27).** The full
  **PR-1..PR-5** series is merged (identity binding + least-privilege DB role
  #55, Supabase/GoTrue email-password provider #56, member management #57,
  agent-home Members UI #58, private storage / signed URLs #60+#61) plus the
  **step-7** crash-safe `agent_home_app` read-role (#62). The owner Supabase
  login is live, signup is closed, the serving DB role is switched, the media
  bucket is private, and end-to-end member isolation (DB + storage) was proven
  with a throwaway synthetic member and then cleaned up. See §6 and
  [`MULTI_USER_HANDOFF.md`](../../MULTI_USER_HANDOFF.md) → "Production rollout
  — COMPLETED". **Onboarding a real 2nd member is now fully unblocked.**
- **Owner-gated, NOT done:** FG-20 ECS system-test; broader prod promotion of the
  still-`develop`-only FGs; live WhatsApp/email round-trip.

---

## 1. Where the code is

- **Repo:** `leolau/aquarium` (GitHub auto-redirects the old
  `leolau/hermes-agent`). Default working branch: **`develop`**.
- **Local checkout on the agent VM:** `/home/ubuntu/repos/hermes-agent`
  (directory name intentionally unchanged; the remote is repointed).
- **`develop` HEAD at hand-off:** `5d1af871b` — "Merge pull request #57 …
  multiuser-pr3-member-mgmt". (agent-home Wave A→C = PRs #43–#53; responsive
  desktop = #54; multi-user = #55/#56/#57.)
- **The prod box's agent-home clone** is a **separate** checkout at
  `/opt/data/agent-home-app` (a real git clone of `develop`, unlike the
  `/opt/data/hermes-agent` copied tree which has no `.git`). At hand-off it was
  deployed at commit `6fcfffa` (PR #54); redeploy to pull newer `develop`.

---

## 2. agent-home (FG-20) — what shipped

New app at repo root: **`agent-home/`** (sibling of `web/`; `web/` untouched).
Architecture is fixed (**D16**): **Next.js UI → Python AI layer (`/api/*`) →
Supabase (Postgres + Storage + RLS)**, BFF pattern — the Next server holds the
authenticated **C1 principal** context, proxies authority ops to the Python API,
and does server-side Supabase reads under the principal's RLS context. The
browser never gets a service-role key or bypasses C1/C2/C6/C8.

### Waves (all merged)
- **Wave A** (PR #43) — mobile-first Next.js 15 App-Router shell (bottom-nav,
  safe-area, 44px targets, PWA manifest + service worker + offline shell,
  `data-component` babel plugin) + the **auth/data seam**: C1 principal bridge
  (reuses `dashboard_auth`, signed HttpOnly `agent_home_session` cookie,
  principal via `/api/comms/whoami`), server-side Supabase context
  (`withPrincipalContext` sets `hermes.principal_*` GUCs + C3 `search_path` so
  Postgres FORCE'd RLS enforces C2), typed Python-API client (`HermesApiClient`),
  shared types, RLS-scoped Realtime stub. Deploy artifacts landed in #44/#45.
- **Wave B1** (PR #46) — read-only mobile **GTS Centre** at `/graph` over
  `GET /api/gts/graph` (C2 + FG-19 `item_grants` enforced upstream).
- **Wave B2** (PR #47) — read-only **Core-area view** at `/core` +
  **C8 interaction-trace timeline** at `/activity` (+ `/activity/[traceId]`).
- **Wave B3** (PR #48 tools-mode; B3 feature commit) — **onboarding** wizard +
  readiness at `/onboarding` + **tool registry** at `/tools` (read-only).
- **Wave C1** (PR #49 backend + #50 UI) — **one-brain chat** pane at `/chat`.
  Backend added `POST /api/sessions/{id}/chat` in `hermes_cli/web_server.py`
  (principal-scoped; extracted the shared agent builder into
  `gateway/session_chat.py` so the api_server adapter and the dashboard build the
  **identical** one-brain agent — cache-/alternation-safe, no synthetic user
  message, system prompt not rebuilt mid-conversation). Attachments upload
  **server-side** to principal-scoped Supabase Storage (`<user_id>/<session>/…`)
  via a server-only `SUPABASE_SERVICE_ROLE_KEY`; browser never holds a storage key.
- **Wave C2** (PR #51) — **agent-webview** console at `/webview` over the existing
  FG-17b `/api/webview/*` (Option-B session-scoped consent + escalation, C2 CDP
  profile isolation, C8 trace; consent decided server-side, never in the browser).
- **Wave C3** (PR #52, +#53 undo-409 UI) — comms **Inbox** at `/inbox`
  (FG-10 notifications + FG-12 change undo/redo) — the first interactive-write
  mobile surface; cross-surface parity met (Telegram-answered items dedupe).
- **Responsive desktop** (PR #54) — desktop/responsive polish on top.

### Routes present in `agent-home/src/app`
`/login`, `/` (seam proof: principal + one RLS-scoped read), `/graph`,
`/activity` (+ `/activity/[traceId]`), `/core`, `/onboarding`, `/tools`, `/chat`,
`/webview`, `/inbox`, plus BFF route handlers under `/api/{session,chat,webview,comms}/*`.

### FG-20 remaining (owner-gated) — in the FG-20 doc's Progress checklist
- [ ] tests (parity + mobile/PWA + negative-access RLS + C6 + cache-safety) green
- [ ] **System test on the ECS** — **owner-gated**

> Invariants respected across all waves: `web/` untouched, **zero** new core model
> tools, **zero** new non-secret `HERMES_*` env vars (only new env is the
> `SUPABASE_SERVICE_ROLE_KEY` **secret** + `AGENT_HOME_*` non-secret topology
> values, since a Node server can't read the Python `config.yaml`). Authority
> writes go through the Python API; TS never re-implements C1/C2/C6/C8 logic.

---

## 3. agent-home deployment (live) — how it's served

- **Subdomain:** `<agent-home-host>` → Cloudflare A record `47.83.199.25`
  (DNS-only/unproxied, matching the dashboard record). Caddy fetches the LE cert.
- **Caddy** (`/etc/caddy/Caddyfile`) has a second site block:
  ```caddy
  <agent-home-host> {
      encode zstd gzip
      reverse_proxy 127.0.0.1:3100
  }
  ```
  Do **not** split `/api/*` to `:9119` here — agent-home's own `/api/session/*`
  BFF routes must go to Next; the Python API stays private on loopback.
- **Port 3100** (not 3000 — `:3000` is the WhatsApp bridge).
- **systemd:** `agent-home.service` (enabled, `Restart=on-failure`), runs
  `next start` from `/opt/data/agent-home-app/agent-home`, secrets from a
  non-committed `agent-home/agent-home.env` (0600 — NOT `.env.production`, which
  Next's dotenv-expand would choke on). Verified **active (running)**, listening
  on `127.0.0.1:3100`, local `GET /` → 307 → `/login`, public HTTPS 200 on `/login`.
- **Deployed with `AGENT_HOME_DATASTORE_MODE=prod`** (reads `app_prod`).
- **Full runbook + unit + Caddy snippet:** `agent-home/deploy/`
  (`DEPLOY.md`, `agent-home.service`, `Caddyfile.agent-home`, `start.sh`).

### Redeploy agent-home (owner-gated)
```bash
APP_DIR=/opt/data/agent-home-app
cd "$APP_DIR" && git fetch origin develop && git checkout develop && git reset --hard origin/develop
npm ci && npm run build -w agent-home
systemctl restart agent-home.service
# verify: curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/   # -> 307
```

> ✅ **RLS caveat — RESOLVED (step 7, 2026-07-27):** agent-home no longer
> connects as `postgres` (BYPASSRLS). Its `DATABASE_URL` now points at a
> dedicated **`agent_home_app`** login role — `LOGIN NOSUPERUSER NOBYPASSRLS`,
> granted `SELECT` only on RLS-forced tables (fail-closed on the rest) — so
> Postgres FORCE'd RLS enforces C2 on its direct reads. Verified live: as the
> role, `owner`-bound reads see all `app_prod.interactions` (380) while a
> synthetic member sees 0 (private:leo_owner), and non-RLS identity tables are
> denied. Python/migrations/CLI keep the privileged DSN. Reproduce the role with
> `hermes owner read-role` (password from `$HERMES_APP_READ_DB_PASSWORD`).
> The membership-grant path (`GRANT hermes_app TO CURRENT_USER`) is avoided — it
> faults the Supabase event trigger; `hermes owner db-role` now takes
> `grant_membership=False` for such builds.

---

## 4. Reaching the box (no SSH key on file)

Use the `aliyun` CLI → ECS RunCommand (Cloud Assistant). Creds are in the agent
VM env (`ALIBABA_CLOUD_ACCESS_KEY_ID` / `_SECRET`). Helper on the agent VM:
```bash
bash /home/ubuntu/runbox.sh i-j6c81aisv2dd8mg17yle <script-file>
```
The `alibabacloud` MCP server is down — use the `aliyun` CLI path. Prod box:
`hermes-systest`, `i-j6c81aisv2dd8mg17yle`, `47.83.199.25`, cn-hongkong, 4 vCPU /
16 GB, `/opt/data`. (Full infra/DNS/TLS/gateway facts:
`SESSION-HANDOFF-2026-07-prod-cutover.md`.)

Operational helper scripts used this session live on the agent VM under
`/home/ubuntu/ecs-scripts/` and `/home/ubuntu/runbox.sh` — **not** in the repo;
recreate/commit if needed in future sessions.

---

## 5. Telegram / auth quick facts

- **Bot the owner talks to:** `@ai_prentice_systest_01_bot` — always-on
  `hermes-gateway.service` on the prod box; owner Telegram ID `8756039695`
  allowlisted (`telegram.allow_from`), everyone else denied; model DeepSeek.
- **agent-home / dashboard login:** username `admin` + the **rotated** password
  (scrypt `password_hash` in the box `config.yaml` under `dashboard.basic_auth`;
  the token-signing `secret` was rotated too, invalidating old sessions).
  Config backup: `/opt/data/hermes-home-staging/config.yaml.bak-20260721-235219`.
- **PWA install:** open `https://<agent-home-host>` → iOS Safari
  Share → *Add to Home Screen*; Android Chrome ⋮ → *Install app*.

---

## 6. Multi-user workstream — COMPLETE + verified in prod (PR-1..PR-5 + step-7; NOT FG-20)

The **PR-1..PR-5** multi-user sequence (plus step-7) is fully merged, deployed,
and verified end-to-end in production (2026-07-27). Full detail lives in
[`MULTI_USER_HANDOFF.md`](../../MULTI_USER_HANDOFF.md). Summary of the shipped
pieces:
- **PR-1 (#55) — security foundation:** login→own-principal identity binding +
  idempotent non-`BYPASSRLS` `hermes_app` DB role (`hermes owner db-role` /
  `hermes owner alias`). Unenrolled subject fails closed (409), never upgraded to owner.
- **PR-2 (#56) — Supabase/GoTrue email+password dashboard-auth provider** (a step
  toward the D4 GoTrue direction — note FG-20's C1 bridge deliberately deferred
  browser-direct GoTrue; reconcile the two auth paths).
- **PR-3 (#57) — member management:** GoTrue admin backend + `hermes member` CLI.
- **PR-4 (#58) — agent-home Members UI:** owner/admin `/members` screen + BFF
  routes (double-guarded: BFF UX gate + Python authority 403).
- **PR-5 (#60, +lint #61) — private storage / signed URLs (MERGED + DEPLOYED):**
  the `agent-home-media` bucket is **private**; `GET /api/chat/media?path=…`
  mints short-lived signed URLs only after a server-side path-ownership check
  (`canReadMediaPath`, own-only for every role, fail-closed on traversal /
  foreign prefixes). The browser never holds a storage key.
- **Step 7 (#62) — crash-safe `agent_home_app` read-role (MERGED + DEPLOYED):**
  see §3; provisioned by `hermes owner read-role`.

**Owner-gated deploy steps — ALL DONE (2026-07-27):** owner Supabase alias set,
`dashboard.supabase_auth` configured, `GOTRUE_DISABLE_SIGNUP=true`, serving DB
role switched to the non-BYPASSRLS `agent_home_app`, and the media bucket flipped
private. Isolation verification (throwaway synthetic member) passed on both the
DB path (owner sees all; member sees shared+own only; stranger sees shared only)
and the storage path (member 200 on own object with real bytes; 403 on owner's
object; 403 traversal; 404 own-missing; 401 unauth), then the member was
deactivated and hard-deleted. Owner data intact (380 interactions).

---

## 7. Open follow-ups (owner-gated)

0. ✅ **DONE (2026-07-27) — full multi-user rollout + isolation verification.**
   PR-1..PR-5 + step-7 deployed to prod; owner Supabase login live; signup
   closed; serving DB role switched to `agent_home_app`; media bucket private;
   DB + storage member isolation proven E2E with a throwaway member (then
   removed). See §6 and `MULTI_USER_HANDOFF.md`. **Onboarding a real 2nd member
   is unblocked** — `hermes member add <email> --role member` or the agent-home
   Members UI.
1. **FG-20 ECS system-test** on `hermes-systest` (staging/`app_dev`, never
   `app_prod`) — parity + mobile/PWA + negative-access RLS + C6 + cache-safety.
2. ✅ **DONE (step 7):** dedicated non-BYPASSRLS `agent_home_app` role
   provisioned and agent-home repointed at it; live RLS enforcement verified
   (see §3). Onboarding a non-owner member is now fully unblocked (PR-5 private
   storage is also deployed + verified — item 0).
3. **Rotate the owner's temp Supabase password** — the temp password issued
   during enrollment passed through Aliyun Cloud Assistant once; change it on
   first login (`hermes member set-password` exists for members; owner sets it
   via GoTrue).
4. **Broader prod promotion:** only 10 FGs were promoted in the cutover
   (03/04/05/08/11/12/15/16/17/18); still `develop`-only for prod:
   **FG-01, 06, 07, 09, 10, 13, 14, 19** — remaining work is system-test +
   promotion, not new code.
5. **Live WhatsApp/email round-trip** + auto-reply/SMTP — pending channel creds.
6. Decide keep/decommission the stopped old box (`8.217.86.90`, kept for rollback).
7. **FG-02 blockchain** stays ON HOLD unless the owner resumes it.
8. Reconcile agent-home's C1 bridge auth with the new GoTrue email/password
   provider (§6) so there's one coherent auth story.

---

## 8. Constraints to respect (from `AGENTS.md` / master plan)

- Prompt-cache safety: system prompt byte-stable within a conversation; strict
  role alternation; never inject a synthetic user message mid-loop.
- The core is a narrow waist — no new core model tools without clearing the
  footprint ladder; `.env` = secrets only, behavioral config in `config.yaml`.
- Core is immutable to the runtime agent (C7, fail-closed); every meaningful
  interaction traced end-to-end (C8 `trace_id`) — traces are side-channel, never
  injected into prompts.
- Never weaken access control / RLS or Core write-protection to make something
  work. Real-path E2E (incl. negative-access RLS) for security/datastore/network
  changes; assert invariants, not snapshots. Preserve contributor authorship.
- `web/` stays the operator console; `agent-home/` is the user/mobile face; both
  hit the same Python API + Supabase. `agent-home` is Core under C7 — the runtime
  agent cannot modify it.
- Request GitHub user `leolau` as reviewer on every PR.
