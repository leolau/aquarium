"""HTTP routes for the to-dos page.

The read/write surface over the staged and open to-dos in ``tasks``: what the
agent noticed, what it thinks should happen about it, and the user's verdict.
Sibling of ``incomings_api`` in every respect that matters — same C1 principal
resolution, same C2 scoping, same keyset paging, same "a missing table is an
empty page, not a 500" behaviour on a box that has not migrated yet.

Two things here are specific to to-dos rather than inherited from that
pattern:

* **The stage transition is a POST to its own route**, not a field on PATCH.
  Promoting, working, finishing and dismissing are the events this whole
  feature exists to record; routing them through a generic field update would
  lose the actor and the reason in the transition history.
* **The detail route joins provenance.** A to-do without the message that
  caused it is an instruction with no context, and "why is this here?" is the
  first question a user asks of anything an agent put in front of them.

Mounted by ``web_server.py`` beside the inbox router.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli.todo_store import TodoError

logger = logging.getLogger(__name__)

#: ``/todos`` in agent-home is the page and its BFF; the Python surface stays
#: under ``/api/registry/*`` with the inbox and the file registry.
router = APIRouter(prefix="/api/registry/todos")

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


async def _resolve_principal(request: Request):
    """Resolve the C1 principal (lazy import to avoid a circular import)."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=True)


def _store(mode: Optional[str] = None):
    from hermes_cli.todo_store import default_store

    return default_store(mode)


async def _table_ready(store) -> bool:
    """Whether the to-do columns exist yet.

    The table itself predates this feature (FG-06 tasks), so the honest test
    is for the ``stage`` column rather than for the table: a box that has the
    old table and not the migration has no to-dos, and an empty page is the
    truthful answer, not a 500 that looks like a bug.
    """
    from hermes_cli.todo_store import TASKS_TABLE

    conn = await store._connect()
    try:
        return (
            await conn.fetchval(
                """SELECT 1 FROM information_schema.columns
                    WHERE table_schema = current_schema()
                      AND table_name = $1 AND column_name = 'stage'""",
                TASKS_TABLE,
            )
            is not None
        )
    finally:
        await conn.close()


def _csv(value: str) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _flag(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes"}


def _when(value: Optional[str], *, field: str) -> Optional[datetime]:
    if not value or not str(value).strip():
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail=f"{field} is not an ISO timestamp"
        ) from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


@router.get("")
async def list_todos(
    request: Request,
    q: str = "",
    stage: str = "",
    priority: str = "",
    source_kind: str = "",
    source_ref: str = "",
    due_before: str = "",
    include_snoozed: Optional[str] = None,
    limit: int = _DEFAULT_LIMIT,
    cursor: str = "",
) -> dict[str, Any]:
    """A keyset page of the caller's visible to-dos, newest first.

    All list-ish parameters are comma-separated. Snoozed to-dos are hidden by
    default — a snooze the list ignores is not a snooze.
    """
    principal = await _resolve_principal(request)
    store = _store()
    if not await _table_ready(store):
        return {"items": [], "next_cursor": None}

    items, next_cursor = await store.list(
        principal,
        query=q or None,
        stages=_csv(stage) or None,
        priorities=_csv(priority) or None,
        source_kinds=_csv(source_kind) or None,
        source_ref=source_ref or None,
        due_before=_when(due_before, field="due_before"),
        include_snoozed=_flag(include_snoozed),
        limit=max(1, min(int(limit or _DEFAULT_LIMIT), _MAX_LIMIT)),
        cursor=cursor or None,
    )
    return {
        "items": [item.as_dict() for item in items],
        "next_cursor": next_cursor,
    }


@router.get("/facets")
async def todos_facets(request: Request) -> dict[str, Any]:
    """Stages, priorities and sources the caller actually has."""
    principal = await _resolve_principal(request)
    store = _store()
    if not await _table_ready(store):
        return {"stages": [], "priorities": [], "source_kinds": []}
    return await store.facets(principal)


