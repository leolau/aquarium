"""HTTP routes for FG-33 app quotas (P8-1 item 1.6). Owner or admin.

Decision 8: limits live in the root-owned ``/etc/aquarium/app-quotas.yaml``;
the owner or an admin adjusts them per member here, and sets the box-wide app
storage location (decision 21) under ``/api/quotas/box``. Writes go through
:class:`hermes_cli.app_quota.QuotaStore`, which refuses self-escalation (an
admin cannot raise their own, another admin's or the owner's limits) and
records a C5 change for every write. Mounted by ``web_server.py`` (item 1.4).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import app_quota
from hermes_cli.route_roles import ADMIN

router = APIRouter(prefix="/api/quotas")


class QuotaUpdate(BaseModel):
    #: dotted key -> value; ``null`` removes that override
    values: Dict[str, Any]


def _store():
    from hermes_cli.web_server import _comms_app_store

    return _comms_app_store()


async def _actor(request: Request):
    from hermes_cli import web_server as ws

    try:
        return await ws._comms_resolve_principal(request, allow_as=False)
    except ws._CommsNotConfigured as exc:
        raise HTTPException(503, "Quotas need the app datastore.") from exc


async def _target(user_id: str):
    from hermes_cli.access import PrincipalStore

    principal = await PrincipalStore(_store()).get(user_id)
    if principal is None:
        raise HTTPException(404, f"No user {user_id!r}.")
    return principal


def _policy_view(policy: app_quota.QuotaPolicy) -> Dict[str, Any]:
    return {"source": policy.source, "warnings": list(policy.warnings)}


@router.get("/box", dependencies=ADMIN)
async def get_box_quotas(request: Request) -> Dict[str, Any]:
    await _actor(request)
    policy = app_quota.load_policy()
    overrides = await app_quota.QuotaStore(_store()).overrides_for(app_quota.BOX)
    return {
        "policy": _policy_view(policy),
        "box": policy.section("box"),
        "storage": {
            "base_path": str(app_quota.storage_base_path(policy, overrides)),
            "min_free_mb": app_quota.min_free_mb(policy, overrides),
        },
        "overrides": overrides,
    }


@router.put("/box", dependencies=ADMIN)
async def put_box_quotas(body: QuotaUpdate, request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    return await _write(actor, app_quota.BOX, body.values, target_role=None)


@router.get("/{user_id}", dependencies=ADMIN)
async def get_user_quotas(user_id: str, request: Request) -> Dict[str, Any]:
    await _actor(request)
    target = await _target(user_id)
    policy = app_quota.load_policy()
    overrides = await app_quota.QuotaStore(_store()).overrides_for(user_id)
    limits = app_quota.effective_limits(target.role, policy=policy, overrides=overrides)
    return {
        "user_id": user_id,
        "policy": _policy_view(policy),
        "limits": limits.as_dict(),
        "overrides": overrides,
    }


@router.put("/{user_id}", dependencies=ADMIN)
async def put_user_quotas(user_id: str, body: QuotaUpdate, request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    if user_id == app_quota.BOX:
        raise HTTPException(400, "Use /api/quotas/box for box-wide settings.")
    target = await _target(user_id)
    return await _write(actor, user_id, body.values, target_role=target.role)


async def _write(actor, user_id: str, values: Dict[str, Any], *, target_role) -> Dict[str, Any]:
    try:
        return await app_quota.QuotaStore(_store()).set_overrides(
            actor, user_id, values, target_role=target_role
        )
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except app_quota.QuotaError as exc:
        raise HTTPException(400, str(exc)) from exc
