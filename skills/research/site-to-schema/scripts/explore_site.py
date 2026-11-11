#!/usr/bin/env python3
"""Log in and inventory pages of a site for study (read-only).

Each probe replays read-only recipe steps (goto / click / fill / select /
submit / wait / paginate ...) after the login and then records what the
page offers: buttons (with onclick), forms and their fields, tables with
headers and sample rows, pagination controls, links and text. Controls that
would change data or end the session are flagged ``forbidden`` and are never
used: the same guards as the refresh runner apply.

    python explore_site.py --recipe recipe.json --credential web-login/site \\
        --probes probes.json --out ~/site-study/inventory

``probes.json``: ``[{"name": "orders", "steps": [{"op": "goto", "url": "/orders"},
{"op": "click", "text": "Search"}]}, ...]`` or ``--goto /path`` (repeatable)
for plain page visits. Only ``base_url`` and ``login`` of ``--recipe`` are
used, so it can be a draft.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_credential, load_json, repo_root  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recipe", required=True, help="recipe.json (base_url + login are used)")
    ap.add_argument("--credential", required=True, help="credential store entry provider/name")
    ap.add_argument("--probes", help="JSON file with a list of probes")
    ap.add_argument("--goto", action="append", default=[], help="page path to visit (repeatable)")
    ap.add_argument("--out", help="directory for <probe>.json inventories")
    args = ap.parse_args(argv)

    repo_root()
    from hermes_cli import site_recipe_runner as srr

    recipe = load_json(args.recipe)
    probes = list(load_json(args.probes)) if args.probes else []
    probes += [{"name": p.strip("/").replace("/", "_") or "home", "steps": [{"op": "goto", "url": p}]}
               for p in args.goto]
    if not probes:
        ap.error("give --probes or --goto")
    credential = load_credential(args.credential)
    out = Path(os.path.expanduser(args.out)) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    report = srr.RunReport()
    try:
        for name, inv in srr.browse(recipe, probes, credential, report=report):
            print(srr.inventory_summary(name, inv), flush=True)
            if out:
                (out / f"{name}.json").write_text(json.dumps(inv, indent=1, ensure_ascii=False), encoding="utf-8")
    except srr.LoginFailed as exc:
        print(f"login: FAILED ({exc})")
        return 2
    except srr.RecipeError as exc:
        print(f"error: {exc}")
        return 1
    for blocked in report.blocked_requests:
        print(f"blocked: {blocked}")
    if out:
        print(f"inventories: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
