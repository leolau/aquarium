"""Network folders: SMB shares reached through a saved Fortinet VPN, served
to the agent through the Folder Bridge (``folder_bridge_*`` tools in app-mcp).

A ``smb-folder`` credential (provider ``fortinet``) names one of its owner's
readable ``fortinet-vpn`` entries plus an SMB path and, optionally, its own
share login. :func:`ensure` connects that VPN when needed and asks the root
helper (``hermes-vpn-helper mount``) to mount the share read-only at
``/opt/data/vpn-files/net-<slug>``, routing the file server through the
tunnel as a ``/32`` when the VPN doesn't reach it yet (the VPN itself has no
routes to configure); ``down``/idle disconnect of the VPN unmounts it again.
The bridge folder id is ``net-<slug>``.

Ownership: only the owner sees/edits a folder through ``/api/vpn/folders``.
While mounted, any agent on the box may read it (box-level, like a VPN's own
share), which is why the internal app-mcp endpoints list every folder.

Design doc: ``docs/design/folder-bridge.md`` ("Network folders").
"""

from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
import re
import stat
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from hermes_cli import vpn
from hermes_cli.credential_store import (
    Credential,
    CredentialError,
    default_credential_store,
    resolve_owner_principal,
    validate_payload,
)

KIND = "smb-folder"
PROVIDER = vpn.PROVIDER
ID_PREFIX = "net-"
CHUNK_BYTES = 4 * 1024 * 1024

_ID_RE = re.compile(r"^net-[a-z0-9][a-z0-9-]{0,40}$")
_HOST_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
_HOST_RE = re.compile(rf"^(?=.{{1,253}}$){_HOST_LABEL}(?:\.{_HOST_LABEL})*$")
_SHARE_RE = re.compile(r"^[A-Za-z0-9 ._$-]{1,80}$")
_SUB_RE = re.compile(r'^[^/\\\x00-\x1f\x7f:*?"<>|,]{1,255}$')
_MOUNT_FIELDS = ("vpn", "share_path", "share_username", "share_password", "share_domain")

INVALID_PATH = (
    "SMB path must look like \\\\server\\share\\folder, "
    "smb://server/share/folder or //server/share/folder"
)


class FolderNotFound(vpn.VpnNotFound):
    """No network folder by that name/id for the caller (HTTP 404)."""


# ---------------------------------------------------------------------------
# SMB path
# ---------------------------------------------------------------------------


def normalize_share_path(value: Any) -> str:
    """``\\\\srv\\share\\sub`` / ``smb://srv/share/sub`` -> ``//srv/share/sub``."""
    text = str(value or "").strip()
    if text[:6].lower() == "smb://":
        text = "//" + text[6:]
    text = text.replace("\\", "/")
    if not text.startswith("//") or text.startswith("///"):
        raise vpn.VpnError(INVALID_PATH)
    parts = text[2:].rstrip("/").split("/")
    if len(parts) < 2 or len(parts) > 18 or any(p == "" for p in parts):
        raise vpn.VpnError(INVALID_PATH)
    server, share, subs = parts[0], parts[1], parts[2:]
    if not _HOST_RE.fullmatch(server.rstrip(".")) or not _SHARE_RE.fullmatch(share):
        raise vpn.VpnError(INVALID_PATH)
    for sub in subs:
        if sub in (".", "..") or not _SUB_RE.fullmatch(sub) or sub != sub.strip():
            raise vpn.VpnError(INVALID_PATH)
    return "//" + "/".join([server.rstrip(".").lower(), share, *subs])


# ---------------------------------------------------------------------------
# Slugs + bookkeeping (``$HERMES_HOME/vpn/state.json``, shared with vpn.py)
# ---------------------------------------------------------------------------


def _key(owner: str, name: str) -> str:
    return f"{owner}/{name}"


