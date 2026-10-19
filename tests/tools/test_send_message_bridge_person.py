"""send_message refuses to send from a WhatsApp bridge that belongs to
someone other than the person the tool call runs for."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hermes_cli import wa_bridge_owners as owners
from tools.access_policy import acting_as
from tools.send_message_tool import _whatsapp_bridge_send_denied


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("WHATSAPP_BRIDGES", "personal:3000,amy:3002")
    owners.record_owner("amy", "amy")
    return tmp_path


def test_named_bridge_only_for_its_person(home):
    with acting_as("amy", "member"):
        assert _whatsapp_bridge_send_denied("amy", None) is None
    with acting_as("leo", "owner"):
        assert "belongs to another person" in _whatsapp_bridge_send_denied("amy", None)
    assert _whatsapp_bridge_send_denied("amy", None)  # no person bound


def test_unrecorded_bridge_sends_as_before(home):
    with acting_as("ben", "admin"):
        assert _whatsapp_bridge_send_denied("personal", None) is None
    assert _whatsapp_bridge_send_denied(None, SimpleNamespace(extra={"bridge_port": 3000})) is None


def test_default_bridge_resolved_from_port_or_session_path(home):
    by_port = SimpleNamespace(extra={"bridge_port": 3002})
    by_path = SimpleNamespace(extra={"session_path": str(home / "whatsapp" / "session-amy")})
    with acting_as("ben", "admin"):
        assert _whatsapp_bridge_send_denied(None, by_port)
        assert _whatsapp_bridge_send_denied(None, by_path)
    with acting_as("amy", "member"):
        assert _whatsapp_bridge_send_denied(None, by_port) is None
