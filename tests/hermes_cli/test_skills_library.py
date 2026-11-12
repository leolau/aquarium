"""Box-wide skills library + per-profile add / remove / delete / copy.

Real path: a temp HERMES_HOME with three profiles, the shared library at
``<hermes root>/skills-shared``, real config.yaml files and the real
``/api/skills/library*`` routes. Pins: every skill is listed once with its
source and per-profile on/off state; Remove only flips ``skills.disabled``
(the file stays); Delete only works on a profile's own skill; a profile-only
skill needs an explicit copy choice; other profiles are never touched;
every change clears the skills prompt cache and is audited.
"""
import json

import pytest
import yaml

SKILL_MD = "---\nname: {name}\ndescription: {name} does a thing\n---\n\n# {name}\n"


def _write_skill(skills_dir, name, category="general"):
    d = skills_dir / category / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(SKILL_MD.format(name=name), encoding="utf-8")
    return d


def _disabled(home):
    cfg = yaml.safe_load((home / "config.yaml").read_text(encoding="utf-8")) or {}
    return set((cfg.get("skills") or {}).get("disabled") or [])


@pytest.fixture
def homes(monkeypatch, _isolate_hermes_home):
    from hermes_constants import get_default_hermes_root, get_hermes_home
    from hermes_cli import profiles

    default = get_hermes_home()
    root = default / "profiles"
    hr, eng = root / "hr", root / "engineers"
    for home in (default, hr, eng):
        (home / "skills").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")

    # built-in in default + hr (with the bundled manifest line), not engineers
    for home in (default, hr):
        _write_skill(home / "skills", "google-workspace", "productivity")
        (home / "skills" / ".bundled_manifest").write_text("google-workspace:abc123\n", encoding="utf-8")
    # hub skill in engineers only
    _write_skill(eng / "skills", "linear", "software-development")
    lock = eng / "skills" / ".hub" / "lock.json"
    lock.parent.mkdir(parents=True)
    lock.write_text(json.dumps({"version": 1, "installed": {"linear": {
        "source": "github", "identifier": "x/linear", "trust_level": "trusted",
        "install_path": "software-development/linear", "files": ["SKILL.md"]}}}), encoding="utf-8")
    # hr's own skill
    _write_skill(hr / "skills", "leave-policy-hk", "hr")
    # shared library skill, switched off in engineers
    shared = get_default_hermes_root() / "skills-shared"
    _write_skill(shared, "docx-editing", "productivity")
    (eng / "config.yaml").write_text(yaml.safe_dump({"skills": {"disabled": ["docx-editing"]}}), encoding="utf-8")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: root)
    from agent.skill_utils import _external_dirs_cache_clear

    _external_dirs_cache_clear()
    return {"default": default, "hr": hr, "engineers": eng, "shared": shared}


@pytest.fixture
def cache_clears(monkeypatch):
    from hermes_cli import web_server

    calls = []
    monkeypatch.setattr(web_server, "_clear_skills_prompt_cache", lambda: calls.append(1))
    return calls


@pytest.fixture
def audits(monkeypatch):
    from hermes_cli.dashboard_auth import audit

    events = []
    monkeypatch.setattr(audit, "audit_log", lambda event, **f: events.append((event.value, f)))
    return events


@pytest.fixture
def client(monkeypatch, homes, cache_clears, audits):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _library(client):
    resp = client.get("/api/skills/library")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    return data, {s["name"]: s for s in data["skills"]}


def _used(entry):
    return {u["profile"]: u["enabled"] for u in entry["used_by"]}


def test_library_lists_every_skill_once_with_source_and_used_by(client):
    data, skills = _library(client)
    assert data["profiles"] == ["default", "engineers", "hr"]
    assert skills["google-workspace"]["source"] == "builtin"
    assert _used(skills["google-workspace"]) == {"default": True, "hr": True}
    assert skills["linear"]["source"] == "hub"
    assert skills["linear"]["trust_level"] == "trusted"
    assert skills["leave-policy-hk"]["source"] == "profile"
    assert skills["leave-policy-hk"]["owners"] == ["hr"]
    assert skills["docx-editing"]["source"] == "shared"
    assert _used(skills["docx-editing"]) == {"default": True, "engineers": False, "hr": True}
    assert "path" not in json.dumps(data)


def test_remove_turns_off_for_one_profile_and_keeps_the_file(client, homes, cache_clears, audits):
    resp = client.post("/api/skills/library/remove", json={"target": "hr", "name": "google-workspace"})
    assert resp.status_code == 200, resp.text
    assert "google-workspace" in _disabled(homes["hr"])
    assert (homes["hr"] / "skills" / "productivity" / "google-workspace" / "SKILL.md").exists()
    assert _disabled(homes["default"]) == set()
    assert cache_clears and audits[-1][0] == "skill_profile_removed"
    assert audits[-1][1]["profile"] == "hr" and audits[-1][1]["skill"] == "google-workspace"
    _, skills = _library(client)
    assert _used(skills["google-workspace"]) == {"default": True, "hr": False}


