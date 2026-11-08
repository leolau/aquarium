"""Profile capability cards — what each profile can do, for planners (FG-34).

One card per profile combines the facts a planner needs to route a step:
the profile's description (``profile.yaml``), its installed skills, its
enabled toolsets, its model, and its 90-day kanban track record. The
project planner, re-plan and kanban decomposer all render the roster
through :func:`roster_prompt_block`, so every planner sees identical facts.

:func:`accessible_profile_names` is the FG-34 decision-1 access set: box
owner/admin → every served profile; anyone else → profiles where they hold
an active principals row, plus the profiles already attached to the project.

Nothing here raises for a broken or missing profile: missing data degrades
to empty fields.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import logging
import time
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

TRACK_RECORD_WINDOW_DAYS = 90
RECENT_TITLES = 5
FAILED_OUTCOMES = ("crashed", "timed_out", "spawn_failed", "gave_up")

_MAX_DESCRIPTION_CHARS = 300
_MAX_TITLE_CHARS = 80
_MAX_TOOLSETS = 24


# ---------------------------------------------------------------------------
# Capability card (contract C-1)
# ---------------------------------------------------------------------------


def _empty_track_record() -> dict:
    return {
        "window_days": TRACK_RECORD_WINDOW_DAYS,
        "completed": 0,
        "blocked": 0,
        "failed": 0,
        "recent": [],
    }


def _track_record(conn, name: str, now: int) -> dict:
    record = _empty_track_record()
    if conn is None:
        return record
    since = now - TRACK_RECORD_WINDOW_DAYS * 86400
    try:
        rows = conn.execute(
            "SELECT outcome, COUNT(*) FROM task_runs "
            "WHERE profile = ? AND ended_at >= ? AND ended_at <= ? "
            "AND outcome IS NOT NULL GROUP BY outcome",
            (name, since, now),
        ).fetchall()
        for outcome, count in rows:
            if outcome == "completed":
                record["completed"] += int(count)
            elif outcome == "blocked":
                record["blocked"] += int(count)
            elif outcome in FAILED_OUTCOMES:
                record["failed"] += int(count)
        recent = conn.execute(
            "SELECT t.title, r.outcome, r.ended_at FROM task_runs r "
            "JOIN tasks t ON t.id = r.task_id "
            "WHERE r.profile = ? AND r.outcome = 'completed' "
            "AND r.ended_at >= ? AND r.ended_at <= ? "
            "ORDER BY r.ended_at DESC, r.id DESC LIMIT ?",
            (name, since, now, RECENT_TITLES),
        ).fetchall()
        record["recent"] = [
            {"title": str(title or ""), "outcome": str(outcome), "ended_at": int(ended)}
            for title, outcome, ended in recent
        ]
    except Exception:  # noqa: BLE001 — no board / old schema → empty record
        logger.debug("capabilities: track record unavailable for %s", name, exc_info=True)
        return _empty_track_record()
    return record


def _card(name: str, conn, now: int) -> dict:
    card: dict[str, Any] = {
        "name": name,
        "display_name": name,
        "description": "",
        "description_auto": False,
        "skills": [],
        "toolsets": [],
        "model": "",
        "track_record": _track_record(conn, name, now),
    }
    try:
        from hermes_cli import profiles

        home = profiles.get_profile_dir(name)
        if not home.is_dir():
            return card
    except Exception:  # noqa: BLE001 — invalid name → empty card
        return card
    try:
        meta = profiles.read_profile_meta(home)
        card["description"] = meta.get("description", "")
        card["description_auto"] = bool(meta.get("description_auto", False))
    except Exception:  # noqa: BLE001
        pass
    try:
        from hermes_cli.profile_describer import installed_skills

        card["skills"] = [
            {"name": skill, "category": category}
            for category, skill in installed_skills(home)
        ]
    except Exception:  # noqa: BLE001
        pass
    try:
        from hermes_cli.projects_run import _enabled_toolsets_for_profile

        card["toolsets"] = list(_enabled_toolsets_for_profile(name))
    except Exception:  # noqa: BLE001
        pass
    try:
        model, _provider = profiles._read_config_model(home)
        card["model"] = str(model or "")
    except Exception:  # noqa: BLE001
        pass
    return card


@contextlib.contextmanager
def _board(board_conn):
    """The caller's board connection, or the default board's (closed on exit)."""
    if board_conn is not None:
        yield board_conn
        return
    try:
        from hermes_cli import kanban_db

        cm = kanban_db.connect_closing()
        conn = cm.__enter__()
    except Exception:  # noqa: BLE001 — no board → no track record
        logger.debug("capabilities: default board unavailable", exc_info=True)
        yield None
        return
    try:
        yield conn
    finally:
        cm.__exit__(None, None, None)


def capability_card(name: str, *, board_conn=None, now: int | None = None) -> dict:
    """One profile's capability card. Never raises."""
    ts = int(now if now is not None else time.time())
    with _board(board_conn) as conn:
        return _card(name, conn, ts)


def capability_roster(
    names: Iterable[str], *, board_conn=None, now: int | None = None
) -> list[dict]:
    """Cards for ``names`` (input order, duplicates dropped), one board read."""
    ts = int(now if now is not None else time.time())
    unique = list(dict.fromkeys(n for n in names if n))
    with _board(board_conn) as conn:
        return [_card(n, conn, ts) for n in unique]


# ---------------------------------------------------------------------------
# Access set (FG-34 decision 1)
# ---------------------------------------------------------------------------


