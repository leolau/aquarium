"""Per-person MCP servers: storage, checks and HTTP routes (Get ready item 8).

A person adds their own MCP servers here. Each one is a credential-store entry
(provider ``mcp``, kind ``mcp-server``, visibility ``private:<user>``), so the
header values (API keys) live with the person's other secrets and never leave
through an API response. ``tools/personal_mcp.py`` loads them into that
person's chats only.

Install-wide servers (``mcp_servers`` in config.yaml, Settings → Tools &
Integrations, owner/admin) are a separate list and are not changed here.

Rules for a personal server, enforced on every save and again at chat start:

* HTTP(S) address only. No ``command`` (stdio) servers: those run a program on
  this server with the service's own environment.
* The address must be on the internet: names that resolve to this machine or
  a private network (127.0.0.1, 10.x, 192.168.x, 169.254.x, ...) are refused,
  so nobody can point "their" tools at Aquarium's own internal services.
* No ``${VAR}`` placeholders: install-wide configs expand those from the
  server's .env, which would hand install secrets to a personal server.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import re
import socket
import threading
from typing import Any, Dict, List, Mapping, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request

from hermes_cli.route_roles import require_admin

logger = logging.getLogger(__name__)

PROVIDER = "mcp"
KIND = "mcp-server"
#: Most servers one person may add.
MAX_SERVERS = 20
_MAX_HEADERS = 10

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,23}$")
_HEADER_NAME_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$")


class PersonalMcpError(ValueError):
    """A personal server entry that may not be saved or loaded."""


def _resolve(host: str) -> List[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({info[4][0] for info in infos})


def _is_public(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def check_url(url: Any, *, resolve: bool = True) -> str:
    """The cleaned server address, or :class:`PersonalMcpError`."""
    if not isinstance(url, str) or not url.strip():
        raise PersonalMcpError("Enter the server address (https://…).")
    url = url.strip()
    if "${" in url:
        raise PersonalMcpError("The address can't contain ${…} placeholders.")
    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise PersonalMcpError(f"That address isn't valid ({exc}).") from exc
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        raise PersonalMcpError("The address must start with https:// (or http://).")
    if parsed.username or parsed.password:
        raise PersonalMcpError("Put keys in a header, not in the address.")
    del port
    if resolve:
        host = parsed.hostname
        try:
            addresses = _resolve(host)
        except (OSError, UnicodeError) as exc:
            raise PersonalMcpError(f"Can't find the server '{host}'.") from exc
        if not addresses or not all(_is_public(a) for a in addresses):
            raise PersonalMcpError(
                f"'{host}' is on this server or a private network. Your own "
                "tools must be on the internet; ask the owner to add internal "
                "servers for everyone."
            )
    return url


def check_headers(headers: Any) -> Dict[str, str]:
    if headers in (None, ""):
        return {}
    if not isinstance(headers, Mapping):
        raise PersonalMcpError("Headers must be name/value pairs.")
    if len(headers) > _MAX_HEADERS:
        raise PersonalMcpError(f"At most {_MAX_HEADERS} headers.")
    clean: Dict[str, str] = {}
    for key, value in headers.items():
        key = str(key).strip()
        value = "" if value is None else str(value).strip()
        if not _HEADER_NAME_RE.fullmatch(key):
            raise PersonalMcpError(f"'{key}' isn't a valid header name.")
        if any(c in value for c in "\r\n\0"):
            raise PersonalMcpError(f"The value of '{key}' has a line break.")
        if "${" in value:
            raise PersonalMcpError(f"The value of '{key}' can't contain ${{…}} placeholders.")
        if value:
            clean[key] = value
    return clean


def check_name(name: Any) -> str:
    name = str(name or "").strip()
    if not _NAME_RE.fullmatch(name):
        raise PersonalMcpError(
            "Use 1–24 lower-case letters, digits, - or _ for the name "
            "(for example: notion)."
        )
    return name


def check_payload(payload: Mapping[str, Any], *, resolve: bool = True) -> Dict[str, Any]:
    """Normalised ``{url, headers?, auth?}`` or :class:`PersonalMcpError`."""
    unknown = sorted(set(payload) - {"url", "headers", "auth"})
    if unknown:
        raise PersonalMcpError(f"Unknown fields: {', '.join(unknown)}")
    out: Dict[str, Any] = {"url": check_url(payload.get("url"), resolve=resolve)}
    headers = check_headers(payload.get("headers"))
    if headers:
        out["headers"] = headers
    auth = payload.get("auth")
    if auth not in (None, "", "oauth"):
        raise PersonalMcpError("Sign-in type must be empty or 'oauth'.")
    if auth == "oauth":
        out["auth"] = "oauth"
    return out


def validate_credential_payload(payload: Mapping[str, Any]) -> None:
    """``KindSpec`` validator: the same rules for writes via /api/credentials."""
    from hermes_cli.credential_store import CredentialError

    try:
        check_payload(payload)
    except PersonalMcpError as exc:
        raise CredentialError(str(exc)) from exc


def runtime_config(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """The ``mcp_servers``-shaped config the MCP client connects with."""
    cfg: Dict[str, Any] = {"url": payload["url"]}
    if payload.get("headers"):
        cfg["headers"] = dict(payload["headers"])
    if payload.get("auth") == "oauth":
        cfg["auth"] = "oauth"
    return cfg


# -- storage --------------------------------------------------------------


def _store():
    from hermes_cli.credential_store import default_credential_store

    return default_credential_store()


def _reader(user_id: str):
    """A non-owner principal for *user_id*: sees shared + their private rows."""
    from hermes_cli.access import Principal

    return Principal(user_id=user_id, display=user_id, role="member")


async def list_own(principal: Any) -> List[Any]:
    entries = await _store().list(principal)
    return sorted(
        (
            e
            for e in entries
            if e.provider == PROVIDER
            and e.kind == KIND
            and e.owner_user_id == principal.user_id
        ),
        key=lambda e: e.name,
    )


def load_runtime_configs(user_id: str) -> Dict[str, Dict[str, Any]]:
    """name -> client config for *user_id*'s servers (sync; for chat start)."""
    from hermes_cli.principal_binding import _run_async

    entries = _run_async(list_own(_reader(user_id)), timeout=10) or []
    out: Dict[str, Dict[str, Any]] = {}
    for entry in entries:
        try:
            out[entry.name] = runtime_config(check_payload(entry.payload))
        except PersonalMcpError as exc:
            logger.warning("personal MCP '%s' for %s skipped: %s", entry.name, user_id, exc)
    return out


