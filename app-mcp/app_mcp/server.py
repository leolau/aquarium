"""app-mcp service entry point: WebSocket hub(s) + MCP tools.

Three listeners in this one process, all loopback except the two WS paths
Caddy fronts:

- **UI hub** (default 127.0.0.1:9221, path ``/app-mcp/ws``) — the browser
  bridge in agent-home connects here to report page/focus and execute
  ``app_act``/``app_act_destructive`` commands.
- **Folder hub** (same port, path ``/app-mcp/folders/ws``) — the Folder
  Bridge page (``/files/bridge``) connects here so ``folder_bridge_*`` tools
  can list/search/read within folders the user has approved via the File
  System Access API. A separate ``Hub`` instance: a different browser tab,
  a different command vocabulary, a different connection lifecycle (opt-in,
  only while that page is open) from the always-on UI bridge.
- **MCP** (default 127.0.0.1:9220, streamable HTTP at ``/mcp``) — consumed by
  the Hermes agent via ``mcp_servers: app:`` in its config. Tools register as
  ``mcp_app_*``; ``mcp_app_app_act_destructive`` and (recommended)
  ``mcp_app_folder_bridge_read_file`` / ``mcp_app_folder_bridge_search_files``
  / ``mcp_app_folder_bridge_import_file_approved``
  are gated by Hermes' ``approvals.tools`` so the user approves in-chat
  before anything sensitive runs — see README.md "MCP tools" for the full
  recommendation and why reads are gated too.

Network folders (``net-*`` folder ids, SMB shares the Hermes server mounts
read-only through a user's VPN) are served here, server-side, from their
mount under ``/opt/data/vpn-files`` — see ``netfolders.py``. They work with
no browser connected; ``APP_MCP_HERMES_TOKEN`` (+ optional
``APP_MCP_HERMES_URL``) lets app-mcp ask Hermes to mount/import.

Config via env: ``APP_MCP_TICKET_SECRET`` (required — shared with the
agent-home BFF's ``AGENT_HOME_APP_MCP_SECRET``), ``APP_MCP_PORT``,
``APP_MCP_WS_PORT``, ``APP_MCP_COMMAND_TIMEOUT``,
``APP_MCP_FOLDER_COMMAND_TIMEOUT`` (folder search/read across a real
directory tree can legitimately take longer than a UI click).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any
from urllib.parse import parse_qs, urlparse

import websockets
from mcp.server.fastmcp import FastMCP
from mcp.server.lowlevel.server import request_ctx

from . import netfolders as nf
from .guard import looks_destructive, looks_sensitive
from .help import help_for
from .hub import Hub, HubError
from .mcp_auth import TOKEN_FILE, BearerTokenMiddleware, read_token
from .pages import PAGES
from .ticket import verify_ticket

log = logging.getLogger("app-mcp")

TICKET_SECRET = os.environ.get("APP_MCP_TICKET_SECRET", "")
MCP_PORT = int(os.environ.get("APP_MCP_PORT", "9220"))
WS_PORT = int(os.environ.get("APP_MCP_WS_PORT", "9221"))
COMMAND_TIMEOUT = float(os.environ.get("APP_MCP_COMMAND_TIMEOUT", "10"))
FOLDER_COMMAND_TIMEOUT = float(
    os.environ.get("APP_MCP_FOLDER_COMMAND_TIMEOUT", "30")
)

hub = Hub(timeout=COMMAND_TIMEOUT)
folder_hub = Hub(timeout=FOLDER_COMMAND_TIMEOUT)
mcp = FastMCP("app", host="127.0.0.1", port=MCP_PORT)
hermes = nf.HermesClient()

SAFE_ACTIONS = {"click", "type", "select", "focus", "read", "scroll", "navigate", "snapshot"}
DESTRUCTIVE_REFUSAL = (
    "That element looks destructive or externally visible. Use app_act_destructive "
    "instead — it goes through the user's approval flow."
)

# Hermes forwards the chat's user id in the MCP request `_meta` under this
# key (tools/mcp_tool.py, `forward_principal: true`). Every tool routes to
# THAT user's browser session only; no key = no browser access.
PRINCIPAL_META_KEY = "aquarium_principal_user_id"

ELEMENT_ACTIONS = {"click", "type", "select", "focus", "read", "scroll"}
SENSITIVE_READ_REFUSAL = (
    "That field holds a password or secret; app-mcp never reads it back."
)
UNNAMED_REFUSAL = (
    "That control has no visible name, so app-mcp cannot tell whether it is "
    "safe. Use app_act_destructive (the user approves it) instead."
)

# WS path -> which Hub owns it. A dict makes `_route_for_path` trivially
# unit testable without opening a real socket.
WS_ROUTES: dict[str, Hub] = {
    "/app-mcp/ws": hub,
    "/app-mcp/folders/ws": folder_hub,
}


# ---------------------------------------------------------------------------
# WebSocket side
# ---------------------------------------------------------------------------

def _route_for_path(path: str) -> Hub | None:
    """Which Hub owns this WS path, or None for an unknown one."""
    return WS_ROUTES.get(path.rstrip("/") or "/")


async def _ws_handler(conn: websockets.ServerConnection) -> None:
    request = conn.request
    parsed = urlparse(request.path if request else "")
    target = _route_for_path(parsed.path)
    if target is None:
        await conn.close(4004, "Unknown path")
        return
    ticket = parse_qs(parsed.query).get("ticket", [""])[0]
    user = verify_ticket(ticket, TICKET_SECRET)
    if user is None:
        await conn.close(4001, "Invalid or expired ticket")
        return
    target.attach(conn, user)
    log.info("app-mcp: session attached (path=%s user=%s)", parsed.path, user)
    try:
        async for raw in conn:
            try:
                msg = json.loads(raw)
            except (TypeError, ValueError):
                continue
            kind = msg.get("type")
            if kind == "state":
                target.update_state(conn, msg.get("path"), msg.get("element"))
            elif kind == "progress":
                target.note_progress(conn, msg.get("id"), msg.get("sent"), msg.get("total"))
            elif kind == "result":
                target.resolve_result(conn, msg.get("id"), msg)
    finally:
        target.detach(conn)
        log.info("app-mcp: session detached (path=%s user=%s)", parsed.path, user)


# ---------------------------------------------------------------------------
# Helpers shared by the tools
# ---------------------------------------------------------------------------

def _caller() -> str | None:
    """The user this MCP request is for, as forwarded by Hermes in `_meta`."""
    ctx = request_ctx.get(None)
    meta = getattr(ctx, "meta", None) if ctx is not None else None
    extra = getattr(meta, "model_extra", None) or {}
    user = extra.get(PRINCIPAL_META_KEY)
    return user if isinstance(user, str) and user else None


def _clean_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """Drop the value of password/secret fields before it reaches the agent."""
    if entry.get("sensitive") or looks_sensitive(entry.get("name")):
        out = {k: v for k, v in entry.items() if k != "value"}
        out["sensitive"] = True
        return out
    return entry


async def _snapshot(user: str | None) -> dict[str, Any]:
    result = await hub.send_command({"type": "snapshot"}, user)
    if result.get("ok"):
        result["elements"] = [
            _clean_entry(e) for e in result.get("elements") or [] if isinstance(e, dict)
        ]
    return result


def _pick_target(
    elements: list[dict[str, Any]],
    element_id: int | None,
    name: str | None,
    selector: str | None,
) -> tuple[dict[str, Any] | None, str | None]:
    """The ONE snapshot entry the action will hit, or a refusal reason.

    The guard must judge the element the browser will really act on, so the
    caller's name/selector are only used to find a unique entry in a fresh
    snapshot; the browser is then sent that entry's id (and its name to
    double-check), never the caller's free-form locator.
    """
    wanted_name = name.strip().lower() if name and name.strip() else None
    if element_id is not None:
        entry = next((e for e in elements if e.get("id") == element_id), None)
        if entry is None:
            return None, f"No element with id {element_id} on the page. Call app_describe_page again."
        if wanted_name is not None and str(entry.get("name") or "").lower() != wanted_name:
            return None, (
                f"Element {element_id} is named {entry.get('name')!r}, not {name!r}. "
                "Refusing a mismatched target."
            )
        if selector and entry.get("selector") != selector:
            return None, f"Element {element_id} does not match selector {selector!r}."
        return entry, None
    if selector:
        matches = [e for e in elements if e.get("selector") == selector]
        if wanted_name is not None:
            matches = [e for e in matches if str(e.get("name") or "").lower() == wanted_name]
    elif wanted_name is not None:
        matches = [e for e in elements if str(e.get("name") or "").lower() == wanted_name]
        if not matches:
            matches = [e for e in elements if wanted_name in str(e.get("name") or "").lower()]
    else:
        return None, "Name the target: element_id (from app_describe_page), name or selector."
    if not matches:
        return None, "No element matched. Call app_describe_page and use an element_id."
    if len(matches) > 1:
        options = ", ".join(f"{e.get('id')}={e.get('name')!r}" for e in matches[:8])
        return None, f"{len(matches)} elements match ({options}). Pass the element_id."
    return matches[0], None


def _build_command(
    action: str,
    target: dict[str, Any] | None,
    value: str | None,
    path: str | None,
) -> dict[str, Any]:
    if action == "snapshot":
        return {"type": "snapshot"}
    if action == "navigate":
        return {"type": "navigate", "path": path or "/"}
    assert target is not None
    command: dict[str, Any] = {
        "type": action,
        "elementId": target.get("id"),
        "expectName": str(target.get("name") or ""),
    }
    if action in ("type", "select"):
        command["value"] = value or ""
    return command


async def _run_action(
    action: str,
    element_id: int | None,
    name: str | None,
    selector: str | None,
    value: str | None,
    path: str | None,
    enforce_guard: bool,
) -> dict[str, Any]:
    if action not in SAFE_ACTIONS:
        return {"ok": False, "detail": f"Unknown action '{action}'. One of: {sorted(SAFE_ACTIONS)}"}
    user = _caller()
    try:
        if action == "snapshot":
            return await _snapshot(user)
        target: dict[str, Any] | None = None
        if action in ELEMENT_ACTIONS:
            snap = await _snapshot(user)
            if not snap.get("ok"):
                return snap
            target, problem = _pick_target(snap.get("elements") or [], element_id, name, selector)
            if target is None:
                return {"ok": False, "detail": problem}
            target_name = str(target.get("name") or "").strip()
            if action == "read" and target.get("sensitive"):
                return {"ok": False, "detail": SENSITIVE_READ_REFUSAL, "element": target_name}
            if enforce_guard and action in ("click", "select"):
                if not target_name:
                    return {"ok": False, "detail": UNNAMED_REFUSAL, "element_id": target.get("id")}
                if looks_destructive(target_name):
                    return {"ok": False, "detail": DESTRUCTIVE_REFUSAL, "element": target_name}
        return await hub.send_command(_build_command(action, target, value, path), user)
    except HubError as err:
        return {"ok": False, "detail": str(err)}


# ---------------------------------------------------------------------------
# MCP tools (registered as mcp_app_* on the Hermes side)
# ---------------------------------------------------------------------------

@mcp.tool()
async def app_state() -> dict[str, Any]:
    """Which page of agent-home the user is on and which UI element they last
    touched. Use this to resolve references like "this page" or "the button
    I'm on" before acting."""
    return hub.state_summary(_caller())


