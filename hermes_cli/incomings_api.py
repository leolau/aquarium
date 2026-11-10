"""HTTP routes for the unified inbox of arrivals.

The read surface over ``inbound_items``: what arrived, on which channel, from
whom, with links out to the files it carried and the memory it became. Every
endpoint resolves the C1 principal and scopes to that principal's visible set,
because an inbox that ignored visibility would be an easier way to read
somebody's private mail than the memory tier is.

Paging is keyset, never offset: an inbox grows at the top, and an offset page
2 shifts under the reader every time something arrives. The cursor is opaque
and deliberately not part of the filter querystring, so a shared inbox URL is
a shared *filter*, not somebody's scroll position.

Mounted by ``web_server.py`` beside the file registry router.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import profile_refs

logger = logging.getLogger(__name__)

#: Same reasoning as the file registry's prefix: ``/api/inbox`` in agent-home
#: is the BFF route, and the Python surface stays under ``/api/registry/*``
#: with its siblings.
router = APIRouter(prefix="/api/registry/incomings")

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200

ENTITY_KIND = "inbound"


async def _resolve_principal(request: Request):
    """Resolve the C1 principal (lazy import to avoid a circular import)."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=True)


def _registry(mode: Optional[str] = None):
    from hermes_cli.inbound_registry import default_registry

    return default_registry(mode)


def _tags(mode: Optional[str] = None):
    from hermes_cli.tags import default_registry

    return default_registry(mode)


async def _table_exists(registry) -> bool:
    """Whether the registry table exists yet.

    A box that has not received anything since the feature shipped has no
    table, and an empty inbox is the honest answer there — not a 500 that
    looks like a broken page.
    """
    from hermes_cli.inbound_registry import INBOUND_ITEMS_TABLE

    conn = await registry._connect()
    try:
        return (
            await conn.fetchval(
                "SELECT to_regclass(current_schema() || $1)",
                f".{INBOUND_ITEMS_TABLE}",
            )
            is not None
        )
    finally:
        await conn.close()


def _csv(value: str) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _flag(value: Optional[str]) -> Optional[bool]:
    if value is None or str(value).strip() == "":
        return None
    return str(value).strip().lower() in {"1", "true", "yes"}


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


async def _decorate(tag_registry, principal, items: list) -> list[dict[str, Any]]:
    """Item dicts with their tags and short refs (``M512``) attached."""
    out: list[dict[str, Any]] = []
    for item in items:
        payload = item.as_dict()
        payload["tags"] = [
            tag.as_dict()
            for tag in await tag_registry.for_entity(principal, ENTITY_KIND, item.id)
        ]
        out.append(payload)
    return await _with_refs(out)


async def _with_refs(payloads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each arrival payload with its short ref (``M512``, FG-36)."""
    return await profile_refs.attach(
        profile_refs.MESSAGE, payloads, created_key="registered_at"
    )


@router.get("")
async def list_incomings(
    request: Request,
    q: str = "",
    surface: str = "",
    kind: str = "",
    sender: str = "",
    importance: str = "",
    tag: str = "",
    tag_match: str = "any",
    exclude_tag: str = "",
    remembered: Optional[str] = None,
    has_attachments: Optional[str] = None,
    since: str = "",
    until: str = "",
    limit: int = _DEFAULT_LIMIT,
    cursor: str = "",
) -> dict[str, Any]:
    """A keyset page of the caller's visible arrivals, newest first.

    All list-ish parameters are comma-separated. ``next_cursor`` is ``None``
    at the end; there is no total, because counting the filtered set on every
    page is the full scan keyset paging exists to avoid.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _table_exists(registry):
        return {"items": [], "next_cursor": None}

    # A short ref (``M512``) typed into search opens exactly that arrival.
    is_ref, target = await profile_refs.search_target(profile_refs.MESSAGE, q)
    if is_ref:
        item = await registry.get(principal, target) if target else None
        return {
            "items": await _decorate(_tags(), principal, [item] if item else []),
            "next_cursor": None,
        }

    page = await registry.list(
        principal,
        query=q,
        surfaces=_csv(surface),
        kinds=_csv(kind),
        senders=_csv(sender),
        importance=_csv(importance),
        since=_when(since, field="since"),
        until=_when(until, field="until"),
        remembered=_flag(remembered),
        has_attachments=_flag(has_attachments),
        include_tags=_csv(tag),
        exclude_tags=_csv(exclude_tag),
        tag_match="all" if str(tag_match).lower() == "all" else "any",
        limit=max(1, min(int(limit or _DEFAULT_LIMIT), _MAX_LIMIT)),
        cursor=cursor or None,
    )
    return {
        "items": await _decorate(_tags(), principal, page.items),
        "next_cursor": page.next_cursor,
    }


@router.get("/facets")
async def incomings_facets(request: Request) -> dict[str, Any]:
    """Surfaces, importance levels and tags the caller actually has.

    Drives the filter chips: offering a "calendar" filter on a box with no
    calendar arrivals is a control that can only disappoint.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _table_exists(registry):
        return {"surfaces": [], "importance": [], "tags": []}

    facets = await registry.facets(principal)
    try:
        tags = await _tags().list(principal, entity_kind=ENTITY_KIND)
    except Exception as exc:  # noqa: BLE001 - a missing vocabulary is not fatal
        logger.debug("incomings: tag facets unavailable (%s)", exc)
        tags = []
    return {
        "surfaces": facets.get("surfaces", []),
        "importance": facets.get("importance", []),
        "tags": [tag.as_dict() for tag in tags],
    }


@router.get("/{item_id}")
async def get_incoming(request: Request, item_id: str) -> dict[str, Any]:
    """One arrival with its attachments and tags, or 404.

    Invisible and absent return the same status on purpose: a distinguishable
    403 would confirm that somebody else's message exists.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _table_exists(registry):
        raise HTTPException(status_code=404, detail="No such item")
    item = await registry.get(principal, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="No such item")

    payload = (await _with_refs([item.as_dict()]))[0]
    payload["attachments"] = await registry.attachments(principal, item_id)
    payload["tags"] = [
        tag.as_dict()
        for tag in await _tags().for_entity(principal, ENTITY_KIND, item_id)
    ]
    return payload


@router.post("/{item_id}/tags")
async def tag_incoming(request: Request, item_id: str) -> dict[str, Any]:
    """Attach a tag, creating it in the shared vocabulary when new."""
    principal = await _resolve_principal(request)
    body = await request.json()
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="missing field: name")

    registry = _registry()
    if not await _table_exists(registry) or (
        await registry.get(principal, item_id)
    ) is None:
        raise HTTPException(status_code=404, detail="No such item")

    tag_registry = _tags()
    await tag_registry.initialize()
    tag = await tag_registry.assign(
        principal,
        ENTITY_KIND,
        item_id,
        name,
        color=str(body.get("color") or "") or None,
        source=str(body.get("source") or "manual"),
    )
    return tag.as_dict()


