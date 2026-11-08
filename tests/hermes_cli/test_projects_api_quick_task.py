"""POST /quick-task and POST /{slug}/quick-task/start — Task mode.

Contracts: Start task creates an ordinary one-off project (no parallel task
model) whose autonomy is the "Check in with me" choice; the agent words the
brief, drafts the plan and — unless the person asked to check the plan
first — activates it and starts run 1. A brief the model can't word keeps
the request as the brief. Starting is a lead + human act, like activating a
plan by hand.
"""

from __future__ import annotations

import json
import threading
import types

import pytest

from hermes_cli import projects_api, projects_db
from tests.hermes_cli.test_projects_api_runs import (  # noqa: F401
    MEMBER_P,
    OWNER,
    env,
)

PLAN = {"body": "Find, compare, report.", "steps": [
    {"key": "find", "title": "Find the options"},
    {"key": "report", "title": "Write the comparison", "depends_on": ["find"]},
]}


_REAL_THREAD = threading.Thread


class _InlineThread:
    """Runs the projects job inline; any other thread (asyncio's executor
    workers) is a real one."""

    def __new__(cls, *args, kwargs=None, **kw):
        if kwargs is None:
            return _REAL_THREAD(*args, **kw)
        return super().__new__(cls)

    def __init__(self, *, target, kwargs, **_):
        self._run = lambda: target(**kwargs)

    def start(self):
        self._run()


@pytest.fixture(autouse=True)
def _inline(monkeypatch):
    projects_api._PLAN_DRAFTS.clear()
    monkeypatch.setattr(
        projects_api, "threading", types.SimpleNamespace(Thread=_InlineThread)
    )
    monkeypatch.setattr(
        projects_api, "_call_plan_model", lambda prompt: json.dumps(PLAN)
    )
    monkeypatch.setattr(
        projects_api,
        "_call_brief_model",
        lambda prompt: json.dumps({
            "title": "Compare three CRM tools",
            "goal": "A clear recommendation of one CRM tool for the team.",
            "output": "CRM comparison",
        }),
    )
    yield
    projects_api._PLAN_DRAFTS.clear()


def _start(client, **body):
    payload = {"request": "Compare HubSpot, Pipedrive and Zoho CRM for us",
               "host_profile": "default"}
    payload.update(body)
    return client.post("/api/registry/projects/quick-task", json=payload)


def _detail(client, slug):
    return client.get(f"/api/registry/projects/{slug}").json()


@pytest.mark.parametrize("autonomy", ["supervised", "autonomous", "manual"])
def test_start_task_is_a_one_off_project_that_plans_and_starts(env, autonomy):
    client, _state = env
    resp = _start(client, autonomy=autonomy)
    assert resp.status_code == 200, resp.text
    created = resp.json()
    assert created["cadence"] == "one_off"
    assert created["autonomy"] == autonomy

    project = _detail(client, created["slug"])
    assert project["name"] == "Compare three CRM tools"
    assert project["goal"] == "A clear recommendation of one CRM tool for the team."
    assert project["description"] == "Compare HubSpot, Pipedrive and Zoho CRM for us"
    assert [o["title"] for o in project["outputs"]] == ["CRM comparison"]
    assert project["status"] == "active"
    assert any(m["user_id"] == OWNER.user_id and m["role"] == "lead"
               for m in project["members"])

    playbook = client.get(f"/api/registry/projects/{created['slug']}/playbook").json()
    assert playbook["active"]["rev"] == 1
    runs = client.get(f"/api/registry/projects/{created['slug']}/runs").json()["runs"]
    assert [r["run_no"] for r in runs] == [1]
    assert runs[0]["playbook_rev"] == 1
    state = client.get(f"/api/registry/projects/{created['slug']}/playbook/draft").json()
    assert state["launch"] == {"status": "started", "run_no": 1}


def test_default_check_in_is_supervised(env):
    client, _state = env
    assert _start(client).json()["autonomy"] == "supervised"


