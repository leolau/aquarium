"""HTTP routes for the FG-33 local-app lifecycle (P8-2 item 2.4).

``POST /api/tools/{name}/{archive,restore,purge}`` with an optional JSON body
``{"mode": "dev"|"prod", "confirm": "<name>"}`` (mode defaults to dev, like
the other app routes). Decision 9: the app's owner or an admin acts without a
C6 approval; who may act is checked per app in ``AppRuntime.resolve`` (C2:
another member's private app is a 404). ``purge`` is irreversible, so it needs
``confirm`` equal to the tool name, and the agent-home button carries
``data-appmcp-deny``. Mounted by ``hermes_cli/web_server.py`` (item 2.2) with
``app.include_router(app_lifecycle_api.router)``.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/tools")


class LifecycleRequest(BaseModel):
    mode: Optional[str] = None
    confirm: Optional[str] = None


def _mode(mode: Optional[str]) -> str:
    return mode if mode in ("dev", "prod") else "dev"


def _registry(mode: str):
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    return ToolRegistry(get_store("supabase-app", "prod" if mode == "prod" else "dev"))


async def _lifecycle_call(request: Request, body: Optional[LifecycleRequest], fn) -> Any:
    """Run one lifecycle verb as the signed-in caller and map its errors."""
    from hermes_cli import app_watch
    from hermes_cli import web_server as ws
    from hermes_cli.app_runtime import AdmissionRefused, AppRuntime, HelperError

    mode = _mode(body.mode if body else None)
    try:
        operator = await ws._comms_resolve_principal(request)
        registry = _registry(mode)
        await registry.initialize()
        return await fn(app_watch, AppRuntime(), registry, operator, mode)
    except HTTPException:
        raise
    except KeyError:
        raise HTTPException(status_code=404, detail="Tool not found")
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except (AdmissionRefused, app_watch.LifecycleConflict) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except HelperError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/{name}/archive")
async def archive_tool_app(request: Request, name: str,
                           body: Optional[LifecycleRequest] = None):
    """Stop, unroute and suspend a local app; nothing is deleted (restore undoes it)."""
    return await _lifecycle_call(
        request, body, lambda aw, rt, reg, who, mode: aw.archive_app(rt, reg, who, name)
    )


@router.post("/{name}/restore")
async def restore_tool_app(request: Request, name: str,
                           body: Optional[LifecycleRequest] = None):
    """Bring an archived or idle-stopped local app back."""
    return await _lifecycle_call(
        request, body, lambda aw, rt, reg, who, mode: aw.restore_app(rt, reg, who, name)
    )


@router.post("/{name}/purge")
async def purge_tool_app(request: Request, name: str,
                         body: Optional[LifecycleRequest] = None):
    """Delete an archived app's instance and database for good; needs ``confirm: <name>``."""
    confirm = (body.confirm if body else None) or ""

    async def _purge(aw, rt, reg, who, mode):
        other = _registry("prod" if mode == "dev" else "dev")
        await other.initialize()
        return await aw.purge_app(rt, reg, who, name, confirm=confirm, other_registry=other)

    return await _lifecycle_call(request, body, _purge)


__all__ = ["LifecycleRequest", "router"]
