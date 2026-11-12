#!/usr/bin/env python3
"""Check design.json against recipe.json before ``site_db.propose_design``.

    python check_design.py design.json recipe.json

Checks the design shape (plan section 3.3), the recipe (the runner's own
validator, including the read-only guard) and that the two agree: same
entities and kinds, keys and cursors are real columns, every table/list
entity is ``variable``, incremental entities really use ``{{cursor}}`` and
every extracted column is declared. An entity with a secret-looking column
(``password_hash``, ``api_key``, ``token`` ...) is a problem: the page sends
secrets to the browser, so the whole entity must be dropped and listed in
``design.exclusions`` with ``"security": true``. Prints open ``question``
fields so they are asked before proposing. Exit 0 = ready, 1 = problems.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import load_json, repo_root  # noqa: E402

COLUMN_TYPES = ("text", "int", "integer", "bigint", "numeric", "decimal", "float", "date", "datetime",
                "timestamp", "timestamptz", "bool", "boolean", "json", "jsonb")
CURSOR_TYPES = ("date", "datetime", "timestamp", "timestamptz", "int", "integer", "bigint")
RESERVED = ("_key", "_hash", "_payload", "_first_seen", "_last_seen", "_removed_at", "_run_id")
_NAME = re.compile(r"[a-z][a-z0-9_]{0,62}")
_DURATION = re.compile(r"P(?:\d+[YMWD])+(?:T(?:\d+[HMS])+)?|PT(?:\d+[HMS])+")


def _walk(steps: Any) -> Iterator[Mapping[str, Any]]:
    for step in steps or []:
        if isinstance(step, dict):
            yield step
            yield from _walk(step.get("steps"))


def _recipe_columns(ent: Mapping[str, Any]) -> Tuple[List[str], bool, bool]:
    """(extracted column names, has a table/pagination step, uses {{cursor}})."""
    cols: List[str] = []
    tabular = uses_cursor = False
    for step in _walk(ent.get("steps")):
        op = step.get("op")
        if op in ("extract_table", "extract_datatable", "extract_json", "paginate"):
            tabular = True
        if op in ("extract_table", "extract_datatable", "extract_json"):
            cols += list((step.get("columns") or {}).keys())
        if op == "extract_fields":
            cols += list((step.get("fields") or {}).keys())
        own = {k: v for k, v in step.items() if k != "steps"}
        if re.search(r"\{\{\s*cursor", json.dumps(own, default=str)):
            uses_cursor = True
    return cols, tabular, uses_cursor


def _source_names(ent: Mapping[str, Any]) -> List[str]:
    """Every name a recipe entity reads: its columns and the page fields/headers/keys they map from."""
    names: List[str] = []
    for step in _walk(ent.get("steps")):
        for mapping in (step.get("columns"), step.get("fields")):
            for col, spec in (mapping or {}).items() if isinstance(mapping, dict) else ():
                names.append(str(col))
                if isinstance(spec, dict):
                    names += [str(spec[k]) for k in ("field", "header", "attr") if spec.get(k)]
    return names


def _check_exclusions(design: Mapping[str, Any], problems: List[str]) -> None:
    exclusions = design.get("exclusions")
    if exclusions is None:
        return
    if not isinstance(exclusions, list):
        problems.append("design.exclusions must be a list of {page, reason, security?}")
        return
    for i, ex in enumerate(exclusions):
        if not isinstance(ex, dict) or not ex.get("page") or not ex.get("reason"):
            problems.append(f"design.exclusions[{i}]: needs 'page' and 'reason'")


def check(design: Any, recipe: Any) -> Tuple[List[str], List[str], List[str]]:
    """(problems, warnings, open questions)."""
    repo_root()
    from hermes_cli.site_recipe_runner import looks_like_secret_column, recipe_problems

    problems = [f"recipe: {p}" for p in recipe_problems(recipe)]
    warnings: List[str] = []
    questions: List[str] = []
    if not isinstance(design, dict):
        return problems + ["design must be a JSON object"], warnings, questions
    if design.get("version") != 1:
        problems.append("design.version must be 1")
    site = design.get("site")
    if not isinstance(site, str) or not _NAME.fullmatch(site):
        problems.append("design.site must be a lower_snake_case slug")
    elif isinstance(recipe, dict) and recipe.get("site") not in (None, site):
        problems.append(f"design.site {site!r} != recipe.site {recipe.get('site')!r}")
    zone = design.get("timezone")
    if zone is not None:
        try:
            valid = isinstance(zone, str) and bool(zone.strip()) and ZoneInfo(zone) is not None
        except (ZoneInfoNotFoundError, ValueError):
            valid = False
        if not valid:
            problems.append(f"design.timezone {zone!r} must be an IANA time zone name, e.g. Asia/Hong_Kong")
    entities = design.get("entities")
    if not isinstance(entities, list) or not entities:
        return problems + ["design.entities must be a non-empty list"], warnings, questions
    _check_exclusions(design, problems)
    rent: Dict[str, Any] = (recipe.get("entities") if isinstance(recipe, dict) else None) or {}
    seen: set = set()
    for i, ent in enumerate(entities):
        if not isinstance(ent, dict):
            problems.append(f"entities[{i}] must be an object")
            continue
        name = ent.get("name")
        at = f"design.{name or f'entities[{i}]'}"
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            problems.append(f"{at}: name must be lower_snake_case")
            continue
        if name in seen:
            problems.append(f"{at}: duplicate entity name")
        seen.add(name)
        kind = ent.get("kind")
        if kind not in ("fixed", "variable"):
            problems.append(f"{at}: kind must be 'fixed' or 'variable'")
        if not str(ent.get("reason") or "").strip():
            problems.append(f"{at}: give a reason for the fixed/variable decision")
        source = ent.get("source")
        if not isinstance(source, dict) or not source.get("page"):
            problems.append(f"{at}: source.page is required (where the data lives)")
        columns = ent.get("columns") or []
        col_types: Dict[str, str] = {}
        for c in columns:
            if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not _NAME.fullmatch(c["name"]):
                problems.append(f"{at}: every column needs a lower_snake_case name ({c!r})")
                continue
            if c["name"] in RESERVED:
                problems.append(f"{at}: column {c['name']} is reserved by the writer")
            ctype = str(c.get("type") or "text").lower()
            if ctype not in COLUMN_TYPES:
                problems.append(f"{at}: column {c['name']} has unknown type {ctype!r}")
            col_types[c["name"]] = ctype
        r = rent.get(name)
        secret = sorted({str(n) for n in [*col_types, *(_source_names(r) if isinstance(r, dict) else [])]
                         if looks_like_secret_column(n)})
        if secret:
            problems.append(
                f"{at}: secret-looking columns {secret}: the page sends secrets to the browser. Drop the whole "
                "entity (never store these columns) and list its page in design.exclusions with "
                '"security": true, to report to the site owner')
        key = ent.get("key") or []
        if kind == "variable":
            if not key:
                problems.append(f"{at}: a variable entity needs a key")
            if not columns:
                problems.append(f"{at}: a variable entity needs typed columns")
        for k in key:
            if k not in col_types:
                problems.append(f"{at}: key column {k!r} is not in columns")
        refresh = ent.get("refresh") or {}
        mode = refresh.get("mode")
        if mode not in ("incremental", "full"):
            problems.append(f"{at}: refresh.mode must be 'incremental' or 'full'")
        cursor = refresh.get("cursor")
        if mode == "incremental":
            if not cursor:
                problems.append(f"{at}: incremental refresh needs refresh.cursor (a date/ID column)")
            elif cursor not in col_types:
                problems.append(f"{at}: refresh.cursor {cursor!r} is not in columns")
            elif col_types[cursor] not in CURSOR_TYPES:
                problems.append(f"{at}: refresh.cursor {cursor!r} must be a date/datetime/integer column")
            if not refresh.get("full_every"):
                warnings.append(f"{at}: incremental without refresh.full_every never detects removed rows")
        if refresh.get("full_every") and not _DURATION.fullmatch(str(refresh["full_every"])):
            problems.append(f"{at}: refresh.full_every must be an ISO 8601 duration like P7D")
        if ent.get("question"):
            questions.append(f"{name}: {ent['question']}")

        r = rent.get(name)
        if r is None:
            problems.append(f"{at}: missing from recipe.entities")
            continue
        if r.get("kind") != kind:
            problems.append(f"{at}: kind {kind!r} but the recipe says {r.get('kind')!r}")
        extracted, tabular, uses_cursor = _recipe_columns(r)
        if tabular and kind != "variable":
            problems.append(f"{at}: the recipe reads a table/paginated list, so the entity must be variable")
        if kind == "variable" and list(r.get("key") or []) != list(key):
            problems.append(f"{at}: key {key} but the recipe key is {r.get('key')}")
        if mode == "incremental":
            if r.get("cursor") != cursor:
                problems.append(f"{at}: recipe.entities.{name}.cursor must be {cursor!r}")
            if not uses_cursor:
                problems.append(f"{at}: incremental, but no recipe step uses {{{{cursor}}}}")
            if r.get("mode") == "full":
                problems.append(f"{at}: incremental in the design, mode 'full' in the recipe")
        elif mode == "full" and uses_cursor and r.get("mode") != "full":
            warnings.append(f"{at}: full refresh, but the recipe uses {{{{cursor}}}}; set recipe mode 'full'")
        undeclared = [c for c in extracted if c not in col_types]
        if columns and undeclared:
            problems.append(f"{at}: the recipe extracts undeclared columns {undeclared}")
        never = [c for c in col_types if extracted and c not in extracted]
        if never:
            warnings.append(f"{at}: columns {never} are declared but never extracted")
    for name in rent:
        if name not in seen:
            problems.append(f"recipe.entities.{name}: not in the design")
    return problems, warnings, questions


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("design")
    ap.add_argument("recipe")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)
    problems, warnings, questions = check(load_json(args.design), load_json(args.recipe))
    if args.json:
        print(json.dumps({"ok": not problems, "problems": problems, "warnings": warnings, "questions": questions},
                         indent=1))
    else:
        for label, items in (("problem", problems), ("warning", warnings), ("ask the user", questions)):
            for item in items:
                print(f"{label}: {item}")
        print("ok: ready to propose" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
