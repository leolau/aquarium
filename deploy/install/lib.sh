# shellcheck shell=bash disable=SC2034  # sets variables for install-aquarium.sh
# deploy/install/lib.sh — helpers sourced by install-aquarium.sh: pick + download + verify a
# signed release, install it into the versioned layout, pin tools and Supabase images, and add
# the system pieces Aquarium needs (VPN helper, WhatsApp bridge unit, automatic security
# updates, SSH check). Each function stands alone so tests/test_install_aquarium_sh.py can
# source this file and run it against temp directories.

AQ_OPT=${AQ_OPT:-/opt/aquarium}                 # releases/<version>, current -> releases/<version>
AQ_TOOLS=${AQ_TOOLS:-/usr/local/lib/aquarium}   # pinned helper binaries (cosign)
AQ_ROOTFS=${AQ_ROOTFS:-}                        # prefix for /etc and /usr paths (tests only)
AQ_CODE_OWNER=${AQ_CODE_OWNER:-root:root}       # owner of installed code
AQ_GITHUB_REPO=${AQ_GITHUB_REPO:-leolau/aquarium}
AQ_GITHUB_API=${AQ_GITHUB_API:-https://api.github.com}
AQ_GITHUB_DL=${AQ_GITHUB_DL:-https://github.com}
AQ_OIDC_ISSUER=https://token.actions.githubusercontent.com
AQ_VERSION_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'

aq_warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
aq_fail() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; return 1; }

# ------------------------------------------------------------------ command line
# Sets SOURCE_MODE (release|branch|checkout|help), REQ_VERSION, CHANNEL and, for --from-branch,
# BRANCH; CHECK_ONLY, ASSUME_YES; ARG_<NAME> + ARG_SET for instance settings given as options.
# No source option: AQUARIUM_BRANCH set = branch install (older usage); else, when the installer
# runs from a git clone (AQ_CHECKOUT), that clone; else the newest stable release.
aq_parse_args() {
  SOURCE_MODE=release CHANNEL=stable REQ_VERSION='' CHECK_ONLY=0 ASSUME_YES=0 ARG_SET=" "
  ARG_HOME_DOMAIN='' ARG_DASHBOARD_DOMAIN='' ARG_ORG_NAME='' ARG_OWNER_EMAIL='' ARG_OWNER_ID=''
  [ -n "${AQUARIUM_BRANCH:-}" ] && SOURCE_MODE=branch
  local picked=0 help=0 name
  while [ $# -gt 0 ]; do
    case $1 in --*=*) set -- "${1%%=*}" "${1#*=}" "${@:2}" ;; esac
    case $1 in
      --version|--channel|--from-branch)
        [ $# -ge 2 ] && [ -n "$2" ] || { aq_fail "$1 needs a value"; return 1; }
        picked=$((picked + 1))
        case $1 in
          --version) REQ_VERSION=$2 SOURCE_MODE=release ;;
          --channel) CHANNEL=$2 SOURCE_MODE=release ;;
          --from-branch) BRANCH=$2 SOURCE_MODE=branch ;;
        esac
        shift 2 ;;
      --from-checkout) picked=$((picked + 1)) SOURCE_MODE=checkout; shift ;;
      --home-domain|--dashboard-domain|--org-name|--owner-email|--owner-id)
        # An empty value is allowed (e.g. --home-domain '' = no public domain).
        [ $# -ge 2 ] || { aq_fail "$1 needs a value"; return 1; }
        name=$(printf '%s' "${1#--}" | tr 'a-z-' 'A-Z_')
        printf -v "ARG_$name" '%s' "$2"
        ARG_SET="$ARG_SET$name "
        shift 2 ;;
      --check) CHECK_ONLY=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help) help=1; shift ;;
      *) aq_fail "unknown option: $1 (see --help)"; return 1 ;;
    esac
  done
  [ "$picked" -le 1 ] || { aq_fail "use only one of --version, --channel, --from-branch, --from-checkout"; return 1; }
  if [ "$picked" -eq 0 ] && [ -z "${AQUARIUM_BRANCH:-}" ] && [ -n "${AQ_CHECKOUT:-}" ]; then
    SOURCE_MODE=checkout
  fi
  case $CHANNEL in stable|beta) ;; *) aq_fail "--channel must be stable or beta (got '$CHANNEL')"; return 1 ;; esac
  if [ -n "$REQ_VERSION" ] && ! [[ $REQ_VERSION =~ $AQ_VERSION_RE ]]; then
    aq_fail "--version must look like v1.2.3 (got '$REQ_VERSION')"; return 1
  fi
  if [ "$SOURCE_MODE" = checkout ] && [ -z "${AQ_CHECKOUT:-}" ]; then
    aq_fail "--from-checkout needs install-aquarium.sh to run from a git clone (git clone ... && cd aquarium && sudo ./install-aquarium.sh)"
    return 1
  fi
  if [ "$help" = 1 ]; then SOURCE_MODE=help; fi
}

