"""Per-role limits on the tools an agent may call and the files it may touch.

Owner and admin keep every tool. Members and viewers lose the tools that run
arbitrary commands (a command denylist can't hold: ``python3 -c`` reads any
file the service account can), and their file tools are confined to their own
folder under ``$HERMES_HOME/workspaces/``. An agent with no logged-in person
is unlimited only when it is trusted local (CLI, TUI, cron, ACP); any other
unresolved session gets ``access.unresolved_role`` (default ``viewer``) and a
per-session folder under ``$HERMES_HOME/workspaces/_unresolved/``.

Overrides live in config.yaml::

    access:
      unresolved_role: viewer                       # or member
      roles:
        member:
          deny_tools: [terminal, code_execution]   # tool or toolset names
          files: own_folder                         # or "any"

Settings → Tools & Integrations in agent-home reads and edits the same knobs
through :func:`role_limits` / :func:`set_role_deny_tools`; this module is the
single source of truth for the defaults.
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import re
from pathlib import Path
from typing import Any, Dict, FrozenSet, Iterable, Iterator, List, Optional, Tuple

_COMMAND_TOOLS: Tuple[str, ...] = (
    "terminal",
    "process",
    "read_terminal",
    "close_terminal",
    "execute_code",
    "cronjob",
    "skill_manage",
)

DEFAULT_DENIED_TOOLS: Dict[str, Tuple[str, ...]] = {
    "owner": (),
    "admin": (),
    "member": _COMMAND_TOOLS,
    "viewer": _COMMAND_TOOLS + ("write_file", "patch"),
}

_FULL_FILE_ROLES = frozenset({"owner", "admin"})

#: Roles whose tool limits can't be changed from the settings page.
LOCKED_ROLES = frozenset({"owner"})

#: Tool groups that let the agent run arbitrary commands; flagged in the UI.
RISKY_GROUPS = frozenset({"terminal", "code_execution"})

_ROLE_PLURALS = {"owner": "The owner", "admin": "Admins", "member": "Members", "viewer": "Viewers"}

#: Tools the configurable toolsets don't list but that belong with a group.
_GROUP_EXTRAS: Dict[str, Tuple[str, ...]] = {
    "terminal": ("read_terminal", "close_terminal"),
}

#: Plain-language phrases for the summary sentence ("Members can't ...").
_SUMMARY_PHRASES: Tuple[Tuple[FrozenSet[str], str], ...] = (
    (frozenset({"terminal", "process", "read_terminal", "close_terminal"}), "use the terminal"),
    (frozenset({"execute_code"}), "run code"),
    (frozenset({"cronjob"}), "schedule jobs"),
    (frozenset({"skill_manage"}), "change skills"),
    (frozenset({"write_file", "patch"}), "write or edit files"),
)

_TOOL_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")

_UNRESOLVED_ROLES = frozenset({"member", "viewer"})
_DEFAULT_UNRESOLVED_ROLE = "viewer"
_UNRESOLVED_FOLDER = "_unresolved"

#: ``(user_id, role, trusted_local, session_key)``. Outside any tool call the
#: process itself is the caller, which is local.
_principal: contextvars.ContextVar[
    Tuple[Optional[str], Optional[str], bool, Optional[str]]
] = contextvars.ContextVar("tool_access_principal", default=(None, None, True, None))


def unresolved_role(config: Optional[Dict[str, Any]] = None) -> str:
    """Role applied to an untrusted session with no resolved person."""
    try:
        if config is None:
            from hermes_cli.config import load_config_readonly

            config = load_config_readonly()
        value = (config.get("access") or {}).get("unresolved_role")
    except Exception:
        value = None
    return value if value in _UNRESOLVED_ROLES else _DEFAULT_UNRESOLVED_ROLE


def _role(user_id: Optional[str], role: Optional[str], trusted_local: bool = False) -> Optional[str]:
    if not user_id:
        return None if trusted_local else unresolved_role()
    from hermes_cli.access import normalize_role

    return normalize_role(role)


def _role_config(role: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    try:
        if config is None:
            from hermes_cli.config import load_config_readonly

            config = load_config_readonly()
        roles = (config.get("access") or {}).get("roles") or {}
        cfg = roles.get(role) if isinstance(roles, dict) else None
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _expand(names) -> FrozenSet[str]:
    import toolsets

    out: set = set()
    for name in names or ():
        name = str(name).strip()
        if not name:
            continue
        if name in toolsets.TOOLSETS:
            out.update(toolsets.resolve_toolset(name))
        else:
            out.add(name)
    return frozenset(out)


def denied_tools(
    user_id: Optional[str], role: Optional[str], *, trusted_local: bool = False
) -> FrozenSet[str]:
    """Tool names *user_id* (holding *role*) may not call; empty when unlimited."""
    r = _role(user_id, role, trusted_local)
    if r is None:
        return frozenset()
    return role_denied_tools(r)


def role_denied_tools(role: str, config: Optional[Dict[str, Any]] = None) -> FrozenSet[str]:
    """Tool names anyone holding *role* may not call (config override or default)."""
    cfg = _role_config(role, config)
    if "deny_tools" in cfg:
        return _expand(cfg.get("deny_tools"))
    return _expand(DEFAULT_DENIED_TOOLS.get(role, _COMMAND_TOOLS))


def role_files_rule(role: str, config: Optional[Dict[str, Any]] = None) -> str:
    """``"any"`` when *role*'s file tools may touch any file, else ``"own_folder"``."""
    files = _role_config(role, config).get("files")
    if files == "any" or (files is None and role in _FULL_FILE_ROLES):
        return "any"
    return "own_folder"


