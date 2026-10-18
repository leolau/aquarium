"""Bearer-token check for the loopback MCP endpoint (security review F19).

``/mcp`` listens on 127.0.0.1 only, but any local process (including the
agent's own terminal) can reach loopback, and a direct ``tools/call`` would
skip the in-agent approval gate. Hermes therefore sends
``Authorization: Bearer <token>``.

The token is the file ``$HERMES_HOME/auth/app-mcp-token`` (mode 0600). Hermes
creates it the first time it connects (``tools/mcp_tool.py``); app-mcp only
reads it, re-reading it for every request (its unit is ProtectSystem=strict and
cannot write there). While app-mcp has no ``HERMES_HOME`` or the file does not
exist, the endpoint stays open, which is the behaviour before this check.
"""
from __future__ import annotations

import hmac
import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

TOKEN_RELPATH = Path("auth") / "app-mcp-token"

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def token_file() -> Path | None:
    home = os.environ.get("HERMES_HOME", "").strip()
    return Path(home) / TOKEN_RELPATH if home else None


def read_token(path: Path | None) -> str:
    if path is None:
        return ""
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _presented_token(scope: Scope) -> str:
    for key, value in scope.get("headers") or []:
        if key.lower() == b"authorization":
            scheme, _, token = value.decode("latin-1").strip().partition(" ")
            if scheme.lower() == "bearer":
                return token.strip()
    return ""


class BearerTokenMiddleware:
    """Refuse HTTP requests that do not carry the shared bearer token."""

    def __init__(self, app: ASGIApp, token_file: Path | None) -> None:
        self.app = app
        self.token_file = token_file

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        token = read_token(self.token_file) if scope.get("type") == "http" else ""
        if not token:
            await self.app(scope, receive, send)
            return
        presented = _presented_token(scope)
        if presented and hmac.compare_digest(presented.encode(), token.encode()):
            await self.app(scope, receive, send)
            return
        body = json.dumps({"error": "app-mcp: missing or wrong bearer token"}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 401,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"www-authenticate", b'Bearer realm="app-mcp"'),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


__all__ = ["TOKEN_RELPATH", "BearerTokenMiddleware", "read_token", "token_file"]
