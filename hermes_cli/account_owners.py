"""Who each box-wide account's arrivals belong to (FG-38 P2b).

Settings › Accounts lets the owner name a person for a mailbox, a calendar or
a WhatsApp phone. The pollers read this map first; without a row they fall
back to the poller config entry, then whoever connected the account, then the
install owner. A choice applies to arrivals from then on: an item's identity
includes its owner, so existing items stay where they are until they are
moved explicitly.

Only the owner role reads or writes the map (FORCE row-level security), and a
choice moves data ownership only: the account's saved login stays with
whoever saved it.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
import logging
import os
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    List,
    Optional,
    Tuple,
    TypeVar,
)

from hermes_cli.access import GUC_PRINCIPAL_ROLE, Principal, bind_principal

if TYPE_CHECKING:
    import asyncpg

    from hermes_cli.datastore import SupabaseAppStore

logger = logging.getLogger(__name__)
T = TypeVar("T")

ACCOUNT_OWNERS_TABLE = "account_owners"
SURFACES: Tuple[str, ...] = ("email", "calendar", "whatsapp")
_SURFACES_SQL = ", ".join(f"'{s}'" for s in SURFACES)

SCHEMA_SQL = f"""
CREATE TABLE IF NOT EXISTS {ACCOUNT_OWNERS_TABLE} (
    surface TEXT NOT NULL CHECK (surface IN ({_SURFACES_SQL})),
    account_key TEXT NOT NULL CHECK (account_key <> ''),
    owner_user_id TEXT NOT NULL REFERENCES principals(user_id) ON DELETE CASCADE,
    set_by TEXT NOT NULL,
    set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (surface, account_key)
);
"""

RLS_SQL = f"""
ALTER TABLE {ACCOUNT_OWNERS_TABLE} ENABLE ROW LEVEL SECURITY;
ALTER TABLE {ACCOUNT_OWNERS_TABLE} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hermes_account_owners_owner ON {ACCOUNT_OWNERS_TABLE};
CREATE POLICY hermes_account_owners_owner ON {ACCOUNT_OWNERS_TABLE}
    FOR ALL
    USING (current_setting('{GUC_PRINCIPAL_ROLE}', true) = 'owner')
    WITH CHECK (current_setting('{GUC_PRINCIPAL_ROLE}', true) = 'owner');
"""

#: How long a poller trusts its copy of the map; a Settings change reaches
#: new arrivals within this many seconds.
CACHE_SECONDS = 60.0


class NotOwner(PermissionError):
    """Only the owner manages who an account belongs to."""


def account_key(surface: str, account: Any) -> str:
    """The map key: a lower-cased address, or a WhatsApp phone's id as is."""
    if surface not in SURFACES:
        raise ValueError(f"unknown surface: {surface!r}")
    key = str(account or "").strip()
    if surface != "whatsapp":
        key = key.lower()
    if not key or len(key) > 320:
        raise ValueError("an account is required")
    return key


@dataclass(frozen=True)
class AccountOwner:
    surface: str
    account_key: str
    owner_user_id: str
    set_by: str
    set_at: datetime

    def as_dict(self) -> Dict[str, Any]:
        return {
            "surface": self.surface,
            "account": self.account_key,
            "owner_user_id": self.owner_user_id,
            "set_by": self.set_by,
            "set_at": self.set_at.isoformat(),
        }


def _row(row: Any) -> AccountOwner:
    return AccountOwner(
        surface=row["surface"],
        account_key=row["account_key"],
        owner_user_id=row["owner_user_id"],
        set_by=row["set_by"],
        set_at=row["set_at"],
    )


