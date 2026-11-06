"""A run card the unblock-loop breaker parked stays parked (Projects).

Behaviour contracts:

- once ``block_task`` parks a card in ``triage`` (same cause,
  ``BLOCK_RECURRENCE_LIMIT`` times), no automatic path re-queues it — not
  ``promote_run_cards`` in any autonomy mode, not the settle hook, not the
  reconcile sweep; the run waits on a human instead of failing as stalled;
- the human ``force_held`` acts (Continue / Resume) and the card's Re-run do
  re-queue it, and clear the loop counter so the next block counts afresh;
- the sweep asks the planner for a revised plan (the ordinary plan draft,
  saved inactive) exactly once per parking, and the card + project say so;
- manual/supervised projects leave that revision for a lead; an autonomous
  project activates it (once per parking) and moves the run onto it — unless
  it repeats the stuck step unchanged, which stays for a person.
"""

from __future__ import annotations

import json

import pytest

from hermes_cli import (
    kanban_db,
    projects_api,
    projects_db,
    projects_reconcile,
    projects_run,
)

GUIDE_CFG = {
    "max_skills": 5,
    "guidance_max_directives": 20,
    "guidance_max_chars": 4000,
    "brief_max_chars": 1200,
}

REPLAN = {"body": "Route around the stuck step.", "steps": [
    {"key": "alt", "title": "Quote from the public price list instead"},
]}


class _FakeApprovalStore:
    def __init__(self):
        self.calls: list = []

    async def initialize(self):
        pass

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return object()


APPROVALS = _FakeApprovalStore()


class _InlineThread:
    def __init__(self, *, target, kwargs, **_):
        self._run = lambda: target(**kwargs)

    def start(self):
        self._run()


@pytest.fixture
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    APPROVALS.calls.clear()
    monkeypatch.setattr("hermes_cli.datastore.get_store", lambda *a, **k: object())
    monkeypatch.setattr(
        projects_run, "_approval_store", lambda app_store, *, config: APPROVALS,
    )
    monkeypatch.setattr(
        projects_run, "_enabled_toolsets_for_profile", lambda profile: ["web"],
    )
    monkeypatch.setattr(projects_run, "_available_skill_names", lambda profile: [])
    monkeypatch.setattr(projects_run, "projects_runtime_config", lambda: dict(GUIDE_CFG))
    prompts: list = []

    def _model(prompt):
        prompts.append(prompt)
        return json.dumps(REPLAN)

    monkeypatch.setattr(projects_api, "_call_plan_model", _model)
    monkeypatch.setattr(projects_api.threading, "Thread", _InlineThread)
    projects_api._PLAN_DRAFTS.clear()
    return prompts


def _project(autonomy):
    with projects_db.connect_closing() as conn:
        pid = projects_db.create_full_project(
            conn,
            goal="Quote the customer for the new racks",
            description="Collect prices and send a quotation.",
            owner_user_id="leo",
            cadence="repeatable",
            autonomy=autonomy,
        )
        projects_db.add_project_profile(conn, project_id=pid, profile="default", role="host")
        projects_db.add_project_member(conn, project_id=pid, user_id="leo", role="lead")
        projects_db.add_project_output(
            conn, project_id=pid, title="The quotation", spec="pdf", required=True,
        )
        projects_db.set_project_status(conn, pid, "active")
        projects_db.save_playbook_rev(
            conn, project_id=pid, body="Method",
            steps=[{"key": "price", "title": "Get the supplier price"},
                   {"key": "quote", "title": "Write the quote", "depends_on": ["price"]}],
            created_by="leo",
        )
        projects_db.activate_playbook_rev(conn, pid, 1)
        return projects_db.get_project(conn, pid)


def _start(project):
    with projects_db.connect_closing() as conn, kanban_db.connect_closing() as bconn:
        return projects_run.start_run(conn, bconn, project=project, triggered_by="leo")


def _loop_until_parked(task_id):
    """Drive the real breaker: block, unblock, block again for one cause."""
    with kanban_db.connect_closing() as bconn:
        for attempt in range(kanban_db.BLOCK_RECURRENCE_LIMIT):
            bconn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (task_id,))
            bconn.commit()
            assert kanban_db.block_task(
                bconn, task_id, reason="waiting on the MCP approval", kind="needs_input",
            )
            if attempt < kanban_db.BLOCK_RECURRENCE_LIMIT - 1:
                assert kanban_db.unblock_task(bconn, task_id)
        task = kanban_db.get_task(bconn, task_id)
        assert task.status == "triage"
        assert kanban_db.is_block_loop_parked(task)


