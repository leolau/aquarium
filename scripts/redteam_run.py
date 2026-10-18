#!/usr/bin/env python3
"""Run the agent red-team suite and print a per-attack report.

Offline (default, safe anywhere, what CI runs):

    .venv/bin/python scripts/redteam_run.py
    .venv/bin/python scripts/redteam_run.py --json report.json
    .venv/bin/python scripts/redteam_run.py --only RT-07,RT-19

Live mode (a *throwaway* install with a real model; never production —
see docs/security/redteam.md):

    # on the test VM, once:
    .venv/bin/python scripts/redteam_run.py --plant --hermes-home $HERMES_HOME
    # from anywhere that reaches the test VM's API server:
    .venv/bin/python scripts/redteam_run.py --live --base-url http://TEST-VM:8642 \
        --api-key "$API_SERVER_KEY" --canary RT-CANARY-LIVE-xxxxxxxxxxxx

Exit code: 0 when every attack that must be blocked was blocked (open
findings are reported as EXPECTED-FAIL), 1 when any regression is found,
2 with --strict when any open finding is still exploitable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

LABELS = {
    ("blocked", True): "PASS",
    ("blocked", False): "FAIL",
    ("vulnerable", False): "EXPECTED-FAIL",
    ("vulnerable", True): "FIXED",
}


def _run(selected: set[str] | None) -> list[dict]:
    import logging

    logging.disable(logging.NOTSET)
    from tests.redteam.harness import load_attacks, redteam_env

    rows = []
    for item in load_attacks():
        if selected and item.id not in selected:
            continue
        started = time.monotonic()
        try:
            with redteam_env() as env:
                outcome = item.run(env)
            blocked, logged = outcome.blocked, outcome.logged
            detail, evidence, log_lines = outcome.detail, outcome.evidence, outcome.log_lines
        except Exception as exc:  # an attack that crashes is a broken test, not a pass
            blocked, logged = False, False
            detail, evidence, log_lines = f"attack crashed: {type(exc).__name__}: {exc}", {}, []
        status = LABELS[(item.expected, bool(blocked and logged))]
        rows.append(
            {
                "id": item.id,
                "status": status,
                "finding": item.finding,
                "vector": item.vector,
                "goal": item.goal,
                "title": item.title,
                "blocked": blocked,
                "logged": logged,
                "detail": detail,
                "note": item.note,
                "evidence": evidence,
                "log_lines": log_lines,
                "seconds": round(time.monotonic() - started, 2),
            }
        )
    return rows


def _print(rows: list[dict]) -> None:
    width = max(len(r["title"]) for r in rows) if rows else 10
    width = min(width, 72)
    print(f"{'ID':<6} {'STATUS':<14} {'FINDING':<8} {'VECTOR':<12} {'GOAL':<13} ATTACK")
    for r in rows:
        print(
            f"{r['id']:<6} {r['status']:<14} {(r['finding'] or '-'):<8} "
            f"{r['vector']:<12} {r['goal']:<13} {r['title'][:width]}"
        )
        print(f"{'':<6} evidence: {r['detail'][:160]}")
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    print()
    print("  ".join(f"{k}={v}" for k, v in sorted(counts.items())))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", type=Path, help="also write the full report (with evidence) here")
    parser.add_argument("--only", help="comma-separated attack ids")
    parser.add_argument("--strict", action="store_true", help="exit 2 while any open finding is exploitable")
    parser.add_argument("--plant", action="store_true", help="live: write fake canaries on THIS throwaway box")
    parser.add_argument("--hermes-home", type=Path, help="live --plant: the test install's HERMES_HOME")
    parser.add_argument("--checkout", type=Path, help="live --plant: the test install's checkout (optional)")
    parser.add_argument("--live", action="store_true", help="send the live payloads to a throwaway install")
    parser.add_argument("--base-url", help="live: the test install's API server, e.g. http://10.0.0.5:8642")
    parser.add_argument("--api-key", default=os.environ.get("API_SERVER_KEY"), help="live: API_SERVER_KEY")
    parser.add_argument("--canary", help="live: the value --plant printed")
    args = parser.parse_args(argv)
    selected = {s.strip() for s in args.only.split(",")} if args.only else None

    if args.plant:
        from tests.redteam.live import plant_canaries

        if not args.hermes_home:
            parser.error("--plant needs --hermes-home")
        print(plant_canaries(args.hermes_home, args.checkout))
        return 0

    mode = "offline"
    if args.live:
        from tests.redteam.live import check_target, run_live

        if not (args.base_url and args.api_key and args.canary):
            parser.error("--live needs --base-url, --api-key and --canary")
        try:
            check_target(args.base_url)
        except ValueError as err:
            parser.error(str(err))
        mode = "live"
        rows = run_live(args.base_url, args.api_key, args.canary, selected)
    else:
        os.environ.setdefault("HERMES_REDTEAM", "offline")
        rows = _run(selected)
    _print(rows)
    if args.json:
        args.json.write_text(json.dumps({"mode": mode, "attacks": rows}, indent=2, default=str))
        print(f"report written to {args.json}")

    if any(r["status"] == "FAIL" for r in rows):
        return 1
    if args.strict and any(r["status"] == "EXPECTED-FAIL" for r in rows):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
