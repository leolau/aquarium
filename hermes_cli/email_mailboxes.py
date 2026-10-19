"""Per-person email mailboxes (IMAP in, SMTP out) — Get ready item 7.

Each person stores their own mailbox as an ``email-imap`` entry in the
unified credential store (provider ``imap``, name = the address, visibility
``private:<user>``). The password never leaves the server: views carry
``password_set`` only. "Test" logs into IMAP and SMTP and logs out again —
no mail is ever sent.

The install-wide poller config (``EMAIL_CONFIG_PATH``) is untouched by this
module; it stays the owner's / install-wide mailbox. The poller reads these
entries in addition and registers each message as the person who owns the
mailbox (see ``custom/email/email_poller.py``).

Runtime state lives in two small JSON files under ``$HERMES_HOME/email/``,
each with a single writer: ``mailbox_tests.json`` (the API's last test
result) and ``mailbox_poll.json`` (the poller's cursor and last outcome).
"""

from __future__ import annotations

import imaplib
import json
import os
import smtplib
import socket
import ssl
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from hermes_cli.credential_store import (
    Credential,
    CredentialError,
    default_credential_store,
    merge_kept_secrets,
)

PROVIDER = "imap"
KIND = "email-imap"
SERVICE = "email"
TIMEOUT_SECONDS = 15

#: Server settings the form fills in for the two common providers. Both need
#: an app password when the account has 2-step sign-in turned on.
PRESETS: Dict[str, Dict[str, Any]] = {
    "gmail": {
        "imap_host": "imap.gmail.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.gmail.com", "smtp_port": 465, "smtp_security": "ssl",
    },
    "outlook": {
        "imap_host": "outlook.office365.com", "imap_port": 993, "imap_security": "ssl",
        "smtp_host": "smtp.office365.com", "smtp_port": 587, "smtp_security": "starttls",
    },
}

_FIELDS = (
    "username", "password", "imap_host", "imap_port", "imap_security",
    "smtp_host", "smtp_port", "smtp_security", "preset",
)
_state_lock = threading.Lock()


class MailboxError(Exception):
    """A request the caller can fix; ``status`` is the HTTP status."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_address(address: Any) -> str:
    value = str(address or "").strip().lower()
    if value.count("@") != 1 or " " in value or len(value) > 254:
        raise MailboxError("address must be an email address")
    return value


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# -- runtime state ----------------------------------------------------------


def _state_dir() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "email"


def _state_path(name: str) -> Path:
    return _state_dir() / f"mailbox_{name}.json"


def _key(owner_user_id: str, address: str) -> str:
    return f"{owner_user_id}/{address}"


def _read_state(name: str) -> Dict[str, Any]:
    try:
        doc = json.loads(_state_path(name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _write_state(name: str, doc: Mapping[str, Any]) -> None:
    path = _state_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".mailbox-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _update_state(name: str, key: str, value: Optional[Mapping[str, Any]]) -> None:
    with _state_lock:
        doc = _read_state(name)
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = dict(value)
        _write_state(name, doc)


def poll_state(owner_user_id: str, address: str) -> Dict[str, Any]:
    return dict(_read_state("poll").get(_key(owner_user_id, address)) or {})


def record_poll(owner_user_id: str, address: str, state: Mapping[str, Any]) -> None:
    """Poller-only writer: cursor (``uidvalidity``/``last_uid``) + outcome."""
    _update_state("poll", _key(owner_user_id, address), state)


def _last_test(owner_user_id: str, address: str) -> Optional[Dict[str, Any]]:
    found = _read_state("tests").get(_key(owner_user_id, address))
    return dict(found) if isinstance(found, dict) else None


# -- connections --------------------------------------------------------------


def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def open_imap(payload: Mapping[str, Any]) -> imaplib.IMAP4:
    """A logged-in IMAP connection for ``payload`` (caller logs out)."""
    host, port = payload["imap_host"], int(payload["imap_port"])
    context = _ssl_context()
    if payload.get("imap_security", "ssl") == "starttls":
        conn = imaplib.IMAP4(host, port, timeout=TIMEOUT_SECONDS)
        conn.starttls(ssl_context=context)
    else:
        conn = imaplib.IMAP4_SSL(host, port, ssl_context=context, timeout=TIMEOUT_SECONDS)
    try:
        conn.login(payload["username"], payload["password"])
    except BaseException:
        try:
            conn.shutdown()
        except Exception:
            pass
        raise
    return conn


def _check_smtp(payload: Mapping[str, Any]) -> None:
    host, port = payload["smtp_host"], int(payload["smtp_port"])
    context = _ssl_context()
    if payload.get("smtp_security", "ssl") == "starttls":
        conn: smtplib.SMTP = smtplib.SMTP(host, port, timeout=TIMEOUT_SECONDS)
        conn.ehlo()
        conn.starttls(context=context)
        conn.ehlo()
    else:
        conn = smtplib.SMTP_SSL(host, port, timeout=TIMEOUT_SECONDS, context=context)
    try:
        conn.login(payload["username"], payload["password"])
    finally:
        try:
            conn.quit()
        except Exception:
            conn.close()


def plain_error(exc: BaseException, server: str) -> str:
    """A user-facing reason that never echoes credentials back."""
    if isinstance(exc, (imaplib.IMAP4.error, smtplib.SMTPAuthenticationError)):
        return "Sign-in failed: check the user name and password (or app password)."
    if isinstance(exc, ssl.SSLError):
        return f"Could not open a secure connection to {server}."
    if isinstance(exc, socket.gaierror):
        return f"Server {server} was not found."
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return f"Server {server} did not answer in time."
    if isinstance(exc, (ConnectionError, OSError)):
        return f"Could not connect to {server}."
    if isinstance(exc, smtplib.SMTPException):
        return f"Server {server} refused the sign-in."
    return f"Could not sign in to {server}."


def check_login(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Log into IMAP and SMTP (no mail sent); per-side ok + plain reason."""
    result: Dict[str, Any] = {"at": _now()}
    try:
        conn = open_imap(payload)
        try:
            conn.logout()
        except Exception:
            pass
        result["imap"] = {"ok": True}
    except Exception as exc:
        result["imap"] = {"ok": False, "error": plain_error(exc, payload["imap_host"])}
    try:
        _check_smtp(payload)
        result["smtp"] = {"ok": True}
    except Exception as exc:
        result["smtp"] = {"ok": False, "error": plain_error(exc, payload["smtp_host"])}
    result["ok"] = result["imap"]["ok"] and result["smtp"]["ok"]
    return result


