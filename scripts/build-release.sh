#!/usr/bin/env bash
# Build an Aquarium release tarball from a committed revision.
#
#   scripts/build-release.sh vX.Y.Z [--out DIR] [--ref REV]
#
# Output (in DIR, default ./dist):
#   aquarium-vX.Y.Z-linux-x86_64.tar.gz   unpacks to aquarium-vX.Y.Z/
#   SHA256SUMS                            sha256 of the tarball (sha256sum format)
#
# The tarball holds the repo files at REV (default HEAD; uncommitted edits are
# NOT included) minus tests/website/.github/plans, plus prebuilt front ends so
# a customer box never runs npm or `next build`:
#   hermes_cli/web_dist/                  dashboard bundle (web/)
#   agent-home/standalone/                agent-home `next build` standalone server
#   RELEASE.json, VERSION                 version + commit metadata
# Python packages are NOT bundled (installer runs `uv sync --locked` on the box).
# Contract: docs/packaging/RELEASES.md. Used by .github/workflows/release.yml.
set -euo pipefail

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 1 ] || usage
VERSION=$1; shift
OUT=dist
REF=HEAD
while [ $# -gt 0 ]; do
  case $1 in
    --out) OUT=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    *) usage ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"
CHANNEL=$(python3 scripts/release_channels.py check "$VERSION")
COMMIT=$(git rev-parse "$REF^{commit}")
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct "$COMMIT")
export SOURCE_DATE_EPOCH
BUILT_AT=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%dT%H:%M:%SZ)
NAME="aquarium-$VERSION"
TARBALL="$NAME-linux-x86_64.tar.gz"

mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/aquarium-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
BUILD="$WORK/build"   # full source tree, where npm builds run
STAGE="$WORK/$NAME"   # what ships
mkdir -p "$BUILD" "$STAGE"

log() { printf '== %s\n' "$*"; }

log "source $COMMIT ($CHANNEL)"
git archive "$COMMIT" | tar -x -C "$BUILD"
git archive "$COMMIT" -- . \
  ':(exclude)tests' ':(exclude)website' ':(exclude).github' \
  ':(exclude)plans' ':(exclude).plans' ':(exclude)infographic' \
  ':(exclude)agent-home/test' | tar -x -C "$STAGE"

log "npm ci"
(cd "$BUILD" && npm ci --no-audit --no-fund --loglevel=error)

log "dashboard bundle (web/)"
(cd "$BUILD/web" && npm run build >/dev/null)
mkdir -p "$STAGE/hermes_cli"
cp -a "$BUILD/hermes_cli/web_dist" "$STAGE/hermes_cli/web_dist"

log "agent-home standalone build"
(cd "$BUILD" && AQUARIUM_STANDALONE=1 HERMES_BUILD_SHA="${COMMIT:0:9}" HERMES_BUILD_TIME="$BUILT_AT" \
  NEXT_TELEMETRY_DISABLED=1 npm run build --workspace agent-home >/dev/null)
SA="$BUILD/agent-home/.next/standalone"
[ -f "$SA/agent-home/server.js" ] || { echo "standalone server.js missing under $SA" >&2; exit 1; }
cp -a "$BUILD/agent-home/.next/static" "$SA/agent-home/.next/static"
[ -d "$BUILD/agent-home/public" ] && cp -a "$BUILD/agent-home/public" "$SA/agent-home/public"
cp -a "$SA" "$STAGE/agent-home/standalone"

printf '%s\n' "$VERSION" > "$STAGE/VERSION"
cat > "$STAGE/RELEASE.json" <<JSON
{
  "version": "$VERSION",
  "channel": "$CHANNEL",
  "commit": "$COMMIT",
  "built_at": "$BUILT_AT",
  "platform": "linux-x86_64",
  "agent_home_server": "agent-home/standalone/agent-home/server.js",
  "dashboard_bundle": "hermes_cli/web_dist"
}
JSON

log "pack $TARBALL"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
  -C "$WORK" -cf - "$NAME" | gzip -n -9 > "$OUT/$TARBALL"
(cd "$OUT" && sha256sum "$TARBALL" > SHA256SUMS)
log "done: $OUT/$TARBALL ($(du -h "$OUT/$TARBALL" | cut -f1))"
cat "$OUT/SHA256SUMS"
