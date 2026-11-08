"""Tests for the decomposer module + `hermes kanban decompose` CLI surface.

The auxiliary LLM client is mocked — no network calls. Tests exercise the
prompt plumbing, response parsing, DB writes (via the real DB helper),
and the assignee-fallback logic.
"""

from __future__ import annotations

import json as jsonlib
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from hermes_cli import kanban_db as kb
from hermes_cli import kanban_decompose as decomp


@pytest.fixture
def kanban_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    kb.init_db()
    return home


def _fake_aux_response(content: str):
    resp = MagicMock()
    resp.choices = [MagicMock()]
    resp.choices[0].message.content = content
    return resp


def _mock_client_returning(content: str):
    client = MagicMock()
    client.chat.completions.create = MagicMock(return_value=_fake_aux_response(content))
    return client


def _patch_aux_client(content: str, *, model: str = "test-model"):
    client = _mock_client_returning(content)
    return patch(
        "agent.auxiliary_client.get_text_auxiliary_client",
        return_value=(client, model),
    )


def _patch_extra_body():
    return patch(
        "agent.auxiliary_client.get_auxiliary_extra_body",
        return_value={},
    )


def _patch_list_profiles(names: list[str]):
    """Pretend the named profiles exist. The decomposer uses
    profiles_mod.list_profiles() to build the roster + valid-set, and
    profiles_mod.profile_exists() to resolve orchestrator/default."""
    from types import SimpleNamespace
    fake_profiles = [
        SimpleNamespace(
            name=n, is_default=(i == 0), description=f"desc for {n}",
            description_auto=False, model="m", provider="p", skill_count=1,
        )
        for i, n in enumerate(names)
    ]
    return [
        patch("hermes_cli.profiles.list_profiles", return_value=fake_profiles),
        patch("hermes_cli.profiles.profile_exists", side_effect=lambda x: x in names),
        patch("hermes_cli.profiles.get_active_profile_name", return_value=names[0] if names else "default"),
    ]


