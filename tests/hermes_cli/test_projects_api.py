"""The Projects HTTP surface (design §12, API part 1 / §17 step 3).

Behaviour contracts, not change detectors: the mandatory-field refusals,
the §11 permission matrix (reads are 404, writes are 403, the judgement
acts stay open to members), the §9.1 progress ladder, and the rule that a
project view never leaks another user's ``private:`` card.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_db
from hermes_cli.access import Principal

# Box-wide identities. Roles here are the *instance* roles; the per-project
# membership matrix is seeded through the store below.
OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER_P = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated projects + kanban stores, a wired app, and an actor dial."""
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))

    state = {"actor": OWNER, "enrolled": set(), "subject": ""}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"])

    async def _subject(request):
        return state["subject"]

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)

    app = FastAPI()
    app.include_router(projects_api.router)
    client = TestClient(app)
    return client, state


def _create(env, *, body=None, actor=None) -> dict:
    """Create a fully-mandatory project through the API; return its payload."""
    client, state = env
    prev = state["actor"]
    if actor is not None:
        state["actor"] = actor
    try:
        payload = {
            "goal": "Ship the Monday digest — to every subscriber",
            "description": "A weekly digest compiled and emailed each Monday.",
            "host_profile": "default",
            "outputs": [{"title": "The Monday digest email"}],
        }
        if body:
            payload.update(body)
        resp = client.post("/api/registry/projects", json=payload)
        assert resp.status_code == 200, resp.text
        return resp.json()
    finally:
        state["actor"] = prev


def _activate(env, project: dict) -> None:
    """Move a fresh (planning) project to active: outputs+member+profile
    rows already exist after create, so the gate opens."""
    client, _state = env
    resp = client.patch(
        f"/api/registry/projects/{project['slug']}", json={"status": "active"}
    )
    assert resp.status_code == 200, resp.text


def _member(project_id: str, user_id: str, role: str) -> None:
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project_id, user_id=user_id, role=role
        )


# ---------------------------------------------------------------------------
# Create — the §1.1 mandatory contract
# ---------------------------------------------------------------------------


def test_create_refused_without_mandatory_fields_and_each_is_named(env):
    client, _state = env
    resp = client.post("/api/registry/projects", json={})
    assert resp.status_code == 422
    missing = resp.json()["detail"]["missing"]
    assert set(missing) == {"goal", "description", "outputs", "host_profile"}


def test_create_partial_mandatory_names_only_what_is_missing(env):
    client, _state = env
    resp = client.post(
        "/api/registry/projects",
        json={"goal": "Ship it", "description": "The brief."},
    )
    assert resp.status_code == 422
    assert set(resp.json()["detail"]["missing"]) == {"outputs", "host_profile"}


def test_create_defaults_name_from_goal_and_writes_membership(env):
    project = _create(env)
    assert project["name"] == "Ship the Monday digest"
    assert project["status"] == "planning"
    assert project["owner_user_id"] == "leo"

    with projects_db.connect_closing() as conn:
        members = projects_db.get_project_members(conn, project["id"])
        profiles = projects_db.get_project_profiles(conn, project["id"])
        outputs = projects_db.get_project_outputs(conn, project["id"])
    assert [(m["user_id"], m["role"]) for m in members] == [("leo", "lead")]
    assert [(p["profile"], p["role"]) for p in profiles] == [("default", "host")]
    assert [o["title"] for o in outputs] == ["The Monday digest email"]
    assert outputs[0]["required"] == 1


def test_output_rollup_counts_delivered_and_accepted():
    rollup = projects_api._output_rollup(
        [
            {"required": 1, "status": "declared"},
            {"required": 1, "status": "delivered"},
            {"required": 0, "status": "accepted"},
        ]
    )
    assert rollup == {
        "total": 3,
        "required": 2,
        "delivered": 2,
        "accepted": 1,
        "awaiting_acceptance": 1,
    }


def test_detail_and_list_carry_the_output_rollup(env):
    client, _state = env
    project = _create(env)
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["output_rollup"]["total"] == 1
    assert detail["output_rollup"]["awaiting_acceptance"] == 0
    listed = client.get("/api/registry/projects").json()["items"]
    assert listed[0]["output_rollup"]["total"] == 1


