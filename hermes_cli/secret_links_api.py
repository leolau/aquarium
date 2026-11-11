"""FG-37 W4: public one-time secret-link endpoints.

``GET  /api/secret-links/{token}`` — what is being asked for:
``{label, purpose, kind, username, expires_at}``.
``POST /api/secret-links/{token}`` — ``{"values": {...}}`` stores the secret in
the credential store of the person who was chatting (``fulfil_by_token`` takes
the owner from the request row); ``{"decline": true}`` closes the request.

No login: the 256-bit token, sent only to that person's own chat, IS the
credential. So every failure that could tell an attacker something about a
token — unknown, already used, expired, declined — is the same 404; requests
are throttled per IP and per token; every response is ``no-store`` /
``no-referrer``; and neither the token nor the body is ever logged (the
uvicorn access log redacts the path, see :class:`SecretLinkAccessLogFilter`).

The registry is per profile (``secret_requests.db`` in that profile's
``HERMES_HOME``), and the link carries no profile, so a token is looked up in
each profile home that has a registry, inside that profile's runtime scope —
which is also the scope its credential store is written in.
"""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from hermes_cli.invitations import RedeemThrottle

logger = logging.getLogger(__name__)

router = APIRouter()

PATH_PREFIX = "/api/secret-links/"
REGISTRY_FILENAME = "secret_requests.db"
MAX_BODY_BYTES = 16 * 1024
MAX_VALUE_CHARS = 8192
_KIND_FIELDS = {"secret": ("value", "username", "note"), "password": ("username", "password")}
_KIND_REQUIRED = {"secret": ("value",), "password": ("password",)}

_SECURITY_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "X-Content-Type-Options": "nosniff",
}
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

# Per token: a handful of tries (page load + submit + a retry or two). Per IP:
# enough for a few people behind one NAT, far too few to scan 2^256 tokens.
_throttle = RedeemThrottle(max_attempts=10, window_seconds=600.0, ip_max_attempts=30)
# A fulfil is a read-check-write across a credential store and the registry;
# serialise them in this process so two racing submits can't both pass the
# lookup before W1's single-use write lands (W1 also enforces it in SQLite).
_fulfil_lock = threading.Lock()


def _json(status: int, body: Dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=status, content=body, headers=dict(_SECURITY_HEADERS))


def _not_found() -> JSONResponse:
    return _json(404, {"ok": False, "error": "not_found"})


def _client_ip(request: Request) -> str:
    """First ``X-Forwarded-For`` hop only behind an on-box (loopback) proxy.

    Same rule as ``web_server._forwarded_client_ip``: every request arrives via
    the agent-home BFF, so the peer alone is one bucket for the whole internet,
    and a header from a non-loopback peer is spoofable.
    """
    peer = (request.client.host if request.client else "").lower()
    if peer in _LOOPBACK_HOSTS:
        candidate = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
        if candidate:
            return candidate
    return peer


def _token_shape_ok(token: str) -> bool:
    # token_urlsafe(32) → 43 chars of [A-Za-z0-9_-]; allow some slack.
    return 20 <= len(token) <= 128 and all(c.isalnum() or c in "-_" for c in token)


def _registry() -> Any:
    from hermes_cli import secret_requests

    return secret_requests


def _registry_homes() -> List[Path]:
    """Profile homes that have a secret-request registry, current home first."""
    from hermes_constants import get_hermes_home

    homes: List[Path] = []
    seen: set = set()

    def _add(path: Optional[Path]) -> None:
        if path is None:
            return
        try:
            resolved = Path(path).resolve()
        except OSError:
            return
        if resolved in seen or not (resolved / REGISTRY_FILENAME).is_file():
            return
        seen.add(resolved)
        homes.append(resolved)

    _add(get_hermes_home())
    try:
        from hermes_cli.profiles import _get_default_hermes_home, _get_profiles_root

        _add(_get_default_hermes_home())
        root = _get_profiles_root()
        if root.is_dir():
            for child in sorted(root.iterdir()):
                if child.is_dir():
                    _add(child)
    except Exception:
        logger.debug("secret link: profile scan failed", exc_info=True)
    return homes


@contextmanager
def _profile_scope(home: Path) -> Iterator[None]:
    from hermes_constants import get_hermes_home

    try:
        if Path(get_hermes_home()).resolve() == home:
            yield
            return
    except OSError:
        pass
    from agent.profile_runtime import profile_runtime_scope

    with profile_runtime_scope(home):
        yield


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _locate(token: str) -> Optional[tuple]:
    """``(home, request)`` for a pending, unexpired token, else ``None``."""
    registry = _registry()
    for home in _registry_homes():
        with _profile_scope(home):
            try:
                found = registry.get_by_token(token)
            except Exception:
                logger.warning("secret link: registry lookup failed", exc_info=False)
                found = None
        if found is not None:
            return home, found
    return None