def folder_slug_for(cred: Credential) -> str:
    """Stable, box-unique folder slug (kept across renames)."""
    key = _key(cred.owner_user_id, cred.name)
    with vpn._locked_state() as doc:
        slugs: Dict[str, str] = doc.setdefault("folder_slugs", {})
        if key in slugs:
            return slugs[key]
        taken = set(slugs.values())
        slug = vpn.slug_base(cred.name)
        if slug in taken:
            digest = hashlib.sha256(("folder:" + key).encode()).hexdigest()
            slug = f"{slug[:34].rstrip('-')}-{digest[:6]}"
            n = 2
            while slug in taken:
                slug = f"{slug[:34].rstrip('-')}-{digest[:4]}{n}"
                n += 1
        slugs[key] = slug
        return slug


def _known_slug(cred: Credential) -> Optional[str]:
    with vpn._locked_state() as doc:
        return (doc.get("folder_slugs") or {}).get(_key(cred.owner_user_id, cred.name))


def _rename_slug(owner: str, old: str, new: str) -> None:
    with vpn._locked_state() as doc:
        slugs = doc.setdefault("folder_slugs", {})
        if _key(owner, old) in slugs:
            slugs[_key(owner, new)] = slugs.pop(_key(owner, old))


def _drop_slug(cred: Credential) -> Optional[str]:
    with vpn._locked_state() as doc:
        slug = doc.setdefault("folder_slugs", {}).pop(
            _key(cred.owner_user_id, cred.name), None
        )
        if slug:
            doc.setdefault("folders", {}).pop(slug, None)
        return slug


def _entry(slug: str) -> Dict[str, Any]:
    with vpn._locked_state() as doc:
        return dict((doc.get("folders") or {}).get(slug) or {})


def _record(slug: str, **fields: Any) -> Dict[str, Any]:
    with vpn._locked_state() as doc:
        entry = doc.setdefault("folders", {}).setdefault(slug, {})
        entry.update(fields)
        return dict(entry)


def folder_id(slug: str) -> str:
    return ID_PREFIX + slug


def mount_path(slug: str) -> str:
    return f"{vpn.MOUNT_ROOT}/{folder_id(slug)}"


# ---------------------------------------------------------------------------
# Store access
# ---------------------------------------------------------------------------


def _is_folder(cred: Credential) -> bool:
    return cred.kind == KIND and cred.provider == PROVIDER


def _readable_by(cred: Credential, user_id: str) -> bool:
    from hermes_cli.access import parse_private_owner

    if cred.owner_user_id == user_id or cred.visibility == "shared":
        return True
    return parse_private_owner(cred.visibility) == user_id


async def own_folders(principal: Any) -> List[Credential]:
    entries = await default_credential_store().list(principal)
    me = getattr(principal, "user_id", None)
    return [e for e in entries if _is_folder(e) and e.owner_user_id == me]


async def find_own_folder(principal: Any, name: str) -> Credential:
    for cred in await own_folders(principal):
        if cred.name == name:
            return cred
    raise FolderNotFound(f"no network folder named '{name}'")


async def readable_folders(principal: Any) -> List[Credential]:
    """Folders the caller added or that are shared with them."""
    me = getattr(principal, "user_id", None)
    entries = await default_credential_store().list(principal)
    return [e for e in entries if _is_folder(e) and _readable_by(e, str(me))]


async def _own_fortinet_entry(principal: Any, name: str) -> Optional[Credential]:
    me = getattr(principal, "user_id", None)
    for cred in await default_credential_store().list(principal):
        if cred.provider == PROVIDER and cred.name == name and cred.owner_user_id == me:
            return cred
    return None


async def box_folders() -> List[Credential]:
    """Every network folder on the box (read as the box owner, who sees all)."""
    owner = await resolve_owner_principal()
    if owner is None:
        return []
    return [e for e in await default_credential_store().list(owner) if _is_folder(e)]


async def vpn_for(folder: Credential) -> Optional[Credential]:
    """The folder's VPN entry, as long as the folder's owner may still read it."""
    owner = await resolve_owner_principal()
    if owner is None:
        return None
    name = folder.payload.get("vpn")
    matches = [
        e
        for e in await vpn.readable_vpns(owner)
        if e.name == name and _readable_by(e, folder.owner_user_id)
    ]
    mine = [m for m in matches if m.owner_user_id == folder.owner_user_id]
    return (mine or matches or [None])[0]


