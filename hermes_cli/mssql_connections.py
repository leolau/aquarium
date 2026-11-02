"""Per-person SQL Server connections (Settings -> In&Out -> SQL Server databases).

Each person stores their own connection as an ``mssql`` entry in the unified
credential store (provider ``mssql``, name = the connection name, visibility
``private:<user>``). The password never leaves the server: views carry
``password_set`` only, and every error is scrubbed of it.

A connection may name one of the person's VPNs (``vpn``); the server is then
reached through that tunnel via a ``/32`` host route (``vpn.ensure_host_route``,
helper ``route``/``unroute``). The driver is python-tds (pure Python, TDS
7.x — SQL Server 2008 R2 and newer) with pyOpenSSL for TLS; both come with
the ``mssql`` extra.

Read-only is the default and the real guarantee is a read-only SQL login.
:func:`check_read_only` is defence in depth: one ``SELECT``/``WITH``
statement, no write/DDL/exec keywords, run inside a transaction that is
always rolled back.
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import decimal
import hashlib
import json
import os
import re
import socket
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

from hermes_cli.credential_store import (
    Credential,
    CredentialError,
    default_credential_store,
    merge_kept_secrets,
)

PROVIDER = "mssql"
KIND = "mssql"
SERVICE = "mssql"
DEFAULT_PORT = 1433
LOGIN_TIMEOUT = 15
QUERY_TIMEOUT = 30
MAX_ROWS = 500
MAX_CELL_CHARS = 2000
MAX_RESULT_BYTES = 200_000
ENCRYPT_MODES = ("strict", "on", "off")

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
_TEXT_FIELDS = ("host", "instance", "database", "username", "vpn", "label")
_BOOL_FIELDS = ("trust_server_certificate", "legacy_tls", "allow_writes")
#: Fields that change where/how we connect: editing one clears the last test.
_CONNECTION_FIELDS = (
    "host", "port", "instance", "database", "username", "password", "encrypt",
    "trust_server_certificate", "legacy_tls", "vpn",
)
_state_lock = threading.Lock()
_tls_local = threading.local()
_tls_hook_lock = threading.Lock()
_tls_hooked = False


class MssqlError(Exception):
    """A request the caller can fix; ``status`` is the HTTP status."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_name(name: Any) -> str:
    value = str(name or "").strip()
    if not _NAME_RE.fullmatch(value):
        raise MssqlError(
            "name must be 1-64 letters, digits, spaces, dots, dashes or underscores"
        )
    return value


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


# -- runtime state ----------------------------------------------------------


def _state_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "mssql" / "connection_tests.json"


def _key(owner_user_id: str, name: str) -> str:
    return f"{owner_user_id}/{name}"


def _read_state() -> Dict[str, Any]:
    try:
        doc = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def _update_state(key: str, value: Optional[Mapping[str, Any]]) -> None:
    with _state_lock:
        doc = _read_state()
        if value is None:
            doc.pop(key, None)
        else:
            doc[key] = dict(value)
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".mssql-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(doc, fh, indent=2, sort_keys=True)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise


def _last_test(owner_user_id: str, name: str) -> Optional[Dict[str, Any]]:
    found = _read_state().get(_key(owner_user_id, name))
    return dict(found) if isinstance(found, dict) else None


def route_user(cred: Credential) -> str:
    """The helper's route holder name for this connection (stable, opaque)."""
    digest = hashlib.sha256(_key(cred.owner_user_id, cred.name).encode()).hexdigest()
    return f"mssql-{digest[:16]}"


# -- driver -------------------------------------------------------------------


def driver_available() -> bool:
    """True when python-tds and pyOpenSSL import (the ``mssql`` extra)."""
    try:
        import OpenSSL.SSL  # noqa: F401
        import pytds  # noqa: F401
    except Exception:
        return False
    return True


