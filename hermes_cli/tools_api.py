"""``/api/tools*`` routes for the FG-07 tool registry and FG-33 apps (P8-2 item 2.2).

Moved out of ``web_server.py``; mounted there after the ``/api/tools/toolsets``
and ``/api/tools/computer-use`` routes so ``/api/tools/{name}`` cannot shadow
them. Every handler acts as the signed-in caller (C1). Who may act is checked
per app (C2): any reader may see a visible app; its owner, an admin or the
owner may change it (decision 9: members manage their own apps within the
quota policy, no C6). Irreversible acts keep one explicit confirmation.

When the Supabase application datastore is not configured, the list routes
degrade to ``{"configured": false}``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
import ssl
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter()

#: Write routes members may call on their own apps; the per-app check is in
#: the handler, through ``_app_tool_call`` (decision 9).
MEMBER_MANAGED_ROUTES: frozenset[str] = frozenset({
    "/api/tools/{name}",
    "/api/tools/{name}/enabled",
    "/api/tools/{name}/config",
    "/api/tools/{name}/promote",
    "/api/tools/{name}/build",
    "/api/tools/{name}/start",
    "/api/tools/{name}/stop",
    "/api/tools/{name}/restart",
    "/api/tools/{name}/icon",
    "/api/tools/{name}/secrets",
    "/api/tools/{name}/egress",
    "/api/tools/{name}/mcp",
    "/api/tools/{name}/visibility",
    "/api/tools/{name}/favicon-refresh",
    "/api/tools/{name}/feedback",
})

HEALTH_TTL_S = 30.0
PROBE_TIMEOUT_S = 2.0
PROBE_CONCURRENCY = 8
MAX_ICON_BYTES = 256 * 1024
MAX_FEEDBACK_CHARS = 4000
ICON_CONTENT_TYPES = ("image/png", "image/webp", "image/jpeg")
FAVICON_CONTENT_TYPES = (*ICON_CONTENT_TYPES, "image/x-icon")
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


# -- request bodies ----------------------------------------------------------


class ToolEnabledToggle(BaseModel):
    enabled: bool
    mode: Optional[str] = None


class ToolConfigUpdate(BaseModel):
    config: Dict[str, Any] = {}
    mode: Optional[str] = None


class ToolPromoteRequest(BaseModel):
    mode: Optional[str] = None


class ToolModeRequest(BaseModel):
    mode: Optional[str] = None


class ToolIconUpdate(BaseModel):
    icon_source: str
    icon: Optional[str] = None
    icon_color: Optional[str] = None
    icon_asset_id: Optional[str] = None
    mode: Optional[str] = None


class ToolSecretUpdate(BaseModel):
    name: str
    value: Optional[str] = None
    delete: bool = False
    mode: Optional[str] = None


class ToolEgressUpdate(BaseModel):
    hosts: List[str] = []
    mode: Optional[str] = None


class ToolMcpUpdate(BaseModel):
    enabled: bool
    mode: Optional[str] = None


class ToolVisibilityUpdate(BaseModel):
    visibility: str
    mode: Optional[str] = None


class ToolFeedback(BaseModel):
    #: ``text`` is what the agent-home BFF (item 2.1) sends; ``body`` is accepted too.
    text: Optional[str] = None
    body: Optional[str] = None
    rating: Optional[str] = None
    mode: Optional[str] = None


# -- shared plumbing ---------------------------------------------------------


async def _principal(request: Request):
    from hermes_cli import web_server as ws

    return await ws._comms_resolve_principal(request)


def _resolve_tool_mode(mode: Optional[str]) -> str:
    from hermes_cli.datastore import resolve_mode

    return resolve_mode(mode if mode in ("dev", "prod") else None)


def _app_mode(mode: Optional[str]) -> str:
    """FG-33 app routes act on dev unless prod is asked for."""
    return mode if mode in ("dev", "prod") else "dev"


async def _app_tool_call(request: Request, mode: Optional[str], fn):
    """Run one act as the signed-in caller (C1) and map errors to HTTP.

    Who may act is checked per app (``AppRuntime.resolve`` / :func:`_tool_for`;
    C2: the app's owner, an admin or the owner; private apps of others are a
    404), so members manage their own apps within the quota policy (decision 9).
    """
    from hermes_cli.app_runtime import AdmissionRefused, AppRuntime, HelperError
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolConfigError, ToolRegistry

    try:
        operator = await _principal(request)
        registry = ToolRegistry(get_store("supabase-app", _app_mode(mode)))
        await registry.initialize()
        return await fn(AppRuntime(), registry, operator)
    except HTTPException:
        raise
    except KeyError:
        raise HTTPException(status_code=404, detail="Tool not found")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except AdmissionRefused as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except (ToolConfigError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HelperError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


def _can_manage(principal: Any, tool: Any) -> bool:
    from hermes_cli.app_runtime import _can_manage as can

    return can(principal, tool)


async def _tool_for(registry: Any, principal: Any, name: str, *, write: bool) -> Any:
    """The tool if ``principal`` may see it (else ``KeyError``, never a leak)."""
    tool = await registry.get_for_principal(principal, name)
    if tool is None:
        raise KeyError(name)
    if write and not _can_manage(principal, tool):
        raise PermissionError(f"Only the app's owner or an admin can change {name!r}")
    return tool


_UPDATABLE = {
    "icon": "", "icon_color": "", "icon_asset_id": "", "icon_source": "",
    "visibility": "", "secret_names": "::text[]",
}


async def _update_tool(registry: Any, name: str, **cols: Any) -> Any:
    """Write a few row columns after the caller's per-app check passed."""
    from hermes_cli.tools_registry import _COLUMNS, TOOLS_TABLE, _row_to_tool

    unknown = set(cols) - set(_UPDATABLE)
    if unknown:  # pragma: no cover - programming error
        raise ValueError(f"not updatable here: {sorted(unknown)}")
    names = list(cols)
    sets = ", ".join(f"{c} = ${i + 2}{_UPDATABLE[c]}" for i, c in enumerate(names))
    conn = await registry.store.connect()
    try:
        row = await conn.fetchrow(
            f"UPDATE {TOOLS_TABLE} SET {sets}, updated_at = NOW() "
            f"WHERE name = $1 RETURNING {_COLUMNS}",
            name, *[cols[c] for c in names],
        )
    finally:
        await conn.close()
    if row is None:
        raise KeyError(name)
    return _row_to_tool(row)


