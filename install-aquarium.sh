#!/usr/bin/env bash
# install-aquarium.sh — install the whole Aquarium stack on a fresh Ubuntu 24.04 VM.
#
#   curl -fsSL https://raw.githubusercontent.com/leolau/aquarium/develop/install-aquarium.sh \
#     | sudo AQUARIUM_HOME_DOMAIN=home.example.com AQUARIUM_DASHBOARD_DOMAIN=example.com bash -s -- [OPTION]
#
# What to install (one option; default --channel stable):
#   --version vX.Y.Z      that GitHub release of leolau/aquarium
#   --channel stable|beta newest release on the channel (beta includes pre-releases)
#   --from-branch BRANCH  a git checkout of BRANCH (development boxes only; not verified)
# A release is installed only after its SHA256SUMS passes a cosign signature check (signed by
# this repo's release workflow for that tag) and the tarball matches it. Releases are unpacked
# root-owned into /opt/aquarium/releases/<version>; /opt/aquarium/current points at the active
# one and $AQUARIUM_ROOT/hermes-agent points at current. Tool versions, the Supabase commit and
# its image digests are pinned in deploy/install/pins.env and supabase-images.lock.
#
# Installs: system packages, Docker, Node 22, uv, Caddy; the Aquarium release (or checkout) and its
# Python/Node dependencies; self-hosted Supabase (Docker Compose); the database roles and
# first owner; the local embedding service (bge-m3); app-mcp; agent-home; the dashboard
# and gateway; systemd units and the Caddy site with automatic TLS. Then runs health checks.
#
# Re-running is safe: generated secrets are kept in $AQUARIUM_ROOT/aquarium-secrets.env
# (root-only) and reused; existing Supabase data and config.yaml are never overwritten.
#
# Settings (environment variables, all optional):
#   AQUARIUM_HOME_DOMAIN       public hostname for agent-home (the app). Unset = no Caddy/TLS,
#                              only SSH is reachable from outside (useful for a test VM).
#   AQUARIUM_DASHBOARD_DOMAIN  public hostname for the operator dashboard.
#   AQUARIUM_OWNER_ID          login name of the first owner            (default: admin)
#   AQUARIUM_OWNER_PASSWORD    owner password; generated when unset and saved in the secrets file
#   AQUARIUM_REPO / AQUARIUM_BRANCH   source for --from-branch (default: leolau/aquarium, develop);
#                              setting AQUARIUM_BRANCH alone also selects a branch install
#   AQUARIUM_ROOT              install root                              (default: /opt/data)
#   AQUARIUM_SUPABASE_REF      supabase/supabase commit for the compose files (default: pins.env;
#                              every image it uses must be in deploy/install/supabase-images.lock)
#   AQUARIUM_INSTALLER_REF     git ref to fetch deploy/install/ from when this script is piped
#                              from curl (default: AQUARIUM_BRANCH)
#   AQUARIUM_SKIP_EMBED_MODEL=1  don't download the ~2.3 GB embedding model now
set -Eeuo pipefail

ROOT=${AQUARIUM_ROOT:-/opt/data}
REPO_URL=${AQUARIUM_REPO:-https://github.com/leolau/aquarium.git}
BRANCH=${AQUARIUM_BRANCH:-develop}
HOME_DOMAIN=${AQUARIUM_HOME_DOMAIN:-}
DASH_DOMAIN=${AQUARIUM_DASHBOARD_DOMAIN:-}
OWNER_ID=${AQUARIUM_OWNER_ID:-admin}
SUPABASE_REF=${AQUARIUM_SUPABASE_REF:-}
APP=$ROOT/hermes-agent
HERMES_HOME_DIR=$ROOT/hermes-home
SUPA=$ROOT/supabase/docker
EMBED=$ROOT/hermes-embed
SECRETS=$ROOT/aquarium-secrets.env
APP_ENV=$ROOT/hermes.env
EMBED_MODEL=BAAI/bge-m3
EMBED_REV=5617a9f61b028005a4858fdac845db406aefb181

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

# Release/pin/component helpers live in deploy/install/ next to this script; when the script
# is piped from curl there is no "next to", so fetch them from the same ref.
HELPERS=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)/deploy/install
if [ ! -f "$HELPERS/lib.sh" ]; then
  HELPERS=$(mktemp -d)
  for f in lib.sh pins.env supabase-images.lock; do
    curl -fsSL "https://raw.githubusercontent.com/leolau/aquarium/${AQUARIUM_INSTALLER_REF:-$BRANCH}/deploy/install/$f" \
      -o "$HELPERS/$f" || die "cannot fetch deploy/install/$f"
  done