def _driver():
    try:
        import pytds
        import pytds.tls
    except ImportError:
        try:
            from tools.lazy_deps import ensure

            ensure("mssql.driver", prompt=False)
            import pytds
            import pytds.tls
        except Exception as exc:
            raise MssqlError(
                "SQL Server support is not installed on this server (the 'mssql' extra)",
                503,
            ) from exc
    _install_tls_hook(pytds.tls)
    return pytds


def _install_tls_hook(tls_module: Any) -> None:
    """Let :func:`connect` hand python-tds its own pyOpenSSL context.

    python-tds builds a fixed TLS 1.2, verify-against-``cafile`` context; we
    need TLS 1.0+ for old servers (``legacy_tls``) and an opt-out of
    certificate checks (``trust_server_certificate``). The hook reads the
    context from a thread-local, so concurrent connections never mix.
    """
    global _tls_hooked
    with _tls_hook_lock:
        if _tls_hooked:
            return
        original = tls_module.create_context

        def create_context(cafile: str):
            ctx = getattr(_tls_local, "ctx", None)
            return ctx if ctx is not None else original(cafile)

        tls_module.create_context = create_context
        _tls_hooked = True


@contextlib.contextmanager
def _tls_override(ctx: Any) -> Iterator[None]:
    _tls_local.ctx = ctx
    try:
        yield
    finally:
        _tls_local.ctx = None


def _ca_bundle() -> str:
    try:
        import certifi

        return certifi.where()
    except ImportError:  # pragma: no cover - certifi is a core dependency
        import ssl

        return ssl.get_default_verify_paths().cafile or "/etc/ssl/certs/ca-certificates.crt"


