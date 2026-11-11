"""Settings → Software upgrade (agent-home). The owner and admins upgrade and roll back.

The work runs as root in ``/usr/local/sbin/aquarium upgrade <verb>`` (installed from
``deploy/aquarium.py``; ``deploy/sudoers.d/aquarium-upgrade`` allows exactly the verbs
status, releases, check, start and rollback). ``start``/``rollback`` hand the job to a
transient systemd unit, so it keeps going while this dashboard restarts. This router
checks the role, re-checks the caller's own password, and shapes the helper's JSON for the
page: release notes become short highlight lists, and paths are stripped from error
text and the technical log before they leave the server.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import re
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from hermes_cli.route_roles import ADMIN

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/software-upgrade")

#: Root-owned install of deploy/aquarium.py; the sudoers rule names it.
_HELPER = "/usr/local/sbin/aquarium"
_UNAVAILABLE = "Software upgrades can't be run from here on this server yet."
_VERSION_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,40}))?$")
#: Absolute paths (two or more segments) in helper text the browser will see.
_PATH_RE = re.compile(r"(?<![\w.:/-])/(?:[\w.@+-]+/)+[\w.@+-]*")
_SECRETISH_RE = re.compile(r"(?i)\b(password|secret|token|key)=\S+")
_HIGHLIGHTS_PER_SECTION = 6


class StartBody(BaseModel):
    version: str = Field(min_length=2, max_length=60)
    password: str = Field(min_length=1, max_length=512)


class RollbackBody(BaseModel):
    password: str = Field(min_length=1, max_length=512)


def _helper_argv(verb: str) -> List[str]:
    return ["sudo", "-n", _HELPER, "upgrade", verb]


def _call(verb: str, payload: Optional[Dict[str, Any]] = None, timeout: float = 60) -> Dict[str, Any]:
    """Run one helper verb; return its JSON answer (``{"ok": False, ...}`` on failure)."""
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
        return {"ok": False, "error": "The server took too long to answer. Try again."}
    for line in reversed(proc.stdout.decode(errors="replace").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                answer = json.loads(line)
            except ValueError:
                break
            return answer if isinstance(answer, dict) else {"ok": False, "error": _UNAVAILABLE}
    # No JSON: sudo refused (rule not installed) or an older helper without `upgrade`.
    return {"ok": False, "unavailable": True, "error": _UNAVAILABLE}


# --------------------------------------------------------------------------- shaping


def scrub(text: Any, limit: int = 400) -> str:
    """Helper text for the browser: no filesystem paths, nothing that looks like a secret."""
    out = _PATH_RE.sub("…", str(text or ""))
    out = _SECRETISH_RE.sub(lambda m: f"{m.group(1)}=…", out)
    return out[:limit]


def version_key(tag: str) -> Optional[Tuple]:
    """Sort key for ``vX.Y.Z[-pre]``: a pre-release sorts before its release; None if not a version."""
    m = _VERSION_RE.match(tag or "")
    if not m:
        return None
    major, minor, patch, pre = m.groups()
    pre_key: Tuple = ((1,),) if pre is None else tuple(
        (0, int(p), "") if p.isdigit() else (0, -1, p) for p in pre.split("."))
    return (int(major), int(minor), int(patch), pre_key)


def highlights(notes: str) -> List[Dict[str, Any]]:
    """Release notes (GitHub Markdown) → ``[{title, items}]`` bullet lists for the page."""
    sections: List[Dict[str, Any]] = []
    current: Dict[str, Any] = {"title": "", "items": []}
    for raw in (notes or "").splitlines():
        line = raw.strip()
        heading = re.match(r"^#{1,4}\s+(.*)$", line)
        if heading:
            if current["items"]:
                sections.append(current)
            current = {"title": _plain(heading.group(1))[:80], "items": []}
            continue
        bullet = re.match(r"^[-*+]\s+(.*)$", line)
        if bullet and len(current["items"]) < _HIGHLIGHTS_PER_SECTION:
            item = _plain(bullet.group(1))
            if item:
                current["items"].append(item[:200])
    if current["items"]:
        sections.append(current)
    return sections[:4]


def _plain(md: str) -> str:
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", md)  # links / images → their text
    text = re.sub(r"[*_`]{1,3}", "", text)
    text = re.sub(r"\s*\(?#\d+\)?$", "", text)  # trailing PR numbers
    return text.strip()


def select_releases(releases: List[Dict[str, Any]], installed: Optional[str], channel: str) -> Dict[str, Any]:
    """Split the release list for the page.

    ``newer``: releases above the installed version (all of them when the install is a
    branch checkout with no version), newest first. Pre-releases only on the beta
    channel. ``latest``: the newest of ``newer`` — the page's default choice.
    ``older``: rollback targets below the installed version.
    """
    beta = channel == "beta"
    here = version_key(installed or "")
    rows = []
    for rel in releases:
        key = version_key(str(rel.get("tag", "")))
        if key is None or (rel.get("prerelease") and not beta):
            continue
        rows.append((key, {
            "tag": rel["tag"],
            "name": str(rel.get("name") or rel["tag"])[:200],
            "published_at": str(rel.get("published_at") or ""),
            "prerelease": bool(rel.get("prerelease")),
            "url": rel.get("url") if str(rel.get("url", "")).startswith("https://github.com/") else "",
            "highlights": highlights(str(rel.get("notes") or "")),
        }))
    rows.sort(key=lambda r: r[0], reverse=True)
    newer = [r for k, r in rows if here is None or k > here]
    older = [r for k, r in rows if here is not None and k < here]
    return {"newer": newer, "older": older, "latest": newer[0]["tag"] if newer else None}


def _job_view(job: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not job:
        return None
    steps = [{"key": str(s.get("key", "")), "state": str(s.get("state", "pending")),
              "started": s.get("started") or None, "finished": s.get("finished") or None}
             for s in job.get("steps") or [] if isinstance(s, dict)]
    phase = str(job.get("phase") or "")
    return {
        "id": str(job.get("id") or ""),
        "kind": "rollback" if job.get("kind") == "rollback" else "upgrade",
        "from": job.get("from") or None,
        "to": job.get("to") or None,
        "by": scrub(job.get("by"), 80) or None,
        "started": job.get("started") or None,
        "finished": job.get("finished") or None,
        "running": phase in ("starting", "running") and bool(job.get("alive", True)),
        "result": job.get("result") or None,
        "error": scrub(job.get("error")) or None,
        "steps": steps,
        "log": [scrub(line, 300) for line in (job.get("log") or [])][-200:],
    }


def _sha(value: Any) -> Optional[str]:
    return value[:9] if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{4,40}", value) else None


def _checkout_view(raw: Any) -> Optional[Dict[str, Any]]:
    """A branch checkout's comparison with its branch on GitHub (``None`` when not compared)."""
    if not isinstance(raw, dict):
        return None
    behind = raw.get("behind")
    return {
        "branch": scrub(raw.get("branch"), 80) or None,
        "commit": _sha(raw.get("commit")),
        "behind": behind if isinstance(behind, int) and not isinstance(behind, bool) and behind >= 0 else None,
        "tip": _sha(raw.get("tip")),
        "commits": [{"sha": _sha(c.get("sha")), "title": scrub(c.get("title"), 200),
                     "date": str(c.get("date") or "")[:40] or None}
                    for c in (raw.get("commits") or [])[:20] if isinstance(c, dict)],
        "error": scrub(raw.get("error")) or None,
    }


