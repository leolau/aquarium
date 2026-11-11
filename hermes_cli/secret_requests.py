"""FG-37 secret prompt: the cross-process request registry.

The agent asks for a secret by name (``request_secret``); the person types it
into a masked popup (agent-home chat) or a one-time link page (messaging), and
the value goes straight to the credential store. This SQLite table only tracks
the request: who may answer it, until when, and how it ended. **No secret
value is ever written here**, and a link token is stored as its sha256 only.

Gateway, dashboard and agent-home BFF are separate processes, so the registry
is a WAL SQLite file (``secret_requests.db``) in the profile's HERMES_HOME.
Every status change is a conditional ``UPDATE ... WHERE status='pending'``, so
two answers racing for one request cannot both win.

Design doc: ``docs/design/master-plan/feature-groups/FG-37-secret-prompt.md``.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from hermes_cli.sqlite_util import write_txn

PROVIDER = "secret"
KINDS = ("secret", "password")
DEFAULT_TTL_SECONDS = 900
POLL_SECONDS = 0.5
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

PENDING = "pending"
STORED = "stored"
DECLINED = "declined"
EXPIRED = "expired"
#: Internal, short-lived: an answer has claimed the row and its credential is
#: being written. Waiters treat it as pending; it never outlives ``fulfil``.
STORING = "storing"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS secret_requests (
    id TEXT PRIMARY KEY,
    token_hash TEXT UNIQUE,
    owner_user_id TEXT NOT NULL,
    profile TEXT,
    session_key TEXT,
    run_id TEXT,
    name TEXT NOT NULL,
    label TEXT,
    purpose TEXT,
    kind TEXT NOT NULL,
    username TEXT,
    channel TEXT,
    status TEXT NOT NULL,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL,
    resolved_at REAL
);
"""

_COLUMNS = (
    "id, owner_user_id, profile, session_key, run_id, name, label, purpose, "
    "kind, username, channel, status, created_at, expires_at, resolved_at"
)


class SecretRequestError(Exception):
    """Base error; ``status_code`` is the HTTP answer for it."""

    status_code = 400


class SecretRequestNotFound(SecretRequestError):
    status_code = 404


class SecretRequestForbidden(SecretRequestError):
    status_code = 403


class SecretRequestNotPending(SecretRequestError):
    status_code = 409


@dataclass(frozen=True)
class SecretRequest:
    id: str
    owner_user_id: str
    profile: Optional[str]
    session_key: Optional[str]
    run_id: Optional[str]
    name: str
    label: Optional[str]
    purpose: Optional[str]
    kind: str
    username: Optional[str]
    channel: Optional[str]
    status: str
    created_at: float
    expires_at: float
    resolved_at: Optional[float]

    @property
    def is_pending(self) -> bool:
        return self.status == PENDING and self.expires_at > time.time()

    def public(self) -> Dict[str, Any]:
        """What a popup/link page may show (no owner, no session)."""
        return {
            "request_id": self.id,
            "name": self.name,
            "label": self.label,
            "purpose": self.purpose,
            "kind": self.kind,
            "username": self.username,
            "status": self.status,
            "expires_at": self.expires_at,
        }


def db_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "secret_requests.db"


def connect(path: Optional[Path] = None) -> sqlite3.Connection:
    path = Path(path) if path is not None else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    try:
        conn.row_factory = sqlite3.Row
        from hermes_state import apply_wal_with_fallback

        apply_wal_with_fallback(conn, db_label="secret_requests.db")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.executescript(_SCHEMA)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except Exception:
        conn.close()
        raise
    return conn


def hash_token(token: str) -> str:
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


def _row(row: Optional[sqlite3.Row]) -> Optional[SecretRequest]:
    if row is None:
        return None
    return SecretRequest(**{k: row[k] for k in row.keys()})


def _fetch(conn: sqlite3.Connection, where: str, *params: Any) -> Optional[SecretRequest]:
    return _row(
        conn.execute(f"SELECT {_COLUMNS} FROM secret_requests WHERE {where}", params).fetchone()
    )


def validate_name(name: str) -> str:
    name = str(name or "").strip()
    if not NAME_RE.fullmatch(name):
        raise SecretRequestError(
            "secret name must be a lowercase slug (a-z, 0-9, '.', '_', '-'; "
            "at most 64 characters, starting with a letter or digit)"
        )
    return name


