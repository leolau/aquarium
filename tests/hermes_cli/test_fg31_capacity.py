"""FG-31 — capacity headroom: the verdict, the bound it names, and the reading.

The behaviours under test are the ones a wrong implementation gets *plausibly*
wrong: a box-wide count that silently reports only this profile, a verdict that
does not say which bound produced it, and — the load-bearing one — a
``constrained`` caused by SQLite's single writer recommending a bigger box, which
would be money spent for no change.
"""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

import pytest

from hermes_cli import active_sessions, capacity
from hermes_cli.capacity import (
    BOUND_CPU,
    BOUND_LATENCY,
    BOUND_MEMORY,
    BOUND_SESSIONS,
    BOUND_STORAGE,
    BOUND_WRITE_LOCK,
    COMFORTABLE,
    CONSTRAINED,
    WATCH,
    CapacityIndicators,
    CapacityThresholds,
    CpuLoad,
    MemoryLoad,
    SessionLoad,
    StorageLoad,
    TurnLatency,
    WriteContention,
    derive_verdict,
)


# ── Thresholds come from config.yaml, never the environment ──────────────────


def test_thresholds_read_config_and_reject_nonsense(caplog):
    thresholds = CapacityThresholds.from_config(
        {"capacity": {"watch_p95_s": 5, "constrained_p95_s": "12.5"}}
    )
    assert thresholds.watch_p95_s == 5.0
    assert thresholds.constrained_p95_s == 12.5
    # Untouched keys keep their conservative defaults.
    assert thresholds.watch_session_ratio == CapacityThresholds().watch_session_ratio

    bad = CapacityThresholds.from_config({"capacity": {"watch_p95_s": "soon"}})
    assert bad.watch_p95_s == CapacityThresholds().watch_p95_s
    assert CapacityThresholds.from_config(None) == CapacityThresholds()
    assert CapacityThresholds.from_config({"capacity": "on"}) == CapacityThresholds()


def test_no_capacity_env_vars_are_introduced(monkeypatch):
    """A behavioural threshold set in the environment must not take effect."""
    monkeypatch.setenv("HERMES_CAPACITY_WATCH_P95_S", "0.001")
    assert CapacityThresholds.from_config({}).watch_p95_s == 25.0


# ── The verdict, and the bound it names ─────────────────────────────────────


def _indicators(
    *,
    active=0,
    cap=None,
    available_mb=8192.0,
    waits=0.0,
    p95=1.0,
    profiles=1,
    disk_pct=None,
    load_ratio=None,
) -> CapacityIndicators:
    return CapacityIndicators(
        sessions=SessionLoad(
            active_total=active, cap_box_wide=cap, cap_here=cap, profiles_seen=profiles
        ),
        memory=MemoryLoad(available_mb=available_mb, total_mb=16384.0),
        contention=WriteContention(events=waits, waited_s=waits * 0.1, window_s=3600.0),
        latency=TurnLatency(samples=100, p50_s=1.0, p95_s=p95),
        storage=(
            StorageLoad(used_mb=disk_pct * 40960.0, total_mb=40960.0, path="/data")
            if disk_pct is not None
            else StorageLoad()
        ),
        cpu=(
            CpuLoad(load1=load_ratio * 4.0, cpus=4, percent=load_ratio * 100.0)
            if load_ratio is not None
            else CpuLoad()
        ),
        profile_count=profiles,
    )


def test_idle_box_is_comfortable_and_recommends_nothing():
    verdict = derive_verdict(_indicators(active=1, cap=15))
    assert verdict.state == COMFORTABLE
    assert verdict.recommendations == []
    assert "comfortable" in verdict.headline()


@pytest.mark.parametrize(
    "active,expected",
    [(1, COMFORTABLE), (9, WATCH), (13, CONSTRAINED)],
)
def test_session_verdict_transitions_at_the_configured_thresholds(active, expected):
    verdict = derive_verdict(_indicators(active=active, cap=15))
    assert verdict.state == expected
    if expected != COMFORTABLE:
        assert verdict.binding is not None
        assert verdict.binding.name == BOUND_SESSIONS
        # The count and the cap are in the reason, not just a percentage.
        assert f"{active} of 15" in verdict.binding.reason


