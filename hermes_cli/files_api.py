"""HTTP routes for the inbound file registry.

The read/serve surface over ``file_assets``: what arrived, from where, and a
short-lived link to the bytes. Every endpoint resolves the C1 principal and
scopes to that principal's visible set — the registry must not be an easier way
to read somebody's private material than the memory tier is.

Two things this deliberately does not do. It never returns a filesystem path:
the bytes live in a private bucket and a browser reaches them only through a
signed URL minted after an ownership check. And it never ingests: a file
appearing here is a record of arrival, not a decision to remember it.

Mounted by ``web_server.py`` beside the memory explorer router.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request

logger = logging.getLogger(__name__)

# NOT ``/api/files`` — that is the dashboard's managed-files browser over the
# box's filesystem, and mounting a router there would shadow it. This registry
# is a different thing: files that *arrived*, wherever they came from.
router = APIRouter(prefix="/api/registry/files")

_DEFAULT_LIMIT = 50

# Registries whose DDL already ran in this process. ``initialize`` drops and
# recreates RLS policies and opens its own connection, so running it on every
# upload made a 100-file upload burst exhaust the connection pool and race on
# the policy DDL.
_INITIALIZED_REGISTRIES: set[tuple[str, str, bool]] = set()
_INITIALIZE_LOCK = asyncio.Lock()


async def _initialize_once(registry) -> None:
    store = registry._store
    key = (
        str(getattr(store, "dsn", "")),
        str(getattr(store, "schema", "")),
        bool(registry.role_reads),
    )
    if key in _INITIALIZED_REGISTRIES:
        return
    async with _INITIALIZE_LOCK:
        if key in _INITIALIZED_REGISTRIES:
            return
        await registry.initialize()
        _INITIALIZED_REGISTRIES.add(key)
_MAX_LIMIT = 200


async def _resolve_principal(request: Request):
    """Resolve the C1 principal (lazy import to avoid a circular import)."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=True)


def _registry(mode: Optional[str] = None):
    from hermes_cli.file_registry import default_registry

    return default_registry(mode)


async def _ensure_table(registry) -> bool:
    """Whether the registry table exists yet.

    A box that has not received a file since the feature shipped has no table,
    and an empty list is the honest answer there — not a 500 that looks like a
    broken page.
    """
    conn = await registry._connect()
    try:
        from hermes_cli.file_registry import FILE_ASSETS_TABLE

        found = await conn.fetchval(
            "SELECT to_regclass(current_schema() || $1)",
            f".{FILE_ASSETS_TABLE}",
        )
        return found is not None
    finally:
        await conn.close()


@router.get("")
async def list_files(
    request: Request,
    q: str = "",
    surface: str = "",
    remembered: Optional[str] = None,
    limit: int = _DEFAULT_LIMIT,
    offset: int = 0,
) -> dict[str, Any]:
    """A page of the caller's visible files, newest first.

    ``surface`` accepts a comma-separated list; ``remembered`` is ``true`` /
    ``false`` / absent.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _ensure_table(registry):
        return {"files": [], "total": 0, "limit": limit, "offset": offset}

    surfaces = [s.strip() for s in surface.split(",") if s.strip()]
    flag: Optional[bool] = None
    if remembered is not None and str(remembered).strip() != "":
        flag = str(remembered).strip().lower() in {"1", "true", "yes"}

    rows, total = await registry.list(
        principal,
        query=q,
        surfaces=surfaces,
        remembered=flag,
        limit=max(1, min(int(limit or _DEFAULT_LIMIT), _MAX_LIMIT)),
        offset=max(0, int(offset or 0)),
    )
    return {
        "files": [row.as_dict() for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.get("/surfaces")
async def list_surfaces(request: Request) -> dict[str, Any]:
    """The surfaces the caller actually has files from, with counts.

    Drives the filter chips: offering a "WhatsApp" filter on a box with no
    WhatsApp files is a dead control.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _ensure_table(registry):
        return {"surfaces": []}

    from hermes_cli.access import bind_principal
    from hermes_cli.file_registry import FILE_ASSETS_TABLE, GRANT_ITEM_KIND
    from hermes_cli.access import scope_filter

    predicate = scope_filter(
        principal,
        start_index=1,
        grant_item_kind=GRANT_ITEM_KIND,
        id_column=f"{FILE_ASSETS_TABLE}.id",
    )
    conn = await registry._connect()
    try:
        async with conn.transaction():
            await bind_principal(conn, principal)
            rows = await conn.fetch(
                f"SELECT surface, COUNT(*) AS n FROM {FILE_ASSETS_TABLE} "
                f"WHERE {predicate.sql} GROUP BY surface ORDER BY n DESC",
                *predicate.params,
            )
    finally:
        await conn.close()
    return {
        "surfaces": [
            {"surface": str(r["surface"]), "count": int(r["n"])} for r in rows
        ]
    }