def tls_settings(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """How a payload's encryption options map onto the connection."""
    encrypt = payload.get("encrypt") or "on"
    trust = bool(payload.get("trust_server_certificate")) and encrypt != "strict"
    if encrypt == "off":
        # SQL Server always encrypts the login; ``off`` leaves the rest clear
        # and, like ODBC's Encrypt=no, does not check the certificate.
        trust = True
    return {
        "encrypt": encrypt,
        "verify": not trust,
        "login_only": encrypt == "off",
        "legacy_tls": bool(payload.get("legacy_tls")),
    }


def _tls_context(settings: Mapping[str, Any]):
    from OpenSSL import SSL

    ctx = SSL.Context(SSL.TLS_CLIENT_METHOD)
    if settings["legacy_tls"]:
        ctx.set_min_proto_version(SSL.TLS1_VERSION)
        ctx.set_cipher_list(b"DEFAULT:@SECLEVEL=0")
    else:
        ctx.set_min_proto_version(SSL.TLS1_2_VERSION)
    if settings["verify"]:
        ctx.set_verify(SSL.VERIFY_PEER, lambda _c, _x, _e, _d, ok: bool(ok))
        ctx.load_verify_locations(cafile=_ca_bundle())
    else:
        ctx.set_verify(SSL.VERIFY_NONE, lambda *_a: True)
    return ctx


def connect(payload: Mapping[str, Any], *, ip: Optional[str] = None,
            timeout: float = QUERY_TIMEOUT):
    """An open python-tds connection (autocommit off; caller closes).

    ``ip`` is the server's address through the VPN: we dial it ourselves so
    the certificate is still checked against ``host``.
    """
    pytds = _driver()
    host = str(payload["host"])
    instance = payload.get("instance") or None
    port = payload.get("port") or (None if instance else DEFAULT_PORT)
    settings = tls_settings(payload)
    kwargs: Dict[str, Any] = {
        "database": payload["database"],
        "user": payload["username"],
        "password": payload["password"],
        "port": port,
        "login_timeout": LOGIN_TIMEOUT,
        "timeout": timeout,
        "autocommit": False,
        "appname": "Hermes",
        "disable_connect_retry": True,
        "cafile": _ca_bundle(),
        "validate_host": settings["verify"],
        "enc_login_only": settings["login_only"],
    }
    sock = None
    if ip and not instance:
        sock = socket.create_connection((ip, int(port)), LOGIN_TIMEOUT)
        kwargs["sock"] = sock
        kwargs["dsn"] = host
    else:
        target = ip or host
        kwargs["dsn"] = f"{target}\\{instance}" if instance else target
    try:
        with _tls_override(_tls_context(settings)):
            return pytds.connect(**kwargs)
    except BaseException:
        if sock is not None:
            sock.close()
        raise


def plain_error(exc: BaseException, payload: Mapping[str, Any]) -> str:
    """A user-facing reason that never echoes the password back."""
    server = str(payload.get("host") or "the server")
    name = type(exc).__name__
    text = str(exc) or name
    if name == "LoginError" or "Login failed" in text:
        message = "Sign-in failed: check the SQL login and password."
    elif isinstance(exc, socket.gaierror):
        message = f"Server {server} was not found."
    elif isinstance(exc, (socket.timeout, TimeoutError)) or name == "TimeoutError":
        message = f"Server {server} did not answer in time."
    elif "SSL" in name or "certificate" in text.lower() or "ssl" in text.lower():
        message = (
            f"Could not open a secure connection to {server}: {text[:200]}. "
            "For Windows Server 2008/2012 tick the older-server option; for a "
            "self-signed certificate tick 'Trust the server certificate'."
        )
    elif isinstance(exc, ConnectionError) or (isinstance(exc, OSError) and name in (
        "OSError", "ConnectionRefusedError", "ConnectionResetError"
    )):
        message = f"Could not connect to {server}."
    elif isinstance(exc, MssqlError):
        message = str(exc)
    else:
        message = text[:500]
    return scrub(message, payload)


def scrub(text: str, payload: Mapping[str, Any]) -> str:
    password = str(payload.get("password") or "")
    if password and password in text:
        text = text.replace(password, "***")
    return text


# -- read-only guard -------------------------------------------------------------

_FORBIDDEN = (
    "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "CREATE", "TRUNCATE",
    "EXEC", "EXECUTE", "GRANT", "REVOKE", "DENY", "BACKUP", "RESTORE", "SHUTDOWN",
    "INTO", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "DBCC", "KILL", "WAITFOR",
    "BULK", "RECONFIGURE", "USE",
)
#: Never allowed, even for a connection with writes switched on.
_ALWAYS_FORBIDDEN = ("SHUTDOWN", "BACKUP", "RESTORE", "RECONFIGURE", "KILL", "DBCC")
_FORBIDDEN_RE = re.compile(r"\b(" + "|".join(_FORBIDDEN) + r")\b", re.IGNORECASE)
_ALWAYS_RE = re.compile(r"\b(" + "|".join(_ALWAYS_FORBIDDEN) + r")\b|\bxp_", re.IGNORECASE)
_XP_RE = re.compile(r"\b(xp_|sp_executesql\b|sp_oa)", re.IGNORECASE)
_TOKEN_RE = re.compile(
    r"--[^\n]*|/\*.*?\*/|'(?:[^']|'')*'|N'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|\"(?:[^\"]|\"\")*\"",
    re.DOTALL,
)


def _code_only(sql: str) -> str:
    """``sql`` with comments, strings and quoted names blanked out."""
    if "/*" in sql and "*/" not in sql:
        raise MssqlError("unterminated /* comment")

    def blank(match: re.Match) -> str:
        token = match.group(0)
        if token.startswith(("--", "/*")):
            return " "
        return " ? "

    stripped = _TOKEN_RE.sub(blank, sql)
    if "'" in stripped:
        raise MssqlError("unterminated string literal")
    return stripped


def _single_statement(code: str) -> str:
    parts = [p.strip() for p in code.split(";")]
    if any(parts[1:]):
        raise MssqlError("only one statement at a time")
    body = parts[0]
    if not body:
        raise MssqlError("sql is empty")
    return body


def check_read_only(sql: str) -> None:
    """Raise :class:`MssqlError` unless ``sql`` is one plain read query."""
    body = _single_statement(_code_only(str(sql or "")))
    first = body.split(None, 1)[0].upper()
    if first not in ("SELECT", "WITH"):
        raise MssqlError("only SELECT / WITH queries are allowed (read-only)")
    found = _FORBIDDEN_RE.search(body) or _XP_RE.search(body)
    if found:
        raise MssqlError(
            f"'{found.group(0).upper()}' is not allowed in a read-only query"
        )


def check_write(sql: str) -> None:
    """A write statement for a connection with ``allow_writes``: one
    statement, no server-level commands."""
    body = _single_statement(_code_only(str(sql or "")))
    found = _ALWAYS_RE.search(body)
    if found:
        raise MssqlError(f"'{found.group(0).upper()}' is never allowed")


def is_read_only(sql: str) -> bool:
    try:
        check_read_only(sql)
    except MssqlError:
        return False
    return True


# -- results ------------------------------------------------------------------------


def _cell(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, decimal.Decimal):
        text = str(value)
    elif isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        text = value.isoformat()
    elif isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        text = "0x" + raw[: MAX_CELL_CHARS // 2].hex()
    elif isinstance(value, uuid.UUID):
        text = str(value)
    else:
        text = str(value)
    if len(text) > MAX_CELL_CHARS:
        text = text[:MAX_CELL_CHARS] + "…"
    return text


def shape_rows(columns: List[str], rows: List[Any], *, max_rows: int = MAX_ROWS,
               max_bytes: int = MAX_RESULT_BYTES) -> Dict[str, Any]:
    """Cap rows/cells/size; ``truncated`` when anything was cut."""
    out: List[List[Any]] = []
    size = len(json.dumps(columns, ensure_ascii=False))
    truncated = len(rows) > max_rows
    for row in rows[:max_rows]:
        cells = [_cell(v) for v in row]
        size += len(json.dumps(cells, ensure_ascii=False, default=str)) + 1
        if size > max_bytes:
            truncated = True
            break
        out.append(cells)
    return {"columns": columns, "rows": out, "row_count": len(out), "truncated": truncated}


def _run(conn: Any, sql: str, params: Optional[Mapping[str, Any]], *,
         write: bool, max_rows: int) -> Dict[str, Any]:
    cur = conn.cursor()
    try:
        if not write:
            cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
        cur.execute(sql, dict(params) if params else None)
        columns = [str(d[0]) for d in (cur.description or [])]
        rows = list(cur.fetchmany(max_rows + 1)) if columns else []
        result = shape_rows(columns, rows, max_rows=max_rows)
        if write:
            result["rows_affected"] = cur.rowcount
            conn.commit()
        else:
            conn.rollback()
        return result
    except BaseException:
        with contextlib.suppress(Exception):
            conn.rollback()
        raise
    finally:
        with contextlib.suppress(Exception):
            cur.close()


def execute(payload: Mapping[str, Any], sql: str, *, params: Optional[Mapping[str, Any]] = None,
            write: bool = False, ip: Optional[str] = None,
            max_rows: int = MAX_ROWS) -> Dict[str, Any]:
    """Run one statement. Read-only unless ``write`` (caller got approval)."""
    if write:
        if not payload.get("allow_writes"):
            raise MssqlError("this connection is read-only")
        check_write(sql)
    else:
        check_read_only(sql)
    conn = connect(payload, ip=ip)
    try:
        return _run(conn, sql, params, write=write, max_rows=max(1, min(max_rows, MAX_ROWS)))
    finally:
        with contextlib.suppress(Exception):
            conn.close()


def check_login(payload: Mapping[str, Any], *, ip: Optional[str] = None) -> Dict[str, Any]:
    """Sign in and run ``SELECT @@VERSION, DB_NAME()``; ok + plain reason."""
    result: Dict[str, Any] = {"at": _now()}
    try:
        conn = connect(payload, ip=ip, timeout=LOGIN_TIMEOUT)
        try:
            cur = conn.cursor()
            cur.execute("SELECT @@VERSION, DB_NAME()")
            row = cur.fetchone() or ("", "")
            conn.rollback()
        finally:
            with contextlib.suppress(Exception):
                conn.close()
        version = str(row[0] or "").splitlines()[0].strip()[:200]
        result.update(ok=True, server_version=version, database=str(row[1] or ""))
    except Exception as exc:
        result.update(ok=False, error=plain_error(exc, payload))
    return result


# -- VPN ------------------------------------------------------------------------------


async def route_for(principal: Any, cred: Credential, *, agent: bool = False) -> Optional[str]:
    """The VPN address to dial for ``cred`` (None: dial ``host`` directly)."""
    vpn_name = cred.payload.get("vpn")
    if not vpn_name:
        return None
    from hermes_cli import vpn

    try:
        vpn_cred = await vpn.find_vpn(principal, vpn_name)
    except vpn.VpnNotFound:
        raise MssqlError(f"the VPN '{vpn_name}' is not set up (Settings -> In&Out)") from None
    doc = await vpn.ensure_host_route(
        vpn_cred, route_user(cred), str(cred.payload["host"]),
        cred.payload.get("port") or (None if cred.payload.get("instance") else DEFAULT_PORT),
        agent=agent,
    )
    if not doc.get("routed") or not doc.get("ip"):
        raise MssqlError(str(doc.get("error") or "the VPN route could not be set up"))
    return str(doc["ip"])


async def release_route(principal: Any, cred: Credential) -> None:
    vpn_name = cred.payload.get("vpn")
    if not vpn_name:
        return
    from hermes_cli import vpn

    try:
        vpn_cred = await vpn.find_vpn(principal, vpn_name)
    except vpn.VpnError:
        return
    await vpn.release_host_route(vpn_cred, route_user(cred))


# -- views ------------------------------------------------------------------------------


def _state_of(test: Optional[Mapping[str, Any]]) -> str:
    if test is None:
        return "untested"
    return "working" if test.get("ok") else "needs_attention"


def view_of(cred: Credential) -> Dict[str, Any]:
    payload = cred.payload
    test = _last_test(cred.owner_user_id, cred.name)
    return {
        "name": cred.name,
        "label": payload.get("label") or "",
        "host": payload.get("host", ""),
        "port": payload.get("port") or (None if payload.get("instance") else DEFAULT_PORT),
        "instance": payload.get("instance") or "",
        "database": payload.get("database", ""),
        "username": payload.get("username", ""),
        "encrypt": payload.get("encrypt") or "on",
        "trust_server_certificate": bool(payload.get("trust_server_certificate")),
        "legacy_tls": bool(payload.get("legacy_tls")),
        "vpn": payload.get("vpn") or "",
        "allow_writes": bool(payload.get("allow_writes")),
        "password_set": bool(payload.get("password")),
        "state": _state_of(test),
        "last_test": test,
    }


async def own_entries(principal: Any) -> List[Credential]:
    """The caller's OWN connections — never another person's, owner included."""
    user_id = getattr(principal, "user_id", None)
    entries = await default_credential_store().list(principal)
    return [
        e for e in entries
        if e.provider == PROVIDER and e.kind == KIND and e.owner_user_id == user_id
    ]


async def own_entry(principal: Any, name: str) -> Credential:
    for entry in await own_entries(principal):
        if entry.name == name:
            return entry
    raise MssqlError("no SQL Server connection with that name", 404)


async def list_mine(principal: Any) -> List[Dict[str, Any]]:
    return [view_of(e) for e in await own_entries(principal)]


def _payload_from(body: Mapping[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    for field in _TEXT_FIELDS:
        value = body.get(field)
        if value is None or str(value).strip() == "":
            continue
        payload[field] = str(value).strip()
    port = body.get("port")
    if port not in (None, ""):
        try:
            payload["port"] = int(str(port).strip())
        except (TypeError, ValueError):
            raise MssqlError("port must be a number") from None
    elif not payload.get("instance"):
        payload["port"] = DEFAULT_PORT
    encrypt = body.get("encrypt") or "on"
    if encrypt not in ENCRYPT_MODES:
        raise MssqlError(f"encrypt must be one of {', '.join(ENCRYPT_MODES)}")
    payload["encrypt"] = encrypt
    for field in _BOOL_FIELDS:
        value = body.get(field)
        if value is not None:
            if not isinstance(value, bool):
                raise MssqlError(f"{field} must be true or false")
            payload[field] = value
    password = body.get("password")
    if isinstance(password, str) and password:
        payload["password"] = password
    return payload


async def save(principal: Any, name: Any, body: Mapping[str, Any]) -> Dict[str, Any]:
    """Create or replace the caller's connection; omitted password is kept."""
    name = normalize_name(name)
    if not isinstance(body, Mapping):
        raise MssqlError("body must be an object")
    payload = _payload_from(body)
    if payload.get("allow_writes") and not getattr(principal, "is_owner", False):
        raise MssqlError("only the owner can allow changes", 403)
    existing = None
    with contextlib.suppress(MssqlError):
        existing = await own_entry(principal, name)
    payload = merge_kept_secrets(KIND, payload, existing.payload if existing else None)
    if not payload.get("password"):
        raise MssqlError("password is required")
    if payload.get("vpn"):
        from hermes_cli import vpn

        try:
            await vpn.find_vpn(principal, payload["vpn"])
        except vpn.VpnNotFound:
            raise MssqlError(f"no VPN named '{payload['vpn']}'") from None
    store = default_credential_store()
    try:
        cred = await store.put(
            principal,
            provider=PROVIDER,
            name=name,
            kind=KIND,
            payload=payload,
            services=[SERVICE],
            visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise MssqlError(scrub(str(exc), payload)) from exc
    if existing is not None and _connection_changed(existing.payload, payload):
        _update_state(_key(cred.owner_user_id, name), None)
        if existing.payload.get("vpn") and (
            existing.payload.get("vpn") != payload.get("vpn")
            or existing.payload.get("host") != payload.get("host")
        ):
            await release_route(principal, existing)
    return view_of(cred)


def _connection_changed(old: Mapping[str, Any], new: Mapping[str, Any]) -> bool:
    return any(old.get(f) != new.get(f) for f in _CONNECTION_FIELDS)


async def delete(principal: Any, name: Any) -> bool:
    name = normalize_name(name)
    cred = await own_entry(principal, name)
    await release_route(principal, cred)
    deleted = await default_credential_store().delete(principal, PROVIDER, name)
    _update_state(_key(principal.user_id, name), None)
    return bool(deleted)


async def run_test(principal: Any, name: Any) -> Dict[str, Any]:
    """Sign into the caller's stored connection and record the outcome."""
    import asyncio

    name = normalize_name(name)
    cred = await own_entry(principal, name)
    try:
        ip = await route_for(principal, cred)
    except MssqlError as exc:
        result: Dict[str, Any] = {"at": _now(), "ok": False, "error": str(exc)}
    else:
        result = await asyncio.to_thread(check_login, cred.payload, ip=ip)
    _update_state(_key(cred.owner_user_id, name), result)
    return view_of(cred)


def connection_summary(cred: Credential) -> Tuple[str, Dict[str, Any]]:
    """What the agent may see about a connection (no secrets)."""
    view = view_of(cred)
    return cred.name, {
        k: view[k] for k in (
            "name", "label", "host", "port", "instance", "database", "vpn",
            "allow_writes", "state",
        )
    }
