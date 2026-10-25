"""Operator Telegram alerts shared by the ops scripts and timers.

Moved here from ``scripts/check_runtime_drift.py`` (FG-33 P8-2 item 2.4) so the
drift check, the deploy-state check, the secret backup and the local-app watch
timer (``hermes_cli/app_watch.py``) all page the instance owner through the
same path, with no new channel. Stdlib only: callers run it with ``python -I``
and some of them as root.

The destination is read from the environment the unit loads (the profile's
``.env``): ``TELEGRAM_BOT_TOKEN`` plus ``TELEGRAM_HOME_CHANNEL`` (or the first
of ``TELEGRAM_ALLOWED_USERS``), and an optional thread.
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.request import Request, urlopen


def telegram_target() -> tuple[str, str, str]:
    """Resolve (token, chat_id, thread_id) from the environment.

    ``TELEGRAM_HOME_CHANNEL`` is the destination Hermes' own setup writes;
    ``TELEGRAM_ALLOWED_USERS`` is the fallback for deployments that never
    bound a home channel. Thread selection follows the same precedence the
    rest of the project uses for scheduled delivery: a cron-specific thread
    overrides the home channel's default topic.
    """
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_HOME_CHANNEL", "").strip()
    if not chat_id:
        chat_id = os.environ.get("TELEGRAM_ALLOWED_USERS", "").split(",")[0].strip()
    thread_id = (
        os.environ.get("TELEGRAM_CRON_THREAD_ID", "").strip()
        or os.environ.get("TELEGRAM_HOME_CHANNEL_THREAD_ID", "").strip()
    )
    return token, chat_id, thread_id


def notify(text: str, *, tag: str = "drift") -> bool:
    """Send *text* to the configured Telegram destination.

    Returns True on success. A failure here is reported but never fatal —
    the report has already been printed to the journal by then.
    """
    token, chat_id, thread_id = telegram_target()
    if not token or not chat_id:
        print(f"[{tag}] no Telegram credentials — skipping notification")
        return False
    payload: dict[str, Any] = {"chat_id": chat_id, "text": text}
    if thread_id:
        payload["message_thread_id"] = thread_id
    request = Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=10) as response:  # noqa: S310 — fixed https URL
            return json.loads(response.read().decode()).get("ok", False)
    except (OSError, ValueError) as exc:
        print(f"[{tag}] Telegram notification failed: {exc}")
        return False


__all__ = ["notify", "telegram_target"]