# ------------------------------------------------------------------ instance settings
# One KEY=VALUE file per server (also read by `aquarium`, deploy/aquarium.py read_kv): the
# answers given at install time, so a re-run asks nothing and changes nothing. No secrets here.
AQ_INSTANCE_CONF=${AQ_INSTANCE_CONF:-$AQ_ROOTFS/etc/aquarium/aquarium.conf}
AQ_INSTANCE_KEYS="ORG_NAME HOME_DOMAIN DASHBOARD_DOMAIN OWNER_ID OWNER_EMAIL"

aq_conf_get() {  # FILE KEY: prints the value; returns 1 if KEY is not in FILE
  [ -f "$1" ] || return 1
  python3 - "$1" "$2" <<'PY'
import sys
path, key = sys.argv[1:]
found = None
try:
    text = open(path, encoding="utf-8").read()
except OSError:
    sys.exit(1)
for line in text.splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    if line.startswith("export "):
        line = line[7:]
    k, v = line.split("=", 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    if k.strip() == key:
        found = v
if found is None:
    sys.exit(1)
print(found)
PY
}

aq_conf_set() {  # FILE KEY=VALUE...: replace or append each key, keep every other line (0644)
  python3 - "$@" <<'PY'
import os, re, sys, tempfile
path, pairs = sys.argv[1], [a.split("=", 1) for a in sys.argv[2:]]
try:
    lines = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    lines = ["# Aquarium instance settings, written by install-aquarium.sh (re-runs reuse them).",
             "# Also read by the `aquarium` admin command. No secrets in this file."]
def render(k, v):
    if any(c in v for c in "\"\\\n\r$`"):
        sys.exit(f"refusing to write {k}: value has a quote, backslash, $, backtick or newline")
    return f"{k}={v}" if re.fullmatch(r"[A-Za-z0-9._@:/+-]*", v) else f'{k}="{v}"'
for k, v in pairs:
    pat = re.compile(rf"^\s*(export\s+)?{re.escape(k)}\s*=")
    hits = [i for i, l in enumerate(lines) if pat.match(l)]
    if hits:
        lines[hits[0]] = render(k, v)
        lines = [l for i, l in enumerate(lines) if i not in hits[1:]]
    else:
        lines.append(render(k, v))
d = os.path.dirname(path) or "."
os.makedirs(d, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=d, prefix=".aquarium.conf.")
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY
}

AQ_DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
AQ_EMAIL_RE='^[^[:space:]@"\\$`]+@[^[:space:]@"\\$`]+\.[^[:space:]@"\\$`]+$'
AQ_ORG_RE='^[^"\\$`[:cntrl:]]{1,80}$'
AQ_OWNER_RE='^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$'

aq_check_setting() {  # NAME VALUE: prints why VALUE is not acceptable for NAME (empty = fine)
  case $1 in
    HOME_DOMAIN|DASHBOARD_DOMAIN)
      [ -z "$2" ] || { [ ${#2} -le 253 ] && [[ $2 =~ $AQ_DOMAIN_RE ]]; } \
        || echo "'$2' is not a host name like app.example.org (lowercase, no http://, no port)" ;;
    OWNER_EMAIL) [ -z "$2" ] || [[ $2 =~ $AQ_EMAIL_RE ]] || echo "'$2' is not an email address" ;;
    ORG_NAME) [[ $2 =~ $AQ_ORG_RE ]] || echo "the organization name must be 1-80 characters without quotes, \\, \$ or backticks" ;;
    OWNER_ID) [[ $2 =~ $AQ_OWNER_RE ]] || echo "'$2' is not a login name (letters, digits, . _ @ -; up to 64)" ;;
  esac
}

aq_normalize_setting() {  # NAME VALUE: trimmed; host names and emails lowercased, trailing dot dropped
  local v=$2
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  case $1 in
    HOME_DOMAIN|DASHBOARD_DOMAIN) v=$(printf '%s' "$v" | tr 'A-Z' 'a-z'); v=${v%.} ;;
    OWNER_EMAIL) v=$(printf '%s' "$v" | tr 'A-Z' 'a-z') ;;
  esac
  printf '%s' "$v"
}

aq_setting_default() {
  case $1 in ORG_NAME) echo Aquarium ;; OWNER_ID) echo admin ;; *) echo ;; esac
}

aq_setting_question() {
  case $1 in
    ORG_NAME) echo "Organization name for this instance" ;;
    HOME_DOMAIN) echo "Public host name for the app, e.g. aquarium.example.org (empty = none, local test only)" ;;
    DASHBOARD_DOMAIN) echo "Public host name for the operator dashboard, e.g. admin.example.org (empty = none)" ;;
    OWNER_ID) echo "Owner login name" ;;
    OWNER_EMAIL) echo "Owner email (Let's Encrypt certificate notices; empty = none)" ;;
  esac
}

