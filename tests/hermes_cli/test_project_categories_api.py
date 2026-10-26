"""Project categories: the store, the ``/api/registry/project-categories``
router, and the ``category_id`` field on the project routes.

Behaviour contracts: the one-time seed, CRUD with its error mapping, the
delete that files projects back under Uncategorized, the project-side
``category_id`` (create / patch / list filter) and the in-place migration
of a legacy DB.
"""

from __future__ import annotations

import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import projects_api, projects_categories_api, projects_db
from hermes_cli.access import Principal
from hermes_cli.projects_idempotency import ProjectsIdempotencyMiddleware

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
MEMBER_P = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]

CATS = "/api/registry/project-categories"
PROJECTS = "/api/registry/projects"


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated stores, both routers + the idempotency middleware, and an
    actor dial (mirrors ``test_projects_api.env``)."""
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    monkeypatch.delenv("HERMES_IDEMPOTENCY_DB", raising=False)

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
    app.include_router(projects_categories_api.router)
    app.add_middleware(ProjectsIdempotencyMiddleware)
    return TestClient(app), state


def _create_project(client, **extra) -> dict:
    payload = {
        "goal": "Ship the Monday digest — to every subscriber",
        "description": "A weekly digest compiled and emailed each Monday.",
        "host_profile": "default",
        "outputs": [{"title": "The Monday digest email"}],
    }
    payload.update(extra)
    resp = client.post(PROJECTS, json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _categories(client) -> list[dict]:
    resp = client.get(CATS)
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


def _by_name(client) -> dict[str, dict]:
    return {c["name"]: c for c in _categories(client)}


# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------


def test_a_fresh_db_is_seeded_with_the_default_categories_in_order(env):
    client, _ = env
    items = _categories(client)
    assert [c["name"] for c in items] == list(projects_db.DEFAULT_CATEGORY_NAMES)
    positions = [c["position"] for c in items]
    assert positions == sorted(positions)
    for c in items:
        assert c["id"].startswith("pcat_")
        assert c["project_count"] == 0
        assert c["color"] is None
        assert isinstance(c["created_at"], int)


def test_deleting_every_category_never_reseeds(env):
    client, _ = env
    for c in _categories(client):
        assert client.delete(f"{CATS}/{c['id']}").status_code == 200
    # A new process opening the same DB re-runs schema init.
    projects_db._INITIALIZED_PATHS.clear()
    with projects_db.connect_closing() as conn:
        assert projects_db.seed_default_categories(conn) is False
    assert _categories(client) == []


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def test_create_trims_appends_and_records_the_creator(env):
    client, state = env
    state["actor"] = MEMBER_P  # any signed-in user may manage categories
    before = _categories(client)
    resp = client.post(CATS, json={"name": "  Finance  ", "color": "#f59e0b"})
    assert resp.status_code == 200, resp.text
    cat = resp.json()
    assert cat["name"] == "Finance"
    assert cat["color"] == "#f59e0b"
    assert cat["created_by"] == "ada"
    assert cat["project_count"] == 0
    assert cat["position"] == max(c["position"] for c in before) + 1
    assert _categories(client)[-1] == cat


@pytest.mark.parametrize("name", ["", "   ", "x" * 41, None, 7])
def test_create_refuses_a_bad_name_with_422(env, name):
    client, _ = env
    assert client.post(CATS, json={"name": name}).status_code == 422


def test_names_are_unique_case_insensitively(env):
    client, _ = env
    assert client.post(CATS, json={"name": "sales"}).status_code == 409
    finance = client.post(CATS, json={"name": "Finance"}).json()
    resp = client.patch(f"{CATS}/{finance['id']}", json={"name": " MARKETING "})
    assert resp.status_code == 409
    # Renaming to its own name in another case is not a conflict.
    resp = client.patch(f"{CATS}/{finance['id']}", json={"name": "FINANCE"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "FINANCE"


def test_patch_renames_recolours_and_reorders(env):
    client, _ = env
    sales = _by_name(client)["Sales"]
    resp = client.patch(
        f"{CATS}/{sales['id']}",
        json={"name": "Revenue", "color": "#10b981", "position": 99},
    )
    assert resp.status_code == 200, resp.text
    cat = resp.json()
    assert (cat["name"], cat["color"], cat["position"]) == ("Revenue", "#10b981", 99)
    assert _categories(client)[-1]["id"] == sales["id"]
    cleared = client.patch(f"{CATS}/{sales['id']}", json={"color": None}).json()
    assert cleared["color"] is None
    assert cleared["name"] == "Revenue"


def test_patch_refuses_bad_fields_with_422(env):
    client, _ = env
    sales = _by_name(client)["Sales"]
    for body in ({"name": ""}, {"position": "first"}, {"position": True}, {"color": 3}):
        assert client.patch(f"{CATS}/{sales['id']}", json=body).status_code == 422, body


def test_unknown_category_is_404(env):
    client, _ = env
    assert client.patch(f"{CATS}/pcat_nope", json={"name": "X"}).status_code == 404
    assert client.delete(f"{CATS}/pcat_nope").status_code == 404


def test_delete_files_its_projects_under_uncategorized(env):
    client, _ = env
    cats = _by_name(client)
    sales, research = cats["Sales"], cats["Research"]
    a = _create_project(client, category_id=sales["id"])
    b = _create_project(client, category_id=sales["id"])
    c = _create_project(client, category_id=research["id"])
    assert _by_name(client)["Sales"]["project_count"] == 2

    resp = client.delete(f"{CATS}/{sales['id']}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"deleted": sales["id"], "uncategorized": 2}

    assert "Sales" not in _by_name(client)
    for p in (a, b):
        assert client.get(f"{PROJECTS}/{p['slug']}").json()["category_id"] is None
    assert client.get(f"{PROJECTS}/{c['slug']}").json()["category_id"] == research["id"]


def test_category_mutations_honour_the_idempotency_key(env):
    client, _ = env
    headers = {"Idempotency-Key": "cat-1"}
    first = client.post(CATS, json={"name": "Finance"}, headers=headers)
    again = client.post(CATS, json={"name": "Finance"}, headers=headers)
    assert first.status_code == again.status_code == 200
    assert again.headers["idempotent-replayed"] == "true"
    assert again.json() == first.json()
    assert [c["name"] for c in _categories(client)].count("Finance") == 1


# ---------------------------------------------------------------------------
# Projects carry category_id
# ---------------------------------------------------------------------------


def test_a_new_project_is_uncategorized_unless_given_a_category(env):
    client, _ = env
    assert _create_project(client)["category_id"] is None
    sales = _by_name(client)["Sales"]
    project = _create_project(client, category_id=sales["id"])
    assert project["category_id"] == sales["id"]
    assert _by_name(client)["Sales"]["project_count"] == 1


def test_create_with_an_unknown_category_is_422_and_creates_nothing(env):
    client, _ = env
    resp = client.post(
        PROJECTS,
        json={
            "goal": "Ship it",
            "description": "The brief.",
            "host_profile": "default",
            "outputs": [{"title": "It"}],
            "category_id": "pcat_nope",
        },
    )
    assert resp.status_code == 422
    assert client.get(PROJECTS, params={"status": "planning"}).json()["items"] == []


def test_patch_sets_moves_and_clears_the_category(env):
    client, _ = env
    cats = _by_name(client)
    project = _create_project(client)
    url = f"{PROJECTS}/{project['slug']}"

    resp = client.patch(url, json={"category_id": cats["Sales"]["id"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["category_id"] == cats["Sales"]["id"]

    resp = client.patch(url, json={"category_id": cats["Research"]["id"]})
    assert resp.json()["category_id"] == cats["Research"]["id"]
    assert client.get(url).json()["category_id"] == cats["Research"]["id"]

    for clear in (None, ""):
        client.patch(url, json={"category_id": cats["Sales"]["id"]})
        resp = client.patch(url, json={"category_id": clear})
        assert resp.status_code == 200
        assert resp.json()["category_id"] is None


def test_patch_with_an_unknown_category_is_422_and_changes_nothing(env):
    client, _ = env
    sales = _by_name(client)["Sales"]
    project = _create_project(client, category_id=sales["id"])
    url = f"{PROJECTS}/{project['slug']}"
    resp = client.patch(url, json={"category_id": "pcat_nope", "name": "Renamed"})
    assert resp.status_code == 422
    fresh = client.get(url).json()
    assert fresh["category_id"] == sales["id"]
    assert fresh["name"] == project["name"]
    assert client.patch(url, json={"category_id": 5}).status_code == 422


def test_the_list_filters_by_category_before_paging(env):
    client, _ = env
    cats = _by_name(client)
    sales = [
        _create_project(client, category_id=cats["Sales"]["id"])["id"] for _ in range(3)
    ]
    loose = [_create_project(client)["id"] for _ in range(2)]
    research = _create_project(client, category_id=cats["Research"]["id"])["id"]

    def _ids(category, **params):
        seen, cursor = [], None
        while True:
            q = {"status": "planning", "category": category, "limit": 1, **params}
            if cursor:
                q["cursor"] = cursor
            body = client.get(PROJECTS, params=q).json()
            seen += [p["id"] for p in body["items"]]
            cursor = body["next_cursor"]
            if not cursor:
                return seen

    assert sorted(_ids(cats["Sales"]["id"])) == sorted(sales)
    assert sorted(_ids("none")) == sorted(loose)
    assert _ids(cats["Research"]["id"]) == [research]
    assert sorted(_ids(f"{cats['Sales']['id']},none")) == sorted(sales + loose)
    assert sorted(_ids(f"{cats['Research']['id']}, {cats['Sales']['id']}")) == sorted(
        sales + [research]
    )
    every = client.get(PROJECTS, params={"status": "planning"}).json()["items"]
    assert len(every) == 6
    assert all("category_id" in p for p in every)


# ---------------------------------------------------------------------------
# Store-level guarantees (the CLI goes through the same functions)
# ---------------------------------------------------------------------------


def test_the_store_validates_without_the_router(env):
    with projects_db.connect_closing() as conn:
        pid = projects_db.create_project(conn, name="Plain")
        with pytest.raises(ValueError):
            projects_db.set_project_category(conn, pid, "pcat_nope")
        with pytest.raises(ValueError):
            projects_db.create_project(conn, name="Other", category_id="pcat_nope")
        with pytest.raises(projects_db.CategoryNameTaken):
            projects_db.create_category(conn, name="SALES")
        with pytest.raises(ValueError):
            projects_db.create_category(conn, name="y" * 41)
        assert projects_db.get_project(conn, pid).category_id is None


def test_a_legacy_db_without_the_column_migrates_in_place(tmp_path):
    db = tmp_path / "legacy.db"
    raw = sqlite3.connect(db)
    raw.executescript(
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            description TEXT, created_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE project_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO projects (id, slug, name, created_at) VALUES ('p_old', 'old', 'Old', 1);
        """
    )
    raw.commit()
    raw.close()

    with projects_db.connect_closing(db) as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)")}
        assert "category_id" in cols
        old = projects_db.get_project(conn, "p_old")
        assert old is not None and old.category_id is None
        assert old.to_dict()["category_id"] is None
        cats = projects_db.list_categories(conn)
        assert [c["name"] for c in cats] == list(projects_db.DEFAULT_CATEGORY_NAMES)
        projects_db.set_project_category(conn, "p_old", cats[0]["id"])
        assert projects_db.get_project(conn, "p_old").category_id == cats[0]["id"]

    # Re-opening is a no-op: no duplicate column, no second seed.
    projects_db._INITIALIZED_PATHS.discard(str(db.resolve()))
    with projects_db.connect_closing(db) as conn:
        assert len(projects_db.list_categories(conn)) == len(
            projects_db.DEFAULT_CATEGORY_NAMES
        )


def test_the_dashboard_app_mounts_the_categories_router():
    from hermes_cli import web_server

    paths = {getattr(r, "path", None) for r in web_server.app.routes}
    assert CATS in paths
    assert f"{CATS}/{{category_id}}" in paths
