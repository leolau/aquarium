"""Which agent-home menu items each role sees.

Stored in the default profile's config.yaml as
``agent_home.nav.roles.<role>.hidden: [app ids]``. The owner always sees every
item; ``home`` and ``settings`` are locked visible for every role so nobody can
hide their way out. ``ADMIN_ONLY_APP_IDS`` (Profiles, Skills) are the reverse:
locked hidden for members and viewers, because only an owner/admin can change
anything there and the API refuses everyone else anyway. ``KNOWN_APP_IDS`` mirrors the Coral registry in
``agent-home/src/components/coral/coral-apps.ts`` (a Vitest test keeps the two
in sync).
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List

NAV_ROLES = ("admin", "member", "viewer")

LOCKED_APP_IDS = ("home", "settings")

ADMIN_ONLY_APP_IDS = ("profiles", "skills")
ADMIN_ONLY_ROLES = ("member", "viewer")

KNOWN_APP_IDS = (
    "home",
    "todos",
    "chat",
    "inbox",
    "memory",
    "projects",
    "files",
    "activity",
    "graph",
    "capacity",
    "users",
    "suggestions",
    "profiles",
    "skills",
    "tools",
    "models",
    "core",
    "webview",
    "settings",
    "onboarding",
)


def _roles_section(config: Dict[str, Any]) -> Dict[str, Any]:
    agent_home = config.get("agent_home")
    nav = agent_home.get("nav") if isinstance(agent_home, dict) else None
    roles = nav.get("roles") if isinstance(nav, dict) else None
    return roles if isinstance(roles, dict) else {}


def _with_admin_only(role: str, hidden: List[str]) -> List[str]:
    if role in ADMIN_ONLY_ROLES:
        hidden.extend(a for a in ADMIN_ONLY_APP_IDS if a not in hidden)
    return hidden


def role_hidden(config: Dict[str, Any], role: str) -> List[str]:
    """*role*'s stored hidden list, minus unknown/locked ids (hand edits),
    plus the admin-only apps for members and viewers."""
    entry = _roles_section(config).get(role)
    raw = entry.get("hidden") if isinstance(entry, dict) else None
    out: List[str] = []
    if not isinstance(raw, list):
        return _with_admin_only(role, out)
    for item in raw:
        if (
            isinstance(item, str)
            and item in KNOWN_APP_IDS
            and item not in LOCKED_APP_IDS
            and item not in out
        ):
            out.append(item)
    return _with_admin_only(role, out)


def all_role_hidden(config: Dict[str, Any]) -> Dict[str, List[str]]:
    return {role: role_hidden(config, role) for role in NAV_ROLES}


def effective_hidden(config: Dict[str, Any], role: str, is_owner: bool) -> List[str]:
    """What the caller must not see: nothing for the owner (or an unknown role)."""
    if is_owner or role not in NAV_ROLES:
        return []
    return role_hidden(config, role)


def set_role_hidden(config: Dict[str, Any], role: str, hidden: Iterable[Any]) -> List[str]:
    """Store *hidden* for *role* in *config*; returns what was stored.

    Raises ``ValueError`` for an unknown role (the owner is not editable) or an
    unknown, duplicate or locked app id. Admin-only apps are always stored as
    hidden for members and viewers, whatever *hidden* says.
    """
    if role not in NAV_ROLES:
        raise ValueError(
            f"Unknown role {role!r}: choose one of {', '.join(NAV_ROLES)} "
            "(the owner always sees everything)."
        )
    clean: List[str] = []
    for item in hidden:
        if not isinstance(item, str) or item not in KNOWN_APP_IDS:
            raise ValueError(f"Unknown menu item: {item!r}")
        if item in LOCKED_APP_IDS:
            raise ValueError(f"{item!r} is always visible and cannot be hidden.")
        if item in clean:
            raise ValueError(f"Duplicate menu item: {item!r}")
        clean.append(item)
    _with_admin_only(role, clean)
    agent_home = config.get("agent_home")
    if not isinstance(agent_home, dict):
        agent_home = config["agent_home"] = {}
    nav = agent_home.get("nav")
    if not isinstance(nav, dict):
        nav = agent_home["nav"] = {}
    roles = nav.get("roles")
    if not isinstance(roles, dict):
        roles = nav["roles"] = {}
    entry = roles.get(role)
    if not isinstance(entry, dict):
        entry = roles[role] = {}
    entry["hidden"] = clean
    return clean