async def _update_endpoint(registry: Any, endpoint: str, **cols: Any) -> Optional[dict]:
    """Mirror ``enabled``/``visibility`` onto the app's FG-11 endpoint row."""
    from hermes_cli.mcp_endpoints import _COLUMNS, _row_to_endpoint

    names = [c for c in cols if c in ("enabled", "visibility")]
    if not names:
        return None
    sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(names))
    conn = await registry.store.connect()
    try:
        if await conn.fetchval("SELECT to_regclass('mcp_endpoints')") is None:
            return None
        row = await conn.fetchrow(
            f"UPDATE mcp_endpoints SET {sets} WHERE name = $1 RETURNING {_COLUMNS}",
            endpoint, *[cols[c] for c in names],
        )
    finally:
        await conn.close()
    return _public_endpoint(_row_to_endpoint(row).as_dict()) if row is not None else None


def _public_endpoint(endpoint: dict) -> dict:
    out = dict(endpoint)
    out.pop("secret_ref", None)
    transport = dict(out.get("transport") or {})
    transport.pop("env", None)
    out["transport"] = transport
    return out


# -- health: one registry read, parallel SSRF-safe probes, 30 s cache --------

_health_cache: Dict[Tuple[str, str, str], Tuple[float, dict]] = {}


def _is_public_ip(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return ip.is_global and not ip.is_multicast


def _public_addresses(host: str, port: int) -> List[str]:
    """Resolved addresses of ``host``; refuses if any is not a public address."""
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    addresses = list(dict.fromkeys(info[4][0] for info in infos))
    if not addresses:
        raise ValueError("does not resolve")
    for address in addresses:
        if not _is_public_ip(address):
            raise ValueError("resolves to a private address")
    return addresses


def fetch_public(url: str, *, timeout: float = PROBE_TIMEOUT_S, max_bytes: int = 0,
                 method: str = "GET") -> Tuple[int, Dict[str, str], bytes]:
    """One https request to a public host, pinned to the checked address.

    SSRF rules (FG-33 Security): https only, the host must resolve to public
    addresses only, the connection goes to that address (no DNS rebinding),
    redirects are never followed. Returns ``(status, headers, body)`` with at
    most ``max_bytes`` of body (``ValueError`` if it is larger).
    """
    import http.client

    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("only plain https:// URLs are probed")
    host = parsed.hostname
    port = parsed.port or 443
    address = _public_addresses(host, port)[0]
    context = ssl.create_default_context()

    class _Pinned(http.client.HTTPSConnection):
        def connect(self) -> None:
            sock = socket.create_connection((address, port), timeout=timeout)
            self.sock = context.wrap_socket(sock, server_hostname=host)

    conn = _Pinned(host, port, timeout=timeout, context=context)
    try:
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn.request(method, path, headers={"User-Agent": "aquarium-health/1", "Accept": "*/*"})
        resp = conn.getresponse()
        body = b""
        if max_bytes:
            body = resp.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ValueError(f"response is larger than {max_bytes} bytes")
        headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, headers, body
    finally:
        conn.close()


def _probe_internal(url: str) -> Tuple[bool, str]:
    """A loopback ``web_url`` probe (the app's own process); no redirects."""
    import urllib.error
    import urllib.request

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):  # noqa: D401
            return None

    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(url, timeout=PROBE_TIMEOUT_S) as resp:  # noqa: S310 - loopback only
            return True, f"HTTP {resp.status}"
    except urllib.error.HTTPError as exc:
        return True, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:200]


