"""Skill version history routes (``/api/skills/versions``).

Admin-only, like every other skill route. Each handler runs the store work
in a worker thread inside the web server's ``_profile_scope`` so the
requested profile's ``skills/.versions`` store is used. Payloads never carry
filesystem paths. The store itself lives in :mod:`tools.skill_versions`.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli.route_roles import ADMIN
from tools import skill_versions

router = APIRouter(prefix="/api/skills/versions")


class DraftRequest(BaseModel):
    name: str
    content: str
    message: Optional[str] = None
    profile: Optional[str] = None
    session_id: Optional[str] = None
    base: Optional[str] = None


class ActivateRequest(BaseModel):
    name: str
    id: str
    trial: bool = False
    profile: Optional[str] = None


async def acting_author(request: Request) -> str:
    """``user:<principal id>`` for the caller; never fails a write over it."""
    from hermes_cli import web_server as ws

    try:
        principal = await asyncio.wait_for(ws._comms_resolve_principal(request), timeout=5)
        user_id = str(getattr(principal, "user_id", "") or "")
    except Exception:
        user_id = ws._comms_session_subject(request) or ""
    user_id = "".join(ch for ch in user_id if ord(ch) >= 32)[:200]
    return f"user:{user_id or 'local'}"


async def _in_profile(profile: Optional[str], fn: Callable[[], Any]) -> Any:
    from hermes_cli.web_server import _profile_scope

    def _run() -> Any:
        with _profile_scope(profile):
            return fn()

    try:
        return await asyncio.to_thread(_run)
    except skill_versions.SkillVersionNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except skill_versions.SkillVersionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _require_skill(name: str) -> None:
    """404 unless ``name`` has a live folder or a stored history."""
    skill_versions.ensure_baseline(name)
    if not skill_versions.list_versions(name):
        raise skill_versions.SkillVersionNotFound(f"Skill '{name}' not found.")


@router.get("", dependencies=ADMIN)
async def list_skill_versions(name: str, profile: Optional[str] = None) -> dict:
    def _work() -> dict:
        skill_versions.validate_name(name)
        _require_skill(name)
        return skill_versions.index_payload(name)

    return await _in_profile(profile, _work)


@router.get("/detail", dependencies=ADMIN)
async def get_skill_version(name: str, id: str, profile: Optional[str] = None) -> dict:
    return await _in_profile(profile, lambda: skill_versions.get_version(name, id))


@router.get("/diff", dependencies=ADMIN)
async def diff_skill_versions(name: str, a: str, b: str, profile: Optional[str] = None) -> dict:
    def _work() -> dict:
        return {"a": a, "b": b, "diff": skill_versions.diff(name, a, b)}

    return await _in_profile(profile, _work)


@router.post("/draft", dependencies=ADMIN)
async def create_skill_draft(
    body: DraftRequest, request: Request, profile: Optional[str] = None
) -> dict:
    if body.session_id:
        from hermes_cli.skills_improve_api import improve_draft_author

        try:
            skill_versions.validate_name(body.name)
        except skill_versions.SkillVersionError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        author = await improve_draft_author(
            request, body.session_id, body.name, body.profile or profile
        )
    else:
        author = await acting_author(request)

    def _work() -> dict:
        skill_versions.validate_name(body.name)
        _require_skill(body.name)
        return skill_versions.create_draft(
            body.name,
            body.content,
            author=author,
            message=body.message or "",
            source="improve" if body.session_id else "edit",
            base=body.base,
        )

    return await _in_profile(body.profile or profile, _work)


@router.post("/activate", dependencies=ADMIN)
async def activate_skill_version(
    body: ActivateRequest, request: Request, profile: Optional[str] = None
) -> dict:
    author = await acting_author(request)
    return await _in_profile(
        body.profile or profile,
        lambda: skill_versions.activate(body.name, body.id, author=author, trial=body.trial),
    )


def record_dashboard_baseline(name: str) -> None:
    """Before a dashboard edit: make sure the pre-edit state is stored."""
    try:
        skill_versions.validate_name(name)
    except skill_versions.SkillVersionError:
        return
    skill_versions.safe_ensure_baseline(name)


def record_dashboard_write(name: str, *, author: str, source: str) -> None:
    """After a successful dashboard create/edit: store the new version."""
    try:
        skill_versions.validate_name(name)
    except skill_versions.SkillVersionError:
        return
    message = "Created in the dashboard" if source == "create" else "Edited in the dashboard"
    skill_versions.safe_snapshot(name, author=author, message=message, source=source)
