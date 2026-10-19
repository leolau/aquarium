"""HTTP routes for a person's own Telegram bot (Get ready item 6).

Each signed-in person keeps one ``telegram-bot`` credential
(``telegram/bot``, private to them) holding the @BotFather token they pasted.
Every route acts on the caller's own entry only; responses never carry the
token. Linking: ``/link/start`` returns a one-time ``t.me/<bot>?start=<code>``
link, the person presses Start in Telegram, and ``/link/check`` reads that
message from their bot (``getUpdates``) to record their Telegram id. The
gateway (``gateway/person_telegram_bots.py``) runs a bot only once it is
linked, answers only that Telegram id, and acts only as its owner.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from typing import Any, Dict, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/telegram-bot")

PROVIDER = "telegram"
NAME = "bot"
KIND = "telegram-bot"
CHANGE_MARKER = "telegram_bots.changed"
LINK_CODE_TTL_SECONDS = 15 * 60
_API_BASE = "https://api.telegram.org"


class TelegramCallError(Exception):
    """A Telegram Bot API call failed; the message never contains the token."""


async def telegram_call(token: str, method: str, params: Optional[dict] = None) -> Any:
    """Call ``method`` on the Bot API and return its ``result``."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(f"{_API_BASE}/bot{token}/{method}", json=params or {})
        data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise TelegramCallError(f"could not reach Telegram ({type(exc).__name__})") from None
    if not isinstance(data, dict) or not data.get("ok"):
        desc = str((data or {}).get("description") or f"HTTP {resp.status_code}")
        raise TelegramCallError(desc.replace(token, "***"))
    return data.get("result")


def bot_id_of(token: str) -> str:
    return str(token).split(":", 1)[0]


def touch_change_marker() -> None:
    """Tell a running gateway to re-read the per-person bots now."""
    from hermes_constants import get_hermes_home

    path = get_hermes_home() / CHANGE_MARKER
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(time.time()))
    except OSError:
        logger.debug("could not touch %s", path, exc_info=True)


async def _principal(request: Request):
    from hermes_cli.credentials_api import _principal as resolve

    return await resolve(request, allow_as=False)


def _store():
    from hermes_cli.credentials_api import _store as store

    return store()


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


async def _own_entry(principal):
    cred = await _store().get(principal, PROVIDER, NAME)
    if cred is None or cred.kind != KIND or cred.owner_user_id != principal.user_id:
        return None
    return cred


def _view(cred) -> Dict[str, Any]:
    if cred is None:
        return {"configured": False, "linked": False}
    p = cred.payload
    expires = float(p.get("link_code_expires") or 0)
    return {
        "configured": True,
        "bot_username": p.get("bot_username") or None,
        "bot_name": p.get("bot_name") or None,
        "linked": bool(p.get("linked_user_id")),
        "linked_username": p.get("linked_username") or None,
        "link_pending": bool(p.get("link_code_hash")) and expires > time.time(),
        "last_test_ok": p.get("last_test_ok"),
        "last_test_at": p.get("last_test_at"),
        "last_test_error": p.get("last_test_error") or None,
    }


async def _save(principal, payload: Dict[str, Any]):
    clean = {k: v for k, v in payload.items() if v not in (None, "")}
    return await _store().put(
        principal,
        provider=PROVIDER,
        name=NAME,
        kind=KIND,
        payload=clean,
        services=[],
        visibility=f"private:{principal.user_id}",
    )


async def _require_entry(principal):
    cred = await _own_entry(principal)
    if cred is None:
        raise HTTPException(404, "no Telegram bot saved yet")
    return cred


