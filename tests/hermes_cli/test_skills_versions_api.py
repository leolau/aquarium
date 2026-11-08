"""HTTP tests for /api/skills/versions (C-2) and the dashboard write hooks."""

import pytest

SKILL_MD = """---
name: {name}
description: a test skill
---

# {name}

{body}
"""


def _md(name, body="Do the thing."):
    return SKILL_MD.format(name=name, body=body)


@pytest.fixture
def homes(monkeypatch, _isolate_hermes_home):
    from hermes_constants import get_hermes_home
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker_home = profiles_root / "worker_alpha"
    for home, name in ((default_home, "dash-skill"), (worker_home, "worker-skill")):
        d = home / "skills" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(_md(name), encoding="utf-8")
        (home / "config.yaml").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)
    return {"default": default_home, "worker_alpha": worker_home}


@pytest.fixture
def client(monkeypatch, homes):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_routes_are_admin_only():
    from hermes_cli.route_roles import ADMIN
    from hermes_cli.skills_versions_api import router

    assert {r.path for r in router.routes} == {
        "/api/skills/versions",
        "/api/skills/versions/detail",
        "/api/skills/versions/diff",
        "/api/skills/versions/draft",
        "/api/skills/versions/activate",
    }
    for route in router.routes:
        assert [d.dependency for d in route.dependencies] == [d.dependency for d in ADMIN]


def test_full_lifecycle(client, homes):
    r = client.get("/api/skills/versions", params={"name": "dash-skill"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "dash-skill" and body["active"] == "v1"
    assert [v["source"] for v in body["versions"]] == ["baseline"]

    r = client.post("/api/skills/versions/draft", json={
        "name": "dash-skill", "content": _md("dash-skill", "Better."), "message": "try",
    })
    assert r.status_code == 200, r.text
    draft = r.json()
    assert draft["status"] == "draft" and draft["source"] == "improve"
    assert draft["author"].startswith("user:") and draft["message"] == "try"
    live = homes["default"] / "skills" / "dash-skill" / "SKILL.md"
    assert "Better." not in live.read_text()

    r = client.get("/api/skills/versions/detail", params={"name": "dash-skill", "id": draft["id"]})
    assert r.status_code == 200
    detail = r.json()
    assert set(detail) == {"meta", "content", "files"}
    assert "Better." in detail["content"]
    assert detail["files"] == [{"path": "SKILL.md", "size": len(detail["content"].encode())}]

    r = client.get("/api/skills/versions/diff", params={"name": "dash-skill", "a": "v1", "b": draft["id"]})
    assert r.status_code == 200
    assert r.json()["a"] == "v1" and "+Better." in r.json()["diff"]

    r = client.post("/api/skills/versions/activate", json={"name": "dash-skill", "id": draft["id"], "trial": True})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["active"] == draft["id"]
    assert {v["id"]: v for v in res["versions"]}[draft["id"]]["trial_of"] == "v1"
    assert "Better." in live.read_text()

    r = client.get("/api/skills/content", params={"name": "dash-skill"})
    assert "Better." in r.json()["content"]

    r = client.post("/api/skills/versions/activate", json={"name": "dash-skill", "id": "v1"})
    assert r.status_code == 200 and r.json()["active"] == "v1"
    assert "Do the thing." in live.read_text()

    text = str(client.get("/api/skills/versions", params={"name": "dash-skill"}).json())
    assert str(homes["default"]) not in text


def test_dashboard_create_and_edit_are_versioned(client, homes):
    r = client.post("/api/skills", json={"name": "new-skill", "content": _md("new-skill")})
    assert r.status_code == 200, r.text
    r = client.put("/api/skills/content", json={"name": "new-skill", "content": _md("new-skill", "v2 body")})
    assert r.status_code == 200, r.text
    versions = client.get("/api/skills/versions", params={"name": "new-skill"}).json()["versions"]
    assert [v["source"] for v in versions] == ["create", "edit"]
    assert all(v["author"].startswith("user:") for v in versions)

    r = client.put("/api/skills/content", json={"name": "dash-skill", "content": _md("dash-skill", "edited")})
    assert r.status_code == 200
    versions = client.get("/api/skills/versions", params={"name": "dash-skill"}).json()["versions"]
    assert [v["source"] for v in versions] == ["baseline", "edit"]


def test_profile_isolation(client, homes):
    r = client.get("/api/skills/versions", params={"name": "worker-skill", "profile": "worker_alpha"})
    assert r.status_code == 200 and r.json()["active"] == "v1"
    assert (homes["worker_alpha"] / "skills" / ".versions" / "worker-skill").is_dir()
    assert not (homes["default"] / "skills" / ".versions" / "worker-skill").exists()
    r = client.get("/api/skills/versions", params={"name": "worker-skill"})
    assert r.status_code == 404

    r = client.post("/api/skills/versions/draft", json={
        "name": "worker-skill", "content": _md("worker-skill", "w"), "profile": "worker_alpha",
    })
    assert r.status_code == 200
    r = client.post("/api/skills/versions/activate", json={
        "name": "worker-skill", "id": r.json()["id"], "profile": "worker_alpha",
    })
    assert r.status_code == 200
    assert "\nw\n" in (homes["worker_alpha"] / "skills" / "worker-skill" / "SKILL.md").read_text()


@pytest.mark.parametrize("params", [
    {"name": "../etc", "id": "v1"},
    {"name": "dash-skill", "id": "../../x"},
    {"name": ".versions", "id": "v1"},
])
def test_bad_input_is_400(client, params):
    assert client.get("/api/skills/versions/detail", params=params).status_code == 400


def test_unknown_is_404(client):
    assert client.get("/api/skills/versions", params={"name": "ghost"}).status_code == 404
    assert client.get("/api/skills/versions/detail", params={"name": "dash-skill", "id": "v9"}).status_code == 404
    r = client.post("/api/skills/versions/activate", json={"name": "dash-skill", "id": "v9"})
    assert r.status_code == 404
    r = client.post("/api/skills/versions/draft", json={"name": "dash-skill", "content": "nope"})
    assert r.status_code == 400


def test_store_hidden_from_skill_list_and_details(client):
    client.post("/api/skills/versions/draft", json={"name": "dash-skill", "content": _md("dash-skill", "x")})
    r = client.get("/api/skills")
    assert r.status_code == 200
    names = [s["name"] for s in r.json()] if isinstance(r.json(), list) else [s["name"] for s in r.json()["skills"]]
    assert names.count("dash-skill") == 1
