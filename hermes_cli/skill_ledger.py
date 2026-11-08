"""Per-use skill ledger: which chat / card / project used a skill, and how it went.

``tools/skill_usage.py`` keeps lifetime counters for the curator. This module
keeps one row per use so the Skills page can answer "is this skill actually
useful?": every load records the session, the kanban task/run, the project,
the person and the skill version in play. Outcomes come from the kanban run
(``task_runs.outcome``, resolved lazily at read time) or from user feedback
on chat uses; anything else stays ``unknown``.

Storage is ``$HERMES_HOME/skill_ledger.db`` (per profile, beside
``state.db``), outside ``skills/`` so the loader, curator and hub sync never
see it. Recording is best-effort: :func:`record_use` never raises and only
does one small INSERT.
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

logger = logging.getLogger(__name__)

TRIGGERS = ("skill_view", "slash", "preload", "cron", "bundle")
OUTCOMES = ("success", "partial", "failure")
OUTCOME_SOURCES = ("kanban", "user", "auto")
MAX_DAYS = 365
MAX_LIMIT = 200
MAX_NOTE = 2000

# ``task_runs.outcome`` -> ledger outcome. ``reclaimed`` (the run was taken
# back and the card retried) says nothing about the skill, so it stays unknown.
KANBAN_OUTCOMES = {
    "completed": "success",
    "blocked": "partial",
    "crashed": "failure",
    "timed_out": "failure",
    "spawn_failed": "failure",
    "gave_up": "failure",
}

_SCHEMA = """
CREATE TABLE IF NOT EXISTS skill_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              REAL NOT NULL,
    skill_name      TEXT NOT NULL,
    version_id      TEXT,
    trigger         TEXT NOT NULL,
    session_id      TEXT,
    kanban_task_id  TEXT,
    kanban_run_id   INTEGER,
    kanban_board    TEXT,
    project_slug    TEXT,
    user_id         TEXT,
    profile         TEXT,
    outcome         TEXT,
    outcome_source  TEXT,
    rating          INTEGER,
    note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_skill_events_name_ts ON skill_events(skill_name, ts);
