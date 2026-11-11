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


def _summary(name: str, inv: dict) -> str:
    if "error" in inv:
        return f"[{name}] ERROR {inv['error']}"
    lines = [f"[{name}] {inv.get('title', '')} — {inv.get('url', '')}"]
    for t in inv.get("tables") or []:
        lines.append(f"  table {t['selector']}: {t['rows']} rows; headers {t['headers'][:12]}")
    for t in inv.get("datatables") or []:
        mode = "server-side" if t.get("server_side") else "client-side"
        keys = [c.get("data") for c in t.get("columns") or []]
        lines.append(f"  datatable {t['selector']} ({mode}, {t.get('total')} rows in the page"
                     f"{', ajax ' + t['ajax_url'] if t.get('ajax_url') else ''}): data keys {keys[:15]}")
    for r in inv.get("json_requests") or []:
        lines.append(f"  json {r['method']} {r['url']} query {r['query_keys'][:10]} body {r['body_keys'][:15]}"
                     f" -> {r['status']}{', ' + str(r['bytes']) + ' bytes' if r.get('bytes') else ''}")
    for f in inv.get("forms") or []:
        flag = " FORBIDDEN" if f.get("forbidden") else ""
        fields = [x.get("name") or x.get("id") for x in f.get("fields") or [] if x.get("type") != "hidden"]
        lines.append(f"  form {f['selector']} {f['method'].upper()} {f['action'] or '(same page)'}{flag}: {fields[:15]}")
    safe = [b["text"] or b["selector"] for b in inv.get("buttons") or [] if not b.get("forbidden")]
    bad = [b["text"] or b["selector"] for b in inv.get("buttons") or [] if b.get("forbidden")]
    if safe:
        lines.append(f"  buttons: {safe[:30]}")
    if bad:
        lines.append(f"  never click: {bad[:30]}")
    if inv.get("pagination"):
        lines.append(f"  pagination: {[p['text'] for p in inv['pagination']][:12]}")
    if inv.get("extracted_count"):
        lines.append(f"  extracted rows: {inv['extracted_count']}")
    return "\n".join(lines)


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
            print(_summary(name, inv), flush=True)
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
