"""End-to-end tests for the skill improve chat routes.

Real ``SessionDB`` under a throwaway ``HERMES_HOME``, the real skill on disk,
the real shared one-brain builder (``gateway.session_chat``) and a real
``AIAgent``. Only three things are faked: the principal store (Postgres), the
model call (``AIAgent.run_conversation``) and the two sibling Skills Lab
modules (usage ledger, version store), which may not be installed.
"""

from __future__ import annotations

import sys
import types
from types import SimpleNamespace

import pytest

SKILL = "pdf-tidy"
SKILL_MD = (
    "---\nname: pdf-tidy\ndescription: Tidy PDFs.\n---\n\n# PDF tidy\n\n"
    "Run this:\n\n```bash\nqpdf --linearize in.pdf out.pdf\n```\n"
)
DRAFT = (
    "---\nname: pdf-tidy\ndescription: Tidy PDFs safely.\n---\n\n# PDF tidy v2\n\n"
    "```bash\nqpdf --linearize --check in.pdf out.pdf\n```\n"
)


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_constants
    import hermes_state

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    skill_dir = tmp_path / "skills" / "docs" / SKILL
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    return tmp_path


@pytest.fixture
def who():
    return {"p": SimpleNamespace(user_id="u-admin", display="Ada", role="admin", is_owner=False)}


@pytest.fixture
def client(monkeypatch, who):
    try:
        from starlette.testclient import TestClient
    except ImportError:  # pragma: no cover
        pytest.skip("fastapi/starlette not installed")
    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    async def _principal(request, profile=None):
        return who["p"]

    monkeypatch.setattr(web_server, "_chat_principal", _principal)
    monkeypatch.setattr(web_server, "_agent_home_trace", lambda p, s: (None, None))
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def siblings(monkeypatch):
    """Small stand-ins for the usage ledger and version store."""
    versions = types.ModuleType("tools.skill_versions")
    versions.calls = []
    versions.ensure_baseline = lambda name: versions.calls.append(("baseline", name))
    versions.current_version_id = lambda name: "v2"
    versions.list_versions = lambda name: [
        {"id": "v1", "n": 1, "created_at": 1_700_000_000, "author": "system",
         "message": "baseline", "source": "baseline", "status": "archived"},
        {"id": "v2", "n": 2, "created_at": 1_700_086_400, "author": "user:u-admin",
         "message": "add qpdf step", "source": "edit", "status": "active"},
    ]
    ledger = types.ModuleType("hermes_cli.skill_ledger")
    ledger.summary = lambda *, days=90, name=None: [
        {"name": "other", "uses": 99},
        {"name": SKILL, "uses": 7, "sessions": 3, "tasks": 4, "projects": 1, "success": 4,
         "partial": 1, "failure": 2, "unknown": 0, "success_rate": 4 / 7},
    ]
    ledger.events = lambda name, *, days=90, limit=50, cursor=None: {"events": [
        {"id": 1, "ts": 1_700_100_000, "trigger": "slash", "outcome": "success", "rating": 1},
        {"id": 2, "ts": 1_700_200_000, "trigger": "cron", "version_id": "v2",
         "outcome": "failure", "note": "qpdf missing on worker"},
        {"id": 3, "ts": 1_700_300_000, "trigger": "skill_view", "outcome": None,
         "rating": -1, "note": "output lost bookmarks"},
    ], "next_cursor": None}
    monkeypatch.setitem(sys.modules, "tools.skill_versions", versions)
    monkeypatch.setitem(sys.modules, "hermes_cli.skill_ledger", ledger)
    return SimpleNamespace(versions=versions, ledger=ledger)


@pytest.fixture
def model(monkeypatch):
    """Replace only the model call; record what the real agent was built with."""
    import run_agent

    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test-not-used")
    state = {"turns": [], "replies": []}

    def _run_conversation(self, user_message, conversation_history=None, task_id=None, **kw):
        state["turns"].append({
            "user_message": user_message,
            "history": list(conversation_history or []),
            "tools": sorted(t["function"]["name"] for t in self.tools or []),
            "valid": set(self.valid_tool_names),
            "trusted_local": self._trusted_local,
            "user_id": self._internal_user_id,
            "role": self._internal_user_role,
            "skip_refresh": getattr(self, "_skip_mcp_refresh", False),
        })
        reply = state["replies"].pop(0) if state["replies"] else "ok"
        self._session_db.append_message(task_id, "user", user_message)
        self._session_db.append_message(task_id, "assistant", reply)
        return {"final_response": reply, "session_id": task_id}

    monkeypatch.setattr(run_agent.AIAgent, "run_conversation", _run_conversation)
    return state


