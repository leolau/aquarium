#!/usr/bin/env python3
"""Shared to-do registration for standalone services (triage, pollers, cron).

The sibling of :mod:`shared.inbound_registration`, for what should *happen*
about an arrival rather than the arrival itself. Triage runs in its own
process against the pipeline's SQLite and never touches the gateway, so the
judgement it forms — "this one needs an answer by Friday" — dies in a table
nobody looks at. This module is the bridge to the shared, principal-scoped
to-do store that ``agent-home`` reads.

Best-effort, always. If Supabase is unconfigured, the owner principal cannot be
resolved, or Postgres is briefly down, the call returns ``None`` and triage
carries on: a missing to-do costs the user a nudge, while an exception here
would cost them the message.

The plan is ``docs/plans/2026-08-11-001-todos-staging-layer-plan.md``.
"""

import asyncio
import logging
from html import escape as _esc
from datetime import datetime, time, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Owner-principal resolution, identical in shape to inbound_registration's: a
# retry-after guard rather than a sticky cache, so a startup race recovers on
# the next batch instead of needing a restart.
_owner_principal: Optional[object] = None
_owner_resolved: bool = False
_owner_last_attempt: float = 0.0
_OWNER_RETRY_INTERVAL_SEC: float = 60.0

#: Most of what triage reads implies *something* that could be written down.
#: Without a ceiling one chatty morning fills the list, the user mutes it, and
#: the feature is dead — so a batch may contribute at most this many to-dos,
#: highest priority first.
MAX_TODOS_PER_BATCH = 3

#: Triage speaks high/medium/low; the store speaks critical/high/normal/low.
_PRIORITY_MAP = {
    "critical": "critical",
    "urgent": "critical",
    "high": "high",
    "medium": "normal",
    "normal": "normal",
    "low": "low",
}
_PRIORITY_RANK = {"critical": 0, "high": 1, "normal": 2, "low": 3}


async def resolve_owner():
    """Resolve the owner principal, retrying periodically after a failure.

    ``None`` when Supabase is unconfigured or unreachable — the caller skips
    its write rather than failing.
    """
    import time as _time

    global _owner_principal, _owner_resolved, _owner_last_attempt
    if _owner_resolved:
        return _owner_principal
    now = _time.monotonic()
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
            "todo registration: no owner principal in PrincipalStore; to-dos "
            "from standalone services will not be recorded (retrying in %ds)",
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    except Exception as exc:
        logger.warning(
            "todo registration: could not resolve owner: %s (retrying in %ds)",
            exc,
            int(_OWNER_RETRY_INTERVAL_SEC),
        )
    return _owner_principal


def normalize_priority(value: Any) -> str:
    """Map a triage priority onto the store's vocabulary."""
    return _PRIORITY_MAP.get(str(value or "").strip().lower(), "normal")


