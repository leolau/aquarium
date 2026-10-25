"""Per-person WhatsApp bridges in the gateway (Get ready item 5).

A bridge someone added in Settings is recorded as theirs in
``$HERMES_HOME/whatsapp/bridge-owners.json`` (``hermes_cli.wa_bridge_owners``).
For every such bridge that is running and linked to a phone, the gateway runs
one WhatsApp adapter that reads it and:

* handles only messages the person writes to themselves from that phone
  (sender and chat = the bridge's own number, the "Message yourself" chat);
  any other sender or chat is dropped at intake by the adapter's existing
  ``allowlist`` DM rule, and groups are off;
* handles every message as the bridge's person (``internal_user_id`` is
  stamped from the recorded person, never resolved from the sender);
* replies through the same bridge (``account_id = "wabridge:<name>"``).

Bridges with no recorded person (made before per-person bridges, e.g. read by
the custom batcher) are never read here, nor is the bridge the main WhatsApp
adapter already reads. The bridge's ``/messages`` queue is drain-on-read, so a
second reader would steal messages.

The set is re-read every few seconds (and right after Settings changes a
bridge, via ``$HERMES_HOME/whatsapp/bridges.changed``), so a bridge that stops,
unlinks or disappears goes quiet without a gateway restart.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from gateway.config import Platform, PlatformConfig

logger = logging.getLogger(__name__)

ACCOUNT_PREFIX = "wabridge:"
_POLL_SECONDS = 10.0
_PERSON_ACTIVE_TTL = 60.0


@dataclass(frozen=True)
class PersonBridgeSpec:
    name: str
    person: str
    port: int
    own_number: str
    session_path: str

    @property
    def account_id(self) -> str:
        return f"{ACCOUNT_PREFIX}{self.name}"


def _unit_active(name: str) -> bool:
    try:
        out = subprocess.run(
            ["systemctl", "is-active", f"hermes-wa-bridge-{name}.service"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return False
    return out.stdout.strip() == "active"


def desired_person_bridges(
    *,
    is_active: Optional[Callable[[str], bool]] = None,
    skip_ports: frozenset = frozenset(),
    person_active: Optional[Callable[[str], bool]] = None,
) -> Dict[str, PersonBridgeSpec]:
    """Recorded, running, linked bridges keyed by account id.

    With ``person_active``, bridges whose person it rejects are left out.
    """
    from hermes_cli import wa_bridge_owners as owners

    is_active = is_active or _unit_active
    specs: Dict[str, PersonBridgeSpec] = {}
    for name, rec in sorted(owners.load_owners().items()):
        port = rec.get("port")
        number = owners.own_number(name)
        if not isinstance(port, int) or port <= 0 or port in skip_ports or not number:
            continue
        session = owners.session_dir(name)
        if (session / "qr.txt").exists() or not is_active(name):
            continue
        if person_active is not None and not person_active(rec["user_id"]):
            continue
        spec = PersonBridgeSpec(name, rec["user_id"], port, number, str(session))
        specs[spec.account_id] = spec
    return specs


class PersonWhatsAppBridgesMixin:
    """Lifecycle + routing for per-person WhatsApp bridges on ``GatewayRunner``."""

    def _person_wa_adapters(self) -> Dict[str, Any]:
        live = getattr(self, "_person_wa_adapter_map", None)
        if live is None:
            live = self._person_wa_adapter_map = {}
        return live

    def _person_wa_specs(self) -> Dict[str, PersonBridgeSpec]:
        specs = getattr(self, "_person_wa_spec_map", None)
        if specs is None:
            specs = self._person_wa_spec_map = {}
        return specs

    def _person_wa_authorization(self, source: Any) -> Optional[bool]:
        """``None`` for any other source; else whether this message may be handled."""
        account_id = str(getattr(source, "account_id", None) or "")
        if not account_id.startswith(ACCOUNT_PREFIX):
            return None
        spec = self._person_wa_specs().get(account_id)
        if spec is None or getattr(source, "platform", None) != Platform.WHATSAPP:
            return False
        if not self._person_wa_person_active(spec.person):
            return False
        from gateway.whatsapp_identity import normalize_whatsapp_identifier

        return bool(
            getattr(source, "chat_type", None) == "dm"
            and normalize_whatsapp_identifier(getattr(source, "user_id", None) or "") == spec.own_number
            and normalize_whatsapp_identifier(getattr(source, "chat_id", None) or "") == spec.own_number
        )

    def _person_wa_active_cache(self) -> Dict[str, float]:
        cache = getattr(self, "_person_wa_active_map", None)
        if cache is None:
            cache = self._person_wa_active_map = {}
        return cache

    def _person_wa_person_active(self, person: str) -> bool:
        checked = self._person_wa_active_cache().get(person)
        return checked is not None and time.monotonic() - checked < _PERSON_ACTIVE_TTL

    async def _person_wa_refresh_person(self, person: str):
        principal = await self._person_bot_owner(person)
        cache = self._person_wa_active_cache()
        if principal is None:
            cache.pop(person, None)
        else:
            cache[person] = time.monotonic()
        return principal

    def _main_whatsapp_port(self) -> Optional[int]:
        main = (getattr(self, "adapters", None) or {}).get(Platform.WHATSAPP)
        port = getattr(main, "_bridge_port", None)
        return port if isinstance(port, int) else None

    async def _reconcile_person_whatsapp_bridges(self) -> None:
        from hermes_cli import wa_bridge_owners as owners

        main_port = self._main_whatsapp_port()
        try:
            people = {rec["user_id"] for rec in (await asyncio.to_thread(owners.load_owners)).values()}
            active_people = {p for p in people if await self._person_wa_refresh_person(p) is not None}
            desired = await asyncio.to_thread(
                desired_person_bridges,
                skip_ports=frozenset({main_port}) if main_port else frozenset(),
                person_active=active_people.__contains__,
            )
        except Exception:
            logger.warning("Could not read per-person WhatsApp bridges", exc_info=True)
            return
        specs = self._person_wa_specs()
        for account_id in list(specs):
            if desired.get(account_id) != specs[account_id]:
                await self._stop_person_wa(account_id)
        for account_id, spec in desired.items():
            if account_id not in self._person_wa_adapters():
                await self._start_person_wa(spec)

    async def _start_person_wa(self, spec: PersonBridgeSpec) -> bool:
        config = PlatformConfig(
            enabled=True,
            extra={
                "account_id": spec.account_id,
                "bridge_name": spec.name,
                "bridge_port": spec.port,
                "session_path": spec.session_path,
                "external_bridge": True,
                "dm_policy": "allowlist",
                "allow_from": [spec.own_number],
                "group_policy": "disabled",
            },
        )
        adapter = self._create_adapter(Platform.WHATSAPP, config)
        if adapter is None:
            return False
        adapter.set_message_handler(self._make_person_wa_handler(spec.account_id))
        adapter.set_fatal_error_handler(self._handle_person_wa_fatal_error)
        adapter.set_session_store(self.session_store)
        adapter.set_busy_session_handler(self._handle_active_session_busy_message)
        adapter.set_authorization_check(self._make_person_wa_auth_check(spec.account_id))
        adapter._busy_text_mode = getattr(self, "_busy_text_mode", None)
        self._person_wa_specs()[spec.account_id] = spec
        self._person_wa_adapters()[spec.account_id] = adapter
        try:
            ok = await self._connect_adapter_with_timeout(adapter, Platform.WHATSAPP)
        except Exception:
            logger.warning("WhatsApp bridge %s: listener failed to start", spec.name, exc_info=True)
            ok = False
        if not ok:
            await self._stop_person_wa(spec.account_id)
            return False
        logger.info("✓ whatsapp connected (person bridge %s)", spec.name)
        return True

    async def _stop_person_wa(self, account_id: str) -> None:
        self._person_wa_specs().pop(account_id, None)
        adapter = self._person_wa_adapters().pop(account_id, None)
        if adapter is not None:
            await self._safe_adapter_disconnect(adapter, Platform.WHATSAPP)

    async def _handle_person_wa_fatal_error(self, adapter: Any) -> None:
        for account_id, live in list(self._person_wa_adapters().items()):
            if live is adapter:
                logger.warning("WhatsApp listener %s stopped after an error; will retry", account_id)
                await self._stop_person_wa(account_id)

    def _make_person_wa_auth_check(self, account_id: str):
        def check(user_id: str, chat_type: Optional[str] = None, chat_id: Optional[str] = None) -> bool:
            from gateway.whatsapp_identity import normalize_whatsapp_identifier

            spec = self._person_wa_specs().get(account_id)
            return bool(
                spec
                and normalize_whatsapp_identifier(user_id or "") == spec.own_number
                and chat_type in (None, "dm")
            )

        return check

    def _make_person_wa_handler(self, account_id: str):
        async def _handler(event):
            source = getattr(event, "source", None)
            spec = self._person_wa_specs().get(account_id)
            if source is None or spec is None:
                return None
            source.account_id = account_id
            principal = await self._person_wa_refresh_person(spec.person)
            if principal is None:
                logger.warning("WhatsApp bridge %s: its person is not active; ignored", spec.name)
                return None
            if not self._person_wa_authorization(source):
                logger.info("WhatsApp bridge %s: ignored a message not from its own person", spec.name)
                return None
            source.internal_user_id = principal.user_id
            source.internal_user_role = principal.role
            return await self._handle_message(event)

        return _handler

    def _person_wa_marker_mtime(self) -> float:
        from hermes_cli.wa_bridge_owners import CHANGE_MARKER, whatsapp_dir

        try:
            return (whatsapp_dir() / CHANGE_MARKER).stat().st_mtime
        except OSError:
            return 0.0

    async def _person_whatsapp_bridges_loop(self) -> None:
        seen = None
        waited = _POLL_SECONDS
        while getattr(self, "_running", False):
            mtime = self._person_wa_marker_mtime()
            if mtime != seen or waited >= _POLL_SECONDS:
                seen, waited = mtime, 0.0
                try:
                    await self._reconcile_person_whatsapp_bridges()
                except Exception:
                    logger.warning("Per-person WhatsApp bridge sync failed", exc_info=True)
            await asyncio.sleep(2.0)
            waited += 2.0

    async def _stop_all_person_wa(self) -> None:
        for account_id in list(self._person_wa_adapters()):
            await self._stop_person_wa(account_id)
