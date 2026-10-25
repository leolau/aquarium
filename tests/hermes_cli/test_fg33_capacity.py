"""FG-33 P8-2 2.5: local apps in the FG-31 capacity verdict, and the app
runtime's backup coverage (``deploy/aquarium.py`` ``backup_sources``)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest

from hermes_cli import capacity
from hermes_cli.capacity import (
    APPS_BUILD_SLICE,
    APPS_DB_SLICE,
    APPS_PARENT_SLICE,
    APPS_RUN_SLICE,
    BOUND_APPS,
    COMFORTABLE,
    CONSTRAINED,
    WATCH,
    AppsLoad,
    CapacityIndicators,
    MemoryLoad,
    SessionLoad,
    SliceMemory,
    as_dict,
    derive_verdict,
    summary_line,
)

REPO = Path(__file__).resolve().parents[2]

GB = 1024.0


def _apps(*, parent=1.0, run=0.5, build=0.0, db=0.2, free_gb=50.0, floor_mb=2048.0,
          reserved_mb=3072.0, separate=False, total_gb=100.0) -> AppsLoad:
    return AppsLoad(
        installed=True,
        slices={
            APPS_PARENT_SLICE: SliceMemory(parent * GB, 6 * GB),
            APPS_RUN_SLICE: SliceMemory(run * GB, 3 * GB),
            APPS_BUILD_SLICE: SliceMemory(build * GB, 2 * GB),
            APPS_DB_SLICE: SliceMemory(db * GB, 1 * GB),
        },
        instances_running=2,
        reserved_mb=reserved_mb,
        storage_path="/var/lib/aquarium-apps",
        storage_free_mb=None if free_gb is None else free_gb * GB,
        storage_total_mb=total_gb * GB,
        min_free_mb=floor_mb,
        separate_volume=separate,
        disk_used_mb=800.0,
    )


def _indicators(apps: AppsLoad, *, available_mb=12 * GB) -> CapacityIndicators:
    return CapacityIndicators(
        sessions=SessionLoad(active_total=0, cap_box_wide=None, cap_here=None),
        memory=MemoryLoad(available_mb=available_mb, total_mb=32 * GB),
        apps=apps,
    )


def _apps_bound(verdict):
    return next(b for b in verdict.bounds if b.name == BOUND_APPS)


def test_a_box_without_the_app_runtime_reports_nothing_about_local_apps():
    ind = _indicators(AppsLoad())
    verdict = derive_verdict(ind)
    assert all(b.name != BOUND_APPS for b in verdict.bounds)
    assert "local apps" not in summary_line(verdict)
    assert as_dict(verdict)["indicators"]["apps"] is None
    assert "app storage" not in ind.unavailable


def test_quiet_apps_are_comfortable_and_do_not_bind():
    verdict = derive_verdict(_indicators(_apps()))
    bound = _apps_bound(verdict)
    assert bound.state == COMFORTABLE
    assert "2 instance(s) running" in bound.reason
    assert "local apps 1.0 GB of 6.0 GB" in summary_line(verdict)


def test_running_apps_at_their_slice_cap_make_local_apps_the_binding_constraint():
    verdict = derive_verdict(_indicators(_apps(parent=3.2, run=2.9)))
    assert verdict.state == CONSTRAINED
    assert verdict.binding.name == BOUND_APPS
    assert "aquarium-apps.slice" in verdict.binding.reason
    assert any("hermes tool stop" in r for r in verdict.recommendations)
    # Local apps have their own kernel caps: no generic "bigger instance" advice.
    assert not any("tier" in r.lower() for r in verdict.recommendations)


def test_the_apps_database_containers_near_their_1gb_cap_are_watched():
    bound = _apps_bound(derive_verdict(_indicators(_apps(db=0.85))))
    assert bound.state == WATCH
    assert "apps database" in bound.reason and APPS_DB_SLICE in bound.reason


def test_the_parent_slice_against_the_6gb_ceiling_binds_even_if_children_are_fine():
    bound = _apps_bound(derive_verdict(_indicators(_apps(parent=5.9, run=2.0, db=0.5))))
    assert bound.state == CONSTRAINED
    assert APPS_PARENT_SLICE in bound.reason


def test_a_build_filling_its_slot_is_the_slot_working_not_a_capacity_problem():
    bound = _apps_bound(derive_verdict(_indicators(_apps(build=2.0))))
    assert bound.state == COMFORTABLE


def test_the_box_under_the_admission_reserve_says_starts_are_refused():
    bound = _apps_bound(derive_verdict(_indicators(_apps(), available_mb=2.5 * GB)))
    assert bound.state in (WATCH, CONSTRAINED)
    assert "reserve" in bound.reason and "refused" in bound.reason


def test_storage_location_under_its_free_floor_refuses_builds():
    verdict = derive_verdict(_indicators(_apps(free_gb=1.5)))
    bound = _apps_bound(verdict)
    assert bound.state == CONSTRAINED
    assert "/var/lib/aquarium-apps" in bound.reason and "builds are refused" in bound.reason
    assert verdict.binding.name == BOUND_APPS
    assert any("storage location" in r for r in verdict.recommendations)


def test_a_separate_app_volume_is_watched_by_percentage_too():
    shared = _apps_bound(derive_verdict(_indicators(_apps(free_gb=12.0, total_gb=100.0))))
    separate = _apps_bound(
        derive_verdict(_indicators(_apps(free_gb=12.0, total_gb=100.0, separate=True)))
    )
    assert shared.state == COMFORTABLE
    assert separate.state in (WATCH, CONSTRAINED)


def test_unmeasured_slices_are_not_read_as_empty():
    apps = _apps()
    apps.slices = {name: SliceMemory(None, sl.cap_mb) for name, sl in apps.slices.items()}
    apps.storage_free_mb = None
    ind = _indicators(apps)
    payload = as_dict(derive_verdict(ind))["indicators"]["apps"]
    assert payload["apps_rss_bytes"] is None
    assert payload["slices"][APPS_RUN_SLICE] == {"current_mb": None, "cap_mb": 3 * GB}


def test_api_payload_carries_apps_rss_and_disk_bytes():
    payload = as_dict(derive_verdict(_indicators(_apps(run=0.5))))["indicators"]["apps"]
    assert payload["apps_rss_bytes"] == 512 * 1048576
    assert payload["apps_disk_bytes"] == 800 * 1048576
    assert payload["slices"][APPS_DB_SLICE]["cap_mb"] == 1024.0
    json.dumps(payload)


# --- collection ------------------------------------------------------------

def _fake_systemctl(monkeypatch, show_stdout: str, units_stdout: str = ""):
    calls = []

    def run(cmd, *a, **k):
        calls.append(cmd)
        out = show_stdout if cmd[1] == "show" else units_stdout
        return subprocess.CompletedProcess(cmd, 0, stdout=out, stderr="")

    monkeypatch.setattr(capacity.shutil, "which", lambda name: "/bin/" + name)
    monkeypatch.setattr(capacity.subprocess, "run", run)
    return calls


SHOW_INSTALLED = (
    "Id=aquarium.slice\nLoadState=loaded\nFragmentPath=/etc/systemd/system/aquarium.slice\n"
    "MemoryCurrent=2147483648\nMemoryMax=6442450944\n\n"
    "Id=aquarium-apps.slice\nLoadState=loaded\nFragmentPath=/etc/systemd/system/aquarium-apps.slice\n"
    "MemoryCurrent=1073741824\nMemoryMax=3221225472\n\n"
    "Id=aquarium-build.slice\nLoadState=loaded\nFragmentPath=/x\n"
    "MemoryCurrent=[not set]\nMemoryMax=infinity\n\n"
    "Id=aquarium-db.slice\nLoadState=not-found\nFragmentPath=\nMemoryCurrent=[not set]\nMemoryMax=infinity\n"
)


def test_collection_reads_slices_the_helper_storage_base_and_running_instances(
    tmp_path, monkeypatch
):
    base = tmp_path / "apps"
    tools = tmp_path / "tools"
    (tools / "demo").mkdir(parents=True)
    (tools / "demo" / "page.tsx").write_bytes(b"x" * 8192)
    conf = tmp_path / "apps.conf"
    conf.write_text(json.dumps(
        {"storage_base": str(base), "min_free_mb": 4096, "tools_root": str(tools)}
    ))
    monkeypatch.setattr(capacity, "APPS_HELPER_CONF", conf)
    capacity._apps_disk_cache.clear()
    _fake_systemctl(
        monkeypatch, SHOW_INSTALLED,
        "aquarium-app@demo-prod.service loaded active running x\n"
        "aquarium-app@demo-dev.service loaded active running x\n",
    )

    load = capacity.collect_apps_load(storage_path=str(tmp_path))

    assert load.installed
    assert load.slice(APPS_PARENT_SLICE).current_mb == 2048.0
    assert load.slice(APPS_RUN_SLICE).cap_mb == 3072.0
    assert load.apps_rss_bytes == 1073741824
    # "infinity" falls back to the designed cap; "[not set]" on a loaded slice is idle.
    assert load.slice(APPS_BUILD_SLICE) == SliceMemory(0.0, 2048.0)
    # A slice that is not installed is unknown, not empty.
    assert load.slice(APPS_DB_SLICE).current_mb is None
    assert load.instances_running == 2
    assert load.storage_path == str(base)
    assert load.min_free_mb == 4096.0
    # The base does not exist yet: free space is read where it will be created.
    assert load.storage_free_mb is not None and not load.separate_volume
    assert load.apps_disk_bytes and load.apps_disk_bytes >= 8192


def test_a_synthesised_slice_without_a_unit_file_is_not_an_installed_runtime(monkeypatch):
    _fake_systemctl(
        monkeypatch,
        "Id=aquarium.slice\nLoadState=loaded\nFragmentPath=\nMemoryCurrent=[not set]\n",
    )
    assert capacity.collect_apps_load().installed is False


def test_no_systemctl_means_no_runtime_and_no_error(monkeypatch):
    monkeypatch.setattr(capacity.shutil, "which", lambda name: None)
    assert capacity.collect_apps_load() == AppsLoad()


def test_the_disk_walk_is_cached_hourly_and_gives_up_past_its_budget(tmp_path):
    capacity._apps_disk_cache.clear()
    (tmp_path / "a").write_bytes(b"x" * 4096)
    first = capacity._apps_disk_mb([tmp_path], now=1000.0)
    (tmp_path / "b").write_bytes(b"x" * 1048576)
    assert capacity._apps_disk_mb([tmp_path], now=1000.0 + 60) == first
    assert capacity._apps_disk_mb([tmp_path], now=1000.0 + 3601) > first
    assert capacity._tree_mb([tmp_path], budget_s=-1.0) is None


def test_an_installed_runtime_with_unreadable_storage_is_flagged_unavailable(monkeypatch):
    apps = _apps(free_gb=None)
    monkeypatch.setattr(capacity, "collect_apps_load", lambda **kw: apps)
    ind = capacity.collect_indicators({})
    assert "app storage" in ind.unavailable


# --- backup coverage (deploy/aquarium.py) ----------------------------------

def _load_aquarium():
    spec = importlib.util.spec_from_file_location("aquarium_cli_fg33", REPO / "deploy" / "aquarium.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def aq(tmp_path, monkeypatch):
    monkeypatch.setenv("AQUARIUM_TEST_PREFIX", str(tmp_path))
    mod = _load_aquarium()
    monkeypatch.setattr(mod, "service_units", lambda: ["hermes-gateway.service"])
    monkeypatch.setattr(mod, "bridge_units", lambda: [])
    monkeypatch.setattr(mod, "unit_env_files", lambda unit: [])
    monkeypatch.setattr(mod, "hermes_homes", lambda cfg: ["/opt/data/hermes"])
    return mod


def _touch(root: Path, path: str, text: str = "x") -> None:
    target = root / path.lstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def test_backup_covers_the_app_caddy_include_templates_slices_and_sudoers(aq, tmp_path):
    for path in (
        "/etc/caddy/Caddyfile",
        "/etc/caddy/apps.d/demo.caddy",
        "/etc/systemd/system/hermes-gateway.service",
        "/etc/systemd/system/aquarium-app@.service",
        "/etc/systemd/system/aquarium-app-build@.service",
        "/etc/systemd/system/aquarium.slice",
        "/etc/systemd/system/aquarium-apps.slice",
        "/etc/systemd/system/aquarium-db.slice",
        "/etc/systemd/system/aquarium-app@demo-prod.service.d/10-release.conf",
        "/etc/sudoers.d/aquarium-apps",
        "/opt/data/hermes/tools/demo/.git/HEAD",
        "/var/lib/aquarium-apps/demo/releases/1/server.js",
    ):
        _touch(tmp_path, path)
    cfg = {"DATA_ROOT": "/opt/data", "SUPABASE_DIR": "/opt/supabase"}

    sources = aq.backup_sources(cfg)

    assert "/etc/caddy/apps.d" in sources
    for unit in ("aquarium-app@.service", "aquarium-app-build@.service", "aquarium.slice",
                 "aquarium-apps.slice", "aquarium-db.slice"):
        assert f"/etc/systemd/system/{unit}" in sources
    assert "/etc/sudoers.d/aquarium-apps" in sources
    # Per-instance drop-ins are helper-derived state; releases are rebuilt.
    assert not any("aquarium-app@demo-prod" in s for s in sources)
    assert not any(s.startswith("/var/lib/aquarium-apps") for s in sources)


def test_backup_without_any_app_runtime_is_unchanged(aq, tmp_path):
    _touch(tmp_path, "/etc/caddy/Caddyfile")
    sources = aq.backup_sources({"DATA_ROOT": "/opt/data", "SUPABASE_DIR": "/opt/supabase"})
    assert sources == ["/etc/caddy/Caddyfile"]


def test_app_build_output_is_skipped_but_app_source_history_is_kept(aq, tmp_path):
    app = tmp_path / "tools" / "demo"
    for rel in (".git/HEAD", "app/page.tsx", ".next/cache/x", "node_modules/next/index.js"):
        _touch(app, rel)
    names = {p.relative_to(app).as_posix() for p in aq.iter_tree(app) if p != app}
    assert ".git/HEAD" in names and "app/page.tsx" in names
    assert not any(n.startswith((".next", "node_modules")) for n in names)
