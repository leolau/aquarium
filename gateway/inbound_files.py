"""Register channel attachments in the durable file registry.

The gateway caches an inbound attachment under ``cache/documents`` so the model
can read it this turn, and that cache is pruned after a day. This module is the
other half: the same bytes go to the private Supabase bucket and a row records
where they came from — platform, receiving account, conversation, sender,
message and time — which is knowledge only the inbound chokepoint has.

Registering is not remembering. Nothing here embeds anything or touches
``rag_documents``; deciding a file matters is a later, deliberate act by the
user or by a triage skill.
"""

from __future__ import annotations

import logging
import mimetypes
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: The prefix ``cache_document_from_bytes`` puts on a cached attachment. The
#: registry wants the name the sender saw, not the cache's disambiguator.
_CACHE_PREFIX = re.compile(r"^doc_[0-9a-f]{12}_")

#: Platform names that already read as surfaces are passed through; the map
#: exists for the ones whose adapter name differs from what a person calls the
#: channel (BlueBubbles *is* iMessage to its user).
_SURFACE_ALIASES = {
    "bluebubbles": "imessage",
    "api_server": "api",
    "local": "cli",
}


def cached_display_name(path: str) -> str:
    """The original filename behind a cache path."""
    return _CACHE_PREFIX.sub("", Path(path).name) or "attachment"


def surface_for(platform: Any) -> str:
    """Normalise a platform value into a registry surface name."""
    raw = getattr(platform, "value", platform)
    name = str(raw or "unknown").strip().lower()
    return _SURFACE_ALIASES.get(name, name)


def _content_type(path: str, declared: str = "") -> str:
    if declared and "/" in declared:
        return declared
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _principal_for(source: Any) -> Optional[Any]:
    """The principal that owns files arriving on ``source``, if it is known.

    An unenrolled sender has no principal, and a registry row needs an owner to
    be scoped to — so an unknown sender's file is left unregistered rather than
    parked under somebody else's identity.
    """
    from hermes_cli.access import Principal

    user_id = getattr(source, "internal_user_id", None)
    if not user_id:
        return None
    role = getattr(source, "internal_user_role", None) or "member"
    return Principal(
        user_id=str(user_id),
        display=str(getattr(source, "user_name", "") or ""),
        role=role,
    )


# ---------------------------------------------------------------------------
# Deployment owner — the fallback principal for personal-agent deployments.
# ---------------------------------------------------------------------------
#
# When an inbound sender is unenrolled (an external WhatsApp contact, a
# recruiter on email, …) ``_principal_for`` returns ``None`` and the file is
# skipped.  For a single-owner deployment the file was *received by* the owner,
# so the owner is the correct principal to scope it to — and the alternative
# (skipping) means the bytes are never uploaded to Supabase and the 24-hour
# cache prune deletes them unrecoverably.
#
# Resolved lazily from the PrincipalStore the gateway already holds, with a
# retry-after guard so a startup race (owner row created after the gateway
# starts) recovers within 60 s without hammering Postgres on every attachment.
_owner_principal: Optional[Any] = None
_owner_resolved: bool = False
_owner_last_attempt: float = float("-inf")
_OWNER_RETRY_INTERVAL_SEC: float = 60.0


async def _resolve_owner_principal(store: Any) -> Optional[Any]:
    """Resolve and cache the deployment owner for the unenrolled-sender fallback.

    Returns ``None`` when the store has no owner (multi-user without a single
    owner role, or Supabase unconfigured), in which case the caller keeps the
    original skip-on-unenrolled behaviour — no regression.
    """
    global _owner_principal, _owner_resolved, _owner_last_attempt
    if _owner_resolved:
        return _owner_principal
    now = time.monotonic()
    if now - _owner_last_attempt < _OWNER_RETRY_INTERVAL_SEC:
        return _owner_principal
    _owner_last_attempt = now
    try:
        principal = await store.get_owner()
        if principal is not None:
            _owner_principal = principal
            _owner_resolved = True
            return principal
        logger.debug(
            "file registry: no owner principal; unenrolled-sender "
            "fallback inactive"
        )
    except Exception:
        logger.debug(
            "file registry: could not resolve owner principal", exc_info=True
        )
        _owner_principal = None
    return _owner_principal


def _conversation_of(source: Any) -> str:
    chat_id = str(getattr(source, "chat_id", "") or "")
    thread_id = str(getattr(source, "thread_id", "") or "")
    return f"{chat_id}#{thread_id}" if thread_id else chat_id


async def register_event_files(
    event: Any,
    source: Any,
    *,
    registry: Optional[Any] = None,
    storage: Optional[Any] = None,
    principal_store: Optional[Any] = None,
) -> list[Any]:
    """Register every attachment on ``event``; returns the rows written.

    Never raises. An attachment whose bytes have already been pruned, an
    unenrolled sender with no owner fallback, or an unreachable bucket each
    mean "no row", which a backfill can repair later — unlike a message the
    gateway failed to answer.

    When ``principal_store`` is provided and the sender is unenrolled, the
    file is attributed to the deployment owner instead of being skipped.
    This is the personal-agent path: the file was *received by* the owner, so
    the owner is the correct visibility scope, and the alternative (skip)
    means the 24-hour cache prune deletes the bytes unrecoverably.
    """
    paths = list(getattr(event, "media_urls", None) or [])
    if not paths:
        return []
    principal = _principal_for(source)
    if principal is None:
        # No enrolled sender.  Fall back to the deployment owner so the file
        # is persisted before the 24-hour cache prune, rather than dropped.
        if principal_store is not None:
            principal = await _resolve_owner_principal(principal_store)
            if principal is not None:
                logger.debug(
                    "file registry: sender unenrolled; attributing %d "
                    "attachment(s) to the deployment owner %s",
                    len(paths),
                    principal.user_id,
                )
        if principal is None:
            logger.debug(
                "file registry: %s attachment(s) from an unenrolled sender "
                "left unregistered",
                len(paths),
            )
            return []

    from hermes_cli.file_registry import store_and_register

    declared = list(getattr(event, "media_types", None) or [])
    surface = surface_for(getattr(source, "platform", None))
    received_at = datetime.now(timezone.utc)
    registered: list[Any] = []
    for index, path in enumerate(paths):
        try:
            data = Path(path).read_bytes()
        except OSError as exc:
            logger.debug("file registry: cannot read %s (%s)", path, exc)
            continue
        asset = await store_and_register(
            principal,
            data,
            surface=surface,
            filename=cached_display_name(path),
            content_type=_content_type(
                path, declared[index] if index < len(declared) else ""
            ),
            account_id=str(getattr(source, "account_id", "") or "") or None,
            conversation=_conversation_of(source) or None,
            sender_id=str(getattr(source, "user_id", "") or "") or None,
            sender_name=str(getattr(source, "user_name", "") or "") or None,
            message_id=str(getattr(event, "message_id", "") or "") or None,
            received_at=received_at,
            registry=registry,
            storage=storage,
        )
        if asset is not None:
            registered.append(asset)
    if registered:
        logger.info(
            "file registry: recorded %d file(s) from %s for %s",
            len(registered),
            surface,
            principal.user_id,
        )
    return registered
