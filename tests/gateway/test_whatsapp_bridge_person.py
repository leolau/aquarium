"""A message through a person's WhatsApp bridge is handled only as them.

Real ``GatewayRunner._enrich_channel_source_identity`` with a temp
HERMES_HOME holding bridge-owners.json + the bridge's creds.json; the
principal store is an in-memory stand-in for the people table.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.session import SessionSource
from hermes_cli import wa_bridge_owners as owners


class _Conn:
    async def connect(self):
        return self

    async def close(self):
        return None


class _Store:
    _store = _Conn()

    def __init__(self, people):
        self.people = people

    async def get(self, user_id, connection=None):
        return self.people.get(user_id)

    async def resolve_by_channel(self, platform, channel_user_id, connection=None):
        return None


def _p(user_id, role):
    return SimpleNamespace(user_id=user_id, role=role, active=True)


class _Adapter:
    account_id = None

    def __init__(self, bridge):
        self.bridge_name = bridge


def _runner(adapter, store):
    runner = object.__new__(GatewayRunner)
    runner.adapters = {Platform.WHATSAPP: adapter}
    runner._principal_store_cache = store
    return runner


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    sess = tmp_path / "whatsapp" / "session-amy"
    sess.mkdir(parents=True)
    (sess / "creds.json").write_text(json.dumps({"me": {"id": "85298765432:3@s.whatsapp.net"}}))
    return tmp_path


def _src(user_id, bound=None, role=None):
    return SessionSource(
        platform=Platform.WHATSAPP, chat_id=user_id, chat_type="dm",
        user_id=user_id, internal_user_id=bound, internal_user_role=role,
    )


STORE = _Store({"amy": _p("amy", "member"), "ben": _p("ben", "admin")})


@pytest.mark.asyncio
async def test_message_from_the_bridges_own_number_is_its_person(home):
    owners.record_owner("amy", "amy")
    out = await _runner(_Adapter("amy"), STORE)._enrich_channel_source_identity(
        _src("85298765432@s.whatsapp.net")
    )
    assert (out.internal_user_id, out.internal_user_role) == ("amy", "member")


@pytest.mark.asyncio
async def test_never_handled_as_someone_else(home):
    """Ben's own number writing to Amy's phone does not run as Ben."""
    owners.record_owner("amy", "amy")
    out = await _runner(_Adapter("amy"), STORE)._enrich_channel_source_identity(
        _src("85255550000@s.whatsapp.net", bound="ben", role="admin")
    )
    assert out.internal_user_id is None and out.internal_user_role is None


@pytest.mark.asyncio
async def test_unrecorded_bridge_keeps_todays_routing(home):
    """Existing box: a bridge with no person changes nothing."""
    out = await _runner(_Adapter("amy"), STORE)._enrich_channel_source_identity(
        _src("85255550000@s.whatsapp.net", bound="ben", role="admin")
    )
    assert (out.internal_user_id, out.internal_user_role) == ("ben", "admin")


@pytest.mark.asyncio
async def test_adapter_without_a_bridge_name_is_untouched(home):
    owners.record_owner("amy", "amy")
    out = await _runner(_Adapter(None), STORE)._enrich_channel_source_identity(
        _src("85255550000@s.whatsapp.net", bound="ben", role="admin")
    )
    assert out.internal_user_id == "ben"


def test_adapter_bridge_name_from_config(home):
    from gateway.config import PlatformConfig
    from plugins.platforms.whatsapp.adapter import WhatsAppAdapter

    a = WhatsAppAdapter(PlatformConfig(enabled=True, extra={
        "session_path": str(home / "whatsapp" / "session-amy")}))
    assert a.bridge_name == "amy"
    b = WhatsAppAdapter(PlatformConfig(enabled=True, extra={"bridge_name": "Work"}))
    assert b.bridge_name == "work"
    c = WhatsAppAdapter(PlatformConfig(enabled=True))
    assert c.bridge_name is None


@pytest.mark.asyncio
async def test_suspended_person_on_own_number_is_refused(home):
    owners.record_owner("amy", "amy")
    store = _Store({"amy": SimpleNamespace(user_id="amy", role="member", active=False)})
    out = await _runner(_Adapter("amy"), store)._enrich_channel_source_identity(
        _src("85298765432@s.whatsapp.net")
    )
    assert out is None


@pytest.mark.asyncio
async def test_missing_person_on_own_number_is_refused(home):
    owners.record_owner("amy", "amy")
    out = await _runner(_Adapter("amy"), _Store({}))._enrich_channel_source_identity(
        _src("85298765432@s.whatsapp.net")
    )
    assert out is None


@pytest.mark.asyncio
async def test_store_error_on_own_number_is_refused(home):
    class Broken(_Store):
        async def get(self, user_id, connection=None):
            raise RuntimeError("store down")

    owners.record_owner("amy", "amy")
    out = await _runner(_Adapter("amy"), Broken({}))._enrich_channel_source_identity(
        _src("85298765432@s.whatsapp.net")
    )
    assert out is None


@pytest.mark.asyncio
async def test_clamp_failure_is_refused(home, monkeypatch):
    def boom(name):
        raise RuntimeError("unreadable")

    monkeypatch.setattr(owners, "bridge_person", boom)
    out = await _runner(_Adapter("amy"), STORE)._enrich_channel_source_identity(
        _src("85298765432@s.whatsapp.net")
    )
    assert out is None
