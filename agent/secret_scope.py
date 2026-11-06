"""Profile-scoped credential resolution for multi-profile gateway multiplexing.

The multiplexing gateway serves many profiles from one process. Each profile
has its own ``.env`` with its own provider keys and platform tokens, so we
**cannot** union them into the process-global ``os.environ`` (that would leak
profile A's keys to profile B's turns, and to every subprocess spawned with
``env=dict(os.environ)``).

This module provides a fail-closed, context-local secret scope:

- ``set_secret_scope(mapping)`` installs the active profile's secrets for the
  current task (a contextvar, so it propagates into the agent's worker thread
  via ``copy_context()`` exactly like the HERMES_HOME override).
- ``get_secret(name)`` reads from that scope. When multiplexing is **active**
  and no scope is set, it RAISES rather than silently falling back to
  ``os.environ`` — an un-migrated or newly-added call site fails loud at that
  exact line instead of leaking another profile's value. When multiplexing is
  **off** (the default), it transparently reads ``os.environ`` so the
  single-profile gateway and every non-gateway caller behave exactly as before.

Design rationale lives in ``docs/design/multiplexing-gateway.md`` (Workstream A).
"""
from __future__ import annotations

import hashlib
import os
from contextvars import ContextVar, Token
from pathlib import Path
from typing import Dict, FrozenSet, Iterable, Mapping, MutableMapping, Optional


# ── multiplex-active flag ────────────────────────────────────────────────
# Process-global: set once at gateway startup when gateway.multiplex_profiles
# is true. Governs whether get_secret() fails closed on an unscoped read.
# A plain module global (not a contextvar): it describes the deployment mode,
# not a per-task value.
_MULTIPLEX_ACTIVE: bool = False


def set_multiplex_active(active: bool) -> None:
    """Mark whether the process is running as a profile multiplexer.

    Called once at gateway startup, and at dashboard startup when the box has
    more than one profile. When True, ``get_secret`` fails closed on an
    unscoped read instead of falling back to ``os.environ``.
    """
    global _MULTIPLEX_ACTIVE
    _MULTIPLEX_ACTIVE = bool(active)


def is_multiplex_active() -> bool:
    """Return whether the process is running as a profile multiplexer."""
    return _MULTIPLEX_ACTIVE


# The profile home whose credentials ``os.environ`` holds, when the process
# declares one. The dashboard loads only its own profile's ``.env`` into
# ``os.environ`` and switches to another profile through
# ``profile_runtime_scope``; so with multiplexing on, an unscoped read made
# while ``HERMES_HOME`` still resolves to that home is the dashboard's own
# profile reading its own value — startup, background jobs, executor threads.
# A read under another profile's ``HERMES_HOME`` with no secret scope still
# fails closed. The gateway never sets it, so it keeps failing every unscoped
# read.
_ENVIRON_HOME: Optional[Path] = None


def set_environ_home(home: Optional[Path]) -> None:
    """Declare the profile home ``os.environ``'s credentials belong to (or None)."""
    global _ENVIRON_HOME
    _ENVIRON_HOME = Path(home).resolve() if home is not None else None


def _environ_is_current_profile() -> bool:
    if _ENVIRON_HOME is None:
        return False
    from hermes_constants import get_hermes_home

    try:
        return Path(get_hermes_home()).resolve() == _ENVIRON_HOME
    except OSError:
        return False


# Names that reached os.environ from an env file in this process. See
# note_env_file_keys() for why the provenance has to be remembered.
_ENV_FILE_KEYS: set[str] = set()


# ── the secret scope contextvar ──────────────────────────────────────────
_SECRET_SCOPE: ContextVar[Optional[Mapping[str, str]]] = ContextVar(
    "_SECRET_SCOPE", default=None
)


class UnscopedSecretError(RuntimeError):
    """Raised when a secret is read in multiplex mode with no scope installed.

    This is the fail-closed signal: it means a credential read reached
    ``get_secret`` without a profile scope active, which in a multiplexer would
    otherwise leak whichever profile's value happened to be in ``os.environ``.
    The fix is to wrap the call path in ``set_secret_scope(...)`` (the per-turn
    / per-adapter profile scope), not to widen the allowlist.
    """


def set_secret_scope(secrets: Optional[Mapping[str, str]]) -> Token:
    """Install the active profile's secret mapping for the current context.

    Returns a token for ``reset_secret_scope``. Pass ``None`` to clear.
    """
    return _SECRET_SCOPE.set(secrets)


def reset_secret_scope(token: Token) -> None:
    """Restore the previous secret scope."""
    _SECRET_SCOPE.reset(token)


def current_secret_scope() -> Optional[Mapping[str, str]]:
    """Return the active secret mapping, or None when no scope is installed."""
    return _SECRET_SCOPE.get()


