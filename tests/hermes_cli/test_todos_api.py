"""The to-dos HTTP surface, exercised without a database.

The routes are thin by design — parse, scope, delegate — so what is worth
pinning is the thin part: that a box which has not run the migration answers
with an empty page instead of a 500, that a snooze stays hidden unless asked
for, that every lifecycle move is attributed to the acting principal, and that
somebody else's to-do is indistinguishable from a missing one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import pytest
from fastapi import HTTPException

from hermes_cli import todos_api
from hermes_cli.access import Principal
from hermes_cli.todo_store import Todo, TodoError

PRINCIPAL = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]


def _todo(**kwargs: Any) -> Todo:
    fields: dict[str, Any] = {
        "id": "tsk_1",
        "owner_user_id": "leo",
        "visibility": "private:leo",
        "title": "Send Ada the signed quote",
        "description": "Before the tender closes.",
        "stage": "open",
        "status": "pending",
        "priority": "high",
        "origin": "triage",
        "current_state": "captured",
        "trigger_state": "captured",
        "completion_state": "done",
        "source_kind": "inbound",
        "source_ref": "11111111-1111-1111-1111-111111111111",
    }
    fields.update(kwargs)
    return Todo(**fields)


class _Store:
    """A store stub that records how the route called it."""

    def __init__(self, *, ready: bool = True, items: Optional[list] = None) -> None:
        self.ready = ready
        self.items = items if items is not None else [_todo()]
        self.calls: list[dict[str, Any]] = []
        self.raises: Optional[Exception] = None

    async def initialize(self, **kwargs):
        return None

    async def list(self, principal, **kwargs):
        self.calls.append({"op": "list", **kwargs})
        return list(self.items), "cur_2"

    async def facets(self, principal, **kwargs):
        return {
            "stages": [{"value": "open", "count": 1}],
            "priorities": [],
            "source_kinds": [],
        }

    async def get(self, principal, todo_id, **kwargs):
        return next((t for t in self.items if t.id == todo_id), None)

    async def history(self, principal, todo_id, **kwargs):
        return [
            {
                "from": "stage:staged",
                "to": "stage:open",
                "at": "2026-08-11T09:00:00+00:00",
                "actor": "skill:email-triage",
            }
        ]

    async def create(self, principal, **kwargs):
        self.calls.append({"op": "create", **kwargs})
        if self.raises:
            raise self.raises
        return _todo(**{k: v for k, v in kwargs.items() if k in _TODO_FIELDS})

    async def update(self, principal, todo_id, **kwargs):
        self.calls.append({"op": "update", "id": todo_id, **kwargs})
        if self.raises:
            raise self.raises
        return self.items[0]

    async def set_stage(self, principal, todo_id, stage, **kwargs):
        self.calls.append({"op": "stage", "id": todo_id, "stage": stage, **kwargs})
        if self.raises:
            raise self.raises
        return _todo(stage=stage)

    async def snooze(self, principal, todo_id, until, **kwargs):
        self.calls.append({"op": "snooze", "id": todo_id, "until": until, **kwargs})
        return _todo(snoozed_until=until)

    async def unsnooze(self, principal, todo_id, **kwargs):
        self.calls.append({"op": "unsnooze", "id": todo_id, **kwargs})
        return _todo(snoozed_until=kwargs.get("until"))


_TODO_FIELDS = {
    "title",
    "description",
    "stage",
    "priority",
    "due_at",
    "source_kind",
    "source_ref",
    "source_note",
    "origin",
}


async def _async(value):
    return value


@pytest.fixture
def wired(monkeypatch):
    store = _Store()
    monkeypatch.setattr(
        todos_api, "_resolve_principal", lambda request: _async(PRINCIPAL)
    )
    monkeypatch.setattr(todos_api, "_store", lambda mode=None: store)
    monkeypatch.setattr(todos_api, "_table_ready", lambda s: _async(s.ready))
    monkeypatch.setattr(todos_api, "_source_item", lambda p, t: _async(None))
    return store


def _request(body: dict):
    class _Req:
        async def json(self):
            return body

    return _Req()


@pytest.mark.asyncio
async def test_a_box_without_the_migration_has_an_empty_page(wired):
    # The tasks table predates this feature, so "no stage column" means the
    # user has no to-dos yet — a new page, not a broken one.
    wired.ready = False
    assert await todos_api.list_todos(request=None) == {
        "items": [],
        "next_cursor": None,
    }
    assert await todos_api.todos_facets(request=None) == {
        "stages": [],
        "priorities": [],
        "source_kinds": [],
    }


@pytest.mark.asyncio
async def test_filters_reach_the_store_split_and_typed(wired):
    await todos_api.list_todos(
        request=None,
        q="quote",
        stage="staged, open",
        priority="high",
        source_kind="inbound",
        due_before="2026-08-14T00:00:00Z",
    )
    call = wired.calls[-1]
    assert call["query"] == "quote"
    assert call["stages"] == ["staged", "open"]
    assert call["priorities"] == ["high"]
    assert call["source_kinds"] == ["inbound"]
    assert call["due_before"] == datetime(2026, 8, 14, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_a_snooze_is_honoured_unless_the_caller_opts_out(wired):
    """A snooze the list ignores is not a snooze."""
    await todos_api.list_todos(request=None)
    assert wired.calls[-1]["include_snoozed"] is False
    await todos_api.list_todos(request=None, include_snoozed="true")
    assert wired.calls[-1]["include_snoozed"] is True


@pytest.mark.asyncio
async def test_the_page_size_is_capped_and_never_zero(wired):
    await todos_api.list_todos(request=None, limit=10_000)
    assert wired.calls[-1]["limit"] == todos_api._MAX_LIMIT
    await todos_api.list_todos(request=None, limit=0)
    assert wired.calls[-1]["limit"] == todos_api._DEFAULT_LIMIT


@pytest.mark.asyncio
async def test_a_malformed_date_is_the_caller_s_error(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.list_todos(request=None, due_before="friday")
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_the_page_carries_the_cursor_and_no_total(wired):
    page = await todos_api.list_todos(request=None)
    assert page["next_cursor"] == "cur_2"
    assert "total" not in page
    assert page["items"][0]["title"] == "Send Ada the signed quote"


@pytest.mark.asyncio
async def test_detail_answers_why_this_is_here(wired):
    payload = await todos_api.get_todo(request=None, todo_id="tsk_1")
    assert payload["history"][0]["actor"] == "skill:email-triage"
    assert "source" in payload


@pytest.mark.asyncio
async def test_somebody_else_s_todo_is_simply_not_found(wired):
    # RLS filters it out, so `get` returns None — a 403 would confirm it exists.
    for call in (
        todos_api.get_todo(request=None, todo_id="not-mine"),
        todos_api.update_todo(request=_request({"title": "x"}), todo_id="not-mine"),
        todos_api.set_todo_stage(
            request=_request({"stage": "done"}), todo_id="not-mine"
        ),
        todos_api.snooze_todo(
            request=_request({"until": "2026-08-20T09:00:00Z"}), todo_id="not-mine"
        ),
        todos_api.unsnooze_todo(request=_request({}), todo_id="not-mine"),
    ):
        with pytest.raises(HTTPException) as excinfo:
            await call
        assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_a_user_written_todo_is_open_and_never_deduped(wired):
    """The user asking twice means they want it twice; triage seeing the same
    message twice does not."""
    await todos_api.create_todo(request=_request({"title": "  Call the bank  "}))
    call = wired.calls[-1]
    assert call["title"] == "Call the bank"
    assert call["stage"] == "open"
    assert call["origin"] == "explicit"
    assert call["source_kind"] == "user"
    assert call["actor"] == "user:leo"


@pytest.mark.asyncio
async def test_a_todo_needs_a_title(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.create_todo(request=_request({"description": "no title"}))
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_an_unknown_priority_is_the_caller_s_error(wired):
    wired.raises = TodoError("Unknown to-do priority: 'urgent'")
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.create_todo(
            request=_request({"title": "x", "priority": "urgent"})
        )
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_every_lifecycle_move_names_who_made_it(wired):
    await todos_api.set_todo_stage(
        request=_request({"stage": "done", "outcome": "sent the quote"}),
        todo_id="tsk_1",
    )
    call = wired.calls[-1]
    assert (call["stage"], call["outcome"]) == ("done", "sent the quote")
    assert call["actor"] == "user:leo"


@pytest.mark.asyncio
async def test_a_stage_move_needs_a_stage(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.set_todo_stage(request=_request({}), todo_id="tsk_1")
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_an_unknown_stage_is_rejected_not_stored(wired):
    wired.raises = TodoError("Unknown to-do stage: 'later'")
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.set_todo_stage(
            request=_request({"stage": "later"}), todo_id="tsk_1"
        )
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_a_snooze_needs_an_end_time(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.snooze_todo(request=_request({}), todo_id="tsk_1")
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_a_snooze_carries_the_moment_it_ends(wired):
    await todos_api.snooze_todo(
        request=_request({"until": "2026-08-20T09:00:00Z"}), todo_id="tsk_1"
    )
    call = wired.calls[-1]
    assert call["until"] == datetime(2026, 8, 20, 9, 0, tzinfo=timezone.utc)
    assert call["actor"] == "user:leo"


@pytest.mark.asyncio
async def test_unsnooze_with_no_body_wakes_the_todo_now(wired):
    payload = await todos_api.unsnooze_todo(request=_request({}), todo_id="tsk_1")
    call = wired.calls[-1]
    assert call["op"] == "unsnooze"
    assert (call["until"], call["notified_at"]) == (None, None)
    assert call["actor"] == "user:leo"
    assert payload["snoozed_until"] is None


@pytest.mark.asyncio
async def test_undo_puts_back_the_snooze_and_stamp_it_replaced(wired):
    """Undo restores what the snooze overwrote, so nothing is re-announced."""
    await todos_api.unsnooze_todo(
        request=_request(
            {"until": "2026-08-18T09:00:00Z", "notified_at": "2026-08-11T09:00:00Z"}
        ),
        todo_id="tsk_1",
    )
    call = wired.calls[-1]
    assert call["until"] == datetime(2026, 8, 18, 9, 0, tzinfo=timezone.utc)
    assert call["notified_at"] == datetime(2026, 8, 11, 9, 0, tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_unsnooze_refuses_a_notification_that_has_not_happened(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.unsnooze_todo(
            request=_request({"notified_at": "2999-01-01T00:00:00Z"}),
            todo_id="tsk_1",
        )
    assert excinfo.value.status_code == 400
    assert not [c for c in wired.calls if c["op"] == "unsnooze"]


@pytest.mark.asyncio
async def test_unsnooze_rejects_a_malformed_time(wired):
    with pytest.raises(HTTPException) as excinfo:
        await todos_api.unsnooze_todo(
            request=_request({"until": "next tuesday"}), todo_id="tsk_1"
        )
    assert excinfo.value.status_code == 400