def open_request(
    *,
    owner_user_id: str,
    profile: Optional[str],
    session_key: Optional[str],
    run_id: Optional[str],
    name: str,
    label: Optional[str],
    purpose: Optional[str],
    kind: str,
    username: Optional[str] = None,
    channel: str,
    ttl_seconds: float = DEFAULT_TTL_SECONDS,
    with_link: bool = False,
) -> Tuple[SecretRequest, Optional[str]]:
    """Open a pending request; with ``with_link`` also mint its one-time token.

    The token is returned once (for the link) and only its sha256 is kept.
    """
    if not str(owner_user_id or "").strip():
        raise SecretRequestError("a secret request needs an owner")
    name = validate_name(name)
    if kind not in KINDS:
        raise SecretRequestError(f"kind must be one of {', '.join(KINDS)}")
    if not ttl_seconds or float(ttl_seconds) <= 0:
        raise SecretRequestError("ttl_seconds must be positive")
    token = secrets.token_urlsafe(32) if with_link else None
    now = time.time()
    request_id = "sr_" + secrets.token_hex(8)
    conn = connect()
    try:
        with write_txn(conn):
            conn.execute(
                "INSERT INTO secret_requests (id, token_hash, owner_user_id, profile, "
                "session_key, run_id, name, label, purpose, kind, username, channel, "
                "status, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    request_id,
                    hash_token(token) if token else None,
                    str(owner_user_id),
                    profile,
                    session_key,
                    run_id,
                    name,
                    (label or name)[:200],
                    (purpose or "")[:500],
                    kind,
                    username or None,
                    channel,
                    PENDING,
                    now,
                    now + float(ttl_seconds),
                ),
            )
        req = _fetch(conn, "id = ?", request_id)
    finally:
        conn.close()
    assert req is not None
    return req, token


def get_request(request_id: str) -> Optional[SecretRequest]:
    conn = connect()
    try:
        return _fetch(conn, "id = ?", str(request_id or ""))
    finally:
        conn.close()


def get_by_token(token: str) -> Optional[SecretRequest]:
    """The pending, unexpired request a link token opens, else ``None``."""
    if not token:
        return None
    conn = connect()
    try:
        req = _fetch(conn, "token_hash = ?", hash_token(token))
    finally:
        conn.close()
    return req if req is not None and req.is_pending else None


def _expire_if_due(conn: sqlite3.Connection, request_id: str) -> None:
    with write_txn(conn):
        conn.execute(
            "UPDATE secret_requests SET status = ?, token_hash = NULL, resolved_at = ? "
            "WHERE id = ? AND status = ? AND expires_at <= ?",
            (EXPIRED, time.time(), request_id, PENDING, time.time()),
        )


def _clean_values(req: SecretRequest, values: Any) -> Dict[str, str]:
    from hermes_cli.credential_store import CredentialError, validate_payload

    if not isinstance(values, Mapping):
        raise SecretRequestError("values must be an object")
    clean: Dict[str, str] = {}
    for key, value in values.items():
        if value is None or value == "":
            continue
        if not isinstance(value, str):
            raise SecretRequestError(f"{key} must be a string")
        clean[str(key)] = value
    if req.kind == "password" and not clean.get("username") and req.username:
        clean["username"] = req.username
    try:
        validate_payload(req.kind, clean)
    except CredentialError as exc:
        # The message names fields only, never values.
        raise SecretRequestError(str(exc)) from None
    return clean


