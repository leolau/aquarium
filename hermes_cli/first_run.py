"""One-time first-run link: the owner sets their own password on a fresh install.

Replaces the installer's old "owner password saved in a secrets file". The
contract, shared by the CLI (``hermes setup-link``), the server
(``POST /api/setup/check`` / ``POST /api/setup/owner``) and the agent-home
first-run page (a later track):

* The CLI mints a random 256-bit token and writes **only its SHA-256** with an
  expiry (default 24 h, ``first_run.ttl_hours`` in config.yaml) and the owner
  principal id to ``$HERMES_HOME/auth/first_run_token.json`` (0600, the service
  account's own file). Minting again replaces the file, so an older link stops
  working.
* The link is ``<origin>/setup#token=<token>``. The token is in the URL
  *fragment*, which browsers never send to a server, so it cannot end up in
  Caddy or Next.js access logs; the page reads it and POSTs it.
* ``/api/setup/owner`` claims the token (single use, under a file lock), creates
  the owner's login account (GoTrue, email + password), links it to the owner
  principal, sets the same password for the operator dashboard's basic-auth
  login, and deletes the token. Any failure puts the token back so a retry
  works; a password the policy rejects does not use up the link.
* No token file → both endpoints refuse every request. A box that never runs
  ``hermes setup-link`` (e.g. an existing install) is unaffected.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

from hermes_cli.invitations import InvitationError, RedeemThrottle, validate_password

DEFAULT_TTL_HOURS = 24
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

NEUTRAL_DETAIL = (
    "This setup link cannot be used. It may have expired or been used already — "
    "create a new one on the server with: hermes setup-link"
)


def token_path(home: Optional[Path] = None) -> Path:
    if home is None:
        from hermes_constants import get_hermes_home

        home = get_hermes_home()
    return Path(home) / "auth" / "first_run_token.json"


def ttl_seconds(config: Mapping[str, Any] | None) -> int:
    """``first_run.ttl_hours`` from config.yaml; bad or missing → 24 hours."""
    section = (config or {}).get("first_run")
    raw = section.get("ttl_hours") if isinstance(section, Mapping) else None
    try:
        hours = float(str(raw)) if raw is not None else DEFAULT_TTL_HOURS
    except ValueError:
        hours = DEFAULT_TTL_HOURS
    return int((hours if hours > 0 else DEFAULT_TTL_HOURS) * 3600)


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


@contextmanager
def _locked(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path.with_suffix(".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _write(path: Path, record: Mapping[str, Any]) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
    os.replace(tmp, path)


def _read(path: Path) -> Optional[dict[str, Any]]:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


@dataclass(frozen=True)
class SetupLink:
    token: str
    owner_id: str
    expires_at: datetime

    def url(self, origin: str) -> str:
        return f"{origin.rstrip('/')}/setup#token={self.token}"


def mint(owner_id: str, *, ttl: int, home: Optional[Path] = None,
         now: Optional[datetime] = None) -> SetupLink:
    """Write a new one-time token (hash only) and return the plaintext once."""
    if not owner_id:
        raise ValueError("owner_id is required")
    token = secrets.token_urlsafe(32)
    expires = (now or _now()) + timedelta(seconds=max(60, int(ttl)))
    path = token_path(home)
    with _locked(path):
        _write(path, {"sha256": _digest(token), "owner_id": owner_id,
                      "expires_at": expires.isoformat()})
        path.with_suffix(".claimed").unlink(missing_ok=True)
    return SetupLink(token=token, owner_id=owner_id, expires_at=expires)


def _matches(record: Optional[dict[str, Any]], token: str, now: datetime) -> bool:
    if not record or not token:
        return False
    if not hmac.compare_digest(str(record.get("sha256", "")), _digest(token)):
        return False
    try:
        expires = datetime.fromisoformat(str(record.get("expires_at", "")))
    except ValueError:
        return False
    return expires.tzinfo is not None and now < expires


def check(token: str, *, home: Optional[Path] = None, now: Optional[datetime] = None) -> bool:
    """True if ``token`` is the current, unexpired, unused link. Does not use it up."""
    return _matches(_read(token_path(home)), token, now or _now())


def claim(token: str, *, home: Optional[Path] = None,
          now: Optional[datetime] = None) -> Optional[dict[str, Any]]:
    """Take the token for one attempt: the file is moved aside so a second,
    concurrent request finds nothing. Return its record, or ``None``."""
    path = token_path(home)
    with _locked(path):
        record = _read(path)
        if not _matches(record, token, now or _now()):
            return None
        os.replace(path, path.with_suffix(".claimed"))
    return record


def release(home: Optional[Path] = None) -> None:
    """Put a claimed token back after a failed attempt (unless a newer one exists)."""
    path = token_path(home)
    with _locked(path):
        claimed = path.with_suffix(".claimed")
        if claimed.exists() and not path.exists():
            os.replace(claimed, path)


def consume(home: Optional[Path] = None) -> None:
    path = token_path(home)
    with _locked(path):
        path.with_suffix(".claimed").unlink(missing_ok=True)


THROTTLE = RedeemThrottle(max_attempts=10, window_seconds=300.0, ip_max_attempts=30)


def _set_dashboard_password(password: str) -> bool:
    """Give the operator dashboard's basic-auth login the same password.

    Only when basic auth is already configured (the installer sets it up with a
    random placeholder nobody knows). The running provider is updated too, so no
    restart is needed.
    """
    from hermes_cli.config import load_config, save_config
    from plugins.dashboard_auth.basic import hash_password

    config = load_config() or {}
    basic = (config.get("dashboard") or {}).get("basic_auth")
    if not isinstance(basic, dict) or not basic.get("username"):
        return False
    new_hash = hash_password(password)
    basic["password_hash"] = new_hash
    basic.pop("password", None)
    save_config(config)
    try:
        from hermes_cli.dashboard_auth.registry import get_provider

        provider = get_provider("basic")
        if provider is not None and hasattr(provider, "set_password_hash"):
            provider.set_password_hash(new_hash)
    except Exception:  # noqa: BLE001 — config is written; restart picks it up
        pass
    return True


async def create_owner(*, token: str, email: str, password: str, store: Any, admin: Any,
                       config: Mapping[str, Any] | None = None,
                       home: Optional[Path] = None) -> bool:
    """Create the owner's login from a setup token. ``False`` for any token problem.

    Raises :class:`InvitationError` (link kept) for a bad email/password or an
    email that already has an account — things the person at the form can fix.
    """
    from hermes_cli.members import MemberConflictError

    record = claim(token, home=home)
    if record is None:
        return False
    try:
        email = (email or "").strip()
        if not _EMAIL_RE.match(email):
            raise InvitationError("Enter the owner's email address.")
        validate_password(password, email=email)
        owner = await store.get_owner()
        if owner is None or owner.user_id != record.get("owner_id"):
            release(home)
            return False
        try:
            user = admin.create_user(email=email, password=password,
                                     display=owner.display or email)
        except MemberConflictError as exc:
            raise InvitationError(
                "An account with this email already exists. Use another email."
            ) from exc
        subject = str(user["id"])
        try:
            await store.link_alias(subject, owner.user_id)
        except Exception:
            admin.delete_user(user_id=subject)
            raise
    except BaseException:
        release(home)
        raise
    consume(home)
    dashboard = _set_dashboard_password(password)
    try:
        from hermes_cli.identity_audit import record_identity_event

        await record_identity_event(
            store=store.app_store, actor_user_id=owner.user_id, action="owner.first_run",
            user_id=owner.user_id,
            payload={"login_subject": subject, "dashboard_password_set": dashboard},
            config=config,
        )
    except Exception:  # noqa: BLE001 — audit is best effort, the owner exists now
        pass
    return True


# ---------------------------------------------------------------- CLI
def setup_link_command(args: argparse.Namespace) -> int:
    from hermes_cli.config import load_config
    from hermes_cli.owner import _prod_store

    try:
        owner = asyncio.run(_prod_store().get_owner())
    except (KeyError, RuntimeError, ValueError, OSError) as error:
        print(f"setup-link failed: {error}", file=sys.stderr)
        return 1
    if owner is None:
        print("No owner is set; run 'hermes owner init <user_id>' first.", file=sys.stderr)
        return 1
    ttl = int(args.ttl_hours * 3600) if args.ttl_hours else ttl_seconds(load_config())
    link = mint(owner.user_id, ttl=ttl)
    print(link.url(args.origin))
    print(f"Valid once, until {link.expires_at:%Y-%m-%d %H:%M} UTC. "
          "Any earlier setup link no longer works.", file=sys.stderr)
    return 0


def register_setup_link_subparser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser(
        "setup-link",
        help="Print a one-time link where the owner sets their login password",
        description=(
            "Create a one-time first-run link (default: valid 24 hours, "
            "first_run.ttl_hours in config.yaml). Only a hash of it is stored; "
            "creating a new link cancels the previous one."
        ),
    )
    parser.add_argument("--origin", default="http://127.0.0.1:3100",
                        help="Public address of agent-home, e.g. https://home.example.com")
    parser.add_argument("--ttl-hours", type=float, default=0, help=argparse.SUPPRESS)
    parser.set_defaults(func=setup_link_command)