def _probe_target(tool: Any) -> Optional[Tuple[str, str]]:
    public = getattr(tool, "public_url", None)
    if public and getattr(tool, "hosting", None) != "local":
        return "public", public
    web = getattr(tool, "web_url", None)
    if web:
        parsed = urlparse(web)
        if parsed.scheme in ("http", "https") and parsed.hostname in _LOOPBACK_HOSTS:
            return "internal", web
    return None


def _probe(kind: str, url: str) -> dict:
    if kind == "internal":
        reachable, detail = _probe_internal(url)
        return {"reachable": reachable, "detail": detail, "status": None}
    try:
        status, _headers, _body = fetch_public(url, method="HEAD")
    except Exception as exc:  # noqa: BLE001
        return {"reachable": False, "detail": str(exc)[:200], "status": None}
    return {"reachable": True, "detail": f"HTTP {status}", "status": status}


async def _probe_cached(mode: str, tool: Any, target: Tuple[str, str], sem) -> dict:
    key = (mode, str(tool.id), target[1])
    now = time.monotonic()
    hit = _health_cache.get(key)
    if hit and now - hit[0] < HEALTH_TTL_S:
        return hit[1]
    async with sem:
        result = await asyncio.to_thread(_probe, *target)
    result["checked_at"] = time.time()
    _health_cache[key] = (time.monotonic(), result)
    if len(_health_cache) > 2048:
        for stale in sorted(_health_cache, key=lambda k: _health_cache[k][0])[:1024]:
            _health_cache.pop(stale, None)
    return result


async def _runtime_rows(registry: Any, tool_ids: List[str]) -> Dict[str, dict]:
    if not tool_ids:
        return {}
    try:
        conn = await registry.store.connect()
    except Exception:  # noqa: BLE001 - health is best-effort
        return {}
    try:
        if await conn.fetchval("SELECT to_regclass('tool_runtime')") is None:
            return {}
        rows = await conn.fetch(
            "SELECT tool_id, health, runtime_state, health_checked_at, consecutive_failures "
            "FROM tool_runtime WHERE tool_id = ANY($1::text[])",
            tool_ids,
        )
        return {str(r["tool_id"]): dict(r) for r in rows}
    except Exception:  # noqa: BLE001
        return {}
    finally:
        await conn.close()


def _local_health(tool: Any, row: Optional[dict]) -> dict:
    state = (row or {}).get("runtime_state")
    health = (row or {}).get("health")
    if getattr(tool, "build_state", None) == "building" or state in ("building", "starting"):
        verdict = "building"
    elif state == "running":
        verdict = health if health in ("ok", "degraded", "down") else "ok"
    elif state in ("failed", "over_quota") or getattr(tool, "build_state", None) == "failed":
        verdict = "down"
    elif state in ("stopped", "idle_stopped"):
        verdict = "off"
    else:
        verdict = "unknown"
    checked = (row or {}).get("health_checked_at")
    return {
        "state": verdict, "source": "runtime", "runtime_state": state,
        "checked_at": checked.isoformat() if hasattr(checked, "isoformat") else checked,
    }


async def health_for(registry: Any, tools: List[Any]) -> Dict[str, dict]:
    """``{tool name: health}`` for already C2-filtered ``tools``.

    Local apps read ``tool_runtime`` (one query); others get a cached probe:
    a public URL through :func:`fetch_public`, or a loopback ``web_url``.
    """
    mode = getattr(registry, "mode", "") or ""
    local = [t for t in tools if getattr(t, "hosting", None) == "local"]
    rows = await _runtime_rows(registry, [str(t.id) for t in local])
    out: Dict[str, dict] = {}
    sem = asyncio.Semaphore(PROBE_CONCURRENCY)
    pending = []
    for tool in tools:
        if getattr(tool, "status", "enabled") == "disabled":
            out[tool.name] = {"state": "off", "source": "status"}
        elif getattr(tool, "hosting", None) == "local":
            out[tool.name] = _local_health(tool, rows.get(str(tool.id)))
        else:
            target = _probe_target(tool)
            if target is None:
                out[tool.name] = {"state": "unknown", "source": "none", "detail": "no probe URL"}
            else:
                pending.append((tool, target))
    results = await asyncio.gather(
        *(_probe_cached(mode, t, target, sem) for t, target in pending)
    )
    for (tool, target), result in zip(pending, results):
        status = result.get("status")
        if not result["reachable"]:
            state = "down"
        elif isinstance(status, int) and status >= 500:
            state = "degraded"
        else:
            state = "ok"
        out[tool.name] = {"state": state, "source": target[0], **result}
    return out