def test_a_verdict_always_names_its_binding_constraint():
    verdict = derive_verdict(_indicators(active=14, cap=15, available_mb=200.0))
    assert verdict.state == CONSTRAINED
    assert verdict.binding is not None
    assert verdict.binding.name in {BOUND_SESSIONS, BOUND_MEMORY}
    assert verdict.binding.name in verdict.headline()


def test_memory_watch_when_one_more_profile_would_not_fit():
    thresholds = CapacityThresholds(profile_slab_mb=150.0, memory_margin_mb=512.0)
    verdict = derive_verdict(_indicators(active=2, cap=15, available_mb=600.0), thresholds)
    assert verdict.state == WATCH
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_MEMORY
    # Names the driver, so the owner knows what to reduce.
    assert "concurrent conversation" in verdict.binding.reason


def test_the_more_pressed_bound_is_the_one_named_when_two_are_close():
    # Both bounds land on `watch`; sessions is further along its own scale.
    thresholds = CapacityThresholds(profile_slab_mb=150.0, memory_margin_mb=512.0)
    verdict = derive_verdict(
        _indicators(active=12, cap=15, available_mb=660.0), thresholds
    )
    assert verdict.state == WATCH
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_SESSIONS


def test_latency_alone_can_produce_a_verdict():
    verdict = derive_verdict(_indicators(active=1, cap=15, p95=90.0))
    assert verdict.state == CONSTRAINED
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_LATENCY


# ── Disk and CPU bounds ──────────────────────────────────────────────────────


def test_disk_verdict_transitions_at_the_configured_thresholds():
    assert derive_verdict(_indicators(active=1, cap=15, disk_pct=0.5)).state == COMFORTABLE
    watch = derive_verdict(_indicators(active=1, cap=15, disk_pct=0.85))
    assert watch.state == WATCH
    assert watch.binding is not None and watch.binding.name == BOUND_STORAGE
    full = derive_verdict(_indicators(active=1, cap=15, disk_pct=0.95))
    assert full.state == CONSTRAINED
    assert full.binding is not None and full.binding.name == BOUND_STORAGE
    # A full disk is named with where, and the advice is cleanup not hardware.
    assert "/data" in full.binding.reason
    joined = " ".join(full.recommendations)
    assert "data volume" in joined
    assert "next tier" not in joined


def test_sustained_cpu_saturation_binds_but_a_quiet_box_does_not():
    quiet = derive_verdict(_indicators(active=1, cap=15, load_ratio=0.3))
    assert quiet.state == COMFORTABLE
    saturated = derive_verdict(_indicators(active=1, cap=15, load_ratio=2.5))
    assert saturated.state == CONSTRAINED
    assert saturated.binding is not None and saturated.binding.name == BOUND_CPU
    assert "load 10.0 on 4" in saturated.binding.reason


def test_unmeasured_disk_and_cpu_do_not_bind_or_report_zero():
    indicators = _indicators(active=1, cap=15)
    verdict = derive_verdict(indicators)
    assert verdict.state == COMFORTABLE
    payload = capacity.as_dict(verdict)
    assert payload["indicators"]["disk_pct"] is None
    assert payload["indicators"]["cpu_load1"] is None


def test_as_dict_carries_the_new_indicators():
    payload = capacity.as_dict(
        derive_verdict(_indicators(active=1, cap=15, disk_pct=0.4, load_ratio=0.5))
    )
    ind = payload["indicators"]
    assert ind["disk_pct"] == pytest.approx(0.4)
    assert ind["disk_path"] == "/data"
    assert ind["cpu_load1"] == pytest.approx(2.0)
    assert ind["cpu_count"] == 4


# ── The bound hardware cannot fix ───────────────────────────────────────────


def test_write_lock_constrained_recommends_runtime_work_not_hardware():
    verdict = derive_verdict(_indicators(active=2, cap=15, waits=120.0))
    assert verdict.state == CONSTRAINED
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_WRITE_LOCK
    assert verdict.binding.hardware_helps is False
    joined = " ".join(verdict.recommendations)
    assert "bigger box does not fix this" in joined
    # No tier advice at all: the upgrade cannot move this bound.
    assert "next tier" not in joined