@router.post("")
async def create_todo(request: Request) -> dict[str, Any]:
    """A to-do the user wrote themselves.

    ``origin='explicit'`` and no dedupe key: the user asking for the same
    thing twice means they want it twice, while triage detecting the same
    thing twice does not.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    title = str(body.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="missing field: title")

    store = _store()
    await store.initialize()
    try:
        todo = await store.create(
            principal,
            title=title,
            description=str(body.get("description") or ""),
            stage="open",
            priority=str(body.get("priority") or "normal"),
            due_at=_when(body.get("due_at"), field="due_at"),
            source_kind="user",
            origin="explicit",
            actor=f"user:{principal.user_id}",
        )
    except TodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return todo.as_dict()


@router.get("/{todo_id}")
async def get_todo(request: Request, todo_id: str) -> dict[str, Any]:
    """One to-do with its history and the arrival behind it, or 404.

    Invisible and absent return the same status on purpose: a distinguishable
    403 would confirm that somebody else's to-do exists.
    """
    principal = await _resolve_principal(request)
    store = _store()
    if not await _table_ready(store):
        raise HTTPException(status_code=404, detail="No such to-do")
    todo = await store.get(principal, todo_id)
    if todo is None:
        raise HTTPException(status_code=404, detail="No such to-do")

    payload = todo.as_dict()
    payload["history"] = await store.history(principal, todo_id)
    source = await _source_item(principal, todo)
    payload["source"] = source
    memory = await _memory_doc(principal, source)
    if memory is not None:
        payload["memory"] = memory
    return payload


async def _source_item(principal, todo) -> Optional[dict[str, Any]]:
    """The arrival this to-do came from, when it still has one.

    Best-effort: a to-do whose source row was deleted, or whose registry is
    unreachable, is still a to-do. The page falls back to ``source_note``.
    """
    if todo.source_kind != "inbound" or not todo.source_ref:
        return None
    try:
        from hermes_cli.inbound_registry import default_registry

        item = await default_registry().get(principal, str(todo.source_ref))
    except Exception as exc:  # noqa: BLE001 - provenance is not the payload
        logger.debug("todos: source arrival unavailable (%s)", exc)
        return None
    return item.as_dict() if item is not None else None


async def _memory_doc(
    principal, source: Optional[dict[str, Any]]
) -> Optional[dict[str, Any]]:
    """The memory document the source arrival produced, when it has one.

    Best-effort, with the same contract as ``_source_item``: returns ``None``
    on any failure, never raises, never blocks the payload.  When the
    arrival was never remembered (no ``document_id``) the key is absent and
    the row is not rendered — a to-do whose provenance is thin renders thin.
    """
    if not source or not source.get("document_id"):
        return None
    doc_id = str(source["document_id"])
    try:
        from hermes_cli.datastore import get_store
        from hermes_cli.access import bind_principal, scope_filter

        app_store = get_store("supabase-app", "prod")
        conn = await app_store.connect()
        try:
            # Keep both layers: bind_principal sets the GUC context for any
            # future RLS policies on rag_documents, and scope_filter is the
            # app-layer visibility predicate that actually enforces C2 today
            # (no rag_documents RLS policy ships in this repo yet).
            await bind_principal(conn, principal)
            pred = scope_filter(
                principal,
                start_index=2,  # $1 is doc_id
                grant_item_kind="document",
                id_column="rag_documents.id",
            )
            row = await conn.fetchrow(
                f"SELECT id, title FROM rag_documents "
                f"WHERE id = $1::uuid AND {pred.sql}",
                doc_id,
                *pred.params,
            )
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001 - memory is not the payload
        logger.debug("todos: memory document unavailable (%s)", exc)
        return None
    if row is None:
        return None
    return {"id": str(row["id"]), "title": str(row["title"] or "")}


@router.post("/{todo_id}/start")
async def start_todo(request: Request, todo_id: str) -> dict[str, Any]:
    """Move a to-do to ``working`` and optionally spawn a seeded session.

    The stage change happens first and unconditionally: a to-do the user said
    they are working on must not stay ``open`` because a spawn failed.  When
    ``session: true`` the spawn runs on a detached thread and the endpoint
    returns ``session_id`` at once — the page has somewhere to link.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    store = _store()
    if not await _table_ready(store) or await store.get(principal, todo_id) is None:
        raise HTTPException(status_code=404, detail="No such to-do")

    # 1. The state change happens first and independently.
    try:
        todo = await store.set_stage(
            principal,
            todo_id,
            "working",
            actor=f"user:{principal.user_id}",
        )
    except TodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = todo.as_dict()
    want_session = _flag(str(body.get("session")))
    if not want_session:
        payload["session_id"] = None
        payload["spawned"] = False
        return payload

    # 2. Build the seed prompt from the to-do and its source arrival.
    #    Profile targeting is dropped until FG-28 provides a "profiles this
    #    subject holds" query — the previous check was inert (profile_home
    #    was always get_hermes_home()) and unsafe (PrincipalStore.get()
    #    returns any enrolled principal, not one the caller holds).
    prompt_parts = [f"# {todo.title}"]
    if todo.description:
        prompt_parts.append(todo.description)
    if todo.source_note:
        prompt_parts.append(f"(From {todo.source_note})")
    arrival = await _source_item(principal, todo)
    if arrival and arrival.get("body"):
        prompt_parts.append(f"\n---\nSource message:\n{arrival['body'][:2000]}")
    prompt = "\n\n".join(prompt_parts)

    _session_id = f"todo_{todo_id}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"

    # 3. Spawn on a detached thread; do not block the request.
    import contextvars
    import threading

    from hermes_constants import get_hermes_home

    _profile_home = str(get_hermes_home())
    _ctx = contextvars.copy_context()

    def _spawn():
        from agent.seeded_session import spawn_seeded_session

        result = spawn_seeded_session(
            prompt,
            origin="todo",
            session_id=_session_id,
            profile_home=_profile_home,
            skip_memory=False,  # a to-do session is the user's work
            context=_ctx,
            internal_user_id=principal.user_id,
            internal_user_role=getattr(principal, "role", None),
        )
        if result.error:
            logger.warning(
                "todos: /start session %s failed (%s)",
                _session_id,
                result.error,
            )
        try:
            import asyncio as _aio

            _aio.run(store.record_session(
                principal,
                todo_id,
                session_id=_session_id,
                actor=f"user:{principal.user_id}",
            ))
        except Exception as exc:
            logger.debug("todos: /start session pointer for %s failed (%s)", _session_id, exc)

    _thread = threading.Thread(target=_spawn, daemon=True)
    _thread.start()

    payload["session_id"] = _session_id
    payload["spawned"] = True
    return payload


