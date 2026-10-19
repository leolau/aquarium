"""Get ready → Security basics: read-only server security checks (owner/admin).

Each check reports a status and plain facts; agent-home turns those into
sentences (English / 繁體中文) and a "Show me how" fix. Nothing here changes a
server setting.

Facts that need root (SSH server settings, automatic updates, firewall and
open ports, ``aquarium doctor``) come from the root-owned, argument-free
helper ``/usr/local/sbin/hermes-security-check`` (deploy/hermes-security-check)
run through ``sudo -n``. Without it those checks say "can't check yet" and
how to install it; the rest still run. The last result is kept in
``$HERMES_HOME/security_basics.json`` so the page shows it without re-running.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HELPER = "/usr/local/sbin/hermes-security-check"
HELPER_TIMEOUT = 200  # helper caps `aquarium doctor` at 150 s; agent-home waits up to 300 s
ALLOWED_PORTS = (22, 80, 443)
TLS_HOST, TLS_PORT = "127.0.0.1", 443
TLS_WARN_DAYS = 20
CADDYFILE = "/etc/caddy/Caddyfile"
AQUARIUM_CONF = "/etc/aquarium/aquarium.conf"
STATE_NAME = "security_basics.json"
DOMAIN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$")

OK, ATTENTION, UNKNOWN, UNAVAILABLE = "ok", "attention", "unknown", "unavailable"
CHECK_IDS = ("tls", "ssh", "updates", "ports", "doctor", "tools_user", "two_factor")

_lock = threading.Lock()


class Busy(RuntimeError):
    """A test is already running."""


def _check(cid: str, status: str, **facts: Any) -> Dict[str, Any]:
    return {"id": cid, "status": status, "facts": facts}


# ------------------------------------------------------------------ root helper


def helper_installed() -> bool:
    """The helper exists as a root-owned file nobody else can change."""
    try:
        st = os.stat(HELPER)
    except OSError:
        return False
    return st.st_uid == 0 and not st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)


def run_helper() -> Tuple[Optional[Dict[str, Any]], str]:
    """(report, "") or (None, reason) with reason missing|refused|busy|timeout|bad_output."""
    if not helper_installed():
        return None, "missing"
    try:
        proc = subprocess.run(["sudo", "-n", HELPER], capture_output=True, text=True,
                              timeout=HELPER_TIMEOUT, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "refused"
    try:
        data = json.loads(proc.stdout.strip().splitlines()[-1]) if proc.stdout.strip() else None
    except ValueError:
        data = None
    if isinstance(data, dict) and data.get("error") == "busy":
        return None, "busy"
    if proc.returncode != 0 or not isinstance(data, dict):
        return None, "refused" if proc.returncode == 1 and not proc.stdout.strip() else "bad_output"
    return data, ""


def _no_helper(cid: str, reason: str) -> Dict[str, Any]:
    return _check(cid, UNKNOWN, reason=f"helper_{reason}")


# ------------------------------------------------------------------ checks


def _read(path: str) -> str:
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def site_domains(extra: Optional[List[str]] = None) -> List[str]:
    """Web addresses this server serves: aquarium.conf, then the Caddyfile sites."""
    found = [str(d).lower() for d in (extra or [])]
    for m in re.finditer(r"^\s*(?:HOME_DOMAIN|DASHBOARD_DOMAIN)\s*=\s*['\"]?([^'\"\s#]+)", _read(AQUARIUM_CONF), re.M):
        found.append(m.group(1).lower())
    depth = 0
    for line in _read(CADDYFILE).splitlines():
        text = line.split("#", 1)[0]
        if depth == 0 and "{" in text:
            for addr in re.split(r"[\s,]+", text.split("{", 1)[0]):
                found.append(re.sub(r"^https?://", "", addr).split("/", 1)[0].rsplit(":", 1)[0].lower())
        depth += text.count("{") - text.count("}")
    return list(dict.fromkeys(d for d in found if DOMAIN_RE.match(d)))[:20]


def _tls_context() -> ssl.SSLContext:
    return ssl.create_default_context()


def cert_info(domain: str) -> Dict[str, Any]:
    """Certificate this server presents for *domain* (asked on loopback, never elsewhere)."""
    try:
        with socket.create_connection((TLS_HOST, TLS_PORT), timeout=8) as sock:
            with _tls_context().wrap_socket(sock, server_hostname=domain) as tls:
                cert = tls.getpeercert() or {}
        expires = ssl.cert_time_to_seconds(cert["notAfter"])
    except ssl.SSLCertVerificationError:
        return {"domain": domain, "ok": False, "error": "invalid"}
    except (OSError, ssl.SSLError, KeyError, ValueError):
        return {"domain": domain, "ok": False, "error": "unreachable"}
    days = int((expires - time.time()) // 86400)
    return {"domain": domain, "ok": days >= TLS_WARN_DAYS, "days_left": days,
            "valid_until": datetime.fromtimestamp(expires, timezone.utc).date().isoformat()}


def check_tls(domains: List[str]) -> Dict[str, Any]:
    if not domains:
        return _check("tls", UNKNOWN, reason="no_domain")
    certs = [cert_info(d) for d in domains]
    return _check("tls", OK if all(c["ok"] for c in certs) else ATTENTION, certificates=certs)


def check_ssh(report: Optional[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    if report is None:
        return _no_helper("ssh", reason)
    ssh = report.get("ssh") or {}
    if not ssh.get("installed"):
        return _check("ssh", OK, installed=False)
    if not ssh.get("readable"):
        return _check("ssh", UNKNOWN, reason="sshd_unreadable")
    facts = {
        "installed": True,
        "password_login": bool(ssh.get("password_authentication") or ssh.get("kbd_interactive_authentication")),
        "empty_passwords": bool(ssh.get("permit_empty_passwords")),
        "root_password_login": ssh.get("permit_root_login") == "yes",
        "authorized_keys": int(ssh.get("authorized_keys") or 0),
    }
    weak = facts["password_login"] or facts["empty_passwords"] or facts["root_password_login"]
    return _check("ssh", ATTENTION if weak else OK, **facts)


def check_updates(report: Optional[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    if report is None:
        return _no_helper("updates", reason)
    up = report.get("updates") or {}
    facts = {"installed": bool(up.get("installed")), "enabled": bool(up.get("unattended_upgrade")),
             "timer_enabled": bool(up.get("timer_enabled"))}
    return _check("updates", OK if all(facts.values()) else ATTENTION, **facts)


def check_ports(report: Optional[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    if report is None:
        return _no_helper("ports", reason)
    ports = report.get("ports") or {}
    if not ports.get("readable"):
        return _check("ports", UNKNOWN, reason="ports_unreadable")
    extra = [{"port": int(p.get("port", 0)), "process": str(p.get("process", ""))[:40],
              "bypasses_firewall": bool(p.get("bypasses_firewall"))}
             for p in ports.get("open") or [] if int(p.get("port", 0)) not in ALLOWED_PORTS]
    firewall = bool((report.get("firewall") or {}).get("active"))
    return _check("ports", ATTENTION if extra else OK, extra=extra, firewall_on=firewall)


def check_doctor(report: Optional[Dict[str, Any]], reason: str) -> Dict[str, Any]:
    if report is None:
        return _no_helper("doctor", reason)
    doc = report.get("doctor") or {}
    if not doc.get("installed"):
        return _check("doctor", UNKNOWN, reason="doctor_missing")
    if not doc.get("trusted", True):
        return _check("doctor", UNKNOWN, reason="doctor_untrusted")
    if not doc.get("ran"):
        return _check("doctor", UNKNOWN, reason="doctor_timeout")
    if not doc.get("supports_json"):
        return _check("doctor", UNKNOWN, reason="doctor_old")
    rows = [r for r in doc.get("rows") or [] if isinstance(r, dict)]
    failed = [r for r in rows if r.get("status") == "fail"]
    warned = [r for r in rows if r.get("status") == "warn"]
    return _check("doctor", ATTENTION if failed else OK, total=len(rows), passed=len(rows) - len(failed) - len(warned),
                  failed=len(failed), warned=len(warned), problems=failed + warned)


def check_tools_user() -> Dict[str, Any]:
    from tools import terminal_user

    run_as = terminal_user.configured_user()
    helper = False
    with contextlib.suppress(OSError):
        st = os.stat(terminal_user.HELPER)
        helper = st.st_uid == 0 and not st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    return _check("tools_user", OK if run_as and helper else ATTENTION, run_as=run_as, helper_installed=helper)


def check_two_factor() -> Dict[str, Any]:
    """Owner two-factor login. Reports "not available" until that feature ships
    ``hermes_cli.two_factor.owner_two_factor_enabled()``."""
    try:
        from hermes_cli import two_factor  # type: ignore[attr-defined]

        enabled = two_factor.owner_two_factor_enabled()
    except (ImportError, AttributeError):
        return _check("two_factor", UNAVAILABLE, reason="not_built")
    except Exception:
        return _check("two_factor", UNKNOWN, reason="unreadable")
    return _check("two_factor", OK if enabled else ATTENTION, enabled=bool(enabled))


# ------------------------------------------------------------------ report


def _state_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / STATE_NAME


def _summary(checks: List[Dict[str, Any]], checked_at: Optional[str], helper: str) -> Dict[str, Any]:
    counted = [c for c in checks if c["status"] != UNAVAILABLE]
    passed = sum(c["status"] == OK for c in counted)
    if checked_at is None:
        status = "not_started"
    else:
        status = "done" if counted and passed == len(counted) else "attention"
    return {"checked_at": checked_at, "status": status, "passed": passed, "total": len(counted),
            "helper": helper, "checks": checks}


def collect() -> Dict[str, Any]:
    report, reason = run_helper()
    checks = [
        check_tls(site_domains((report or {}).get("domains"))),
        check_ssh(report, reason),
        check_updates(report, reason),
        check_ports(report, reason),
        check_doctor(report, reason),
        check_tools_user(),
        check_two_factor(),
    ]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return _summary(checks, now, "ok" if report is not None else reason)


def _save(result: Dict[str, Any]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".security_basics.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(result, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def last_result() -> Dict[str, Any]:
    """The last saved test, or a "not tested yet" result."""
    with contextlib.suppress(OSError, ValueError):
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        if isinstance(data, dict) and isinstance(data.get("checks"), list):
            data["running"] = _lock.locked()
            return data
    result = _summary([], None, "")
    result["running"] = _lock.locked()
    return result


def run_test() -> Dict[str, Any]:
    """Run every check now (one at a time per process) and save the result."""
    if not _lock.acquire(blocking=False):
        raise Busy("A security check is already running.")
    try:
        result = collect()
        with contextlib.suppress(OSError):
            _save(result)
        result["running"] = False
        return result
    finally:
        _lock.release()