def _task(task_id):
    with kanban_db.connect_closing() as bconn:
        return kanban_db.get_task(bconn, task_id)


def _kinds(task_id):
    with kanban_db.connect_closing() as bconn:
        return [e.kind for e in kanban_db.list_events(bconn, task_id)]


def _park_raw(task_id):
    with kanban_db.connect_closing() as bconn:
        bconn.execute(
            "UPDATE tasks SET status = 'triage', block_kind = 'needs_input', "
            "block_recurrences = ? WHERE id = ?",
            (kanban_db.BLOCK_RECURRENCE_LIMIT, task_id),
        )
        bconn.commit()


@pytest.mark.parametrize("autonomy", ["manual", "supervised", "autonomous"])
def test_promote_run_cards_never_promotes_a_parked_card(stores, autonomy):
    project = _project(autonomy)
    result = _start(project)
    price = result["cards"]["price"]
    _park_raw(price)
    with projects_db.connect_closing() as conn, kanban_db.connect_closing() as bconn:
        run = result["run"]
        playbook = projects_db.get_playbook(conn, project.id, rev=run["playbook_rev"])
        promoted = projects_run.promote_run_cards(
            bconn, conn, project=project, run_id=run["id"],
            steps=playbook["steps"], autonomy=autonomy, held=set(),
        )
    assert price not in promoted
    assert _task(price).status == "triage"


def test_a_forced_human_promotion_releases_the_card_and_clears_the_marker(stores):
    project = _project("autonomous")
    result = _start(project)
    price = result["cards"]["price"]
    _park_raw(price)
    run = result["run"]
    with projects_db.connect_closing() as conn, kanban_db.connect_closing() as bconn:
        playbook = projects_db.get_playbook(conn, project.id, rev=run["playbook_rev"])
        promoted = projects_run.promote_run_cards(
            bconn, conn, project=project, run_id=run["id"],
            steps=playbook["steps"], autonomy="autonomous", held=set(),
            force_held=True,
        )
    assert promoted == [price]
    task = _task(price)
    assert task.status == "ready"
    assert task.block_recurrences == 0 and task.block_kind is None
    assert "block_loop_released" in _kinds(price)


def test_the_settle_hook_does_not_requeue_a_card_the_breaker_parked(stores):
    """The production loop: approval_requested -> blocked ->
    block_loop_detected -> specified -> promoted -> blocked ... The settle
    hook ran refill, which specified the parked card straight back."""
    project = _project("autonomous")
    result = _start(project)
    price = result["cards"]["price"]
    _loop_until_parked(price)

    kinds = _kinds(price)
    after = kinds[kinds.index("block_loop_detected"):]
    assert "specified" not in after and "promoted" not in after
    assert after.count("block_loop_parked") == 1
    # Marked, with the owner told — but no re-plan from the settle hook.
    assert "replan_requested" not in kinds
    assert any("parked after" in c["body"] for c in APPROVALS.calls)
    with kanban_db.connect_closing() as bconn:
        notes = [c.body for c in kanban_db.list_comments(bconn, price)]
    assert any(
        n.startswith(f"Parked after {kanban_db.BLOCK_RECURRENCE_LIMIT} blocks")
        for n in notes
    )


@pytest.mark.parametrize("autonomy", ["manual", "supervised"])
def test_the_sweep_never_repromotes_and_replans_exactly_once(stores, autonomy):
    prompts = stores
    project = _project(autonomy)
    result = _start(project)
    run = result["run"]
    price = result["cards"]["price"]
    _loop_until_parked(price)

    future = int(run["started_at"]) + 3 * 3600
    for _ in range(3):
        results = projects_reconcile.reconcile_all_open_runs(now=future)
        assert any(
            r.get("action") == "waiting_on_human" and r.get("task_id") == price
            for r in results
        )
        assert _task(price).status == "triage"

    kinds = _kinds(price)
    assert kinds.count("replan_requested") == 1
    assert kinds.count("replan_proposed") == 1
    assert kinds.count("block_loop_parked") == 1
    assert len(prompts) == 1
    assert "RE-PLAN REQUEST" in prompts[0] and "Get the supplier price" in prompts[0]
    with projects_db.connect_closing() as conn:
        assert projects_db.get_project_run_by_id(conn, run["id"])["status"] == "running"
        revs = projects_db.list_playbook_revs(conn, project.id)
        active = projects_db.get_playbook(conn, project.id)
    # The revision waits for a lead, as every agent draft does (§7.2).
    assert len(revs) == 2
    assert active["rev"] == 1
    with kanban_db.connect_closing() as bconn:
        assert projects_run.parked_replan_state(bconn, price) == {
            "status": "proposed", "rev": 2,
        }
        waits = projects_run.run_human_waits(bconn, [price])
    assert waits[0]["parked"] is True
    assert waits[0]["replan"]["status"] == "proposed"


