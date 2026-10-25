"""POST/GET /{slug}/playbook/draft — the agent drafts a proposed plan.

Contracts: the model runs off the request thread and its result lands as
an ordinary *inactive* revision (activation stays human); the model's
loose output is normalised onto the playbook schema (keys, dependencies,
assignee) rather than refused; failures are reported, not raised; and a
second draft while one is running is a 409.
"""

from __future__ import annotations

import json
import time
import types

import pytest

from hermes_cli import projects_api, projects_db

from tests.hermes_cli.test_projects_api import OWNER, _create, env  # noqa: F401


def _wait_done(client, slug, timeout=5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = client.get(f"/api/registry/projects/{slug}/playbook/draft").json()
        if state["status"] in ("done", "failed"):
            return state
        time.sleep(0.02)
    raise AssertionError("draft never finished")


@pytest.fixture(autouse=True)
def _clear_drafts():
    projects_api._PLAN_DRAFTS.clear()
    yield
    projects_api._PLAN_DRAFTS.clear()


def test_draft_saves_an_inactive_revision(env, monkeypatch):
    client, _state = env
    slug = _create(env)["slug"]
    seen = {}

    def fake_model(prompt):
        seen["prompt"] = prompt
        return "```json\n" + json.dumps(
            {
                "body": "Compile, review, send.",
                "steps": [
                    {"key": "Compile Items", "title": "Compile the items"},
                    {
                        "key": "review",
                        "title": "Review the digest",
                        "depends_on": ["Compile Items"],
                        "checkpoint": True,
                        "assignee": "nobody-i-know",
                    },
                    {"title": "Send it", "depends_on": ["review", "ghost"]},
                ],
            }
        ) + "\n```"

    monkeypatch.setattr(projects_api, "_call_plan_model", fake_model)

    resp = client.post(f"/api/registry/projects/{slug}/playbook/draft")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"

    state = _wait_done(client, slug)
    assert state["status"] == "done", state
    assert state["rev"] == 1
    assert "The Monday digest email" in seen["prompt"]
    assert "Ship the Monday digest" in seen["prompt"]

    playbook = client.get(f"/api/registry/projects/{slug}/playbook").json()
    assert playbook["active"] is None
    (rev,) = playbook["revisions"]
    assert rev["active"] in (0, False)
    assert rev["note"] == "drafted by the agent"
    assert rev["body"] == "Compile, review, send."
    keys = [s["key"] for s in rev["steps"]]
    assert keys == ["compile-items", "review", "send-it"]
    by_key = {s["key"]: s for s in rev["steps"]}
    assert by_key["review"]["depends_on"] == ["compile-items"]
    assert by_key["review"]["checkpoint"] is True
    # Unknown assignee → the host profile; unknown dependency dropped.
    assert by_key["review"]["assignee"] == "default"
    assert by_key["send-it"]["depends_on"] == ["review"]


def test_draft_response_reports_the_job_as_started_even_if_it_already_finished(
    env, monkeypatch
):
    """The draft job may finish before the route returns; the response still
    describes the job it started, and the poll endpoint shows the outcome."""

    class _FinishFirstThread:
        def __init__(self, *, target, kwargs, **_):
            self._run = lambda: target(**kwargs)

        def start(self):
            self._run()

    monkeypatch.setattr(
        projects_api, "threading", types.SimpleNamespace(Thread=_FinishFirstThread)
    )
    monkeypatch.setattr(
        projects_api,
        "_call_plan_model",
        lambda prompt: json.dumps({"body": "x", "steps": [{"title": "Draft it"}]}),
    )
    client, _state = env
    slug = _create(env)["slug"]

    resp = client.post(f"/api/registry/projects/{slug}/playbook/draft")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
    state = client.get(f"/api/registry/projects/{slug}/playbook/draft").json()
    assert state["status"] == "done", state


def test_draft_reports_model_failure(env, monkeypatch):
    client, _state = env
    slug = _create(env)["slug"]
    monkeypatch.setattr(
        projects_api, "_call_plan_model", lambda prompt: "Sorry, I cannot help."
    )
    assert client.post(f"/api/registry/projects/{slug}/playbook/draft").status_code == 200
    state = _wait_done(client, slug)
    assert state["status"] == "failed"
    assert "did not return a plan" in state["detail"]
    assert client.get(f"/api/registry/projects/{slug}/playbook").json()["revisions"] == []


def test_second_draft_while_running_is_refused(env, monkeypatch):
    client, _state = env
    slug = _create(env)["slug"]
    import threading

    gate = threading.Event()

    def slow_model(prompt):
        gate.wait(5)
        return json.dumps({"steps": [{"key": "a", "title": "A"}]})

    monkeypatch.setattr(projects_api, "_call_plan_model", slow_model)
    assert client.post(f"/api/registry/projects/{slug}/playbook/draft").status_code == 200
    again = client.post(f"/api/registry/projects/{slug}/playbook/draft")
    assert again.status_code == 409
    assert "already drafting" in again.json()["detail"]
    gate.set()
    assert _wait_done(client, slug)["status"] == "done"


def test_idle_status_and_archived_refusal(env):
    client, _state = env
    created = _create(env)
    slug = created["slug"]
    assert client.get(f"/api/registry/projects/{slug}/playbook/draft").json() == {
        "status": "idle"
    }
    with projects_db.connect_closing() as conn:
        assert projects_db.archive_project(conn, created["id"])
    assert client.post(f"/api/registry/projects/{slug}/playbook/draft").status_code == 409


def _active_plan(env, steps) -> tuple[str, int]:
    created = _create(env)
    with projects_db.connect_closing() as conn:
        rev = projects_db.save_playbook_rev(
            conn, project_id=created["id"], body="The approach.", steps=steps
        )
        assert projects_db.activate_playbook_rev(conn, created["id"], rev)
    return created["slug"], rev


def test_toolsets_fill_proposes_lists_for_unstamped_steps(env, monkeypatch):
    client, _state = env
    slug, rev = _active_plan(env, [
        {"key": "research", "title": "Research the brief"},
        {"key": "draft", "title": "Draft the doc", "depends_on": ["research"],
         "toolsets": ["file"]},
        {"key": "upload", "title": "Upload to Drive", "depends_on": ["draft"]},
    ])
    monkeypatch.setattr(
        projects_api.projects_run, "_enabled_toolsets_for_profile",
        lambda profile: ["file", "terminal", "web", "google-workspace"],
    )
    seen = {}

    def fake_model(prompt):
        seen["prompt"] = prompt
        return json.dumps({"toolsets": {
            "research": ["web", "file", "made-up"],
            "draft": ["terminal"],
            "upload": ["google-workspace"],
        }})

    monkeypatch.setattr(projects_api, "_call_step_toolsets_model", fake_model)

    resp = client.post(f"/api/registry/projects/{slug}/playbook/toolsets")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["rev"] == rev + 1 and data["active"] is False
    assert data["filled"] == ["research", "upload"]
    assert "Upload to Drive" in seen["prompt"]
    assert "Draft the doc" not in seen["prompt"]
    assert "google-workspace" in seen["prompt"]

    playbook = client.get(f"/api/registry/projects/{slug}/playbook").json()
    assert playbook["active"]["rev"] == rev
    with projects_db.connect_closing() as conn:
        proj = projects_db.get_project(conn, slug)
        proposed = projects_db.get_playbook(conn, proj.id, rev=data["rev"])
    by_key = {s["key"]: s for s in proposed["steps"]}
    assert by_key["research"]["toolsets"] == ["web", "file"]
    assert by_key["draft"]["toolsets"] == ["file"]
    assert by_key["upload"]["toolsets"] == ["google-workspace"]
    assert by_key["upload"]["depends_on"] == ["draft"]
    assert proposed["body"] == "The approach."


def test_toolsets_fill_refuses_when_nothing_to_fill(env, monkeypatch):
    client, _state = env
    slug, _rev = _active_plan(env, [
        {"key": "a", "title": "A", "toolsets": ["file"]},
    ])
    called = []
    monkeypatch.setattr(
        projects_api, "_call_step_toolsets_model", lambda p: called.append(p) or "{}"
    )
    resp = client.post(f"/api/registry/projects/{slug}/playbook/toolsets")
    assert resp.status_code == 409
    assert "already has a tool list" in resp.json()["detail"]
    assert called == []


def test_toolsets_fill_without_usable_suggestion_saves_nothing(env, monkeypatch):
    client, _state = env
    slug, rev = _active_plan(env, [{"key": "a", "title": "A"}])
    monkeypatch.setattr(
        projects_api.projects_run, "_enabled_toolsets_for_profile",
        lambda profile: ["file"],
    )
    monkeypatch.setattr(
        projects_api, "_call_step_toolsets_model",
        lambda p: json.dumps({"toolsets": {"a": ["browser"]}}),
    )
    resp = client.post(f"/api/registry/projects/{slug}/playbook/toolsets")
    assert resp.status_code == 502
    revs = client.get(f"/api/registry/projects/{slug}/playbook").json()["revisions"]
    assert [r["rev"] for r in revs] == [rev]
