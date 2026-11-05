"""A deploy that cannot delete leaves the box running code the repo removed.

`git checkout -f <ref> -- .` writes every file the ref *has* and removes nothing
it *lacks*, and the `git reset` after it turns the leftover into an untracked
file. Found on `hermes-systest`: `docs/design/projects-feature-design.md`, still
there — byte-identical to its last committed version — days after the rename
that replaced it. A stale document is the harmless case; a deleted module that
is still importable is the same hole.

The update block is lifted out of the deploy script and run against a real
repository, because the property under test is what git actually does to the
working tree.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = REPO_ROOT / "deploy" / "hermes-deploy.sh"


def _update_block() -> str:
    """The checkout/reset/prune sequence, verbatim from the deploy script."""
    text = DEPLOY_SCRIPT.read_text()
    match = re.search(
        r"^TARGET=\"origin/\$BRANCH\"$.*?^untracked=.*?^fi$", text, re.S | re.M
    )
    assert match, "the update block moved; update this test with it"
    return match.group(0)


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout


@pytest.fixture()
def box(tmp_path: Path) -> Path:
    """An origin with a delete and a rename, and a clone standing one behind."""
    origin = tmp_path / "origin"
    origin.mkdir()
    _git(origin, "init", "-q", "-b", "develop")
    _git(origin, "config", "user.email", "t@example.com")
    _git(origin, "config", "user.name", "t")
    (origin / "docs").mkdir()
    (origin / "docs" / "design.md").write_text("the design\n")
    (origin / "keep.py").write_text("print('keep')\n")
    (origin / "retired.py").write_text("print('retired')\n")
    (origin / ".gitignore").write_text(".env\n")
    _git(origin, "add", "-A")
    _git(origin, "commit", "-qm", "first")

    clone = tmp_path / "box"
    _git(tmp_path, "clone", "-q", str(origin), str(clone))

    (origin / "retired.py").unlink()
    (origin / "docs" / "design.md").rename(origin / "docs" / "FG-32.md")
    (origin / "keep.py").write_text("print('keep, changed')\n")
    _git(origin, "add", "-A")
    _git(origin, "commit", "-qm", "retire and rename")

    # What only the box has: a secret the deploy must never touch, and an
    # orphan a pre-fix deploy already left behind.
    (clone / ".env").write_text("SECRET=1\n")
    (clone / "docs" / "left-behind.md").write_text("an earlier deploy's orphan\n")
    return clone


def _run_update(box: Path, ref: str = "") -> subprocess.CompletedProcess[str]:
    script = box.parent / "update.sh"
    script.write_text(
        "set -euo pipefail\n"
        "BRANCH=develop\n"
        f"REF={ref}\n"
        "ALLOWED_LOCAL_MODS=(.env)\n"
        "cd \"$1\"\n"
        "git fetch -q --no-tags origin develop\n"
        "git fetch -q --tags origin\n"
        "BEFORE=$(git rev-parse --short HEAD)\n"
        "git checkout -q $BRANCH\n" + _update_block() + "\n"
    )
    return subprocess.run(
        ["bash", str(script), str(box)], capture_output=True, text=True
    )


def test_a_file_the_repository_deleted_is_deleted_on_the_box(box: Path) -> None:
    result = _run_update(box)

    assert result.returncode == 0, result.stderr
    assert not (box / "retired.py").exists()
    assert not (box / "docs" / "design.md").exists(), "a rename is a delete too"
    assert "removed upstream-deleted file: retired.py" in result.stdout


def test_the_new_revision_still_arrives_whole(box: Path) -> None:
    _run_update(box)

    assert (box / "docs" / "FG-32.md").read_text() == "the design\n"
    assert (box / "keep.py").read_text() == "print('keep, changed')\n"


def test_nothing_untracked_is_deleted(box: Path) -> None:
    """The prune names only paths git reports as deleted between two revisions,
    so a secret or a build artefact the deploy did not put there cannot be
    caught by it."""
    result = _run_update(box)

    assert (box / ".env").read_text() == "SECRET=1\n"
    assert (box / "docs" / "left-behind.md").exists()
    # But an orphan it cannot remove, it names.
    assert "docs/left-behind.md" in result.stdout
    assert ".env" not in result.stdout


def test_a_clean_checkout_reports_nothing(box: Path) -> None:
    """An always-printed line is background colour: the orphan report is silent
    when there is nothing to report."""
    (box / "docs" / "left-behind.md").unlink()

    result = _run_update(box)

    assert "untracked files in the deployment checkout" not in result.stdout


def test_a_release_tag_is_deployed_detached_and_still_prunes(box: Path) -> None:
    """`--ref vX.Y.Z` (Settings → Software upgrade) lands exactly on the tag,
    with the same delete handling as a branch deploy."""
    origin = box.parent / "origin"
    _git(origin, "tag", "v1.1.0")
    (origin / "later.py").write_text("print('after the tag')\n")
    _git(origin, "add", "-A")
    _git(origin, "commit", "-qm", "after the tag")

    result = _run_update(box, ref="v1.1.0")

    assert result.returncode == 0, result.stderr
    assert _git(box, "rev-parse", "HEAD") == _git(origin, "rev-parse", "v1.1.0^{commit}")
    assert not (box / "retired.py").exists()
    assert not (box / "later.py").exists()
