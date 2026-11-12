"""Read-only triage status for the signed-in person (email, WhatsApp, calendar).

Each triage pipeline is a set of standalone services under ``custom/`` that read
their own JSON config, a credential, and a folder of skill files. This module
reads those same sources — never writes them — and reports, for one caller:

* which accounts of **theirs** each pipeline would process (another person's
  mailbox, number or calendar is never counted or returned);
* which triage skill files the pipeline loads (path, name, present);
* where each kind is configured in agent-home.

No secret leaves this module: credentials are only checked for existence and
ownership; payloads, passwords and tokens are never copied into the result.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

KINDS: tuple[str, ...] = ("email", "whatsapp", "calendar")

SET_UP = "set_up"
PARTLY_SET_UP = "partly_set_up"
NOT_SET_UP = "not_set_up"

# The pipelines' own config locations (custom/*/): the same constants and
# environment overrides the services read, so this never drifts from them.
WHATSAPP_CONFIG_PATH = "/opt/data/whatsapp-messages/config.json"
CALENDAR_CONFIG_DEFAULT = "/opt/data/calendar/config.json"
CALENDAR_DB_DEFAULT = "/opt/data/calendar/calendar_data.db"

# ``load_skills`` fallbacks when a config has no ``triage.skills_dirs``.
DEFAULT_SKILL_DIRS: Dict[str, tuple[str, ...]] = {
    "email": ("/opt/data/skills/whatsapp-triage", "/opt/data/skills/email-triage"),
    "whatsapp": ("/opt/data/skills/whatsapp-triage",),
    "calendar": ("/opt/data/skills/calendar-triage",),
}
DEFAULT_SKILL_SUBDIRS: tuple[str, ...] = ("custom",)

SOURCE_DIRS: Dict[str, str] = {
    "email": "custom/skills/email-triage",
    "whatsapp": "custom/skills/whatsapp-triage",
    "calendar": "custom/skills/calendar-triage",
}

SERVICE_UNITS: Dict[str, tuple[str, ...]] = {
    "email": ("hermes-email-poller.service", "hermes-email-batcher.service", "hermes-email-triage.service"),
    "whatsapp": ("hermes-wa-batcher.service", "hermes-wa-triage.service"),
    "calendar": ("hermes-calendar-poller.service", "hermes-calendar-triage.service"),
}

LABELS: Dict[str, str] = {"email": "Email", "whatsapp": "WhatsApp", "calendar": "Calendar"}

# agent-home Settings → In & out hosts Mailboxes, Connected accounts and
# WhatsApp bridges; Google sign-in has its own sub-page.
SETUP_LINKS: Dict[str, List[Dict[str, str]]] = {
    "email": [
        {"label": "Mailboxes", "href": "/settings/in-out"},
        {"label": "Connect Google", "href": "/settings/in-out/google"},
    ],
    "whatsapp": [{"label": "WhatsApp bridges", "href": "/settings/in-out"}],
    "calendar": [
        {"label": "Connected accounts", "href": "/settings/in-out"},
        {"label": "Connect Google", "href": "/settings/in-out/google"},
    ],
}


# -- config sources ------------------------------------------------------------


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def email_config_path() -> Path:
    from hermes_cli.email_accounts_api import _config_path

    return _config_path()


def whatsapp_config_path() -> Path:
    return Path(WHATSAPP_CONFIG_PATH)


def calendar_config_path() -> Path:
    return Path(os.environ.get("CALENDAR_CONFIG_PATH") or CALENDAR_CONFIG_DEFAULT)


def calendar_db_path() -> Path:
    return Path(os.environ.get("CALENDAR_DB_PATH") or CALENDAR_DB_DEFAULT)


# -- skills --------------------------------------------------------------------


def _str_list(value: Any) -> Optional[List[str]]:
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    return None


def skill_sources(kind: str, config: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The folders ``load_skills`` reads for ``kind``, with their ``*.md`` files.

    Mirrors ``custom/*/…triage_agent.load_skills``: ``triage.skills_dirs`` (or
    the built-in fallback), each also scanned under ``triage.skills_subdirs``
    (default ``custom``); ``*.md`` only, so a ``.md.disabled`` file is off.
    """
    triage = (config or {}).get("triage")
    triage = triage if isinstance(triage, dict) else {}
    dirs = _str_list(triage.get("skills_dirs")) or list(DEFAULT_SKILL_DIRS[kind])
    subdirs = _str_list(triage.get("skills_subdirs"))
    if subdirs is None:
        subdirs = list(DEFAULT_SKILL_SUBDIRS)
    out: List[Dict[str, Any]] = []
    for base in dirs:
        base_path = Path(base)
        for folder, layer in [(base_path, "base")] + [(base_path / s, "custom") for s in subdirs]:
            files = sorted(folder.glob("*.md")) if folder.is_dir() else []
            out.append(
                {
                    "name": folder.name if layer == "base" else f"{base_path.name}/{folder.name}",
                    "path": str(folder),
                    "layer": layer,
                    "present": folder.is_dir(),
                    "files": [{"name": f.name, "path": str(f), "present": True} for f in files],
                }
            )
    return out