def status_view(raw: Dict[str, Any], rel: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """What the page needs from ``upgrade status`` (+ ``upgrade releases``)."""
    if raw.get("unavailable") or not raw.get("ok"):
        return {"available": False, "error": scrub(raw.get("error")) or _UNAVAILABLE}
    inst = raw.get("installed") or {}
    installed = {
        "version": inst.get("version") or None,
        "label": scrub(inst.get("label"), 80),
        "commit": inst.get("commit") or None,
        "kind": "release" if inst.get("layout") == "release" else "checkout",
        "channel": "beta" if inst.get("channel") == "beta" else "stable",
        "installed_at": inst.get("installed_at") or None,
        "by": scrub(inst.get("by"), 80) or None,
    }
    out: Dict[str, Any] = {
        "available": True,
        "installed": installed,
        "job": _job_view(raw.get("job")),
        "history": [{
            "id": str(h.get("id") or ""),
            "kind": "rollback" if h.get("kind") == "rollback" else "upgrade",
            "from": h.get("from") or None, "to": h.get("to") or None,
            "by": scrub(h.get("by"), 80) or None,
            "started": h.get("started") or None, "finished": h.get("finished") or None,
            "seconds": h.get("seconds"), "result": h.get("result") or None,
            "error": scrub(h.get("error")) or None,
        } for h in raw.get("history") or [] if isinstance(h, dict)],
        "checked_at": raw.get("releases_checked_at") or None,
        "rollback_to": (raw.get("rollback") or {}).get("to") or None,
    }
    if rel is not None:
        packaged_only = installed["kind"] == "release"
        listed = [r for r in rel.get("releases") or [] if not packaged_only or r.get("packaged")]
        out["releases"] = select_releases(listed, installed["version"], installed["channel"])
        out["checked_at"] = rel.get("checked_at") or out["checked_at"]
        out["release_error"] = scrub(rel.get("error")) or None
        out["checkout"] = _checkout_view(rel.get("checkout")) if installed["kind"] == "checkout" else None
    return out


def _fail(answer: Dict[str, Any]) -> HTTPException:
    if answer.get("unavailable"):
        return HTTPException(503, _UNAVAILABLE)
    return HTTPException(400, scrub(answer.get("error")) or "That did not work. Try again.")


# --------------------------------------------------------------------------- password re-check


async def _confirm_password(request: Request, password: str) -> str:
    """Re-check the signed-in owner's or admin's own password; return the name for the history.

    Uses the same ``dashboard_auth`` provider the login used (Supabase's password grant
    on agent-home installs), with the login page's per-IP attempt limit. A caller with
    no interactive password login (operator token, OAuth-only) is refused: upgrades from
    there go through ``sudo aquarium update`` on the server.
    """
    from hermes_cli import web_server as ws
    from hermes_cli.dashboard_auth import get_provider
    from hermes_cli.dashboard_auth.base import InvalidCredentialsError, ProviderError
    from hermes_cli.dashboard_auth.routes import _client_ip, _password_rate_limited

    session = getattr(request.state, "session", None)
    if session is None or not getattr(session, "email", ""):
        raise HTTPException(403, "Sign in with your password to upgrade.")
    if _password_rate_limited(_client_ip(request)):
        raise HTTPException(429, "Too many tries. Wait a minute and try again.")
    provider = get_provider(session.provider)
    if provider is None or not getattr(provider, "supports_password", False):
        raise HTTPException(403, "Your sign-in has no password to confirm with.")
    try:
        checked = await asyncio.to_thread(functools.partial(
            provider.complete_password_login, username=session.email, password=password))
    except InvalidCredentialsError:
        _log.warning("software upgrade: password re-check failed for %s", session.user_id)
        raise HTTPException(400, "That password is not right.")
    except (ProviderError, NotImplementedError):
        raise HTTPException(503, "Your password could not be checked right now. Try again.")
    if getattr(checked, "user_id", None) != session.user_id:
        raise HTTPException(400, "That password is not right.")
    try:
        principal = await ws._comms_resolve_principal(request)
        name = str(getattr(principal, "display", "") or "")
    except Exception:  # noqa: BLE001 — the name is only a label for the history
        name = ""
    return (name or session.display_name or session.email)[:80]


# --------------------------------------------------------------------------- routes


@router.get("", dependencies=ADMIN)
async def upgrade_status():
    raw = await asyncio.to_thread(_call, "status")
    rel = await asyncio.to_thread(_call, "releases") if raw.get("ok") else None
    return status_view(raw, rel if rel and rel.get("ok") else ({"releases": []} if rel else None))


@router.get("/job", dependencies=ADMIN)
async def upgrade_job():
    """Light poll for the progress page: status without the release list."""
    return status_view(await asyncio.to_thread(_call, "status"))


@router.post("/check", dependencies=ADMIN)
async def upgrade_check():
    """Ask GitHub for releases now (read-only: it only refreshes the cached list)."""
    rel = await asyncio.to_thread(_call, "check", None, 90)
    if rel.get("unavailable"):
        raise _fail(rel)
    raw = await asyncio.to_thread(_call, "status")
    return status_view(raw, rel if rel.get("ok") else {"releases": [], "error": rel.get("error")})


@router.post("/start", status_code=202, dependencies=ADMIN)
async def upgrade_start(request: Request, body: StartBody):
    if version_key(body.version) is None:
        raise HTTPException(400, "Pick a release like v1.2.3.")
    by = await _confirm_password(request, body.password)
    answer = await asyncio.to_thread(_call, "start", {"version": body.version, "by": by})
    if not answer.get("ok"):
        raise _fail(answer)
    return {"started": True, "status": status_view(answer.get("status") or {})}


@router.post("/rollback", status_code=202, dependencies=ADMIN)
async def upgrade_rollback(request: Request, body: RollbackBody):
    by = await _confirm_password(request, body.password)
    answer = await asyncio.to_thread(_call, "rollback", {"by": by})
    if not answer.get("ok"):
        raise _fail(answer)
    return {"started": True, "status": status_view(answer.get("status") or {})}
