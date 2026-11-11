"""FG-37 W4: one-time secure links for secrets the agent asks for over messaging.

When ``request_secret`` runs on a WhatsApp, Telegram or email turn there is no
popup to open, so the gateway sends the person a link
``<agent_home.public_url>/secret/<token>`` instead. The link works once,
expires with the request (15 minutes) and needs no sign-in: the token is the
credential, and the value goes straight to the credential store of the person
who was chatting (``secret_requests.fulfil_by_token`` takes the owner from the
request row).

Per turn, ``gateway/run.py`` registers a sender for the session key (the same
lifecycle as ``tools.approval.register_gateway_notify``). The tool calls
:func:`send_secret_link` (or looks the sender up with
:func:`get_secret_link_sender`) and then waits on the returned ``request_id``.

The URL and token live only in the message to the person. Nothing here logs
them, and the tool result is a placeholder (``"secure link sent"``), so the
link never enters the transcript or the model's context.
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_TTL_SECONDS = 900
SEND_TIMEOUT_SECONDS = 15.0

SecretLinkSender = Callable[..., Dict[str, Any]]

_senders: Dict[str, SecretLinkSender] = {}
_lock = threading.Lock()

# Not messaging channels: agent-home chat has its own popup (W1/W3), and the
# local/CLI surfaces have no person on the other end of a link.
_NO_LINK_PLATFORMS = frozenset({"api_server", "local", "webhook", "cron"})

_UNSAFE_URL_CHARS = re.compile(r"[\s\"'<>\\`\x00-\x1f\x7f]")

HINT_NO_PUBLIC_URL = (
    "Secure links are not set up on this Aquarium (agent_home.public_url is "
    "not an https address). Do not ask for the secret in chat; ask the person "
    "to add it in agent-home under Settings → Connected accounts."
)
HINT_UNLINKED = (
    "This chat is not linked to an Aquarium account, so there is nowhere safe "
    "to store a secret. Do not ask for it in chat; ask the person to add it in "
    "agent-home under Settings → Connected accounts."
)
HINT_GROUP = (
    "Secure links are only sent in a direct chat with one person, never in a "
    "group. Do not ask for the secret here; ask the person to message you "
    "directly or add it in agent-home under Settings → Connected accounts."
)
HINT_NO_CHANNEL = (
    "Secure links can only be sent over WhatsApp, Telegram or email. Ask the "
    "person to add the secret in agent-home under Settings → Connected accounts."
)
HINT_SEND_FAILED = (
    "The secure link could not be delivered. Do not ask for the secret in "
    "chat; ask the person to add it in agent-home under Settings → Connected "
    "accounts."
)
HINT_NO_REGISTRY = (
    "Secret requests are not available on this Aquarium. Ask the person to add "
    "the secret in agent-home under Settings → Connected accounts."
)


def _unavailable(hint: str) -> Dict[str, Any]:
    return {"status": "unavailable", "hint": hint}


def register_secret_link_sender(session_key: str, sender: SecretLinkSender) -> None:
    """Bind ``sender`` to ``session_key`` for the duration of one gateway turn."""
    with _lock:
        _senders[session_key] = sender


def unregister_secret_link_sender(session_key: str) -> None:
    with _lock:
        _senders.pop(session_key, None)


def get_secret_link_sender(session_key: str) -> Optional[SecretLinkSender]:
    with _lock:
        return _senders.get(session_key)


def send_secret_link(session_key: Optional[str] = None, **request: Any) -> Dict[str, Any]:
    """Send a link for the current (or given) session; ``unavailable`` if none.

    ``request`` takes the sender's keyword arguments: ``name``, ``label``,
    ``purpose``, ``kind``, ``username``, ``run_id``, ``ttl_seconds``.
    """
    if session_key is None:
        try:
            from tools.approval import get_current_session_key

            session_key = get_current_session_key(default="")
        except Exception:
            session_key = ""
    sender = get_secret_link_sender(session_key or "")
    if sender is None:
        return _unavailable(HINT_NO_CHANNEL)
    return sender(**request)


def public_base_url(config: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """``agent_home.public_url`` without a trailing slash, or ``None``.

    Only an absolute ``https://`` URL with a host and no query/fragment is
    accepted; anything else (empty, ``http://``, a bare host, quotes or
    whitespace) means no links.
    """
    if config is None:
        try:
            from hermes_cli.config import load_config_readonly

            config = load_config_readonly() or {}
        except Exception:
            return None
    section = config.get("agent_home") if isinstance(config, dict) else None
    raw = section.get("public_url") if isinstance(section, dict) else None
    value = str(raw or "").strip()
    if not value or _UNSAFE_URL_CHARS.search(value):
        return None
    from urllib.parse import urlsplit

    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    if parts.query or parts.fragment or parts.username or parts.password:
        return None
    return value.rstrip("/")


def link_message(*, label: str, purpose: str, url: str, ttl_seconds: int) -> str:
    """The plain-text message carrying the link (works on every channel)."""
    minutes = max(1, int(round(ttl_seconds / 60)))
    lines = [f"🔒 Secure link for: {label}"]
    if purpose:
        lines.append(f"Why: {purpose}")
    lines += [
        "",
        f"Open this link to type or paste it: {url}",
        f"It works once and expires in {minutes} minutes. No sign-in needed.",
        "Please never send the secret itself as a chat message.",
    ]
    return "\n".join(lines)


def _platform_name(source: Any) -> str:
    platform = getattr(source, "platform", None)
    return str(getattr(platform, "value", platform) or "").lower()


def make_link_sender(
    *,
    source: Any,
    adapter: Any,
    chat_id: str,
    loop: Any,
    session_key: str,
    profile: str = "",
    metadata: Optional[Dict[str, Any]] = None,
    config_loader: Optional[Callable[[], Dict[str, Any]]] = None,
) -> SecretLinkSender:
    """Build the per-turn sender ``gateway/run.py`` registers.

    The sender runs on the agent thread: it opens the request with
    ``with_link=True`` for the session's internal user, schedules the message
    on the gateway loop through the platform adapter and waits (bounded) for
    delivery. It refuses with ``unavailable`` — never guessing an owner — when
    the sender has no linked principal, the chat is a group, the platform is
    not a messaging channel or ``agent_home.public_url`` is not https.
    """

    def _send(
        *,
        name: str,
        label: str,
        purpose: str = "",
        kind: str = "secret",
        username: Optional[str] = None,
        run_id: Optional[str] = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> Dict[str, Any]:
        platform = _platform_name(source)
        if not platform or platform in _NO_LINK_PLATFORMS or adapter is None:
            return _unavailable(HINT_NO_CHANNEL)
        chat_type = str(getattr(source, "chat_type", "dm") or "dm").lower()
        if chat_type != "dm":
            return _unavailable(HINT_GROUP)
        owner = str(getattr(source, "internal_user_id", "") or "").strip()
        if not owner:
            return _unavailable(HINT_UNLINKED)
        cfg = config_loader() if config_loader is not None else None
        base = public_base_url(cfg)
        if not base:
            return _unavailable(HINT_NO_PUBLIC_URL)
        try:
            from hermes_cli import secret_requests
        except Exception:
            logger.warning("secret link: request registry unavailable", exc_info=True)
            return _unavailable(HINT_NO_REGISTRY)

        try:
            request, token = secret_requests.open_request(
                owner_user_id=owner,
                profile=profile or "default",
                session_key=session_key,
                run_id=run_id,
                name=name,
                label=label,
                purpose=purpose,
                kind=kind,
                username=username,
                channel=platform,
                ttl_seconds=int(ttl_seconds),
                with_link=True,
            )
        except (ValueError, secret_requests.SecretRequestError) as exc:
            # Bad name/kind from the model: tell it, the message is ours.
            return {"status": "error", "error": str(exc)}
        except Exception:
            logger.warning("secret link: could not open the request", exc_info=True)
            return _unavailable(HINT_NO_REGISTRY)
        request_id = str(getattr(request, "id", "") or "")
        if not token:
            _decline_quietly(secret_requests, request_id)
            return _unavailable(HINT_NO_REGISTRY)

        text = link_message(
            label=label or name,
            purpose=purpose,
            url=f"{base}/secret/{token}",
            ttl_seconds=int(ttl_seconds),
        )
        if not _deliver(adapter, chat_id, text, metadata, loop):
            _decline_quietly(secret_requests, request_id)
            return _unavailable(HINT_SEND_FAILED)
        try:
            adapter.pause_typing_for_chat(chat_id)
        except Exception:
            pass
        return {
            "status": "sent",
            "request_id": request_id,
            "expires_at": getattr(request, "expires_at", None),
            "channel": platform,
            "message": "secure link sent",
        }

    return _send


def _deliver(adapter: Any, chat_id: str, text: str, metadata: Any, loop: Any) -> bool:
    from agent.async_utils import safe_schedule_threadsafe

    try:
        fut = safe_schedule_threadsafe(
            adapter.send(chat_id, text, metadata=metadata),
            loop,
            logger=logger,
            log_message="secret link: send scheduling error",
        )
        if fut is None:
            return False
        result = fut.result(timeout=SEND_TIMEOUT_SECONDS)
    except Exception as exc:
        # The exception text can never contain the link: it is not in scope.
        logger.warning("secret link: send failed: %s", type(exc).__name__)
        return False
    ok = bool(getattr(result, "success", result is not None and result is not False))
    if not ok:
        logger.warning("secret link: adapter refused the message")
    return ok


def _decline_quietly(registry: Any, request_id: str) -> None:
    if not request_id:
        return
    try:
        registry.decline(request_id)
    except Exception:
        logger.debug("secret link: could not close request %s", request_id, exc_info=True)
