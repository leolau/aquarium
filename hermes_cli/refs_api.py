"""``GET /api/refs/{ref}`` — resolve a short ref (``P12``, ``T345``,
``P12-R3``, ``D88``, ``M512``) to the item it names, for callers who may see it.

The resolver carries no access rules of its own: a project goes through
``projects_api._can_read`` and a card additionally through
``projects_api._card_visible`` — the same gates the project pages use; a
to-do or inbox message goes through its store's own C2-scoped ``get`` in the
profile the ref was issued in (``profile_refs``). A
ref that names nothing and a ref the caller may not see are the same 404.

Design note: docs/design/master-plan/feature-groups/FG-36-short-refs.md.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import kanban_db, projects_api, projects_db, short_refs

router = APIRouter(prefix="/api/refs", tags=["refs"])

NOT_FOUND = "ref not found"


def _readable_project(id_or_slug: str, principal, enrolled: set[str]):
    ctx = projects_api._load_ctx_sync(id_or_slug, principal.user_id)  # noqa: SLF001
    if ctx is None:
        return None
    project, role, profiles = ctx
    if not projects_api._can_read(project, role, principal, enrolled, profiles):  # noqa: SLF001
        return None
    return project


def _project_url(project) -> str:
    return f"/projects/{quote(project.slug, safe='')}"


def _resolve_project(parsed, record, principal, enrolled) -> Optional[dict]:
    project = _readable_project(record.internal_id, principal, enrolled)
    if project is None:
        return None
    base = {
        "project_ref": record.ref,
        "project_id": project.id,
        "project_slug": project.slug,
        "profile": None,
    }
    if parsed.run_no is None:
        return {
            "ref": record.ref,
            "kind": "project",
            "id": project.id,
            "title": project.name,
            "status": project.status,
            "url": _project_url(project),
            **base,
        }
    with projects_db.connect_closing() as conn:
        run = projects_db.get_project_run(conn, project.id, parsed.run_no)
    if run is None:
        return None
    return {
        "ref": short_refs.run_ref(record.ref, parsed.run_no),
        "kind": "run",
        "id": run.get("id"),
        "run_no": parsed.run_no,
        "title": f"{project.name} — run {parsed.run_no}",
        "status": run.get("status"),
        "url": f"{_project_url(project)}/runs/{parsed.run_no}",
        **base,
    }


def _resolve_card(parsed, record, principal, enrolled) -> Optional[dict]:
    with kanban_db.connect_closing(board=record.board or None) as bconn:
        task = kanban_db.get_task(bconn, record.internal_id)
    if task is None or not getattr(task, "project_id", None):
        return None
    project = _readable_project(task.project_id, principal, enrolled)
    if project is None or (project.board_slug or None) != (record.board or None):
        return None
    if not projects_api._card_visible(task, principal):  # noqa: SLF001
        return None
    return {
        "ref": record.ref,
        "kind": "card",
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "url": f"{_project_url(project)}/cards/{quote(task.id, safe='')}",
        "project_ref": projects_api._project_refs([project]).get(project.id),  # noqa: SLF001
        "project_id": project.id,
        "project_slug": project.slug,
        "profile": None,
    }


def _resolve_profile_item(parsed, record, principal, enrolled) -> Optional[dict]:
    """To-dos (D) and inbox messages (M): the store's own ``get`` in
    ``record.profile`` (``profile_refs.resolve``)."""
    from hermes_cli import profile_refs

    return profile_refs.resolve_sync(parsed, record, principal, enrolled)


#: Per-kind resolvers. Chats (C) add theirs with their PR; each must check
#: authority in ``record.profile``.
RESOLVERS: dict[str, Callable[..., Optional[dict]]] = {
    "P": _resolve_project,
    "T": _resolve_card,
    "D": _resolve_profile_item,
    "M": _resolve_profile_item,
}


def resolve_sync(ref: str, principal, enrolled: set[str]) -> Optional[dict]:
    """The resolution for ``ref`` as ``principal`` sees it, else ``None``."""
    parsed = short_refs.parse_ref(ref)
    if parsed is None:
        return None
    resolver = RESOLVERS.get(parsed.kind)
    if resolver is None:
        return None
    record = short_refs.lookup(parsed.base)
    if record is None:
        return None
    return resolver(parsed, record, principal, enrolled)


@router.get("/{ref}")
async def resolve_ref(request: Request, ref: str) -> dict[str, Any]:
    """Kind, internal id, title, status and the agent-home URL — or 404."""
    principal = await projects_api._principal_read(request)  # noqa: SLF001
    enrolled = await projects_api._enrolled_profiles(principal.user_id)  # noqa: SLF001
    from hermes_cli.profile_refs import CALLER_SUBJECT

    # Profile-scoped kinds re-resolve the caller in the ref's own profile.
    CALLER_SUBJECT.set(await projects_api._interactive_subject(request))  # noqa: SLF001
    result = await asyncio.to_thread(resolve_sync, ref, principal, set(enrolled))
    if result is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return result