def _db():
    from hermes_state import SessionDB

    return SessionDB()


def test_improve_chat_end_to_end(client, siblings, model, home):
    r = client.post("/api/skills/improve/start", json={"name": SKILL, "goal": "fewer failures"})
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]
    assert set(r.json()) == {"session_id"}

    db = _db()
    try:
        row = db.get_session(sid)
        assert row["title"] == f"Improve skill: {SKILL}"
        assert db.session_owner_user_id(sid) == "u-admin"
        assert [t["name"] for t in db.get_session_tags(sid)] == [f"skill-improve:{SKILL}"]
    finally:
        db.close()
    assert ("baseline", SKILL) in siblings.versions.calls

    model["replies"] = ["What fails most?"]
    r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "hi"})
    assert r.status_code == 200, r.text
    assert r.json()["reply"] == "What fails most?"
    assert "draft" not in r.json()

    first = model["turns"][0]
    seed = first["user_message"]
    assert first["history"] == []
    assert SKILL_MD.strip() in seed
    assert "fewer failures" in seed
    assert "v2 (active)" in seed and "add qpdf step" in seed and "v1 [archived]" in seed
    assert "7 uses" in seed and "success rate 57%" in seed
    assert "qpdf missing on worker" in seed and "output lost bookmarks" in seed
    assert "```skill-draft" in seed or "````skill-draft" in seed
    assert seed.rstrip().endswith("hi")
    assert str(home) not in seed

    # Runs as the caller, untrusted, with nothing that can write.
    assert first["trusted_local"] is False
    assert (first["user_id"], first["role"]) == ("u-admin", "admin")
    assert first["skip_refresh"] is True
    for tool in ("skill_manage", "write_file", "patch", "terminal", "execute_code", "delegate_task"):
        assert tool not in first["valid"] and tool not in first["tools"]
    assert first["valid"] == set(first["tools"])
    assert "skill_view" in first["valid"] and "read_file" in first["valid"]

    model["replies"] = [f"Here it is:\n\n```skill-draft\n{DRAFT}```\n\nWant changes?"]
    r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "go"})
    assert r.status_code == 200, r.text
    assert r.json()["draft"] == DRAFT

    second = model["turns"][1]
    # Later turns: plain user text, the seeded turn replayed verbatim from the
    # transcript, and the same tool set (stable prefix for the cache).
    assert second["user_message"] == "go"
    assert [m["role"] for m in second["history"]] == ["user", "assistant"]
    assert second["history"][0]["content"] == seed
    assert second["tools"] == first["tools"]

    r = client.get("/api/skills/improve/sessions", params={"name": SKILL})
    assert r.status_code == 200, r.text
    assert r.json() == [{
        "session_id": sid,
        "title": f"Improve skill: {SKILL}",
        "started_at": r.json()[0]["started_at"],
        "drafts": 1,
    }]
    assert isinstance(r.json()[0]["started_at"], (int, float))

    live = home / "skills" / "docs" / SKILL / "SKILL.md"
    assert live.read_text(encoding="utf-8") == SKILL_MD


def test_missing_sibling_modules_leave_empty_sections(client, model, monkeypatch):
    monkeypatch.setitem(sys.modules, "tools.skill_versions", None)
    monkeypatch.setitem(sys.modules, "hermes_cli.skill_ledger", None)
    sid = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "hi"})
    assert r.status_code == 200, r.text
    seed = model["turns"][0]["user_message"]
    assert SKILL_MD.strip() in seed
    assert seed.count("(none recorded)") == 2 and "(no usage recorded)" in seed


def test_failing_sibling_modules_do_not_break_start(client, model, monkeypatch):
    broken = types.ModuleType("tools.skill_versions")

    def _boom(*a, **k):
        raise RuntimeError("store unavailable")

    broken.ensure_baseline = broken.list_versions = broken.current_version_id = _boom
    monkeypatch.setitem(sys.modules, "tools.skill_versions", broken)
    monkeypatch.setitem(sys.modules, "hermes_cli.skill_ledger", None)
    r = client.post("/api/skills/improve/start", json={"name": SKILL})
    assert r.status_code == 200, r.text


