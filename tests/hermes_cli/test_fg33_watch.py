"""FG-33 P8-2 item 2.4: the apps watch timer, owner/box alerts and lifecycle clocks.

The watch pass is driven with fake registries and a fake runtime at the
``AppRuntime`` seam (no root helpers); the owner notification path is checked
end to end against a throwaway Postgres with the real ``NotificationStore``.
"""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli import app_watch as aw
from hermes_cli.access import Principal

REPO = Path(__file__).resolve().parents[2]
DAY = aw.DAY
T0 = 1_800_000_000.0
OWNER = Principal(user_id="root", display="Root", role="owner")


# ── the lifecycle state machine ──────────────────────────────────────────────

def _step(state, now, *, mode="prod", since=T0, last_visit=None, notice_at=None, running=False):
    return aw.lifecycle_step(state, mode=mode, now=now, since=since, last_visit=last_visit,
                             notice_at=notice_at, running=running)


def test_active_goes_idle_only_after_14_days_without_a_visit():
    assert _step("active", T0 + 13.9 * DAY) == ("active", None)
    assert _step("active", T0 + 14 * DAY) == ("idle", None)
    # A visit restarts the clock.
    assert _step("active", T0 + 20 * DAY, last_visit=T0 + 10 * DAY) == ("active", None)


@pytest.mark.parametrize("mode,days", [("prod", 30), ("dev", 7)])
def test_idle_stops_after_its_mode_timer_and_never_without_72h_notice(mode, days):
    due = T0 + days * DAY
    assert _step("idle", due - 3.1 * DAY, mode=mode) == ("idle", None)
    assert _step("idle", due - 3 * DAY, mode=mode) == ("idle", "notice")
    # The notice went out late: the stop still waits a full 72 h after it.
    late = due + 5 * DAY
    assert _step("idle", late + 2.9 * DAY, mode=mode, notice_at=late) == ("idle", None)
    assert _step("idle", late + 3 * DAY, mode=mode, notice_at=late) == ("stopped", "stop")
    # On time: stop exactly at the due date.
    assert _step("idle", due, mode=mode, notice_at=due - 3 * DAY) == ("stopped", "stop")


def test_a_visit_or_a_running_instance_wakes_the_app():
    assert _step("idle", T0 + 2 * DAY, last_visit=T0 + DAY) == ("active", "wake")
    assert _step("stopped", T0 + DAY, running=True) == ("active", "wake")


def test_stopped_archives_after_90_days_and_archived_or_purged_never_move():
    assert _step("stopped", T0 + 89 * DAY) == ("stopped", None)
    assert _step("stopped", T0 + 90 * DAY) == ("archived", "archive")
    for state in ("archived", "purged"):
        assert _step(state, T0 + 1000 * DAY, running=True, last_visit=T0 + 999 * DAY) == (state, None)


@pytest.mark.parametrize("doc,code,expected", [
    ({"active_state": "active"}, 200, ("ok", False)),
    ({"active_state": "active"}, 503, ("degraded", True)),
    ({"active_state": "active"}, None, ("down", True)),
    ({"active_state": "failed"}, None, ("down", True)),
    ({"active_state": "inactive", "enabled": True}, None, ("down", True)),
    # A dev instance the helper idle-stopped is not broken.
    ({"active_state": "inactive", "enabled": False}, None, ("unknown", False)),
    (None, None, ("unknown", False)),
])
def test_probe_verdict(doc, code, expected):
    assert aw.probe_verdict(doc, code) == expected


def test_established_counts_only_open_connections_to_the_port(tmp_path):
    table = tmp_path / "tcp"
    table.write_text(
        "  sl  local_address rem_address   st\n"
        "   0: 0100007F:1195 0100007F:A000 01 x\n"   # 4501, ESTABLISHED
        "   1: 0100007F:1195 0100007F:A001 06 x\n"   # 4501, TIME_WAIT
        "   2: 0100007F:10CD 0100007F:A002 01 x\n"   # 4301
        "   3: 00000000:1195 00000000:0000 0A x\n"   # LISTEN
    )
    assert aw.established(4501, [str(table)]) == 1
    assert aw.established(4999, [str(table), str(tmp_path / "missing")]) == 0


def test_box_alerts_fire_once_per_episode(tmp_path):
    path = tmp_path / "state.json"
    with aw.WatchState(path) as st:
        assert st.box_episodes({"capacity": "constrained"}, T0) == ["constrained"]
    with aw.WatchState(path) as st:
        assert st.box_episodes({"capacity": "constrained"}, T0 + 300) == []
    with aw.WatchState(path) as st:
        assert st.box_episodes({}, T0 + 600) == []
    with aw.WatchState(path) as st:
        assert st.box_episodes({"capacity": "constrained"}, T0 + 900) == ["constrained"]
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


