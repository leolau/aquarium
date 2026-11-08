"""FG-34 W2 — the planner assigns steps from the requester's capability
roster, and approving a plan attaches the profiles it names.

Contracts: the drafter sees ``roster_prompt_block`` of every profile the
requester may use (background re-plans: the project owner's set); a pick
outside that set falls back to the host with ``assigned_by: "fallback"``
and a reason; ``matched_skills`` only names the picked profile's skills
or tools; activating or starting a plan attaches an accessible profile it
names and refuses (403, nothing attached) one the approver cannot use.
"""

from __future__ import annotations

import json
import time

import pytest

from hermes_cli import profile_capabilities as pc, projects_api, projects_db
from hermes_cli.access import Principal

from tests.hermes_cli.test_profile_capabilities import _make_profile
from tests.hermes_cli.test_projects_api import OWNER, _create, env  # noqa: F401

LEAD = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _profiles_and_drafts():
    projects_api._PLAN_DRAFTS.clear()
    _make_profile(
        "researcher", description="Finds and cites sources.",
        skills=("research/web-research", "research/arxiv"),
    )
    _make_profile("writer", description="Writes reports.", skills=("writing/report",))
    _make_profile("secret", description="Box-only operator.")
    yield
    projects_api._PLAN_DRAFTS.clear()


def _wait_done(client, slug, timeout=5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = client.get(f"/api/registry/projects/{slug}/playbook/draft").json()
        if state["status"] in ("done", "failed"):
            return state
        time.sleep(0.02)
    raise AssertionError("draft never finished")


def _draft(env, monkeypatch, steps, *, slug=None) -> tuple[dict, str]:
    client, _state = env
    slug = slug or _create(env)["slug"]
    seen = {}

    def fake_model(prompt):
        seen["prompt"] = prompt
        return json.dumps({"body": "Plan.", "steps": steps})

    monkeypatch.setattr(projects_api, "_call_plan_model", fake_model)
    resp = client.post(f"/api/registry/projects/{slug}/playbook/draft")
    assert resp.status_code == 200, resp.text
    state = _wait_done(client, slug)
    assert state["status"] == "done", state
    (rev,) = client.get(f"/api/registry/projects/{slug}/playbook").json()["revisions"]
    return {s["key"]: s for s in rev["steps"]}, seen["prompt"]


def _lead_project(env) -> dict:
    """A project ``LEAD`` leads; LEAD may use ``writer`` (enrolled) and
    the project's own ``default`` — not ``researcher`` or ``secret``."""
    _client, state = env
    project = _create(env)
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id="ada", role="lead"
        )
    state["actor"] = LEAD
    state["enrolled"] = {"writer"}
    return project


def test_prompt_lists_the_roster_and_the_right_pick_is_kept(env, monkeypatch):
    steps, prompt = _draft(env, monkeypatch, [{
        "key": "sources", "title": "Collect sources", "assignee": "researcher",
        "assignee_reason": "Has web research skills and a good track record.",
        "fit": "strong",
        "matched_skills": ["web-research", "research/arxiv", "made-up-skill", "writing/report"],
    }])
    assert "Profiles a step may be assigned to" in prompt
    assert "- researcher: Finds and cites sources." in prompt
    assert "research/web-research" in prompt
    assert "- secret: Box-only operator." in prompt  # owner/admin: every profile
    step = steps["sources"]
    assert step["assignee"] == "researcher"
    assert step["assigned_by"] == "planner"
    assert step["fit"] == "strong"
    assert step["matched_skills"] == ["web-research", "arxiv"]
    assert step["assignee_reason"] == "Has web research skills and a good track record."
    assert step["suggested_profile"] is None


def test_unknown_pick_falls_back_to_the_host_with_a_reason(env, monkeypatch):
    steps, _prompt = _draft(env, monkeypatch, [
        {"key": "a", "title": "Do it", "assignee": "nobody-i-know",
         "fit": "strong", "matched_skills": ["web-research"]},
        {"key": "b", "title": "Design the logo", "assignee": None, "fit": "none",
         "assignee_reason": "Nobody can draw.", "suggested_profile": "designer"},
    ])
    a, b = steps["a"], steps["b"]
    assert a["assignee"] == "default"
    assert (a["assigned_by"], a["fit"], a["matched_skills"]) == ("fallback", "none", [])
    assert "nobody-i-know" in a["assignee_reason"]
    assert b["assignee"] == "default"
    assert (b["assigned_by"], b["fit"]) == ("fallback", "none")
    assert "Nobody can draw." in b["assignee_reason"]
    assert b["suggested_profile"] == "designer"