def test_create_refuses_goal_over_160_chars(env):
    client, _state = env
    resp = client.post(
        "/api/registry/projects",
        json={
            "goal": "x" * 161,
            "description": "d",
            "host_profile": "default",
            "outputs": [{"title": "o"}],
        },
    )
    assert resp.status_code == 422


def test_collection_routes_answer_without_a_redirect(env):
    """F3: the client calls ``/api/registry/projects`` with no trailing
    slash; a 307 costs a round trip and replays the session to wherever
    the ``Location`` header points. The todos router's ``""`` convention
    is the shipped one."""
    client, _state = env
    resp = client.get("/api/registry/projects", follow_redirects=False)
    assert resp.status_code == 200
    resp = client.post(
        "/api/registry/projects",
        json={
            "goal": "Ship the Monday digest — to every subscriber",
            "description": "A weekly digest compiled and emailed each Monday.",
            "host_profile": "default",
            "outputs": [{"title": "The Monday digest email"}],
        },
        follow_redirects=False,
    )
    assert resp.status_code == 200, resp.text


def test_list_pagination_loses_no_rows_under_a_filter(env):
    """M2: filters run before the page slice and the cursor is taken from
    the last row examined. Five projects, two needing attention (the
    newest and the oldest); paging one at a time must surface exactly
    those two — the old code ended pagination on the all-filtered middle
    page and dropped the oldest match."""

    def _waiting_run(project_id: str) -> None:
        with projects_db.connect_closing() as conn:
            run = projects_db.open_project_run(
                conn, project_id=project_id, trigger="manual",
                profile="default",
            )
            projects_db.update_project_run(conn, run["id"], status="waiting")

    slugs = []
    ids = {}
    for i in range(5):
        project = _create(
            env, body={"goal": f"Pagination fixture project number {i}"}
        )
        slugs.append(project["slug"])
        ids[project["slug"]] = project["id"]
    # Same-second rows sort on random project ids — stagger the timestamps
    # so "newest first" is deterministic instead of a coin flip.
    with projects_db.connect_closing() as conn:
        with projects_db.write_txn(conn):
            for i, slug in enumerate(slugs):
                conn.execute(
                    "UPDATE projects SET created_at = ? WHERE slug = ?",
                    (1_700_000_000 + i, slug),
                )
    newest, oldest = slugs[-1], slugs[0]
    _waiting_run(ids[newest])
    _waiting_run(ids[oldest])

    client, _state = env
    seen = []
    cursor = None
    for _ in range(10):  # generous bound; the contract ends pagination
        url = "/api/registry/projects?health=attention&limit=1"
        if cursor:
            url += f"&cursor={cursor}"
        body = client.get(url).json()
        seen.extend(item["slug"] for item in body["items"])
        cursor = body["next_cursor"]
        if cursor is None:
            break
    assert seen == [newest, oldest]  # both matches, once each, newest first


# ---------------------------------------------------------------------------
# §11 read gate — 404, never 403
# ---------------------------------------------------------------------------


def test_non_member_read_is_404_not_403(env):
    project = _create(env)
    client, state = env
    state["actor"] = STRANGER
    resp = client.get(f"/api/registry/projects/{project['slug']}")
    assert resp.status_code == 404


def test_member_and_viewer_can_read(env):
    project = _create(env)
    _member(project["id"], "ada", "viewer")
    client, state = env
    state["actor"] = MEMBER_P
    resp = client.get(f"/api/registry/projects/{project['slug']}")
    assert resp.status_code == 200


def test_shared_project_readable_through_enrollment_only(env):
    project = _create(env, body={"visibility": "shared"})
    client, state = env

    state["actor"] = STRANGER
    state["enrolled"] = {"default"}  # listed in project_profiles
    assert client.get(f"/api/registry/projects/{project['slug']}").status_code == 200

    state["enrolled"] = {"elsewhere"}
    assert client.get(f"/api/registry/projects/{project['slug']}").status_code == 404