def _folder_name(user_id: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_.@-]", "_", user_id).lstrip(".")
    return name or "_"


def _unresolved_folder(session_key: Optional[str]) -> Path:
    digest = hashlib.sha256(str(session_key or "").encode("utf-8")).hexdigest()[:16]
    return Path(_UNRESOLVED_FOLDER) / digest


def files_root(
    user_id: Optional[str],
    role: Optional[str],
    *,
    trusted_local: bool = False,
    session_key: Optional[str] = None,
) -> Optional[Path]:
    """The only folder *user_id*'s file tools may use, or ``None`` for anywhere.

    An untrusted session with no person always gets a per-session folder.
    """
    r = _role(user_id, role, trusted_local)
    if r is None:
        return None
    if user_id:
        if role_files_rule(r) == "any":
            return None
        folder = Path(_folder_name(str(user_id)))
    else:
        folder = _unresolved_folder(session_key)
    from hermes_constants import get_hermes_home

    root = Path(get_hermes_home()) / "workspaces" / folder
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


@contextlib.contextmanager
def acting_as(
    user_id: Optional[str],
    role: Optional[str],
    *,
    trusted_local: bool = False,
    session_key: Optional[str] = None,
) -> Iterator[None]:
    """Bind the person a tool call runs for, for the duration of the call."""
    token = _principal.set((user_id, role, bool(trusted_local), session_key))
    try:
        yield
    finally:
        _principal.reset(token)


def current_principal() -> Tuple[Optional[str], Optional[str]]:
    """``(user_id, role)`` of the person the current tool call runs for."""
    user_id, role, _trusted, _key = _principal.get()
    return user_id, role


def current_files_root() -> Optional[Path]:
    user_id, role, trusted_local, session_key = _principal.get()
    return files_root(user_id, role, trusted_local=trusted_local, session_key=session_key)


def check_file_access(path: Path) -> Optional[str]:
    """Error message when the bound person may not touch *path*, else ``None``."""
    root = current_files_root()
    if root is None:
        return None
    from tools.path_security import validate_within_dir

    if validate_within_dir(Path(path), root):
        return (
            f"Access denied: you can only use files in your own folder ({root}). "
            "Relative paths start there."
        )
    return None


def blocked_tool_error(function_name: str) -> str:
    return (
        f"'{function_name}' is not available to your role. "
        "Ask the owner or an admin if you need it."
    )


# ── Settings page: read and edit the per-role limits ─────────────────────────


def _tool_groups() -> List[Tuple[str, str, str, Tuple[str, ...]]]:
    """``(name, label, description, tools)`` for every configurable toolset."""
    import toolsets
    from hermes_cli.tools_config import (
        _get_effective_configurable_toolsets,
        gui_toolset_label,
    )

    groups = []
    for name, label, desc in _get_effective_configurable_toolsets():
        try:
            tools = set(toolsets.resolve_toolset(name))
        except Exception:
            tools = set()
        tools.update(_GROUP_EXTRAS.get(name, ()))
        if tools:
            groups.append((name, gui_toolset_label(label), desc, tuple(sorted(tools))))
    return groups