class AccountOwnerStore:
    """The owner's account → person choices in one profile's schema."""

    def __init__(self, app_store: "SupabaseAppStore") -> None:
        self._store = app_store

    async def initialize(self, *, connection: Optional["asyncpg.Connection"] = None) -> None:
        """Create the table and its owner-only policy. Idempotent."""
        from hermes_cli.access import initialize_access

        own = connection is None
        conn = connection or await self._store.connect()
        try:
            await initialize_access(conn)
            await conn.execute(SCHEMA_SQL)
            await conn.execute(RLS_SQL)
        finally:
            if own:
                await conn.close()

    @contextlib.asynccontextmanager
    async def _session(self, principal: Principal) -> AsyncIterator["asyncpg.Connection"]:
        if not getattr(principal, "is_owner", False):
            raise NotOwner("accounts are assigned by the owner")
        conn = await self._store.connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                yield conn
        finally:
            await conn.close()

    async def list(self, principal: Principal) -> List[AccountOwner]:
        async with self._session(principal) as conn:
            rows = await conn.fetch(
                f"SELECT * FROM {ACCOUNT_OWNERS_TABLE} ORDER BY surface, account_key"
            )
        return [_row(r) for r in rows]

    async def get(self, principal: Principal, surface: str, account: Any) -> Optional[str]:
        key = account_key(surface, account)
        async with self._session(principal) as conn:
            return await conn.fetchval(
                f"SELECT owner_user_id FROM {ACCOUNT_OWNERS_TABLE} "
                "WHERE surface = $1 AND account_key = $2",
                surface,
                key,
            )

    async def set(
        self,
        principal: Principal,
        surface: str,
        account: Any,
        owner_user_id: Optional[str],
    ) -> Optional[AccountOwner]:
        """Name ``owner_user_id`` for the account, or clear the choice (None).

        Returns the previous choice. The person must be enrolled and active.
        """
        key = account_key(surface, account)
        async with self._session(principal) as conn:
            prev = await conn.fetchrow(
                f"SELECT * FROM {ACCOUNT_OWNERS_TABLE} "
                "WHERE surface = $1 AND account_key = $2 FOR UPDATE",
                surface,
                key,
            )
            if owner_user_id is None:
                await conn.execute(
                    f"DELETE FROM {ACCOUNT_OWNERS_TABLE} WHERE surface = $1 AND account_key = $2",
                    surface,
                    key,
                )
            else:
                active = await conn.fetchval(
                    "SELECT active FROM principals WHERE user_id = $1", owner_user_id
                )
                if not active:
                    raise ValueError("no active person with that id")
                await conn.execute(
                    f"""
                    INSERT INTO {ACCOUNT_OWNERS_TABLE} (surface, account_key, owner_user_id, set_by)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (surface, account_key) DO UPDATE
                        SET owner_user_id = EXCLUDED.owner_user_id,
                            set_by = EXCLUDED.set_by,
                            set_at = NOW()
                    """,
                    surface,
                    key,
                    owner_user_id,
                    principal.user_id,
                )
            await _audit(self._store, conn, principal, surface, key, prev, owner_user_id)
        _invalidate()
        return _row(prev) if prev is not None else None


async def _audit(
    app_store: "SupabaseAppStore",
    conn: "asyncpg.Connection",
    principal: Principal,
    surface: str,
    key: str,
    prev: Any,
    owner_user_id: Optional[str],
) -> None:
    """One change-log row per choice, in the same transaction as the choice."""
    from hermes_cli.changes import ChangeLog

    before = prev["owner_user_id"] if prev is not None else None
    await ChangeLog(app_store).record(
        actor_user_id=principal.user_id,
        target_kind="data",
        op={"kind": "account_owner", "surface": surface, "account": key, "owner_user_id": owner_user_id},
        inverse_op=None,
        reversible=False,
        action="account owner cleared" if owner_user_id is None else "account owner set",
        target_ref=f"{ACCOUNT_OWNERS_TABLE}:{surface}:{key}",
        payload={"before": before, "after": owner_user_id},
        approved=True,
        connection=conn,
    )


# -- the accounts Settings lists ---------------------------------------------

EMAIL_CONFIG_PATH = "/opt/data/email-messages/config.json"
CALENDAR_DB_PATH = "/opt/data/calendar/calendar_data.db"
WHATSAPP_CONFIG_PATH = "/opt/data/whatsapp-messages/config.json"