def test_private_project_not_readable_through_enrollment(env):
    project = _create(env, body={"visibility": "private"})
    client, state = env
    state["actor"] = STRANGER
    state["enrolled"] = {"default"}
    assert client.get(f"/api/registry/projects/{project['slug']}").status_code == 404


# ---------------------------------------------------------------------------
# §11 write gate — lead/admin write; members get the judgement acts
# ---------------------------------------------------------------------------


def test_viewer_read_but_never_writes(env):
    project = _create(env)
    _member(project["id"], "ada", "viewer")
    client, state = env
    state["actor"] = MEMBER_P
    assert client.patch(
        f"/api/registry/projects/{project['slug']}", json={"goal": "New goal."}
    ).status_code == 403
    assert client.post(
        f"/api/registry/projects/{project['slug']}/links",
        json={"kind": "url", "ref": "https://example.com"},
    ).status_code == 403


def test_member_judgement_acts_but_not_record_writes(env):
    project = _create(env)
    _member(project["id"], "ada", "member")
    client, state = env
    state["actor"] = MEMBER_P

    assert client.patch(
        f"/api/registry/projects/{project['slug']}", json={"goal": "New goal."}
    ).status_code == 403

    assert client.post(
        f"/api/registry/projects/{project['slug']}/links",
        json={"kind": "url", "ref": "https://example.com"},
    ).status_code == 200
    assert client.post(
        f"/api/registry/projects/{project['slug']}/contacts",
        json={"name": "Ada's client"},
    ).status_code == 200
    assert client.post(
        f"/api/registry/projects/{project['slug']}/outputs",
        json={"title": "An extra output"},
    ).status_code == 200


def test_patch_goal_and_name_are_independent(env):
    project = _create(env)
    client, _state = env
    slug = project["slug"]

    resp = client.patch(f"/api/registry/projects/{slug}", json={"goal": "A new outcome."})
    assert resp.status_code == 200
    body = resp.json()
    assert body["goal"] == "A new outcome."
    assert body["name"] == project["name"]  # re-wording never renames

    resp = client.patch(f"/api/registry/projects/{slug}", json={"name": "Renamed"})
    body = resp.json()
    assert body["name"] == "Renamed"
    assert body["goal"] == "A new outcome."  # renaming never rewrites


def test_member_toggling_required_is_refused(env):
    """Proposing an output is a judgement act; changing what counts as
    required is structural — lead and above only."""
    project = _create(env)
    _member(project["id"], "ada", "member")
    client, state = env
    with projects_db.connect_closing() as conn:
        oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]
    state["actor"] = MEMBER_P
    resp = client.patch(
        f"/api/registry/projects/{project['slug']}/outputs/{oid}",
        json={"required": False},
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# Contacts — address is members-only PII
# ---------------------------------------------------------------------------


def test_viewer_responses_omit_contact_address_members_do_not(env):
    project = _create(env)
    _member(project["id"], "ada", "viewer")
    client, _state = env
    assert client.post(
        f"/api/registry/projects/{project['slug']}/contacts",
        json={"name": "The client", "address": "client@example.com"},
    ).status_code == 200

    # Lead sees the address.
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["contacts"][0]["address"] == "client@example.com"

    # Viewer: the field is dropped, not blanked.
    client, state = env
    state["actor"] = MEMBER_P
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert "address" not in detail["contacts"][0]
    assert detail["contacts"][0]["name"] == "The client"


def test_owner_without_a_member_row_still_sees_contact_addresses(env):
    """M3: address visibility derives from write authority, not from the
    membership table — an owner with no ``project_members`` row (role
    None) kept losing addresses to the ``role not in (None, 'viewer')``
    gate."""
    project = _create(env)
    client, _state = env
    assert client.post(
        f"/api/registry/projects/{project['slug']}/contacts",
        json={"name": "The client", "address": "client@example.com"},
    ).status_code == 200
    with projects_db.connect_closing() as conn:
        conn.execute(
            "DELETE FROM project_members WHERE project_id = ?",
            (project["id"],),
        )
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["contacts"][0]["address"] == "client@example.com"


# ---------------------------------------------------------------------------
# Outputs lifecycle — deliver, human-only accept, closure offer (§6.1)
# ---------------------------------------------------------------------------


def test_accept_flow_and_closure_offer(env):
    project = _create(env)
    _activate(env, project)
    client, state = env
    slug = project["slug"]
    with projects_db.connect_closing() as conn:
        oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]

    resp = client.post(f"/api/registry/projects/{slug}/outputs/{oid}/deliver", json={})
    assert resp.status_code == 200

    with projects_db.connect_closing() as conn:
        row = projects_db.get_project_outputs(conn, project["id"])[0]
    assert row["status"] == "delivered"
    assert row["delivered_at"]

    state["subject"] = "leo"  # accepting is a human act (§16)
    resp = client.post(f"/api/registry/projects/{slug}/outputs/{oid}/accept")
    assert resp.status_code == 200
    body = resp.json()
    assert body["by"] == "leo"
    # The updated row rides the response so a UI merges it without reload.
    assert body["output"]["id"] == oid
    assert body["output"]["status"] == "accepted"
    # one_off with every required output accepted → closure is offered,
    # never forced.
    assert body["offers_closure"] is True
    with projects_db.connect_closing() as conn:
        assert projects_db.get_project(conn, project["id"]).status == "active"


