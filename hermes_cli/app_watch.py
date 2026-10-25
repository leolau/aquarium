"""FG-33 local apps: the watch timer, alerts and the lifecycle (P8-2 item 2.4).

``aquarium-apps-watch.timer`` runs ``python -m hermes_cli.app_watch`` every
5 minutes as ``hermes``. One pass:

* reads every local app instance from ``aquarium-app-helper status --all``,
  probes ``GET <base path>/api/health`` on loopback, takes the unit's memory and
  (hourly) the source size and ``pg_database_size``, and writes ``tool_runtime``
  so the Tools page never probes live;
* samples each running instance's CPU from its cgroup v2 ``cpu.stat`` and
  turns two passes into a rate (% of one core). Near the app's ``CPUQuota``
  (``per_app.cpu_quota_pct``) for three passes in a row, the app's owner gets a
  ``proactive_ask`` (``dedupe_key=app-cpu:<slug>``) and the instance owner a
  box alert, once per episode;
* counts a *visit* when the instance has an established loopback connection
  (the front door's upstream; the helper's dev idle check uses the same signal);
* alerts the app's owner through ``NotificationStore`` (a ``proactive_ask``,
  ``dedupe_key=app-down:<slug>``, held during quiet hours) when the third
  consecutive check fails, and the instance owner through the operator
  Telegram path (``scripts/lib/notify.py``) for box-level conditions: more than
  three apps down, a crash loop (unit ``failed`` after ``StartLimitBurst``),
  capacity ``constrained``. Each alert is sent once per episode;
* steps the lifecycle (FG-33 §9): ``active → idle`` after 14 days without a
  visit, ``idle → stopped`` after 30 days idle (7 for dev) with a 72 h notice,
  ``stopped → archived`` after 90 days stopped. Purge is never automatic.

Lifecycle verbs (``hermes tool archive|restore|purge``, ``POST
/api/tools/{name}/{archive,restore,purge}``), per decision 9: the app's owner
or an admin, no C6 approval; ``purge`` needs one explicit confirmation (the
tool name). Prod database verbs still get an approved row that records that
confirmation, because the provisioner checks one before any prod change.

* **archive** — stop and unroute the instance, copy the database and then
  refuse connections to it (``apps db archive``: the copy lands root-only 0600
  in ``<APPS_BASE>/db-backups/`` and its path, size and time are recorded on the
  ``app_databases`` row), switch the tool and its MCP endpoint off. If the copy
  fails nothing is suspended, the instance is routed and started again, and the
  error is raised. Nothing is deleted; ``restore`` undoes it. A root timer
  (``aquarium apps copies prune``) deletes copies nobody made or used for 90 days.
* **restore** — reload the archive copy if the database is gone or has no rows,
  otherwise just resume it (``apps db restore``), route and start the instance
  again, and switch the tool back on if archive switched it off.
* **purge** (only from ``archived``) — remove the instance, drop the database
  (the provisioner keeps its final dump), delete the MCP secret and endpoint,
  and the source when no other mode still uses it. The tools row stays as a
  ``purged`` tombstone; ``DELETE /api/tools/{name}`` removes it.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import fcntl
import importlib.util
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional, Tuple

from hermes_cli.access import Principal

DAY = 86400.0
WATCH_INTERVAL_S = 300
#: Three failed checks in a row (~15 min at the 5-min timer) before the owner hears.
FAILURES_TO_ALERT = 3
IDLE_AFTER_S = 14 * DAY
STOP_AFTER_IDLE_S = {"prod": 30 * DAY, "dev": 7 * DAY}
STOP_NOTICE_S = 72 * 3600.0
ARCHIVE_AFTER_STOPPED_S = 90 * DAY
#: Box alert when MORE than this many app instances are down at once.
BOX_DOWN_ALERT = 3
SIZE_EVERY_S = 3600.0
HEALTH_TIMEOUT_S = 5.0
PROC_NET_TCP = ("/proc/net/tcp", "/proc/net/tcp6")
CGROUP_ROOT = Path("/sys/fs/cgroup")
#: aquarium-app@.service runs in aquarium-apps.slice, a child of aquarium.slice.
APPS_CGROUP = ("aquarium.slice", "aquarium-apps.slice")
#: systemd caps an instance at its CPUQuota, so "over quota" means pinned near it.
CPU_HIGH_SHARE = 0.9
CPU_RUNS_TO_ALERT = FAILURES_TO_ALERT
#: A rate needs two samples this close together; an older one only restarts the baseline.
CPU_SAMPLE_MAX_GAP_S = 3 * WATCH_INTERVAL_S
LIFECYCLE_VERBS = ("archive", "restore", "purge")

OwnerNotifier = Callable[[str, str, str, str], Awaitable[Any]]
BoxNotifier = Callable[[str], Any]


class LifecycleConflict(Exception):
    """The app is not in a lifecycle state the verb can act on (HTTP 409)."""


# ---------------------------------------------------------------------------
# the lifecycle state machine (pure)
# ---------------------------------------------------------------------------


def lifecycle_step(
    state: str, *, mode: str, now: float, since: float, last_visit: Optional[float],
    notice_at: Optional[float], running: bool,
) -> Tuple[str, Optional[str]]:
    """``(next_state, action)`` for one watch pass.

    ``since`` is when the app entered ``state``; ``last_visit`` the last seen
    visit (``None``: never, so the clock starts at ``since``). ``action`` is
    ``None``, ``"notice"`` (tell the owner the stop is coming), ``"stop"``,
    ``"archive"`` or ``"wake"`` (back to active). ``archived``/``purged`` never
    move on their own.
    """
    if state not in ("active", "idle", "stopped"):
        return state, None
    last = last_visit if last_visit is not None else since
    visited = last_visit is not None and last_visit > since
    if state == "active":
        return ("idle", None) if now - last >= IDLE_AFTER_S else ("active", None)
    if state == "idle":
        if visited:
            return "active", "wake"
        due = since + STOP_AFTER_IDLE_S.get(mode, STOP_AFTER_IDLE_S["prod"])
        if notice_at is None:
            return ("idle", "notice") if now >= due - STOP_NOTICE_S else ("idle", None)
        if now >= max(due, notice_at + STOP_NOTICE_S):
            return "stopped", "stop"
        return "idle", None
    if running or visited:
        return "active", "wake"
    if now - since >= ARCHIVE_AFTER_STOPPED_S:
        return "archived", "archive"
    return "stopped", None


def probe_verdict(doc: Optional[dict], http_status: Optional[int]) -> Tuple[str, bool]:
    """``(health, failing)`` of one instance from its helper status and probe.

    ``http_status`` is the ``/api/health`` answer (``None``: no connection).
    An instance that is simply not running and not meant to be (a dev
    instance idle-stopped by the helper) is ``unknown``, not a failure.
    """
    if not doc:
        return "unknown", False
    state = doc.get("active_state")
    if state == "active":
        if http_status is None:
            return "down", True
        return ("ok", False) if 200 <= http_status < 300 else ("degraded", True)
    if state == "failed" or doc.get("enabled"):
        return "down", True
    return "unknown", False


def crash_looping(doc: Optional[dict]) -> bool:
    """systemd gave up restarting (``StartLimitBurst`` hit): the unit is ``failed``."""
    return bool(doc) and doc.get("active_state") == "failed"


# ---------------------------------------------------------------------------
# the watch's own small state (lifecycle clocks, alert episodes)
# ---------------------------------------------------------------------------


def default_state_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "apps-watch" / "state.json"


class WatchState:
    """``$HERMES_HOME/apps-watch/state.json`` under an exclusive lock.

    Holds what ``tool_runtime`` has no column for: when an app entered its
    lifecycle state, when the stop notice went out, the tool status archive
    switched off, and which box alerts are already sent. The API and the timer
    both use it, so every use holds the lock.
    """

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path = Path(path) if path is not None else default_state_path()
        self.data: Dict[str, Any] = {}
        #: A dry run reads the clocks but never writes them back.
        self.readonly = False
        self._lock = None

    def __enter__(self) -> "WatchState":
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._lock = open(self.path.with_suffix(".lock"), "a+", encoding="utf-8")
        fcntl.flock(self._lock, fcntl.LOCK_EX)
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        self.data = data if isinstance(data, dict) else {}
        self.data.setdefault("apps", {})
        self.data.setdefault("box", {})
        return self

    def __exit__(self, *exc: Any) -> None:
        try:
            if exc[0] is None and not self.readonly:
                tmp = self.path.with_suffix(".tmp")
                fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(self.data, fh, indent=1, sort_keys=True)
                os.replace(tmp, self.path)
        finally:
            if self._lock is not None:
                fcntl.flock(self._lock, fcntl.LOCK_UN)
                self._lock.close()
                self._lock = None

    def app(self, mode: str, tool_id: str, lifecycle: str, now: float) -> dict:
        """The app's entry; its clock restarts whenever the lifecycle changed elsewhere."""
        key = f"{mode}:{tool_id}"
        entry = self.data["apps"].get(key)
        if not isinstance(entry, dict) or entry.get("lifecycle") != lifecycle:
            kept = {k: v for k, v in (entry or {}).items()
                    if k in ("size_at", "status_before_archive", "cpu", "cpu_high_runs")}
            entry = {"lifecycle": lifecycle, "since": now, "notice_at": None, **kept}
            self.data["apps"][key] = entry
        return entry

    def moved(self, mode: str, tool_id: str, lifecycle: str, now: float, **extra: Any) -> dict:
        entry = self.app(mode, tool_id, lifecycle, now)
        entry.update(extra)
        return entry

    def box_episodes(self, active: Dict[str, str], now: float) -> List[str]:
        """Messages of box conditions that just started; ended ones are forgotten."""
        box = self.data["box"]
        fresh = [text for key, text in sorted(active.items()) if key not in box]
        for key in list(box):
            if key not in active:
                del box[key]
        for key in active:
            box.setdefault(key, now)
        return fresh


