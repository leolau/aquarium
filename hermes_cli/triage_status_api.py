"""``GET /api/triage/status`` — the signed-in person's triage setup (read-only).

Signed-in policy: every person sees only their own mailboxes, numbers and
calendars (see :mod:`hermes_cli.triage_status`). The route takes no
``profile`` parameter of its own, so ``?profile=`` is handled wholly by
``require_profile_scope``: it refuses a profile the caller isn't enrolled in
and otherwise holds that profile's scope (``HERMES_HOME``, credential store,
config) for the handler, with the caller resolved in that profile.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from hermes_cli import triage_status
from hermes_cli.profile_route_scope import ProfileScope, require_profile_scope
from hermes_cli.route_roles import ADMIN

router = APIRouter(prefix="/api/triage", tags=["triage"])


async def _caller(request: Request):
    """The signed-in person; no multi-user datastore = the single-user owner."""
    from hermes_cli.wa_bridge_api import _OPERATOR
    from hermes_cli.web_server import _CommsNotConfigured, _comms_resolve_principal

    try:
        return await _comms_resolve_principal(request, allow_as=False)
    except _CommsNotConfigured:
        return _OPERATOR


async def _principal(request: Request, target: Optional[ProfileScope]):
    if isinstance(target, ProfileScope) and target.principal is not None:
        return target.principal
    return await _caller(request)


@router.get("/status")
async def get_triage_status(
    request: Request,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    principal = await _principal(request, target)
    result = await triage_status.triage_status(
        principal, install_owner=not isinstance(target, ProfileScope)
    )
    result["can_edit"] = triage_status.can_edit(principal)
    if isinstance(target, ProfileScope):
        name = target.entry.name
    else:
        # No scope switch: the hint (if any) names the acting profile.
        name = (request.query_params.get("profile") or "").strip() or None
    return {"profile": name, **result}


# Triage skill files are box-wide (the pipelines read them from
# ``triage.skills_dirs``): any signed-in person may read them and their
# history; only an owner or admin (in the addressed profile) may change them.


class SkillFileWrite(BaseModel):
    kind: str
    path: str
    content: str


def _file(kind: str, path: str):
    try:
        return triage_status.triage_file(kind, path)
    except triage_status.SkillFileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc


@router.get("/skill-file")
async def get_triage_skill_file(
    request: Request,
    kind: str,
    path: str,
    target: Optional[ProfileScope] = Depends(require_profile_scope),
):
    principal = await _principal(request, target)
    file = _file(kind, path)
    try:
        content = file.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"cannot read {file.name}") from exc
    return {
        "kind": kind,
        "name": file.name,
        "path": str(file),
        "content": content,
        "can_edit": triage_status.can_edit(principal),
    }


@router.get("/skill-file/history")
async def get_triage_skill_file_history(kind: str, path: str):
    file = _file(kind, path)
    return {"kind": kind, "path": str(file), "versions": triage_status.file_history(file)}


@router.put("/skill-file", dependencies=ADMIN)
async def put_triage_skill_file(body: SkillFileWrite, request: Request):
    from hermes_cli.skills_versions_api import acting_author

    file = _file(body.kind, body.path)
    author = await acting_author(request)
    try:
        version = triage_status.write_triage_file(file, body.content, author=author)
    except triage_status.SkillFileError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail) from exc
    return {"ok": True, "path": str(file), "version": {k: v for k, v in version.items() if k != "content"}}

