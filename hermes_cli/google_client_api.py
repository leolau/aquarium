"""Owner-only HTTP routes for Google step A: the install's OAuth client.

Get ready item 4, step A. The owner registers this Aquarium with Google once
(a Google Cloud OAuth client of type "Desktop app") and hands the client to
the server here. It is written to ``$HERMES_HOME/google-workspace/
client_secret.json`` (0600), the file :func:`load_google_client` already
reads, so step B (each person's own Connected accounts) picks it up with no
other change. The client secret is never returned.

An existing client (from that file, the legacy file or env) is reported as
done and is only overwritten with an explicit ``replace``; the old file is
kept beside it as ``client_secret.json.replaced-<timestamp>``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import google_oauth
from hermes_cli.route_roles import OWNER as _OWNER

router = APIRouter(prefix="/api/google-client")

#: Steps 1–5 are done in the Google Cloud console, which Aquarium can't see,
#: so the owner ticks them; step 6 is "a client is saved".
TICK_STEPS = ("1", "2", "3", "4", "5")
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$")
_SECRET_RE = re.compile(r"^\S{1,200}$")
_MAX_JSON_BYTES = 64 * 1024


def _workspace_dir() -> Path:
    return google_oauth.google_client_paths()[0].parent


def _state_path() -> Path:
    return _workspace_dir() / "setup_state.json"


def _read_state() -> Dict[str, Any]:
    try:
        doc = json.loads(_state_path().read_text())
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _atomic_write(path: Path, text: str) -> None:
    if not path.parent.exists():
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-")
    try:
        os.chmod(tmp, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _write_state(state: Dict[str, Any]) -> None:
    _atomic_write(_state_path(), json.dumps(state, indent=2))


def _record_check(result: str) -> Dict[str, Any]:
    state = _read_state()
    state["last_check"] = {"result": result, "at": int(time.time())}
    _write_state(state)
    return state["last_check"]


def _id_hint(client_id: str) -> str:
    suffix = ".apps.googleusercontent.com"
    head = client_id[: -len(suffix)] if client_id.endswith(suffix) else client_id
    shown = head[:8] + "…" if len(head) > 8 else head
    return shown + (suffix if client_id.endswith(suffix) else "")


def setup_scopes() -> list:
    """Every scope step B can ask for, for the consent screen (step 4)."""
    scopes = list(google_oauth.IDENTITY_SCOPES) + list(google_oauth.WORKSPACE_SCOPES)
    gmail_at = max(i for i, s in enumerate(scopes) if "/auth/gmail." in s) + 1
    scopes.insert(gmail_at, "https://mail.google.com/")
    return list(dict.fromkeys(scopes))


def _status() -> Dict[str, Any]:
    client = google_oauth.resolve_google_client()
    state = _read_state()
    saved = state.get("steps")
    steps: Dict[str, Any] = saved if isinstance(saved, dict) else {}
    return {
        "configured": client is not None,
        "source": client["source"] if client else None,
        "client_type": client["client_type"] if client else None,
        "client_id_hint": _id_hint(client["client_id"]) if client else None,
        "steps": {n: bool(steps.get(n)) for n in TICK_STEPS},
        "last_check": state.get("last_check"),
        "scopes": setup_scopes(),
        "redirect_uri": google_oauth.REDIRECT_URI,
    }


def _parse_client(body: Dict[str, Any]) -> Dict[str, Any]:
    """The client document to store, from an uploaded file or pasted values."""
    raw = body.get("client_json")
    if raw:
        if not isinstance(raw, str) or len(raw.encode()) > _MAX_JSON_BYTES:
            raise HTTPException(400, "too_large")
        try:
            doc = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "not_json")
        kind = next((k for k in ("installed", "web") if isinstance(doc, dict)
                     and isinstance(doc.get(k), dict)), None)
        if kind is None:
            raise HTTPException(400, "not_client_file")
        section = dict(doc[kind])
    else:
        kind = "installed"
        section = {
            "client_id": body.get("client_id"),
            "client_secret": body.get("client_secret"),
            "auth_uri": google_oauth.AUTH_URL,
            "token_uri": google_oauth.TOKEN_URI,
            "redirect_uris": ["http://localhost"],
        }
    client_id = str(section.get("client_id") or "").strip()
    client_secret = str(section.get("client_secret") or "").strip()
    if not _CLIENT_ID_RE.match(client_id):
        raise HTTPException(400, "bad_client_id")
    if not _SECRET_RE.match(client_secret):
        raise HTTPException(400, "missing_secret")
    section["client_id"] = client_id
    section["client_secret"] = client_secret
    return {kind: section}


async def _check(client_id: str, client_secret: str) -> str:
    return await asyncio.to_thread(
        google_oauth.check_google_client, client_id, client_secret
    )


@router.get("", dependencies=_OWNER)
async def get_google_client(request: Request):
    return _status()


@router.put("", dependencies=_OWNER)
async def save_google_client(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "invalid_request")
    if google_oauth.resolve_google_client() is not None and body.get("replace") is not True:
        raise HTTPException(409, "client_exists")
    doc = _parse_client(body)
    section = next(iter(doc.values()))
    result = await _check(section["client_id"], section["client_secret"])
    if result != google_oauth.CLIENT_CHECK_OK:
        # Nothing is written: a client Google rejects would break step B
        # for everyone, and an existing working client must stay in place.
        return {"saved": False, "check": result, "client": _status()}
    path = google_oauth.google_client_paths()[0]
    if path.exists():
        backup = path.with_name(f"{path.name}.replaced-{int(time.time())}")
        shutil.copy2(path, backup)
        os.chmod(backup, 0o600)
    _atomic_write(path, json.dumps(doc, indent=2))
    _record_check(result)
    return {"saved": True, "check": result, "client": _status()}


@router.post("/test", dependencies=_OWNER)
async def test_google_client(request: Request):
    client = google_oauth.resolve_google_client()
    if client is None:
        return {"check": "missing", "client": _status()}
    result = await _check(client["client_id"], client["client_secret"])
    _record_check(result)
    return {"check": result, "client": _status()}


@router.put("/steps", dependencies=_OWNER)
async def save_google_client_steps(request: Request):
    body = await request.json()
    steps = body.get("steps") if isinstance(body, dict) else None
    if not isinstance(steps, dict) or not all(
        k in TICK_STEPS and isinstance(v, bool) for k, v in steps.items()
    ):
        raise HTTPException(400, "invalid_steps")
    state = _read_state()
    saved = state.get("steps")
    current: Dict[str, Any] = saved if isinstance(saved, dict) else {}
    state["steps"] = {n: bool(steps.get(n, current.get(n, False))) for n in TICK_STEPS}
    _write_state(state)
    return _status()
