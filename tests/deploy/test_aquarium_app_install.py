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
import sys
import tempfile
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


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


@needs_visudo
def test_quota_policy_is_world_readable_but_secrets_are_not(tmp_path):
    root = tmp_path / "root"
    assert _install(root).returncode == 0
    etc = root / "etc/aquarium"
    assert _mode(etc) == 0o711  # anyone may open a known name, nobody may list
    assert _mode(etc / "apps") == 0o700
    policy = etc / "app-quotas.yaml"
    assert policy.read_bytes() == (REPO / "deploy/install/app-quotas.yaml.example").read_bytes()
    assert _mode(policy) == 0o644
    assert _mode(etc / "apps.conf") == 0o644


@needs_visudo
def test_rerun_fixes_modes_on_a_box_installed_before_without_touching_secrets(tmp_path):
    root = tmp_path / "root"
    etc = root / "etc/aquarium"
    (etc / "apps/demo").mkdir(parents=True)
    etc.chmod(0o700)
    files = {
        "app-quotas.yaml": ("per_member:\n  apps_running: 1\n", 0o600),
        "app-limits.json": ('{"roles": {}}\n', 0o600),
        "agent-home.env": ("SECRET=x\n", 0o600),
        "apps-db-prod.env": ("PASSWORD=x\n", 0o600),
        "apps/demo/db-prod-rw.dsn": ("postgres://x\n", 0o600),
    }
    for name, (body, mode) in files.items():
        (etc / name).write_text(body)
        (etc / name).chmod(mode)
    proc = _install(root)
    assert proc.returncode == 0, proc.stderr
    assert "readable by every user" not in proc.stderr
    assert _mode(etc) == 0o711
    assert _mode(etc / "apps") == 0o700
    for name in ("app-quotas.yaml", "app-limits.json"):
        assert _mode(etc / name) == 0o644, name
    for name, (body, mode) in files.items():
        assert (etc / name).read_text() == body, name  # an owner's policy edits are kept
        if name.endswith((".env", ".dsn")):
            assert _mode(etc / name) == 0o600, name


@needs_visudo
def test_rerun_warns_about_a_world_readable_secret_and_leaves_it(tmp_path):
    root = tmp_path / "root"
    (root / "etc/aquarium").mkdir(parents=True)
    leaked = root / "etc/aquarium/offsite.env"
    leaked.write_text("KEY=x\n")
    leaked.chmod(0o644)
    proc = _install(root)
    assert proc.returncode == 0, proc.stderr
    assert f"{leaked} is readable by every user" in proc.stderr
    assert _mode(leaked) == 0o644


def _sudo_ok() -> bool:
    if VISUDO is None or not shutil.which("sudo") or os.name != "posix":
        return False
    return subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0


_READ_AS_NOBODY = r"""
import json, os, sys
from pathlib import Path
from hermes_cli import app_quota
etc = Path(sys.argv[1])
os.setgroups([]); os.setgid(65534); os.setuid(65534)
policy = app_quota.load_policy(etc / "app-quotas.yaml", limits_path=etc / "app-limits.json")
out = {"source": policy.source, "warnings": list(policy.warnings),
       "member": app_quota.effective_limits("member", policy=policy).per_member,
       "admin": app_quota.effective_limits("admin", policy=policy).per_member}
for key, probe in (("secret", lambda: (etc / "agent-home.env").read_text()),
                   ("listing", lambda: os.listdir(etc)), ("apps", lambda: os.listdir(etc / "apps"))):
    try:
        probe()
        out[key] = "readable"
    except PermissionError:
        out[key] = "denied"
print(json.dumps(out))
"""


@pytest.mark.skipif(not _sudo_ok(), reason="needs passwordless sudo and visudo")
def test_a_non_root_process_reads_the_installed_policy_and_settings_but_no_secret():
    root = Path(tempfile.mkdtemp(prefix="aq-quota-", dir="/var/tmp"))
    root.chmod(0o755)
    etc = root / "etc/aquarium"
    try:
        install = subprocess.run(
            ["sudo", "-n", "env", f"AQ_ROOTFS={root}", "AQ_CODE_OWNER=0:0", f"PATH={os.environ['PATH']}",
             "bash", "-c", f'set -euo pipefail; . "{LIB}"; aq_install_app_runtime "{REPO}" /srv/hermes-home'],
            capture_output=True, text=True)
        assert install.returncode == 0, install.stderr
        writes = {"app-quotas.yaml": ("per_member:\n  apps_running: 1\n", "644"),
                  "app-limits.json": ('{"roles": {"admin": {"per_member": {"apps_running": 7}}}}\n', "644"),
                  "agent-home.env": ("SECRET=x\n", "600")}
        for name, (body, mode) in writes.items():
            subprocess.run(["sudo", "-n", "sh", "-c", f'cat > "$1" && chmod {mode} "$1"', "sh", str(etc / name)],
                           input=body, text=True, check=True)
        proc = subprocess.run(["sudo", "-n", "env", f"PYTHONPATH={REPO}", sys.executable, "-c",
                               _READ_AS_NOBODY, str(etc)], capture_output=True, text=True, cwd="/")
        assert proc.returncode == 0, proc.stderr
        seen = json.loads(proc.stdout.strip().splitlines()[-1])
        assert seen["warnings"] == []
        assert seen["member"]["apps_running"] == 1  # from app-quotas.yaml
        assert seen["admin"]["apps_running"] == 7  # from Settings -> App limits
        assert (seen["secret"], seen["listing"], seen["apps"]) == ("denied", "denied", "denied")
    finally:
        subprocess.run(["sudo", "-n", "rm", "-rf", str(root)], check=False)


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
