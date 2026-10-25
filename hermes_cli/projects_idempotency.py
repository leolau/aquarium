"""Server-side idempotency for project writes.

The browser sends an ``Idempotency-Key`` with every project mutation and
re-sends the *same* key on Retry. This ASGI middleware makes sure the
backend acts at most once per key:

- first request with a key: claimed (in flight), executed, and — when it
  succeeds (2xx) — its status and body are stored for 24 h;
- the same key again with the same request: the stored answer is replayed
  with ``Idempotent-Replayed: true`` and the route does **not** run again;
- the same key while the first is still running: wait briefly for it,
  then replay, or answer 409 "This action is already in progress.";
- the same key on a different method/path/body: 422.

A refused or failed attempt (non-2xx) releases its key, so Retry after a
real refusal runs the action again instead of replaying the refusal.
Streaming responses (``text/event-stream``) are passed through untouched
and never recorded. Requests without the header, and reads, are not
touched at all.

It is mounted on the app (not per router), so every route under
``/api/registry/projects`` — including ones added in new router modules —
the project-category routes under ``/api/registry/project-categories``, and
the FG-33 tool/app and quota routes under ``/api/tools`` and ``/api/quotas``
are covered. Keys are scoped per principal; the store is its own small
SQLite file (WAL) next to ``projects.db`` so it is safe across processes.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

PROJECTS_PREFIX = "/api/registry/projects"
CATEGORIES_PREFIX = "/api/registry/project-categories"
TOOLS_PREFIX = "/api/tools"
QUOTAS_PREFIX = "/api/quotas"
COVERED_PREFIXES = (PROJECTS_PREFIX, CATEGORIES_PREFIX, TOOLS_PREFIX, QUOTAS_PREFIX)
MUTATING_METHODS = frozenset({"POST", "PATCH", "PUT", "DELETE"})
HEADER = "idempotency-key"
REPLAYED_HEADER = "Idempotent-Replayed"

TTL_SECONDS = 24 * 60 * 60
#: How long a repeat waits for an in-flight original before answering 409.
WAIT_SECONDS = 3.0
#: An in-flight claim older than this is treated as abandoned (the process
#: that took it died) and may be taken over.
LEASE_SECONDS = 10 * 60
MAX_KEY_LENGTH = 200
#: Responses larger than this are passed through but not recorded.
MAX_RECORDED_BYTES = 2 * 1024 * 1024

IN_PROGRESS_DETAIL = "This action is already in progress."
MISMATCH_DETAIL = "This Idempotency-Key was already used for a different request."
KEY_TOO_LONG_DETAIL = "Idempotency-Key is too long."

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS idempotency_keys (
    principal    TEXT NOT NULL,
    key          TEXT NOT NULL,
    method       TEXT NOT NULL,
    path         TEXT NOT NULL,
    body_hash    TEXT NOT NULL,
    status       INTEGER,
    content_type TEXT,
    body         BLOB,
    created_at   REAL NOT NULL,
    completed_at REAL,
    PRIMARY KEY (principal, key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
"""


def idempotency_db_path() -> Path:
    """``HERMES_IDEMPOTENCY_DB``, else ``projects_idempotency.db`` beside
    the projects DB (so tests that isolate ``HERMES_PROJECTS_DB`` isolate
    this too)."""
    override = os.environ.get("HERMES_IDEMPOTENCY_DB", "").strip()
    if override:
        return Path(override).expanduser()
    from hermes_cli import projects_db

    return projects_db.projects_db_path().parent / "projects_idempotency.db"


@dataclass(frozen=True)
class Stored:
    method: str
    path: str
    body_hash: str
    status: Optional[int]
    content_type: Optional[str]
    body: Optional[bytes]
    created_at: float


@dataclass(frozen=True)
class Claim:
    """``owner`` — run it; ``replay`` — answer ``stored``; ``in_flight`` —
    someone else is running it; ``mismatch`` — key reused for another
    request."""

    outcome: str
    stored: Optional[Stored] = None