def _summary(role: str, denied: FrozenSet[str], files: str) -> str:
    who = _ROLE_PLURALS.get(role, role.title())
    if role == "owner" and not denied:
        return "The owner can use every tool and any file."
    cant = [phrase for tools, phrase in _SUMMARY_PHRASES if tools & denied]
    others = len(denied.difference(*(tools for tools, _ in _SUMMARY_PHRASES)))
    if others:
        cant.append(f"use {others} other tool{'s' if others != 1 else ''}")
    if cant:
        head = cant[0] if len(cant) == 1 else ", ".join(cant[:-1]) + " or " + cant[-1]
        tools_part = f"{who} can't {head}."
    else:
        tools_part = f"{who} can use every tool."
    files_part = "can use any file" if files == "any" else "can only use files in their own folder"
    return f"{tools_part} They {files_part}."


def role_limits(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Effective tool and file limits for every role, for the settings page."""
    from hermes_cli.access import ROLES

    groups = _tool_groups()
    grouped = {t for *_, tools in groups for t in tools}
    out = []
    for role in ROLES:
        cfg = _role_config(role, config)
        denied = role_denied_tools(role, config)
        files = role_files_rule(role, config)
        role_groups = []
        for name, label, desc, tools in groups:
            blocked = [t for t in tools if t in denied]
            state = "blocked" if len(blocked) == len(tools) else "partial" if blocked else "allowed"
            role_groups.append({
                "name": name,
                "label": label,
                "description": desc,
                "risky": name in RISKY_GROUPS,
                "state": state,
                "tools": list(tools),
                "blocked_tools": blocked,
            })
        out.append({
            "role": role,
            "label": _ROLE_PLURALS.get(role, role.title()),
            "locked": role in LOCKED_ROLES,
            "customised": "deny_tools" in cfg,
            "files": files,
            "files_customised": "files" in cfg,
            "summary": _summary(role, denied, files),
            "blocked_tools": sorted(denied),
            "other_blocked_tools": sorted(denied - grouped),
            "groups": role_groups,
        })
    return out


def _compact(names: Iterable[str]) -> List[str]:
    """Write whole groups as their toolset name, leftover tools by name."""
    import toolsets

    remaining = set(names)
    wanted = set(remaining)
    out: List[str] = []
    for name, *_ in _tool_groups():
        if name not in toolsets.TOOLSETS:
            continue
        try:
            tools = set(toolsets.resolve_toolset(name))
        except Exception:
            continue
        if tools and tools <= wanted and tools & remaining:
            out.append(name)
            remaining -= tools
    return out + sorted(remaining)


def _check_editable(role: str) -> None:
    from hermes_cli.access import ROLES

    if role not in ROLES:
        raise ValueError(f"Unknown role: {role}")
    if role in LOCKED_ROLES:
        raise ValueError("The owner always has every tool.")


def set_role_deny_tools(config: Dict[str, Any], role: str, names: Iterable[str]) -> List[str]:
    """Store *names* as *role*'s blocked tools in *config*; returns what was stored.

    Raises ``ValueError`` for an unknown or locked role or a malformed name.
    """
    _check_editable(role)
    clean = set()
    for name in names:
        name = str(name).strip()
        if not _TOOL_NAME_RE.match(name):
            raise ValueError(f"Not a tool name: {name!r}")
        clean.add(name)
    stored = _compact(_expand(clean))
    access = config.get("access")
    if not isinstance(access, dict):
        access = config["access"] = {}
    roles = access.get("roles")
    if not isinstance(roles, dict):
        roles = access["roles"] = {}
    entry = roles.get(role)
    if not isinstance(entry, dict):
        entry = roles[role] = {}
    entry["deny_tools"] = stored
    return stored


def reset_role_deny_tools(config: Dict[str, Any], role: str) -> None:
    """Drop *role*'s blocked-tools override so the defaults apply again."""
    _check_editable(role)
    roles = (config.get("access") or {}).get("roles")
    if not isinstance(roles, dict):
        return
    entry = roles.get(role)
    if isinstance(entry, dict):
        entry.pop("deny_tools", None)
        if not entry:
            roles.pop(role, None)
    if not roles:
        config["access"].pop("roles", None)
        if not config["access"]:
            config.pop("access", None)
