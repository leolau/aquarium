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
