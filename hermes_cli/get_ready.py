"""The P2 "Get ready" checklist: one live status per item for one person.

Eleven items in three groups. "Basics" (1-3) and "Keep it safe" (10-11) are
about the whole install and are owner/admin only; "Your connections" (4-9) are
per person — every person sees *their own* status. Each item's status comes
from one provider function in :data:`STATUS_PROVIDERS` and its "Test" from
:data:`TEST_PROVIDERS`; a unit that builds a feature (2FA, per-person Telegram,
backups, ...) replaces that one function and nothing else.

Status text is returned as a message key plus params (the UI owns the English
and Traditional Chinese wording) and never carries a secret, a message or a
file: only presence, counts and display names.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List, Mapping, Optional

DONE = "done"
ATTENTION = "attention"
NOT_STARTED = "not_started"

BASICS = "basics"
CONNECTIONS = "connections"
SAFETY = "safety"

#: Roles that see and test the install-wide items (groups basics + safety).
MANAGER_ROLES = ("owner", "admin")


@dataclass(frozen=True)
class ItemSpec:
    id: str
    n: int
    group: str
    required: bool

    @property
    def per_person(self) -> bool:
        return self.group == CONNECTIONS


ITEMS: tuple[ItemSpec, ...] = (
    ItemSpec("owner", 1, BASICS, True),
    ItemSpec("model", 2, BASICS, True),
    ItemSpec("people", 3, BASICS, True),
    ItemSpec("google", 4, CONNECTIONS, False),
    ItemSpec("whatsapp", 5, CONNECTIONS, False),
    ItemSpec("telegram", 6, CONNECTIONS, False),
    ItemSpec("email", 7, CONNECTIONS, False),
    ItemSpec("tools", 8, CONNECTIONS, False),
    ItemSpec("vpn", 9, CONNECTIONS, False),
    ItemSpec("backups", 10, SAFETY, True),
    ItemSpec("security", 11, SAFETY, True),
)
ITEMS_BY_ID: Dict[str, ItemSpec] = {item.id: item for item in ITEMS}


@dataclass
class ItemStatus:
    """What one item looks like for one person right now."""

    status: str
    detail: str
    params: Dict[str, Any] = field(default_factory=dict)
    #: The feature behind this item (or part of it) is not built yet.
    coming: bool = False
    #: Sub-steps (Google step A / step B), each ``{"id", "status"}``.
    steps: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class TestOutcome:
    result: str  # "ok" | "warn" | "bad"
    detail: str
    params: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Context:
    """Everything a provider may look at. Built once per request."""

    principal: Any
    config: Mapping[str, Any]
    env: Mapping[str, str]
    _cache: Dict[str, Any] = field(default_factory=dict)

    @property
    def user_id(self) -> str:
        return str(getattr(self.principal, "user_id", "") or "")

    @property
    def role(self) -> str:
        return str(getattr(self.principal, "role", "") or "")

    @property
    def is_owner(self) -> bool:
        return self.role == "owner" or bool(getattr(self.principal, "is_owner", False))

    @property
    def is_manager(self) -> bool:
        return self.is_owner or self.role in MANAGER_ROLES


def visible_items(ctx: Context) -> List[ItemSpec]:
    """Owner/admin get all eleven; everyone else only their connections."""
    if ctx.is_manager:
        return list(ITEMS)
    return [item for item in ITEMS if item.per_person]


def can_see(ctx: Context, item_id: str) -> bool:
    return any(item.id == item_id for item in visible_items(ctx))


# ---------------------------------------------------------------------------
# Shared facts (presence only)
# ---------------------------------------------------------------------------


def _secret_present(env: Mapping[str, str], name: str) -> bool:
    from hermes_cli.onboarding_readiness import _secret_present as present

    return present(env, name)


_PROVIDER_NAMES = {
    "OPENROUTER_API_KEY": "OpenRouter",
    "OPENAI_API_KEY": "OpenAI",
    "ANTHROPIC_API_KEY": "Anthropic",
    "GEMINI_API_KEY": "Google Gemini",
    "GOOGLE_API_KEY": "Google Gemini",
    "DEEPSEEK_API_KEY": "DeepSeek",
    "NOUS_API_KEY": "Nous",
}


def _provider_label(env_name: str) -> str:
    if env_name in _PROVIDER_NAMES:
        return _PROVIDER_NAMES[env_name]
    base = env_name
    for suffix in ("_API_KEY", "_TOKEN", "_KEY"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.replace("_", " ").title() or env_name


def model_key_name(env: Mapping[str, str]) -> str:
    from hermes_cli.onboarding_readiness import (
        LLM_PROVIDER_SECRET_ENV_VARS,
        _first_present_secret,
    )

    return _first_present_secret(env, LLM_PROVIDER_SECRET_ENV_VARS) or ""


def google_client_present() -> bool:
    """Google step A: the install's OAuth client exists (owner, once)."""
    try:
        from hermes_cli.google_oauth import load_google_client

        client_id, client_secret = load_google_client()
    except Exception:
        return False
    return bool(client_id and client_secret)


