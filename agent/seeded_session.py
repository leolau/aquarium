"""One session-spawn path for cron and for to-do ``/start``.

The boundary is **thick on plumbing, thin on policy** (plan Part 1.2a):
everything that would be a bug if the two callers resolved it differently
goes inside; everything a caller is entitled to decide stays a parameter.

Inside: profile scope (``profile_runtime_scope``), config load + runtime
resolution, MCP discovery, ``SessionDB``, ``AIAgent`` construction,
``run_conversation``, and the inactivity-timeout worker thread.

Parameters: toolsets, ``max_iterations``, ``reasoning_config``,
``prefill_messages``, ``quiet_mode``, ``load_soul_identity``,
``skip_memory``, ``workdir``, ``platform``, ``inactivity_limit``.

Stays in cron: the provider-drift/pin guard, the wake-gate prerun, job-
registry bookkeeping, the run's Markdown document, trace binding.

The helper returns a :class:`SeededSession` and does **not** own the detach
decision: cron calls it in the foreground and reads the result; ``/start``
calls it on a detached ``copy_context()`` thread and returns at once.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence, Union

log = logging.getLogger(__name__)

#: The agent's own callbacks, named here so a passthrough is typed rather
#: than ``Any``. Tool args/results are part of the agent's signature; a
#: consumer that forwards them anywhere public must drop them itself.
ReasoningCallback = Callable[[str], None]
ToolStartCallback = Callable[[str, str, Mapping[str, Any]], None]
ToolCompleteCallback = Callable[[str, str, Mapping[str, Any], Any], None]

#: How often the inactivity loop polls the future (seconds).
_POLL_INTERVAL = 5.0

#: Default inactivity timeout (seconds).  ``None`` = unlimited.
_DEFAULT_INACTIVITY_LIMIT = 600.0


@dataclass(frozen=True)
class SeededSession:
    """The outcome of a seeded session run.

    ``error`` is set instead of raising: a caller decides what a failed
    spawn means for its own state machine (cron logs and delivers; ``/start``
    returns ``spawned: False`` alongside the already-moved stage).

    ``agent`` is the constructed ``AIAgent`` instance, exposed so a caller
    that owns resource cleanup (cron) can call ``agent.close()`` in its
    ``finally`` block.  ``None`` when construction itself failed.
    """

    session_id: str
    result: Any | None
    timed_out: bool
    error: str | None
    agent: Any | None = None


def spawn_seeded_session(
    prompt: str,
    *,
    origin: str,
    session_id: str,
    profile_home: Union[Path, str, None] = None,
    runtime: Mapping[str, Any] | None = None,
    config: Mapping[str, Any] | None = None,
    session_db: Any | None = None,
    model: str | None = None,
    enabled_toolsets: Sequence[str] | None = None,
    disabled_toolsets: Sequence[str] | None = None,
    max_iterations: int | None = None,
    reasoning_config: Mapping[str, Any] | None = None,
    prefill_messages: Sequence[Any] | None = None,
    workdir: str | None = None,
    load_soul_identity: bool = True,
    skip_memory: bool = False,
    quiet_mode: bool = True,
    inactivity_limit: float | None = _DEFAULT_INACTIVITY_LIMIT,
    context: contextvars.Context | None = None,
    reasoning_callback: ReasoningCallback | None = None,
    tool_start_callback: ToolStartCallback | None = None,
    tool_complete_callback: ToolCompleteCallback | None = None,
    internal_user_id: str | None = None,
    internal_user_role: str | None = None,
    trusted_local: bool = False,
) -> SeededSession:
    """Spawn a seeded agent session and run it to completion (or timeout).

    Returns a :class:`SeededSession`.  Never raises — failures are reported
    through ``error`` so the caller's state machine is never corrupted by an
    unexpected exception.

    The three callbacks are the same ones ``agent_init`` already accepts and
    the chat stream already uses; they are passed through so a caller that
    runs a session in-process (a project run's inline step) can show what the
    agent is doing while it does it, instead of only afterwards.
    """
    try:
        return _run(
            prompt,
            origin=origin,
            session_id=session_id,
            profile_home=profile_home,
            runtime=runtime,
            config=config,
            session_db=session_db,
            model=model,
            enabled_toolsets=enabled_toolsets,
            disabled_toolsets=disabled_toolsets,
            max_iterations=max_iterations,
            reasoning_config=reasoning_config,
            prefill_messages=prefill_messages,
            workdir=workdir,
            load_soul_identity=load_soul_identity,
            skip_memory=skip_memory,
            quiet_mode=quiet_mode,
            inactivity_limit=inactivity_limit,
            context=context,
            reasoning_callback=reasoning_callback,
            tool_start_callback=tool_start_callback,
            tool_complete_callback=tool_complete_callback,
            internal_user_id=internal_user_id,
            internal_user_role=internal_user_role,
            trusted_local=trusted_local,
        )
    except Exception as exc:
        log.warning("seeded_session[%s]: failed (%s)", session_id, exc)
        return SeededSession(
            session_id=session_id,
            result=None,
            timed_out=False,
            error=str(exc),
        )


def _run(
    prompt: str,
    *,
    origin: str,
    session_id: str,
    profile_home: Union[Path, str, None],
    runtime: Mapping[str, Any] | None,
    config: Mapping[str, Any] | None,
    session_db: Any | None,
    model: str | None,
    enabled_toolsets: Sequence[str] | None,
    disabled_toolsets: Sequence[str] | None,
    max_iterations: int | None,
    reasoning_config: Mapping[str, Any] | None,
    prefill_messages: Sequence[Any] | None,
    workdir: str | None,
    load_soul_identity: bool,
    skip_memory: bool,
    quiet_mode: bool,
    inactivity_limit: float | None,
    context: contextvars.Context | None,
    reasoning_callback: ReasoningCallback | None = None,
    tool_start_callback: ToolStartCallback | None = None,
    tool_complete_callback: ToolCompleteCallback | None = None,
    internal_user_id: str | None = None,
    internal_user_role: str | None = None,
    trusted_local: bool = False,
) -> SeededSession:
    # -- profile scope (the drift guard) --------------------------------
    #
    # ``profile_runtime_scope`` is a contextmanager that sets the contextvar
    # pair (HERMES_HOME override + secret scope).  When ``profile_home`` is
    # None we rely on the process's own HERMES_HOME (cron's existing path).
    cm = _maybe_profile_scope(profile_home)

    def _body() -> SeededSession:
        return _body_inner(
            prompt,
            origin=origin,
            session_id=session_id,
            runtime=runtime,
            config=config,
            session_db=session_db,
            model=model,
            enabled_toolsets=enabled_toolsets,
            disabled_toolsets=disabled_toolsets,
            max_iterations=max_iterations,
            reasoning_config=reasoning_config,
            prefill_messages=prefill_messages,
            workdir=workdir,
            load_soul_identity=load_soul_identity,
            skip_memory=skip_memory,
            quiet_mode=quiet_mode,
            inactivity_limit=inactivity_limit,
            context=context,
            reasoning_callback=reasoning_callback,
            tool_start_callback=tool_start_callback,
            tool_complete_callback=tool_complete_callback,
            internal_user_id=internal_user_id,
            internal_user_role=internal_user_role,
            trusted_local=trusted_local,
        )

    if cm is not None:
        with cm:
            return _body()
    return _body()


def _maybe_profile_scope(profile_home):
    if profile_home is None:
        return None
    from agent.profile_runtime import profile_runtime_scope

    return profile_runtime_scope(profile_home)


def _body_inner(
    prompt: str,
    *,
    origin: str,
    session_id: str,
    runtime: Mapping[str, Any] | None,
    config: Mapping[str, Any] | None,
    session_db: Any | None,
    model: str | None,
    enabled_toolsets: Sequence[str] | None,
    disabled_toolsets: Sequence[str] | None,
    max_iterations: int | None,
    reasoning_config: Mapping[str, Any] | None,
    prefill_messages: Sequence[Any] | None,
    workdir: str | None,
    load_soul_identity: bool,
    skip_memory: bool,
    quiet_mode: bool,
    inactivity_limit: float | None,
    context: contextvars.Context | None,
    reasoning_callback: ReasoningCallback | None = None,
    tool_start_callback: ToolStartCallback | None = None,
    tool_complete_callback: ToolCompleteCallback | None = None,
    internal_user_id: str | None = None,
    internal_user_role: str | None = None,
    trusted_local: bool = False,
) -> SeededSession:
    import yaml

    agent = None  # tracked for SeededSession.agent (cron closes it)

    # -- config load ----------------------------------------------------
    # When a caller (cron) passes a pre-resolved config, use it directly
    # — the caller already applied managed_scope, _expand_env_vars, etc.
    _cfg: dict[str, Any] = dict(config) if config else {}
    if config is None:
        from hermes_constants import get_hermes_home

        _home = get_hermes_home()
        _cfg_path = str(Path(_home) / "config.yaml")
        if os.path.exists(_cfg_path):
            try:
                with open(_cfg_path, encoding="utf-8") as _f:
                    _cfg = yaml.safe_load(_f) or {}
                try:
                    from hermes_cli import managed_scope

                    _cfg = managed_scope.apply_managed_overlay(_cfg)
                except Exception:
                    pass
                from hermes_cli.config import _expand_env_vars

                _cfg = _expand_env_vars(_cfg)
            except Exception as exc:
                log.warning("seeded_session[%s]: config load failed (%s)", session_id, exc)

    # -- runtime resolution ---------------------------------------------
    resolved_runtime = runtime
    if resolved_runtime is None:
        resolved_runtime = _resolve_runtime(_cfg, session_id)
    if resolved_runtime is None:
        return SeededSession(
            session_id=session_id,
            result=None,
            timed_out=False,
            error="could not resolve runtime provider",
            agent=agent,
        )

    # -- model resolution (caller can pass a pre-resolved model) --------
    if model:
        _model = model
    else:
        _model_cfg = _cfg.get("model") or {}
        if isinstance(_model_cfg, str):
            _model = _model_cfg
        elif isinstance(_model_cfg, dict):
            _model = _model_cfg.get("default") or _model_cfg.get("model") or os.getenv("HERMES_MODEL", "")
        else:
            _model = os.getenv("HERMES_MODEL", "")
    if not _model:
        return SeededSession(
            session_id=session_id,
            result=None,
            timed_out=False,
            error="no model configured",
            agent=agent,
        )

    # -- fallback chain + credential pool -------------------------------
    from hermes_cli.fallback_config import get_fallback_chain

    fallback_model = get_fallback_chain(_cfg) or None

    credential_pool = None
    _provider = str(resolved_runtime.get("provider") or "").strip().lower()
    if _provider:
        try:
            from agent.credential_pool import load_pool

            _pool = load_pool(_provider)
            if _pool.has_credentials():
                credential_pool = _pool
        except Exception as exc:
            log.debug("seeded_session[%s]: credential pool failed (%s)", session_id, exc)

    # -- MCP discovery (non-fatal) --------------------------------------
    try:
        from tools.mcp_tool import discover_mcp_tools

        _mcp_tools = discover_mcp_tools()
        if _mcp_tools:
            log.info(
                "seeded_session[%s]: %d MCP tool(s) available",
                session_id,
                len(_mcp_tools),
            )
    except Exception as exc:
        log.warning("seeded_session[%s]: MCP init failed (non-fatal): %s", session_id, exc)

    # -- reasoning config (when not passed) ------------------------------
    _reasoning = reasoning_config
    if _reasoning is None:
        from hermes_constants import parse_reasoning_effort

        _effort = str(_cfg.get("agent", {}).get("reasoning_effort", "")).strip()
        _reasoning = parse_reasoning_effort(_effort) or None

    # -- prefill messages (when not passed) ------------------------------
    _prefill = prefill_messages
    if _prefill is None:
        _prefill = _load_prefill(_cfg, session_id)

    # -- max iterations (when not passed) -------------------------------
    _max_iter = max_iterations
    if _max_iter is None:
        _max_iter = _cfg.get("agent", {}).get("max_turns") or _cfg.get("max_turns") or 90

    # -- provider routing -----------------------------------------------
    _pr = _cfg.get("provider_routing") or {}

    # -- SessionDB (caller can pass its own) ---------------------------
    _session_db = session_db
    _close_session_db = False  # only close one we created
    if _session_db is None:
        from hermes_state import SessionDB

        _session_db = SessionDB()
        _close_session_db = True

    # -- AIAgent construction -------------------------------------------
    from run_agent import AIAgent

    agent = AIAgent(
        model=_model,
        api_key=resolved_runtime.get("api_key"),
        base_url=resolved_runtime.get("base_url"),
        provider=resolved_runtime.get("provider"),
        api_mode=resolved_runtime.get("api_mode"),
        acp_command=resolved_runtime.get("command"),
        acp_args=resolved_runtime.get("args"),
        max_iterations=_max_iter,
        reasoning_config=_reasoning,
        prefill_messages=_prefill,
        fallback_model=fallback_model,
        credential_pool=credential_pool,
        providers_allowed=_pr.get("only"),
        providers_ignored=_pr.get("ignore"),
        providers_order=_pr.get("order"),
        provider_sort=_pr.get("sort"),
        openrouter_min_coding_score=(_cfg.get("openrouter") or {}).get("min_coding_score"),
        enabled_toolsets=list(enabled_toolsets) if enabled_toolsets else None,
        disabled_toolsets=list(disabled_toolsets) if disabled_toolsets else None,
        quiet_mode=quiet_mode,
        skip_context_files=not bool(workdir),
        load_soul_identity=load_soul_identity,
        skip_memory=skip_memory,
        platform=origin,
        session_id=session_id,
        session_db=_session_db,
        reasoning_callback=reasoning_callback,
        tool_start_callback=tool_start_callback,
        tool_complete_callback=tool_complete_callback,
        internal_user_id=internal_user_id,
        internal_user_role=internal_user_role,
        trusted_local=trusted_local,
    )

    _ctx = context or contextvars.copy_context()
    if workdir:
        # Pin the session cwd via the _SESSION_CWD ContextVar (not
        # os.environ, which is process-global and would clobber concurrent
        # sessions with different workdirs).  resolve_agent_cwd() checks the
        # ContextVar first, then falls back to TERMINAL_CWD / os.getcwd().
        from agent.runtime_cwd import set_session_cwd

        _ctx.run(set_session_cwd, workdir)
    _pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    _future = _pool.submit(_ctx.run, agent.run_conversation, prompt)
    _timed_out = False

    try:
        if inactivity_limit is None:
            result = _future.result()
        else:
            result = None
            while True:
                _done, _ = concurrent.futures.wait(
                    {_future}, timeout=_POLL_INTERVAL
                )
                if _done:
                    result = _future.result()
                    break
                # Check the agent's activity via get_activity_summary (same
                # path cron uses) — _activity_tracker doesn't exist on AIAgent.
                _idle_secs = 0.0
                if hasattr(agent, "get_activity_summary"):
                    try:
                        _act = agent.get_activity_summary()
                        _idle_secs = _act.get("seconds_since_activity", 0.0)
                    except Exception:
                        pass
                if _idle_secs >= inactivity_limit:
                    _timed_out = True
                    # Cancel the future (no-op if running) AND interrupt the
                    # agent so the run actually stops — cron does the same.
                    _future.cancel()
                    if hasattr(agent, "interrupt"):
                        try:
                            agent.interrupt("inactivity timeout")
                        except Exception:
                            pass
                    log.warning(
                        "seeded_session[%s]: inactivity timeout (%.0fs)",
                        session_id,
                        inactivity_limit,
                    )
                    break
    except Exception as exc:
        log.warning("seeded_session[%s]: run failed (%s)", session_id, exc)
        return SeededSession(
            session_id=session_id,
            result=None,
            timed_out=False,
            error=str(exc),
            agent=agent,
        )
    finally:
        _pool.shutdown(wait=False, cancel_futures=True)
        if _close_session_db and _session_db:
            try:
                _session_db.close()
            except Exception:
                pass

    return SeededSession(
        session_id=session_id,
        result=result,
        timed_out=_timed_out,
        error=None,
        agent=agent,
    )


def _resolve_runtime(
    config: dict[str, Any], session_id: str
) -> Mapping[str, Any] | None:
    """Resolve runtime provider from config (the same path cron takes)."""
    from hermes_cli.runtime_provider import resolve_runtime_provider

    try:
        return resolve_runtime_provider()
    except Exception as exc:
        log.warning("seeded_session[%s]: runtime resolution failed (%s)", session_id, exc)
        return None


def _load_prefill(
    config: dict[str, Any], session_id: str
) -> list[Any] | None:
    """Load prefill messages from config (the same path cron takes)."""
    agent_cfg = config.get("agent", {})
    if not isinstance(agent_cfg, dict):
        agent_cfg = {}
    prefill_file = (
        os.getenv("HERMES_PREFILL_MESSAGES_FILE", "")
        or config.get("prefill_messages_file", "")
        or agent_cfg.get("prefill_messages_file", "")
    )
    if not prefill_file:
        return None
    import json

    pfpath = Path(prefill_file).expanduser()
    if not pfpath.is_absolute():
        from hermes_constants import get_hermes_home

        pfpath = Path(get_hermes_home()) / pfpath
    if not pfpath.exists():
        return None
    try:
        with open(pfpath, "r", encoding="utf-8") as _pf:
            data = json.load(_pf)
        return data if isinstance(data, list) else None
    except Exception as exc:
        log.warning("seeded_session[%s]: prefill load failed (%s)", session_id, exc)
        return None


__all__ = ["SeededSession", "spawn_seeded_session"]
