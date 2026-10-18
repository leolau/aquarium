"""FG-31 — capacity headroom: where the owner stands before things get slow.

Phase 6 made the access model serve hundreds of registered people. It did not
change what one box can do *at once*. Two things bound that, and they have
different fixes:

* **memory** — every active conversation holds a live agent in RAM to keep its
  prompt cache warm, so RAM tracks concurrent conversations, not user count;
* **SQLite's single writer** — simultaneous writes serialise, which costs
  latency and never correctness.

The second one matters most for the advice: a bigger box does not fix it. So
this module does not report a percentage — it derives one verdict and **names
the bound that is binding**, because "memory, driven by 9 concurrent
conversations" tells the owner what to do and "78%" does not.

Every indicator comes from something already shipped: the active-session
leases, ``psutil`` for RSS/available memory, the write-retry accounting in
``SessionDB``, transcript timestamps for latency, and the profiles directory.
"""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import yaml

log = logging.getLogger(__name__)

COMFORTABLE = "comfortable"
WATCH = "watch"
CONSTRAINED = "constrained"

_SEVERITY = {COMFORTABLE: 0, WATCH: 1, CONSTRAINED: 2}

#: Bound labels. Used in the verdict text and asserted by the tests, so the
#: "which bound is binding" contract is one vocabulary rather than prose.
BOUND_SESSIONS = "concurrent conversations"
BOUND_MEMORY = "memory"
BOUND_WRITE_LOCK = "write-lock waits"
BOUND_LATENCY = "turn latency"
BOUND_STORAGE = "disk space"
BOUND_CPU = "cpu load"

#: Bounds a bigger box cannot fix. The single-writer bound is serialisation:
#: more RAM and more cores do not remove it, the runtime scale-out work does.
_HARDWARE_CANNOT_FIX = {BOUND_WRITE_LOCK}


@dataclass(frozen=True)
class CapacityThresholds:
    """Verdict thresholds. Conservative until calibrated on the systest box.

    Deliberately in ``config.yaml`` (``capacity:``) and never environment
    variables: these are behavioural settings, not credentials.
    """

    #: Peak share of the concurrency cap that reads as approaching the bound.
    watch_session_ratio: float = 0.60
    constrained_session_ratio: float = 0.85
    #: RAM one more live conversation costs, **measured** on hermes-systest
    #: (2026-08-16, FG-31 §Calibration): concurrent seeded conversations in one
    #: process peaked at 154/209/248/295 MB RSS for 1/4/6/12, i.e. 13–19 MB of
    #: margin per additional conversation, sub-linear as they share caches. 20
    #: rounds that up; the first conversation's ~127 MB of agent machinery is
    #: process cost, which ``profile_slab_mb`` already carries.
    conversation_cost_mb: float = 20.0
    #: RAM one more profile costs (a gateway of its own, ~150 MB measured).
    profile_slab_mb: float = 150.0
    #: Working margin the box should keep free beyond one more profile.
    memory_margin_mb: float = 512.0
    #: Write-lock waits per hour. Rare waits are normal on a shared state.db;
    #: routine waits are the serialisation bound biting.
    watch_contention_per_hour: float = 6.0
    constrained_contention_per_hour: float = 30.0
    #: Reply latency the owner actually experiences, p95.
    watch_p95_s: float = 25.0
    constrained_p95_s: float = 60.0
    #: Turns the window must hold before p95 may decide the verdict. With a
    #: handful of samples p95 *is* the slowest turn, so a single long agentic
    #: reply pins the box to ``constrained`` for a day with nothing running.
    #: Below this the latency is still reported — labelled as too small to
    #: judge — and simply cannot bind.
    min_latency_samples: float = 8.0
    #: Share of the data volume used. A full disk breaks everything at once —
    #: WAL files, uploads, backups — so it binds the verdict like the others.
    watch_disk_pct: float = 0.80
    constrained_disk_pct: float = 0.90
    #: 1-minute load average per CPU. Sustained ratio above 1.0 means work is
    #: queueing; instantaneous percentages are too noisy to bind, so only the
    #: load average feeds the verdict.
    watch_load_ratio: float = 1.0
    constrained_load_ratio: float = 2.0
    #: Free space the upload store (the Supabase storage volume) should keep.
    #: Uploads are unlimited, so the owner is warned when free space drops
    #: below *either* floor instead of refusing files at a fixed size.
    upload_min_free_gb: float = 5.0
    upload_min_free_pct: float = 0.10
    #: Trailing window for contention and latency.
    window_s: float = 86400.0

    @classmethod
    def from_config(cls, config: Optional[Dict[str, Any]]) -> "CapacityThresholds":
        section = {}
        if isinstance(config, dict):
            raw = config.get("capacity")
            if isinstance(raw, dict):
                section = raw
        values: Dict[str, float] = {}
        for name in cls.__dataclass_fields__:  # noqa: F821 - dataclass API
            if name not in section:
                continue
            try:
                values[name] = float(section[name])
            except (TypeError, ValueError):
                log.warning(
                    "Ignoring invalid capacity.%s=%r (expected a number)",
                    name,
                    section[name],
                )
        return cls(**values)


