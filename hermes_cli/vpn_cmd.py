"""``hermes vpn`` — agents' terminal surface for "Private networks (VPN)".

Rung 2 on the footprint ladder (CLI + skill ``skills/productivity/fortinet-vpn``),
no model tool. Runs as the ``hermes`` user and reaches the root helper through
``sudo -n`` (see ``hermes_cli/vpn.py``). Acts as the enrolled owner principal,
like other service-context consumers. Output is one short line per VPN.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, Dict

from hermes_cli import vpn


def describe(view: Dict[str, Any], *, with_check: bool = False) -> str:
    status = view["status"]
    state = status["state"]
    name = view["name"]
    if state == "connected":
        if view.get("share_path"):
            line = f"{name}: connected — files at {view['mount_path']} (read-only)"
        else:
            line = (
                f"{name}: connected (no file share on the VPN itself; its network "
                "folders are in folder_bridge_list_folders)"
            )
    elif state == "needs_cert":
        digest = (status.get("cert") or {}).get("sha256") or ""
        line = (
            f"{name}: needs_cert — the VPN server's certificate is not trusted "
            f"yet; ask the user to review and trust it in Settings → In&Out"
            + (f" (sha256 {digest[:16]}…)" if digest else "")
        )
    elif state == "error":
        line = f"{name}: error — {status.get('error') or 'unknown error'}"
    else:
        line = f"{name}: {state}"
    check = status.get("last_check")
    if with_check and isinstance(check, dict) and check.get("message"):
        line += f" | check: {check['message']}"
    return line


def _emit(view: Dict[str, Any], as_json: bool, *, with_check: bool = False) -> None:
    print(json.dumps(view) if as_json else describe(view, with_check=with_check))


async def _dispatch(args: argparse.Namespace) -> int:
    from hermes_cli.credential_store import resolve_owner_principal

    action = args.vpn_command
    if action == "migrate-shares":
        lines = await vpn.migrate_shares(dry_run=bool(args.dry_run))
        for line in lines:
            print(line)
        return 1 if any(": failed," in line for line in lines) else 0
    principal = await resolve_owner_principal()
    as_json = bool(args.json)

    if action == "list" or (action == "status" and not args.name):
        views = await vpn.list_views(principal)
        if as_json:
            print(json.dumps({"vpns": views}))
        elif not views:
            print("No VPNs are configured. The user adds one in Settings → In&Out.")
        for view in [] if as_json else views:
            print(describe(view))
        return 0
    if action == "status":
        cred = await vpn.find_vpn(principal, args.name, loose=True)
        _emit(await vpn.view_of(cred), as_json, with_check=True)
        return 0
    if action == "up":
        cred = await vpn.find_vpn(principal, args.name, loose=True)
        current = await vpn.view_of(cred)
        if current["status"]["state"] != "connected" and not current["auto_connect"]:
            print(f"Connect '{cred.name}' in Settings → In&Out, then tell me.")
            return 1
        view = await vpn.connect(principal, cred.name)
        _emit(view, as_json)
        return 0 if view["status"]["state"] == "connected" else 1
    if action == "down":
        view = await vpn.disconnect(principal, args.name, loose=True)
        _emit(view, as_json)
        return 0
    if action == "test":
        view = await vpn.test(principal, args.name, loose=True)
        _emit(view, as_json, with_check=True)
        check = view["status"].get("last_check") or {}
        return 0 if check.get("ok") else 1
    print(f"Unknown vpn action: {action}", file=sys.stderr)
    return 2


def vpn_command(args: argparse.Namespace) -> int:
    try:
        return asyncio.run(_dispatch(args))
    except vpn.VpnError as exc:
        print(f"vpn: {exc}", file=sys.stderr)
        return 1


def register_vpn_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes vpn``."""
    parser = subparsers.add_parser(
        "vpn",
        help="Private networks (Fortinet VPN): connect and read office file shares",
        description=(
            "Connect a Fortinet VPN configured in Settings → In&Out and read its "
            "file share (read-only) under /opt/data/vpn-files/<slug>."
        ),
    )
    sub = parser.add_subparsers(dest="vpn_command", required=True)
    listing = sub.add_parser("list", help="Configured VPNs and their state")
    listing.add_argument("--json", action="store_true", help="JSON output")
    status = sub.add_parser("status", help="State of one VPN (or all)")
    status.add_argument("name", nargs="?", default=None, help="VPN name")
    status.add_argument("--json", action="store_true", help="JSON output")
    for verb, text in (
        ("up", "Connect (only if the VPN allows agents to connect on their own)"),
        ("down", "Disconnect and unmount"),
        ("test", "Connect if needed, then list the file share"),
    ):
        cmd = sub.add_parser(verb, help=text)
        cmd.add_argument("name", help="VPN name, e.g. \"Office files\"")
        cmd.add_argument("--json", action="store_true", help="JSON output")
    migrate = sub.add_parser(
        "migrate-shares",
        help="Move each VPN's own file share into a network folder (Files → Bridge)",
        description=(
            "For every VPN that still has its own file share: create a network "
            "folder (same owner and visibility) for it, then remove the share, "
            "share login and routes from the VPN. Safe to re-run."
        ),
    )
    migrate.add_argument("--dry-run", action="store_true", help="Only print what would change")
    parser.set_defaults(func=vpn_command)
