#!/usr/bin/env bash
# uninstall-aquarium.sh — the reverse of install-aquarium.sh: removes one Aquarium instance from
# this server so the same box can be installed again from scratch and behave like a new install.
#
#   sudo ./uninstall-aquarium.sh                 # shows the plan, asks you to type the host name
#   sudo ./uninstall-aquarium.sh --yes           # no question (scripts)
#   sudo ./uninstall-aquarium.sh --dry-run       # only show what would be removed
#
# A backup is written first (database dump + tarball of the data and settings folders) under
# /var/backups/aquarium-uninstall/<time>/, which this script never removes. --no-backup skips it.
# OS packages (docker, caddy, node, uv, ...) stay installed unless --purge-packages.
# Only what install-aquarium.sh (or the aquarium tools it installs) creates is removed; running
# it again on a half-removed box is safe. Every path it removes is listed by --list.
set -Eeuo pipefail

R=${AQ_ROOTFS:-}            # tests only: a fake root filesystem every path is resolved under
YES=0 BACKUP=1 PURGE=0 DRY=0 LIST=0 DATA_ROOT_ARG=
BACKUP_PARENT=/var/backups/aquarium-uninstall

usage() {
  cat <<'USAGE'
Usage: sudo ./uninstall-aquarium.sh [--yes] [--no-backup] [--backup-dir DIR] [--purge-packages]
                                    [--data-root DIR] [--dry-run] [--list]
  --yes             do not ask for the typed confirmation
  --no-backup       do not write the database dump + data tarball first
  --backup-dir DIR  where the backup folder is created (default /var/backups/aquarium-uninstall)
  --purge-packages  also remove the packages and tools the installer added (caddy, docker, node, uv, ...)
  --data-root DIR   the data folder of the install (default: DATA_ROOT in /etc/aquarium/aquarium.conf,
                    else $AQUARIUM_ROOT, else /opt/data)
  --dry-run         print what would be removed and stop
  --list            print every path, unit and account the uninstaller covers (present or not)
USAGE
}

while [ $# -gt 0 ]; do
  case $1 in
    -y|--yes) YES=1 ;;
    --no-backup) BACKUP=0 ;;
    --backup-dir) [ $# -ge 2 ] || { usage >&2; exit 2; }; BACKUP_PARENT=$2; shift ;;
    --backup-dir=*) BACKUP_PARENT=${1#*=} ;;
    --purge-packages) PURGE=1 ;;
    --data-root) [ $# -ge 2 ] || { usage >&2; exit 2; }; DATA_ROOT_ARG=$2; shift ;;
    --data-root=*) DATA_ROOT_ARG=${1#*=} ;;
    --dry-run) DRY=1 ;;
    --list) LIST=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mwarning: %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
p() { printf '%s%s' "$R" "$1"; }   # logical path -> on-disk path