def test_check_plan_first_pauses_before_activation_then_start_approves(env):
    client, _state = env
    slug = _start(client, check_plan_first=True).json()["slug"]
    playbook = client.get(f"/api/registry/projects/{slug}/playbook").json()
    assert playbook["active"] is None
    assert len(playbook["revisions"]) == 1
    assert client.get(f"/api/registry/projects/{slug}/runs").json()["runs"] == []

    resp = client.post(f"/api/registry/projects/{slug}/quick-task/start", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "started"
    assert client.get(f"/api/registry/projects/{slug}/playbook").json()["active"]["rev"] == 1
    assert [r["run_no"] for r in client.get(
        f"/api/registry/projects/{slug}/runs").json()["runs"]] == [1]
    # A second start while run 1 is open is refused, not a second run.
    again = client.post(f"/api/registry/projects/{slug}/quick-task/start", json={})
    assert again.status_code == 409


def test_unworded_brief_keeps_the_request(env, monkeypatch):
    client, _state = env

    def _down(prompt):
        raise RuntimeError("no provider")

    monkeypatch.setattr(projects_api, "_call_brief_model", _down)
    slug = _start(client, request="Summarise last week's support tickets").json()["slug"]
    project = _detail(client, slug)
    assert project["name"] == "Summarise last week's support tickets"
    assert project["goal"] == "Summarise last week's support tickets"
    assert [o["title"] for o in project["outputs"]] == ["The result"]


def test_plan_draft_failure_is_reported_and_retry_drafts_again(env, monkeypatch):
    client, _state = env
    monkeypatch.setattr(projects_api, "_call_plan_model", lambda prompt: "no plan")
    slug = _start(client).json()["slug"]
    state = client.get(f"/api/registry/projects/{slug}/playbook/draft").json()
    assert state["status"] == "failed"
    assert client.get(f"/api/registry/projects/{slug}/runs").json()["runs"] == []

    monkeypatch.setattr(projects_api, "_call_plan_model", lambda prompt: json.dumps(PLAN))
    resp = client.post(f"/api/registry/projects/{slug}/quick-task/start", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "drafting"
    assert [r["run_no"] for r in client.get(
        f"/api/registry/projects/{slug}/runs").json()["runs"]] == [1]


@pytest.mark.parametrize(
    "body, missing",
    [({"request": "  "}, "request"), ({"host_profile": ""}, "host_profile")],
)
def test_missing_request_or_profile_is_422(env, body, missing):
    client, _state = env
    resp = _start(client, **body)
    assert resp.status_code == 422
    assert missing in resp.json()["detail"]["missing"]


def test_unknown_check_in_is_422(env):
    client, _state = env
    assert _start(client, autonomy="yolo").status_code == 422


def test_start_task_needs_a_verified_human(env):
    client, state = env
    state["subject"] = ""
    resp = _start(client)
    assert resp.status_code == 403
    assert "human act" in resp.json()["detail"]
    with projects_db.connect_closing() as conn:
        assert projects_db.list_projects(conn) == []


def test_only_a_lead_carries_a_task_on(env):
    client, state = env
    slug = _start(client, check_plan_first=True).json()["slug"]
    pid = _detail(client, slug)["id"]
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(conn, project_id=pid, user_id="ada", role="member")
    state["actor"] = MEMBER_P
    resp = client.post(f"/api/registry/projects/{slug}/quick-task/start", json={})
    assert resp.status_code == 403


def test_list_marks_task_state_for_task_mode(env):
    client, _state = env
    running = _start(client).json()["slug"]
    paused = _start(client, check_plan_first=True).json()["slug"]
    items = {i["slug"]: i for i in client.get("/api/registry/projects").json()["items"]}
    assert items[running]["latest_run"] == {"run_no": 1, "status": "running"}
    assert items[running]["plan_pending"] is False
    assert items[paused]["latest_run"] is None
    assert items[paused]["plan_pending"] is True


def test_detail_runs_carry_the_run_write_up(env):
    client, _state = env
    created = _start(client).json()
    with projects_db.connect_closing() as conn:
        run = projects_db.list_project_runs(conn, created["id"], limit=1)[0]
        projects_db.update_project_run(
            conn, run["id"], status="failed", error="The page returned 404.",
            summary="Stopped at step 1.",
        )
    runs = _detail(client, created["slug"])["runs"]
    assert runs[0]["error"] == "The page returned 404."
    assert runs[0]["summary"] == "Stopped at step 1."
