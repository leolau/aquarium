"""FG-33 P8-2 2.8: an app is linked to an FG-32 project through a
``project_links(kind='tool')`` pointer, a ``kind='code'`` output with
``link_kind='url'`` deliveries, and its ``mcp-la-<slug>`` project toolset."""

from __future__ import annotations

import asyncio

import pytest

from hermes_cli import projects_db as pdb
from hermes_cli import projects_links_apps as pla
from hermes_cli.access import Principal
from hermes_cli.projects_run import resolve_toolsets

OWNER = Principal(user_id="u-owner", display="u-owner", role="owner")
ADMIN = Principal(user_id="u-admin", display="u-admin", role="admin")
ALICE = Principal(user_id="u-alice", display="u-alice", role="member")
BOB = Principal(user_id="u-bob", display="u-bob", role="member")


def _app(name="todo", owner="u-alice", hosting="local", **extra):
    return {"name": name, "owner_user_id": owner, "hosting": hosting,
            "display_name": extra.pop("display_name", name.title()), **extra}


@pytest.fixture
def conn():
    with pdb.connect_closing() as c:
        yield c


@pytest.fixture
def project(conn):
    pid = pdb.create_project(conn, name="Shop", owner_user_id="u-lead")
    pdb.add_project_member(conn, project_id=pid, user_id="u-alice", role="member")
    pdb.add_project_member(conn, project_id=pid, user_id="u-bob", role="viewer")
    return pdb.get_project(conn, pid)


def _links(conn, project):
    return pdb.get_project_links(conn, project.id, kind="tool")


def test_link_writes_one_tool_pointer_idempotently(conn, project):
    first = pla.link_app(conn, project.slug, _app(), ALICE)
    again = pla.link_app(conn, project.slug, _app(), ALICE)

    assert first["linked"] is True and again["linked"] is False
    rows = _links(conn, project)
    assert [(r["kind"], r["ref"], r["added_by"]) for r in rows] == [("tool", "todo", "u-alice")]
    assert pla.linked_apps(conn, project.slug)[0]["app"] == "todo"
    assert pla.projects_for_app(conn, "todo") == [project.slug]


def test_toolset_name_follows_the_app_endpoint_prefix():
    assert pla.app_toolset_name("todo") == "mcp-la-todo"
    assert pla.app_toolset_name("todo", "external") == "mcp-xa-todo"
    with pytest.raises(ValueError):
        pla.app_toolset_name("Bad Slug")


def test_toolset_attached_only_to_a_narrowing_project(conn, project):
    # Empty toolsets = everything the host enables: adding one name would narrow it.
    pla.link_app(conn, project.slug, _app(), ALICE)
    assert not pdb.get_project(conn, project.id).toolsets

    pdb.update_project_fields(conn, project.id, {"toolsets": "web,terminal"})
    res = pla.link_app(conn, project.slug, _app(), ALICE)
    pla.link_app(conn, project.slug, _app(), ALICE)
    toolsets = pdb.get_project(conn, project.id).toolsets.split(",")
    assert res["toolset_attached"] is True
    assert toolsets == ["web", "terminal", "mcp-la-todo"]

    # Still a narrowing filter: the app toolset is never granted beyond the host.
    effective, dropped = resolve_toolsets(toolsets, ["web", "terminal"])
    assert effective == ["web", "terminal"] and dropped == ["mcp-la-todo"]


def test_unlink_removes_pointer_and_toolset_but_never_widens(conn, project):
    pdb.update_project_fields(conn, project.id, {"toolsets": "web"})
    pla.link_app(conn, project.slug, _app(), ALICE)
    res = pla.unlink_app(conn, project.slug, "todo", ALICE)
    assert res["unlinked"] is True and _links(conn, project) == []
    assert pdb.get_project(conn, project.id).toolsets == "web"

    pdb.update_project_fields(conn, project.id, {"toolsets": "mcp-la-todo"})
    pla.unlink_app(conn, project.slug, "todo", ALICE)
    assert pdb.get_project(conn, project.id).toolsets == "mcp-la-todo"


@pytest.mark.parametrize("who", [BOB, Principal(user_id="u-stranger", display="u-stranger", role="member")])
def test_viewer_or_non_member_cannot_link(conn, project, who):
    with pytest.raises(pla.LinkRefused):
        pla.link_app(conn, project.slug, _app(owner=who.user_id), who)
    assert _links(conn, project) == []