def test_add_turns_a_shared_skill_back_on(client, homes):
    resp = client.post("/api/skills/library/add", json={"target": "engineers", "name": "docx-editing"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["copied"] is None
    assert "docx-editing" not in _disabled(homes["engineers"])


def test_add_builtin_to_a_profile_without_it_copies_and_keeps_its_source(client, homes):
    resp = client.post("/api/skills/library/add", json={"target": "engineers", "name": "google-workspace"})
    assert resp.status_code == 200, resp.text
    assert (homes["engineers"] / "skills" / "productivity" / "google-workspace" / "SKILL.md").exists()
    assert "google-workspace:abc123" in (homes["engineers"] / "skills" / ".bundled_manifest").read_text()
    _, skills = _library(client)
    assert skills["google-workspace"]["source"] == "builtin"
    assert _used(skills["google-workspace"])["engineers"] is True


def test_add_hub_skill_copies_its_lock_entry(client, homes):
    resp = client.post("/api/skills/library/add", json={"target": "hr", "name": "linear"})
    assert resp.status_code == 200, resp.text
    lock = json.loads((homes["hr"] / "skills" / ".hub" / "lock.json").read_text())
    assert lock["installed"]["linear"]["trust_level"] == "trusted"


def test_profile_only_skill_needs_a_copy_choice(client, homes):
    resp = client.post("/api/skills/library/add", json={"target": "engineers", "name": "leave-policy-hk"})
    assert resp.status_code == 409
    assert not (homes["engineers"] / "skills" / "hr").exists()


def test_copy_only_into_this_profile_leaves_the_owner_alone(client, homes, audits):
    resp = client.post(
        "/api/skills/library/add",
        json={"target": "engineers", "name": "leave-policy-hk", "where": "only"},
    )
    assert resp.status_code == 200, resp.text
    assert (homes["engineers"] / "skills" / "hr" / "leave-policy-hk" / "SKILL.md").exists()
    assert (homes["hr"] / "skills" / "hr" / "leave-policy-hk" / "SKILL.md").exists()
    assert not (homes["shared"] / "hr").exists()
    assert audits[-1][1]["copied"] == "only"
    _, skills = _library(client)
    assert skills["leave-policy-hk"]["owners"] == ["engineers", "hr"]
    assert "default" not in _used(skills["leave-policy-hk"])


def test_copy_into_shared_library_moves_it_for_every_profile(client, homes):
    resp = client.post(
        "/api/skills/library/add",
        json={"target": "engineers", "name": "leave-policy-hk", "where": "shared"},
    )
    assert resp.status_code == 200, resp.text
    assert (homes["shared"] / "hr" / "leave-policy-hk" / "SKILL.md").exists()
    assert not (homes["hr"] / "skills" / "hr" / "leave-policy-hk").exists()
    _, skills = _library(client)
    entry = skills["leave-policy-hk"]
    assert entry["source"] == "shared"
    used = _used(entry)
    assert used["engineers"] is True and used["hr"] is True


def test_delete_only_for_a_profiles_own_skill(client, homes, audits):
    for name in ("google-workspace", "docx-editing"):
        resp = client.post("/api/skills/library/delete", json={"target": "hr", "name": name})
        assert resp.status_code in (404, 409), resp.text
    assert (homes["hr"] / "skills" / "productivity" / "google-workspace").exists()
    assert (homes["shared"] / "productivity" / "docx-editing").exists()

    resp = client.post("/api/skills/library/delete", json={"target": "hr", "name": "leave-policy-hk"})
    assert resp.status_code == 200, resp.text
    assert not (homes["hr"] / "skills" / "hr" / "leave-policy-hk").exists()
    assert audits[-1][0] == "skill_profile_deleted"
    _, skills = _library(client)
    assert "leave-policy-hk" not in skills


def test_unknown_profile_or_skill_is_refused(client):
    assert client.post("/api/skills/library/add", json={"target": "nope", "name": "linear"}).status_code == 404
    assert client.post("/api/skills/library/add", json={"target": "hr", "name": "nope"}).status_code == 404
    assert client.post("/api/skills/library/remove", json={"target": "default", "name": "linear"}).status_code == 404


def test_library_routes_refuse_a_profile_query(client):
    resp = client.get("/api/skills/library", params={"profile": "hr"})
    assert resp.status_code == 400