@dataclass
class SessionLoad:
    """Live conversations, box-wide and per profile."""

    active_total: int = 0
    per_profile: Dict[str, int] = field(default_factory=dict)
    #: The cap enforced in *this* profile. The registry is profile-local, so
    #: each profile enforces its own — see ``cap_box_wide``.
    cap_here: Optional[int] = None
    #: Sum of every profile's cap: what the box can be asked to hold at once.
    #: ``None`` when any profile leaves the cap unset (i.e. unbounded).
    cap_box_wide: Optional[int] = None
    profiles_seen: int = 0

    @property
    def ratio(self) -> Optional[float]:
        if not self.cap_box_wide:
            return None
        return self.active_total / float(self.cap_box_wide)


@dataclass
class MemoryLoad:
    available_mb: Optional[float] = None
    total_mb: Optional[float] = None
    hermes_rss_mb: Optional[float] = None
    by_process: Dict[str, float] = field(default_factory=dict)

    @property
    def measured(self) -> bool:
        return self.available_mb is not None


@dataclass
class WriteContention:
    events: float = 0.0
    waited_s: float = 0.0
    exhausted: float = 0.0
    window_s: float = 86400.0
    available: bool = True

    @property
    def per_hour(self) -> float:
        hours = max(self.window_s / 3600.0, 1.0 / 3600.0)
        return self.events / hours


@dataclass
class TurnLatency:
    samples: int = 0
    p50_s: Optional[float] = None
    p95_s: Optional[float] = None

    def representative(self, thresholds: "CapacityThresholds") -> bool:
        """Whether p95 over this many turns may decide the verdict."""
        return self.samples >= int(thresholds.min_latency_samples)


@dataclass
class StorageLoad:
    """Usage of the filesystem that holds the hermes home (and the SQLite
    databases, session dirs, and backups that grow with use)."""

    used_mb: Optional[float] = None
    total_mb: Optional[float] = None
    #: The path the reading was taken on — names *which* volume is filling.
    path: Optional[str] = None

    @property
    def measured(self) -> bool:
        return self.used_mb is not None and self.total_mb is not None

    @property
    def pct(self) -> Optional[float]:
        if not self.measured or not self.total_mb:
            return None
        return (self.used_mb or 0.0) / self.total_mb


@dataclass
class CpuLoad:
    """Sustained CPU pressure: the 1-minute load average per core, plus an
    instantaneous busy sample for display."""

    load1: Optional[float] = None
    cpus: Optional[int] = None
    percent: Optional[float] = None

    @property
    def measured(self) -> bool:
        return self.load1 is not None and bool(self.cpus)

    @property
    def ratio(self) -> Optional[float]:
        if not self.measured:
            return None
        return self.load1 / float(self.cpus)


@dataclass
class CapacityIndicators:
    sessions: SessionLoad = field(default_factory=SessionLoad)
    memory: MemoryLoad = field(default_factory=MemoryLoad)
    contention: WriteContention = field(default_factory=WriteContention)
    latency: TurnLatency = field(default_factory=TurnLatency)
    storage: StorageLoad = field(default_factory=StorageLoad)
    cpu: CpuLoad = field(default_factory=CpuLoad)
    profile_count: int = 1
    collected_at: float = field(default_factory=time.time)
    #: Indicators that could not be read, by name, so a surface can say
    #: "unknown" instead of implying a measured zero.
    unavailable: List[str] = field(default_factory=list)


@dataclass
class Bound:
    """One capacity bound, its state, and whether hardware can move it."""

    name: str
    state: str
    reason: str
    #: 0..1+ share of the way to `constrained`, for tie-breaking only.
    pressure: float
    hardware_helps: bool = True


@dataclass
class CapacityVerdict:
    state: str
    binding: Optional[Bound]
    bounds: List[Bound]
    recommendations: List[str]
    indicators: CapacityIndicators

    def headline(self) -> str:
        """One line: the verdict and the constraint that produced it."""
        if self.binding is None or self.state == COMFORTABLE:
            return f"Headroom: {self.state}."
        return f"Headroom: {self.state} — {self.binding.name}, {self.binding.reason}."


# ── Collection ───────────────────────────────────────────────────────────────


def _profile_homes() -> List[Tuple[str, Path]]:
    """``(name, home)`` for every profile on the box, default first."""
    from hermes_cli.profiles import _get_default_hermes_home, _get_profiles_root

    homes: List[Tuple[str, Path]] = []
    default_home = _get_default_hermes_home()
    if default_home.is_dir():
        homes.append(("default", default_home))
    root = _get_profiles_root()
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if entry.is_dir() and entry.name != "default":
                homes.append((entry.name, entry))
    return homes


def _profile_cap(home: Path) -> Tuple[Optional[int], bool]:
    """``(cap, known)`` for a profile, read from its own ``config.yaml``."""
    from hermes_cli.active_sessions import resolve_max_concurrent_sessions

    path = home / "config.yaml"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            config = yaml.safe_load(fh) or {}
    except FileNotFoundError:
        return None, True
    except Exception as exc:
        log.debug("capacity: could not read %s: %s", path, exc)
        return None, False
    if not isinstance(config, dict):
        return None, True
    return resolve_max_concurrent_sessions(config), True