async def all_credentials(config: Mapping[str, Any]) -> List[Any]:
    """Every credential row, read as the owner (who bypasses row scoping).

    Callers reduce these to booleans per person; payloads never leave here.
    """
    from hermes_cli.credential_store import (
        default_credential_store,
        resolve_owner_principal,
    )

    store = default_credential_store(config)
    owner = await resolve_owner_principal()
    if owner is None:
        return []
    return list(await store.list(owner))


async def own_credentials(ctx: Context) -> List[Any]:
    """The caller's own credential rows (shared rows from others excluded)."""
    if "own_creds" not in ctx._cache:
        try:
            from hermes_cli.credential_store import default_credential_store

            rows = await default_credential_store(ctx.config).list(ctx.principal)
        except Exception:
            rows = []
        ctx._cache["own_creds"] = [
            r for r in rows if getattr(r, "owner_user_id", None) == ctx.user_id
        ]
    return ctx._cache["own_creds"]


def connection_flags(creds: List[Any]) -> Dict[str, Any]:
    kinds = [getattr(c, "kind", "") for c in creds]
    return {
        "google": sum(1 for c in creds if getattr(c, "provider", "") == "google"),
        "vpn": kinds.count("fortinet-vpn"),
        "folders": kinds.count("smb-folder"),
    }


def whatsapp_bridges() -> List[Dict[str, Any]]:
    """The install's WhatsApp bridges (owner-managed, install-wide today)."""
    try:
        from hermes_cli import wa_bridge_api

        return [wa_bridge_api._describe(name) for name in wa_bridge_api._bridge_names()]
    except Exception:
        return []


def email_accounts() -> List[Dict[str, Any]]:
    """Enabled mailboxes of the install's email poller (owner, install-wide)."""
    try:
        from hermes_cli import email_accounts_api

        doc = email_accounts_api._load_config() or {}
    except Exception:
        return []
    accounts = doc.get("accounts")
    if not isinstance(accounts, list):
        return []
    return [a for a in accounts if isinstance(a, dict) and a.get("enabled", True)]


#: The in-house app MCP server is wired by the installer, not added by a person.
_INTERNAL_MCP_SERVERS = {"app"}


def install_mcp_servers(config: Mapping[str, Any]) -> List[str]:
    servers = config.get("mcp_servers") if isinstance(config, Mapping) else None
    if not isinstance(servers, Mapping):
        return []
    return sorted(
        name
        for name, cfg in servers.items()
        if name not in _INTERNAL_MCP_SERVERS
        and not (isinstance(cfg, Mapping) and cfg.get("enabled") is False)
    )


@dataclass
class Person:
    user_id: str
    display: str
    role: str
    email: str = ""
    invited_pending: bool = False


async def list_people(ctx: Context) -> List[Person]:
    """This profile's roster (owner/admin callers only).

    Uses the member service when user management is set up (so a pending
    invite is known), else the enrolled principals, else just the caller.
    """
    from hermes_cli import web_server

    now = datetime.now(timezone.utc)

    def _pending(inv: Any) -> bool:
        if inv is None or inv.used_at is not None or inv.revoked_at is not None:
            return False
        expires = inv.expires_at
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return expires > now

    try:
        service = web_server._comms_user_service(ctx.principal)
        page = await service.list_members(ctx.principal, limit=200)
        return [
            Person(
                user_id=m.user_id,
                display=m.display or m.email or m.user_id,
                role=m.role,
                email=m.email,
                invited_pending=_pending(m.invitation),
            )
            for m in page.members
            if m.enrolled
        ]
    except Exception:
        pass
    try:
        from hermes_cli.access import PrincipalStore

        rows = await PrincipalStore(web_server._comms_app_store()).list_principals(
            active=True, limit=200
        )
        if rows:
            return [Person(p.user_id, p.display or p.user_id, p.role) for p in rows]
    except Exception:
        pass
    return [
        Person(
            ctx.user_id,
            str(getattr(ctx.principal, "display", "") or ctx.user_id),
            ctx.role,
        )
    ]


