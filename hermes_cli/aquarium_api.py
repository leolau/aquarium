"""FG-35 aquarium: the box-wide snapshot, its idle setting, and each person's creature.

The snapshot lists every active principal across the served profiles with
usage read by aggregate SQL from each profile's ``state.db`` and the box-wide
projects DB; it is cached for :data:`SNAPSHOT_TTL_SECONDS` so polling viewers
share one build. ``aquarium.idle_seconds`` and ``aquarium.name`` live in the default profile's
config.yaml (like the upload limit). A creature is a per-person preference in
:mod:`hermes_cli.user_prefs`; ``/api/me/creature`` only ever acts on the
signed-in person.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from hermes_cli.aquarium_creatures import (
    AQUARIUM_NAME_DEFAULT,
    AQUARIUM_NAME_MAX,
    IDLE_SECONDS_DEFAULT,
    IDLE_SECONDS_MAX,
    IDLE_SECONDS_MIN,
)
from hermes_cli.route_roles import ADMIN

logger = logging.getLogger(__name__)

router = APIRouter()

SNAPSHOT_TTL_SECONDS = 4.0
_DAY_SECONDS = 24 * 60 * 60
_ADMIN_ROLES = ("owner", "admin")
_PARENT_WALK_LIMIT = 50
_BIDI_CONTROLS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")

_cache: Dict[str, Any] = {"at": 0.0, "snapshot": None, "loop": None, "lock": None}


def _section(config: Dict[str, Any]) -> Dict[str, Any]:
    aquarium = config.get("aquarium")
    return aquarium if isinstance(aquarium, dict) else {}


def _valid_idle(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and IDLE_SECONDS_MIN <= value <= IDLE_SECONDS_MAX
    )


def idle_seconds(config: Dict[str, Any]) -> int:
    value = _section(config).get("idle_seconds")
    return value if _valid_idle(value) else IDLE_SECONDS_DEFAULT


def _writable_section(config: Dict[str, Any]) -> Dict[str, Any]:
    aquarium = config.get("aquarium")
    if not isinstance(aquarium, dict):
        aquarium = config["aquarium"] = {}
    return aquarium


def set_idle_seconds(config: Dict[str, Any], value: Any) -> int:
    """Store *value* in *config*; ``ValueError`` when out of range."""
    if not _valid_idle(value):
        raise ValueError(
            f"idle_seconds must be a whole number between {IDLE_SECONDS_MIN} "
            f"and {IDLE_SECONDS_MAX}."
        )
    _writable_section(config)["idle_seconds"] = value
    return value


def normalize_name(value: Any) -> str:
    """The trimmed name without control characters; ``""`` means the default.

    ``ValueError`` for a non-string or one longer than :data:`AQUARIUM_NAME_MAX`.
    """
    if not isinstance(value, str):
        raise ValueError("name must be a string.")
    name = "".join(
        c for c in value if unicodedata.category(c) != "Cc" and c not in _BIDI_CONTROLS
    ).strip()
    if len(name) > AQUARIUM_NAME_MAX:
        raise ValueError(f"name must be at most {AQUARIUM_NAME_MAX} characters.")
    return name


def aquarium_name(config: Dict[str, Any]) -> str:
    try:
        return normalize_name(_section(config).get("name")) or AQUARIUM_NAME_DEFAULT
    except ValueError:
        return AQUARIUM_NAME_DEFAULT


def set_aquarium_name(config: Dict[str, Any], value: Any) -> str:
    """Store *value* in *config*; empty or whitespace resets to the default."""
    name = normalize_name(value)
    aquarium = _writable_section(config)
    if name:
        aquarium["name"] = name
    else:
        aquarium.pop("name", None)
    return name or AQUARIUM_NAME_DEFAULT


def settings(config: Dict[str, Any]) -> Dict[str, Any]:
    return {"idle_seconds": idle_seconds(config), "name": aquarium_name(config)}


def read_settings() -> Dict[str, Any]:
    from hermes_cli import web_server as ws

    try:
        with ws._profile_scope("default"):
            return settings(ws.load_config())
    except Exception:
        return {"idle_seconds": IDLE_SECONDS_DEFAULT, "name": AQUARIUM_NAME_DEFAULT}


def _served_entries() -> list:
    from hermes_cli.profile_registry import get_profile_registry

    return [
        e
        for e in get_profile_registry()
        if (e.served or e.is_default) and e.hermes_home.is_dir()
    ]


async def _active_principals(entries: Iterable[Any]) -> List[Tuple[Any, list]]:
    """``(entry, active principals)`` per profile that has a user directory."""
    from agent.profile_runtime import profile_runtime_scope
    from hermes_cli import web_server as ws
    from hermes_cli.access import PrincipalStore

    out: List[Tuple[Any, list]] = []
    for entry in entries:
        try:
            with profile_runtime_scope(entry.hermes_home):
                rows = await PrincipalStore(ws._comms_app_store()).list_principals(
                    active=True
                )
        except Exception:
            logger.debug("aquarium: no principals for %s", entry.name, exc_info=True)
            continue
        out.append((entry, rows))
    return out


def _connect_ro(path: Path) -> Optional[sqlite3.Connection]:
    if not path.is_file():
        return None
    try:
        return sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True, timeout=1.0)
    except sqlite3.Error:
        return None


_SESSION_TOTALS_SQL = """
SELECT user_id,
       SUM(CASE WHEN parent_session_id IS NULL THEN 1 ELSE 0 END),
       COALESCE(SUM(input_tokens), 0),
       COALESCE(SUM(output_tokens), 0),
       COALESCE(SUM(CASE WHEN started_at >= ?
                         THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
                    END), 0)
  FROM sessions
 WHERE user_id IS NOT NULL AND user_id != ''
 GROUP BY user_id
