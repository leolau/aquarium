"""Per-person MCP servers at chat time (Get ready item 8).

Each person can add their own MCP servers (stored per person in the
credential store, see ``hermes_cli/personal_mcp.py``). This module is the
runtime half:

* a personal server connects under an internal name ``p<hash>_<name>`` that
  is unique per person, so two people's "notion" never share a connection,
  tool names or OAuth tokens;
* its tools never come out of ``get_tool_definitions`` (no toolset reaches
  them), so no chat, cron job, CLI run or subagent sees them by accident;
* :func:`apply_to_agent` adds the owner's tools to that person's agent when it
  is built. Which servers a chat uses is decided once, on the chat's first
  agent build, and kept for the whole chat (prompt caching): a server added
  later shows up in the next new chat;
* :func:`blocked_call_error` refuses a call to a personal tool from anyone but
  its owner, whatever the model asks for.

Install-wide ``mcp_servers`` in config.yaml are untouched by all of this.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

#: ``sessions.model_config`` key holding the server names a chat started with.
SESSION_KEY = "_personal_mcp"
#: Seconds to wait for one personal server while a chat starts.
CONNECT_TIMEOUT = 15
#: After a failed connect, don't retry that server for this long (seconds),
#: so a dead server can't add CONNECT_TIMEOUT to every chat turn.
RETRY_AFTER = 300

_lock = threading.Lock()
#: internal server name -> owner user id
_owners: Dict[str, str] = {}
#: internal server name -> fingerprint of the config it connected with
_fingerprints: Dict[str, str] = {}
#: internal server name -> monotonic time of the last failed connect
_failed_at: Dict[str, float] = {}
#: session id -> (owner user id, server names) chosen at chat start
_session_choice: "OrderedDict[str, Tuple[str, Tuple[str, ...]]]" = OrderedDict()
_SESSION_CACHE_MAX = 2048


def internal_name(user_id: str, name: str) -> str:
    """The process-wide server name for *user_id*'s server *name*."""
    digest = hashlib.sha256(str(user_id).encode("utf-8")).hexdigest()[:8]
    from tools.mcp_tool import sanitize_mcp_name_component

    return f"p{digest}_{sanitize_mcp_name_component(name)}"


