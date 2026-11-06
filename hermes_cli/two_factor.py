"""Optional two-factor login (TOTP, RFC 6238) for password sign-in.

Each person may turn it on for their own login: Aquarium makes a secret, the
person scans it into an authenticator app, confirms one code, and gets ten
one-time recovery codes. From then on ``/auth/password-login`` asks for a code
after the password checks out.

Storage: one file per login, ``<root>/auth/two_factor/<sha256(user)>.json``
(directory 0700, file 0600), at the box root the profile registry hangs off —
never a profile home. Accounts are box-wide (one GoTrue), so a login's second
step is too: a request scoped to another profile reads and writes the same file
(FG-28 B5). The TOTP secret is kept as-is (the app needs the same value to make
codes), recovery codes only as salted SHA-256 hashes.

Nothing changes for anyone who has not turned it on: :func:`any_enabled` is a
directory listing, so an install where nobody uses it never even resolves a
principal at sign-in.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import hermes_constants


def _pyotp():
    # Imported on use: sign-in for people without two-factor never needs it.
    import pyotp

    return pyotp

ISSUER = "Aquarium"
RECOVERY_CODE_COUNT = 10
#: An unconfirmed setup (QR shown, code not typed yet) expires after this.
PENDING_TTL_SECONDS = 15 * 60
#: Wrong codes allowed per person in :data:`FAILURE_WINDOW_SECONDS`.
MAX_FAILURES = 5
FAILURE_WINDOW_SECONDS = 15 * 60
#: Accept the code before and after the current 30-second step (clock drift).
_VALID_WINDOW = 1
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_lock = threading.Lock()


class TwoFactorError(Exception):
    """A request that can't be done in the current state (plain-words message)."""


class TwoFactorLocked(TwoFactorError):
    """Too many wrong codes recently; try again later."""


def _dir(home: Optional[Path] = None) -> Path:
    return (home or hermes_constants.get_default_hermes_root()) / "auth" / "two_factor"


def _legacy_dir(home: Optional[Path] = None) -> Optional[Path]:
    """Where a pre-FG-28 process kept the files, when that is not the root.

    Records were written under the process's own ``HERMES_HOME``. That is the
    root on a standard install (the default profile home *is* the root), so
    this is ``None`` there; only a process launched with a named profile home
    has older records to read. Never the per-request scope.
    """
    if home is not None:
        return None
    launched = os.environ.get("HERMES_HOME", "").strip()
    if not launched:
        return None
    legacy = Path(launched) / "auth" / "two_factor"
    root = _dir()
    if hermes_constants.resolve_path_cached(legacy) == hermes_constants.resolve_path_cached(root):
        return None
    return legacy


def _name(user_id: str) -> str:
    return hashlib.sha256(user_id.encode("utf-8")).hexdigest() + ".json"


def _path(user_id: str, home: Optional[Path] = None) -> Path:
    return _dir(home) / _name(user_id)


def _legacy_path(user_id: str, home: Optional[Path] = None) -> Optional[Path]:
    legacy = _legacy_dir(home)
    return legacy / _name(user_id) if legacy is not None else None


@contextmanager
def _locked() -> Iterator[None]:
    with _lock:
        yield