# -- registry list + reads ---------------------------------------------------


@router.get("/api/tools")
async def list_tools(request: Request, mode: Optional[str] = None, include: str = ""):
    """Tools visible to the caller (C2) for a mode; ``include=health`` adds health."""
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    resolved_mode = _resolve_tool_mode(mode)
    try:
        viewer = await _principal(request)
        registry = ToolRegistry(get_store("supabase-app", resolved_mode))
        await registry.initialize()
        tools = await registry.list_for_principal(viewer)
    except HTTPException:
        raise
    except RuntimeError as exc:
        return {"configured": False, "mode": resolved_mode, "tools": [], "detail": str(exc)}
    rows = [t.as_dict() for t in tools]
    if "health" in {part.strip() for part in include.split(",")}:
        health = await health_for(registry, tools)
        for row in rows:
            row["health"] = health.get(row["name"], {"state": "unknown"})
    return {"configured": True, "mode": resolved_mode, "tools": rows}


@router.get("/api/tools/changes")
async def list_tool_changes(request: Request, mode: Optional[str] = None, limit: int = 50):
    """Render the C5/FG-12 change log entries visible to the caller (C2)."""
    from hermes_cli.changes import ChangeLog, initialize_changes
    from hermes_cli.datastore import get_store

    try:
        viewer = await _principal(request)
        prod_store = get_store("supabase-app", "prod")
        connection = await prod_store.connect()
        try:
            await initialize_changes(connection)
        finally:
            await connection.close()
        changes = await ChangeLog(prod_store).list_changes(viewer, limit=limit)
    except HTTPException:
        raise
    except RuntimeError as exc:
        return {"configured": False, "changes": [], "detail": str(exc)}
    return {
        "configured": True,
        "changes": [
            {
                "id": c.id,
                "actor_user_id": c.actor_user_id,
                "mode": c.mode,
                "target_kind": c.target_kind,
                "reversible": c.reversible,
                "visibility": c.visibility,
                "undone": c.undone,
                "payload": c.payload,
            }
            for c in changes
        ],
    }


def _usage_view(usage: Any) -> Optional[dict]:
    if usage is None:
        return None
    out = {}
    for key in ("registered", "running", "ram_mb", "disk_mb", "db_mb", "external_apps"):
        value = getattr(usage, key, None)
        out[key] = sorted(value) if isinstance(value, (set, frozenset)) else value
    return out


@router.get("/api/tools/quota")
async def tool_quota(request: Request):
    """The caller's own app limits and current use (for the quota strip)."""
    from hermes_cli.app_runtime import measure_usage
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    try:
        from hermes_cli import app_quota
        from hermes_cli import web_server as ws
    except ImportError:  # pragma: no cover - 1.6 is merged
        return {"configured": False}
    try:
        who = await _principal(request)
        policy = app_quota.load_policy()
        overrides = await app_quota.QuotaStore(ws._comms_app_store()).overrides_for(who.user_id)
        limits = app_quota.effective_limits(who.role, policy=policy, overrides=overrides)
        registry = ToolRegistry(get_store("supabase-app", "dev"))
        await registry.initialize()
        usage, _box = await measure_usage(registry, who)
    except HTTPException:
        raise
    except RuntimeError as exc:
        return {"configured": False, "detail": str(exc)}
    return {
        "configured": True,
        "user_id": who.user_id,
        "limits": limits.as_dict(),
        "usage": _usage_view(usage),
    }


@router.get("/api/tools/{name}")
async def get_tool(request: Request, name: str, mode: Optional[str] = None):
    """One visible tool with its runtime facts (C2 read)."""
    from hermes_cli.app_runtime import app_path

    async def _run(rt, reg, who):
        tool = await _tool_for(reg, who, name, write=False)
        payload = tool.as_dict()
        payload["can_manage"] = _can_manage(who, tool)
        if tool.hosting == "local":
            payload["path"] = app_path(tool.name, reg.mode)
        try:
            store = rt._store_for(reg)
            await store.initialize()
            payload["runtime"] = await store.get_runtime(tool.id)
        except Exception:  # noqa: BLE001 - the runtime tables may not exist yet
            payload["runtime"] = None
        return payload

    return await _app_tool_call(request, _resolve_tool_mode(mode), _run)