# ── genuinely-global env vars (NOT per-profile secrets) ──────────────────
# These are process/deployment-level settings, not profile credentials. They
# legitimately live in os.environ and must keep reading from it even in
# multiplex mode — routing them through the fail-closed path would wrongly
# crash. Anything matching is read from os.environ regardless of scope.
#
# Membership test is by exact name OR prefix (see _is_global_env). Keep this
# list tight: when in doubt a value is a profile secret, not a global.
_GLOBAL_ENV_EXACT = frozenset({
    # Hermes runtime / deployment
    "HERMES_HOME", "HERMES_PROFILE", "HERMES_GATEWAY_LOCK_DIR",
    "HERMES_MAX_ITERATIONS", "HERMES_MAX_TOKENS", "HERMES_API_TIMEOUT",
    "HERMES_REDACT_SECRETS", "HERMES_NOUS_TIMEOUT_SECONDS",
    "_HERMES_GATEWAY",
    # OS / interpreter
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TZ", "PWD", "SHELL", "TMPDIR",
    "VIRTUAL_ENV", "PYTHONPATH", "SSL_CERT_FILE",
    # Kanban paths (per-board, not per-profile-secret)
    "HERMES_KANBAN_DB", "HERMES_KANBAN_WORKSPACES_ROOT", "HERMES_KANBAN_BOARD",
    # The box's one GoTrue (FG-28 decision D2): accounts are box-wide, so its
    # URL and keys are too, under every name ``members.load_admin_client``
    # reads. A profile without its own Supabase .env must still reach it.
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY",
    "SUPABASE_JWT_SECRET", "SUPABASE_SERVICE_KEY",
    "HERMES_DASHBOARD_SUPABASE_URL",
    "HERMES_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY",
    "HERMES_SUPABASE_SERVICE_ROLE_KEY",
    # ...and every name the dashboard's Supabase auth provider reads.
    "HERMES_DASHBOARD_SUPABASE_ANON_KEY", "HERMES_DASHBOARD_SUPABASE_JWT_SECRET",
    "HERMES_DASHBOARD_SUPABASE_AUDIENCE", "GOTRUE_JWT_SECRET",
})
_GLOBAL_ENV_PREFIXES = (
    "HERMES_KANBAN_",
    "HERMES_TELEGRAM_",   # tuning knobs (batch delays, fallback toggles) — NOT the token
    "TERMINAL_",          # terminal/sandbox backend settings
)


def _is_global_env(name: str) -> bool:
    """Return True for genuinely process-global (non-profile-secret) env vars."""
    if name in _GLOBAL_ENV_EXACT:
        return True
    return any(name.startswith(p) for p in _GLOBAL_ENV_PREFIXES)


def get_secret(name: str, default: Optional[str] = None) -> Optional[str]:
    """Resolve a credential by env-var name, honoring the active profile scope.

    Resolution order:

    1. Genuinely-global vars (``_is_global_env``) always read ``os.environ`` —
       they are deployment settings, not profile secrets.
    2. When a secret scope is installed (multiplexed turn), read from it; an
       absent key returns ``default``. The scope is authoritative — we do NOT
       fall through to ``os.environ``, because in a multiplexer ``os.environ``
       may hold another profile's value.
    3. No scope installed:
       - multiplex INACTIVE (default deployment): read ``os.environ`` —
         identical to the legacy ``os.getenv`` behavior every caller had before.
       - multiplex ACTIVE: FAIL CLOSED. Raise ``UnscopedSecretError`` so the
         missing scope is caught loudly instead of leaking a cross-profile value
         — unless ``HERMES_HOME`` resolves to the home declared with
         ``set_environ_home`` (the process's own profile), whose values
         ``os.environ`` holds.
    """
    if _is_global_env(name):
        val = os.environ.get(name)
        return val if val is not None else default

    scope = _SECRET_SCOPE.get()
    if scope is not None:
        val = scope.get(name)
        return val if val is not None else default

    if _MULTIPLEX_ACTIVE and not _environ_is_current_profile():
        raise UnscopedSecretError(
            f"get_secret({name!r}) called with no profile secret scope active "
            f"while multiplexing is on. This credential read must run inside a "
            f"set_secret_scope(...) block (the per-turn / per-adapter profile "
            f"scope). Reading os.environ here would risk leaking another "
            f"profile's value. See docs/design/multiplexing-gateway.md "
            f"(Workstream A)."
        )

    val = os.environ.get(name)
    return val if val is not None else default


