"""deploy/hermes-tools-exec: agent terminal commands run as their own user.

Real path when the machine allows it (passwordless sudo, as on the Devin VM and
CI runners): the reviewed helper and sudoers rule are installed for real, and a
command started by `hermes` runs as `hermes-tools`, keeps the environment it was
handed, and cannot read the gateway's /proc/<pid>/environ or hermes's home.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy/hermes-tools-exec"
RULE = REPO / "deploy/sudoers.d/hermes-tools"


def test_helper_refuses_the_wrong_user_and_arguments():
    out = subprocess.run(["bash", str(HELPER), "bash", "-c", "true"], capture_output=True, text=True)
    assert out.returncode == 2 and "must run as hermes-tools" in out.stderr


def test_rule_switches_to_hermes_tools_never_root():
    text = RULE.read_text()
    assert "hermes ALL=(hermes-tools) NOPASSWD:SETENV: /usr/local/sbin/hermes-tools-exec" in text
    assert "(root)" not in text


def test_installer_and_deploy_ship_it():
    install = (REPO / "install-aquarium.sh").read_text()
    assert "useradd --system --create-home --home-dir /home/hermes-tools" in install
    assert "bash deploy/hermes-tools-setup" in install
    setup = (REPO / "deploy/hermes-tools-setup").read_text()
    assert 'deploy/hermes-tools-exec" /usr/local/sbin/hermes-tools-exec' in setup
    assert 'visudo -cf "$REPO/deploy/sudoers.d/hermes-tools"' in setup
    assert "TOOLS HELPER STALE" in (REPO / "deploy/hermes-deploy.sh").read_text()


def _sudo_ok() -> bool:
    return shutil.which("sudo") is not None and subprocess.run(
        ["sudo", "-n", "true"], capture_output=True
    ).returncode == 0


@pytest.mark.skipif(not _sudo_ok(), reason="needs passwordless sudo to install the helper")
def test_command_runs_as_hermes_tools_and_cannot_read_the_gateway():
    setup = (
        "id hermes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hermes "
        "--shell /usr/sbin/nologin hermes; "
        "id hermes-tools >/dev/null 2>&1 || useradd --system --create-home --home-dir "
        "/home/hermes-tools --shell /usr/sbin/nologin hermes-tools; "
        "chmod 700 /home/hermes; "
        f"install -m 0755 -o root -g root {HELPER} /usr/local/sbin/hermes-tools-exec; "
        f"visudo -cf {RULE} >/dev/null; "
        f"install -m 0440 -o root -g root {RULE} /etc/sudoers.d/hermes-tools"
    )
    subprocess.run(["sudo", "-n", "bash", "-c", setup], check=True)
    inner = (
        'id -un; echo "env=$PASSED"; '
        'cat /proc/$PPID/environ >/dev/null 2>&1 && echo parent-readable || echo parent-blocked; '
        'ls /home/hermes >/dev/null 2>&1 && echo home-readable || echo home-blocked'
    )
    out = subprocess.run(
        ["sudo", "-n", "-u", "hermes", "env", "PASSED=kept", "bash", "-c",
         f"cd /tmp && sudo -n -E -u hermes-tools /usr/local/sbin/hermes-tools-exec bash -c '{inner}'"],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    assert out == ["hermes-tools", "env=kept", "parent-blocked", "home-blocked"]


def test_rule_keeps_path_and_process_group():
    text = RULE.read_text()
    assert "Defaults!/usr/local/sbin/hermes-tools-exec !use_pty, !secure_path" in text
    deploy = (REPO / "deploy/hermes-deploy.sh").read_text()
    assert "TOOLS SUDOERS RULE STALE" in deploy
    assert "usermod -aG hermes-tools hermes" in (REPO / "deploy/hermes-tools-setup").read_text()
