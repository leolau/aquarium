"""End-to-end tests for the "New skill with AI" routes (Skills Lab create).

Real ``SessionDB``, skills tree, version store, projects and kanban DBs under
a throwaway ``HERMES_HOME``, the real one-brain builder and a real ``AIAgent``.
Only the principal store and the model call are faked; the "default" profile
resolves to the temp home.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

DRAFT = (
    "---\nname: digest-tone\ndescription: Keep the Monday digest conversational.\n---\n\n"
    "# Digest tone\n\n1. Read it aloud.\n"
)
_P = "/api/registry/projects"


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    import hermes_constants
    import hermes_state
    from hermes_cli import profiles, web_server

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    monkeypatch.setattr(profiles, "profile_exists", lambda name: name == "default")
    monkeypatch.setattr(profiles, "get_profile_dir", lambda name: tmp_path)
    monkeypatch.setattr(web_server, "_enter_profile_secrets", lambda d: None, raising=False)
    monkeypatch.setattr(web_server, "_cron_profile_home", lambda p: (p, tmp_path))
    (tmp_path / "skills").mkdir(exist_ok=True)
    return tmp_path


@pytest.fixture
def who():
    return {"p": SimpleNamespace(user_id="leo", display="Leo", role="owner", is_owner=True)}


@pytest.fixture
def client(monkeypatch, who):
    from starlette.testclient import TestClient

    from hermes_cli import projects_api, web_server
    from hermes_cli.access import Principal
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    async def _principal(request, profile=None):
        return who["p"]

    async def _resolve(request, *, allow_as=True):
        p = who["p"]
        return Principal(user_id=p.user_id, display=p.display, role=p.role)  # type: ignore[arg-type]

    async def _enrolled(user_id):
        return set()

    async def _subject(request):
        return who["p"].user_id

    monkeypatch.setattr(web_server, "_chat_principal", _principal)
    monkeypatch.setattr(web_server, "_agent_home_trace", lambda p, s: (None, None))
    monkeypatch.setattr(web_server, "_comms_resolve_principal", _resolve, raising=False)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def model(monkeypatch):
    import run_agent

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-not-used")
    state = {"turns": [], "replies": []}

    def _run_conversation(self, user_message, conversation_history=None, task_id=None, **kw):
        state["turns"].append({
            "user_message": user_message,
            "history": list(conversation_history or []),
            "tools": sorted(t["function"]["name"] for t in self.tools or []),
            "skip_refresh": getattr(self, "_skip_mcp_refresh", False),
        })
        reply = state["replies"].pop(0) if state["replies"] else "ok"
        self._session_db.append_message(task_id, "user", user_message)
        self._session_db.append_message(task_id, "assistant", reply)
        return {"final_response": reply, "session_id": task_id}

    monkeypatch.setattr(run_agent.AIAgent, "run_conversation", _run_conversation)
    return state


@pytest.fixture
def project(client):
    from hermes_cli import kanban_db, projects_db

    r = client.post(_P, json={
        "goal": "Ship the Monday digest", "description": "A weekly digest emailed each Monday.",
        "host_profile": "default", "outputs": [{"title": "The Monday digest email"}],
    })
    assert r.status_code == 200, r.text
    proj = r.json()
    with projects_db.connect_closing() as conn:
        p = projects_db.get_project(conn, proj["slug"])
        cand = projects_db.add_skill_candidate(
            conn, project_id=p.id, run_no=1, name="digest-tone", body="Keep it conversational.",
        )
    with kanban_db.connect_closing(board=p.board_slug or None) as bconn:
        done = kanban_db.create_task(bconn, title="Draft the digest", project_id=p.id)
        kanban_db.complete_task(bconn, done, result="Sent; readers liked the casual intro.")
        todo = kanban_db.create_task(bconn, title="Collect links", project_id=p.id)
    return SimpleNamespace(slug=proj["slug"], id=p.id, candidate=cand, done=done, todo=todo)


def _disabled(home):
    from hermes_cli.config import load_config
    from hermes_cli.skills_config import get_disabled_skills

    return get_disabled_skills(load_config())


def test_create_chat_seeds_first_turn_only_and_locks_down(client, model, project):
    r = client.post("/api/skills/create/start", json={
        "profile": "default", "project": project.slug, "goal": "Write the digest in our voice",
        "candidate_id": project.candidate,
    })
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]

    model["replies"] = [f"Here:\n\n````skill-draft\n{DRAFT}````\n", "Tweaked."]
    r = client.post("/api/skills/create/message", json={"profile": "default", "session_id": sid, "text": "go"})
    assert r.status_code == 200, r.text
    assert r.json()["draft"] == DRAFT
    first = model["turns"][0]
    # The seed is the first user turn: project brief, the top done card with
    # its result, the retro candidate and the SKILL.md rules.
    for needle in ("Write the digest in our voice", "Ship the Monday digest", "Draft the digest",
                   "readers liked the casual intro", "Keep it conversational.", "frontmatter"):
        assert needle in first["user_message"]
    assert "Collect links" not in first["user_message"]
    assert first["user_message"].endswith("go")
    assert first["skip_refresh"] is True
    assert not {"write_file", "patch", "terminal", "skill_manage"} & set(first["tools"])

    client.post("/api/skills/create/message", json={"profile": "default", "session_id": sid, "text": "shorter"})
    assert model["turns"][1]["user_message"] == "shorter"


def test_picked_cards_replace_the_top_done_cards(client, model, project):
    r = client.post("/api/skills/create/start", json={
        "profile": "default", "project": project.slug, "card_ids": [project.todo],
    })
    sid = r.json()["session_id"]
    client.post("/api/skills/create/message", json={"profile": "default", "session_id": sid, "text": "go"})
    seed = model["turns"][0]["user_message"]
    assert "Collect links" in seed and "Draft the digest" not in seed


def test_improve_and_create_sessions_do_not_cross(client, model, home):
    skill = home / "skills" / "pdf"
    skill.mkdir()
    (skill / "SKILL.md").write_text("---\nname: pdf\ndescription: d\n---\nx\n")
    imp = client.post("/api/skills/improve/start", json={"name": "pdf"}).json()["session_id"]
    new = client.post("/api/skills/create/start", json={"goal": "tidy CSVs"}).json()["session_id"]
    assert client.post("/api/skills/create/message", json={"session_id": imp, "text": "x"}).status_code == 404
    assert client.post("/api/skills/improve/message", json={"session_id": new, "text": "x"}).status_code == 404


def test_start_needs_something_to_learn_from(client):
    assert client.post("/api/skills/create/start", json={}).status_code == 400
    assert client.post("/api/skills/create/start", json={"card_ids": ["t1"]}).status_code == 400


def test_save_creates_disabled_draft_marks_project_and_candidate(client, model, project, home):
    from hermes_cli import projects_db
    from tools import skill_versions

    sid = client.post("/api/skills/create/start", json={
        "profile": "default", "project": project.slug, "candidate_id": project.candidate,
    }).json()["session_id"]
    r = client.post("/api/skills/create/save", json={
        "profile": "default", "project": project.slug, "session_id": sid,
        "candidate_id": project.candidate, "name": "digest-tone", "category": "writing",
        "content": DRAFT,
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["enabled"] is False and out["created_here"] is True
    assert out["version"]["status"] == "draft" and out["version"]["author"] == f"agent:{sid}"

    assert (home / "skills" / "writing" / "digest-tone" / "SKILL.md").read_text() == DRAFT
    assert "digest-tone" in _disabled(home)
    hist = skill_versions.index_payload("digest-tone")
    assert hist["active"] is None and hist["draft_only"] is True
    assert [v["status"] for v in hist["versions"]] == ["draft"]
    # The project Skills tab's `created_here` reads `project:<slug>` from v1's message.
    assert f"project:{project.slug}" in hist["versions"][0]["message"]
    # Opening the Versions tab (ensure_baseline) must not promote the draft.
    skill_versions.ensure_baseline("digest-tone")
    assert [v["status"] for v in skill_versions.list_versions("digest-tone")] == ["draft"]

    with projects_db.connect_closing() as conn:
        created = projects_db.list_created_skills(conn, project.id)
        cand = projects_db.get_skill_candidate(conn, project.id, project.candidate)
    assert [(c["profile"], c["name"], c["session_id"]) for c in created] == [("default", "digest-tone", sid)]
    assert cand["dismissed_at"]

    # Collision: never clobber.
    again = client.post("/api/skills/create/save", json={"profile": "default", "name": "digest-tone", "content": DRAFT})
    assert again.status_code == 409

    # Preload works for the disabled draft (lead), before it is enabled.
    r = client.patch(f"{_P}/{project.slug}/tools", json={"skills": ["digest-tone"]})
    assert r.status_code == 200, r.text
    assert r.json()["skills"] == ["digest-tone"]

    # Activating v1 from the Versions tab enables the skill.
    vid = hist["versions"][0]["id"]
    r = client.post("/api/skills/versions/activate", json={"name": "digest-tone", "id": vid, "profile": "default"})
    assert r.status_code == 200, r.text
    assert "digest-tone" not in _disabled(home)
    assert skill_versions.index_payload("digest-tone")["active"] == vid


def test_save_rejects_bad_input(client):
    assert client.post("/api/skills/create/save", json={"name": "../x", "content": DRAFT}).status_code == 400
    assert client.post("/api/skills/create/save", json={"name": "ok", "content": ""}).status_code == 400
    bad = client.post("/api/skills/create/save", json={"name": "ok", "content": "no frontmatter"})
    assert bad.status_code == 400
    assert "ok" not in _disabled(None)


def test_unreadable_project_is_404(client, project, who):
    who["p"] = SimpleNamespace(user_id="mallory", display="M", role="member", is_owner=False)
    r = client.post("/api/skills/create/start", json={"profile": "default", "project": project.slug, "goal": "x"})
    assert r.status_code == 404
    r = client.post("/api/skills/create/save", json={
        "profile": "default", "project": project.slug, "name": "x-skill", "content": DRAFT,
    })
    assert r.status_code == 404


def test_create_routes_need_lab():
    from hermes_cli.route_roles import declared_role
    from hermes_cli.web_server import app

    paths = {"/api/skills/create/start", "/api/skills/create/message", "/api/skills/create/save"}
    found = {r.path: r for r in app.routes if getattr(r, "path", None) in paths}
    assert set(found) == paths
    assert all(declared_role(r) == "skills:lab" for r in found.values())
