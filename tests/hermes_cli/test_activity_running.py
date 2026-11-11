"""``GET /api/activity/running`` — the activity bar's feed.

The contract: every row is scoped exactly like the page it links to. The
owner/admin see everything; a member sees only their own chats, project
work in projects they can read (never another user's private card) and
cron jobs driving such projects.
"""

from __future__ import annotations

import json
import os
import socket
import time
from datetime import datetime
from types import SimpleNamespace

import pytest

from hermes_cli import activity_running as act
from hermes_cli import kanban_db, projects_db
from hermes_cli.access import Principal
from tests.hermes_cli.test_projects_api import (  # noqa: F401 — fixture
    MEMBER_P,
    OWNER,
    STRANGER,
    _activate,
    _create,
    _member,
    env,
)

ADMIN = Principal(user_id="ann", display="Ann", role="admin")  # type: ignore[arg-type]


def _running_project(env):
    """An active project with a running run, a shared running card and
    someone else's private running card."""
    project = _create(env)
    _activate(env, project)
    with projects_db.connect_closing() as conn:
        projects_db.open_project_run(
            conn, project_id=project["id"], trigger="manual", profile="default"
        )
    with kanban_db.connect_closing() as bconn:
        shared = kanban_db.create_task(bconn, title="Shared card", project_id=project["id"])
        private = kanban_db.create_task(
            bconn, title="Mallory's private card", project_id=project["id"],
            owner_user_id="mallory", visibility="private:mallory", triage=True,
        )
        kanban_db.create_task(bconn, title="Idle", project_id=project["id"])
        bconn.execute(
            "UPDATE tasks SET status = 'running', started_at = 1700000000 "
            "WHERE id IN (?, ?)", (shared, private),
        )
        bconn.commit()
    return project, shared, private


def _names(items):
    return sorted((i["kind"], i["name"]) for i in items)


def test_project_work_follows_project_and_card_visibility(env):
    project, shared, private = _running_project(env)
    run_name = f"{project['name']} · run 1"

    owner_view = act.project_items(OWNER, set())
    assert _names(owner_view) == sorted([
        ("project_run", run_name),
        ("card", "Shared card"),
        ("card", "Mallory's private card"),
    ])

    _member(project["id"], "ada", "lead")
    member_view = act.project_items(MEMBER_P, set())
    assert _names(member_view) == sorted([("project_run", run_name), ("card", "Shared card")])
    card = next(i for i in member_view if i["kind"] == "card")
    assert card["href"] == f"/projects/{project['slug']}/cards/{shared}"
    assert card["started_at"] == 1700000000
    run = next(i for i in member_view if i["kind"] == "project_run")
    assert run["href"] == f"/projects/{project['slug']}/runs/1"
    assert run["status"] == "running" and run["profile"] == "default"

    # Not a member, not enrolled in the project's profile: nothing.
    assert act.project_items(STRANGER, set()) == []
    # The private card's owner sees their own card.
    mallory = Principal(user_id="mallory", display="M", role="member")  # type: ignore[arg-type]
    _member(project["id"], "mallory", "member")
    assert ("card", "Mallory's private card") in _names(act.project_items(mallory, set()))


def test_finished_work_is_not_listed(env):
    project, shared, _private = _running_project(env)
    with projects_db.connect_closing() as conn:
        conn.execute("UPDATE project_runs SET status = 'done'")
        conn.commit()
    with kanban_db.connect_closing() as bconn:
        bconn.execute("UPDATE tasks SET status = 'done'")
        bconn.commit()
    assert act.project_items(OWNER, set()) == []


def _marker(cron_dir, job_id, name):
    d = cron_dir / "running"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{job_id}.json").write_text(json.dumps({
        "job_id": job_id, "name": name, "started_at": time.time(),
        "pid": os.getpid(), "host": socket.gethostname(),
    }))


def test_cron_jobs_visible_to_admins_or_through_a_readable_project(env, tmp_path):
    project = _create(env)
    _activate(env, project)
    with projects_db.connect_closing() as conn:
        conn.execute(
            "UPDATE projects SET cron_job_id = 'job-p' WHERE id = ?", (project["id"],)
        )
        conn.commit()
    cron_dir = tmp_path / "cron"
    _marker(cron_dir, "job-p", "Project digest")
    _marker(cron_dir, "job-x", "Operator backup")
    dirs = [("default", cron_dir)]

    assert _names(act.cron_items(OWNER, set(), dirs)) == [
        ("cron", "Operator backup"), ("cron", "Project digest"),
    ]
    assert len(act.cron_items(ADMIN, set(), dirs)) == 2

    assert act.cron_items(MEMBER_P, set(), dirs) == []
    _member(project["id"], "ada", "member")
    [row] = act.cron_items(MEMBER_P, set(), dirs)
    assert row["name"] == "Project digest"
    assert row["href"] == f"/projects/{project['slug']}"
    assert row["id"] == "default:job-p" and row["profile"] == "default"


