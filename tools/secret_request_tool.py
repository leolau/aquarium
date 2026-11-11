"""FG-37 ``request_secret``: ask the person for a secret without chat text.

The tool opens a request in :mod:`hermes_cli.secret_requests`, hands it to the
surface the turn runs on, and blocks until the person stores it, declines it
or it expires. The person types the value into a masked popup (agent-home
chat) or a one-time link page (messaging); it goes straight to their
credential store. The tool result only ever carries the status and the
secret's **name** — never the value.

Surfaces:

* chat surface (agent-home streamed turns): registered per run with
  :func:`register_secret_surface` under the approval session key, exactly like
  ``tools.approval.register_gateway_notify``. It receives the
  ``secret.request`` event payload and, later, the final status.
* link sender (messaging turns): registered per turn by ``gateway/run.py`` in
  :mod:`gateway.secret_links`. It opens the request with a one-time link,
  sends the link to the person and returns its ``request_id``; the tool then
  waits on that request like any other.

With neither, the tool answers ``unavailable``.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from tools.registry import registry, tool_error

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 900

#: ``notify(event)`` gets the ``secret.request`` payload; ``resolved(request_id,
#: status)`` the outcome. Both run in the agent thread and must not block.
SecretNotify = Callable[[Dict[str, Any]], None]
SecretResolved = Callable[[str, str], None]


@dataclass(frozen=True)
class _Surface:
    notify: SecretNotify
    resolved: Optional[SecretResolved] = None


_lock = threading.Lock()
_surfaces: Dict[str, _Surface] = {}

UNAVAILABLE_HINT = (
    "This conversation cannot show a secure secret prompt. Do not ask for the "
    "secret in chat. Ask the person to add it in Settings -> Connected accounts "
    "(as a secret named '{name}') and tell you when it is there."
)


def register_secret_surface(
    session_key: str, notify: SecretNotify, resolved: Optional[SecretResolved] = None
) -> None:
    with _lock:
        _surfaces[session_key] = _Surface(notify, resolved)


def unregister_secret_surface(session_key: str) -> None:
    with _lock:
        _surfaces.pop(session_key, None)


def _surface_for(session_key: str) -> Optional[_Surface]:
    with _lock:
        return _surfaces.get(session_key) if session_key else None


def _session(name: str) -> str:
    try:
        from gateway.session_context import get_session_env

        return get_session_env(name, "") or ""
    except Exception:
        return ""


def _current_key() -> str:
    from tools.approval import get_current_session_key

    return get_current_session_key(default="")


def _owner_user_id() -> Optional[str]:
    from tools.access_policy import current_principal

    user_id, _role = current_principal()
    if user_id:
        return str(user_id)
    try:
        from hermes_cli.credential_store import resolve_owner_principal
        from hermes_cli.secret_requests import _run

        owner = _run(resolve_owner_principal(None))
        return getattr(owner, "user_id", None)
    except Exception:
        logger.debug("request_secret: no owner principal", exc_info=True)
        return None


def _profile() -> str:
    try:
        from hermes_cli.profiles import get_active_profile_name

        return get_active_profile_name() or ""
    except Exception:
        return ""


def _unavailable(name: str, reason: str = "") -> str:
    out = {"status": "unavailable", "hint": UNAVAILABLE_HINT.format(name=name)}
    if reason:
        out["reason"] = reason
    return json.dumps(out)


def _interrupted() -> bool:
    try:
        from tools.interrupt import is_interrupted

        return is_interrupted()
    except Exception:
        return False


def request_secret_tool(
    name: str,
    label: Optional[str] = None,
    purpose: Optional[str] = None,
    kind: str = "secret",
    username: Optional[str] = None,
    *,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> str:
    from hermes_cli import secret_requests as sr

    kind = (kind or "secret").strip()
    try:
        name = sr.validate_name(name)
    except sr.SecretRequestError as exc:
        return tool_error(str(exc))
    if kind not in sr.KINDS:
        return tool_error(f"kind must be one of {', '.join(sr.KINDS)}")

    session_key = _current_key()
    label = (label or "").strip() or name
    purpose = (purpose or "").strip()
    username = (username or "").strip() or None
    surface = _surface_for(session_key)
    if surface is None:
        return _request_by_link(sr, name, label, purpose, kind, username, session_key, timeout)

    owner = _owner_user_id()
    if not owner:
        return _unavailable(name, "no signed-in person is bound to this conversation")

    try:
        req, _token = sr.open_request(
            owner_user_id=owner,
            profile=_profile(),
            session_key=_session("HERMES_SESSION_KEY") or session_key,
            run_id=session_key or None,
            name=name,
            label=label,
            purpose=purpose,
            kind=kind,
            username=username,
            channel="agent-home",
            ttl_seconds=timeout,
            with_link=False,
        )
    except sr.SecretRequestError as exc:
        return tool_error(str(exc))

    try:
        surface.notify(
            {
                "request_id": req.id,
                "name": req.name,
                "label": req.label,
                "purpose": req.purpose,
                "kind": req.kind,
                "username": req.username,
                "expires_at": req.expires_at,
            }
        )
    except Exception:
        logger.warning("request_secret: surface failed for %s", req.id, exc_info=True)
        sr.expire(req.id)
        return _unavailable(name, "the secure prompt could not be shown")

    status = sr.wait(req.id, timeout, should_stop=_interrupted)
    if surface.resolved is not None:
        try:
            surface.resolved(req.id, status)
        except Exception:
            logger.debug("request_secret: resolved callback failed", exc_info=True)
    return _result(status, req.name, req.kind)


def _request_by_link(sr, name, label, purpose, kind, username, session_key, timeout) -> str:
    """Messaging turn: the gateway's link sender opens the request and sends the link."""
    try:
        from gateway.secret_links import get_secret_link_sender

        sender = get_secret_link_sender(session_key) if session_key else None
    except Exception:
        sender = None
    if sender is None:
        return _unavailable(name)
    try:
        sent = sender(
            name=name,
            label=label,
            purpose=purpose,
            kind=kind,
            username=username,
            run_id=session_key or None,
            ttl_seconds=int(timeout),
        ) or {}
    except Exception:
        logger.warning("request_secret: link sender failed", exc_info=True)
        return _unavailable(name, "the secure link could not be sent")
    request_id = sent.get("request_id")
    if sent.get("status") == "error":
        return tool_error(str(sent.get("error") or "invalid secret request"))
    if sent.get("status") != "sent" or not request_id:
        hint = sent.get("hint") or UNAVAILABLE_HINT.format(name=name)
        return json.dumps({"status": "unavailable", "hint": hint})
    return _result(sr.wait(request_id, timeout, should_stop=_interrupted), name, kind)