@router.get("/api/tools/{name}/health")
async def tool_health(request: Request, name: str, mode: Optional[str] = None):
    """Health of one visible tool (same rules and cache as the batch read)."""
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    resolved_mode = _resolve_tool_mode(mode)
    try:
        viewer = await _principal(request)
        registry = ToolRegistry(get_store("supabase-app", resolved_mode))
        await registry.initialize()
        tools = {t.name: t for t in await registry.list_for_principal(viewer)}
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    tool = tools.get(name)
    if tool is None:
        raise HTTPException(status_code=404, detail=f"Tool '{name}' not found")
    health = (await health_for(registry, [tool]))[name]
    reachable = health.get("reachable")
    if reachable is None:
        reachable = health["state"] in ("ok", "degraded")
    return {
        "name": name,
        "reachable": bool(reachable),
        "detail": health.get("detail") or health["state"],
        "web_url": getattr(tool, "web_url", None),
        "health": health,
    }


@router.get("/api/tools/{name}/mcp")
async def tool_mcp(request: Request, name: str, mode: Optional[str] = None):
    """The app's MCP endpoint row (no secret ref) and when changes apply."""

    async def _run(rt, reg, who):
        from hermes_cli.mcp_endpoints import MCPEndpointRegistry

        tool = await _tool_for(reg, who, name, write=False)
        endpoint = None
        if tool.mcp_endpoint_ref:
            found = await MCPEndpointRegistry(reg.store).get(tool.mcp_endpoint_ref)
            endpoint = _public_endpoint(found.as_dict()) if found is not None else None
        return {"tool": tool.name, "mode": reg.mode, "endpoint": endpoint,
                "takes_effect": "next_chat"}

    return await _app_tool_call(request, _resolve_tool_mode(mode), _run)


# -- registry writes (members on their own tools; decision 9) ----------------


@router.put("/api/tools/{name}/enabled")
async def set_tool_enabled(request: Request, name: str, body: ToolEnabledToggle):
    """Enable/disable a tool (its owner, an admin or the owner); records C5."""

    async def _run(rt, reg, who):
        try:
            tool = await reg.set_enabled(who, name, bool(body.enabled))
        except PermissionError:
            if who.role != "admin":
                raise
            await _tool_for(reg, who, name, write=True)
            tool = await _admin_set_enabled(reg, name, bool(body.enabled))
        await _provenance(who, f"hermes tool {'enable' if body.enabled else 'disable'} {name}",
                          name, tool, {"status": tool.status})
        return tool.as_dict()

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


async def _provenance(who: Any, action: str, name: str, tool: Any, payload: dict) -> None:
    from hermes_cli.datastore import get_store
    from hermes_cli.tool_cmd import _record_provenance

    await _record_provenance(
        get_store("supabase-app", "prod"), actor_user_id=who.user_id, action=action,
        target_ref=name, mode=tool.mode, visibility=tool.visibility, payload=payload,
    )


async def _admin_set_enabled(registry: Any, name: str, enabled: bool) -> Any:
    """An admin acting on someone else's tool (the registry allows only its owner)."""
    from hermes_cli.tools_registry import _COLUMNS, TOOLS_TABLE, _row_to_tool

    conn = await registry.store.connect()
    try:
        row = await conn.fetchrow(
            f"UPDATE {TOOLS_TABLE} SET status = $2, updated_at = NOW() "
            f"WHERE name = $1 RETURNING {_COLUMNS}",
            name, "enabled" if enabled else "disabled",
        )
    finally:
        await conn.close()
    if row is None:
        raise KeyError(name)
    return _row_to_tool(row)


@router.put("/api/tools/{name}/config")
async def set_tool_config(request: Request, name: str, body: ToolConfigUpdate):
    """Replace a tool's config_json (validated: no HERMES_* non-secret keys).

    The registry lets only the row's owner (or the owner role) write it.
    """

    async def _run(rt, reg, who):
        tool = await reg.set_config(who, name, body.config)
        await _provenance(who, f"hermes tool config {name}", name, tool,
                          {"config_json": tool.config_json})
        return tool.as_dict()

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


