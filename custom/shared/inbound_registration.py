#!/usr/bin/env python3
"""Shared arrival registration for standalone services (pollers, batcher).

The sibling of :mod:`shared.file_registration`, for the message rather than its
attachments. Standalone services write to the pipeline's own SQLite and never
touch the gateway's ``MessageEvent`` path, so nothing mirrors what arrived into
the shared, principal-scoped store that ``agent-home`` reads. This module is
that mirror: one call beside each existing SQLite insert.

Best-effort, always. If Supabase is unconfigured, the owner principal cannot be
resolved, or Postgres is briefly down, the call returns ``False`` and message
processing continues. A missing registry row is recoverable — ``hermes
incomings backfill`` replays it from the SQLite the poller already wrote. A
dropped message is not recoverable, so nothing here is allowed to raise.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Owner-principal resolution, identical in shape to file_registration's: a
# retry-after guard rather than a sticky cache, so a startup race (env not yet
# loaded, owner row created after the service started, a transient DB blip)
# recovers on the next message instead of needing a restart.
_owner_principal: Optional[object] = None
_owner_resolved: bool = False
_owner_last_attempt: float = 0.0
_OWNER_RETRY_INTERVAL_SEC: float = 60.0


async def _resolve_owner():
    """Resolve the owner principal, retrying periodically after a failure."""
    import time

    global _owner_principal, _owner_resolved, _owner_last_attempt
    if _owner_resolved:
        return _owner_principal
    now = time.monotonic()
    if now - _owner_last_attempt < _OWNER_RETRY_INTERVAL_SEC:
        return _owner_principal
    _owner_last_attempt = now
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.config import load_config
        from hermes_cli.datastore import get_store

        config = load_config() or {}
        store = PrincipalStore(get_store("supabase-app", "prod", config=config))
        principal = await store.get_owner()
        if principal is not None:
            _owner_principal = principal
            _owner_resolved = True
            return principal
        logger.warning(
            "inbound registration: no owner principal in PrincipalStore; "
            "arrivals from standalone services will not be registered "
            "(retrying in %ds)",
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    except Exception as exc:
        logger.warning(
            "inbound registration: could not resolve owner: %s (retrying in %ds)",
            exc,
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    return _owner_principal


def _as_utc(value: Any) -> Optional[datetime]:
    """Coerce a poller timestamp to an aware UTC datetime, or ``None``.

    The three services hand over three shapes — a ``datetime``, an ISO string
    (sometimes with a trailing ``Z`` that ``fromisoformat`` rejected before
    3.11), and an all-day calendar ``YYYY-MM-DD`` — and a naive value would be
    read by Postgres as UTC anyway, so the assumption is made explicit here
    rather than silently at the driver.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        logger.debug("inbound registration: unparseable timestamp %r", value)
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def mark_importance(
    *,
    surface: str,
    external_id: str,
    account_id: Optional[str] = None,
    importance: str,
) -> bool:
    """Stamp a triage verdict onto an arrival. Never raises.

    Separate from :func:`register_item` because triage runs long after the
    message landed and holds only the classification — re-registering from
    there would rewrite the body and provenance from a stale batch file.
    """
    if not surface or not external_id or not importance:
        return False
    try:
        from hermes_cli.inbound_registry import default_registry

        async def _do() -> bool:
            principal = await _resolve_owner()
            if principal is None:
                return False
            return await default_registry("prod").set_importance(
                principal,
                surface=surface,
                external_id=external_id,
                account_id=account_id or "",
                importance=importance,
            )

        return asyncio.run(_do())
    except Exception as exc:
        logger.warning(
            "inbound registration: could not stamp importance on %s/%s (%s)",
            surface,
            external_id,
            exc,
        )
        return False


async def resolve_person(user_id: str):
    """The live principal ``user_id`` — or ``None`` (never the owner instead).

    For per-person sources (a person's own mailbox): an arrival whose person
    is gone or deactivated is dropped rather than handed to anyone else.
    """
    try:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.config import load_config
        from hermes_cli.datastore import get_store

        config = load_config() or {}
        store = PrincipalStore(get_store("supabase-app", "prod", config=config))
        principal = await store.get(user_id)
    except Exception as exc:
        logger.warning("inbound registration: could not resolve %s (%s)", user_id, exc)
        return None
    if principal is None or not getattr(principal, "active", True):
        return None
    return principal


def register_item(
    *,
    surface: str,
    external_id: str,
    account_id: Optional[str] = None,
    kind: str = "message",
    conversation: Optional[str] = None,
    conversation_name: Optional[str] = None,
    sender_id: Optional[str] = None,
    sender_name: Optional[str] = None,
    subject: Optional[str] = None,
    body: Optional[str] = None,
    occurred_at: Any = None,
    ends_at: Any = None,
    importance: Optional[str] = None,
    has_attachments: bool = False,
    metadata: Optional[dict] = None,
    owner_user_id: Optional[str] = None,
) -> Optional[str]:
    """Mirror one arrival into the shared registry. Never raises.

    Returns the item's id when registered — the callers that also register
    attachments need it for ``file_assets.inbound_item_id`` — and ``None``
    otherwise. Safe to call from synchronous code. ``owner_user_id`` files
    the arrival as that person (private to them) instead of the install owner.
    """
    if not surface or not external_id:
        return None
    try:
        from hermes_cli.inbound_registry import register_arrival

        async def _do():
            if owner_user_id:
                principal = await resolve_person(owner_user_id)
            else:
                principal = await _resolve_owner()
            if principal is None:
                return None
            item = await register_arrival(
                principal,
                surface=surface,
                external_id=external_id,
                account_id=account_id or "",
                kind=kind,
                conversation=conversation,
                conversation_name=conversation_name,
                sender_id=sender_id,
                sender_name=sender_name,
                subject=subject,
                body=body or "",
                occurred_at=_as_utc(occurred_at) or datetime.now(timezone.utc),
                ends_at=_as_utc(ends_at),
                importance=importance,
                has_attachments=has_attachments,
                metadata=metadata,
            )
            return item.id if item is not None else None

        return asyncio.run(_do())
    except Exception as exc:
        logger.warning(
            "inbound registration: could not register %s/%s (%s)",
            surface,
            external_id,
            exc,
        )
        return None