def test_sessions_are_listed_per_skill_and_per_owner(client, siblings, model, home):
    other = home / "skills" / "other-skill"
    other.mkdir(parents=True)
    (other / "SKILL.md").write_text("---\nname: other-skill\ndescription: x\n---\nbody\n")

    a1 = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    a2 = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    client.post("/api/skills/improve/start", json={"name": "other-skill"})

    rows = client.get("/api/skills/improve/sessions", params={"name": SKILL}).json()
    assert {r["session_id"] for r in rows} == {a1, a2}
    assert len({r["title"] for r in rows}) == 2
    assert all(r["drafts"] == 0 for r in rows)

    # A signed-in login is scoped to the improve chats it owns.
    from hermes_cli.skills_improve_api import _list_sessions_sync

    assert _list_sessions_sync(SKILL, None, "u-other") == []
    assert {r["session_id"] for r in _list_sessions_sync(SKILL, None, "u-admin")} == {a1, a2}


def test_message_rejects_unknown_and_non_improve_sessions(client, model):
    db = _db()
    try:
        db.ensure_session("plainchat", source="agent_home", user_id="u-admin")
    finally:
        db.close()
    for sid in ("plainchat", "skillimp_1_deadbeef", "../etc"):
        r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "hi"})
        assert r.status_code == 404, (sid, r.text)
    assert model["turns"] == []


def test_message_requires_access_to_the_session(client, model, monkeypatch, who):
    from hermes_cli import web_server

    sid = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    monkeypatch.setattr(web_server, "_chat_scope_for", lambda p: p.user_id)
    who["p"] = SimpleNamespace(user_id="u-other", display="Bo", role="admin", is_owner=False)
    r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "hi"})
    assert r.status_code == 404
    assert model["turns"] == []


@pytest.mark.parametrize("body,status", [
    ({"name": "missing-skill"}, 404),
    ({"name": "../secrets"}, 400),
    ({}, 400),
])
def test_start_validates_the_skill(client, body, status):
    r = client.post("/api/skills/improve/start", json=body)
    assert r.status_code == status


def test_message_validates_text(client):
    sid = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    r = client.post("/api/skills/improve/message", json={"session_id": sid, "text": "  "})
    assert r.status_code == 400


def test_routes_follow_the_lab_permission():
    from hermes_cli.route_roles import declared_role
    from hermes_cli.web_server import app

    paths = {"/api/skills/improve/start", "/api/skills/improve/message", "/api/skills/improve/sessions"}
    found = {r.path: r for r in app.routes if getattr(r, "path", None) in paths}
    assert set(found) == paths
    assert all(declared_role(r) == "skills:lab" for r in found.values())


# ── Draft extraction ─────────────────────────────────────────────────────────


def test_extract_draft_keeps_nested_code_blocks():
    from hermes_cli.skills_improve_api import extract_draft

    text = f"intro\n```skill-draft\n{DRAFT}```\nafter"
    assert extract_draft(text) == DRAFT


def test_extract_draft_takes_the_last_complete_block():
    from hermes_cli.skills_improve_api import extract_draft

    text = (
        "```skill-draft\nold\n```\n"
        "```python\nprint(1)\n```\n"
        "````skill-draft\nnew\n```bash\nls\n```\n````\n"
        "```skill-draft\nunterminated\n"
    )
    assert extract_draft(text) == "new\n```bash\nls\n```\n"


@pytest.mark.parametrize("text", [None, "", "no fences", "```markdown\nx\n```", "```skill-draft\n\n```"])
def test_extract_draft_none(text):
    from hermes_cli.skills_improve_api import extract_draft

    assert extract_draft(text) is None


def test_seed_fence_survives_skill_with_code_blocks():
    from hermes_cli.skills_improve_api import build_seed, extract_draft

    seed = build_seed(name=SKILL, content=SKILL_MD, goal=None,
                      versions={"active": None, "versions": []},
                      usage={"summary": None, "concerns": []})
    assert "````markdown\n" in seed and "````skill-draft" in seed
    assert extract_draft(seed) is None


