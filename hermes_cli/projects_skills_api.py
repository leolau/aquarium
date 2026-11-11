"""The project Skills tab: which skills a project's runs used, and how it went.

``GET /api/registry/projects/{slug}/skills?days=90`` rolls up the uses
attributed to the project (card uses; ``skill_ledger._resolve_pending`` fills
the slug) from the skill ledger of every project profile the caller may see,
and ``POST .../skills/candidates/{id}/dismiss`` hides a retro skill
suggestion.

Profiles stay independent islands: each profile's ledger, config and the
caller's role there are read in that profile's own scope, and the same skill
name in two profiles is two rows. Any project reader gets the summary rows
of the profiles they are enrolled in (instance admins: every project
profile); run-level evidence (``/api/skills/usage/detail?project=``), the
candidates' full ``body`` and the AI actions need Skills ``lab`` in the
profile concerned, reported per profile as ``can_lab`` / ``can_manage``.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import projects_api, projects_db, skill_ledger
from hermes_cli.projects_run import parse_skill_field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

PREVIEW_CHARS = 280
DEFAULT_DAYS = 90

#: Why a project profile contributes no rows for this caller.
HIDDEN_NOT_ENROLLED = "not_enrolled"
HIDDEN_UNAVAILABLE = "unavailable"


@dataclass
class _ProfileGrant:
    profile: str
    #: The profile's role in the project (``host`` or ``member``).
    role: str
    home: Optional[Path]
    visible: bool
    can_lab: bool = False
    can_manage: bool = False
    hidden_reason: Optional[str] = None

    def public(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "profile": self.profile,
            "role": self.role,
            "can_lab": self.can_lab,
            "can_manage": self.can_manage,
            "hidden": not self.visible,
        }
        if self.hidden_reason:
            out["hidden_reason"] = self.hidden_reason
        return out


# ---------------------------------------------------------------------------
# Per-profile authority (never merged across profiles)
# ---------------------------------------------------------------------------


def _profile_homes() -> Dict[str, Path]:
    return {h.name: h.hermes_home for h in projects_api._profile_homes()}


def _ordered_profiles(profiles: List[dict]) -> List[dict]:
    """Host first, then the other project profiles by name."""
    return sorted(profiles, key=lambda p: (p.get("role") != "host", p.get("profile") or ""))


def _host_profile(profiles: List[dict]) -> Optional[str]:
    ordered = _ordered_profiles(profiles)
    return ordered[0]["profile"] if ordered else None


@dataclass(frozen=True)
class _Entry:
    name: str
    hermes_home: Path


@dataclass(frozen=True)
class _Operator:
    """A sessionless caller in a profile with no multi-user datastore."""

    user_id: str = ""
    role: str = "owner"
    is_owner: bool = True
    active: bool = True


async def _caller_in(request: Request, subject: str, name: str, home: Path):
    """The caller's active principal in profile ``name``, or None.

    A verified login is re-resolved in that profile's own ``principals``
    (FG-28: the profile is a routing hint, never a grant); a sessionless
    operator caller resolves that profile's owner, as the acting profile does.
    """
    from hermes_cli import web_server as ws
    from hermes_cli.console_scope import (
        ProfileScopeError,
        _scoped_to,
        resolve_console_principal,
    )

    if not subject:
        try:
            with _scoped_to(home):
                return await ws._comms_resolve_principal(request)
        except ws._CommsNotConfigured:
            return _Operator()
        except HTTPException:
            return None
    try:
        from hermes_cli.access import PrincipalStore

        return await resolve_console_principal(
            subject,
            name,
            store_factory=lambda _home: PrincipalStore(ws._comms_app_store()),
            registry=[_Entry(name, home)],
        )
    except (ProfileScopeError, RuntimeError, LookupError, OSError):
        return None


def _skills_rights_sync(principal: Any, home: Path) -> tuple[bool, bool]:
    """``(lab, manage)`` for ``principal`` under ``home``'s Settings → Skills."""
    from hermes_cli.route_roles import _role_allows

    if principal is None:
        return False, False
    if _role_allows(principal, "owner"):
        return True, True
    from hermes_cli.config import load_config
    from hermes_cli.console_scope import _scoped_to
    from tools import skills_access

    role = getattr(principal, "role", None)
    try:
        with _scoped_to(home):
            cfg = load_config()
    except Exception:
        logger.debug("project skills: config unreadable for %s", home, exc_info=True)
        return False, False
    return (
        skills_access.allows(role, "lab", cfg),
        skills_access.allows(role, "manage", cfg),
    )


