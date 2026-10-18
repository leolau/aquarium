#!/usr/bin/env python3
"""Release tag rules and the ``channels.json`` contract for Aquarium releases.

Tags: ``vX.Y.Z`` is a stable release; ``vX.Y.Z-rc.N`` and ``vX.Y.Z-beta.N`` are
beta (GitHub prerelease). See docs/packaging/RELEASES.md.

CLI:
  release_channels.py check <tag>             print "stable" or "beta", exit 1 if invalid
  release_channels.py channels <tag> [--releases FILE]
      print channels.json; FILE is ``gh api repos/<repo>/releases`` output
      (the releases that already exist; <tag> is added to them).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys

REPO = "leolau/aquarium"
TAG_RE = re.compile(r"^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc|beta)\.(0|[1-9]\d*))?$")
_PRE_RANK = {"beta": 0, "rc": 1}


def parse_tag(tag: str) -> tuple[tuple[int, ...], str]:
    """Return (sort key, channel) for a release tag; raise ValueError if not a release tag."""
    m = TAG_RE.match(tag)
    if not m:
        raise ValueError(f"not a release tag: {tag!r} (want vX.Y.Z, vX.Y.Z-rc.N or vX.Y.Z-beta.N)")
    major, minor, patch, pre, n = m.groups()
    base = (int(major), int(minor), int(patch))
    if pre is None:
        return base + (1, 0, 0), "stable"
    return base + (0, _PRE_RANK[pre], int(n)), "beta"


def tarball_name(tag: str) -> str:
    return f"aquarium-{tag}-linux-x86_64.tar.gz"


def _entry(tag: str, repo: str) -> dict[str, str]:
    return {
        "version": tag,
        "tarball": tarball_name(tag),
        "download_base": f"https://github.com/{repo}/releases/download/{tag}/",
    }


def compute_channels(tags: list[str], repo: str = REPO, now: str | None = None) -> dict:
    """stable = newest stable tag; beta = newest tag of any kind (a newer stable beats an older rc)."""
    valid = []
    for t in tags:
        try:
            valid.append((parse_tag(t)[0], t, parse_tag(t)[1]))
        except ValueError:
            continue
    valid.sort()
    stable = [t for _, t, ch in valid if ch == "stable"]
    return {
        "schema": 1,
        "repo": repo,
        "generated_at": now or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "channels": {
            "stable": _entry(stable[-1], repo) if stable else None,
            "beta": _entry(valid[-1][1], repo) if valid else None,
        },
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check")
    c.add_argument("tag")
    ch = sub.add_parser("channels")
    ch.add_argument("tag")
    ch.add_argument("--releases", help="JSON list of existing releases (objects with tag_name, draft)")
    ch.add_argument("--repo", default=REPO)
    args = ap.parse_args(argv)
    try:
        _, channel = parse_tag(args.tag)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.cmd == "check":
        print(channel)
        return 0
    tags = [args.tag]
    if args.releases:
        with open(args.releases, encoding="utf-8") as fh:
            tags += [r["tag_name"] for r in json.load(fh) if not r.get("draft")]
    print(json.dumps(compute_channels(sorted(set(tags)), repo=args.repo), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