def test_human_acts_refuse_a_session_less_caller(env):
    """§16: accepting an output, activating a directive, activating a
    playbook revision and scoring a run all need a verified interactive
    subject — the role gate alone never suffices."""
    project = _create(env)
    _activate(env, project)
    client, _state = env  # subject stays "" — an agent turn
    slug = project["slug"]
    with projects_db.connect_closing() as conn:
        oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]
        did = projects_db.add_project_directive(
            conn, project_id=project["id"], kind="directive",
            body="Never email before 9am", author_user_id="leo", active=False,
        )
        projects_db.save_playbook_rev(
            conn, project_id=project["id"], body="The method", steps=[],
            created_by="leo",
        )
        projects_db.open_project_run(
            conn, project_id=project["id"], trigger="manual", profile="default",
        )

    resp = client.post(f"/api/registry/projects/{slug}/outputs/{oid}/accept")
    assert resp.status_code == 403
    assert "human act" in resp.json()["detail"]

    resp = client.post(f"/api/registry/projects/{slug}/directives/{did}/activate")
    assert resp.status_code == 403
    assert "human act" in resp.json()["detail"]

    resp = client.post(f"/api/registry/projects/{slug}/playbook/1/activate")
    assert resp.status_code == 403
    assert "human act" in resp.json()["detail"]

    resp = client.post(
        f"/api/registry/projects/{slug}/runs/1/score", json={"score": 4}
    )
    assert resp.status_code == 403
    assert "human act" in resp.json()["detail"]


def test_agent_cannot_accept_directly_through_status_patch(env):
    """``accepted`` is reserved for the human-only accept route."""
    project = _create(env)
    client, _state = env
    with projects_db.connect_closing() as conn:
        oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]
    resp = client.patch(
        f"/api/registry/projects/{project['slug']}/outputs/{oid}",
        json={"status": "accepted"},
    )
    assert resp.status_code == 422


def test_delete_last_required_output_refused_optional_is_not(env):
    project = _create(env)
    client, _state = env
    slug = project["slug"]
    with projects_db.connect_closing() as conn:
        required_oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]
        optional_oid = projects_db.add_project_output(
            conn, project_id=project["id"], title="Nice-to-have", required=False
        )

    assert client.delete(
        f"/api/registry/projects/{slug}/outputs/{required_oid}"
    ).status_code == 409
    assert client.delete(
        f"/api/registry/projects/{slug}/outputs/{optional_oid}"
    ).status_code == 200


# ---------------------------------------------------------------------------
# §9.1 the progress ladder
# ---------------------------------------------------------------------------


