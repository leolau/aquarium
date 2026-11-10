"""``/{slug}/clarify`` — the agent asks scope questions before it plans.

Contracts: reads need read permission and writes need write permission
(viewer 403, stranger 404, archived 409); questions come from a background,
tool-less model call whose loose reply is normalised into a recorded round;
one job per project (409 while running); a failed call is a ``failed`` job
with a friendly detail; answers 404 on an unknown id and 409 on a blank
answer or a confirmed round; confirm stores the (edited) understanding and
may start the ordinary plan draft, reporting a refusal instead of failing;
an idempotent replay never starts a second job.
"""

from __future__ import annotations

import json
import threading
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import projects_api, projects_clarify_api, projects_db
from hermes_cli.access import Principal
from hermes_cli.projects_idempotency import ProjectsIdempotencyMiddleware

from tests.hermes_cli.test_projects_api import (  # noqa: F401
    MEMBER_P,
    OWNER,
    STRANGER,
    _create,
    _member,
)

VIEWER_P = Principal(user_id="vic", display="Vic", role="member")  # type: ignore[arg-type]
PREFIX = "/api/registry/projects"


def _app(tmp_path, monkeypatch, *, idempotent: bool):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.setenv("HERMES_IDEMPOTENCY_DB", str(tmp_path / "idem.db"))
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
    app.include_router(projects_clarify_api.router)
    if idempotent:
        app.add_middleware(ProjectsIdempotencyMiddleware)
    return TestClient(app), state


@pytest.fixture
def env(tmp_path, monkeypatch):
    return _app(tmp_path, monkeypatch, idempotent=False)


@pytest.fixture
def ienv(tmp_path, monkeypatch):
    return _app(tmp_path, monkeypatch, idempotent=True)


@pytest.fixture(autouse=True)
def _reset():
    projects_clarify_api.reset_state()
    projects_api._PLAN_DRAFTS.clear()
    yield
    projects_clarify_api.reset_state()
    projects_api._PLAN_DRAFTS.clear()


ROUND_ONE = {
    "understanding": "A weekly digest emailed to every subscriber on Monday.",
    "done": False,
    "questions": [
        {
            "category": "audience",
            "question": "Who reads the digest?",
            "why": "Tone and depth depend on the reader.",
            "options": ["Customers", "The team"],
            "allow_multiple": True,
        },
        {"category": "format", "question": "How long should it be?", "why": "Sets the scope."},
        {"category": "nonsense", "question": "Any hard deadline on Monday?"},
    ],
}


class FakeModel:
    def __init__(self, reply=None, exc=None, gate=None):
        self.reply = json.dumps(ROUND_ONE) if reply is None else reply
        self.exc = exc
        self.gate = gate
        self.calls: list[list[dict]] = []

    def __call__(self, messages):
        self.calls.append(messages)
        if self.gate is not None:
            self.gate.wait(5)
        if self.exc is not None:
            raise self.exc
        return self.reply


@pytest.fixture
def model(monkeypatch):
    fake = FakeModel()
    monkeypatch.setattr(projects_clarify_api, "_call_clarify_model", fake)
    return fake


def _url(slug, tail=""):
    return f"{PREFIX}/{slug}/clarify{tail}"