# ---------------------------------------------------------------------------
# Scheduled: the landing "Scheduled N" button
# ---------------------------------------------------------------------------


def _schedule(project_id, job_id, next_run_at=None):
    with projects_db.connect_closing() as conn:
        conn.execute(
            "UPDATE projects SET cron_job_id = ?, next_run_at = ? WHERE id = ?",
            (job_id, next_run_at, project_id),
        )
        conn.commit()


def _scheduled_card(project_id, title, **kw):
    with kanban_db.connect_closing() as bconn:
        task = kanban_db.create_task(bconn, title=title, project_id=project_id, **kw)
        bconn.execute("UPDATE tasks SET status = 'scheduled' WHERE id = ?", (task,))
        bconn.commit()
    return task


def _counts(summary):
    return (summary["projects"], summary["cards"], summary["cron_jobs"], summary["total"])


def test_scheduled_projects_count_only_readable_active_schedules(env):
    readable = _create(env, body={"goal": "Weekly report for the team", "visibility": "shared"})
    private = _create(env, body={"goal": "Mallory's private digest", "visibility": "private"})
    archived = _create(env, body={"goal": "An archived schedule"})
    paused = _create(env, body={"goal": "A paused schedule"})
    unscheduled = _create(env, body={"goal": "No schedule at all"})
    for project in (readable, private, archived, paused, unscheduled):
        _activate(env, project)
    _schedule(readable["id"], "job-r", 1_800_000_500)
    _schedule(private["id"], "job-m", 1_800_000_100)
    _schedule(archived["id"], "job-a", 1_800_000_000)
    _schedule(paused["id"], "job-p", 1_800_000_000)
    with projects_db.connect_closing() as conn:
        conn.execute("UPDATE projects SET archived = 1 WHERE id = ?", (archived["id"],))
        conn.execute("UPDATE projects SET status = 'paused' WHERE id = ?", (paused["id"],))
        conn.commit()

    _member(readable["id"], "ada", "member")
    member = act.scheduled_summary(MEMBER_P, set(), job_dirs=[])
    assert _counts(member) == (1, 0, 0, 1)
    assert member["next_run_at"] == 1_800_000_500

    # Shared-read through an enrolment in the project's profile counts too;
    # a private project never does.
    assert act.scheduled_summary(STRANGER, set(), job_dirs=[])["projects"] == 0
    assert act.scheduled_summary(STRANGER, {"default"}, job_dirs=[])["projects"] == 1

    owner = act.scheduled_summary(OWNER, set(), job_dirs=[])
    assert _counts(owner) == (2, 0, 0, 2)
    assert owner["next_run_at"] == 1_800_000_100


def test_scheduled_cards_count_on_their_own_board_and_respect_privacy(env, tmp_path, monkeypatch):
    # Real per-board databases, so a card on a foreign board is a separate row.
    monkeypatch.delenv("HERMES_KANBAN_DB", raising=False)
    monkeypatch.setenv("HERMES_KANBAN_HOME", str(tmp_path / "kanban-home"))
    project = _create(env)
    _activate(env, project)
    _scheduled_card(project["id"], "Parked until Friday")
    _scheduled_card(
        project["id"], "Mallory's parked card",
        owner_user_id="mallory", visibility="private:mallory",
    )
    kanban_db.create_board("elsewhere")
    with kanban_db.connect_closing(board="elsewhere") as bconn:
        stray = kanban_db.create_task(bconn, title="Wrong board", project_id=project["id"])
        bconn.execute("UPDATE tasks SET status = 'scheduled' WHERE id = ?", (stray,))
        bconn.commit()

    assert _counts(act.scheduled_summary(OWNER, set(), job_dirs=[])) == (0, 2, 0, 2)
    _member(project["id"], "ada", "member")
    assert _counts(act.scheduled_summary(MEMBER_P, set(), job_dirs=[])) == (0, 1, 0, 1)
    assert act.scheduled_summary(STRANGER, set(), job_dirs=[])["cards"] == 0
    mallory = Principal(user_id="mallory", display="M", role="member")  # type: ignore[arg-type]
    _member(project["id"], "mallory", "member")
    assert act.scheduled_summary(mallory, set(), job_dirs=[])["cards"] == 2


