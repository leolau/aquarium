"""HTTP routes for the unified credential store.

The per-user management surface behind agent-home's Settings →
*Connected accounts*: list/detail (redacted), create/replace, toggle
``services``/``visibility``, delete, and the Google OAuth2 start/complete
flow. Mounted by ``web_server.py`` beside the todos router.

Design doc: ``docs/design/unified-credential-store.md`` §7. Secrets never
leave through this router: every response body goes through
``Credential.redacted()``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli.credential_store import (
    CREDENTIAL_KINDS,
    CredentialError,
    default_credential_store,
    merge_kept_secrets,
)
from hermes_cli.google_oauth import (
    GoogleOAuthError,
    authorized_user_payload,
    build_authorization_url,
    connect_scopes,
    email_from_id_token,
    exchange_code,
    fetch_userinfo_email,
    generate_pkce,
    load_google_client,
    parse_code_or_url,
    refresh_access_token,
    scopes_for_services,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/credentials")

_PENDING_TTL_SECONDS = 600


async def _principal(request: Request, *, allow_as: bool):
    """Resolve the C1 principal (lazy import to avoid a circular import)."""
    from hermes_cli.web_server import _comms_resolve_principal

    return await _comms_resolve_principal(request, allow_as=allow_as)


def _store():
    return default_credential_store()


def _pending_path(user_id: str) -> Path:
    from hermes_constants import get_hermes_home

    return (
        get_hermes_home() / "credentials-pending" / (user_id or "_") / "google.json"
    )


def _write_pending(user_id: str, doc: dict) -> None:
    path = _pending_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".pending-")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_pending(user_id: str) -> Optional[dict]:
    path = _pending_path(user_id)
    try:
        doc = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if time.time() - float(doc.get("created_at", 0)) > _PENDING_TTL_SECONDS:
        path.unlink(missing_ok=True)
        return None
    return doc


def _delete_pending(user_id: str) -> None:
    _pending_path(user_id).unlink(missing_ok=True)


async def _own_entry(store: Any, principal: Any, provider: str, name: str):
    """The caller's own entry (``put``/``delete`` only ever touch those)."""
    for entry in await store.list(principal):
        if (
            entry.provider == provider
            and entry.name == name
            and entry.owner_user_id == principal.user_id
        ):
            return entry
    return None


@router.get("")
async def list_credentials(request: Request):
    principal = await _principal(request, allow_as=True)
    store = _store()
    try:
        entries = await store.list(principal)
    except CredentialError as exc:
        raise HTTPException(400, str(exc))
    return {"credentials": [e.redacted() for e in entries]}


@router.get("/{provider}/{name}")
async def get_credential(request: Request, provider: str, name: str):
    principal = await _principal(request, allow_as=True)
    entry = await _store().get(principal, provider, name)
    if entry is None:
        raise HTTPException(404, "credential not found or not visible")
    return {"credential": entry.redacted()}


@router.put("/{provider}/{name}")
async def put_credential(request: Request, provider: str, name: str):
    principal = await _principal(request, allow_as=False)
    body = await request.json()
    store = _store()
    kind = str(body.get("kind") or "")
    payload = dict(body.get("payload") or {})
    spec = CREDENTIAL_KINDS.get(kind)
    from hermes_cli import telegram_bot_api, vpn

    if kind == telegram_bot_api.KIND or (
        provider == telegram_bot_api.PROVIDER
        and getattr(await _own_entry(store, principal, provider, name), "kind", None)
        == telegram_bot_api.KIND
    ):
        # Linking must go through /api/telegram-bot (it proves the Telegram id).
        raise HTTPException(409, "manage your Telegram bot under /api/telegram-bot")
    if provider == vpn.PROVIDER:
        # VPNs and network folders share provider "fortinet" (and so one name
        # space per owner): never let one silently replace the other.
        clash = await _own_entry(store, principal, provider, name)
        if clash is not None and clash.kind != kind:
            raise HTTPException(409, f"'{name}' is already used by a {clash.kind} entry")
    if spec is not None and spec.keep_secrets_on_put:
        existing = await _own_entry(store, principal, provider, name)
        if existing is not None and existing.kind == kind:
            payload = merge_kept_secrets(kind, payload, existing.payload)
    try:
        entry = await store.put(
            principal,
            provider=provider,
            name=name,
            kind=kind,
            payload=payload,
            services=body.get("services"),
            visibility=body.get("visibility"),
        )
    except CredentialError as exc:
        raise HTTPException(400, str(exc))
    return {"credential": entry.redacted()}


@router.patch("/{provider}/{name}")
async def patch_credential(request: Request, provider: str, name: str):
    principal = await _principal(request, allow_as=False)
    body = await request.json()
    try:
        entry = await _store().patch(
            principal,
            provider,
            name,
            services=body.get("services"),
            visibility=body.get("visibility"),
        )
    except CredentialError as exc:
        raise HTTPException(400, str(exc))
    if entry is None:
        raise HTTPException(404, "credential not found")
    return {"credential": entry.redacted()}