def _skills_present(sources: Sequence[Dict[str, Any]]) -> bool:
    return any(s["files"] for s in sources)


# -- ownership -----------------------------------------------------------------


def _owns(principal: Any, owner_user_id: Optional[str]) -> bool:
    """``owner_user_id`` empty/None = legacy box-wide setup → the install owner's."""
    if owner_user_id:
        return owner_user_id == getattr(principal, "user_id", None)
    return bool(getattr(principal, "is_owner", False))


async def _service_credentials(service: str, provider: str) -> Optional[List[Any]]:
    """Every entry opting into ``service`` (None = store unreadable)."""
    from hermes_cli.credential_store import default_credential_store

    try:
        return await default_credential_store().resolve_for_service(service, provider=provider)
    except Exception:
        return None


def _claimed(principal: Any, matches: Sequence[Any]) -> Optional[bool]:
    """Whether the caller holds a credential among ``matches``.

    ``True``: the caller owns one (an address saved by several people counts
    for each of them). ``False``: no credential at all, so an unowned legacy
    account — the install owner's. ``None``: only other people hold it.
    """
    user_id = getattr(principal, "user_id", None)
    if any(m.owner_user_id == user_id for m in matches):
        return True
    if not matches and _owns(principal, None):
        return False
    return None


def _by_name(entries: Optional[Iterable[Any]], name: str, *, kind: Optional[str] = None) -> List[Any]:
    want = (name or "").strip().lower()
    return [
        e for e in (entries or [])
        if str(getattr(e, "name", "")).strip().lower() == want
        and (kind is None or getattr(e, "kind", None) == kind)
    ]


# -- per-kind detection --------------------------------------------------------


async def _email(principal: Any) -> Dict[str, Any]:
    from hermes_cli import email_mailboxes

    path = email_config_path()
    config = _read_json(path)
    imap = await _service_credentials(email_mailboxes.SERVICE, email_mailboxes.PROVIDER)
    google = await _service_credentials("email", "google")
    accounts: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for acct in (config or {}).get("accounts") or []:
        if not isinstance(acct, dict):
            continue
        address = str(acct.get("address") or "").strip()
        if not address:
            continue
        auth = str(acct.get("auth") or "xoauth2").lower()
        if auth == "password":
            matches = _by_name(imap, address, kind=email_mailboxes.KIND)
            owner = str(acct.get("owner_user_id") or "")
            if owner:
                # The poller logs in only as the recorded owner.
                if not _owns(principal, owner):
                    continue
                matches = [m for m in matches if m.owner_user_id == owner]
                has_credential = bool(matches)
            else:
                claimed = _claimed(principal, matches)
                if claimed is None:
                    continue
                has_credential = claimed
        else:
            claimed = _claimed(principal, _by_name(google, str(acct.get("google_account") or address)))
            if claimed is None:
                continue
            has_credential = claimed
        seen.add(address.lower())
        accounts.append(
            {
                "address": address,
                "auth": "password" if auth == "password" else "xoauth2",
                "enabled": bool(acct.get("enabled", True)),
                "credential": has_credential,
                "in_triage": True,
            }
        )
    # The caller's own IMAP mailboxes the poller config doesn't list: polled
    # into the inbound registry but never triaged.
    for entry in imap or []:
        if (
            entry.kind == email_mailboxes.KIND
            and entry.owner_user_id == getattr(principal, "user_id", None)
            and entry.name.lower() not in seen
        ):
            accounts.append(
                {"address": entry.name, "auth": "password", "enabled": True,
                 "credential": True, "in_triage": False}
            )
    return _kind_result("email", path, config, accounts, credentials_checked=imap is not None and google is not None)


def _linked_digits(session: Optional[Path]) -> Optional[str]:
    """Digits of the number linked in ``session/creds.json`` (as ``own_number``)."""
    if session is None:
        return None
    doc = _read_json(session / "creds.json")
    me = (doc or {}).get("me")
    jid = str((me if isinstance(me, dict) else {}).get("id") or "")
    digits = re.split(r"[:@]", jid, maxsplit=1)[0]
    return digits if digits.isdigit() else None


def _wa_number(session: Optional[Path], configured: Any) -> Optional[str]:
    from hermes_cli import wa_bridge_owners

    masked = wa_bridge_owners.mask_number(_linked_digits(session))
    if masked:
        return masked
    text = str(configured or "")
    if "*" in text:
        return text
    digits = "".join(ch for ch in text if ch.isdigit())
    return wa_bridge_owners.mask_number(digits) if digits else None


