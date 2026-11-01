"""Process-wide, bounded Postgres connection pool for long-lived servers.

Every app store opens its connection through
:meth:`hermes_cli.datastore.SupabaseAppStore.connect` and closes it when done.
Opening a fresh connection costs a TCP + auth handshake (~40 ms through the
production supavisor) and, under a handful of parallel requests, exhausts the
pooler's session-mode client limit (``EMAXCONNSESSION``). A server process
(the dashboard) therefore calls :func:`enable` once at startup; from then on
``connect()`` hands out a pooled connection and ``close()`` returns it.

asyncpg connections belong to the event loop that opened them, while store
code runs on the server loop *and* on short-lived ``asyncio.run`` loops in
worker threads. The pool therefore lives on one dedicated background loop and
every call on a pooled connection is marshalled onto it, so one bounded pool
serves every caller in the process.

Returning a connection runs asyncpg's reset (roll back an open transaction,
``RESET ALL``, release advisory locks), so session state such as a bound
principal never leaks to the next user. ``search_path`` is set per checkout.

When the pool stays exhausted past ``pool_acquire_timeout`` (or a task that
already holds a pooled connection asks for a second one while the pool is
full), :func:`acquire` returns ``None`` and the caller opens a direct
connection exactly as before, so nesting can never deadlock the pool.
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_POOL_SIZE = 5
DEFAULT_ACQUIRE_TIMEOUT = 10.0
#: How long a task that already holds a pooled connection waits for another
#: before falling back to a direct connection (nested use must not deadlock).
NESTED_ACQUIRE_TIMEOUT = 0.25
#: Idle pooled connections are closed after this many seconds.
MAX_INACTIVE_LIFETIME = 120.0


@dataclass(frozen=True)
class PoolSettings:
    max_size: int = DEFAULT_POOL_SIZE
    acquire_timeout: float = DEFAULT_ACQUIRE_TIMEOUT


def settings_from_config(config: Any) -> PoolSettings:
    """Read ``datastore.supabase_app.pool_size`` / ``pool_acquire_timeout``."""
    node: Any = config if isinstance(config, dict) else {}
    for key in ("datastore", "supabase_app"):
        node = node.get(key) if isinstance(node, dict) else None
    node = node if isinstance(node, dict) else {}
    try:
        size = int(node.get("pool_size", DEFAULT_POOL_SIZE))
    except (TypeError, ValueError):
        size = DEFAULT_POOL_SIZE
    try:
        timeout = float(node.get("pool_acquire_timeout", DEFAULT_ACQUIRE_TIMEOUT))
    except (TypeError, ValueError):
        timeout = DEFAULT_ACQUIRE_TIMEOUT
    return PoolSettings(max_size=max(0, size), acquire_timeout=max(0.0, timeout))


_lock = threading.Lock()
_settings: Optional[PoolSettings] = None
_loop: Optional[asyncio.AbstractEventLoop] = None
_thread: Optional[threading.Thread] = None
_pools: Dict[str, Any] = {}
_pool_locks: Dict[str, asyncio.Lock] = {}
_held: contextvars.ContextVar[int] = contextvars.ContextVar("hermes_db_pool_held", default=0)


def enabled() -> bool:
    return _settings is not None and _settings.max_size > 0 and _loop is not None


def enable(settings: PoolSettings) -> bool:
    """Turn pooling on for this process (idempotent). Returns whether it is on."""
    global _settings, _loop, _thread
    with _lock:
        if settings.max_size <= 0:
            return False
        if _loop is not None:
            _settings = settings
            return True
        ready = threading.Event()
        loop = asyncio.new_event_loop()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()

        thread = threading.Thread(target=_run, name="hermes-db-pool", daemon=True)
        thread.start()
        ready.wait()
        _loop, _thread, _settings = loop, thread, settings
        return True


def disable(timeout: float = 5.0) -> None:
    """Close every pool and stop the pool loop (server shutdown, tests)."""
    global _settings, _loop, _thread
    with _lock:
        loop, thread = _loop, _thread
        _settings = None
        _loop = _thread = None
    if loop is None:
        return

    async def _close_all() -> None:
        pools = list(_pools.values())
        _pools.clear()
        _pool_locks.clear()
        for pool in pools:
            try:
                await asyncio.wait_for(pool.close(), timeout)
            except Exception:  # noqa: BLE001 - best effort on shutdown
                pool.terminate()

    try:
        asyncio.run_coroutine_threadsafe(_close_all(), loop).result(timeout + 1)
    except Exception:  # noqa: BLE001
        logger.debug("db pool: close on shutdown failed", exc_info=True)
    loop.call_soon_threadsafe(loop.stop)
    if thread is not None:
        thread.join(timeout)


def stats() -> Dict[str, Dict[str, int]]:
    """``{dsn_key: {"size", "idle", "max"}}`` without credentials (tests/ops)."""
    out: Dict[str, Dict[str, int]] = {}
    for index, pool in enumerate(list(_pools.values())):
        out[f"pool{index}"] = {
            "size": pool.get_size(),
            "idle": pool.get_idle_size(),
            "max": pool.get_max_size(),
        }
    return out


async def _on_pool_loop(coro: Any) -> Any:
    loop = _loop
    if loop is None:
        coro.close()
        raise RuntimeError("database pool is not running")
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        return await coro
    return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(coro, loop))


async def _get_pool(dsn: str) -> Any:
    pool = _pools.get(dsn)
    if pool is not None:
        return pool
    lock = _pool_locks.setdefault(dsn, asyncio.Lock())
    async with lock:
        pool = _pools.get(dsn)
        if pool is None:
            import asyncpg

            from hermes_cli import db_setup

            settings = _settings or PoolSettings()
            pool = await asyncpg.create_pool(
                dsn,
                min_size=0,
                max_size=settings.max_size,
                max_inactive_connection_lifetime=MAX_INACTIVE_LIFETIME,
                connection_class=db_setup.connection_class(),
            )
            _pools[dsn] = pool
    return pool


async def acquire(dsn: str, schema: str) -> Optional["PooledConnection"]:
    """A pooled connection pinned to ``schema``, or ``None`` to connect directly.

    ``None`` means pooling is off, or no connection freed up in time.
    """
    settings = _settings
    if not enabled() or settings is None:
        return None
    timeout = (
        min(NESTED_ACQUIRE_TIMEOUT, settings.acquire_timeout)
        if _held.get() > 0
        else settings.acquire_timeout
    )

    async def _checkout() -> Any:
        pool = await _get_pool(dsn)
        raw = await pool.acquire(timeout=timeout)
        try:
            await raw.execute("SELECT set_config('search_path', $1, false)", schema)
        except BaseException:
            await pool.release(raw)
            raise
        return pool, raw

    try:
        pool, raw = await _on_pool_loop(_checkout())
    except asyncio.TimeoutError:
        logger.warning(
            "db pool: no free connection within %.2fs (max %d); connecting directly",
            timeout,
            settings.max_size,
        )
        return None
    conn = PooledConnection(pool, raw)
    _held.set(_held.get() + 1)
    return conn


class _PooledTransaction:
    """``conn.transaction()`` whose statements run on the pool loop."""

    def __init__(self, tx: Any) -> None:
        self._tx = tx

    async def start(self) -> None:
        await _on_pool_loop(self._tx.start())

    async def commit(self) -> None:
        await _on_pool_loop(self._tx.commit())

    async def rollback(self) -> None:
        await _on_pool_loop(self._tx.rollback())

    async def __aenter__(self) -> "_PooledTransaction":
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await _on_pool_loop(self._tx.__aexit__(exc_type, exc, tb))


_OWN_ATTRS = frozenset({"_pool", "_raw", "_released"})


class PooledConnection:
    """A checked-out pool connection usable from any event loop.

    Mirrors the subset of :class:`asyncpg.Connection` the stores use;
    :meth:`close` returns the connection to the pool instead of closing it.
    """

    def __init__(self, pool: Any, raw: Any) -> None:
        object.__setattr__(self, "_pool", pool)
        object.__setattr__(self, "_raw", raw)
        object.__setattr__(self, "_released", False)

    # Attributes the stores read/set directly (``_addr``, ``_params``,
    # ``_hermes_skip_setup``) live on the underlying connection.
    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name in _OWN_ATTRS:
            object.__setattr__(self, name, value)
        else:
            setattr(self._connection(), name, value)

    def _connection(self) -> Any:
        """The real ``asyncpg.Connection`` behind the pool's proxy."""
        raw = self._live()
        return getattr(raw, "_con", None) or raw

    def _live(self) -> Any:
        if self._released:
            raise RuntimeError("connection was returned to the pool")
        return self._raw

    async def execute(self, query: str, *args: Any, timeout: Any = None) -> str:
        return await _on_pool_loop(self._live().execute(query, *args, timeout=timeout))

    async def executemany(self, command: str, args: Any, *, timeout: Any = None) -> Any:
        return await _on_pool_loop(self._live().executemany(command, args, timeout=timeout))

    async def fetch(self, query: str, *args: Any, timeout: Any = None, **kw: Any) -> Any:
        return await _on_pool_loop(self._live().fetch(query, *args, timeout=timeout, **kw))

    async def fetchrow(self, query: str, *args: Any, timeout: Any = None, **kw: Any) -> Any:
        return await _on_pool_loop(self._live().fetchrow(query, *args, timeout=timeout, **kw))

    async def fetchval(self, query: str, *args: Any, column: int = 0, timeout: Any = None) -> Any:
        return await _on_pool_loop(
            self._live().fetchval(query, *args, column=column, timeout=timeout)
        )

    async def set_type_codec(self, *args: Any, **kwargs: Any) -> Any:
        return await _on_pool_loop(self._live().set_type_codec(*args, **kwargs))

    def transaction(self, **kwargs: Any) -> _PooledTransaction:
        return _PooledTransaction(self._live().transaction(**kwargs))

    def is_in_transaction(self) -> bool:
        return self._live().is_in_transaction()

    def is_closed(self) -> bool:
        return self._released or self._raw.is_closed()

    async def close(self, *, timeout: Any = None) -> None:
        if self._released:
            return
        self._released = True
        _held.set(max(0, _held.get() - 1))
        try:
            await _on_pool_loop(self._pool.release(self._raw, timeout=timeout))
        except Exception:  # noqa: BLE001 - a broken connection is dropped by the pool
            logger.debug("db pool: release failed", exc_info=True)

    def terminate(self) -> None:
        if self._released:
            return
        self._released = True
        loop = _loop
        raw, pool = self._raw, self._pool
        if loop is not None:
            loop.call_soon_threadsafe(raw.terminate)
            loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(pool.release(raw))
            )

    def __del__(self) -> None:
        # Safety net for a caller that forgot ``close()``: give the slot back
        # instead of shrinking the pool forever.
        try:
            released = object.__getattribute__(self, "_released")
        except AttributeError:
            return
        if released:
            return
        loop = _loop
        if loop is None or loop.is_closed():
            return
        raw, pool = self._raw, self._pool
        logger.warning("db pool: connection garbage-collected without close()")
        try:
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(pool.release(raw)))
        except RuntimeError:
            pass