def test_draft_saved_from_improve_chat_is_credited_to_the_agent(client, monkeypatch, who, home):
    from hermes_cli import web_server

    sid = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    other = client.post("/api/skills/improve/start", json={"name": "other-skill"})
    r = client.post("/api/skills/versions/draft", json={
        "name": SKILL, "content": DRAFT, "message": "from chat", "session_id": sid,
    })
    assert r.status_code == 200, r.text
    assert (r.json()["author"], r.json()["source"], r.json()["status"]) == (f"agent:{sid}", "improve", "draft")
    assert (home / "skills" / "docs" / SKILL / "SKILL.md").read_text(encoding="utf-8") == SKILL_MD

    r = client.post("/api/skills/versions/draft", json={"name": SKILL, "content": DRAFT})
    assert r.status_code == 200 and r.json()["author"].startswith("user:")

    bad = ["skillimp_1_deadbeef", "../etc"]
    if other.status_code == 200:
        bad.append(other.json()["session_id"])
    for bogus in bad:
        r = client.post("/api/skills/versions/draft", json={"name": SKILL, "content": DRAFT, "session_id": bogus})
        assert r.status_code == 404, (bogus, r.text)

    monkeypatch.setattr(web_server, "_chat_scope_for", lambda p: p.user_id)
    who["p"] = SimpleNamespace(user_id="u-other", display="Bo", role="admin", is_owner=False)
    r = client.post("/api/skills/versions/draft", json={"name": SKILL, "content": DRAFT, "session_id": sid})
    assert r.status_code == 404


# ── Project-scoped improve (Part B3) ─────────────────────────────────────────

PROJECT = "site-relaunch"
FOREIGN = "secret-deal"


@pytest.fixture
def projects(tmp_path, monkeypatch, who):
    """Real projects DB: one readable project, one the caller can't read."""
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    from hermes_cli import projects_api, projects_db

    async def _principal(request):
        return who["p"]

    async def _enrolled(user_id):
        return set()

    monkeypatch.setattr(projects_api, "_principal_read", _principal)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    with projects_db.connect_closing() as conn:
        mine = projects_db.create_project(
            conn, name="Site relaunch", slug=PROJECT, goal="Ship the new site",
            description="Marketing site rebuild.", owner_user_id="u-admin",
        )
        projects_db.create_project(
            conn, name="Secret deal", slug=FOREIGN, owner_user_id="u-someone-else",
        )
    return mine


@pytest.fixture
def project_ledger(siblings, monkeypatch):
    """Uses in this project, in a foreign project and outside projects."""
    from hermes_cli import skills_usage_api

    def _ev(i, slug, outcome, task=None, note=None, rating=None):
        return {"id": i, "ts": 1_700_000_000 + i * 1000, "project_slug": slug, "outcome": outcome,
                "kanban_board": "main" if task else None, "kanban_task_id": task,
                "session_id": f"s{i}", "trigger": "card" if task else "slash", "note": note,
                "rating": rating}

    events = [
        _ev(9, PROJECT, "failure", "t-hero", note="hero image upload failed"),
        _ev(8, FOREIGN, "failure", "t-merger", note="merger memo leaked"),
        _ev(7, None, "success"),
        _ev(6, PROJECT, "success", "t-footer"),
        _ev(5, FOREIGN, "success", "t-board"),
        _ev(4, None, "partial", note="chat note"),
    ]
    titles = {("main", "t-hero"): "Hero banner PDF", ("main", "t-footer"): "Footer legal PDF",
              ("main", "t-merger"): "Acme merger memo", ("main", "t-board"): "Board pack"}
    siblings.ledger.events = lambda name, *, days=90, limit=50, cursor=None: {
        "events": events, "next_cursor": None}
    siblings.ledger.summary = lambda *, days=90, name=None: [
        {"name": SKILL, "uses": 6, "sessions": 6, "tasks": 4, "projects": 2, "success": 3,
         "partial": 1, "failure": 2, "unknown": 0, "success_rate": 0.5},
    ]
    seen = []

    def _titles(rows):
        seen.extend(rows)
        return {k: v for k, v in titles.items() if any(
            (r["kanban_board"], r["kanban_task_id"]) == k for r in rows)}

    monkeypatch.setattr(skills_usage_api, "_task_titles", _titles)
    return SimpleNamespace(events=events, seen=seen)


def _seed(sid):
    from hermes_cli.skills_improve_api import _read_seed

    return _read_seed(sid, None)


