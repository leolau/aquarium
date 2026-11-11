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

Gateway channel chats (Telegram etc.) are not listed: the only signal is the
sessions ``last_active < 300s`` heuristic, which says "recently active", not
"running", and long-lived channel sessions would show a misleading run time.
"""

from __future__ import annotations

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


def readable_cron_projects(
    principal,
    enrolled: Iterable[str],
    job_ids: Iterable[str],
) -> dict[str, Any]:
    """``{cron_job_id: project}`` for the jobs in ``job_ids`` that drive a
    live project the caller can read. A job no readable project points at is
    left out: only instance admins see standalone cron jobs."""
    from hermes_cli import projects_db
    from hermes_cli.projects_api import _can_read, _member_role_sync

    ids = sorted({str(j) for j in job_ids if j})
    if not ids:
        return {}
    enrolled_set = set(enrolled)
    linked: dict[str, Any] = {}
    marks = ",".join("?" for _ in ids)
    with projects_db.connect_closing() as conn:
        rows = conn.execute(
            f"SELECT id FROM projects WHERE archived = 0 AND cron_job_id IN ({marks})",
            ids,
        ).fetchall()
        for row in rows:
            project = projects_db.get_project(conn, row["id"])
            if project is None:
                continue
            role = _member_role_sync(conn, project.id, principal.user_id)
            profiles = projects_db.get_project_profiles(conn, project.id)
            if _can_read(project, role, principal, enrolled_set, profiles):
                linked[project.cron_job_id] = project
    return linked


def cron_items(
    principal,
    enrolled: Iterable[str],
    dirs: Iterable[tuple[str, Path]],
) -> list[dict]:
    from cron.jobs import list_running_jobs
    from hermes_cli.projects_api import _instance_admin

    running: list[tuple[str, dict]] = []
    for profile, cron_dir in dirs:
        for job in list_running_jobs(cron_dir):
            running.append((profile, job))
    if not running:
        return []

    admin = _instance_admin(principal)
    linked = readable_cron_projects(
        principal, enrolled, {job["job_id"] for _p, job in running}
    )

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


def finalize(items: list[dict]) -> list[dict]:
    """Newest first, bounded."""
    items.sort(key=lambda i: i.get("started_at") or 0, reverse=True)
    return items[:MAX_ITEMS]
