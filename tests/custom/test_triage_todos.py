"""Triage's judgement has to reach the To-dos page, and quietly.

The `todos` handler is the one place where a chatty morning can turn into a
list nobody reads, so these tests pin the volume controls (cap, ordering,
staged-by-default), the provenance the page needs, and the rule every bridge
in this pipeline obeys: a registry outage costs a nudge, never the message.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


def _load(name: str, relative: str):
    sys.path.insert(0, str(REPO_ROOT / "custom"))
    spec = importlib.util.spec_from_file_location(
        name, REPO_ROOT / "custom" / relative
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def handlers():
    return _load("_test_triage_handlers_todos", "shared/triage_handlers.py")


@pytest.fixture(scope="module")
def registration():
    return _load("_test_todo_registration", "shared/todo_registration.py")


class _NullDb:
    def execute(self, *args, **kwargs):
        return self

    def fetchone(self):
        return None

    def commit(self):
        return None


@pytest.fixture
def recorded(monkeypatch):
    """Capture what the handler would write, without a database."""
    calls: list[dict] = []
    module = type(sys)("shared.todo_registration")
    real = _load("_test_todo_registration_inner", "shared/todo_registration.py")

    def _register(**kwargs):
        calls.append(kwargs)
        return {"id": f"todo-{len(calls)}", "stage": "open", "created": True}

    module.register_todo = _register
    module.select_candidates = real.select_candidates
    monkeypatch.setitem(sys.modules, "shared.todo_registration", module)
    return calls


def _email_batch(todos):
    return {
        "_channel": "email",
        "account_id": "leo@example.com",
        "emails": [{"id": 7, "message_id": "<abc@mail>"}],
        "summary": "Acme asked for the signed quote.",
        "todos": todos,
    }


def test_a_todo_carries_the_arrival_it_came_from(handlers, recorded):
    handlers.process_result(
        {
            "summary": "Acme asked for the signed quote.",
            "todos": [
                {
                    "title": "Send the signed quote back to Acme",
                    "detail": "Ada needs it before the tender closes.",
                    "priority": "high",
                    "due_date": "2026-08-14",
                    "notify": True,
                }
            ],
        },
        _email_batch(None),
        _NullDb(),
    )
    assert len(recorded) == 1
    call = recorded[0]
    assert call["title"] == "Send the signed quote back to Acme"
    assert (call["surface"], call["external_id"]) == ("email", "<abc@mail>")
    assert call["account_id"] == "leo@example.com"
    assert call["notify"] is True
    assert call["actor"] == "skill:email-triage"


def test_a_todo_without_notify_stays_silent(handlers, recorded):
    handlers.process_result(
        {"todos": [{"title": "Read the industry newsletter"}]},
        _email_batch(None),
        _NullDb(),
    )
    assert recorded[0]["notify"] is False


def test_a_batch_contributes_at_most_three_todos(handlers, recorded):
    handlers.process_result(
        {
            "todos": [
                {"title": f"Thing {i}", "priority": "low"} for i in range(7)
            ]
        },
        _email_batch(None),
        _NullDb(),
    )
    assert len(recorded) == 3


def test_the_cap_keeps_the_urgent_ones(handlers, recorded):
    """The batch that overflows is exactly the one that must not lose the
    item that mattered."""
    handlers.process_result(
        {
            "todos": [
                {"title": "Low thing", "priority": "low"},
                {"title": "Medium thing", "priority": "medium"},
                {"title": "Another low thing", "priority": "low"},
                {"title": "Critical thing", "priority": "critical"},
                {"title": "High thing", "priority": "high"},
            ]
        },
        _email_batch(None),
        _NullDb(),
    )
    assert [c["title"] for c in recorded] == [
        "Critical thing",
        "High thing",
        "Medium thing",
    ]


def test_the_batch_summary_stands_in_for_a_missing_detail(handlers, recorded):
    handlers.process_result(
        {
            "summary": "Acme asked for the signed quote.",
            "todos": [{"title": "Send the quote"}],
        },
        _email_batch(None),
        _NullDb(),
    )
    assert recorded[0]["description"] == "Acme asked for the signed quote."


def test_junk_entries_are_skipped_not_recorded(handlers, recorded):
    handlers.process_result(
        {"todos": ["a string", {"detail": "no title"}, {"title": "  "}]},
        _email_batch(None),
        _NullDb(),
    )
    assert recorded == []


def test_a_store_outage_does_not_break_the_pipeline(handlers, monkeypatch):
    module = type(sys)("shared.todo_registration")
    real = _load("_test_todo_registration_outage", "shared/todo_registration.py")

    def _boom(**kwargs):
        raise RuntimeError("postgres is down")

    module.register_todo = _boom
    module.select_candidates = real.select_candidates
    monkeypatch.setitem(sys.modules, "shared.todo_registration", module)

    # process_result owns the guard; the SQLite writes above already happened.
    handlers.process_result(
        {"todos": [{"title": "Send the quote"}]}, _email_batch(None), _NullDb()
    )


def test_a_batch_with_no_todos_field_records_nothing(handlers, recorded):
    handlers.process_result({"summary": "fyi"}, _email_batch(None), _NullDb())
    assert recorded == []


# -- the registration module's own decisions --------------------------------


def test_priority_vocabularies_are_bridged(registration):
    assert registration.normalize_priority("medium") == "normal"
    assert registration.normalize_priority("HIGH") == "high"
    assert registration.normalize_priority("urgent") == "critical"
    assert registration.normalize_priority(None) == "normal"
    assert registration.normalize_priority("whatever") == "normal"


def test_a_bare_date_is_due_at_the_end_of_that_day(registration):
    """Due Friday must not be overdue at one minute past midnight on Friday."""
    due = registration.parse_due("2026-08-14")
    assert (due.hour, due.minute) == (23, 59)
    assert due.tzinfo is not None


def test_unparseable_and_absent_dates_are_simply_absent(registration):
    assert registration.parse_due(None) is None
    assert registration.parse_due("null") is None
    assert registration.parse_due("next Tuesday-ish") is None


def test_selection_is_stable_within_a_priority(registration):
    picked = registration.select_candidates(
        [
            {"title": "first", "priority": "medium"},
            {"title": "second", "priority": "medium"},
            {"title": "third", "priority": "medium"},
            {"title": "fourth", "priority": "medium"},
        ]
    )
    assert [p["title"] for p in picked] == ["first", "second", "third"]


def test_notify_breaks_a_priority_tie(registration):
    picked = registration.select_candidates(
        [
            {"title": "quiet", "priority": "high"},
            {"title": "loud", "priority": "high", "notify": True},
        ],
        limit=1,
    )
    assert [p["title"] for p in picked] == ["loud"]


def test_a_todo_with_no_title_is_never_registered(registration):
    assert registration.register_todo(title="   ") is None


def test_a_recorded_todo_marks_its_arrival_for_incomings(handlers, recorded):
    batch = _email_batch(None)
    handlers.process_result(
        {"todos": [{"title": "Sign the quote", "priority": "high"}]},
        batch,
        _NullDb(),
    )
    assert batch["_todo_arrivals"] == [
        ("email", "leo@example.com", "<abc@mail>", "high")
    ]