aq_interactive() {  # prompts only with a terminal to ask on, and never with --yes
  [ "${ASSUME_YES:-0}" != 1 ] && { : < "${AQ_TTY:-/dev/tty}"; } 2>/dev/null
}

# aq_resolve_instance: sets each of AQ_INSTANCE_KEYS from the first of: --option, AQUARIUM_<KEY>
# (non-empty), the saved instance config, an answer at the prompt (interactive runs only), the
# default. Every value is checked; asks to confirm when it prompted. Writes nothing.
aq_resolve_instance() {
  local key val src why env asked=0 tries ans interactive=0
  aq_interactive && interactive=1 && exec 3< "${AQ_TTY:-/dev/tty}"
  for key in $AQ_INSTANCE_KEYS; do
    env="AQUARIUM_$key"
    if [[ $ARG_SET == *" $key "* ]]; then val=ARG_$key; val=${!val}; src="--$(printf '%s' "$key" | tr 'A-Z_' 'a-z-')"
    elif [ -n "${!env:-}" ]; then val=${!env}; src=$env
    elif val=$(aq_conf_get "$AQ_INSTANCE_CONF" "$key"); then src=$AQ_INSTANCE_CONF
    elif [ "$interactive" = 1 ]; then
      asked=1 tries=0
      while :; do
        printf '%s [%s]: ' "$(aq_setting_question "$key")" "$(aq_setting_default "$key")" >&2
        IFS= read -r ans <&3 || { echo >&2; aq_fail "no answer for $key"; return 1; }
        val=$(aq_normalize_setting "$key" "${ans:-$(aq_setting_default "$key")}")
        why=$(aq_check_setting "$key" "$val")
        [ -n "$why" ] || break
        printf '  %s\n' "$why" >&2
        tries=$((tries + 1))
        [ "$tries" -lt 5 ] || { aq_fail "no valid answer for $key"; return 1; }
      done
      src=prompt
    else val=$(aq_setting_default "$key"); src=default
    fi
    val=$(aq_normalize_setting "$key" "$val")
    why=$(aq_check_setting "$key" "$val")
    [ -z "$why" ] || { aq_fail "$key from $src: $why"; return 1; }
    printf -v "$key" '%s' "$val"
  done
  if [ -n "$HOME_DOMAIN" ] && [ "$HOME_DOMAIN" = "$DASHBOARD_DOMAIN" ]; then
    aq_fail "the app and the dashboard need two different host names (both are $HOME_DOMAIN)"; return 1
  fi
  if [ "$asked" = 1 ]; then
    aq_instance_summary >&2
    printf 'Install with these settings? [Y/n]: ' >&2
    IFS= read -r ans <&3 || ans=n
    case $ans in ""|y|Y|yes|YES) ;; *) aq_fail "stopped; nothing was changed"; return 1 ;; esac
  fi
  [ "$interactive" = 0 ] || exec 3<&-
}

aq_instance_summary() {
  printf '\nInstance settings:\n'
  printf '  %-17s %s\n' "Organization" "$ORG_NAME" "App domain" "${HOME_DOMAIN:-(none: no HTTPS, local only)}" \
    "Dashboard domain" "${DASHBOARD_DOMAIN:-(none)}" "Owner login" "$OWNER_ID" "Owner email" "${OWNER_EMAIL:-(none)}"
}

aq_save_instance() {  # [KEY=VALUE...]: the resolved settings plus any extra keys
  local key pairs=()
  for key in $AQ_INSTANCE_KEYS; do pairs+=("$key=${!key}"); done
  [ -d "$(dirname "$AQ_INSTANCE_CONF")" ] || install -d -m 711 "$(dirname "$AQ_INSTANCE_CONF")"
  aq_conf_set "$AQ_INSTANCE_CONF" "${pairs[@]}" "$@"
}

