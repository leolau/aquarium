"""Skill usage ledger routes for the agent-home Skills page.

``GET /api/skills/usage`` rolls up every skill's uses, ``GET .../detail``
lists one skill's uses with the chat / card / project each came from (titles
resolved here, never filesystem paths), and ``POST .../feedback`` rates a use.
Admin-only like the other skill routes: the detail rows name other people's
sessions. ``?profile=`` scopes to that profile's ledger; ``?project=`` on the
detail narrows it to one project's uses, for callers who can read that project.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import skill_ledger
from hermes_cli.route_roles import SKILLS_LAB

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/skills/usage")

# A project slug or its short ref (``P12``), as the projects routes accept.
_PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def _profile_scope(profile: Optional[str]):
    from hermes_cli import web_server

    return web_server._profile_scope(profile)


def _session_titles(ids: Iterable[str]) -> Dict[str, Optional[str]]:
    ids = sorted({i for i in ids if i})
    if not ids:
        return {}
    from hermes_constants import get_hermes_home

    conn = skill_ledger._readonly(get_hermes_home() / "state.db")
    if conn is None:
        return {}
    try:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT id, title FROM sessions WHERE id IN ({marks})", ids)
        return {r["id"]: r["title"] for r in rows}
    except Exception:
        logger.debug("skills usage: session titles unavailable", exc_info=True)
        return {}
    finally:
        conn.close()


def _task_titles(events: List[Dict[str, Any]]) -> Dict[tuple, Optional[str]]:
    by_board: Dict[Optional[str], set] = {}
    for e in events:
        if e["kanban_task_id"]:
            by_board.setdefault(e["kanban_board"], set()).add(e["kanban_task_id"])
    out: Dict[tuple, Optional[str]] = {}
    for board, ids in by_board.items():
        conn = skill_ledger._kanban_conn(board)
        if conn is None:
            continue
        try:
            ordered = sorted(ids)
            marks = ",".join("?" * len(ordered))
            for r in conn.execute(f"SELECT id, title FROM tasks WHERE id IN ({marks})", ordered):
                out[(board, r["id"])] = r["title"]
        except Exception:
            logger.debug("skills usage: task titles unavailable", exc_info=True)
        finally:
            conn.close()
    return out


def _project_names(slugs: Iterable[str]) -> Dict[str, Optional[str]]:
    slugs = sorted({s for s in slugs if s})
    if not slugs:
        return {}
    conn = skill_ledger._projects_conn()
    if conn is None:
        return {}
    try:
        marks = ",".join("?" * len(slugs))
        rows = conn.execute(f"SELECT slug, name FROM projects WHERE slug IN ({marks})", slugs)
        return {r["slug"]: r["name"] for r in rows}
    except Exception:
        logger.debug("skills usage: project names unavailable", exc_info=True)
        return {}
    finally:
        conn.close()


def _public_event(
    e: Dict[str, Any],
    sessions: Dict[str, Optional[str]],
    tasks: Dict[tuple, Optional[str]],
    projects: Dict[str, Optional[str]],
) -> Dict[str, Any]:
    sid, tid, slug = e["session_id"], e["kanban_task_id"], e["project_slug"]
    return {
        "id": e["id"],
        "ts": e["ts"],
        "trigger": e["trigger"],
        "version_id": e["version_id"],
        "outcome": e["outcome"],
        "outcome_source": e["outcome_source"],
        "rating": e["rating"],
        "note": e["note"],
        "session": {"id": sid, "title": sessions.get(sid)} if sid else None,
        "task": {"id": tid, "title": tasks.get((e["kanban_board"], tid))} if tid else None,
        "project": {"slug": slug, "name": projects.get(slug)} if slug else None,
        "user_id": e["user_id"],
    }


def _decorate(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    sessions = _session_titles(e["session_id"] for e in events)
    tasks = _task_titles(events)
    projects = _project_names(e["project_slug"] for e in events)
    return [_public_event(e, sessions, tasks, projects) for e in events]


def _usage_sync(profile: Optional[str], days: int) -> Dict[str, Any]:
    days = skill_ledger._clamp_days(days)
    with _profile_scope(profile):
        return {"days": days, "skills": skill_ledger.summary(days=days)}


def _detail_sync(
    name: str,
    profile: Optional[str],
    days: int,
    limit: int,
    cursor: Optional[str],
    project: Optional[str] = None,
) -> Dict[str, Any]:
    days = skill_ledger._clamp_days(days)
    with _profile_scope(profile):
        rows = skill_ledger.summary(days=days, name=name, project=project)
        try:
            page = skill_ledger.events(
                name, days=days, limit=limit, cursor=cursor, project=project
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        events = _decorate(page["events"])
    row = rows[0] if rows else {**skill_ledger._blank_row(name), "trend": _empty_trend(days)}
    out = {
        "name": name,
        "summary": row,
        "by_version": page["by_version"],
        "events": events,
        "next_cursor": page["next_cursor"],
    }
    if project:
        out["project"] = project
    return out


def _empty_trend(days: int) -> List[Dict[str, Any]]:
    from datetime import datetime, timedelta, timezone

    today = datetime.now(timezone.utc).date()
    return [
        {"day": (today - timedelta(days=o)).isoformat(), "uses": 0}
        for o in range(days - 1, -1, -1)
    ]


def _feedback_sync(
    profile: Optional[str], event_id: int, rating: int, note: Optional[str]
) -> Dict[str, Any]:
    with _profile_scope(profile):
        event = skill_ledger.set_feedback(event_id, rating, note)
        if event is None:
            raise HTTPException(status_code=404, detail="usage event not found")
        return _decorate([event])[0]


@router.get("", dependencies=SKILLS_LAB)
async def get_usage(profile: Optional[str] = None, days: int = 90) -> Dict[str, Any]:
    return await asyncio.to_thread(_usage_sync, profile, days)


@router.get("/detail", dependencies=SKILLS_LAB)
async def get_usage_detail(
    request: Request,
    name: str,
    profile: Optional[str] = None,
    days: int = 90,
    limit: int = 50,
    cursor: Optional[str] = None,
    project: Optional[str] = None,
) -> Dict[str, Any]:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    slug: Optional[str] = None
    if project is not None:
        project = project.strip()
        if not _PROJECT_RE.match(project):
            raise HTTPException(status_code=400, detail="invalid project")
        # Skills ``lab`` alone must not let anyone probe a private project's
        # card titles by slug: the project read gate applies too (404).
        from hermes_cli import projects_api

        record, _role, _profiles, _principal = await projects_api._require_read_slug(
            request, project
        )
        slug = record.slug
    return await asyncio.to_thread(
        _detail_sync, name, profile, days, limit, cursor, slug
    )


@router.post("/feedback", dependencies=SKILLS_LAB)
async def post_usage_feedback(request: Request, profile: Optional[str] = None) -> Dict[str, Any]:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON body")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected a JSON object")
    event_id = body.get("event_id")
    rating = body.get("rating")
    note = body.get("note")
    if isinstance(event_id, bool) or not isinstance(event_id, int) or event_id < 1:
        raise HTTPException(status_code=422, detail="event_id must be a positive integer")
    if isinstance(rating, bool) or rating not in (-1, 1):
        raise HTTPException(status_code=422, detail="rating must be -1 or 1")
    if note is not None and not isinstance(note, str):
        raise HTTPException(status_code=422, detail="note must be a string")
    return await asyncio.to_thread(_feedback_sync, profile, event_id, rating, note)
