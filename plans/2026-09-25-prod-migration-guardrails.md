# Guardrails against deploying to the decommissioned Alibaba box

Date: 2026-09-25
Status: **Done** (docs fixed; no code change)

## Incident

While troubleshooting Folder Bridge large-file imports (see
`2026-09-25-folder-bridge-import-keepalive.md`), an agent spent an entire
session — merging and "deploying" six follow-up PRs (#460–#466), restarting
services, chasing a phantom "reverse proxy caching stale JS" theory — against
`i-j6c81aisv2dd8mg17yle` (Alibaba Cloud ECS, `47.83.199.25`, cn-hongkong) via
`aliyun oos StartExecution`. Every deploy reported success. Nothing the user
observed ever changed, because **that box has not been production since
2026-08-20**. The real production box is a Hetzner server
(`<prod-host>`), reachable by plain SSH, documented in
`docs/deployment/PRODUCTION.md`. The agent never opened that file and instead
reused the Alibaba/OOS access pattern from earlier conversation history (and
from the `testing-hermes-systest-box` skill, which described exactly that
access pattern with no warning that it was stale).

Once discovered (by a `code_search` that surfaced `PRODUCTION.md`'s migration
banner), the real box was found running `247e93ac9` — a dozen-plus merged PRs
behind `develop` — with `app-mcp` missing the keepalive code entirely and no
`mcp_servers.app` timeout configured. A proper deploy (`ssh ... 'deploy-hermes.sh
develop'`) plus the missing `app-mcp.env` / `config.yaml` fixes resolved the
actual issue in minutes once applied to the right server.

**Root cause of the wasted session: no unmissable, load-bearing pointer to
"where is production and how do I reach it" existed anywhere an agent is
guaranteed to read before acting.** `docs/deployment/README.md` was correctly
marked superseded; `AGENTS.md` (the one file every session reads) said
nothing about production access at all; and an active skill described the
dead box's access method as if it were current.

## Fix — make the current access path impossible to miss

1. **`AGENTS.md`** — added a `⚠️ STOP` section immediately after the title
   (the first thing anything reads) naming the Hetzner box, its SSH command,
   and an explicit "if you're about to use `OOS_RunCommand`, stop" warning,
   pointing to `docs/deployment/PRODUCTION.md` as the single source of truth.
2. **`.agents/skills/testing-hermes-systest-box/SKILL.md`** — this skill's
   description and access-pattern section actively taught the dead
   OOS_RunCommand path with no caveat. Rewrote the top of the file as an
   unmissable superseded banner (also updated in the skill's frontmatter
   `description`, since that's what search/matching sees first), redirecting
   to `PRODUCTION.md` and the SSH command before any historical content.
3. **`agent-home/deploy/DEPLOY.md`** — had the same unmarked Alibaba
   instance ID / `aliyun` CLI instructions with zero pointer to the
   migration. Added a superseded banner matching the one already on
   `docs/deployment/README.md`.
4. **This file** — a durable incident record, linked from both of the above,
   so a future reader who lands on either the skill or `AGENTS.md` can see
   *why* the warning exists and how expensive skipping it was.

## Already-correct references (no change needed)

- `docs/deployment/README.md` — already had a clear superseded banner.
- `docs/deployment/hetzner-migration-runbook.md` — the authoritative
  migration history, unaffected.
- `docs/deployment/PRODUCTION.md` — the authoritative current-state doc;
  unchanged, just needed to actually be read first.
- `HANDOFF.md` — already marks the Alibaba section historical.

## Verification

- Re-ran `grep -rn "OOS_RunCommand\|aliyun ecs\|47.83.199.25\|i-j6c81aisv2dd8mg17yle"`
  across the repo after the edits: every remaining hit is inside a block
  explicitly marked historical/superseded (this file,
  `docs/deployment/README.md`, `HANDOFF.md`,
  `.agents/skills/testing-hermes-systest-box/SKILL.md`'s "historical content"
  section, and `docs/deployment/hetzner-migration-runbook.md`, which is
  migration history by definition).
- No code changed; this is a documentation/guardrail fix only.

## Follow-up (not done here, worth considering)

- A pre-flight check baked into the deploy tooling itself (e.g. `deploy-hermes.sh`
  or a wrapper) that refuses to run against an Alibaba instance ID/IP would be
  a stronger guardrail than documentation alone, since it fails safe even if
  an agent skips every doc. Not implemented — flagging for whoever owns
  deploy tooling next.