def _wait_job(client, slug, timeout=5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = client.get(_url(slug)).json()
        if state["job"]["status"] in ("done", "failed"):
            return state
        time.sleep(0.02)
    raise AssertionError("clarify job never finished")


def _ask(client, slug, **body):
    return client.post(_url(slug, "/questions"), json=body)


def _round(env, model) -> tuple[str, dict]:
    client, _ = env
    slug = _create(env)["slug"]
    assert _ask(client, slug).status_code == 200
    state = _wait_job(client, slug)
    assert state["job"]["status"] == "done", state
    return slug, state


# ---------------------------------------------------------------------------
# GET + questions job
# ---------------------------------------------------------------------------


def test_get_on_a_fresh_project_is_the_empty_state(env):
    client, _ = env
    slug = _create(env)["slug"]
    resp = client.get(_url(slug))
    assert resp.status_code == 200
    state = resp.json()
    assert state["status"] == "not_started"
    assert state["round"] == 0
    assert state["rounds"] == [] and state["questions"] == []
    assert state["understanding"] is None
    assert state["job"] == {"status": "idle"}


def test_questions_job_records_a_round_from_the_model(env, model):
    client, _ = env
    project = _create(env)
    slug = project["slug"]
    model.gate = threading.Event()
    resp = _ask(client, slug)
    assert resp.status_code == 200, resp.text
    assert resp.json()["job"]["status"] == "running"
    model.gate.set()

    state = _wait_job(client, slug)
    assert state["job"]["status"] == "done"
    assert state["job"]["round_no"] == 1
    assert state["status"] == "open"
    assert state["round"] == 1
    assert state["open_count"] == 3
    (rnd,) = state["rounds"]
    assert rnd["understanding"] == ROUND_ONE["understanding"]
    assert rnd["done"] is False
    assert rnd["created_by"] == "leo"
    qs = state["questions"]
    assert [q["category"] for q in qs] == ["audience", "format", "other"]
    assert qs[0]["options"] == ["Customers", "The team"]
    assert qs[0]["allow_multiple"] is True
    assert qs[0]["why"] == "Tone and depth depend on the reader."
    # Not confirmed yet: no confirmed understanding on the summary.
    assert state["understanding"] is None

    # One fresh, tool-less message list: system + the project text.
    (messages,) = model.calls
    assert [m["role"] for m in messages] == ["system", "user"]
    prompt = messages[1]["content"]
    assert "Ship the Monday digest" in prompt
    assert "A weekly digest compiled and emailed each Monday." in prompt
    assert "The Monday digest email" in prompt
    assert "first round" in prompt


def test_prompt_carries_inputs_grouped_like_the_inputs_tab(env, model):
    client, _ = env
    project = _create(env)
    pid = project["id"]
    with projects_db.connect_closing() as conn:
        for kind, ref, label in (
            ("sample", "files/last-digest.pdf", "last-digest.pdf"),
            ("reference", "files/style-guide.docx", "style-guide.docx"),
            ("file", "files/raw.csv", "raw.csv"),
            ("memory", "mem_1", "Subscribers prefer short items"),
            ("reference", "note:Never mention competitors", "Never mention competitors"),
            ("url", "https://example.com/feed", "The feed"),
            ("goal", "g_1", "A goal is not an input"),
        ):
            projects_db.add_project_link(
                conn, project_id=pid, kind=kind, profile="default", ref=ref, label=label
            )
    _ask(client, project["slug"], focus="the tone of voice")
    _wait_job(client, project["slug"])
    prompt = model.calls[0][1]["content"]
    files = prompt.index("Files:")
    memories = prompt.index("Memories:")
    links = prompt.index("Links & notes:")
    assert files < memories < links
    assert "last-digest.pdf (template to match)" in prompt
    assert "style-guide.docx (reference to read)" in prompt
    assert "raw.csv (file)" in prompt
    assert "- Subscribers prefer short items" in prompt[memories:links]
    assert "Note: Never mention competitors" in prompt[links:]
    assert "<https://example.com/feed>" in prompt[links:]
    assert "A goal is not an input" not in prompt
    assert "focus on: the tone of voice" in prompt
    state = client.get(_url(project["slug"])).json()
    assert state["rounds"][0]["focus"] == "the tone of voice"


def test_a_follow_up_round_sees_earlier_answers(env, model):
    client, _ = env
    slug, state = _round(env, model)
    q1, q2, _q3 = state["questions"]
    resp = client.post(
        _url(slug, "/answers"),
        json={"answers": [{"id": q1["id"], "answer": "Paying customers"}, {"id": q2["id"], "skip": True}]},
    )
    assert resp.status_code == 200
    model.reply = json.dumps({"understanding": "Enough now.", "done": True, "questions": []})
    _ask(client, slug)
    state = _wait_job(client, slug)
    prompt = model.calls[1][1]["content"]
    assert "EARLIER ROUNDS" in prompt
    assert "Who reads the digest?" in prompt
    assert "A: Paying customers" in prompt
    assert "(skipped by the owner)" in prompt
    assert "(not answered yet)" in prompt
    assert "This is round 2" in prompt
    # done with no questions: the round is recorded already answered.
    assert state["round"] == 2
    assert state["rounds"][-1]["done"] is True
    assert state["status"] == "answered"
    assert [q["round_no"] for q in state["questions"]] == [1, 1, 1]


def test_reply_in_a_code_fence_with_prose_is_parsed(env, model):
    client, _ = env
    model.reply = "Here you go:\n```json\n" + json.dumps(ROUND_ONE) + "\n```\nHope that helps."
    slug = _create(env)["slug"]
    _ask(client, slug)
    state = _wait_job(client, slug)
    assert state["job"]["status"] == "done"
    assert len(state["questions"]) == 3


def test_second_request_while_running_is_409(env, monkeypatch):
    client, _ = env
    gate = threading.Event()
    fake = FakeModel(gate=gate)
    monkeypatch.setattr(projects_clarify_api, "_call_clarify_model", fake)
    slug = _create(env)["slug"]
    assert _ask(client, slug).status_code == 200
    again = _ask(client, slug)
    assert again.status_code == 409
    assert "already working on questions" in again.json()["detail"]
    # Confirm is refused while the job runs, too.
    assert client.post(_url(slug, "/confirm"), json={}).status_code == 409
    gate.set()
    assert _wait_job(client, slug)["job"]["status"] == "done"
    assert len(fake.calls) == 1


@pytest.mark.parametrize(
    "fake, needle",
    [
        (FakeModel(reply="Sorry, I can't help with that."), "couldn't be read as questions"),
        (FakeModel(exc=RuntimeError("boom: traceback")), "couldn't come up with questions"),
        (
            FakeModel(exc=projects_clarify_api.ClarifyModelUnavailable("No LLM provider configured")),
            "no model is configured",
        ),
        (FakeModel(exc=TimeoutError("read timed out")), "took too long"),
    ],
)
def test_a_failed_job_carries_a_friendly_detail(env, monkeypatch, fake, needle):
    client, _ = env
    monkeypatch.setattr(projects_clarify_api, "_call_clarify_model", fake)
    slug = _create(env)["slug"]
    _ask(client, slug)
    state = _wait_job(client, slug)
    assert state["job"]["status"] == "failed"
    assert needle in state["job"]["detail"]
    assert "traceback" not in state["job"]["detail"]
    assert state["rounds"] == []
    # A failed job does not block the next attempt.
    monkeypatch.setattr(projects_clarify_api, "_call_clarify_model", FakeModel())
    assert _ask(client, slug).status_code == 200
    assert _wait_job(client, slug)["job"]["status"] == "done"


def test_focus_is_bounded(env, model):
    client, _ = env
    slug = _create(env)["slug"]
    resp = _ask(client, slug, focus="x" * (projects_clarify_api.FOCUS_MAX_LEN + 1))
    assert resp.status_code == 422
    assert model.calls == []


# ---------------------------------------------------------------------------
# Answers
# ---------------------------------------------------------------------------


def test_answers_happy_path_moves_the_round_to_answered(env, model):
    client, _ = env
    slug, state = _round(env, model)
    ids = [q["id"] for q in state["questions"]]
    resp = client.post(
        _url(slug, "/answers"),
        json={"answers": [{"id": ids[0], "answer": "Customers"}, {"id": ids[1], "answer": "Short"}]},
    )
    assert resp.status_code == 200, resp.text
    state = resp.json()
    assert state["status"] == "open"
    assert state["answered_count"] == 2 and state["open_count"] == 1
    resp = client.post(_url(slug, "/answers"), json={"answers": [{"id": ids[2], "skip": True}]})
    state = resp.json()
    assert state["status"] == "answered"
    by_id = {q["id"]: q for q in state["questions"]}
    assert by_id[ids[0]]["answer"] == "Customers"
    assert by_id[ids[0]]["answered_by"] == "leo"
    assert by_id[ids[2]]["status"] == "skipped"
    # Still changeable until confirmed.
    resp = client.post(_url(slug, "/answers"), json={"answers": [{"id": ids[0], "answer": "Everyone"}]})
    assert {q["id"]: q for q in resp.json()["questions"]}[ids[0]]["answer"] == "Everyone"


def test_answers_refusals(env, model):
    client, _ = env
    slug, state = _round(env, model)
    qid = state["questions"][0]["id"]
    resp = client.post(_url(slug, "/answers"), json={"answers": [{"id": "clq_nope", "answer": "x"}]})
    assert resp.status_code == 404
    resp = client.post(_url(slug, "/answers"), json={"answers": [{"id": qid, "answer": "   "}]})
    assert resp.status_code == 409
    assert client.post(_url(slug, "/answers"), json={"answers": []}).status_code == 422
    assert client.post(_url(slug, "/answers"), json={"answers": [{"answer": "x"}]}).status_code == 422
    assert client.post(_url(slug, "/confirm"), json={}).status_code == 200
    resp = client.post(_url(slug, "/answers"), json={"answers": [{"id": qid, "answer": "late"}]})
    assert resp.status_code == 409
    assert "confirmed" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------


def test_confirm_without_a_round_is_409(env):
    client, _ = env
    slug = _create(env)["slug"]
    resp = client.post(_url(slug, "/confirm"), json={})
    assert resp.status_code == 409
    assert "nothing to confirm" in resp.json()["detail"]


def test_confirm_keeps_the_agents_understanding_and_skips_open_questions(env, model):
    client, _ = env
    slug, state = _round(env, model)
    qid = state["questions"][0]["id"]
    client.post(_url(slug, "/answers"), json={"answers": [{"id": qid, "answer": "Customers"}]})
    resp = client.post(_url(slug, "/confirm"), json={})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["plan_draft"] is None
    st = body["state"]
    assert st["status"] == "confirmed"
    assert st["understanding"] == ROUND_ONE["understanding"]
    assert st["confirmed_at"]
    assert [q["status"] for q in st["questions"]] == ["answered", "skipped", "skipped"]
    assert st["rounds"][0]["confirmed_by"] == "leo"
    assert projects_api._PLAN_DRAFTS == {}


def test_confirm_stores_an_edited_understanding(env, model):
    client, _ = env
    slug, _state = _round(env, model)
    resp = client.post(
        _url(slug, "/confirm"), json={"understanding": "  Digest for paying customers only.  "}
    )
    assert resp.json()["state"]["understanding"] == "Digest for paying customers only."
    too_long = "x" * (projects_clarify_api.UNDERSTANDING_MAX_LEN + 1)
    assert client.post(_url(slug, "/confirm"), json={"understanding": too_long}).status_code == 422


def test_confirm_with_draft_plan_starts_the_plan_draft(env, model, monkeypatch):
    client, _ = env
    slug, _state = _round(env, model)
    prompts = []

    def fake_plan(prompt):
        prompts.append(prompt)
        return json.dumps({"body": "Do it.", "steps": [{"key": "a", "title": "Write it"}]})

    monkeypatch.setattr(projects_api, "_call_plan_model", fake_plan)
    resp = client.post(_url(slug, "/confirm"), json={"draft_plan": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["plan_draft"]["status"] == "running"
    assert body["state"]["status"] == "confirmed"
    deadline = time.time() + 5
    while time.time() < deadline:
        draft = client.get(f"{PREFIX}/{slug}/playbook/draft").json()
        if draft["status"] != "running":
            break
        time.sleep(0.02)
    assert draft["status"] == "done", draft
    assert draft["rev"] == 1
    assert len(prompts) == 1


def test_confirm_with_draft_plan_reports_a_refused_draft(env, model):
    client, _ = env
    project = _create(env)
    slug = project["slug"]
    _ask(client, slug)
    _wait_job(client, slug)
    with projects_db.connect_closing() as conn:
        conn.execute("DELETE FROM project_outputs WHERE project_id = ?", (project["id"],))
        conn.commit()
    resp = client.post(_url(slug, "/confirm"), json={"draft_plan": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["plan_draft"] == {
        "status": "refused",
        "detail": "declare at least one output before drafting a plan",
    }
    # The confirm itself still landed.
    assert body["state"]["status"] == "confirmed"


def test_confirm_while_a_plan_draft_runs_reports_it_refused(env, model):
    client, _ = env
    project = _create(env)
    slug = project["slug"]
    _ask(client, slug)
    _wait_job(client, slug)
    projects_api._PLAN_DRAFTS[project["id"]] = {"status": "running"}
    body = client.post(_url(slug, "/confirm"), json={"draft_plan": True}).json()
    assert body["plan_draft"]["status"] == "refused"
    assert "already drafting" in body["plan_draft"]["detail"]


# ---------------------------------------------------------------------------
# Permissions, archive, detail, idempotency
# ---------------------------------------------------------------------------


def test_viewer_reads_but_never_writes_and_a_stranger_sees_nothing(env, model):
    client, state = env
    slug, st = _round(env, model)
    pid = client.get(f"{PREFIX}/{slug}").json()["id"]
    qid = st["questions"][0]["id"]
    _member(pid, "vic", "viewer")
    state["actor"] = VIEWER_P
    assert client.get(_url(slug)).status_code == 200
    assert _ask(client, slug).status_code == 403
    assert client.post(_url(slug, "/answers"), json={"answers": [{"id": qid, "answer": "x"}]}).status_code == 403
    assert client.post(_url(slug, "/confirm"), json={}).status_code == 403
    state["actor"] = STRANGER
    assert client.get(_url(slug)).status_code == 404
    assert _ask(client, slug).status_code == 404
    assert client.post(_url(slug, "/confirm"), json={}).status_code == 404
    assert len(model.calls) == 1


def test_archived_project_refuses_every_clarify_write(env, model):
    client, _ = env
    slug, st = _round(env, model)
    pid = client.get(f"{PREFIX}/{slug}").json()["id"]
    with projects_db.connect_closing() as conn:
        assert projects_db.archive_project(conn, pid)
    qid = st["questions"][0]["id"]
    assert client.get(_url(slug)).status_code == 200
    assert _ask(client, slug).status_code == 409
    assert client.post(_url(slug, "/answers"), json={"answers": [{"id": qid, "answer": "x"}]}).status_code == 409
    assert client.post(_url(slug, "/confirm"), json={}).status_code == 409
    assert len(model.calls) == 1


def test_detail_payload_carries_the_clarify_summary(env, model):
    client, _ = env
    slug = _create(env)["slug"]
    detail = client.get(f"{PREFIX}/{slug}").json()
    assert detail["clarify"]["status"] == "not_started"
    _ask(client, slug)
    _wait_job(client, slug)
    client.post(_url(slug, "/confirm"), json={"understanding": "Got it."})
    clarify = client.get(f"{PREFIX}/{slug}").json()["clarify"]
    assert clarify["status"] == "confirmed"
    assert clarify["understanding"] == "Got it."
    assert clarify["round"] == 1


def test_same_idempotency_key_replays_without_a_second_job(ienv, model):
    client, _ = ienv
    slug = _create(ienv)["slug"]
    headers = {"Idempotency-Key": "clarify-1"}
    a = client.post(_url(slug, "/questions"), json={}, headers=headers)
    assert a.status_code == 200, a.text
    _wait_job(client, slug)
    b = client.post(_url(slug, "/questions"), json={}, headers=headers)
    assert b.status_code == 200
    assert b.headers["idempotent-replayed"] == "true"
    assert a.json() == b.json()
    assert len(model.calls) == 1
    assert len(client.get(_url(slug)).json()["rounds"]) == 1
    # A fresh key asks again.
    client.post(_url(slug, "/questions"), json={}, headers={"Idempotency-Key": "clarify-2"})
    assert len(_wait_job(client, slug)["rounds"]) == 2


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_parse_reply_tolerates_loose_shapes():
    raw = json.dumps(
        {
            "understanding": "U",
            "done": "false",
            "questions": [
                "Plain string question?",
                {"text": "Uses text?", "options": "Only one", "allow_multiple": "yes"},
                {"question": "   "},
                42,
            ]
            + [{"question": f"Q{i}?"} for i in range(10)],
        }
    )
    parsed = projects_clarify_api.parse_clarify_reply(raw)
    assert parsed["done"] is False
    qs = parsed["questions"]
    assert len(qs) == projects_db.CLARIFY_MAX_QUESTIONS
    assert qs[0]["question"] == "Plain string question?"
    assert qs[1]["options"] == ["Only one"] and qs[1]["allow_multiple"] is True


def test_parse_reply_with_no_questions_is_done_and_garbage_is_refused():
    parsed = projects_clarify_api.parse_clarify_reply('{"understanding": "All clear."}')
    assert parsed == {"understanding": "All clear.", "done": True, "questions": []}
    with pytest.raises(projects_clarify_api.ClarifyReplyError):
        projects_clarify_api.parse_clarify_reply('{"questions": []}')
    with pytest.raises(projects_clarify_api.ClarifyReplyError):
        projects_clarify_api.parse_clarify_reply("no json here")
    with pytest.raises(projects_clarify_api.ClarifyReplyError):
        projects_clarify_api.parse_clarify_reply('{"questions": [')


def test_group_input_links_mirrors_the_inputs_tab():
    links = [
        {"kind": "file", "ref": "a.pdf", "added_at": 1},
        {"kind": "sample", "ref": "b.pdf", "added_at": 5},
        {"kind": "sample", "ref": "https://x.test/s", "added_at": 2},
        {"kind": "reference", "ref": "note:hello", "added_at": 3},
        {"kind": "reference", "ref": "c.docx", "added_at": 4},
        {"kind": "memory", "ref": "m1", "added_at": 1},
        {"kind": "todo", "ref": "t1", "added_at": 6},
        {"kind": "arrival", "ref": "ar1", "added_at": 7},
        {"kind": "conversation", "ref": "cv1", "added_at": 8},
        {"kind": "url", "ref": "https://y.test", "added_at": 9},
        {"kind": "goal", "ref": "g1", "added_at": 10},
    ]
    groups = projects_clarify_api.group_input_links(links)
    assert [r["ref"] for r in groups["files"]] == ["b.pdf", "c.docx", "a.pdf"]
    assert [r["ref"] for r in groups["memories"]] == ["m1"]
    assert [r["ref"] for r in groups["links"]] == [
        "https://y.test", "cv1", "ar1", "t1", "note:hello", "https://x.test/s",
    ]


def test_prompt_is_bounded(env):
    client, _ = env
    project = _create(env, body={"description": "word " * 20_000})
    with projects_db.connect_closing() as conn:
        for i in range(200):
            projects_db.add_project_link(
                conn, project_id=project["id"], kind="reference", profile="default",
                ref=f"note:{'n' * 500} {i}",
            )
        projects_db.add_clarify_round(
            conn, project["id"],
            questions=[{"question": "q" * 1_500} for _ in range(7)],
            understanding="u" * 3_000, done=False, created_by="leo",
        )
    with projects_db.connect_closing() as conn:
        proj = projects_db.get_project(conn, project["slug"])
    prompt = projects_clarify_api.build_clarify_prompt(proj)
    assert len(prompt) <= projects_clarify_api.PROMPT_MAX_CHARS
    assert "more inputs" in prompt
    assert "This is round 2" in prompt