async def _principal_for(user_id: str) -> Any:
    from hermes_cli.access import Principal, PrincipalStore

    store = default_credential_store()
    if getattr(store, "backend", "") == "supabase":
        found = await PrincipalStore(store._store).get(user_id)
        if found is not None:
            return found
    role = "owner" if user_id == "owner" else "member"
    return Principal(user_id=user_id, display=user_id, role=role)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def build_view(
    cred: Credential,
    slug: str,
    *,
    vpn_cred: Optional[Credential],
    vpn_doc: Dict[str, Any],
    fdoc: Dict[str, Any],
    entry: Dict[str, Any],
) -> Dict[str, Any]:
    """The contract's NetworkFolderView. Never includes ``share_password``."""
    payload = cred.payload
    mounted = bool(fdoc.get("mounted"))
    if vpn_cred is None:
        vpn_state = "error"
        error: Optional[str] = (
            f"The VPN '{payload.get('vpn')}' was removed or is no longer shared with you"
        )
    else:
        state = vpn_doc.get("state")
        vpn_state = state if state in vpn.STATES else "error"
        error = None if mounted else (entry.get("last_error") or fdoc.get("error") or None)
    return {
        "id": folder_id(slug),
        "name": cred.name,
        "vpn": payload.get("vpn"),
        "vpn_slug": vpn.slug_for(vpn_cred) if vpn_cred is not None else None,
        "share_path": payload.get("share_path"),
        "share_username": payload.get("share_username") or None,
        "has_share_password": bool(payload.get("share_password")),
        "share_domain": payload.get("share_domain") or None,
        "trusted_for_import": bool(payload.get("trusted_for_import")),
        "mount_path": mount_path(slug),
        "status": {
            "vpn_state": vpn_state,
            "mounted": mounted,
            "error": error,
            "last_check": entry.get("last_check"),
        },
    }


async def view_of(cred: Credential) -> Dict[str, Any]:
    slug = folder_slug_for(cred)
    vpn_cred = await vpn_for(cred)
    vpn_doc: Dict[str, Any] = {}
    if vpn_cred is not None:
        vpn_doc = await vpn._helper("status", vpn.slug_for(vpn_cred))
    fdoc = await vpn._helper("fstatus", slug)
    return build_view(
        cred, slug, vpn_cred=vpn_cred, vpn_doc=vpn_doc, fdoc=fdoc, entry=_entry(slug)
    )


async def list_views(principal: Any) -> List[Dict[str, Any]]:
    return [await view_of(c) for c in await own_folders(principal)]


# ---------------------------------------------------------------------------
# Create / update / delete (principal-scoped: own folders only)
# ---------------------------------------------------------------------------


def _text(body: Dict[str, Any], key: str) -> Optional[str]:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise vpn.VpnError(f"{key} must be a string")
    return value.strip() or None


async def _payload_from(
    principal: Any, body: Dict[str, Any], existing: Optional[Credential]
) -> Tuple[str, Dict[str, Any]]:
    old = existing.payload if existing else {}
    name = _text(body, "name") or (existing.name if existing else None)
    if not name:
        raise vpn.VpnError("name is required")
    vpn_name = _text(body, "vpn") or old.get("vpn")
    if not vpn_name:
        raise vpn.VpnError("vpn is required: pick one of your saved VPNs")
    try:
        vpn_cred = await vpn.find_vpn(principal, vpn_name)
    except vpn.VpnNotFound:
        raise vpn.VpnError(
            f"no VPN named '{vpn_name}' — add it in Settings → In&Out first"
        ) from None
    raw_path = body.get("share_path") if "share_path" in body else old.get("share_path")
    payload: Dict[str, Any] = {
        "vpn": vpn_cred.name,
        "share_path": normalize_share_path(raw_path),
    }
    trusted = body.get("trusted_for_import", old.get("trusted_for_import", False))
    if not isinstance(trusted, bool):
        raise vpn.VpnError("trusted_for_import must be true or false")
    payload["trusted_for_import"] = trusted
    username = _text(body, "share_username") if "share_username" in body else old.get(
        "share_username"
    )
    if username:
        payload["share_username"] = username
        password = body.get("share_password")
        if password not in (None, ""):
            if not isinstance(password, str):
                raise vpn.VpnError("share_password must be a string")
            payload["share_password"] = password
        elif old.get("share_username") and old.get("share_password"):
            payload["share_password"] = old["share_password"]
        domain = _text(body, "share_domain") if "share_domain" in body else old.get(
            "share_domain"
        )
        if domain:
            payload["share_domain"] = domain
    try:
        validate_payload(KIND, payload)
    except CredentialError as exc:
        raise vpn.VpnError(str(exc).removeprefix("smb-folder: ")) from exc
    return name, payload