# ── a watch pass against fakes ───────────────────────────────────────────────

class MemStore:
    def __init__(self):
        self.rows: dict = {}
        self.writes = 0

    async def initialize(self):
        pass

    async def get_runtime(self, tool_id):
        return dict(self.rows[tool_id]) if tool_id in self.rows else None

    async def set_runtime(self, tool_id, **fields):
        self.writes += 1
        self.rows.setdefault(tool_id, {}).update(fields)
        return self.rows[tool_id]

    async def get_database(self, tool_id, mode):
        return None


class Reg:
    def __init__(self, mode, tools):
        self.mode, self.tools, self.store = mode, tools, None

    async def list_for_principal(self, principal):
        assert principal is OWNER
        return list(self.tools)


class Runtime:
    def __init__(self, instances):
        self.instances = instances
        self.calls: list = []

    async def _call(self, verb, **spec):
        self.calls.append((verb, spec))
        return {"instances": self.instances} if verb == "status" else {}

    def repo_for(self, tool):
        return Path("/nonexistent-fg33")


def _tool(name, owner="alice"):
    return SimpleNamespace(id=f"t-{name}", name=name, hosting="local", owner_user_id=owner,
                           mcp_endpoint_ref=None, status="enabled", release_sha="abc1234")


def _doc(name, mode="prod", state="active", port=4301):
    return {"slug": name, "mode": mode, "active_state": state, "port": port,
            "base_path": f"/apps/{name}", "memory_bytes": 4096, "enabled": mode == "prod"}


@pytest.fixture
def harness(tmp_path, monkeypatch):
    store = MemStore()
    monkeypatch.setattr(aw, "_store_for", lambda registry: store)
    sent = {"owner": [], "box": []}

    async def owner(user_id, title, body, key):
        sent["owner"].append((user_id, key))

    def run(registries, runtime, now, *, code=None, visits=0, cap=None, dry_run=False):
        return asyncio.run(aw.watch_once(
            registries, owner=OWNER, runtime=runtime, notify_owner=owner,
            notify_box=lambda text: sent["box"].append(text),
            state=aw.WatchState(tmp_path / "state.json"), now=now,
            capacity_state=lambda: cap, health=lambda port, base: code,
            visits=lambda port: visits, dry_run=dry_run,
        ))

    return SimpleNamespace(store=store, sent=sent, run=run, state=tmp_path / "state.json")


def test_broken_app_alerts_its_owner_once_after_three_failures(harness):
    regs = {"prod": Reg("prod", [_tool("notes")])}
    runtime = Runtime([_doc("notes")])
    for i in range(5):
        harness.run(regs, runtime, T0 + i * 300, code=None)
    row = harness.store.rows["t-notes"]
    assert (row["health"], row["consecutive_failures"], row["rss_bytes"]) == ("down", 5, 4096)
    assert harness.sent["owner"] == [("alice", "app-down:notes")]
    harness.run(regs, runtime, T0 + 1800, code=200)
    assert harness.store.rows["t-notes"]["consecutive_failures"] == 0
    assert harness.store.rows["t-notes"]["health"] == "ok"
    for i in range(3):  # a new episode is a new alert (the store dedupes a pending one)
        harness.run(regs, runtime, T0 + 2100 + i * 300, code=None)
    assert harness.sent["owner"] == [("alice", "app-down:notes")] * 2


def test_idle_dev_instance_is_not_a_failure(harness):
    regs = {"dev": Reg("dev", [_tool("notes")])}
    runtime = Runtime([{**_doc("notes", "dev", "inactive", 4501), "enabled": False}])
    for i in range(4):
        harness.run(regs, runtime, T0 + i * 300)
    assert harness.store.rows["t-notes"]["health"] == "unknown"
    assert harness.sent["owner"] == [] and harness.sent["box"] == []


def test_box_alerts_for_many_down_crash_loops_and_capacity_are_sent_once(harness):
    names = ["a1", "a2", "a3", "a4"]
    regs = {"prod": Reg("prod", [_tool(n) for n in names])}
    runtime = Runtime([_doc(n) for n in names[:3]] + [_doc("a4", state="failed")])
    harness.run(regs, runtime, T0, code=None, cap="constrained")
    box = harness.sent["box"]
    assert len(box) == 3
    assert any("4 instances are down" in t for t in box)
    assert any("a4 (prod) is crash-looping" in t for t in box)
    assert any("constrained" in t for t in box)
    harness.run(regs, runtime, T0 + 300, code=None, cap="constrained")
    assert len(harness.sent["box"]) == 3
    harness.run(regs, Runtime([_doc(n) for n in names]), T0 + 600, code=200, cap="comfortable")
    harness.run(regs, runtime, T0 + 900, code=None, cap="comfortable")
    assert len(harness.sent["box"]) == 5  # the two app episodes started again