# ---------------------------------------------------------------------------
# box probes
# ---------------------------------------------------------------------------


def established(port: int, tables: Iterable[str] = PROC_NET_TCP) -> int:
    """Open TCP connections to local ``port`` (the front door's upstream)."""
    n = 0
    for path in tables:
        try:
            with open(path, encoding="ascii") as fh:
                next(fh, None)
                for line in fh:
                    cols = line.split()
                    if len(cols) > 3 and cols[3] == "01" and cols[1].rsplit(":", 1)[-1] == f"{port:04X}":
                        n += 1
        except OSError:
            continue
    return n


def health_status(port: int, base_path: str, timeout: float = HEALTH_TIMEOUT_S) -> Optional[int]:
    """HTTP status of ``GET http://127.0.0.1:<port><base>/api/health``; ``None`` if unreachable."""
    url = f"http://127.0.0.1:{int(port)}{base_path.rstrip('/')}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - loopback only
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)
    except (OSError, ValueError):
        return None


def cpu_usage_usec(unit: str, root: Path = CGROUP_ROOT) -> Optional[int]:
    """CPU time (µs) ``unit`` has used since it started, from its cgroup v2
    ``cpu.stat``; ``None`` if the cgroup is missing or unreadable."""
    if not unit or "/" in unit or unit.startswith("."):
        return None
    try:
        text = root.joinpath(*APPS_CGROUP, unit, "cpu.stat").read_text(encoding="ascii")
    except (OSError, ValueError):
        return None
    for line in text.splitlines():
        key, _, value = line.partition(" ")
        if key == "usage_usec" and value.strip().isdigit():
            return int(value)
    return None