class IdempotencyStore:
    def __init__(
        self,
        db_path: Optional[Path] = None,
        *,
        ttl_seconds: float = TTL_SECONDS,
        lease_seconds: float = LEASE_SECONDS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._db_path = db_path
        self.ttl_seconds = ttl_seconds
        self.lease_seconds = lease_seconds
        self.clock = clock
        self._initialized: set[str] = set()
        self._init_lock = threading.Lock()

    @staticmethod
    def _initialize(conn: sqlite3.Connection) -> None:
        """Switch to WAL and create the schema.

        ``PRAGMA journal_mode=WAL`` ignores ``busy_timeout``, so a first
        connection racing another process (or a writer) gets "database is
        locked" straight away; retry briefly instead of failing the request.
        """
        from hermes_state import apply_wal_with_fallback

        delay = 0.02
        for attempt in range(8):
            try:
                apply_wal_with_fallback(conn, db_label="projects_idempotency.db")
                conn.executescript(SCHEMA_SQL)
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 7:
                    raise
                time.sleep(delay)
                delay = min(delay * 2, 0.5)

    @contextlib.contextmanager
    def _connect(self):
        path = self._db_path or idempotency_db_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(path), timeout=10.0, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=10000")
            resolved = str(path.resolve())
            if resolved not in self._initialized:
                with self._init_lock:
                    if resolved not in self._initialized:
                        self._initialize(conn)
                        self._initialized.add(resolved)
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _row(row) -> Stored:
        return Stored(
            method=row["method"],
            path=row["path"],
            body_hash=row["body_hash"],
            status=row["status"],
            content_type=row["content_type"],
            body=row["body"],
            created_at=row["created_at"],
        )

    def claim(
        self, principal: str, key: str, method: str, path: str, body_hash: str
    ) -> Claim:
        now = self.clock()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    "DELETE FROM idempotency_keys WHERE created_at < ?",
                    (now - self.ttl_seconds,),
                )
                row = conn.execute(
                    "SELECT * FROM idempotency_keys WHERE principal = ? AND key = ?",
                    (principal, key),
                ).fetchone()
                if row is None:
                    conn.execute(
                        "INSERT INTO idempotency_keys"
                        " (principal, key, method, path, body_hash, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (principal, key, method, path, body_hash, now),
                    )
                    result = Claim("owner")
                else:
                    stored = self._row(row)
                    if (stored.method, stored.path, stored.body_hash) != (
                        method,
                        path,
                        body_hash,
                    ):
                        result = Claim("mismatch", stored)
                    elif stored.status is not None:
                        result = Claim("replay", stored)
                    elif now - stored.created_at > self.lease_seconds:
                        conn.execute(
                            "UPDATE idempotency_keys SET created_at = ?"
                            " WHERE principal = ? AND key = ?",
                            (now, principal, key),
                        )
                        result = Claim("owner")
                    else:
                        result = Claim("in_flight", stored)
                conn.execute("COMMIT")
                return result
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def complete(
        self,
        principal: str,
        key: str,
        status: int,
        content_type: Optional[str],
        body: bytes,
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                "UPDATE idempotency_keys SET status = ?, content_type = ?, body = ?,"
                " completed_at = ? WHERE principal = ? AND key = ? AND status IS NULL",
                (status, content_type, body, self.clock(), principal, key),
            )

    def release(self, principal: str, key: str) -> None:
        """Drop an in-flight claim (the attempt failed or was not recordable)."""
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM idempotency_keys"
                " WHERE principal = ? AND key = ? AND status IS NULL",
                (principal, key),
            )


async def _default_principal(request) -> str:
    from hermes_cli.projects_api import _principal_write

    principal = await _principal_write(request)
    return str(principal.user_id)


def _header(scope, name: str) -> Optional[str]:
    target = name.encode("latin-1")
    for k, v in scope.get("headers") or []:
        if k.lower() == target:
            return v.decode("latin-1")
    return None


def _covers(path: str) -> bool:
    return any(
        path == prefix or path.startswith(prefix + "/")
        for prefix in COVERED_PREFIXES
    )


