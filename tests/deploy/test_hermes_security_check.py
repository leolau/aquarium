"""deploy/hermes-security-check runs as root via sudo with no arguments.

It runs here against a temp world: its fixed paths are rewritten into
tmp_path and its PATH points at fake ``sshd``/``ss``/``ufw``/``dpkg-query``/
``apt-config``/``systemctl``/``aquarium``, so nothing reads the real system."""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy" / "hermes-security-check"

SSHD_WEAK = "port 22\npasswordauthentication yes\nkbdinteractiveauthentication no\npermitrootlogin yes\n"
SSHD_GOOD = "port 22\npasswordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin without-password\n"
SS = (
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))\n'
    'LISTEN 0 128 [::]:443 [::]:* users:(("caddy",pid=2,fd=7))\n'
    'LISTEN 0 128 *:80 *:* users:(("caddy",pid=2,fd=8))\n'
    'LISTEN 0 128 0.0.0.0:9119 0.0.0.0:* users:(("python3",pid=3,fd=5))\n'
    'LISTEN 0 128 0.0.0.0:8000 0.0.0.0:* users:(("docker-proxy",pid=4,fd=4))\n'
    'LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=5,fd=5))\n'
    'LISTEN 0 128 172.17.0.1:3000 0.0.0.0:* users:(("node",pid=6,fd=5))\n'
    'LISTEN 0 128 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=7,fd=5))\n'
)
UFW_ACTIVE = (
    "Status: active\n\nTo                         Action      From\n--                         ------      ----\n"
    "OpenSSH                    ALLOW       Anywhere\n80/tcp                     ALLOW       Anywhere\n"
    "443/tcp                    ALLOW       Anywhere\nOpenSSH (v6)               ALLOW       Anywhere (v6)\n"
)


def _fake(path: Path, body: str) -> None:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)


@pytest.fixture
def world(tmp_path):
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    for sub in ("root/.ssh", "home/leo/.ssh", "ufw-apps", "caddy", "aq"):
        (tmp_path / sub).mkdir(parents=True)
    (tmp_path / "ufw-apps" / "openssh-server").write_text("[OpenSSH]\ntitle=Secure shell\nports=22/tcp\n")
    (tmp_path / "root/.ssh/authorized_keys").write_text(
        "# admin\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFake leo@laptop\n")
    (tmp_path / "home/leo/.ssh/authorized_keys").write_text("not a key\n")
    (tmp_path / "caddy/Caddyfile").write_text(
        "{\n  admin unix//var/lib/caddy/admin.sock\n}\nhome.example.com, www.example.com {\n"
        "  reverse_proxy 127.0.0.1:3100\n}\nhttps://dash.example.com:443 {\n  reverse_proxy 127.0.0.1:9119\n}\n")
    _fake(bin_ / "sshd", f'[ "$1" = "-T" ] || exit 9\ncat "{tmp_path}/sshd.out"\n')
    (tmp_path / "sshd.out").write_text(SSHD_WEAK)
    _fake(bin_ / "ss", f'echo "ss $*" >> "{tmp_path}/calls"\ncat "{tmp_path}/ss.out"\n')
    (tmp_path / "ss.out").write_text(SS)
    _fake(bin_ / "ufw", f'cat "{tmp_path}/ufw.out"\n')
    (tmp_path / "ufw.out").write_text(UFW_ACTIVE)
    _fake(bin_ / "dpkg-query", 'printf "install ok installed"\n')
    _fake(bin_ / "apt-config", 'echo \'APT::Periodic::Update-Package-Lists "1";\'\n'
                               'echo \'APT::Periodic::Unattended-Upgrade "1";\'\n')
    _fake(bin_ / "systemctl", 'echo enabled\n')
    _fake(tmp_path / "aq" / "aquarium",
          f'echo "aquarium $*" >> "{tmp_path}/calls"\necho "noise"\n'
          'echo \'{"rows": [{"status": "ok", "text": "disk /: 50 GB free", "fix": ""},'
          ' {"status": "fail", "text": "service hermes-gateway.service: failed", "fix": "aquarium logs gateway"}],'
          ' "failed": 1, "warned": 0}\'\nexit 1\n')
    text = HELPER.read_text()
    for old, new in {
        'PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"': f'PATH = "{bin_}:/usr/bin:/bin"',
        '"/run/hermes-security-check.lock"': f'"{tmp_path}/lock"',
        '"/usr/sbin/sshd"': f'"{bin_}/sshd"',
        '"/usr/local/sbin/aquarium"': f'"{tmp_path}/aq/aquarium"',
        '"/etc/caddy/Caddyfile"': f'"{tmp_path}/caddy/Caddyfile"',
        '"/etc/aquarium/aquarium.conf"': f'"{tmp_path}/aquarium.conf"',
        '"/etc/ufw/applications.d"': f'"{tmp_path}/ufw-apps"',
        '"/root/.ssh/': f'"{tmp_path}/root/.ssh/',
        '"/home/*/.ssh/': f'"{tmp_path}/home/*/.ssh/',
        "st.st_uid != 0": f"st.st_uid != {os.getuid()}",
    }.items():
        assert old in text, old
        text = text.replace(old, new)
    script = tmp_path / "helper.py"
    script.write_text(text)
    return tmp_path, script


