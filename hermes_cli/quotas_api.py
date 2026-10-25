"""HTTP routes for FG-33 app quotas (P8-1 item 1.6). Owner or admin.

Decision 8: limits live in the root-owned ``/etc/aquarium/app-quotas.yaml``;
the owner or an admin adjusts them per member here, and sets the box-wide app
storage location (decision 21) under ``/api/quotas/box``.

P8-2 2.10 adds the Settings panels' backends: ``/api/quotas/defaults``
(App limits: the per-role defaults, written to a root file by the app
helper's ``configure`` verb), ``/api/quotas/storage`` (App storage: the
helper moves its base path and APPS_BASE, then the box override follows)
and ``/api/quotas/github`` (GitHub token, decision 14: stored in the
credential store; only "set"/last 4 ever leave the server). Writes go through
:class:`hermes_cli.app_quota.QuotaStore`, which refuses self-escalation (an
admin cannot raise their own, another admin's or the owner's limits) and
records a C5 change for every write. Mounted by ``web_server.py`` (item 1.4).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import app_quota, app_source_publish
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
    _require_editor(actor)
    _sync_storage_to_helper(body.values)
    return await _write(actor, app_quota.BOX, body.values, target_role=None)


_STORAGE_HELPER_KEYS = {"storage.base_path": "storage_base", "storage.min_free_mb": "min_free_mb"}


def _helper_configure(spec: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return app_quota.configure_helper(spec)
    except app_quota.QuotaError as exc:
        raise HTTPException(409, str(exc)) from exc


def _require_editor(actor) -> None:
    denied = app_quota._may_edit(actor, app_quota.BOX, None)
    if denied:
        raise HTTPException(403, denied)


def _sync_storage_to_helper(values: Dict[str, Any]) -> None:
    """Box storage writes move the root helper (and APPS_BASE) first, so the
    override never names a location the helper does not use."""
    spec = {}
    for key, field in _STORAGE_HELPER_KEYS.items():
        if values.get(key) is not None:
            try:
                spec[field] = app_quota.validate_override(key, values[key], scope="box",
                                                          actor_is_owner=True)
            except app_quota.QuotaError as exc:
                raise HTTPException(400, str(exc)) from exc
    if spec:
        _helper_configure(spec)


def _limits_view(actor, policy: app_quota.QuotaPolicy) -> Dict[str, Any]:
    return {
        "policy": _policy_view(policy),
        "tiers": app_quota.tier_limits(policy),
        "defaults": app_quota.tier_limits(app_quota.QuotaPolicy(data=app_quota.DEFAULT_POLICY)),
        "editable": {t: app_quota.may_edit_tier(actor, t) is None for t in app_quota.LIMIT_TIERS},
    }


class LimitsUpdate(BaseModel):
    #: tier -> {"per_app": {...}, "per_member": {...}}; ``null`` resets a tier
    limits: Dict[str, Any]


@router.get("/defaults", dependencies=ADMIN)
async def get_default_limits(request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    return _limits_view(actor, app_quota.load_policy())


@router.put("/defaults", dependencies=ADMIN)
async def put_default_limits(body: LimitsUpdate, request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    for tier in body.limits:
        denied = app_quota.may_edit_tier(actor, tier) if tier in app_quota.LIMIT_TIERS else None
        if denied:
            raise HTTPException(403, denied)
    try:
        clean = app_quota.validate_tier_limits(body.limits)
    except app_quota.QuotaError as exc:
        raise HTTPException(400, str(exc)) from exc
    before = app_quota.tier_limits()
    _helper_configure({"limits": clean})
    policy = app_quota.load_policy()
    change_ref = await app_quota.QuotaStore(_store()).record_settings_change(
        actor, action="quota.defaults.set", target_ref="quota:defaults", path="/quotas/defaults",
        before={t: before[t] for t in clean}, after=clean,
    )
    return {**_limits_view(actor, policy), "change_ref": change_ref}


async def _storage_view(overrides: Dict[str, Any]) -> Dict[str, Any]:
    policy = app_quota.load_policy()
    base = app_quota.storage_base_path(policy, overrides)
    free = app_quota._free_mb(base)
    return {
        "base_path": str(base),
        "default_base_path": app_quota.DEFAULT_STORAGE_BASE,
        "min_free_mb": app_quota.min_free_mb(policy, overrides),
        "free_mb": None if free is None else int(free),
    }


class StorageUpdate(BaseModel):
    base_path: Optional[str] = None
    min_free_mb: Optional[int] = None


@router.get("/storage", dependencies=ADMIN)
async def get_storage(request: Request) -> Dict[str, Any]:
    await _actor(request)
    return await _storage_view(await app_quota.QuotaStore(_store()).overrides_for(app_quota.BOX))


@router.put("/storage", dependencies=ADMIN)
async def put_storage(body: StorageUpdate, request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    _require_editor(actor)
    values: Dict[str, Any] = {}
    if body.base_path is not None:
        values["storage.base_path"] = body.base_path
    if body.min_free_mb is not None:
        values["storage.min_free_mb"] = body.min_free_mb
    if not values:
        raise HTTPException(400, "Nothing to change.")
    _sync_storage_to_helper(values)
    result = await _write(actor, app_quota.BOX, values, target_role=None)
    return {**await _storage_view(result["overrides"]), "change_ref": result["change_ref"]}


async def _github_view(overrides: Dict[str, Any]) -> Dict[str, Any]:
    settings = app_source_publish.settings_from_overrides(overrides)
    try:
        token = await app_source_publish.resolve_token(settings)
    except Exception:  # noqa: BLE001 - the panel still renders; status shows unset
        token = None
    return {
        "owner": settings.owner,
        "use_box_git": settings.use_box_git,
        "token": app_source_publish.token_status(token),
        "mode": "token" if token else ("box-git" if settings.use_box_git else "local-only"),
    }


class GithubUpdate(BaseModel):
    owner: Optional[str] = None
    use_box_git: Optional[bool] = None
    #: write-only; never echoed
    token: Optional[str] = None


@router.get("/github", dependencies=ADMIN)
async def get_github(request: Request) -> Dict[str, Any]:
    await _actor(request)
    return await _github_view(await app_quota.QuotaStore(_store()).overrides_for(app_quota.BOX))


@router.put("/github", dependencies=ADMIN)
async def put_github(body: GithubUpdate, request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    _require_editor(actor)
    values: Dict[str, Any] = {}
    if body.owner is not None:
        values["github.owner"] = body.owner.strip() or None
    if body.use_box_git is not None:
        values["github.use_box_git"] = body.use_box_git
    if body.token:
        try:
            token = app_source_publish.validate_token(body.token)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        from hermes_cli.credential_store import CredentialError, default_credential_store

        try:
            await default_credential_store().put(
                actor, provider=app_source_publish.PROVIDER,
                name=app_source_publish.CREDENTIAL_NAME,
                kind=app_source_publish.CREDENTIAL_KIND, payload={"token": token},
            )
        except CredentialError as exc:
            raise HTTPException(400, str(exc)) from exc
        values["github.credential"] = {"owner_user_id": actor.user_id,
                                       "name": app_source_publish.CREDENTIAL_NAME}
    if not values:
        raise HTTPException(400, "Nothing to change.")
    result = await _write(actor, app_quota.BOX, values, target_role=None)
    return {**await _github_view(result["overrides"]), "change_ref": result["change_ref"]}


@router.delete("/github", dependencies=ADMIN)
async def delete_github_token(request: Request) -> Dict[str, Any]:
    actor = await _actor(request)
    _require_editor(actor)
    from hermes_cli.credential_store import default_credential_store

    try:
        await default_credential_store().delete(
            actor, app_source_publish.PROVIDER, app_source_publish.CREDENTIAL_NAME)
    except Exception:  # noqa: BLE001 - dropping the reference is what disables publishing
        pass
    result = await _write(actor, app_quota.BOX, {"github.credential": None}, target_role=None)
    return {**await _github_view(result["overrides"]), "change_ref": result["change_ref"]}


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
