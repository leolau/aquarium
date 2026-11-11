"""The incomings HTTP surface, exercised without a database.

The routes are thin by design — parse, scope, delegate — so what is worth
pinning is exactly the thin part: that a box whose registry was never
initialised answers with an empty inbox instead of a 500, that filters reach
the registry in the shape it expects, that the limit is capped, and that an
invisible item is indistinguishable from a missing one.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import pytest
from fastapi import HTTPException

from hermes_cli import incomings_api
from hermes_cli.access import Principal
from hermes_cli.inbound_registry import InboundItem, InboundPage

PRINCIPAL = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]


def _item(**kwargs: Any) -> InboundItem:
    fields: dict[str, Any] = {
        "id": "11111111-1111-1111-1111-111111111111",
        "owner_user_id": "leo",
        "visibility": "private:leo",
        "surface": "email",
        "account_id": "leo@example.com",
        "external_id": "<abc@mail>",
        "kind": "message",
        "conversation": "thread-1",
        "conversation_name": None,
        "sender_id": "ada@example.com",
        "sender_name": "Ada",
        "subject": "Invoice 42",
        "body": "the tender is due friday",
        "occurred_at": datetime(2026, 8, 10, tzinfo=timezone.utc),
        "ends_at": None,
        "registered_at": None,
        "updated_at": None,
        "importance": None,
        "has_attachments": False,
        "metadata": {},
        "document_id": None,
        "remembered_at": None,
        "remembered_by": None,
    }
    fields.update(kwargs)
    return InboundItem(**fields)


class _Registry:
    """A registry stub that records how the route called it."""

    def __init__(self, *, exists: bool = True, items: Optional[list] = None) -> None:
        self.exists = exists
        self.items = items if items is not None else [_item()]
        self.calls: list[dict[str, Any]] = []

    async def table_exists(self) -> bool:
        return self.exists

    async def list(self, principal, **kwargs):
        self.calls.append(kwargs)
        return InboundPage(items=list(self.items), next_cursor="cur_2")

    async def get(self, principal, item_id):
        return next((i for i in self.items if str(i.id) == item_id), None)

    async def facets(self, principal):
        return {
            "surfaces": [{"value": "email", "count": 1}],
            "importance": [],
        }

    async def attachments(self, principal, item_id):
        return [{"id": "file_1", "filename": "deck.pdf", "byte_size": 10}]


class _Tags:
    async def for_entity(self, principal, kind, entity_id):
        return []

    async def list(self, principal, entity_kind=None):
        return []


@pytest.fixture
def wired(monkeypatch):
    registry = _Registry()
    monkeypatch.setattr(
        incomings_api, "_resolve_principal", lambda request: _async(PRINCIPAL)
    )
    monkeypatch.setattr(incomings_api, "_registry", lambda mode=None: registry)
    monkeypatch.setattr(incomings_api, "_tags", lambda mode=None: _Tags())
    monkeypatch.setattr(
        incomings_api, "_table_exists", lambda reg: _async(reg.exists)
    )
    return registry


async def _async(value):
    return value


@pytest.mark.asyncio
async def test_an_uninitialised_registry_is_an_empty_inbox(wired):
    # A box that has received nothing since the feature shipped has no table.
    # That is a new user, not a server error.
    wired.exists = False
    assert await incomings_api.list_incomings(request=None) == {
        "items": [],
        "next_cursor": None,
    }
    assert await incomings_api.incomings_facets(request=None) == {
        "surfaces": [],
        "importance": [],
        "tags": [],
    }


@pytest.mark.asyncio
async def test_filters_reach_the_registry_split_and_typed(wired):
    await incomings_api.list_incomings(
        request=None,
        q="invoice",
        surface="email, whatsapp",
        tag="finance,urgent",
        exclude_tag="spam",
        tag_match="ALL",
        remembered="true",
        has_attachments="1",
        since="2026-08-01T00:00:00Z",
    )
    call = wired.calls[-1]
    assert call["query"] == "invoice"
    assert call["surfaces"] == ["email", "whatsapp"]
    assert call["include_tags"] == ["finance", "urgent"]
    assert call["exclude_tags"] == ["spam"]
    assert call["tag_match"] == "all"
    assert call["remembered"] is True
    assert call["has_attachments"] is True
    assert call["since"] == datetime(2026, 8, 1, tzinfo=timezone.utc)
    # Absent tri-state flags stay absent: "not filtered" is not "false".
    assert call["until"] is None


@pytest.mark.asyncio
async def test_the_page_size_is_capped_and_never_zero(wired):
    await incomings_api.list_incomings(request=None, limit=10_000)
    assert wired.calls[-1]["limit"] == incomings_api._MAX_LIMIT
    await incomings_api.list_incomings(request=None, limit=0)
    assert wired.calls[-1]["limit"] == incomings_api._DEFAULT_LIMIT


@pytest.mark.asyncio
async def test_a_malformed_date_is_the_caller_s_error(wired):
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.list_incomings(request=None, since="yesterday")
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_the_page_carries_the_cursor_and_no_total(wired):
    page = await incomings_api.list_incomings(request=None)
    assert page["next_cursor"] == "cur_2"
    assert "total" not in page
    assert page["items"][0]["subject"] == "Invoice 42"
    assert page["items"][0]["tags"] == []


@pytest.mark.asyncio
async def test_detail_carries_attachments_and_tags(wired):
    payload = await incomings_api.get_incoming(
        request=None, item_id="11111111-1111-1111-1111-111111111111"
    )
    assert payload["attachments"][0]["filename"] == "deck.pdf"
    assert payload["tags"] == []


@pytest.mark.asyncio
async def test_somebody_else_s_arrival_is_simply_not_found(wired):
    # RLS filters it out, so `get` returns None — and a 403 here would confirm
    # the message exists.
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.get_incoming(request=None, item_id="not-mine")
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_remembering_an_empty_arrival_is_refused(wired, monkeypatch):
    wired.items = [_item(subject=None, body="")]
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.remember_incoming(
            request=None, item_id="11111111-1111-1111-1111-111111111111"
        )
    assert excinfo.value.status_code == 400


def test_flag_parses_the_tri_state():
    assert incomings_api._flag(None) is None
    assert incomings_api._flag("") is None
    assert incomings_api._flag("true") is True
    assert incomings_api._flag("no") is False


class _AttentionRegistry(_Registry):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.writes: list[tuple] = []

    async def attention_count(self, principal):
        return {"count": 3, "urgent": 1, "by_surface": {"email": 2, "calendar": 1}}

    async def clear_attention(self, principal, item_id, *, outcome):
        self.writes.append(("clear", item_id, outcome))
        return _item(
            attention_at=datetime(2026, 8, 10, tzinfo=timezone.utc),
            attention_reason="escalated",
            attention_cleared_at=datetime(2026, 8, 11, tzinfo=timezone.utc),
            attention_outcome=outcome,
        )

    async def reopen_attention(self, principal, item_id):
        self.writes.append(("reopen", item_id, None))
        return _item(
            attention_at=datetime(2026, 8, 10, tzinfo=timezone.utc),
            attention_reason="escalated",
        )


class _Todos:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def live_counts_by_source(self, principal, source_kind, refs):
        assert source_kind == "inbound"
        self.calls.append(list(refs))
        return {"11111111-1111-1111-1111-111111111111": 2}


class _Body:
    def __init__(self, body: Any = None, *, broken: bool = False) -> None:
        self.body = body
        self.broken = broken

    async def json(self):
        if self.broken:
            raise ValueError("not json")
        return self.body


ITEM_ID = "11111111-1111-1111-1111-111111111111"


@pytest.fixture
def attention(monkeypatch, wired):
    registry = _AttentionRegistry()
    todos = _Todos()
    monkeypatch.setattr(incomings_api, "_registry", lambda mode=None: registry)
    monkeypatch.setattr(
        incomings_api, "_resolve_write_principal", lambda request: _async(PRINCIPAL)
    )
    monkeypatch.setattr(incomings_api, "_todos", lambda mode=None: todos)
    registry.todos = todos
    return registry


@pytest.mark.asyncio
async def test_the_attention_filter_reaches_the_registry(attention):
    await incomings_api.list_incomings(request=None, attention="OPEN")
    assert attention.calls[-1]["attention"] == "open"
    await incomings_api.list_incomings(request=None)
    assert attention.calls[-1]["attention"] == "any"


@pytest.mark.asyncio
async def test_an_unknown_attention_filter_is_the_caller_s_error(attention):
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.list_incomings(request=None, attention="maybe")
    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_todo_counts_are_one_batched_read_per_page(attention):
    attention.items = [_item(), _item(id="22222222-2222-2222-2222-222222222222")]
    page = await incomings_api.list_incomings(request=None, attention="open")
    assert [i["todo_count"] for i in page["items"]] == [2, 0]
    assert len(attention.todos.calls) == 1
    assert len(attention.todos.calls[0]) == 2


@pytest.mark.asyncio
async def test_a_missing_todo_store_is_a_zero_not_a_500(attention, monkeypatch):
    def _broken(mode=None):
        raise RuntimeError("no tasks table")

    monkeypatch.setattr(incomings_api, "_todos", _broken)
    page = await incomings_api.list_incomings(request=None)
    assert page["items"][0]["todo_count"] == 0


@pytest.mark.asyncio
async def test_the_item_payload_carries_the_attention_fields(attention):
    attention.items = [
        _item(attention_at=datetime(2026, 8, 10, tzinfo=timezone.utc),
              attention_reason="todo", attention_priority="high")
    ]
    detail = await incomings_api.get_incoming(request=None, item_id=ITEM_ID)
    assert detail["attention_reason"] == "todo"
    assert detail["attention_priority"] == "high"
    assert detail["attention_cleared_at"] is None
    assert detail["attention_outcome"] is None
    assert detail["todo_count"] == 2


@pytest.mark.asyncio
async def test_attention_count_delegates_and_is_empty_before_the_table(attention):
    assert await incomings_api.incomings_attention_count(request=None) == {
        "count": 3,
        "urgent": 1,
        "by_surface": {"email": 2, "calendar": 1},
    }
    attention.exists = False
    assert await incomings_api.incomings_attention_count(request=None) == {
        "count": 0,
        "urgent": 0,
        "by_surface": {},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["done", "dismissed"])
async def test_clearing_records_the_outcome(attention, outcome):
    payload = await incomings_api.set_incoming_attention(
        request=_Body({"action": "clear", "outcome": outcome}), item_id=ITEM_ID
    )
    assert attention.writes == [("clear", ITEM_ID, outcome)]
    assert payload["attention_outcome"] == outcome
    assert payload["todo_count"] == 2


@pytest.mark.asyncio
async def test_reopening_needs_no_outcome(attention):
    payload = await incomings_api.set_incoming_attention(
        request=_Body({"action": "reopen"}), item_id=ITEM_ID
    )
    assert attention.writes == [("reopen", ITEM_ID, None)]
    assert payload["attention_cleared_at"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "request_body",
    [
        _Body(broken=True),
        _Body(["clear"]),
        _Body({}),
        _Body({"action": "snooze"}),
        _Body({"action": "clear"}),
        _Body({"action": "clear", "outcome": "later"}),
    ],
)
async def test_a_malformed_attention_write_is_a_400(attention, request_body):
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.set_incoming_attention(
            request=request_body, item_id=ITEM_ID
        )
    assert excinfo.value.status_code == 400
    assert attention.writes == []


@pytest.mark.asyncio
async def test_an_invisible_item_cannot_be_cleared(attention):
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.set_incoming_attention(
            request=_Body({"action": "reopen"}), item_id="not-a-uuid"
        )
    assert excinfo.value.status_code == 404
    attention.exists = False
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.set_incoming_attention(
            request=_Body({"action": "reopen"}), item_id=ITEM_ID
        )
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_a_reader_who_is_not_the_owner_cannot_clear(attention):
    # Visible through a grant or a role, but Done is the owner's decision.
    attention.items = [_item(owner_user_id="ada", visibility="private:ada")]
    with pytest.raises(HTTPException) as excinfo:
        await incomings_api.set_incoming_attention(
            request=_Body({"action": "clear", "outcome": "done"}), item_id=ITEM_ID
        )
    assert excinfo.value.status_code == 403
    assert attention.writes == []
