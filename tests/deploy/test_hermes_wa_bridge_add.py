"""deploy/hermes-wa-bridge-add runs as root via sudo (F14). It is run here
against a temp world: its fixed paths are rewritten into tmp_path and its
PATH points at fake ``systemctl``/``ss``/``runuser``/``chown``, so nothing
touches systemd or real users."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy" / "hermes-wa-bridge-add"
FAKES = {
    "systemctl": "#!/bin/sh\necho \"systemctl $*\" >> \"$W/calls\"\n",
    "ss": "#!/bin/sh\nexit 0\n",
    "chown": "#!/bin/sh\necho \"chown $*\" >> \"$W/calls\"\n",
    # `runuser -u hermes -- cmd...` -> run cmd as the test user
    "runuser": "#!/bin/sh\necho \"runuser $*\" >> \"$W/calls\"\nshift 3\nexec \"$@\"\n",
    # The pre-F14 helper created the session dir with `install -d -o hermes`.
    "install": "#!/bin/sh\necho \"install $*\" >> \"$W/calls\"\n",
}


@pytest.fixture
def world(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for name, body in FAKES.items():
        (fake_bin / name).write_text(body)
        (fake_bin / name).chmod(0o755)
    for sub in ("etc/systemd/system", "home/whatsapp", "log", "app"):
        (tmp_path / sub).mkdir(parents=True)
    text = HELPER.read_text()
    text = text.replace("/etc/systemd/system", str(tmp_path / "etc/systemd/system"))
    text = text.replace("/opt/data/hermes-home-staging", str(tmp_path / "home"))
    text = text.replace("/var/log/", str(tmp_path / "log") + "/")
    text = text.replace("/opt/data/hermes-agent", str(tmp_path / "app"))
    text = text.replace(
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        f"PATH={fake_bin}:/usr/bin:/bin",
    )
    script = tmp_path / "helper.sh"
    script.write_text(text)
    return tmp_path, script


def _run(world, *args):
    root, script = world
    env = {**os.environ, "W": str(root), "PATH": f"{root / 'bin'}:/usr/bin:/bin"}
    return subprocess.run(["bash", str(script), *args], capture_output=True, text=True, env=env)


def test_provisions_unprivileged_unit(world):
    root, _ = world
    result = _run(world, "office")
    assert result.returncode == 0, result.stderr
    unit = root / "etc/systemd/system/hermes-wa-bridge-office.service"
    assert "--port 3000" in unit.read_text()
    dropin = root / "etc/systemd/system/hermes-wa-bridge-office.service.d/10-unprivileged.conf"
    assert "User=hermes" in dropin.read_text()
    session = root / "home/whatsapp/session-office"
    assert session.is_dir() and not session.is_symlink()
    assert "runuser -u hermes -- mkdir" in (root / "calls").read_text()


def test_refuses_symlinked_session_dir(world, tmp_path):
    """The whatsapp/ dir is hermes-writable: a planted symlink must not make
    root create or chown anything at its target."""
    root, _ = world
    target = tmp_path / "victim"
    target.mkdir()
    (root / "home/whatsapp/session-office").symlink_to(target)
    result = _run(world, "office")
    assert result.returncode == 4, result.stdout + result.stderr
    assert "not a plain directory" in result.stderr
    assert not (root / "etc/systemd/system/hermes-wa-bridge-office.service").exists()
    calls = (root / "calls").read_text() if (root / "calls").exists() else ""
    assert str(target) not in calls and "session-office" not in calls


@pytest.mark.parametrize(
    "args",
    [[], ["Bad Name"], ["../etc"], ["ok", "--extra"], ["-x"]],
)
def test_rejects_bad_arguments(world, args):
    root, _ = world
    result = _run(world, *args)
    assert result.returncode == 2
    assert not list((root / "etc/systemd/system").iterdir())


def test_installed_path_matches_api_and_sudoers():
    import hermes_cli.wa_bridge_api as api

    rule = (HELPER.parent / "sudoers.d" / "hermes-wa-bridge").read_text()
    assert f"NOPASSWD: {api._ADD_HELPER}\n" in rule
    assert HELPER.read_text().startswith("#!/bin/bash\n")