@mcp.tool()
async def app_pages() -> dict[str, Any]:
    """The map of agent-home pages (route, name, purpose), with the user's
    current page marked. For what is ON the current page, use app_describe_page;
    for how a page or feature is used, app_page_help."""
    current = hub.state_summary(_caller()).get("page")
    return {
        "current": current,
        "pages": [
            {**p, "current": p["path"] == current, "has_help": help_for(p["path"]) is not None}
            for p in PAGES
        ],
    }


@mcp.tool()
async def app_page_help(path: str | None = None) -> dict[str, Any]:
    """Usage guide for an agent-home page or feature, written for the user:
    what the screen is for, how to use it end to end, what each option means
    and who may do what. Defaults to the page the user is on; pass a path
    (e.g. "/projects") to explain another one. Use this to answer "how do I
    use …", "what does this page do", "what is the difference between …"."""
    target = path or hub.state_summary(_caller()).get("page")
    text = help_for(target)
    if text is None:
        return {"ok": False, "path": target, "detail": "No guide for this page."}
    return {"ok": True, "path": target, "help": text}


@mcp.tool()
async def app_describe_page() -> dict[str, Any]:
    """Detailed description of every interactive element on the page the user
    is on right now: id, role, accessible name, value/checked/disabled and a
    selector. Use the ids with app_act / app_act_destructive."""
    user = _caller()
    try:
        result = await _snapshot(user)
    except HubError as err:
        return {"ok": False, "detail": str(err)}
    if not result.get("ok"):
        return result
    elements = result.get("elements") or []
    page = hub.state_summary(user).get("page")
    return {
        "ok": True,
        "page": page,
        "has_help": help_for(page) is not None,
        "element_count": len(elements),
        "elements": elements,
    }


