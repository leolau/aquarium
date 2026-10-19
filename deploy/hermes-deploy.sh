#!/usr/bin/env bash
# Deploy the tracked branch of leolau/aquarium onto this box.
#   /opt/data/deploy-hermes.sh [branch]        (default: develop)
# Idempotent. Aborts on unexpected local modifications so a hotfix is never
# silently clobbered; ALLOWED_LOCAL_MODS lists the ones we knowingly carry.
set -euo pipefail

REPO=/opt/data/hermes-agent
BRANCH="${1:-develop}"
ALLOWED_LOCAL_MODS=(
)
# Only the long-running services. `hermes-*` also matches the oneshot jobs
# behind timers (drift-check, memory-projection, secret-backup): restarting
# those *runs* them mid-deploy, and `systemctl is-active` reports `inactive`
# with exit 3 for a oneshot that has finished — under `set -e` that aborted the
# verification loop, so this script exited 3 on every successful deploy and
# never printed its own "deploy OK". Enabled unit files are exactly the ones
# meant to be running; `static` (timer-invoked) units are excluded.
UNITS=$(systemctl list-unit-files 'hermes-*.service' --state=enabled --no-legend \
  | awk '{print $1}')
# app-mcp serves the app/folder-bridge tools from this checkout (python -m
# app_mcp.server) but sits outside the hermes-* glob, so a deploy that shipped
# new tools left the old process registering the old tool list.
if systemctl list-unit-files app-mcp.service --state=enabled --no-legend | grep -q .; then
  UNITS="$UNITS app-mcp.service"
fi
# agent-home is restarted separately (it is not in the hermes-* glob) but a
# deploy that leaves the phone app down must still fail loudly.
VERIFY_UNITS="$UNITS agent-home.service"

# After `aquarium migrate-layout` the code path is a link to a signed, root-owned release.
if [ -L "$REPO" ]; then
  echo "ABORT: $REPO is a release install now; update it with: sudo aquarium update" >&2
  exit 1
fi
cd "$REPO"

# F13: this script runs as root, so everything it executes from the checkout
# (git config + hooks, setup.py, package.json scripts, .npmrc, scripts/*.py)
# must be root-owned. A hermes-owned checkout lets anything running as hermes
# (gateway, dashboard, the agent's own terminal) plant code that root then
# runs. Only the agent-home runtime cache and env files (data, read by hermes
# services, never executed by this script) keep belonging to hermes.
HERMES_WRITABLE=(agent-home/.next/cache agent-home/agent-home.env app-mcp/app-mcp.env)
prune=()
for w in "${HERMES_WRITABLE[@]}"; do prune+=(-path "$REPO/$w" -prune -o); done
prune+=(\( -name .env -o -name '.env.*' -o -name '*.env' \) -prune -o)
not_root_owned() {
  find "$REPO" -xdev "${prune[@]}" \( ! -user root -o -perm /022 \) ! -type l "$@"
}
# A checkout from before this change is hermes-owned: make it root's once,
# saving every old owner/mode first so it can be put back exactly.
if [ -n "$(not_root_owned -print -quit)" ]; then
  MIGRATED=${DEPLOY_BACKUP_ROOT:-/opt/data/backups}/root-owned-checkout-$(date +%Y%m%d-%H%M%S)
  mkdir -p -m 700 "$MIGRATED"
  find "$REPO" -xdev ! -type l -printf '%u:%g %m %p\n' > "$MIGRATED/owners.txt"
  cat > "$MIGRATED/rollback.sh" <<ROLLBACK
#!/bin/bash
# Puts back the owners/modes $REPO had before the deploy made it root-owned.
while read -r og m p; do chown "\$og" "\$p"; chmod "\$m" "\$p"; done < "$MIGRATED/owners.txt"
ROLLBACK
  not_root_owned -exec chown root:root {} + -exec chmod go-w {} +
  echo "== one-time: $REPO is now root-owned (security review F13); undo: bash $MIGRATED/rollback.sh =="