fi
# shellcheck source=deploy/install/lib.sh
. "$HELPERS/lib.sh"
# shellcheck source=deploy/install/pins.env
. "$HELPERS/pins.env"
SUPABASE_REF=${SUPABASE_REF:-$SUPABASE_COMMIT}
aq_parse_args "$@"
if [ "$SOURCE_MODE" = help ]; then
  echo "usage: install-aquarium.sh [--version vX.Y.Z | --channel stable|beta | --from-branch BRANCH]"
  exit 0
fi
as_hermes() { sudo -u hermes -H env HERMES_HOME="$HERMES_HOME_DIR" "$@"; }
rand() { openssl rand -hex "${1:-24}"; }
# uv-managed Pythons must live outside /root so the hermes account can run the venvs.
export UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python
mkvenv() {  # mkvenv DIR: (re)create a 3.11 venv the hermes account can execute
  if ! { [ -x "$1/bin/python" ] && sudo -u hermes "$1/bin/python" -V >/dev/null 2>&1; }; then
    rm -rf "$1" && uv venv -q "$1" --python 3.11
  fi
}

# ---------------------------------------------------------------- 0. preflight
[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "Ubuntu required (found ${ID:-unknown})"
[ "$(uname -m)" = x86_64 ] || echo "warning: tested on x86_64 only"
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "$free_gb" -ge 25 ] || die "need >= 25 GB free disk, have ${free_gb} GB"
mkdir -p "$ROOT"

# ---------------------------------------------------------------- 1. system packages
log "System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git build-essential python3-dev \
  openssl jq rsync sudo ufw tesseract-ocr debian-keyring debian-archive-keyring apt-transport-https \
  docker.io docker-compose-v2