# -- HTTP ------------------------------------------------------------------

router = APIRouter(prefix="/api/mcp/personal")


async def _principal(request: Request):
    from hermes_cli import web_server as ws

    try:
        return await ws._comms_resolve_principal(request)
    except ws._CommsNotConfigured as exc:
        raise HTTPException(
            409,
            "Your own tools need sign-in for each person (multi-user setup).",
        ) from exc


def _summary(entry: Any) -> Dict[str, Any]:
    from tools.personal_mcp import internal_name

    payload = entry.payload or {}
    row = {
        "name": entry.name,
        "url": payload.get("url"),
        "auth": payload.get("auth") or None,
        "header_names": sorted((payload.get("headers") or {}).keys()),
    }
    if row["auth"] == "oauth":
        row["oauth_token_present"] = _oauth_token_present(
            internal_name(entry.owner_user_id, entry.name)
        )
    return row


def _oauth_token_present(server: str) -> bool:
    try:
        from tools.mcp_oauth import HermesTokenStorage

        return HermesTokenStorage(server).has_cached_tokens()
    except Exception:  # noqa: BLE001
        return False


async def _own_entry(principal: Any, name: str):
    for entry in await list_own(principal):
        if entry.name == name:
            return entry
    raise HTTPException(404, f"You have no tool called '{name}'.")


@router.get("")
async def list_personal_servers(request: Request):
    from hermes_cli import web_server as ws

    try:
        principal = await ws._comms_resolve_principal(request)
    except ws._CommsNotConfigured:
        return {"configured": False, "servers": [], "limit": MAX_SERVERS}
    entries = await list_own(principal)
    return {
        "configured": True,
        "servers": [_summary(e) for e in entries],
        "limit": MAX_SERVERS,
    }


