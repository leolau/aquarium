"""Short refs for to-dos (``D88``) and inbox messages (``M512``) — FG-36 PR 3.

Contracts: both kinds are numbered box-wide in creation order across every
profile, each row records the profile it lives in, the stores number a row
when they create it, every to-do / inbox payload carries its ref, a ref typed
into either search box finds exactly that item, and ``/api/refs/{ref}``
answers only what the caller may read through that store **in the ref's
profile** — anything else is the same 404 as a ref that names nothing.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hermes_cli import (
    incomings_api,
    inbound_registry,
    profile_refs,
    projects_api,
    refs_api,
    short_refs,
    todo_store,
    todos_api,
)
from hermes_cli.access import Principal
from hermes_cli.inbound_registry import InboundItem, InboundPage, InboundRegistry
from hermes_cli.todo_store import Todo, TodoStore

OWNER = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
ADA = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
EVE = Principal(user_id="eve", display="Eve", role="member")  # type: ignore[arg-type]

U = "00000000-0000-0000-0000-{:012d}".format


def _ts(seconds: int) -> datetime:
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def _todo(todo_id: str, owner: str = "leo", created: int = 100, **kw: Any) -> Todo:
    fields: dict[str, Any] = dict(
        id=todo_id,
        owner_user_id=owner,
        visibility=f"private:{owner}",
        title=f"to-do {todo_id[-2:]}",
        description="",
        stage="open",
        status="pending",
        priority="normal",
        origin="explicit",
        current_state="captured",
        trigger_state="captured",
        completion_state="done",
        created_at=_ts(created),
    )
    fields.update(kw)
    return Todo(**fields)


def _item(item_id: str, owner: str = "leo", created: int = 100, **kw: Any) -> InboundItem:
    fields: dict[str, Any] = dict(
        id=item_id,
        owner_user_id=owner,
        visibility=f"private:{owner}",
        surface="email",
        account_id="",
        external_id=f"<{item_id}>",
        kind="message",
        conversation=None,
        conversation_name=None,
        sender_id="ada@example.com",
        sender_name="Ada",
        subject=f"mail {item_id[-2:]}",
        body="",
        occurred_at=_ts(created),
        ends_at=None,
        registered_at=_ts(created),
        updated_at=None,
        importance=None,
        has_attachments=False,
        metadata={},
        document_id=None,
        remembered_at=None,
        remembered_by=None,
    )
    fields.update(kw)
    return InboundItem(**fields)


def _visible(principal, owner: str) -> bool:
    return principal.is_owner or principal.user_id == owner


class _World:
    """Two profiles' to-dos, inbox items and enrolments."""

    def __init__(self) -> None:
        self.todos: dict[str, dict[str, Todo]] = {"default": {}, "hr": {}}
        self.items: dict[str, dict[str, InboundItem]] = {"default": {}, "hr": {}}
        #: profile -> identity -> principal
        self.enrolled: dict[str, dict[str, Principal]] = {
            "default": {"leo": OWNER, "ada": ADA, "eve": EVE},
            "hr": {},
        }


class _TodoStoreStub:
    def __init__(self, world: _World) -> None:
        self.rows = world.todos[profile_refs.current_profile()]

    async def get(self, principal, todo_id):
        todo = self.rows.get(todo_id)
        return todo if todo and _visible(principal, todo.owner_user_id) else None


class _RegistryStub:
    def __init__(self, world: _World) -> None:
        self.rows = world.items[profile_refs.current_profile()]

    async def get(self, principal, item_id):
        item = self.rows.get(item_id)
        return item if item and _visible(principal, item.owner_user_id) else None


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(tmp_path / "projects.db"))
    default_home = tmp_path / "home"
    hr_home = tmp_path / "home" / "profiles" / "hr"
    hr_home.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setattr(
        profile_refs, "_profile_homes", lambda: [("default", default_home), ("hr", hr_home)]
    )
    w = _World()

    async def _rows(kind):
        profile = profile_refs.current_profile()
        if kind == "D":
            return [(t.id, t.created_at) for t in w.todos[profile].values()]
        return [(i.id, i.registered_at) for i in w.items[profile].values()]

    async def _principal_here(identity):
        return w.enrolled[profile_refs.current_profile()].get(identity)

    monkeypatch.setattr(profile_refs, "_profile_rows", _rows)
    monkeypatch.setattr(profile_refs, "_principal_here", _principal_here)
    monkeypatch.setattr(todo_store, "default_store", lambda mode=None: _TodoStoreStub(w))
    monkeypatch.setattr(
        inbound_registry, "default_registry", lambda mode=None: _RegistryStub(w)
    )
    return w


