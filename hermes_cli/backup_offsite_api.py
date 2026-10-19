"""Offsite backups for Get ready (item 10). Owner only.

The real work runs as root in ``/usr/local/sbin/aquarium offsite <verb>`` (installed from
``deploy/aquarium.py``; sudoers rule ``deploy/sudoers.d/hermes-backup`` allows exactly those
verbs). This router only checks the role, passes settings to the helper on stdin and shapes
its JSON answer for the page. Storage secrets go to the helper once and are never sent back:
the helper keeps them in root-only ``/etc/aquarium/offsite.env``.
"""

from __future__ import annotations

import datetime as _dt
import json
import subprocess
from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hermes_cli.route_roles import OWNER

router = APIRouter(prefix="/api/backups/offsite")

#: Root-owned install of deploy/aquarium.py; the sudoers rule names it.
_HELPER = "/usr/local/sbin/aquarium"
#: A nightly copy older than this means the schedule is not working.
_STALE_HOURS = 48
_UNAVAILABLE = "Offsite backups can't be set up on this server yet."


class OffsiteSettings(BaseModel):
    provider: Literal["b2", "s3", "other"]
    bucket: str = Field(min_length=3, max_length=63)
    key_id: str = Field(min_length=4, max_length=256)
    secret: str = Field(default="", max_length=512)
    endpoint: str = Field(default="", max_length=300)
    region: str = Field(default="", max_length=40)
    prefix: Optional[str] = Field(default=None, max_length=100)
    time: str = Field(default="03:00", max_length=5)
    keep_days: int = Field(default=30, ge=1, le=3650)
    schedule: bool = True


def _helper_argv(verb: str) -> list[str]:
    return ["sudo", "-n", _HELPER, "offsite", verb]


def _call(verb: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 30) -> Dict[str, Any]:
    """Run one helper verb; return its JSON answer (``{"ok": False, "error": ...}`` on failure)."""
    try:
        proc = subprocess.run(
            _helper_argv(verb),
            input=json.dumps(payload).encode() if payload is not None else b"",
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return {"ok": False, "unavailable": True, "error": _UNAVAILABLE}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "The storage service took too long to answer. Try again."}
    for line in reversed(proc.stdout.decode(errors="replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                break
    # No JSON: sudo refused (rule not installed) or an old helper without `offsite`.
    return {"ok": False, "unavailable": True, "error": _UNAVAILABLE}


def _age_hours(at: str) -> Optional[float]:
    try:
        then = _dt.datetime.fromisoformat(at)
    except (TypeError, ValueError):
        return None
    return (_dt.datetime.now(_dt.timezone.utc) - then).total_seconds() / 3600


def _view(raw: Dict[str, Any]) -> Dict[str, Any]:
    """What the page needs: a state, the target without secrets, the last results."""
    if raw.get("unavailable"):
        return {"available": False, "state": "unavailable", "configured": False}
    configured = bool(raw.get("configured"))
    good = raw.get("last_good_backup") or None
    last = raw.get("last_backup") or None
    test = raw.get("last_restore_test") or None
    schedule = raw.get("schedule") or {"enabled": True, "time": "03:00", "keep_days": 30}
    if not configured:
        state = "not_configured"
    elif raw.get("running"):
        state = "running"
    elif last and not last.get("ok"):
        state = "backup_failed"
    elif not good:
        state = "needs_first_backup"
    elif schedule.get("enabled") and (_age_hours(good.get("at", "")) or 0) > _STALE_HOURS:
        state = "backup_late"
    elif test and not test.get("ok"):
        state = "restore_test_failed"
    elif not test:
        state = "needs_restore_test"
    else:
        state = "ok"
    target = raw.get("target") if configured else None
    return {
        "available": True,
        "configured": configured,
        "state": state,
        "target": target,
        "schedule": schedule,
        "running": raw.get("running") or None,
        "last_backup": last,
        "last_good_backup": good,
        "last_restore_test": test,
        "last_check": raw.get("last_check") or None,
        "copies": raw.get("copies"),
        "key_exists": bool(raw.get("key_exists")),
    }


def _fail(answer: Dict[str, Any]) -> HTTPException:
    if answer.get("unavailable"):
        return HTTPException(503, _UNAVAILABLE)
    return HTTPException(400, str(answer.get("error") or "That did not work. Try again."))


@router.get("", dependencies=OWNER)
async def offsite_status():
    return _view(_call("status"))


@router.put("", dependencies=OWNER)
async def offsite_configure(body: OffsiteSettings):
    """Check the storage with the given key, then save it. Nothing is saved if the check fails."""
    answer = _call("configure", body.model_dump(), timeout=120)
    if not answer.get("ok"):
        raise _fail(answer)
    out: Dict[str, Any] = {"status": _view(answer.get("status") or _call("status"))}
    if answer.get("new_key"):
        out["new_key"] = answer["new_key"]  # shown once so the owner can keep it elsewhere
    return out


@router.delete("", dependencies=OWNER)
async def offsite_remove():
    answer = _call("remove")
    if not answer.get("ok"):
        raise _fail(answer)
    return _view(_call("status"))


@router.post("/test", dependencies=OWNER)
async def offsite_test():
    answer = _call("test", timeout=90)
    if not answer.get("ok"):
        raise _fail(answer)
    return _view(answer.get("status") or _call("status"))


@router.post("/run", status_code=202, dependencies=OWNER)
async def offsite_run():
    answer = _call("run")
    if not answer.get("ok"):
        raise _fail(answer)
    return {"started": bool(answer.get("started")), "status": _view(answer.get("status") or {})}


@router.post("/restore-test", status_code=202, dependencies=OWNER)
async def offsite_restore_test():
    answer = _call("restore-test")
    if not answer.get("ok"):
        raise _fail(answer)
    return {"started": bool(answer.get("started")), "status": _view(answer.get("status") or {})}