@router.delete("/{item_id}/tags/{tag_id}")
async def untag_incoming(
    request: Request, item_id: str, tag_id: str
) -> dict[str, Any]:
    """Detach a tag. The tag itself stays in the vocabulary."""
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _table_exists(registry) or (
        await registry.get(principal, item_id)
    ) is None:
        raise HTTPException(status_code=404, detail="No such item")
    removed = await _tags().unassign(principal, ENTITY_KIND, item_id, tag_id)
    return {"removed": removed}


class RememberError(Exception):
    """Remembering failed for a reason the caller can report verbatim."""

    def __init__(self, message: str, *, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


async def remember_item(principal, registry, item) -> Any:
    """Ingest one arrival into the memory tier and stamp the link back.

    Shared by the HTTP route and ``hermes incomings remember``: the traceable
    part is the ``source_ref`` back to the item, so "why do I remember this"
    is answerable by the message it came from, whichever surface asked.
    """
    text = "\n\n".join(part for part in (item.subject, item.body) if part).strip()
    if not text:
        raise RememberError("This arrival has no text to remember.", status=400)

    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store
    from plugins.memory.supabase_pgvector.rag import RagStore
    from plugins.memory.supabase_pgvector.store import PgvectorMemoryStore

    config = load_config()
    rag = RagStore(PgvectorMemoryStore(get_store("supabase-app"), config=config))
    try:
        await rag.initialize()
        result = await rag.ingest(
            principal,
            source_kind="inbound",
            source_ref=str(item.id),
            title=item.subject
            or f"{item.surface} from {item.sender_name or 'unknown'}",
            text=text,
        )
        document_id = result.document_id
        if document_id is None:
            # Unchanged content: the document already exists, so find its id
            # to stamp rather than reporting a failure the user cannot act on.
            # ``ingested_state`` maps to content hashes, not ids, so the lookup
            # goes through the document list.
            for document in await rag.documents(principal, source_kind="inbound"):
                if document.source_ref == str(item.id):
                    document_id = document.id
                    break
    except Exception as exc:  # noqa: BLE001 - upstream memory tier failure
        logger.warning("incomings: could not remember %s (%s)", item.id, exc)
        raise RememberError("The memory tier could not be reached.") from exc
    if document_id is None:
        raise RememberError("The arrival was not ingested.")

    updated = await registry.mark_remembered(
        principal,
        str(item.id),
        document_id=str(document_id),
        remembered_by=principal.user_id,
    )
    return updated or item


@router.post("/{item_id}/remember")
async def remember_incoming(request: Request, item_id: str) -> dict[str, Any]:
    """Ingest an arrival into the memory tier and stamp the link back.

    Registering an arrival is a fact; remembering it is a judgement, made here
    deliberately by the user.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _table_exists(registry):
        raise HTTPException(status_code=404, detail="No such item")
    item = await registry.get(principal, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="No such item")

    try:
        remembered = await remember_item(principal, registry, item)
    except RememberError as error:
        raise HTTPException(status_code=error.status, detail=str(error)) from error
    return remembered.as_dict()
