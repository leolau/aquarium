"""FG-34 capability cards (contract C-1) and the assignable-profiles route (C-2).

Behaviour contracts: a card is built from the profile's real files and the
board's ``task_runs``; a broken or missing profile degrades to empty fields;
the access set follows decision 1; the prompt block is bounded and stable.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, profile_capabilities as pc, profiles, projects_api, projects_db
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER_P = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]

NOW = 1_800_000_000
DAY = 86400


def _make_profile(name, *, description="", auto=False, skills=(), model=None, toolsets=None):
    home = profiles.get_profile_dir(name)
    home.mkdir(parents=True, exist_ok=True)
    if description:
        (home / "profile.yaml").write_text(
            yaml.safe_dump({"description": description, "description_auto": auto})
        )
    cfg = {}
    if model:
        cfg["model"] = {"default": model, "provider": "openrouter"}
    if toolsets is not None:
        cfg["platform_toolsets"] = {"cli": list(toolsets)}
    if cfg:
        (home / "config.yaml").write_text(yaml.safe_dump(cfg))
    for skill in skills:
        d = home / "skills" / skill
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(f"---\nname: {skill.split('/')[-1]}\n---\n")
    return home


@pytest.fixture
def board(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    with kanban_db.connect_closing() as conn:
        yield conn


def _run(conn, profile, outcome, ended_at, title="card"):
    task_id = f"t{conn.execute('SELECT COUNT(*) FROM tasks').fetchone()[0] + 1}"
    conn.execute(
        "INSERT INTO tasks (id, title, status, created_at) VALUES (?, ?, 'done', ?)",
        (task_id, title, ended_at),
    )
    conn.execute(
        "INSERT INTO task_runs (task_id, profile, status, started_at, ended_at, outcome)"
        " VALUES (?, ?, 'done', ?, ?, ?)",
        (task_id, profile, ended_at - 60, ended_at, outcome),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# capability_card
# ---------------------------------------------------------------------------


def test_card_reads_description_skills_toolsets_and_model(board):
    _make_profile(
        "researcher",
        description="Finds and cites sources.",
        auto=True,
        skills=("research/web-research", "research/citation", "loose-skill"),
        model="anthropic/claude-sonnet-4",
        toolsets=["web", "file"],
    )
    card = pc.capability_card("researcher", board_conn=board, now=NOW)

    assert card["name"] == card["display_name"] == "researcher"
    assert card["description"] == "Finds and cites sources."
    assert card["description_auto"] is True
    assert {"name": "web-research", "category": "research"} in card["skills"]
    assert {"name": "citation", "category": "research"} in card["skills"]
    assert {"name": "loose-skill", "category": ""} in card["skills"]
    assert {"web", "file"} <= set(card["toolsets"])
    assert card["model"] == "anthropic/claude-sonnet-4"
    json.dumps(card)  # JSON-serialisable


def test_missing_profile_degrades_to_empty_card(board):
    card = pc.capability_card("ghost", board_conn=board, now=NOW)
    assert card["name"] == "ghost"
    assert card["description"] == "" and card["skills"] == [] and card["toolsets"] == []
    assert card["model"] == ""
    assert card["track_record"]["completed"] == 0


def test_broken_profile_files_never_raise(board):
    home = _make_profile("broken")
    (home / "profile.yaml").write_text(":::not yaml[")
    (home / "config.yaml").write_text("- just a list")
    card = pc.capability_card("broken", board_conn=board, now=NOW)
    assert card["description"] == "" and card["model"] == ""


def test_invalid_profile_name_never_raises():
    card = pc.capability_card("../../etc", board_conn=None, now=NOW)
    assert card["skills"] == []


def test_card_without_board_conn_uses_default_board(board):
    _run(board, "writer", "completed", NOW - DAY, title="Draft")
    card = pc.capability_card("writer", now=NOW)
    assert card["track_record"]["completed"] == 1


# ---------------------------------------------------------------------------
# track record
# ---------------------------------------------------------------------------


def test_track_record_counts_outcomes_within_the_90_day_window(board):
    _make_profile("researcher")
    _run(board, "researcher", "completed", NOW - DAY, title="Collect EU pricing")
    _run(board, "researcher", "completed", NOW - 2 * DAY, title="Collect US pricing")
    _run(board, "researcher", "blocked", NOW - 3 * DAY)
    for outcome in pc.FAILED_OUTCOMES:
        _run(board, "researcher", outcome, NOW - 4 * DAY)
    _run(board, "researcher", "reclaimed", NOW - 4 * DAY)  # neither bucket
    _run(board, "researcher", "completed", NOW - 91 * DAY, title="too old")
    _run(board, "writer", "completed", NOW - DAY, title="other profile")

    tr = pc.capability_card("researcher", board_conn=board, now=NOW)["track_record"]
    assert tr["window_days"] == 90
    assert (tr["completed"], tr["blocked"], tr["failed"]) == (2, 1, len(pc.FAILED_OUTCOMES))
    assert [r["title"] for r in tr["recent"]] == ["Collect EU pricing", "Collect US pricing"]
    assert tr["recent"][0] == {
        "title": "Collect EU pricing", "outcome": "completed", "ended_at": NOW - DAY,
    }


def test_recent_titles_capped_newest_first(board):
    for i in range(8):
        _run(board, "writer", "completed", NOW - (i + 1) * 60, title=f"card {i}")
    tr = pc.capability_card("writer", board_conn=board, now=NOW)["track_record"]
    assert tr["completed"] == 8
    assert [r["title"] for r in tr["recent"]] == [f"card {i}" for i in range(pc.RECENT_TITLES)]


def test_roster_keeps_order_and_drops_duplicates(board):
    roster = pc.capability_roster(["b", "a", "b", ""], board_conn=board, now=NOW)
    assert [c["name"] for c in roster] == ["b", "a"]


# ---------------------------------------------------------------------------
# roster_prompt_block
# ---------------------------------------------------------------------------


def _big_card(name, n_skills=200, n_recent=12):
    return {
        "name": name,
        "description": "x" * 2000,
        "skills": [{"name": f"skill-{i:03d}", "category": "cat"} for i in range(n_skills)],
        "toolsets": [f"ts{i}" for i in range(60)],
        "model": "m",
        "track_record": {
            "window_days": 90, "completed": 3, "blocked": 0, "failed": 1,
            "recent": [{"title": "t" * 500, "outcome": "completed", "ended_at": 1}] * n_recent,
        },
    }


def test_prompt_block_is_capped_and_deterministic():
    roster = [_big_card("a"), _big_card("b")]
    block = pc.roster_prompt_block(roster, max_skills=10)
    assert block == pc.roster_prompt_block(roster, max_skills=10)
    for name in ("a", "b"):
        assert f"- {name} (model: m):" in block
    assert block.count("cat/skill-") == 20
    assert "(+190 more)" in block
    assert block.count('"t') == 2 * pc.RECENT_TITLES
    # bounded regardless of how much each profile carries
    assert len(block) < 2 * 3000


def test_prompt_block_renders_facts_and_empty_states():
    card = {
        "name": "researcher",
        "description": "Finds and cites sources.",
        "skills": [{"name": "web-research", "category": "research"}],
        "toolsets": ["web"],
        "model": "",
        "track_record": {
            "window_days": 90, "completed": 14, "blocked": 1, "failed": 0,
            "recent": [{"title": "Collect EU pricing", "outcome": "completed", "ended_at": 1}],
        },
    }
    block = pc.roster_prompt_block([card, {"name": "blank"}])
    assert "- researcher: Finds and cites sources." in block
    assert "skills: research/web-research" in block
    assert "tools: web" in block
    assert '14 completed, 1 blocked, 0 failed; recent: "Collect EU pricing"' in block
    assert "- blank: (no description)" in block
    assert pc.roster_prompt_block([]) == "  (no profiles available)"


# ---------------------------------------------------------------------------
# Access set (decision 1)
# ---------------------------------------------------------------------------


@pytest.fixture
def projects(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    for name in ("researcher", "writer", "secret"):
        _make_profile(name)
    enrolled = {"ada": {"writer"}}

    async def _enrolled(user_id):
        return set(enrolled.get(user_id, set()))

    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)

    with projects_db.connect_closing() as conn:
        pid = projects_db.create_project(
            conn, slug="digest", name="Digest", owner_user_id="leo",
        )
        projects_db.add_project_profile(
            conn, project_id=pid, profile="researcher", role="host"
        )
    project = SimpleNamespace(id=pid, host_profile="researcher", owner_user_id="leo")
    return project, enrolled


def test_admin_accesses_every_served_profile(projects):
    project, _ = projects
    names = asyncio.run(pc.accessible_profile_names(OWNER, project=project))
    assert {"default", "researcher", "writer", "secret"} <= set(names)
    assert names == sorted(names)


def test_member_gets_enrolments_plus_project_profiles(projects):
    project, _ = projects
    assert asyncio.run(pc.accessible_profile_names(MEMBER_P, project=project)) == [
        "researcher", "writer",
    ]
    assert asyncio.run(pc.accessible_profile_names(MEMBER_P)) == ["writer"]


def test_outsider_gets_only_project_profiles(projects):
    project, _ = projects
    assert asyncio.run(pc.accessible_profile_names(STRANGER, project=project)) == ["researcher"]
    assert asyncio.run(pc.accessible_profile_names(None)) == []


def test_sync_variant_uses_project_owner_for_background_replans(projects, monkeypatch):
    project, _ = projects
    roles = {"leo": OWNER, "ada": MEMBER_P}

    async def _lookup(user_id):
        return roles.get(user_id)

    monkeypatch.setattr(pc, "_principal_for_user", _lookup)
    assert "secret" in pc.accessible_profile_names_for_user(None, project=project)
    assert pc.accessible_profile_names_for_user("ada", project=project) == ["researcher", "writer"]
    assert pc.accessible_profile_names_for_user("eve", project=project) == ["researcher"]


def test_sync_variant_fails_closed_when_principal_lookup_breaks(projects, monkeypatch):
    project, _ = projects

    async def _boom(user_id):
        raise RuntimeError("store down")

    monkeypatch.setattr(pc, "_principal_for_user", _boom)
    assert pc.accessible_profile_names_for_user("leo", project=project) == ["researcher"]


def test_sync_variant_works_inside_a_running_loop(projects, monkeypatch):
    project, _ = projects

    async def _lookup(user_id):
        return MEMBER_P

    monkeypatch.setattr(pc, "_principal_for_user", _lookup)

    async def _inside():
        return pc.accessible_profile_names_for_user("ada", project=project)

    assert asyncio.run(_inside()) == ["researcher", "writer"]


# ---------------------------------------------------------------------------
# GET /{slug}/assignable-profiles (C-2)
# ---------------------------------------------------------------------------


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    _make_profile("researcher", description="Finds sources.", skills=("research/web-research",))
    _make_profile("writer", description="Writes reports.")
    _make_profile("analyst")
    _make_profile("secret")

    state = {"actor": OWNER, "enrolled": {"ada": {"writer"}, "eve": set()}}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"].get(user_id, set()))

    async def _subject(request):
        return ""

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    app = FastAPI()
    app.include_router(projects_api.router)
    client = TestClient(app)

    resp = client.post(
        "/api/registry/projects",
        json={
            "goal": "Ship the Monday digest",
            "description": "A weekly digest.",
            "host_profile": "researcher",
            "outputs": [{"title": "The digest"}],
            "visibility": "shared",
        },
    )
    assert resp.status_code == 200, resp.text
    project = resp.json()
    with projects_db.connect_closing() as conn:
        projects_db.add_project_profile(
            conn, project_id=project["id"], profile="analyst", role="worker"
        )
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id="ada", role="member"
        )
    with kanban_db.connect_closing() as conn:
        import time

        _run(conn, "writer", "completed", int(time.time()) - DAY, title="Q3 report")
    return client, state, project


def _get(client, project):
    return client.get(f"/api/registry/projects/{project['slug']}/assignable-profiles")


def test_admin_sees_every_profile_host_first(api):
    client, _state, project = api
    resp = _get(client, project)
    assert resp.status_code == 200, resp.text
    cards = resp.json()["profiles"]
    names = [c["name"] for c in cards]
    assert names[:2] == ["researcher", "analyst"]
    assert {"default", "secret", "writer"} <= set(names[2:])
    assert names[2:] == sorted(names[2:])
    host = cards[0]
    assert host["is_host"] is True and host["in_project"] is True
    assert host["description"] == "Finds sources."
    assert {"name": "web-research", "category": "research"} in host["skills"]
    assert cards[1]["is_host"] is False and cards[1]["in_project"] is True
    writer = next(c for c in cards if c["name"] == "writer")
    assert writer["in_project"] is False
    assert writer["track_record"]["completed"] == 1
    assert writer["track_record"]["recent"][0]["title"] == "Q3 report"


def test_enrolled_member_sees_enrolments_plus_project_profiles(api):
    client, state, project = api
    state["actor"] = MEMBER_P
    resp = _get(client, project)
    assert resp.status_code == 200, resp.text
    assert [c["name"] for c in resp.json()["profiles"]] == ["researcher", "analyst", "writer"]


def test_outsider_cannot_read_assignable_profiles(api):
    client, state, project = api
    state["actor"] = STRANGER
    assert _get(client, project).status_code == 404
