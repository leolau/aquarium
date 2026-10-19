"""Every sudoers rule the repo ships or documents must name a root-owned
system path — never a file under the hermes-writable checkout or data dirs,
and never an interpreter that takes a script path (``bash x.sh``,
``python x.py``): whoever can edit that file runs code as root (F14)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCANNED = [
    *sorted((REPO / "deploy").rglob("*")),
    *sorted((REPO / "docs" / "deployment").rglob("*.md")),
    *sorted((REPO / "plans").rglob("*.md")),
    REPO / "install-aquarium.sh",
    REPO / "hermes_cli" / "wa_bridge_api.py",
]
RULE = re.compile(
    r"\bhermes(?:-tools)?\s+ALL\s*=\s*\([^)]*\)\s*NOPASSWD:\s*(?:[A-Z_]+:\s*)*(?P<cmds>[^`|\n]+)"
)
SAFE_PREFIXES = ("/usr/local/sbin/", "/usr/bin/systemctl", "/bin/systemctl")
INTERPRETERS = re.compile(r"(^|/)(bash|sh|dash|python3?(\.\d+)?|node|perl)$")


def _rules():
    for path in SCANNED:
        if not path.is_file():
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        for match in RULE.finditer(text):
            for cmd in match.group("cmds").split(","):
                yield path.relative_to(REPO), cmd.strip()


def test_rules_are_found():
    cmds = {cmd for _, cmd in _rules()}
    assert "/usr/local/sbin/hermes-wa-bridge-add" in cmds
    # Tags such as SETENV: are skipped, so the command itself is still checked.
    assert "/usr/local/sbin/hermes-tools-exec" in cmds
    assert "/usr/local/sbin/hermes-tools-cli" in cmds
    # "" = sudo refuses any argument to the security check helper.
    assert '/usr/local/sbin/hermes-security-check ""' in cmds


@pytest.mark.parametrize("where,cmd", list(_rules()))
def test_rule_runs_only_root_owned_system_binaries(where, cmd):
    binary = cmd.split()[0]
    assert binary.startswith(SAFE_PREFIXES), f"{where}: {cmd}"
    assert not INTERPRETERS.search(binary), f"{where}: {cmd}"
    assert "/opt/" not in cmd, f"{where}: {cmd}"


def test_shipped_sudoers_files_point_at_shipped_helpers():
    for rule in sorted((REPO / "deploy" / "sudoers.d").iterdir()):
        for line in rule.read_text().splitlines():
            m = RULE.search(line)
            if m and m.group("cmds").strip().startswith("/usr/local/sbin/"):
                helper = m.group("cmds").strip().split()[0].rsplit("/", 1)[1]
                assert (REPO / "deploy" / helper).is_file(), (rule.name, helper)
