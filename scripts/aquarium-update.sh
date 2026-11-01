#!/usr/bin/env bash
# aquarium-update.sh — update an installed Aquarium server to new code: fetch, rebuild, restart.
#
#   sudo /opt/data/hermes-agent/scripts/aquarium-update.sh [BRANCH]          git installs
#   sudo /opt/data/hermes-agent/scripts/aquarium-update.sh [--version vX.Y.Z | --channel stable|beta]
#                                                                            release installs
#
# Reads the install from /etc/aquarium/aquarium.conf (written by install-aquarium.sh).
#  - Git installs (--from-checkout / --from-branch): runs the box's deploy script, which fetches
#    BRANCH (default: the installed one) from the checkout's origin, refuses to clobber local
#    edits, installs dependencies, rebuilds what changed, restarts the services and checks them.
#    When the update brings a newer deploy script, it is installed and run once more.
#  - Release installs: hands over to `aquarium update` (signed release, backup, rollback).
# Changing domains or owner settings: edit aquarium.conf and re-run install-aquarium.sh.
set -Eeuo pipefail

AQ_ROOTFS=${AQ_ROOTFS:-}   # prefix for absolute paths (tests only)
CONF=$AQ_ROOTFS/etc/aquarium/aquarium.conf

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

conf_get() {  # KEY: value from aquarium.conf (same parsing as `aquarium`)
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$CONF" 2>/dev/null \
    | tail -1 | sed -E 's/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}

main() {
  case ${1:-} in -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;; esac
  [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
  [ -f "$CONF" ] || die "$CONF not found: this server was not installed by install-aquarium.sh (or predates it); use sudo aquarium update or $AQ_ROOTFS/opt/data/deploy-hermes.sh"
  local root source branch app deploy
  root=$(conf_get DATA_ROOT); root=$AQ_ROOTFS${root:-/opt/data}
  source=$(conf_get INSTALL_SOURCE)
  app=$root/hermes-agent
  case $source in
    release)
      exec "$AQ_ROOTFS/usr/local/sbin/aquarium" update "$@" ;;
    checkout|branch)
      [ $# -le 1 ] && [[ ${1:-x} != -* ]] || die "this server runs from a git checkout: pass a branch name (or nothing), not ${1:-}"
      branch=${1:-$(conf_get BRANCH)}; branch=${branch:-develop}
      [ "$root" = "$AQ_ROOTFS/opt/data" ] || die "git updates support AQUARIUM_ROOT=/opt/data only (this install: ${root#"$AQ_ROOTFS"}); re-run install-aquarium.sh from an updated clone instead"
      deploy=$root/deploy-hermes.sh
      [ -x "$deploy" ] || die "$deploy is missing; re-run install-aquarium.sh"
      "$deploy" "$branch"
      if [ -f "$app/deploy/hermes-deploy.sh" ] && ! cmp -s "$app/deploy/hermes-deploy.sh" "$deploy"; then
        echo "==> the update brought a newer deploy script; installing it and running it once more"
        install -m 755 "$app/deploy/hermes-deploy.sh" "$deploy"
        "$deploy" "$branch"
      fi
      ;;
    *) die "unknown INSTALL_SOURCE '${source}' in $CONF" ;;
  esac
}

main "$@"