def _jobs_file(cron_dir, jobs):
    cron_dir.mkdir(parents=True, exist_ok=True)
    (cron_dir / "jobs.json").write_text(json.dumps({"jobs": jobs}))


def test_standalone_cron_jobs_count_for_admins_only(env, tmp_path):
    project = _create(env)
    _activate(env, project)
    _schedule(project["id"], "job-p", 1_800_000_900)
    default_dir, work_dir = tmp_path / "cron-default", tmp_path / "cron-work"
    _jobs_file(default_dir, [
        {"id": "job-p", "name": "Project digest", "enabled": True,
         "next_run_at": "2027-02-01T08:00:00+00:00"},
        {"id": "job-x", "name": "Nightly backup", "enabled": True,
         "next_run_at": "2027-02-01T02:00:00+00:00"},
        {"id": "job-off", "name": "Disabled", "enabled": False,
         "next_run_at": "2027-01-01T00:00:00+00:00"},
    ])
    _jobs_file(work_dir, [{"id": "job-w", "name": "Work sync"}])
    dirs = [("default", default_dir), ("work", work_dir)]

    admin = act.scheduled_summary(ADMIN, set(), job_dirs=dirs)
    assert _counts(admin) == (1, 0, 2, 3)
    assert admin["next_run_at"] == 1_800_000_900  # sooner than the backup
    _schedule(project["id"], "job-p", None)
    assert act.scheduled_summary(OWNER, set(), job_dirs=dirs)["next_run_at"] == int(
        datetime.fromisoformat("2027-02-01T02:00:00+00:00").timestamp()
    )

    _member(project["id"], "ada", "member")
    assert _counts(act.scheduled_summary(MEMBER_P, set(), job_dirs=dirs)) == (1, 0, 0, 1)


def test_cron_job_dirs_finds_every_profile_store(tmp_path, monkeypatch):
    from hermes_cli import profiles as profiles_mod

    default_home, root = tmp_path / "home", tmp_path / "home" / "profiles"
    _jobs_file(default_home / "cron", [])
    _jobs_file(root / "work" / "cron", [])
    (root / "empty" / "cron").mkdir(parents=True)
    monkeypatch.setattr(profiles_mod, "get_profile_dir", lambda name: default_home)
    monkeypatch.setattr(profiles_mod, "_get_profiles_root", lambda: root)
    assert act.cron_job_dirs() == [
        ("default", default_home / "cron"), ("work", root / "work" / "cron"),
    ]


def test_unreadable_jobs_file_counts_nothing(tmp_path):
    (tmp_path / "jobs.json").write_text("{not json")
    assert act._read_jobs(tmp_path) == []
    (tmp_path / "jobs.json").write_text(json.dumps([{"id": "a"}, "junk"]))
    assert act._read_jobs(tmp_path) == [{"id": "a"}]


class _FakeDB:
    def __init__(self, owners, titles):
        self.owners, self.titles, self.closed = owners, titles, False

    def session_owner_user_id(self, sid):
        return self.owners.get(sid)

    def get_session_title(self, sid):
        return self.titles.get(sid)

    def close(self):
        self.closed = True


def test_chats_are_scoped_to_their_owner():
    db = _FakeDB({"s-ada": "ada", "s-eve": "eve"}, {"s-ada": "Ada's chat"})
    runs = [
        {"session_id": "s-ada", "profile": None, "started_at": 100.0},
        {"session_id": "s-eve", "profile": None, "started_at": 200.0},
    ]
    member = act.chat_items(runs, "ada", lambda p: db)
    assert [(i["id"], i["name"]) for i in member] == [("s-ada", "Ada's chat")]
    assert member[0]["href"] == "/chat?session=s-ada"
    assert member[0]["started_at"] == 100.0
    assert db.closed

    everyone = act.chat_items(runs, None, lambda p: db)
    assert sorted(i["id"] for i in everyone) == ["s-ada", "s-eve"]
    assert next(i for i in everyone if i["id"] == "s-eve")["name"] == "Chat"


def test_named_profile_chat_links_carry_the_profile():
    db = _FakeDB({}, {})
    [row] = act.chat_items(
        [{"session_id": "s1", "profile": "work", "started_at": 1.0}], None, lambda p: db
    )
    assert row["href"] == "/chat?session=s1&profile=work"
    assert row["profile"] == "work"