def test_decompose_with_fanout_creates_children(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="ship a feature", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "test split",
        "tasks": [
            {"title": "research", "body": "look it up", "assignee": "researcher", "parents": []},
            {"title": "build", "body": "code it", "assignee": "engineer", "parents": [0]},
        ],
    })

    patches = _patch_list_profiles(["orchestrator", "researcher", "engineer"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.fanout is True
    assert outcome.child_ids and len(outcome.child_ids) == 2

    with kb.connect() as conn:
        root = kb.get_task(conn, tid)
        c0 = kb.get_task(conn, outcome.child_ids[0])
        c1 = kb.get_task(conn, outcome.child_ids[1])
    assert root.status == "todo"
    assert c0.status == "ready"
    assert c1.status == "todo"
    assert c0.assignee == "researcher"
    assert c1.assignee == "engineer"


def test_decompose_fanout_false_assigns_default_when_unassigned(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="just one thing", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "**Goal**\nDo the thing.",
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.fanout is False
    assert outcome.new_title == "Tightened title"
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    # specify path with no parents -> recompute_ready flips to 'ready'
    assert task.status == "ready"
    assert task.title == "Tightened title"
    assert task.assignee == "fallback"


def test_decompose_fanout_false_preserves_existing_assignee(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(
            conn,
            title="already routed",
            assignee="engineer",
            triage=True,
        )

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Keep existing lane.",
        "assignee": "fallback",
    })

    patches = _patch_list_profiles(["orchestrator", "engineer", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "engineer"
    assert task.title == "Tightened title"


def test_decompose_fanout_false_uses_valid_llm_assignee(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="route me", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Route to specialist.",
        "assignee": "engineer",
    })

    patches = _patch_list_profiles(["orchestrator", "engineer", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "engineer"


def test_decompose_fanout_false_invalid_llm_assignee_uses_default(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="route me safely", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single unit",
        "title": "Tightened title",
        "body": "Route to fallback.",
        "assignee": "made_up",
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client(llm_payload), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value={"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    with kb.connect() as conn:
        task = kb.get_task(conn, tid)
    assert task is not None
    assert task.assignee == "fallback"


def test_decompose_unknown_assignee_falls_back_to_default(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)

    # Roster only has 'orchestrator' and 'fallback'; LLM picks 'made_up'.
    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "test",
        "tasks": [
            {"title": "do X", "body": "", "assignee": "made_up", "parents": []},
        ],
    })

    patches = _patch_list_profiles(["orchestrator", "fallback"])
    for p in patches:
        p.start()
    try:
        with patch.dict(
            "os.environ", {}, clear=False,
        ), _patch_aux_client(llm_payload), _patch_extra_body(), \
            patch(
                "hermes_cli.kanban_decompose._load_config",
                return_value={
                    "kanban": {
                        "orchestrator_profile": "orchestrator",
                        "default_assignee": "fallback",
                    }
                },
            ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok, outcome.reason
    assert outcome.child_ids and len(outcome.child_ids) == 1
    with kb.connect() as conn:
        child = kb.get_task(conn, outcome.child_ids[0])
    # 'made_up' wasn't in roster, so assignee rewritten to 'fallback'
    assert child.assignee == "fallback"


def test_decompose_handles_malformed_llm_json(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        with _patch_aux_client("not json at all, sorry"), _patch_extra_body():
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is False
    assert "malformed JSON" in outcome.reason


def test_decompose_returns_false_when_task_not_triage(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x")  # ready, not triage

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()
    assert outcome.ok is False
    assert "not in triage" in outcome.reason


def test_decompose_leaves_project_cards_alone(kanban_home):
    """A project run holds its cards in triage on purpose; the sweep must
    neither list them nor fan them out into project-less children."""
    with kb.connect() as conn:
        plain = kb.create_task(conn, title="plain", triage=True)
        card = kb.create_task(conn, title="project card", triage=True)
        conn.execute(
            "UPDATE tasks SET project_id = 'p_test' WHERE id = ?", (card,)
        )
        conn.commit()

    assert decomp.list_triage_ids() == [plain]
    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        outcome = decomp.decompose_task(card, author="auto-decomposer")
    finally:
        for p in patches:
            p.stop()
    assert outcome.ok is False
    assert "project card" in outcome.reason
    with kb.connect() as conn:
        assert kb.get_task(conn, card).status == "triage"
        assert len(kb.list_tasks(conn, include_archived=True)) == 2


def test_decompose_no_aux_client_configured(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)

    patches = _patch_list_profiles(["orchestrator"])
    for p in patches:
        p.start()
    try:
        with patch(
            "agent.auxiliary_client.get_text_auxiliary_client",
            return_value=(None, ""),
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()

    assert outcome.ok is False
    assert "no auxiliary client" in outcome.reason


# ---------------------------------------------------------------------------
# FG-34: capability roster + assignment reasons
# ---------------------------------------------------------------------------


def _make_skilled_profile(name: str, skills: tuple[str, ...]) -> None:
    from hermes_cli import profiles

    home = profiles.get_profile_dir(name)
    for skill in skills:
        d = home / "skills" / skill
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(f"---\nname: {skill.split('/')[-1]}\n---\n")


def _record_finished_run(profile: str, title: str, outcome: str = "completed") -> None:
    import time

    now = int(time.time())
    with kb.connect() as conn:
        tid = kb.create_task(conn, title=title)
        conn.execute(
            "INSERT INTO task_runs (task_id, profile, status, started_at, ended_at, outcome)"
            " VALUES (?, ?, 'done', ?, ?, ?)",
            (tid, profile, now - 120, now - 60, outcome),
        )
        conn.commit()


def _run_decompose(tid, llm_payload, names, cfg=None):
    patches = _patch_list_profiles(names)
    for p in patches:
        p.start()
    client = _mock_client_returning(llm_payload)
    try:
        with patch(
            "agent.auxiliary_client.get_text_auxiliary_client",
            return_value=(client, "test-model"),
        ), _patch_extra_body(), patch(
            "hermes_cli.kanban_decompose._load_config",
            return_value=cfg or {"kanban": {"default_assignee": "fallback"}},
        ):
            outcome = decomp.decompose_task(tid, author="me")
    finally:
        for p in patches:
            p.stop()
    messages = client.chat.completions.create.call_args.kwargs["messages"]
    return outcome, messages


def _assignment_of(task_id):
    from hermes_cli import projects_run

    with kb.connect() as conn:
        record = projects_run.card_assignment(kb.list_events(conn, task_id))
        comments = [c.body for c in kb.list_comments(conn, task_id)]
    return record, comments


def test_roster_carries_skills_and_track_record(kanban_home):
    _make_skilled_profile("researcher", ("research/web-research", "research/citation"))
    _record_finished_run("researcher", "Collect EU pricing")

    patches = _patch_list_profiles(["orchestrator", "researcher"])
    for p in patches:
        p.start()
    try:
        roster, valid = decomp._build_roster()
    finally:
        for p in patches:
            p.stop()

    assert valid == {"orchestrator", "researcher"}
    by_name = {c["name"]: c for c in roster}
    researcher = by_name["researcher"]
    assert {"name": "web-research", "category": "research"} in researcher["skills"]
    assert researcher["track_record"]["completed"] == 1
    # Listed description survives when the profile dir has no profile.yaml.
    assert researcher["description"] == "desc for researcher"
    assert researcher["has_description"] is True

    block = decomp._format_roster(roster)
    assert "research/web-research" in block
    assert "1 completed" in block
    assert '"Collect EU pricing"' in block


def test_good_pick_kept_with_reason_recorded_on_child(kanban_home):
    _make_skilled_profile("researcher", ("research/web-research",))
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="price report", triage=True)

    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "split",
        "tasks": [{
            "title": "Collect competitor pricing",
            "body": "find prices",
            "assignee": "researcher",
            "assignee_reason": "Has web-research and finished similar cards.",
            "fit": "strong",
            "matched_skills": ["web-research", "research/web-research", "invented-skill"],
            "parents": [],
        }],
    })
    outcome, messages = _run_decompose(
        tid, llm_payload, ["orchestrator", "researcher", "fallback"],
    )

    assert outcome.ok, outcome.reason
    system, user = messages[0]["content"], messages[1]["content"]
    assert "assignee_reason" in system and "TRACK RECORD" in system
    assert "research/web-research" in user

    child_id = outcome.child_ids[0]
    with kb.connect() as conn:
        assert kb.get_task(conn, child_id).assignee == "researcher"
    record, comments = _assignment_of(child_id)
    assert record == {
        "assignee": "researcher",
        "assignee_reason": "Has web-research and finished similar cards.",
        "fit": "strong",
        "matched_skills": ["web-research"],
        "assigned_by": "planner",
    }
    assert any(
        "Assigned to researcher (strong fit)" in c and "finished similar cards" in c
        for c in comments
    )


def test_unknown_pick_routes_to_default_with_reason(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="x", triage=True)
    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "t",
        "tasks": [{
            "title": "do X", "body": "", "assignee": "made_up",
            "assignee_reason": "made_up is great", "fit": "strong",
            "matched_skills": ["anything"], "parents": [],
        }],
    })
    outcome, _ = _run_decompose(tid, llm_payload, ["orchestrator", "fallback"])

    assert outcome.ok, outcome.reason
    child_id = outcome.child_ids[0]
    with kb.connect() as conn:
        assert kb.get_task(conn, child_id).assignee == "fallback"
    record, comments = _assignment_of(child_id)
    assert record["assignee"] == "fallback"
    assert record["assigned_by"] == "fallback"
    assert record["fit"] == "none"
    assert record["matched_skills"] == []
    assert "'made_up'" in record["assignee_reason"]
    assert "not an available profile" in record["assignee_reason"]
    assert any("Assigned to fallback (fallback)" in c for c in comments)


def test_no_fit_keeps_the_models_explanation(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="email the client", triage=True)
    llm_payload = jsonlib.dumps({
        "fanout": True,
        "rationale": "t",
        "tasks": [{
            "title": "Send to the client", "body": "", "assignee": None,
            "assignee_reason": "No profile has an email skill.", "fit": "none",
            "suggested_profile": "mailer", "parents": [],
        }],
    })
    outcome, _ = _run_decompose(tid, llm_payload, ["orchestrator", "fallback"])

    assert outcome.ok, outcome.reason
    record, _ = _assignment_of(outcome.child_ids[0])
    assert record["assigned_by"] == "fallback"
    assert record["suggested_profile"] == "mailer"
    assert "No profile has an email skill" in record["assignee_reason"]
    assert "default assignee fallback" in record["assignee_reason"]
    assert len(record["assignee_reason"]) <= 240


def test_single_task_records_assignment_reason(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="one thing", triage=True)
    llm_payload = jsonlib.dumps({
        "fanout": False,
        "rationale": "single",
        "title": "One thing",
        "body": "do it",
        "assignee": "researcher",
        "assignee_reason": "Researcher has the right tools.",
        "fit": "partial",
    })
    outcome, _ = _run_decompose(tid, llm_payload, ["orchestrator", "researcher"])

    assert outcome.ok, outcome.reason
    record, comments = _assignment_of(tid)
    assert record["assignee"] == "researcher"
    assert record["assigned_by"] == "planner"
    assert record["fit"] == "partial"
    assert any("Researcher has the right tools." in c for c in comments)


def test_single_task_keeps_existing_assignee_without_record(kanban_home):
    with kb.connect() as conn:
        tid = kb.create_task(conn, title="mine", triage=True, assignee="orchestrator")
    llm_payload = jsonlib.dumps({
        "fanout": False, "title": "Mine", "body": "b", "assignee": "researcher",
    })
    outcome, _ = _run_decompose(tid, llm_payload, ["orchestrator", "researcher"])

    assert outcome.ok, outcome.reason
    record, _ = _assignment_of(tid)
    assert record is None