systemctl enable --now docker
# Only SSH and the Caddy ports are public; everything else listens on 127.0.0.1.
# The dashboard binds 0.0.0.0 so its login gate is on (as in prod); ufw keeps :9119 closed.
ufw default deny incoming >/dev/null
ufw allow OpenSSH >/dev/null && ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# Exact versions from deploy/install/pins.env.
aq_install_node
aq_install_uv
if [ -n "$HOME_DOMAIN$DASH_DOMAIN" ]; then aq_install_caddy; fi
log "Automatic security updates and SSH check"
aq_enable_unattended_upgrades
aq_ssh_check
if [ "$(swapon --noheadings | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- 2. service account + secrets
log "Service account and secrets"
id hermes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hermes --shell /usr/sbin/nologin hermes
install -d -m 700 -o root -g root "$ROOT/deploy"
touch "$SECRETS" && chmod 600 "$SECRETS"
secret() {  # secret NAME [value]: read from the secrets file, else set it once
  local name=$1 val
  val=$(sed -n "s/^$name=//p" "$SECRETS" | tail -1)
  if [ -z "$val" ]; then val=${2:-$(rand)}; echo "$name=$val" >> "$SECRETS"; fi
  printf '%s' "$val"
}
PG_PASSWORD=$(secret POSTGRES_PASSWORD)
JWT_SECRET=$(secret JWT_SECRET "$(rand 32)")
OWNER_PASSWORD=$(secret OWNER_PASSWORD "${AQUARIUM_OWNER_PASSWORD:-$(rand 12)}")
SESSION_SECRET=$(secret AGENT_HOME_SESSION_SECRET "$(rand 32)")
APP_MCP_SECRET=$(secret APP_MCP_TICKET_SECRET "$(rand 32)")
READ_DB_PASSWORD=$(secret HERMES_APP_READ_DB_PASSWORD)
DASH_AUTH_SECRET=$(secret DASHBOARD_BASIC_AUTH_SECRET "$(rand 32)")
TENANT=$(secret POOLER_TENANT_ID aquarium)
jwt() {  # jwt ROLE: HS256 Supabase key, valid 10 years
  python3 - "$JWT_SECRET" "$1" <<'PY'
import base64, hashlib, hmac, json, sys, time
b = lambda d: base64.urlsafe_b64encode(d).rstrip(b"=").decode()
now = int(time.time())
h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
p = b(json.dumps({"role": sys.argv[2], "iss": "supabase", "iat": now, "exp": now + 10 * 365 * 86400}).encode())
s = b(hmac.new(sys.argv[1].encode(), f"{h}.{p}".encode(), hashlib.sha256).digest())
print(f"{h}.{p}.{s}")
PY
}
ANON_KEY=$(secret SUPABASE_ANON_KEY "$(jwt anon)")
SERVICE_KEY=$(secret SUPABASE_SERVICE_ROLE_KEY "$(jwt service_role)")

# ---------------------------------------------------------------- 3. application checkout
if [ "$SOURCE_MODE" = branch ]; then
  log "Aquarium source ($REPO_URL @ $BRANCH, unverified development install)"
  [ ! -L "$APP" ] || die "$APP points at a release install; install a release with --version instead"
  if [ ! -d "$APP/.git" ]; then
    git clone --branch "$BRANCH" "$REPO_URL" "$APP"
  else
    git -C "$APP" fetch -q origin "$BRANCH" && git -C "$APP" merge -q --ff-only "origin/$BRANCH"
  fi
  git config --system --add safe.directory "$APP" 2>/dev/null || true
else
  aq_check_compat_path "$APP"
  VERSION=$(aq_resolve_version)
  log "Aquarium release $VERSION (signature + checksum verified)"
  if [ ! -d "$AQ_OPT/releases/$VERSION" ]; then
    DL=$(mktemp -d)
    aq_download_release "$VERSION" "$DL"
    COSIGN=$(aq_install_cosign)
    aq_verify_release "$COSIGN" "$DL" "$VERSION"
    aq_unpack_release "$DL/$(aq_tarball_name "$VERSION")" "$VERSION"
    rm -rf "$DL"
  fi
  aq_activate_release "$VERSION" "$APP"
fi

log "Python dependencies"
cd "$APP"
mkvenv "$APP/.venv"
# app-mcp runs from its folder (python -m app_mcp.server) on this venv; install only its deps.
# Extras + pins match the production venv (it carried ~30 packages beyond the lock).
uv pip install -q --python .venv/bin/python \
  -e ".[all,dev,messaging,app-push,documents,edge-tts,bedrock]" \
  "mcp>=1.26,<2" "websockets>=15,<16" google-genai==2.13.0 pymupdf==1.28.2 pymysql==1.2.0 \
  pytesseract==0.3.13 tabulate==0.10.0 tornado==6.5.7 numpy==2.4.3

log "Node dependencies and builds (agent-home, dashboard)"
# A release ships agent-home and the dashboard prebuilt; build only what is missing.
if [ "$SOURCE_MODE" = branch ] || [ ! -d node_modules ]; then npm ci --no-audit --no-fund --silent; fi
if [ "$SOURCE_MODE" = branch ] || [ ! -f hermes_cli/web_dist/index.html ]; then (cd web && npm run build); fi
if [ "$SOURCE_MODE" = branch ] || [ ! -f agent-home/.next/BUILD_ID ]; then npm run build --workspace agent-home; fi
chmod +x agent-home/deploy/start.sh
# WhatsApp bridge dependencies (the service account cannot write into a release).
(cd scripts/whatsapp-bridge && npm ci --no-audit --no-fund --silent --omit=dev)

log "VPN helper and office file-share support"
aq_install_vpn_support "$APP"

# ---------------------------------------------------------------- 4. Supabase
log "Supabase (self-hosted, Docker Compose)"
if [ ! -f "$SUPA/docker-compose.yml" ]; then
  rm -rf "$ROOT/supabase/src"
  aq_fetch_supabase "$SUPABASE_REF" "$ROOT/supabase/src"
  mkdir -p "$SUPA" && cp -a "$ROOT/supabase/src/docker/." "$SUPA/"
  aq_pin_compose_images "$SUPA/docker-compose.yml" "$HELPERS/supabase-images.lock"
  cp "$SUPA/.env.example" "$SUPA/.env"
fi
chmod 600 "$SUPA/.env"
set_env() {  # set_env FILE KEY VALUE (replace or append)
  local f=$1 k=$2 v=$3
  if grep -q "^$k=" "$f"; then
    python3 - "$f" "$k" "$v" <<'PY'
import sys
f, k, v = sys.argv[1:]
lines = open(f).read().splitlines()
open(f, "w").write("\n".join(f"{k}={v}" if l.startswith(k + "=") else l for l in lines) + "\n")
PY
  else echo "$k=$v" >> "$f"; fi
}
# Upstream .env pins COMPOSE_FILE, which stops Compose auto-loading the loopback override.
set_env "$SUPA/.env" COMPOSE_FILE docker-compose.yml:docker-compose.override.yml
set_env "$SUPA/.env" POSTGRES_PASSWORD "$PG_PASSWORD"
set_env "$SUPA/.env" JWT_SECRET "$JWT_SECRET"
set_env "$SUPA/.env" ANON_KEY "$ANON_KEY"
set_env "$SUPA/.env" SERVICE_ROLE_KEY "$SERVICE_KEY"
set_env "$SUPA/.env" DASHBOARD_USERNAME supabase
set_env "$SUPA/.env" DASHBOARD_PASSWORD "$(secret SUPABASE_STUDIO_PASSWORD)"
set_env "$SUPA/.env" SECRET_KEY_BASE "$(secret SUPABASE_SECRET_KEY_BASE "$(rand 32)")"
set_env "$SUPA/.env" VAULT_ENC_KEY "$(secret SUPABASE_VAULT_ENC_KEY "$(rand 16)")"
set_env "$SUPA/.env" PG_META_CRYPTO_KEY "$(secret SUPABASE_PG_META_CRYPTO_KEY "$(rand 16)")"
set_env "$SUPA/.env" LOGFLARE_PUBLIC_ACCESS_TOKEN "$(secret LOGFLARE_PUBLIC_ACCESS_TOKEN)"
set_env "$SUPA/.env" LOGFLARE_PRIVATE_ACCESS_TOKEN "$(secret LOGFLARE_PRIVATE_ACCESS_TOKEN)"
set_env "$SUPA/.env" POOLER_TENANT_ID "$TENANT"
set_env "$SUPA/.env" FILE_SIZE_LIMIT 5368709120
set_env "$SUPA/.env" SITE_URL "https://${HOME_DOMAIN:-localhost}"
set_env "$SUPA/.env" API_EXTERNAL_URL "http://127.0.0.1:8000"
set_env "$SUPA/.env" SUPABASE_PUBLIC_URL "http://127.0.0.1:8000"
set_env "$SUPA/.env" DISABLE_SIGNUP true
# Docker-published ports bypass ufw, so keep the API gateway and pooler on loopback.
cat > "$SUPA/docker-compose.override.yml" <<'YML'
services:
  api-gw:
    ports: !override
      - 127.0.0.1:${API_GW_HTTP_PORT:-${KONG_HTTP_PORT:-8000}}:8000/tcp
  supavisor:
    ports: !override
      - 127.0.0.1:${POSTGRES_PORT}:5432
      - 127.0.0.1:${POOLER_PROXY_PORT_TRANSACTION}:6543
YML
(cd "$SUPA" && docker compose pull -q && docker compose up -d)
log "Waiting for Postgres"
for _ in $(seq 1 90); do
  docker exec supabase-db pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 5
done
docker exec supabase-db pg_isready -U postgres -h localhost >/dev/null || die "supabase-db not ready"
DB_PORT=$(sed -n 's/^POSTGRES_PORT=//p' "$SUPA/.env"); DB_PORT=${DB_PORT:-5432}
DATABASE_URL="postgresql://postgres.$TENANT:$PG_PASSWORD@127.0.0.1:$DB_PORT/postgres"
for _ in $(seq 1 60); do
  db_ok=0
  "$APP/.venv/bin/python" -c "import asyncio,asyncpg,sys;asyncio.run(asyncpg.connect(sys.argv[1]))" "$DATABASE_URL" 2>/dev/null && db_ok=1 && break
  sleep 5
done
[ "$db_ok" = 1 ] || die "cannot connect to Postgres through the Supabase pooler"

# ---------------------------------------------------------------- 5. Hermes home + config
log "Agent home and config.yaml"
install -d -o hermes -g hermes -m 750 "$HERMES_HOME_DIR" "$HERMES_HOME_DIR/workspaces"
umask 077
cat > "$APP_ENV" <<ENV
DATABASE_URL=$DATABASE_URL
SUPABASE_URL=http://127.0.0.1:8000
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
# Member logins: the dashboard "supabase" auth provider verifies GoTrue tokens with these.
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_JWT_SECRET=$JWT_SECRET
HERMES_HOME=$HERMES_HOME_DIR
ENV
umask 022
chown root:hermes "$APP_ENV" && chmod 640 "$APP_ENV"
# Model/provider API keys go in $HERMES_HOME/.env (secrets only), added by the operator.
[ -f "$HERMES_HOME_DIR/.env" ] || install -o hermes -g hermes -m 600 /dev/null "$HERMES_HOME_DIR/.env"

as_hermes "$APP/.venv/bin/python" - "$OWNER_ID" "$OWNER_PASSWORD" "$DASH_AUTH_SECRET" <<'PY'
import os, sys
from pathlib import Path
import yaml
from plugins.dashboard_auth.basic import hash_password
owner, password, secret = sys.argv[1:]
path = Path(os.environ["HERMES_HOME"]) / "config.yaml"
cfg = yaml.safe_load(path.read_text()) if path.exists() else {}
cfg = cfg or {}
def default(d, key, value):
    d.setdefault(key, value)
    return d[key]
default(cfg, "datastore", {"mode": "prod", "supabase_app": {"dsn": "${DATABASE_URL}"}})
mem = default(cfg, "memory", {})
mem.setdefault("provider", "supabase_pgvector")
mem.setdefault("embedding", {"provider": "local_http", "endpoint": "http://127.0.0.1:8791",
                             "model": "BAAI/bge-m3", "dim": 1024, "timeout_seconds": 120})
mem.setdefault("rag", {"enabled": True})
basic = default(default(cfg, "dashboard", {}), "basic_auth", {})
if not basic.get("password_hash"):
    basic.update(username=owner, password_hash=hash_password(password), secret=secret)
path.write_text(yaml.safe_dump(cfg, sort_keys=False))
path.chmod(0o600)
PY
chown -R hermes:hermes "$HERMES_HOME_DIR"

# ---------------------------------------------------------------- 6. database roles + first owner
log "Database roles and first owner"
# Run `hermes` as the service account with the app env (DATABASE_URL etc.) loaded.
run_env() { sudo -u hermes -H bash -c 'set -a; . "$0"; set +a; exec "$@"' "$APP_ENV" "$@"; }
hermes_db() { run_env "$APP/.venv/bin/hermes" "$@"; }
cd "$APP"
# A fresh database has no app schema yet; create it and the principal tables, then the
# non-BYPASSRLS hermes_app role. Membership is skipped: `GRANT hermes_app TO CURRENT_USER`
# kills the backend on self-hosted Supabase (see ensure_app_role), so agent-home reads
# through the separate agent_home_app LOGIN role below instead.
# pgvector is created here, once, before any service starts: on first boot the dashboard,
# gateway and app-mcp each run `CREATE EXTENSION IF NOT EXISTS vector` at the same moment,
# and all but one fail with a duplicate-key error on pg_extension.
run_env "$APP/.venv/bin/python" - <<'PY'
import asyncio
from hermes_cli.access import ensure_app_role, initialize_access
from hermes_cli.owner import _prod_app_store
async def main():
    store = _prod_app_store()
    connection = await store.connect()
    try:
        await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await initialize_access(connection)
        await ensure_app_role(connection, store.schema, grant_membership=False)
    finally:
        await connection.close()
asyncio.run(main())
PY
sudo -u hermes -H HERMES_APP_READ_DB_PASSWORD="$READ_DB_PASSWORD" \
  bash -c 'set -a; . "$0"; set +a; exec "$@"' "$APP_ENV" "$APP/.venv/bin/hermes" owner read-role
# `owner show` exits 0 even when no owner is set, so test its output.
hermes_db owner show 2>/dev/null | grep -q "^Owner:" || hermes_db owner init "$OWNER_ID" --display "$OWNER_ID"
hermes_db owner alias "$OWNER_ID" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 7. embedding service
log "Embedding service ($EMBED_MODEL)"
install -d -o hermes -g hermes "$EMBED" "$EMBED/models"
mkvenv "$EMBED/venv"
uv pip install -q --python "$EMBED/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu torch==2.13.0
uv pip install -q --python "$EMBED/venv/bin/python" sentence-transformers==5.7.0 transformers==5.15.1 \
  fastapi==0.141.1 uvicorn==0.52.4 huggingface-hub==1.28.0
if [ "${AQUARIUM_SKIP_EMBED_MODEL:-0}" != 1 ]; then
  sudo -u hermes -H "$EMBED/venv/bin/python" -c "
from huggingface_hub import snapshot_download
snapshot_download('$EMBED_MODEL', revision='$EMBED_REV', cache_dir='$EMBED/models')"
fi

# ---------------------------------------------------------------- 8. agent-home + app-mcp env
log "agent-home and app-mcp settings"
AH_DB_URL="postgresql://agent_home_app.$TENANT:$READ_DB_PASSWORD@127.0.0.1:$DB_PORT/postgres"
umask 077
cat > "$APP/agent-home/agent-home.env" <<ENV
AGENT_HOME_SESSION_SECRET=$SESSION_SECRET
DATABASE_URL=$AH_DB_URL
SUPABASE_URL=http://127.0.0.1:8000
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_KEY
AGENT_HOME_APP_MCP_SECRET=$APP_MCP_SECRET
AGENT_HOME_API_URL=http://127.0.0.1:9119
AGENT_HOME_DATASTORE_MODE=prod
PORT=3100
ENV
sed "s/^APP_MCP_TICKET_SECRET=.*/APP_MCP_TICKET_SECRET=$APP_MCP_SECRET/" app-mcp/deploy/app-mcp.env.example > app-mcp/app-mcp.env
umask 022
chown hermes:hermes agent-home/agent-home.env app-mcp/app-mcp.env
if [ "$SOURCE_MODE" = branch ]; then
  find "$APP" -path "$APP/.venv" -prune -o -print0 | xargs -0 chown hermes:hermes
else
  aq_release_writable_dirs "$APP"
fi
chown -R root:root "$APP/.venv"

# ---------------------------------------------------------------- 9. systemd
log "systemd units"
UNIT_DIR=/etc/systemd/system
fix_paths() { sed "s#/opt/data/hermes-agent#$APP#g; s#/opt/data/hermes-embed#$EMBED#g"; }
fix_paths < agent-home/deploy/agent-home.service > $UNIT_DIR/agent-home.service
fix_paths < app-mcp/deploy/app-mcp.service > $UNIT_DIR/app-mcp.service
fix_paths < deploy/hermes-embed.service > $UNIT_DIR/hermes-embed.service
# Template only (one instance per linked phone); see the unit file for how to start one.
fix_paths < deploy/hermes-wa-bridge@.service | sed "s#/opt/data/hermes-home#$HERMES_HOME_DIR#g" \
  > "$UNIT_DIR/hermes-wa-bridge@.service"
install -d -m 700 /etc/aquarium
# ProtectHome hides ~hermes, so point the Hugging Face cache/token lookups at the model dir.
sed -i "/^\[Service\]/a Environment=HF_HOME=$EMBED/hf" $UNIT_DIR/hermes-embed.service
if [ "${AQUARIUM_SKIP_EMBED_MODEL:-0}" = 1 ]; then sed -i 's/ --offline//' $UNIT_DIR/hermes-embed.service; fi
for svc in dashboard gateway; do
  if [ $svc = dashboard ]; then
    desc="Aquarium dashboard API (:9119, agent-home auth bridge)"
    cmd="$APP/.venv/bin/hermes dashboard --skip-build --host 0.0.0.0 --port 9119 --no-open"
    stop=20
  else
    desc="Aquarium messaging gateway"
    cmd="$APP/.venv/bin/hermes gateway run"
    # Same budget as `hermes gateway install` (max(60, drain) + 30): room to drain chats.
    stop=90
  fi
  cat > $UNIT_DIR/hermes-$svc.service <<UNIT
[Unit]
Description=$desc
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=hermes
Group=hermes
WorkingDirectory=$APP
Environment=PATH=$APP/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=$APP_ENV
ExecStart=$cmd
Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=$stop

[Install]
WantedBy=multi-user.target
UNIT
done
install -m 755 deploy/hermes-deploy.sh "$ROOT/deploy-hermes.sh"
systemctl daemon-reload
systemctl enable -q hermes-embed hermes-dashboard hermes-gateway app-mcp agent-home
systemctl restart hermes-embed hermes-dashboard hermes-gateway app-mcp agent-home

# ---------------------------------------------------------------- 10. Caddy
if [ -n "$HOME_DOMAIN$DASH_DOMAIN" ]; then
  log "Caddy + TLS"
  sse='@sse path /api/chat/stream /api/chat/attach /api/sessions/*/chat/stream*'
  {
    [ -n "$HOME_DOMAIN" ] && cat <<CADDY
$HOME_DOMAIN {
    $sse
    handle @sse {
        reverse_proxy 127.0.0.1:3100 {
            flush_interval -1
        }
    }
    @app_mcp_ws path /app-mcp/ws /app-mcp/folders/ws
    handle @app_mcp_ws {
        reverse_proxy 127.0.0.1:9221
    }
    handle {
        encode zstd gzip
        reverse_proxy 127.0.0.1:3100
    }
}
CADDY
    [ -n "$DASH_DOMAIN" ] && cat <<CADDY
$DASH_DOMAIN {
    $sse
    handle @sse {
        reverse_proxy 127.0.0.1:9119 {
            flush_interval -1
        }
    }
    handle {
        encode zstd gzip
        reverse_proxy 127.0.0.1:9119
    }
}
CADDY
  } > /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  systemctl enable -q caddy && systemctl reload-or-restart caddy
fi

# Services create their tables on first start; the read-only agent-home role only gets
# SELECT on tables that exist, so grant again now and pick it up.
sleep 20
sudo -u hermes -H HERMES_APP_READ_DB_PASSWORD="$READ_DB_PASSWORD" \
  bash -c 'set -a; . "$0"; set +a; exec "$@"' "$APP_ENV" "$APP/.venv/bin/hermes" owner read-role >/dev/null
systemctl restart agent-home

# ---------------------------------------------------------------- 11. health checks
log "Health checks"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ok    $1"; else echo "  FAIL  $1"; fail=1; fi; }
sleep 10
for u in hermes-embed hermes-dashboard hermes-gateway app-mcp agent-home; do
  for _ in $(seq 1 12); do systemctl is-active -q "$u" && break; sleep 5; done
  check "service $u active" "systemctl is-active -q $u"
done
check "supabase containers healthy" "[ \$(docker ps --filter health=unhealthy -q | wc -l) -eq 0 ]"
check "postgres reachable (pooler)" "'$APP/.venv/bin/python' -c \"import asyncio,asyncpg;asyncio.run(asyncpg.connect('$DATABASE_URL'))\""
for _ in $(seq 1 24); do curl -sf -o /dev/null http://127.0.0.1:3100/login && break; sleep 5; done
check "agent-home :3100/login" "curl -sf -o /dev/null http://127.0.0.1:3100/login"
check "dashboard :9119" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9119/ | grep -qE '^(200|302|401)$'"
if [ "${AQUARIUM_SKIP_EMBED_MODEL:-0}" != 1 ]; then
  for _ in $(seq 1 36); do curl -sf -m 30 -X POST http://127.0.0.1:8791/embed -H 'Content-Type: application/json' -d '{"texts":["ok"]}' -o /dev/null && break; sleep 5; done
  check "embedding :8791" "curl -sf -m 30 -X POST http://127.0.0.1:8791/embed -H 'Content-Type: application/json' -d '{\"texts\":[\"ok\"]}'"
fi
[ -n "$HOME_DOMAIN" ] && check "https://$HOME_DOMAIN/login" "curl -sf -o /dev/null https://$HOME_DOMAIN/login"

cat <<DONE

Aquarium installed (${HOME_DOMAIN:-http://127.0.0.1:3100}).
  Owner login : $OWNER_ID   (password in $SECRETS, key OWNER_PASSWORD)
  Secrets     : $SECRETS (root only)
  Next        : add your model API key(s) to $HERMES_HOME_DIR/.env, then
                systemctl restart hermes-gateway hermes-dashboard
DONE
if [ "$SOURCE_MODE" = branch ]; then
  echo "  Deploy later: $ROOT/deploy-hermes.sh $BRANCH"
else
  echo "  Version     : $VERSION  (upgrade: re-run this installer with --version <newer tag>)"
fi
exit $fail