@mcp.tool()
async def app_act(
    action: str,
    element_id: int | None = None,
    name: str | None = None,
    selector: str | None = None,
    value: str | None = None,
    path: str | None = None,
) -> dict[str, Any]:
    """Perform a SAFE action on the user's app UI and report the outcome.
    Actions: click, type, select, focus, read, scroll (target one element by
    element_id from app_describe_page; a name/selector must match exactly one
    element); navigate (pass path, e.g. "/todos"); snapshot. Refuses elements
    that look destructive or have no name — those need app_act_destructive."""
    return await _run_action(action, element_id, name, selector, value, path, enforce_guard=True)


@mcp.tool()
async def app_act_destructive(
    action: str,
    element_id: int | None = None,
    name: str | None = None,
    selector: str | None = None,
    value: str | None = None,
    path: str | None = None,
) -> dict[str, Any]:
    """Perform a DESTRUCTIVE or externally-visible action on the user's app UI
    (delete, archive, send, submit…). This tool is gated by the user's
    approval flow — the user sees exactly what will happen and approves or
    denies before anything runs. Same parameters as app_act."""
    return await _run_action(action, element_id, name, selector, value, path, enforce_guard=False)


# ---------------------------------------------------------------------------
# Folder Bridge tools (registered as mcp_app_folder_bridge_* on the Hermes
# side). Each is a thin forward to `folder_hub` — the browser holds the
# FileSystemDirectoryHandle map and does the actual traversal/read; this
# service only brokers the request/response, exactly like `_run_action`
# above does for UI commands. See README.md for the approvals.tools
# recommendation before enabling this in a shared/production config.
# ---------------------------------------------------------------------------