async def _json_response(send, status: int, payload: dict, extra=()) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                *extra,
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class ProjectsIdempotencyMiddleware:
    """Pure ASGI (not ``BaseHTTPMiddleware``) so streaming bodies flow
    through chunk by chunk and are never buffered."""

    def __init__(
        self,
        app,
        *,
        store: Optional[IdempotencyStore] = None,
        wait_seconds: float = WAIT_SECONDS,
        poll_seconds: float = 0.05,
        principal_resolver: Optional[Callable[[object], Awaitable[str]]] = None,
    ) -> None:
        self.app = app
        self.store = store or IdempotencyStore()
        self.wait_seconds = wait_seconds
        self.poll_seconds = poll_seconds
        self.principal_resolver = principal_resolver or _default_principal

    async def __call__(self, scope, receive, send):
        if (
            scope.get("type") != "http"
            or scope.get("method", "").upper() not in MUTATING_METHODS
            or not _covers(scope.get("path", ""))
        ):
            await self.app(scope, receive, send)
            return
        key = (_header(scope, HEADER) or "").strip()
        if not key:
            await self.app(scope, receive, send)
            return
        if len(key) > MAX_KEY_LENGTH:
            await _json_response(send, 422, {"detail": KEY_TOO_LONG_DETAIL})
            return

        body, disconnected = await self._read_body(receive)
        replay_receive = self._replaying(body, receive)
        if disconnected:
            await self.app(scope, replay_receive, send)
            return

        try:
            from starlette.requests import Request

            principal = await self.principal_resolver(Request(scope, replay_receive))
        except Exception:
            # The route resolves the same principal and refuses the same way;
            # nothing executes, so there is nothing to make idempotent.
            await self.app(scope, self._replaying(body, receive), send)
            return

        method = scope["method"].upper()
        query = scope.get("query_string", b"").decode("latin-1")
        path = scope["path"] + (f"?{query}" if query else "")
        body_hash = hashlib.sha256(body).hexdigest()

        deadline = time.monotonic() + self.wait_seconds
        while True:
            claim = await asyncio.to_thread(
                self.store.claim, principal, key, method, path, body_hash
            )
            if claim.outcome != "in_flight" or time.monotonic() >= deadline:
                break
            await asyncio.sleep(self.poll_seconds)

        if claim.outcome == "mismatch":
            await _json_response(send, 422, {"detail": MISMATCH_DETAIL})
            return
        if claim.outcome == "in_flight":
            await _json_response(send, 409, {"detail": IN_PROGRESS_DETAIL})
            return
        if claim.outcome == "replay":
            stored = claim.stored
            assert stored is not None and stored.status is not None
            payload = stored.body or b""
            headers = [
                (b"content-length", str(len(payload)).encode()),
                (REPLAYED_HEADER.lower().encode(), b"true"),
            ]
            if stored.content_type:
                headers.append((b"content-type", stored.content_type.encode("latin-1")))
            await send(
                {"type": "http.response.start", "status": stored.status, "headers": headers}
            )
            await send({"type": "http.response.body", "body": payload})
            return

        await self._execute(scope, self._replaying(body, receive), send, principal, key)

    async def _execute(self, scope, receive, send, principal: str, key: str) -> None:
        state = {
            "status": 0,
            "content_type": None,
            "record": True,
            "chunks": [],
            "size": 0,
            "done": False,
        }

        async def send_wrapper(message):
            kind = message["type"]
            if kind == "http.response.start":
                state["status"] = int(message["status"])
                for k, v in message.get("headers") or []:
                    if k.lower() == b"content-type":
                        state["content_type"] = v.decode("latin-1")
                ctype = (state["content_type"] or "").lower()
                if not 200 <= state["status"] < 300 or "text/event-stream" in ctype:
                    state["record"] = False
            elif kind == "http.response.body" and not state["done"]:
                if state["record"]:
                    chunk = message.get("body", b"") or b""
                    state["size"] += len(chunk)
                    if state["size"] > MAX_RECORDED_BYTES:
                        state["record"] = False
                        state["chunks"] = []
                    else:
                        state["chunks"].append(chunk)
                if not message.get("more_body", False):
                    state["done"] = True
                    if state["record"]:
                        # Recorded before the final chunk reaches the client,
                        # so a retry the client fires on seeing the answer
                        # always finds it.
                        try:
                            await asyncio.to_thread(
                                self.store.complete,
                                principal,
                                key,
                                state["status"],
                                state["content_type"],
                                b"".join(state["chunks"]),
                            )
                            state["stored"] = True
                        except Exception:
                            logger.warning("idempotency: could not record response", exc_info=True)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if not state.get("stored"):
                try:
                    await asyncio.to_thread(self.store.release, principal, key)
                except Exception:
                    logger.warning("idempotency: could not release key", exc_info=True)

    @staticmethod
    async def _read_body(receive) -> tuple[bytes, bool]:
        chunks: list[bytes] = []
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return b"".join(chunks), True
            chunks.append(message.get("body", b"") or b"")
            if not message.get("more_body", False):
                return b"".join(chunks), False

    @staticmethod
    def _replaying(body: bytes, receive):
        sent = False

        async def _receive():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        return _receive
