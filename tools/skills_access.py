"""Per-role skill permissions: the five rows of Settings → Skills permissions.

``use`` and ``agent_edit`` are tool rows: they read and write the role's
``access.roles.<role>.deny_tools`` (see :mod:`tools.access_policy`), so the
Tools & Integrations grid stays the single source of truth for tools.
``view``, ``manage`` and ``lab`` gate the skills API and live in::

    access:
      roles:
        member:
          skills: {view: false, manage: false, lab: false}

Implications hold on every write: ``manage`` and ``lab`` need ``view``,
``agent_edit`` needs ``use``. The owner always has every row.
"""

from __future__ import annotations

from typing import Any, Dict, FrozenSet, List, Mapping, Optional, Tuple

from tools import access_policy

ACTIONS: Tuple[Tuple[str, str, str], ...] = (
    (
        "use",
        "Agent uses skills in their chats",
        "The agent can list and read skills while it works for them.",
    ),
    (
        "view",
        "See the skill list and read skills",
        "The Skills app: the list of skills and each skill's page.",
    ),
    (
        "agent_edit",
        "Ask the agent to create or edit skills (incl. /learn)",
        "The agent can write new skills or change existing ones for them.",
    ),
    (
        "manage",
        "Create, edit, turn on/off or install skills in settings",
        "New skill, edit, the on/off switch and installing from the hub.",
    ),
    (
        "lab",
        "Skills Lab: Usage, Versions, Improve",
        "See how skills are used, their versions, and improve them.",
    ),
)
ACTION_KEYS: Tuple[str, ...] = tuple(key for key, _, _ in ACTIONS)

#: The tool-backed rows and the tools each one allows.
TOOL_ROWS: Dict[str, FrozenSet[str]] = {
    "use": frozenset({"skills_list", "skill_view"}),
    "agent_edit": frozenset({"skill_manage"}),
}
#: The rows stored under ``access.roles.<role>.skills``.
API_ROWS: Tuple[str, ...] = ("view", "manage", "lab")

#: ``row -> the row it needs``.
_NEEDS: Dict[str, str] = {"manage": "view", "lab": "view", "agent_edit": "use"}

_DEFAULT_API: Dict[str, Dict[str, bool]] = {
    "owner": {"view": True, "manage": True, "lab": True},
    "admin": {"view": True, "manage": True, "lab": True},
    "member": {"view": False, "manage": False, "lab": False},
    "viewer": {"view": False, "manage": False, "lab": False},
}
_LOCKED = frozenset({"owner"})
_ROLE_LABELS = {
    "owner": "The owner",
    "admin": "Admins",
    "member": "Members",
    "viewer": "Viewers",
}

OWNER_LOCKED = "The owner can always do everything with skills."
ADMIN_ROW_DENIED = "Only the owner can change what admins can do."
EDIT_DENIED = "Only the owner or an admin can change skills permissions."


def _roles() -> Tuple[str, ...]:
    from hermes_cli.access import ROLES

    return tuple(ROLES)