async def two_factor_status(ctx: Context) -> Optional[bool]:
    """Whether the owner's own login has two-factor on (``None``: no owner yet)."""
    from hermes_cli import two_factor

    owner_id = ctx.user_id if ctx.is_owner else ""
    if not owner_id:
        owner = next((p for p in await list_people(ctx) if p.role == "owner"), None)
        owner_id = owner.user_id if owner is not None else ""
    if not owner_id:
        return None
    return await asyncio.to_thread(two_factor.is_enabled, owner_id)


# ---------------------------------------------------------------------------
# Status providers — one per item
# ---------------------------------------------------------------------------


async def status_owner(ctx: Context) -> ItemStatus:
    from hermes_cli.onboarding_readiness import probe_owner_enrolled

    enrolled, _ = await probe_owner_enrolled(ctx.config)
    if not enrolled and not ctx.is_owner:
        enrolled = any(p.role == "owner" for p in await list_people(ctx))
    if not enrolled and not ctx.is_owner:
        return ItemStatus(NOT_STARTED, "owner.none")
    two_factor = await two_factor_status(ctx)
    if two_factor:
        return ItemStatus(DONE, "owner.done")
    return ItemStatus(ATTENTION, "owner.no_2fa")


async def status_model(ctx: Context) -> ItemStatus:
    name = model_key_name(ctx.env)
    if not name:
        return ItemStatus(NOT_STARTED, "model.none")
    return ItemStatus(DONE, "model.done", {"provider": _provider_label(name)})


async def status_people(ctx: Context) -> ItemStatus:
    people = await list_people(ctx)
    pending = [p for p in people if p.invited_pending]
    if len(people) <= 1:
        return ItemStatus(NOT_STARTED, "people.only_you")
    if pending:
        return ItemStatus(
            ATTENTION,
            "people.pending",
            {"count": len(people), "pending": len(pending), "name": pending[0].display},
        )
    return ItemStatus(DONE, "people.done", {"count": len(people)})


async def status_google(ctx: Context) -> ItemStatus:
    step_a = google_client_present()
    connected = connection_flags(await own_credentials(ctx))["google"]
    steps = [
        {"id": "a", "status": DONE if step_a else NOT_STARTED},
        {"id": "b", "status": DONE if connected else NOT_STARTED},
    ]
    if connected and step_a:
        return ItemStatus(DONE, "google.done", {"count": connected}, steps=steps)
    if connected:
        return ItemStatus(ATTENTION, "google.no_client", steps=steps)
    if step_a:
        return ItemStatus(NOT_STARTED, "google.connect_yours", steps=steps)
    return ItemStatus(NOT_STARTED, "google.none", steps=steps)


async def status_whatsapp(ctx: Context) -> ItemStatus:
    # Bridges are install-wide and owner-managed today; they count as the
    # owner's. Per-person bridges are another unit's work.
    if not ctx.is_owner:
        return ItemStatus(NOT_STARTED, "whatsapp.coming", coming=True)
    bridges = await asyncio.to_thread(whatsapp_bridges)
    if not bridges:
        return ItemStatus(NOT_STARTED, "whatsapp.none")
    linked = [b for b in bridges if b.get("paired")]
    if linked and all(b.get("active") == "active" for b in linked):
        return ItemStatus(DONE, "whatsapp.done", {"count": len(linked)})
    waiting = next((b for b in bridges if not b.get("paired")), None)
    if waiting is not None:
        return ItemStatus(ATTENTION, "whatsapp.waiting_qr", {"name": waiting["name"]})
    return ItemStatus(ATTENTION, "whatsapp.stopped")


async def status_telegram(ctx: Context) -> ItemStatus:
    # The install's single bot (TELEGRAM_BOT_TOKEN in .env) is the owner's.
    if not ctx.is_owner:
        return ItemStatus(NOT_STARTED, "telegram.coming", coming=True)
    if _secret_present(ctx.env, "TELEGRAM_BOT_TOKEN"):
        return ItemStatus(DONE, "telegram.done")
    return ItemStatus(NOT_STARTED, "telegram.none")


async def status_email(ctx: Context) -> ItemStatus:
    # The email poller's mailboxes are install-wide; they count as the owner's.
    if not ctx.is_owner:
        return ItemStatus(NOT_STARTED, "email.coming", coming=True)
    accounts = await asyncio.to_thread(email_accounts)
    if accounts:
        return ItemStatus(DONE, "email.done", {"count": len(accounts)})
    return ItemStatus(NOT_STARTED, "email.none")