INSTANCE_CONF=/etc/aquarium/aquarium.conf
conf_get() {  # KEY: last value in aquarium.conf (quotes stripped), empty if absent
  [ -f "$(p "$INSTANCE_CONF")" ] || return 0
  sed -n "s/^$1=//p" "$(p "$INSTANCE_CONF")" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

ROOT=${DATA_ROOT_ARG:-$(conf_get DATA_ROOT)}
ROOT=${ROOT:-${AQUARIUM_ROOT:-/opt/data}}
APPS_BASE=$(conf_get APPS_BASE); APPS_BASE=${APPS_BASE:-/var/lib/aquarium-apps}
for x in "$ROOT" "$APPS_BASE" "$BACKUP_PARENT"; do
  case $x in /*) ;; *) die "paths must be absolute (got $x)" ;; esac
done
ROOT=$(realpath -m "$ROOT") APPS_BASE=$(realpath -m "$APPS_BASE") BACKUP_PARENT=$(realpath -m "$BACKUP_PARENT")
APP=$ROOT/hermes-agent
SUPA=$ROOT/supabase/docker
UNIT_DIR=/etc/systemd/system

check_owned_dir() {  # never let a setting turn into rm -rf of a system folder
  case $1 in
    ''|/|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/media|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/usr/*bin|/usr/local|/var|/var/lib|/var/backups|/var/log)
      die "$2 is $1: refusing to remove a system folder" ;;
  esac
}
check_owned_dir "$ROOT" "the data root"
check_owned_dir "$APPS_BASE" "APPS_BASE"

# ---------------------------------------------------------------- what the installer creates
# Units: install-aquarium.sh writes these by name; deploy/install/lib.sh copies every
# deploy/aquarium*.{service,timer,slice}; hermes-wa-bridge-add and `aquarium offsite` add hermes-*.
UNIT_NAMES=(agent-home.service app-mcp.service hermes-embed.service hermes-dashboard.service
  hermes-gateway.service hermes-wa-bridge@.service)
UNIT_GLOBS=('hermes-*.service' 'hermes-*.timer' 'aquarium*.service' 'aquarium*.timer' 'aquarium*.slice')
# Loaded units to stop, including instances (hermes-wa-bridge@x, aquarium-app@x) and the transient
# units the VPN / app helpers start with systemd-run (hermes-vpn-*, aquarium-app-idle-*).
UNIT_STOP_PATTERNS=('agent-home.service' 'app-mcp.service' 'hermes-*' 'aquarium*')

# Root-owned helpers in /usr/local/sbin (install-aquarium.sh, lib.sh, hermes-tools-setup).
SBIN_NAMES=(aquarium hermes-vpn-helper hermes-security-check hermes-wa-bridge-add hermes-tools-exec
  hermes-tools-cli)
SBIN_GLOBS=('aquarium-app-*')
SUDOERS_GLOBS=('hermes-*' 'aquarium-*')   # every file of deploy/sudoers.d is named like this

# Inside the data root: everything the installer puts there.
ROOT_ENTRIES=(hermes-agent hermes-home hermes-embed supabase deploy aquarium-secrets.env hermes.env
  deploy-hermes.sh backups)

# Everything else outside the data root (folders are removed with their contents).
SYSTEM_PATHS=(/etc/aquarium /etc/hermes-tools /usr/local/lib/hermes-tools /usr/local/lib/aquarium
  /opt/aquarium /etc/modules-load.d/aquarium-nls.conf /etc/caddy/apps.d "$APPS_BASE"
  /usr/local/share/uv/python /var/backups/hermes-tools-install /var/log/aquarium.log
  /run/aquarium.lock /run/aquarium-apps /run/aquarium-egress /run/aquarium-egress-proxy /run/hermes-vpn)

SERVICE_USERS=(hermes-tools hermes)        # removed only if they still look like the installer's

CADDYFILE=/etc/caddy/Caddyfile

# Only with --purge-packages: what install-aquarium.sh installs on top of Ubuntu for Aquarium.
# Base tools (git, curl, jq, rsync, sudo, ufw, build-essential, unattended-upgrades, ...), the
# firewall rules and the swap file stay: they are ordinary server setup another program may rely on.
PURGE_APT=(caddy nodejs openfortivpn cifs-utils tesseract-ocr)
PURGE_APT_DOCKER=(docker.io docker-compose-v2)
PURGE_PATHS=(/usr/local/bin/uv /usr/local/bin/uvx /etc/apt/sources.list.d/nodesource.list
  /usr/share/keyrings/nodesource.gpg /etc/apt/sources.list.d/caddy-stable.list
  /usr/share/keyrings/caddy-stable-archive-keyring.gpg)

list_manifest() {
  local x
  for x in "${UNIT_NAMES[@]}" "${UNIT_GLOBS[@]}"; do printf 'unit\t%s/%s\n' "$UNIT_DIR" "$x"; done
  for x in "${UNIT_NAMES[@]}" "${UNIT_GLOBS[@]}"; do printf 'unit-dropin\t%s/%s.d\n' "$UNIT_DIR" "$x"; done
  for x in "${UNIT_STOP_PATTERNS[@]}"; do printf 'unit-stop\t%s\n' "$x"; done
  for x in "${SBIN_NAMES[@]}" "${SBIN_GLOBS[@]}"; do printf 'path\t/usr/local/sbin/%s\n' "$x"; done
  for x in "${SUDOERS_GLOBS[@]}"; do printf 'path\t/etc/sudoers.d/%s\n' "$x"; done
  for x in "${ROOT_ENTRIES[@]}"; do printf 'path\t%s/%s\n' "$ROOT" "$x"; done
  printf 'path\t%s\n' "$ROOT"
  for x in "${SYSTEM_PATHS[@]}"; do printf 'path\t%s\n' "$x"; done
  for x in "${SERVICE_USERS[@]}"; do printf 'user\t%s\n' "$x"; printf 'path\t/home/%s\n' "$x"; done
  printf 'caddy\t%s\n' "$CADDYFILE"
  printf 'docker\tcompose project with working dir %s (Supabase), aquarium-apps-db-*\n' "$SUPA"
  printf 'git-safe-directory\t%s\n' "$APP"
  printf 'keep\t%s\n' "$BACKUP_PARENT" /var/backups/aquarium /swapfile /etc/fstab \
    /etc/apt/apt.conf.d/20auto-upgrades /usr/local/bin/uv /usr/local/bin/uvx
  for x in "${PURGE_APT[@]}" "${PURGE_APT_DOCKER[@]}"; do printf 'purge-package\t%s\n' "$x"; done
  for x in "${PURGE_PATHS[@]}"; do printf 'purge-path\t%s\n' "$x"; done
}

if [ "$LIST" = 1 ]; then list_manifest; exit 0; fi

# ---------------------------------------------------------------- what is present on this box
expand() {  # DIR GLOB...: existing entries of DIR matching each GLOB (logical paths, sorted, unique)
  local dir=$1 g f; shift
  for g in "$@"; do
    for f in "$(p "$dir")"/$g; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      printf '%s\n' "$dir/${f##*/}"
    done
  done | sort -u
}

