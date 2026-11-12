"""Whose item this is, and where that person hears about it (FG-38 P3).

Escalations, digests and to-do pushes used to go to one Telegram chat, the
first ``TELEGRAM_ALLOWED_USERS`` entry, whoever the item belonged to. Each item
now goes to its arrival's person (the owner the pollers registered it under):

* to their linked Telegram (a ``telegram:`` channel on their principal);
* else, for the install owner, to the box's Telegram chat, as before;
* else to that person's agent-home notifications, never to someone else.

With no people store configured (a single-user install) everything is the
install's, and the box chat keeps getting it.
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
from typing import Callable, Iterable, Optional

logger = logging.getLogger(__name__)

Arrival = tuple  # (surface, account_id, external_id)


class LookupUnavailable(Exception):
    """The people store or the inbound registry could not be asked; retry later."""


def box_chat() -> str:
    return os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",")[0].strip()


def telegram_chat(person, owner_user_id: Optional[str]) -> Optional[str]:
    """The Telegram chat ``person`` is reached on, or ``None``."""
    for channel in getattr(person, "channels", ()) or ():
        platform, _, handle = str(channel).partition(":")
        if platform == "telegram" and handle:
            return handle
    if owner_user_id and person.user_id == owner_user_id:
        return box_chat() or None
    return None


async def _lookup(arrivals: list) -> tuple:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    store = get_store("supabase-app", "prod", config=load_config() or {})
    if not getattr(store, "dsn", None):
        return None, {}
    people = PrincipalStore(store)
    owner = await people.get_owner()
    if owner is None:
        raise LookupUnavailable("no install owner is enrolled")
    from hermes_cli.inbound_registry import default_registry

    registry = default_registry("prod")
    known = {owner.user_id: owner}
    found: dict = {}
    for arrival in arrivals:
        if arrival in found:
            continue
        surface, account_id, external_id = arrival
        ids = []
        if external_id:
            ids = await registry.owners_for(
                owner,
                surface=surface,
                external_id=str(external_id),
                account_id=account_id or "",
            )
        if not ids:
            # Never registered (or from before registration): the owner's, as before.
            found[arrival] = [owner]
            continue
        live = []
        for user_id in ids:
            if user_id not in known:
                known[user_id] = await people.get(user_id)
            person = known[user_id]
            if person is not None and getattr(person, "active", True):
                live.append(person)
        found[arrival] = live
    return owner, found


def resolve_people(arrivals: Iterable[Arrival]) -> tuple:
    """``(install_owner, {arrival: [live people]})`` for channel arrivals.

    ``install_owner`` is ``None`` on a single-user install (no people store).
    An arrival whose people are all deactivated maps to ``[]``: nobody is told.
    Raises :class:`LookupUnavailable` rather than guessing when the stores are
    down, so a caller keeps the item and tries again.
    """
    try:
        return asyncio.run(_lookup(list(arrivals)))
    except LookupUnavailable:
        raise
    except Exception as exc:
        raise LookupUnavailable(str(exc)) from exc


def _plain(text: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", text or "")).strip()


def notify_in_app(person, *, title: str, text: str, dedupe_key: str) -> bool:
    """Put ``text`` in ``person``'s agent-home notifications. Never raises."""
    try:
        from hermes_cli.todo_notifier import default_stores

        _store, notifications = default_stores()
        asyncio.run(
            notifications.create(
                kind="proactive_ask",
                target_user_id=person.user_id,
                title=title,
                body=_plain(text),
                dedupe_key=dedupe_key,
            )
        )
        return True
    except Exception as exc:
        logger.warning("could not notify %s in the app (%s)", person.user_id, exc)
        return False


def deliver(
    person,
    owner,
    text: str,
    *,
    send: Callable[..., bool],
    title: str,
    dedupe_key: str,
) -> bool:
    """Tell ``person`` (and only them) ``text``; ``True`` once they have it."""
    chat = telegram_chat(person, getattr(owner, "user_id", None))
    if chat:
        return bool(send(text, parse_mode="HTML", chat_id=chat))
    return notify_in_app(person, title=title, text=text, dedupe_key=dedupe_key)