NOT_CONNECTED_HINT = (
    "No Folder Bridge session connected. Tell the user to open Files -> "
    "Folder Bridge (/files/bridge) in their browser on their Mac and "
    "press Connect, then add at least one folder."
)


async def _folder_command(command: dict[str, Any]) -> dict[str, Any]:
    user = _caller()
    if not folder_hub.is_connected(user):
        return {"ok": False, "detail": NOT_CONNECTED_HINT}
    try:
        return await folder_hub.send_command(command, user)
    except HubError as err:
        return {"ok": False, "detail": str(err)}


async def _network_folders() -> tuple[list[dict[str, Any]], str | None]:
    """(records, error) for every network folder on the box."""
    if not hermes.configured:
        return [], None
    try:
        return [nf.folder_record(v) for v in await hermes.list_folders()], None
    except nf.NetFolderError as err:
        return [], str(err)


async def _net_call(folder_id: str, fn: Any, *args: Any) -> dict[str, Any]:
    """Run one filesystem op on a mounted network folder (mounting it first)."""
    try:
        root = await nf.ensure_root(hermes, folder_id)
        return await asyncio.to_thread(fn, root, folder_id, *args)
    except nf.NetFolderError as err:
        return {"ok": False, "detail": str(err)}
    except OSError as err:
        return {"ok": False, "detail": f"File server error: {err.strerror or err}"}