loaded_units() {
  have systemctl || return 0
  [ -z "$R" ] || [ -n "${AQ_TEST_SYSTEMCTL:-}" ] || return 0
  systemctl list-units --all --plain --no-legend --no-pager "${UNIT_STOP_PATTERNS[@]}" 2>/dev/null \
    | awk '{print $1}' | grep -v '^$' || true
  systemctl list-unit-files --plain --no-legend --no-pager "${UNIT_STOP_PATTERNS[@]}" 2>/dev/null \
    | awk '{print $1}' | grep -v '^$' || true
}

unit_files() { expand "$UNIT_DIR" "${UNIT_NAMES[@]}" "${UNIT_GLOBS[@]}"; }
unit_dropins() {
  local x
  expand "$UNIT_DIR" "${UNIT_NAMES[@]/%/.d}" "${UNIT_GLOBS[@]/%/.d}"
  # enablement links (multi-user.target.wants/hermes-gateway.service, ...) and template instances
  for x in "$(p "$UNIT_DIR")"/*.wants "$(p "$UNIT_DIR")"/*.requires; do
    [ -d "$x" ] || continue
    expand "${x#"$R"}" "${UNIT_NAMES[@]}" "${UNIT_GLOBS[@]}" 'agent-home*' 'app-mcp*' 'hermes-wa-bridge@*'
  done
}

owned_paths() {
  local x
  expand /usr/local/sbin "${SBIN_NAMES[@]}" "${SBIN_GLOBS[@]}"
  expand /etc/sudoers.d "${SUDOERS_GLOBS[@]}"
  for x in "${ROOT_ENTRIES[@]}"; do expand "$ROOT" "$x"; done
  for x in "${SYSTEM_PATHS[@]}"; do [ -e "$(p "$x")" ] || [ -L "$(p "$x")" ] && printf '%s\n' "$x"; done
  return 0
}

ours_user() {  # NAME: exists and still looks like what the installer made (system uid, its home)
  local ent uid home
  ent=$(getent passwd "$1" 2>/dev/null) || return 1
  uid=$(cut -d: -f3 <<<"$ent") home=$(cut -d: -f6 <<<"$ent")
  [ "$uid" -lt 1000 ] && [ "$home" = "/home/$1" ]
}

caddy_is_ours() {  # the Caddyfile install-aquarium.sh writes proxies to agent-home / the dashboard
  local f; f=$(p "$CADDYFILE")
  [ -f "$f" ] && grep -Eq 'reverse_proxy 127\.0\.0\.1:(3100|9119)' "$f"
}

docker_ok() { have docker && docker info >/dev/null 2>&1; }

DOCKER_PROJECTS=()
find_docker_projects() {  # compose projects this install started: Supabase (by its folder) + app DB clusters
  DOCKER_PROJECTS=()
  docker_ok || return 0
  local _name project dir
  while IFS=$'\t' read -r _name project dir; do
    [ -n "$project" ] || continue
    if [ "$dir" = "$SUPA" ] || [[ $project == aquarium-apps-db-* ]]; then
      [[ " ${DOCKER_PROJECTS[*]} " == *" $project "* ]] || DOCKER_PROJECTS+=("$project")
    fi
  done < <(docker ps -a --format '{{.Names}}	{{.Label "com.docker.compose.project"}}	{{.Label "com.docker.compose.project.working_dir"}}')
}

project_containers() { docker ps -aq --filter "label=com.docker.compose.project=$1"; }
project_volumes() { docker volume ls -q --filter "label=com.docker.compose.project=$1"; }
project_networks() { docker network ls -q --filter "label=com.docker.compose.project=$1"; }

has_safe_directory() {
  have git && git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$APP"
}

# ---------------------------------------------------------------- the plan
UNITS_LOADED=() UNIT_FILES=() DROPINS=() PATHS=() USERS=() CADDY=0 SAFEDIR=0
gather() {
  mapfile -t UNITS_LOADED < <(loaded_units | sort -u)
  mapfile -t UNIT_FILES < <(unit_files)
  mapfile -t DROPINS < <(unit_dropins | sort -u)
  mapfile -t PATHS < <(owned_paths)
  USERS=()
  local u; for u in "${SERVICE_USERS[@]}"; do ! ours_user "$u" || USERS+=("$u"); done
  CADDY=0; ! caddy_is_ours || CADDY=1
  SAFEDIR=0; ! has_safe_directory || SAFEDIR=1
  find_docker_projects
}

print_plan() {
  local x n=0
  echo "Aquarium uninstall plan for $(hostname) (data root $ROOT):"
  section() { [ "$#" -gt 1 ] || return 0; echo "  $1:"; shift; printf '    %s\n' "$@"; n=$((n + $#)); }
  section "stop and disable units" "${UNITS_LOADED[@]}"
  section "remove unit files" "${UNIT_FILES[@]}" "${DROPINS[@]}"
  local dock=()
  for x in "${DOCKER_PROJECTS[@]}"; do
    dock+=("compose project $x: containers $(project_containers "$x" | wc -l), volumes $(project_volumes "$x" | wc -l)")
  done
  section "remove Docker containers, volumes and networks (with all database data)" "${dock[@]}"
  section "remove files and folders" "${PATHS[@]}"
  [ "$CADDY" = 0 ] || section "remove the Caddy site Aquarium wrote, disable caddy" "$CADDYFILE"
  [ "$SAFEDIR" = 0 ] || section "remove from git's system config" "safe.directory $APP"
  local users=(); for x in "${USERS[@]}"; do users+=("$x (and /home/$x)"); done
  section "remove service accounts" "${users[@]}"
  if [ "$PURGE" = 1 ]; then
    section "purge packages (--purge-packages)" "${PURGE_APT[@]}" "${PURGE_APT_DOCKER[*]} (only if no other containers)"
    section "remove tool files (--purge-packages)" "${PURGE_PATHS[@]}"
  else
    echo "  kept: OS packages (docker, caddy, node, uv, ...) — add --purge-packages to remove them"
  fi
  [ -e "$(p "$ROOT")" ] && echo "  $ROOT itself is removed only if nothing else is left in it"
  if [ "$BACKUP" = 1 ]; then echo "  backup first: $BACKUP_PARENT/<time>/ (database dump + files tarball)"
  else echo "  NO backup (--no-backup)"; fi
  PLAN_SIZE=$n
}

# ---------------------------------------------------------------- backup
under_removed() {  # PATH: is PATH inside something this script removes?
  local x
  for x in "$ROOT" "${SYSTEM_PATHS[@]}" /home/hermes /home/hermes-tools /etc/sudoers.d /usr/local/sbin "$UNIT_DIR"; do
    case "$1/" in "$x"/*) return 0 ;; esac
  done
  return 1
}

do_backup() {
  local dest stamp c ok=0 rel tarlist=() st
  under_removed "$BACKUP_PARENT" && die "--backup-dir $BACKUP_PARENT is inside a folder this script removes"
  stamp=$(date +%Y%m%d-%H%M%S)
  dest=$BACKUP_PARENT/$stamp
  log "Backup to $dest"
  install -d -m 700 "$(p "$BACKUP_PARENT")" "$(p "$dest")"
  chmod 700 "$(p "$BACKUP_PARENT")"

  # Database: the Supabase Postgres of this install (container supabase-db of its compose project).
  local db=""
  if docker_ok; then
    for c in "${DOCKER_PROJECTS[@]}"; do
      [[ $c == aquarium-apps-db-* ]] && continue
      db=$(docker ps -a --filter "label=com.docker.compose.project=$c" --filter "label=com.docker.compose.service=db" \
        --format '{{.Names}}' | head -1)
    done
  fi
  if [ -n "$db" ]; then
    docker start "$db" >/dev/null
    for _ in $(seq 1 60); do
      docker exec "$db" pg_isready -U postgres -h localhost >/dev/null 2>&1 && { ok=1; break; }
      sleep 2
    done
    [ "$ok" = 1 ] || die "database container $db does not become ready; nothing was removed (use --no-backup to skip the backup)"
    docker exec "$db" pg_dump -U supabase_admin -d postgres -Fc > "$(p "$dest")/postgres.dump" \
      || die "pg_dump failed; nothing was removed (use --no-backup to skip the backup)"
    docker exec "$db" pg_dumpall -U supabase_admin --globals-only > "$(p "$dest")/postgres-globals.sql" \
      || die "pg_dumpall --globals-only failed; nothing was removed"
    echo "  database: postgres.dump (pg_restore -d <dsn> postgres.dump), postgres-globals.sql"
  else
    warn "no Supabase database container found: the backup has no database dump"
  fi
  # Local-app database clusters (FG-33), if any are running.
  for c in "${DOCKER_PROJECTS[@]}"; do
    [[ $c == aquarium-apps-db-* ]] || continue
    while read -r db; do
      [ -n "$db" ] || continue
      docker exec -u postgres "$db" pg_dumpall -U supabase_admin > "$(p "$dest")/$db.sql" \
        || die "pg_dumpall of $db failed; nothing was removed (use --no-backup to skip the backup)"
      echo "  app database cluster: $db.sql"
    done < <(docker ps --filter "label=com.docker.compose.project=$c" --filter "label=com.docker.compose.service=db" --format '{{.Names}}')
  done

  # Files: settings, secrets, the hermes homes and data. Code, models and the raw database
  # folders are left out (the code is in git / the release, the database is dumped above).
  for rel in /etc/aquarium /etc/hermes-tools "$ROOT" /home/hermes /home/hermes-tools "$APPS_BASE"; do
    [ -e "$(p "$rel")" ] && tarlist+=("${rel#/}")
  done
  caddy_is_ours && tarlist+=("${CADDYFILE#/}")
  if [ "${#tarlist[@]}" -gt 0 ]; then
    st=0
    tar -C "$(p /)" -czf "$(p "$dest")/files.tar.gz" --ignore-failed-read --warning=no-file-changed \
      --exclude="${APP#/}" --exclude="${ROOT#/}/hermes-embed" --exclude="${ROOT#/}/supabase/src" \
      --exclude="${SUPA#/}/volumes/db/data" --exclude="${APPS_BASE#/}/db" \
      --exclude=node_modules --exclude=.venv --exclude=.cache --exclude=.npm \
      "${tarlist[@]}" || st=$?
    [ "$st" -le 1 ] || die "the files tarball failed; nothing was removed (use --no-backup to skip the backup)"
    echo "  files: files.tar.gz (${tarlist[*]})"
  fi
  { echo "Aquarium uninstall backup of $(hostname), $stamp, data root $ROOT"
    echo "postgres.dump        pg_dump -Fc of the Supabase database 'postgres'"
    echo "postgres-globals.sql roles and grants (pg_dumpall --globals-only)"
    echo "files.tar.gz         $(printf '/%s ' "${tarlist[@]}")(without code, models and raw database folders)"
  } > "$(p "$dest")/README.txt"
  chmod -R go-rwx "$(p "$dest")"
  BACKUP_DEST=$dest
}

# ---------------------------------------------------------------- removal steps
sysd() { have systemctl || return 0; [ -z "$R" ] || [ -n "${AQ_TEST_SYSTEMCTL:-}" ] || return 0; systemctl "$@"; }

stop_units() {
  local u
  [ "${#UNITS_LOADED[@]}" -gt 0 ] || return 0
  log "Stopping units"
  for u in "${UNITS_LOADED[@]}"; do
    sysd disable --now -q "$u" >/dev/null 2>&1 || sysd stop "$u" >/dev/null 2>&1 || true
    sysd reset-failed "$u" >/dev/null 2>&1 || true
  done
}

remove_docker() {
  local proj ids
  [ "${#DOCKER_PROJECTS[@]}" -gt 0 ] || return 0
  log "Removing Docker containers and volumes"
  for proj in "${DOCKER_PROJECTS[@]}"; do
    mapfile -t ids < <(project_containers "$proj")
    if [ "$PURGE" = 1 ] && [ "${#ids[@]}" -gt 0 ]; then
      mapfile -t PURGE_IMAGES < <(docker inspect -f '{{.Image}}' "${ids[@]}" 2>/dev/null | sort -u; printf '%s\n' "${PURGE_IMAGES[@]}")
    fi
    [ "${#ids[@]}" -eq 0 ] || docker rm -f -v "${ids[@]}" >/dev/null
    mapfile -t ids < <(project_volumes "$proj")
    [ "${#ids[@]}" -eq 0 ] || docker volume rm -f "${ids[@]}" >/dev/null
    mapfile -t ids < <(project_networks "$proj")
    [ "${#ids[@]}" -eq 0 ] || docker network rm "${ids[@]}" >/dev/null || true
  done
}

stop_user_processes() {
  local u
  for u in "${USERS[@]}"; do
    have pkill || continue
    pkill -KILL -u "$u" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -u "$u" >/dev/null 2>&1 || break; sleep 1; done
  done
}

remove_paths() {
  local x
  log "Removing files"
  for x in "${UNIT_FILES[@]}" "${DROPINS[@]}" "${PATHS[@]}"; do
    rm -rf -- "$(p "$x")"
  done
  if [ "$CADDY" = 1 ]; then
    sysd disable --now -q caddy >/dev/null 2>&1 || true
    rm -f -- "$(p "$CADDYFILE")"
  fi
  sysd daemon-reload >/dev/null 2>&1 || true
}

remove_safe_directory() {
  [ "$SAFEDIR" = 1 ] || return 0
  git config --system --fixed-value --unset-all safe.directory "$APP" 2>/dev/null \
    || warn "could not remove safe.directory $APP from the system git config"
}

remove_users() {
  local u
  for u in "${USERS[@]}"; do
    log "Removing account $u"
    userdel "$u" 2>/dev/null || warn "userdel $u failed"
    getent group "$u" >/dev/null 2>&1 && { groupdel "$u" 2>/dev/null || warn "groupdel $u failed"; }
    rm -rf -- "$(p "/home/$u")"
  done
}

remove_root_if_empty() {
  local d; d=$(p "$ROOT")
  [ -d "$d" ] || return 0
  if rmdir -- "$d" 2>/dev/null; then return 0; fi
  warn "$ROOT is kept: it still holds files the installer did not create: $(find "$d" -mindepth 1 -maxdepth 1 -printf '%f ' | head -c 200)"
}

purge_packages() {
  [ "$PURGE" = 1 ] || return 0
  log "Purging packages (--purge-packages)"
  local pkgs=() x others=""
  for x in "${PURGE_APT[@]}"; do dpkg-query -W -f='${Status}' "$x" 2>/dev/null | grep -q 'ok installed' && pkgs+=("$x"); done
  if docker_ok; then
    [ "${#PURGE_IMAGES[@]}" -eq 0 ] || docker rmi "${PURGE_IMAGES[@]}" >/dev/null 2>&1 || true
    others=$(docker ps -aq)
  fi
  if [ -n "$others" ]; then
    warn "Docker is kept: other containers still exist on this server"
  else
    for x in "${PURGE_APT_DOCKER[@]}"; do dpkg-query -W -f='${Status}' "$x" 2>/dev/null | grep -q 'ok installed' && pkgs+=("$x"); done
  fi
  [ "${#pkgs[@]}" -eq 0 ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y -q "${pkgs[@]}"
  for x in "${PURGE_PATHS[@]}"; do rm -f -- "$(p "$x")"; done
}

# ---------------------------------------------------------------- main
[ -n "$R" ] || [ "$DRY" = 1 ] || [ "$(id -u)" -eq 0 ] || die "run as root: sudo $0 $*"
PURGE_IMAGES=() BACKUP_DEST="" PLAN_SIZE=0
gather
print_plan
if [ "$PLAN_SIZE" -eq 0 ] && [ "$PURGE" = 0 ]; then
  [ -e "$(p "$ROOT")" ] || { echo "Nothing to remove: Aquarium is not installed here."; exit 0; }
fi
[ "$DRY" = 0 ] || exit 0

if [ "$YES" = 0 ]; then
  tty=${AQ_TTY:-/dev/tty}
  { [ -r "$tty" ] && [ -t 0 ] || [ -n "${AQ_TTY:-}" ]; } \
    || die "refusing to remove anything without --yes (no terminal to confirm on)"
  host=$(hostname)
  printf 'This permanently removes the Aquarium instance above. Type the server name (%s) to continue: ' "$host"
  read -r answer < "$tty" || answer=""
  [ "$answer" = "$host" ] || die "confirmation did not match; nothing was removed"
fi

[ "$BACKUP" = 0 ] || do_backup
stop_units
remove_docker
stop_user_processes
remove_paths
remove_safe_directory
remove_users
remove_root_if_empty
purge_packages

# A second pass catches anything recreated while the services were stopping.
gather
[ "${#UNIT_FILES[@]}${#PATHS[@]}${#USERS[@]}${#DOCKER_PROJECTS[@]}" = 0000 ] \
  || warn "some items are still present; run the script again (it is safe to repeat)"
log "Aquarium is removed."
[ -z "$BACKUP_DEST" ] || echo "Backup: $BACKUP_DEST"
echo "Install again with: sudo ./install-aquarium.sh"
