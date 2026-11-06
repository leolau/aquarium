"""Behavior contracts for journey node edit/delete (agent.learning_mutations).

Exercises the real on-disk resolution (skills dir + MEMORY.md/USER.md chunking)
against a temp HERMES_HOME, never mocks — the id→file mapping is the whole point.
"""

from __future__ import annotations

import pytest

from agent import learning_mutations as lm
from hermes_constants import get_hermes_home

_SKILL = """---
name: my-skill
description: A test skill.
---

# My Skill

Body.
"""


@pytest.fixture
def home():
    base = get_hermes_home()
    (base / "memories").mkdir(parents=True, exist_ok=True)
    (base / "memories" / "MEMORY.md").write_text("alpha note\nline two\n§\nbeta note", encoding="utf-8")
    (base / "memories" / "USER.md").write_text("user profile note", encoding="utf-8")
    skill = base / "skills" / "my-skill"
    skill.mkdir(parents=True, exist_ok=True)
    (skill / "SKILL.md").write_text(_SKILL, encoding="utf-8")
    return base


def test_parse_node_kind():
    assert lm.parse_node_kind("memory:memory:0") == "memory"
    assert lm.parse_node_kind("memory:profile:3") == "memory"
    assert lm.parse_node_kind("debugging-hermes") == "skill"


def test_memory_global_index_maps_across_files(home):
    # MEMORY.md → indices 0,1; USER.md → index 2 (global, memory cards first).
    assert lm.node_detail("memory:memory:0")["content"].startswith("alpha note")
    assert lm.node_detail("memory:memory:1")["content"] == "beta note"
    assert lm.node_detail("memory:profile:2")["content"] == "user profile note"


def test_memory_label_is_first_line(home):
    assert lm.node_detail("memory:memory:0")["label"] == "alpha note"


def test_delete_memory_rewrites_file(home):
    assert lm.delete_node("memory:memory:0")["ok"]
    remaining = (home / "memories" / "MEMORY.md").read_text(encoding="utf-8")
    assert "alpha note" not in remaining
    assert "beta note" in remaining


def test_edit_memory_replaces_chunk(home):
    assert lm.edit_node("memory:profile:2", "rewritten profile")["ok"]
    assert (home / "memories" / "USER.md").read_text(encoding="utf-8").strip() == "rewritten profile"


def test_edit_memory_empty_is_rejected(home):
    res = lm.edit_node("memory:memory:1", "   ")
    assert not res["ok"]
    assert "delete" in res["message"]


def test_stale_memory_index_errors(home):
    res = lm.node_detail("memory:memory:9")
    assert not res["ok"]


def test_bad_memory_id_returns_error(home):
    res = lm.delete_node("memory:bogus:0")
    assert not res["ok"]


def test_skill_detail_returns_skill_md(home):
    d = lm.node_detail("my-skill")
    assert d["ok"] and d["kind"] == "skill"
    assert "name: my-skill" in d["content"]


def test_delete_skill_archives_recoverably(home):
    res = lm.delete_node("my-skill")
    assert res["ok"]
    assert not (home / "skills" / "my-skill").exists()
    assert (home / "skills" / ".archive" / "my-skill" / "SKILL.md").exists()


def test_delete_pinned_skill_refused(home):
    from tools import skill_usage

    skill_usage.set_pinned("my-skill", True)
    res = lm.delete_node("my-skill")
    assert not res["ok"]
    assert "pinned" in res["message"]
    assert (home / "skills" / "my-skill").exists()


def test_edit_skill_rewrites_and_validates(home):
    bad = lm.edit_node("my-skill", "no frontmatter here")
    assert not bad["ok"]
    good = lm.edit_node("my-skill", _SKILL.replace("A test skill.", "Updated desc."))
    assert good["ok"]
    assert "Updated desc." in (home / "skills" / "my-skill" / "SKILL.md").read_text(encoding="utf-8")


def test_missing_skill_detail(home):
    assert not lm.node_detail("nonexistent-skill")["ok"]


def test_memory_writes_match_memory_tool_format(home):
    """A journey mutation must leave the file byte-identical to what the memory
    tool itself writes — same §-join, no trailing-newline drift — so the two
    surfaces never fight over format and indices stay aligned."""
    from tools.memory_tool import ENTRY_DELIMITER, MemoryStore

    assert lm.edit_node("memory:memory:0", "alpha rewritten")["ok"]
    path = home / "memories" / "MEMORY.md"
    entries = MemoryStore._read_file(path)

    assert entries == ["alpha rewritten", "beta note"]
    assert path.read_text(encoding="utf-8") == ENTRY_DELIMITER.join(entries)


# ── FG-24: the viewer's own files + the shared block, never anyone else's ───


@pytest.fixture
def fg24_home(home):
    from tools.memory_tool import get_memory_dir, get_person_memory_dir

    (get_memory_dir("alice")).mkdir(parents=True, exist_ok=True)
    (get_memory_dir("alice") / "MEMORY.md").write_text("alice note", encoding="utf-8")
    (get_person_memory_dir("alice")).mkdir(parents=True, exist_ok=True)
    (get_person_memory_dir("alice") / "USER.md").write_text("alice is concise", encoding="utf-8")
    (get_memory_dir("bob")).mkdir(parents=True, exist_ok=True)
    (get_memory_dir("bob") / "MEMORY.md").write_text("bob secret", encoding="utf-8")
    return home


def _cards(principal):
    from agent.learning_graph import _memory_cards

    return _memory_cards(principal)


def test_principal_sees_shared_then_own_files_only(fg24_home):
    cards = _cards(("alice", "member"))
    assert [(c["source"], c["body"]) for c in cards] == [
        ("shared", "alpha note\nline two"),
        ("shared", "beta note"),
        ("memory", "alice note"),
        ("profile", "alice is concise"),
    ]
    assert not any("bob" in c["body"] for c in cards)
    assert [c["editable"] for c in cards] == [False, False, True, True]


def test_member_edits_own_notes_not_shared(fg24_home):
    from tools.memory_tool import get_memory_dir

    me = ("alice", "member")
    assert lm.node_detail("memory:memory:2", me)["content"] == "alice note"
    assert lm.edit_node("memory:memory:2", "alice rewritten", me)["ok"]
    assert (get_memory_dir("alice") / "MEMORY.md").read_text(encoding="utf-8") == "alice rewritten"

    refused = lm.edit_node("memory:shared:0", "hijack", me)
    assert not refused["ok"] and "owner or an admin" in refused["message"]
    assert not lm.delete_node("memory:shared:1", me)["ok"]
    assert "alpha note" in (fg24_home / "memories" / "MEMORY.md").read_text(encoding="utf-8")


def test_admin_may_edit_shared(fg24_home):
    assert lm.edit_node("memory:shared:1", "beta rewritten", ("alice", "admin"))["ok"]
    assert "beta rewritten" in (fg24_home / "memories" / "MEMORY.md").read_text(encoding="utf-8")


def test_unresolved_viewer_sees_shared_read_only(fg24_home):
    unresolved = (None, None, True)
    cards = _cards(unresolved)
    assert {c["source"] for c in cards} == {"shared"}
    assert not any(c["editable"] for c in cards)
    assert not lm.delete_node("memory:shared:0", unresolved)["ok"]


def test_no_principal_keeps_pre_fg24_layout(fg24_home):
    cards = _cards((None, None, False))
    assert [c["source"] for c in cards] == ["memory", "memory", "profile"]
    assert all(c["editable"] for c in cards)
