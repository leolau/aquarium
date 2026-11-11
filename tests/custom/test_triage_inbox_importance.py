"""The triage verdict has to reach the Inbox, not just the pipeline's SQLite.

``process_result`` writes tasks, notes and escalations into the pipeline's own
tables; the same verdict is what makes an arrival findable under "urgent" in
agent-home. These tests pin the projection: which arrivals a batch covers, how
three channels' vocabularies collapse into one word, and that a registry
outage still leaves the SQLite writes intact.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def handlers():
    """Load ``custom/shared/triage_handlers.py`` the way the agents do."""
    sys.path.insert(0, str(REPO_ROOT / "custom"))
    spec = importlib.util.spec_from_file_location(
        "_test_triage_handlers", REPO_ROOT / "custom" / "shared" / "triage_handlers.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_escalation_outranks_the_classification(handlers):
    # The Telegram alert and the Inbox must not disagree about the same message.
    assert (
        handlers._triage_importance(
            {
                "classification": "informational",
                "escalate": True,
                "escalation_priority": "high",
            }
        )
        == "high"
    )
    assert handlers._triage_importance({"escalate": True}) == "urgent"


def test_falls_back_to_the_channel_s_own_word(handlers):
    # Calendar classifies importance; the message channels classify a kind.
    assert handlers._triage_importance({"importance": "critical"}) == "critical"
    assert (
        handlers._triage_importance({"classification": "actionable"}) == "actionable"
    )
    assert handlers._triage_importance({}) == ""


def test_a_whatsapp_batch_covers_every_message_in_it(handlers):
    batch = {
        "_channel": "whatsapp",
        "source_phone": "+85211112222",
        "messages": [
            {"msg_id": "wamid.1"},
            {"msg_id": "wamid.2"},
            {"msg_id": ""},
        ],
    }
    assert handlers._triaged_arrivals(batch) == [
        ("whatsapp", "+85211112222", "wamid.1"),
        ("whatsapp", "+85211112222", "wamid.2"),
    ]


def test_an_email_batch_uses_the_rfc_message_id(handlers):
    # The registry keyed the arrival on the RFC id, not the SQLite rowid.
    batch = {
        "_channel": "email",
        "account_id": "leo@example.com",
        "emails": [{"id": 7, "message_id": "<abc@mail>"}, {"id": 8}],
    }
    assert handlers._triaged_arrivals(batch) == [
        ("email", "leo@example.com", "<abc@mail>")
    ]


def test_a_calendar_batch_is_the_single_event(handlers):
    batch = {
        "_channel": "calendar",
        "account_id": "leo@example.com",
        "google_event_id": "evt_1",
    }
    assert handlers._triaged_arrivals(batch) == [
        ("calendar", "leo@example.com", "evt_1")
    ]
    assert handlers._triaged_arrivals({"_channel": "calendar"}) == []


def test_stamps_each_arrival_once(handlers, monkeypatch):
    calls = []
    module = type(sys)("shared.inbound_registration")
    module.mark_importance = lambda **kwargs: calls.append(kwargs) or True
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", module)

    handlers.stamp_inbox_importance(
        {"escalate": True, "escalation_priority": "high"},
        {
            "_channel": "whatsapp",
            "source_phone": "+852",
            "messages": [{"msg_id": "wamid.1"}, {"msg_id": "wamid.2"}],
        },
    )
    assert [c["external_id"] for c in calls] == ["wamid.1", "wamid.2"]
    assert {c["importance"] for c in calls} == {"high"}


def test_an_unclassified_batch_touches_nothing(handlers, monkeypatch):
    module = type(sys)("shared.inbound_registration")

    def _fail(**kwargs):
        raise AssertionError("nothing to stamp")

    module.mark_importance = _fail
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", module)
    handlers.stamp_inbox_importance({"summary": "fyi"}, {"_channel": "whatsapp"})


def test_a_registry_outage_does_not_break_the_pipeline(handlers, monkeypatch):
    module = type(sys)("shared.inbound_registration")

    def _boom(**kwargs):
        raise RuntimeError("postgres is down")

    module.mark_importance = _boom
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", module)

    # process_result owns the guard: the SQLite writes above it already
    # happened, and losing the projection must not lose them.
    handlers.process_result(
        {"escalate": True, "escalation_priority": "high"},
        {
            "_channel": "whatsapp",
            "source_phone": "+852",
            "messages": [{"msg_id": "wamid.1"}],
        },
        _NullDb(),
    )


class _NullDb:
    def execute(self, *args, **kwargs):
        return self

    def fetchone(self):
        return None

    def commit(self):
        return None


def _stamped(handlers, monkeypatch, result, batch):
    calls = []
    module = type(sys)("shared.inbound_registration")
    module.mark_importance = lambda **kwargs: calls.append(kwargs) or True
    monkeypatch.setitem(sys.modules, "shared.inbound_registration", module)
    handlers.stamp_inbox_importance(result, batch)
    return calls


_WA = {"_channel": "whatsapp", "source_phone": "+852", "messages": [{"msg_id": "w1"}]}
_CAL = {"_channel": "calendar", "account_id": "leo@x", "google_event_id": "evt-1"}


def test_an_escalation_needs_the_user_at_its_priority(handlers, monkeypatch):
    calls = _stamped(
        handlers, monkeypatch, {"escalate": True, "escalation_priority": "high"}, _WA
    )
    assert [(c["attention_reason"], c["attention_priority"]) for c in calls] == [
        ("escalated", "high")
    ]
    calls = _stamped(handlers, monkeypatch, {"escalate": True}, _WA)
    assert calls[0]["attention_priority"] == "urgent"


def test_a_critical_calendar_event_needs_the_user(handlers, monkeypatch):
    calls = _stamped(handlers, monkeypatch, {"importance": "critical"}, _CAL)
    assert (calls[0]["attention_reason"], calls[0]["attention_priority"]) == (
        "critical_event",
        "urgent",
    )
    # A merely important meeting is in the Inbox, not in Incomings.
    calls = _stamped(handlers, monkeypatch, {"importance": "important"}, _CAL)
    assert calls[0]["attention_reason"] is None


def test_informational_chatter_is_not_flagged(handlers, monkeypatch):
    calls = _stamped(
        handlers, monkeypatch, {"classification": "informational"}, dict(_WA)
    )
    assert calls and calls[0]["attention_reason"] is None
    assert calls[0]["importance"] == "informational"


def test_a_todo_for_the_arrival_flags_it_even_without_a_verdict(
    handlers, monkeypatch
):
    batch = dict(_WA, _todo_arrivals=[("whatsapp", "+852", "w1", "low"),
                                      ("whatsapp", "+852", "w1", "high")])
    calls = _stamped(handlers, monkeypatch, {}, batch)
    assert [(c["attention_reason"], c["attention_priority"]) for c in calls] == [
        ("todo", "high")
    ]
    assert calls[0]["importance"] == ""


def test_escalation_wins_over_a_todo(handlers, monkeypatch):
    batch = dict(_WA, _todo_arrivals=[("whatsapp", "+852", "w1", "high")])
    calls = _stamped(
        handlers, monkeypatch, {"escalate": True, "escalation_priority": "low"}, batch
    )
    assert calls[0]["attention_reason"] == "escalated"


def _load_registration():
    sys.path.insert(0, str(REPO_ROOT / "custom"))
    spec = importlib.util.spec_from_file_location(
        "_test_inbound_registration",
        REPO_ROOT / "custom" / "shared" / "inbound_registration.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _StubRegistry:
    def __init__(self):
        self.calls = []

    async def set_importance(self, principal, **kwargs):
        self.calls.append(("importance", kwargs))
        return True

    async def flag_attention(self, principal, **kwargs):
        self.calls.append(("attention", kwargs))
        return True


@pytest.fixture
def stub_registry(monkeypatch):
    import hermes_cli.inbound_registry as inbound_registry

    registration = _load_registration()
    registry = _StubRegistry()

    async def _owner():
        return object()

    monkeypatch.setattr(registration, "_resolve_owner", _owner)
    monkeypatch.setattr(inbound_registry, "default_registry", lambda mode: registry)
    return registration, registry


def test_mark_importance_flags_attention_with_its_reason(stub_registry):
    registration, registry = stub_registry
    assert registration.mark_importance(
        surface="email", external_id="<a@m>", account_id="leo@x",
        importance="high", attention_reason="escalated", attention_priority="high",
    ) is True
    assert [kind for kind, _ in registry.calls] == ["importance", "attention"]
    assert registry.calls[1][1] == {
        "surface": "email", "external_id": "<a@m>", "account_id": "leo@x",
        "reason": "escalated", "priority": "high",
    }


def test_mark_importance_without_a_reason_never_flags(stub_registry):
    registration, registry = stub_registry
    registration.mark_importance(
        surface="email", external_id="<a@m>", importance="informational"
    )
    assert [kind for kind, _ in registry.calls] == ["importance"]
    assert registration.mark_importance(surface="email", external_id="<a@m>") is False
