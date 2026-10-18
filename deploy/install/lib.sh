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
# Sets SOURCE_MODE (release|branch|help), REQ_VERSION, CHANNEL and, for --from-branch, BRANCH.
# No option = newest stable release; AQUARIUM_BRANCH set = branch install (older usage).
aq_parse_args() {
  SOURCE_MODE=release CHANNEL=stable REQ_VERSION=
  [ -n "${AQUARIUM_BRANCH:-}" ] && SOURCE_MODE=branch
  local picked=0
  while [ $# -gt 0 ]; do
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
      -h|--help) SOURCE_MODE=help; shift ;;
      *) aq_fail "unknown option: $1 (use --version vX.Y.Z, --channel stable|beta or --from-branch BRANCH)"; return 1 ;;
    esac
  done
  [ "$picked" -le 1 ] || { aq_fail "use only one of --version, --channel, --from-branch"; return 1; }
  case $CHANNEL in stable|beta) ;; *) aq_fail "--channel must be stable or beta (got '$CHANNEL')"; return 1 ;; esac
  if [ -n "$REQ_VERSION" ] && ! [[ $REQ_VERSION =~ $AQ_VERSION_RE ]]; then
    aq_fail "--version must look like v1.2.3 (got '$REQ_VERSION')"; return 1
  fi
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
