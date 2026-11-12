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
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

KINDS: tuple[str, ...] = ("email", "whatsapp", "calendar")

SET_UP = "set_up"
PARTLY_SET_UP = "partly_set_up"
NOT_SET_UP = "not_set_up"
#: ``missing`` reason: the poller logs in with another person's credential
#: for the caller's address, so the caller's own credential is not used.
OTHER_POLLED = "other_person_polled"

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


def _claim(
    principal: Any,
    matches: Sequence[Any],
    polled: Optional[Any],
    *,
    recorded_owner: str = "",
) -> Optional[Dict[str, bool]]:
    """The caller's stake in one poller account, or None if it isn't theirs.

    ``matches`` are every credential saved for the account's address;
    ``polled`` is the one the poller picks. Only that credential's owner is
    ``credential: True``. Another holder of the address is listed with
    ``polled_by_other`` so the status says whose credential is used.
    ``recorded_owner`` is the account's ``owner_user_id``, if any. With no
    credential and no recorded owner it is a legacy box-wide account,
    which belongs to the install owner.
    """
    user_id = getattr(principal, "user_id", None)
    mine = polled is not None and polled.owner_user_id == user_id
    if not (
        mine
        or any(m.owner_user_id == user_id for m in matches)
        or (recorded_owner and recorded_owner == user_id)
        or (not matches and not recorded_owner and _owns(principal, None))
    ):
        return None
    return {"credential": mine, "polled_by_other": polled is not None and not mine}


