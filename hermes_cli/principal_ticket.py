"""Requester principal ticket (FG-33 P8-0 item 0.4).

The gateway mints a short-lived HMAC ticket for the person a chat turn runs
for. The agent's terminal gets it as ``HERMES_PRINCIPAL_TICKET`` (a per-turn
credential, not configuration), the same way kanban workers carry
``HERMES_KANBAN_TASK``. ``deploy/hermes-tools-cli`` verifies it and turns it
into ``hermes tool --as <user>``, and ``hermes_cli.tool_cmd`` re-checks it, so a
tool the agent creates is authored by the requester, not the enrolled owner.

Ticket: ``v1.<b64url(user_id)>.<expiry_ms>.<b64url(sig)>``, where ``sig`` is
HMAC-SHA256 over ``v1.<b64url(user_id)>.<expiry_ms>`` (the
``app-mcp/app_mcp/ticket.py`` pattern, with the user id encoded so it may hold
dots). The key lives in ``$HERMES_HOME/auth/principal-ticket.key`` (0600,
created on first mint). The agent's shell runs as ``hermes-tools`` and cannot
read it, so it cannot forge a ticket. A key file that group or others can read
is refused, so a widened mode fails closed instead of letting tickets be forged.

``deploy/hermes-tools-cli`` runs as ``python3 -I`` from a root-owned copy and
cannot import this module, so it carries a stdlib copy of :func:`verify`; the
tests check that the two agree.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import stat
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Optional

ENV_VAR = "HERMES_PRINCIPAL_TICKET"
KEY_RELPATH = Path("auth") / "principal-ticket.key"
VERSION = "v1"
#: One chat turn; long enough for a slow build step, short enough that a leaked
#: ticket is soon useless.
DEFAULT_TTL_SECONDS = 30 * 60

#: (ticket, session id it was minted under). Unset means "no turn bound here".
_CURRENT: ContextVar[Optional[tuple[str, str]]] = ContextVar(
    "aquarium_principal_ticket", default=None
)


def key_file(home: str | os.PathLike | None = None) -> Path:
    """``$HERMES_HOME/auth/principal-ticket.key`` of the process (not a profile).

    ``hermes-tools-cli`` reads the key under the HERMES_HOME in its root-owned
    config, which is the gateway's own, so every profile uses the same key.
    """
    if home is None:
        home = os.environ.get("HERMES_HOME", "").strip()
        if not home:
            from hermes_constants import get_hermes_home

            home = str(get_hermes_home())
    return Path(home) / KEY_RELPATH


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _read_key(path: Path) -> bytes | None:
    try:
        st = path.stat()
        if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
            return None
        key = path.read_bytes().strip()
    except OSError:
        return None
    return key or None


def _load_or_create_key(path: Path) -> bytes | None:
    key = _read_key(path)
    if key is not None or path.exists():
        return key
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return _read_key(path)
    except OSError:
        return None
    with os.fdopen(fd, "w", encoding="ascii") as fh:
        fh.write(secrets.token_hex(32))
    return _read_key(path)


def _sign(payload: str, key: bytes) -> str:
    return _b64(hmac.new(key, payload.encode("ascii"), hashlib.sha256).digest())


def sign(user_id: str, key: bytes, expires_ms: int) -> str:
    """Return a ticket for *user_id* valid until *expires_ms* (epoch ms)."""
    payload = f"{VERSION}.{_b64(user_id.encode('utf-8'))}.{int(expires_ms)}"
    return f"{payload}.{_sign(payload, key)}"


def verify(
    ticket: str,
    *,
    key: bytes | None = None,
    home: str | os.PathLike | None = None,
    now_ms: float | None = None,
) -> str | None:
    """Return the user id when *ticket* is authentic and unexpired, else None."""
    if not ticket:
        return None
    if key is None:
        key = _read_key(key_file(home))
    if not key:
        return None
    parts = ticket.split(".")
    if len(parts) != 4 or parts[0] != VERSION:
        return None
    _, uid_raw, expires_raw, sig = parts
    if not expires_raw.isdigit():
        return None
    if not hmac.compare_digest(_sign(f"{VERSION}.{uid_raw}.{expires_raw}", key), sig):
        return None
    now = now_ms if now_ms is not None else time.time() * 1000
    if now > int(expires_raw):
        return None
    try:
        user_id = _unb64(uid_raw).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    return user_id if user_id.strip() else None


def _session_id() -> str:
    try:
        from gateway.session_context import get_session_env

        return get_session_env("HERMES_SESSION_ID", "")
    except Exception:  # noqa: BLE001 - no gateway in this process
        return ""


def mint(user_id: Optional[str], *, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> str:
    """Mint a ticket for *user_id* and bind it to the current turn.

    Called once per turn by the gateway when it builds the agent. Always
    rebinds, so a turn without a person (``user_id`` None) clears whatever an
    earlier turn on the same worker thread left behind. Returns the ticket, or
    "" when there is no person or the key cannot be created (the agent's
    ``hermes tool`` calls then fail closed).
    """
    ticket = ""
    if user_id and str(user_id).strip():
        key = _load_or_create_key(key_file())
        if key:
            expires = int(time.time() * 1000) + int(ttl_seconds) * 1000
            ticket = sign(str(user_id), key, expires)
    _CURRENT.set((ticket, _session_id()))
    return ticket


def current() -> str:
    """The ticket bound to this turn, or "" (none, or minted for another session)."""
    bound = _CURRENT.get()
    if not bound:
        return ""
    ticket, session_id = bound
    return ticket if session_id == _session_id() else ""


def inject_env(env: dict) -> None:
    """Put this turn's ticket into a subprocess env, or strip an inherited one.

    A bound turn is authoritative: its ticket goes in, or nothing does. With no
    turn bound, a ticket the process itself was started with (e.g. a worker)
    is kept unless the process hosts concurrent sessions, where an inherited
    value could belong to someone else.
    """
    if _CURRENT.get() is not None:
        ticket = current()
        if ticket:
            env[ENV_VAR] = ticket
        else:
            env.pop(ENV_VAR, None)
        return
    try:
        from gateway.session_context import session_context_engaged

        engaged = session_context_engaged()
    except Exception:  # noqa: BLE001
        engaged = False
    if engaged:
        env.pop(ENV_VAR, None)


__all__ = [
    "DEFAULT_TTL_SECONDS",
    "ENV_VAR",
    "KEY_RELPATH",
    "current",
    "inject_env",
    "key_file",
    "mint",
    "sign",
    "verify",
]