def test_helper_outage_is_one_box_alert_and_no_app_writes(harness):
    from hermes_cli.app_runtime import HelperError

    class Broken(Runtime):
        async def _call(self, verb, **spec):
            raise HelperError("aquarium-app-helper status failed: not installed")

    regs = {"prod": Reg("prod", [_tool("notes")])}
    report = harness.run(regs, Broken([]), T0)
    harness.run(regs, Broken([]), T0 + 300)
    assert "not installed" in report["error"]
    assert len(harness.sent["box"]) == 1 and harness.store.writes == 0


def test_lifecycle_with_a_clock_override_stops_after_notice(harness, monkeypatch):
    regs = {"dev": Reg("dev", [_tool("notes")])}
    up = Runtime([_doc("notes", "dev", port=4501)])
    harness.run(regs, up, T0, code=200)
    harness.run(regs, up, T0 + 14 * DAY, code=200)
    assert harness.store.rows["t-notes"]["lifecycle_state"] == "idle"
    harness.run(regs, up, T0 + 18 * DAY, code=200)            # due at 21 d: notice now
    assert harness.sent["owner"] == [("alice", "app-idle:notes:dev")]
    harness.run(regs, up, T0 + 20 * DAY, code=200)
    assert harness.store.rows["t-notes"]["lifecycle_state"] == "idle"
    assert ("stop", {"slug": "notes", "mode": "dev"}) not in up.calls
    harness.run(regs, up, T0 + 21 * DAY, code=200)
    row = harness.store.rows["t-notes"]
    assert (row["lifecycle_state"], row["runtime_state"]) == ("stopped", "stopped")
    assert ("stop", {"slug": "notes", "mode": "dev"}) in up.calls
    assert len(harness.sent["owner"]) == 1

    archived = []

    async def fake_archive(runtime, registry, principal, name, *, state=None, reason="owner"):
        archived.append((principal.user_id, name, reason))
        return {}

    monkeypatch.setattr(aw, "archive_app", fake_archive)
    down = Runtime([_doc("notes", "dev", "inactive", 4501)])
    harness.run(regs, down, T0 + 110 * DAY)
    assert archived == []
    harness.run(regs, down, T0 + 111 * DAY)
    assert archived == [("root", "notes", "watch")]


def test_a_visit_wakes_an_idle_app(harness):
    regs = {"prod": Reg("prod", [_tool("notes")])}
    up = Runtime([_doc("notes")])
    harness.run(regs, up, T0, code=200)
    harness.run(regs, up, T0 + 15 * DAY, code=200)
    assert harness.store.rows["t-notes"]["lifecycle_state"] == "idle"
    harness.run(regs, up, T0 + 16 * DAY, code=200, visits=1)
    assert harness.store.rows["t-notes"]["lifecycle_state"] == "active"


def test_dry_run_writes_nothing_and_alerts_no_one(harness):
    regs = {"prod": Reg("prod", [_tool("notes")])}
    runtime = Runtime([_doc("notes")])
    for i in range(4):
        report = harness.run(regs, runtime, T0 + i * 300, code=None, cap="constrained", dry_run=True)
    assert harness.store.writes == 0 and not harness.state.exists()
    assert harness.sent == {"owner": [], "box": []}
    assert report["box_alerts"] and [c for c in runtime.calls if c[0] != "status"] == []


# ── owner notification end to end (throwaway Postgres) ───────────────────────

from tests.hermes_cli.test_fg33_local_e2e import _config, _fetch, _reset, postgres_dsn  # noqa: E402,F401


@pytest.mark.asyncio
async def test_owner_alert_is_one_deduped_notification(postgres_dsn, tmp_path, monkeypatch):
    from hermes_cli.human_comms import NOTIFICATIONS_TABLE

    await _reset(postgres_dsn)
    cfg = _config(postgres_dsn)
    store = MemStore()
    monkeypatch.setattr(aw, "_store_for", lambda registry: store)
    notify = aw.notification_owner_notifier(cfg)
    regs = {"prod": Reg("prod", [_tool("notes")])}
    runtime = Runtime([_doc("notes")])
    for i in range(9):
        if i == 5:  # recovers once, then a second episode while the first is still pending
            code = 200
        else:
            code = None
        await aw.watch_once(regs, owner=OWNER, runtime=runtime, notify_owner=notify,
                            notify_box=lambda text: None, state=aw.WatchState(tmp_path / "s.json"),
                            now=T0 + i * 300, health=lambda p, b, c=code: c, visits=lambda p: 0)
    rows = await _fetch(postgres_dsn,
                        f"SELECT owner_user_id, kind, status, visibility FROM app_prod.{NOTIFICATIONS_TABLE} "
                        "WHERE dedupe_key = 'app-down:notes'")
    assert [tuple(r) for r in rows] == [("alice", "proactive_ask", "pending", "private:alice")]


