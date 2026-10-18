"""The browser-session hub: state tracking + command round-trips.

Sessions are keyed by the authenticated user (from the signed WS ticket):
each user has at most one live browser session, and a newer connection only
supersedes that same user's older one. A command is always sent for a named
user, so one person's agent turn can never drive another person's browser
(security review F4). The hub keeps each user's last reported UI state and
brokers command/result pairs over the WebSocket with per-command futures and
a timeout, so an MCP tool always resolves — either with the browser's answer
or with a structured failure. Results and progress pings are only accepted
from the connection the command was sent to.
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol


class WsLike(Protocol):
    """Anything with an async send — keeps the hub testable without websockets."""

    async def send(self, message: str) -> None: ...


class HubError(RuntimeError):
    """A user-safe failure an MCP tool can hand straight back to the agent."""


NO_PRINCIPAL = (
    "app-mcp does not know which user this request is for, so it will not "
    "touch any browser session. (Hermes must forward the chat's user — set "
    "forward_principal: true on the app MCP server in config.yaml.)"
)


@dataclass
class _Session:
    conn: WsLike
    path: str | None = None
    element: dict[str, Any] | None = None
    state_at: float = 0.0


class Hub:
    def __init__(self, timeout: float = 10.0) -> None:
        self.timeout = timeout
        self._sessions: dict[str, _Session] = {}
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        # Which connection each in-flight command went to; results and
        # progress from any other connection are ignored.
        self._pending_conn: dict[str, WsLike] = {}
        # monotonic() of the last progress ping per in-flight command; makes
        # `timeout` a silence deadline so long-running commands (a large
        # file import uploads over HTTP for minutes) don't hit a fixed total
        # cap they can never beat.
        self._progress: dict[str, float] = {}
        # (bytes_sent, bytes_total) from the same pings, when the browser
        # includes them (currently only importFile) — lets folder_bridge_state
        # report real upload progress instead of just "still alive".
        self._progress_bytes: dict[str, tuple[int, int]] = {}

    # -- connection lifecycle ------------------------------------------------

    def attach(self, conn: WsLike, user: str) -> None:
        if not user:
            raise ValueError("Hub.attach needs the authenticated user")
        old = self._sessions.get(user)
        if old is not None and old.conn is not conn:
            # Newest connection of the SAME user wins; drop the stale one's work.
            self._fail_pending(old.conn, "Superseded by a newer app session")
        self._sessions[user] = _Session(conn=conn)

    def detach(self, conn: WsLike) -> None:
        for user, session in list(self._sessions.items()):
            if session.conn is conn:
                del self._sessions[user]
                self._fail_pending(conn, "The app disconnected mid-action")

    def _fail_pending(self, conn: WsLike, detail: str) -> None:
        for msg_id, owner in list(self._pending_conn.items()):
            if owner is not conn:
                continue
            fut = self._pending.pop(msg_id, None)
            if fut is not None and not fut.done():
                fut.set_result({"ok": False, "detail": detail, "state": None})
            self._pending_conn.pop(msg_id, None)
            self._progress.pop(msg_id, None)
            self._progress_bytes.pop(msg_id, None)

    def _session_for_conn(self, conn: WsLike) -> _Session | None:
        for session in self._sessions.values():
            if session.conn is conn:
                return session
        return None

    def _owns(self, msg_id: Any, conn: WsLike) -> bool:
        return isinstance(msg_id, str) and self._pending_conn.get(msg_id) is conn

    # -- inbound --------------------------------------------------------------

    def update_state(self, conn: WsLike, path: Any, element: Any) -> None:
        session = self._session_for_conn(conn)
        if session is None:
            return
        if isinstance(path, str) and path:
            session.path = path
        if isinstance(element, dict):
            session.element = element
        elif element is None:
            session.element = None
        session.state_at = time.time()

    def note_progress(
        self, conn: WsLike, msg_id: Any, sent: Any = None, total: Any = None
    ) -> None:
        """Refresh the silence deadline for an in-flight command.

        The browser pings `{type: "progress", id}` while a command runs;
        each ping resets the clock so `send_command` only fails after
        `timeout` seconds with no sign of life. `sent`/`total` are optional
        byte counts (currently sent only by importFile) surfaced through
        `state_summary()` for real upload progress, not just liveness.
        """
        if self._owns(msg_id, conn) and msg_id in self._pending:
            self._progress[msg_id] = time.monotonic()
            if isinstance(sent, (int, float)) and isinstance(total, (int, float)):
                self._progress_bytes[msg_id] = (int(sent), int(total))

    def resolve_result(self, conn: WsLike, msg_id: Any, payload: dict[str, Any]) -> None:
        if not self._owns(msg_id, conn):
            return
        fut = self._pending.pop(msg_id, None)
        self._pending_conn.pop(msg_id, None)
        self._progress_bytes.pop(msg_id, None)
        if fut is not None and not fut.done():
            clean = {k: v for k, v in payload.items() if k not in ("type", "id")}
            fut.set_result(clean)

    # -- outbound -------------------------------------------------------------

    @property
    def connected(self) -> bool:
        """True when any user has a live session (diagnostics only)."""
        return bool(self._sessions)

    def is_connected(self, user: str | None) -> bool:
        return bool(user) and user in self._sessions

    def state_summary(self, user: str | None) -> dict[str, Any]:
        session = self._sessions.get(user) if user else None
        summary: dict[str, Any] = {
            "connected": session is not None,
            "user": user if session is not None else None,
            "page": session.path if session else None,
            "element": session.element if session else None,
            "state_age_s": (
                round(time.time() - session.state_at, 1)
                if session and session.state_at
                else None
            ),
        }
        if session is None:
            return summary
        # Surface the most advanced in-flight upload of THIS user's session —
        # one browser session runs one Folder Bridge command at a time, so
        # "most bytes sent" is effectively "the current one".
        uploads = [
            st
            for msg_id, st in self._progress_bytes.items()
            if self._pending_conn.get(msg_id) is session.conn
        ]
        if uploads:
            sent, total = max(uploads, key=lambda st: st[0])
            summary["active_upload"] = {
                "bytes_sent": sent,
                "bytes_total": total,
                "percent": round(100 * sent / total, 1) if total else None,
            }
        return summary

    async def send_command(self, command: dict[str, Any], user: str | None) -> dict[str, Any]:
        """Send one command to `user`'s browser and await its structured result."""
        if not user:
            raise HubError(NO_PRINCIPAL)
        session = self._sessions.get(user)
        if session is None:
            raise HubError("No app session connected — the user's app is not reachable.")
        conn = session.conn
        msg_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[msg_id] = fut
        self._pending_conn[msg_id] = conn
        self._progress[msg_id] = time.monotonic()
        try:
            await conn.send(json.dumps({"type": "cmd", "id": msg_id, "command": command}))
            while True:
                try:
                    # shield() so a slice timeout doesn't cancel the future —
                    # the browser may still be working and pinging progress.
                    return await asyncio.wait_for(
                        asyncio.shield(fut), timeout=self.timeout
                    )
                except asyncio.TimeoutError:
                    last = self._progress.get(msg_id, 0.0)
                    if time.monotonic() - last < self.timeout:
                        continue
                    raise HubError(
                        "Timed out waiting for the app to execute the action."
                    ) from None
        finally:
            self._pending.pop(msg_id, None)
            self._pending_conn.pop(msg_id, None)
            self._progress.pop(msg_id, None)
            self._progress_bytes.pop(msg_id, None)