def collect_session_load(config: Optional[Dict[str, Any]] = None) -> SessionLoad:
    """Live conversations across every profile, not just this one.

    The lease registry lives under each profile's home, so a per-profile read
    understates the box: three profiles at 6 live conversations each would each
    report 6 while the box carries 18 — and RAM, the resource the cap protects,
    is box-wide.
    """
    from hermes_cli.active_sessions import (
        read_registry_for_home,
        resolve_max_concurrent_sessions,
    )
    from hermes_constants import get_hermes_home

    load = SessionLoad()
    here = Path(get_hermes_home()).resolve()
    load.cap_here = resolve_max_concurrent_sessions(config or {})
    caps: List[int] = []
    every_cap_known = True
    for name, home in _profile_homes():
        try:
            entries = read_registry_for_home(home)
        except Exception as exc:
            log.debug("capacity: lease read failed for %s: %s", name, exc)
            every_cap_known = False
            continue
        load.per_profile[name] = len(entries)
        load.active_total += len(entries)
        load.profiles_seen += 1
        if home.resolve() == here and load.cap_here is not None:
            cap, known = load.cap_here, True
        else:
            cap, known = _profile_cap(home)
        if not known:
            every_cap_known = False
        elif cap is None:
            # Cap disabled for this profile: the box is unbounded, and a sum
            # would understate that.
            every_cap_known = False
        else:
            caps.append(cap)
    if caps and every_cap_known:
        load.cap_box_wide = sum(caps)
    return load


#: Process-name fragments to the slab they represent. Matched against the
#: command line, so a profile's gateway and the console are counted separately.
_PROCESS_LABELS: Sequence[Tuple[str, str]] = (
    ("gateway", "gateway"),
    ("web_server", "console"),
    ("dashboard", "console"),
    ("embed", "embedding server"),
    ("hermes", "other hermes"),
)


def collect_memory_load() -> MemoryLoad:
    load = MemoryLoad()
    try:
        import psutil
    except ImportError:
        return load
    try:
        virtual = psutil.virtual_memory()
        load.available_mb = virtual.available / 1048576.0
        load.total_mb = virtual.total / 1048576.0
    except Exception as exc:
        log.debug("capacity: virtual_memory unavailable: %s", exc)
        return load
    total_rss = 0.0
    for proc in psutil.process_iter(["cmdline", "memory_info"]):
        try:
            info = proc.info
            cmdline = " ".join(info.get("cmdline") or []).lower()
            mem = info.get("memory_info")
            if not cmdline or mem is None or "hermes" not in cmdline:
                continue
            rss_mb = mem.rss / 1048576.0
        except Exception:
            continue
        total_rss += rss_mb
        for fragment, label in _PROCESS_LABELS:
            if fragment in cmdline:
                load.by_process[label] = load.by_process.get(label, 0.0) + rss_mb
                break
    load.hermes_rss_mb = total_rss
    return load


def collect_write_contention(
    thresholds: CapacityThresholds, *, now: Optional[float] = None
) -> WriteContention:
    """Write-lock waits recorded by ``SessionDB``'s retry path."""
    from hermes_state import SessionDB

    result = WriteContention(window_s=thresholds.window_s)
    db: Optional[SessionDB] = None
    try:
        # Read-only: an indicator must never take the write lock it is
        # measuring, nor initialise a schema on a box that has none yet.
        db = SessionDB(read_only=True)
        totals = db.read_write_contention(window_s=thresholds.window_s, now=now)
        result.events = totals.get("events", 0.0)
        result.waited_s = totals.get("waited_s", 0.0)
        result.exhausted = totals.get("exhausted", 0.0)
    except Exception as exc:
        log.debug("capacity: contention read failed: %s", exc)
        result.available = False
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
    return result