@dataclass(frozen=True)
class AccountPaths:
    """Where the pollers keep their account lists (the pollers' own defaults)."""

    email_config: str = os.environ.get("EMAIL_CONFIG_PATH", EMAIL_CONFIG_PATH)
    calendar_db: str = os.environ.get("CALENDAR_DB_PATH", CALENDAR_DB_PATH)
    whatsapp_config: str = WHATSAPP_CONFIG_PATH


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    return data if isinstance(data, dict) else {}


async def _google_people(service: str) -> Dict[str, str]:
    """``{address: user_id}`` of who connected each Google account for ``service``."""
    from hermes_cli.credential_store import default_credential_store

    entries = await default_credential_store().resolve_for_service(service, provider="google")
    return {e.name.lower(): e.owner_user_id for e in entries if e.owner_user_id}


async def _mailbox_people() -> Dict[str, str]:
    """``{address: user_id}`` of who saved each password mailbox."""
    from hermes_cli.email_mailboxes import all_mailboxes

    people: Dict[str, str] = {}
    for cred in await all_mailboxes():
        if cred.owner_user_id:
            people.setdefault(cred.name.lower(), cred.owner_user_id)
    return people


def _bridge_people() -> Dict[int, str]:
    """``{bridge port: user_id}`` of who added each WhatsApp bridge in Settings."""
    from hermes_cli.wa_bridge_owners import load_owners

    return {
        rec["port"]: rec["user_id"]
        for rec in load_owners().values()
        if isinstance(rec.get("port"), int)
    }


def _email_accounts(paths: AccountPaths) -> List[Dict[str, Any]]:
    return [
        {
            "surface": "email",
            "account": account_key("email", a.get("address")),
            "label": str(a.get("name") or a.get("address")),
            "enabled": bool(a.get("enabled", True)),
            "config_owner": a.get("owner_user_id") or None,
            "_password": a.get("auth") == "password",
            "_google": str(a.get("google_account") or a.get("address") or "").lower(),
        }
        for a in _read_json(paths.email_config).get("accounts", [])
        if isinstance(a, dict) and a.get("address")
    ]


def _calendar_accounts(paths: AccountPaths) -> List[Dict[str, Any]]:
    if not os.path.exists(paths.calendar_db):
        return []
    db = sqlite3.connect(f"file:{paths.calendar_db}?mode=ro", uri=True, timeout=5)
    try:
        rows = db.execute("SELECT email, enabled FROM calendar_accounts").fetchall()
    finally:
        db.close()
    return [
        {
            "surface": "calendar",
            "account": account_key("calendar", email),
            "label": str(email),
            "enabled": bool(enabled),
            "config_owner": None,
        }
        for email, enabled in rows
        if email
    ]


def _whatsapp_accounts(paths: AccountPaths) -> List[Dict[str, Any]]:
    from hermes_cli.wa_bridge_owners import mask_number

    phones = []
    for ph in _read_json(paths.whatsapp_config).get("phones", []):
        if not isinstance(ph, dict) or not ph.get("id"):
            continue
        digits = "".join(c for c in str(ph.get("number") or "") if c.isdigit())
        number = mask_number(digits) if digits else None
        label = str(ph.get("label") or ph["id"])
        phones.append({
            "surface": "whatsapp",
            "account": account_key("whatsapp", ph["id"]),
            "label": f"{label} ({number})" if number else label,
            "enabled": bool(ph.get("enabled", True)),
            "config_owner": ph.get("owner_user_id") or None,
            "_port": ph.get("bridge_port"),
        })
    return phones


