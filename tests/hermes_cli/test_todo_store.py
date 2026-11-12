"""Unit tests for the to-do store's pure helpers.

The Postgres behaviour lives in ``test_todo_store_e2e.py``; these cover the
decisions that are made before a query is built — de-duplication identity,
the stage/status coupling, and cursor round-tripping.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from hermes_cli.todo_store import (
    LIVE_STAGES,
    STAGE_STATUS,
    TODO_STAGES,
    Todo,
    TodoError,
    compute_dedupe_key,
    decode_cursor,
    encode_cursor,
    normalize_title,
    validate_priority,
    validate_source_kind,
    validate_stage,
)


def _todo(**kwargs) -> Todo:
    fields = {
        "id": "8a8b2f4e-0000-4000-8000-000000000001",
        "owner_user_id": "leo",
        "visibility": "private:leo",
        "title": "Send the signed quote",
        "description": "",
        "stage": "open",
        "status": "pending",
        "priority": "normal",
        "origin": "triage",
        "current_state": "captured",
        "trigger_state": "captured",
        "completion_state": "done",
    }
    fields.update(kwargs)
    return Todo(**fields)


def test_every_stage_maps_to_a_status() -> None:
    """The two vocabularies are written together, so neither may have a hole."""
    assert set(STAGE_STATUS) == set(TODO_STAGES)
    assert set(STAGE_STATUS.values()) <= {
        "pending",
        "in_progress",
        "completed",
        "cancelled",
    }


def test_only_live_stages_are_deduplicated() -> None:
    assert set(LIVE_STAGES) == {"staged", "open", "working", "review"}
    assert "done" not in LIVE_STAGES
    assert "dismissed" not in LIVE_STAGES


def test_normalize_title_collapses_whitespace_and_case() -> None:
    assert normalize_title("  Send   the\nQUOTE ") == "send the quote"


def test_dedupe_key_is_stable_across_cosmetic_title_changes() -> None:
    first = compute_dedupe_key(
        "leo", source_kind="inbound", source_ref="item-1", title="Send  the quote"
    )
    second = compute_dedupe_key(
        "leo", source_kind="inbound", source_ref="item-1", title="send the QUOTE"
    )
    assert first == second


def test_dedupe_key_separates_two_actions_from_one_message() -> None:
    """One arrival that implies two things is two to-dos, not one."""
    quote = compute_dedupe_key(
        "leo", source_kind="inbound", source_ref="item-1", title="Send the quote"
    )
    call = compute_dedupe_key(
        "leo", source_kind="inbound", source_ref="item-1", title="Call the client"
    )
    assert quote != call


def test_dedupe_key_is_per_owner_and_per_source() -> None:
    base = dict(source_kind="inbound", source_ref="item-1", title="Send the quote")
    assert compute_dedupe_key("leo", **base) != compute_dedupe_key("ada", **base)
    assert compute_dedupe_key(
        "leo", source_kind="inbound", source_ref="item-2", title="Send the quote"
    ) != compute_dedupe_key("leo", **base)


def test_a_user_typed_todo_has_no_dedupe_key() -> None:
    """Typing the same thing twice is a decision, not a duplicate."""
    assert (
        compute_dedupe_key(
            "leo", source_kind=None, source_ref=None, title="Send the quote"
        )
        is None
    )


def test_validators_reject_unknown_vocabulary() -> None:
    assert validate_stage("staged") == "staged"
    assert validate_priority("critical") == "critical"
    assert validate_source_kind(None) is None
    with pytest.raises(TodoError):
        validate_stage("archived")
    with pytest.raises(TodoError):
        validate_priority("urgent")
    with pytest.raises(TodoError):
        validate_source_kind("telepathy")


def test_cursor_round_trips() -> None:
    when = datetime(2026, 8, 11, 9, 30, tzinfo=timezone.utc)
    todo = _todo(created_at=when)
    decoded_when, decoded_id = decode_cursor(encode_cursor(todo))
    assert decoded_when == when
    assert decoded_id == todo.id


def test_a_malformed_cursor_is_a_value_error() -> None:
    with pytest.raises(ValueError):
        decode_cursor("not-a-cursor!!")


def test_is_live_follows_the_stage() -> None:
    assert _todo(stage="staged").is_live is True
    assert _todo(stage="done").is_live is False


def test_as_dict_omits_the_dedupe_key() -> None:
    """It is an internal identity, and it hashes the message's own content."""
    payload = _todo(dedupe_key="abc123").as_dict()
    assert "dedupe_key" not in payload
    assert payload["stage"] == "open"