# ---------------------------------------------------------------------------
# Backfill and assignment
# ---------------------------------------------------------------------------


def test_backfill_numbers_every_profile_s_rows_oldest_first(world):
    world.todos["default"][U(1)] = _todo(U(1), created=300)
    world.todos["default"][U(2)] = _todo(U(2), created=100)
    world.todos["hr"][U(3)] = _todo(U(3), created=200)
    world.items["hr"][U(4)] = _item(U(4), created=50)

    assert short_refs.backfill("D") == 3
    refs = short_refs.ensure_refs(
        "D",
        [
            short_refs.RefItem(U(1), profile="default"),
            short_refs.RefItem(U(2), profile="default"),
            short_refs.RefItem(U(3), profile="hr"),
        ],
    )
    assert refs == {U(2): "D1", U(3): "D2", U(1): "D3"}
    assert short_refs.lookup("d2").profile == "hr"
    assert short_refs.lookup("M1").internal_id == U(4)
    assert short_refs.lookup("M1").profile == "hr"
    assert short_refs.backfill("D") == 0  # once per kind


class _Conn:
    """Just enough asyncpg for ``create`` / ``register``."""

    def __init__(self, row: dict[str, Any]) -> None:
        self.row = row

    def transaction(self):
        class _Tx:
            async def __aenter__(self):
                return None

            async def __aexit__(self, *exc):
                return False

        return _Tx()

    async def fetchrow(self, sql, *args):
        return self.row

    async def execute(self, *args):
        return None

    async def executemany(self, *args):
        return None

    async def close(self):
        return None


class _AppStore:
    mode = "prod"

    def __init__(self, conn: _Conn) -> None:
        self.conn = conn

    async def connect(self):
        return self.conn


def _todo_row(todo_id: str, *, inserted: bool) -> dict[str, Any]:
    row = {
        k: v
        for k, v in vars(_todo(todo_id, created=500)).items()
        if k != "created"
    }
    row["inserted"] = inserted
    return row


@pytest.mark.asyncio
async def test_a_new_todo_is_numbered_at_create_after_the_existing_ones(world):
    world.todos["default"][U(1)] = _todo(U(1), created=100)
    store = TodoStore(_AppStore(_Conn(_todo_row(U(9), inserted=True))))
    todo = await store.create(OWNER, title="Call Ada")
    assert todo.id == U(9)
    assert short_refs.lookup("D1").internal_id == U(1)
    record = short_refs.lookup("D2")
    assert (record.internal_id, record.profile) == (U(9), "default")


@pytest.mark.asyncio
async def test_a_collapsed_duplicate_gets_no_second_number(world):
    store = TodoStore(_AppStore(_Conn(_todo_row(U(9), inserted=False))))
    await store.create(OWNER, title="Call Ada", source_kind="inbound")
    assert short_refs.lookup("D1") is None


@pytest.mark.asyncio
async def test_an_arrival_is_numbered_once_however_often_it_is_re_seen(world):
    row = dict(vars(_item(U(7), created=900)))
    registry = InboundRegistry(_AppStore(_Conn(row)))
    for _ in range(3):
        await registry.register(OWNER, surface="email", external_id="<x>")
    record = short_refs.lookup("M1")
    assert (record.internal_id, record.profile) == (U(7), "default")
    assert short_refs.lookup("M2") is None


# ---------------------------------------------------------------------------
# Payloads and search
# ---------------------------------------------------------------------------


async def _async(value):
    return value


