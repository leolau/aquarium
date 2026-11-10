"""``hermes ref <ref>`` — what a short ref (``P12``, ``T345``, ``P12-R3``, ``D88``)
names, as ``GET /api/refs/{ref}`` answers it.

Footprint-ladder rung 2: a CLI command the agent runs, no model tool. The
lookup goes through the ``refs_api`` router in process, so the read gate is
the API's own (``hermes projects`` convention: ``--actor`` or the enrolled
owner).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


def _resolve(ref: str, actor) -> tuple[int, dict]:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hermes_cli import projects_api, refs_api
    from hermes_cli.projects_cli import _resolve_principal

    principal = asyncio.run(_resolve_principal(actor))

    async def _as(request):
        return principal

    saved = projects_api._principal_read  # noqa: SLF001 - same package
    projects_api._principal_read = _as  # noqa: SLF001
    try:
        app = FastAPI()
        app.include_router(refs_api.router)
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(f"/api/refs/{ref}")
    finally:
        projects_api._principal_read = saved  # noqa: SLF001
    try:
        body = resp.json()
    except Exception:
        body = {"detail": f"HTTP {resp.status_code}"}
    return resp.status_code, body


def format_resolution(item: dict) -> str:
    """One line: ``P12  project  Monday digest  [active]  /projects/digest``."""
    parts = [item.get("ref") or "", item.get("kind") or "", item.get("title") or ""]
    if item.get("status"):
        parts.append(f"[{item['status']}]")
    if item.get("url"):
        parts.append(item["url"])
    line = "  ".join(p for p in parts if p)
    extra = [f"id: {item.get('id')}"]
    if item.get("project_ref") and item.get("kind") != "project":
        extra.append(f"project: {item['project_ref']} ({item.get('project_slug')})")
    elif item.get("project_slug"):
        extra.append(f"slug: {item['project_slug']}")
    if item.get("profile"):
        extra.append(f"profile: {item['profile']}")
    return line + "\n  " + "\n  ".join(extra)


def ref_command(args: argparse.Namespace) -> int:
    try:
        status, body = _resolve(args.ref, args.actor)
    except (RuntimeError, ValueError) as error:
        print(f"ref: {error}", file=sys.stderr)
        return 1
    if status != 200:
        print(f"ref: {args.ref}: {body.get('detail', status)}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(body, indent=2, default=str))
    else:
        print(format_resolution(body))
    return 0


def register_ref_subparser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "ref",
        help="Resolve a short ref (P12, T345, P12-R3, D88, M512) to the item it names",
        description=(
            "Look up a short ref — P<n> project, T<n> project card, "
            "P<n>-R<n> run, D<n> to-do, M<n> inbox message — and print its "
            "kind, internal id, title, status "
            "and agent-home URL. Case-insensitive. Only items the actor may "
            "see resolve; anything else is 'ref not found'."
        ),
    )
    parser.add_argument("ref", help="e.g. P12, t345, P12-R3, D88, m512")
    parser.add_argument(
        "--actor", default=None, help="Principal to act as (default: the enrolled owner)"
    )
    parser.add_argument("--json", action="store_true", help="Print the JSON resolution")
    parser.set_defaults(func=ref_command)
