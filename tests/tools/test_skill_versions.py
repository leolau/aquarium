"""E2E tests for the skill version store (tools/skill_versions.py).

Everything runs against the per-test HERMES_HOME with real imports: the
store, the skill_manage write path, the loader, and the prompt cache.
"""

import json
import threading

import pytest

from hermes_constants import get_skills_dir
from tools import skill_versions as sv

SKILL_MD = """---
name: {name}
description: {desc}
---

# {name}

{body}
"""


def _md(name="demo", desc="a demo skill", body="Do the thing."):
    return SKILL_MD.format(name=name, desc=desc, body=body)


def _live(name="demo", category=None, **kw):
    root = get_skills_dir()
    d = root / category / name if category else root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(_md(name, **kw), encoding="utf-8")
    return d


@pytest.fixture
def skill_manager(monkeypatch):
    import tools.skill_manager_tool as smt

    monkeypatch.setattr(smt, "SKILLS_DIR", get_skills_dir())
    return smt


class TestValidation:
    @pytest.mark.parametrize("bad", ["../x", "..", "a/b", "a\\b", ".versions", "", "x" * 200, "a..b", None])
    def test_rejects_unsafe_names(self, bad):
        with pytest.raises(sv.SkillVersionError):
            sv.validate_name(bad)

    @pytest.mark.parametrize("bad", ["v0", "1", "../v1", "v1/..", "vx", ""])
    def test_rejects_unsafe_ids(self, bad):
        with pytest.raises(sv.SkillVersionError):
            sv.validate_version_id(bad)

    def test_rejects_unknown_author(self):
        _live()
        with pytest.raises(sv.SkillVersionError):
            sv.snapshot("demo", author="root", source="edit")

    def test_traversal_never_reads_outside_store(self):
        with pytest.raises(sv.SkillVersionError):
            sv.get_version("../../etc", "v1")
        assert sv.current_version_id("../x") is None


