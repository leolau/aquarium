"""HTTP surface for the data dictionary (plan 2026-11-14-001, Phase 2).

Every route resolves the signed-in principal and their access to the source
server-side (:func:`hermes_cli.data_dictionary.resolve_access`). No access
gives 404, the same as a missing source; too little gives 403.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import data_dictionary as dd
from hermes_cli import site_sources as ss

router = APIRouter(prefix="/api/data")

NOT_FOUND = "No such data source."
TOO_LOW = {
    "propose": "You can read this dictionary but not suggest changes.",
    "manage": "Only the source's owner or an admin can do this.",
}


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
    return body


async def _source_for(request: Request, source_id: str, need: str = "read") -> Tuple[Any, Any, str]:
    principal = await _caller(request)
    try:
        source = await dd.get_source(source_id)
        if source is None or source.profile != ss.current_profile():
            raise HTTPException(404, NOT_FOUND)
        access = await dd.resolve_access(source, principal)
    except ss.SiteError as exc:
        raise _fail(exc) from exc
    if access is None:
        raise HTTPException(404, NOT_FOUND)
    if not dd.allows(access, need):
        raise HTTPException(403, TOO_LOW[need])
    return principal, source, access


async def _run(coro):
    try:
        return await coro
    except ss.SiteError as exc:
        raise _fail(exc) from exc


@router.get("/sources")
async def list_sources(request: Request):
    principal = await _caller(request)
    return {"sources": await _run(dd.list_sources(principal, ss.current_profile()))}


@router.get("/sources/{source_id}")
async def get_source(source_id: str, request: Request):
    _p, source, access = await _source_for(request, source_id)
    found = await _run(dd.dictionary(source, draft=dd.allows(access, "propose")))
    return {"source": source.view(access), **found}


@router.get("/sources/{source_id}/versions")
async def list_versions(source_id: str, request: Request):
    _p, source, _a = await _source_for(request, source_id)
    return {"versions": await _run(dd.list_versions(source))}


@router.get("/sources/{source_id}/versions/{version}")
async def get_version(source_id: str, version: int, request: Request):
    _p, source, access = await _source_for(request, source_id)
    found = await _run(dd.get_version(source, version))
    if found["status"] in ("draft", "rejected") and not dd.allows(access, "propose"):
        raise HTTPException(404, "No such version.")
    return found


@router.post("/sources/{source_id}/draft")
async def propose(source_id: str, request: Request):
    principal, source, _a = await _source_for(request, source_id, "propose")
    body = await _body(request)
    origin = str(body.get("origin") or "edit")
    if origin in ("design", "restore"):
        raise HTTPException(400, "origin must be edit, chat, feedback, study or schema_check")
    return await _run(dd.propose(
        source,
        tables=body.get("tables"),
        remove=body.get("remove") or [],
        glossary=body.get("glossary"),
        origin=origin,
        note=str(body.get("note") or ""),
        by=principal.user_id,
    ))


@router.post("/sources/{source_id}/draft/approve")
async def approve(source_id: str, request: Request):
    principal, source, _a = await _source_for(request, source_id, "manage")
    body = await _body(request)
    if not isinstance(body.get("version"), int):
        raise HTTPException(400, "Give the draft's version.")
    reject = body.get("reject") or []
    if not isinstance(reject, list):
        raise HTTPException(400, "reject must be a list of table names")
    return await _run(dd.approve(source, body["version"], reject=reject, by=principal.user_id))


@router.delete("/sources/{source_id}/draft")
async def discard(source_id: str, request: Request):
    principal, source, _a = await _source_for(request, source_id, "manage")
    return {"discarded": await _run(dd.discard(source, by=principal.user_id))}


@router.post("/sources/{source_id}/versions/{version}/restore")
async def restore(source_id: str, version: int, request: Request):
    principal, source, _a = await _source_for(request, source_id, "manage")
    return await _run(dd.restore(source, version, by=principal.user_id))


@router.get("/sources/{source_id}/grants")
async def list_grants(source_id: str, request: Request):
    _p, source, _a = await _source_for(request, source_id, "manage")
    return {"owner_user_id": source.owner_user_id, "grants": await _run(dd.list_grants(source.id))}


@router.post("/sources/{source_id}/grants")
async def put_grant(source_id: str, request: Request):
    principal, source, _a = await _source_for(request, source_id, "manage")
    body = await _body(request)
    user_id = str(body.get("user_id") or "").strip()
    if source.owner_user_id and user_id == source.owner_user_id:
        raise HTTPException(400, "The source's owner already has full access.")
    grant = await _run(dd.put_grant(source.id, user_id, str(body.get("grant") or "read"), by=principal.user_id))
    return {"grant": grant}


@router.delete("/sources/{source_id}/grants")
async def revoke_grant(source_id: str, request: Request):
    _p, source, _a = await _source_for(request, source_id, "manage")
    user_id = (request.query_params.get("user_id") or "").strip()
    if not user_id:
        raise HTTPException(400, "Give user_id.")
    return {"revoked": await _run(dd.revoke_grant(source.id, user_id))}
