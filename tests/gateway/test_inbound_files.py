"""Channel attachments reach the file registry with their provenance intact."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

import pytest

import gateway.inbound_files as inbound_files_mod
from gateway.inbound_files import (
    cached_display_name,
    register_event_files,
    surface_for,
)


@dataclass
class _Source:
    platform: str = "telegram"
    chat_id: str = "chat-1"
    thread_id: str = ""
    user_id: str = "tg-9001"
    user_name: str = "Ada Wong"
    account_id: str = "bot-main"
    internal_user_id: Optional[str] = "ada"
    internal_user_role: str = "member"


@dataclass
class _Event:
    media_urls: list = field(default_factory=list)
    media_types: list = field(default_factory=list)
    message_id: str = "42"


class _Registry:
    """Records what would have been written, without a database."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def register(self, principal, **kwargs):
        self.calls.append({"owner": principal.user_id, **kwargs})
        return kwargs


class _Storage:
    bucket = "agent-home-media"

    def __init__(self) -> None:
        self.uploads: list[tuple[str, bytes, str]] = []

    async def upload(self, path, data, *, content_type="application/octet-stream"):
        self.uploads.append((path, data, content_type))
        return path


def test_cached_display_name_strips_the_cache_prefix() -> None:
    assert cached_display_name("/tmp/cache/doc_0123456789ab_grant.pdf") == "grant.pdf"
    assert cached_display_name("/tmp/cache/plain.txt") == "plain.txt"


def test_surface_names_the_channel_a_person_recognises() -> None:
    assert surface_for("telegram") == "telegram"
    assert surface_for("bluebubbles") == "imessage"

    class _Enum:
        value = "WhatsApp"

    assert surface_for(_Enum()) == "whatsapp"


@pytest.mark.asyncio
async def test_an_attachment_is_registered_with_its_provenance(tmp_path) -> None:
    cached = tmp_path / "doc_0123456789ab_grant.pdf"
    cached.write_bytes(b"%PDF-1.7 grant")
    registry, storage = _Registry(), _Storage()

    written = await register_event_files(
        _Event(media_urls=[str(cached)], media_types=["application/pdf"]),
        _Source(thread_id="topic-7"),
        registry=registry,
        storage=storage,
    )

    assert len(written) == 1
    call = registry.calls[0]
    assert call["owner"] == "ada"
    assert call["surface"] == "telegram"
    assert call["filename"] == "grant.pdf"
    assert call["content_type"] == "application/pdf"
    assert call["account_id"] == "bot-main"
    assert call["conversation"] == "chat-1#topic-7"
    assert call["sender_id"] == "tg-9001"
    assert call["sender_name"] == "Ada Wong"
    assert call["message_id"] == "42"
    assert storage.uploads[0][1] == b"%PDF-1.7 grant"


@pytest.mark.asyncio
async def test_the_content_type_is_guessed_when_the_adapter_declares_none(
    tmp_path,
) -> None:
    cached = tmp_path / "doc_0123456789ab_notes.md"
    cached.write_bytes(b"# notes")
    registry = _Registry()

    await register_event_files(
        _Event(media_urls=[str(cached)]),
        _Source(),
        registry=registry,
        storage=_Storage(),
    )
    assert registry.calls[0]["content_type"] == "text/markdown"


@pytest.mark.asyncio
async def test_an_unenrolled_sender_registers_nothing(tmp_path) -> None:
    """A row needs an owner; parking it under someone else would be worse.

    No ``principal_store`` is passed, so the owner fallback does not fire
    and the original skip-on-unenrolled behaviour is preserved.
    """
    cached = tmp_path / "doc_0123456789ab_x.bin"
    cached.write_bytes(b"x")
    registry = _Registry()

    written = await register_event_files(
        _Event(media_urls=[str(cached)]),
        _Source(internal_user_id=None),
        registry=registry,
        storage=_Storage(),
    )
    assert written == []
    assert registry.calls == []


@dataclass
class _OwnerPrincipal:
    user_id: str = "leo"
    display: str = "Leo"
    role: str = "owner"