"""

_PROJECT_COUNTS_SQL = """
SELECT user_id, COUNT(DISTINCT project_id)
  FROM (SELECT owner_user_id AS user_id, id AS project_id
          FROM projects
         WHERE archived = 0 AND owner_user_id IS NOT NULL AND owner_user_id != ''
        UNION
        SELECT m.user_id, m.project_id
          FROM project_members m JOIN projects p ON p.id = m.project_id
         WHERE p.archived = 0)
 GROUP BY user_id
"""


def _session_owner(conn: sqlite3.Connection, session_id: str) -> Optional[str]:
    sid: Optional[str] = session_id
    for _ in range(_PARENT_WALK_LIMIT):
        if not sid:
            return None
        row = conn.execute(
            "SELECT user_id, parent_session_id FROM sessions WHERE id = ?", (sid,)
        ).fetchone()
        if row is None:
            return None
        if row[0]:
            return str(row[0])
        sid = row[1]
    return None


def _running_session_ids(entries: Iterable[Any]) -> Dict[Path, Set[str]]:
    """Session ids with a live chat turn in this process, by profile home."""
    from hermes_cli import web_server as ws
    from hermes_constants import get_hermes_home

    homes = {e.name: e.hermes_home for e in entries}
    own = get_hermes_home()
    out: Dict[Path, Set[str]] = {}
    for run in list(ws._CHAT_RUNS.values()):
        sid = run.get("session_id")
        if run.get("done") or not sid:
            continue
        profile = run.get("profile")
        home = homes.get(profile) if profile and profile != "current" else own
        if home is not None:
            out.setdefault(Path(home).resolve(), set()).add(str(sid))
    return out


def _usage(entries: List[Any]) -> Tuple[Dict[str, List[int]], Set[str], Dict[str, int]]:
    """Session totals and running owners per user over every profile, plus projects."""
    since = time.time() - _DAY_SECONDS
    running = _running_session_ids(entries)
    totals: Dict[str, List[int]] = {}
    active: Set[str] = set()
    for entry in entries:
        conn = _connect_ro(entry.hermes_home / "state.db")
        if conn is None:
            continue
        try:
            for user_id, chats, t_in, t_out, t_24h in conn.execute(
                _SESSION_TOTALS_SQL, (since,)
            ):
                acc = totals.setdefault(str(user_id), [0, 0, 0, 0])
                for i, value in enumerate((chats, t_in, t_out, t_24h)):
                    acc[i] += int(value or 0)
            for sid in running.get(entry.hermes_home.resolve(), ()):
                owner = _session_owner(conn, sid)
                if owner:
                    active.add(owner)
        except sqlite3.Error:
            logger.debug("aquarium: unreadable state.db for %s", entry.name, exc_info=True)
        finally:
            conn.close()

    projects: Dict[str, int] = {}
    try:
        from hermes_cli.projects_db import projects_db_path

        conn = _connect_ro(projects_db_path())
    except Exception:
        conn = None
    if conn is not None:
        try:
            projects = {str(u): int(n) for u, n in conn.execute(_PROJECT_COUNTS_SQL)}
        except sqlite3.Error:
            logger.debug("aquarium: unreadable projects DB", exc_info=True)
        finally:
            conn.close()
    return totals, active, projects


async def build_snapshot() -> Dict[str, Any]:
    from hermes_cli.user_prefs import creature_for

    entries = _served_entries()
    enrolled = await _active_principals(entries)
    totals, active, projects = await asyncio.to_thread(_usage, entries)
    default_name = next((e.name for e in entries if e.is_default), "default")

    people: Dict[str, Dict[str, Any]] = {}
    for entry, principals in enrolled:
        for principal in principals:
            person = people.setdefault(
                principal.user_id, {"name": "", "profiles": [], "admin": False}
            )
            if not person["name"] and principal.display:
                person["name"] = principal.display
            if entry.name not in person["profiles"]:
                person["profiles"].append(entry.name)
            person["admin"] = person["admin"] or principal.role in _ADMIN_ROLES

    users = []
    for user_id, person in people.items():
        names = list(person["profiles"])
        if person["admin"] and default_name not in names:
            names.insert(0, default_name)
        chats, t_in, t_out, t_24h = totals.get(user_id, (0, 0, 0, 0))
        users.append(
            {
                "user_id": user_id,
                "name": person["name"] or user_id,
                "creature": creature_for(user_id)[0],
                "metrics": {
                    "chats": chats,
                    "projects": projects.get(user_id, 0),
                    "tokens_in": t_in,
                    "tokens_out": t_out,
                    "tokens_24h": t_24h,
                    "active_now": user_id in active,
                },
                "profiles": [{"name": n, "display_name": n} for n in names],
            }
        )
    users.sort(key=lambda u: (u["name"].casefold(), u["user_id"]))
    return {"generated_at": time.time(), **read_settings(), "users": users}


def _lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    if _cache["loop"] is not loop:
        _cache["loop"], _cache["lock"] = loop, asyncio.Lock()
    return _cache["lock"]


def invalidate_snapshot() -> None:
    _cache["snapshot"] = None


async def cached_snapshot() -> Dict[str, Any]:
    """The box-wide snapshot, rebuilt at most every :data:`SNAPSHOT_TTL_SECONDS`."""

    def fresh() -> Optional[Dict[str, Any]]:
        snap = _cache["snapshot"]
        if snap is not None and time.monotonic() - _cache["at"] < SNAPSHOT_TTL_SECONDS:
            return snap
        return None

    snap = fresh()
    if snap is not None:
        return snap
    async with _lock():
        snap = fresh()
        if snap is None:
            snap = await build_snapshot()
            _cache["snapshot"], _cache["at"] = snap, time.monotonic()
        return snap


@router.get("/api/aquarium/snapshot")
async def get_aquarium_snapshot(request: Request):
    """Every active person as a creature with their usage. Any signed-in person."""
    from hermes_cli import web_server as ws

    user_id = await ws._preferences_user_id(request)
    snap = await cached_snapshot()
    return {
        **snap,
        "users": [{**u, "is_self": u["user_id"] == user_id} for u in snap["users"]],
    }


class AquariumSettingsUpdate(BaseModel):
    idle_seconds: Any = None
    name: Any = None


_SETTERS = {"idle_seconds": set_idle_seconds, "name": set_aquarium_name}


@router.get("/api/aquarium/settings")
async def get_aquarium_settings(request: Request):
    """Idle seconds and display name. Any signed-in person may read them."""
    from hermes_cli import web_server as ws

    await ws._comms_resolve_principal(request)
    return read_settings()


@router.put("/api/aquarium/settings", dependencies=ADMIN)
async def put_aquarium_settings(body: AquariumSettingsUpdate, request: Request):
    """Set any of ``aquarium.idle_seconds`` / ``aquarium.name``; returns all.

    Owner and admin only; 400 when nothing is given or any field is invalid
    (then nothing is saved).
    """
    from hermes_cli import web_server as ws

    fields = [f for f in _SETTERS if f in body.model_fields_set]
    if not fields:
        raise HTTPException(status_code=400, detail="Give idle_seconds and/or name.")
    with ws._profile_scope("default"):
        config = ws.load_config()
        try:
            for field in fields:
                _SETTERS[field](config, getattr(body, field))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        ws.save_config(config)
        result = settings(config)
    invalidate_snapshot()
    return result


class CreatureUpdate(BaseModel):
    creature: Any = None


@router.get("/api/me/creature")
async def get_my_creature(request: Request):
    """The signed-in person's creature; ``chosen`` is false for the fallback."""
    from hermes_cli import web_server as ws
    from hermes_cli.user_prefs import creature_for

    creature, chosen = creature_for(await ws._preferences_user_id(request))
    return {"creature": creature, "chosen": chosen}


@router.put("/api/me/creature")
async def put_my_creature(body: CreatureUpdate, request: Request):
    """Save the signed-in person's creature; nobody else's. 400 for an unknown id."""
    from hermes_cli import web_server as ws
    from hermes_cli.user_prefs import set_creature

    user_id = await ws._preferences_user_id(request)
    try:
        creature = set_creature(user_id, body.creature)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    invalidate_snapshot()
    return {"creature": creature, "chosen": True}
