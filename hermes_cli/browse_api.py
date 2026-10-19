"""Files → Browse in agent-home: read-only, one folder level at a time.

Two server-side kinds of place, each limited to what the caller may already
reach:

* ``net-…`` — network folders the caller added or that are shared with them
  (``vpn_folders.readable_folders``), mounted read-only through their VPN.
* ``workspace`` — the caller's own ``$HERMES_HOME/workspaces/<person>`` folder,
  where the agent writes files for them.

The third kind on that page, folders on the person's own computer, never
reaches the server: the browser lists them itself (Folder Bridge handles).

Listing never walks a tree (one ``scandir`` per request, bounded by
``LIST_TIMEOUT``), every path is opened component by component without
following symlinks, and nothing here writes to a place.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import stat
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from hermes_cli import vpn, vpn_folders

router = APIRouter(prefix="/api/browse")

WORKSPACE = "workspace"
#: A slow SMB share can take 10–15 s for one big folder; past this the page
#: says so instead of spinning.
LIST_TIMEOUT = 30.0
MAX_ENTRIES = 5000


async def _principal(request: Request):
    from hermes_cli.credentials_api import _principal as resolve

    return await resolve(request, allow_as=False)


def workspace_root(user_id: str) -> Path:
    from hermes_constants import get_hermes_home
    from tools.access_policy import _folder_name

    root = Path(get_hermes_home()) / "workspaces" / _folder_name(str(user_id))
    root.mkdir(parents=True, exist_ok=True)
    return root


def _split(path: Any) -> List[str]:
    if path in (None, ""):
        return []
    return vpn_folders.split_rel(path)


def open_dir_inside(root: str, path: Any) -> int:
    """Open a directory under ``root`` without following any symlink."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
    dfd = os.open(root, flags)
    for part in _split(path):
        try:
            nfd = os.open(part, flags, dir_fd=dfd)
        except OSError as exc:
            os.close(dfd)
            raise vpn.VpnError(f"Not a folder: {path} ({exc.strerror})") from None
        os.close(dfd)
        dfd = nfd
    return dfd


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def list_dir(root: str, path: Any) -> Dict[str, Any]:
    """One folder's immediate entries: folders first, then files, by name."""
    parts = _split(path)
    fd = open_dir_inside(root, path)
    entries: List[Dict[str, Any]] = []
    truncated = False
    try:
        with os.scandir(fd) as it:
            for entry in it:
                if len(entries) >= MAX_ENTRIES:
                    truncated = True
                    break
                try:
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    kind, size = "directory", None
                elif stat.S_ISREG(st.st_mode):
                    kind, size = "file", st.st_size
                else:
                    continue
                entries.append({
                    "name": entry.name,
                    "path": "/".join(parts + [entry.name]),
                    "kind": kind,
                    "size": size,
                    "modified_at": _iso(st.st_mtime),
                })
    finally:
        os.close(fd)
    entries.sort(key=lambda e: (e["kind"] != "directory", e["name"].lower()))
    return {"path": "/".join(parts), "entries": entries, "truncated": truncated}


def _network_place(view: Dict[str, Any], cred: Any, me: str) -> Dict[str, Any]:
    return {
        "id": view["id"],
        "kind": "network",
        "name": view["name"],
        "vpn": view["vpn"],
        "shared": cred.owner_user_id != me,
        "trusted_for_import": view["trusted_for_import"],
        "mounted": view["status"]["mounted"],
        "error": view["status"]["error"],
    }


async def places(principal: Any) -> List[Dict[str, Any]]:
    me = getattr(principal, "user_id", None)
    out = []
    for cred in await vpn_folders.readable_folders(principal):
        out.append(_network_place(await vpn_folders.view_of(cred), cred, me))
    out.append({"id": WORKSPACE, "kind": "workspace", "name": "Workspace"})
    return out


async def resolve_place(principal: Any, place: Any) -> Tuple[str, str]:
    """``(root on disk, label)``; mounts a network folder that isn't yet."""
    if place == WORKSPACE:
        return str(workspace_root(principal.user_id)), "Workspace"
    for cred in await vpn_folders.readable_folders(principal):
        if vpn_folders.folder_id(vpn_folders.folder_slug_for(cred)) == place:
            view = await vpn_folders.ensure(cred)
            if not view["status"]["mounted"]:
                raise HTTPException(
                    409, view["status"]["error"] or "The network folder is not mounted"
                )
            return view["mount_path"], cred.name
    raise HTTPException(404, "Unknown place")


async def _guard(coro) -> Any:
    try:
        return await coro
    except vpn.VpnNotFound as exc:
        raise HTTPException(404, str(exc))
    except vpn.VpnError as exc:
        raise HTTPException(400, str(exc))
    except PermissionError:
        raise HTTPException(403, "That folder is not readable")
    except FileNotFoundError:
        raise HTTPException(404, "Not found")


@router.get("/places")
async def list_places(request: Request):
    principal = await _principal(request)
    return {"places": await _guard(places(principal))}


@router.get("/list")
async def list_folder(request: Request, place: str, path: str = ""):
    principal = await _principal(request)
    root, _ = await resolve_place(principal, place)
    try:
        listing = await asyncio.wait_for(
            _guard(asyncio.to_thread(list_dir, root, path)), LIST_TIMEOUT
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            504,
            f"The file server didn't list this folder within {LIST_TIMEOUT:g} s. "
            "Try again; a slow share often answers the second time.",
        )
    return {"place": place, **listing}


async def _stream(fd: int) -> AsyncIterator[bytes]:
    offset = 0
    try:
        while True:
            chunk = await asyncio.to_thread(os.pread, fd, vpn_folders.CHUNK_BYTES, offset)
            if not chunk:
                return
            offset += len(chunk)
            yield chunk
    finally:
        os.close(fd)


@router.get("/file")
async def read_file(request: Request, place: str, path: str):
    principal = await _principal(request)
    root, _ = await resolve_place(principal, place)
    fd = await _guard(asyncio.to_thread(vpn_folders.open_inside, root, path))
    size = os.fstat(fd).st_size
    name = vpn_folders.split_rel(path)[-1]
    content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return StreamingResponse(
        _stream(fd),
        media_type=content_type,
        headers={"content-length": str(size), "cache-control": "private, no-store"},
    )


@router.post("/save")
async def save_file(request: Request):
    """Copy one file into the caller's own Files (Storage + ``file_assets``).

    Pressing the button is the person's approval, so a network folder's
    "trusted for import" flag (which gates the *agent*) does not apply here.
    """
    principal = await _principal(request)
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise HTTPException(400, "body must be a JSON object")
    root, label = await resolve_place(principal, body.get("place"))
    path = body.get("path")
    return await _guard(vpn_folders.store_file(principal, root, path, label=label))

