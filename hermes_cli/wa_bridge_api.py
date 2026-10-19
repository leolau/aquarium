"""HTTP routes for managing the deployment's WhatsApp bridge units.

The WhatsApp sidecar (``scripts/whatsapp-bridge/bridge.js``) runs as
``hermes-wa-bridge-<name>.service`` units, one per linked phone, each with a
session dir under ``<HERMES_HOME>/whatsapp/session-<name>``. Pairing state
lives on disk: ``creds.json`` marks a linked session, ``qr.txt`` holds the
pending pairing payload while the bridge waits for a scan.

This router is the Settings surface for those units: list/status, fetch the
pending QR payload, restart (refresh), stop, rebind (wipe session + restart
to force a fresh QR), and provision a new bridge unit. Service control goes
through the hermes user's NOPASSWD systemctl grant; unit provisioning goes
through the root-owned ``/usr/local/sbin/hermes-wa-bridge-add`` (a reviewed
copy of ``deploy/hermes-wa-bridge-add``, sudoers rule in
``deploy/sudoers.d/hermes-wa-bridge``). Never the checkout's copy: the hermes
user can write the checkout, so sudo-running it would hand that user root.

Bridges are per person (``hermes_cli.wa_bridge_owners``): anyone signed in can
add one, and it belongs to them. Only that person sees its QR (authentication
material), controls it or sends its test message; owner/admin see other
people's bridges as a status only. A bridge with no recorded person (made
before this, e.g. by hand) belongs to the install owner, as before.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import wa_bridge_owners as owners

router = APIRouter(prefix="/api/wa-bridges")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_UNIT_PREFIX = "hermes-wa-bridge-"
#: qr.txt older than this is almost certainly dead — Baileys rotates the
#: payload every ~60s while unpaired.
_QR_STALE_SECONDS = 90
#: Root-owned install of deploy/hermes-wa-bridge-add; the sudoers rule names it.
_ADD_HELPER = "/usr/local/sbin/hermes-wa-bridge-add"
_NOT_YOURS = "Only the person who added this WhatsApp bridge can do this."
TEST_MESSAGE = (
    "Test message from Aquarium: this WhatsApp bridge works. "
    "Only you received this."
)


def _wa_dir() -> Path:
    return owners.whatsapp_dir()


def _unit_name(name: str) -> str:
    return f"{_UNIT_PREFIX}{name}.service"


def _session_dir(name: str) -> Path:
    return _wa_dir() / f"session-{name}"


def _valid_name(name: str) -> str:
    name = name.strip().lower()
    if not _NAME_RE.match(name):
        raise HTTPException(400, "bridge name must be lowercase letters, digits, hyphens")
    return name


def _systemctl(*args: str, sudo: bool = True) -> subprocess.CompletedProcess:
    cmd = (["sudo", "-n"] if sudo else []) + ["systemctl", *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=15)


def _is_active(name: str) -> str:
    try:
        out = _systemctl("is-active", _unit_name(name), sudo=False)
        return out.stdout.strip() or "unknown"
    except Exception:
        return "unknown"


def _service_control(name: str, verb: str) -> None:
    try:
        out = _systemctl(verb, _unit_name(name))
    except subprocess.TimeoutExpired:
        raise HTTPException(504, f"systemctl {verb} timed out")
    if out.returncode != 0:
        detail = (out.stderr or out.stdout).strip() or "unknown error"
        raise HTTPException(502, f"systemctl {verb} failed: {detail}")


def _bridge_names() -> List[str]:
    """Bridge names from unit files (enabled or not) plus stray session dirs."""
    names = set()
    try:
        out = _systemctl(
            "list-unit-files", f"{_UNIT_PREFIX}*.service", "--no-legend",
            sudo=False,
        )
        for line in out.stdout.splitlines():
            unit = line.split()[0] if line.split() else ""
            if unit.startswith(_UNIT_PREFIX) and unit.endswith(".service"):
                names.add(unit[len(_UNIT_PREFIX):-len(".service")])
    except Exception:
        pass
    wa = _wa_dir()
    if wa.is_dir():
        for d in wa.iterdir():
            if d.is_dir() and d.name.startswith("session-"):
                names.add(d.name[len("session-"):])
    return sorted(n for n in names if _NAME_RE.match(n))


def _describe(name: str) -> Dict[str, Any]:
    sess = _session_dir(name)
    qr = sess / "qr.txt"
    qr_age: Optional[float] = None
    try:
        qr_age = time.time() - qr.stat().st_mtime
    except OSError:
        pass
    return {
        "name": name,
        "unit": _unit_name(name),
        "active": _is_active(name),
        "paired": (sess / "creds.json").is_file(),
        "qr_pending": qr.is_file(),
        "qr_age_seconds": round(qr_age) if qr_age is not None else None,
        "qr_stale": qr_age is not None and qr_age > _QR_STALE_SECONDS,
    }


def _add_helper_installed() -> bool:
    return Path(_ADD_HELPER).is_file()


_OPERATOR = SimpleNamespace(user_id="", display="", role="owner", is_owner=True)


def _is_owner(principal: Any) -> bool:
    return bool(getattr(principal, "is_owner", False)) or (
        getattr(principal, "role", None) == "owner"
    )


def _is_admin(principal: Any) -> bool:
    return _is_owner(principal) or getattr(principal, "role", None) == "admin"


async def _caller(request: Request):
    """The signed-in person. No multi-user datastore = single-user install,
    where the operator is the owner (same rule as ``route_roles``)."""
    from hermes_cli.web_server import _CommsNotConfigured, _comms_resolve_principal

    try:
        return await _comms_resolve_principal(request, allow_as=False)
    except _CommsNotConfigured:
        return _OPERATOR


def _is_persons(name: str, principal: Any, recorded: Dict[str, Dict[str, Any]]) -> bool:
    rec = recorded.get(name)
    if rec:
        return rec["user_id"] == getattr(principal, "user_id", None)
    return _is_owner(principal)


async def _require_bridge_person(request: Request, name: str):
    """403 unless the caller is the person this bridge belongs to."""
    principal = await _caller(request)
    if not _is_persons(name, principal, owners.load_owners()):
        raise HTTPException(403, _NOT_YOURS)
    return principal


def _status(desc: Dict[str, Any]) -> str:
    active = desc["active"]
    if active == "active":
        if desc["qr_pending"]:
            return "waiting_for_qr"
        return "connected" if desc["paired"] else "not_linked"
    if active == "activating":
        return "restarting"
    if active == "failed":
        return "failed"
    return "stopped"


def _mine(name: str) -> Dict[str, Any]:
    desc = _describe(name)
    desc["status"] = _status(desc)
    desc["number"] = owners.mask_number(owners.own_number(name))
    return desc


async def _displays(user_ids: List[str]) -> Dict[str, str]:
    if not user_ids:
        return {}
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.web_server import _comms_app_store

        found = await PrincipalStore(_comms_app_store()).list_principals(
            user_ids=user_ids
        )
        return {p.user_id: p.display or p.user_id for p in found}
    except Exception:
        return {}


async def _owner_user_id() -> Optional[str]:
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.web_server import _comms_app_store

        owner = await PrincipalStore(_comms_app_store()).get_owner()
        return owner.user_id if owner else None
    except Exception:
        return None


@router.get("")
async def list_bridges(request: Request):
    """The caller's own bridges in full; for owner/admin, everyone else's as a
    status only (person + state, never the QR, number or controls)."""
    principal = await _caller(request)
    recorded = owners.load_owners()
    mine: List[Dict[str, Any]] = []
    others: List[Dict[str, Any]] = []
    for name in _bridge_names():
        if _is_persons(name, principal, recorded):
            mine.append(_mine(name))
        elif _is_admin(principal):
            rec = recorded.get(name)
            others.append({
                "name": name,
                "person": rec["user_id"] if rec else None,
                "status": _status(_describe(name)),
            })
    if others:
        install_owner = None
        if any(o["person"] is None for o in others):
            install_owner = await _owner_user_id()
        for o in others:
            o["person"] = o["person"] or install_owner or ""
        names = await _displays(sorted({o["person"] for o in others if o["person"]}))
        for o in others:
            o["person_display"] = names.get(o["person"], o["person"] or "Owner")
    return {
        "bridges": mine,
        "others": others,
        "can_add": _add_helper_installed(),
    }


@router.get("/{name}/qr")
async def get_qr(request: Request, name: str):
    """The pending pairing payload. Auth material — its person only, never logged."""
    name = _valid_name(name)
    await _require_bridge_person(request, name)
    qr = _session_dir(name) / "qr.txt"
    try:
        payload = qr.read_text().strip()
    except OSError:
        raise HTTPException(404, "no pending QR — bridge is paired or not running")
    if not payload:
        raise HTTPException(404, "QR file is empty")
    age = round(time.time() - qr.stat().st_mtime)
    return {"payload": payload, "age_seconds": age, "stale": age > _QR_STALE_SECONDS}


@router.post("/{name}/restart")
async def restart_bridge(request: Request, name: str):
    name = _valid_name(name)
    await _require_bridge_person(request, name)
    _service_control(name, "restart")
    return {"bridge": _mine(name)}


@router.post("/{name}/stop")
async def stop_bridge(request: Request, name: str):
    name = _valid_name(name)
    await _require_bridge_person(request, name)
    _service_control(name, "stop")
    return {"bridge": _mine(name)}


@router.post("/{name}/rebind")
async def rebind_bridge(request: Request, name: str):
    """Wipe the session and restart — the bridge emits a fresh QR to scan."""
    name = _valid_name(name)
    await _require_bridge_person(request, name)
    sess = _session_dir(name)
    _service_control(name, "stop")
    if sess.is_dir():
        backup = sess.with_name(f"{sess.name}.rebind-{int(time.time())}")
        try:
            sess.rename(backup)
        except OSError as exc:
            _service_control(name, "start")
            raise HTTPException(500, f"could not move session aside: {exc}")
    try:
        sess.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(500, f"could not recreate session dir: {exc}")
    _service_control(name, "start")
    return {"bridge": _mine(name)}


_PORT_RE = re.compile(r"--port[ =]+(\d+)")


def _bridge_port(name: str) -> Optional[int]:
    """Port the bridge listens on: recorded at add time, else the
    ``WHATSAPP_BRIDGES`` map, else ``--port`` in its unit file."""
    port = owners.recorded_port(name)
    if port:
        return port
    for part in os.getenv("WHATSAPP_BRIDGES", "").split(","):
        bname, sep, bport = part.strip().partition(":")
        if sep and bname.strip() == name and bport.strip().isdigit():
            return int(bport.strip())
    try:
        out = _systemctl("cat", _unit_name(name), sudo=False)
    except Exception:
        return None
    match = _PORT_RE.search(out.stdout or "")
    return int(match.group(1)) if match else None


def _post_send(port: int, chat_id: str, message: str) -> tuple[int, Dict[str, Any]]:
    body = json.dumps({"chatId": chat_id, "message": message}).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/send",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read() or b"{}")
        except ValueError:
            data = {}
        return exc.code, data


@router.post("/{name}/test")
async def send_test(request: Request, name: str):
    """Send one test message to the bridge's own number (never anyone else)."""
    name = _valid_name(name)
    await _require_bridge_person(request, name)
    desc = _describe(name)
    number = owners.own_number(name)
    if not desc["paired"] or desc["active"] != "active" or desc["qr_pending"] or not number:
        raise HTTPException(409, "Link the phone first: scan the QR code with WhatsApp.")
    port = _bridge_port(name)
    if not port:
        raise HTTPException(409, "Could not find which port this bridge uses.")
    try:
        status, data = await asyncio.to_thread(
            _post_send, port, f"{number}@s.whatsapp.net", TEST_MESSAGE
        )
    except (OSError, ValueError):
        raise HTTPException(502, "The WhatsApp bridge did not answer. Try Restart.")
    if status == 503:
        raise HTTPException(409, "The bridge is not connected to WhatsApp yet.")
    if status >= 400 or not data.get("success"):
        raise HTTPException(502, "WhatsApp did not accept the test message.")
    return {"sent": True, "to": owners.mask_number(number)}


@router.post("")
async def add_bridge(request: Request):
    """Provision a new bridge unit via the root-owned add helper (sudo); the
    bridge belongs to the person who added it."""
    principal = await _caller(request)
    body = await request.json()
    name = _valid_name(str(body.get("name") or ""))
    if _unit_name(name) in {
        _unit_name(n) for n in _bridge_names()
    }:
        raise HTTPException(409, f"bridge '{name}' already exists")
    if not _add_helper_installed():
        raise HTTPException(
            501,
            f"{_ADD_HELPER} is not installed on this host "
            "(see docs/deployment/PRODUCTION.md, WhatsApp bridges)",
        )
    try:
        out = subprocess.run(
            ["sudo", "-n", _ADD_HELPER, name],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "bridge provisioning timed out")
    if out.returncode != 0:
        detail = (out.stderr or out.stdout).strip() or "provisioning failed"
        raise HTTPException(502, detail)
    person = getattr(principal, "user_id", "") or await _owner_user_id()
    if person:
        match = re.search(r"on port (\d+)", out.stdout or "")
        owners.record_owner(name, person, port=int(match.group(1)) if match else None)
    return {"bridge": _mine(name)}