class _ListStore:
    def __init__(self, todos: list[Todo]) -> None:
        self.todos = {t.id: t for t in todos}
        self.listed = 0

    async def initialize(self, **kw):
        return None

    async def list(self, principal, **kw):
        self.listed += 1
        return list(self.todos.values()), None

    async def get(self, principal, todo_id):
        return self.todos.get(todo_id)

    async def history(self, principal, todo_id):
        return []

    async def create(self, principal, **kw):
        todo = _todo(U(5), created=999, title=kw["title"])
        self.todos[todo.id] = todo
        await profile_refs.assign("D", todo.id, todo.created_at)
        return todo


@pytest.fixture
def todo_routes(world, monkeypatch):
    world.todos["default"][U(1)] = _todo(U(1), created=100)
    world.todos["default"][U(2)] = _todo(U(2), created=200)
    world.todos["hr"][U(3)] = _todo(U(3), created=150)
    store = _ListStore([world.todos["default"][U(1)], world.todos["default"][U(2)]])
    monkeypatch.setattr(todos_api, "_resolve_principal", lambda request: _async(OWNER))
    monkeypatch.setattr(todos_api, "_store", lambda mode=None: store)
    monkeypatch.setattr(todos_api, "_table_ready", lambda s: _async(True))
    monkeypatch.setattr(todos_api, "_source_item", lambda p, t: _async(None))
    return store


@pytest.mark.asyncio
async def test_todo_list_detail_and_create_payloads_carry_refs(todo_routes):
    page = await todos_api.list_todos(request=None)
    assert {i["id"]: i["ref"] for i in page["items"]} == {U(1): "D1", U(2): "D3"}
    detail = await todos_api.get_todo(request=None, todo_id=U(2))
    assert detail["ref"] == "D3" and detail["id"] == U(2)

    class _Req:
        async def json(self):
            return {"title": "Call Ada"}

    created = await todos_api.create_todo(_Req())
    assert created["ref"] == "D4"


@pytest.mark.asyncio
async def test_a_todo_ref_in_search_finds_exactly_that_todo(todo_routes):
    for q in ("D3", "d3", " D3 "):
        page = await todos_api.list_todos(request=None, q=q)
        assert [i["id"] for i in page["items"]] == [U(2)], q
        assert page["next_cursor"] is None
    assert todo_routes.listed == 0
    # D2 lives in another profile; D99 names nothing: both find nothing here.
    for q in ("D2", "D99"):
        assert (await todos_api.list_todos(request=None, q=q))["items"] == []
    # Other kinds and plain words are ordinary searches.
    await todos_api.list_todos(request=None, q="M1")
    assert todo_routes.listed == 1


class _Tags:
    async def for_entity(self, principal, kind, entity_id):
        return []


class _InboxRegistry:
    def __init__(self, items: list[InboundItem]) -> None:
        self.items = {i.id: i for i in items}
        self.listed = 0

    async def list(self, principal, **kw):
        self.listed += 1
        return InboundPage(items=list(self.items.values()), next_cursor="c")

    async def get(self, principal, item_id):
        return self.items.get(item_id)

    async def attachments(self, principal, item_id):
        return []


@pytest.fixture
def inbox_routes(world, monkeypatch):
    world.items["default"][U(1)] = _item(U(1), created=100)
    world.items["hr"][U(2)] = _item(U(2), created=200)
    registry = _InboxRegistry([world.items["default"][U(1)]])
    monkeypatch.setattr(incomings_api, "_resolve_principal", lambda request: _async(OWNER))
    monkeypatch.setattr(incomings_api, "_registry", lambda mode=None: registry)
    monkeypatch.setattr(incomings_api, "_tags", lambda mode=None: _Tags())
    monkeypatch.setattr(incomings_api, "_table_exists", lambda reg: _async(True))
    return registry


@pytest.mark.asyncio
async def test_inbox_list_detail_and_search_carry_and_accept_refs(inbox_routes):
    page = await incomings_api.list_incomings(request=None)
    assert [(i["id"], i["ref"]) for i in page["items"]] == [(U(1), "M1")]
    detail = await incomings_api.get_incoming(request=None, item_id=U(1))
    assert detail["ref"] == "M1"
    found = await incomings_api.list_incomings(request=None, q="m1")
    assert [i["id"] for i in found["items"]] == [U(1)]
    assert found["items"][0]["tags"] == []
    assert (await incomings_api.list_incomings(request=None, q="M2"))["items"] == []
    assert inbox_routes.listed == 1


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