def test_inaccessible_pick_falls_back_for_a_non_admin(env, monkeypatch):
    project = _lead_project(env)
    steps, prompt = _draft(env, monkeypatch, [
        {"key": "a", "title": "Write it", "assignee": "writer", "fit": "partial",
         "matched_skills": ["report"]},
        {"key": "b", "title": "Operate", "assignee": "secret", "fit": "strong"},
    ], slug=project["slug"])
    assert "- writer: Writes reports." in prompt
    assert "- secret:" not in prompt and "- researcher:" not in prompt
    assert steps["a"]["assignee"] == "writer"
    assert steps["a"]["matched_skills"] == ["report"]
    b = steps["b"]
    assert b["assignee"] == "default"
    assert b["assigned_by"] == "fallback"
    assert "'secret'" in b["assignee_reason"]


def test_reason_is_trimmed_to_240_chars():
    steps = projects_api._normalise_draft_steps(
        [{"title": "Go", "assignee": "writer", "assignee_reason": "x" * 400}],
        assignee="default", profile_names={"default", "writer"},
        roster=[{"name": "writer", "skills": [], "toolsets": []}],
    )
    assert len(steps[0]["assignee_reason"]) == projects_db.STEP_REASON_MAX


def _save_plan(project: dict, assignee: str) -> None:
    with projects_db.connect_closing() as conn:
        projects_db.save_playbook_rev(
            conn, project_id=project["id"], body="Plan",
            steps=[{"key": "a", "title": "Do it", "assignee": assignee}],
            created_by="ada",
        )


def _project_profiles(project: dict) -> dict:
    with projects_db.connect_closing() as conn:
        return {
            p["profile"]: p
            for p in projects_db.get_project_profiles(conn, project["id"])
        }


def test_activation_attaches_an_accessible_profile(env):
    client, state = env
    project = _lead_project(env)
    state["subject"] = "ada"
    _save_plan(project, "writer")
    resp = client.post(f"/api/registry/projects/{project['slug']}/playbook/1/activate", json={})
    assert resp.status_code == 200, resp.text
    attached = _project_profiles(project)
    assert attached["writer"]["added_by"] == "ada"


def test_activation_refuses_an_inaccessible_profile(env):
    client, state = env
    project = _lead_project(env)
    state["subject"] = "ada"
    _save_plan(project, "secret")
    resp = client.post(f"/api/registry/projects/{project['slug']}/playbook/1/activate", json={})
    assert resp.status_code == 403
    assert "'secret'" in resp.json()["detail"]
    assert "secret" not in _project_profiles(project)
    with projects_db.connect_closing() as conn:
        assert projects_db.get_playbook(conn, project["id"]) is None


def test_attach_checks_every_step_before_attaching_any(env):
    from hermes_cli import projects_run

    project = _lead_project(env)
    with projects_db.connect_closing() as conn:
        proj = projects_db.get_project(conn, project["id"])
        with pytest.raises(projects_run.AssigneeNotAccessible):
            projects_run.attach_plan_profiles(
                conn, proj,
                [{"key": "a", "assignee": "writer"}, {"key": "b", "assignee": "secret"}],
                accessible=["default", "writer"], added_by="ada",
            )
    assert "writer" not in _project_profiles(project)


def test_replan_uses_the_project_owners_set(env, monkeypatch):
    project = _lead_project(env)
    seen = {}

    def _for_user(user_id, *, project=None):
        seen["user_id"] = user_id
        return ["default", "secret"]

    monkeypatch.setattr(pc, "accessible_profile_names_for_user", _for_user)
    monkeypatch.setattr(
        projects_api, "_call_plan_model",
        lambda prompt: seen.setdefault("prompt", prompt) and json.dumps({
            "body": "Re-plan.",
            "steps": [{"key": "a", "title": "Operate", "assignee": "secret",
                       "fit": "strong"}],
        }),
    )
    with projects_db.connect_closing() as conn:
        proj = projects_db.get_project(conn, project["id"])
    done = {}
    assert projects_api.start_replan_draft(
        proj, context="The step is stuck.", note="re-plan",
        on_claimed=lambda: None, on_saved=lambda rev: done.setdefault("rev", rev),
        on_failed=lambda detail: done.setdefault("failed", detail),
    )
    deadline = time.time() + 5
    while not done and time.time() < deadline:
        time.sleep(0.02)
    assert done.get("rev") == 1, done
    assert seen["user_id"] is None
    assert "- secret: Box-only operator." in seen["prompt"]
    assert "- writer:" not in seen["prompt"]
    with projects_db.connect_closing() as conn:
        (step,) = projects_db.get_playbook(conn, project["id"], rev=1)["steps"]
    assert (step["assignee"], step["assigned_by"]) == ("secret", "planner")