def parse_due(value: Any) -> Optional[datetime]:
    """Coerce a triage due date to an aware UTC datetime, or ``None``.

    A bare ``YYYY-MM-DD`` means end of that day: a to-do due Friday is not
    overdue at one minute past midnight on Friday.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text or text.lower() in ("null", "none"):
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        logger.debug("todo registration: unparseable due date %r", value)
        return None
    if len(text) == 10:
        parsed = datetime.combine(parsed.date(), time(23, 59, 59))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def select_candidates(candidates: list, limit: int = MAX_TODOS_PER_BATCH) -> list:
    """The at-most-``limit`` candidates worth recording, most urgent first.

    Sorting before truncating matters: the batch that produces five candidates
    is exactly the batch where the one that mattered must not be the one cut.
    Ties keep the order triage produced, which is the order it read them in.
    """
    ranked = sorted(
        enumerate(candidates),
        key=lambda pair: (
            _PRIORITY_RANK.get(normalize_priority(pair[1].get("priority")), 2),
            0 if pair[1].get("notify") else 1,
            pair[0],
        ),
    )
    return [item for _, item in ranked[: max(0, limit)]]


def register_todo(
    *,
    title: str,
    description: str = "",
    priority: str = "normal",
    due_date: Any = None,
    notify: bool = False,
    source_kind: str = "inbound",
    surface: Optional[str] = None,
    account_id: Optional[str] = None,
    external_id: Optional[str] = None,
    source_note: Optional[str] = None,
    actor: str = "skill:triage",
    origin: str = "triage",
) -> Optional[dict]:
    """Record one to-do. Never raises.

    Returns ``{"id", "stage", "created"}`` when written and ``None`` otherwise.
    ``created`` is ``False`` when this collapsed onto a live to-do that already
    said the same thing, which is how the caller avoids notifying twice.

    When ``surface``/``external_id`` identify a registered arrival the to-do is
    linked to it, so the page can show the message behind the ask. When they do
    not — the arrival was never registered, or the registry is unreachable —
    the to-do is still created, with ``source_note`` carrying whatever context
    is left. A to-do with weak provenance beats no to-do.
    """
    clean_title = (title or "").strip()
    if not clean_title:
        return None
    try:
        from hermes_cli.todo_notifier import announce, default_stores

        async def _do() -> Optional[dict]:
            principal = await resolve_owner()
            if principal is None:
                return None
            source_ref = None
            if surface and external_id:
                source_ref = await _lookup_arrival(
                    principal,
                    surface=surface,
                    account_id=account_id or "",
                    external_id=external_id,
                )
            note = source_note
            if source_ref is None and surface and external_id and not note:
                note = f"{surface}:{external_id}"
            store, notifications = default_stores()
            todo = await store.create(
                principal,
                title=clean_title,
                description=description or "",
                stage="open" if notify else "staged",
                priority=normalize_priority(priority),
                due_at=parse_due(due_date),
                source_kind=source_kind,
                source_ref=source_ref,
                source_note=note,
                origin=origin,
                actor=actor,
            )
            pushed = False
            if todo.stage == "open" and todo.notified_at is None:
                # Announcing inline is the fast path: the sweep in the digest
                # would find this row anyway, but an hour later, and "reply by
                # noon" is not useful at one.
                result = await announce(store, notifications, principal, todo)
                pushed = result.should_push and push_todo(todo.title, result)
            return {
                "id": todo.id,
                "stage": todo.stage,
                "created": todo.created,
                "push": pushed,
            }

        return asyncio.run(_do())
    except Exception as exc:
        logger.warning(
            "todo registration: could not record %r (%s)", clean_title, exc
        )
        return None


def push_todo(title: str, announcement) -> bool:
    """Push a high-priority to-do to Telegram now. Never raises.

    Reuses the escalation pusher's sender rather than adding a second Telegram
    client: same bot, same chat, same failure handling. Whether a push is
    warranted was already decided under C6 (priority bar, quiet hours) — this
    only carries it out.
    """
    try:
        from shared.escalation_pusher_v2 import send_telegram

        text = f"\u2705 <b>New to-do</b>\n{_esc(title)}"
        if announcement.body:
            text += f"\n<i>{_esc(announcement.body)}</i>"
        return bool(send_telegram(text, parse_mode="HTML"))
    except Exception as exc:
        logger.warning("todo registration: could not push %r (%s)", title, exc)
        return False


async def _lookup_arrival(
    principal,
    *,
    surface: str,
    account_id: str,
    external_id: str,
) -> Optional[str]:
    """The registry id of the arrival this to-do came from, if it has one."""
    try:
        from hermes_cli.inbound_registry import default_registry

        return await default_registry("prod").id_for(
            principal,
            surface=surface,
            account_id=account_id,
            external_id=external_id,
        )
    except Exception as exc:
        logger.debug("todo registration: no arrival link (%s)", exc)
        return None


def expire_staged(older_than_days: int = 14) -> int:
    """Dismiss staged to-dos nobody touched. Never raises; returns the count.

    The other half of capturing generously — run from the digest cron, so the
    list a user opens is the list of things still worth their attention.
    """
    try:
        from hermes_cli.todo_store import default_store

        async def _do() -> int:
            principal = await resolve_owner()
            if principal is None:
                return 0
            return await default_store("prod").expire_staged(
                principal, older_than_days=older_than_days
            )

        return asyncio.run(_do())
    except Exception as exc:
        logger.warning("todo registration: staged sweep failed (%s)", exc)
        return 0
