"""The project Skills tab routes (``hermes_cli.projects_skills_api``).

Behaviour contracts against real stores in a temp HERMES_HOME with two
profiles (``default`` hosts the project, ``sales`` is a member profile), each
with its own skill ledger and config: unreadable projects are 404; the
fan-out reads each profile's ledger in its own scope and never merges rows;
a profile the caller is not enrolled in is hidden; ``can_lab`` is per
profile; candidates' bodies need ``lab`` in the host profile; dismiss needs
project write or host ``lab`` and refuses archived projects.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import projects_api, projects_db, projects_skills_api, skill_ledger

OWNER = SimpleNamespace(user_id="leo", display="Leo", role="owner", is_owner=True, active=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False, active=True)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False, active=True)
STRANGER = SimpleNamespace(user_id="eve", display="Eve", role="member", is_owner=False, active=True)

LAB_FOR_MEMBERS = (
    "access:\n  roles:\n    member:\n      skills:\n        view: true\n        lab: true\n"
)


@pytest.fixture
def world(tmp_path, monkeypatch):
    from hermes_cli import profiles, web_server
    from hermes_constants import get_hermes_home

    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    for var in ("HERMES_KANBAN_TASK", "HERMES_KANBAN_RUN_ID", "HERMES_KANBAN_BOARD", "HERMES_SESSION_ID"):
        monkeypatch.delenv(var, raising=False)
    default_home = get_hermes_home()
    root = default_home / "profiles"
    sales = root / "sales"
    (sales / "skills").mkdir(parents=True)
    (sales / "config.yaml").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(profiles, "_get_default_hermes_home", lambda: default_home)
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: root)

    # Who the caller is: in the acting profile (``actor``) and, for a verified
    # login (``subject``), per profile home (``by_home``) as that profile's own
    # principals table would answer.
    state = {"actor": OWNER, "subject": "", "enrolled": set(), "by_home": {}}

    async def _resolve(request, *, allow_as=False):
        return state["actor"]

    async def _enrolled(user_id):
        return set(state["enrolled"])

    async def _subject(request):
        return state["subject"]

    class _Store:
        def __init__(self, _app_store):
            self.home = str(get_hermes_home().resolve())

        async def resolve_alias(self, subject):
            return None

        async def get(self, user_id):
            return state["by_home"].get(self.home, {}).get(user_id)

        async def get_owner(self):
            return None

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _resolve)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    monkeypatch.setattr("hermes_cli.access.PrincipalStore", _Store)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)

    app = FastAPI()
    app.include_router(projects_skills_api.router)
    client = TestClient(app)
    homes = {"default": default_home, "sales": sales}

    def login(who, profiles_enrolled):
        state["actor"] = who
        state["subject"] = who.user_id
        state["enrolled"] = set(profiles_enrolled)
        state["by_home"] = {
            str(homes[p].resolve()): {who.user_id: who} for p in profiles_enrolled
        }

    return SimpleNamespace(client=client, state=state, homes=homes, login=login, tmp=tmp_path)


def _card(project_id, title, outcome):
    from hermes_cli import kanban_db as kb

    with kb.connect_closing() as conn:
        task_id = kb.create_task(conn, title=title)
        conn.execute("UPDATE tasks SET project_id = ? WHERE id = ?", (project_id, task_id))
        cur = conn.execute(
            "INSERT INTO task_runs (task_id, status, started_at, ended_at, outcome)"
            " VALUES (?, 'done', ?, ?, ?)",
            (task_id, int(time.time()) - 5, int(time.time()), outcome),
        )
        conn.commit()
        return task_id, int(cur.lastrowid)


def _use(home, skill, project_id, title, outcome="completed"):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    task_id, run_id = _card(project_id, title, outcome)
    token = set_hermes_home_override(home)
    try:
        skill_ledger.record_use(skill, trigger="preload", kanban_task_id=task_id, kanban_run_id=run_id)
    finally:
        reset_hermes_home_override(token)
    return task_id


def _project(*, slug="launch", owner="leo", skills="writer,pdf-forms", visibility="shared"):
    with projects_db.connect_closing() as conn:
        pid = projects_db.create_project(conn, name="Launch", slug=slug, owner_user_id=owner)
        projects_db.add_project_profile(conn, project_id=pid, profile="default", role="host")
        projects_db.add_project_profile(conn, project_id=pid, profile="sales", role="member")
        projects_db.update_project_fields(conn, pid, {"skills": skills, "visibility": visibility})
    return pid


def _run(project_id, run_no, task_ids):
    with projects_db.connect_closing() as conn:
        rid = f"run-{run_no}"
        conn.execute(
            "INSERT INTO project_runs (id, project_id, run_no, trigger, profile, status, started_at)"
            " VALUES (?, ?, ?, 'manual', 'default', 'done', ?)",
            (rid, project_id, run_no, int(time.time())),
        )
        for t in task_ids:
            conn.execute("INSERT INTO project_run_cards (run_id, task_id) VALUES (?, ?)", (rid, t))
        conn.commit()


def _seed(world):
    pid = _project()
    t1 = _use(world.homes["default"], "writer", pid, "Draft copy")
    t2 = _use(world.homes["default"], "writer", pid, "Fix copy", outcome="crashed")
    _use(world.homes["sales"], "writer", pid, "Pitch deck")
    _use(world.homes["sales"], "deck-maker", pid, "Pitch deck 2")
    _run(pid, 1, [t1, t2])
    with projects_db.connect_closing() as conn:
        keep = projects_db.add_skill_candidate(conn, project_id=pid, run_no=1, name="po-check", body="x" * 400)
        gone = projects_db.add_skill_candidate(conn, project_id=pid, run_no=1, name="old", body="old body")
        projects_db.dismiss_skill_candidate(conn, project_id=pid, candidate_id=gone, dismissed_by="leo")
    return pid, keep


def test_owner_sees_both_profiles_without_merging_rows(world):
    _seed(world)
    world.login(OWNER, ["default", "sales"])
    resp = world.client.get("/api/registry/projects/launch/skills", params={"days": 30})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["days"] == 30 and data["host_profile"] == "default"
    rows = {(r["name"], r["profile"]): r for r in data["skills"]}
    assert set(rows) == {("writer", "default"), ("writer", "sales"), ("deck-maker", "sales")}
    here = rows[("writer", "default")]
    assert (here["uses"], here["success"], here["failure"], here["runs"], here["tasks"]) == (2, 1, 1, 1, 2)
    assert here["preloaded"] is True and rows[("writer", "sales")]["preloaded"] is False
    assert here["outcomes"] == {"success": 1, "partial": 0, "failed": 1}
    assert len(here["trend"]) == 30
    assert data["preloaded_unused"] == ["pdf-forms"] == data["unused_preloaded"]
    assert data["totals"]["uses"] == 4 and data["totals"]["cards"] == 4 and data["totals"]["runs"] == 1
    assert data["totals"]["worth_improving"] == 1
    assert data["totals"]["first_time_success_rate"] == 0.75
    assert [p["profile"] for p in data["profiles"]] == ["default", "sales"]
    assert all(p["can_lab"] and p["can_manage"] and not p["hidden"] for p in data["profiles"])
    [cand] = data["candidates"]
    assert cand["name"] == "po-check" and len(cand["preview"]) == 280 and len(cand["body"]) == 400
    assert str(world.tmp) not in resp.text


def test_member_sees_summary_but_no_lab_and_unenrolled_profile_is_hidden(world):
    pid, _keep = _seed(world)
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(conn, project_id=pid, user_id="mia", role="member")
    world.login(MEMBER, ["default"])
    data = world.client.get("/api/registry/projects/launch/skills").json()
    assert {(r["name"], r["profile"]) for r in data["skills"]} == {("writer", "default")}
    by = {p["profile"]: p for p in data["profiles"]}
    assert by["default"] == {"profile": "default", "role": "host", "can_lab": False,
                             "can_manage": False, "hidden": False}
    assert by["sales"]["hidden"] is True and by["sales"]["hidden_reason"] == "not_enrolled"
    [cand] = data["candidates"]
    assert "body" not in cand and cand["preview"]


def test_lab_is_read_from_each_profiles_own_config(world):
    _seed(world)
    (world.homes["sales"] / "config.yaml").write_text(LAB_FOR_MEMBERS, encoding="utf-8")
    world.login(MEMBER, ["default", "sales"])
    data = world.client.get("/api/registry/projects/launch/skills").json()
    by = {p["profile"]: p for p in data["profiles"]}
    assert by["default"]["can_lab"] is False and by["sales"]["can_lab"] is True
    # Host profile has no lab for her, so no full candidate body.
    assert "body" not in data["candidates"][0]
    assert len(data["skills"]) == 3


def test_instance_admin_sees_every_project_profile(world):
    _seed(world)
    world.login(ADMIN, ["default"])
    data = world.client.get("/api/registry/projects/launch/skills").json()
    by = {p["profile"]: p for p in data["profiles"]}
    assert not by["sales"]["hidden"] and by["sales"]["can_lab"] is False
    assert by["default"]["can_lab"] is True
    assert {r["profile"] for r in data["skills"]} == {"default", "sales"}


def test_unreadable_project_is_404(world):
    _seed(world)
    _project(slug="secret", owner="leo", visibility="private")
    world.login(STRANGER, ["default"])
    assert world.client.get("/api/registry/projects/secret/skills").status_code == 404
    assert world.client.get("/api/registry/projects/nope/skills").status_code == 404
    assert world.client.post(
        "/api/registry/projects/secret/skills/candidates/skc_x/dismiss"
    ).status_code == 404


def test_dismiss_needs_write_or_host_lab_and_hides_the_candidate(world):
    pid, keep = _seed(world)
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(conn, project_id=pid, user_id="mia", role="member")
    url = f"/api/registry/projects/launch/skills/candidates/{keep}/dismiss"
    world.login(MEMBER, ["default"])
    assert world.client.post(url).status_code == 403

    (world.homes["default"] / "config.yaml").write_text(LAB_FOR_MEMBERS, encoding="utf-8")
    resp = world.client.post(url)
    assert resp.status_code == 200, resp.text
    assert resp.json()["ok"] is True and resp.json()["id"] == keep and resp.json()["dismissed_at"]
    assert world.client.post(url).status_code == 200  # idempotent
    world.login(OWNER, ["default", "sales"])
    assert world.client.get("/api/registry/projects/launch/skills").json()["candidates"] == []
    assert world.client.post(
        "/api/registry/projects/launch/skills/candidates/skc_missing/dismiss"
    ).status_code == 404


def test_dismiss_refused_on_an_archived_project(world):
    pid, keep = _seed(world)
    with projects_db.connect_closing() as conn:
        conn.execute("UPDATE projects SET archived = 1 WHERE id = ?", (pid,))
        conn.commit()
    world.login(OWNER, ["default", "sales"])
    resp = world.client.post(f"/api/registry/projects/launch/skills/candidates/{keep}/dismiss")
    assert resp.status_code == 409, resp.text


def test_candidate_dismissed_column_is_added_to_a_legacy_db(world, monkeypatch):
    import sqlite3

    path = world.tmp / "legacy-projects.db"
    with sqlite3.connect(str(path)) as legacy:
        legacy.executescript(
            "CREATE TABLE project_skill_candidates (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,"
            " run_no INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);"
        )
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(path))
    with projects_db.connect_closing() as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(project_skill_candidates)")}
    assert {"dismissed_at", "dismissed_by"} <= cols


# ---------------------------------------------------------------------------
# /api/skills/usage/detail?project=
# ---------------------------------------------------------------------------


@pytest.fixture
def detail_client(world):
    from starlette.testclient import TestClient as StarletteClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = StarletteClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_usage_detail_filters_by_project_and_checks_project_read(world, detail_client, monkeypatch):
    pid = _project()
    other = _project(slug="digest", visibility="private", owner="someone")
    _use(world.homes["default"], "writer", pid, "Draft copy")
    _use(world.homes["default"], "writer", other, "Private card")
    world.state["actor"] = OWNER

    resp = detail_client.get("/api/skills/usage/detail", params={"name": "writer", "project": "launch"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["project"] == "launch" and data["summary"]["uses"] == 1
    assert [e["task"]["title"] for e in data["events"]] == ["Draft copy"]
    assert detail_client.get(
        "/api/skills/usage/detail", params={"name": "writer", "project": "../x"}
    ).status_code == 400

    # A lab holder who cannot read the private project gets a 404, not titles.
    (world.homes["default"] / "config.yaml").write_text(LAB_FOR_MEMBERS, encoding="utf-8")
    world.state["actor"] = STRANGER
    from hermes_cli import web_server

    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "eve")
    resp = detail_client.get("/api/skills/usage/detail", params={"name": "writer", "project": "digest"})
    assert resp.status_code == 404, resp.text
    assert "Private card" not in resp.text