@router.post("/api/tools/{name}/promote")
async def promote_tool_route(request: Request, name: str, body: ToolPromoteRequest):
    """Dev→prod promotion. The explicit POST is the approval; a member may
    promote their own app within the quota policy (decision 9)."""
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry, promote_tool

    async def _run(rt, reg, who):
        from hermes_cli.app_runtime import admit

        if not (who.is_owner or who.role == "admin"):
            tool = await _tool_for(reg, who, name, write=True)
            if tool.hosting == "local":
                prod = ToolRegistry(get_store("supabase-app", "prod"))
                await prod.initialize()
                await admit(prod, who, "promote", tool=name)
        result = await promote_tool(
            get_store("supabase-app", "prod"), name, actor=who.user_id, approved=True,
        )
        return {
            "ok": True,
            "tool_name": result.tool_name,
            "approval_ref": result.approval_ref,
            "change_ref": result.change_ref,
            "promotion_ref": result.promotion_ref,
        }

    return await _app_tool_call(request, "dev", _run)


@router.put("/api/tools/{name}/icon")
async def set_tool_icon(request: Request, name: str, body: ToolIconUpdate):
    """Generated (monogram/emoji + palette token) or uploaded icon (C5)."""

    async def _run(rt, reg, who):
        tool = await _tool_for(reg, who, name, write=True)
        cols = await _icon_columns(who, body)
        updated = await _update_tool(reg, tool.name, **cols)
        await rt._record(reg, who, updated, f"hermes tool icon {name}", cols)
        return updated.as_dict()

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


def _valid_palette_token(value: Optional[str]) -> Optional[str]:
    import re

    if value is None:
        return None
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", value):
        raise ValueError("icon_color must be a palette token such as 'blue'")
    return value


async def _icon_columns(who: Any, body: ToolIconUpdate) -> dict:
    if body.icon_source == "generated":
        icon = (body.icon or "").strip()
        if not icon or len(icon) > 8 or any(ord(c) < 32 for c in icon):
            raise ValueError("A generated icon is a monogram or emoji of at most 8 characters")
        return {"icon_source": "generated", "icon": icon,
                "icon_color": _valid_palette_token(body.icon_color), "icon_asset_id": None}
    if body.icon_source == "uploaded":
        asset = await _visible_asset(who, body.icon_asset_id)
        if asset.content_type not in ICON_CONTENT_TYPES:
            raise ValueError("An uploaded icon must be PNG, WebP or JPEG (SVG is refused)")
        if int(asset.byte_size or 0) > MAX_ICON_BYTES:
            raise ValueError("An uploaded icon must be at most 256 KB")
        return {"icon_source": "uploaded", "icon_asset_id": asset.id,
                "icon_color": _valid_palette_token(body.icon_color)}
    raise ValueError("icon_source must be 'generated' or 'uploaded' (favicon: POST favicon-refresh)")


async def _visible_asset(who: Any, asset_id: Optional[str]) -> Any:
    from hermes_cli.file_registry import default_registry

    if not asset_id:
        raise ValueError("icon_asset_id is required for an uploaded icon")
    try:
        asset = await default_registry().get(who, asset_id)
    except Exception:  # noqa: BLE001 - no registry table yet == no such file
        asset = None
    if asset is None:
        raise ValueError("No such file")
    return asset


@router.put("/api/tools/{name}/visibility")
async def set_tool_visibility(request: Request, name: str, body: ToolVisibilityUpdate):
    """Share an app with members or make it private to its owner (C5)."""

    async def _run(rt, reg, who):
        tool = await _tool_for(reg, who, name, write=True)
        if body.visibility == "shared":
            visibility = "shared"
        elif body.visibility == "private":
            visibility = f"private:{tool.owner_user_id}"
        else:
            raise ValueError("visibility must be 'shared' or 'private'")
        updated = await _update_tool(reg, tool.name, visibility=visibility)
        if tool.mcp_endpoint_ref:
            await _update_endpoint(reg, tool.mcp_endpoint_ref, visibility=visibility)
        await rt._record(reg, who, updated, f"hermes tool visibility {name}",
                         {"visibility": visibility, "was": tool.visibility})
        return updated.as_dict()

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


@router.put("/api/tools/{name}/mcp")
async def set_tool_mcp(request: Request, name: str, body: ToolMcpUpdate):
    """Turn the app's MCP tools on/off for chats (applies from the next chat)."""

    async def _run(rt, reg, who):
        tool = await _tool_for(reg, who, name, write=True)
        if not tool.mcp_endpoint_ref:
            raise HTTPException(status_code=409, detail=f"{name!r} has no MCP endpoint")
        endpoint = await _update_endpoint(reg, tool.mcp_endpoint_ref, enabled=bool(body.enabled))
        if endpoint is None:
            raise KeyError(tool.mcp_endpoint_ref)
        await rt._record(reg, who, tool, f"hermes tool mcp {'on' if body.enabled else 'off'} {name}",
                         {"endpoint": tool.mcp_endpoint_ref, "enabled": bool(body.enabled)})
        return {"tool": tool.name, "mode": reg.mode, "endpoint": endpoint,
                "takes_effect": "next_chat"}

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


