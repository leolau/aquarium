"""What is running right now — the feed behind agent-home's activity bar.

``GET /api/activity/running`` (wired in ``web_server``) returns one compact
row per live item: agent-home chat turns, project runs, running kanban cards
and cron jobs. Each source is read by *status* (never by walking every
project) and scoped exactly like the page the row links to:

* chats — the caller's chat scope (``_chat_scope_for``: the owner sees all,
  everyone else only the conversations they own);
* project runs and cards — ``projects_api._can_read`` on the project, and the
  board's principal card filter (a private card is its owner's alone);
* cron jobs — owner/admin see every job; anyone else only a job driving a
  project they can read.

``GET /api/activity/scheduled`` counts what waits on time with the same
helpers (``scheduled_summary``).

Gateway channel chats (Telegram etc.) are not listed: the only signal is the
sessions ``last_active < 300s`` heuristic, which says "recently active", not
"running", and long-lived channel sessions would show a misleading run time.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable, Iterable, Optional
from urllib.parse import urlencode, quote

logger = logging.getLogger(__name__)

#: Upper bound on rows returned; the bar is one scrolling row.
MAX_ITEMS = 50
_PER_SOURCE_LIMIT = 200


def _item(
    kind: str,
    item_id: str,
    name: str,
    started_at: Optional[float],
    href: Optional[str],
    profile: Optional[str],
    status: str,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "id": item_id,
        "name": (name or "").strip()[:120] or kind,
        "started_at": float(started_at) if started_at else None,
        "href": href,
        "profile": profile or None,
        "status": status,
    }


def _chat_href(session_id: str, profile: Optional[str]) -> str:
    params = {"session": session_id}
    if profile and profile != "default":
        params["profile"] = profile
    return "/chat?" + urlencode(params)


def _project_href(slug: str, *rest: Any) -> str:
    return "/" + "/".join(
        ["projects", quote(slug, safe="")] + [quote(str(p), safe="") for p in rest]
    )


# ---------------------------------------------------------------------------
# Chats
# ---------------------------------------------------------------------------


def chat_items(
    runs: Iterable[dict],
    scope: Optional[str],
    open_db: Callable[[Optional[str]], Any],
) -> list[dict]:
    """Live agent-home turns the caller may see.

    *runs* are snapshots of in-flight ``_CHAT_RUNS`` entries
    (``run_id``/``session_id``/``profile``/``started_at``); *scope* is the
    caller's chat scope (``None`` = every conversation).
    """
    by_profile: dict[Optional[str], list[dict]] = {}
    for run in runs:
        by_profile.setdefault(run.get("profile") or None, []).append(run)
    out: list[dict] = []
    for profile, group in by_profile.items():
        try:
            db = open_db(profile)
        except Exception:
            logger.debug("activity: session DB for %s unavailable", profile, exc_info=True)
            continue
        try:
            seen: set[str] = set()
            for run in group:
                sid = run["session_id"]
                if sid in seen:
                    continue
                seen.add(sid)
                if scope is not None and db.session_owner_user_id(sid) != scope:
                    continue
                title = db.get_session_title(sid) or "Chat"
                out.append(
                    _item(
                        "chat", sid, title, run.get("started_at"),
                        _chat_href(sid, profile), profile, "running",
                    )
                )
        finally:
            try:
                db.close()
            except Exception:
                pass
    return out


# ---------------------------------------------------------------------------
# Projects: runs + running cards
# ---------------------------------------------------------------------------


def _running_cards(principal) -> list[dict]:
    """Running project cards on every board, principal-filtered like
    ``kanban_db.list_tasks`` (one indexed status query per board)."""
    from hermes_cli import kanban_db

    try:
        boards = [b.get("slug") or kanban_db.DEFAULT_BOARD for b in kanban_db.list_boards(include_archived=False)]
    except Exception:
        logger.debug("activity: board discovery failed", exc_info=True)
        boards = [kanban_db.DEFAULT_BOARD]
    sql = (
        "SELECT t.id, t.title, t.project_id, t.assignee, "
        "COALESCE((SELECT MAX(r.started_at) FROM task_runs r "
        "          WHERE r.task_id = t.id AND r.status = 'running'), "
        "         t.started_at, t.created_at) AS started_at "
        "FROM tasks t WHERE t.status = 'running' AND t.project_id IS NOT NULL"
    )
    params: list[Any] = []
    if principal is not None and not getattr(principal, "is_owner", False):
        sql += " AND (t.visibility = 'shared' OR t.visibility = ?)"
        params.append(principal.private_visibility)
    sql += f" ORDER BY started_at DESC LIMIT {_PER_SOURCE_LIMIT}"
    out: list[dict] = []
    for board in boards:
        try:
            with kanban_db.connect_closing(board=board) as bconn:
                for row in bconn.execute(sql, params).fetchall():
                    card = dict(row)
                    card["board"] = board
                    out.append(card)
        except Exception:
            logger.debug("activity: board %s unreadable", board, exc_info=True)
    return out


def project_items(principal, enrolled: Iterable[str]) -> list[dict]:
    """Running/waiting project runs and running cards in projects the
    caller can read. Only projects that actually have live work are loaded
    and permission-checked."""
    from hermes_cli import kanban_db, projects_db
    from hermes_cli.projects_api import _can_read, _member_role_sync

    enrolled_set = set(enrolled)
    cards = _running_cards(principal)
    with projects_db.connect_closing() as conn:
        runs = [
            dict(r)
            for r in conn.execute(
                "SELECT id, project_id, run_no, status, started_at, profile "
                "FROM project_runs WHERE status IN ('running', 'waiting') "
                f"ORDER BY started_at DESC LIMIT {_PER_SOURCE_LIMIT}"
            ).fetchall()
        ]
        wanted = {r["project_id"] for r in runs} | {c["project_id"] for c in cards}
        readable: dict[str, Any] = {}
        for pid in wanted:
            project = projects_db.get_project(conn, pid)
            if project is None or project.archived:
                continue
            role = _member_role_sync(conn, project.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, project.id)
            if _can_read(project, role, principal, enrolled_set, profiles):
                readable[project.id] = project

    out: list[dict] = []
    for run in runs:
        project = readable.get(run["project_id"])
        if project is None:
            continue
        out.append(
            _item(
                "project_run", run["id"], f"{project.name} · run {run['run_no']}",
                run["started_at"], _project_href(project.slug, "runs", run["run_no"]),
                run.get("profile"), run["status"],
            )
        )
    for card in cards:
        project = readable.get(card["project_id"])
        # A card counts only on its project's own board.
        if project is None or (project.board_slug or kanban_db.DEFAULT_BOARD) != card["board"]:
            continue
        out.append(
            _item(
                "card", card["id"], card["title"], card["started_at"],
                _project_href(project.slug, "cards", card["id"]),
                card.get("assignee"), "running",
            )
        )
    return out


# ---------------------------------------------------------------------------
# Cron
# ---------------------------------------------------------------------------


def cron_dirs() -> list[tuple[str, Path]]:
    """``(profile, cron_dir)`` for every profile with a running-marker dir.

    A cheap directory scan — ``profiles.list_profiles`` also counts skills
    and probes gateways, far too much for a 15 s poll.
    """
    from hermes_cli import profiles as profiles_mod

    out: list[tuple[str, Path]] = []
    try:
        default_cron = profiles_mod.get_profile_dir("default") / "cron"
        if (default_cron / "running").is_dir():
            out.append(("default", default_cron))
        root = profiles_mod._get_profiles_root()
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if (child / "cron" / "running").is_dir():
                    out.append((child.name, child / "cron"))
    except Exception:
        logger.debug("activity: cron dir scan failed", exc_info=True)
    return out


def cron_items(
    principal,
    enrolled: Iterable[str],
    dirs: Iterable[tuple[str, Path]],
) -> list[dict]:
    from cron.jobs import list_running_jobs
    from hermes_cli import projects_db
    from hermes_cli.projects_api import _can_read, _instance_admin, _member_role_sync

    running: list[tuple[str, dict]] = []
    for profile, cron_dir in dirs:
        for job in list_running_jobs(cron_dir):
            running.append((profile, job))
    if not running:
        return []

    admin = _instance_admin(principal)
    enrolled_set = set(enrolled)
    linked: dict[str, Any] = {}
    job_ids = sorted({job["job_id"] for _p, job in running})
    marks = ",".join("?" for _ in job_ids)
    with projects_db.connect_closing() as conn:
        rows = conn.execute(
            f"SELECT id FROM projects WHERE archived = 0 AND cron_job_id IN ({marks})",
            job_ids,
        ).fetchall()
        for row in rows:
            project = projects_db.get_project(conn, row["id"])
            if project is None:
                continue
            role = _member_role_sync(conn, project.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, project.id)
            if _can_read(project, role, principal, enrolled_set, profiles):
                linked[project.cron_job_id] = project

    out: list[dict] = []
    for profile, job in running:
        project = linked.get(job["job_id"])
        if project is None and not admin:
            continue
        out.append(
            _item(
                "cron", f"{profile}:{job['job_id']}", job["name"], job["started_at"],
                _project_href(project.slug) if project is not None else None,
                profile, "running",
            )
        )
    return out


# ---------------------------------------------------------------------------
# Scheduled: the landing "Scheduled N" button
# ---------------------------------------------------------------------------


def cron_job_dirs() -> list[tuple[str, Path]]:
    """``(profile, cron_dir)`` for every profile with a cron job store."""
    from hermes_cli import profiles as profiles_mod

    out: list[tuple[str, Path]] = []
    try:
        default_cron = profiles_mod.get_profile_dir("default") / "cron"
        if (default_cron / "jobs.json").is_file():
            out.append(("default", default_cron))
        root = profiles_mod._get_profiles_root()
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if (child / "cron" / "jobs.json").is_file():
                    out.append((child.name, child / "cron"))
    except Exception:
        logger.debug("activity: cron store scan failed", exc_info=True)
    return out


def _read_jobs(cron_dir: Path) -> list[dict]:
    """The jobs in *cron_dir*'s ``jobs.json``, read only.

    ``cron.jobs.load_jobs`` targets one profile's module globals and may
    rewrite the file; a count needs neither.
    """
    try:
        data = json.loads((cron_dir / "jobs.json").read_text(encoding="utf-8"), strict=False)
    except (OSError, ValueError):
        return []
    jobs = data.get("jobs", []) if isinstance(data, dict) else data
    return [j for j in jobs if isinstance(j, dict)] if isinstance(jobs, list) else []


def _iso_epoch(value: Any) -> Optional[int]:
    from hermes_cli.projects_schedule import _iso_to_epoch

    return _iso_to_epoch(value) if isinstance(value, str) else None


def _scheduled_card_counts(principal) -> dict[tuple[str, str], int]:
    """``{(board, project_id): n}`` of cards parked in ``scheduled``,
    principal-filtered like ``_running_cards``."""
    from hermes_cli import kanban_db

    try:
        boards = [b.get("slug") or kanban_db.DEFAULT_BOARD for b in kanban_db.list_boards(include_archived=False)]
    except Exception:
        logger.debug("activity: board discovery failed", exc_info=True)
        boards = [kanban_db.DEFAULT_BOARD]
    sql = (
        "SELECT t.project_id, COUNT(*) AS n FROM tasks t "
        "WHERE t.status = 'scheduled' AND t.project_id IS NOT NULL"
    )
    params: list[Any] = []
    if principal is not None and not getattr(principal, "is_owner", False):
        sql += " AND (t.visibility = 'shared' OR t.visibility = ?)"
        params.append(principal.private_visibility)
    sql += " GROUP BY t.project_id"
    out: dict[tuple[str, str], int] = {}
    for board in boards:
        try:
            with kanban_db.connect_closing(board=board) as bconn:
                for row in bconn.execute(sql, params).fetchall():
                    out[(board, row["project_id"])] = int(row["n"])
        except Exception:
            logger.debug("activity: board %s unreadable", board, exc_info=True)
    return out


def scheduled_summary(
    principal,
    enrolled: Iterable[str],
    job_dirs: Optional[Iterable[tuple[str, Path]]] = None,
) -> dict[str, Any]:
    """What is waiting on time, counted for the caller.

    * ``projects`` — active, unarchived projects with a schedule the caller
      can read (``_can_read``);
    * ``cards`` — cards parked in ``scheduled`` on their project's own
      board, in such a readable project (a private card is its owner's);
    * ``cron_jobs`` — enabled jobs no project is linked to, owner/admin
      only (anyone else 0: a job behind their project is under
      ``projects``).

    ``next_run_at`` is the soonest of the counted schedules (epoch seconds,
    from the ``next_run_at`` display caches), or None.
    """
    from hermes_cli import kanban_db, projects_db
    from hermes_cli.projects_api import (
        _can_read,
        _has_active_schedule,
        _instance_admin,
        _member_role_sync,
    )

    enrolled_set = set(enrolled)
    admin = _instance_admin(principal)
    card_counts = _scheduled_card_counts(principal)
    next_runs: list[int] = []
    projects = 0
    cards = 0
    with projects_db.connect_closing() as conn:
        scheduled_ids = {
            r["id"]
            for r in conn.execute(
                "SELECT id FROM projects WHERE archived = 0 AND status = 'active' "
                "AND cron_job_id IS NOT NULL"
            ).fetchall()
        }
        linked_jobs = {
            r["cron_job_id"]
            for r in conn.execute(
                "SELECT cron_job_id FROM projects WHERE cron_job_id IS NOT NULL"
            ).fetchall()
        }
        wanted = scheduled_ids | {pid for _b, pid in card_counts}
        for pid in wanted:
            project = projects_db.get_project(conn, pid)
            if project is None or project.archived:
                continue
            role = _member_role_sync(conn, project.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, project.id)
            if not _can_read(project, role, principal, enrolled_set, profiles):
                continue
            if pid in scheduled_ids and _has_active_schedule(project):
                projects += 1
                if project.next_run_at:
                    next_runs.append(int(project.next_run_at))
            # A card counts only on its project's own board.
            cards += card_counts.get(
                (project.board_slug or kanban_db.DEFAULT_BOARD, project.id), 0
            )

    cron_jobs = 0
    if admin:
        for _profile, cron_dir in (cron_job_dirs() if job_dirs is None else job_dirs):
            for job in _read_jobs(cron_dir):
                if not job.get("enabled", True) or job.get("id") in linked_jobs:
                    continue
                cron_jobs += 1
                when = _iso_epoch(job.get("next_run_at"))
                if when:
                    next_runs.append(when)

    return {
        "total": projects + cards + cron_jobs,
        "projects": projects,
        "cards": cards,
        "cron_jobs": cron_jobs,
        "next_run_at": min(next_runs) if next_runs else None,
    }


def finalize(items: list[dict]) -> list[dict]:
    """Newest first, bounded."""
    items.sort(key=lambda i: i.get("started_at") or 0, reverse=True)
    return items[:MAX_ITEMS]
