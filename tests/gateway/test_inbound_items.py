"""Channel messages reach the inbound registry with their provenance intact."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import pytest

import gateway.inbound_items as inbound_items_mod
from gateway.inbound_items import MAX_BODY_CHARS, register_event_item


@dataclass
class _Source:
    platform: str = "telegram"
    account_id: str = "acct-1"
    chat_id: str = "chat-9"
    thread_id: str = ""
    user_id: str = "42"
    user_name: str = "Ada"
    chat_name: str = "Tender 2026"
    internal_user_id: Optional[str] = "ada"
    internal_user_role: str = "member"


@dataclass
class _Event:
    message_id: str = "m-1"
    text: str = "can we meet at three"
    media_urls: Optional[list] = None


class _Registry:
    """Captures what the gateway asked the registry to record."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def register(self, principal, **fields):
        self.calls.append({"principal": principal, **fields})
        return object()


class _Store:
    def __init__(self, owner=None) -> None:
        self._owner = owner

    async def get_owner(self):
        return self._owner


@pytest.fixture(autouse=True)
def _reset_owner_cache():
    """The owner cache is module state shared with the file registration."""
    import gateway.inbound_files as files_mod

    files_mod._owner_principal = None
    files_mod._owner_resolved = False
    files_mod._owner_last_attempt = float("-inf")
    yield


@pytest.mark.asyncio
async def test_records_the_message_with_its_provenance() -> None:
    registry = _Registry()
    item = await register_event_item(_Event(), _Source(), registry=registry)

    assert item is not None
    (call,) = registry.calls
    assert call["surface"] == "telegram"
    assert call["external_id"] == "m-1"
    assert call["account_id"] == "acct-1"
    assert call["conversation"] == "chat-9"
    assert call["conversation_name"] == "Tender 2026"
    assert call["sender_id"] == "42"
    assert call["sender_name"] == "Ada"
    assert call["body"] == "can we meet at three"
    assert call["has_attachments"] is False
    assert call["principal"].user_id == "ada"


@pytest.mark.asyncio
async def test_thread_is_part_of_the_conversation_key() -> None:
    registry = _Registry()
    await register_event_item(
        _Event(), _Source(thread_id="t-3"), registry=registry
    )
    assert registry.calls[0]["conversation"] == "chat-9#t-3"


@pytest.mark.asyncio
async def test_platform_alias_becomes_the_surface_people_use() -> None:
    registry = _Registry()
    await register_event_item(
        _Event(), _Source(platform="bluebubbles"), registry=registry
    )
    assert registry.calls[0]["surface"] == "imessage"


@pytest.mark.asyncio
async def test_attachment_presence_is_recorded() -> None:
    registry = _Registry()
    await register_event_item(
        _Event(media_urls=["/cache/doc_abc.pdf"]), _Source(), registry=registry
    )
    assert registry.calls[0]["has_attachments"] is True


@pytest.mark.asyncio
async def test_a_pasted_logfile_is_clipped_not_dropped() -> None:
    registry = _Registry()
    await register_event_item(
        _Event(text="x" * (MAX_BODY_CHARS + 500)), _Source(), registry=registry
    )
    assert len(registry.calls[0]["body"]) == MAX_BODY_CHARS


@pytest.mark.asyncio
async def test_a_message_without_an_id_is_skipped() -> None:
    """No stable external id means the upsert key is meaningless."""
    registry = _Registry()
    assert (
        await register_event_item(_Event(message_id=""), _Source(), registry=registry)
        is None
    )
    assert registry.calls == []


@pytest.mark.asyncio
async def test_unenrolled_sender_falls_back_to_the_deployment_owner() -> None:
    registry = _Registry()

    class _Owner:
        user_id = "leo"

    await register_event_item(
        _Event(),
        _Source(internal_user_id=None),
        registry=registry,
        principal_store=_Store(owner=_Owner()),
    )
    assert registry.calls[0]["principal"].user_id == "leo"


@pytest.mark.asyncio
async def test_unenrolled_sender_without_an_owner_is_left_unregistered() -> None:
    """A row needs an owner to be scoped to; guessing one is worse than none."""
    registry = _Registry()
    result = await register_event_item(
        _Event(),
        _Source(internal_user_id=None),
        registry=registry,
        principal_store=_Store(owner=None),
    )
    assert result is None
    assert registry.calls == []


@pytest.mark.asyncio
async def test_a_registry_failure_never_reaches_the_turn(monkeypatch) -> None:
    """The reply matters more than the bookkeeping."""

    class _Broken:
        async def register(self, principal, **fields):
            raise RuntimeError("postgres is down")

    assert await register_event_item(_Event(), _Source(), registry=_Broken()) is None
    assert inbound_items_mod.MAX_BODY_CHARS > 0
