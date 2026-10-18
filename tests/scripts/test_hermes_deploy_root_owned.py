"""F13/F15: deploy-hermes.sh runs as root, so it must never run code the
hermes user can edit — git config/hooks, setup code, npm scripts/.npmrc, or
scripts/*.py from a hermes-writable checkout. The ownership gate and the npm
step are run for real (lifted from the script) against a temp tree; the rest
are contracts on the script text."""

from __future__ import annotations

import getpass
import grp
import json
import os
import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY = REPO_ROOT / "deploy" / "hermes-deploy.sh"
TEXT = DEPLOY.read_text()


def _block(start: str, end: str) -> str:
    match = re.search(rf"^{start}.*?^{end}$", TEXT, re.S | re.M)
    assert match, f"block {start!r} moved; update this test with it"
    return match.group(0)


def _gate(repo: Path, backups: Path) -> subprocess.CompletedProcess[str]:
    # The test user stands in for root: the gate's question is "owned by the
    # deploying user and not group/world-writable".
    me = f"{getpass.getuser()}:{grp.getgrgid(os.getgid()).gr_name}"
    block = (
        _block(r"HERMES_WRITABLE=\(", "fi")
        .replace("-user root", f"-user {getpass.getuser()}")
        .replace("chown root:root", f"chown {me}")
    )
    return subprocess.run(
        ["bash", "-c", f"set -euo pipefail\nREPO={repo}\n{block}\necho GATE-OK"],
        capture_output=True, text=True, env={**os.environ, "DEPLOY_BACKUP_ROOT": str(backups)},
    )


@pytest.fixture
def tree(tmp_path: Path) -> Path:
    repo = tmp_path / "hermes-agent"
    for rel in ("scripts/deploy_state.py", ".git/hooks/README", "agent-home/.next/cache/x"):
        (repo / rel).parent.mkdir(parents=True, exist_ok=True)
        (repo / rel).write_text("x\n")
    for path in [repo, *repo.rglob("*")]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    return repo


def _mode(path: Path) -> int:
    return path.stat().st_mode & 0o777


def test_root_owned_tree_is_left_alone(tree: Path, tmp_path: Path) -> None:
    result = _gate(tree, tmp_path / "backups")
    assert "GATE-OK" in result.stdout, result.stderr
    assert not (tmp_path / "backups").exists()


@pytest.mark.parametrize("rel", ["scripts/deploy_state.py", ".git/hooks", "scripts"])
def test_hermes_writable_checkout_is_made_root_owned_with_rollback(
    tree: Path, tmp_path: Path, rel: str,
) -> None:
    """The existing box's checkout is all hermes-owned: the deploy must fix
    that itself (no manual step) and leave an exact undo."""
    before = 0o775 if (tree / rel).is_dir() else 0o664
    (tree / rel).chmod(before)
    result = _gate(tree, tmp_path / "backups")
    assert "GATE-OK" in result.stdout, result.stderr
    assert "now root-owned" in result.stdout
    assert _mode(tree / rel) == before & ~0o022
    (migrated,) = (tmp_path / "backups").iterdir()
    assert f"{before:o} {tree / rel}\n" in (migrated / "owners.txt").read_text()

    subprocess.run(["bash", str(migrated / "rollback.sh")], check=True)
    assert _mode(tree / rel) == before


def test_runtime_cache_and_env_files_keep_their_owner(tree: Path, tmp_path: Path) -> None:
    (tree / "agent-home/.next/cache").chmod(0o777)
    (tree / "agent-home/.next/cache/x").chmod(0o666)
    for env in ("agent-home/agent-home.env", ".env", "custom/local.env"):
        (tree / env).parent.mkdir(exist_ok=True)
        (tree / env).write_text("K=v\n")
        (tree / env).chmod(0o660)
    assert "GATE-OK" in _gate(tree, tmp_path / "backups").stdout
    assert _mode(tree / "agent-home/.next/cache") == 0o777
    for env in ("agent-home/agent-home.env", ".env", "custom/local.env"):
        assert _mode(tree / env) == 0o660, env


def _npm(tmp_path: Path, rc: str | None) -> tuple[subprocess.CompletedProcess[str], str]:
    work = tmp_path / "work"
    (work / "web").mkdir(parents=True)
    (work / "agent-home").mkdir()
    if rc:
        (work / rc).write_text("registry=https://evil.example/\n")
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "npm").write_text(f'#!/bin/sh\necho "npm $*" >> {tmp_path}/calls\n')
    (fake / "npm").chmod(0o755)
    block = _block("NPM_REBUILD=", "}")
    result = subprocess.run(
        ["bash", "-c", f"set -euo pipefail\nREPO={work}\ncd {work}\n{block}\nnpm_ci"],
        capture_output=True, text=True,
        env={**os.environ, "PATH": f"{fake}:/usr/bin:/bin"},
    )
    calls = (tmp_path / "calls").read_text() if (tmp_path / "calls").exists() else ""
    return result, calls