def test_a_bound_hardware_cannot_fix_wins_a_tie_against_one_it_can():
    # Sessions and write-lock waits both reach `constrained`.
    verdict = derive_verdict(_indicators(active=15, cap=15, waits=200.0))
    assert verdict.state == CONSTRAINED
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_WRITE_LOCK


def test_hardware_advice_states_its_measured_basis():
    verdict = derive_verdict(_indicators(active=13, cap=15, available_mb=8192.0))
    joined = " ".join(verdict.recommendations)
    assert "13 concurrent conversation(s)" in joined
    # The per-conversation cost is a measurement now (hermes-systest,
    # 2026-08-16), and the advice says which — an unattributed number is the
    # one a reader cannot check.
    assert "measured (hermes-systest" in joined
    assert "still an estimate" not in joined


def test_idle_profiles_are_recommended_before_hardware():
    verdict = derive_verdict(
        _indicators(active=13, cap=15, profiles=3),
        idle_profiles=["hr", "finance"],
    )
    assert verdict.recommendations, "a constrained box must say something"
    assert verdict.recommendations[0].startswith("Retire idle profiles")
    assert "hr, finance" in verdict.recommendations[0]


def test_constrained_reports_and_never_lowers_the_cap():
    """The open question, answered: report-only."""
    before = _indicators(active=15, cap=15)
    verdict = derive_verdict(before)
    assert verdict.state == CONSTRAINED
    assert verdict.indicators.sessions.cap_here == 15
    assert any("owner's call" in rec for rec in verdict.recommendations)


def test_an_unmeasurable_indicator_is_not_a_measured_zero():
    indicators = _indicators(active=1, cap=15)
    indicators.memory = MemoryLoad()
    indicators.contention = WriteContention(available=False)
    indicators.latency = TurnLatency()
    verdict = derive_verdict(indicators)
    assert verdict.state == COMFORTABLE
    names = {bound.name for bound in verdict.bounds}
    assert names == {BOUND_SESSIONS}
    payload = capacity.as_dict(verdict)
    assert payload["indicators"]["available_mb"] is None
    assert payload["indicators"]["write_lock_waits_per_hour"] is None


# ── Box-wide accounting across profiles ─────────────────────────────────────


def _write_registry(home: Path, count: int, cap: int | None) -> None:
    (home / "runtime").mkdir(parents=True, exist_ok=True)
    entries = [
        {
            "session_id": f"{home.name}-{i}",
            "surface": "gateway:telegram",
            "pid": os.getpid(),
            "started_at": time.time(),
        }
        for i in range(count)
    ]
    active_sessions._write_entries(home / "runtime" / "active_sessions.json", entries)
    config = {} if cap is None else {"max_concurrent_sessions": cap}
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")


def test_active_sessions_are_summed_across_profiles_under_one_gateway(
    tmp_path, monkeypatch
):
    """The registry is profile-local; the RAM it protects is not.

    Three profiles at 6 live conversations each would each report `6 / 15` while
    the box actually carries 18 — the reading that matters is the sum.
    """
    default_home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    _write_registry(default_home, 6, 15)
    for name in ("hr", "finance"):
        _write_registry(default_home / "profiles" / name, 6, 15)

    load = capacity.collect_session_load({"max_concurrent_sessions": 15})
    assert load.active_total == 18
    assert load.per_profile == {"default": 6, "finance": 6, "hr": 6}
    assert load.profiles_seen == 3
    assert load.cap_here == 15
    # What the box can be *asked* to hold: 3 profiles × 15.
    assert load.cap_box_wide == 45


def test_an_uncapped_profile_makes_the_box_cap_unknown_not_understated(
    tmp_path, monkeypatch
):
    default_home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    _write_registry(default_home, 2, 15)
    _write_registry(default_home / "profiles" / "hr", 3, None)

    load = capacity.collect_session_load({"max_concurrent_sessions": 15})
    assert load.active_total == 5
    assert load.cap_box_wide is None
    assert load.ratio is None
    # And a ratio-less reading cannot invent a session verdict.
    verdict = derive_verdict(CapacityIndicators(sessions=load))
    assert BOUND_SESSIONS not in {bound.name for bound in verdict.bounds}