def scope_fingerprint() -> str:
    """A short, stable id for the active scope's *contents* — "" when unscoped.

    Callers that cache a value derived from secrets (``load_config`` caches the
    ``${VAR}``-expanded config) must key that cache on the scope as well as on
    the file, or profile A's turn serves profile B a config expanded with A's
    credentials. Content-based rather than ``id(mapping)`` so the same profile
    entering a second turn — a fresh dict with identical values — still hits its
    cache instead of re-parsing the file every turn.

    The digest is not reversible and is never logged with a value beside it, so
    it does not widen exposure of the secrets it summarises.
    """
    scope = _SECRET_SCOPE.get()
    if scope is None:
        return ""
    digest = hashlib.blake2b(digest_size=8)
    for key in sorted(scope):
        digest.update(key.encode("utf-8", "replace"))
        digest.update(b"\x00")
        digest.update(str(scope[key]).encode("utf-8", "replace"))
        digest.update(b"\x00")
    return digest.hexdigest()


def expand_env_ref(name: str) -> Optional[str]:
    """Resolve a ``${NAME}`` config reference against the active profile.

    Deliberately *not* ``get_secret``: config expansion runs on paths that
    legitimately have no scope installed — the CLI, and the multiplexer's own
    startup before any turn — so failing closed here would abort the process
    rather than catch a missed migration. Under a scope the scope is
    authoritative (no ``os.environ`` fallback, which is the leak this exists to
    close); with no scope it reads ``os.environ`` exactly as before.
    """
    if _is_global_env(name):
        return os.environ.get(name)
    scope = _SECRET_SCOPE.get()
    if scope is not None:
        return scope.get(name)
    return os.environ.get(name)


def note_env_file_keys(keys: Iterable[str]) -> None:
    """Record that ``keys`` were written into ``os.environ`` from an env file.

    ``load_hermes_dotenv`` calls this. The set is what lets a spawned child be
    corrected per profile: a value in ``os.environ`` that came from *a* profile's
    ``.env`` is by definition profile-owned, so under another profile's scope it
    is wrong, whereas a value the operator exported in the unit file or the shell
    is deployment-level and must survive untouched. Nothing distinguishes the two
    once they are both strings in ``os.environ``, so the provenance has to be
    remembered at load time.

    Process-global and append-only, like ``_MULTIPLEX_ACTIVE``: it describes what
    this process has done to its own environment, not a per-task value.
    """
    _ENV_FILE_KEYS.update(keys)


def env_file_keys() -> FrozenSet[str]:
    """Names ``os.environ`` received from an env file in this process."""
    return frozenset(_ENV_FILE_KEYS)


def apply_scope_to_subprocess_env(env: MutableMapping[str, str]) -> None:
    """Correct an already-filtered child environment to the active profile.

    A child process cannot see a contextvar, so a spawn inside profile B's turn
    inherits whatever ``os.environ`` holds — and in a multiplexer that is the
    default profile's ``.env``, loaded at import time before any turn. A
    ``claude``/``codex`` executor spawned for B then authenticates as A, and a
    terminal command with a skill-registered passthrough key reads A's value.

    Two rules, applied to the dict the caller has *already* filtered:

    - a key the scope defines and that survived filtering takes the scope's
      value;
    - a key that came from an env file but is absent from the scope is dropped,
      because inheriting another profile's value is worse than the child finding
      nothing.

    It deliberately never *adds* a key. The blocklists in
    ``tools/environments/local.py`` decide what a child may see at all; this only
    corrects *whose* value it is, so a profile scope can never re-admit a
    credential a spawn surface had stripped on purpose.

    No-op when nothing is scoped, which is every single-profile deployment.
    """
    scope = _SECRET_SCOPE.get()
    if scope is None:
        return
    for key in list(env):
        if _is_global_env(key):
            continue
        if key in scope:
            env[key] = str(scope[key])
        elif key in _ENV_FILE_KEYS:
            del env[key]


def load_env_file(env_path: Path) -> Dict[str, str]:
    """Parse a ``.env`` file into a plain dict WITHOUT touching ``os.environ``.

    Used to load a profile's secrets into an isolated mapping for
    ``set_secret_scope``. Mirrors python-dotenv's basic parsing (KEY=VALUE,
    ``export`` prefix, ``#`` comments, optional matching quotes) but never
    mutates the process environment — that isolation is the whole point.
    """
    secrets: Dict[str, str] = {}
    try:
        text = env_path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return secrets

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        secrets[key] = value

    return secrets


def build_profile_secret_scope(hermes_home: Path) -> Dict[str, str]:
    """Build a profile's secret mapping from its ``<home>/.env``.

    Returns a fresh dict (safe to install via ``set_secret_scope``). Genuinely
    global vars are intentionally NOT copied in — ``get_secret`` reads those
    from ``os.environ`` directly, so the scope holds only profile secrets.
    """
    return load_env_file(Path(hermes_home) / ".env")

