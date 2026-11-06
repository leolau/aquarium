"""The board's human verbs and context read (Projects redesign: board).

Behaviour contracts:

- ``GET /{slug}/board/context`` names the run that created each card and
  says whether the open run is stalled with the *same* verdict the run
  detail read gives (``_run_stalled``) — the board must not disagree with
  the run page;
- ``POST /{slug}/cards/approve`` makes every listed triage card ready in
  one request, never executes a card twice (a replay reports it
  ``unchanged``), and one refusal never undoes the rest;
- ``POST /{slug}/cards/{id}/unblock`` releases a blocked card and puts the
  optional reason on its comment thread; anything not blocked is a 409;
- all three follow the project gates: a viewer reads but never writes, a
  stranger gets a 404, an archived project refuses the writes.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_board_api, projects_db
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER_P = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
VIEWER_P = Principal(user_id="vic", display="Vic", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]

PREFIX = "/api/registry/projects"


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    state = {"actor": OWNER}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set()

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)

    app = FastAPI()
    app.include_router(projects_api.router)
    app.include_router(projects_board_api.router)
    return TestClient(app), state


def _project(env) -> dict:
    client, _state = env
    resp = client.post(
        PREFIX,
        json={
            "goal": "Ship the Monday digest to every subscriber",
            "description": "A weekly digest compiled and emailed each Monday.",
            "host_profile": "default",
            "outputs": [{"title": "The Monday digest email"}],
        },
    )
    assert resp.status_code == 200, resp.text
    project = resp.json()
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id="ada", role="member"
        )
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id="vic", role="viewer"
        )
        projects_db.set_project_status(conn, project["id"], "active")
    return project


def _card(env, slug, title) -> str:
    client, _state = env
    resp = client.post(f"{PREFIX}/{slug}/cards", json={"title": title})
    assert resp.status_code == 200, resp.text
    return resp.json()["task_id"]


def _status(task_id) -> str:
    with kanban_db.connect_closing() as bconn:
        return kanban_db.get_task(bconn, task_id).status


def _open_run(project) -> dict:
    with projects_db.connect_closing() as conn:
        return projects_db.open_project_run(
            conn,
            project_id=project["id"],
            trigger="manual",
            triggered_by="leo",
            profile="default",
        )


def _link(run, task_id, step="step"):
    with projects_db.connect_closing() as conn:
        projects_db.link_run_card(conn, run["id"], task_id, step)


def _set_status(task_id, status):
    with kanban_db.connect_closing() as bconn:
        with kanban_db.write_txn(bconn):
            bconn.execute(
                "UPDATE tasks SET status = ? WHERE id = ?", (status, task_id)
            )


# ---------------------------------------------------------------------------
# GET /{slug}/board/context
# ---------------------------------------------------------------------------


def test_context_without_runs_is_empty(env):
    client, _state = env
    project = _project(env)
    _card(env, project["slug"], "Draft the digest")
    resp = client.get(f"{PREFIX}/{project['slug']}/board/context")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"card_runs": {}, "open_run": None}


def test_context_names_the_run_that_created_each_card(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    first = _card(env, slug, "Gather arrivals")
    second = _card(env, slug, "Send the digest")
    loose = _card(env, slug, "A card nobody's run made")
    run1 = _open_run(project)
    _link(run1, first)
    with projects_db.connect_closing() as conn:
        projects_db.close_project_run(conn, run1["id"], status="done")
    run2 = _open_run(project)
    _link(run2, second)
    # A card carried into a later run still reads as made by the first.
    _link(run2, first)

    data = client.get(f"{PREFIX}/{slug}/board/context").json()
    assert data["card_runs"] == {
        first: run1["run_no"],
        second: run2["run_no"],
    }
    assert loose not in data["card_runs"]
    assert data["open_run"]["run_no"] == run2["run_no"]
    assert set(data["open_run"]["card_ids"]) == {first, second}


def test_context_stall_agrees_with_the_run_detail_read(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    with kanban_db.connect_closing() as bconn:
        sub = kanban_db.create_task(
            bconn,
            title="Extract objectives",
            project_id=project["id"],
            owner_user_id="leo",
            initial_status="running",
        )
        card = kanban_db.create_task(
            bconn,
            title="Draft the outline",
            project_id=project["id"],
            owner_user_id="leo",
            initial_status="running",
            parents=[sub],
        )
        assert kanban_db.block_task(bconn, sub, reason="worker died")
    _set_status(card, "todo")
    run = _open_run(project)
    _link(run, card)

    ctx = client.get(f"{PREFIX}/{slug}/board/context").json()["open_run"]
    detail = client.get(f"{PREFIX}/{slug}/runs/{run['run_no']}").json()
    assert ctx["stalled"] is True
    assert ctx["stalled"] == detail["stalled"]
    assert ctx["blocked_tree_count"] == len(detail["blocked_tasks"]) == 1

    # A worker on the card makes the run honest again — on both reads.
    _set_status(card, "running")
    ctx = client.get(f"{PREFIX}/{slug}/board/context").json()["open_run"]
    detail = client.get(f"{PREFIX}/{slug}/runs/{run['run_no']}").json()
    assert ctx["stalled"] is False and detail["stalled"] is False


def test_context_read_gates(env):
    client, state = env
    project = _project(env)
    state["actor"] = VIEWER_P
    assert client.get(f"{PREFIX}/{project['slug']}/board/context").status_code == 200
    state["actor"] = STRANGER
    assert client.get(f"{PREFIX}/{project['slug']}/board/context").status_code == 404


# ---------------------------------------------------------------------------
# POST /{slug}/cards/approve
# ---------------------------------------------------------------------------


def test_approve_all_makes_each_triage_card_ready_once(env):
    client, state = env
    project = _project(env)
    slug = project["slug"]
    ids = [_card(env, slug, f"Card {n}") for n in range(3)]
    state["actor"] = MEMBER_P  # approval is a judgement act: members may
    resp = client.post(
        f"{PREFIX}/{slug}/cards/approve", json={"task_ids": ids + [ids[0]]}
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert [r["task_id"] for r in data["results"]] == ids  # deduped, in order
    assert data["approved"] == 3 and data["failed"] == 0
    assert all(r["card"]["status"] == "ready" for r in data["results"])
    assert [_status(t) for t in ids] == ["ready"] * 3

    # A replay (lost response, second tab) executes nothing.
    again = client.post(f"{PREFIX}/{slug}/cards/approve", json={"task_ids": ids}).json()
    assert again["approved"] == 0 and again["failed"] == 0
    assert all(r["unchanged"] for r in again["results"])


def test_approve_all_reports_refusals_without_undoing_the_rest(env):
    client, _state = env
    project = _project(env)
    other = client.post(
        PREFIX,
        json={
            "goal": "A different project entirely, for isolation",
            "description": "Someone else's work.",
            "host_profile": "default",
            "outputs": [{"title": "Theirs"}],
        },
    ).json()
    mine = _card(env, project["slug"], "Mine")
    theirs = _card(env, other["slug"], "Theirs")
    data = client.post(
        f"{PREFIX}/{project['slug']}/cards/approve",
        json={"task_ids": [mine, theirs, "task_nope"]},
    ).json()
    by_id = {r["task_id"]: r for r in data["results"]}
    assert by_id[mine]["ok"] is True
    assert by_id[theirs] == {"task_id": theirs, "ok": False, "error": "card not found"}
    assert by_id["task_nope"]["ok"] is False
    assert data["approved"] == 1 and data["failed"] == 2
    assert _status(mine) == "ready"
    assert _status(theirs) == "triage"


@pytest.mark.parametrize("body", [{}, {"task_ids": []}, {"task_ids": "x"}, {"task_ids": ["", " "]}])
def test_approve_all_validates_the_list(env, body):
    client, _state = env
    project = _project(env)
    resp = client.post(f"{PREFIX}/{project['slug']}/cards/approve", json=body)
    assert resp.status_code == 422


def test_approve_all_write_gates(env):
    client, state = env
    project = _project(env)
    card = _card(env, project["slug"], "Draft")
    state["actor"] = VIEWER_P
    resp = client.post(f"{PREFIX}/{project['slug']}/cards/approve", json={"task_ids": [card]})
    assert resp.status_code == 403
    state["actor"] = STRANGER
    resp = client.post(f"{PREFIX}/{project['slug']}/cards/approve", json={"task_ids": [card]})
    assert resp.status_code == 404
    assert _status(card) == "triage"
    state["actor"] = OWNER
    assert client.post(f"{PREFIX}/{project['slug']}/archive", json={}).status_code == 200
    resp = client.post(f"{PREFIX}/{project['slug']}/cards/approve", json={"task_ids": [card]})
    assert resp.status_code == 409
    assert _status(card) == "triage"


# ---------------------------------------------------------------------------
# POST /{slug}/cards/{id}/unblock
# ---------------------------------------------------------------------------


def _blocked_card(env, slug) -> str:
    client, _state = env
    card = _card(env, slug, "Send the digest")
    assert client.patch(f"{PREFIX}/{slug}/cards/{card}", json={"status": "ready"}).status_code == 200
    assert client.patch(f"{PREFIX}/{slug}/cards/{card}", json={"status": "blocked"}).status_code == 200
    assert _status(card) == "blocked"
    return card


def test_unblock_with_a_reason_comments_then_releases(env):
    client, state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    state["actor"] = MEMBER_P
    resp = client.post(
        f"{PREFIX}/{slug}/cards/{card}/unblock",
        json={"reason": "The list is attached now."},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ready"
    assert _status(card) == "ready"
    comments = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"]
    assert comments[-1]["body"] == "The list is attached now."
    assert comments[-1]["author"] == "user:ada"


def test_unblock_without_a_reason_adds_no_comment(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    resp = client.post(f"{PREFIX}/{slug}/cards/{card}/unblock", json={})
    assert resp.status_code == 200, resp.text
    assert client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"] == []


def test_unblock_refuses_a_card_that_is_not_blocked(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _card(env, slug, "Still in triage")
    resp = client.post(f"{PREFIX}/{slug}/cards/{card}/unblock", json={"reason": "go"})
    assert resp.status_code == 409
    assert "not blocked" in resp.json()["detail"]
    # The refusal happened before the comment: nothing written.
    assert client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"] == []
    assert client.post(f"{PREFIX}/{slug}/cards/task_nope/unblock", json={}).status_code == 404


def test_unblock_gates(env):
    client, state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    state["actor"] = VIEWER_P
    assert client.post(f"{PREFIX}/{slug}/cards/{card}/unblock", json={}).status_code == 403
    resp = client.post(f"{PREFIX}/{slug}/cards/{card}/unblock", json={"reason": "x" * 2001})
    assert resp.status_code == 403
    state["actor"] = OWNER
    resp = client.post(f"{PREFIX}/{slug}/cards/{card}/unblock", json={"reason": "x" * 2001})
    assert resp.status_code == 422
    assert _status(card) == "blocked"


# ---------------------------------------------------------------------------
# POST /{slug}/cards/{id}/approvals — a worker's approval, answered here
# ---------------------------------------------------------------------------


def _ask_approval(card, key, label=None):
    with kanban_db.connect_closing() as bconn:
        return kanban_db.request_task_approval(
            bconn, card, [(key, label or key)], detail=f"{key} {{}}"
        )


def _pending_on_board(client, slug, card):
    board = client.get(f"{PREFIX}/{slug}/board").json()
    for column in board["columns"]:
        for task in column["tasks"]:
            if task["id"] == card:
                return task.get("pending_approvals")
    raise AssertionError(f"{card} is not on the board")


def test_board_shows_what_a_blocked_card_waits_to_be_allowed(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    assert _ask_approval(card, "mcp_canva_create_upload_url") == "pending"
    pending = _pending_on_board(client, slug, card)
    assert [p["key"] for p in pending] == ["mcp_canva_create_upload_url"]
    assert pending[0]["detail"] == "mcp_canva_create_upload_url {}"


def test_allowing_the_last_approval_comments_and_releases_the_card(env):
    client, state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    _ask_approval(card, "mcp_canva_create_upload_url")
    state["actor"] = MEMBER_P
    resp = client.post(
        f"{PREFIX}/{slug}/cards/{card}/approvals",
        json={"key": "mcp_canva_create_upload_url", "decision": "approve"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ready"
    assert resp.json()["pending_approvals"] == []
    assert _status(card) == "ready"
    comments = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"]
    assert comments[-1]["author"] == "user:ada"
    assert "Approved for this card: mcp_canva_create_upload_url" in comments[-1]["body"]
    # The worker's next ask goes through.
    assert _ask_approval(card, "mcp_canva_create_upload_url") == "approved"


def test_denying_records_it_for_the_next_worker(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    _ask_approval(card, "mcp_canva_publish_brand_template")
    resp = client.post(
        f"{PREFIX}/{slug}/cards/{card}/approvals",
        json={"key": "mcp_canva_publish_brand_template", "decision": "deny"},
    )
    assert resp.status_code == 200, resp.text
    assert _status(card) == "ready"
    body = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"][-1]["body"]
    assert body.startswith("Denied for this card: mcp_canva_publish_brand_template")
    assert _ask_approval(card, "mcp_canva_publish_brand_template") == "denied"


def test_a_card_stays_blocked_while_another_approval_is_pending(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    _ask_approval(card, "mcp_canva_create_upload_url")
    _ask_approval(card, "mcp_canva_get_design_pages")
    resp = client.post(
        f"{PREFIX}/{slug}/cards/{card}/approvals",
        json={"key": "mcp_canva_create_upload_url", "decision": "approve"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "blocked"
    assert [p["key"] for p in resp.json()["pending_approvals"]] == [
        "mcp_canva_get_design_pages"
    ]
    assert _status(card) == "blocked"


def test_approval_refusals_and_gates(env):
    client, state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    url = f"{PREFIX}/{slug}/cards/{card}/approvals"
    # Nothing pending under that key: 409, and no comment written.
    resp = client.post(url, json={"key": "mcp_canva_x", "decision": "approve"})
    assert resp.status_code == 409
    assert client.get(f"{PREFIX}/{slug}/cards/{card}").json()["comments"] == []
    assert client.post(url, json={"key": "k", "decision": "maybe"}).status_code == 422
    assert client.post(url, json={"decision": "approve"}).status_code == 422
    assert client.post(
        f"{PREFIX}/{slug}/cards/task_nope/approvals",
        json={"key": "k", "decision": "approve"},
    ).status_code == 404
    _ask_approval(card, "mcp_canva_x")
    state["actor"] = VIEWER_P
    assert client.post(url, json={"key": "mcp_canva_x", "decision": "approve"}).status_code == 403
    assert _status(card) == "blocked"


def test_card_page_shows_what_a_blocked_card_waits_to_be_allowed(env):
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _blocked_card(env, slug)
    assert client.get(f"{PREFIX}/{slug}/cards/{card}").json()["pending_approvals"] == []
    _ask_approval(card, "mcp_canva_export_design")
    _ask_approval(card, "script execution via -e/-c flag")
    pending = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["pending_approvals"]
    assert [p["key"] for p in pending] == [
        "mcp_canva_export_design",
        "script execution via -e/-c flag",
    ]
    assert pending[0]["detail"] == "mcp_canva_export_design {}"
    client.post(
        f"{PREFIX}/{slug}/cards/{card}/approvals",
        json={"key": "mcp_canva_export_design", "decision": "approve"},
    )
    pending = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["pending_approvals"]
    assert [p["key"] for p in pending] == ["script execution via -e/-c flag"]


def test_card_page_totals_its_workers_model_calls(env):
    """A card's page shows its workers' calls: main-model totals across
    attempts, and one row per attempt/caller/model labelled with how the
    attempt ended. Calls from other cards never leak in."""
    import os
    from pathlib import Path

    from hermes_state import SessionDB

    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _card(env, slug, "Verify each page")
    assert client.get(f"{PREFIX}/{slug}/cards/{card}").json()["model_calls"] is None
    with kanban_db.connect_closing() as bconn:
        with kanban_db.write_txn(bconn):
            first = bconn.execute(
                "INSERT INTO task_runs (task_id, status, outcome, started_at)"
                " VALUES (?, 'done', 'crashed', 100)", (card,),
            ).lastrowid
            second = bconn.execute(
                "INSERT INTO task_runs (task_id, status, outcome, started_at)"
                " VALUES (?, 'done', 'completed', 200)", (card,),
            ).lastrowid
    db = SessionDB(Path(os.environ["HERMES_HOME"]) / "state.db")
    try:
        db.record_api_call(model="ds", caller="main", duration_ms=2100,
                           kanban_task_id=card, kanban_run_id=first)
        for ms in (3200, 316400):
            db.record_api_call(model="ds", caller="main", duration_ms=ms,
                               kanban_task_id=card, kanban_run_id=second)
        db.record_api_call(model="ds", caller="main", status="error",
                           kanban_task_id=card, kanban_run_id=second)
        db.record_api_call(model="qwen", caller="aux:vision", status="error",
                           duration_ms=120000, kanban_task_id=card,
                           kanban_run_id=second)
        db.record_api_call(model="ds", caller="main", duration_ms=1,
                           kanban_task_id="t_someone_else")
    finally:
        db.close()

    calls = client.get(f"{PREFIX}/{slug}/cards/{card}").json()["model_calls"]
    assert calls["main"]["calls"] == 4 and calls["main"]["failures"] == 1
    assert calls["main"]["min_ms"] == 2100 and calls["main"]["max_ms"] == 316400
    rows = {(r["attempt"], r["caller"]): r for r in calls["rows"]}
    assert set(rows) == {(1, "main"), (2, "main"), (2, "aux:vision")}
    assert rows[(1, "main")]["run_outcome"] == "crashed"
    assert rows[(2, "main")]["calls"] == 3 and rows[(2, "main")]["failures"] == 1
    assert rows[(2, "aux:vision")]["failures"] == 1


def test_rerun_releases_a_card_the_unblock_loop_breaker_parked(env):
    """The card's Re-run (Answer the agent) is the human act that re-queues
    a block-loop-parked card — and it clears the loop counter, so automatic
    promotion treats the card normally again."""
    client, _state = env
    project = _project(env)
    slug = project["slug"]
    card = _card(env, slug, "Get the supplier price")
    with kanban_db.connect_closing() as bconn:
        bconn.execute(
            "UPDATE tasks SET status = 'triage', block_kind = 'needs_input', "
            "block_recurrences = ? WHERE id = ?",
            (kanban_db.BLOCK_RECURRENCE_LIMIT, card),
        )
        bconn.commit()
    detail = client.get(f"{PREFIX}/{slug}/cards/{card}").json()
    assert detail["parked"] is True
    assert detail["replan"]["status"] == "pending"
    resp = client.post(
        f"{PREFIX}/{slug}/cards/{card}/unblock", json={"reason": "Approved it now."}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ready"
    with kanban_db.connect_closing() as bconn:
        task = kanban_db.get_task(bconn, card)
    assert task.block_recurrences == 0 and task.block_kind is None
    detail = client.get(f"{PREFIX}/{slug}/cards/{card}").json()
    assert detail["parked"] is False
    assert detail["comments"][-1]["body"] == "Approved it now."