@router.patch("/{todo_id}")
async def update_todo(request: Request, todo_id: str) -> dict[str, Any]:
    """Edit the parts of a to-do that are description, not lifecycle."""
    principal = await _resolve_principal(request)
    body = await request.json()
    store = _store()
    if not await _table_ready(store) or await store.get(principal, todo_id) is None:
        raise HTTPException(status_code=404, detail="No such to-do")

    try:
        todo = await store.update(
            principal,
            todo_id,
            title=(
                str(body["title"]).strip() if body.get("title") is not None else None
            ),
            description=(
                str(body["description"])
                if body.get("description") is not None
                else None
            ),
            priority=(
                str(body["priority"]) if body.get("priority") is not None else None
            ),
            due_at=_when(body.get("due_at"), field="due_at"),
            actor=f"user:{principal.user_id}",
        )
    except TodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return todo.as_dict()


@router.post("/{todo_id}/stage")
async def set_todo_stage(request: Request, todo_id: str) -> dict[str, Any]:
    """Move a to-do along its lifecycle, recording who moved it and why.

    This is the endpoint the page's buttons are: promote a staged to-do, start
    it, finish it, dismiss it. The transition is audited with the acting
    principal, which is what makes "the agent decided" and "I decided"
    distinguishable months later.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    stage = str(body.get("stage") or "").strip()
    if not stage:
        raise HTTPException(status_code=400, detail="missing field: stage")

    store = _store()
    if not await _table_ready(store) or await store.get(principal, todo_id) is None:
        raise HTTPException(status_code=404, detail="No such to-do")
    try:
        todo = await store.set_stage(
            principal,
            todo_id,
            stage,
            outcome=str(body.get("outcome") or "") or None,
            actor=f"user:{principal.user_id}",
        )
    except TodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return todo.as_dict()


@router.post("/{todo_id}/complete")
async def complete_todo(request: Request, todo_id: str) -> dict[str, Any]:
    """Finish a to-do, optionally proposing what should leave because of it.

    The proposal is *not* a send. It becomes an irreversible FG-10 approval, so
    the user answers it themselves and C6's standing consent can never answer
    it for them — the design position is that the system may propose and only
    the user may send.

    A failed proposal does not un-finish the work: the to-do is closed either
    way and the error is reported alongside it, because losing a completion
    because a draft was malformed would be the wrong trade.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    store = _store()
    if not await _table_ready(store) or await store.get(principal, todo_id) is None:
        raise HTTPException(status_code=404, detail="No such to-do")

    try:
        todo = await store.set_stage(
            principal,
            todo_id,
            "done",
            outcome=str(body.get("outcome") or "") or None,
            actor=f"user:{principal.user_id}",
        )
    except TodoError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = todo.as_dict()
    action = body.get("proposed_action")
    if isinstance(action, dict) and action:
        payload["proposal"] = await _propose(principal, todo, action)
    return payload


