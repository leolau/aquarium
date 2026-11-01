"""``DELETE /api/registry/projects/{slug}?confirm=<slug>&purge=smoke``.

The disposable-test-data variant of hard delete: the e2e and smoke suites
start runs, so their ``[smoke]`` projects carry history the normal delete
refuses. Behaviour contracts:

- Refused unless the project is archived, is test data by name
  (``[smoke]…`` name or ``smoke-…`` slug), the caller is a verified human
  who created it, no run is open, and ``confirm`` names the slug. An
  instance owner/admin or project lead who did not create it is refused —
  a role never widens this path.
- A permitted purge leaves nothing behind: project row + ``project_*``
  rows, the board's cards, and every run's chat session; the active
  pointer no longer names it.
- Without ``purge`` the normal delete still refuses a project with history.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from hermes_cli import kanban_db, projects_db
from hermes_cli.access import Principal
from hermes_state import SessionDB

from tests.hermes_cli.test_projects_api_lifecycle import (  # noqa: F401 - fixture
    LEAD_P,
    MEMBER_P,
    OWNER,
    PREFIX,
    VIEWER_P,
    _archive,
    _create_active_project,
    env,
)

ADMIN_P = Principal(user_id="adm", display="Adm", role="admin")  # type: ignore[arg-type]
SMOKE_NAME = "[smoke] lifecycle 1730000000"


def _home(tmp_path) -> Path:
    return tmp_path / "home"


def _smoke_project(env, **overrides) -> dict:
    return _create_active_project(env, name=SMOKE_NAME, **overrides)


def _seed_run(project: dict, tmp_path, *, run_no: int = 1, status: str = "done") -> str:
    """A run row plus the chat session it created, as a real run leaves them."""
    session_id = f"proj-run-{run_no}-{uuid.uuid4().hex[:8]}"
    db = SessionDB(db_path=_home(tmp_path) / "state.db")
    try:
        db.create_session(session_id, "api_server")
        db.append_message(session_id, "user", "[smoke] do the thing")
    finally:
        db.close()
    with projects_db.connect_closing() as conn:
        with projects_db.write_txn(conn):
            conn.execute(
                "INSERT INTO project_runs "
                "(id, project_id, run_no, trigger, profile, status, started_at, session_id) "
                "VALUES (?, ?, ?, 'manual', 'default', ?, 1700000000, ?)",
                (f"run-{run_no}", project["id"], run_no, status, session_id),
            )
    return session_id


def _session_exists(tmp_path, session_id: str) -> bool:
    db = SessionDB(db_path=_home(tmp_path) / "state.db")
    try:
        return db.get_session(session_id) is not None
    finally:
        db.close()


def _purge(client, slug: str, **params):
    q = {"confirm": slug, "purge": "smoke", **params}
    return client.request("DELETE", f"{PREFIX}/{slug}", params=q)


def _with_history(env, tmp_path) -> tuple[dict, str]:
    """An archived [smoke] project with a card, a delivered output, a
    finished run and that run's session — everything the normal delete
    refuses."""
    client, _state = env
    project = _smoke_project(env)
    resp = client.post(f"{PREFIX}/{project['slug']}/cards", json={"title": "[smoke] card"})
    assert resp.status_code == 200, resp.text
    with projects_db.connect_closing() as conn:
        projects_db.set_active(conn, project["id"])
        with projects_db.write_txn(conn):
            conn.execute(
                "UPDATE project_outputs SET status = 'delivered', "
                "delivered_at = 1700000000 WHERE project_id = ?",
                (project["id"],),
            )
    _archive(env, project)
    session_id = _seed_run(project, tmp_path)
    return project, session_id


def test_purge_removes_every_trace_of_a_smoke_project(env, tmp_path):
    project, session_id = _with_history(env, tmp_path)
    client, _state = env
    assert _session_exists(tmp_path, session_id)

    resp = _purge(client, project["slug"])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["deleted"] == project["slug"]
    assert body["purged"] == {"runs": 1, "cards": 1, "sessions": 1}

    assert client.get(f"{PREFIX}/{project['slug']}").status_code == 404
    with projects_db.connect_closing() as conn:
        assert projects_db.get_active_id(conn) != project["id"]
        for table in ("project_runs", "project_outputs", "project_members"):
            assert not conn.execute(
                f"SELECT 1 FROM {table} WHERE project_id = ?", (project["id"],)
            ).fetchone(), table
    with kanban_db.connect_closing() as bconn:
        assert kanban_db.list_tasks(
            bconn, project_id=project["id"], include_archived=True
        ) == []
    assert not _session_exists(tmp_path, session_id)

    log = _home(tmp_path) / "logs" / "dashboard-auth.log"
    events = [json.loads(line) for line in log.read_text().splitlines()]
    purged = [e for e in events if e["event"] == "project_purged"]
    assert purged and purged[-1]["slug"] == project["slug"]
    assert purged[-1]["actor_user_id"] == OWNER.user_id
    assert purged[-1]["sessions"] == [session_id]


def test_plain_delete_still_refuses_a_smoke_project_with_history(env, tmp_path):
    project, session_id = _with_history(env, tmp_path)
    client, _state = env
    resp = client.request(
        "DELETE", f"{PREFIX}/{project['slug']}", params={"confirm": project["slug"]}
    )
    assert resp.status_code == 409
    assert "1 run" in resp.json()["detail"]
    assert _session_exists(tmp_path, session_id)


def test_purge_matches_a_smoke_slug_too(env, tmp_path):
    client, _state = env
    project = _create_active_project(env, name="Throwaway", slug="smoke-lifecycle-x")
    assert project["slug"] == "smoke-lifecycle-x"
    _archive(env, project)
    _seed_run(project, tmp_path)
    assert _purge(client, project["slug"]).status_code == 200


def test_purge_refuses_a_non_smoke_project(env, tmp_path):
    client, _state = env
    project = _create_active_project(env, name="Monday digest")
    _archive(env, project)
    session_id = _seed_run(project, tmp_path)
    resp = _purge(client, project["slug"])
    assert resp.status_code == 403
    assert "[smoke]" in resp.json()["detail"]
    assert client.get(f"{PREFIX}/{project['slug']}").status_code == 200
    assert _session_exists(tmp_path, session_id)


def test_purge_refuses_an_unarchived_project(env, tmp_path):
    client, _state = env
    project = _smoke_project(env)
    _seed_run(project, tmp_path)
    resp = _purge(client, project["slug"])
    assert resp.status_code == 409
    assert "not archived" in resp.json()["detail"]


@pytest.mark.parametrize("status", ["queued", "running", "waiting"])
def test_purge_refuses_an_open_run(env, tmp_path, status):
    client, _state = env
    project = _smoke_project(env)
    _archive(env, project)
    session_id = _seed_run(project, tmp_path, status=status)
    resp = _purge(client, project["slug"])
    assert resp.status_code == 409
    assert "open run" in resp.json()["detail"]
    assert _session_exists(tmp_path, session_id)


def test_purge_needs_the_typed_slug_and_a_known_mode(env, tmp_path):
    project, _sid = _with_history(env, tmp_path)
    client, _state = env
    resp = client.request(
        "DELETE", f"{PREFIX}/{project['slug']}",
        params={"confirm": "nope", "purge": "smoke"},
    )
    assert resp.status_code == 422
    resp = client.request(
        "DELETE", f"{PREFIX}/{project['slug']}",
        params={"confirm": project["slug"], "purge": "all"},
    )
    assert resp.status_code == 422
    assert client.get(f"{PREFIX}/{project['slug']}").status_code == 200


# Authorization matrix: only the verified human creator may purge. Roles that
# may otherwise write (instance owner/admin, project lead) are refused when
# they did not create the project.
@pytest.mark.parametrize(
    ("actor", "subject", "expected"),
    [
        pytest.param(OWNER, OWNER.user_id, 200, id="creator"),
        pytest.param(OWNER, None, 403, id="creator-without-human-session"),
        pytest.param(ADMIN_P, ADMIN_P.user_id, 403, id="instance-admin-non-creator"),
        pytest.param(
            Principal(user_id="own2", display="O2", role="owner"),  # type: ignore[arg-type]
            "own2", 403, id="instance-owner-non-creator",
        ),
        pytest.param(LEAD_P, LEAD_P.user_id, 403, id="project-lead-non-creator"),
        pytest.param(MEMBER_P, MEMBER_P.user_id, 403, id="project-member"),
        pytest.param(VIEWER_P, VIEWER_P.user_id, 403, id="project-viewer"),
    ],
)
def test_purge_authorization_matrix(env, tmp_path, actor, subject, expected):
    project, session_id = _with_history(env, tmp_path)
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(
            conn, project_id=project["id"], user_id=LEAD_P.user_id, role="lead"
        )
    client, state = env
    state["actor"] = actor
    state["subject"] = subject
    resp = _purge(client, project["slug"])
    assert resp.status_code == expected, resp.text
    state["actor"], state["subject"] = OWNER, OWNER.user_id
    still_there = client.get(f"{PREFIX}/{project['slug']}").status_code == 200
    assert still_there is (expected != 200)
    assert _session_exists(tmp_path, session_id) is (expected != 200)