def test_reading_another_profiles_registry_prunes_dead_leases_without_writing(
    tmp_path, monkeypatch
):
    home = tmp_path / "other"
    _write_registry(home, 1, 5)
    path = home / "runtime" / "active_sessions.json"
    entries = json.loads(path.read_text(encoding="utf-8"))["entries"]
    entries.append(
        {
            "session_id": "dead",
            "surface": "cli",
            "pid": 99999999,
            "started_at": time.time(),
        }
    )
    active_sessions._write_entries(path, entries)
    monkeypatch.setattr("gateway.status._pid_exists", lambda pid: int(pid) != 99999999)
    before = path.read_bytes()

    live = active_sessions.read_registry_for_home(home)

    assert [entry["session_id"] for entry in live] == ["other-0"]
    # The owner reclaims its own file; a reader must not take its lock.
    assert path.read_bytes() == before


# ── Real write-lock contention, measured through SQLite ─────────────────────


def _session_db(tmp_path, monkeypatch):
    from hermes_state import SessionDB

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    return SessionDB(db_path=tmp_path / "state.db")


def test_an_idle_database_records_no_write_lock_waits(tmp_path, monkeypatch):
    db = _session_db(tmp_path, monkeypatch)
    try:
        for i in range(20):
            db.set_meta(f"k{i}", "v")
        totals = db.read_write_contention()
        assert totals["events"] == 0.0
        assert totals["waited_s"] == 0.0
    finally:
        db.close()


def test_two_writers_contending_are_counted_and_timed(tmp_path, monkeypatch):
    """Real contention, not a simulated one: a second connection holds the
    WAL write lock while ``SessionDB`` tries to write."""
    db = _session_db(tmp_path, monkeypatch)
    holder = sqlite3.connect(
        str(tmp_path / "state.db"), isolation_level=None, check_same_thread=False
    )
    released = threading.Event()
    try:
        holder.execute("BEGIN IMMEDIATE")
        holder.execute(
            "INSERT INTO state_meta (key, value) VALUES ('held', '1') "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )

        def _release():
            # Held long enough to force real retries, well inside the retry
            # budget (15 attempts × 20-150 ms) so the write still succeeds.
            time.sleep(0.5)
            holder.commit()
            released.set()

        thread = threading.Thread(target=_release, daemon=True)
        thread.start()
        db.set_meta("contended", "yes")  # must wait, retry, then succeed
        thread.join(timeout=10)
        assert released.is_set()

        totals = db.read_write_contention()
        assert totals["events"] >= 1, "a real wait must be counted"
        assert totals["waited_s"] > 0.0, "the wait must be timed, not just counted"
        assert totals["exhausted"] == 0.0
        assert db.get_meta("contended") == "yes"
    finally:
        holder.close()
        db.close()