# ------------------------------------------------------------------ preflight (read-only)
# aq_preflight [DOMAIN...]: what the install needs, one line per check (ok / warn / FAIL).
# Returns 1 on any FAIL. Changes nothing and needs no root, so `--check` can run it anywhere.
aq_preflight() {
  local fails=0 id ver arch mem_gb cpus disk_gb listeners port who d ips mine domains=0
  for d in "$@"; do [ -z "$d" ] || domains=1; done
  aq__row() { printf '  %-5s %s\n' "$1" "$2"; [ "$1" != FAIL ] || fails=1; }
  id=$( (. "$AQ_ROOTFS/etc/os-release" 2>/dev/null; echo "${ID:-unknown}") )
  ver=$( (. "$AQ_ROOTFS/etc/os-release" 2>/dev/null; echo "${VERSION_ID:-?}") )
  if [ "$id" != ubuntu ]; then aq__row FAIL "OS: $id $ver (Ubuntu 24.04 required)"
  elif [ "$ver" != 24.04 ]; then aq__row warn "OS: Ubuntu $ver (tested on 24.04 only)"
  else aq__row ok "OS: Ubuntu $ver"; fi
  arch=$(uname -m)
  if [ "$arch" = x86_64 ]; then aq__row ok "CPU: $arch"
  else aq__row FAIL "CPU: $arch (x86_64 required: the pinned uv/cosign downloads are x86_64)"; fi
  cpus=$(nproc 2>/dev/null || echo 1)
  if [ "$cpus" -ge 2 ]; then aq__row ok "CPU cores: $cpus"; else aq__row warn "CPU cores: $cpus (2+ recommended)"; fi
  mem_gb=$(awk '/^MemTotal:/ {printf "%d", ($2 / 1048576) + 0.5}' "$AQ_ROOTFS/proc/meminfo" 2>/dev/null)
  mem_gb=${mem_gb:-0}
  if [ "$mem_gb" -ge 8 ]; then aq__row ok "memory: ${mem_gb} GB"
  elif [ "$mem_gb" -ge 4 ]; then aq__row warn "memory: ${mem_gb} GB (8 GB+ recommended; Supabase + the embedding model are tight below that)"
  else aq__row FAIL "memory: ${mem_gb} GB (4 GB minimum, 8 GB+ recommended)"; fi
  disk_gb=$(df -BG --output=avail "${AQ_DISK_PATH:-/}" 2>/dev/null | tail -1 | tr -dc 0-9 || true)
  disk_gb=${disk_gb:-0}
  if [ "$disk_gb" -ge 25 ]; then aq__row ok "free disk: ${disk_gb} GB"
  else aq__row FAIL "free disk: ${disk_gb} GB (25 GB minimum)"; fi
  if [ "$(id -u)" -eq 0 ]; then aq__row ok "running as root"
  else aq__row warn "not running as root (the install itself needs sudo)"; fi
  if listeners=$(ss -Htlnp 2>/dev/null); then
    for port in 80 443; do
      who=$(printf '%s\n' "$listeners" | awk -v p=":$port" 'substr($4, length($4) - length(p) + 1) == p { print $0 }')
      if [ -z "$who" ]; then aq__row ok "port $port is free"
      elif printf '%s' "$who" | grep -q '"caddy"'; then aq__row ok "port $port: Caddy (an earlier install)"
      elif [ "$domains" = 1 ]; then aq__row FAIL "port $port is in use by another program (Caddy needs 80/443 for HTTPS): $(printf '%s' "$who" | awk '{print $4, $6}' | head -1)"
      else aq__row warn "port $port is in use by another program (only matters with a domain)"; fi
    done
  else
    aq__row warn "could not list listening ports (ss missing)"
  fi
  mine=$(hostname -I 2>/dev/null | xargs || true)
  for d in "$@"; do
    [ -n "$d" ] || continue
    ips=$(getent ahostsv4 "$d" 2>/dev/null | awk '{print $1}' | sort -u | xargs || true)
    if [ -z "$ips" ]; then
      aq__row warn "DNS: $d does not resolve yet. Add an A record for it pointing at this server${mine:+ ($mine)}; HTTPS certificates are issued once it does."
    elif [ -n "$mine" ] && [ -n "$(comm -12 <(tr ' ' '\n' <<<"$ips" | sort) <(tr ' ' '\n' <<<"$mine" | sort))" ]; then
      aq__row ok "DNS: $d -> $ips (this server)"
    else
      aq__row warn "DNS: $d -> $ips, but this server's addresses are ${mine:-unknown}. Fine only if that address forwards ports 80/443 here."
    fi
  done
  if [ "$fails" = 0 ]; then echo "Preflight: ready to install."; else echo "Preflight: fix the FAIL lines above first."; fi
  [ "$fails" = 0 ]
}

# ------------------------------------------------------------------ install from a git clone
aq_git() {  # git on a checkout root does not own: no hooks, no fsmonitor, no ownership refusal
  local dir=$1; shift
  git -c safe.directory="$dir" -c core.hooksPath=/dev/null -c core.fsmonitor=false -C "$dir" "$@"
}

