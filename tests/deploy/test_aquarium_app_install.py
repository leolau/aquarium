"""FG-33 P8-1 1.2 install path: ``aq_install_app_runtime`` (deploy/install/lib.sh)
against a temp root, its one call in install-aquarium.sh, and the STALE
warnings deploy/hermes-deploy.sh prints for the app runtime files."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
LIB = REPO / "deploy" / "install" / "lib.sh"
VISUDO = shutil.which("visudo") or ("/usr/sbin/visudo" if Path("/usr/sbin/visudo").exists() else None)
needs_visudo = pytest.mark.skipif(VISUDO is None, reason="visudo not installed")


def _install(root: Path, app: Path = REPO, home: str = "/srv/hermes-home"):
    fake_bin = root / "fakebin"
    fake_bin.mkdir(parents=True, exist_ok=True)
    (fake_bin / "visudo").write_text(f'#!/bin/sh\nexec {VISUDO} "$@"\n')
    (fake_bin / "visudo").chmod(0o755)
    env = {**os.environ, "AQ_ROOTFS": str(root), "AQ_CODE_OWNER": f"{os.getuid()}:{os.getgid()}",
           "PATH": f"{fake_bin}:{os.environ['PATH']}"}
    return subprocess.run(["bash", "-c", f'set -euo pipefail; . "{LIB}"; aq_install_app_runtime "{app}" "{home}"'],
                          capture_output=True, text=True, env=env)


@needs_visudo
def test_installs_every_unit_slice_helper_and_sudoers(tmp_path):
    root = tmp_path / "root"
    (root / "etc/caddy").mkdir(parents=True)
    proc = _install(root)
    assert proc.returncode == 0, proc.stderr
    units = root / "etc/systemd/system"
    for name in ("aquarium.slice", "aquarium-apps.slice", "aquarium-build.slice", "aquarium-db.slice",
                 "aquarium-app@.service", "aquarium-app-build@.service"):
        assert (units / name).read_bytes() == (REPO / "deploy" / name).read_bytes(), name
    helper = root / "usr/local/sbin/aquarium-app-helper"
    assert stat.S_IMODE(helper.stat().st_mode) == 0o755
    assert not (root / "usr/local/sbin/aquarium-app@.service").exists()
    rule = root / "etc/sudoers.d/aquarium-apps"
    assert stat.S_IMODE(rule.stat().st_mode) == 0o440
    assert stat.S_IMODE((root / "etc/aquarium/apps").stat().st_mode) == 0o700
    assert (root / "etc/caddy/apps.d").is_dir()
    conf = json.loads((root / "etc/aquarium/apps.conf").read_text())
    assert conf == {"storage_base": "/var/lib/aquarium-apps", "tools_root": "/srv/hermes-home/tools"}


@needs_visudo
def test_rerun_keeps_the_owners_storage_location(tmp_path):
    root = tmp_path / "root"
    assert _install(root).returncode == 0
    conf = root / "etc/aquarium/apps.conf"
    conf.write_text('{"storage_base": "/mnt/apps"}\n')
    assert _install(root).returncode == 0
    assert json.loads(conf.read_text()) == {"storage_base": "/mnt/apps"}


@needs_visudo
def test_new_units_are_picked_up_by_glob(tmp_path):
    app = tmp_path / "app"
    shutil.copytree(REPO / "deploy", app / "deploy", ignore=shutil.ignore_patterns("__pycache__", "install"))
    (app / "deploy/aquarium-apps-watch.timer").write_text("[Timer]\nOnCalendar=*:0/5\n")
    (app / "deploy/aquarium-app-egress").write_text("#!/bin/sh\n")
    root = tmp_path / "root"
    assert _install(root, app).returncode == 0
    assert (root / "etc/systemd/system/aquarium-apps-watch.timer").is_file()
    assert (root / "usr/local/sbin/aquarium-app-egress").is_file()


@needs_visudo
def test_broken_sudoers_aborts_before_installing(tmp_path):
    app = tmp_path / "app"
    shutil.copytree(REPO / "deploy", app / "deploy", ignore=shutil.ignore_patterns("__pycache__", "install"))
    (app / "deploy/sudoers.d/aquarium-apps").write_text("hermes ALL=(root NOPASSWD /bin/true\n")
    root = tmp_path / "root"
    proc = _install(root, app)
    assert proc.returncode != 0 and "visudo" in proc.stderr
    assert not (root / "usr/local/sbin/aquarium-app-helper").exists()
    assert not (root / "etc/sudoers.d/aquarium-apps").exists()


def test_install_script_calls_it_once():
    text = (REPO / "install-aquarium.sh").read_text()
    assert len(re.findall(r'^aq_install_app_runtime "\$APP" "\$HERMES_HOME_DIR"$', text, re.M)) == 1


def _stale_block() -> str:
    text = (REPO / "deploy/hermes-deploy.sh").read_text()
    match = re.search(r"^# FG-33 local apps: units/slices.*?^fi\n(?=\n)", text, re.S | re.M)
    assert match, "the FG-33 STALE block moved; update this test with it"
    return match.group(0)


def test_deploy_reports_stale_app_runtime_files(tmp_path):
    repo = tmp_path / "repo"
    (repo / "deploy/sudoers.d").mkdir(parents=True)
    for name in ("aquarium.slice", "aquarium-app@.service", "aquarium-app-helper"):
        shutil.copy(REPO / "deploy" / name, repo / "deploy" / name)
    shutil.copy(REPO / "deploy/sudoers.d/aquarium-apps", repo / "deploy/sudoers.d/aquarium-apps")
    sysroot = tmp_path / "sys"
    (sysroot / "units").mkdir(parents=True)
    (sysroot / "sbin").mkdir()
    (sysroot / "sudoers").mkdir()
    shutil.copy(repo / "deploy/aquarium.slice", sysroot / "units/aquarium.slice")
    (sysroot / "units/aquarium-app@.service").write_text("old\n")
    (sysroot / "sbin/aquarium-app-helper").write_text("old\n")
    (sysroot / "sudoers/aquarium-apps").write_text("old\n")
    block = (_stale_block()
             .replace("/etc/systemd/system/", f"{sysroot}/units/")
             .replace("/usr/local/sbin/", f"{sysroot}/sbin/")
             .replace("/etc/sudoers.d/aquarium-apps", f"{sysroot}/sudoers/aquarium-apps"))
    script = f'set -euo pipefail\nREPO="{repo}"\nAFTER=abc123\n{block}\necho done\n'
    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    out = proc.stdout
    assert "APP RUNTIME UNIT STALE" in out and "aquarium-app@.service differs" in out
    assert "aquarium.slice differs" not in out
    assert "APP RUNTIME HELPER STALE" in out and "APPS SUDOERS RULE STALE" in out
    assert out.rstrip().endswith("done")