def test_a_busy_planner_defers_the_replan_to_the_next_sweep(stores):
    prompts = stores
    project = _project("autonomous")
    result = _start(project)
    price = result["cards"]["price"]
    _loop_until_parked(price)
    projects_api._PLAN_DRAFTS[project.id] = {"status": "running"}
    projects_reconcile.reconcile_all_open_runs()
    assert "replan_requested" not in _kinds(price)
    projects_api._PLAN_DRAFTS.clear()
    projects_reconcile.reconcile_all_open_runs()
    assert _kinds(price).count("replan_requested") == 1
    assert len(prompts) == 1


def test_a_failed_replan_is_recorded_and_not_retried(stores, monkeypatch):
    def _boom(prompt):
        raise RuntimeError("model down")

    monkeypatch.setattr(projects_api, "_call_plan_model", _boom)
    project = _project("supervised")
    result = _start(project)
    price = result["cards"]["price"]
    _loop_until_parked(price)
    projects_reconcile.reconcile_all_open_runs()
    projects_reconcile.reconcile_all_open_runs()
    kinds = _kinds(price)
    assert kinds.count("replan_requested") == 1
    assert kinds.count("replan_failed") == 1
    with kanban_db.connect_closing() as bconn:
        assert projects_run.parked_replan_state(bconn, price)["status"] == "failed"


def test_a_human_rerun_clears_the_marker_and_a_new_parking_replans_again(stores):
    prompts = stores
    project = _project("supervised")
    result = _start(project)
    price = result["cards"]["price"]
    _loop_until_parked(price)
    projects_reconcile.reconcile_all_open_runs()

    with kanban_db.connect_closing() as bconn:
        assert kanban_db.release_parked_task(bconn, price, actor="user:leo")
        assert not kanban_db.release_parked_task(bconn, price, actor="user:leo")
    task = _task(price)
    assert task.status == "ready" and task.block_recurrences == 0

    # One fresh block is a block, not a parking — the count restarted.
    with kanban_db.connect_closing() as bconn:
        bconn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (price,))
        bconn.commit()
        kanban_db.block_task(bconn, price, reason="waiting on the MCP approval", kind="needs_input")
    assert _task(price).status == "blocked"

    # Parked again later: that parking gets its own (single) re-plan.
    with kanban_db.connect_closing() as bconn:
        for _ in range(kanban_db.BLOCK_RECURRENCE_LIMIT - 1):
            assert kanban_db.unblock_task(bconn, price)
            bconn.execute("UPDATE tasks SET status = 'running' WHERE id = ?", (price,))
            bconn.commit()
            kanban_db.block_task(bconn, price, reason="waiting on the MCP approval", kind="needs_input")
    assert _task(price).status == "triage"
    projects_reconcile.reconcile_all_open_runs()
    projects_reconcile.reconcile_all_open_runs()
    assert _kinds(price).count("replan_requested") == 2
    assert len(prompts) == 2


def test_resume_run_still_releases_a_parked_card(stores):
    project = _project("autonomous")
    result = _start(project)
    run = result["run"]
    price = result["cards"]["price"]
    _loop_until_parked(price)
    with projects_db.connect_closing() as conn:
        projects_db.update_project_run(conn, run["id"], status="failed")
        run = projects_db.get_project_run_by_id(conn, run["id"])
    with projects_db.connect_closing() as conn, kanban_db.connect_closing() as bconn:
        projects_run.resume_run(conn, bconn, project=project, run=run)
    task = _task(price)
    assert task.status == "ready" and task.block_recurrences == 0


ROUTE_AROUND = {"body": "Use the public price list.", "steps": [
    {"key": "alt", "title": "Quote from the public price list instead"},
    {"key": "quote", "title": "Write the quote from the list price",
     "depends_on": ["alt"]},
]}


