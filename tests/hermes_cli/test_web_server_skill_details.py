"""GET /api/skills/details — side facts for the agent-home skill page.

Pins: files are listed relative to the skill folder (never an absolute path),
hidden/cache files are skipped, ``modified_at`` is SKILL.md's mtime, and
``used_by`` lists every profile that has the skill with its enabled state.
"""
import pytest
import yaml

SKILL_MD = "---\nname: {name}\ndescription: a test skill\n---\n\n# {name}\n\nDo the thing.\n"


def _write_skill(skills_dir, name, category=None):
    d = skills_dir / category / name if category else skills_dir / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(SKILL_MD.format(name=name), encoding="utf-8")
    return d


@pytest.fixture
def homes(tmp_path, monkeypatch, _isolate_hermes_home):
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker = profiles_root / "worker_alpha"
    other = profiles_root / "other_beta"
    for home in (default_home, worker, other):
        (home / "skills").mkdir(parents=True, exist_ok=True)
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")

    skill = _write_skill(default_home / "skills", "shared-skill", category="productivity")
    (skill / "references").mkdir()
    (skill / "references" / "notes.md").write_text("x" * 42, encoding="utf-8")
    (skill / "scripts").mkdir()
    (skill / "scripts" / "run.py").write_text("print(1)\n", encoding="utf-8")
    (skill / ".hidden").write_text("secret", encoding="utf-8")
    (skill / "__pycache__").mkdir()
    (skill / "__pycache__" / "run.cpython-312.pyc").write_bytes(b"\0")

    _write_skill(worker / "skills", "shared-skill")
    (worker / "config.yaml").write_text(
        yaml.safe_dump({"skills": {"disabled": ["shared-skill"]}}), encoding="utf-8"
    )
    _write_skill(other / "skills", "unrelated-skill")

    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": worker, "skill_dir": skill}


@pytest.fixture
def client(monkeypatch, homes):
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


def test_details_lists_relative_files_and_used_by(client, homes):
    resp = client.get("/api/skills/details", params={"name": "shared-skill"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "shared-skill"
    paths = [f["path"] for f in data["files"]]
    assert paths == ["SKILL.md", "references/notes.md", "scripts/run.py"]
    assert {f["path"]: f["size"] for f in data["files"]}["references/notes.md"] == 42
    assert data["files_truncated"] is False
    mtime = (homes["skill_dir"] / "SKILL.md").stat().st_mtime
    assert data["modified_at"] == pytest.approx(mtime)
    assert data["used_by"] == [
        {"profile": "default", "enabled": True},
        {"profile": "worker_alpha", "enabled": False},
    ]


def test_details_never_leak_filesystem_paths(client, homes):
    text = client.get("/api/skills/details", params={"name": "shared-skill"}).text
    assert str(homes["default"]) not in text
    assert str(homes["skill_dir"]) not in text
    assert "secret" not in text and ".hidden" not in text and "__pycache__" not in text


def test_details_scope_to_requested_profile(client, homes):
    resp = client.get(
        "/api/skills/details", params={"name": "shared-skill", "profile": "worker_alpha"}
    )
    assert resp.status_code == 200
    assert [f["path"] for f in resp.json()["files"]] == ["SKILL.md"]


def test_details_unknown_skill_is_404(client):
    resp = client.get("/api/skills/details", params={"name": "nope-skill"})
    assert resp.status_code == 404


def test_details_unknown_profile_is_404(client):
    resp = client.get(
        "/api/skills/details", params={"name": "shared-skill", "profile": "ghost"}
    )
    assert resp.status_code == 404


def test_details_files_are_capped(client, homes, monkeypatch):
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_SKILL_DETAILS_MAX_FILES", 2)
    data = client.get("/api/skills/details", params={"name": "shared-skill"}).json()
    assert len(data["files"]) == 2
    assert data["files_truncated"] is True
