# Aquarium: packaging, getting-ready guide, security — plan and handoff


Status: **resumed 2026-10-18** with 16 parallel sub-agents (one per track, coordinator https://app.devin.ai/sessions/a7006e16318c4047b9b432fc8348091e). Nothing is deployed to production yet. Start here, then `git log origin/develop` for anything merged after this date.

Every PR must keep the existing Hetzner box working (Leo, 2026-10-18) and has an "Existing Hetzner box: what changes" section, checked against a read-only inventory of the box (services, ports, sudoers, env-file names, Caddy, MCP config, `MEDIA:` history).

## Progress (as of 2026-10-18, second run)

| Item | State | PRs |
|---|---|---|
| Plan + 7 decisions | done | sections below |
| Phase 0: git-history secret scan | **done, nothing to rotate** (gitleaks v8.21.2 over 13,622 commits: only upstream fixtures/placeholders) | |
| Phase 0: move production/handoff/security docs to a private repo | **waiting on Leo**: new `leolau/aquarium-ops` or `docs/` in `leolau/aquarium-deploy-state` | |
| Phase 0: GitHub secret scanning + push protection + Dependabot | **waiting on Leo** (repo admin): https://github.com/leolau/aquarium/settings/security_analysis | |
| GitHub Actions | **done**: Actions was on; `ci.yml` only ran on `main`. Now runs on PRs/pushes to `develop` and `main`; upstream-only jobs guarded. the 19 pre-existing develop failures + docs MDX error are fixed in #569 (MCP structured-content ones by #560/#563) | #548, #569 |
| Release pipeline (`vX.Y.Z` tag → tested, signed tarball + `SHA256SUMS` + cosign + `channels.json`) | **done, never run for real** (first tag `v0.1.0-rc.1` waits on Leo) | #550 |
| Installer: verified release installs, pins, VPN/WhatsApp components | **done** | #544 |
| Installer: one-time first-run link (replaces owner password in a file) | PR open; page itself is P2 | #555 |
| Installer E2E on a throwaway Hetzner VM | **passes** after 2 fixes (pgvector race, gateway stop timeout); CI install test needs `HCLOUD_TOKEN` secret | #566, #567 |
| `aquarium` admin command (status/update/backup/restore/doctor/logs/migrate-layout/uninstall) | PR open. Production stays on `deploy-hermes.sh` until Leo decides when to run `migrate-layout` (suggested: after the first v1.x release passed on a throwaway VM) | #561 |
| F1 custom servers | merged + compatibility follow-up for the box | #538, #553 |
| F2 role checks + route authz test (480 dashboard + 201 agent-home routes) | PR open | #556 |
| F3 file-response XSS + agent-home security headers | PR open | #554 |
| F4 app-mcp | merged (+ #551 keeps live `app` config working), test fix #560 | #543, #551, #560 |
| F5, F9 | merged earlier | #536, #535 |
| F6 inbox facts out of shared MEMORY.md | PR open | #557 |
| F7 + F22 `/yolo` owner/admin, approvals bound to requester | merged | #546 |
| F8 WhatsApp bridge shell/media path | merged | #541 |
| F10 skill scanner | merged | #539 |
| F12 low items (Telegram escaping, image plugin, …) | PR open; upload cap waits on Leo | #552 |
| F13 + F15 root-owned deploy, safe root jobs | PR open; deploy migrates ownership itself and writes `rollback.sh` | #545 |
| F14 WhatsApp bridge helper | merged | #540 |
| F16 secrets out of the agent's terminal, env files to `/etc/aquarium` | PR open; `DATABASE_URL` A/B/C waits on Leo | #562 |
| F17 + F18 app-mcp self-approval / trusted-import | PR open | #547 |
| F19 app-mcp token on `127.0.0.1:9220` | PR open (token in `$HERMES_HOME/auth/`) | #563 |
| F20 | fixed earlier | #520, #521 |
| F21 strict media delivery (keeps `cache/images`, `exports/**` working) | PR open | #558 |
| F23 untrusted `@file` expansion | merged | #549 |
| F24 Caddy admin API off TCP | PR open | #564 |
| F25 tirith pin | merged | #542 |
| F11 Electron desktop | out of scope (not shipped to customers) | |
| S2 security scans in CI + release gate | release gate PR open; scans workflow blocked: Devin's git proxy can't push `.github/workflows/` (waits on Leo) | #559 |
| S2 prompt-injection red-team suite (31 attacks, fake model) | PR open; 9 expected-fail for still-open findings | #565 |
| P2 mockups | **awaiting Leo's approval** (session https://app.devin.ai/sessions/f678183ff18944bbad62cd53f7c43abc) | |
| G1 written guide (EN + 繁中) | not started (after P2 screens) | |

### Open decisions for Leo
1. Private docs repo choice; P2 mockup approval; GitHub security settings.
2. Upload cap in agent-home (unlimited / 5 GiB / 1 GiB, reject before reading) — #552.
3. #555: merge now (fresh installs get a link to a page not built yet) or hold until P2.
4. Push `v0.1.0-rc.1` to test signing/publishing.
5. F16: keep `DATABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in the agent terminal for now (B, recommended), remove (A), or remove + config opt-in (C).
6. Workflow-file pushes: GH_TOKEN directly, give the Devin GitHub app `workflow` permission, or Leo adds them.
7. RT-14: require approval for every agent-typed `sudo`, or log as F26.
8. Old Telegram merge/keep buttons sent before #538 return 403 — OK?
9. Follow-ups: hide admin buttons for members in `web/`; bind Feishu/Teams/QQ/WhatsApp Cloud approval buttons to the requester.
10. `HCLOUD_TOKEN` repo secret (separate Hetzner project) for the install test.

### Existing Hetzner box notes (read-only inventory, 2026-10-18)
- Deploy entry point is the hand-installed `/opt/data/deploy-hermes.sh` (differs from `deploy/hermes-deploy.sh`); repo changes to the deploy script reach the box only when it is recopied.
- `hermes-secret-backup.service` is failed; Supabase Docker ports 5432/6543/8000/8443 are published on `0.0.0.0` and UFW is inactive. Not changed (needs Leo's OK).
- F19 (#563) stays off on the box after deploy until `HERMES_HOME=/opt/data/hermes-home-staging` is added to `/opt/data/hermes-agent/app-mcp/app-mcp.env` and app-mcp is restarted (manual on purpose; check: `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:9220/mcp` gives 401 when on).
- Email/WhatsApp MCP servers and the Telegram callback server (7902, 8650, 8651) don't run on the box; health ports 7900/7901/7903 listen on `0.0.0.0`.

### Picking it up
1. Production rules (unchanged): read `docs/deployment/PRODUCTION.md` first; backup before any deploy; Leo merges PRs and approves production deploys; deploy fixes one at a time; no real WhatsApp messages without Leo's OK.
2. Sub-agents must not create helper sessions and must not merge.

## Decisions (Leo, 2026-10-18)
1. Repo stays public. `docs/deployment/PRODUCTION.md`, handoff docs and the security reviews move to a private repo; scan the full git history for leaked keys and ask before rotating any.
2. Customers install on their own cloud VM (Ubuntu). No Docker Desktop / laptop package for now.
3. Google: each install creates its own Google OAuth client, with a guided step.
4. Guide and checklist in English and Traditional Chinese.
5. Our Hetzner production box is customer #1: every release is updated and verified there first (backup first), before anyone else. Attack-style tests run on a throwaway Hetzner VM installed the customer way; production gets only read-only outside scans, and fixes one at a time with Leo's OK.
6. Fix the open High security findings before the first release; packaging and the guide are built in parallel.
7. Plan an independent third-party penetration test before selling to outside customers.

## Where we are today

| Area | What exists | Gap |
|---|---|---|
| Install | `install-aquarium.sh` (#524): one command on a fresh Ubuntu 24.04 VM installs Supabase, the embedding service, agent-home, dashboard, gateway, app-mcp, Caddy/TLS, ufw, first owner, health checks. Unit-tested helpers (#528). | Never run end to end on a clean VM. Installs from the `develop` branch (no versions, no releases: the repo has 0 releases). Pulls Supabase compose from `master`. Leaves the model API key as a manual `.env` edit. No `update` / `backup` / `restore` / `uninstall`. VPN helper, WhatsApp bridge sudo rules, `linux-modules-extra` are not installed. |
| Setup in the app | agent-home has an onboarding wizard, Settings → Connected accounts (Google, code-paste OAuth), WhatsApp bridges (QR pairing in the page), VPN, network folders, users/roles. | No single "what's left to set up" checklist. Google needs a Google Cloud OAuth client per install, and nothing explains how to create one. Adding a new WhatsApp bridge relies on a root sudo rule into the checkout (finding F14). |
| Guides | `docs/deployment/PRODUCTION.md` (operator runbook for our box), upstream Hermes docs under `website/docs` (CLI/TUI, not Aquarium). README still opens as "Hermes Agent". | No Aquarium-specific getting-ready guide for a new owner. |
| Security | 4 Oct static review: 13 High, 11 Medium and 1 Low (grouped) finding (`docs/reviews/2026-10-04-security-review.md`). Since then: F20 (chat privacy) fixed by #520/#521, F2 partly by #522/#533 (role limits). Live per-role check script (#529) passes 63/63 on prod. | The other High findings look open (e.g. F1: the custom email/WhatsApp MCP and Telegram callback servers still bind `0.0.0.0`; F3: no `nosniff`/CSP in agent-home; F13–F16: the agent user can reach root or read every secret). GitHub Actions workflows exist (tests, lint, osv-scanner, supply-chain-audit) but none run on this repo. **The repo is public**, including `docs/deployment/PRODUCTION.md` with the production IP and layout. |

## 1. Packaging: "download and install Aquarium"

### Recommended shape
Aquarium is a server (Supabase + Python services + Next.js + WhatsApp bridges + VPN helper). The simplest dependable way for "anyone" is **a server you rent, set up by one command or one click**, not a desktop app.

**Tier A (build first): one-command install on an Ubuntu VPS**
- `curl -fsSL https://get.aquarium.<domain>/install.sh | sudo bash` (or the GitHub release asset), which:
  - downloads a **versioned, checksum-verified release** (`aquarium-vX.Y.Z.tar.gz` plus `SHA256SUMS`, signed) and never a moving branch;
  - pins Supabase images by digest and node/uv/Caddy versions;
  - installs everything `install-aquarium.sh` does today, **plus** the VPN helper (with `linux-modules-extra`), the WhatsApp bridge template unit, backups and OS auto-updates;
  - keeps code root-owned and read-only to the `hermes` user (fixes F13/F15 for every new install);
  - at the end prints **one link** to a first-run page (one-time token) instead of a password in a file.
- **First-run page in agent-home** (replaces the "edit `.env`" step): set the owner password, paste a model API key (tested live), pick a timezone/language, and optionally a domain. Then it lands on the getting-ready checklist (part 2).
- **`aquarium` admin command** on the box: `aquarium status | update [--version] | backup | restore <file> | doctor | logs | uninstall`.
  - `update` takes a backup, installs the new release, migrates, restarts and health-checks, and rolls back automatically if the checks fail. This is today's `deploy-hermes.sh` made safe for non-experts.
  - `doctor` checks disk, certificates, services, DB, model key, Google token expiry and WhatsApp pairing, with a plain-language fix for each.
- **Release pipeline (GitHub Actions):** a tag `vX.Y.Z` runs tests, builds the tarball (agent-home prebuilt, so customers don't run `next build`), creates `SHA256SUMS` and a signature (cosign/minisign), and publishes a GitHub Release with notes. Two channels: `stable` and `beta`.
- **Install test in CI:** every release candidate is installed on a throwaway Hetzner VM by a workflow, health-checked, upgraded from the previous release, then the VM is deleted.

**Tier B (after A): one-click cloud images**
- A Hetzner (and optionally DigitalOcean) snapshot/marketplace image built by Packer from the same release: create the server, open the printed link, done.

**Not recommended for now**
- Docker Desktop on Mac/Windows: the VPN helper (needs root, ppp, CIFS mounts), WhatsApp bridges and a 24/7 gateway don't fit a laptop that sleeps. Possible later as "try it locally", without VPN.
- A multi-tenant hosted Aquarium run by us: that is a different product (billing, isolation, support).

### Requirements for a customer
Ubuntu 24.04 x86_64 VPS with 4 vCPU / 16 GB RAM / 80 GB disk (bge-m3 embedding plus Supabase), a domain name pointing at it, and a model API key. Roughly €15–30/month at Hetzner.

### License
The core is a fork of Nous Research Hermes Agent (MIT). Distribution must keep its LICENSE/NOTICE. Aquarium's own parts can carry any license you choose.

## 2. Getting-ready guide

Two parts that share the same steps, so they can't drift apart:

**a) In-app "Get ready" checklist (agent-home → Settings → Get ready)**
Each item shows a live status (done / needs attention / not started), a "Set up" button that opens the right page, and a "Test" button:

1. **Owner account and password**, and 2-factor login (new: TOTP).
2. **Model provider key**, tested with one short call.
3. **Users and roles:** invite people (admin / member / viewer), explaining what each role can and cannot do (from the #522 role matrix).
4. **Google (Gmail, Calendar, Drive):**
   - step 1, once per install: create a Google Cloud OAuth client (guided, with screenshots and the exact redirect/scopes to copy);
   - step 2, per user: connect the account.
5. **WhatsApp:** add a bridge, scan the QR with the phone, send a test message to yourself. Includes the warning that the number should be a dedicated business phone.
6. **Email** (IMAP/SMTP) if used.
7. **VPN and network folders:** add the Fortinet VPN (connection only), then each `\\server\share` in Files → Bridge, and press Test.
8. **Backups:** offsite backup target (S3/Backblaze), first backup run, restore test.
9. **Security basics:** domain/TLS ok, SSH key-only, updates on, an `aquarium doctor` pass.

**b) Written guide** at `docs/getting-started/` (English and Traditional Chinese), published as a simple site:
- "Install in 15 minutes" (VPS, DNS, one command, first-run page)
- one page per checklist item (screenshots, common errors and fixes, e.g. "SMB dialect not supported", "QR expired", "Google: access blocked")
- "Updating, backups and restore" and "Troubleshooting with `aquarium doctor`".
- The README gets an Aquarium front page that links here, with the Hermes upstream credit below it.

## 3. Security: test and check

Honest target: **no open Critical or High findings, OWASP ASVS Level 2 checklist met, and a repeatable test run before every release.** Nobody can promise "unhackable"; what we can promise is that it is checked, tested and fixed continuously.

**Phase 0: urgent, before anything is packaged**
- **Public repo:** decide whether `leolau/aquarium` should stay public. Right now anyone can read the production IP, the host layout, the security review (a ready-made list of open holes) and all deploy procedures. At minimum: move `PRODUCTION.md`/handoff docs and the security reviews to a private repo, and run a secret scan (gitleaks/trufflehog) over the **full git history**, rotating anything found.
- Turn on GitHub secret scanning and push protection, plus Dependabot.

**Phase 1: fix what we already know (4 Oct review)**
- Re-verify all 25 findings (F1–F25) against current `develop` and record fixed/open for each.
- Fix every open High: F1, F3, F4, F13–F19, the rest of F2, plus the Mediums that matter for strangers' installs (F7 `/yolo`, F8 bridge shell, F9 git args, F21 media delivery, F22 approval binding, F23 `@file:` from untrusted senders, F24 Caddy admin, F25 unpinned tirith).
- Each fix gets regression tests (house rule).

**Phase 2: automated checks on every PR and release**
- Get the existing workflows actually running (tests, lint, typecheck, `osv-scanner`, `supply-chain-audit`), and add `pip-audit`, `npm audit`, gitleaks, Semgrep/Bandit and a container image scan (Trivy).
- **Route authorisation test:** enumerate every FastAPI and Next.js route and assert its required role (catches the next F2).
- Extend `scripts/live_access_check.py` into a release gate: temporary users for each role, chat privacy, tool/file limits, approvals not self-approvable, VPN/network folders read-only, no secret readable from the agent terminal.

**Phase 3: live testing on a fresh install (a throwaway VM, never production)**
- External: port scan (only 22/80/443 open), TLS grade (testssl.sh), OWASP ZAP authenticated scan of agent-home and the dashboard, nuclei templates.
- Host: Lynis/CIS audit, sudoers audit (no rule may point into a hermes-writable path), file permissions on every secret.
- **Agent red-team suite** (the most important one for an AI agent): scripted prompt-injection attacks through WhatsApp, email, web pages and shared files that try to read `.env`/DB passwords, approve their own actions, tick "trusted for import", reach root, exfiltrate files, or change other users' data. Each attempt must fail and be logged.
- Report with severities, fixes and re-test.

**Phase 4 (decided: yes, before selling to outside customers):** an independent third-party penetration test of a release installed on a fresh VM.

**Then for production:** apply the same fixes to our box (backup first, deploy one change at a time) and run the Phase 3 external scans read-only against it.

## Execution (sub-agents, in parallel)

| Track | Work | Est. |
|---|---|---|
| S1 Security fixes | Phase 0 + 1 (re-verify, fix Highs, tests) | 2–3 sessions |
| S2 Security automation and red-team | Phase 2 + 3 suites, test VM | 2 sessions |
| P1 Packaging | release pipeline, hardened installer, `aquarium` command, CI install test | 2–3 sessions |
| P2 First-run + Get ready | agent-home first-run page and checklist, TOTP | 2 sessions |
| G1 Guide | written guide EN + 繁中, screenshots from the P2 UI, README front page | 1 session |

Order: Phase 0 first (a day). S1, P1 and P2 run in parallel. G1 follows P2's screens. S2's live run is the gate for the first public release `v1.0.0`. Each track is its own PR(s) with you as reviewer, a mockup first for every new screen, and nothing deployed to production without a backup and your OK. Waiting on outside parties (Google OAuth review, a third-party pentest) is extra calendar time.

## Appendix: sub-agent prompts (re-usable)

Each track prompt below was followed by the common rules.

### s1a

#### Track S1a — security fixes: web/app surfaces (dashboard, agent-home, app-mcp)
You own these findings from docs/reviews/2026-10-04-security-review.md:
- F2 (remaining parts): dashboard gated mode must check role, not just sign-in, on every admin-grade route (env/config writes, MCP server add incl. stdio, secret reveal, updates) — in hermes_cli/web_server.py and the agent-home BFF routes that proxy them. Add a route-level authorisation test that enumerates every FastAPI route and every agent-home `app/api/**/route.ts` and asserts its required role (an allowlist of public/any-user routes; everything else must declare a role). That test must fail if a new route is added without a role.
- F3: agent-home file proxy stored XSS: `X-Content-Type-Options: nosniff`, a sandboxing CSP on proxied file responses, `Content-Disposition: attachment` for anything not on a safe inline list (images, pdf); plus a baseline CSP/security headers for agent-home pages (frame-ancestors, etc.) that does not break the app — verify with `npm run build` and a headless check of main pages.
- F4: app-mcp destructive-action guard must check the element actually acted on; hub bound to the authenticated principal (not "last connected"); redact password/secret input values in snapshots.
- F17, F18: approval controls (Approve / Always approve / Deny) and Folder Bridge "Trusted for import" must not be actionable through app-mcp `app_act` (DOM marker such as `data-appmcp-deny` plus a server-side deny-list enforced in app-mcp, not only in the page).
- F19: require a token on the loopback app-mcp MCP endpoint (reuse the existing `APP_MCP_HERMES_TOKEN` mechanism if suitable) so the agent's own terminal cannot call it directly.
- F9: dashboard git `base` parameter: validate as a ref and pass `--` / `--end-of-options` so it can't become an option.

### s1b

#### Track S1b — security fixes: gateway, agent core, custom services, WhatsApp bridge, skills
You own these findings from docs/reviews/2026-10-04-security-review.md:
- F1: custom email/WhatsApp MCP servers, Telegram callback, health servers in `custom/` bind `0.0.0.0` with no auth and `Access-Control-Allow-Origin: *`: bind 127.0.0.1 by default, require a token, drop the wildcard CORS. Check the systemd units / callers in `deploy/` and `custom/` still work (update units/docs in the same PR and list any server step needed to deploy).
- F5: no contact auto-merge from phone/email that merely appears in a message body from an unknown sender.
- F6: facts extracted from third-party messages must not be written into the profile-wide shared MEMORY.md that goes into every principal's system prompt (untrusted tier / per-principal, keep the feature useful).
- F7: gateway `/yolo` requires owner/admin role.
- F8: WhatsApp bridge: ffmpeg via execFile (no shell); `/send-media` restricted to an allowlisted media directory.
- F10: skill scanner ignores `.skillignore` for untrusted/agent-created skills, scans agent-created skills by default, write gate fails closed.
- F21: strict media delivery by default (only files under allowed roots attach to chat replies).
- F22: gateway approvals bound to the requester; plain-text 'always' cannot skip slash-command gating.
- F23: don't expand @file:/@folder:/@diff/@url references in text from untrusted senders (and check principal scoping / allowed roots for trusted ones).
- F25: pin the tirith version and verify its digest.
- F12 (Low group): fix the cheap ones (unlimited uploads cap, Telegram HTML escaping, image plugin local-file/SSRF) and list the rest.
Out of scope: F11 (Electron desktop app, not shipped to customers) — just record its current status.

### p1

#### Track P1 — packaging: versioned releases + hardened installer + `aquarium` admin command, and deploy-side security (F13–F16, F24)
Context: Aquarium is installed on a customer's own cloud VM (Ubuntu 24.04 x86_64). Today `install-aquarium.sh` (repo root, from #524; helper tests in tests/ from #528) installs everything from the moving `develop` branch, pulls Supabase compose from `master`, leaves the model API key as a manual `.env` edit, and has no update/backup/restore. Production deploys use `deploy/hermes-deploy.sh` (installed as /opt/data/deploy-hermes.sh). Our own Hetzner production box is "customer #1": every release must be able to update it first, so the new layout must have a migration path from the current production layout described in docs/deployment/PRODUCTION.md (read it; do NOT connect to production).
Deliverables (several focused PRs to develop is fine):
1. Release pipeline: GitHub Actions workflow on tag `vX.Y.Z` that runs tests, builds a release tarball (agent-home prebuilt with `next build` so customers don't build), `SHA256SUMS`, and a signature (cosign keyless or minisign — pick one, document key handling), publishes a GitHub Release; `stable`/`beta` channels. Note: GitHub Actions currently has no runs on this repo — check why (disabled? workflow conditions?) and say what Leo must switch on.
2. Installer hardening (`install-aquarium.sh`): install a pinned, checksum/signature-verified release instead of a branch (keep a `--from-branch` dev option); pin Supabase images by digest and node/uv/Caddy versions; also install the VPN helper (deploy/hermes-vpn-helper + sudoers, `linux-modules-extra-$(uname -r)`, nls_utf8), the WhatsApp bridge template unit, unattended-upgrades, SSH hardening check; code root-owned and read-only to `hermes`, data dirs only writable (this is F13/F15). Finish by printing a one-time first-run link (a token URL) instead of a password-in-file; the first-run page itself is a separate track — define the token contract (CLI writes a hashed one-time token with expiry; page consumes it) and implement the server side + CLI part only.
3. `aquarium` admin command on the box: `status | update [--version|--channel] | backup | restore <file> | doctor | logs | uninstall`. `update` = backup → verify signature → install → migrate → restart → health-check → automatic rollback on failure. `doctor` = disk, certs, services, DB, model key, Google token expiry, WhatsApp pairing, VPN helper version, with a plain-language fix per failure.
4. Deploy-side security from docs/reviews/2026-10-04-security-review.md: F13 (root deploy runs code from hermes-owned checkout: root-owned code, `git -c core.hooksPath=/dev/null -c core.fsmonitor=false`, `python -I`, `npm ci --ignore-scripts` where possible), F14 (sudoers rule `bash <checkout>/deploy/wa-bridge-add.sh` → root-owned copy in /usr/local/sbin or templated unit `hermes-wa-bridge@.service`), F15 (root jobs like hermes-secret-backup run a root-owned script copy as a restricted user), F16 (EnvironmentFiles outside the checkout, root-owned 0600; DATABASE_URL and other secrets on the terminal env blocklist), F24 (Caddy admin API off or unix socket). Re-verify each first. Write the production migration steps for each into the PR body (Leo will approve deploying to production separately).
5. CI install test: a workflow (manual dispatch + on release candidate) that installs on a throwaway Hetzner VM via hcloud, health-checks, upgrades from the previous release, then deletes the VM. Needs an `HCLOUD_TOKEN` repo secret — do not request it; just document it. Additionally, run the installer yourself end to end in the most realistic environment you have (a fresh Ubuntu 24.04 VM/container with systemd if possible) and report exactly what was and wasn't exercised.

### p2

#### Track P2 — MOCKUPS ONLY: agent-home first-run page and "Get ready" checklist (no implementation yet)
Leo approves a mockup before any UI is built. Produce PNG mockups only, rendered with headless Chrome from a static HTML file (or from a mocked agent-home route) that uses agent-home's real styles/components (Tailwind tokens from agent-home/src/app/globals.css, existing components in agent-home/src/components). Mobile-first: render each screen at 390px wide and 1280px wide. Do NOT open a PR; do not change app code beyond a throwaway branch.
Screens:
1. First-run page (opened from a one-time link the installer prints): set owner password (with strength hint) + optional TOTP 2-factor setup, paste model provider API key with a live "Test" result, timezone and language (English / 繁體中文), optional domain check. Then lands on the checklist.
2. Settings → Get ready checklist: items with live status (done / needs attention / not started), a "Set up" button to the existing page and a "Test" button: 1 Owner account + 2FA, 2 Model provider key, 3 Users and roles (admin/member/viewer with what each can do), 4 Google (step A once per install: create your Google Cloud OAuth client — guided, values to copy such as redirect URI/scopes; step B per user: connect account), 5 WhatsApp (add bridge, scan QR, send yourself a test), 6 Email, 7 VPN + network folders (VPN is connection only; network folders in Files → Bridge with \\server\share and Test), 8 Backups (offsite target, first backup, restore test), 9 Security basics (TLS, SSH key-only, updates, doctor pass). Show a mix of states.
3. The Google step-A guided panel opened from the checklist.
4. One screen in Traditional Chinese to show the language switch.
Look at the existing pages first so the mockups match reality: agent-home/src/components/onboarding/OnboardingWizard.tsx, components/settings/ConnectedAccounts.tsx, WhatsAppBridges.tsx, VpnConnections.tsx, components/files/NetworkFolders.tsx, the users/members pages, and hermes_cli/google_oauth.py for the real OAuth flow (manual code-paste) and scopes. Mark clearly in each mockup what is new vs what already exists.
Deliverable: attach all PNGs in your final message via message_user, plus a short list of the data/API each screen needs (which exists today, which is new), then stop and wait.

### Common rules


- Repo: github.com/leolau/aquarium (old name leolau/ai-prentice-4-all redirects). Base branch: `develop`. Branch name: `devin/$(date +%s)-<slug>`.
- Read AGENTS.md first. Primary UI is `agent-home/`. Tests: `scripts/run_tests.sh <paths>` (Python), `cd agent-home && npm test` / `npm run lint` / `npx tsc --noEmit`; Python lint `ruff check`, types `ty check` where the repo uses them.
- Security review to work from: `docs/reviews/2026-10-04-security-review.md` (consolidated, authoritative; finding IDs F1–F25). Its "Remediation roadmap" section lists the agreed fix direction per finding. Fixed since the review: F20 (by #520/#521) and part of F2 (#522/#533, role limits on Tools & Integrations).
- Step 1 for every finding you own: re-verify it against current `develop` (exact file:line), record status fixed / open / partly. Do not fix what is already fixed.
- Every fix needs regression tests that fail before and pass after, plus a run of the affected test suites. Prefer real-path tests (temp HERMES_HOME, real imports) over mocks for security boundaries. Do not break the feature you secure (AGENTS.md: "Fixes that destroy the feature they secure").
- Do NOT touch production or any live server, do not deploy, do not send WhatsApp/email messages, do not print secrets.
- Before opening each PR: all tests/lint/types pass locally, then `git fetch origin && git merge origin/develop`, re-run tests, and confirm the PR is mergeable. Open PRs against `develop` and request `leolau` as reviewer. Keep PRs focused (one finding group per PR) so they can be merged independently; other agents are editing the same repo in parallel.
- PR body: what was vulnerable (file:line), the fix, tests, and anything still unverified. Say whether a mobile app update is needed (normally no) and whether deploying needs any extra server step (env var, sudoers, root helper reinstall, service restart).
- When done, reply with a final message containing: a table of each owned finding (ID, status before, what you did, PR URL), and any decision you need. Then stop. If you hit a design decision with no clear answer from the review, stop and ask in a message rather than guessing.
- Do not create helper/child Devin sessions; do the track in this one session.