async def _grants(request: Request, principal: Any, profiles: List[dict]) -> List[_ProfileGrant]:
    homes = await asyncio.to_thread(_profile_homes)
    subject = await projects_api._interactive_subject(request)
    admin = projects_api._instance_admin(principal)
    out: List[_ProfileGrant] = []
    for row in _ordered_profiles(profiles):
        name = row["profile"]
        role = row.get("role") or "member"
        home = homes.get(name)
        if home is None or not home.is_dir():
            out.append(_ProfileGrant(name, role, None, False, hidden_reason=HIDDEN_UNAVAILABLE))
            continue
        there = await _caller_in(request, subject, name, home)
        if there is not None and not getattr(there, "active", True):
            there = None
        if there is None and not admin:
            out.append(_ProfileGrant(name, role, home, False, hidden_reason=HIDDEN_NOT_ENROLLED))
            continue
        lab, manage = await asyncio.to_thread(_skills_rights_sync, there, home)
        out.append(_ProfileGrant(name, role, home, True, can_lab=lab, can_manage=manage))
    return out


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@contextmanager
def _ledger_scope(home: Path) -> Iterator[None]:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        yield


def _skill_meta_sync(profile: str, names: List[str], slug: str) -> Dict[str, Dict[str, Any]]:
    """Category, origin, active version, enabled and ``created_here`` per skill.

    ``created_here``: the skill's first stored version names this project
    (``"project": <slug>`` in its version metadata, or ``project:<slug>`` in
    its message), as the Skills tab's "New skill with AI" records it.
    """
    if not names:
        return {}
    from hermes_cli import web_server as ws

    out: Dict[str, Dict[str, Any]] = {}
    try:
        with ws._profile_scope(profile):
            from hermes_cli.config import load_config
            from hermes_cli.skills_config import get_disabled_skills
            from tools import skill_versions
            from tools import skills_tool as _skills_tool

            disabled = get_disabled_skills(load_config())
            found = {s["name"]: s for s in _skills_tool._find_all_skills(skip_disabled=False)}
            origins = ws._skill_origins(Path(_skills_tool.SKILLS_DIR))
            for name in names:
                skill = found.get(name)
                index: Dict[str, Any] = {"active": None, "versions": []}
                try:
                    skill_versions.validate_name(name)
                    index = skill_versions._read_index(name)
                except Exception:
                    pass
                first = min(index["versions"], key=lambda v: int(v.get("n") or 0), default=None)
                created_here = bool(first) and (
                    first.get("project") == slug
                    or f"project:{slug}" in str(first.get("message") or "")
                )
                out[name] = {
                    "category": (skill or {}).get("category"),
                    "source": origins.get(name, {}).get("source", "local") if skill else None,
                    "version": index.get("active"),
                    "enabled": bool(skill) and name not in disabled,
                    "installed": skill is not None,
                    "created_here": created_here,
                }
    except Exception:
        logger.debug("project skills: skill metadata unavailable in %s", profile, exc_info=True)
    return out


def _run_numbers_sync(project_id: str, task_ids: List[str]) -> Dict[str, int]:
    """``task_id -> run_no`` for the project's cards that belong to a run."""
    ids = sorted({t for t in task_ids if t})
    out: Dict[str, int] = {}
    if not ids:
        return out
    with projects_db.connect_closing() as conn:
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                "SELECT c.task_id, r.run_no FROM project_run_cards c"
                " JOIN project_runs r ON r.id = c.run_id"
                f" WHERE r.project_id = ? AND c.task_id IN ({marks})",
                [project_id, *chunk],
            ).fetchall()
            out.update({r["task_id"]: int(r["run_no"]) for r in rows})
    return out


def _public_row(row: Dict[str, Any], profile: str, meta: Dict[str, Any], runs: int, preloaded: bool) -> Dict[str, Any]:
    out = {
        "name": row["name"],
        "profile": profile,
        "uses": row["uses"],
        "tasks": row["tasks"],
        "runs": runs,
        "success": row["success"],
        "partial": row["partial"],
        "failure": row["failure"],
        "unknown": row["unknown"],
        "rated_down": row["rated_down"],
        "success_rate": row["success_rate"],
        "last_used_at": row["last_used_at"],
        "trend": row["trend"],
        "preloaded": preloaded,
        "created_here": bool(meta.get("created_here")),
        "category": meta.get("category"),
        "source": meta.get("source"),
        "version": meta.get("version"),
        "enabled": meta.get("enabled"),
        # Alias of the three counts above, as the plan's Part B summary names them.
        "outcomes": {"success": row["success"], "partial": row["partial"], "failed": row["failure"]},
    }
    return out


def _candidate(row: dict, *, with_body: bool) -> Dict[str, Any]:
    body = str(row.get("body") or "")
    out: Dict[str, Any] = {
        "id": row["id"],
        "name": row["name"],
        "run_no": row["run_no"],
        "run": row["run_no"],
        "preview": body[:PREVIEW_CHARS],
        "created_at": row["created_at"],
    }
    if with_body:
        out["body"] = body
    return out