def _read(path: Path) -> Optional[dict[str, Any]]:
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def _write(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(record, handle)
    os.replace(tmp, path)


def _load(user_id: str, home: Optional[Path] = None) -> dict[str, Any]:
    """The record at the root, else a pre-FG-28 one (rewritten to the root on save)."""
    record = _read(_path(user_id, home))
    if record is None:
        legacy = _legacy_path(user_id, home)
        record = _read(legacy) if legacy is not None else None
    return record or {"user_id": user_id}


def _normalise_code(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


def _hash_recovery(code: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{_normalise_code(code)}".encode("utf-8")).hexdigest()


def _new_recovery_codes() -> list[str]:
    def one() -> str:
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(8))
        return f"{raw[:4]}-{raw[4:]}"

    return [one() for _ in range(RECOVERY_CODE_COUNT)]


def _store_recovery(record: dict[str, Any], codes: list[str]) -> None:
    salt = secrets.token_hex(16)
    record["recovery_salt"] = salt
    record["recovery_hashes"] = [_hash_recovery(c, salt) for c in codes]


def _is_enabled(record: dict[str, Any]) -> bool:
    return bool(record.get("enabled")) and bool(record.get("secret"))


def any_enabled(home: Optional[Path] = None) -> bool:
    """True when at least one person on this install has two-factor login on."""
    entries: list[Path] = []
    for directory in (_dir(home), _legacy_dir(home)):
        if directory is None:
            continue
        try:
            entries.extend(directory.glob("*.json"))
        except OSError:
            continue
    return any(_is_enabled(_read(p) or {}) for p in entries)


def is_enabled(user_id: str, home: Optional[Path] = None) -> bool:
    return bool(user_id) and _is_enabled(_load(user_id, home))


def status(user_id: str, home: Optional[Path] = None) -> dict[str, Any]:
    record = _load(user_id, home)
    enabled = _is_enabled(record)
    return {
        "enabled": enabled,
        "recovery_codes_left": len(record.get("recovery_hashes") or []) if enabled else 0,
    }


def start(user_id: str, account_name: str, home: Optional[Path] = None) -> dict[str, str]:
    """Make a new secret (not active until :func:`confirm`). Returns secret + otpauth URI."""
    with _locked():
        record = _load(user_id, home)
        if _is_enabled(record):
            raise TwoFactorError("Two-factor login is already on. Turn it off first.")
        secret = _pyotp().random_base32()
        record["pending_secret"] = secret
        record["pending_created"] = int(time.time())
        _write(_path(user_id, home), record)
    uri = _pyotp().TOTP(secret).provisioning_uri(
        name=account_name or user_id, issuer_name=ISSUER
    )
    return {"secret": secret, "otpauth_uri": uri}


def _recent_failures(record: dict[str, Any], now: float) -> list[float]:
    cutoff = now - FAILURE_WINDOW_SECONDS
    return [t for t in record.get("failures") or [] if isinstance(t, (int, float)) and t >= cutoff]


def _check_totp(secret: str, code: str, record: dict[str, Any], now: float) -> bool:
    """Match ``code`` against ``secret``; refuses a step already used (no replay)."""
    digits = _normalise_code(code)
    if len(digits) != 6 or not digits.isdigit():
        return False
    totp = _pyotp().TOTP(secret)
    last = int(record.get("last_step") or 0)
    current = int(now // totp.interval)
    for offset in range(-_VALID_WINDOW, _VALID_WINDOW + 1):
        step = current + offset
        if step <= last:
            continue
        if hmac.compare_digest(totp.at(step * totp.interval), digits):
            record["last_step"] = step
            return True
    return False


def _guarded(record: dict[str, Any], now: float) -> None:
    failures = _recent_failures(record, now)
    record["failures"] = failures
    if len(failures) >= MAX_FAILURES:
        raise TwoFactorLocked(
            "Too many wrong codes. Wait 15 minutes and try again."
        )


def _fail(record: dict[str, Any], now: float) -> None:
    record["failures"] = _recent_failures(record, now) + [now]


def confirm(user_id: str, code: str, home: Optional[Path] = None) -> list[str]:
    """Turn two-factor login on if ``code`` matches the pending secret.

    Returns the recovery codes (shown once; only hashes are kept).
    """
    now = time.time()
    with _locked():
        path = _path(user_id, home)
        record = _load(user_id, home)
        secret = str(record.get("pending_secret") or "")
        created = int(record.get("pending_created") or 0)
        if not secret or now - created > PENDING_TTL_SECONDS:
            raise TwoFactorError("This setup has expired. Start again to get a new code.")
        _guarded(record, now)
        if not _check_totp(secret, code, record, now):
            _fail(record, now)
            _write(path, record)
            raise TwoFactorError("That code doesn't match. Check the time on your phone and try the newest code.")
        codes = _new_recovery_codes()
        record.update(
            secret=secret,
            enabled=True,
            enabled_at=int(now),
            failures=[],
        )
        record.pop("pending_secret", None)
        record.pop("pending_created", None)
        _store_recovery(record, codes)
        _write(path, record)
    return codes


def verify(user_id: str, code: str, home: Optional[Path] = None) -> bool:
    """Check a sign-in code: a 6-digit app code or an unused recovery code.

    A recovery code is used up. Raises :class:`TwoFactorLocked` after
    :data:`MAX_FAILURES` wrong codes in :data:`FAILURE_WINDOW_SECONDS`.
    """
    now = time.time()
    with _locked():
        path = _path(user_id, home)
        record = _load(user_id, home)
        if not _is_enabled(record):
            return False
        _guarded(record, now)
        if _check_totp(str(record["secret"]), code, record, now):
            record["failures"] = []
            _write(path, record)
            return True
        salt = str(record.get("recovery_salt") or "")
        wanted = _hash_recovery(code, salt) if _normalise_code(code) else ""
        hashes = list(record.get("recovery_hashes") or [])
        match = next((h for h in hashes if wanted and hmac.compare_digest(h, wanted)), None)
        if match is not None:
            hashes.remove(match)
            record["recovery_hashes"] = hashes
            record["failures"] = []
            _write(path, record)
            return True
        _fail(record, now)
        _write(path, record)
        return False


def disable(user_id: str, home: Optional[Path] = None) -> None:
    """Turn two-factor login off (caller has checked password + code)."""
    with _locked():
        for path in (_path(user_id, home), _legacy_path(user_id, home)):
            if path is None:
                continue
            try:
                path.unlink()
            except FileNotFoundError:
                pass


def regenerate_recovery_codes(user_id: str, home: Optional[Path] = None) -> list[str]:
    """Replace every recovery code (caller has checked password + code)."""
    with _locked():
        path = _path(user_id, home)
        record = _load(user_id, home)
        if not _is_enabled(record):
            raise TwoFactorError("Two-factor login is off.")
        codes = _new_recovery_codes()
        _store_recovery(record, codes)
        _write(path, record)
    return codes


async def principal_id_for_session(session: Any) -> str:
    """The account a login acts as, for the two-factor and preferences lookup.

    Account-level (FG-28 B5): one id per GoTrue subject, the same whichever
    profile the request is scoped to. A ``principal_aliases`` row in the
    **default** profile wins (the bootstrap owner's records are keyed by it),
    else the subject itself — so someone enrolled only in ``hr`` is still
    looked up, and their second step is never skipped. A basic-auth login
    nobody enrolled is the operator login, which first run gives the owner's
    password, so it counts as the owner. Returns ``""`` only without a subject.
    """
    from contextlib import nullcontext

    from hermes_cli import web_server as ws
    from hermes_cli.access import PrincipalStore
    from hermes_cli.console_scope import _scoped_to

    subject = (getattr(session, "user_id", "") or "").strip()
    if not subject:
        return ""
    root = hermes_constants.get_default_hermes_root()
    in_default = hermes_constants.resolve_path_cached(
        hermes_constants.get_hermes_home()
    ) == hermes_constants.resolve_path_cached(root)
    with nullcontext() if in_default else _scoped_to(root):
        principals = PrincipalStore(ws._comms_app_store())
        user_id = await principals.resolve_alias(subject) or subject
        if getattr(session, "provider", "") == "basic" and await principals.get(user_id) is None:
            owner = await principals.get_owner()
            if owner is not None:
                return owner.user_id
    return user_id