def cpu_percent(prev: Any, usec: int, now: float) -> Optional[float]:
    """Average CPU (% of one core) since the ``{"usec", "at"}`` sample ``prev``.

    ``None`` without a usable baseline: no sample yet, the counter went
    backwards (the unit restarted into a new cgroup) or the sample is stale.
    """
    if not isinstance(prev, dict):
        return None
    try:
        used, at = int(prev["usec"]), float(prev["at"])
    except (KeyError, TypeError, ValueError):
        return None
    elapsed = now - at
    if usec < used or elapsed <= 0 or elapsed > CPU_SAMPLE_MAX_GAP_S:
        return None
    return round((usec - used) / (elapsed * 1e6) * 100, 1)


def default_cpu_quota_pct() -> Optional[int]:
    """``per_app.cpu_quota_pct`` of the root policy (built-in default: 50)."""
    from hermes_cli import app_quota

    value = app_quota.load_policy().section("per_app").get("cpu_quota_pct")
    return value if isinstance(value, int) and value > 0 else None


def tree_bytes(path: Path) -> Optional[int]:
    """Bytes under ``path`` (no symlinks followed); ``None`` if it is missing."""
    if not path.is_dir():
        return None
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            with contextlib.suppress(OSError):
                total += os.lstat(os.path.join(root, name)).st_size
    return total