async def _whatsapp(principal: Any) -> Dict[str, Any]:
    from hermes_cli import wa_bridge_owners as owners

    path = whatsapp_config_path()
    config = _read_json(path)
    by_port = {port: name for name, port in owners.bridge_ports().items()}
    accounts: List[Dict[str, Any]] = []
    on_triage: set[str] = set()
    for phone in (config or {}).get("phones") or []:
        if not isinstance(phone, dict):
            continue
        session = phone.get("session_dir")
        name = by_port.get(phone.get("bridge_port")) or (
            owners.bridge_name_for_session_path(session) if session else None
        )
        if not _owns(principal, owners.bridge_person(name) if name else None):
            continue
        if name:
            on_triage.add(name)
        # The batcher reads the phone's configured session_dir; a bridge-owned
        # session under HERMES_HOME is the fallback when the config names none.
        session_path = Path(str(session)).expanduser() if session else (
            owners.session_dir(name) if name else None
        )
        accounts.append(
            {
                "id": str(phone.get("id") or name or ""),
                "label": str(phone.get("name") or phone.get("id") or name or ""),
                "number": _wa_number(session_path, phone.get("number")),
                "enabled": bool(phone.get("enabled", True)),
                "credential": bool(session_path and (session_path / "creds.json").is_file()),
                "in_triage": True,
            }
        )
    user_id = getattr(principal, "user_id", None)
    for name, record in owners.load_owners().items():
        if record.get("user_id") == user_id and name not in on_triage:
            accounts.append(
                {"id": name, "label": name, "number": _wa_number(owners.session_dir(name), None), "enabled": True,
                 "credential": (owners.session_dir(name) / "creds.json").is_file(), "in_triage": False}
            )
    return _kind_result("whatsapp", path, config, accounts, credentials_checked=True)


def _calendar_rows(config: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    db = calendar_db_path()
    if db.is_file():
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            try:
                conn.row_factory = sqlite3.Row
                rows = conn.execute("SELECT id, email, label, enabled FROM calendar_accounts").fetchall()
            finally:
                conn.close()
            return [dict(r) for r in rows]
        except sqlite3.Error:
            pass
    cal = (config or {}).get("calendar")
    listed = cal.get("accounts") if isinstance(cal, dict) else None
    return [a for a in (listed or []) if isinstance(a, dict)]


async def _calendar(principal: Any) -> Dict[str, Any]:
    path = calendar_config_path()
    config = _read_json(path)
    google = await _service_credentials("calendar", "google")
    accounts: List[Dict[str, Any]] = []
    for row in _calendar_rows(config):
        email = str(row.get("email") or "").strip()
        if not email:
            continue
        claimed = _claimed(principal, _by_name(google, email))
        if claimed is None:
            continue
        accounts.append(
            {
                "id": str(row.get("id") or email),
                "label": str(row.get("label") or email),
                "address": email,
                "enabled": bool(row.get("enabled", 1)),
                "credential": claimed,
                "in_triage": True,
            }
        )
    return _kind_result("calendar", path, config, accounts, credentials_checked=google is not None)


# -- status --------------------------------------------------------------------


def _kind_result(
    kind: str,
    config_path: Path,
    config: Optional[Dict[str, Any]],
    accounts: List[Dict[str, Any]],
    *,
    credentials_checked: bool,
) -> Dict[str, Any]:
    skills = skill_sources(kind, config)
    present = _skills_present(skills)
    ready = [a for a in accounts if a["in_triage"] and a["enabled"] and a["credential"]]
    missing: List[str] = []
    if not accounts:
        missing.append("account")
    else:
        if not ready:
            if not any(a["in_triage"] for a in accounts):
                missing.append("triage")
            elif not any(a["in_triage"] and a["enabled"] for a in accounts):
                missing.append("enabled")
            else:
                missing.append("credential")
        if not present:
            missing.append("skills")
    if not accounts:
        status = NOT_SET_UP
    elif ready and present:
        status = SET_UP
    else:
        status = PARTLY_SET_UP
    return {
        "kind": kind,
        "label": LABELS[kind],
        "status": status,
        "missing": missing,
        "accounts": accounts,
        "skills_present": present,
        "skills": skills,
        "skills_source": SOURCE_DIRS[kind],
        "config": {"path": str(config_path), "present": config is not None},
        "credentials_checked": credentials_checked,
        "setup_links": SETUP_LINKS[kind],
        "services": [{"unit": u, "state": None} for u in SERVICE_UNITS[kind]],
    }


def unit_states(units: Sequence[str]) -> Dict[str, str]:
    """``systemctl is-active`` per unit; empty when systemd is unreachable."""
    try:
        proc = subprocess.run(
            ["systemctl", "is-active", *units],
            capture_output=True, text=True, timeout=3, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    lines = proc.stdout.split()
    return dict(zip(units, lines)) if len(lines) == len(units) else {}


async def triage_status(principal: Any) -> Dict[str, Any]:
    kinds = [await _email(principal), await _whatsapp(principal), await _calendar(principal)]
    units = [s["unit"] for k in kinds for s in k["services"]]
    states = unit_states(units)
    for k in kinds:
        for s in k["services"]:
            s["state"] = states.get(s["unit"])
    return {"kinds": kinds}