async def discover_accounts(
    principal: Principal,
    store: AccountOwnerStore,
    install_owner_id: Optional[str],
    *,
    paths: Optional[AccountPaths] = None,
) -> Dict[str, Any]:
    """Every mailbox, calendar and WhatsApp phone, whose it is and why.

    The pollers' precedence: the owner's Settings choice, then the poller
    config entry, then whoever connected the account, then the install owner.
    A source that can't be read is named in ``unreadable`` rather than failing
    the page.
    """
    paths = paths or AccountPaths()
    chosen = {(c.surface, c.account_key): c for c in await store.list(principal)}
    unreadable: List[str] = []

    async def _try(name: str, fn: Callable[[], Awaitable[T]], empty: T) -> T:
        try:
            return await fn()
        except Exception as exc:
            logger.warning("accounts: could not read %s (%s)", name, exc)
            unreadable.append(name)
            return empty

    async def _sync(fn: Callable[[], T]) -> T:
        return await asyncio.to_thread(fn)

    email = await _try("email", lambda: _sync(lambda: _email_accounts(paths)), [])
    calendar = await _try("calendar", lambda: _sync(lambda: _calendar_accounts(paths)), [])
    whatsapp = await _try("whatsapp", lambda: _sync(lambda: _whatsapp_accounts(paths)), [])
    google_mail = await _try("email credentials", lambda: _google_people("email"), {}) if email else {}
    mailboxes = await _try("email mailboxes", _mailbox_people, {}) if email else {}
    google_cal = await _try("calendar credentials", lambda: _google_people("calendar"), {}) if calendar else {}
    bridges = await _try("whatsapp bridges", lambda: _sync(_bridge_people), {}) if whatsapp else {}

    for a in email:
        a["connected_owner"] = (mailboxes if a.pop("_password") else google_mail).get(a.pop("_google"))
    for a in calendar:
        a["connected_owner"] = google_cal.get(a["account"])
    for a in whatsapp:
        a["connected_owner"] = bridges.get(a.pop("_port"))

    accounts = []
    for a in email + calendar + whatsapp:
        choice = chosen.pop((a["surface"], a["account"]), None)
        a["settings_owner"] = choice.owner_user_id if choice else None
        a["set_by"] = choice.set_by if choice else None
        a["set_at"] = choice.set_at.isoformat() if choice else None
        for source, who in (
            ("settings", a["settings_owner"]),
            ("config", a["config_owner"]),
            ("connected", a["connected_owner"]),
            ("install_owner", install_owner_id),
        ):
            if who:
                a["owner_user_id"], a["source"] = who, source
                break
        else:
            a["owner_user_id"], a["source"] = None, "install_owner"
        accounts.append(a)
    # A choice for an account no poller lists any more still shows, so it can be cleared.
    for c in chosen.values():
        accounts.append({
            "surface": c.surface, "account": c.account_key, "label": c.account_key,
            "enabled": False, "config_owner": None, "connected_owner": None,
            "settings_owner": c.owner_user_id, "set_by": c.set_by,
            "set_at": c.set_at.isoformat(), "owner_user_id": c.owner_user_id,
            "source": "settings",
        })
    return {"accounts": accounts, "unreadable": unreadable}


def default_store() -> AccountOwnerStore:
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    return AccountOwnerStore(get_store("supabase-app", "prod", config=load_config() or {}))


_cache: Optional[Tuple[float, Dict[Tuple[str, str], str]]] = None


def _invalidate() -> None:
    global _cache
    _cache = None


async def _load_map() -> Dict[Tuple[str, str], str]:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    owner = await PrincipalStore(
        get_store("supabase-app", "prod", config=load_config() or {})
    ).get_owner()
    if owner is None:
        return {}
    return {(r.surface, r.account_key): r.owner_user_id for r in await default_store().list(owner)}


def settings_owner(surface: str, account: Any) -> Optional[str]:
    """The person the owner chose in Settings for this account, or None.

    For the synchronous pollers. Never raises: when the map can't be read the
    caller falls through to its next rule. A change reaches a running poller
    within ``CACHE_SECONDS``.
    """
    global _cache
    try:
        key = account_key(surface, account)
    except ValueError:
        return None
    now = time.monotonic()
    if _cache is None or now - _cache[0] > CACHE_SECONDS:
        try:
            _cache = (now, _run_sync(_load_map))
        except Exception as exc:
            logger.warning("account owners: could not read the Settings choices (%s)", exc)
            return None
    return _cache[1].get((surface, key))


def _run_sync(fn: Callable[[], Awaitable[T]]) -> T:
    """``asyncio.run(fn())``, also from a thread that already runs a loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(fn())
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, fn()).result()
