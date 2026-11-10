"""``GET /api/refs/{ref}`` — resolve a short ref (``P12``, ``T345``,
``P12-R3``, ``C1024``, ``D88``, ``M512``) to the item it names, for callers who may see it.

The resolver carries no access rules of its own: a project goes through
``projects_api._can_read`` and a card additionally through
``projects_api._card_visible`` — the same gates the project pages use; a
chat goes through the chat routes' rule in the chat's own profile; a
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


def _chat_status(session: dict) -> str:
    if session.get("archived"):
        return "archived"
    return "ended" if session.get("ended_at") else "open"


def _resolve_chat(parsed, record, principal, enrolled) -> Optional[dict]:
    """A chat, for a caller who may read it **in its profile**.

    ``principal`` is the caller as resolved in ``record.profile``
    (:func:`_profile_principal`); visibility is the chat routes' own rule
    (``_chat_scope_for`` + the conversation's owner). The ref names the
    conversation: it resolves to the live compression tip.
    """
    from hermes_cli import chat_refs
    from hermes_cli.web_server import _chat_scope_for

    db = chat_refs.open_db(record.profile or "")
    if db is None:
        return None
    try:
        root = db.get_session(record.internal_id)
        if root is None:
            return None
        tip_id = db.get_compression_tip(record.internal_id) or record.internal_id
        tip = db.get_session(tip_id) or root
        scope = _chat_scope_for(principal)
        if scope is not None and db.session_owner_user_id(tip_id) != scope:
            return None
        title = tip.get("title") or root.get("title") or ""
    finally:
        db.close()
    query = f"session={quote(tip_id, safe='')}&profile={quote(record.profile or '', safe='')}"
    return {
        "ref": record.ref,
        "kind": "chat",
        "id": tip_id,
        "title": title or "Untitled chat",
        "status": _chat_status(tip),
        "url": f"/chat?{query}",
        "lineage_root": record.internal_id,
        "profile": record.profile,
    }


#: Per-kind resolvers. Each profile-scoped kind checks authority in
#: ``record.profile`` (chats via :func:`resolve_for_request`, to-dos and
#: inbox messages via ``profile_refs``).
RESOLVERS: dict[str, Callable[..., Optional[dict]]] = {
    "P": _resolve_project,
    "T": _resolve_card,
    "C": _resolve_chat,
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


async def _profile_principal(request: Request, profile: str):
    """The caller as enrolled in ``profile`` (FG-28: reading a profile's
    chats needs an enrolment there), or ``None``.

    The chat routes' own resolver: the acting profile resolves as it always
    has; another profile re-resolves the verified subject in that profile's
    ``principals`` (not enrolled / suspended → ``None``, never its owner).
    """
    from hermes_cli.web_server import _chat_principal

    try:
        return await _chat_principal(request, profile)
    except HTTPException:
        return None


#: Kinds whose resolver takes the caller as already resolved in
#: ``record.profile`` (D and M re-resolve inside ``profile_refs``).
PROFILE_PRINCIPAL_KINDS = frozenset({"C"})


async def resolve_for_request(request: Request, ref: str, *, principal=None) -> Optional[dict]:
    """:func:`resolve_sync` under the request's caller, with the
    profile-scoped kinds authorised in the item's own profile.

    ``principal`` overrides the box-wide reader (a chat turn passes the
    principal it already resolved for the chat's profile).
    """
    parsed = short_refs.parse_ref(ref)
    if parsed is None or parsed.kind not in RESOLVERS:
        return None
    record = await asyncio.to_thread(short_refs.lookup, parsed.base)
    if record is None:
        return None
    if parsed.kind in PROFILE_PRINCIPAL_KINDS:
        principal = await _profile_principal(request, record.profile or "")
        if principal is None:
            return None
    elif principal is None:
        principal = await projects_api._principal_read(request)  # noqa: SLF001
    enrolled = await projects_api._enrolled_profiles(principal.user_id)  # noqa: SLF001
    from hermes_cli.profile_refs import CALLER_SUBJECT

    # D/M re-resolve the caller in the ref's own profile from the subject.
    CALLER_SUBJECT.set(await projects_api._interactive_subject(request))  # noqa: SLF001
    return await asyncio.to_thread(
        RESOLVERS[parsed.kind], parsed, record, principal, set(enrolled)
    )


@router.get("/{ref}")
async def resolve_ref(request: Request, ref: str) -> dict[str, Any]:
    """Kind, internal id, title, status and the agent-home URL — or 404."""
    result = await resolve_for_request(request, ref)
    if result is None:
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return result
