"""Task mode's Start approves the run's cards (no second "Approve all").

Contracts: a run started from Task mode (``POST /{slug}/quick-task/start``
or the auto-launch after ``POST /quick-task``) is ``auto_approve``. Its
cards still respect ``max_in_progress`` — the cap limits how many run at
once — but the ones it keeps in triage are queued, and each settled card
releases the next without a human click, dependency order intact. Gates
that are genuinely human stay: ``manual`` autonomy is never auto-approved,
a checkpoint still holds its successors until Continue, and Project mode's
"Start iteration" (``POST /{slug}/runs``) is unchanged.
"""

from __future__ import annotations

import json
import threading
import types

import pytest

from hermes_cli import kanban_db, projects_api, projects_board_api, projects_db
from tests.hermes_cli.test_projects_api_runs import (  # noqa: F401
    OWNER,
    env,
)

PREFIX = "/api/registry/projects"

PLAN = {"body": "Find, compare, report.", "steps": [
    {"key": "find", "title": "Find the options"},
    {"key": "price", "title": "Check the prices"},
    {"key": "report", "title": "Write the comparison", "depends_on": ["find", "price"]},
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


@pytest.fixture
def plan():
    return json.loads(json.dumps(PLAN))


@pytest.fixture(autouse=True)
def _inline(monkeypatch, plan):
    projects_api._PLAN_DRAFTS.clear()
    monkeypatch.setattr(
        projects_api, "threading", types.SimpleNamespace(Thread=_InlineThread)
    )
    monkeypatch.setattr(projects_api, "_call_plan_model", lambda prompt: json.dumps(plan))
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


@pytest.fixture
def client(env):
    client, _state = env
    client.app.include_router(projects_board_api.router)
    return client


def _create(client, **body):
    payload = {"request": "Compare HubSpot, Pipedrive and Zoho CRM for us",
               "host_profile": "default"}
    payload.update(body)
    resp = client.post(f"{PREFIX}/quick-task", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _cards(project_id: str) -> dict[str, str]:
    """step key → board status for the newest run's cards."""
    with projects_db.connect_closing() as conn:
        run = projects_db.list_project_runs(conn, project_id, limit=1)[0]
        links = projects_db.get_run_cards(conn, run["id"])
    with kanban_db.connect_closing() as bconn:
        return {rc["step_key"]: kanban_db.get_task(bconn, rc["task_id"]).status for rc in links}


def _task_id(project_id: str, step_key: str) -> str:
    with projects_db.connect_closing() as conn:
        run = projects_db.list_project_runs(conn, project_id, limit=1)[0]
        links = projects_db.get_run_cards(conn, run["id"])
    return next(rc["task_id"] for rc in links if rc["step_key"] == step_key)


def _finish(project_id: str, step_key: str) -> None:
    task_id = _task_id(project_id, step_key)
    with kanban_db.connect_closing() as bconn:
        assert kanban_db.claim_task(bconn, task_id, claimer="test:1")
        assert kanban_db.complete_task(bconn, task_id, result="ok")


def _start_after_review(client, **body) -> dict:
    created = _create(client, check_plan_first=True, **body)
    resp = client.post(f"{PREFIX}/{created['slug']}/quick-task/start", json={})
    assert resp.status_code == 200, resp.text
    return created


def test_start_marks_the_run_approved_and_the_queue_drains_without_a_click(client):
    created = _start_after_review(client)
    slug, pid = created["slug"], created["id"]
    assert _detail_runs(client, slug)[0]["auto_approve"] is True
    ctx = client.get(f"{PREFIX}/{slug}/board/context").json()
    assert ctx["open_run"]["auto_approve"] is True

    # The cap (1) still limits what runs at once: one card out, the rest
    # queued in triage, the dependent one last.
    cards = _cards(pid)
    assert cards["find"] in ("todo", "ready")
    assert cards["price"] == "triage" and cards["report"] == "triage"

    # Each settled card frees the slot for the next — no Approve all.
    _finish(pid, "find")
    cards = _cards(pid)
    assert cards["price"] in ("todo", "ready")
    assert cards["report"] == "triage"

    _finish(pid, "price")
    assert _cards(pid)["report"] == "ready"


def test_initial_auto_launch_is_approved_too(client):
    created = _create(client)
    runs = _detail_runs(client, created["slug"])
    assert [r["run_no"] for r in runs] == [1]
    assert runs[0]["auto_approve"] is True


def test_a_higher_cap_runs_independent_cards_together_but_keeps_dependency_order(client):
    created = _create(client, check_plan_first=True)
    slug, pid = created["slug"], created["id"]
    resp = client.patch(f"{PREFIX}/{slug}", json={"max_in_progress": 3})
    assert resp.status_code == 200, resp.text
    assert client.post(f"{PREFIX}/{slug}/quick-task/start", json={}).status_code == 200
    cards = _cards(pid)
    assert cards["find"] == "ready" and cards["price"] == "ready"
    # Approved, but its parents are open: it waits in todo, it never jumps.
    assert cards["report"] in ("triage", "todo")
    _finish(pid, "find")
    assert _cards(pid)["report"] != "ready"
    _finish(pid, "price")
    assert _cards(pid)["report"] == "ready"


def test_every_step_autonomy_keeps_asking(client):
    created = _start_after_review(client, autonomy="manual")
    assert _detail_runs(client, created["slug"])[0]["auto_approve"] is False
    assert set(_cards(created["id"]).values()) == {"triage"}


def test_a_checkpoint_still_holds_its_successors_until_continue(client, plan):
    plan["steps"][0]["checkpoint"] = True
    plan["steps"] = [plan["steps"][0], {**plan["steps"][2], "depends_on": ["find"]}]
    created = _start_after_review(client)
    pid = created["id"]
    assert _detail_runs(client, created["slug"])[0]["auto_approve"] is True
    _finish(pid, "find")
    assert _cards(pid)["report"] == "triage"


def test_project_mode_start_iteration_is_unchanged(client):
    created = _create(client, check_plan_first=True)
    slug = created["slug"]
    with projects_db.connect_closing() as conn:
        assert projects_db.activate_playbook_rev(conn, created["id"], 1, note="test")
        projects_db.set_project_status(conn, created["id"], "active")
    resp = client.post(f"{PREFIX}/{slug}/runs", json={})
    assert resp.status_code == 200, resp.text
    assert _detail_runs(client, slug)[0]["auto_approve"] is False
    ctx = client.get(f"{PREFIX}/{slug}/board/context").json()
    assert ctx["open_run"]["auto_approve"] is False


def test_a_legacy_runs_table_gains_the_column(tmp_path, monkeypatch):
    import sqlite3

    db = tmp_path / "legacy.db"
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(db))
    with projects_db.connect_closing():
        pass
    raw = sqlite3.connect(db)
    raw.execute("ALTER TABLE project_runs DROP COLUMN auto_approve")
    raw.commit()
    raw.close()
    monkeypatch.setattr(projects_db, "_INITIALIZED_PATHS", set())
    with projects_db.connect_closing() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(project_runs)")}
    assert "auto_approve" in cols


def _detail_runs(client, slug):
    return client.get(f"{PREFIX}/{slug}").json()["runs"]
