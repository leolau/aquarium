#!/usr/bin/env python3
"""Dry-run a recipe against the live site and print what it extracts.

Writes nothing to the database (the backend's first load does that after
the design is approved). Use it before proposing a design to prove every
entity extracts rows with the expected columns.

    python preview_recipe.py --recipe recipe.json --credential web-login/site \\
        [--entities orders,about] [--mode full] [--cursor orders=2026-11-01] \\
        [--sample 3] [--jsonl items.jsonl]

Exit codes: 0 ok, 1 invalid recipe / an entity failed, 2 login failed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_credential, load_json, repo_root  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--recipe", required=True)
    ap.add_argument("--credential", required=True, help="credential store entry provider/name")
    ap.add_argument("--entities", help="comma-separated entity names (default: all)")
    ap.add_argument("--mode", choices=("incremental", "full"), default="full")
    ap.add_argument("--cursor", action="append", default=[], help="entity=value (incremental mode)")
    ap.add_argument("--sample", type=int, default=3, help="rows to print per entity")
    ap.add_argument("--jsonl", help="write every item to this file")
    args = ap.parse_args(argv)

    repo_root()
    from hermes_cli import site_recipe_runner as srr

    recipe = load_json(args.recipe)
    problems = srr.recipe_problems(recipe)
    if problems:
        print("invalid recipe:")
        for p in problems:
            print(f"  - {p}")
        return 1
    cursors = dict(c.split("=", 1) for c in args.cursor)
    entities = [e.strip() for e in args.entities.split(",")] if args.entities else None
    credential = load_credential(args.credential)
    report = srr.RunReport()
    samples = defaultdict(list)
    keys: dict = defaultdict(Counter)
    sink = open(os.path.expanduser(args.jsonl), "w", encoding="utf-8") if args.jsonl else None
    status = 0
    try:
        for item in srr.run_recipe(recipe, credential, entities=entities, mode=args.mode, cursors=cursors,
                                   report=report):
            keys[item.entity][item.key] += 1
            if len(samples[item.entity]) < args.sample:
                samples[item.entity].append(item.payload)
            if sink:
                sink.write(json.dumps(item._asdict(), ensure_ascii=False, default=str) + "\n")
    except srr.LoginFailed as exc:
        print(f"login: FAILED ({exc})")
        return 2
    except srr.RecipeRunError:
        status = 1
    except srr.RecipeError as exc:
        print(f"error: {exc}")
        return 1
    finally:
        if sink:
            sink.close()
    for name in list(report.completed) + list(report.failed):
        state = f"FAILED {report.failed[name]}" if name in report.failed else "ok"
        print(f"== {name}: {report.rows.get(name, 0)} items ({state})")
        for row in samples.get(name, []):
            print("   ", json.dumps(row, ensure_ascii=False, default=str)[:400])
        dupes = sum(1 for n in keys[name].values() if n > 1)
        if dupes:
            print(f"   ! {dupes} keys seen more than once (key not unique, or overlapping pages)")
    print(json.dumps(report.as_dict(), indent=1, default=str))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
