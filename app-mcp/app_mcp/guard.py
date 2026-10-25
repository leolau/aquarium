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


# Approval and consent controls: only the human may press these (security
# review F17/F18). Refused for app_act AND app_act_destructive, by name here
# and by the page's `data-appmcp-deny` marker (snapshot `denied: true`).
# Going live is consent too (FG-33 P8-0 0.3): deploy/publish/make live/
# redeploy/unlink. "delete" stays destructive-only; new Delete buttons carry
# the page marker instead.
CONSENT_WORDS = (
    r"approve[sd]?",
    r"approval",
    r"re-?approv\w*",
    r"allow",
    r"deny",
    r"denied",
    r"grant",
    r"authori[sz]e",
    r"trust",
    r"trusted",
    r"consent",
    r"acknowledge",
    r"deploy(?:s|ing)?",
    r"re-?deploy(?:s|ing)?",
    r"publish(?:es|ing)?",
    r"make\s+live",
    r"unlink(?:s|ing)?",
)

_CONSENT = re.compile(r"\b(?:" + "|".join(CONSENT_WORDS) + r")\b", re.IGNORECASE)


def looks_like_consent(name: str | None) -> bool:
    """True when the control's name reads like an approval/consent decision."""
    if not name:
        return False
    return bool(_CONSENT.search(name))


def is_user_only(entry: dict) -> bool:
    """A control app-mcp must never operate: page-marked or consent-named."""
    return bool(entry.get("denied")) or looks_like_consent(str(entry.get("name") or ""))
