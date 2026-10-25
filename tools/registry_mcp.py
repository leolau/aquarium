"""App MCP endpoints from the ``mcp_endpoints`` registry, chosen once per chat.

FG-33 apps (local ``la-<slug>``, external ``xa-<slug>``) register an MCP
endpoint in the FG-11 registry. Every chat sees every *enabled* app endpoint
its person may see under contract C2 (decision 17), resolved when the chat's
agent is first built and pinned in ``sessions.model_config._registry_mcp``.
An app registered, enabled or extended later reaches the *next* chat only:
the current chat's tool list (and so its prompt cache) never grows mid-chat.

Like :mod:`tools.personal_mcp`, the tools are never reached through a
toolset: their registry ``check_fn`` is always false (see
``tools.mcp_tool._register_server_tools``), so only this module adds them, to
the chats of people the endpoint was resolved for, and a call from anyone
else is refused (:func:`blocked_call_error`).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

SESSION_KEY = "_registry_mcp"
CONNECT_TIMEOUT = 15
RETRY_AFTER = 300
LOAD_TIMEOUT = 10
APP_SERVER_PREFIXES = ("la-", "xa-")

#: ``secret_ref`` names a token file in ``$HERMES_HOME/auth/mcp-secrets/``.
SECRETS_RELDIR = Path("auth") / "mcp-secrets"
_VALID_SECRET_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")

#: Platforms whose datastore mode may follow ``datastore.mode``; every other
#: (channel) origin is production (see ``hermes_cli.datastore.resolve_mode``).
_LOCAL_PLATFORMS = {"", "cli", "local", "api_server"}

_lock = threading.Lock()
_grants: Dict[str, Set[str]] = {}
_fingerprints: Dict[str, str] = {}
_failed_at: Dict[str, float] = {}
_session_choice: "OrderedDict[str, Tuple[str, Tuple[str, ...]]]" = OrderedDict()
_SESSION_CACHE_MAX = 2048


def is_app_server(name: str) -> bool:
    """Whether *name* is an FG-33 app MCP server (``la-*`` / ``xa-*``)."""
    return str(name or "").startswith(APP_SERVER_PREFIXES)


def is_registry_server(name: str) -> bool:
    with _lock:
        return name in _grants


def blocked_call_error(server: str, user_id: Optional[str]) -> Optional[str]:
    """Error text when *user_id*'s chat was not given *server*, else ``None``."""
    with _lock:
        granted = _grants.get(server)
        if granted is None or (user_id and str(user_id) in granted):
            return None
    return (
        f"The app tools of '{server}' were not set up for this chat and "
        "can't be used here."
    )


# -- secrets ------------------------------------------------------------------


def _secrets_dir() -> Path:
    home = os.environ.get("HERMES_HOME", "").strip()
    if not home:
        from hermes_constants import get_hermes_home

        home = str(get_hermes_home())
    return Path(home) / SECRETS_RELDIR


def read_secret(ref: str) -> str:
    """The token *ref* names, or ``""`` when it is malformed or absent."""
    if not isinstance(ref, str) or not _VALID_SECRET_REF.fullmatch(ref):
        return ""
    try:
        return (_secrets_dir() / ref).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


# -- connecting -----------------------------------------------------------------