fi
# Never let repository-controlled git config or hooks run as root.
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
# hermes-run tools (banner, deploy_state) read this root-owned checkout.
command git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$REPO" \
  || command git config --system --add safe.directory "$REPO"
# npm ci with lifecycle scripts off; only these reviewed, lockfile-pinned
# runtime packages get their install step (native binaries). A project .npmrc
# can point npm at another registry or set a script shell; tracked ones are
# reviewed, and since the tree is root-owned only root can add one.
NPM_REBUILD=(agent-browser esbuild node-pty sharp unicode-animations)
npm_ci() {
  for rc in .npmrc web/.npmrc agent-home/.npmrc; do
    if [ -e "$rc" ] && ! git ls-files --error-unmatch "$rc" >/dev/null 2>&1; then
      echo "WARNING: untracked $REPO/$rc is used by npm; check it is yours." >&2
    fi
  done
  nice -n 15 npm ci --ignore-scripts --no-audit --no-fund --silent
  nice -n 15 npm rebuild --silent "${NPM_REBUILD[@]}"
}

echo "== local modifications check =="
mapfile -t mods < <(git status --porcelain --untracked-files=no | awk '{print $2}')
for m in "${mods[@]:-}"; do
  [ -z "$m" ] && continue
  ok=0
  for a in "${ALLOWED_LOCAL_MODS[@]}"; do [ "$m" = "$a" ] && ok=1; done
  if [ "$ok" = 0 ]; then
    echo "ABORT: unexpected local change to $m — commit it upstream or add it to ALLOWED_LOCAL_MODS." >&2
    exit 1
  fi
  echo "carrying known local mod: $m"
done

TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /opt/data/backups/deploy-$TS
for a in "${ALLOWED_LOCAL_MODS[@]}"; do
  [ -f "$a" ] && install -D "$a" "/opt/data/backups/deploy-$TS/$a"
done
git diff > "/opt/data/backups/deploy-$TS/local-mods.diff" || true

echo "== fetching origin/$BRANCH =="
# Retried: the fetch is over SSH to github.com from cn-hongkong, where a
# connect timeout is an occasional fact of life. Aborting is correct — a deploy
# must never install a revision it could not verify — but a single blip then
# leaves the box on the old revision, and the operator has to notice the abort
# among the passing output to know nothing happened.
fetched=
for attempt in 1 2 3; do
  if git fetch --no-tags origin "$BRANCH"; then
    fetched=yes
    break
  fi
  echo "   fetch attempt $attempt failed; retrying in $((attempt * 5))s"
  sleep $((attempt * 5))
done
if [ -z "$fetched" ]; then
  echo "FETCH FAILED after 3 attempts — nothing deployed, box unchanged at $(git rev-parse --short HEAD)" >&2
  exit 1
fi
BEFORE=$(git rev-parse --short HEAD)
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -b "$BRANCH" --track "origin/$BRANCH"
git checkout -f "origin/$BRANCH" -- .
git reset -q "origin/$BRANCH"
git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1 || git update-ref "refs/heads/$BRANCH" "origin/$BRANCH"
# `checkout -- .` writes what the new revision HAS; it removes nothing the new
# revision LACKS, and the reset above then leaves the orphan untracked. So a
# file deleted or renamed upstream lived on here forever — a stale document is
# the harmless case, an importable deleted module is not. Delete exactly what
# git says the two revisions deleted: nothing untracked (.env, agent-home.env,
# .next/) is named by that list, so nothing untracked can be caught by it.
# --no-renames matters: the case that found this was a rename, and git reports
# a rename as R rather than D, so the old path would go on surviving.
while IFS= read -r gone; do
  [ -z "$gone" ] && continue
  keep=0
  for a in "${ALLOWED_LOCAL_MODS[@]}"; do [ "$gone" = "$a" ] && keep=1; done
  [ "$keep" = 1 ] && continue
  [ -e "$gone" ] || continue
  rm -f "$gone"
  echo "removed upstream-deleted file: $gone"
  rmdir -p --ignore-fail-on-non-empty "$(dirname "$gone")" 2>/dev/null || true