# -- box-facing writes via the root helpers (local apps) ---------------------


@router.put("/api/tools/{name}/secrets")
async def set_tool_secret(request: Request, name: str, body: ToolSecretUpdate):
    """Set or delete one app secret through the helper; the value is never
    stored in a row, logged or returned (only the names are)."""
    from hermes_cli.app_runtime import MCP_TOKEN_NAME

    async def _run(rt, reg, who):
        tool = await _tool_for(reg, who, name, write=True)
        slug = rt.require_local(tool)
        value = None if body.delete else body.value
        out = await asyncio.to_thread(
            lambda: rt.helper.set_secret(slug, reg.mode, body.name, value=value,
                                         delete=bool(body.delete))
        )
        names = sorted(n for n in (out.get("secret_names") or [])
                       if isinstance(n, str) and n != MCP_TOKEN_NAME)
        await _update_tool(reg, tool.name, secret_names=names)
        await rt._record(reg, who, tool, f"hermes tool secret {'unset' if body.delete else 'set'} {name}",
                         {"mode": reg.mode, "name": body.name, "deleted": bool(body.delete)})
        return {"tool": tool.name, "mode": reg.mode, "secret_names": names,
                "restart_needed": bool(out.get("restart_needed"))}

    return await _app_tool_call(request, body.mode, _run)


@router.put("/api/tools/{name}/egress")
async def set_tool_egress(request: Request, name: str, body: ToolEgressUpdate):
    """Replace a local app instance's internet allowlist (item 2.6's helper)."""

    async def _run(rt, reg, who):
        from hermes_cli.app_runtime import validate_egress_hosts

        tool = await _tool_for(reg, who, name, write=True)
        slug = rt.require_local(tool)
        hosts = validate_egress_hosts(body.hosts)
        out = await asyncio.to_thread(lambda: rt.helper.set_egress(slug, reg.mode, hosts))
        await rt._record(reg, who, tool, f"hermes tool egress {name}",
                         {"mode": reg.mode, "hosts": hosts})
        return {"tool": tool.name, "mode": reg.mode,
                "hosts": out.get("hosts", hosts) if isinstance(out, dict) else hosts}

    return await _app_tool_call(request, body.mode, _run)


# -- favicon + feedback ------------------------------------------------------


def _sniff_image(data: bytes) -> Optional[str]:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:4] == b"\x00\x00\x01\x00":
        return "image/x-icon"
    return None


def _local_favicon(rt: Any, tool: Any) -> bytes:
    repo = rt.repo_for(tool)
    for rel in ("app/icon.png", "public/favicon.png", "app/favicon.ico", "public/favicon.ico"):
        path = repo / rel
        if path.is_file() and not path.is_symlink():
            if path.stat().st_size > MAX_ICON_BYTES:
                raise ValueError(f"{rel} is larger than 256 KB")
            return path.read_bytes()
    raise ValueError("The app has no app/icon.png or favicon to snapshot")


def _external_favicon(public_url: str) -> bytes:
    parsed = urlparse(public_url)
    status, _headers, body = fetch_public(
        f"https://{parsed.netloc}/favicon.ico", max_bytes=MAX_ICON_BYTES,
    )
    if status != 200:
        raise ValueError(f"favicon fetch answered HTTP {status} (redirects are not followed)")
    return body


@router.post("/api/tools/{name}/favicon-refresh")
async def refresh_tool_favicon(request: Request, name: str, body: ToolModeRequest):
    """Snapshot the app's own icon once into the file store (icon_source=favicon)."""

    async def _run(rt, reg, who):
        from hermes_cli.file_registry import store_and_register

        tool = await _tool_for(reg, who, name, write=True)
        if tool.hosting == "local":
            data = await asyncio.to_thread(_local_favicon, rt, tool)
        elif tool.public_url:
            data = await asyncio.to_thread(_external_favicon, tool.public_url)
        else:
            raise ValueError(f"{name!r} has no source for a favicon")
        content_type = _sniff_image(data)
        if content_type not in FAVICON_CONTENT_TYPES:
            raise ValueError("The favicon must be PNG, WebP, JPEG or ICO (SVG is refused)")
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
               "image/x-icon": "ico"}[content_type]
        asset = await store_and_register(
            who, data, surface="agent_home", filename=f"{tool.name}-icon.{ext}",
            content_type=content_type,
        )
        if asset is None:
            raise RuntimeError("The file store is not configured, so the icon cannot be saved")
        updated = await _update_tool(reg, tool.name, icon_source="favicon", icon_asset_id=asset.id)
        await rt._record(reg, who, updated, f"hermes tool icon {name}",
                         {"icon_source": "favicon", "icon_asset_id": asset.id})
        return updated.as_dict()

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


