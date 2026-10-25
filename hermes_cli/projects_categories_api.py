"""Project categories — the user-managed columns of the ``/projects`` board.

Any signed-in user may manage categories: reads resolve the principal the
way project reads do, writes resolve the acting principal (never ``?as=``).
Validation lives in :mod:`hermes_cli.projects_db` so the CLI cannot bypass
it; this router only maps its errors (bad input 422, duplicate name 409,
unknown id 404). Mutations are covered by the projects idempotency
middleware (``Idempotency-Key``).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import projects_api, projects_db

router = APIRouter(prefix="/api/registry/project-categories")

_PATCH_FIELDS = ("name", "color", "position")


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    return body


async def _run(fn, *args, **kwargs):
    try:
        return await asyncio.to_thread(fn, *args, **kwargs)
    except projects_db.CategoryNameTaken as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _list_sync() -> dict:
    with projects_db.connect_closing() as conn:
        return {"items": projects_db.list_categories(conn)}


def _create_sync(body: dict, created_by: str) -> dict:
    with projects_db.connect_closing() as conn:
        return projects_db.create_category(
            conn, name=body.get("name"), color=body.get("color"), created_by=created_by
        )


def _update_sync(category_id: str, fields: dict) -> dict:
    with projects_db.connect_closing() as conn:
        category = projects_db.update_category(conn, category_id, **fields)
    if category is None:
        raise HTTPException(status_code=404, detail="category not found")
    return category


def _delete_sync(category_id: str) -> dict:
    with projects_db.connect_closing() as conn:
        reset = projects_db.delete_category(conn, category_id)
    if reset is None:
        raise HTTPException(status_code=404, detail="category not found")
    return {"deleted": category_id, "uncategorized": reset}


@router.get("")
async def list_categories_route(request: Request) -> dict[str, Any]:
    await projects_api._principal_read(request)
    return await asyncio.to_thread(_list_sync)


@router.post("")
async def create_category_route(request: Request) -> dict[str, Any]:
    principal = await projects_api._principal_write(request)
    body = await _json_object(request)
    return await _run(_create_sync, body, principal.user_id)


@router.patch("/{category_id}")
async def patch_category_route(category_id: str, request: Request) -> dict[str, Any]:
    await projects_api._principal_write(request)
    body = await _json_object(request)
    fields = {k: body[k] for k in _PATCH_FIELDS if k in body}
    return await _run(_update_sync, category_id, fields)


@router.delete("/{category_id}")
async def delete_category_route(category_id: str, request: Request) -> dict[str, Any]:
    await projects_api._principal_write(request)
    return await _run(_delete_sync, category_id)