def test_progress_rung1_outranks_cards_when_a_delivery_exists(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    with projects_db.connect_closing() as conn:
        oid = projects_db.get_project_outputs(conn, project["id"])[0]["id"]
    client.post(f"/api/registry/projects/{slug}/outputs/{oid}/deliver", json={})

    detail = client.get(f"/api/registry/projects/{slug}").json()
    progress = detail["progress"]
    assert progress["rung"] == "outputs"
    assert "of 1 outputs accepted" in progress["headline"]
    # The card rollup rides along at every rung.
    assert progress["cards"]["total"] == 0


def test_progress_falls_to_rung3_labelled_cards(env):
    project = _create(env)
    client, _state = env
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    progress = detail["progress"]
    assert progress["rung"] == "cards"
    assert progress["label"] == "cards"
    assert "cards done" in progress["headline"]


def test_progress_rung2_hook_consulted_when_a_goal_is_linked(env, monkeypatch):
    project = _create(env)
    client, _state = env
    assert client.post(
        f"/api/registry/projects/{project['slug']}/links",
        json={"kind": "goal", "ref": "g_1", "profile": "default"},
    ).status_code == 200

    seen = {}

    def _hook(proj, link):
        seen["link"] = link
        return {"headline": "40% to the metric"}

    monkeypatch.setattr(projects_api, "goal_progress_hook", _hook)
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["progress"]["rung"] == "goal"
    assert seen["link"]["ref"] == "g_1"

    # Hook returns None → the ladder falls through to the labelled rollup.
    monkeypatch.setattr(projects_api, "goal_progress_hook", lambda p, l: None)
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    assert detail["progress"]["rung"] == "cards"


def test_standing_progress_never_a_percentage(env):
    project = _create(env, body={"cadence": "standing"})
    client, _state = env
    with projects_db.connect_closing() as conn:
        projects_db.update_project_fields(
            conn, project["id"], {"review_every": "30d"}
        )
    detail = client.get(f"/api/registry/projects/{project['slug']}").json()
    progress = detail["progress"]
    assert progress["rung"] == "standing"
    assert "%" not in progress["headline"]
    assert "delivered this period" in progress["headline"]


# ---------------------------------------------------------------------------
# Rule 4 — board reads stay principal-filtered through the project surface
# ---------------------------------------------------------------------------


def test_board_and_card_reads_hide_other_users_private_cards(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]

    # One shared card, one private card owned by somebody else (seeded
    # through the store: the API would never create it this way).
    assert client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Shared card"}
    ).status_code == 200
    with kanban_db.connect_closing() as bconn:
        private_tid = kanban_db.create_task(
            bconn,
            title="Someone else's private card",
            project_id=project["id"],
            owner_user_id="mallory",
            visibility="private:mallory",
            triage=True,
        )

    # As a non-owner member the private card must be invisible.
    _member(project["id"], "ada", "lead")
    client, state = env
    state["actor"] = MEMBER_P
    board = client.get(f"/api/registry/projects/{slug}/board").json()
    titles = [t["title"] for c in board["columns"] for t in c["tasks"]]
    assert "Shared card" in titles
    assert "Someone else's private card" not in titles

    assert client.get(
        f"/api/registry/projects/{slug}/cards/{private_tid}"
    ).status_code == 404


def test_card_detail_surfaces_the_block_reason(env):
    """Regression: GET /cards/{id} used to call ``task_dict()`` with no
    ``latest_summary``, so ``kanban_block``'s *required* ``reason`` — the
    one thing a human needs to see to know what to do with a blocked card
    — never reached the card detail response, even though the board-list
    endpoint already attaches it via ``kanban_db.latest_summaries()``. A
    blocked card must show both the reason text and the block kind."""
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    with kanban_db.connect_closing() as bconn:
        kanban_db.specify_triage_task(bconn, tid)
        bconn.execute(
            "UPDATE tasks SET status = 'running' WHERE id = ?", (tid,)
        )
        assert kanban_db.block_task(
            bconn, tid,
            reason="Which Canva template should I use?",
            kind="needs_input",
        )

    card = client.get(f"/api/registry/projects/{slug}/cards/{tid}").json()
    assert card["status"] == "blocked"
    assert card["latest_summary"] == "Which Canva template should I use?"
    assert card["block_kind"] == "needs_input"