@router.post("/api/tools/{name}/feedback")
async def tool_feedback(request: Request, name: str, body: ToolFeedback):
    """Typed feedback on an app lands on its FG-32 project as a ``feedback``
    directive (read by the next run; nothing is injected into a running one)."""

    async def _run(rt, reg, who):
        from hermes_cli import projects_db

        tool = await _tool_for(reg, who, name, write=True)
        text = (body.text if body.text is not None else body.body or "").strip()
        if not text:
            raise ValueError("feedback must not be empty")
        if len(text) > MAX_FEEDBACK_CHARS:
            raise ValueError(f"feedback is at most {MAX_FEEDBACK_CHARS} characters")
        if body.rating not in (None, "good", "bad"):
            raise ValueError("rating must be 'good' or 'bad'")
        if not tool.project_slug:
            raise HTTPException(status_code=409,
                                detail=f"{name!r} is not linked to a project yet")

        def _write() -> dict:
            with projects_db.connect_closing() as conn:
                project = projects_db.get_project(conn, tool.project_slug)
                if project is None:
                    raise HTTPException(status_code=409,
                                        detail=f"{name!r} is linked to a missing project")
                if not (who.is_owner or who.role == "admin"):
                    members = {m["user_id"]: m["role"]
                               for m in projects_db.get_project_members(conn, project.id)}
                    if members.get(who.user_id) not in ("lead", "member"):
                        raise PermissionError("Only members of the app's project can leave feedback")
                did = projects_db.add_project_directive(
                    conn, project_id=project.id, kind="feedback", body=text,
                    target_ref=f"tool:{tool.name}", rating=body.rating,
                    author_user_id=who.user_id,
                )
                return {"directive_id": did, "project": project.slug}

        out = await asyncio.to_thread(_write)
        return {"tool": tool.name, "mode": reg.mode, **out}

    return await _app_tool_call(request, _resolve_tool_mode(body.mode), _run)


# -- FG-33 local app runtime (moved from web_server.py, P8-1 item 1.4) -------


@router.post("/api/tools/{name}/build")
async def build_tool_app(request: Request, name: str, body: ToolModeRequest):
    """Build a local app's dev HEAD and (re)start its dev instance."""
    return await _app_tool_call(
        request, body.mode, lambda rt, reg, who: rt.build(reg, who, name)
    )


@router.post("/api/tools/{name}/start")
async def start_tool_app(request: Request, name: str, body: ToolModeRequest):
    return await _app_tool_call(
        request, body.mode, lambda rt, reg, who: rt.control(reg, who, name, "start")
    )


@router.post("/api/tools/{name}/stop")
async def stop_tool_app(request: Request, name: str, body: ToolModeRequest):
    return await _app_tool_call(
        request, body.mode, lambda rt, reg, who: rt.control(reg, who, name, "stop")
    )


@router.post("/api/tools/{name}/restart")
async def restart_tool_app(request: Request, name: str, body: ToolModeRequest):
    return await _app_tool_call(
        request, body.mode, lambda rt, reg, who: rt.control(reg, who, name, "restart")
    )


@router.get("/api/tools/{name}/logs")
async def tool_app_logs(request: Request, name: str, mode: Optional[str] = None, lines: int = 200):
    """A capped journal tail of a local app instance (its owner or an admin)."""
    return await _app_tool_call(
        request, mode, lambda rt, reg, who: rt.logs(reg, who, name, lines=lines)
    )


@router.get("/api/tools/{name}/runtime")
async def tool_app_runtime(request: Request, name: str, mode: Optional[str] = None):
    """Runtime state, browser path and recent deployments of an app (C2 read)."""
    return await _app_tool_call(
        request, mode, lambda rt, reg, who: rt.runtime(reg, who, name)
    )


@router.get("/api/tools/{name}/database")
async def tool_app_database(request: Request, name: str, mode: Optional[str] = None):
    """A local app's database binding for the mode (never a DSN)."""
    return await _app_tool_call(
        request, mode, lambda rt, reg, who: rt.database(reg, who, name)
    )


@router.delete("/api/tools/{name}")
async def delete_tool_app(request: Request, name: str, mode: Optional[str] = None, confirm: str = ""):
    """Delete a tool in a mode; a local app also loses its instance and database.

    Irreversible, so it needs ``?confirm=<name>`` (decision 9's one explicit
    confirmation before data loss).
    """
    return await _app_tool_call(
        request, mode, lambda rt, reg, who: rt.remove(reg, who, name, confirm=confirm)
    )


__all__ = ["MEMBER_MANAGED_ROUTES", "fetch_public", "health_for", "router"]