def _percentile(values: Sequence[float], pct: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    index = min(len(ordered) - 1, max(0, int(round(pct * (len(ordered) - 1)))))
    return ordered[index]


def collect_storage_load() -> StorageLoad:
    """Usage of the filesystem holding the hermes home.

    That path is deliberate: it is where the databases, session dirs, and
    backups grow, so it is the disk that running out actually hurts — the OS
    volume filling is a different incident.
    """
    from hermes_constants import get_hermes_home

    load = StorageLoad()
    try:
        import psutil
    except ImportError:
        return load
    try:
        target = Path(get_hermes_home())
        if not target.exists():
            target = Path("/")
        usage = psutil.disk_usage(str(target))
    except Exception as exc:
        log.debug("capacity: disk_usage unavailable: %s", exc)
        return load
    load.used_mb = usage.used / 1048576.0
    load.total_mb = usage.total / 1048576.0
    load.path = str(target)
    return load


#: Where the standard install keeps uploaded files: install-aquarium.sh runs
#: Supabase from ``$AQUARIUM_ROOT/supabase/docker`` and its storage service
#: bind-mounts ``./volumes/storage``.
_SUPABASE_STORAGE_SUBDIR = Path("supabase") / "docker" / "volumes" / "storage"


def upload_storage_path(config: Optional[Dict[str, Any]] = None) -> Path:
    """The directory whose disk holds uploads.

    ``capacity.upload_storage_path`` in config.yaml wins; then the standard
    Supabase storage volume; then the hermes home (same disk on a one-box
    install), so a box without Supabase storage still gets a reading.
    """
    section = config.get("capacity") if isinstance(config, dict) else None
    configured = section.get("upload_storage_path") if isinstance(section, dict) else None
    if isinstance(configured, str) and configured.strip():
        return Path(configured.strip()).expanduser()
    root = Path(os.environ.get("AQUARIUM_ROOT") or "/opt/data")
    candidate = root / _SUPABASE_STORAGE_SUBDIR
    if candidate.is_dir():
        return candidate
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


@dataclass
class UploadStorage:
    """Free space on the disk that holds uploaded files."""

    path: Optional[str] = None
    free_bytes: Optional[int] = None
    total_bytes: Optional[int] = None
    min_free_bytes: Optional[int] = None

    @property
    def measured(self) -> bool:
        return self.free_bytes is not None and bool(self.total_bytes)

    @property
    def low(self) -> bool:
        return (
            self.measured
            and self.min_free_bytes is not None
            and self.free_bytes < self.min_free_bytes
        )

    def as_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "free_bytes": self.free_bytes,
            "total_bytes": self.total_bytes,
            "min_free_bytes": self.min_free_bytes,
            "low": self.low,
        }

    def warning(self) -> Optional[str]:
        if not self.low:
            return None
        gb = 1024.0 ** 3
        return (
            f"Upload storage is running low: {self.free_bytes / gb:.1f} GB free of "
            f"{self.total_bytes / gb:.0f} GB on {self.path}. Free up space or add "
            "disk before large uploads start failing."
        )


def collect_upload_storage(
    config: Optional[Dict[str, Any]] = None,
    thresholds: Optional[CapacityThresholds] = None,
) -> UploadStorage:
    thresholds = thresholds or CapacityThresholds.from_config(config)
    try:
        target = upload_storage_path(config)
        while not target.exists() and target != target.parent:
            target = target.parent
        usage = shutil.disk_usage(str(target))
    except Exception as exc:
        log.debug("capacity: upload storage unavailable: %s", exc)
        return UploadStorage()
    floor = max(
        thresholds.upload_min_free_gb * 1024.0 ** 3,
        thresholds.upload_min_free_pct * usage.total,
    )
    return UploadStorage(
        path=str(target),
        free_bytes=int(usage.free),
        total_bytes=int(usage.total),
        min_free_bytes=int(floor),
    )


def collect_cpu_load() -> CpuLoad:
    load = CpuLoad()
    try:
        import psutil
    except ImportError:
        return load
    try:
        load.cpus = psutil.cpu_count() or None
        load.load1 = psutil.getloadavg()[0]
        # A short sample: instantaneous busy-ness for display only — the
        # verdict binds on the sustained load average, not a spike.
        load.percent = psutil.cpu_percent(interval=0.1)
    except Exception as exc:
        log.debug("capacity: cpu load unavailable: %s", exc)
    return load


# ── CPU utilization history ─────────────────────────────────────────────────
#
# The instantaneous reading above can only describe *now*. The capacity page
# asks a different question — how busy the box has been — which needs samples
# persisted somewhere. A tiny SQLite file at the shared root (alongside
# kanban.db, box-wide rather than per-profile) keeps one row per minute; the
# dashboard runs the sampler thread in its lifespan.

#: How often the sampler records a reading, and how long rows are kept.
#: 31 days covers the longest maximum window with a small margin.
CPU_SAMPLE_INTERVAL_S = 60.0
CPU_HISTORY_KEEP_S = 31 * 86400.0

_CPU_HISTORY_WINDOWS = (
    ("max_24h", 86400.0),
    ("max_7d", 7 * 86400.0),
    ("max_30d", 30 * 86400.0),
)


def _capacity_db_path() -> Path:
    """``<shared root>/capacity.db`` — box-wide history, not per-profile."""
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / "capacity.db"


def _connect_history(path: Path, *, create: bool) -> Optional[sqlite3.Connection]:
    """Open the history DB. Read paths never create it — an indicator must
    not make a file appear on a box that has none."""
    if not create and not path.exists():
        return None
    try:
        conn = sqlite3.connect(str(path), timeout=5.0)
        if create:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS cpu_samples ("
                "ts REAL PRIMARY KEY, pct REAL NOT NULL, load1 REAL)"
            )
        return conn
    except Exception as exc:
        log.debug("capacity: history db unavailable: %s", exc)
        return None


def record_cpu_sample(
    pct: float,
    load1: Optional[float],
    *,
    now: Optional[float] = None,
    path: Optional[Path] = None,
) -> None:
    """Append one utilization reading and prune past the retention window."""
    ts = now if now is not None else time.time()
    conn = _connect_history(
        path if path is not None else _capacity_db_path(), create=True
    )
    if conn is None:
        return
    try:
        conn.execute(
            "INSERT OR REPLACE INTO cpu_samples (ts, pct, load1) VALUES (?, ?, ?)",
            (ts, float(pct), load1),
        )
        conn.execute(
            "DELETE FROM cpu_samples WHERE ts < ?", (ts - CPU_HISTORY_KEEP_S,)
        )
        conn.commit()
    except Exception as exc:
        log.debug("capacity: history write failed: %s", exc)
    finally:
        conn.close()


