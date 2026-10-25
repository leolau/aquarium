"""POST /{slug}/changes and /changes/{id}/approve — the change-requirements flow.

Contracts: a change is recorded as a directive carrying its kinds + apply
mode; ``now`` stops the open run the way the stop route does (finished
cards and deliveries survive) and drafts a revised plan; ``next`` drafts
and leaves the run alone; ``record`` only saves. Approve activates the
drafted revision and starts the next run through the ordinary start path
(409 while a run is open); a replay never acts twice.
"""

from __future__ import annotations

import json
import time
import types

import pytest

from hermes_cli import kanban_db, projects_api, projects_changes_api, projects_db

from tests.hermes_cli.test_projects_api_runs import (  # noqa: F401
    MEMBER_P,
    OWNER,
    STRANGER,
    STEPS,
    VIEWER_P,
    _active_project,
    _save_and_activate_playbook,
    env,
)

NEW_STEPS = [
    {"key": "gather", "title": "Collect arrivals"},
    {"key": "translate", "title": "Translate to Chinese", "depends_on": ["gather"]},
    {"key": "send", "title": "Send to the list", "depends_on": ["translate"]},
]


@pytest.fixture
def cenv(env):  # noqa: F811
    client, state = env
    client.app.include_router(projects_changes_api.router)
    return client, state


@pytest.fixture(autouse=True)
def _clear_drafts():
    projects_api._PLAN_DRAFTS.clear()
    yield
    projects_api._PLAN_DRAFTS.clear()


@pytest.fixture
def model(monkeypatch):
    seen: dict = {"prompts": []}

    def fake_model(prompt):
        seen["prompts"].append(prompt)
        return json.dumps(
            {
                "body": "Now in Chinese too.",
                "steps": NEW_STEPS,
                "reading": seen.get(
                    "reading",
                    {
                        "changes": ["Add a Chinese edition"],
                        "affected_outputs": ["The Monday digest email", "Nope"],
                        "supersedes": [],
                    },
                ),
            }
        )

    monkeypatch.setattr(projects_api, "_call_plan_model", fake_model)
    return seen


def _url(project, tail=""):
    return f"/api/registry/projects/{project['slug']}{tail}"


