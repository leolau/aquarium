"""Skill usage ledger (``hermes_cli.skill_ledger``) and its ``/api/skills/usage`` routes.

Behaviour contracts, exercised against a temp HERMES_HOME with the real
kanban / projects / session stores: every load site records one use with
its context; kanban uses take the run's outcome and the card's project at
read time; chat uses take the user's rating; the routes resolve titles
server-side, never leak paths and stay admin-only.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import time
import types
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from hermes_cli import skill_ledger

SKILL_MD = "---\nname: {name}\ndescription: test skill {name}\n---\n\n# {name}\n\nDo the thing.\n"


@pytest.fixture
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    for var in ("HERMES_KANBAN_TASK", "HERMES_KANBAN_RUN_ID", "HERMES_KANBAN_BOARD", "HERMES_SESSION_ID"):
        monkeypatch.delenv(var, raising=False)
    return tmp_path


def _kanban_task(title, *, project_id=None, run_outcome=None):
    from hermes_cli import kanban_db as kb

    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title=title)
        if project_id:
            conn.execute("UPDATE tasks SET project_id = ? WHERE id = ?", (project_id, task_id))
        cur = conn.execute(
            "INSERT INTO task_runs (task_id, status, started_at, ended_at, outcome)"
            " VALUES (?, 'done', ?, ?, ?)",
            (task_id, int(time.time()) - 5, int(time.time()), run_outcome),
        )
        conn.commit()
        return task_id, int(cur.lastrowid)


def _project(name, slug):
    from hermes_cli import projects_db

    with projects_db.connect_closing() as conn:
        return projects_db.create_project(conn, name=name, slug=slug)


# ---------------------------------------------------------------------------
# Python API
# ---------------------------------------------------------------------------


def test_record_use_captures_session_card_principal_and_profile(stores, monkeypatch):
    from tools.access_policy import acting_as

    task_id, run_id = _kanban_task("Write the report")
    monkeypatch.setenv("HERMES_SESSION_ID", "sess-1")
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    monkeypatch.setenv("HERMES_KANBAN_RUN_ID", str(run_id))
    with acting_as("ada", "member"):
        event_id = skill_ledger.record_use("writer", trigger="skill_view")
    event = skill_ledger.get_event(event_id)
    assert event["session_id"] == "sess-1"
    assert event["kanban_task_id"] == task_id
    assert event["kanban_run_id"] == run_id
    assert event["user_id"] == "ada"
    assert event["profile"] == "default"
    assert event["outcome"] is None and event["version_id"] is None


def test_record_use_takes_version_from_skill_versions_when_present(stores, monkeypatch):
    fake = types.ModuleType("tools.skill_versions")
    fake.current_version_id = lambda name: "v3" if name == "writer" else None
    monkeypatch.setitem(sys.modules, "tools.skill_versions", fake)
    event_id = skill_ledger.record_use("writer", trigger="slash")
    assert skill_ledger.get_event(event_id)["version_id"] == "v3"


def test_record_use_is_best_effort(stores, monkeypatch, tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x")
    monkeypatch.setattr(skill_ledger, "ledger_path", lambda: blocker / "skill_ledger.db")
    assert skill_ledger.record_use("writer", trigger="skill_view") is None
    monkeypatch.undo()
    assert skill_ledger.record_use("writer", trigger="nonsense") is None
    assert skill_ledger.record_use("", trigger="skill_view") is None


@pytest.mark.parametrize(
    "run_outcome,expected",
    [("completed", "success"), ("blocked", "partial"), ("crashed", "failure"),
     ("timed_out", "failure"), ("spawn_failed", "failure"), ("gave_up", "failure"),
     ("reclaimed", None), (None, None)],
)
def test_kanban_outcome_comes_from_the_run(stores, run_outcome, expected):
    task_id, run_id = _kanban_task("card", run_outcome=run_outcome)
    event_id = skill_ledger.record_use(
        "writer", trigger="skill_view", kanban_task_id=task_id, kanban_run_id=run_id
    )
    page = skill_ledger.events("writer")
    [event] = [e for e in page["events"] if e["id"] == event_id]
    assert event["outcome"] == expected
    assert event["outcome_source"] == ("kanban" if expected else None)


def test_summary_rolls_up_sessions_tasks_projects_and_outcomes(stores):
    project_id = _project("Quarterly report", "quarterly")
    done_task, done_run = _kanban_task("Draft", project_id=project_id, run_outcome="completed")
    bad_task, bad_run = _kanban_task("Review", run_outcome="crashed")
    skill_ledger.record_use("writer", trigger="skill_view", session_id="s1")
    skill_ledger.record_use("writer", trigger="skill_view", session_id="s1")
    skill_ledger.record_use("writer", trigger="cron", kanban_task_id=done_task, kanban_run_id=done_run)
    skill_ledger.record_use("writer", trigger="bundle", kanban_task_id=bad_task, kanban_run_id=bad_run)
    skill_ledger.record_use("other", trigger="slash", session_id="s2")

    rows = {r["name"]: r for r in skill_ledger.summary(days=7)}
    writer = rows["writer"]
    assert writer["uses"] == 4
    assert writer["sessions"] == 1
    assert writer["tasks"] == 2
    assert writer["projects"] == 1
    assert (writer["success"], writer["partial"], writer["failure"], writer["unknown"]) == (1, 0, 1, 2)
    assert writer["success_rate"] == 0.5
    assert rows["other"]["success_rate"] is None
    assert len(writer["trend"]) == 7
    assert sum(d["uses"] for d in writer["trend"]) == 4
    assert writer["trend"][-1]["uses"] == 4
    assert writer["last_used_at"] == pytest.approx(time.time(), abs=60)
    assert [r["name"] for r in skill_ledger.summary(days=7)] == ["writer", "other"]
    project_rows = [e for e in skill_ledger.events("writer")["events"] if e["project_slug"]]
    assert [e["project_slug"] for e in project_rows] == ["quarterly"]


def test_project_filter_narrows_summary_events_and_by_version(stores):
    here = _project("Launch", "launch")
    there = _project("Digest", "digest")
    t1, r1 = _kanban_task("Ship it", project_id=here, run_outcome="completed")
    t2, r2 = _kanban_task("Mail it", project_id=there, run_outcome="crashed")
    skill_ledger.record_use("writer", trigger="preload", kanban_task_id=t1, kanban_run_id=r1)
    skill_ledger.record_use("writer", trigger="preload", kanban_task_id=t2, kanban_run_id=r2)
    chat = skill_ledger.record_use("writer", trigger="skill_view", session_id="s1")
    skill_ledger.set_feedback(chat, -1)

    [row] = skill_ledger.summary(days=7, project="launch")
    assert (row["uses"], row["success"], row["failure"], row["rated_down"]) == (1, 1, 0, 0)
    assert skill_ledger.project_rollup("launch", 7) == [row]
    [overall] = skill_ledger.summary(days=7)
    assert (overall["uses"], overall["rated_down"]) == (3, 1)

    page = skill_ledger.events("writer", project="digest")
    assert [e["kanban_task_id"] for e in page["events"]] == [t2]
    assert page["by_version"] == [{"version_id": None, "uses": 1, "success_rate": 0.0}]
    assert skill_ledger.project_cards("launch", 7) == [
        {"skill_name": "writer", "board": None, "task_id": t1}
    ]
    assert skill_ledger.summary(days=7, project="nope") == []


def test_project_index_is_added_to_an_existing_ledger(stores):
    path = skill_ledger.ledger_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    legacy = sqlite3.connect(str(path))
    legacy.executescript(
        skill_ledger._SCHEMA.replace(
            "CREATE INDEX IF NOT EXISTS idx_skill_events_project_ts ON skill_events(project_slug, ts);", ""
        )
    )
    legacy.close()
    skill_ledger._INITIALIZED.discard(str(path.resolve()))
    skill_ledger.summary(days=7)
    with sqlite3.connect(str(path)) as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert "idx_skill_events_project_ts" in names


def test_window_excludes_old_uses(stores):
    old = skill_ledger.record_use("writer", trigger="skill_view")
    with skill_ledger._connect() as conn:
        conn.execute("UPDATE skill_events SET ts = ? WHERE id = ?", (time.time() - 10 * 86400, old))
    skill_ledger.record_use("writer", trigger="skill_view")
    assert skill_ledger.summary(days=7)[0]["uses"] == 1
    assert skill_ledger.summary(days=30)[0]["uses"] == 2


def test_feedback_sets_chat_outcome_but_never_overrides_kanban(stores):
    chat = skill_ledger.record_use("writer", trigger="skill_view", session_id="s1")
    task_id, run_id = _kanban_task("card", run_outcome="completed")
    card = skill_ledger.record_use("writer", trigger="skill_view", kanban_task_id=task_id, kanban_run_id=run_id)
    skill_ledger.summary()

    rated = skill_ledger.set_feedback(chat, -1, "missed the tone")
    assert (rated["outcome"], rated["outcome_source"], rated["rating"], rated["note"]) == (
        "failure", "user", -1, "missed the tone")
    rated = skill_ledger.set_feedback(chat, 1)
    assert (rated["outcome"], rated["note"]) == ("success", "missed the tone")
    rated = skill_ledger.set_feedback(chat, 0)
    assert rated["outcome"] is None and rated["outcome_source"] is None

    kept = skill_ledger.set_feedback(card, -1)
    assert (kept["outcome"], kept["outcome_source"], kept["rating"]) == ("success", "kanban", -1)
    assert skill_ledger.set_feedback(99999, 1) is None
    with pytest.raises(ValueError):
        skill_ledger.set_feedback(chat, 2)


def test_events_page_newest_first_with_cursor(stores):
    ids = [skill_ledger.record_use("writer", trigger="skill_view") for _ in range(5)]
    first = skill_ledger.events("writer", limit=2)
    assert [e["id"] for e in first["events"]] == ids[::-1][:2]
    second = skill_ledger.events("writer", limit=2, cursor=first["next_cursor"])
    assert [e["id"] for e in second["events"]] == ids[::-1][2:4]
    last = skill_ledger.events("writer", limit=2, cursor=second["next_cursor"])
    assert [e["id"] for e in last["events"]] == [ids[0]] and last["next_cursor"] is None
    with pytest.raises(ValueError):
        skill_ledger.events("writer", cursor="abc")


def test_by_version_groups_uses(stores, monkeypatch):
    fake = types.ModuleType("tools.skill_versions")
    state = {"v": "v1"}
    fake.current_version_id = lambda name: state["v"]
    monkeypatch.setitem(sys.modules, "tools.skill_versions", fake)
    a = skill_ledger.record_use("writer", trigger="skill_view")
    state["v"] = "v2"
    b = skill_ledger.record_use("writer", trigger="skill_view")
    skill_ledger.record_use("writer", trigger="skill_view")
    skill_ledger.set_feedback(a, -1)
    skill_ledger.set_feedback(b, 1)
    versions = {v["version_id"]: v for v in skill_ledger.events("writer")["by_version"]}
    assert versions["v1"] == {"version_id": "v1", "uses": 1, "success_rate": 0.0}
    assert versions["v2"] == {"version_id": "v2", "uses": 2, "success_rate": 1.0}


# ---------------------------------------------------------------------------
# Load sites
# ---------------------------------------------------------------------------


@pytest.fixture
def skills_root(stores):
    from hermes_constants import get_hermes_home

    root = get_hermes_home() / "skills"
    for name in ("writer", "editor"):
        d = root / name
        (d / "references").mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(SKILL_MD.format(name=name), encoding="utf-8")
        (d / "references" / "style.md").write_text("tone", encoding="utf-8")
    with patch("tools.skills_tool.SKILLS_DIR", root):
        yield root


def _triggers(name):
    return [e["trigger"] for e in skill_ledger.events(name)["events"]]


def test_skill_view_tool_records_one_use_per_load(skills_root, monkeypatch):
    from tools.registry import registry

    monkeypatch.setenv("HERMES_SESSION_ID", "sess-tool")
    handler = registry.get_entry("skill_view").handler
    assert json.loads(handler({"name": "writer"}))["success"]
    assert json.loads(handler({"name": "writer", "file_path": "references/style.md"}))["success"]
    handler({"name": "does-not-exist"})
    events = skill_ledger.events("writer")["events"]
    assert [(e["trigger"], e["session_id"]) for e in events] == [("skill_view", "sess-tool")]
    assert skill_ledger.events("does-not-exist")["events"] == []


def test_slash_preload_and_bundle_record_their_trigger(skills_root):
    from agent import skill_commands

    skill_commands.scan_skill_commands()
    assert skill_commands.build_skill_invocation_message("/writer", "go")
    _prompt, loaded, _missing = skill_commands.build_preloaded_skills_prompt(["editor"])
    assert loaded == ["editor"]
    assert _triggers("writer") == ["slash"]
    assert _triggers("editor") == ["preload"]


def test_cron_job_prompt_records_cron_use(skills_root):
    from cron import scheduler

    scheduler._build_job_prompt({"id": "job1", "name": "nightly", "prompt": "run", "skills": ["writer"]})
    assert _triggers("writer") == ["cron"]


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": None}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server, "_comms_session_subject",
        lambda request: state["as"].user_id if state["as"] else "",
    )
    return state


@pytest.fixture
def client(stores, acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _seed_titled_uses():
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB

    db = SessionDB(db_path=get_hermes_home() / "state.db")
    db.create_session("chat-1", source="web")
    db.set_session_title("chat-1", "Plan the launch")
    db.close()
    project_id = _project("Launch", "launch")
    task_id, run_id = _kanban_task("Ship it", project_id=project_id, run_outcome="completed")
    chat = skill_ledger.record_use("writer", trigger="skill_view", session_id="chat-1", user_id="mia")
    card = skill_ledger.record_use("writer", trigger="cron", kanban_task_id=task_id, kanban_run_id=run_id)
    return chat, card, task_id


def test_usage_route_lists_skill_rollups(client):
    _seed_titled_uses()
    resp = client.get("/api/skills/usage", params={"days": 14})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["days"] == 14
    [row] = data["skills"]
    assert set(row) == {"name", "uses", "sessions", "tasks", "projects", "success", "partial",
                        "failure", "unknown", "rated_down", "success_rate", "last_used_at", "trend"}
    assert (row["name"], row["uses"], row["success"], row["unknown"], row["projects"]) == ("writer", 2, 1, 1, 1)
    assert len(row["trend"]) == 14 and set(row["trend"][0]) == {"day", "uses"}


def test_detail_route_resolves_titles_and_hides_paths(client, stores):
    chat, card, task_id = _seed_titled_uses()
    resp = client.get("/api/skills/usage/detail", params={"name": "writer"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["name"] == "writer" and data["summary"]["uses"] == 2
    assert data["by_version"] == [{"version_id": None, "uses": 2, "success_rate": 1.0}]
    by_id = {e["id"]: e for e in data["events"]}
    assert by_id[chat]["session"] == {"id": "chat-1", "title": "Plan the launch"}
    assert by_id[chat]["task"] is None and by_id[chat]["user_id"] == "mia"
    assert by_id[card]["task"] == {"id": task_id, "title": "Ship it"}
    assert by_id[card]["project"] == {"slug": "launch", "name": "Launch"}
    assert by_id[card]["outcome"] == "success" and by_id[card]["outcome_source"] == "kanban"
    assert set(by_id[chat]) == {"id", "ts", "trigger", "version_id", "outcome", "outcome_source",
                                "rating", "note", "session", "task", "project", "user_id"}
    assert data["next_cursor"] is None
    assert str(stores) not in resp.text

    empty = client.get("/api/skills/usage/detail", params={"name": "never-used"}).json()
    assert empty["summary"]["uses"] == 0 and empty["events"] == [] and len(empty["summary"]["trend"]) == 90
    assert client.get("/api/skills/usage/detail", params={"name": "writer", "cursor": "x"}).status_code == 400


def test_feedback_route_rates_a_use(client):
    chat, _card, _task = _seed_titled_uses()
    resp = client.post("/api/skills/usage/feedback", json={"event_id": chat, "rating": -1, "note": "too long"})
    assert resp.status_code == 200, resp.text
    event = resp.json()
    assert (event["rating"], event["note"], event["outcome"], event["outcome_source"]) == (-1, "too long", "failure", "user")
    assert event["session"] == {"id": "chat-1", "title": "Plan the launch"}
    assert client.post("/api/skills/usage/feedback", json={"event_id": 9999, "rating": 1}).status_code == 404
    for bad in ({"event_id": chat, "rating": 0}, {"event_id": chat, "rating": True},
                {"event_id": "1", "rating": 1}, {"event_id": chat, "rating": 1, "note": 5}):
        assert client.post("/api/skills/usage/feedback", json=bad).status_code == 422, bad


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
@pytest.mark.parametrize(
    "method,path,body",
    [("get", "/api/skills/usage", None), ("get", "/api/skills/usage/detail?name=writer", None),
     ("post", "/api/skills/usage/feedback", {"event_id": 1, "rating": 1})],
)
def test_routes_are_admin_only(client, acting, who, method, path, body):
    acting["as"] = who
    resp = client.request(method.upper(), path, json=body)
    assert resp.status_code == 403, resp.text


def test_profile_param_reads_that_profiles_ledger(client, monkeypatch, stores):
    from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
    from hermes_cli import profiles

    default_home = get_hermes_home()
    profiles_root = default_home / "profiles"
    worker = profiles_root / "worker_alpha"
    (worker / "skills").mkdir(parents=True)
    (worker / "config.yaml").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: profiles_root)

    skill_ledger.record_use("writer", trigger="skill_view")
    token = set_hermes_home_override(worker)
    try:
        skill_ledger.record_use("worker-only", trigger="skill_view")
    finally:
        reset_hermes_home_override(token)

    default_names = [r["name"] for r in client.get("/api/skills/usage").json()["skills"]]
    worker_rows = client.get("/api/skills/usage", params={"profile": "worker_alpha"}).json()["skills"]
    assert default_names == ["writer"]
    assert [r["name"] for r in worker_rows] == ["worker-only"]
    assert (worker / "skill_ledger.db").exists()