def _throttled(request: Request, token: str) -> bool:
    return not _throttle.allow(ip=_client_ip(request) or "unknown", token=token)


@router.get("/api/secret-links/{token}")
async def get_secret_link(token: str, request: Request) -> JSONResponse:
    if _throttled(request, token):
        return _json(429, {"ok": False, "error": "rate_limited"})
    if not _token_shape_ok(token):
        return _not_found()
    located = await run_in_threadpool(_locate, token)
    if located is None:
        return _not_found()
    _home, req = located
    kind = str(_field(req, "kind") or "secret")
    return _json(
        200,
        {
            "ok": True,
            "label": str(_field(req, "label") or _field(req, "name") or ""),
            "purpose": str(_field(req, "purpose") or ""),
            "kind": kind,
            "username": _field(req, "username") or None,
            "expires_at": _field(req, "expires_at"),
        },
    )


def _clean_values(kind: str, raw: Any) -> Optional[Dict[str, str]]:
    allowed = _KIND_FIELDS.get(kind)
    if allowed is None or not isinstance(raw, dict):
        return None
    values: Dict[str, str] = {}
    for key, val in raw.items():
        if key not in allowed or not isinstance(val, str) or len(val) > MAX_VALUE_CHARS:
            return None
        if val.strip():
            values[key] = val
    if any(not values.get(k) for k in _KIND_REQUIRED[kind]):
        return None
    return values


@router.post("/api/secret-links/{token}")
async def post_secret_link(token: str, request: Request) -> JSONResponse:
    if _throttled(request, token):
        return _json(429, {"ok": False, "error": "rate_limited"})
    body_bytes = await request.body()
    if len(body_bytes) > MAX_BODY_BYTES:
        return _json(413, {"ok": False, "error": "too_large"})
    import json

    try:
        body = json.loads(body_bytes or b"{}")
    except ValueError:
        return _json(400, {"ok": False, "error": "invalid"})
    finally:
        del body_bytes
    if not isinstance(body, dict):
        return _json(400, {"ok": False, "error": "invalid"})
    if not _token_shape_ok(token):
        return _not_found()
    return await run_in_threadpool(_submit, token, body)


def _submit(token: str, body: Dict[str, Any]) -> JSONResponse:
    registry = _registry()
    with _fulfil_lock:
        located = _locate(token)
        if located is None:
            return _not_found()
        home, req = located
        if body.get("decline") is True:
            with _profile_scope(home):
                try:
                    registry.decline(token)
                except Exception:
                    return _not_found()
            return _json(200, {"ok": True, "status": "declined"})

        kind = str(_field(req, "kind") or "secret")
        values = _clean_values(kind, body.get("values"))
        body.clear()
        if values is None:
            return _json(400, {"ok": False, "error": "invalid"})
        with _profile_scope(home):
            try:
                stored = registry.fulfil_by_token(token, values=values)
            except getattr(registry, "SecretRequestError", ()) as exc:
                if getattr(exc, "status_code", None) != 400:
                    return _not_found()
                # Values the kind rejects (e.g. a password with no username):
                # the link is still open, so let the page ask again.
                return _json(400, {"ok": False, "error": "invalid"})
            except Exception as exc:
                # Never format the exception: it could carry a value.
                logger.warning("secret link: fulfil failed (%s)", type(exc).__name__)
                stored = None
            finally:
                values.clear()
        if stored is None or str(_field(stored, "status") or "stored") != "stored":
            return _not_found()
        return _json(200, {"ok": True, "status": "stored", "name": str(_field(stored, "name") or "")})


def redact_path(path: str) -> str:
    """Replace the token in a secret-link path with ``[redacted]``."""
    if path.startswith(PATH_PREFIX):
        return PATH_PREFIX + "[redacted]"
    return path


class SecretLinkAccessLogFilter(logging.Filter):
    """Strip secret-link tokens from uvicorn access-log records.

    uvicorn's access record args are ``(client, method, full_path, http_version,
    status)``; the path (with any query) is rewritten in place.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            if PATH_PREFIX in args[2]:
                record.args = args[:2] + (redact_path(args[2]),) + args[3:]
        elif isinstance(record.msg, str) and PATH_PREFIX in record.msg:
            head, _, _tail = record.msg.partition(PATH_PREFIX)
            record.msg = head + PATH_PREFIX + "[redacted]"
        return True


_ACCESS_FILTER = SecretLinkAccessLogFilter()


def install_access_log_redaction() -> None:
    """Attach the redaction filter to uvicorn's access logger (idempotent)."""
    access = logging.getLogger("uvicorn.access")
    if _ACCESS_FILTER not in access.filters:
        access.addFilter(_ACCESS_FILTER)


install_access_log_redaction()
