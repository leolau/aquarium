"""Short refs on the Projects surface and ``GET /api/refs/{ref}`` (FG-36).

Contracts: every project/card/run payload agent-home reads carries its ref;
the resolver answers only what the caller may already read through the
project pages — anything else, existing or not, is the same 404.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import kanban_db, projects_api, projects_db, refs_api, short_refs
from hermes_cli.access import Principal

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
STRANGER = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    state = {"actor": OWNER}

    async def _resolve(request, *, allow_as=True):
        return state["actor"]

    async def _enrolled(user_id):
        return set()

    async def _subject(request):
        return ""

    monkeypatch.setattr(
        "hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False
    )
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    app = FastAPI()
    app.include_router(projects_api.router)
    app.include_router(refs_api.router)
    return TestClient(app), state


def _create(client, name="Monday digest") -> dict:
    resp = client.post(
        "/api/registry/projects",
        json={
            "name": name,
            "goal": f"Ship {name} to every subscriber",
            "description": "A weekly digest compiled and emailed each Monday.",
            "host_profile": "default",
            "outputs": [{"title": "The digest email"}],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _card(project_id: str, title: str, **kw) -> str:
    with kanban_db.connect_closing() as bconn:
        return kanban_db.create_task(bconn, title=title, project_id=project_id, **kw)


def _run(project_id: str) -> dict:
    with projects_db.connect_closing() as conn:
        return projects_db.open_project_run(
            conn, project_id=project_id, trigger="manual", profile="default"
        )


# ---------------------------------------------------------------------------
# Serialization
# ---------------------------------------------------------------------------


def test_projects_get_refs_in_creation_order_and_keep_them_on_rename(env):
    client, _ = env
    a = _create(client, "Alpha")
    b = _create(client, "Beta")
    assert (a["ref"], b["ref"]) == ("P1", "P2")
    resp = client.patch(f"/api/registry/projects/{a['slug']}", json={"name": "Renamed"})
    assert resp.status_code == 200, resp.text
    detail = client.get(f"/api/registry/projects/{a['slug']}").json()
    assert detail["ref"] == "P1" and detail["name"] == "Renamed"
    items = client.get("/api/registry/projects").json()["items"]
    assert {i["id"]: i["ref"] for i in items} == {a["id"]: "P1", b["id"]: "P2"}


def test_search_by_ref_finds_exactly_that_project(env):
    client, _ = env
    _create(client, "Alpha")
    beta = _create(client, "Beta")
    for q in ("P2", "p2", "P2-R7"):
        items = client.get("/api/registry/projects", params={"q": q}).json()["items"]
        assert [i["id"] for i in items] == [beta["id"]], q


def test_a_ref_shaped_search_still_matches_names(env):
    client, _ = env
    alpha = _create(client, "Alpha")
    router = _create(client, "Upgrade the P1 router")
    items = client.get("/api/registry/projects", params={"q": "P1"}).json()["items"]
    assert {i["id"] for i in items} == {alpha["id"], router["id"]}


def test_a_project_ref_stands_in_for_its_slug(env):
    client, _ = env
    p = _create(client)
    assert client.get("/api/registry/projects/p1").json()["id"] == p["id"]


def test_cards_and_runs_carry_refs(env):
    client, _ = env
    p = _create(client)
    t1 = _card(p["id"], "First")
    t2 = _card(p["id"], "Second")
    board = client.get(f"/api/registry/projects/{p['slug']}/board").json()
    refs = {t["id"]: t["ref"] for c in board["columns"] for t in c["tasks"]}
    assert refs == {t1: "T1", t2: "T2"}
    card = client.get(f"/api/registry/projects/{p['slug']}/cards/{t2}").json()
    assert card["ref"] == "T2" and card["id"] == t2  # internal id unchanged

    run = _run(p["id"])
    with projects_db.connect_closing() as conn:
        projects_db.link_run_card(conn, run["id"], t1)
    detail = client.get(f"/api/registry/projects/{p['slug']}/runs/{run['run_no']}").json()
    assert detail["ref"] == f"P1-R{run['run_no']}"
    assert detail["project_ref"] == "P1"
    assert [c["ref"] for c in detail["cards"]] == ["T1"]
    runs = client.get(f"/api/registry/projects/{p['slug']}/runs").json()["runs"]
    assert [r["ref"] for r in runs] == [f"P1-R{run['run_no']}"]
    brief = client.get(f"/api/registry/projects/{p['slug']}").json()["runs"]
    assert [r["ref"] for r in brief] == [f"P1-R{run['run_no']}"]


def test_a_card_made_outside_create_task_gets_a_ref_on_read(env):
    client, _ = env
    p = _create(client)
    with kanban_db.connect_closing() as bconn:
        bconn.execute(
            "INSERT INTO tasks (id, title, status, created_at, project_id) "
            "VALUES ('t_raw', 'raw', 'todo', 1, ?)",
            (p["id"],),
        )
        bconn.commit()
    card = client.get(f"/api/registry/projects/{p['slug']}/cards/t_raw").json()
    assert short_refs.parse_ref(card["ref"]).kind == "T"


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


def test_resolves_project_card_and_run_for_a_reader(env):
    client, _ = env
    p = _create(client)
    tid = _card(p["id"], "Draft the email")
    run = _run(p["id"])

    proj = client.get("/api/refs/p1").json()
    assert proj["kind"] == "project" and proj["id"] == p["id"]
    assert proj["title"] == p["name"] and proj["status"] == p["status"]
    assert proj["url"] == f"/projects/{p['slug']}"

    card = client.get("/api/refs/T1").json()
    assert (card["kind"], card["id"], card["title"]) == ("card", tid, "Draft the email")
    assert card["url"] == f"/projects/{p['slug']}/cards/{tid}"
    assert card["project_ref"] == "P1"

    r = client.get(f"/api/refs/P1-R{run['run_no']}").json()
    assert r["kind"] == "run" and r["run_no"] == run["run_no"]
    assert r["url"] == f"/projects/{p['slug']}/runs/{run['run_no']}"
    assert r["status"] == "running"


@pytest.mark.parametrize("ref", ["P99", "T99", "P1-R99", "C1", "D1", "M1", "nope", "P01"])
def test_unknown_refs_are_404(env, ref):
    client, _ = env
    _create(client)
    assert client.get(f"/api/refs/{ref}").status_code == 404


def test_a_project_the_caller_cannot_read_is_404_like_a_missing_one(env):
    client, state = env
    p = _create(client)
    _card(p["id"], "Card")
    run = _run(p["id"])
    state["actor"] = STRANGER
    for ref in ("P1", "T1", f"P1-R{run['run_no']}"):
        resp = client.get(f"/api/refs/{ref}")
        assert resp.status_code == 404, ref
        assert resp.json() == client.get("/api/refs/P99").json()


def test_another_users_private_card_is_404_even_to_a_project_member(env):
    client, state = env
    p = _create(client)
    _card(p["id"], "Shared")
    _card(
        p["id"],
        "Mallory's private card",
        owner_user_id="mallory",
        visibility="private:mallory",
        triage=True,
    )
    with projects_db.connect_closing() as conn:
        projects_db.add_project_member(conn, project_id=p["id"], user_id="ada", role="lead")
    state["actor"] = MEMBER
    assert client.get("/api/refs/T1").status_code == 200
    assert client.get("/api/refs/T2").status_code == 404
    state["actor"] = OWNER  # an instance owner sees every card
    assert client.get("/api/refs/T2").status_code == 200


def test_cli_prints_the_api_resolution(env, monkeypatch, capsys):
    import argparse

    from hermes_cli import projects_cli, ref_cli

    client, _ = env
    p = _create(client)

    async def _principal(actor):
        return OWNER

    monkeypatch.setattr(projects_cli, "_resolve_principal", _principal)
    api_body = client.get("/api/refs/P1").json()

    rc = ref_cli.ref_command(argparse.Namespace(ref="p1", actor=None, json=True))
    import json

    assert rc == 0
    assert json.loads(capsys.readouterr().out) == api_body

    rc = ref_cli.ref_command(argparse.Namespace(ref="p1", actor=None, json=False))
    out = capsys.readouterr().out
    assert rc == 0 and "P1" in out and p["name"] in out and f"/projects/{p['slug']}" in out

    assert ref_cli.ref_command(argparse.Namespace(ref="P42", actor=None, json=False)) == 1
    assert "ref not found" in capsys.readouterr().err