# aq_sync_checkout SRC DEST: DEST becomes a copy of the clone SRC, .git included (later updates
# fetch from the same origin). Dependencies, build output and local env files are not copied, and
# DEST's own are kept. SRC = DEST (cloned straight into place): nothing to copy.
aq_sync_checkout() {
  local src dest
  src=$(realpath "$1") dest=$(realpath -m "$2")
  [ -d "$src/.git" ] || { aq_fail "$src is not a plain git clone (a .git folder is needed; worktrees are not supported)"; return 1; }
  aq_git "$src" rev-parse --verify -q HEAD >/dev/null || { aq_fail "$src has no commit checked out"; return 1; }
  [ "$src" != "$dest" ] || return 0
  case "$dest/" in "$src"/*) aq_fail "cannot install into $dest: it is inside the clone $src"; return 1 ;; esac
  case "$src/" in "$dest"/*) aq_fail "cannot install from $src: it is inside the install folder $dest"; return 1 ;; esac
  if [ -n "$(aq_git "$src" status --porcelain --untracked-files=no)" ]; then
    aq_warn "$src has uncommitted changes; they are installed too, but updates refuse to run until they are committed upstream"
  fi
  mkdir -p "$(dirname "$dest")"
  rsync -a --delete \
    --exclude=node_modules/ --exclude=/.venv/ --exclude=/venv/ --exclude=__pycache__/ \
    --exclude=/agent-home/.next/ --exclude=/web/dist/ \
    --exclude=/.env --exclude=/.env.local --exclude=/agent-home/agent-home.env --exclude=/app-mcp/app-mcp.env \
    "$src/" "$dest/"
}

# ------------------------------------------------------------------ release pick + download
# aq_pick_release CHANNEL < releases.json  — newest published tag on the channel.
# stable = full releases only; beta = full releases and pre-releases. Drafts never count.
aq_pick_release() {
  python3 -c '
import json, re, sys
channel, pattern = sys.argv[1], re.compile(sys.argv[2])
for rel in json.load(sys.stdin):
    tag = rel.get("tag_name") or ""
    if rel.get("draft") or not pattern.match(tag):
        continue
    if channel == "stable" and rel.get("prerelease"):
        continue
    print(tag)
    break
' "$1" "$AQ_VERSION_RE"
}

aq_resolve_version() {  # prints the tag to install (REQ_VERSION, else newest on CHANNEL)
  if [ -n "$REQ_VERSION" ]; then printf '%s\n' "$REQ_VERSION"; return 0; fi
  local tag
  tag=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
    "$AQ_GITHUB_API/repos/$AQ_GITHUB_REPO/releases?per_page=50" | aq_pick_release "$CHANNEL")
  [ -n "$tag" ] || { aq_fail "no $CHANNEL release of $AQ_GITHUB_REPO is published yet (for a development install use --from-branch develop)"; return 1; }
  printf '%s\n' "$tag"
}

aq_tarball_name() { printf 'aquarium-%s-linux-x86_64.tar.gz' "$1"; }

aq_download_release() {  # VERSION DIR: the tarball and its signed checksum list
  local base="$AQ_GITHUB_DL/$AQ_GITHUB_REPO/releases/download/$1" f
  for f in "$(aq_tarball_name "$1")" SHA256SUMS SHA256SUMS.sig SHA256SUMS.pem; do
    curl -fsSL --retry 3 -o "$2/$f" "$base/$f" || { aq_fail "cannot download $f of release $1"; return 1; }
  done
}

aq_fetch_verified() {  # URL SHA256 DEST: download, keep only if the sha256 matches
  local tmp
  tmp=$(mktemp "$3.XXXXXX")
  if ! curl -fsSL --retry 3 -o "$tmp" "$1"; then rm -f "$tmp"; aq_fail "download failed: $1"; return 1; fi
  if ! printf '%s  %s\n' "$2" "$tmp" | sha256sum -c --status; then
    rm -f "$tmp"; aq_fail "checksum mismatch for $1 (expected sha256 $2)"; return 1
  fi
  mv -f "$tmp" "$3"
}

aq_install_cosign() {  # prints the path of the pinned cosign (COSIGN_VERSION/COSIGN_SHA256)
  local bin="$AQ_TOOLS/cosign-$COSIGN_VERSION"
  if ! { [ -x "$bin" ] && printf '%s  %s\n' "$COSIGN_SHA256" "$bin" | sha256sum -c --status; }; then
    install -d -m 755 "$AQ_TOOLS"
    aq_fetch_verified "$AQ_GITHUB_DL/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-amd64" \
      "$COSIGN_SHA256" "$bin" || return 1
    chmod 755 "$bin"
  fi
  printf '%s\n' "$bin"
}

# The only signer accepted: the release workflow of this repo, running for exactly this tag.
aq_release_identity() {
  printf 'https://github.com/%s/.github/workflows/%s@refs/tags/%s' \
    "$AQ_GITHUB_REPO" "$AQUARIUM_RELEASE_WORKFLOW" "$1"
}

aq_verify_release() {  # COSIGN DIR VERSION: signature over SHA256SUMS, then the tarball's sum
  local cosign=$1 dir=$2 v=$3 tarball line
  tarball=$(aq_tarball_name "$v")
  if ! "$cosign" verify-blob \
      --certificate "$dir/SHA256SUMS.pem" --signature "$dir/SHA256SUMS.sig" \
      --certificate-identity "$(aq_release_identity "$v")" \
      --certificate-oidc-issuer "$AQ_OIDC_ISSUER" \
      "$dir/SHA256SUMS" >/dev/null; then
    aq_fail "signature check failed: SHA256SUMS of $v was not signed by the $AQ_GITHUB_REPO release workflow for tag $v"
    return 1
  fi
  line=$(awk -v f="$tarball" '$2 == f || $2 == "*" f' "$dir/SHA256SUMS")
  [ -n "$line" ] && [ "$(printf '%s\n' "$line" | wc -l)" -eq 1 ] \
    || { aq_fail "SHA256SUMS of $v has no single entry for $tarball"; return 1; }
  (cd "$dir" && printf '%s\n' "$line" | sha256sum -c --status) \
    || { aq_fail "checksum mismatch for $tarball"; return 1; }
}

# ------------------------------------------------------------------ versioned layout
aq_unpack_release() {  # TARBALL VERSION: extract to $AQ_OPT/releases/VERSION (kept if present)
  local tarball=$1 v=$2 top="aquarium-$2" dest="$AQ_OPT/releases/$2" stage bad root
  [ -d "$dest" ] && return 0
  bad=$(tar -tzf "$tarball" | awk -v top="$top" '
    !(($0 == top || $0 == top "/" || index($0, top "/") == 1) && $0 !~ /(^|\/)\.\.(\/|$)/) { print; exit }')
  [ -z "$bad" ] || { aq_fail "release archive has an entry outside $top/: $bad"; return 1; }
  install -d -m 755 "$AQ_OPT" "$AQ_OPT/releases"
  stage=$(mktemp -d "$AQ_OPT/releases/.stage-$v.XXXXXX")
  tar -xzf "$tarball" -C "$stage" --no-same-owner
  root=$(realpath "$stage/$top")
  bad=$(find "$stage/$top" -type l -print0 | while IFS= read -r -d '' link; do
    case $(realpath -m "$link") in "$root"|"$root"/*) ;; *) printf '%s\n' "${link#"$stage/"}" ;; esac
  done | head -1)
  if [ -n "$bad" ]; then rm -rf "$stage"; aq_fail "release archive has a link pointing outside it: $bad"; return 1; fi
  chown -R "$AQ_CODE_OWNER" "$stage/$top"
  chmod -R go-w "$stage/$top"
  chmod 755 "$stage/$top"
  mv "$stage/$top" "$dest"
  rmdir "$stage"
}

aq_activate_release() {  # VERSION COMPAT: current -> releases/VERSION; COMPAT -> current
  local v=$1 compat=$2
  [ -d "$AQ_OPT/releases/$v" ] || { aq_fail "release $v is not unpacked"; return 1; }
  aq_check_compat_path "$compat" || return 1
  ln -sfn "releases/$v" "$AQ_OPT/current.new" && mv -Tf "$AQ_OPT/current.new" "$AQ_OPT/current"
  mkdir -p "$(dirname "$compat")"
  ln -sfn "$AQ_OPT/current" "$compat.new" && mv -Tf "$compat.new" "$compat"
}

aq_check_compat_path() {  # COMPAT must be absent or a symlink (never replace a real checkout)
  if [ -e "$1" ] && [ ! -L "$1" ]; then
    aq_fail "$1 is a real folder from an earlier branch install. Re-run with --from-branch, or move it away first to switch to release installs."
    return 1
  fi
}

aq_release_writable_dirs() {  # APP: the paths the hermes account writes inside a release
  install -d -m 750 "$1/agent-home/.next/cache"
  chown -R hermes:hermes "$1/agent-home/.next/cache"
}

# ------------------------------------------------------------------ pinned tools
aq_install_node() {  # NodeSource apt repo, exact NODE_DEB_VERSION
  [ "$(node -v 2>/dev/null)" = "v${NODE_DEB_VERSION%%-*}" ] && return 0
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_DEB_VERSION%%.*}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -y -q --allow-downgrades "nodejs=$NODE_DEB_VERSION"
}

aq_install_uv() {  # GitHub release tarball, sha256-checked (UV_VERSION/UV_SHA256)
  [ "$(uv --version 2>/dev/null | awk '{print $2}')" = "$UV_VERSION" ] && return 0
  local tmp name=uv-x86_64-unknown-linux-gnu
  tmp=$(mktemp -d)
  aq_fetch_verified "$AQ_GITHUB_DL/astral-sh/uv/releases/download/$UV_VERSION/$name.tar.gz" \
    "$UV_SHA256" "$tmp/uv.tar.gz" || { rm -rf "$tmp"; return 1; }
  tar -xzf "$tmp/uv.tar.gz" -C "$tmp" --no-same-owner
  install -m 755 "$tmp/$name/uv" "$tmp/$name/uvx" "$AQ_ROOTFS/usr/local/bin/"
  rm -rf "$tmp"
}

aq_install_caddy() {  # Caddy apt repo, exact CADDY_DEB_VERSION
  [ "$(dpkg-query -W -f='${Version}' caddy 2>/dev/null)" = "$CADDY_DEB_VERSION" ] && return 0
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q --allow-downgrades "caddy=$CADDY_DEB_VERSION"
}

# ------------------------------------------------------------------ Supabase at a fixed commit
aq_fetch_supabase() {  # COMMIT DEST [URL]: docker/ folder of supabase/supabase at exactly COMMIT
  local commit=$1 dest=$2 url=${3:-https://github.com/supabase/supabase}
  rm -rf "$dest"
  git init -q "$dest"
  git -C "$dest" remote add origin "$url"
  git -C "$dest" sparse-checkout set docker
  git -C "$dest" fetch -q --depth 1 --filter=blob:none origin "$commit"
  git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$dest" rev-parse HEAD)" = "$commit" ] \
    || { aq_fail "supabase checkout is not at $commit"; return 1; }
}

aq_pin_compose_images() {  # COMPOSE LOCK: rewrite every `image: name:tag` to name:tag@digest
  python3 - "$1" "$2" <<'PY'
import re, sys
compose, lock = sys.argv[1:]
pins = {}
for raw in open(lock):
    line = raw.split("#", 1)[0].strip()
    if line:
        ref, digest = line.rsplit("@", 1)
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            sys.exit(f"bad digest in {lock}: {line}")
        pins[ref] = digest
image = re.compile(r"""^(\s*image:\s*)["']?([^"'\s@]+)(@sha256:[0-9a-f]{64})?["']?\s*$""")
out, missing = [], set()
for line in open(compose).read().splitlines():
    match = image.match(line)
    if match:
        if match.group(2) in pins:
            line = f"{match.group(1)}{match.group(2)}@{pins[match.group(2)]}"
        else:
            missing.add(match.group(2))
    out.append(line)
if missing:
    sys.exit(f"{compose}: images without a digest in {lock}: {', '.join(sorted(missing))}")
open(compose, "w").write("\n".join(out) + "\n")
PY
}

# ------------------------------------------------------------------ system components
aq_install_vpn_support() {  # APP: VPN client, SMB mount support, the root VPN helper + sudoers
  local app=$1 extra
  extra="linux-modules-extra-$(uname -r)"
  apt-get install -y -q openfortivpn cifs-utils
  if apt-cache show "$extra" >/dev/null 2>&1; then
    apt-get install -y -q "$extra"
  else
    aq_warn "$extra is not available for this kernel; office file shares with non-English file names may not mount"
  fi
  if modprobe nls_utf8 2>/dev/null; then
    install -d -m 755 "$AQ_ROOTFS/etc/modules-load.d"
    echo nls_utf8 > "$AQ_ROOTFS/etc/modules-load.d/aquarium-nls.conf"
  else
    aq_warn "could not load the nls_utf8 kernel module; reboot (new kernel) and re-run the installer"
  fi
  install -d -m 755 "$AQ_ROOTFS/usr/local/sbin" "$AQ_ROOTFS/etc/sudoers.d"
  install -m 755 "$app/deploy/hermes-vpn-helper" "$AQ_ROOTFS/usr/local/sbin/hermes-vpn-helper"
  chown "$AQ_CODE_OWNER" "$AQ_ROOTFS/usr/local/sbin/hermes-vpn-helper"
  visudo -cqf "$app/deploy/sudoers.d/hermes-vpn" \
    || { aq_fail "deploy/sudoers.d/hermes-vpn does not pass visudo"; return 1; }
  install -m 440 "$app/deploy/sudoers.d/hermes-vpn" "$AQ_ROOTFS/etc/sudoers.d/hermes-vpn"
  chown "$AQ_CODE_OWNER" "$AQ_ROOTFS/etc/sudoers.d/hermes-vpn"
}

aq_install_security_check() {  # APP: read-only root helper + sudoers for Get ready → Security basics
  local app=$1
  install -d -m 755 "$AQ_ROOTFS/usr/local/sbin" "$AQ_ROOTFS/etc/sudoers.d"
  visudo -cqf "$app/deploy/sudoers.d/hermes-security-check" \
    || { aq_fail "deploy/sudoers.d/hermes-security-check does not pass visudo"; return 1; }
  install -m 755 "$app/deploy/hermes-security-check" "$AQ_ROOTFS/usr/local/sbin/hermes-security-check"
  chown "$AQ_CODE_OWNER" "$AQ_ROOTFS/usr/local/sbin/hermes-security-check"
  install -m 440 "$app/deploy/sudoers.d/hermes-security-check" "$AQ_ROOTFS/etc/sudoers.d/hermes-security-check"
  chown "$AQ_CODE_OWNER" "$AQ_ROOTFS/etc/sudoers.d/hermes-security-check"
}

aq_enable_unattended_upgrades() {  # automatic Ubuntu security updates (keeps an operator's choice)
  local conf="$AQ_ROOTFS/etc/apt/apt.conf.d/20auto-upgrades"
  apt-get install -y -q unattended-upgrades
  if [ ! -f "$conf" ]; then
    install -d -m 755 "$(dirname "$conf")"
    printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > "$conf"
  elif ! grep -q 'Unattended-Upgrade "1"' "$conf"; then
    aq_warn "automatic security updates are switched off in $conf; left as is"
  fi
}

aq_ssh_warnings() {  # stdin: `sshd -T` output; prints one line per weak setting
  awk '
    $1 == "permitrootlogin" && $2 == "yes" { print "SSH lets root log in with a password (PermitRootLogin yes). Set it to prohibit-password." }
    $1 == "passwordauthentication" && $2 == "yes" { print "SSH accepts passwords (PasswordAuthentication yes). Use SSH keys and set it to no." }
    $1 == "kbdinteractiveauthentication" && $2 == "yes" { print "SSH accepts keyboard-interactive passwords (KbdInteractiveAuthentication yes). Set it to no." }
    $1 == "permitemptypasswords" && $2 == "yes" { print "SSH accepts empty passwords (PermitEmptyPasswords yes). Set it to no." }
  '
}

aq_ssh_check() {  # warn only: never changes SSH (a wrong change can lock the operator out)
  local out
  if ! out=$(sshd -T 2>/dev/null); then aq_warn "could not read the SSH server settings (sshd -T)"; return 0; fi
  printf '%s\n' "$out" | aq_ssh_warnings | while IFS= read -r line; do aq_warn "$line"; done
}

aq_install_app_runtime() {  # APP HERMES_HOME: FG-33 local-app units, slices, root helpers, sudoers
  local app=$1 home=$2 f conf
  local units="$AQ_ROOTFS/etc/systemd/system" sbin="$AQ_ROOTFS/usr/local/sbin"
  visudo -cqf "$app/deploy/sudoers.d/aquarium-apps" \
    || { aq_fail "deploy/sudoers.d/aquarium-apps does not pass visudo"; return 1; }
  install -d -m 755 "$units" "$sbin" "$AQ_ROOTFS/etc/sudoers.d" "$AQ_ROOTFS/var/lib/aquarium-apps"
  # Traverse-only, no listing: non-root code (watcher, agent) reads the quota policy and
  # apps.conf by name; the secrets beside them stay root 0600 and apps/ stays 0700.
  install -d -m 711 "$AQ_ROOTFS/etc/aquarium"
  install -d -m 700 "$AQ_ROOTFS/etc/aquarium/apps"
  # By glob, so later FG-33 units/helpers (watch timer, egress helper) need no installer edit.
  for f in "$app"/deploy/aquarium*.service "$app"/deploy/aquarium*.timer "$app"/deploy/aquarium*.slice; do
    [ -f "$f" ] || continue
    install -m 644 "$f" "$units/${f##*/}"
    chown "$AQ_CODE_OWNER" "$units/${f##*/}"
  done
  for f in "$app"/deploy/aquarium-app-*; do
    case $f in *.service|*.timer|*.slice) continue ;; esac
    [ -f "$f" ] || continue
    install -m 755 "$f" "$sbin/${f##*/}"
    chown "$AQ_CODE_OWNER" "$sbin/${f##*/}"
  done
  install -m 440 "$app/deploy/sudoers.d/aquarium-apps" "$AQ_ROOTFS/etc/sudoers.d/aquarium-apps"
  chown "$AQ_CODE_OWNER" "$AQ_ROOTFS/etc/sudoers.d/aquarium-apps"
  [ -d "$AQ_ROOTFS/etc/caddy" ] && install -d -m 755 "$AQ_ROOTFS/etc/caddy/apps.d"
  conf="$AQ_ROOTFS/etc/aquarium/apps.conf"
  if [ ! -e "$conf" ]; then  # keeps an owner's storage location on re-runs
    python3 -c 'import json, sys; print(json.dumps({"storage_base": "/var/lib/aquarium-apps", "tools_root": sys.argv[1] + "/tools"}, indent=2))' \
      "$home" > "$conf"
    chmod 644 "$conf"
    chown "$AQ_CODE_OWNER" "$conf"
  fi
  f="$AQ_ROOTFS/etc/aquarium/app-quotas.yaml"
  if [ ! -e "$f" ] && [ ! -L "$f" ] && [ -f "$app/deploy/install/app-quotas.yaml.example" ]; then
    install -m 644 "$app/deploy/install/app-quotas.yaml.example" "$f"  # keeps an owner's edits on re-runs
  fi
  # The quota policy must be readable by everyone but writable only by root
  # (hermes_cli/app_quota.py ignores a file that is not), also on boxes installed before.
  for f in apps.conf app-quotas.yaml app-limits.json; do
    f="$AQ_ROOTFS/etc/aquarium/$f"
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    chmod 644 "$f"
    chown "$AQ_CODE_OWNER" "$f"
  done
  find "$AQ_ROOTFS/etc/aquarium" -maxdepth 1 -type f -perm /o=r \
    ! -name apps.conf ! -name app-quotas.yaml ! -name app-limits.json ! -name aquarium.conf ! -name app-egress.json \
    | while IFS= read -r f; do aq_warn "$f is readable by every user; if it holds a secret run: chmod 600 $f"; done
  if [ -z "$AQ_ROOTFS" ]; then systemctl daemon-reload; fi
}
