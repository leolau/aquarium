"""HTTP routes for the email poller's per-account enable flag.

Gmail accounts log in with XOAUTH2 (``auth: "xoauth2"``, the default);
IMAP/SMTP mailboxes added under Settings -> Email mailboxes log in with their
stored password (``auth: "password"``) and get the same pipeline.

The deployment email poller (``custom/email/email_poller.py``) polls the
accounts listed in its JSON config where ``enabled`` is true, re-reading the
file every cycle — so writes here take effect on the next poll with no
restart. The config lives outside the credential store: this router is the
settings surface for it, gated to the owner since polling is box-global.

Credential opt-in stays separate: the poller only authenticates accounts that
also hold a credential-store entry with the ``email`` service.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/email-accounts")

DEFAULT_CONFIG_PATH = "/opt/data/email-messages/config.json"

#: Gmail defaults stamped onto entries created by enabling an address that
#: isn't in the poller config yet (the common "just connected a new account"
#: path). XOAUTH2 comes from the credential store — no password fields.
_GMAIL_DEFAULTS: Dict[str, Any] = {
    "imap": {"host": "imap.gmail.com", "port": 993, "tls": True},
    "smtp": {"host": "smtp.gmail.com", "port": 587, "tls": True},
    "folders": ["INBOX"],
    "poll_interval_seconds": 60,
}


def _config_path() -> Path:
    return Path(os.environ.get("EMAIL_CONFIG_PATH") or DEFAULT_CONFIG_PATH)


def _load_config() -> Optional[dict]:
    try:
        doc = json.loads(_config_path().read_text())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _write_config(doc: dict) -> None:
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        mode = 0o600
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".config-")
    os.chmod(tmp, mode)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh, indent=1)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _find_account(accounts: List[dict], address: str) -> Optional[dict]:
    wanted = address.strip().lower()
    for account in accounts:
        if str(account.get("address") or "").strip().lower() == wanted:
            return account
    return None


def _next_account_id(accounts: List[dict]) -> str:
    used = {str(a.get("id") or "") for a in accounts}
    n = 1
    while f"email{n}" in used:
        n += 1
    return f"email{n}"


def _public_entry(account: dict) -> dict:
    return {
        "id": account.get("id"),
        "address": account.get("address"),
        "label": account.get("label"),
        "enabled": bool(account.get("enabled", True)),
        "auth": account.get("auth") or "xoauth2",
    }


async def _mailbox_entry(principal: Any, address: str) -> dict:
    """Poller entry for the owner's own IMAP/SMTP mailbox (password login).

    Server settings are copied from the mailbox; the password stays in the
    credential store and the poller reads it from there each cycle.
    """
    from hermes_cli import email_mailboxes as mb

    try:
        cred = await mb._own_entry(principal, mb.normalize_address(address))
    except mb.MailboxError as exc:
        raise HTTPException(404, "add this mailbox under Email mailboxes first") from exc
    payload = cred.payload
    return {
        "auth": "password",
        "owner_user_id": cred.owner_user_id,
        "imap": {
            "host": payload.get("imap_host"),
            "port": int(payload.get("imap_port") or 993),
            "tls": payload.get("imap_security", "ssl") != "starttls",
        },
        "smtp": {
            "host": payload.get("smtp_host"),
            "port": int(payload.get("smtp_port") or 465),
            "tls": True,
        },
        "folders": ["INBOX"],
        "poll_interval_seconds": 60,
    }


async def _owner_principal(request: Request):
    """Session principal; this is box-global config so it's owner-only."""
    from hermes_cli.web_server import _comms_resolve_principal

    principal = await _comms_resolve_principal(request, allow_as=False)
    if not getattr(principal, "is_owner", False):
        raise HTTPException(403, "email polling is managed by the owner")
    return principal


@router.get("")
async def list_email_accounts(request: Request):
    await _owner_principal(request)
    doc = _load_config()
    accounts = doc.get("accounts") if doc else None
    return {
        "config_present": doc is not None,
        "accounts": [
            _public_entry(a) for a in accounts if isinstance(a, dict)
        ] if isinstance(accounts, list) else [],
    }


@router.patch("")
async def set_email_account_polling(request: Request):
    principal = await _owner_principal(request)
    body = await request.json()
    address = str(body.get("address") or "").strip()
    enabled = bool(body.get("enabled"))
    auth = str(body.get("auth") or "xoauth2")
    if auth not in ("xoauth2", "password"):
        raise HTTPException(400, "auth must be 'xoauth2' or 'password'")
    if "@" not in address:
        raise HTTPException(400, "address must be an email address")
    doc = _load_config() or {"accounts": []}
    accounts = doc.setdefault("accounts", [])
    if not isinstance(accounts, list):
        raise HTTPException(500, "poller config 'accounts' is not a list")
    account = _find_account(accounts, address)
    if account is None:
        if not enabled:
            raise HTTPException(404, "no poller entry for that address")
        defaults = (
            await _mailbox_entry(principal, address)
            if auth == "password" else _GMAIL_DEFAULTS
        )
        account = {
            "id": _next_account_id(accounts),
            "address": address,
            "label": address.split("@", 1)[-1],
            **defaults,
            "enabled": True,
        }
        accounts.append(account)
    else:
        account["enabled"] = enabled
    _write_config(doc)
    return {"account": _public_entry(account)}