async def status_tools(ctx: Context) -> ItemStatus:
    # ``mcp_servers`` in config.yaml are install-wide; they count as the owner's.
    if not ctx.is_owner:
        return ItemStatus(NOT_STARTED, "tools.coming", coming=True)
    servers = install_mcp_servers(ctx.config)
    if servers:
        return ItemStatus(DONE, "tools.done", {"count": len(servers)})
    return ItemStatus(NOT_STARTED, "tools.none")


async def status_vpn(ctx: Context) -> ItemStatus:
    flags = connection_flags(await own_credentials(ctx))
    if flags["folders"]:
        return ItemStatus(
            DONE, "vpn.done", {"vpn": flags["vpn"], "folders": flags["folders"]}
        )
    if flags["vpn"]:
        return ItemStatus(ATTENTION, "vpn.no_folder", {"vpn": flags["vpn"]})
    return ItemStatus(NOT_STARTED, "vpn.none")


async def status_backups(ctx: Context) -> ItemStatus:
    return ItemStatus(NOT_STARTED, "backups.coming", coming=True)


def _security_status(result: Mapping[str, Any]) -> ItemStatus:
    params = {"passed": result.get("passed", 0), "total": result.get("total", 0)}
    if result.get("status") == "done":
        return ItemStatus(DONE, "security.done", params)
    if result.get("status") == "attention":
        return ItemStatus(ATTENTION, "security.attention", params)
    return ItemStatus(NOT_STARTED, "security.none")


async def status_security(ctx: Context) -> ItemStatus:
    """Item 11: the last saved read-only server check (hermes_cli/security_basics)."""
    from hermes_cli import security_basics

    return _security_status(await asyncio.to_thread(security_basics.last_result))


StatusProvider = Callable[[Context], Awaitable[ItemStatus]]
TestProvider = Callable[[Context], Awaitable[TestOutcome]]

STATUS_PROVIDERS: Dict[str, StatusProvider] = {
    "owner": status_owner,
    "model": status_model,
    "people": status_people,
    "google": status_google,
    "whatsapp": status_whatsapp,
    "telegram": status_telegram,
    "email": status_email,
    "tools": status_tools,
    "vpn": status_vpn,
    "backups": status_backups,
    "security": status_security,
}


# ---------------------------------------------------------------------------
# Test providers — default: re-run the live status check
# ---------------------------------------------------------------------------


_STATUS_TO_RESULT = {DONE: "ok", ATTENTION: "warn", NOT_STARTED: "bad"}


async def _test_from_status(ctx: Context, item_id: str) -> TestOutcome:
    status = await STATUS_PROVIDERS[item_id](ctx)
    return TestOutcome(_STATUS_TO_RESULT[status.status], status.detail, status.params)


def _run_model_test() -> Dict[str, Any]:
    from hermes_cli.web_server import _run_model_test_sync

    return _run_model_test_sync("main", "", "", "", None)


async def test_model(ctx: Context) -> TestOutcome:
    """One real "say OK" round-trip through the configured main model."""
    if not model_key_name(ctx.env):
        return TestOutcome("bad", "model.none")
    started = time.monotonic()
    try:
        result = await asyncio.wait_for(asyncio.to_thread(_run_model_test), 90.0)
    except asyncio.TimeoutError:
        return TestOutcome("bad", "test.model_timeout")
    except Exception:
        return TestOutcome("bad", "test.model_failed")
    if not result.get("ok"):
        return TestOutcome("bad", "test.model_failed")
    seconds = round(time.monotonic() - started, 1)
    return TestOutcome("ok", "test.model_ok", {"seconds": seconds})


async def test_security(ctx: Context) -> TestOutcome:
    """Runs the same read-only checks as ``POST /api/security-basics/test``."""
    from hermes_cli import security_basics

    try:
        result = await asyncio.to_thread(security_basics.run_test)
    except security_basics.Busy:
        return TestOutcome("warn", "security.busy")
    status = _security_status(result)
    tone = {DONE: "ok", ATTENTION: "warn"}.get(status.status, "bad")
    return TestOutcome(tone, status.detail, status.params)


TEST_PROVIDERS: Dict[str, TestProvider] = {
    "model": test_model,
    "security": test_security,
}


async def run_test(ctx: Context, item_id: str) -> TestOutcome:
    provider = TEST_PROVIDERS.get(item_id)
    if provider is not None:
        return await provider(ctx)
    return await _test_from_status(ctx, item_id)


# ---------------------------------------------------------------------------
# Last-test store: $HERMES_HOME/get-ready/last-tests.json, keyed by person
# ---------------------------------------------------------------------------