def test_contention_totals_ignore_buckets_outside_the_window(tmp_path, monkeypatch):
    from hermes_state import SessionDB

    db = _session_db(tmp_path, monkeypatch)
    try:
        now = time.time()
        old_bucket = str(int((now - 300000) // SessionDB._CONTENTION_BUCKET_S))
        new_bucket = str(int(now // SessionDB._CONTENTION_BUCKET_S))
        db.set_meta(
            SessionDB._CONTENTION_META_KEY,
            json.dumps(
                {
                    "buckets": {
                        old_bucket: {"events": 99, "waited_s": 9.9, "exhausted": 1},
                        new_bucket: {"events": 3, "waited_s": 0.3, "exhausted": 0},
                        "not-a-bucket": {"events": 5},
                    }
                }
            ),
        )
        totals = db.read_write_contention(window_s=3600.0, now=now)
        assert totals["events"] == 3.0
        assert round(totals["waited_s"], 3) == 0.3
    finally:
        db.close()


def test_contention_rate_is_per_hour_over_the_window():
    contention = WriteContention(events=48.0, window_s=86400.0)
    assert round(contention.per_hour, 2) == 2.0


# ── Turn latency, derived from the transcript ──────────────────────────────


def test_turn_latency_pairs_a_reply_with_the_message_that_asked_for_it(
    tmp_path, monkeypatch
):
    db = _session_db(tmp_path, monkeypatch)
    try:
        base = time.time()
        db.create_session("s1", "Test")
        # Two turns: 2s and 30s. The trailing assistant row has no user before
        # it in the same session, so it must not become a sample.
        db.append_message("s1", "user", "a", timestamp=base)
        db.append_message("s1", "assistant", "b", timestamp=base + 2)
        db.append_message("s1", "user", "c", timestamp=base + 10)
        db.append_message("s1", "assistant", "d", timestamp=base + 40)
        db.append_message("s1", "assistant", "e", timestamp=base + 41)

        samples = db.recent_turn_latencies_s(window_s=3600.0, now=base + 60)
        assert sorted(samples) == [2.0, 30.0]
        assert capacity._percentile(sorted(samples), 0.50) == 2.0
        assert capacity._percentile(sorted(samples), 0.95) == 30.0
    finally:
        db.close()


def test_turn_latency_ignores_samples_outside_the_window(tmp_path, monkeypatch):
    db = _session_db(tmp_path, monkeypatch)
    try:
        now = time.time()
        db.create_session("s1", "Test")
        db.append_message("s1", "user", "old", timestamp=now - 100000)
        db.append_message("s1", "assistant", "old", timestamp=now - 99000)
        db.append_message("s1", "user", "new", timestamp=now - 10)
        db.append_message("s1", "assistant", "new", timestamp=now - 5)
        assert db.recent_turn_latencies_s(window_s=3600.0, now=now) == [5.0]
    finally:
        db.close()


def test_percentiles_of_an_empty_sample_are_unknown():
    assert capacity._percentile([], 0.5) is None
    assert capacity._percentile([4.0], 0.95) == 4.0


# ── Cost of collection ─────────────────────────────────────────────────────


def test_collection_is_cheap_enough_to_run_on_demand(tmp_path, monkeypatch):
    """Runs on every `hermes status` and in the digest, so it must not be a
    monitoring sweep: a handful of small reads, well under a second."""
    default_home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    _write_registry(default_home, 3, 15)
    _write_registry(default_home / "profiles" / "hr", 2, 15)

    started = time.monotonic()
    indicators = capacity.collect_indicators({"max_concurrent_sessions": 15})
    elapsed = time.monotonic() - started

    assert indicators.sessions.active_total == 5
    assert indicators.profile_count == 2
    assert elapsed < 5.0, f"collection took {elapsed:.2f}s"


# ── Rendering contracts the surfaces depend on ─────────────────────────────


def test_summary_line_reports_unknowns_as_unknown():
    indicators = _indicators(active=2, cap=15)
    indicators.memory = MemoryLoad()
    indicators.contention = WriteContention(available=False)
    line = capacity.summary_line(derive_verdict(indicators))
    assert "memory unknown" in line
    assert "write-lock waits unknown" in line


def test_digest_lines_lead_with_the_reading_then_the_verdict():
    verdict = derive_verdict(_indicators(active=14, cap=15))
    lines = capacity.digest_lines(verdict)
    assert lines[0].startswith("Active conversations 14 / ~15")
    assert lines[1].startswith("Headroom: constrained")
    assert any("max_concurrent_sessions" in line for line in lines[2:])


def test_as_dict_carries_the_binding_constraint_and_its_fixability():
    payload = capacity.as_dict(derive_verdict(_indicators(active=2, cap=15, waits=200.0)))
    assert payload["state"] == CONSTRAINED
    assert payload["binding_constraint"]["name"] == BOUND_WRITE_LOCK
    assert payload["binding_constraint"]["hardware_helps"] is False
    assert payload["indicators"]["cap_box_wide"] == 15
    assert payload["recommendations"]


# ── Latency is what a person waited for, over a sample big enough to judge ──
#
# Both behaviours below come from the live systest box (2026-08-16), where the
# verdict read `constrained — turn latency, p95 1195.8s over 3 turn(s)` with
# zero conversations running and 9.1 GB free. All three "turns" were scheduled
# jobs, and the 20-minute one was a job waiting for the previous job.


def test_a_scheduled_job_is_not_a_reply_someone_waited_for(tmp_path, monkeypatch):
    db = _session_db(tmp_path, monkeypatch)
    try:
        base = time.time()
        # The live box, reproduced: three cron runs, one of them 20 minutes,
        # and one real conversation.
        db.create_session("cron_142a6b4e9532_20260816", "cron")
        db.append_message("cron_142a6b4e9532_20260816", "user", "job", timestamp=base)
        db.append_message(
            "cron_142a6b4e9532_20260816", "assistant", "", timestamp=base + 1195.8
        )
        db.create_session("cron_a012c36564c5_20260816", "cron")
        db.append_message("cron_a012c36564c5_20260816", "user", "job", timestamp=base)
        db.append_message(
            "cron_a012c36564c5_20260816", "assistant", "", timestamp=base + 2.7
        )
        # A run whose row carries no source (the `unknown` default): the id
        # convention is the only thing left to exclude it by.
        db.create_session("cron_a7436d0c8f14_20260816", "unknown")
        db.append_message("cron_a7436d0c8f14_20260816", "user", "job", timestamp=base)
        db.append_message(
            "cron_a7436d0c8f14_20260816", "assistant", "", timestamp=base + 600.0
        )
        # A backgrounded to-do run: /start returns at once, so nobody is
        # waiting on this turn either.
        db.create_session("todo-9", "todo")
        db.append_message("todo-9", "user", "do the thing", timestamp=base)
        db.append_message("todo-9", "assistant", "", timestamp=base + 420.0)
        db.create_session("home-1", "agent_home")
        db.append_message("home-1", "user", "hello", timestamp=base)
        db.append_message("home-1", "assistant", "hi", timestamp=base + 6.5)

        samples = db.recent_turn_latencies_s(window_s=3600.0, now=base + 1300)

        assert samples == [6.5], "only the human turn is reply latency"
    finally:
        db.close()


def test_seeded_origins_are_all_classified():
    """Every ``spawn_seeded_session`` caller's origin must be classified.

    A seeded session's ``origin`` becomes the agent's ``platform`` and so the
    session's ``source``, which is what the latency filter reads. A new seeded
    caller that nobody classifies silently puts a machine's runtime back into
    the owner's reply latency — the live 2026-08-16 reading, one call site
    later.
    """
    import re
    from pathlib import Path

    from hermes_state import NON_INTERACTIVE_SESSION_SOURCES

    root = Path(__file__).resolve().parents[2]
    found: set[str] = set()
    for path in root.rglob("*.py"):
        parts = set(path.parts)
        if parts & {".venv", "venv", "tests", "node_modules", "site-packages"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for call in re.findall(r"spawn_seeded_session\(\s*(.*?)\n\s*\)", text, re.S):
            found.update(re.findall(r"origin=\"([^\"]+)\"", call))

    assert found, "no spawn_seeded_session call sites found — the scan broke"
    assert found <= set(NON_INTERACTIVE_SESSION_SOURCES), (
        f"unclassified seeded origin(s): {sorted(found - set(NON_INTERACTIVE_SESSION_SOURCES))}"
    )


def test_latency_cannot_bind_the_verdict_on_a_handful_of_turns():
    thresholds = CapacityThresholds()
    indicators = _indicators(active=1, cap=15)
    indicators.latency = TurnLatency(samples=3, p50_s=6.7, p95_s=1195.8)

    verdict = derive_verdict(indicators, thresholds)

    assert verdict.state == COMFORTABLE, "3 turns cannot condemn an idle box"
    assert all(bound.name != BOUND_LATENCY for bound in verdict.bounds)

    # The reading is still reported — as a sample too small to judge, not as a
    # measured zero, and not silently dropped.
    indicators.unavailable.append("turn latency (only 3 interactive turn(s))")
    payload = capacity.as_dict(derive_verdict(indicators, thresholds))
    assert payload["indicators"]["turn_p95_s"] == 1195.8
    assert payload["indicators"]["turn_samples"] == 3
    assert any("turn latency" in name for name in payload["unavailable"])


def test_a_representative_sample_still_binds():
    thresholds = CapacityThresholds()
    indicators = _indicators(active=1, cap=15)
    indicators.latency = TurnLatency(
        samples=int(thresholds.min_latency_samples), p50_s=40.0, p95_s=1195.8
    )

    verdict = derive_verdict(indicators, thresholds)

    assert verdict.state == CONSTRAINED
    assert verdict.binding is not None
    assert verdict.binding.name == BOUND_LATENCY


def test_a_small_sample_is_named_as_unjudged_by_collection(tmp_path, monkeypatch):
    default_home = tmp_path / ".hermes"
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    _write_registry(default_home, 1, 15)
    monkeypatch.setattr(
        capacity,
        "collect_turn_latency",
        lambda thresholds, now=None: TurnLatency(samples=1, p50_s=50.0, p95_s=50.0),
    )
    # Disk/CPU read the real machine — a loaded dev box would bind the verdict
    # for reasons unrelated to what this test checks.
    monkeypatch.setattr(capacity, "collect_storage_load", lambda: StorageLoad())
    monkeypatch.setattr(capacity, "collect_cpu_load", lambda: CpuLoad())

    indicators = capacity.collect_indicators({"max_concurrent_sessions": 15})

    assert any("turn latency" in name for name in indicators.unavailable)
    assert any(
        "1 interactive" in name and "8 needed" in name
        for name in indicators.unavailable
    ), indicators.unavailable
    assert derive_verdict(indicators).state != CONSTRAINED


def test_the_minimum_sample_size_is_a_config_setting():
    thresholds = CapacityThresholds.from_config({"capacity": {"min_latency_samples": 2}})
    latency = TurnLatency(samples=2, p50_s=90.0, p95_s=90.0)
    assert latency.representative(thresholds)
    assert not latency.representative(CapacityThresholds())


# ── CPU utilization history ──────────────────────────────────────────────────


def _seed_history(path, now, entries):
    """``entries``: (age_seconds, pct) pairs written as individual samples."""
    for age_s, pct in entries:
        capacity.record_cpu_sample(pct, 0.5, now=now - age_s, path=path)


def test_history_is_empty_until_the_sampler_has_written(tmp_path):
    assert capacity.cpu_history(path=tmp_path / "capacity.db") == {
        "hourly": [],
        "max_24h": None,
        "max_7d": None,
        "max_30d": None,
    }


def test_hourly_buckets_hold_one_point_per_hour(tmp_path):
    # Mid-hour, so the samples a few minutes back stay in the current hour.
    now = (time.time() // 3600) * 3600 + 1800
    path = tmp_path / "capacity.db"
    # Three samples in the current hour, one in the hour two hours ago.
    _seed_history(
        path, now, [(60, 10.0), (120, 30.0), (180, 50.0), (2 * 3600 + 60, 70.0)]
    )
    history = capacity.cpu_history(now=now, path=path)
    assert len(history["hourly"]) == 24
    current = history["hourly"][-1]
    assert current["avg_pct"] == 30.0  # mean of the hour's samples
    assert current["max_pct"] == 50.0
    assert history["hourly"][-3]["max_pct"] == 70.0
    # Untouched buckets are null, not a fake zero.
    assert all(
        p["avg_pct"] is None
        for p in history["hourly"][:-3]
    )


def test_window_maxima_report_the_busiest_sampled_minute(tmp_path):
    now = time.time()
    path = tmp_path / "capacity.db"
    _seed_history(
        path,
        now,
        [
            (3600, 40.0),
            (2 * 86400, 65.0),
            (15 * 86400, 92.0),
            (32 * 86400, 99.0),  # pruned / outside every window
        ],
    )
    history = capacity.cpu_history(now=now, path=path)
    assert history["max_24h"] == 40.0
    assert history["max_7d"] == 65.0
    assert history["max_30d"] == 92.0


def test_samples_older_than_the_retention_window_are_pruned(tmp_path):
    now = time.time()
    path = tmp_path / "capacity.db"
    # A backdated row is kept when inserted (its own write prunes nothing
    # older than itself) but is pruned by the next fresh write.
    capacity.record_cpu_sample(60.0, 0.5, now=now - 32 * 86400, path=path)
    capacity.record_cpu_sample(70.0, 0.5, now=now, path=path)
    conn = sqlite3.connect(str(path))
    try:
        kept = conn.execute("SELECT COUNT(*) FROM cpu_samples").fetchone()[0]
        oldest = conn.execute("SELECT MIN(ts) FROM cpu_samples").fetchone()[0]
    finally:
        conn.close()
    assert kept == 1
    assert oldest >= now - capacity.CPU_HISTORY_KEEP_S