def _plan_returns(monkeypatch, plan, prompts):
    def _model(prompt):
        prompts.append(prompt)
        return json.dumps(plan)

    monkeypatch.setattr(projects_api, "_call_plan_model", _model)


def _run_cards(run_id):
    with projects_db.connect_closing() as conn:
        return projects_db.get_run_cards(conn, run_id)


def test_an_autonomous_project_activates_the_replan_exactly_once(stores, monkeypatch):
    prompts = stores
    _plan_returns(monkeypatch, ROUTE_AROUND, prompts)
    project = _project("autonomous")
    result = _start(project)
    run = result["run"]
    price, old_quote = result["cards"]["price"], result["cards"]["quote"]
    _loop_until_parked(price)

    for _ in range(3):
        projects_reconcile.reconcile_all_open_runs()

    kinds = _kinds(price)
    assert kinds.count("replan_requested") == 1
    assert kinds.count("replan_activated") == 1
    assert len(prompts) == 1
    # The parked card is superseded, never re-run.
    after = kinds[kinds.index("block_loop_detected"):]
    assert "specified" not in after and "promoted" not in after
    assert _task(price).status == "archived"
    assert _task(old_quote).status == "archived"
    assert "superseded_by_replan" in _kinds(old_quote)

    with projects_db.connect_closing() as conn:
        assert projects_db.get_playbook(conn, project.id)["rev"] == 2
        assert len(projects_db.list_playbook_revs(conn, project.id)) == 2
        fresh = projects_db.get_project_run_by_id(conn, run["id"])
    assert fresh["status"] == "running" and fresh["playbook_rev"] == 2

    # The run continues on the new plan: its first step is promoted, the
    # dependent one waits on it.
    new = {
        rc["step_key"]: _task(rc["task_id"])
        for rc in _run_cards(run["id"])
        if rc["task_id"] not in (price, old_quote)
    }
    assert set(new) == {"alt", "quote"}
    assert new["alt"].status in ("ready", "running")
    assert new["quote"].status in ("triage", "todo")

    with kanban_db.connect_closing() as bconn:
        notes = [c.body for c in kanban_db.list_comments(bconn, price)]
        assert projects_run.parked_replan_state(bconn, price)["status"] == "activated"
        assert projects_run.run_replans(bconn, [price, old_quote]) == [
            {"task_id": price, "title": "Get the supplier price", "rev": 2},
        ]
    assert any(n.startswith("Re-planned automatically after") for n in notes)


def test_auto_activation_refuses_a_plan_that_repeats_the_stuck_step(stores, monkeypatch):
    prompts = stores
    same_again = {"body": "Try again.", "steps": [
        {"key": "price-again", "title": "Get the  supplier price"},
        {"key": "quote", "title": "Write the quote", "depends_on": ["price-again"]},
    ]}
    _plan_returns(monkeypatch, same_again, prompts)
    project = _project("autonomous")
    result = _start(project)
    run = result["run"]
    price = result["cards"]["price"]
    _loop_until_parked(price)

    projects_reconcile.reconcile_all_open_runs()
    projects_reconcile.reconcile_all_open_runs()

    kinds = _kinds(price)
    assert "replan_activated" not in kinds
    assert kinds.count("replan_held") == 1
    assert _task(price).status == "triage"
    with projects_db.connect_closing() as conn:
        assert projects_db.get_playbook(conn, project.id)["rev"] == 1
        assert projects_db.get_project_run_by_id(conn, run["id"])["playbook_rev"] == 1
    with kanban_db.connect_closing() as bconn:
        state = projects_run.parked_replan_state(bconn, price)
    assert state["status"] == "held" and "unchanged" in state["detail"]


def test_a_supervised_project_never_activates_the_replan(stores, monkeypatch):
    prompts = stores
    _plan_returns(monkeypatch, ROUTE_AROUND, prompts)
    project = _project("supervised")
    result = _start(project)
    price = result["cards"]["price"]
    _loop_until_parked(price)
    projects_reconcile.reconcile_all_open_runs()
    projects_reconcile.reconcile_all_open_runs()
    kinds = _kinds(price)
    assert "replan_proposed" in kinds
    assert "replan_activated" not in kinds and "replan_held" not in kinds
    with projects_db.connect_closing() as conn:
        assert projects_db.get_playbook(conn, project.id)["rev"] == 1
    assert _task(price).status == "triage"