class TestBaselineAndSnapshot:
    def test_first_touch_records_baseline_once(self):
        _live()
        meta = sv.ensure_baseline("demo")
        assert meta["id"] == "v1" and meta["source"] == "baseline" and meta["author"] == "system"
        assert meta["status"] == "active" and meta["parent"] is None and meta["trial_of"] is None
        assert sv.ensure_baseline("demo")["id"] == "v1"
        assert [v["id"] for v in sv.list_versions("demo")] == ["v1"]
        assert sv.current_version_id("demo") == "v1"

    def test_missing_skill_is_not_versioned(self):
        assert sv.ensure_baseline("nope") is None
        assert sv.snapshot("nope", author="hub", source="import") is None
        assert sv.list_versions("nope") == []

    def test_snapshot_copies_full_folder_and_dedupes(self):
        d = _live()
        (d / "references").mkdir()
        (d / "references" / "api.md").write_text("ref", encoding="utf-8")
        v1 = sv.snapshot("demo", author="user:u1", message="hi", source="create")
        assert v1["id"] == "v1"
        assert sv.snapshot("demo", author="user:u1", source="edit")["id"] == "v1"

        (d / "SKILL.md").write_text(_md(body="Better."), encoding="utf-8")
        v2 = sv.snapshot("demo", author="agent:s1", message="tweak", source="edit")
        assert v2["id"] == "v2" and v2["parent"] == "v1" and v2["sha256"] != v1["sha256"]
        statuses = {v["id"]: v["status"] for v in sv.list_versions("demo")}
        assert statuses == {"v2": "active", "v1": "archived"}

        detail = sv.get_version("demo", "v1")
        assert "Do the thing." in detail["content"]
        assert [f["path"] for f in detail["files"]] == ["SKILL.md", "references/api.md"]

    def test_out_of_band_change_is_captured_before_next_write(self):
        d = _live()
        sv.ensure_baseline("demo")
        (d / "SKILL.md").write_text(_md(body="hand edit"), encoding="utf-8")
        meta = sv.ensure_baseline("demo")
        assert meta["id"] == "v2" and meta["author"] == "system"
        assert "hand edit" in sv.get_version("demo", "v2")["content"]

    def test_list_is_oldest_first(self):
        d = _live()
        sv.ensure_baseline("demo")
        for i in range(3):
            (d / "SKILL.md").write_text(_md(body=f"rev {i}"), encoding="utf-8")
            sv.snapshot("demo", author="user:u", source="edit")
        ns = [v["n"] for v in sv.list_versions("demo")]
        assert ns == sorted(ns) and ns[-1] == sv.list_versions("demo")[-1]["n"]
        assert sv.list_versions("demo")[-1]["id"] == sv.current_version_id("demo")

    def test_index_matches_contract_shape(self):
        _live()
        sv.snapshot("demo", author="curator", source="patch")
        index = json.loads((get_skills_dir() / ".versions" / "demo" / "index.json").read_text())
        assert index["active"] == "v1"
        assert set(index["versions"][0]) >= {
            "id", "n", "created_at", "author", "message", "parent",
            "status", "source", "sha256", "trial_of",
        }
        assert set(sv.list_versions("demo")[0]) == {
            "id", "n", "created_at", "author", "message", "parent",
            "status", "source", "sha256", "trial_of",
        }

    def test_concurrent_snapshots_get_unique_ids(self):
        d = _live()
        sv.ensure_baseline("demo")
        errors = []

        def write(i):
            try:
                (d / f"note-{i}.md").write_text(str(i), encoding="utf-8")
                sv.snapshot("demo", author="user:u", source="edit")
            except Exception as exc:  # pragma: no cover - surfaced below
                errors.append(exc)

        threads = [threading.Thread(target=write, args=(i,)) for i in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert not errors
        ids = [v["id"] for v in sv.list_versions("demo")]
        assert len(ids) == len(set(ids))
        assert sum(1 for v in sv.list_versions("demo") if v["status"] == "active") == 1


class TestDraftsDiffActivate:
    def test_draft_never_touches_live(self):
        d = _live()
        (d / "scripts").mkdir()
        (d / "scripts" / "run.sh").write_text("echo hi\n", encoding="utf-8")
        before = (d / "SKILL.md").read_text()
        draft = sv.create_draft("demo", _md(body="Draft body."), author="agent:sess-1", message="idea")
        assert draft["status"] == "draft" and draft["source"] == "improve" and draft["parent"] == "v1"
        assert (d / "SKILL.md").read_text() == before
        assert sv.current_version_id("demo") == "v1"
        files = [f["path"] for f in sv.get_version("demo", draft["id"])["files"]]
        assert "scripts/run.sh" in files

    def test_draft_from_base_copies_that_version(self):
        d = _live()
        first = sv.create_draft("demo", _md(body="First."), author="user:u")
        assert first["parent"] == "v1"
        (d / "extra.txt").write_text("live only\n", encoding="utf-8")
        edited = sv.create_draft("demo", _md(body="Edited."), author="user:u", source="edit", base=first["id"])
        assert edited["parent"] == first["id"] and edited["source"] == "edit"
        with pytest.raises(sv.SkillVersionNotFound):
            sv.create_draft("demo", _md(body="x"), author="user:u", base="v99")
        with pytest.raises(sv.SkillVersionError):
            sv.create_draft("demo", _md(body="x"), author="user:u", base="../v1")

    def test_draft_validates_content(self):
        _live()
        with pytest.raises(sv.SkillVersionError):
            sv.create_draft("demo", "no frontmatter", author="user:u")
        with pytest.raises(sv.SkillVersionNotFound):
            sv.create_draft("ghost", _md("ghost"), author="user:u")

    def test_diff_is_unified(self):
        _live()
        sv.ensure_baseline("demo")
        draft = sv.create_draft("demo", _md(body="New body."), author="user:u")
        text = sv.diff("demo", "v1", draft["id"])
        assert "--- v1/SKILL.md" in text and f"+++ {draft['id']}/SKILL.md" in text
        assert "-Do the thing." in text and "+New body." in text
        assert sv.diff("demo", "v1", "v1") == ""
        with pytest.raises(sv.SkillVersionNotFound):
            sv.diff("demo", "v1", "v99")

    def test_trial_keep_and_revert(self):
        from agent.skill_utils import iter_skill_index_files

        d = _live(category="research")
        sv.ensure_baseline("demo")
        draft = sv.create_draft("demo", _md(body="Trial body."), author="user:u")

        res = sv.activate("demo", draft["id"], author="user:u", trial=True)
        assert res["active"] == draft["id"]
        meta = {v["id"]: v for v in res["versions"]}
        assert meta[draft["id"]]["trial_of"] == "v1" and meta[draft["id"]]["status"] == "active"
        assert meta["v1"]["status"] == "archived"
        assert "Trial body." in (d / "SKILL.md").read_text()
        assert not (d.parent / ".versions").exists()
        found = list(iter_skill_index_files(get_skills_dir(), "SKILL.md"))
        assert found == [d / "SKILL.md"]

        kept = sv.activate("demo", draft["id"], author="user:u")
        assert {v["id"]: v for v in kept["versions"]}[draft["id"]]["trial_of"] is None

        sv.activate("demo", draft["id"], author="user:u", trial=True)  # no-op: already active
        reverted = sv.activate("demo", "v1", author="user:u")
        assert reverted["active"] == "v1"
        assert "Do the thing." in (d / "SKILL.md").read_text()

    def test_activate_records_unsaved_live_changes_first(self):
        d = _live()
        sv.ensure_baseline("demo")
        draft = sv.create_draft("demo", _md(body="Draft."), author="user:u")
        (d / "SKILL.md").write_text(_md(body="hand edit"), encoding="utf-8")
        sv.activate("demo", draft["id"], author="user:u")
        bodies = {v["id"]: sv.get_version("demo", v["id"])["content"] for v in sv.list_versions("demo")}
        assert any("hand edit" in c for c in bodies.values())

    def test_activate_removes_files_absent_from_target(self):
        d = _live()
        sv.ensure_baseline("demo")
        (d / "extra.md").write_text("x", encoding="utf-8")
        sv.snapshot("demo", author="user:u", source="edit")
        sv.activate("demo", "v1", author="user:u")
        assert not (d / "extra.md").exists()
        sv.activate("demo", "v2", author="user:u")
        assert (d / "extra.md").read_text() == "x"

    def test_activate_restores_deleted_live_skill(self):
        import shutil

        d = _live()
        sv.ensure_baseline("demo")
        shutil.rmtree(d)
        sv.create_draft("demo", _md(body="again"), author="user:u")
        res = sv.activate("demo", "v2", author="user:u")
        assert res["active"] == "v2" and (d / "SKILL.md").is_file()

    def test_activate_clears_prompt_cache_for_next_build(self):
        from agent import prompt_builder

        _live()
        sv.ensure_baseline("demo")
        draft = sv.create_draft("demo", _md(desc="fresh description"), author="user:u")
        first = prompt_builder.build_skills_system_prompt()
        assert "a demo skill" in first
        sv.activate("demo", draft["id"], author="user:u")
        # A prompt already built for a running conversation is a plain string
        # the agent holds; it is unaffected. The next build sees the new version.
        assert "a demo skill" in first
        assert "fresh description" in prompt_builder.build_skills_system_prompt()


class TestRetention:
    def _set_cap(self, cap):
        from hermes_constants import get_hermes_home

        (get_hermes_home() / "config.yaml").write_text(
            f"skills:\n  versions:\n    max_per_skill: {cap}\n", encoding="utf-8"
        )

    def test_default_cap(self):
        assert sv.max_per_skill() == 50

    def test_prunes_oldest_but_keeps_drafts_active_and_trial_parent(self):
        self._set_cap(3)
        d = _live()
        sv.ensure_baseline("demo")
        draft = sv.create_draft("demo", _md(body="keep me"), author="user:u")
        for i in range(5):
            (d / "SKILL.md").write_text(_md(body=f"rev {i}"), encoding="utf-8")
            sv.snapshot("demo", author="user:u", source="edit")
        ids = [v["id"] for v in sv.list_versions("demo")]
        assert len(ids) == 3
        assert draft["id"] in ids and sv.current_version_id("demo") in ids
        store = get_skills_dir() / ".versions" / "demo"
        assert sorted(p.name for p in store.iterdir() if p.name.startswith("v")) == sorted(ids)

        active = sv.current_version_id("demo")
        sv.activate("demo", draft["id"], author="user:u", trial=True)
        for i in range(3):
            sv.create_draft("demo", _md(body=f"d{i}"), author="user:u")
        ids = {v["id"] for v in sv.list_versions("demo")}
        assert active in ids and draft["id"] in ids


class TestSkillManageHooks:
    def test_every_write_action_snapshots(self, skill_manager, monkeypatch):
        import contextvars

        from gateway.session_context import set_session_vars

        def ok(res):
            assert json.loads(res)["success"], res

        def writes():
            # Own context: clear_session_vars would leave "" behind and hide
            # HERMES_SESSION_ID from later tests in this process.
            set_session_vars(session_id="sess-42")
            ok(skill_manager.skill_manage("create", "demo", content=_md()))
            ok(skill_manager.skill_manage("edit", "demo", content=_md(body="Edited.")))
            ok(skill_manager.skill_manage("patch", "demo", old_string="Edited.", new_string="Patched."))
            ok(skill_manager.skill_manage("write_file", "demo", file_path="references/a.md", file_content="A"))
            ok(skill_manager.skill_manage("remove_file", "demo", file_path="references/a.md"))

        contextvars.copy_context().run(writes)

        versions = sorted(sv.list_versions("demo"), key=lambda v: v["n"])
        assert [v["source"] for v in versions] == ["create", "edit", "patch", "patch", "patch"]
        assert {v["author"] for v in versions} == {"agent:sess-42"}
        assert sv.current_version_id("demo") == versions[-1]["id"]
        assert versions[-1]["sha256"] == versions[2]["sha256"]

    def test_failed_write_records_nothing(self, skill_manager):
        skill_manager.skill_manage("create", "demo", content=_md())
        res = json.loads(skill_manager.skill_manage("patch", "demo", old_string="missing", new_string="x"))
        assert not res["success"]
        assert [v["id"] for v in sv.list_versions("demo")] == ["v1"]

    def test_pre_existing_skill_gets_baseline_before_first_agent_edit(self, skill_manager):
        _live()
        skill_manager.skill_manage("edit", "demo", content=_md(body="Edited."))
        versions = sorted(sv.list_versions("demo"), key=lambda v: v["n"])
        assert [v["source"] for v in versions] == ["baseline", "edit"]
        assert "Do the thing." in sv.get_version("demo", "v1")["content"]

    def test_author_scope_attributes_curator(self, skill_manager):
        with sv.author_scope("curator"):
            skill_manager.skill_manage("create", "demo", content=_md())
        assert sv.list_versions("demo")[0]["author"] == "curator"

    def test_store_failure_never_breaks_the_write(self, skill_manager, monkeypatch):
        monkeypatch.setattr(sv, "_capture_live_locked", lambda *a, **k: 1 / 0)
        res = json.loads(skill_manager.skill_manage("create", "demo", content=_md()))
        assert res["success"]


class TestInvisibleToScanners:
    def test_store_is_not_a_skill(self, skill_manager, monkeypatch):
        import tools.skills_tool as st
        from agent.skill_utils import iter_skill_index_files
        from tools.skills_tool import _find_all_skills

        monkeypatch.setattr(st, "SKILLS_DIR", get_skills_dir())

        skill_manager.skill_manage("create", "demo", content=_md())
        sv.create_draft("demo", _md(body="draft"), author="user:u")
        assert (get_skills_dir() / ".versions" / "demo" / "v2" / "SKILL.md").is_file()
        names = [s["name"] for s in _find_all_skills()]
        assert names.count("demo") == 1
        found = list(iter_skill_index_files(get_skills_dir(), "SKILL.md"))
        assert all(".versions" not in p.parts for p in found)

    def test_curator_backup_skips_store(self, skill_manager):
        from agent.curator_backup import _EXCLUDE_TOP_LEVEL

        assert ".versions" in _EXCLUDE_TOP_LEVEL


class TestHubHooks:
    def _install(self, body):
        import tools.skills_hub as hub
        from tools.skills_guard import ScanResult

        content = _md("hubskill", body=body)
        bundle = hub.SkillBundle(
            name="hubskill", files={"SKILL.md": content},
            source="community", identifier="owner/hubskill", trust_level="community",
        )
        q = hub.quarantine_bundle(bundle)
        scan = ScanResult(skill_name="hubskill", source="community", trust_level="community", verdict="safe")
        return hub.install_from_quarantine(q, "hubskill", "", bundle, scan)

    def test_install_and_update_are_versioned_as_hub(self):
        installed = self._install("First.")
        assert installed == get_skills_dir() / "hubskill"
        (installed / "SKILL.md").write_text(_md("hubskill", body="local tweak"), encoding="utf-8")
        self._install("Second.")
        versions = sorted(sv.list_versions("hubskill"), key=lambda v: v["n"])
        assert [(v["author"], v["source"]) for v in versions] == [
            ("hub", "import"), ("system", "edit"), ("hub", "import"),
        ]
        assert "local tweak" in sv.get_version("hubskill", "v2")["content"]
        assert "Second." in sv.get_version("hubskill", "v3")["content"]