async def _propose(principal, todo, action: dict[str, Any]) -> dict[str, Any]:
    """Raise the approval for a proposed outgoing action, or say why not."""
    from hermes_cli.todo_outbound import OutboundError, parse_action, propose

    try:
        arrival = await _source_item(principal, todo)
        parsed = parse_action(action, arrival=arrival)
    except OutboundError as exc:
        return {"error": str(exc)}
    try:
        from hermes_cli.todo_notifier import default_stores

        store, notifications = default_stores()
        proposal = await propose(store, notifications, principal, todo, parsed)
    except Exception as exc:  # noqa: BLE001 - the work is done regardless
        logger.warning("todos: could not propose an action (%s)", exc)
        return {"error": "the outgoing action could not be proposed"}
    return proposal.as_dict()


@router.post("/{todo_id}/snooze")
async def snooze_todo(request: Request, todo_id: str) -> dict[str, Any]:
    """Hide a to-do until a moment the user chooses.

    A snooze re-arms the notification: when it lapses the to-do is announced
    again, because "later" only means anything if something happens later.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    until = _when(body.get("until"), field="until")
    if until is None:
        raise HTTPException(status_code=400, detail="missing field: until")

    store = _store()
    if not await _table_ready(store) or await store.get(principal, todo_id) is None:
        raise HTTPException(status_code=404, detail="No such to-do")
    todo = await store.snooze(
        principal, todo_id, until=until, actor=f"user:{principal.user_id}"
    )
    return todo.as_dict()


# ---------------------------------------------------------------------------
# Promotion seam — a to-do becomes a project card (Part 2)
# ---------------------------------------------------------------------------

#: Map the to-do's four-level priority onto the board's coarser two.
_PROMOTE_PRIORITY_MAP: dict[str, int] = {
    "critical": 2,
    "high": 2,
    "normal": 1,
    "low": 0,
}


@router.post("/{todo_id}/promote")
async def promote_todo(
    request: Request, todo_id: str
) -> dict[str, Any]:
    """Promote a to-do into a project card.

    Only a human promotes — never triage, never the agent. The card is created
    with ``status='triage'`` (never ``ready``: promotion is not dispatch).
    The to-do moves to ``working`` (not ``done`` — the work moved, not
    finished). A ``project_links`` row records the provenance so the project
    page can show the to-do it came from.

    .. note::
        Promotion has **no project authorisation** yet — any caller can
        promote into any project slug.  This is a stated precondition of the
        current seam, not a gap; the Projects permission router (when it
        lands) will gate this endpoint.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    project_slug = str(body.get("project") or body.get("slug") or "").strip()
    if not project_slug:
        raise HTTPException(status_code=400, detail="missing field: project")
    target_profile = str(body.get("profile") or "").strip() or principal.user_id

    store = _store()
    if not await _table_ready(store):
        raise HTTPException(status_code=404, detail="No such to-do")
    todo = await store.get(principal, todo_id)
    if todo is None:
        raise HTTPException(status_code=404, detail="No such to-do")

    # 1. Resolve the project.
    try:
        from hermes_cli import projects_db
        from hermes_cli.projects_db import connect_closing

        with connect_closing() as pconn:
            project = projects_db.get_project(pconn, project_slug)
    except Exception as exc:
        raise HTTPException(
            status_code=404, detail=f"project {project_slug!r} not found"
        ) from exc
    if project is None:
        raise HTTPException(
            status_code=404, detail=f"project {project_slug!r} not found"
        )

    # 2. Create the card with project_id, title/body seeded, status='triage'.
    priority = _PROMOTE_PRIORITY_MAP.get(todo.priority, 1)
    card_body = todo.description or ""
    card_body += f"\n\n(Promoted from to-do {todo_id})"

    from hermes_cli.kanban_db import ArchivedProjectError

    try:
        from hermes_cli.kanban_db import create_task, connect_closing as kconn_closing

        with kconn_closing() as kconn:
            card_id = create_task(
                kconn,
                title=todo.title,
                body=card_body,
                priority=priority,
                project_id=project.id,
                triage=True,
            )
            # Verify the card actually carries the project_id (cross-profile
            # projects may not resolve through the per-profile store yet).
            from hermes_cli.kanban_db import get_task, delete_task
            _card = get_task(kconn, card_id)
            _card_ok = _card is not None and bool(_card.project_id)
            if not _card_ok:
                # create_task silently nulls a project_id that doesn't
                # resolve through the per-profile store.  Delete the orphan
                # card rather than leaving a dangling triage card on the
                # board with no project and no project_links row.
                delete_task(kconn, card_id)
    except ArchivedProjectError as exc:
        # The writer's refusal — an archived project (U9). Surface it the
        # way the Projects router answers the same act: 409 naming the
        # archive and restore. ONLY the refusal gets this mapping (U13):
        # plain ``create_task`` input errors fall through to the log +
        # generic-failure branch below.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("todos: promote card creation failed (%s)", exc)
        raise HTTPException(
            status_code=500, detail="could not create the project card"
        ) from exc
    if not _card_ok:
        raise HTTPException(
            status_code=500,
            detail="project did not resolve on the target board "
                   "— promotion is single-profile until the shared "
                   "Projects store lands",
        )

    # 3. Write the project_links row.
    try:
        with connect_closing() as pconn:
            projects_db.add_project_link(
                pconn,
                project_id=project.id,
                kind="todo",
                profile=target_profile,
                ref=todo_id,
                label=todo.title,
                added_by=principal.user_id,
            )
    except Exception as exc:
        logger.warning("todos: project_links write failed (%s)", exc)
        # The card exists; the link is best-effort but not critical.

    # 4. Move the to-do to working (not done — the work moved).
    todo = await store.set_stage(
        principal,
        todo_id,
        "working",
        actor=f"user:{principal.user_id}",
    )
    payload = todo.as_dict()
    payload["card_id"] = card_id
    payload["project_id"] = project.id
    return payload
