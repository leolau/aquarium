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