@router.post("")
async def add_personal_server(request: Request):
    principal = await _principal(request)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    body = body if isinstance(body, dict) else {}
    try:
        unknown = sorted(set(body) - {"name", "url", "headers", "auth"})
        if unknown:
            raise PersonalMcpError(
                f"Not allowed for your own tools: {', '.join(unknown)}. "
                "Only internet (https://) servers can be added here."
            )
        name = check_name(body.get("name"))
        payload = await asyncio.to_thread(
            check_payload,
            {k: body.get(k) for k in ("url", "headers", "auth") if body.get(k) is not None},
        )
    except PersonalMcpError as exc:
        raise HTTPException(400, str(exc)) from exc
    existing = await list_own(principal)
    if any(e.name == name for e in existing):
        raise HTTPException(409, f"You already have a tool called '{name}'.")
    if len(existing) >= MAX_SERVERS:
        raise HTTPException(400, f"You can add up to {MAX_SERVERS} servers.")
    from hermes_cli.credential_store import CredentialError

    try:
        entry = await _store().put(
            principal,
            provider=PROVIDER,
            name=name,
            kind=KIND,
            payload=payload,
            visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _summary(entry)


@router.delete("/{name}")
async def remove_personal_server(request: Request, name: str):
    from tools.personal_mcp import drop_server, internal_name

    principal = await _principal(request)
    await _own_entry(principal, name)
    await _store().delete(principal, PROVIDER, name)
    server = internal_name(principal.user_id, name)
    await asyncio.to_thread(drop_server, server)
    try:
        from tools.mcp_oauth_manager import get_manager

        get_manager().remove(server)
    except Exception:  # noqa: BLE001 - no OAuth support / no tokens
        pass
    return {"ok": True}


@router.post("/{name}/test")
async def test_personal_server(request: Request, name: str):
    from hermes_cli.mcp_config import _probe_single_server
    from tools.personal_mcp import internal_name

    principal = await _principal(request)
    entry = await _own_entry(principal, name)
    server = internal_name(principal.user_id, name)
    try:
        cfg = runtime_config(await asyncio.to_thread(check_payload, entry.payload))
    except PersonalMcpError as exc:
        return {"ok": False, "error": str(exc), "tools": []}
    if cfg.get("auth") == "oauth" and not _oauth_token_present(server):
        return {"ok": False, "error": "Sign in to this server first.", "tools": [], "needs_sign_in": True}
    try:
        tools = await asyncio.to_thread(_probe_single_server, server, cfg)
    except Exception as exc:  # noqa: BLE001 - shown to the person
        return {"ok": False, "error": str(exc) or type(exc).__name__, "tools": []}
    return {"ok": True, "tools": [{"name": t, "description": d} for t, d in tools]}


@router.get("/catalog")
async def personal_catalog(request: Request):
    """Catalog servers a person can add for themselves (internet HTTP ones)."""
    principal = await _principal(request)
    from hermes_cli import mcp_catalog

    added = {e.name for e in await list_own(principal)}
    entries = []
    for entry in mcp_catalog.list_catalog():
        transport = entry.transport
        auth_type = getattr(entry.auth, "type", "none") or "none"
        if transport.type != "http" or entry.install is not None:
            continue
        if not str(transport.url or "").startswith("https://"):
            continue
        if auth_type not in ("none", "oauth"):
            continue
        entries.append(
            {
                "name": entry.name,
                "description": entry.description,
                "url": transport.url,
                "auth": "oauth" if auth_type == "oauth" else None,
                "added": entry.name in added,
            }
        )
    return {"entries": entries}


@router.get("/people", dependencies=[Depends(require_admin)])
async def personal_servers_by_person(request: Request):
    """How many own tools each person has (owner/admin view; names only)."""
    from hermes_cli.access import Principal

    reader = Principal(user_id="__personal_mcp_status__", display="", role="owner")
    counts: Dict[str, int] = {}
    for entry in await _store().list(reader):
        if entry.provider == PROVIDER and entry.kind == KIND:
            counts[entry.owner_user_id] = counts.get(entry.owner_user_id, 0) + 1
    return {"people": [{"user_id": u, "servers": n} for u, n in sorted(counts.items())]}


# -- OAuth sign-in for a personal server ------------------------------------
#
# Reuses the dashboard's browser-driven flow (start → open the URL → paste the
# redirect back). Tokens are stored under the server's per-person internal
# name, so they belong to that person only.


def _flow_key(server: str) -> str:
    return f"personal:{server}"


@router.post("/{name}/oauth/start")
async def start_personal_oauth(request: Request, name: str):
    from hermes_cli import web_server as ws
    from tools.mcp_oauth import _OAUTH_AVAILABLE
    from tools.personal_mcp import drop_server, internal_name

    principal = await _principal(request)
    entry = await _own_entry(principal, name)
    try:
        cfg = runtime_config(await asyncio.to_thread(check_payload, entry.payload))
    except PersonalMcpError as exc:
        raise HTTPException(400, str(exc)) from exc
    if cfg.get("auth") != "oauth":
        raise HTTPException(400, f"'{name}' doesn't use sign-in.")
    if not _OAUTH_AVAILABLE:
        raise HTTPException(503, "MCP sign-in support is not installed.")
    server = internal_name(principal.user_id, name)
    key = _flow_key(server)
    with ws._MCP_OAUTH_FLOWS_LOCK:
        ws._mcp_oauth_flows_gc()
        existing = ws._MCP_OAUTH_FLOWS.get(key)
        if existing and existing["status"] in ws._MCP_OAUTH_FLOW_ACTIVE:
            return _public_flow(existing)
        if any(st["status"] in ws._MCP_OAUTH_FLOW_ACTIVE for st in ws._MCP_OAUTH_FLOWS.values()):
            raise HTTPException(409, "Another sign-in is running. Try again in a few minutes.")
        state: Dict[str, Any] = {
            "status": "starting",
            "name": name,
            "authorization_url": None,
            "error": None,
        }
        ws._MCP_OAUTH_FLOWS[key] = state
    await asyncio.to_thread(drop_server, server)
    threading.Thread(
        target=ws._run_mcp_oauth_flow,
        args=(server, cfg, None, state),
        daemon=True,
        name=f"mcp-oauth-{server}",
    ).start()
    return _public_flow(state)


def _public_flow(state: Mapping[str, Any]) -> Dict[str, Any]:
    error = state.get("error")
    if error and "config.yaml" in str(error):
        error = "The server didn't finish the sign-in. Try again, or ask the owner."
    return {
        "status": state.get("status"),
        "name": state.get("name"),
        "authorization_url": state.get("authorization_url"),
        "error": error,
    }


@router.get("/{name}/oauth/status")
async def personal_oauth_status(request: Request, name: str):
    from hermes_cli import web_server as ws
    from tools.personal_mcp import internal_name

    principal = await _principal(request)
    with ws._MCP_OAUTH_FLOWS_LOCK:
        ws._mcp_oauth_flows_gc()
        state = ws._MCP_OAUTH_FLOWS.get(_flow_key(internal_name(principal.user_id, name)))
    if state is None:
        return {"status": "idle", "authorization_url": None, "error": None}
    return _public_flow(state)


@router.post("/{name}/oauth/redirect")
async def personal_oauth_redirect(request: Request, name: str):
    from hermes_cli import web_server as ws
    from tools.mcp_oauth import write_drop_redirect
    from tools.personal_mcp import internal_name

    principal = await _principal(request)
    try:
        body = await request.json()
    except ValueError:
        body = {}
    url = str((body or {}).get("url") or "").strip()
    server = internal_name(principal.user_id, name)
    with ws._MCP_OAUTH_FLOWS_LOCK:
        state = ws._MCP_OAUTH_FLOWS.get(_flow_key(server))
    if state is None or state["status"] != "waiting_user":
        raise HTTPException(409, f"No sign-in is waiting for '{name}'.")
    if "code=" not in url and "error=" not in url:
        raise HTTPException(400, "Paste the whole address the browser ended on (it contains code=).")
    write_drop_redirect(server, url)
    return {"ok": True}


@router.post("/{name}/oauth/cancel")
async def personal_oauth_cancel(request: Request, name: str):
    from hermes_cli import web_server as ws
    from tools.mcp_oauth import write_drop_redirect
    from tools.personal_mcp import internal_name

    principal = await _principal(request)
    server = internal_name(principal.user_id, name)
    with ws._MCP_OAUTH_FLOWS_LOCK:
        state = ws._MCP_OAUTH_FLOWS.get(_flow_key(server))
        if state is None or state["status"] not in ws._MCP_OAUTH_FLOW_ACTIVE:
            raise HTTPException(409, f"No sign-in is running for '{name}'.")
        state["cancelled"] = True
    write_drop_redirect(server, "?error=access_denied&error_description=cancelled")
    return {"ok": True}