def _skills_config(role: str, config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    raw = access_policy._role_config(role, config).get("skills")
    return raw if isinstance(raw, dict) else {}


def _default_denied(role: str) -> FrozenSet[str]:
    return access_policy._expand(
        access_policy.DEFAULT_DENIED_TOOLS.get(role, access_policy._COMMAND_TOOLS)
    )


def _tool_rows(denied: FrozenSet[str]) -> Dict[str, bool]:
    return {row: not (tools & denied) for row, tools in TOOL_ROWS.items()}


def _api_rows(role: str, config: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    stored = _skills_config(role, config)
    defaults = _DEFAULT_API.get(role, _DEFAULT_API["viewer"])
    rows = {
        key: stored[key] if isinstance(stored.get(key), bool) else defaults[key]
        for key in API_ROWS
    }
    # A hand-edited ``manage: true, view: false`` fails closed.
    if not rows["view"]:
        rows["manage"] = rows["lab"] = False
    return rows


def role_actions(role: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, bool]:
    """The five rows for *role*, in :data:`ACTION_KEYS` order."""
    if role in _LOCKED:
        return {key: True for key in ACTION_KEYS}
    rows = {
        **_tool_rows(access_policy.role_denied_tools(role, config)),
        **_api_rows(role, config),
    }
    return {key: rows[key] for key in ACTION_KEYS}


def allows(
    role: Optional[str], action: str, config: Optional[Dict[str, Any]] = None
) -> bool:
    """Whether *role* has *action*; an unknown role is treated as a viewer."""
    if action not in ACTION_KEYS:
        raise ValueError(f"Unknown skills action: {action}")
    from hermes_cli.access import normalize_role

    return role_actions(normalize_role(role), config)[action]


def _customised(role: str, config: Optional[Dict[str, Any]]) -> bool:
    if role in _LOCKED:
        return False
    if any(isinstance(_skills_config(role, config).get(k), bool) for k in API_ROWS):
        return True
    denied = access_policy.role_denied_tools(role, config)
    return _tool_rows(denied) != _tool_rows(_default_denied(role))


def can_edit(caller_role: Optional[str], caller_is_owner: bool, role: str) -> bool:
    """Whether the caller may change *role*'s column."""
    if role in _LOCKED or role not in _roles():
        return False
    if caller_is_owner or caller_role == "owner":
        return True
    return caller_role == "admin" and role != "admin"


def check_edit(caller_role: Optional[str], caller_is_owner: bool, role: str) -> None:
    """Raise ``ValueError`` (bad role → 400) or ``PermissionError`` (→ 403)."""
    if role not in _roles():
        raise ValueError(f"Unknown role: {role}")
    if role in _LOCKED:
        raise ValueError(OWNER_LOCKED)
    if can_edit(caller_role, caller_is_owner, role):
        return
    if role == "admin" and caller_role == "admin":
        raise PermissionError(ADMIN_ROW_DENIED)
    raise PermissionError(EDIT_DENIED)


def normalise(
    current: Mapping[str, bool], changes: Mapping[str, Any]
) -> Dict[str, bool]:
    """Apply *changes* to *current* and restore the implications.

    Turning a row on turns on what it needs; turning a row off turns off what
    needs it. When a request asks for both (``view: false, manage: true``) the
    "off" wins.
    """
    unknown = sorted(set(changes) - set(ACTION_KEYS))
    if unknown:
        raise ValueError(f"Unknown skills action: {', '.join(unknown)}")
    for key, value in changes.items():
        if not isinstance(value, bool):
            raise ValueError(f"{key} must be true or false")
    rows = {key: bool(current.get(key, False)) for key in ACTION_KEYS}
    rows.update(changes)
    for row, need in _NEEDS.items():
        if changes.get(row) is True and changes.get(need) is not False:
            rows[need] = True
    for row, need in _NEEDS.items():
        if changes.get(need) is False or not rows[need]:
            rows[row] = False
    return rows


def _role_entry(config: Dict[str, Any], role: str) -> Dict[str, Any]:
    access = config.get("access")
    if not isinstance(access, dict):
        access = config["access"] = {}
    roles = access.get("roles")
    if not isinstance(roles, dict):
        roles = access["roles"] = {}
    entry = roles.get(role)
    if not isinstance(entry, dict):
        entry = roles[role] = {}
    return entry


def _write_tool_rows(
    config: Dict[str, Any], role: str, rows: Mapping[str, bool]
) -> None:
    current = access_policy.role_denied_tools(role, config)
    if _tool_rows(current) == {row: rows[row] for row in TOOL_ROWS}:
        return
    denied = set(current)
    for row, tools in TOOL_ROWS.items():
        if rows[row]:
            denied -= tools
        else:
            denied |= tools
    if frozenset(denied) == _default_denied(role):
        access_policy.reset_role_deny_tools(config, role)
    else:
        access_policy.set_role_deny_tools(config, role, denied)


def set_role_actions(
    config: Dict[str, Any], role: str, changes: Mapping[str, Any]
) -> Dict[str, bool]:
    """Store *changes* (a partial ``{action: bool}``) for *role*; returns the rows.

    Raises ``ValueError`` for an unknown or locked role, an unknown action or
    a non-boolean value. Callers check who may edit (:func:`check_edit`).
    """
    if role not in _roles():
        raise ValueError(f"Unknown role: {role}")
    if role in _LOCKED:
        raise ValueError(OWNER_LOCKED)
    rows = normalise(role_actions(role, config), changes)
    _write_tool_rows(config, role, rows)
    _role_entry(config, role)["skills"] = {key: rows[key] for key in API_ROWS}
    return role_actions(role, config)


def reset_role_actions(config: Dict[str, Any], role: str) -> Dict[str, bool]:
    """Put *role*'s five rows back to the defaults; other tool limits stay."""
    if role not in _roles():
        raise ValueError(f"Unknown role: {role}")
    if role in _LOCKED:
        raise ValueError(OWNER_LOCKED)
    _write_tool_rows(config, role, _tool_rows(_default_denied(role)))
    roles = (config.get("access") or {}).get("roles")
    if isinstance(roles, dict) and isinstance(roles.get(role), dict):
        roles[role].pop("skills", None)
        if not roles[role]:
            roles.pop(role, None)
        if not roles:
            config["access"].pop("roles", None)
            if not config["access"]:
                config.pop("access", None)
    return role_actions(role, config)


def matrix(
    config: Optional[Dict[str, Any]], caller_role: Optional[str], caller_is_owner: bool
) -> Dict[str, Any]:
    """The Settings → Skills permissions payload, ``editable`` computed for the caller."""
    actions: List[Dict[str, str]] = [
        {"key": key, "label": label, "description": desc}
        for key, label, desc in ACTIONS
    ]
    roles = [
        {
            "role": role,
            "label": _ROLE_LABELS.get(role, role.title()),
            "locked": role in _LOCKED,
            "editable": can_edit(caller_role, caller_is_owner, role),
            "customised": _customised(role, config),
            "actions": role_actions(role, config),
        }
        for role in _roles()
    ]
    return {"actions": actions, "roles": roles}