def _served_profile_names() -> list[str]:
    try:
        from hermes_cli.profiles import profiles_to_serve

        return [name for name, _home in profiles_to_serve(multiplex=True)]
    except Exception:  # noqa: BLE001
        logger.debug("capabilities: profile registry unavailable", exc_info=True)
        return []


def _project_profile_names(project) -> list[str]:
    if project is None:
        return []
    names: list[str] = []
    try:
        from hermes_cli import projects_db

        with projects_db.connect_closing() as conn:
            rows = projects_db.get_project_profiles(conn, project.id)
        names = [r["profile"] for r in rows if r.get("profile")]
    except Exception:  # noqa: BLE001
        logger.debug("capabilities: project profiles unavailable", exc_info=True)
    host = getattr(project, "host_profile", None)
    if host and host not in names:
        names.append(host)
    return names


def _is_instance_admin(principal) -> bool:
    from hermes_cli.projects_api import _instance_admin

    return principal is not None and _instance_admin(principal)


async def accessible_profile_names(principal, *, project=None) -> list[str]:
    """Profiles ``principal`` may have a plan step assigned to, sorted.

    Box owner/admin → every served profile. Anyone else → profiles where
    they hold an **active** principals row, plus ``project``'s attached
    profiles. Fails closed to the project's profiles.
    """
    project_names = await asyncio.to_thread(_project_profile_names, project)
    if _is_instance_admin(principal):
        served = await asyncio.to_thread(_served_profile_names)
        return sorted(set(served) | set(project_names))
    enrolled: set[str] = set()
    user_id = getattr(principal, "user_id", None)
    if user_id:
        from hermes_cli import projects_api

        try:
            enrolled = set(await projects_api._enrolled_profiles(user_id))
        except Exception:  # noqa: BLE001 — fail closed
            enrolled = set()
    return sorted(enrolled | set(project_names))


async def _principal_for_user(user_id: str):
    """The box principal row for ``user_id`` (role decides admin), or None."""
    from hermes_cli.access import PrincipalStore
    from hermes_cli.web_server import _comms_app_store

    return await PrincipalStore(_comms_app_store()).get(user_id)


async def _accessible_for_user(user_id: Optional[str], project) -> list[str]:
    principal = None
    if user_id:
        try:
            principal = await _principal_for_user(user_id)
        except Exception:  # noqa: BLE001 — store unreachable → not admin
            logger.debug("capabilities: principal lookup failed", exc_info=True)
        if principal is None or not getattr(principal, "active", True):
            principal = _UserOnly(user_id)
    return await accessible_profile_names(principal, project=project)


class _UserOnly:
    """A non-admin stand-in for a user id with no readable principal row."""

    role = "member"
    is_owner = False

    def __init__(self, user_id: str):
        self.user_id = user_id


def accessible_profile_names_for_user(user_id: str | None, *, project=None) -> list[str]:
    """Sync :func:`accessible_profile_names` for background jobs (re-plans).

    ``user_id=None`` uses the project owner's set. Safe to call from a
    thread or from inside a running event loop (runs on a worker thread).
    """
    if not user_id and project is not None:
        user_id = getattr(project, "owner_user_id", None) or None

    def _run() -> list[str]:
        return asyncio.run(_accessible_for_user(user_id, project))

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return _run()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(_run).result()


# ---------------------------------------------------------------------------
# Prompt text
# ---------------------------------------------------------------------------


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _sample(items: list[str], cap: int) -> tuple[list[str], int]:
    """Evenly spaced, order-preserving sample of at most ``cap`` items."""
    if cap <= 0:
        return [], len(items)
    if len(items) <= cap:
        return items, 0
    step = len(items) / cap
    return [items[int(i * step)] for i in range(cap)], len(items) - cap


def roster_prompt_block(roster: list[dict], *, max_skills: int = 40) -> str:
    """The compact, deterministic roster text every planner prompt uses."""
    if not roster:
        return "  (no profiles available)"
    lines: list[str] = []
    for card in roster:
        name = card.get("name") or "?"
        model = card.get("model") or ""
        head = f"- {name}" + (f" (model: {model})" if model else "")
        desc = _clip(card.get("description") or "", _MAX_DESCRIPTION_CHARS)
        lines.append(f"{head}: {desc or '(no description)'}")

        skills = sorted(
            f"{s.get('category')}/{s.get('name')}" if s.get("category") else str(s.get("name"))
            for s in card.get("skills") or []
            if s.get("name")
        )
        shown, more = _sample(skills, max_skills)
        lines.append(
            "  skills: "
            + (", ".join(shown) if shown else "(none)")
            + (f" (+{more} more)" if more else "")
        )

        tools, more_tools = _sample(sorted(card.get("toolsets") or []), _MAX_TOOLSETS)
        lines.append(
            "  tools: "
            + (", ".join(tools) if tools else "(none)")
            + (f" (+{more_tools} more)" if more_tools else "")
        )

        tr = card.get("track_record") or {}
        days = tr.get("window_days", TRACK_RECORD_WINDOW_DAYS)
        record = (
            f"  track record ({days}d): {tr.get('completed', 0)} completed, "
            f"{tr.get('blocked', 0)} blocked, {tr.get('failed', 0)} failed"
        )
        titles = [
            _clip(r.get("title") or "", _MAX_TITLE_CHARS)
            for r in (tr.get("recent") or [])[:RECENT_TITLES]
            if r.get("title")
        ]
        if titles:
            record += "; recent: " + "; ".join(f'"{t}"' for t in titles)
        lines.append(record)
    return "\n".join(lines)