class _PrincipalStore:
    """Mock PrincipalStore for the owner-fallback tests.

    ``owner=None`` (the default) means "no owner in the store" so the
    fallback stays inactive; pass an ``_OwnerPrincipal`` to simulate a
    personal-agent deployment with a single owner.
    """

    def __init__(self, owner: Optional[_OwnerPrincipal] = None) -> None:
        self._owner = owner

    async def get_owner(self):
        return self._owner


@pytest.mark.asyncio
async def test_unenrolled_sender_falls_back_to_owner(tmp_path) -> None:
    """An unenrolled sender's file is attributed to the deployment owner.

    Without the fallback the file would be skipped and the 24-hour cache
    prune would delete it unrecoverably.  With a principal store the owner
    principal is resolved and the file is registered under it.
    """
    # Reset the module-level owner cache so this test is independent.
    inbound_files_mod._owner_principal = None
    inbound_files_mod._owner_resolved = False
    inbound_files_mod._owner_last_attempt = float("-inf")

    cached = tmp_path / "doc_0123456789ab_resume.pdf"
    cached.write_bytes(b"%PDF-1.7 resume")
    registry, storage = _Registry(), _Storage()
    store = _PrincipalStore(owner=_OwnerPrincipal(user_id="leo", display="Leo"))

    written = await register_event_files(
        _Event(media_urls=[str(cached)], media_types=["application/pdf"]),
        _Source(internal_user_id=None),
        registry=registry,
        storage=storage,
        principal_store=store,
    )

    assert len(written) == 1
    call = registry.calls[0]
    # Registered under the owner, not the unenrolled sender.
    assert call["owner"] == "leo"
    # Provenance still records the actual sender and channel.
    assert call["surface"] == "telegram"
    assert call["sender_id"] == "tg-9001"
    assert call["sender_name"] == "Ada Wong"
    assert storage.uploads[0][1] == b"%PDF-1.7 resume"


@pytest.mark.asyncio
async def test_unenrolled_sender_with_no_owner_still_skips(tmp_path) -> None:
    """When the store has no owner, the fallback is inactive and skips."""
    inbound_files_mod._owner_principal = None
    inbound_files_mod._owner_resolved = False
    inbound_files_mod._owner_last_attempt = float("-inf")

    cached = tmp_path / "doc_0123456789ab_x.bin"
    cached.write_bytes(b"x")
    registry = _Registry()

    written = await register_event_files(
        _Event(media_urls=[str(cached)]),
        _Source(internal_user_id=None),
        registry=registry,
        storage=_Storage(),
        principal_store=_PrincipalStore(owner=None),
    )
    assert written == []
    assert registry.calls == []


@pytest.mark.asyncio
async def test_a_pruned_cache_file_is_skipped_not_fatal(tmp_path) -> None:
    present = tmp_path / "doc_0123456789ab_here.txt"
    present.write_bytes(b"here")
    registry = _Registry()

    written = await register_event_files(
        _Event(media_urls=[str(tmp_path / "gone.txt"), str(present)]),
        _Source(),
        registry=registry,
        storage=_Storage(),
    )
    assert len(written) == 1
    assert registry.calls[0]["filename"] == "here.txt"


@pytest.mark.asyncio
async def test_an_event_without_attachments_touches_nothing() -> None:
    registry = _Registry()
    assert await register_event_files(_Event(), _Source(), registry=registry) == []
    assert registry.calls == []



@pytest.mark.asyncio
async def test_owner_resolves_on_first_try_right_after_boot(monkeypatch) -> None:
    """``time.monotonic()`` counts from boot: within 60 s of it, the first lookup must not be throttled."""
    import importlib.util

    spec = importlib.util.find_spec("gateway.inbound_files")
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)  # a fresh copy with the module's own defaults
    monkeypatch.setattr(fresh.time, "monotonic", lambda: 5.0)
    owner = _OwnerPrincipal(user_id="leo", display="Leo")
    assert await fresh._resolve_owner_principal(_PrincipalStore(owner=owner)) is owner