def _result(status: str, name: str, kind: str) -> str:
    if status == "stored":
        return json.dumps({"status": "stored", "secret": name, "kind": kind})
    return json.dumps({"status": status})


REQUEST_SECRET_SCHEMA = {
    "name": "request_secret",
    "description": (
        "Ask the person for a password, personal access token, API key or other "
        "secret through a secure masked prompt. NEVER ask for secrets as chat "
        "text. The person types it into the prompt and it is saved to their "
        "credential store under `name`; you only get the name back, never the "
        "value. Blocks until they save it, decline, or it expires. Returns "
        "{\"status\": \"stored\", \"secret\": name, \"kind\": kind} or "
        "{\"status\": \"declined\" | \"expired\" | \"unavailable\"}. Refer to the "
        "secret by name afterwards. Use kind='password' to ask for a username "
        "and password pair."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": (
                    "Slug to save it under, e.g. 'github-pat' (lowercase a-z, 0-9, "
                    "'.', '_', '-'; max 64)."
                ),
            },
            "label": {
                "type": "string",
                "description": "What to ask for, shown as the prompt title, e.g. 'GitHub personal access token'.",
            },
            "purpose": {
                "type": "string",
                "description": "Why you need it, shown to the person, e.g. 'Push the fix to leolau/aquarium'.",
            },
            "kind": {
                "type": "string",
                "enum": ["secret", "password"],
                "description": "'secret' for one value (default); 'password' for username + password.",
            },
            "username": {
                "type": "string",
                "description": "Optional username to prefill when kind='password'.",
            },
        },
        "required": ["name", "label", "purpose"],
    },
}


registry.register(
    name="request_secret",
    toolset="secrets",
    schema=REQUEST_SECRET_SCHEMA,
    handler=lambda args, **kw: request_secret_tool(
        name=args.get("name", ""),
        label=args.get("label"),
        purpose=args.get("purpose"),
        kind=args.get("kind") or "secret",
        username=args.get("username"),
    ),
    emoji="🔑",
)