async def _put(principal: Any, name: str, payload: Dict[str, Any]) -> Credential:
    try:
        return await default_credential_store().put(
            principal,
            provider=PROVIDER,
            name=name,
            kind=KIND,
            payload=payload,
            visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise vpn.VpnError(str(exc)) from exc


async def create(principal: Any, body: Dict[str, Any]) -> Dict[str, Any]:
    name, payload = await _payload_from(principal, body, None)
    clash = await _own_fortinet_entry(principal, name)
    if clash is not None:
        what = "network folder" if clash.kind == KIND else "VPN"
        raise vpn.VpnError(f"the name '{name}' is already used by your {what} '{name}'")
    return await view_of(await _put(principal, name, payload))


async def update(principal: Any, name: str, body: Dict[str, Any]) -> Dict[str, Any]:
    existing = await find_own_folder(principal, name)
    new_name, payload = await _payload_from(principal, body, existing)
    if new_name != existing.name:
        clash = await _own_fortinet_entry(principal, new_name)
        if clash is not None:
            raise vpn.VpnError(f"the name '{new_name}' is already in use")
    remount = any(existing.payload.get(k) != payload.get(k) for k in _MOUNT_FIELDS)
    slug = _known_slug(existing)
    if remount and slug:
        await vpn._helper("umount", slug)
        _record(slug, last_error=None, last_check=None)
    updated = await _put(principal, new_name, payload)
    if new_name != existing.name:
        _rename_slug(existing.owner_user_id, existing.name, new_name)
        await default_credential_store().delete(principal, PROVIDER, existing.name)
    return await view_of(updated)


async def forget(cred: Credential) -> None:
    """Unmount a folder whose credential is being deleted."""
    slug = _known_slug(cred)
    if slug:
        await vpn._helper("umount", slug)
    _drop_slug(cred)


async def delete(principal: Any, name: str) -> None:
    cred = await find_own_folder(principal, name)
    await forget(cred)
    await default_credential_store().delete(principal, PROVIDER, cred.name)


# ---------------------------------------------------------------------------
# Mounting
# ---------------------------------------------------------------------------


def mount_spec(folder: Credential, vpn_cred: Credential, vpn_slug: str, slug: str) -> Dict[str, Any]:
    """Helper ``mount`` spec with the share login resolved: the folder's own
    login, else the VPN's share login, else the VPN login."""
    fp, vp = folder.payload, vpn_cred.payload
    if fp.get("share_username"):
        user, password, domain = (
            fp["share_username"], fp.get("share_password"), fp.get("share_domain"),
        )
    else:
        user = vp.get("share_username") or vp.get("username")
        password = vp.get("share_password") or vp.get("password")
        domain = vp.get("share_domain")
    spec: Dict[str, Any] = {
        "vpn_slug": vpn_slug,
        "folder_slug": slug,
        "share_path": fp["share_path"],
        "share_username": user,
    }
    if password:
        spec["share_password"] = password
    if domain:
        spec["share_domain"] = domain
    return spec


async def ensure(folder: Credential, *, agent: bool = False) -> Dict[str, Any]:
    """Connect the folder's VPN if needed, then mount the folder.

    ``agent`` (app-mcp callers) honours the VPN's ``auto_connect: false``: a
    VPN only the user may connect is not brought up for an agent.
    """
    slug = folder_slug_for(folder)
    vpn_cred = await vpn_for(folder)
    if vpn_cred is None:
        return await view_of(folder)
    vpn_slug = vpn.slug_for(vpn_cred)
    doc = await vpn._helper("status", vpn_slug)
    if doc.get("state") != "connected":
        if agent and vpn_cred.payload.get("auto_connect") is False:
            _record(slug, last_error=f"Connect '{vpn_cred.name}' in Settings → In&Out, then try again")
            return await view_of(folder)
        view = await vpn._connect(vpn_cred)
        status = view["status"]
        if status["state"] != "connected":
            if status["state"] == "needs_cert":
                reason = "the VPN server's certificate must be trusted in Settings → In&Out"
            else:
                reason = status.get("error") or "the VPN did not connect"
            _record(slug, last_error=f"VPN connect failed: {reason}")
            return await view_of(folder)
    try:
        fdoc = await vpn._helper("mount", slug, mount_spec(folder, vpn_cred, vpn_slug, slug))
    except vpn.VpnError as exc:
        fdoc = {"mounted": False, "error": f"Invalid share settings: {exc}"}
    if fdoc.get("mounted"):
        _record(slug, last_error=None, last_used=vpn._now())
    else:
        _record(slug, last_error=fdoc.get("error") or "Could not mount the network folder")
    return await view_of(folder)


async def test(principal: Any, name: str) -> Dict[str, Any]:
    """Save & test: connect if needed, mount, count files; records last_check."""
    cred = await find_own_folder(principal, name)
    view = await ensure(cred)
    slug = folder_slug_for(cred)
    if view["status"]["mounted"]:
        doc = await vpn._helper("fcheck", slug)
        check = doc.get("check")
        if not isinstance(check, dict):
            check = None
        if check is None:
            check = {"at": vpn._now(), "ok": False, "file_count": None,
                     "message": doc.get("error") or "The folder check failed"}
    else:
        check = {"at": vpn._now(), "ok": False, "file_count": None,
                 "message": view["status"]["error"] or "The folder is not mounted"}
    _record(slug, last_check=check)
    return await view_of(cred)


async def disconnect(principal: Any, name: str) -> Dict[str, Any]:
    """Unmount only; the VPN stays up."""
    cred = await find_own_folder(principal, name)
    slug = folder_slug_for(cred)
    await vpn._helper("umount", slug)
    _record(slug, last_error=None)
    return await view_of(cred)


# ---------------------------------------------------------------------------
# Internal (app-mcp) surface: box-wide
# ---------------------------------------------------------------------------


async def find_by_id(fid: Any) -> Credential:
    if not isinstance(fid, str) or not _ID_RE.fullmatch(fid):
        raise FolderNotFound("unknown network folder id")
    for cred in await box_folders():
        if folder_id(folder_slug_for(cred)) == fid:
            return cred
    raise FolderNotFound("unknown network folder id")


async def internal_view(cred: Credential) -> Dict[str, Any]:
    view = await view_of(cred)
    return {
        "id": view["id"],
        "name": view["name"],
        "vpn": view["vpn"],
        "trusted_for_import": view["trusted_for_import"],
        "mounted": view["status"]["mounted"],
        "mount_path": view["mount_path"],
        "owner_user_id": cred.owner_user_id,
        "status": view["status"],
    }


async def internal_list() -> List[Dict[str, Any]]:
    return [await internal_view(c) for c in await box_folders()]


def split_rel(path: Any) -> List[str]:
    """``a/b/c.pdf`` -> parts; refuses ``..``, NULs and empty paths."""
    if not isinstance(path, str):
        raise vpn.VpnError("path must be a string")
    parts = [p for p in path.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." or "\x00" in p for p in parts):
        raise vpn.VpnError("path must be a file inside the folder")
    return parts


def open_inside(root: str, path: str) -> int:
    """Open a regular file under ``root`` without following any symlink."""
    parts = split_rel(path)
    flags = os.O_RDONLY | os.O_NOFOLLOW
    dfd = os.open(root, flags | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            try:
                nfd = os.open(part, flags | os.O_DIRECTORY, dir_fd=dfd)
            except OSError as exc:
                raise vpn.VpnError(f"Not found: {path} ({exc.strerror})") from None
            os.close(dfd)
            dfd = nfd
        try:
            fd = os.open(parts[-1], flags | os.O_NONBLOCK, dir_fd=dfd)
        except OSError as exc:
            raise vpn.VpnError(f"Not found: {path} ({exc.strerror})") from None
    finally:
        os.close(dfd)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise vpn.VpnError(f"Not a file: {path}")
    return fd


def _hash_fd(fd: int) -> str:
    hasher = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(fd, CHUNK_BYTES, offset)
        if not chunk:
            return hasher.hexdigest()
        hasher.update(chunk)
        offset += len(chunk)


NEEDS_APPROVAL = (
    "This network folder is not marked 'trusted for import'. Ask the user to "
    "turn that on for it on /files/bridge, or call "
    "folder_bridge_import_file_approved so they can approve this file in chat."
)


async def import_file(fid: Any, path: Any, *, approved: bool, storage: Any = None,
                      registry: Any = None) -> Dict[str, Any]:
    """Copy one file from a mounted network folder into the folder owner's
    file store (Storage + ``file_assets``), the server-side twin of the
    browser's ``POST /api/files/import``. Same result shape as the browser."""
    cred = await find_by_id(fid)
    if not approved and not cred.payload.get("trusted_for_import"):
        return {"ok": False, "needsApproval": True, "detail": NEEDS_APPROVAL}
    view = await ensure(cred, agent=True)
    if not view["status"]["mounted"]:
        return {"ok": False, "detail": view["status"]["error"] or "The network folder is not mounted"}
    principal = await _principal_for(cred.owner_user_id)
    result = await store_file(principal, view["mount_path"], path, label=cred.name,
                              storage=storage, registry=registry)
    if result.get("ok"):
        result = {"ok": True, "folderId": fid, **{k: v for k, v in result.items() if k != "ok"}}
    return result


async def store_file(principal: Any, root: str, path: Any, *, label: str,
                     storage: Any = None, registry: Any = None) -> Dict[str, Any]:
    """Copy the regular file ``root/path`` into *principal*'s file store."""
    parts = split_rel(path)
    rel = "/".join(parts)
    fd = await asyncio.to_thread(open_inside, root, rel)
    try:
        size = os.fstat(fd).st_size
        digest = await asyncio.to_thread(_hash_fd, fd)
        filename = parts[-1]
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if storage is None:
            from hermes_cli.filestore import SupabaseStorage, StorageNotConfigured

            try:
                storage = SupabaseStorage.from_env()
            except StorageNotConfigured as exc:
                return {"ok": False, "detail": f"File storage is not configured ({exc})"}
        from hermes_cli.file_registry import default_registry, storage_key

        key = storage_key(principal.user_id, "agent_home", digest, filename)
        hasher = hashlib.sha256()
        sent = 0

        async def chunks() -> AsyncIterator[bytes]:
            nonlocal sent
            while True:
                chunk = await asyncio.to_thread(os.pread, fd, CHUNK_BYTES, sent)
                if not chunk:
                    return
                hasher.update(chunk)
                sent += len(chunk)
                yield chunk

        await storage.upload_stream(key, chunks(), size=size, content_type=content_type)
        if sent != size or hasher.hexdigest() != digest:
            return {"ok": False, "detail": f"{rel} changed while it was being imported; try again"}
        reg = registry if registry is not None else default_registry()
        await reg.initialize()
        asset = await reg.register(
            principal,
            surface="agent_home",
            filename=filename,
            content_type=content_type,
            byte_size=size,
            sha256=digest,
            storage_bucket=storage.bucket,
            storage_path=key,
            conversation=f"{label}/{rel}",
            sender_id=principal.user_id,
            sender_name=getattr(principal, "display", None) or principal.user_id,
        )
    finally:
        os.close(fd)
    return {
        "ok": True,
        "path": rel,
        "assetId": asset.id,
        "filename": asset.filename,
        "size": size,
        "sha256": digest,
        "storageBucket": storage.bucket,
        "storagePath": key,
        "verified": True,
    }