@router.post("/register")
async def register_file(request: Request) -> dict[str, Any]:
    """Record a file agent-home has already written to Storage.

    agent-home holds the bytes and the bucket credentials for its own uploads,
    so it uploads and then tells the registry where the object landed — rather
    than shipping the bytes twice. The caller's principal owns the row; a
    client cannot register a file on somebody else's behalf.
    """
    principal = await _resolve_principal(request)
    body = await request.json()
    required = ("filename", "sha256", "storage_path")
    missing = [key for key in required if not str(body.get(key) or "").strip()]
    if missing:
        raise HTTPException(
            status_code=400, detail=f"missing fields: {', '.join(missing)}"
        )

    registry = _registry()
    await _initialize_once(registry)
    asset = await registry.register(
        principal,
        surface=str(body.get("surface") or "agent_home"),
        filename=str(body["filename"]),
        content_type=str(body.get("content_type") or "application/octet-stream"),
        byte_size=int(body.get("byte_size") or 0),
        sha256=str(body["sha256"]),
        storage_bucket=str(body.get("storage_bucket") or ""),
        storage_path=str(body["storage_path"]),
        conversation=str(body.get("conversation") or "") or None,
        sender_id=principal.user_id,
        sender_name=principal.display or principal.user_id,
        message_id=str(body.get("message_id") or "") or None,
    )
    return asset.as_dict()


@router.get("/by-path")
async def get_file_by_path(
    request: Request, path: str = Query(min_length=1)
) -> dict[str, Any]:
    """Resolve a bucket storage path to the newest visible registry row.

    Project ``file`` links store only the storage path; the Files panel
    needs the registry id to open the shared view/download surface. Same
    visibility predicate as ``GET /{asset_id}`` — invisible == absent == 404.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _ensure_table(registry):
        raise HTTPException(status_code=404, detail="No such file")
    asset = await registry.get_by_storage_path(principal, path)
    if asset is None:
        raise HTTPException(status_code=404, detail="No such file")
    return asset.as_dict()


@router.get("/{asset_id}")
async def get_file(request: Request, asset_id: str) -> dict[str, Any]:
    """One file's record, or 404 when it does not exist or is not visible.

    Invisible and absent deliberately return the same status: a distinguishable
    403 would confirm that somebody else's file exists.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _ensure_table(registry):
        raise HTTPException(status_code=404, detail="No such file")
    asset = await registry.get(principal, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="No such file")
    return asset.as_dict()


@router.get("/{asset_id}/link")
async def get_file_link(
    request: Request, asset_id: str, download: bool = False
) -> dict[str, Any]:
    """A short-lived signed URL for the bytes, after the visibility check.

    The check above is the isolation: signing is unconditional once reached, so
    it must never be reached for a file the caller cannot see.
    """
    principal = await _resolve_principal(request)
    registry = _registry()
    if not await _ensure_table(registry):
        raise HTTPException(status_code=404, detail="No such file")
    asset = await registry.get(principal, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="No such file")

    from hermes_cli.filestore import (
        DEFAULT_SIGNED_URL_TTL,
        StorageNotConfigured,
        SupabaseStorage,
    )

    try:
        storage = SupabaseStorage.from_env(bucket=asset.storage_bucket or None)
        url = await storage.signed_url(
            asset.storage_path,
            download_name=asset.filename if download else "",
        )
    except StorageNotConfigured as exc:
        raise HTTPException(status_code=501, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - upstream storage failure
        logger.warning("file registry: could not sign %s (%s)", asset_id, exc)
        raise HTTPException(
            status_code=502, detail="The file store could not be reached."
        ) from exc
    return {
        "url": url,
        "expires_in": DEFAULT_SIGNED_URL_TTL,
        "filename": asset.filename,
        "content_type": asset.content_type,
    }