def test_card_detail_surfaces_live_progress_while_running(env):
    """A card's worker runs in another process with no reasoning stream —
    heartbeat notes and comments are the equivalent progress signal, and
    the card page must actually receive them (found missing: the page
    showed a running card with no update at all, not even a stale one)."""
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    with kanban_db.connect_closing() as bconn:
        kanban_db.specify_triage_task(bconn, tid)
        bconn.execute(
            "UPDATE tasks SET status = 'running' WHERE id = ?", (tid,)
        )
        assert kanban_db.heartbeat_worker(bconn, tid, note="42/100 done")
        # A later heartbeat with no note must not blank out the last real
        # one — the card should keep showing the most recent *note*.
        assert kanban_db.heartbeat_worker(bconn, tid, note=None)
        kanban_db.add_comment(bconn, tid, "default", "Halfway through the batch.")

    card = client.get(f"/api/registry/projects/{slug}/cards/{tid}").json()
    assert card["status"] == "running"
    assert card["latest_heartbeat"]["note"] == "42/100 done"
    assert len(card["comments"]) == 1
    assert card["comments"][0]["body"] == "Halfway through the batch."
    assert card["comments"][0]["author"] == "default"


def test_card_detail_surfaces_the_workers_own_log_cleaned_of_terminal_noise(
    env, tmp_path, monkeypatch,
):
    """A board-dispatched card's worker has no in-memory reasoning buffer
    to tail (that's `run_activity.py`, for inline sessions only) — but its
    stdout/stderr is captured to a durable log file any process can read.
    The card page must surface it, with the terminal-only noise (ANSI
    codes, spinner-frame repeats) stripped."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    with kanban_db.connect_closing() as bconn:
        kanban_db.specify_triage_task(bconn, tid)
        bconn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))

    log_path = kanban_db.worker_log_path(tid)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_bytes(
        "\x1b[1m╭─ ⚕ Hermes ─╮\x1b[0m\r\n"
        "Reading the tender document now.\r\n"
        "───────\n".encode("utf-8")
    )

    card = client.get(f"/api/registry/projects/{slug}/cards/{tid}").json()
    assert card["worker_log_tail"] is not None
    assert "Reading the tender document now." in card["worker_log_tail"]
    assert "\x1b" not in card["worker_log_tail"]
    assert "Hermes" not in card["worker_log_tail"]


def test_card_detail_has_no_heartbeat_or_comments_when_there_are_none(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    card = client.get(f"/api/registry/projects/{slug}/cards/{tid}").json()
    assert card["latest_heartbeat"] is None
    assert card["comments"] == []


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    """Minimal SSE reader for a fully-drained `TestClient` response — only
    safe to call for a stream that terminates on its own (a `gone`/`end`
    frame), since `TestClient.get()` reads the whole body before returning."""
    frames: list[tuple[str, dict]] = []
    for block in text.strip("\n").split("\n\n"):
        if not block.strip() or block.startswith(":"):
            continue
        event, data_lines = "message", []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].strip())
        if data_lines:
            frames.append((event, json.loads("\n".join(data_lines))))
    return frames


def test_card_stream_pushes_the_row_then_ends_once_it_leaves_running(env):
    """A card page no longer has to poll for this (§12 push edition): the
    stream is only live while `running`, so a card that isn't (or just
    stopped) is a one-frame stream — a real `running` card's browser tab
    would instead see repeated `update` frames as its heartbeat/comments
    change, up to the tick this test doesn't wait out."""
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    with kanban_db.connect_closing() as bconn:
        kanban_db.specify_triage_task(bconn, tid)
        bconn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (tid,))
        assert kanban_db.heartbeat_worker(bconn, tid, note="10/20 done")
        bconn.execute("UPDATE tasks SET status = 'done' WHERE id = ?", (tid,))

    resp = client.get(f"/api/registry/projects/{slug}/cards/{tid}/stream")
    assert resp.status_code == 200
    frames = _parse_sse(resp.text)
    assert frames[0][0] == "update"
    assert frames[0][1]["status"] == "done"
    assert frames[0][1]["latest_heartbeat"]["note"] == "10/20 done"
    assert frames[-1][0] == "end"


