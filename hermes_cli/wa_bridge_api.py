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
user can write the checkout, so sudo-running it would hand that user root. All
routes are owner-gated — bridges are box-global and the QR payload is
authentication material.
"""

from __future__ import annotations

import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(prefix="/api/wa-bridges")

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
_UNIT_PREFIX = "hermes-wa-bridge-"
#: qr.txt older than this is almost certainly dead — Baileys rotates the
#: payload every ~60s while unpaired.
_QR_STALE_SECONDS = 90
#: Root-owned install of deploy/hermes-wa-bridge-add; the sudoers rule names it.
_ADD_HELPER = "/usr/local/sbin/hermes-wa-bridge-add"


def _wa_dir() -> Path:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home) / "whatsapp"


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


async def _owner_principal(request: Request):
    from hermes_cli.web_server import _comms_resolve_principal

    principal = await _comms_resolve_principal(request, allow_as=False)
    if not getattr(principal, "is_owner", False):
        raise HTTPException(403, "WhatsApp bridges are managed by the owner")
    return principal


@router.get("")
async def list_bridges(request: Request):
    await _owner_principal(request)
    return {"bridges": [_describe(n) for n in _bridge_names()]}


@router.get("/{name}/qr")
async def get_qr(request: Request, name: str):
    """The pending pairing payload. Auth material — owner only, never logged."""
    await _owner_principal(request)
    name = _valid_name(name)
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
    await _owner_principal(request)
    name = _valid_name(name)
    _service_control(name, "restart")
    return {"bridge": _describe(name)}


@router.post("/{name}/stop")
async def stop_bridge(request: Request, name: str):
    await _owner_principal(request)
    name = _valid_name(name)
    _service_control(name, "stop")
    return {"bridge": _describe(name)}


@router.post("/{name}/rebind")
async def rebind_bridge(request: Request, name: str):
    """Wipe the session and restart — the bridge emits a fresh QR to scan."""
    await _owner_principal(request)
    name = _valid_name(name)
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
    return {"bridge": _describe(name)}


@router.post("")
async def add_bridge(request: Request):
    """Provision a new bridge unit via the root-owned add helper (sudo)."""
    await _owner_principal(request)
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
    return {"bridge": _describe(name)}
