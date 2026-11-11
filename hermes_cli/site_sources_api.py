"""HTTP surface for site-to-schema (plan 2026-11-10-001 §3.6).

Every route resolves the signed-in principal and the caller's access to the
site server-side (:func:`hermes_cli.site_sources.access_level`). Someone with
no access to a site gets 404 — the same answer as a site that does not exist —
so the list of sites is not discoverable. A read-only grantee asking for a
management action gets 403.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from hermes_cli import site_sources as ss
from hermes_cli.route_roles import ADMIN

router = APIRouter(prefix="/api/sites")

NOT_FOUND = "No such site."


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


def _fail(exc: ss.SiteError) -> HTTPException:
    return HTTPException(exc.status, str(exc))


async def _body(request: Request) -> Dict[str, Any]:
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be an object")
    body.pop("profile", None)
    return body


def _config() -> Dict[str, Any]:
    from hermes_cli.config import load_config_readonly

    return load_config_readonly() or {}


async def _site_for(request: Request, site_id: str, *, need: str = "read") -> Tuple[Any, Any, str]:
    """``(principal, site, access)`` or 404/403. ``need`` is read | admin."""
    principal = await _caller(request)
    try:
        site = await ss.get_site(site_id)
        if site is None or site.profile != ss.current_profile():
            raise HTTPException(404, NOT_FOUND)
        grant = None
        if not ss._is_profile_admin(principal) and site.owner_user_id != principal.user_id:
            grant = await ss.grant_for(site.id, principal.user_id)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    access = ss.access_level(site, principal, grant)
    if access is None:
        raise HTTPException(404, NOT_FOUND)
    if need == "admin" and access != "admin":
        raise HTTPException(403, "You can read this site but not manage it.")
    return principal, site, access


# -- settings ----------------------------------------------------------------


@router.get("/settings")
async def get_settings(request: Request):
    principal = await _caller(request)
    config = _config()
    return {
        "create_roles": ss.create_roles(config),
        "can_create": ss.can_create(principal, config),
    }


@router.put("/settings", dependencies=ADMIN)
async def put_settings(request: Request):
    from hermes_cli.config import load_config, save_config

    body = await _body(request)
    if "create_roles" not in body:
        raise HTTPException(400, "Give create_roles.")
    config = load_config()
    try:
        roles = ss.set_create_roles(config, body["create_roles"])
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    save_config(config)
    principal = await _caller(request)
    return {"create_roles": roles, "can_create": ss.can_create(principal, config)}


# -- sites -------------------------------------------------------------------


@router.get("")
async def list_sites(request: Request):
    principal = await _caller(request)
    try:
        sites = await ss.list_sites(profile=ss.current_profile())
        grants = {} if ss._is_profile_admin(principal) else await ss.grants_of(principal.user_id)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    out = []
    for site in sites:
        access = ss.access_level(site, principal, grants.get(site.id))
        if access is not None:
            out.append(site.view(access))
    return {"sites": out, "can_create": ss.can_create(principal, _config())}


@router.post("")
async def create_site(request: Request):
    principal = await _caller(request)
    if not ss.can_create(principal, _config()):
        raise HTTPException(403, "Your role can't add sites. Ask the owner or an admin.")
    body = await _body(request)
    try:
        site = await ss.create_site(principal, body)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"site": site.view("admin")}


@router.get("/{site_id}")
async def get_site(site_id: str, request: Request):
    _principal, site, access = await _site_for(request, site_id)
    try:
        current = await ss.approved_design(site)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    view = site.view(access)
    view["design_version"] = current[0] if current else None
    return {"site": view}


@router.patch("/{site_id}")
async def patch_site(site_id: str, request: Request):
    principal, site, access = await _site_for(request, site_id, need="admin")
    body = await _body(request)
    if body.get("status") not in (None, "active", "paused"):
        raise HTTPException(400, "status can only be set to active or paused here")
    try:
        site = await ss.update_site(site, body, principal=principal)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"site": site.view(access)}


@router.delete("/{site_id}")
async def pause_site(site_id: str, request: Request):
    """Pause, never drop: the schema and its history stay (D8)."""
    _principal, site, access = await _site_for(request, site_id, need="admin")
    try:
        await ss.set_status(site, "paused")
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"site": site.view(access)}


# -- designs -----------------------------------------------------------------


@router.get("/{site_id}/designs")
async def list_designs(site_id: str, request: Request):
    _principal, site, access = await _site_for(request, site_id)
    try:
        designs = await ss.list_designs(site)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    if access != "admin":
        for item in designs:
            item.pop("recipe", None)
    return {"designs": designs}


@router.post("/{site_id}/designs/{version}/approve")
async def approve_design(site_id: str, version: int, request: Request):
    principal, site, _access = await _site_for(request, site_id, need="admin")
    try:
        result = await ss.apply_design(site, version, approved_by=principal.user_id)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return result


# -- grants ------------------------------------------------------------------


@router.get("/{site_id}/grants")
async def list_grants(site_id: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id, need="admin")
    try:
        grants = await ss.list_grants(site.id)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"owner_user_id": site.owner_user_id, "grants": grants}


@router.post("/{site_id}/grants")
async def put_grant(site_id: str, request: Request):
    principal, site, _access = await _site_for(request, site_id, need="admin")
    body = await _body(request)
    user_id = str(body.get("user_id") or "").strip()
    if user_id == site.owner_user_id:
        raise HTTPException(400, "The site's owner already has full access.")
    try:
        grant = await ss.put_grant(site.id, user_id, str(body.get("grant") or "read"), by=principal.user_id)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"grant": grant}


@router.delete("/{site_id}/grants")
async def revoke_grant(site_id: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id, need="admin")
    user_id = request.query_params.get("user_id") or ""
    if not user_id:
        with_body = await _body(request) if await request.body() else {}
        user_id = str(with_body.get("user_id") or "")
    if not user_id.strip():
        raise HTTPException(400, "Give user_id.")
    try:
        revoked = await ss.revoke_grant(site.id, user_id.strip())
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"revoked": revoked}


# -- refresh + runs ----------------------------------------------------------


@router.post("/{site_id}/refresh", status_code=202)
async def refresh(site_id: str, request: Request):
    """Refresh now: starts in the background and returns the run."""
    _principal, site, _access = await _site_for(request, site_id, need="admin")
    body = await _body(request) if await request.body() else {}
    entities = body.get("entities")
    if entities is not None and (
        not isinstance(entities, list) or not all(isinstance(e, str) for e in entities)
    ):
        raise HTTPException(400, "entities must be a list of names")
    try:
        run = await ss.start_refresh(
            site, trigger="manual", entities=entities or None, mode=body.get("mode")
        )
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    return {"run": run}


@router.get("/{site_id}/runs")
async def list_runs(site_id: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id)
    try:
        return {"runs": await ss.list_runs(site)}
    except ss.SiteError as exc:
        raise _fail(exc) from exc


# -- data --------------------------------------------------------------------


def _flag(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _int(value: Optional[str], default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except ValueError:
        raise HTTPException(400, "page and page_size must be numbers") from None


@router.get("/{site_id}/tables")
async def list_tables(site_id: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id)
    try:
        return {"tables": await ss.table_summaries(site)}
    except ss.SiteError as exc:
        raise _fail(exc) from exc


@router.get("/{site_id}/tables/{entity}")
async def table_rows(site_id: str, entity: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id)
    qp = request.query_params
    try:
        return await ss.table_rows(
            site,
            entity,
            q=qp.get("q"),
            page=_int(qp.get("page"), 1),
            page_size=_int(qp.get("page_size"), ss.PAGE_SIZE),
            include_removed=_flag(qp.get("include_removed")),
        )
    except ss.SiteError as exc:
        raise _fail(exc) from exc


@router.get("/{site_id}/tables/{entity}/export")
async def export_table(site_id: str, entity: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id)
    fmt = (request.query_params.get("format") or "csv").lower()
    if fmt not in ("csv", "xlsx"):
        raise HTTPException(400, "format must be csv or xlsx")
    try:
        columns, rows = await ss.export_rows(
            site, entity, include_removed=_flag(request.query_params.get("include_removed"))
        )
        if fmt == "csv":
            data, media = ss.to_csv(columns, rows), "text/csv; charset=utf-8"
        else:
            data = ss.to_xlsx(columns, rows, title=entity)
            media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    filename = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{site.slug}-{entity}.{fmt}")
    return Response(
        content=data,
        media_type=media,
        headers={
            "content-disposition": f'attachment; filename="{filename}"',
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
        },
    )


@router.get("/{site_id}/history/{entity}/{key:path}")
async def row_history(site_id: str, entity: str, key: str, request: Request):
    _principal, site, _access = await _site_for(request, site_id)
    try:
        return await ss.history(site, entity, key)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