# ── the drift-check hook and the Telegram helper move ────────────────────────

def _fake_hermes(tmp_path, payload, code=0):
    script = tmp_path / "hermes"
    script.write_text(f"#!/bin/sh\necho '{json.dumps(payload)}'\nexit {code}\n")
    script.chmod(0o755)
    return script


def test_tool_doctor_problems_are_drift_and_a_clean_doctor_is_silent(tmp_path):
    import scripts.check_runtime_drift as drift

    orphan = {"ok": False, "problems": [{"kind": "orphan_database", "db_name": "lapp_x_dev",
                                         "mode": "dev"}]}
    findings = drift.check_apps(_fake_hermes(tmp_path, orphan))
    assert [(f["severity"], f["component"]) for f in findings] == [("drift", "apps:orphan_database")]
    assert "lapp_x_dev" in findings[0]["actual"]
    assert drift.check_apps(_fake_hermes(tmp_path, {"ok": True, "problems": []})) == []
    broken = drift.check_apps(_fake_hermes(tmp_path, {}, code=1))
    assert [f["severity"] for f in broken] == ["note"]


def test_drift_main_runs_the_doctor_only_where_apps_are_installed(tmp_path, monkeypatch):
    import scripts.check_runtime_drift as drift

    pyproject = REPO / "pyproject.toml"
    monkeypatch.setattr(drift, "collect", lambda path: [])
    calls = []
    monkeypatch.setattr(drift, "check_apps", lambda: calls.append(1) or [
        {"severity": "drift", "component": "apps:orphan_instance", "expected": "x",
         "actual": "y", "detail": "z"}])
    sent = []
    monkeypatch.setattr(drift, "notify", lambda text: sent.append(text))
    monkeypatch.setattr(drift, "APP_HELPER", tmp_path / "absent")
    assert drift.main(["--notify", "--pyproject", str(pyproject)]) == 0 and calls == []
    monkeypatch.setattr(drift, "APP_HELPER", Path(sys.executable))
    assert drift.main(["--notify", "--pyproject", str(pyproject)]) == 1
    assert calls == [1] and sent and "orphan_instance" in sent[0]
    assert drift.main(["--no-tool-doctor", "--pyproject", str(pyproject)]) == 0


def test_telegram_helper_lives_in_scripts_lib_and_drift_delegates(monkeypatch):
    lib = aw.load_notify_lib()
    import scripts.check_runtime_drift as drift

    for key in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL", "TELEGRAM_ALLOWED_USERS",
                "TELEGRAM_CRON_THREAD_ID", "TELEGRAM_HOME_CHANNEL_THREAD_ID"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "-100")
    assert lib.telegram_target() == drift._telegram_target() == ("t", "-100", "")
    assert "def notify" not in (REPO / "scripts/check_runtime_drift.py").read_text().split(
        "def _notify_lib")[0]
    sent = []
    monkeypatch.setattr(lib, "urlopen", lambda req, timeout: sent.append(req) or _Ok())
    assert aw.telegram_box_notifier("3 apps down") is True
    assert json.loads(sent[0].data)["text"] == "3 apps down"


class _Ok:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return b'{"ok": true}'


# ── units ────────────────────────────────────────────────────────────────────

def test_watch_units_are_a_five_minute_oneshot_outside_the_deploy_glob():
    timer = (REPO / "deploy/aquarium-apps-watch.timer").read_text()
    service = (REPO / "deploy/aquarium-apps-watch.service").read_text()
    assert "OnUnitActiveSec=5min" in timer and "Unit=aquarium-apps-watch.service" in timer
    assert "Type=oneshot" in service and "User=hermes" in service
    assert not any(line.strip() == "[Install]" for line in service.splitlines())
    assert "-m hermes_cli.app_watch" in service
    # sudo to the root helpers needs setuid, so the unit must not set NoNewPrivileges.
    assert "NoNewPrivileges=yes" not in service.split("[Service]")[1]
    deploy = (REPO / "deploy/hermes-deploy.sh").read_text()
    assert "aquarium-apps-watch" not in deploy
    assert os.path.basename("aquarium-apps-watch.service").startswith("aquarium-")
