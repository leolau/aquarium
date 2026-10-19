"""Per-person Telegram bots (Get ready item 6).

Each person may save their own @BotFather bot under ``/api/telegram-bot``
(``hermes_cli/telegram_bot_api.py``; credential kind ``telegram-bot``). Once
the person has linked their Telegram account, the gateway runs that bot next
to the install-wide bot (``TELEGRAM_BOT_TOKEN``, untouched) and:

* accepts only private chats from the linked Telegram id (adapter
  ``allow_from`` at intake, re-checked in :meth:`_person_bot_authorization`);
* handles every message as the bot's owner (``internal_user_id`` is stamped
  from the credential owner, never resolved from the sender);
* replies through the same bot (``account_id = "tgbot:<bot id>"``).

Adding, changing or removing one person's bot starts/stops only that bot.
The API touches ``$HERMES_HOME/telegram_bots.changed`` after every change;
the loop below notices within a few seconds and also re-reads periodically.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from gateway.config import Platform, PlatformConfig

logger = logging.getLogger(__name__)

ACCOUNT_PREFIX = "tgbot:"
_POLL_SECONDS = 5.0
_FULL_RESYNC_SECONDS = 300.0


@dataclass(frozen=True)
class PersonBotSpec:
    account_id: str
    owner_user_id: str
    linked_user_id: str
    token: str

    @property
    def fingerprint(self) -> str:
        raw = f"{self.owner_user_id}|{self.linked_user_id}|{self.token}"
        return hashlib.sha256(raw.encode()).hexdigest()


def desired_person_bots(entries: List[Any], *, install_token: str = "") -> Dict[str, PersonBotSpec]:
    """Linked ``telegram-bot`` entries keyed by account id.

    A bot claimed by two owners, or the install bot itself, is never run.
    """
    install_bot_id = install_token.split(":", 1)[0] if install_token else ""
    specs: Dict[str, PersonBotSpec] = {}
    clashes = set()
    for cred in entries:
        payload = getattr(cred, "payload", None) or {}
        token = str(payload.get("token") or "").strip()
        linked = str(payload.get("linked_user_id") or "").strip()
        if not token or not linked or getattr(cred, "kind", "") != "telegram-bot":
            continue
        bot_id = token.split(":", 1)[0]
        if bot_id == install_bot_id:
            continue
        account_id = f"{ACCOUNT_PREFIX}{bot_id}"
        if account_id in specs:
            clashes.add(account_id)
            continue
        specs[account_id] = PersonBotSpec(account_id, str(cred.owner_user_id), linked, token)
    for account_id in clashes:
        logger.error("Telegram bot %s is saved by more than one person; not running it", account_id)
        specs.pop(account_id, None)
    return specs


class PersonTelegramBotsMixin:
    """Lifecycle + routing for per-person Telegram bots on ``GatewayRunner``."""

    def _person_bots(self) -> Dict[str, Any]:
        bots = getattr(self, "_person_bot_adapters", None)
        if bots is None:
            bots = self._person_bot_adapters = {}
        return bots

    def _person_bot_spec_map(self) -> Dict[str, PersonBotSpec]:
        specs = getattr(self, "_person_bot_specs", None)
        if specs is None:
            specs = self._person_bot_specs = {}
        return specs

    def _source_adapter(self, source: Any):
        """The adapter a reply to ``source`` must leave through."""
        account_id = getattr(source, "account_id", None)
        if account_id and str(account_id).startswith(ACCOUNT_PREFIX):
            return self._person_bots().get(str(account_id))
        return self.adapters.get(source.platform)

    def _person_bot_authorization(self, source: Any) -> Optional[bool]:
        """``None`` for any other source; else whether the sender may use the bot."""
        account_id = str(getattr(source, "account_id", None) or "")
        if not account_id.startswith(ACCOUNT_PREFIX):
            return None
        spec = self._person_bot_spec_map().get(account_id)
        return bool(
            spec is not None
            and getattr(source, "platform", None) == Platform.TELEGRAM
            and getattr(source, "chat_type", None) == "dm"
            and str(getattr(source, "user_id", None) or "") == spec.linked_user_id
        )

    async def _load_person_bot_entries(self) -> List[Any]:
        from hermes_cli.credential_store import default_credential_store

        return await default_credential_store().resolve_by_kind("telegram-bot", provider="telegram")

    async def _reconcile_person_telegram_bots(self) -> None:
        try:
            entries = await self._load_person_bot_entries()
        except Exception:
            logger.warning("Could not read per-person Telegram bots", exc_info=True)
            return
        desired = desired_person_bots(entries, install_token=os.getenv("TELEGRAM_BOT_TOKEN", "").strip())
        specs = self._person_bot_spec_map()
        bots = self._person_bots()
        for account_id in list(specs):
            want = desired.get(account_id)
            if want is None or want.fingerprint != specs[account_id].fingerprint:
                await self._stop_person_bot(account_id)
        for account_id, spec in desired.items():
            if account_id not in bots:
                await self._start_person_bot(spec)

    async def _start_person_bot(self, spec: PersonBotSpec) -> bool:
        config = PlatformConfig(
            enabled=True,
            token=spec.token,
            extra={
                "account_id": spec.account_id,
                "allow_from": [spec.linked_user_id],
                "force_polling": True,
            },
        )
        adapter = self._create_adapter(Platform.TELEGRAM, config)
        if adapter is None:
            return False
        adapter.set_message_handler(self._make_person_bot_message_handler(spec.account_id))
        adapter.set_fatal_error_handler(self._handle_person_bot_fatal_error)
        adapter.set_session_store(self.session_store)
        adapter.set_busy_session_handler(self._handle_active_session_busy_message)
        adapter.set_authorization_check(self._make_person_bot_auth_check(spec.account_id))
        adapter._busy_text_mode = getattr(self, "_busy_text_mode", None)
        # Registered before connect so an early message already routes here.
        self._person_bot_spec_map()[spec.account_id] = spec
        self._person_bots()[spec.account_id] = adapter
        try:
            ok = await self._connect_adapter_with_timeout(adapter, Platform.TELEGRAM)
        except Exception:
            logger.warning("Telegram bot %s failed to start", spec.account_id, exc_info=True)
            ok = False
        if not ok:
            await self._stop_person_bot(spec.account_id)
            return False
        logger.info("✓ telegram connected (person bot %s)", spec.account_id)
        return True

    async def _stop_person_bot(self, account_id: str) -> None:
        self._person_bot_spec_map().pop(account_id, None)
        adapter = self._person_bots().pop(account_id, None)
        if adapter is not None:
            await self._safe_adapter_disconnect(adapter, Platform.TELEGRAM)

    async def _handle_person_bot_fatal_error(self, adapter: Any) -> None:
        for account_id, live in list(self._person_bots().items()):
            if live is adapter:
                logger.warning("Telegram bot %s stopped after an error; will retry", account_id)
                await self._stop_person_bot(account_id)

    def _make_person_bot_auth_check(self, account_id: str):
        def check(user_id: str, chat_type: Optional[str] = None, chat_id: Optional[str] = None) -> bool:
            spec = self._person_bot_spec_map().get(account_id)
            return bool(spec and str(user_id or "") == spec.linked_user_id and chat_type in (None, "dm"))

        return check

    def _make_person_bot_message_handler(self, account_id: str):
        async def _handler(event):
            source = getattr(event, "source", None)
            spec = self._person_bot_spec_map().get(account_id)
            if source is None or spec is None:
                return None
            source.account_id = account_id
            if not self._person_bot_authorization(source):
                logger.info("Ignored a message to Telegram bot %s from an unlinked sender", account_id)
                return None
            principal = await self._person_bot_owner(spec.owner_user_id)
            if principal is None:
                logger.warning("Telegram bot %s: owner is not an active person; ignored", account_id)
                return None
            source.internal_user_id = principal.user_id
            source.internal_user_role = principal.role
            return await self._handle_message(event)

        return _handler

    async def _person_bot_owner(self, owner_user_id: str):
        store = self._get_principal_store()
        if store is None:
            return None
        try:
            principal = await store.get(owner_user_id)
        except Exception:
            logger.warning("Could not resolve the owner of a Telegram bot", exc_info=True)
            return None
        if principal is None or not getattr(principal, "active", True):
            return None
        return principal

    def _person_bot_marker_mtime(self) -> float:
        from hermes_cli.telegram_bot_api import CHANGE_MARKER
        from hermes_constants import get_hermes_home

        try:
            return (get_hermes_home() / CHANGE_MARKER).stat().st_mtime
        except OSError:
            return 0.0

    async def _person_telegram_bots_loop(self) -> None:
        seen = None
        since_full = 0.0
        while getattr(self, "_running", False):
            mtime = self._person_bot_marker_mtime()
            if mtime != seen or since_full >= _FULL_RESYNC_SECONDS:
                seen = mtime
                since_full = 0.0
                try:
                    await self._reconcile_person_telegram_bots()
                except Exception:
                    logger.warning("Per-person Telegram bot sync failed", exc_info=True)
            await asyncio.sleep(_POLL_SECONDS)
            since_full += _POLL_SECONDS

    async def _stop_all_person_bots(self) -> None:
        for account_id in list(self._person_bots()):
            await self._stop_person_bot(account_id)