done < <(git diff --name-only --no-renames --diff-filter=D "$BEFORE" "origin/$BRANCH")
# Orphans from deploys made before the loop above existed, and anything a
# process wrote into the checkout. Ignored paths (.env, agent-home.env, .next/)
# are excluded by --porcelain, so what remains is genuinely unaccounted for.
# Reported, never deleted — the deploy does not know what it did not put there.
untracked=$(git status --porcelain --untracked-files=normal | awk '$1 == "??" {print $2}')
if [ -n "$untracked" ]; then
  echo "untracked files in the deployment checkout (not from this revision):"
  echo "$untracked" | sed 's/^/  /'
fi
for a in "${ALLOWED_LOCAL_MODS[@]}"; do
  [ -f "/opt/data/backups/deploy-$TS/$a" ] && cp -a "/opt/data/backups/deploy-$TS/$a" "$a"
done
AFTER=$(git rev-parse --short HEAD)
echo "$BEFORE -> $AFTER"
[ "$BEFORE" = "$AFTER" ] && echo "(already up to date)"

echo "== reinstalling package =="
./.venv/bin/python -I -m pip install -q -e .
# The services run as hermes and can't write __pycache__ in this root-owned
# tree, so compile here; otherwise every start recompiles in memory.
nice -n 15 ./.venv/bin/python -I -m compileall -q -j 0 \
  -x '/(node_modules|\.venv|\.git|web_dist|\.next)/' . >/dev/null 2>&1 || true

# The dashboard runs with --skip-build and serves the prebuilt bundle in
# hermes_cli/web_dist, which is git-ignored: without this step a deploy ships
# new API endpoints with the old SPA, and every frontend change is invisible
# on the box. Only rebuild when web/ actually moved — it is minutes of CPU on
# a box that is also serving conversations.
if [ "$BEFORE" != "$AFTER" ] && \
   ! git diff --quiet "$BEFORE" "$AFTER" -- web/; then
  echo "== rebuilding dashboard bundle (web/ changed) =="
  npm_ci
  (cd web && nice -n 15 npm run build)
elif [ ! -d hermes_cli/web_dist/assets ]; then
  echo "== building dashboard bundle (no bundle present) =="
  npm_ci
  (cd web && nice -n 15 npm run build)
fi

# FG-23 A0.2: Rebuild agent-home (the phone PWA) only when its sources
# changed, or when no build exists. agent-home is an npm *workspace* of the
# root package.json — install/build from the repo root, NOT from inside
# agent-home/ (that would create a second, unhoisted dep tree). The root
# package-lock.json is matched explicitly because a workspace dependency change
# lands there.
if [ "$BEFORE" != "$AFTER" ] && \
   git diff --name-only "$BEFORE" "$AFTER" | grep -qE '^(agent-home/|package-lock\.json$)'; then
  echo "== rebuilding agent-home bundle (agent-home/ changed) =="
  npm_ci
  rm -rf agent-home/.next
  nice -n 15 npm run build --workspace agent-home
  restart_agent_home=1
elif [ ! -f agent-home/.next/BUILD_ID ]; then
  echo "== building agent-home bundle (no build present) =="
  npm_ci
  rm -rf agent-home/.next
  nice -n 15 npm run build --workspace agent-home
  restart_agent_home=1
fi

# root owns the whole tree (see the check at the top); `next start` only needs
# to write its cache. The build above starts from an empty .next, so nothing
# the hermes user put in the old cache is read by a root build.
install -d -o hermes -g hermes "$REPO/agent-home/.next/cache"

# F16: the agent's shell no longer sees DATABASE_URL / the Supabase service-role
# key unless security.terminal_database_credentials is true. A profile set up
# before that keeps `hermes promote` etc. working from chat: the first deploy
# writes true once; an explicit value (installer's false, operator's choice) is
# never touched again.
for cfg in ${HERMES_HOME_GLOB:-/opt/data/hermes-home*/config.yaml}; do
  [ -f "$cfg" ] || continue
  runuser -u hermes -- env HERMES_HOME="$(dirname "$cfg")" \
    ./.venv/bin/python -I scripts/keep_terminal_db_credentials.py \
    || echo "WARNING: could not check security.terminal_database_credentials in $cfg" >&2