def test_project_seed_puts_this_projects_runs_first(client, projects, project_ledger, model):
    r = client.post("/api/skills/improve/start", json={"name": SKILL, "project": PROJECT})
    assert r.status_code == 200, r.text
    sid = r.json()["session_id"]
    seed = _seed(sid)
    assert seed["project"] == PROJECT
    text = seed["seed"]

    assert "## This project" in text and "Site relaunch" in text
    assert "Ship the new site" in text and "Marketing site rebuild." in text
    assert 'card "Hero banner PDF"' in text and 'card "Footer legal PDF"' in text
    assert "hero image upload failed" in text
    assert text.index("## This project") < text.index("## Usage in this project")
    assert "keep every change safe" in text.lower()

    # Other uses only as numbers: no foreign project's slug, titles or notes.
    elsewhere = text[text.index("## Usage elsewhere"):]
    assert "4 uses outside this project: 2 in 1 other projects, 2 in chats" in elsewhere
    for leaked in (FOREIGN, "Secret deal", "Acme merger memo", "Board pack",
                   "merger memo leaked", "chat note"):
        assert leaked not in text
    assert all(r["kanban_task_id"] in {"t-hero", "t-footer"} for r in project_ledger.seen)

    # Seed is still the one-time first-turn prefix (cache-safe).
    client.post("/api/skills/improve/message", json={"session_id": sid, "text": "why?"})
    client.post("/api/skills/improve/message", json={"session_id": sid, "text": "and?"})
    assert model["turns"][0]["user_message"].startswith(text)
    assert "## This project" not in model["turns"][1]["user_message"]


def test_project_seed_prefers_the_ledgers_project_rollup(client, projects, project_ledger, siblings):
    def summary(*, days=90, name=None, project=None):
        if project:
            return [{"name": SKILL, "uses": 40, "success": 30, "partial": 5, "failure": 5,
                     "unknown": 0, "sessions": 9, "tasks": 12, "projects": 1}]
        return [{"name": SKILL, "uses": 50, "success": 35, "partial": 5, "failure": 10,
                 "unknown": 0, "projects": 3}]

    siblings.ledger.summary = summary
    sid = client.post("/api/skills/improve/start",
                      json={"name": SKILL, "project": PROJECT}).json()["session_id"]
    text = _seed(sid)["seed"]
    assert "40 uses" in text
    assert "10 uses outside this project" in text and "in 2 other projects" in text


def test_project_session_is_tagged_and_listed_per_project(client, projects, siblings, model):
    plain = client.post("/api/skills/improve/start", json={"name": SKILL}).json()["session_id"]
    scoped = client.post("/api/skills/improve/start",
                         json={"name": SKILL, "project": PROJECT}).json()["session_id"]
    db = _db()
    try:
        tags = {t["name"] for t in db.get_session_tags(scoped)}
    finally:
        db.close()
    assert {f"skill-improve:{SKILL}", f"skill-improve-project:{PROJECT}"} <= tags

    rows = client.get("/api/skills/improve/sessions", params={"name": SKILL, "project": PROJECT})
    assert rows.status_code == 200
    assert [r["session_id"] for r in rows.json()] == [scoped]
    every = client.get("/api/skills/improve/sessions", params={"name": SKILL}).json()
    assert {r["session_id"] for r in every} == {plain, scoped}


@pytest.mark.parametrize("slug", [FOREIGN, "no-such-project", "../etc"])
def test_unreadable_project_is_404(client, projects, siblings, model, who, slug):
    who["p"] = SimpleNamespace(user_id="u-admin", display="Ada", role="member", is_owner=False)
    r = client.post("/api/skills/improve/start", json={"name": SKILL, "project": slug})
    assert r.status_code == 404
    r = client.get("/api/skills/improve/sessions", params={"name": SKILL, "project": slug})
    assert r.status_code == 404


def test_project_improve_needs_lab_in_the_profile(client, projects, siblings, model, monkeypatch):
    from hermes_cli import web_server
    from tools import skills_access

    viewer = SimpleNamespace(user_id="u-admin", display="Vi", role="viewer", is_owner=False)

    async def _resolve(request, **kw):
        return viewer

    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "sub-viewer")
    monkeypatch.setattr(web_server, "_comms_resolve_principal", _resolve)
    monkeypatch.setattr(skills_access, "allows", lambda role, action, cfg: action != "lab")
    r = client.post("/api/skills/improve/start", json={"name": SKILL, "project": PROJECT})
    assert r.status_code == 403
    r = client.get("/api/skills/improve/sessions", params={"name": SKILL, "project": PROJECT})
    assert r.status_code == 403
