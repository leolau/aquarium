"""FG-34 W4: a plan step's assignment fields (C-3) follow it onto its card.

Behaviour contracts:

- the C-3 fields survive a playbook save; a step without them is saved
  exactly as before;
- a run copies them onto each card, and the card read returns them as
  ``assignment`` (``null`` for a card that never had them);
- a person changing the assignee — on the card or in the plan editor —
  marks it ``manual``, clears ``fit``/``matched_skills`` and keeps the
  planner's own pick as ``planner_assignee``; old cards and steps are left
  alone.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_db, projects_run
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
PREFIX = "/api/registry/projects"

PLANNED = {
    "assignee_reason": "Has web-research and citation; finished 14 research cards.",
    "fit": "strong",
    "matched_skills": ["web-research", "citation"],
    "assigned_by": "planner",
    "suggested_profile": None,
}

STEPS = [
    {"key": "research", "title": "Collect competitor pricing",
     "assignee": "researcher", **PLANNED},
    {"key": "write", "title": "Draft the report", "depends_on": ["research"],
     "assignee": None, "assignee_reason": "No profile has an email skill.",
     "fit": "none", "matched_skills": [], "assigned_by": "fallback",
     "suggested_profile": "mailer"},
    {"key": "legacy", "title": "Owner reviews", "depends_on": ["write"]},
]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setattr("hermes_cli.datastore.get_store", lambda *a, **k: object())
    monkeypatch.setattr(
        projects_run, "_enabled_toolsets_for_profile", lambda profile: ["web"]
    )
    monkeypatch.setattr(projects_run, "_available_skill_names", lambda profile: [])

    async def _resolve(request, *, allow_as=True):
        return OWNER

    async def _enrolled(user_id):
        return set()

    async def _subject(request):
        return OWNER.user_id

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)

    app = FastAPI()
    app.include_router(projects_api.router)
    return TestClient(app)


def _project(client) -> dict:
    resp = client.post(
        PREFIX,
        json={
            "goal": "Ship the pricing report to the client",
            "description": "Research competitors and write the report.",
            "host_profile": "default",
            "outputs": [{"title": "The pricing report"}],
        },
    )
    assert resp.status_code == 200, resp.text
    project = resp.json()
    with projects_db.connect_closing() as conn:
        for name in ("researcher", "writer"):
            projects_db.add_project_profile(
                conn, project_id=project["id"], profile=name, added_by="leo"
            )
        projects_db.set_project_status(conn, project["id"], "active")
    return project


def _planner_rev(project, steps=STEPS) -> int:
    """What the planner writes: a revision whose steps carry C-3 fields."""
    with projects_db.connect_closing() as conn:
        return projects_db.save_playbook_rev(
            conn, project_id=project["id"], body="Plan", steps=steps,
            created_by="leo",
        )


def _run(client, project) -> dict:
    rev = _planner_rev(project)
    resp = client.post(f"{PREFIX}/{project['slug']}/playbook/{rev}/activate", json={})
    assert resp.status_code == 200, resp.text
    resp = client.post(f"{PREFIX}/{project['slug']}/runs", json={})
    assert resp.status_code == 200, resp.text
    return resp.json()["cards"]


def _card(client, project, task_id) -> dict:
    resp = client.get(f"{PREFIX}/{project['slug']}/cards/{task_id}")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_validate_keeps_c3_fields_and_leaves_old_steps_untouched():
    cleaned = projects_db.validate_playbook_steps(STEPS)
    assert {k: cleaned[0][k] for k in PLANNED} == PLANNED
    assert cleaned[1]["suggested_profile"] == "mailer"
    assert set(cleaned[2]) == {
        "key", "title", "body", "mode", "assignee", "depends_on",
        "checkpoint", "toolsets",
    }


def test_step_assignment_cleans_without_refusing():
    long = "x" * 500
    got = projects_db.step_assignment({
        "assignee_reason": long, "fit": "excellent",
        "matched_skills": ["a", "a", 3, " b "], "assigned_by": "robot",
    })
    assert got == {"assignee_reason": "x" * 240, "matched_skills": ["a", "b"]}
    assert projects_db.step_assignment({"key": "k", "title": "t"}) is None


def test_run_cards_carry_the_assignment(env):
    client = env
    project = _project(client)
    cards = _run(client, project)

    research = _card(client, project, cards["research"])
    assert research["assignee"] == "researcher"
    assert research["assignment"] == {"assignee": "researcher", **PLANNED}

    write = _card(client, project, cards["write"])
    assert write["assignee"] == "default"  # fell back to the host
    assert write["assignment"]["assigned_by"] == "fallback"
    assert write["assignment"]["fit"] == "none"
    assert write["assignment"]["suggested_profile"] == "mailer"

    assert _card(client, project, cards["legacy"])["assignment"] is None


def test_hand_reassigning_a_card_marks_it_manual(env):
    client = env
    project = _project(client)
    cards = _run(client, project)

    resp = client.patch(
        f"{PREFIX}/{project['slug']}/cards/{cards['research']}",
        json={"assignee": "writer"},
    )
    assert resp.status_code == 200, resp.text
    got = _card(client, project, cards["research"])["assignment"]
    assert got["assignee"] == "writer"
    assert got["assigned_by"] == "manual"
    assert got["fit"] is None and got["matched_skills"] == []
    assert got["planner_assignee"] == "researcher"
    assert got["assignee_reason"] == PLANNED["assignee_reason"]

    # A second hand edit still remembers the planner's own pick.
    client.patch(
        f"{PREFIX}/{project['slug']}/cards/{cards['research']}",
        json={"assignee": "default"},
    )
    got = _card(client, project, cards["research"])["assignment"]
    assert got["assignee"] == "default"
    assert got["planner_assignee"] == "researcher"

    # A title edit is not an assignment change.
    with kanban_db.connect_closing() as bconn:
        before = len(kanban_db.list_events(bconn, cards["write"]))
    client.patch(
        f"{PREFIX}/{project['slug']}/cards/{cards['write']}",
        json={"title": "Draft the pricing report", "assignee": "default"},
    )
    with kanban_db.connect_closing() as bconn:
        kinds = [e.kind for e in kanban_db.list_events(bconn, cards["write"])[before:]]
    assert "assignment" not in kinds
    assert _card(client, project, cards["write"])["assignment"]["assigned_by"] == "fallback"

    # An old card is reassigned exactly as before.
    resp = client.patch(
        f"{PREFIX}/{project['slug']}/cards/{cards['legacy']}",
        json={"assignee": "writer"},
    )
    assert resp.status_code == 200, resp.text
    assert _card(client, project, cards["legacy"])["assignment"] is None


def test_plan_editor_reassignment_marks_the_step_manual(env):
    client = env
    project = _project(client)
    base = _planner_rev(project)

    # What today's editor sends: key/title/assignee only, no C-3 fields.
    edited = [
        {"key": "research", "title": "Collect competitor pricing",
         "assignee": "writer"},
        {"key": "write", "title": "Draft the report", "assignee": None,
         "depends_on": ["research"]},
        {"key": "legacy", "title": "Owner reviews", "assignee": "writer",
         "depends_on": ["write"]},
    ]
    resp = client.post(
        f"{PREFIX}/{project['slug']}/playbook",
        json={"steps": edited, "base_rev": base},
    )
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        steps = projects_db.get_playbook(conn, project["id"], resp.json()["rev"])["steps"]
    research, write, legacy = steps

    assert research["assignee"] == "writer"
    assert research["assigned_by"] == "manual"
    assert research["fit"] is None and research["matched_skills"] == []
    assert research["planner_assignee"] == "researcher"

    # Unchanged assignee: the planner's fields carry over untouched.
    assert write["assigned_by"] == "fallback"
    assert write["fit"] == "none" and write["suggested_profile"] == "mailer"
    assert "planner_assignee" not in write

    # An old step stays an old step, even when its assignee changes.
    assert projects_db.step_assignment(legacy) is None


def test_plan_editor_defaults_to_the_newest_revision(env):
    client = env
    project = _project(client)
    _planner_rev(project)
    resp = client.post(
        f"{PREFIX}/{project['slug']}/playbook",
        json={"steps": [{"key": "research", "title": "Collect competitor pricing",
                         "assignee": "default"}]},
    )
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        step = projects_db.get_playbook(conn, project["id"], resp.json()["rev"])["steps"][0]
    assert step["assigned_by"] == "manual"
    assert step["planner_assignee"] == "researcher"


def test_plan_without_a_base_saves_exactly_as_before(env):
    client = env
    project = _project(client)
    steps = [{"key": "a", "title": "A", "assignee": "writer"}]
    resp = client.post(f"{PREFIX}/{project['slug']}/playbook", json={"steps": steps})
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        saved = projects_db.get_playbook(conn, project["id"], resp.json()["rev"])["steps"]
    assert saved == projects_db.validate_playbook_steps(steps)
