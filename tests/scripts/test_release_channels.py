"""Release tag rules + channels.json contract (docs/packaging/RELEASES.md)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "release_channels.py"
_spec = importlib.util.spec_from_file_location("release_channels", _PATH)
assert _spec and _spec.loader
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)


@pytest.mark.parametrize(
    "tag,channel",
    [("v1.2.3", "stable"), ("v0.1.0", "stable"), ("v1.2.3-rc.1", "beta"), ("v1.2.3-beta.10", "beta")],
)
def test_valid_tags(tag, channel):
    assert rc.parse_tag(tag)[1] == channel


@pytest.mark.parametrize(
    "tag",
    ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-alpha.1", "v1.2.3-rc", "v1.2.3-rc.1+meta", "v2026.5.15.2", "v1.2.3 "],
)
def test_invalid_tags(tag):
    with pytest.raises(ValueError):
        rc.parse_tag(tag)


def test_semver_order():
    order = ["v1.2.3-beta.2", "v1.2.3-rc.1", "v1.2.3-rc.2", "v1.2.3", "v1.2.10-beta.1", "v1.10.0"]
    assert sorted(reversed(order), key=lambda t: rc.parse_tag(t)[0]) == order


def test_channels_pick_newest_stable_and_newest_overall():
    out = rc.compute_channels(["v1.0.0", "v1.1.0-rc.1", "v0.9.0", "junk"], now="x")
    assert out["channels"]["stable"]["version"] == "v1.0.0"
    assert out["channels"]["beta"]["version"] == "v1.1.0-rc.1"
    # A stable newer than every rc is also what beta users get.
    out = rc.compute_channels(["v1.1.0-rc.1", "v1.1.0"], now="x")
    assert out["channels"]["beta"]["version"] == "v1.1.0"


def test_channel_entry_names_match_asset_contract():
    entry = rc.compute_channels(["v1.2.3"], repo="o/r", now="x")["channels"]["stable"]
    assert entry == {
        "version": "v1.2.3",
        "tarball": "aquarium-v1.2.3-linux-x86_64.tar.gz",
        "download_base": "https://github.com/o/r/releases/download/v1.2.3/",
    }


def test_no_stable_yet():
    out = rc.compute_channels(["v0.1.0-rc.1"], now="x")
    assert out["channels"]["stable"] is None
    assert out["schema"] == 1


def test_cli_channels_skips_drafts(tmp_path):
    releases = tmp_path / "r.json"
    releases.write_text(json.dumps([{"tag_name": "v9.0.0", "draft": True}, {"tag_name": "v1.0.0"}]), encoding="utf-8")
    res = subprocess.run(
        [sys.executable, str(_PATH), "channels", "v1.1.0-rc.1", "--releases", str(releases)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(res.stdout)
    assert data["channels"]["stable"]["version"] == "v1.0.0"
    assert data["channels"]["beta"]["version"] == "v1.1.0-rc.1"


def test_cli_check_rejects_bad_tag():
    res = subprocess.run([sys.executable, str(_PATH), "check", "main"], capture_output=True, text=True)
    assert res.returncode == 1
