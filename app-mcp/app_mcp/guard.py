"""Destructive-action guard for app-mcp.

``app_act`` (the safe tool) refuses to operate elements whose accessible name
reads like a destructive or externally-visible action; the agent must call
``app_act_destructive`` instead, which Hermes gates behind its tool-approval
flow (``approvals.tools: [mcp_app_app_act_destructive]``). The check is
word-boundary based, so "Filter" or "Sender settings" never match, while
"Delete task", "Archive", "Send" do.
"""
from __future__ import annotations

import re

DESTRUCTIVE_WORDS = (
    "delete",
    "remove",
    "archive",
    "destroy",
    "drop",
    "erase",
    "purge",
    "send",
    "submit",
    "publish",
    "post",
    "deliver",
    "deactivate",
    "suspend",
    "revoke",
    "terminate",
    "unsubscribe",
)

_PATTERN = re.compile(r"\b(" + "|".join(DESTRUCTIVE_WORDS) + r")\b", re.IGNORECASE)


def looks_destructive(name: str | None) -> bool:
    """True when the element's accessible name reads like a destructive action."""
    if not name:
        return False
    return bool(_PATTERN.search(name))


# Fields whose value must never reach agent context (snapshot / read).
SENSITIVE_WORDS = (
    "password",
    "passcode",
    "passphrase",
    "secret",
    "token",
    "api key",
    "api-key",
    "apikey",
    "private key",
    "pin",
    "otp",
    "one-time code",
    "credential",
)

_SENSITIVE = re.compile(
    r"\b(?:" + "|".join(re.escape(w) for w in SENSITIVE_WORDS) + r")s?\b",
    re.IGNORECASE,
)


def looks_sensitive(name: str | None) -> bool:
    """True when a field's accessible name reads like it holds a secret."""
    if not name:
        return False
    return bool(_SENSITIVE.search(name))
