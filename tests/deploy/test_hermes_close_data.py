"""deploy/hermes-close-data closes the raw channel stores and old database
copies to "others" (the terminal's hermes-tools user), run for real against a
temp data folder with the caller's own group standing in for hermes."""

from __future__ import annotations

import getpass
import stat
import subprocess
from pathlib import Path

import pytest

grp = pytest.importorskip("grp")
pwd = pytest.importorskip("pwd")

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "hermes-close-data"
ME = getpass.getuser()
GROUP = grp.getgrgid(pwd.getpwnam(ME).pw_gid).gr_name

pytestmark = pytest.mark.skipif(
    ME == "root" or ME != GROUP,
    reason="needs a non-root POSIX user whose primary group has its name",
)

CLOSED = ["email-messages", "whatsapp-messages", "calendar", "backups", "restore-b2c-20261026"]


def run(data: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(SCRIPT), "--data", str(data), "--group", GROUP, *extra],
        capture_output=True, text=True, check=False,
    )


@pytest.fixture
def data(tmp_path: Path) -> Path:
    for name in CLOSED + ["skills"]:
        d = tmp_path / name
        d.mkdir()
        d.chmod(0o2777 if name.startswith("restore-") else 0o755)
        (d / "store.db").write_text("x")
        (d / "store.db").chmod(0o644)
    return tmp_path


def test_closes_every_raw_store_to_others(data: Path):
    result = run(data)
    assert result.returncode == 0, result.stderr
    for name in CLOSED:
        st = (data / name).stat()
        assert st.st_mode & 0o007 == 0, name
        assert st.st_mode & stat.S_IWGRP == 0, name
        assert st.st_mode & 0o750 == 0o750, name
        assert grp.getgrgid(st.st_gid).gr_name == GROUP
    # Only the folders: what is inside, and unrelated folders, are untouched.
    assert stat.S_IMODE((data / "email-messages" / "store.db").stat().st_mode) == 0o644
    assert stat.S_IMODE((data / "skills").stat().st_mode) == 0o755


def test_idempotent_and_missing_folders_are_fine(tmp_path: Path):
    (tmp_path / "calendar").mkdir(mode=0o755)
    assert run(tmp_path).returncode == 0
    second = run(tmp_path)
    assert second.returncode == 0, second.stderr
    assert stat.S_IMODE((tmp_path / "calendar").stat().st_mode) & 0o007 == 0


def test_symlink_is_not_followed(tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir(mode=0o755)
    outside.chmod(0o755)
    data = tmp_path / "data"
    data.mkdir()
    (data / "email-messages").symlink_to(outside)
    assert run(data).returncode == 0
    assert stat.S_IMODE(outside.stat().st_mode) == 0o755


def test_rejects_unknown_arguments_and_missing_data(tmp_path: Path):
    assert run(tmp_path, "--recursive").returncode == 2
    assert run(tmp_path / "nope").returncode == 2


def test_deploy_closes_stores_before_restarting_services():
    script = (REPO / "deploy" / "hermes-deploy.sh").read_text()
    close = script.index('deploy/hermes-close-data" --data /opt/data')
    assert close < script.index('echo "== restarting services =="')