def test_card_stream_is_404_for_an_unknown_card(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    resp = client.get(
        f"/api/registry/projects/{project['slug']}/cards/task_missing/stream"
    )
    assert resp.status_code == 404


def test_card_stream_hides_another_users_private_card(env):
    project = _create(env)
    _activate(env, project)
    client, state = env
    slug = project["slug"]
    with kanban_db.connect_closing() as bconn:
        private_tid = kanban_db.create_task(
            bconn,
            title="Someone else's private card",
            project_id=project["id"],
            owner_user_id="mallory",
            visibility="private:mallory",
            triage=True,
        )
    _member(project["id"], "ada", "lead")
    state["actor"] = MEMBER_P
    resp = client.get(f"/api/registry/projects/{slug}/cards/{private_tid}/stream")
    assert resp.status_code == 404


def test_card_create_lands_in_triage_on_the_project(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    resp = client.post(
        f"/api/registry/projects/{project['slug']}/cards",
        json={"title": "Draft the outline"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "triage"

    with kanban_db.connect_closing() as bconn:
        task = kanban_db.get_task(bconn, body["task_id"])
    assert task.status == "triage"
    assert task.project_id == project["id"]


def test_card_patch_edits_assigns_and_moves_through_structured_verbs(env):
    project = _create(env)
    _activate(env, project)
    client, _state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    url = f"/api/registry/projects/{slug}/cards/{tid}"

    # Title / body / assignee in one patch; the assignee must be a project
    # profile.
    assert client.patch(url, json={"assignee": "nope"}).status_code == 422
    resp = client.patch(
        url, json={"title": "Draft the outline", "body": "Two pages.", "assignee": "default"}
    )
    assert resp.status_code == 200, resp.text
    card = resp.json()
    assert card["title"] == "Draft the outline"
    assert card["body"] == "Two pages."
    assert card["assignee"] == "default"
    assert client.patch(url, json={"title": "  "}).status_code == 422
    assert client.patch(url, json={}).status_code == 422

    # Columns: triage → ready (approve) → blocked → ready → done; the
    # dispatcher's columns and triage are never a target, and a move the
    # verb refuses comes back as 409 with the reason.
    assert client.patch(url, json={"status": "running"}).status_code == 422
    assert client.patch(url, json={"status": "todo"}).status_code == 422
    assert client.patch(url, json={"status": "triage"}).status_code == 422
    for status in ("ready", "blocked", "ready", "done"):
        resp = client.patch(url, json={"status": status})
        assert resp.status_code == 200, (status, resp.text)
        assert resp.json()["status"] == status
    resp = client.patch(url, json={"status": "blocked"})
    assert resp.status_code == 409
    assert "blocked" in resp.json()["detail"]

    # Unassign with null.
    assert client.patch(url, json={"assignee": None}).json()["assignee"] is None

    # Unknown card is a 404, and another project's card is too.
    assert client.patch(
        f"/api/registry/projects/{slug}/cards/task_missing", json={"title": "x"}
    ).status_code == 404


def test_card_patch_refused_for_strangers_and_archived_projects(env):
    project = _create(env)
    _activate(env, project)
    client, state = env
    slug = project["slug"]
    tid = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    url = f"/api/registry/projects/{slug}/cards/{tid}"

    state["actor"] = STRANGER
    assert client.patch(url, json={"title": "Mine now"}).status_code in (403, 404)
    state["actor"] = OWNER

    assert client.post(f"/api/registry/projects/{slug}/archive").status_code == 200
    assert client.patch(url, json={"title": "Too late"}).status_code == 409


# ---------------------------------------------------------------------------
# Members / profiles guardrails
# ---------------------------------------------------------------------------


def test_last_lead_cannot_be_removed(env):
    project = _create(env)
    client, _state = env
    resp = client.delete(f"/api/registry/projects/{project['slug']}/members/leo")
    assert resp.status_code == 409

    _member(project["id"], "ada", "lead")
    assert (
        client.delete(f"/api/registry/projects/{project['slug']}/members/leo").status_code
        == 200
    )


def test_last_profile_cannot_be_detached(env):
    project = _create(env)
    client, _state = env
    assert (
        client.delete(
            f"/api/registry/projects/{project['slug']}/profiles/default"
        ).status_code
        == 409
    )
    assert client.post(
        f"/api/registry/projects/{project['slug']}/profiles",
        json={"profile": "research"},
    ).status_code == 200
    assert (
        client.delete(
            f"/api/registry/projects/{project['slug']}/profiles/default"
        ).status_code
        == 200
    )


def test_links_delete_detaches_the_pointer(env):
    project = _create(env)
    client, _state = env
    slug = project["slug"]
    assert client.post(
        f"/api/registry/projects/{slug}/links",
        json={"kind": "reference", "ref": "/docs/spec.md", "label": "Spec"},
    ).status_code == 200
    # Duplicate link is a 409 — the PK is the dedupe.
    assert client.post(
        f"/api/registry/projects/{slug}/links",
        json={"kind": "reference", "ref": "/docs/spec.md"},
    ).status_code == 409
    assert client.request(
        "DELETE",
        f"/api/registry/projects/{slug}/links",
        json={"kind": "reference", "ref": "/docs/spec.md", "profile": "default"},
    ).status_code == 200
    detail = client.get(f"/api/registry/projects/{slug}").json()
    assert detail["links"].get("reference", []) == []


def test_detail_usage_totals_every_run_and_only_this_projects_tokens(env):
    """The project page's "used so far" line: all runs' time (a live run
    counts up to now) and the tokens its own cards' workers recorded —
    never another project's."""
    import os
    import sqlite3
    import time as _time
    from pathlib import Path

    from hermes_state import SessionDB

    client, _state = env
    project = _create(env)
    _activate(env, project)
    other = _create(env, body={"goal": "Another project entirely"})
    _activate(env, other)
    slug = project["slug"]

    mine = client.post(
        f"/api/registry/projects/{slug}/cards", json={"title": "Draft"}
    ).json()["task_id"]
    theirs = client.post(
        f"/api/registry/projects/{other['slug']}/cards", json={"title": "X"}
    ).json()["task_id"]

    db_path = Path(os.environ["HERMES_HOME"]) / "state.db"
    SessionDB(db_path=db_path)
    with sqlite3.connect(db_path) as conn:
        for task_id, inp, out, cache in (
            (mine, 1000, 200, 5000),
            (mine, 500, 100, 0),
            (theirs, 9999, 9999, 9999),
        ):
            conn.execute(
                "INSERT INTO api_call_log (ts, kanban_task_id, input_tokens,"
                " output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?)",
                (_time.time(), task_id, inp, out, cache),
            )

    now = int(_time.time())
    with projects_db.connect_closing() as conn:
        done = projects_db.open_project_run(
            conn, project_id=project["id"], trigger="manual", profile="default"
        )
        conn.execute(
            "UPDATE project_runs SET status = 'done', started_at = ?,"
            " ended_at = ? WHERE id = ?",
            (now - 4000, now - 400, done["id"]),
        )
        conn.commit()
        live = projects_db.open_project_run(
            conn, project_id=project["id"], trigger="manual", profile="default"
        )
        conn.execute(
            "UPDATE project_runs SET started_at = ? WHERE id = ?",
            (now - 60, live["id"]),
        )
        conn.commit()

    usage = client.get(f"/api/registry/projects/{slug}").json()["usage"]
    assert usage["runs"] == 2
    assert 3600 + 60 <= usage["run_seconds"] <= 3600 + 60 + 30
    tokens = usage["tokens"]
    assert tokens["calls"] == 2
    assert tokens["input_tokens"] == 1500
    assert tokens["output_tokens"] == 300
    assert tokens["cache_read_tokens"] == 5000
    assert tokens["total"] == 1800


def test_detail_usage_tokens_read_not_recorded_without_a_call_log(env):
    client, _state = env
    project = _create(env)
    _activate(env, project)
    slug = project["slug"]
    client.post(f"/api/registry/projects/{slug}/cards", json={"title": "Draft"})
    usage = client.get(f"/api/registry/projects/{slug}").json()["usage"]
    assert usage == {"runs": 0, "run_seconds": 0, "tokens": None}