def test_npm_ci_runs_without_lifecycle_scripts(tmp_path: Path) -> None:
    result, calls = _npm(tmp_path, None)
    assert result.returncode == 0, result.stderr
    lines = calls.splitlines()
    assert lines[0].startswith("npm ci --ignore-scripts")
    assert lines[1].startswith("npm rebuild") and "agent-browser" in lines[1]


@pytest.mark.parametrize("rc", [".npmrc", "web/.npmrc", "agent-home/.npmrc"])
def test_untracked_project_npmrc_is_flagged(tmp_path: Path, rc: str) -> None:
    result, calls = _npm(tmp_path, rc)
    assert result.returncode == 0, result.stderr
    assert f"untracked {tmp_path / 'work' / rc} is used by npm" in result.stderr
    assert calls.startswith("npm ci --ignore-scripts")


def test_every_runtime_install_script_is_reviewed() -> None:
    """A runtime package whose install step builds/downloads its binary must
    be named in NPM_REBUILD, or --ignore-scripts silently breaks it (e.g.
    agent-browser fetches the browser driver in postinstall)."""
    rebuild = set(re.search(r"^NPM_REBUILD=\(([^)]*)\)", TEXT, re.M).group(1).split())
    lock = json.loads((REPO_ROOT / "package-lock.json").read_text())["packages"]
    needed = {
        key.split("node_modules/")[-1]
        for key, meta in lock.items()
        if key.startswith("node_modules/") and meta.get("hasInstallScript")
        and not meta.get("dev") and key.split("node_modules/")[-1] != "fsevents"  # macOS only
    }
    assert needed <= rebuild, needed - rebuild


def test_no_command_makes_the_checkout_hermes_owned() -> None:
    for text in (TEXT, (REPO_ROOT / "install-aquarium.sh").read_text()):
        assert not re.search(r"xargs -0 chown hermes", text)
        assert not re.search(r"chown -R hermes[^\n]*(\$REPO|\$APP)\b", text)


def test_git_hooks_and_fsmonitor_are_disabled_before_any_git_call() -> None:
    wrapper = TEXT.index('git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }')
    first_git = re.search(r"^[^#\n]*\$\(git |^\s*git |<\(git ", TEXT, re.M).start()
    assert wrapper < first_git


def test_root_runs_python_isolated() -> None:
    assert "./.venv/bin/python -I -m pip install" in TEXT
    assert "pip install -q -e ." not in TEXT.replace("-m pip install -q -e .", "")
    assert "./.venv/bin/python -I scripts/deploy_state.py handover" in TEXT
    code = "\n".join(line for line in TEXT.splitlines() if not line.lstrip().startswith("#"))
    assert not re.search(r"npm ci (?!--ignore-scripts)", code)


def test_root_timer_runs_isolated_python_from_root_owned_paths() -> None:
    unit = (REPO_ROOT / "deploy" / "hermes-secret-backup.service").read_text()
    assert "User=" not in unit  # root: it must read every credential
    assert "bin/python -I" in unit
    assert "CapabilityBoundingSet=CAP_DAC_READ_SEARCH" in unit
    assert "ProtectSystem=strict" in unit


@pytest.mark.parametrize("script", ["backup_secrets.py", "deploy_state.py"])
def test_repo_root_module_cannot_shadow_site_packages(tmp_path: Path, script: str) -> None:
    """Root runs these with the repo on sys.path. A stray `packaging/` at the
    repo root (imported by check_runtime_drift) must not win over the real one."""
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    for name in ("backup_secrets.py", "deploy_state.py", "check_runtime_drift.py"):
        (repo / "scripts" / name).write_text((REPO_ROOT / "scripts" / name).read_text())
    marker = tmp_path / "pwned"
    (repo / "packaging").mkdir()
    (repo / "packaging" / "__init__.py").write_text(f"open({str(marker)!r}, 'w').write('x')\n")
    venv_python = REPO_ROOT / ".venv" / "bin" / "python"
    python = str(venv_python) if venv_python.exists() else "python3"
    result = subprocess.run(
        [python, "-I", str(repo / "scripts" / script), "--help"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert not marker.exists(), "a module planted at the repo root ran"
    assert result.returncode == 0, result.stderr