def test_finalize_orders_newest_first_and_bounds():
    items = [act._item("chat", str(i), "c", float(i), None, None, "running") for i in range(80)]
    out = act.finalize(items)
    assert len(out) == act.MAX_ITEMS
    assert out[0]["id"] == "79"


# ---------------------------------------------------------------------------
# The HTTP route: live chat turns from the in-memory registry
# ---------------------------------------------------------------------------


@pytest.fixture
def route(tmp_path, monkeypatch):
    from starlette.testclient import TestClient

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    state = {"actor": SimpleNamespace(user_id="leo", role="owner", is_owner=True,
                                      private_visibility="private:leo")}

    async def _principal(request, *, allow_as=False):
        return state["actor"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _principal)
    monkeypatch.setattr(act, "project_items", lambda *a, **k: [])
    monkeypatch.setattr(act, "cron_dirs", lambda: [])
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    db = hermes_state.SessionDB()
    db.create_session("s-ada", "web", user_id="ada")
    db.create_session("s-eve", "web", user_id="eve")
    db.set_session_title("s-ada", "Plan the launch")
    db.close()
    web_server._CHAT_RUNS.update({
        "r1": {"session_id": "s-ada", "done": False, "profile": None, "started_at": 50.0},
        "r2": {"session_id": "s-eve", "done": False, "profile": None, "started_at": 60.0},
        "r3": {"session_id": "s-ada", "done": True, "profile": None, "started_at": 10.0},
    })
    yield c, state
    for k in ("r1", "r2", "r3"):
        web_server._CHAT_RUNS.pop(k, None)


def test_route_lists_live_turns_scoped_by_role(route):
    client, state = route
    body = client.get("/api/activity/running").json()
    assert [(i["id"], i["started_at"]) for i in body] == [("s-eve", 60.0), ("s-ada", 50.0)]

    state["actor"] = SimpleNamespace(user_id="ada", role="member", is_owner=False,
                                     private_visibility="private:ada")
    body = client.get("/api/activity/running").json()
    assert body == [{
        "kind": "chat", "id": "s-ada", "name": "Plan the launch", "started_at": 50.0,
        "href": "/chat?session=s-ada", "profile": None, "status": "running",
    }]


def test_route_requires_the_session_token(route):
    from starlette.testclient import TestClient
    from hermes_cli.web_server import app

    assert TestClient(app).get("/api/activity/running").status_code == 401


def test_route_lists_nothing_without_the_multi_user_datastore(route, monkeypatch):
    """No datastore → no principal to scope by: fail closed (empty), never
    fall back to an all-seeing view."""
    from hermes_cli import web_server

    client, _state = route

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("multi user datastore not configured")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    res = client.get("/api/activity/running")
    assert res.status_code == 200
    assert res.json() == []


def test_scheduled_route_counts_for_the_caller(route, monkeypatch):
    from hermes_cli import projects_api

    client, state = route
    seen = []

    def _summary(principal, enrolled):
        seen.append((principal.user_id, set(enrolled)))
        return {"total": 3, "projects": 1, "cards": 2, "cron_jobs": 0, "next_run_at": 99}

    async def _enrolled(user_id):
        return {"work"}

    monkeypatch.setattr(act, "scheduled_summary", _summary)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    res = client.get("/api/activity/scheduled")
    assert res.status_code == 200
    assert res.json() == {"total": 3, "projects": 1, "cards": 2, "cron_jobs": 0, "next_run_at": 99}

    state["actor"] = SimpleNamespace(user_id="ada", role="member", is_owner=False,
                                     private_visibility="private:ada")
    client.get("/api/activity/scheduled")
    # The owner reads box-wide; a member through their enrolments.
    assert seen == [("leo", set()), ("ada", {"work"})]


def test_scheduled_route_requires_the_session_token(route):
    from starlette.testclient import TestClient
    from hermes_cli.web_server import app

    assert TestClient(app).get("/api/activity/scheduled").status_code == 401


def test_scheduled_route_counts_nothing_without_the_multi_user_datastore(route, monkeypatch):
    from hermes_cli import web_server

    client, _state = route

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("multi user datastore not configured")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    res = client.get("/api/activity/scheduled")
    assert res.status_code == 200
    assert res.json() == {
        "total": 0, "projects": 0, "cards": 0, "cron_jobs": 0, "next_run_at": None,
    }
