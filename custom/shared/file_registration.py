#!/usr/bin/env python3
"""Shared file registration for standalone services (email poller, WhatsApp batcher).

Standalone services don't go through the gateway's MessageEvent pipeline, so
the gateway's file registry hook (register_event_files in gateway/inbound_files.py)
never fires for them.  This module bridges that gap by calling
store_and_register() directly, with the principal resolved from the
PrincipalStore (the owner for a personal agent).

The registration is best-effort: if Supabase is unconfigured, the principal
can't be resolved, or anything else goes wrong, the call returns False and
the message-processing continues uninterrupted.  A missing registry row is
recoverable by a backfill; a dropped message is not.
"""

import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Cache the resolved owner principal so we don't hit Postgres on every file.
# A retry-after guard (not a sticky cache) so a startup race — Supabase env
# not yet loaded, owner row created after the service starts, transient DB
# blip — recovers without hammering Postgres on every message.
_owner_principal: Optional[object] = None
_owner_resolved: bool = False
_owner_last_attempt: float = 0.0
_OWNER_RETRY_INTERVAL_SEC: float = 60.0


async def _resolve_owner():
    """Resolve the owner principal from the PrincipalStore.

    Returns the cached principal on subsequent calls.  Returns ``None`` if the
    principal store is unconfigured or no owner exists — but unlike a sticky
    cache, a ``None`` result is retried after :data:`_OWNER_RETRY_INTERVAL_SEC`
    so the owner row appearing later (or env coming up after the service) is
    picked up without a restart.
    """
    import time

    global _owner_principal, _owner_resolved, _owner_last_attempt
    if _owner_resolved:
        return _owner_principal
    now = time.monotonic()
    if now - _owner_last_attempt < _OWNER_RETRY_INTERVAL_SEC:
        # Still inside the backoff window from the last failed attempt.
        return _owner_principal
    _owner_last_attempt = now
    try:
        from hermes_cli.config import load_config
        from hermes_cli.datastore import get_store
        from hermes_cli.access import PrincipalStore

        config = load_config() or {}
        app_store = get_store("supabase-app", "prod", config=config)
        store = PrincipalStore(app_store)
        principal = await store.get_owner()
        if principal is not None:
            _owner_principal = principal
            _owner_resolved = True
            return principal
        logger.warning(
            "file registration: no owner principal found in PrincipalStore; "
            "files from standalone services will not be registered "
            "(retrying in %ds)",
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    except Exception as exc:
        logger.warning(
            "file registration: could not resolve owner: %s "
            "(retrying in %ds)",
            exc,
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    return _owner_principal


def register_file(
    data: bytes,
    *,
    surface: str,
    filename: str,
    content_type: str = "application/octet-stream",
    account_id: Optional[str] = None,
    conversation: Optional[str] = None,
    sender_id: Optional[str] = None,
    sender_name: Optional[str] = None,
    message_id: Optional[str] = None,
    received_at: Optional[datetime] = None,
    inbound_item_id: Optional[str] = None,
) -> bool:
    """Register a file in the file registry.  Best-effort, never raises.

    Returns ``True`` if the file was registered, ``False`` otherwise.  Safe to
    call from synchronous code (uses ``asyncio.run`` internally).
    """
    if not data:
        return False
    try:
        from hermes_cli.file_registry import store_and_register

        async def _do():
            principal = await _resolve_owner()
            if principal is None:
                return False
            asset = await store_and_register(
                principal,
                data,
                surface=surface,
                filename=filename,
                content_type=content_type,
                account_id=account_id,
                conversation=conversation,
                sender_id=sender_id,
                sender_name=sender_name,
                message_id=message_id,
                received_at=received_at or datetime.now(timezone.utc),
                inbound_item_id=inbound_item_id,
            )
            return asset is not None

        return asyncio.run(_do())
    except Exception as exc:
        logger.warning(
            "file registration: could not register %r (%s)", filename, exc
        )
        return False


def register_files_batch(items: list[dict], owner_user_id: Optional[str] = None) -> int:
    """Register multiple files in a single event loop.

    Each item is a dict with the same keyword arguments as :func:`register_file`.
    ``owner_user_id`` files them as that person instead of the install owner.
    Returns the number of files successfully registered.
    """
    if not items:
        return 0

    async def _do_all():
        if owner_user_id:
            from shared.inbound_registration import resolve_person

            principal = await resolve_person(owner_user_id)
        else:
            principal = await _resolve_owner()
        if principal is None:
            return 0
        from hermes_cli.file_registry import store_and_register

        registered = 0
        for item in items:
            data = item.pop("data", b"")
            if not data:
                continue
            try:
                asset = await store_and_register(principal, data, **item)
                if asset is not None:
                    registered += 1
            except Exception as exc:
                logger.warning(
                    "file registration: could not register %r (%s)",
                    item.get("filename", "?"),
                    exc,
                )
        return registered

    try:
        return asyncio.run(_do_all())
    except Exception as exc:
        logger.warning("file registration: batch failed: %s", exc)
        return 0