@mcp.tool()
async def folder_bridge_state() -> dict[str, Any]:
    """Whether a Folder Bridge browser session is connected right now, and
    how long ago it last reported in. Use this before the other
    folder_bridge_* tools to know whether to ask the user to connect one
    first (Files -> Folder Bridge, /files/bridge, on their Mac). If an
    import_file call is currently in flight, this also returns
    `active_upload: {bytes_sent, bytes_total, percent}` from the browser's
    live upload progress — useful for reassuring the user a large import
    hasn't stalled without waiting for the (possibly very long) tool call
    itself to return. `network_folders` counts the server-side network
    folders (office file shares through a VPN), which work without a
    browser session."""
    summary = folder_hub.state_summary(_caller())
    folders, error = await _network_folders()
    summary["network_folders"] = len(folders)
    summary["network_folders_mounted"] = sum(1 for f in folders if f["mounted"])
    if error:
        summary["network_folders_error"] = error
    return summary


@mcp.tool()
async def folder_bridge_list_folders() -> dict[str, Any]:
    """List every folder the agent can use: the folders the user approved in
    their current Folder Bridge browser session, plus network folders
    (`kind: "network"`, ids `net-…`: office file shares reached through a
    VPN, read-only, available even when no browser is connected; they are
    mounted on first use). Each has id, label, permission and `trusted`
    (import without asking). Use the ids with the other folder_bridge_*
    tools. Browse a network folder one directory at a time with
    folder_bridge_list_directory, one call after another: never walk a whole
    share (or run `find`/`ls -R` on its mount) and never list in parallel —
    it jams the VPN link. Totals of big shares are unknown."""
    network, net_error = await _network_folders()
    browser: dict[str, Any] = {"ok": False, "detail": NOT_CONNECTED_HINT}
    if folder_hub.is_connected(_caller()):
        browser = await _folder_command({"type": "listFolders"})
    if not network and not net_error:
        return browser
    out: dict[str, Any] = {
        "ok": True,
        "folders": list(browser.get("folders") or []) + network,
    }
    if not browser.get("ok"):
        out["browser"] = browser.get("detail")
    if net_error:
        out["network_error"] = net_error
    return out


@mcp.tool()
async def folder_bridge_list_directory(
    folder_id: str, path: str | None = None
) -> dict[str, Any]:
    """List the contents of a directory inside one approved folder.
    `path` is relative to the folder root (omit or "" for the root)."""
    if nf.is_net_id(folder_id):
        return await _net_call(folder_id, nf.list_directory, path or "")
    return await _folder_command(
        {"type": "listDirectory", "folderId": folder_id, "path": path or ""}
    )