def _project_skills_sync(project, profiles: List[dict], grants: List[_ProfileGrant], days: int) -> Dict[str, Any]:
    slug = project.slug
    host = _host_profile(profiles)
    preload_list = parse_skill_field(project.skills)
    rows: List[Dict[str, Any]] = []
    all_cards: set = set()
    run_nos: set = set()
    host_used: set = set()
    for grant in grants:
        if not grant.visible or grant.home is None:
            continue
        try:
            with _ledger_scope(grant.home):
                summary = skill_ledger.project_rollup(slug, days)
                cards = skill_ledger.project_cards(slug, days)
        except Exception:
            logger.warning("project skills: ledger unreadable in profile %s", grant.profile, exc_info=True)
            continue
        task_runs = _run_numbers_sync(project.id, [c["task_id"] for c in cards])
        per_skill_runs: Dict[str, set] = {}
        for c in cards:
            all_cards.add((grant.profile, c["board"], c["task_id"]))
            run_no = task_runs.get(c["task_id"])
            if run_no is not None:
                run_nos.add(run_no)
                per_skill_runs.setdefault(c["skill_name"], set()).add(run_no)
        meta = _skill_meta_sync(grant.profile, [r["name"] for r in summary], slug)
        for row in summary:
            is_preloaded = grant.profile == host and row["name"] in preload_list
            if grant.profile == host:
                host_used.add(row["name"])
            rows.append(
                _public_row(
                    row, grant.profile, meta.get(row["name"], {}),
                    len(per_skill_runs.get(row["name"], ())), is_preloaded,
                )
            )
    rows.sort(key=lambda r: (-r["uses"], r["name"], r["profile"]))

    host_grant = next((g for g in grants if g.profile == host), None)
    with projects_db.connect_closing() as conn:
        candidates = projects_db.list_skill_candidates(conn, project.id, include_dismissed=False)
    with_body = bool(host_grant and host_grant.visible and host_grant.can_lab)

    success = sum(r["success"] for r in rows)
    known = sum(r["success"] + r["partial"] + r["failure"] for r in rows)
    preloaded_unused = [n for n in preload_list if n not in host_used]
    return {
        "days": days,
        "window_days": days,
        "host_profile": host,
        "profiles": [g.public() for g in grants],
        "totals": {
            "skills": len(rows),
            "uses": sum(r["uses"] for r in rows),
            "cards": len(all_cards),
            "runs": len(run_nos),
            "success": success,
            "known": known,
            "first_time_success_rate": round(success / known, 4) if known else None,
            "worth_improving": sum(1 for r in rows if r["failure"] or r["rated_down"]),
        },
        "skills": rows,
        "preloaded_unused": preloaded_unused,
        "unused_preloaded": preloaded_unused,
        "candidates": [_candidate(c, with_body=with_body) for c in candidates],
    }


@router.get("/{slug}/skills")
async def project_skills_route(request: Request, days: int = DEFAULT_DAYS) -> Dict[str, Any]:
    """The project's Skills tab payload (see module docstring)."""
    project, _role, profiles, principal = await projects_api._require_read(request)
    days = skill_ledger._clamp_days(days)
    grants = await _grants(request, principal, profiles)
    return await asyncio.to_thread(_project_skills_sync, project, profiles, grants, days)


@router.post("/{slug}/skills/candidates/{candidate_id}/dismiss")
async def dismiss_skill_candidate_route(request: Request, candidate_id: str) -> Dict[str, Any]:
    """Hide a retro skill suggestion: project writers, or ``lab`` in the host profile."""
    project, role, profiles, principal = await projects_api._require_read(request)
    if not projects_api._can_write(project, role, principal):
        host = _host_profile(profiles)
        grants = await _grants(request, principal, [p for p in profiles if p["profile"] == host])
        if not (grants and grants[0].visible and grants[0].can_lab):
            raise HTTPException(status_code=403, detail="not permitted")
    projects_api._refuse_if_archived(project, "dismissing a skill suggestion")

    def _dismiss_sync() -> Optional[dict]:
        with projects_db.connect_closing() as conn:
            return projects_db.dismiss_skill_candidate(
                conn,
                project_id=project.id,
                candidate_id=candidate_id,
                dismissed_by=getattr(principal, "user_id", None) or None,
            )

    row = await asyncio.to_thread(_dismiss_sync)
    if row is None:
        raise HTTPException(status_code=404, detail="skill suggestion not found")
    out = _candidate(row, with_body=False)
    out["dismissed_at"] = row.get("dismissed_at")
    out["ok"] = True
    return out
