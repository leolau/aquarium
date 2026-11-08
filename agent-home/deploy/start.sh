#!/usr/bin/env bash
# Launch the agent-home production server on loopback only. Caddy fronts it.
# Requires `npm run build` to have been run first (see deploy/DEPLOY.md).
set -euo pipefail

cd "$(dirname "$0")/.."

# Load nvm if node/npm isn't already on PATH (systemd's PATH is minimal).
if ! command -v npm >/dev/null 2>&1; then
  for nvm_sh in "$HOME/.nvm/nvm.sh" /usr/local/nvm/nvm.sh /opt/nvm/nvm.sh; do
    if [ -s "$nvm_sh" ]; then
      # shellcheck disable=SC1090
      . "$nvm_sh"
      break
    fi
  done
fi

# PORT comes from the systemd EnvironmentFile (agent-home.env). Default 3100
# because :3000 on the prod box is the WhatsApp bridge.
#
# Host must be `localhost`, not `127.0.0.1`: Next normalises the middleware's
# request URL to `localhost`, so with `127.0.0.1` every middleware rewrite
# (e.g. a role-hidden page → /not-available) looks external and is proxied to
# `https://localhost:<port>` behind Caddy's X-Forwarded-Proto, which fails as a
# bare 500. ipv4first keeps `localhost` bound to 127.0.0.1 where Caddy points.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--dns-result-order=ipv4first"
exec npm run start -- -H localhost -p "${PORT:-3100}"