@mcp.tool()
async def folder_bridge_search_files(
    folder_ids: list[str],
    query: str,
    extensions: list[str] | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Search by file or folder name (case-insensitive substring, or a
    `*`/`?` glob such as "*.pdf"; a query containing `/` is matched against
    the whole "Folder label/relative/path") plus a short content snippet
    where feasible, across one or more approved folders. `folder_ids` from
    folder_bridge_list_folders; `extensions` optionally narrows to file
    types (e.g. [".md", ".pdf", ".txt"]). Browser and network (`net-…`)
    folder ids may be mixed."""
    net_ids = [f for f in folder_ids if nf.is_net_id(f)]
    browser_ids = [f for f in folder_ids if not nf.is_net_id(f)]
    matches: list[dict[str, Any]] = []
    problems: list[str] = []
    if browser_ids:
        result = await _folder_command(
            {
                "type": "searchFiles",
                "folderIds": browser_ids,
                "query": query,
                "extensions": extensions or [],
                "limit": limit,
            }
        )
        if not net_ids:
            return result
        if result.get("ok"):
            matches.extend(result.get("matches") or [])
        else:
            problems.append(str(result.get("detail")))
    labels: dict[str, str] = {}
    if net_ids:
        network, net_error = await _network_folders()
        labels = {f["id"]: f["label"] for f in network}
        if net_error:
            problems.append(net_error)
    for fid in net_ids:
        if len(matches) >= limit:
            break
        if fid not in labels:
            problems.append(f"{fid}: unknown network folder")
            continue
        try:
            root = await nf.ensure_root(hermes, fid)
            found = await asyncio.to_thread(
                nf.search_folder, root, fid, labels[fid], query, extensions or [],
                limit - len(matches),
            )
        except (nf.NetFolderError, OSError) as err:
            problems.append(f"{labels[fid]}: {err}")
            continue
        matches.extend(found)
    if not matches and problems:
        return {"ok": False, "detail": "; ".join(problems)}
    out: dict[str, Any] = {"ok": True, "matches": matches[:limit]}
    if problems:
        out["warnings"] = problems
    return out


@mcp.tool()
async def folder_bridge_read_file(
    folder_id: str, path: str, max_bytes: int = 200_000
) -> dict[str, Any]:
    """Read a UTF-8 text file's content from an approved folder (capped at
    max_bytes). Binary files (PDF, .numbers/.xlsx, images, ...) are refused
    with `binary: true` — use folder_bridge_import_file for those, which
    copies the bytes intact into Files instead of decoding them. This is a
    read of the user's own local files — Hermes recommends gating this tool
    behind approvals.tools so the user sees and approves each read in chat."""
    if nf.is_net_id(folder_id):
        return await _net_call(folder_id, nf.read_file, path, max_bytes)
    return await _folder_command(
        {
            "type": "readFile",
            "folderId": folder_id,
            "path": path,
            "encoding": "utf-8",
            "maxBytes": max_bytes,
        }
    )


async def _import_file(folder_id: str, path: str, *, approved: bool) -> dict[str, Any]:
    if nf.is_net_id(folder_id):
        # Hermes (which holds the Storage credentials) reads the mount and
        # enforces "trusted for import" again; bytes never pass through here.
        try:
            return await hermes.import_file(folder_id, path, approved)
        except nf.NetFolderError as err:
            return {"ok": False, "detail": str(err)}
    return await _folder_command(
        {"type": "importFile", "folderId": folder_id, "path": path, "approved": approved}
    )


@mcp.tool()
async def folder_bridge_import_file(folder_id: str, path: str) -> dict[str, Any]:
    """Copy one file from an approved folder byte-for-byte into Files (the
    file store + registry), any type including PDF/.numbers/.xlsx. The
    browser uploads the bytes directly; the result is the registry row
    (asset id, filename, size, sha256, storage path, `verified` = the stored
    hash matches the original). Only works for folders the user has marked
    "trusted for import" on /files/bridge — otherwise it returns
    `needsApproval: true`; then use folder_bridge_import_file_approved,
    which asks the user in chat."""
    return await _import_file(folder_id, path, approved=False)


@mcp.tool()
async def folder_bridge_import_file_approved(folder_id: str, path: str) -> dict[str, Any]:
    """Same as folder_bridge_import_file, for a folder the user has NOT
    marked trusted: the user approves this specific file in chat first.
    Hermes must list this tool in approvals.tools — that prompt is the
    approval; the browser then accepts the import."""
    return await _import_file(folder_id, path, approved=True)


@mcp.tool()
async def folder_bridge_get_file_metadata(folder_id: str, path: str) -> dict[str, Any]:
    """Get a file's size, last-modified time and path without reading its
    content."""
    if nf.is_net_id(folder_id):
        return await _net_call(folder_id, nf.file_metadata, path)
    return await _folder_command(
        {"type": "getFileMetadata", "folderId": folder_id, "path": path}
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

async def _main() -> None:
    if not TICKET_SECRET:
        raise SystemExit(
            "app-mcp: APP_MCP_TICKET_SECRET is not set — refusing to start "
            "(the browser bridge would be unauthenticated)."
        )
    if not read_token():
        log.warning(
            "app-mcp: no %s yet — the MCP endpoint accepts any local caller "
            "until Hermes connects and creates it.",
            TOKEN_FILE,
        )
    async with websockets.serve(_ws_handler, "127.0.0.1", WS_PORT):
        log.info("app-mcp: WS hub on 127.0.0.1:%s, MCP on 127.0.0.1:%s/mcp", WS_PORT, MCP_PORT)
        await _serve_mcp()


def mcp_http_app(token_file=TOKEN_FILE):
    """The streamable-HTTP MCP app behind the bearer-token check (F19)."""
    return BearerTokenMiddleware(mcp.streamable_http_app(), token_file)


async def _serve_mcp() -> None:  # pragma: no cover - runs the real server
    import uvicorn

    config = uvicorn.Config(
        mcp_http_app(),
        host=mcp.settings.host,
        port=mcp.settings.port,
        log_level=mcp.settings.log_level.lower(),
    )
    await uvicorn.Server(config).serve()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    asyncio.run(_main())


if __name__ == "__main__":
    main()