def _install_bot_id() -> str:
    token = (os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    return bot_id_of(token) if token else ""


async def _others_using(owner_user_id: str, *, bot_id: str = "", tg_user_id: str = "") -> bool:
    for cred in await _store().resolve_by_kind(KIND, provider=PROVIDER):
        if cred.owner_user_id == owner_user_id:
            continue
        p = cred.payload
        if bot_id and str(p.get("bot_id") or bot_id_of(p.get("token", ""))) == bot_id:
            return True
        if tg_user_id and str(p.get("linked_user_id") or "") == tg_user_id:
            return True
    return False


async def _channel_owned_by_someone_else(owner_user_id: str, tg_user_id: str) -> bool:
    """A Telegram id already linked (install bot) to a different person."""
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.web_server import _comms_app_store

        mapped = await PrincipalStore(_comms_app_store()).resolve_by_channel(
            "telegram", tg_user_id
        )
    except Exception:
        logger.debug("channel lookup unavailable", exc_info=True)
        return False
    return mapped is not None and mapped.user_id != owner_user_id


@router.get("")
async def get_bot(request: Request):
    principal = await _principal(request)
    return _view(await _own_entry(principal))


@router.put("")
async def save_bot(request: Request):
    from hermes_cli.telegram_managed_bot import is_valid_telegram_bot_token

    principal = await _principal(request)
    try:
        body = await request.json()
    except ValueError:
        body = None
    token = str((body or {}).get("token") or "").strip() if isinstance(body, dict) else ""
    if not is_valid_telegram_bot_token(token):
        raise HTTPException(400, "invalid_token")
    bot_id = bot_id_of(token)
    if bot_id == _install_bot_id():
        raise HTTPException(409, "install_bot")
    if await _others_using(principal.user_id, bot_id=bot_id):
        raise HTTPException(409, "bot_in_use")
    try:
        me = await telegram_call(token, "getMe")
    except TelegramCallError:
        raise HTTPException(400, "telegram_rejected")
    existing = await _own_entry(principal)
    payload: Dict[str, Any] = {
        "token": token,
        "bot_id": str(me.get("id") or bot_id),
        "bot_username": me.get("username"),
        "bot_name": me.get("first_name"),
        "last_test_ok": True,
        "last_test_at": time.time(),
    }
    if existing is not None and str(existing.payload.get("bot_id")) == payload["bot_id"]:
        for key in ("linked_user_id", "linked_username"):
            payload[key] = existing.payload.get(key)
    cred = await _save(principal, payload)
    touch_change_marker()
    return _view(cred)


@router.post("/test")
async def test_bot(request: Request):
    principal = await _principal(request)
    cred = await _require_entry(principal)
    payload = dict(cred.payload)
    try:
        me = await telegram_call(payload["token"], "getMe")
        payload.update(
            last_test_ok=True,
            last_test_error=None,
            bot_username=me.get("username") or payload.get("bot_username"),
            bot_name=me.get("first_name") or payload.get("bot_name"),
        )
    except TelegramCallError as exc:
        payload.update(last_test_ok=False, last_test_error=str(exc)[:200])
    payload["last_test_at"] = time.time()
    return _view(await _save(principal, payload))


@router.post("/link/start")
async def start_link(request: Request):
    principal = await _principal(request)
    cred = await _require_entry(principal)
    payload = dict(cred.payload)
    if not payload.get("bot_username"):
        raise HTTPException(400, "test_first")
    code = secrets.token_hex(12)
    payload.update(
        link_code_hash=_hash_code(code),
        link_code_expires=time.time() + LINK_CODE_TTL_SECONDS,
        linked_user_id=None,
        linked_username=None,
    )
    view = _view(await _save(principal, payload))
    touch_change_marker()
    return {**view, "link_url": f"https://t.me/{payload['bot_username']}?start={code}"}


@router.post("/link/check")
async def check_link(request: Request):
    principal = await _principal(request)
    cred = await _require_entry(principal)
    payload = dict(cred.payload)
    if payload.get("linked_user_id"):
        return _view(cred)
    code_hash = str(payload.get("link_code_hash") or "")
    if not code_hash or float(payload.get("link_code_expires") or 0) < time.time():
        raise HTTPException(400, "link_expired")
    try:
        updates = await telegram_call(
            payload["token"], "getUpdates", {"timeout": 0, "allowed_updates": ["message"]}
        )
    except TelegramCallError:
        raise HTTPException(502, "telegram_unreachable")
    found = None
    last_id = None
    for upd in updates or []:
        last_id = upd.get("update_id", last_id)
        msg = upd.get("message") or {}
        text = str(msg.get("text") or "")
        if (msg.get("chat") or {}).get("type") != "private" or not text.startswith("/start "):
            continue
        if hmac.compare_digest(_hash_code(text.split(" ", 1)[1].strip()), code_hash):
            found = msg.get("from") or {}
    if last_id is not None:
        try:
            await telegram_call(payload["token"], "getUpdates", {"offset": int(last_id) + 1, "timeout": 0})
        except TelegramCallError:
            pass
    if not found or not found.get("id"):
        return {**_view(cred), "linked": False}
    tg_id = str(found["id"])
    if await _others_using(principal.user_id, tg_user_id=tg_id) or await _channel_owned_by_someone_else(
        principal.user_id, tg_id
    ):
        raise HTTPException(409, "telegram_account_in_use")
    payload.update(
        linked_user_id=tg_id,
        linked_username=found.get("username") or found.get("first_name"),
        link_code_hash=None,
        link_code_expires=None,
    )
    view = _view(await _save(principal, payload))
    touch_change_marker()
    return view


@router.delete("/link")
async def unlink(request: Request):
    principal = await _principal(request)
    cred = await _require_entry(principal)
    payload = dict(cred.payload)
    payload.update(linked_user_id=None, linked_username=None, link_code_hash=None, link_code_expires=None)
    view = _view(await _save(principal, payload))
    touch_change_marker()
    return view


@router.delete("")
async def remove_bot(request: Request):
    principal = await _principal(request)
    await _store().delete(principal, PROVIDER, NAME)
    touch_change_marker()
    return {"configured": False, "linked": False}
