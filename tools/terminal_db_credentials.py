"""Whether the agent's terminal may see the database credentials (F16).

``DATABASE_URL`` and the Supabase service-role key give full access to the
app database. The gateway needs them, but a shell command the model writes
does not, unless the operator wants the agent to run database CLIs itself
(``hermes promote``, ``hermes owner transfer``, the office-documents registry
script). That is what ``security.terminal_database_credentials`` turns on.
"""

from __future__ import annotations

import os

SETTING = "security.terminal_database_credentials"

GATED_ENV_VARS = frozenset({
    "DATABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_SERVICE_KEY",
    "HERMES_SUPABASE_SERVICE_ROLE_KEY",
    "HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY",
})

# Set in the agent's shell when the variables above were held back, so a
# Hermes CLI started from that shell can say why instead of failing on a
# missing DSN.
HIDDEN_MARKER = "HERMES_TERMINAL_DB_CREDENTIALS_HIDDEN"


def allowed() -> bool:
    """True only when config.yaml says ``true``; anything else hides them."""
    try:
        from hermes_cli.config import read_raw_config

        section = read_raw_config().get("security") or {}
        return isinstance(section, dict) and section.get("terminal_database_credentials") is True
    except Exception:
        return False


def is_gated(name: str) -> bool:
    return name.upper() in GATED_ENV_VARS


def hide_from(env: dict) -> None:
    """Drop the gated variables from *env* unless the setting allows them."""
    if allowed():
        env.pop(HIDDEN_MARKER, None)
        return
    for key in [k for k in env if is_gated(k)]:
        del env[key]
    env[HIDDEN_MARKER] = "1"


def hidden_hint() -> str:
    """Explanation to append to a "not configured" error, or ``""``."""
    if os.environ.get(HIDDEN_MARKER) != "1":
        return ""
    return (
        " The agent's terminal does not get DATABASE_URL or "
        "SUPABASE_SERVICE_ROLE_KEY by default. To let the agent run this, an "
        f"operator sets {SETTING}: true in config.yaml "
        f"(hermes config set {SETTING} true)."
    )