# -- views --------------------------------------------------------------------


def _state_of(test: Optional[Mapping[str, Any]], poll: Mapping[str, Any]) -> str:
    if poll.get("ok") is False:
        return "needs_attention"
    if test is None:
        return "untested"
    return "working" if test.get("ok") else "needs_attention"


def view_of(cred: Credential) -> Dict[str, Any]:
    payload = cred.payload
    test = _last_test(cred.owner_user_id, cred.name)
    poll = poll_state(cred.owner_user_id, cred.name)
    return {
        "address": cred.name,
        "username": payload.get("username", ""),
        "imap_host": payload.get("imap_host", ""),
        "imap_port": payload.get("imap_port"),
        "imap_security": payload.get("imap_security", "ssl"),
        "smtp_host": payload.get("smtp_host", ""),
        "smtp_port": payload.get("smtp_port"),
        "smtp_security": payload.get("smtp_security", "ssl"),
        "preset": payload.get("preset") or "other",
        "password_set": bool(payload.get("password")),
        "state": _state_of(test, poll),
        "last_test": test,
        "last_poll": {
            k: poll[k] for k in ("at", "ok", "error", "new_count") if k in poll
        } or None,
    }


async def _own_entries(principal: Any) -> List[Credential]:
    """The caller's OWN mailboxes — never another person's, owner included."""
    user_id = getattr(principal, "user_id", None)
    entries = await default_credential_store().list(principal)
    return [
        e for e in entries
        if e.provider == PROVIDER and e.kind == KIND and e.owner_user_id == user_id
    ]


async def _own_entry(principal: Any, address: str) -> Credential:
    for entry in await _own_entries(principal):
        if entry.name == address:
            return entry
    raise MailboxError("no mailbox with that address", 404)


async def list_mine(principal: Any) -> List[Dict[str, Any]]:
    return [view_of(e) for e in await _own_entries(principal)]


def _coerce_port(value: Any, field: str) -> int:
    try:
        port = int(str(value).strip())
    except (TypeError, ValueError):
        raise MailboxError(f"{field} must be a number") from None
    return port


async def save(principal: Any, address: Any, body: Mapping[str, Any]) -> Dict[str, Any]:
    """Create or replace the caller's mailbox; omitted password is kept."""
    address = normalize_address(address)
    if not isinstance(body, Mapping):
        raise MailboxError("body must be an object")
    payload: Dict[str, Any] = {"address": address}
    for field in _FIELDS:
        value = body.get(field)
        if value is None or value == "":
            continue
        if field.endswith("_port"):
            value = _coerce_port(value, field)
        elif field != "password":
            value = str(value).strip()
        payload[field] = value
    if payload.get("preset") not in (None, "other", *PRESETS):
        raise MailboxError("unknown preset")
    existing = None
    try:
        existing = await _own_entry(principal, address)
    except MailboxError:
        pass
    payload = merge_kept_secrets(KIND, payload, existing.payload if existing else None)
    if not payload.get("password"):
        raise MailboxError("password or app password is required")
    store = default_credential_store()
    try:
        cred = await store.put(
            principal,
            provider=PROVIDER,
            name=address,
            kind=KIND,
            payload=payload,
            services=[SERVICE],
            visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise MailboxError(str(exc)) from exc
    if existing is not None and _connection_changed(existing.payload, payload):
        _update_state("tests", _key(cred.owner_user_id, address), None)
    return view_of(cred)


def _connection_changed(old: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    return any(old.get(f) != new.get(f) for f in _FIELDS if f != "preset")


async def delete(principal: Any, address: Any) -> bool:
    address = normalize_address(address)
    await _own_entry(principal, address)
    deleted = await default_credential_store().delete(principal, PROVIDER, address)
    _update_state("tests", _key(principal.user_id, address), None)
    return bool(deleted)


async def run_test(principal: Any, address: Any) -> Dict[str, Any]:
    """Log into the caller's stored mailbox (IMAP + SMTP) and record it."""
    import asyncio

    address = normalize_address(address)
    cred = await _own_entry(principal, address)
    result = await asyncio.to_thread(check_login, cred.payload)
    _update_state("tests", _key(cred.owner_user_id, address), result)
    return view_of(cred)


# -- poller side ----------------------------------------------------------------


async def all_mailboxes() -> List[Credential]:
    """Every person's mailbox, full payload — in-process service use only."""
    entries = await default_credential_store().resolve_for_service(
        SERVICE, provider=PROVIDER
    )
    return [e for e in entries if e.kind == KIND]