done

# P2 first run: /setup offers the model / region / domain steps only before the
# owner's first login. A profile that already has chats gets
# auth/first_run_done.json once, so a later `hermes setup-link` (login reset)
# keeps only setting the password. Fresh installs (no chats) are left alone.
for cfg in ${HERMES_HOME_GLOB:-/opt/data/hermes-home*/config.yaml}; do
  [ -f "$cfg" ] || continue
  runuser -u hermes -- env HERMES_HOME="$(dirname "$cfg")" \
    ./.venv/bin/python -I scripts/mark_first_run_done.py \
    || echo "WARNING: could not check the first-run marker for $(dirname "$cfg")" >&2
done

# Table setup as the schema owner (`hermes db migrate`). With
# /etc/aquarium/db-admin.env (root, 0600) the owner address comes from there and
# a failure stops the deploy before any restart: services on a least-privilege
# login cannot create tables themselves. Without that file (boxes set up before
# it existed) the gateway's own DATABASE_URL is used and a failure is only a
# warning: those services still own the schema and set up their tables on first
# use, exactly as before. The address goes over stdin, never into the
# environment of a process running as hermes.
DB_ADMIN_ENV=${DB_ADMIN_ENV:-/etc/aquarium/db-admin.env}
gateway_db_env() {
  local f
  for f in $(systemctl show -P EnvironmentFiles hermes-gateway.service 2>/dev/null | awk '{print $1}'); do
    [ -r "$f" ] && grep -h '^DATABASE_URL=' "$f" || true
  done | tail -n 1
}
for cfg in ${HERMES_HOME_GLOB:-/opt/data/hermes-home*/config.yaml}; do
  [ -f "$cfg" ] || continue
  migrate=(runuser -u hermes -- env HERMES_HOME="$(dirname "$cfg")"
           ./.venv/bin/python -I -m hermes_cli.db_migrate --dsn-stdin)
  if [ -f "$DB_ADMIN_ENV" ]; then
    "${migrate[@]}" < "$DB_ADMIN_ENV" || {
      echo "ABORT: hermes db migrate failed for $cfg; services were not restarted" >&2
      exit 1
    }
  elif dsn=$(gateway_db_env) && [ -n "$dsn" ]; then
    printf '%s\n' "$dsn" | "${migrate[@]}" \
      || echo "WARNING: hermes db migrate failed for $cfg; services still set up their own tables" >&2
  fi
done
unset dsn

echo "== restarting services =="
systemctl daemon-reload
# agent-home runs as `hermes` and `next start` writes into .next, so it is
# restarted *after* its cache dir is handed to hermes above.
if [ "${restart_agent_home:-0}" = 1 ]; then
  systemctl restart agent-home
fi
for u in $UNITS; do systemctl restart "$u"; done
sleep 15
fail=0
for u in $VERIFY_UNITS; do
  # `is-active` exits nonzero for anything not active; report it, don't abort.
  s=$(systemctl is-active "$u" || true)
  printf "%-40s %s\n" "$u" "$s"
  [ "$s" = active ] || fail=1
done
[ "$fail" = 0 ] || { echo "DEPLOY WARNING: a unit is not active — see journalctl -u <unit>" >&2; exit 1; }
echo "deploy OK ($AFTER)  backup: /opt/data/backups/deploy-$TS"

# docs/deployment/README.md claims to state what is *currently* true of this box
# and names the revision it was verified against. Nothing kept that honest, so
# it went three deploys stale unnoticed. Stale means the deploy tooling it
# documents moved after it was written, not merely that HEAD moved — that is
# every deploy. Advisory here (a stale document must not block a deploy); the
# weekly drift timer is what reports it.
# -I keeps cwd and PYTHON* env vars out of its import path.
./.venv/bin/python -I scripts/deploy_state.py handover || true