def _ts(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def _dt(ts: float) -> datetime:
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def load_notify_lib():
    """``scripts/lib/notify.py`` of this checkout, or ``None`` (installed without scripts)."""
    name = "aquarium_scripts_lib_notify"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parents[1] / "scripts" / "lib" / "notify.py"
    if not path.is_file():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules[name] = module
    return module


def telegram_box_notifier(text: str) -> bool:
    lib = load_notify_lib()
    if lib is None:
        print(f"[apps-watch] {text}")
        return False
    return bool(lib.notify(text, tag="apps-watch"))


def notification_owner_notifier(config: Optional[dict] = None) -> OwnerNotifier:
    """Raise a deduped ``proactive_ask`` for the app's owner (NotificationStore, prod)."""

    async def _notify(user_id: str, title: str, body: str, dedupe_key: str) -> Any:
        from hermes_cli.datastore import get_store
        from hermes_cli.human_comms import NotificationStore

        store = NotificationStore(get_store("supabase-app", "prod", config=config), config=config)
        await store.initialize()
        return await store.create(kind="proactive_ask", target_user_id=user_id, title=title,
                                  body=body, dedupe_key=dedupe_key)

    return _notify


# ---------------------------------------------------------------------------
# lifecycle verbs
# ---------------------------------------------------------------------------


def _store_for(registry: Any):
    from hermes_cli.app_store import AppStore

    return AppStore(registry.store)


async def _lifecycle_of(store: Any, tool: Any) -> Tuple[str, dict]:
    row = await store.get_runtime(tool.id) or {}
    return row.get("lifecycle_state") or "active", row


async def _set_endpoint_enabled(registry: Any, name: Optional[str], enabled: bool) -> None:
    if not name:
        return
    conn = await registry.store.connect()
    try:
        if await conn.fetchval("SELECT to_regclass('mcp_endpoints')") is not None:
            await conn.execute("UPDATE mcp_endpoints SET enabled = $2 WHERE name = $1", name, enabled)
    finally:
        await conn.close()


async def archive_app(
    runtime: Any, registry: Any, principal: Principal, name: str, *,
    state: Any = None, reason: str = "owner",
) -> dict:
    """Stop, unroute, copy and suspend a local app in the registry's mode (reversible)."""
    from hermes_cli import app_runtime as rt

    mode = registry.mode
    tool = await runtime.resolve(registry, principal, name, write=True)
    slug = runtime.require_local(tool)
    store = _store_for(registry)
    await store.initialize()
    lifecycle, row = await _lifecycle_of(store, tool)
    if lifecycle in ("archived", "purged"):
        raise LifecycleConflict(f"{slug!r} ({mode}) is already {lifecycle}")
    await runtime._call("stop", slug=slug, mode=mode)
    await runtime._call("unroute", slug=slug, mode=mode)
    db = await store.get_database(tool.id, mode)
    suspended = False
    archive: Dict[str, Any] = {}
    if db is not None and db.status == "ready":
        try:
            approval = await runtime._approve(registry, principal, "tool.archive", slug) if mode == "prod" else None
            out = await runtime._db("archive", slug, mode, approval_ref=approval)
            if not isinstance(out.get("backup_ref"), str):
                raise rt.HelperError(f"aquarium apps db archive returned no copy for {slug!r} ({mode})")
        except Exception:
            await _undo_stop(runtime, tool, slug, mode, running=row.get("runtime_state") == "running")
            raise
        size = out.get("size_bytes") if isinstance(out.get("size_bytes"), int) else None
        await store.record_archive(tool.id, mode, archive_ref=out["backup_ref"], archive_bytes=size)
        archive = {"database_archive": out["backup_ref"], "database_archive_bytes": size}
        suspended = True
    previous = tool.status
    if previous == "enabled":
        await registry.set_enabled(principal, tool.name, False)
    await _set_endpoint_enabled(registry, tool.mcp_endpoint_ref, False)
    await store.set_runtime(tool.id, runtime="local", lifecycle_state="archived",
                            runtime_state="stopped")
    now = time.time()
    with (state or WatchState()) as st:
        st.moved(mode, tool.id, "archived", now, status_before_archive=previous)
    payload = {"mode": mode, "lifecycle_state": "archived", "database_suspended": suspended,
               **archive, "status_before": previous, "by": reason}
    await runtime._record(registry, principal, tool, f"hermes tool archive {slug}", payload)
    return {"tool": slug, **payload}


async def _undo_stop(runtime: Any, tool: Any, slug: str, mode: str, *, running: bool) -> None:
    """Archive could not copy the database: put the instance back the way it was (best effort)."""
    if not tool.release_sha:
        return
    with contextlib.suppress(Exception):
        await runtime._call("route", slug=slug, mode=mode)
    if running:
        with contextlib.suppress(Exception):
            await runtime._call("start", slug=slug, mode=mode)


async def restore_app(
    runtime: Any, registry: Any, principal: Principal, name: str, *,
    state: Any = None,
) -> dict:
    """Bring an archived or lifecycle-stopped app back: database, route, instance."""
    from hermes_cli import app_runtime as rt

    mode = registry.mode
    tool = await runtime.resolve(registry, principal, name, write=True)
    slug = runtime.require_local(tool)
    store = _store_for(registry)
    await store.initialize()
    lifecycle, _row = await _lifecycle_of(store, tool)
    if lifecycle == "purged":
        raise LifecycleConflict(f"{slug!r} ({mode}) was purged; its data is gone")
    if lifecycle not in ("archived", "stopped"):
        raise LifecycleConflict(f"{slug!r} ({mode}) is {lifecycle}, not archived or stopped")
    if mode == "prod" and await store.latest_approval_ref(tool.id) is None:
        raise PermissionError(f"{slug!r} has no approved prod release; promote it first")
    if tool.release_sha:
        await rt.admit(registry, principal, "start", tool=tool.name, mode=mode)
    db = await store.get_database(tool.id, mode)
    reloaded = False
    if db is not None and db.status == "suspended":
        approval = await runtime._approve(registry, principal, "tool.restore", slug) if mode == "prod" else None
        if lifecycle == "archived" and db.archive_ref:
            out = await runtime._db("restore", slug, mode, approval_ref=approval, backup_ref=db.archive_ref)
            reloaded = out.get("restored") is True
        else:  # archived before archive took a copy
            await runtime._db("resume", slug, mode, approval_ref=approval)
        await store.upsert_database(tool.id, mode, db.db_name, status="ready")
    started = False
    fields: Dict[str, Any] = {}
    if tool.release_sha:
        if lifecycle == "archived":
            await runtime._call("route", slug=slug, mode=mode)
        out = await runtime._call("start", slug=slug, mode=mode)
        started = True
        if isinstance(out.get("port"), int):
            fields["port"] = out["port"]
    now = time.time()
    with (state or WatchState()) as st:
        entry = st.app(mode, tool.id, lifecycle, now)
        previous = entry.get("status_before_archive")
        st.moved(mode, tool.id, "active", now, status_before_archive=None)
    if lifecycle == "archived":
        await _set_endpoint_enabled(registry, tool.mcp_endpoint_ref, True)
        if previous == "enabled" and tool.status != "enabled":
            await registry.set_enabled(principal, tool.name, True)
    await store.set_runtime(
        tool.id, runtime="local", lifecycle_state="active",
        runtime_state="running" if started else "stopped",
        unit=f"aquarium-app@{slug}-{mode}", last_visit_at=_dt(now), **fields,
    )
    payload = {"mode": mode, "lifecycle_state": "active", "from": lifecycle, "started": started,
               "database_reloaded": reloaded}
    await runtime._record(registry, principal, tool, f"hermes tool restore {slug}", payload)
    return {"tool": slug, **payload}


async def purge_app(
    runtime: Any, registry: Any, principal: Principal, name: str, *, confirm: str,
    other_registry: Any = None, state: Any = None,
) -> dict:
    """Delete an archived app's instance, database and secrets for good (one confirmation).

    The source is deleted only when ``other_registry`` (the other mode) shows
    no live row of the same app; without it the source is kept.
    """
    from hermes_cli import app_runtime as rt

    mode = registry.mode
    tool = await runtime.resolve(registry, principal, name, write=True)
    slug = runtime.require_local(tool)
    if confirm != tool.name:
        raise ValueError(
            f"Purging {tool.name!r} deletes its {mode} instance and database for good; "
            f"confirm by repeating the tool name ({tool.name!r})"
        )
    store = _store_for(registry)
    await store.initialize()
    lifecycle, _row = await _lifecycle_of(store, tool)
    if lifecycle == "purged":
        raise LifecycleConflict(f"{slug!r} ({mode}) is already purged")
    if lifecycle != "archived":
        raise LifecycleConflict(f"{slug!r} ({mode}) is {lifecycle}; archive it before purging")
    approval = await runtime._approve(registry, principal, "tool.purge", slug) if mode == "prod" else None
    await runtime._call("remove", slug=slug, mode=mode, confirm=slug)
    db = await store.get_database(tool.id, mode)
    backup_ref = None
    if db is not None and db.status != "dropped":
        out = await runtime._db("drop", slug, mode, approval_ref=approval, confirm=slug)
        backup_ref = out.get("backup_ref")
        await store.upsert_database(tool.id, mode, db.db_name, status="dropped",
                                    last_backup_ref=backup_ref)
    with contextlib.suppress(OSError):
        (runtime.secrets_dir / rt.secret_ref(slug, mode)).unlink()
    if tool.mcp_endpoint_ref:
        await rt._delete_endpoint(registry, tool.mcp_endpoint_ref)
    source_deleted = await _purge_source(runtime, tool, other_registry)
    if tool.status == "enabled":
        await registry.set_enabled(principal, tool.name, False)
    await store.set_runtime(tool.id, runtime="local", lifecycle_state="purged",
                            runtime_state="stopped", health="unknown", consecutive_failures=0)
    with (state or WatchState()) as st:
        st.moved(mode, tool.id, "purged", time.time(), status_before_archive=None)
    payload = {"mode": mode, "lifecycle_state": "purged", "backup_ref": backup_ref,
               "source_deleted": source_deleted}
    await runtime._record(registry, principal, tool, f"hermes tool purge {slug}", payload,
                          reversible=False)
    return {"tool": slug, **payload}


async def _purge_source(runtime: Any, tool: Any, other_registry: Any) -> bool:
    if other_registry is None:
        return False
    other = await other_registry.get(tool.name)
    if other is not None:
        other_store = _store_for(other_registry)
        await other_store.initialize()
        lifecycle, _row = await _lifecycle_of(other_store, other)
        if lifecycle != "purged":
            return False
    repo = runtime.repo_for(tool).resolve()
    root = runtime.tools_root.resolve()
    if repo == root or root not in repo.parents or not repo.is_dir():
        return False
    shutil.rmtree(repo)
    return True


# ---------------------------------------------------------------------------
# one watch pass
# ---------------------------------------------------------------------------


async def _size_fields(runtime: Any, store: Any, tool: Any, mode: str) -> Dict[str, Any]:
    from hermes_cli import app_runtime as rt

    fields: Dict[str, Any] = {}
    disk = await asyncio.to_thread(tree_bytes, runtime.repo_for(tool))
    if disk is not None:
        fields["disk_bytes"] = disk
    db = await store.get_database(tool.id, mode)
    if db is not None and db.status in ("ready", "suspended"):
        try:
            live = await runtime._db("status", tool.name, mode)
        except rt.HelperError:
            live = {}
        if isinstance(live.get("size_bytes"), int):
            fields["db_bytes"] = live["size_bytes"]
    return fields


async def watch_once(
    registries: Dict[str, Any], *, owner: Principal, runtime: Any,
    notify_owner: OwnerNotifier, notify_box: BoxNotifier,
    state: Any = None, now: Optional[float] = None,
    capacity_state: Optional[Callable[[], Optional[str]]] = None,
    health: Callable[[int, str], Optional[int]] = health_status,
    visits: Callable[[int], int] = established,
    cpu_usage: Callable[[str], Optional[int]] = cpu_usage_usec,
    cpu_quota_pct: Optional[Callable[[], Optional[int]]] = None,
    dry_run: bool = False,
) -> dict:
    """One pass over every local app in ``registries`` (mode -> ToolRegistry)."""
    from hermes_cli import app_runtime as rt

    now = time.time() if now is None else now
    try:
        cpu_quota = (cpu_quota_pct or default_cpu_quota_pct)()
    except Exception:  # noqa: BLE001 - a broken policy read never stops the watch
        cpu_quota = None
    report: Dict[str, Any] = {"apps": [], "alerts": [], "box_alerts": [], "actions": []}
    try:
        status = await runtime._call("status", all=True)
        instances = {(d.get("slug"), d.get("mode")): d
                     for d in status.get("instances") or [] if isinstance(d, dict)}
    except rt.HelperError as exc:
        report["error"] = str(exc)
        instances = None
    box: Dict[str, str] = {}
    down: List[str] = []
    with (state or WatchState()) as st:
        st.readonly = st.readonly or dry_run
        if instances is None:
            box["helper"] = f"Local apps: the app helper does not answer ({report['error'][:300]})"
        for mode, registry in registries.items():
            if instances is None:
                break
            store = _store_for(registry)
            await store.initialize()
            for tool in await registry.list_for_principal(owner):
                if tool.hosting != "local":
                    continue
                await _watch_app(
                    tool, mode, registry, store, instances.get((tool.name, mode)), st, now,
                    owner=owner, runtime=runtime, notify_owner=notify_owner, health=health,
                    visits=visits, cpu_usage=cpu_usage, cpu_quota=cpu_quota, dry_run=dry_run,
                    report=report, box=box, down=down,
                )
        if len(down) > BOX_DOWN_ALERT:
            box["apps-down"] = f"Local apps: {len(down)} instances are down ({', '.join(sorted(down)[:10])})"
        if capacity_state is not None:
            try:
                cap = capacity_state()
            except Exception:  # noqa: BLE001 - a broken probe never stops the watch
                cap = None
            if cap == "constrained":
                box["capacity"] = "Box capacity is constrained; new local apps are not admitted"
        fresh = st.box_episodes(box, now) if not dry_run else sorted(box.values())
    for text in fresh:
        report["box_alerts"].append(text)
        if not dry_run:
            notify_box(text)
    return report


async def _watch_app(
    tool: Any, mode: str, registry: Any, store: Any, doc: Optional[dict], st: WatchState,
    now: float, *, owner: Principal, runtime: Any, notify_owner: OwnerNotifier,
    health: Callable[[int, str], Optional[int]], visits: Callable[[int], int],
    cpu_usage: Callable[[str], Optional[int]], cpu_quota: Optional[int], dry_run: bool,
    report: dict, box: Dict[str, str], down: List[str],
) -> None:
    from hermes_cli import app_runtime as rt

    slug = tool.name
    row = await store.get_runtime(tool.id) or {}
    lifecycle = row.get("lifecycle_state") or "active"
    entry = st.app(mode, tool.id, lifecycle, now)
    fields: Dict[str, Any] = {}
    running = bool(doc) and doc.get("active_state") == "active"
    port = doc.get("port") if doc else None
    last_visit = _ts(row.get("last_visit_at"))
    if running and isinstance(port, int) and visits(port) > 0:
        last_visit = now
        fields["last_visit_at"] = _dt(now)
    if isinstance(doc, dict) and isinstance(doc.get("memory_bytes"), int):
        fields["rss_bytes"] = doc["memory_bytes"]

    failures = int(row.get("consecutive_failures") or 0)
    if lifecycle in ("active", "idle"):
        code = None
        if running and isinstance(port, int):
            code = await asyncio.to_thread(health, port, str((doc or {}).get("base_path") or ""))
        verdict, failing = probe_verdict(doc, code)
        new_failures = failures + 1 if failing else 0
        fields.update(health=verdict, consecutive_failures=new_failures,
                      health_checked_at=_dt(now))
        if verdict == "down":
            down.append(f"{slug}-{mode}")
        if crash_looping(doc):
            box[f"crash-loop:{slug}-{mode}"] = (
                f"Local app {slug} ({mode}) is crash-looping: systemd stopped restarting it")
        if failures < FAILURES_TO_ALERT <= new_failures:
            report["alerts"].append({"tool": slug, "mode": mode, "owner": tool.owner_user_id})
            if not dry_run:
                await notify_owner(
                    tool.owner_user_id, f"Your app {slug} is down",
                    f"{slug} ({mode}) failed {new_failures} health checks in a row ({verdict}). "
                    f"See its logs on the Tools page, or ask the agent to fix it.",
                    f"app-down:{slug}",
                )
    cpu_pct = await _watch_cpu(tool, mode, doc, entry, now, running=running,
                               cpu_usage=cpu_usage, quota=cpu_quota, notify_owner=notify_owner,
                               dry_run=dry_run, report=report, box=box)
    if now - float(entry.get("size_at") or 0) >= SIZE_EVERY_S:
        fields.update(await _size_fields(runtime, store, tool, mode))
        entry["size_at"] = now

    nxt, action = lifecycle_step(
        lifecycle, mode=mode, now=now, since=float(entry["since"]), last_visit=last_visit,
        notice_at=entry.get("notice_at"), running=running,
    )
    if action is not None:
        report["actions"].append({"tool": slug, "mode": mode, "action": action, "to": nxt})
    if dry_run:
        report["apps"].append({"tool": slug, "mode": mode, "lifecycle": lifecycle,
                               "cpu_pct": cpu_pct, **{
            k: v for k, v in fields.items() if not isinstance(v, datetime)}})
        return
    if action == "notice":
        entry["notice_at"] = now
        await notify_owner(
            tool.owner_user_id, f"Your app {slug} will be stopped",
            f"Nobody has opened {slug} ({mode}) for a while, so it will be stopped in about "
            f"3 days. Open it to keep it running; you can restore it any time.",
            f"app-idle:{slug}:{mode}",
        )
    if action == "stop":
        await runtime._call("stop", slug=slug, mode=mode)
        fields["runtime_state"] = "stopped"
    if nxt != lifecycle and action != "archive":
        fields["lifecycle_state"] = nxt
    if fields:
        await store.set_runtime(tool.id, runtime="local", **fields)
    if nxt != lifecycle and action != "archive":
        st.moved(mode, tool.id, nxt, now)
    if action == "archive":
        try:
            await archive_app(runtime, registry, owner, slug, state=_Held(st), reason="watch")
        except rt.HelperError as exc:
            nxt = lifecycle
            report["alerts"].append({"tool": slug, "mode": mode, "kind": "archive-failed",
                                     "error": str(exc)[:500]})
            await notify_owner(
                tool.owner_user_id, f"Your app {slug} could not be archived",
                f"{slug} ({mode}) stays stopped with its database untouched: "
                f"the database copy failed ({str(exc)[:300]}).",
                f"app-archive-failed:{slug}:{mode}",
            )
    report["apps"].append({"tool": slug, "mode": mode, "lifecycle": nxt,
                           "health": fields.get("health", row.get("health")),
                           "cpu_pct": cpu_pct})


async def _watch_cpu(
    tool: Any, mode: str, doc: Optional[dict], entry: dict, now: float, *, running: bool,
    cpu_usage: Callable[[str], Optional[int]], quota: Optional[int],
    notify_owner: OwnerNotifier, dry_run: bool, report: dict, box: Dict[str, str],
) -> Optional[float]:
    """Sample the instance's CPU into ``entry``; alert on sustained use near ``quota``."""
    slug = tool.name
    usec = None
    if running:
        unit = str((doc or {}).get("unit") or f"aquarium-app@{slug}-{mode}.service")
        usec = cpu_usage(unit)
    pct = cpu_percent(entry.get("cpu"), usec, now) if usec is not None else None
    if usec is None:
        entry.pop("cpu", None)
    else:
        entry["cpu"] = {"usec": usec, "at": now}
    runs = int(entry.get("cpu_high_runs") or 0)
    if not running or not quota:
        new_runs = 0
    elif pct is None:
        new_runs = runs
    else:
        new_runs = runs + 1 if pct >= quota * CPU_HIGH_SHARE else 0
    entry["cpu_high_runs"] = new_runs
    if new_runs >= CPU_RUNS_TO_ALERT:
        box[f"cpu-high:{slug}-{mode}"] = (
            f"Local app {slug} ({mode}) has been at its {quota}% CPU limit for "
            f"{new_runs} checks in a row")
    if runs < CPU_RUNS_TO_ALERT <= new_runs:
        report["alerts"].append({"tool": slug, "mode": mode, "owner": tool.owner_user_id,
                                 "kind": "cpu", "cpu_pct": pct})
        if not dry_run:
            await notify_owner(
                tool.owner_user_id, f"Your app {slug} is using all its CPU",
                f"{slug} ({mode}) has used about {pct:g}% CPU (its limit is {quota}%) for "
                f"{new_runs} checks in a row, so it is being slowed down. Check its logs on "
                f"the Tools page, or ask the agent to find what keeps it busy.",
                f"app-cpu:{slug}",
            )
    return pct


class _Held:
    """An already-locked :class:`WatchState` passed to a verb inside the pass."""

    def __init__(self, state: WatchState) -> None:
        self._state = state

    def __enter__(self) -> WatchState:
        return self._state

    def __exit__(self, *exc: Any) -> None:
        return None


# ---------------------------------------------------------------------------
# entry point (aquarium-apps-watch.service)
# ---------------------------------------------------------------------------


def _capacity_state(config: Optional[dict]) -> Optional[str]:
    from hermes_cli import capacity

    return capacity.headroom(config).state


async def run_watch(*, now: Optional[float] = None, dry_run: bool = False,
                    box_alerts: bool = True) -> dict:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.app_runtime import AppRuntime
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    config = load_config() or {}
    owner = await PrincipalStore(get_store("supabase-app", "prod", config=config)).get_owner()
    if owner is None:
        return {"error": "no owner enrolled; nothing to watch"}
    registries = {}
    for mode in ("dev", "prod"):
        registries[mode] = ToolRegistry(get_store("supabase-app", mode, config=config))
        await registries[mode].initialize()
    return await watch_once(
        registries, owner=owner, runtime=AppRuntime(config=config),
        notify_owner=notification_owner_notifier(config),
        notify_box=telegram_box_notifier if box_alerts else (lambda text: print(f"[apps-watch] {text}")),
        now=now, dry_run=dry_run, capacity_state=lambda: _capacity_state(config),
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="One FG-33 local-app watch pass.")
    parser.add_argument("--json", action="store_true", help="print the pass report as JSON")
    parser.add_argument("--dry-run", action="store_true",
                        help="probe and report only: no writes, alerts or lifecycle actions")
    parser.add_argument("--now", default=None,
                        help="clock override (ISO 8601), for testing lifecycle timers")
    parser.add_argument("--no-box-alerts", action="store_true",
                        help="print box alerts instead of sending them to Telegram")
    args = parser.parse_args(argv)
    now = None
    if args.now:
        now = _ts(args.now)
        if now is None:
            parser.error(f"--now {args.now!r} is not an ISO 8601 time")
    from hermes_cli.env_loader import load_hermes_dotenv

    load_hermes_dotenv()
    report = asyncio.run(run_watch(now=now, dry_run=args.dry_run,
                                   box_alerts=not args.no_box_alerts))
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True, default=str))
    else:
        if report.get("error"):
            print(f"apps-watch: {report['error']}")
        print(f"apps-watch: {len(report.get('apps', []))} app instance(s), "
              f"{len(report.get('alerts', []))} owner alert(s), "
              f"{len(report.get('box_alerts', []))} box alert(s), "
              f"{len(report.get('actions', []))} lifecycle action(s)")
    return 0


__all__ = [
    "LIFECYCLE_VERBS",
    "LifecycleConflict",
    "WatchState",
    "archive_app",
    "cpu_percent",
    "cpu_usage_usec",
    "crash_looping",
    "lifecycle_step",
    "probe_verdict",
    "purge_app",
    "restore_app",
    "watch_once",
]


if __name__ == "__main__":
    sys.exit(main())