def _first(entries: Optional[Iterable[Any]], match: Callable[[Any], bool]) -> Optional[Any]:
    return next((e for e in entries or [] if match(e)), None)


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
            # As email_poller._mailbox_payload: the first stored mailbox for
            # the address, restricted to the recorded owner when there is one.
            owner = str(acct.get("owner_user_id") or "")
            wanted = str(acct.get("address") or "").strip().lower()
            matches = _by_name(imap, address, kind=email_mailboxes.KIND)
            polled = _first(
                (e for e in imap or [] if e.kind == email_mailboxes.KIND),
                lambda e: e.name.lower() == wanted and (not owner or e.owner_user_id == owner),
            )
            claim = _claim(principal, matches, polled, recorded_owner=owner)
        else:
            # As google_oauth.credentials_for_email: first exact name match.
            login = acct.get("google_account") or acct.get("address")
            polled = _first(google, lambda e: e.name == login)
            claim = _claim(principal, _by_name(google, str(login)), polled)
        if claim is None:
            continue
        seen.add(address.lower())
        accounts.append(
            {
                "address": address,
                "auth": "password" if auth == "password" else "xoauth2",
                "enabled": bool(acct.get("enabled", True)),
                **claim,
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
                 "credential": True, "polled_by_other": False, "in_triage": False}
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


def _bridges_elsewhere() -> tuple[set[str], set[int]]:
    """Bridge names and ports recorded by *other* profiles on this box.

    The phone list is box-wide but each profile records its own bridges, so a
    phone whose owner record lives in another profile is that profile's, never
    an unowned legacy phone of this one.
    """
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.wa_bridge_owners import OWNERS_FILE, whatsapp_dir

    here = whatsapp_dir().resolve()
    names: set[str] = set()
    ports: set[int] = set()
    try:
        entries = get_profile_registry()
    except Exception:
        return names, ports
    for entry in entries:
        folder = Path(entry.hermes_home) / "whatsapp"
        if folder.resolve() == here:
            continue
        doc = _read_json(folder / OWNERS_FILE)
        for name, rec in (doc or {}).items():
            if not isinstance(rec, dict) or not rec.get("user_id"):
                continue
            names.add(str(name))
            if isinstance(rec.get("port"), int):
                ports.add(rec["port"])
    return names, ports


async def _whatsapp(principal: Any) -> Dict[str, Any]:
    from hermes_cli import wa_bridge_owners as owners

    path = whatsapp_config_path()
    config = _read_json(path)
    by_port = {port: name for name, port in owners.bridge_ports().items()}
    elsewhere_names, elsewhere_ports = _bridges_elsewhere()
    accounts: List[Dict[str, Any]] = []
    on_triage: set[str] = set()
    for phone in (config or {}).get("phones") or []:
        if not isinstance(phone, dict):
            continue
        session = phone.get("session_dir")
        name = by_port.get(phone.get("bridge_port")) or (
            owners.bridge_name_for_session_path(session) if session else None
        )
        person = owners.bridge_person(name) if name else None
        if person is None and (name in elsewhere_names or phone.get("bridge_port") in elsewhere_ports):
            continue
        if not _owns(principal, person):
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
        # As calendar_poller: credentials_for_email('calendar', row email).
        raw = row.get("email")
        claim = _claim(principal, _by_name(google, email), _first(google, lambda e: e.name == raw))
        if claim is None:
            continue
        accounts.append(
            {
                "id": str(row.get("id") or email),
                "label": str(row.get("label") or email),
                "address": email,
                "enabled": bool(row.get("enabled", 1)),
                **claim,
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
            elif any(
                a["in_triage"] and a["enabled"] and a.get("polled_by_other") for a in accounts
            ):
                missing.append(OTHER_POLLED)
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
        # The work_request gate: a skill may only auto-start work when the
        # channel config says ``triage.auto_work`` — read live, like the
        # pollers read it, so the page shows the flag that would apply now.
        "auto_work": bool((config or {}).get("triage", {}).get("auto_work")),
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


class _InScope:
    """``principal`` without the install-owner claim on unowned legacy setups.

    Legacy box-wide accounts belong to the install owner, i.e. the acting
    profile's owner; another profile's owner (``?profile=``) never gets them.
    """

    def __init__(self, principal: Any) -> None:
        self.user_id = getattr(principal, "user_id", None)
        self.role = getattr(principal, "role", None)
        self.is_owner = False


def can_edit(principal: Any) -> bool:
    """Triage skill files are box-wide: owner/admin edit, members view."""
    from hermes_cli.route_roles import ADMIN_ROLES

    return bool(getattr(principal, "is_owner", False)) or getattr(principal, "role", None) in ADMIN_ROLES


async def triage_status(principal: Any, *, install_owner: bool = True) -> Dict[str, Any]:
    if not install_owner:
        principal = _InScope(principal)
    kinds = [await _email(principal), await _whatsapp(principal), await _calendar(principal)]
    units = [s["unit"] for k in kinds for s in k["services"]]
    states = unit_states(units)
    for k in kinds:
        for s in k["services"]:
            s["state"] = states.get(s["unit"])
    return {"kinds": kinds}


# -- triage skill files (view / edit / history) --------------------------------

MAX_SKILL_FILE_BYTES = 256 * 1024
VERSIONS_DIR = ".versions"


class SkillFileError(Exception):
    """A triage skill file request that can't be served (``status`` = HTTP)."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def kind_config(kind: str) -> tuple[Path, Optional[Dict[str, Any]]]:
    path = {"email": email_config_path, "whatsapp": whatsapp_config_path, "calendar": calendar_config_path}[kind]()
    return path, _read_json(path)


def triage_file(kind: str, path: str) -> Path:
    """``path`` if it is one of the ``*.md`` files ``kind``'s pipeline reads.

    Only files listed by :func:`skill_sources` are addressable, so a request
    can never reach another file (no traversal, no symlink out of the folder).
    """
    if kind not in KINDS:
        raise SkillFileError(404, f"unknown triage kind: {kind!r}")
    _, config = kind_config(kind)
    for source in skill_sources(kind, config):
        for f in source["files"]:
            if f["path"] == path:
                file = Path(path)
                if file.resolve().parent != Path(source["path"]).resolve():
                    break
                return file
    raise SkillFileError(404, f"{path!r} is not a {kind} triage skill file")


def _history_path(file: Path) -> Path:
    return file.parent / VERSIONS_DIR / f"{file.name}.jsonl"


def file_history(file: Path) -> List[Dict[str, Any]]:
    """Saved versions of ``file``, newest first."""
    try:
        lines = _history_path(file).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict) and isinstance(rec.get("content"), str):
            out.append(rec)
    return list(reversed(out))


def _append_version(file: Path, content: str, *, author: str, message: str) -> Dict[str, Any]:
    import time

    hist = _history_path(file)
    hist.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    rec = {
        "id": f"{int(now * 1000)}-{len(file_history(file)) + 1}",
        "at": now,
        "author": author,
        "message": message,
        "content": content,
    }
    with hist.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec) + "\n")
    return rec


def write_triage_file(file: Path, content: str, *, author: str) -> Dict[str, Any]:
    """Replace ``file`` (atomically) and record the new version.

    The first edit also stores the file as it was, so History always holds
    the pre-edit text. The pipelines read the file on the next message.
    """
    import tempfile

    if len(content.encode("utf-8")) > MAX_SKILL_FILE_BYTES:
        raise SkillFileError(413, "triage skill file is too large")
    try:
        before = file.read_text(encoding="utf-8")
        if not file_history(file):
            _append_version(file, before, author="system", message="Before the first edit")
        mode = file.stat().st_mode & 0o777
        fd, tmp = tempfile.mkstemp(dir=str(file.parent), prefix=f".{file.name}.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
            os.chmod(tmp, mode)
            os.replace(tmp, file)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return _append_version(file, content, author=author, message="Edited in Agent Profiles")
    except OSError as exc:
        raise SkillFileError(500, f"could not save {file.name}: {exc.strerror or exc}") from exc