def _wait_draft(client, project, timeout=5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = client.get(_url(project, "/playbook/draft")).json()
        if state["status"] in ("done", "failed"):
            return state
        time.sleep(0.02)
    raise AssertionError("draft never finished")


def _start_run(client, project) -> dict:
    resp = client.post(_url(project, "/runs"), json={})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _change(client, project, apply, text="Add a Chinese edition", kinds=("add",), **kw):
    return client.post(
        _url(project, "/changes"),
        json={"text": text, "kinds": list(kinds), "apply": apply},
        **kw,
    )


# ---------------------------------------------------------------------------
# POST /changes
# ---------------------------------------------------------------------------


def test_record_saves_the_directive_and_starts_nothing(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    _start_run(client, project)

    resp = _change(client, project, "record", kinds=["memory", "add", "memory"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["draft"] == {"status": "idle"}
    assert body["stopped_run"] is None
    change = body["change"]
    assert change["kind"] == "directive" and change["active"] == 1
    assert change["body"] == "Add a Chinese edition"
    assert change["kinds"] == ["memory", "add"]
    assert change["apply"] == "record"
    assert change["is_change"] is True
    assert body["applies_from"] == "next run"

    assert model["prompts"] == []
    runs = client.get(_url(project, "/runs")).json()["runs"]
    assert runs[0]["status"] == "running"
    # The ordinary directive surface sees it too.
    directives = client.get(_url(project, "/directives")).json()
    assert any(d["id"] == change["id"] for d in directives["directives"])


def test_next_drafts_a_seeded_plan_and_leaves_the_run_alone(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    old = client.post(
        _url(project, "/directives"),
        json={"kind": "directive", "body": "Keep it under 500 words"},
    ).json()
    model["reading"] = {
        "changes": ["Add a Chinese edition", "Drop the word cap"],
        "affected_outputs": ["the monday digest email"],
        "supersedes": [f"[{old['id']}]", "d_unknown"],
    }
    _start_run(client, project)

    resp = _change(client, project, "next", kinds=["add", "output"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["draft"]["status"] == "running"
    assert body["draft"]["change_id"] == body["change"]["id"]
    assert body["stopped_run"] is None

    state = _wait_draft(client, project)
    assert state["status"] == "done", state
    rev = state["rev"]
    assert state["change_id"] == body["change"]["id"]
    reading = state["reading"]
    assert reading["changes"] == ["Add a Chinese edition", "Drop the word cap"]
    assert [o["title"] for o in reading["affected_outputs"]] == [
        "The Monday digest email"
    ]
    assert reading["supersedes"] == [{"id": old["id"], "body": "Keep it under 500 words"}]

    (prompt,) = model["prompts"]
    assert "Add a Chinese edition" in prompt
    assert "kinds: add, output" in prompt
    assert f"[{old['id']}] Keep it under 500 words" in prompt
    assert "[approve] Owner reviews" in prompt  # the current plan
    # The change itself is not listed among the "current" requirements.
    assert f"[{body['change']['id']}]" not in prompt

    playbook = client.get(_url(project, "/playbook")).json()
    assert playbook["active"]["rev"] == 1  # the draft is not activated
    drafted = next(r for r in playbook["revisions"] if r["rev"] == rev)
    assert drafted["active"] in (0, False)
    assert [s["key"] for s in drafted["steps"]] == ["gather", "translate", "send"]

    runs = client.get(_url(project, "/runs")).json()["runs"]
    assert runs[0]["status"] == "running"

    history = client.get(_url(project, "/changes")).json()
    change = next(c for c in history["changes"] if c["id"] == body["change"]["id"])
    assert change["draft_rev"] == rev
    assert change["reading"]["changes"][0] == "Add a Chinese edition"
    plain = next(c for c in history["changes"] if c["id"] == old["id"])
    assert plain["is_change"] is False and plain["kinds"] == []


def test_change_response_reports_the_draft_as_started_even_if_it_already_finished(
    cenv, model, monkeypatch
):
    """The draft job may finish before the route returns; the response still
    describes the job it started, and the poll endpoint shows the outcome."""

    class _FinishFirstThread:
        def __init__(self, *, target, kwargs, **_):
            self._run = lambda: target(**kwargs)

        def start(self):
            self._run()

    monkeypatch.setattr(
        projects_changes_api, "threading", types.SimpleNamespace(Thread=_FinishFirstThread)
    )
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)

    resp = _change(client, project, "next")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["draft"]["status"] == "running"
    assert body["draft"]["change_id"] == body["change"]["id"]
    state = client.get(_url(project, "/playbook/draft")).json()
    assert state["status"] == "done", state


def test_now_stops_the_open_run_and_keeps_finished_work(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    started = _start_run(client, project)
    cards = started["cards"]
    done_card, running_card = cards["gather"], cards["approve"]
    with kanban_db.connect_closing() as bconn:
        bconn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (done_card,))
        bconn.execute(
            "UPDATE tasks SET status = 'running' WHERE id = ?", (running_card,)
        )
    with projects_db.connect_closing() as conn:
        out = projects_db.get_project_outputs(conn, project["id"])[0]
        projects_db.record_output_delivery(
            conn, output_id=out["id"], run_id=started["run"]["id"],
            task_id=done_card, label="Issue 1",
        )

    resp = _change(client, project, "now", kinds=["direction"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stopped_run"] == 1
    assert body["change"]["stopped_run"] == 1
    assert body["draft"]["status"] == "running"

    run = client.get(_url(project, "/runs")).json()["runs"][0]
    assert run["status"] == "cancelled"
    with kanban_db.connect_closing() as bconn:
        assert kanban_db.get_task(bconn, done_card).status == "done"
        assert kanban_db.get_task(bconn, running_card).status == "blocked"
    with projects_db.connect_closing() as conn:
        assert len(projects_db.get_output_deliveries(conn, project_id=project["id"])) == 1
    assert _wait_draft(client, project)["status"] == "done"

    history = client.get(_url(project, "/changes")).json()
    (run_row,) = history["runs"]
    assert run_row["deliveries"] == 1
    assert run_row["cards_done"] == 1 and run_row["cards_total"] == 3


def test_now_without_an_open_run_only_drafts(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    resp = _change(client, project, "now")
    assert resp.status_code == 200, resp.text
    assert resp.json()["stopped_run"] is None
    assert _wait_draft(client, project)["status"] == "done"


def test_a_failed_draft_is_reported_and_can_be_redrafted(cenv, monkeypatch):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)

    def boom(prompt):
        raise RuntimeError("no model")

    monkeypatch.setattr(projects_api, "_call_plan_model", boom)
    change = _change(client, project, "next").json()["change"]
    assert _wait_draft(client, project)["status"] == "failed"

    monkeypatch.setattr(
        projects_api, "_call_plan_model",
        lambda prompt: json.dumps({"steps": NEW_STEPS}),
    )
    resp = client.post(_url(project, f"/changes/{change['id']}/draft"))
    assert resp.status_code == 200, resp.text
    state = _wait_draft(client, project)
    assert state["status"] == "done"
    # No reading from the model → the change text is the one change.
    assert state["reading"]["changes"] == ["Add a Chinese edition"]

    resp = client.post(_url(project, "/changes/d_nope/draft"))
    assert resp.status_code == 404


def test_same_idempotency_key_records_once(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    headers = {"Idempotency-Key": "k-123"}
    first = _change(client, project, "record", headers=headers).json()
    second = _change(client, project, "record", headers=headers).json()
    assert second["replayed"] is True
    assert second["change"]["id"] == first["change"]["id"]
    directives = client.get(_url(project, "/directives")).json()["directives"]
    assert len([d for d in directives if d["body"] == "Add a Chinese edition"]) == 1
    third = _change(client, project, "record", headers={"Idempotency-Key": "k-2"})
    assert third.json()["change"]["id"] != first["change"]["id"]


def test_a_second_draft_while_one_runs_is_409_and_records_nothing(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    projects_api._PLAN_DRAFTS[project["id"]] = {"status": "running"}
    resp = _change(client, project, "next")
    assert resp.status_code == 409
    assert "already drafting" in resp.json()["detail"]
    directives = client.get(_url(project, "/directives")).json()["directives"]
    assert directives == []


@pytest.mark.parametrize(
    "payload, needle",
    [
        ({"text": "  ", "kinds": [], "apply": "record"}, "describe"),
        ({"text": "x", "kinds": ["bogus"], "apply": "record"}, "kind"),
        ({"text": "x", "kinds": "add", "apply": "record"}, "kinds"),
        ({"text": "x", "kinds": [], "apply": "later"}, "apply"),
        ({"text": "x" * 4001, "kinds": [], "apply": "record"}, "under"),
    ],
)
def test_change_validation(cenv, payload, needle):
    client, _ = cenv
    project = _active_project(cenv)
    resp = client.post(_url(project, "/changes"), json=payload)
    assert resp.status_code == 422, resp.text
    assert needle in resp.json()["detail"]


def test_change_permissions(cenv, model):
    client, state = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)

    state["actor"] = VIEWER_P
    assert _change(client, project, "record").status_code == 403
    state["actor"] = STRANGER
    assert _change(client, project, "record").status_code in (403, 404)
    state["actor"] = MEMBER_P
    assert _change(client, project, "record").status_code == 200
    # Reading the history is a read.
    state["actor"] = VIEWER_P
    assert client.get(_url(project, "/changes")).status_code == 200


def test_archived_project_refuses_changes(cenv):
    client, _ = cenv
    project = _active_project(cenv)
    with projects_db.connect_closing() as conn:
        projects_db.archive_project(conn, project["id"])
    resp = _change(client, project, "record")
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# POST /changes/{id}/approve
# ---------------------------------------------------------------------------


def _drafted_change(cenv, *, apply="next", run_open=False):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    if run_open:
        _start_run(client, project)
    body = _change(client, project, apply).json()
    state = _wait_draft(client, project)
    assert state["status"] == "done", state
    return project, body["change"], state["rev"]


def test_approve_activates_the_rev_and_starts_the_next_run(cenv, model):
    client, _ = cenv
    project, change, rev = _drafted_change(cenv, apply="now")
    resp = client.post(_url(project, f"/changes/{change['id']}/approve"), json={"rev": rev})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rev"] == rev and body["active"] is True
    assert body["run"]["run_no"] == 1
    assert body["run"]["playbook_rev"] == rev
    assert body["change"]["approved"]["rev"] == rev
    assert body["change"]["approved"]["run_no"] == 1
    assert client.get(_url(project, "/playbook")).json()["active"]["rev"] == rev


def test_approve_after_now_stopped_the_run_starts_iteration_two(cenv, model):
    client, _ = cenv
    project, change, rev = _drafted_change(cenv, apply="now", run_open=True)
    resp = client.post(_url(project, f"/changes/{change['id']}/approve"), json={"rev": rev})
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"]["run_no"] == 2


def test_approve_is_409_while_a_run_is_open_and_changes_nothing(cenv, model):
    client, _ = cenv
    project, change, rev = _drafted_change(cenv, apply="next", run_open=True)
    resp = client.post(_url(project, f"/changes/{change['id']}/approve"), json={"rev": rev})
    assert resp.status_code == 409
    assert "Run 1 is still open" in resp.json()["detail"]
    assert client.get(_url(project, "/playbook")).json()["active"]["rev"] == 1
    runs = client.get(_url(project, "/runs")).json()["runs"]
    assert len(runs) == 1


def test_repeat_approve_is_idempotent(cenv, model):
    client, _ = cenv
    project, change, rev = _drafted_change(cenv)
    url = _url(project, f"/changes/{change['id']}/approve")
    first = client.post(url, json={"rev": rev}).json()
    second = client.post(url, json={"rev": rev})
    assert second.status_code == 200, second.text
    assert second.json()["replayed"] is True
    assert second.json()["run"]["run_no"] == first["run"]["run_no"] == 1
    assert len(client.get(_url(project, "/runs")).json()["runs"]) == 1


def test_save_without_running_activates_only(cenv, model):
    client, _ = cenv
    project, change, rev = _drafted_change(cenv)
    url = _url(project, f"/changes/{change['id']}/approve")
    resp = client.post(url, json={"rev": rev, "start": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["run"] is None
    assert client.get(_url(project, "/playbook")).json()["active"]["rev"] == rev
    assert client.get(_url(project, "/runs")).json()["runs"] == []
    # Saving again replays; approving to run later still starts one run.
    assert client.post(url, json={"rev": rev, "start": False}).json()["replayed"] is True
    started = client.post(url, json={"rev": rev}).json()
    assert started["run"]["run_no"] == 1


def test_approve_retires_superseded_requirements(cenv, model):
    client, _ = cenv
    project = _active_project(cenv)
    _save_and_activate_playbook(cenv, project)
    old = client.post(
        _url(project, "/directives"),
        json={"kind": "directive", "body": "English only"},
    ).json()
    change = _change(client, project, "next").json()["change"]
    rev = _wait_draft(client, project)["rev"]
    resp = client.post(
        _url(project, f"/changes/{change['id']}/approve"),
        json={"rev": rev, "supersedes": [old["id"], change["id"], "d_nope"]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["superseded"] == [old["id"]]
    history = client.get(_url(project, "/changes")).json()["changes"]
    retired = next(c for c in history if c["id"] == old["id"])
    assert retired["active"] == 0 and retired["superseded_by"] == change["id"]


def test_approve_validation_and_permissions(cenv, model):
    client, state = cenv
    project, change, rev = _drafted_change(cenv)
    url = _url(project, f"/changes/{change['id']}/approve")
    assert client.post(url, json={}).status_code == 422
    assert client.post(url, json={"rev": "x"}).status_code == 422
    assert client.post(url, json={"rev": 99}).status_code == 404
    assert (
        client.post(_url(project, "/changes/d_nope/approve"), json={"rev": rev}).status_code
        == 404
    )
    # A plain directive is not a change.
    plain = client.post(
        _url(project, "/directives"), json={"kind": "directive", "body": "x"}
    ).json()
    assert (
        client.post(_url(project, f"/changes/{plain['id']}/approve"), json={"rev": rev}).status_code
        == 404
    )
    # Activation is a lead act.
    state["actor"] = MEMBER_P
    assert client.post(url, json={"rev": rev}).status_code == 403
    state["actor"] = OWNER
    state["subject"] = ""
    assert client.post(url, json={"rev": rev}).status_code in (401, 403)