def cpu_sampler_loop(
    stop_event: Any,
    interval_s: float = CPU_SAMPLE_INTERVAL_S,
    *,
    path: Optional[Path] = None,
) -> None:
    """Daemon-thread target: record CPU busy% once a minute.

    ``cpu_percent(interval=None)`` reports the share of wall-clock time the
    box was busy *since the previous call*, so each sample is already the
    average over the interval — no second measurement needed.
    """
    try:
        import psutil
    except ImportError:
        return
    target = path if path is not None else _capacity_db_path()
    psutil.cpu_percent(interval=None)  # prime: the first call measures since boot
    while not stop_event.wait(interval_s):
        try:
            pct = psutil.cpu_percent(interval=None)
            load1 = psutil.getloadavg()[0]
        except Exception as exc:
            log.debug("capacity: cpu sample failed: %s", exc)
            continue
        record_cpu_sample(pct, load1, path=target)


def cpu_history(
    *, now: Optional[float] = None, path: Optional[Path] = None
) -> Dict[str, Any]:
    """Hourly utilization for the graph plus peaks over 24h / 7d / 30d.

    ``hourly`` is exactly 24 hour-aligned buckets ending at the current hour;
    a bucket with no samples gets ``None`` so the UI renders a gap rather than
    a fake zero. Peaks are the busiest sampled minute in each window — the
    per-minute samples are themselves interval averages, so a "peak" is the
    busiest minute, not a scheduler tick.
    """
    ts_now = now if now is not None else time.time()
    empty: Dict[str, Any] = {"hourly": [], "max_24h": None, "max_7d": None, "max_30d": None}
    conn = _connect_history(
        path if path is not None else _capacity_db_path(), create=False
    )
    if conn is None:
        return empty
    try:
        hour_now = int(ts_now // 3600)
        rows = conn.execute(
            "SELECT CAST(ts / 3600 AS INTEGER) AS bucket, AVG(pct), MAX(pct) "
            "FROM cpu_samples WHERE ts >= ? AND ts < ? GROUP BY bucket",
            ((hour_now - 23) * 3600.0, (hour_now + 1) * 3600.0),
        ).fetchall()
        by_bucket = {int(r[0]): (r[1], r[2]) for r in rows}
        hourly = [
            {
                "ts": (hour_now - 23 + i) * 3600,
                "avg_pct": (
                    None
                    if (hour_now - 23 + i) not in by_bucket
                    else round(by_bucket[hour_now - 23 + i][0], 1)
                ),
                "max_pct": (
                    None
                    if (hour_now - 23 + i) not in by_bucket
                    else round(by_bucket[hour_now - 23 + i][1], 1)
                ),
            }
            for i in range(24)
        ]
        peaks: Dict[str, Any] = {}
        for name, window_s in _CPU_HISTORY_WINDOWS:
            row = conn.execute(
                "SELECT MAX(pct) FROM cpu_samples WHERE ts >= ?",
                (ts_now - window_s,),
            ).fetchone()
            peaks[name] = None if row is None or row[0] is None else round(row[0], 1)
    except Exception as exc:
        log.debug("capacity: history read failed: %s", exc)
        return empty
    finally:
        conn.close()
    return {"hourly": hourly, **peaks}


def collect_turn_latency(
    thresholds: CapacityThresholds, *, now: Optional[float] = None
) -> TurnLatency:
    from hermes_state import SessionDB

    latency = TurnLatency()
    db: Optional[SessionDB] = None
    try:
        db = SessionDB(read_only=True)
        samples = db.recent_turn_latencies_s(window_s=thresholds.window_s, now=now)
    except Exception as exc:
        log.debug("capacity: latency read failed: %s", exc)
        return latency
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:
                pass
    latency.samples = len(samples)
    latency.p50_s = _percentile(samples, 0.50)
    latency.p95_s = _percentile(samples, 0.95)
    return latency


def collect_indicators(
    config: Optional[Dict[str, Any]] = None,
    *,
    thresholds: Optional[CapacityThresholds] = None,
    now: Optional[float] = None,
) -> CapacityIndicators:
    """Every indicator, each degrading to "unavailable" on its own.

    Cheap by construction: four small reads (one JSON file per profile, one
    ``psutil`` sweep, two indexed queries), so it can run on the digest cadence
    and on demand without touching the turn path.
    """
    thresholds = thresholds or CapacityThresholds.from_config(config)
    indicators = CapacityIndicators(collected_at=now or time.time())
    try:
        indicators.sessions = collect_session_load(config)
    except Exception as exc:
        log.debug("capacity: session load unavailable: %s", exc)
        indicators.unavailable.append("active conversations")
    indicators.memory = collect_memory_load()
    if not indicators.memory.measured:
        indicators.unavailable.append("memory")
    indicators.contention = collect_write_contention(thresholds, now=now)
    if not indicators.contention.available:
        indicators.unavailable.append("write-lock waits")
    indicators.latency = collect_turn_latency(thresholds, now=now)
    if not indicators.latency.samples:
        indicators.unavailable.append("turn latency")
    elif not indicators.latency.representative(thresholds):
        indicators.unavailable.append(
            f"turn latency (only {indicators.latency.samples} interactive "
            f"turn(s) in the window; {int(thresholds.min_latency_samples)} "
            "needed to judge)"
        )
    indicators.storage = collect_storage_load()
    if not indicators.storage.measured:
        indicators.unavailable.append("disk space")
    indicators.cpu = collect_cpu_load()
    if not indicators.cpu.measured:
        indicators.unavailable.append("cpu load")
    try:
        indicators.profile_count = max(1, len(_profile_homes()))
    except Exception as exc:
        log.debug("capacity: profile count unavailable: %s", exc)
    return indicators


# ── Verdict ──────────────────────────────────────────────────────────────────


def _session_bound(
    load: SessionLoad, thresholds: CapacityThresholds
) -> Optional[Bound]:
    ratio = load.ratio
    if ratio is None:
        return None
    detail = (
        f"{load.active_total} of {load.cap_box_wide} "
        f"across {max(1, load.profiles_seen)} profile(s)"
    )
    pressure = ratio / thresholds.constrained_session_ratio
    if ratio >= thresholds.constrained_session_ratio:
        return Bound(BOUND_SESSIONS, CONSTRAINED, f"{detail} — at the cap", pressure)
    if ratio >= thresholds.watch_session_ratio:
        return Bound(BOUND_SESSIONS, WATCH, f"{detail} — approaching the cap", pressure)
    return Bound(BOUND_SESSIONS, COMFORTABLE, detail, pressure)


def _memory_bound(
    memory: MemoryLoad,
    load: SessionLoad,
    thresholds: CapacityThresholds,
) -> Optional[Bound]:
    if memory.available_mb is None:
        return None
    #: What the box must keep free to absorb one more profile and its work.
    need = thresholds.profile_slab_mb + thresholds.memory_margin_mb
    driver = f"{load.active_total} concurrent conversation(s)"
    detail = f"{memory.available_mb / 1024.0:.1f} GB available, driven by {driver}"
    # Pressure is measured against the *constrained* line, as every other bound
    # is, so the tie-break compares like with like.
    pressure = thresholds.memory_margin_mb / max(memory.available_mb, 1.0)
    if memory.available_mb < thresholds.memory_margin_mb:
        return Bound(BOUND_MEMORY, CONSTRAINED, f"{detail} — below the working margin", pressure)
    if memory.available_mb < need:
        return Bound(
            BOUND_MEMORY,
            WATCH,
            f"{detail} — under the cost of one more profile plus margin",
            pressure,
        )
    return Bound(BOUND_MEMORY, COMFORTABLE, detail, pressure)


def _contention_bound(
    contention: WriteContention, thresholds: CapacityThresholds
) -> Optional[Bound]:
    if not contention.available:
        return None
    per_hour = contention.per_hour
    detail = (
        f"{per_hour:.1f} write-lock wait(s)/hour, "
        f"{contention.waited_s:.1f}s waited over "
        f"{contention.window_s / 3600.0:.0f}h"
    )
    pressure = per_hour / max(thresholds.constrained_contention_per_hour, 1e-6)
    if per_hour >= thresholds.constrained_contention_per_hour:
        return Bound(
            BOUND_WRITE_LOCK,
            CONSTRAINED,
            f"{detail} — writes are serialising routinely",
            pressure,
            hardware_helps=False,
        )
    if per_hour >= thresholds.watch_contention_per_hour:
        return Bound(
            BOUND_WRITE_LOCK,
            WATCH,
            f"{detail} — waits are becoming routine",
            pressure,
            hardware_helps=False,
        )
    return Bound(BOUND_WRITE_LOCK, COMFORTABLE, detail, pressure, hardware_helps=False)


def _latency_bound(
    latency: TurnLatency, thresholds: CapacityThresholds
) -> Optional[Bound]:
    if latency.p95_s is None:
        return None
    if not latency.representative(thresholds):
        return None
    detail = f"p95 {latency.p95_s:.1f}s over {latency.samples} turn(s)"
    pressure = latency.p95_s / max(thresholds.constrained_p95_s, 1e-6)
    if latency.p95_s >= thresholds.constrained_p95_s:
        return Bound(BOUND_LATENCY, CONSTRAINED, f"{detail} — replies are slow", pressure)
    if latency.p95_s >= thresholds.watch_p95_s:
        return Bound(BOUND_LATENCY, WATCH, f"{detail} — replies are lengthening", pressure)
    return Bound(BOUND_LATENCY, COMFORTABLE, detail, pressure)


def _storage_bound(
    storage: StorageLoad, thresholds: CapacityThresholds
) -> Optional[Bound]:
    pct = storage.pct
    if pct is None:
        return None
    where = storage.path or "the data volume"
    detail = (
        f"{(storage.used_mb or 0.0) / 1024.0:.0f} of "
        f"{(storage.total_mb or 0.0) / 1024.0:.0f} GB used "
        f"({pct:.0%}) on {where}"
    )
    pressure = pct / max(thresholds.constrained_disk_pct, 1e-6)
    if pct >= thresholds.constrained_disk_pct:
        return Bound(
            BOUND_STORAGE, CONSTRAINED, f"{detail} — nearly full", pressure
        )
    if pct >= thresholds.watch_disk_pct:
        return Bound(
            BOUND_STORAGE, WATCH, f"{detail} — filling up", pressure
        )
    return Bound(BOUND_STORAGE, COMFORTABLE, detail, pressure)


def _cpu_bound(
    cpu: CpuLoad, thresholds: CapacityThresholds
) -> Optional[Bound]:
    ratio = cpu.ratio
    if ratio is None:
        return None
    detail = f"load {cpu.load1:.1f} on {cpu.cpus} cpu(s)"
    pressure = ratio / max(thresholds.constrained_load_ratio, 1e-6)
    if ratio >= thresholds.constrained_load_ratio:
        return Bound(
            BOUND_CPU, CONSTRAINED, f"{detail} — work is queueing", pressure
        )
    if ratio >= thresholds.watch_load_ratio:
        return Bound(
            BOUND_CPU, WATCH, f"{detail} — at saturation", pressure
        )
    return Bound(BOUND_CPU, COMFORTABLE, detail, pressure)


def derive_verdict(
    indicators: CapacityIndicators,
    thresholds: Optional[CapacityThresholds] = None,
    *,
    config: Optional[Dict[str, Any]] = None,
    idle_profiles: Optional[Sequence[str]] = None,
) -> CapacityVerdict:
    """One verdict, naming the bound that produced it.

    When two bounds sit at the same state the more pressed one is named, and a
    bound hardware cannot fix wins a tie — recommending an upgrade that cannot
    help would be worse than saying nothing.
    """
    thresholds = thresholds or CapacityThresholds.from_config(config)
    bounds = [
        bound
        for bound in (
            _session_bound(indicators.sessions, thresholds),
            _memory_bound(indicators.memory, indicators.sessions, thresholds),
            _contention_bound(indicators.contention, thresholds),
            _latency_bound(indicators.latency, thresholds),
            _storage_bound(indicators.storage, thresholds),
            _cpu_bound(indicators.cpu, thresholds),
        )
        if bound is not None
    ]
    state = COMFORTABLE
    binding: Optional[Bound] = None
    for bound in bounds:
        if _SEVERITY[bound.state] > _SEVERITY[state]:
            state, binding = bound.state, bound
        elif (
            binding is not None
            and bound.state == state
            and _SEVERITY[bound.state] > _SEVERITY[COMFORTABLE]
        ):
            if (not bound.hardware_helps and binding.hardware_helps) or (
                bound.hardware_helps == binding.hardware_helps
                and bound.pressure > binding.pressure
            ):
                binding = bound
    return CapacityVerdict(
        state=state,
        binding=binding,
        bounds=bounds,
        recommendations=_recommendations(
            state, binding, indicators, thresholds, idle_profiles or []
        ),
        indicators=indicators,
    )


def _tier_advice(indicators: CapacityIndicators, thresholds: CapacityThresholds) -> str:
    """Hardware advice with the measured basis stated, or its absence stated."""
    profiles = indicators.profile_count
    active = indicators.sessions.active_total
    need_mb = (
        profiles * thresholds.profile_slab_mb + active * thresholds.conversation_cost_mb
    )
    basis = (
        f"{profiles} profile(s) + {active} concurrent conversation(s) ≈ "
        f"{need_mb / 1024.0:.1f} GB of agent working set"
    )
    return (
        f"Size the next tier from the load, not the user count: {basis}. "
        "The per-conversation figure is measured (hermes-systest, 2026-08-16), "
        "not estimated."
    )


def _recommendations(
    state: str,
    binding: Optional[Bound],
    indicators: CapacityIndicators,
    thresholds: CapacityThresholds,
    idle: Sequence[str],
) -> List[str]:
    if state == COMFORTABLE or binding is None:
        return []
    out: List[str] = []
    if binding.name == BOUND_WRITE_LOCK:
        # Said first and plainly: this is the one an upgrade cannot move.
        out.append(
            "A bigger box does not fix this. Write-lock waits are SQLite's "
            "single-writer bound — the fix is the runtime scale-out work "
            "(sharded workers, moving the session store off SQLite), not "
            "hardware."
        )
    # The cheap actions first, and only the ones this box can actually take.
    if idle:
        out.append(
            "Retire idle profiles — "
            + ", ".join(idle)
            + f" (each costs about {thresholds.profile_slab_mb:.0f} MB of gateway)."
        )
    if indicators.profile_count > 1:
        gateways = indicators.memory.by_process.get("gateway")
        if gateways is None or gateways > thresholds.profile_slab_mb * 1.5:
            out.append(
                "Consolidate to one multiplexed gateway if that is not enabled "
                f"yet — it removes about {thresholds.profile_slab_mb:.0f} MB per "
                "profile."
            )
    if binding.name == BOUND_STORAGE:
        out.append(
            "Free space on the data volume first — rotated logs, retired "
            "tables (zz_migrated_*), bridge-session rebind backups, and "
            "deploy backups all grow without bound. Deleting rows from a "
            "SQLite database does not shrink its file; a VACUUM does."
        )
    if binding.name == BOUND_CPU:
        out.append(
            "If the load is pollers, spread or lengthen their intervals; if "
            "it is conversations, a bigger tier adds cores — and noisy "
            "neighbours on the same box show up here too."
        )
    if binding.hardware_helps and binding.name != BOUND_STORAGE:
        # The sizing basis is memory-shaped; for a full disk the advice is
        # cleanup, not a bigger instance.
        out.append(_tier_advice(indicators, thresholds))
    if binding.name == BOUND_SESSIONS:
        out.append(
            "Or reduce concurrency deliberately: lowering "
            "`max_concurrent_sessions` in config.yaml refuses new sessions with "
            "a clear message instead of slowing everyone down. Reported, never "
            "applied automatically — serving fewer people is the owner's call."
        )
    return out


# ── Rendering ────────────────────────────────────────────────────────────────


def _fmt_optional_gb(mb: Optional[float]) -> str:
    return "unknown" if mb is None else f"{mb / 1024.0:.1f} GB"


def summary_line(verdict: CapacityVerdict) -> str:
    """The single line for `hermes status` and the digest."""
    ind = verdict.indicators
    sessions = f"{ind.sessions.active_total}"
    if ind.sessions.cap_box_wide:
        sessions += f" / ~{ind.sessions.cap_box_wide}"
    memory = _fmt_optional_gb(ind.memory.available_mb)
    if ind.memory.total_mb:
        memory += f" free of {_fmt_optional_gb(ind.memory.total_mb)}"
    disk = (
        f"disk {ind.storage.pct:.0%} used"
        if ind.storage.pct is not None
        else "disk unknown"
    )
    cpu = (
        f"load {ind.cpu.load1:.1f}/{ind.cpu.cpus} cpu"
        if ind.cpu.measured
        else "cpu load unknown"
    )
    waits = (
        "no write-lock waits"
        if ind.contention.available and ind.contention.events == 0
        else f"{ind.contention.per_hour:.1f} write-lock waits/h"
        if ind.contention.available
        else "write-lock waits unknown"
    )
    return f"Active conversations {sessions} · memory {memory} · {disk} · {cpu} · {waits}"


def digest_lines(verdict: CapacityVerdict) -> List[str]:
    """Plain-text lines for the FG-29 weekly digest."""
    lines = [summary_line(verdict), verdict.headline()]
    lines.extend(f"  {rec}" for rec in verdict.recommendations)
    if verdict.indicators.unavailable:
        lines.append(
            "  Not measured: " + ", ".join(sorted(verdict.indicators.unavailable))
        )
    return lines


def as_dict(verdict: CapacityVerdict) -> Dict[str, Any]:
    """JSON shape for the agent-home card (D20) and the API."""
    ind = verdict.indicators
    return {
        "state": verdict.state,
        "headline": verdict.headline(),
        "summary": summary_line(verdict),
        "binding_constraint": None
        if verdict.binding is None
        else {
            "name": verdict.binding.name,
            "reason": verdict.binding.reason,
            "hardware_helps": verdict.binding.hardware_helps,
        },
        "bounds": [
            {
                "name": bound.name,
                "state": bound.state,
                "reason": bound.reason,
                "hardware_helps": bound.hardware_helps,
            }
            for bound in verdict.bounds
        ],
        "recommendations": list(verdict.recommendations),
        "indicators": {
            "active_conversations": ind.sessions.active_total,
            "per_profile": dict(ind.sessions.per_profile),
            "cap_here": ind.sessions.cap_here,
            "cap_box_wide": ind.sessions.cap_box_wide,
            "available_mb": ind.memory.available_mb,
            "total_mb": ind.memory.total_mb,
            "hermes_rss_mb": ind.memory.hermes_rss_mb,
            "by_process": dict(ind.memory.by_process),
            "write_lock_waits_per_hour": ind.contention.per_hour
            if ind.contention.available
            else None,
            "write_lock_waited_s": ind.contention.waited_s
            if ind.contention.available
            else None,
            "turn_p50_s": ind.latency.p50_s,
            "turn_p95_s": ind.latency.p95_s,
            "turn_samples": ind.latency.samples,
            "disk_used_mb": ind.storage.used_mb,
            "disk_total_mb": ind.storage.total_mb,
            "disk_pct": ind.storage.pct,
            "disk_path": ind.storage.path,
            "cpu_load1": ind.cpu.load1,
            "cpu_count": ind.cpu.cpus,
            "cpu_percent": ind.cpu.percent,
            "profile_count": ind.profile_count,
        },
        "unavailable": sorted(ind.unavailable),
        "collected_at": ind.collected_at,
    }


def headroom(
    config: Optional[Dict[str, Any]] = None,
    *,
    idle_profiles: Optional[Sequence[str]] = None,
    now: Optional[float] = None,
) -> CapacityVerdict:
    """Collect and judge in one call — what every surface uses."""
    thresholds = CapacityThresholds.from_config(config)
    indicators = collect_indicators(config, thresholds=thresholds, now=now)
    return derive_verdict(
        indicators, thresholds, config=config, idle_profiles=idle_profiles
    )
