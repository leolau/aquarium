"""Draft dirs are shared with the terminal user's group, never with everyone."""

from __future__ import annotations

import getpass
import grp
import os
import stat

import pytest

from hermes_cli import todo_work
from tools import terminal_user

pytestmark = pytest.mark.skipif(os.name == "nt", reason="POSIX permissions")


def _own_group_user() -> str:
    me = getpass.getuser()
    try:
        grp.getgrnam(me)
    except KeyError:
        pytest.skip("no group named after the current user")
    return me


def test_shared_with_the_terminal_users_group_not_the_world(tmp_path, monkeypatch):
    user = _own_group_user()
    monkeypatch.setattr(terminal_user, "configured_user", lambda: user)
    draft = tmp_path / "drafts" / "todo_1"

    todo_work.prepare_draft_dir(draft)

    gid = grp.getgrnam(user).gr_gid
    for path, mode in ((draft.parent, 0o3770), (draft, 0o2770)):
        st = path.stat()
        assert stat.S_IMODE(st.st_mode) == mode
        assert st.st_gid == gid
        assert not st.st_mode & stat.S_IRWXO


def test_single_user_install_leaves_the_dirs_alone(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_user, "configured_user", lambda: "")
    draft = tmp_path / "drafts" / "todo_1"

    todo_work.prepare_draft_dir(draft)

    assert draft.is_dir()
    assert not draft.stat().st_mode & stat.S_IWOTH
    assert not draft.parent.stat().st_mode & stat.S_IWOTH


def test_write_draft_file_replaces_and_leaves_no_temp(tmp_path):
    folder = tmp_path / "todo_1"
    folder.mkdir()
    target = folder / "DRAFT.md"
    target.write_text("old", encoding="utf-8")

    todo_work.write_draft_file(target, "new")

    assert target.read_text(encoding="utf-8") == "new"
    assert [p.name for p in folder.iterdir()] == ["DRAFT.md"]


def test_write_draft_file_never_follows_a_planted_link(tmp_path):
    folder = tmp_path / "todo_1"
    folder.mkdir()
    victim = tmp_path / "config.yaml"
    victim.write_text("secret: keep", encoding="utf-8")
    # Any predictable temp name the writer could pick is a link to the victim.
    import os as _os

    for name in (f"DRAFT.md.{_os.getpid()}.tmp", ".DRAFT.md.tmp"):
        (folder / name).symlink_to(victim)

    todo_work.write_draft_file(folder / "DRAFT.md", "new")

    assert victim.read_text(encoding="utf-8") == "secret: keep"
    assert (folder / "DRAFT.md").read_text(encoding="utf-8") == "new"
    assert not (folder / "DRAFT.md").is_symlink()


def test_a_symlinked_draft_folder_is_refused(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_user, "configured_user", lambda: _own_group_user())
    elsewhere = tmp_path / "home"
    elsewhere.mkdir(mode=0o700)
    drafts = tmp_path / "drafts"
    drafts.mkdir()
    (drafts / "todo_1").symlink_to(elsewhere)

    with pytest.raises(OSError):
        todo_work.prepare_draft_dir(drafts / "todo_1")

    assert stat.S_IMODE(elsewhere.stat().st_mode) == 0o700