CREATE INDEX IF NOT EXISTS idx_skill_events_ts ON skill_events(ts);
CREATE INDEX IF NOT EXISTS idx_skill_events_run ON skill_events(kanban_run_id);
"""

_INIT_LOCK = threading.Lock()
_INITIALIZED: set[str] = set()


def ledger_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "skill_ledger.db"


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    path = ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=1.0)
    try:
        conn.row_factory = sqlite3.Row
        key = str(path.resolve())
        if key not in _INITIALIZED:
            with _INIT_LOCK:
                if key not in _INITIALIZED:
                    try:
                        conn.execute("PRAGMA journal_mode=WAL")
                    except sqlite3.DatabaseError:
                        pass
                    conn.executescript(_SCHEMA)
                    _INITIALIZED.add(key)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _readonly(path: Path) -> Optional[sqlite3.Connection]:
    """A SELECT-only connection to another store, or None when it is absent."""
    if not path.exists():
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.0)
    conn.row_factory = sqlite3.Row
    return conn


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


def _env(name: str) -> Optional[str]:
    value = (os.environ.get(name) or "").strip()
    return value or None


def _current_session_id() -> Optional[str]:
    try:
        from gateway.session_context import get_session_env

        value = (get_session_env("HERMES_SESSION_ID") or "").strip()
        return value or None
    except Exception:
        return _env("HERMES_SESSION_ID")


def _current_user_id() -> Optional[str]:
    try:
        from tools.access_policy import current_principal

        user_id, _role = current_principal()
        return user_id or None
    except Exception:
        return None


def _current_profile() -> Optional[str]:
    try:
        from hermes_cli.profiles import get_active_profile_name

        return get_active_profile_name()
    except Exception:
        return _env("HERMES_PROFILE")


def _current_version_id(skill_name: str) -> Optional[str]:
    try:
        from tools.skill_versions import current_version_id
    except ImportError:
        return None
    try:
        value = current_version_id(skill_name)
        return str(value) if value else None
    except Exception:
        return None


def record_use(
    skill_name: str,
    *,
    trigger: str,
    session_id: Optional[str] = None,
    kanban_task_id: Optional[str] = None,
    kanban_run_id: Optional[int] = None,
    project_slug: Optional[str] = None,
    user_id: Optional[str] = None,
    profile: Optional[str] = None,
    version_id: Optional[str] = None,
) -> Optional[int]:
    """Append one use of ``skill_name``; returns the event id or None on failure.

    Unset context is filled from the running process: the session id
    (``HERMES_SESSION_ID`` session var), the kanban card/run a worker was
    spawned for (``HERMES_KANBAN_TASK`` / ``HERMES_KANBAN_RUN_ID``), the
    principal bound to the tool call, the active profile and the skill's
    active version. Never raises.
    """
    try:
        name = str(skill_name or "").strip()
        if not name or trigger not in TRIGGERS:
            return None
        if session_id is None:
            session_id = _current_session_id()
        board = None
        if kanban_task_id is None:
            kanban_task_id = _env("HERMES_KANBAN_TASK")
            if kanban_run_id is None and kanban_task_id:
                raw_run = _env("HERMES_KANBAN_RUN_ID")
                kanban_run_id = int(raw_run) if raw_run and raw_run.isdigit() else None
        if kanban_task_id:
            board = _env("HERMES_KANBAN_BOARD")
        if user_id is None:
            user_id = _current_user_id()
        if profile is None:
            profile = _current_profile()
        if version_id is None:
            version_id = _current_version_id(name)
        with _connect() as conn:
            cur = conn.execute(
                "INSERT INTO skill_events (ts, skill_name, version_id, trigger, session_id,"
                " kanban_task_id, kanban_run_id, kanban_board, project_slug, user_id, profile)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    time.time(), name, version_id, trigger, session_id or None,
                    kanban_task_id or None, kanban_run_id, board,
                    project_slug or None, user_id or None, profile or None,
                ),
            )
            return int(cur.lastrowid)
    except Exception:
        logger.debug("skill ledger: record_use(%s) failed", skill_name, exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Lazy resolution of kanban outcomes and project slugs
# ---------------------------------------------------------------------------


def _kanban_conn(board: Optional[str]) -> Optional[sqlite3.Connection]:
    try:
        from hermes_cli import kanban_db

        return _readonly(kanban_db.kanban_db_path(board=board or None))
    except Exception:
        logger.debug("skill ledger: kanban db unavailable", exc_info=True)
        return None


def _projects_conn() -> Optional[sqlite3.Connection]:
    try:
        from hermes_cli import projects_db

        return _readonly(projects_db.projects_db_path())
    except Exception:
        logger.debug("skill ledger: projects db unavailable", exc_info=True)
        return None


def _resolve_pending(conn: sqlite3.Connection, since: float) -> None:
    """Fill outcome (from the card's run) and project slug for kanban uses."""
    rows = conn.execute(
        "SELECT id, ts, kanban_task_id, kanban_run_id, kanban_board, project_slug, outcome"
        " FROM skill_events WHERE ts >= ? AND kanban_task_id IS NOT NULL"
        " AND (outcome IS NULL OR project_slug IS NULL)",
        (since,),
    ).fetchall()
    if not rows:
        return
    by_board: Dict[Optional[str], List[sqlite3.Row]] = {}
    for row in rows:
        by_board.setdefault(row["kanban_board"], []).append(row)
    project_ids: Dict[int, str] = {}
    for board, items in by_board.items():
        kconn = _kanban_conn(board)
        if kconn is None:
            continue
        try:
            for row in items:
                if row["outcome"] is None:
                    run = None
                    if row["kanban_run_id"] is not None:
                        run = kconn.execute(
                            "SELECT outcome FROM task_runs WHERE id = ? AND task_id = ?",
                            (row["kanban_run_id"], row["kanban_task_id"]),
                        ).fetchone()
                    else:
                        run = kconn.execute(
                            "SELECT outcome FROM task_runs WHERE task_id = ? AND started_at <= ?"
                            " ORDER BY started_at DESC, id DESC LIMIT 1",
                            (row["kanban_task_id"], int(row["ts"]) + 1),
                        ).fetchone()
                    mapped = KANBAN_OUTCOMES.get((run["outcome"] or "") if run else "")
                    if mapped:
                        conn.execute(
                            "UPDATE skill_events SET outcome = ?, outcome_source = 'kanban'"
                            " WHERE id = ? AND outcome IS NULL",
                            (mapped, row["id"]),
                        )
                if row["project_slug"] is None:
                    task = kconn.execute(
                        "SELECT project_id FROM tasks WHERE id = ?", (row["kanban_task_id"],)
                    ).fetchone()
                    if task is not None and task["project_id"]:
                        project_ids[row["id"]] = task["project_id"]
        except sqlite3.Error:
            logger.debug("skill ledger: kanban outcome lookup failed", exc_info=True)
        finally:
            kconn.close()
    if not project_ids:
        return
    pconn = _projects_conn()
    if pconn is None:
        return
    try:
        slugs: Dict[str, Optional[str]] = {}
        for pid in set(project_ids.values()):
            hit = pconn.execute(
                "SELECT slug FROM projects WHERE id = ? OR slug = ?", (pid, pid)
            ).fetchone()
            slugs[pid] = hit["slug"] if hit else None
        for event_id, pid in project_ids.items():
            if slugs.get(pid):
                conn.execute(
                    "UPDATE skill_events SET project_slug = ? WHERE id = ? AND project_slug IS NULL",
                    (slugs[pid], event_id),
                )
    except sqlite3.Error:
        logger.debug("skill ledger: project lookup failed", exc_info=True)
    finally:
        pconn.close()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def _clamp_days(days: Any) -> int:
    try:
        value = int(days)
    except (TypeError, ValueError):
        value = 90
    return max(1, min(MAX_DAYS, value))


def _since(days: int) -> float:
    return time.time() - days * 86400


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _blank_row(name: str) -> Dict[str, Any]:
    return {
        "name": name,
        "uses": 0,
        "sessions": 0,
        "tasks": 0,
        "projects": 0,
        "success": 0,
        "partial": 0,
        "failure": 0,
        "unknown": 0,
        "success_rate": None,
        "last_used_at": None,
    }


def _rate(success: int, partial: int, failure: int) -> Optional[float]:
    known = success + partial + failure
    return round(success / known, 4) if known else None


def _summarise(rows: List[sqlite3.Row], days: int) -> List[Dict[str, Any]]:
    today = datetime.now(timezone.utc).date()
    day_keys = [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]
    acc: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        name = row["skill_name"]
        entry = acc.get(name)
        if entry is None:
            entry = acc[name] = {
                **_blank_row(name),
                "_sessions": set(), "_tasks": set(), "_projects": set(), "_days": {},
            }
        entry["uses"] += 1
        if row["session_id"]:
            entry["_sessions"].add(row["session_id"])
        if row["kanban_task_id"]:
            entry["_tasks"].add(row["kanban_task_id"])
        if row["project_slug"]:
            entry["_projects"].add(row["project_slug"])
        outcome = row["outcome"] if row["outcome"] in OUTCOMES else "unknown"
        entry[outcome] += 1
        ts = float(row["ts"])
        if entry["last_used_at"] is None or ts > entry["last_used_at"]:
            entry["last_used_at"] = ts
        day = _day(ts)
        entry["_days"][day] = entry["_days"].get(day, 0) + 1
    out = []
    for entry in acc.values():
        entry["sessions"] = len(entry.pop("_sessions"))
        entry["tasks"] = len(entry.pop("_tasks"))
        entry["projects"] = len(entry.pop("_projects"))
        per_day = entry.pop("_days")
        entry["trend"] = [{"day": d, "uses": per_day.get(d, 0)} for d in day_keys]
        entry["success_rate"] = _rate(entry["success"], entry["partial"], entry["failure"])
        out.append(entry)
    out.sort(key=lambda e: (-e["uses"], e["name"]))
    return out


def summary(*, days: int = 90, name: Optional[str] = None) -> List[Dict[str, Any]]:
    """Per-skill rollup over the last ``days`` days (busiest first).

    ``trend`` is dense: one ``{"day", "uses"}`` entry per UTC day in the
    window, oldest first. ``success_rate`` is success over uses with a known
    outcome, or None when none is known.
    """
    days = _clamp_days(days)
    since = _since(days)
    with _connect() as conn:
        _resolve_pending(conn, since)
        query = (
            "SELECT skill_name, ts, session_id, kanban_task_id, project_slug, outcome"
            " FROM skill_events WHERE ts >= ?"
        )
        params: List[Any] = [since]
        if name:
            query += " AND skill_name = ?"
            params.append(name)
        rows = conn.execute(query, params).fetchall()
    return _summarise(rows, days)


def _event_dict(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "ts": float(row["ts"]),
        "skill_name": row["skill_name"],
        "trigger": row["trigger"],
        "version_id": row["version_id"],
        "outcome": row["outcome"],
        "outcome_source": row["outcome_source"],
        "rating": row["rating"],
        "note": row["note"],
        "session_id": row["session_id"],
        "kanban_task_id": row["kanban_task_id"],
        "kanban_run_id": row["kanban_run_id"],
        "kanban_board": row["kanban_board"],
        "project_slug": row["project_slug"],
        "user_id": row["user_id"],
        "profile": row["profile"],
    }


def events(
    name: str,
    *,
    days: int = 90,
    limit: int = 50,
    cursor: Optional[Any] = None,
) -> Dict[str, Any]:
    """Newest-first uses of ``name``: ``{"events": [...], "next_cursor"}``.

    ``cursor`` is the ``next_cursor`` of the previous page (an opaque string;
    today the last event id seen). ``by_version`` rolls up the whole window.
    """
    days = _clamp_days(days)
    since = _since(days)
    try:
        limit = max(1, min(MAX_LIMIT, int(limit)))
    except (TypeError, ValueError):
        limit = 50
    before: Optional[int] = None
    if cursor not in (None, ""):
        try:
            before = int(cursor)
        except (TypeError, ValueError):
            raise ValueError("invalid cursor")
    with _connect() as conn:
        _resolve_pending(conn, since)
        query = "SELECT * FROM skill_events WHERE skill_name = ? AND ts >= ?"
        params: List[Any] = [name, since]
        if before is not None:
            query += " AND id < ?"
            params.append(before)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(limit + 1)
        rows = conn.execute(query, params).fetchall()
        versions = conn.execute(
            "SELECT version_id, COUNT(*) AS uses,"
            " SUM(outcome = 'success') AS s, SUM(outcome = 'partial') AS p,"
            " SUM(outcome = 'failure') AS f, MAX(ts) AS last_ts"
            " FROM skill_events WHERE skill_name = ? AND ts >= ?"
            " GROUP BY version_id ORDER BY last_ts DESC",
            (name, since),
        ).fetchall()
    page = [_event_dict(r) for r in rows[:limit]]
    next_cursor = str(page[-1]["id"]) if len(rows) > limit and page else None
    by_version = [
        {
            "version_id": v["version_id"],
            "uses": int(v["uses"]),
            "success_rate": _rate(int(v["s"] or 0), int(v["p"] or 0), int(v["f"] or 0)),
        }
        for v in versions
    ]
    return {"events": page, "next_cursor": next_cursor, "by_version": by_version}


def get_event(event_id: int) -> Optional[Dict[str, Any]]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM skill_events WHERE id = ?", (int(event_id),)).fetchone()
    return _event_dict(row) if row else None


def set_feedback(event_id: int, rating: int, note: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Rate one use (-1 / 0 / 1) and optionally leave a note.

    For uses without a kanban outcome the rating becomes the outcome
    (1 = success, -1 = failure, 0 = clears a user-set outcome); a kanban
    outcome is never overwritten. ``note=None`` keeps the existing note.
    Returns the updated event, or None when it does not exist.
    """
    if rating not in (-1, 0, 1) or isinstance(rating, bool):
        raise ValueError("rating must be -1, 0 or 1")
    if note is not None:
        note = str(note).strip()[:MAX_NOTE] or None
    with _connect() as conn:
        row = conn.execute(
            "SELECT outcome_source FROM skill_events WHERE id = ?", (int(event_id),)
        ).fetchone()
        if row is None:
            return None
        sets = ["rating = ?"]
        params: List[Any] = [rating]
        if note is not None:
            sets.append("note = ?")
            params.append(note)
        if row["outcome_source"] != "kanban":
            outcome = {1: "success", -1: "failure"}.get(rating)
            sets.append("outcome = ?")
            sets.append("outcome_source = ?")
            params.extend([outcome, "user" if outcome else None])
        params.append(int(event_id))
        conn.execute(f"UPDATE skill_events SET {', '.join(sets)} WHERE id = ?", params)
    return get_event(event_id)