@pytest.fixture
def resolver(world, monkeypatch):
    world.todos["default"][U(1)] = _todo(U(1), owner="ada", created=100)
    world.todos["hr"][U(2)] = _todo(U(2), owner="leo", created=200)
    world.items["default"][U(3)] = _item(U(3), owner="ada", created=100)
    state: dict[str, Any] = {"actor": OWNER, "subject": ""}

    async def _principal(request):
        return state["actor"]

    async def _enrolled(user_id):
        return set()

    async def _subject(request):
        return state["subject"]

    monkeypatch.setattr(projects_api, "_principal_read", _principal)
    monkeypatch.setattr(projects_api, "_enrolled_profiles", _enrolled)
    monkeypatch.setattr(projects_api, "_interactive_subject", _subject)
    app = FastAPI()
    app.include_router(refs_api.router)
    return TestClient(app), state


def test_resolves_a_todo_and_a_message_for_a_reader(resolver):
    client, state = resolver
    state["actor"] = ADA
    todo = client.get("/api/refs/d1").json()
    assert todo == {
        "ref": "D1",
        "kind": "todo",
        "id": U(1),
        "title": "to-do 01",
        "status": "open",
        "url": f"/todos/{U(1)}",
        "profile": "default",
    }
    msg = client.get("/api/refs/M1").json()
    assert (msg["kind"], msg["id"], msg["title"]) == ("message", U(3), "mail 03")
    assert msg["url"] == f"/inbox/{U(3)}" and msg["profile"] == "default"


def test_an_item_the_caller_cannot_see_is_404_like_a_missing_one(resolver):
    client, state = resolver
    state["actor"] = EVE
    missing = client.get("/api/refs/D99")
    assert missing.status_code == 404
    for ref in ("D1", "M1"):
        resp = client.get(f"/api/refs/{ref}")
        assert resp.status_code == 404, ref
        assert resp.json() == missing.json()


def test_another_profile_s_item_needs_an_enrolment_there(resolver, world):
    client, state = resolver
    # D2 is Leo's to-do in `hr`. Owning `default` grants nothing in `hr`.
    assert client.get("/api/refs/D2").status_code == 404
    world.enrolled["hr"]["leo"] = OWNER
    body = client.get("/api/refs/D2").json()
    assert (body["id"], body["profile"]) == (U(2), "hr")
    # A verified login subject is what gets re-resolved there.
    state["subject"] = "sub-leo"
    assert client.get("/api/refs/D2").status_code == 404
    world.enrolled["hr"]["sub-leo"] = OWNER
    assert client.get("/api/refs/D2").status_code == 200
    # A suspended or absent enrolment there is the same 404.
    del world.enrolled["hr"]["sub-leo"]
    assert client.get("/api/refs/D2").status_code == 404


def test_cli_resolves_a_todo_and_names_its_profile(resolver, monkeypatch, capsys):
    from hermes_cli import projects_cli, ref_cli

    client, _ = resolver

    async def _actor(actor):
        return OWNER

    monkeypatch.setattr(projects_cli, "_resolve_principal", _actor)
    api_body = client.get("/api/refs/D1").json()
    assert ref_cli.ref_command(argparse.Namespace(ref="d1", actor=None, json=True)) == 0
    assert json.loads(capsys.readouterr().out) == api_body
    assert ref_cli.ref_command(argparse.Namespace(ref="D1", actor=None, json=False)) == 0
    out = capsys.readouterr().out
    assert "D1" in out and "todo" in out and f"/todos/{U(1)}" in out
    assert "profile: default" in out


def test_current_profile_names_the_scoped_home(world, tmp_path):
    from hermes_cli.console_scope import _scoped_to

    assert profile_refs.current_profile() == "default"
    with _scoped_to(Path(tmp_path / "home" / "profiles" / "hr")):
        assert profile_refs.current_profile() == "hr"