def _run(world, *args):
    _, script = world
    proc = subprocess.run([sys.executable, "-I", str(script), *args], capture_output=True, text=True,
                          env={"PATH": "/usr/bin:/bin"}, timeout=60)
    return proc, (json.loads(proc.stdout) if proc.stdout.strip().startswith("{") else None)


def test_refuses_any_argument(world):
    proc, data = _run(world, "--json")
    assert proc.returncode == 2 and data is None
    assert "takes no arguments" in proc.stderr
    assert not (world[0] / "calls").exists()  # nothing ran


def test_reports_weak_ssh_and_counts_only_real_keys(world):
    proc, data = _run(world)
    assert proc.returncode == 0, proc.stderr
    ssh = data["ssh"]
    assert ssh["password_authentication"] is True and ssh["permit_root_login"] == "yes"
    assert ssh["authorized_keys"] == 1
    assert "AAAAC3" not in proc.stdout and "leo@laptop" not in proc.stdout  # never key material
    (world[0] / "sshd.out").write_text(SSHD_GOOD)
    ssh = _run(world)[1]["ssh"]
    assert ssh["password_authentication"] is False and ssh["permit_root_login"] == "without-password"


def test_open_ports_respect_ufw_but_not_for_docker(world):
    data = _run(world)[1]
    assert data["firewall"] == {"tool": "ufw", "active": True, "allow_all": False, "allowed": [22, 80, 443]}
    open_ports = {p["port"]: p for p in data["ports"]["open"]}
    # 9119 listens publicly but ufw blocks it; docker-published 8000 bypasses ufw;
    # loopback and docker-bridge listeners are not reachable from outside.
    assert sorted(open_ports) == [22, 80, 443, 8000]
    assert open_ports[8000]["bypasses_firewall"] is True and open_ports[8000]["process"] == "docker-proxy"


def test_firewall_off_means_every_public_listener_is_open(world):
    (world[0] / "ufw.out").write_text("Status: inactive\n")
    data = _run(world)[1]
    assert data["firewall"]["active"] is False
    assert [p["port"] for p in data["ports"]["open"]] == [22, 80, 443, 8000, 9119]


def test_updates_and_domains(world):
    (world[0] / "aquarium.conf").write_text("HOME_DOMAIN=home.example.com\nCHANNEL=stable\n")
    data = _run(world)[1]
    assert data["updates"] == {"installed": True, "unattended_upgrade": True,
                               "update_package_lists": True, "timer_enabled": True}
    assert data["domains"] == ["home.example.com", "www.example.com", "dash.example.com"]


def test_runs_doctor_json_and_keeps_its_rows(world):
    data = _run(world)[1]
    doc = data["doctor"]
    assert doc["ran"] and doc["supports_json"]
    assert [r["status"] for r in doc["rows"]] == ["ok", "fail"]
    assert "aquarium doctor --json" in (world[0] / "calls").read_text()


def test_doctor_without_json_support_or_not_root_owned(world):
    _fake(world[0] / "aq" / "aquarium", 'echo "usage: aquarium" >&2\nexit 2\n')
    assert _run(world)[1]["doctor"] == {"installed": True, "trusted": True, "ran": True, "supports_json": False}
    (world[0] / "aq" / "aquarium").chmod(0o777)
    assert _run(world)[1]["doctor"] == {"installed": True, "trusted": False}
    (world[0] / "aq" / "aquarium").unlink()
    assert _run(world)[1]["doctor"] == {"installed": False}


def test_second_run_while_one_is_running_says_busy(world):
    with open(world[0] / "lock", "a", encoding="utf-8") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        proc, data = _run(world)
    assert proc.returncode == 75 and data == {"version": 1, "error": "busy"}