def _fingerprint(config: Dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(config, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def owner_of_server(server: str) -> Optional[str]:
    with _lock:
        return _owners.get(server)


def _server_of_tool(tool_name: str) -> Optional[str]:
    try:
        from tools import mcp_tool
    except Exception:  # pragma: no cover - mcp package missing
        return None
    with mcp_tool._lock:
        return mcp_tool._mcp_tool_server_names.get(tool_name)


def owner_of_tool(tool_name: str) -> Optional[str]:
    """The person a registered tool belongs to, or ``None`` for shared tools."""
    if not tool_name.startswith("mcp_"):
        return None
    server = _server_of_tool(tool_name)
    return owner_of_server(server) if server else None


def personal_tool_names(names: Iterable[str]) -> Set[str]:
    """The subset of *names* that are someone's personal MCP tools."""
    with _lock:
        if not _owners:
            return set()
    return {n for n in names if owner_of_tool(n) is not None}


def blocked_call_error(tool_name: str, user_id: Optional[str]) -> Optional[str]:
    """Error text when *user_id* may not call *tool_name*, else ``None``."""
    owner = owner_of_tool(tool_name)
    if owner is None or (user_id and owner == user_id):
        return None
    return (
        f"The tool '{tool_name}' belongs to another person's own tools and "
        "can't be used in this chat."
    )


def _server_tool_names(server: str) -> List[str]:
    from tools import mcp_tool

    with mcp_tool._lock:
        task = mcp_tool._servers.get(server)
        return list(getattr(task, "_registered_tool_names", []) or [])


def drop_server(server: str) -> None:
    """Disconnect one personal server and forget its tools (idempotent)."""
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
        logger.debug("personal MCP '%s': shutdown failed", server, exc_info=True)
    task._deregister_tools()


def connect(user_id: str, servers: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    """Connect *user_id*'s servers (name -> config). Returns name -> internal name
    for the ones that are connected now."""
    from tools import mcp_tool

    if not servers or not getattr(mcp_tool, "_MCP_AVAILABLE", False):
        return {}
    wanted: Dict[str, Dict[str, Any]] = {}
    names: Dict[str, str] = {}
    now = time.monotonic()
    for name, cfg in servers.items():
        server = internal_name(user_id, name)
        names[name] = server
        fp = _fingerprint(cfg)
        with _lock:
            current_fp = _fingerprints.get(server)
            failed = _failed_at.get(server)
        if current_fp is not None and current_fp != fp:
            drop_server(server)
            failed = None
        with mcp_tool._lock:
            connected = server in mcp_tool._servers
        if connected:
            continue
        if failed is not None and now - failed < RETRY_AFTER:
            continue
        with _lock:
            _owners[server] = user_id
            _fingerprints[server] = fp
        wanted[server] = {**cfg, "connect_timeout": CONNECT_TIMEOUT}
    if wanted:
        try:
            mcp_tool.register_mcp_servers(wanted)
        except Exception:  # noqa: BLE001 - a chat must still start
            logger.warning("personal MCP: connect failed", exc_info=True)
        with mcp_tool._lock:
            live = set(mcp_tool._servers)
        with _lock:
            for server in wanted:
                if server not in live:
                    _failed_at[server] = time.monotonic()
                    _fingerprints.pop(server, None)
    with mcp_tool._lock:
        live = set(mcp_tool._servers)
    return {name: server for name, server in names.items() if server in live}


def tool_definitions(servers: Iterable[str]) -> List[dict]:
    """OpenAI-format schemas of the tools the connected *servers* registered."""
    from tools.registry import registry

    names: Set[str] = set()
    for server in servers:
        names.update(_server_tool_names(server))
    if not names:
        return []
    return registry.get_definitions(names, quiet=True)


# -- chat start ---------------------------------------------------------------


def _session_model_config(db: Any, session_id: str) -> Optional[dict]:
    try:
        row = db.get_session(session_id)
    except Exception:  # noqa: BLE001
        return None
    if not row:
        return None
    raw = row.get("model_config")
    try:
        cfg = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) else {}
    cfg.setdefault("__parent__", row.get("parent_session_id"))
    return cfg


def _stored_choice(db: Any, session_id: str, user_id: str) -> Optional[List[str]]:
    """Names stored for this chat (or the chat it continues), else ``None``."""
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
    """Write the choice onto an existing session row; ``False`` when none yet."""
    cfg = _session_model_config(db, session_id)
    if cfg is None:
        return False
    cfg.pop("__parent__", None)
    cfg[SESSION_KEY] = {"user": user_id, "servers": names}
    try:
        db.update_session_meta(session_id, json.dumps(cfg))
    except Exception:  # noqa: BLE001 - the in-process copy still holds
        logger.debug("personal MCP: could not store chat choice", exc_info=True)
    return True


def choose_for_session(
    session_id: Optional[str],
    user_id: str,
    available: List[str],
    db: Any = None,
    new_session_config: Optional[dict] = None,
) -> List[str]:
    """The person's servers this chat uses: fixed on its first call.

    The choice is kept on the session row (``model_config``) so later turns,
    which build a fresh agent, and a restarted process keep the same tools.
    For a chat whose row doesn't exist yet it goes into
    *new_session_config*, which the agent writes when it creates the row.
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


def _load_user_servers(user_id: str) -> Dict[str, Dict[str, Any]]:
    from hermes_cli.personal_mcp import load_runtime_configs

    return load_runtime_configs(user_id)


def apply_to_agent(agent: Any) -> None:
    """Add the chat person's own MCP tools to a freshly built agent.

    Sets ``agent._personal_mcp_defs`` (re-added by every tool-list refresh) and
    appends them to ``agent.tools``. Fail-soft: a chat always starts.
    """
    agent._personal_mcp_defs = []
    user_id = getattr(agent, "_internal_user_id", None)
    if not user_id:
        return
    try:
        servers = _load_user_servers(str(user_id))
    except Exception:  # noqa: BLE001
        logger.warning("personal MCP: could not read servers", exc_info=True)
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
    defs = tool_definitions(live.values())
    if not defs:
        return
    agent._personal_mcp_defs = defs
    have = {t["function"]["name"] for t in (agent.tools or [])}
    agent.tools = list(agent.tools or []) + [
        d for d in defs if d["function"]["name"] not in have
    ]


def reinject(agent: Any, tools_list: list, name_set: set) -> None:
    """Put the agent's own personal tools back after a tool-list rebuild."""
    for schema in getattr(agent, "_personal_mcp_defs", None) or []:
        name = schema["function"]["name"]
        if name not in name_set:
            tools_list.append(schema)
            name_set.add(name)


def _reset_for_tests() -> None:
    with _lock:
        _owners.clear()
        _fingerprints.clear()
        _failed_at.clear()
        _session_choice.clear()
