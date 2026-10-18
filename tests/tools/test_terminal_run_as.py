"""terminal.run_as: the agent's commands run as their own Linux user.

Real path: a gateway-side Python process runs as ``hermes`` with a temp
HERMES_HOME whose config.yaml sets ``terminal.run_as: hermes-tools``; the local
terminal, background processes and execute_code then start through the
root-owned /usr/local/sbin/hermes-tools-exec. Needs passwordless sudo, the two
users, and a checkout ``hermes`` can read (skipped otherwise).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from tools import terminal_user

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy/hermes-tools-exec"
RULE = REPO / "deploy/sudoers.d/hermes-tools"


def test_unset_setting_keeps_commands_as_the_gateway_user(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert terminal_user.configured_user() == ""
    (tmp_path / "config.yaml").write_text("terminal:\n  run_as: ''\n")
    assert terminal_user.configured_user() == ""


def test_missing_helper_fails_with_a_message_naming_the_setting(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_user, "HELPER", str(tmp_path / "absent"))
    with pytest.raises(terminal_user.RunAsUnavailable, match="terminal.run_as"):
        terminal_user.wrap_bash(["/bin/bash", "-c", "true"], "hermes-tools")


def test_wrap_runs_bash_through_the_helper_never_as_root():
    if not os.path.exists(terminal_user.HELPER) or os.stat(terminal_user.HELPER).st_uid != 0:
        pytest.skip("helper not installed")
    argv = terminal_user.wrap_bash(["/usr/bin/zsh", "-lic", "echo hi"], "hermes-tools")
    assert argv == ["sudo", "-n", "-E", "-u", "hermes-tools", terminal_user.HELPER,
                    "bash", "-lic", "echo hi"]
    assert "root" not in argv


def _sudo_ok() -> bool:
    if sys.platform == "win32" or not shutil.which("sudo"):
        return False
    return subprocess.run(["sudo", "-n", "true"], capture_output=True).returncode == 0


GATEWAY_SCRIPT = r'''
import json, os, time, subprocess
from tools.environments.local import LocalEnvironment
from tools.process_registry import process_registry
out = {}
env = LocalEnvironment(cwd="/tmp", timeout=30)
r = env.execute("id -un; cat /proc/%d/environ >/dev/null 2>&1 && echo gw-env-readable || echo gw-env-blocked; "
                "cat \"$HERMES_HOME/.env\" >/dev/null 2>&1 && echo dotenv-readable || echo dotenv-blocked; "
                "echo path=$PATH" % os.getpid())
out["first"] = r["output"].split()
env.execute("cd /var")
out["cwd"] = env.execute("pwd")["output"].strip()
r = env.execute("sleep 300 & sleep 300", timeout=2)
out["timeout_rc"] = r["returncode"]
time.sleep(1.5)
left = subprocess.run(["pgrep", "-u", "hermes-tools", "-f", "sleep 300"], capture_output=True, text=True)
out["sleeps_left_after_timeout"] = left.stdout.split()
snap = env._snapshot_path
env.cleanup()
out["snapshot_removed"] = not os.path.exists(snap)
s = process_registry.spawn_local("id -un; sleep 300", cwd="/tmp")
time.sleep(1.0)
out["bg_kill"] = process_registry.kill_process(s.id)["status"]
time.sleep(1.0)
left = subprocess.run(["pgrep", "-u", "hermes-tools", "-f", "sleep 300"], capture_output=True, text=True)
out["sleeps_left_after_kill"] = left.stdout.split()
print("RESULT" + json.dumps(out))
'''


@pytest.mark.skipif(not _sudo_ok(), reason="needs passwordless sudo to install the helper")
def test_terminal_and_background_run_as_hermes_tools(tmp_path):
    setup = (
        "id hermes >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/hermes "
        "--shell /usr/sbin/nologin hermes; "
        "id hermes-tools >/dev/null 2>&1 || useradd --system --create-home --home-dir "
        "/home/hermes-tools --shell /usr/sbin/nologin hermes-tools; "
        "usermod -aG hermes-tools hermes; "
        f"install -m 0755 -o root -g root {HELPER} /usr/local/sbin/hermes-tools-exec; "
        f"visudo -cf {RULE} >/dev/null; "
        f"install -m 0440 -o root -g root {RULE} /etc/sudoers.d/hermes-tools"
    )
    subprocess.run(["sudo", "-n", "bash", "-c", setup], check=True)
    python = REPO / ".venv/bin/python"
    if subprocess.run(["sudo", "-n", "-u", "hermes", "test", "-x", str(python)]).returncode:
        pytest.skip("hermes cannot read this checkout")
    home = Path(tempfile.mkdtemp(prefix="hermes-runas-", dir="/tmp"))
    try:
        (home / "config.yaml").write_text("terminal:\n  run_as: hermes-tools\n")
        (home / ".env").write_text("TELEGRAM_BOT_TOKEN=gateway-secret\n")
        subprocess.run(["sudo", "-n", "chown", "-R", "hermes:hermes", str(home)], check=True)
        subprocess.run(["sudo", "-n", "chmod", "700", str(home)], check=True)
        subprocess.run(["sudo", "-n", "chmod", "600", str(home / ".env")], check=True)
        proc = subprocess.run(
            ["sudo", "-n", "-u", "hermes", "env", f"HERMES_HOME={home}",
             "PATH=/opt/custom/bin:/usr/bin:/bin", str(python), "-c", GATEWAY_SCRIPT],
            cwd=REPO, capture_output=True, text=True, timeout=120,
        )
        line = next((x for x in proc.stdout.splitlines() if x.startswith("RESULT")), None)
        assert line, proc.stdout + proc.stderr
        out = json.loads(line[len("RESULT"):])
    finally:
        subprocess.run(["sudo", "-n", "rm", "-rf", str(home)])
    assert out["first"][:3] == ["hermes-tools", "gw-env-blocked", "dotenv-blocked"]
    assert "/opt/custom/bin" in out["first"][3].split("=", 1)[1].split(":")
    assert out["cwd"] == "/var"
    assert out["timeout_rc"] != 0
    assert out["sleeps_left_after_timeout"] == []
    assert out["snapshot_removed"] is True
    assert out["bg_kill"] == "killed"
    assert out["sleeps_left_after_kill"] == []