# The VPN helper runs as root through sudo, so it must be a root-owned copy —
# never the hermes-owned checkout. Reported when stale, not auto-installed
# (one-time install + upgrades: docs/deployment/PRODUCTION.md "Fortinet VPN").
VPN_HELPER=/usr/local/sbin/hermes-vpn-helper
if [ -e "$VPN_HELPER" ] && ! cmp -s "$VPN_HELPER" "$REPO/deploy/hermes-vpn-helper"; then
  echo "VPN HELPER STALE: $VPN_HELPER differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo install -m 755 -o root -g root $REPO/deploy/hermes-vpn-helper $VPN_HELPER"
fi
WA_HELPER=/usr/local/sbin/hermes-wa-bridge-add
if [ -e "$WA_HELPER" ] && ! cmp -s "$WA_HELPER" "$REPO/deploy/hermes-wa-bridge-add"; then
  echo "WA BRIDGE HELPER STALE: $WA_HELPER differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo install -m 755 -o root -g root $REPO/deploy/hermes-wa-bridge-add $WA_HELPER"
fi
TOOLS_HELPER=/usr/local/sbin/hermes-tools-exec
if [ -e "$TOOLS_HELPER" ] && ! cmp -s "$TOOLS_HELPER" "$REPO/deploy/hermes-tools-exec"; then
  echo "TOOLS HELPER STALE: $TOOLS_HELPER differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo install -m 755 -o root -g root $REPO/deploy/hermes-tools-exec $TOOLS_HELPER"
fi
TOOLS_CLI=/usr/local/sbin/hermes-tools-cli
if [ -e "$TOOLS_CLI" ] && ! cmp -s "$TOOLS_CLI" "$REPO/deploy/hermes-tools-cli"; then
  echo "TOOLS CLI HELPER STALE: $TOOLS_CLI differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo install -m 755 -o root -g root $REPO/deploy/hermes-tools-cli $TOOLS_CLI"
fi
TOOLS_SHIM=/usr/local/lib/hermes-tools/bin/hermes
if [ -e "$TOOLS_SHIM" ] && ! cmp -s "$TOOLS_SHIM" "$REPO/deploy/hermes-tools-shim"; then
  echo "TOOLS SHIM STALE: $TOOLS_SHIM differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo install -m 755 -o root -g root $REPO/deploy/hermes-tools-shim $TOOLS_SHIM"
fi
TOOLS_RULE=/etc/sudoers.d/hermes-tools
if [ -e "$TOOLS_RULE" ] && ! cmp -s "$TOOLS_RULE" "$REPO/deploy/sudoers.d/hermes-tools"; then
  echo "TOOLS SUDOERS RULE STALE: $TOOLS_RULE differs from the reviewed copy at $AFTER. Install it with:"
  echo "    sudo visudo -cf $REPO/deploy/sudoers.d/hermes-tools && sudo install -m 440 -o root -g root $REPO/deploy/sudoers.d/hermes-tools $TOOLS_RULE"
fi

# The deploy tool does not deploy itself: /opt/data/deploy-hermes.sh is a copy
# installed by hand, so a merged fix to this script changes nothing on the box
# until someone remembers to install it — and the deploy it was supposed to fix
# reports success meanwhile. Found when the delete-pruning fix above merged,
# deployed green, and did not run. Reported, not self-applied: a script that
# rewrites itself while bash is still reading it is its own class of bug.
SELF=$(readlink -f "$0")
REVIEWED=$(readlink -f "$REPO/deploy/hermes-deploy.sh" 2>/dev/null || true)
if [ -n "$REVIEWED" ] && [ "$SELF" != "$REVIEWED" ] && ! cmp -s "$SELF" "$REVIEWED"; then
  echo "DEPLOY TOOL STALE: the running $SELF differs from the reviewed copy at $AFTER."
  echo "  Everything above ran the old script. Install the new one and re-run:"
  echo "    sudo install -m 755 -o root -g root $REVIEWED $SELF"
fi