def _store_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "get-ready" / "last-tests.json"


def _read_tests() -> Dict[str, Dict[str, Any]]:
    try:
        doc = json.loads(_store_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def last_tests_for(user_id: str) -> Dict[str, Any]:
    entry = _read_tests().get(user_id)
    return entry if isinstance(entry, dict) else {}


def record_test(user_id: str, item_id: str, outcome: TestOutcome) -> Dict[str, Any]:
    record = {
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "result": outcome.result,
        "detail": outcome.detail,
        "params": outcome.params,
    }
    doc = _read_tests()
    person = doc.get(user_id) if isinstance(doc.get(user_id), dict) else {}
    person[item_id] = record
    doc[user_id] = person
    path = _store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".last-tests-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return record


# ---------------------------------------------------------------------------
# Payloads
# ---------------------------------------------------------------------------


async def item_payload(ctx: Context, item: ItemSpec, tests: Mapping[str, Any]) -> Dict[str, Any]:
    try:
        status = await STATUS_PROVIDERS[item.id](ctx)
    except Exception:
        status = ItemStatus(ATTENTION, "check_failed")
    return {
        "id": item.id,
        "n": item.n,
        "group": item.group,
        "required": item.required,
        "per_person": item.per_person,
        "status": status.status,
        "detail": status.detail,
        "params": status.params,
        "coming": status.coming,
        "steps": status.steps,
        "last_test": tests.get(item.id),
    }


async def checklist(ctx: Context) -> Dict[str, Any]:
    tests = last_tests_for(ctx.user_id)
    items = [await item_payload(ctx, item, tests) for item in visible_items(ctx)]
    counts = {DONE: 0, ATTENTION: 0, NOT_STARTED: 0}
    for row in items:
        counts[row["status"]] += 1
    return {
        "role": ctx.role,
        "can_manage": ctx.is_manager,
        "items": items,
        "summary": {
            "total": len(items),
            "done": counts[DONE],
            "attention": counts[ATTENTION],
            "not_started": counts[NOT_STARTED],
        },
    }


#: Per-person connection cell states for the people table.
SET = "set"
WAITING = "waiting"
NOT_SET = "not_set"
COMING = "coming"

PEOPLE_CONNECTIONS = ("google", "whatsapp", "telegram", "email", "tools", "vpn")


async def people_status(ctx: Context) -> Dict[str, Any]:
    """Per person, per connection: set / waiting / not set. Never a secret."""
    people = await list_people(ctx)
    try:
        creds = await all_credentials(ctx.config)
    except Exception:
        creds = []
    by_owner: Dict[str, List[Any]] = {}
    for cred in creds:
        by_owner.setdefault(getattr(cred, "owner_user_id", ""), []).append(cred)
    step_a = google_client_present()
    bridges = await asyncio.to_thread(whatsapp_bridges)
    mailboxes = await asyncio.to_thread(email_accounts)
    servers = install_mcp_servers(ctx.config)
    telegram = _secret_present(ctx.env, "TELEGRAM_BOT_TOKEN")

    rows = []
    for person in people:
        flags = connection_flags(by_owner.get(person.user_id, []))
        is_owner = person.role == "owner"
        cells: Dict[str, Dict[str, Any]] = {}
        if flags["google"]:
            cells["google"] = {"state": SET}
        elif not step_a:
            cells["google"] = {"state": WAITING, "reason": "step_a"}
        else:
            cells["google"] = {"state": NOT_SET}
        if not is_owner:
            for key in ("whatsapp", "telegram", "email", "tools"):
                cells[key] = {"state": COMING}
        else:
            if any(b.get("paired") for b in bridges):
                cells["whatsapp"] = {"state": SET}
            elif bridges:
                cells["whatsapp"] = {"state": WAITING, "reason": "qr"}
            else:
                cells["whatsapp"] = {"state": NOT_SET}
            cells["telegram"] = {"state": SET if telegram else NOT_SET}
            cells["email"] = {"state": SET if mailboxes else NOT_SET}
            cells["tools"] = (
                {"state": SET, "count": len(servers)} if servers else {"state": NOT_SET}
            )
        cells["vpn"] = {"state": SET if (flags["vpn"] or flags["folders"]) else NOT_SET}
        rows.append(
            {
                "user_id": person.user_id,
                "display": person.display,
                "role": person.role,
                "is_you": person.user_id == ctx.user_id,
                "invited_pending": person.invited_pending,
                "connections": cells,
            }
        )
    return {"connections": list(PEOPLE_CONNECTIONS), "people": rows}