@router.delete("/{provider}/{name}")
async def delete_credential(request: Request, provider: str, name: str):
    principal = await _principal(request, allow_as=False)
    store = _store()
    from hermes_cli import vpn

    if provider == vpn.PROVIDER:
        from hermes_cli import vpn_folders

        existing = await _own_entry(store, principal, provider, name)
        if existing is not None and existing.kind == vpn.KIND:
            try:
                await vpn.forget(existing)
            except Exception:  # noqa: BLE001 - deleting must still work
                logger.warning("VPN disconnect before delete failed", exc_info=True)
        elif existing is not None and existing.kind == vpn_folders.KIND:
            try:
                await vpn_folders.forget(existing)
            except Exception:  # noqa: BLE001 - deleting must still work
                logger.warning("network folder unmount before delete failed", exc_info=True)
    deleted = await store.delete(principal, provider, name)
    if not deleted:
        raise HTTPException(404, "credential not found")
    if provider == "telegram":
        from hermes_cli.telegram_bot_api import touch_change_marker

        touch_change_marker()
    return {"deleted": True}


@router.post("/google/start")
async def google_start(request: Request):
    principal = await _principal(request, allow_as=False)
    body = await request.json()
    services = body.get("services") or ["workspace"]
    name = str(body.get("name") or "").strip() or None
    try:
        from hermes_cli.credential_store import validate_services

        clean_services = validate_services(services)
        if not clean_services:
            raise CredentialError("at least one service is required")
        client_id, _client_secret = load_google_client()
    except (CredentialError, GoogleOAuthError) as exc:
        raise HTTPException(400, str(exc))
    pkce = generate_pkce()
    requested_scopes = connect_scopes(clean_services)
    _write_pending(
        principal.user_id,
        {
            "state": pkce["state"],
            "code_verifier": pkce["code_verifier"],
            "services": clean_services,
            "scopes": requested_scopes,
            "name": name,
            "client_id": client_id,
            "created_at": time.time(),
        },
    )
    auth_url = build_authorization_url(
        client_id=client_id,
        scopes=requested_scopes,
        state=pkce["state"],
        code_challenge=pkce["code_challenge"],
        login_hint=name,
    )
    return {
        "auth_url": auth_url,
        "state": pkce["state"],
        "expires_in": _PENDING_TTL_SECONDS,
    }


@router.post("/google/complete")
async def google_complete(request: Request):
    principal = await _principal(request, allow_as=False)
    body = await request.json()
    pending = _read_pending(principal.user_id)
    if pending is None:
        raise HTTPException(409, "no pending Google authorization; call start first")
    try:
        code, state = parse_code_or_url(str(body.get("code_or_url") or ""))
        if state is not None and state != pending.get("state"):
            raise GoogleOAuthError("state mismatch — restart the flow")
        client_id, client_secret = load_google_client()
        if pending.get("client_id") and pending["client_id"] != client_id:
            raise GoogleOAuthError("OAuth client changed mid-flow; restart")
        token_doc = exchange_code(
            client_id=client_id,
            client_secret=client_secret,
            code=code,
            code_verifier=str(pending.get("code_verifier") or ""),
        )
    except GoogleOAuthError as exc:
        raise HTTPException(400, str(exc))
    if not token_doc.get("refresh_token"):
        raise HTTPException(
            400, "Google returned no refresh token; re-run start and approve "
            "offline access"
        )
    email = email_from_id_token(str(token_doc.get("id_token") or ""))
    if email is None:
        email = fetch_userinfo_email(str(token_doc.get("access_token") or ""))
    name = email or str(pending.get("name") or "").strip()
    if not name:
        raise HTTPException(
            400, "could not determine the Google account email; retry with a "
            "named start"
        )
    services = list(pending.get("services") or [])
    payload = authorized_user_payload(
        token_doc=token_doc,
        client_id=client_id,
        client_secret=client_secret,
        scopes=list(pending.get("scopes") or scopes_for_services(services)),
    )
    try:
        entry = await _store().put(
            principal,
            provider="google",
            name=name,
            kind="google-oauth2",
            payload=payload,
            services=services,
        )
    except CredentialError as exc:
        raise HTTPException(400, str(exc))
    _delete_pending(principal.user_id)
    return {
        "credential": entry.redacted(),
        "account_email": email,
        "granted_scopes": payload.get("scopes", []),
    }


@router.post("/google/{name}/refresh")
async def google_refresh(request: Request, name: str):
    principal = await _principal(request, allow_as=False)
    store = _store()
    entry = await store.get(principal, "google", name)
    if entry is None:
        raise HTTPException(404, "credential not found or not visible")
    payload = entry.payload
    try:
        token_doc = refresh_access_token(
            client_id=str(payload.get("client_id") or ""),
            client_secret=str(payload.get("client_secret") or ""),
            refresh_token=str(payload.get("refresh_token") or ""),
        )
    except GoogleOAuthError as exc:
        raise HTTPException(502, str(exc))
    fragment = {
        "token": token_doc.get("access_token", ""),
    }
    if token_doc.get("refresh_token"):
        fragment["refresh_token"] = token_doc["refresh_token"]
    won = await store.update_tokens(
        "google",
        name,
        owner_user_id=entry.owner_user_id,
        old_refresh_token=str(payload.get("refresh_token") or ""),
        payload_fragment=fragment,
    )
    return {"refreshed": True, "write_won": won}