def test_member_cannot_link_someone_elses_app_but_admin_can(conn, project):
    with pytest.raises(pla.LinkRefused):
        pla.link_app(conn, project.slug, _app(owner="u-carol"), ALICE)
    assert pla.link_app(conn, project.slug, _app(owner="u-carol"), ADMIN)["linked"]
    assert pla.link_app(conn, project.slug, _app("notes", owner="u-carol"), OWNER)["linked"]


def test_non_app_tool_and_missing_project_are_refused(conn, project):
    with pytest.raises(ValueError):
        pla.link_app(conn, project.slug, _app(hosting=None), ALICE)
    with pytest.raises(LookupError):
        pla.link_app(conn, "no-such-project", _app(), ALICE)


def test_deliver_records_url_on_one_code_output_per_app(conn, project):
    prod = pla.deliver_app(conn, project.slug, _app(release_sha="abc123"), ALICE)
    dev = pla.deliver_app(conn, project.slug, _app(), ALICE, mode="dev")
    other = pla.deliver_app(conn, project.slug, _app("notes"), ALICE)

    assert prod["output_id"] == dev["output_id"] != other["output_id"]
    outputs = {o["id"]: o for o in pdb.get_project_outputs(conn, project.id)}
    assert outputs[prod["output_id"]]["kind"] == "code"
    assert outputs[prod["output_id"]]["status"] == "delivered"
    deliveries = pdb.get_output_deliveries(conn, output_id=prod["output_id"])
    assert {(d["link_kind"], d["link_ref"]) for d in deliveries} == {
        ("url", "/apps/todo/"), ("url", "/apps-dev/todo/"),
    }
    assert any("abc123" in (d["note"] or "") for d in deliveries)
    assert _links(conn, project)  # delivering links the app


def test_deliver_reuses_a_declared_code_output(conn, project):
    oid = pdb.add_project_output(conn, project_id=project.id, title="Booking app", kind="code")
    res = pla.deliver_app(conn, project.slug, _app(), ALICE, output_id=oid)
    assert res["output_id"] == oid
    again = pla.deliver_app(conn, project.slug, _app(), ALICE)
    assert again["output_id"] == oid
    report = pdb.add_project_output(conn, project_id=project.id, title="R", kind="report")
    with pytest.raises(ValueError):
        pla.deliver_app(conn, project.slug, _app(), ALICE, output_id=report)


def test_external_app_delivers_its_public_url(conn, project):
    app = _app(hosting="external", public_url="https://todo.example.com")
    res = pla.deliver_app(conn, project.slug, app, ALICE)
    assert res["url"] == "https://todo.example.com"
    assert res["toolset"] == "mcp-xa-todo"
    with pytest.raises(ValueError):
        pla.deliver_app(conn, project.slug, _app(hosting="external"), ALICE)
    with pytest.raises(ValueError):
        pla.app_url("todo", public_url="javascript:alert(1)")


def test_deliver_refused_on_archived_project(conn, project):
    pdb.archive_project(conn, project.id)
    with pytest.raises(pla.LinkRefused):
        pla.deliver_app(conn, project.slug, _app(), ALICE)
    assert pdb.get_project_outputs(conn, project.id) == []


class _FakeConn:
    def __init__(self, row):
        self.row, self.updates, self.closed = row, [], False

    async def fetchrow(self, sql, *args):
        return self.row

    async def execute(self, sql, *args):
        self.updates.append(args)

    async def close(self):
        self.closed = True


class _FakeRegistry:
    def __init__(self, conn):
        self.conn = conn

    async def _connect(self):
        return self.conn


def _row(owner):
    from hermes_cli.tools_registry import _COLUMN_NAMES

    row = {c: None for c in _COLUMN_NAMES}
    row.update(name="todo", owner_user_id=owner, kind="mcp", status="enabled",
               visibility="private", config_json={}, hosting="local")
    return row


def test_mirror_project_slug_respects_app_ownership(monkeypatch):
    import hermes_cli.tools_registry as tr

    monkeypatch.setattr(tr, "_row_to_tool", lambda r: r)
    mine = _FakeConn(_row("u-alice"))
    assert asyncio.run(pla.mirror_project_slug(_FakeRegistry(mine), ALICE, "todo", "shop"))
    assert mine.updates == [("todo", "shop")] and mine.closed

    theirs = _FakeConn(_row("u-carol"))
    with pytest.raises(pla.LinkRefused):
        asyncio.run(pla.mirror_project_slug(_FakeRegistry(theirs), ALICE, "todo", "shop"))
    assert theirs.updates == [] and theirs.closed

    missing = _FakeConn(None)
    assert not asyncio.run(pla.mirror_project_slug(_FakeRegistry(missing), ALICE, "todo", None))