def _run(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _store_credential(req: SecretRequest, principal: Any, values: Mapping[str, str]) -> None:
    from hermes_cli.access import private
    from hermes_cli.credential_store import default_credential_store

    store = default_credential_store()
    _run(
        store.put(
            principal,
            provider=PROVIDER,
            name=req.name,
            kind=req.kind,
            payload=dict(values),
            visibility=private(principal.user_id),
        )
    )


def _claim_and_store(req: SecretRequest, principal: Any, values: Any) -> SecretRequest:
    clean = _clean_values(req, values)
    conn = connect()
    try:
        _expire_if_due(conn, req.id)
        with write_txn(conn):
            claimed = conn.execute(
                "UPDATE secret_requests SET status = ? WHERE id = ? AND status = ? "
                "AND expires_at > ?",
                (STORING, req.id, PENDING, time.time()),
            ).rowcount
        if claimed != 1:
            raise SecretRequestNotPending("this secret request is no longer open")
        try:
            _store_credential(req, principal, clean)
        except BaseException:
            with write_txn(conn):
                conn.execute(
                    "UPDATE secret_requests SET status = ? WHERE id = ? AND status = ?",
                    (PENDING, req.id, STORING),
                )
            raise
        with write_txn(conn):
            conn.execute(
                "UPDATE secret_requests SET status = ?, token_hash = NULL, resolved_at = ? "
                "WHERE id = ? AND status = ?",
                (STORED, time.time(), req.id, STORING),
            )
        done = _fetch(conn, "id = ?", req.id)
    finally:
        conn.close()
    assert done is not None
    return done


def fulfil(request_id: str, *, principal: Any, values: Any) -> SecretRequest:
    """Store the answer as the owner's ``secret``-provider credential.

    404 unknown, 403 not the owner, 409 not pending (single use).
    """
    req = get_request(request_id)
    if req is None:
        raise SecretRequestNotFound("no such secret request")
    if str(getattr(principal, "user_id", "") or "") != req.owner_user_id:
        raise SecretRequestForbidden("this secret request belongs to someone else")
    return _claim_and_store(req, principal, values)


def _owner_principal(user_id: str) -> Any:
    from hermes_cli.access import Principal

    return Principal(user_id=user_id, display=user_id, role="member")


def fulfil_by_token(token: str, *, values: Any) -> SecretRequest:
    """Link-page answer: the owner is taken from the row the token opens."""
    req = get_by_token(token)
    if req is None:
        raise SecretRequestNotFound("no such secret request")
    return _claim_and_store(req, _owner_principal(req.owner_user_id), values)


def decline(request_id_or_token: str, *, principal: Any = None) -> SecretRequest:
    """Close a pending request as declined (by id, or by link token).

    With ``principal`` the caller must own the request.
    """
    key = str(request_id_or_token or "")
    conn = connect()
    try:
        req = _fetch(conn, "id = ?", key) or _fetch(conn, "token_hash = ?", hash_token(key))
        if req is None:
            raise SecretRequestNotFound("no such secret request")
        if principal is not None and str(getattr(principal, "user_id", "") or "") != req.owner_user_id:
            raise SecretRequestForbidden("this secret request belongs to someone else")
        _expire_if_due(conn, req.id)
        with write_txn(conn):
            changed = conn.execute(
                "UPDATE secret_requests SET status = ?, token_hash = NULL, resolved_at = ? "
                "WHERE id = ? AND status = ?",
                (DECLINED, time.time(), req.id, PENDING),
            ).rowcount
        if changed != 1:
            raise SecretRequestNotPending("this secret request is no longer open")
        done = _fetch(conn, "id = ?", req.id)
    finally:
        conn.close()
    assert done is not None
    return done


def expire(request_id: str) -> bool:
    """Close a pending request as expired now (the waiter gave up)."""
    conn = connect()
    try:
        with write_txn(conn):
            return (
                conn.execute(
                    "UPDATE secret_requests SET status = ?, token_hash = NULL, resolved_at = ? "
                    "WHERE id = ? AND status = ?",
                    (EXPIRED, time.time(), request_id, PENDING),
                ).rowcount
                == 1
            )
    finally:
        conn.close()


def wait(
    request_id: str,
    timeout: float,
    *,
    poll: float = POLL_SECONDS,
    should_stop: Optional[Callable[[], bool]] = None,
) -> str:
    """Block until the request leaves ``pending``; return its final status.

    On timeout (or when ``should_stop()`` turns true) a still-pending request
    is marked ``expired``. A row mid-``fulfil`` is waited out briefly.
    """
    deadline = time.monotonic() + max(0.0, float(timeout))
    grace = 30.0
    while True:
        req = get_request(request_id)
        if req is None:
            return EXPIRED
        if req.status in (STORED, DECLINED, EXPIRED):
            return req.status
        if req.status == PENDING and req.expires_at <= time.time():
            expire(request_id)
            continue
        stop = bool(should_stop and should_stop())
        if stop or time.monotonic() >= deadline:
            if req.status == PENDING and expire(request_id):
                return EXPIRED
            if req.status == STORING:
                if grace <= 0:
                    return EXPIRED
                grace -= poll
        time.sleep(poll)