def _fingerprint(config: Dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def _server_tool_names(server: str) -> List[str]:
    from tools import mcp_tool

    with mcp_tool._lock:
        task = mcp_tool._servers.get(server)
        return list(getattr(task, "_registered_tool_names", []) or [])


def drop_server(server: str) -> None:
    """Disconnect one registry server and forget its tools (idempotent)."""
    from tools import mcp_tool

    with mcp_tool._lock:
        task = mcp_tool._servers.pop(server, None)
    with _lock:
        _fingerprints.pop(server, None)
        _failed_at.pop(server, None)
    if task is None:
        return
    try:
        mcp_tool._run_on_mcp_loop(task.shutdown(), timeout=15)
    except Exception:  # noqa: BLE001 - best effort; tools are dropped below
        logger.debug("registry MCP '%s': shutdown failed", server, exc_info=True)
    task._deregister_tools()


def connect(user_id: str, servers: Dict[str, Dict[str, Any]]) -> List[str]:
    """Connect the endpoints *user_id* may use; returns the ones live now."""
    from tools import mcp_tool

    if not servers or not getattr(mcp_tool, "_MCP_AVAILABLE", False):
        return []
    wanted: Dict[str, Dict[str, Any]] = {}
    now = time.monotonic()
    for server, cfg in servers.items():
        fp = _fingerprint(cfg)
        with _lock:
            current_fp = _fingerprints.get(server)
            failed = _failed_at.get(server)
        if current_fp is not None and current_fp != fp:
            drop_server(server)
            failed = None
        with _lock:
            _grants.setdefault(server, set()).add(str(user_id))
        with mcp_tool._lock:
            connected = server in mcp_tool._servers
        if connected:
            continue
        if failed is not None and now - failed < RETRY_AFTER:
            continue
        with _lock:
            _fingerprints[server] = fp
        wanted[server] = {**cfg, "connect_timeout": CONNECT_TIMEOUT}
    if wanted:
        try:
            mcp_tool.register_mcp_servers(wanted)
        except Exception:  # noqa: BLE001 - a chat must still start
            logger.warning("registry MCP: connect failed", exc_info=True)
        with mcp_tool._lock:
            live = set(mcp_tool._servers)
        with _lock:
            for server in wanted:
                if server not in live:
                    _failed_at[server] = time.monotonic()
                    _fingerprints.pop(server, None)
    with mcp_tool._lock:
        live = set(mcp_tool._servers)
    return [server for server in servers if server in live]


def tool_definitions(servers: Iterable[str]) -> List[dict]:
    """OpenAI-format schemas of the tools the connected *servers* registered.

    Read straight from the registry entries: their ``check_fn`` hides them
    from every toolset-based listing.
    """
    from tools.registry import registry

    defs: List[dict] = []
    for server in servers:
        for name in sorted(_server_tool_names(server)):
            entry = registry.get_entry(name)
            if entry is not None:
                defs.append({"type": "function", "function": {**entry.schema, "name": name}})
    return defs


# -- chat start -----------------------------------------------------------------


def _stored_choice(db: Any, session_id: str, user_id: str) -> Optional[List[str]]:
    """Names pinned for this chat (or the chat it continues), else ``None``."""
    from tools.personal_mcp import _session_model_config

    sid: Optional[str] = session_id
    for _ in range(2):
        if not sid:
            return None
        cfg = _session_model_config(db, sid)
        if cfg is None:
            return None
        stored = cfg.get(SESSION_KEY)
        if isinstance(stored, dict) and stored.get("user") == user_id:
            return [str(n) for n in stored.get("servers") or []]
        sid = cfg.get("__parent__")
    return None


def _store_choice(db: Any, session_id: str, user_id: str, names: List[str]) -> bool:
    """Pin the choice on an existing session row; ``False`` when none yet."""
    from tools.personal_mcp import _session_model_config

    cfg = _session_model_config(db, session_id)
    if cfg is None:
        return False
    cfg.pop("__parent__", None)
    cfg[SESSION_KEY] = {"user": user_id, "servers": names}
    try:
        db.update_session_meta(session_id, json.dumps(cfg))
    except Exception:  # noqa: BLE001 - the in-process copy still holds
        logger.debug("registry MCP: could not store chat choice", exc_info=True)
    return True


def choose_for_session(
    session_id: Optional[str],
    user_id: str,
    available: List[str],
    db: Any = None,
    new_session_config: Optional[dict] = None,
) -> List[str]:
    """The app endpoints this chat uses: fixed on its first call.

    Endpoints that appear later are not added; ones switched off or no longer
    visible drop out (the person may not use them any more).
    """
    if not session_id:
        return list(available)
    with _lock:
        cached = _session_choice.get(session_id)
    if cached is not None and cached[0] == user_id:
        chosen = list(cached[1])
    else:
        chosen = _stored_choice(db, session_id, user_id) if db is not None else None
        if chosen is None:
            chosen = list(available)
            stored = db is not None and _store_choice(db, session_id, user_id, chosen)
            if not stored and isinstance(new_session_config, dict):
                new_session_config[SESSION_KEY] = {"user": user_id, "servers": chosen}
        with _lock:
            _session_choice[session_id] = (user_id, tuple(chosen))
            _session_choice.move_to_end(session_id)
            while len(_session_choice) > _SESSION_CACHE_MAX:
                _session_choice.popitem(last=False)
    keep = set(available)
    return [n for n in chosen if n in keep]


def _mode_for(platform: Optional[str]) -> str:
    if str(platform or "").lower() not in _LOCAL_PLATFORMS:
        return "prod"
    from hermes_cli.datastore import resolve_mode

    return resolve_mode(None)


def load_endpoint_configs(user_id: str, role: str, mode: str) -> Dict[str, Dict[str, Any]]:
    """``{name: client config}`` for the enabled app endpoints *user_id* may see."""
    from hermes_cli.access import Principal
    from hermes_cli.datastore import get_store
    from hermes_cli.mcp_endpoints import MCPEndpointRegistry
    from hermes_cli.principal_binding import _run_async

    principal = Principal(user_id=user_id, display=user_id, role=role)  # type: ignore[arg-type]
    registry = MCPEndpointRegistry(get_store("supabase-app", mode))  # type: ignore[arg-type]
    configs = _run_async(
        registry.resolve_server_configs(principal, apps_only=True), timeout=LOAD_TIMEOUT
    )
    return {
        name: cfg for name, cfg in (configs or {}).items() if is_app_server(name)
    }


def apply_registry_endpoints(agent: Any) -> None:
    """Add the chat's app MCP tools to a freshly built agent.

    Sets ``agent._registry_mcp_defs`` (re-added by every tool-list refresh) and
    appends them to ``agent.tools``. Fail-soft: a chat always starts.
    """
    agent._registry_mcp_defs = []
    user_id = getattr(agent, "_internal_user_id", None)
    role = getattr(agent, "_internal_user_role", None)
    if not user_id or not role:
        return
    try:
        servers = load_endpoint_configs(
            str(user_id), str(role), _mode_for(getattr(agent, "platform", None))
        )
    except Exception:  # noqa: BLE001
        logger.warning("registry MCP: could not read app endpoints", exc_info=True)
        return
    if not servers:
        return
    chosen = choose_for_session(
        getattr(agent, "session_id", None),
        str(user_id),
        sorted(servers),
        getattr(agent, "_session_db", None),
        getattr(agent, "_session_init_model_config", None),
    )
    if not chosen:
        return
    live = connect(str(user_id), {n: servers[n] for n in chosen})
    defs = tool_definitions(live)
    if not defs:
        return
    agent._registry_mcp_defs = defs
    have = {t["function"]["name"] for t in (agent.tools or [])}
    agent.tools = list(agent.tools or []) + [
        d for d in defs if d["function"]["name"] not in have
    ]


def reinject(agent: Any, tools_list: list, name_set: set) -> None:
    """Put the chat's app tools back after a tool-list rebuild."""
    for schema in getattr(agent, "_registry_mcp_defs", None) or []:
        name = schema["function"]["name"]
        if name not in name_set:
            tools_list.append(schema)
            name_set.add(name)


def _reset_for_tests() -> None:
    with _lock:
        _grants.clear()
        _fingerprints.clear()
        _failed_at.clear()
        _session_choice.clear()
