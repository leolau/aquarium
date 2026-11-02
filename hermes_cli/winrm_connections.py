"""Per-person Windows servers (Settings -> In&Out -> Windows servers).

Each person stores their own server as a ``winrm`` entry in the unified
credential store (provider ``winrm``, name = the server name, visibility
``private:<user>``). The password never leaves the server: views carry
``password_set`` only, and every error is scrubbed of it.

The driver is pypsrp (PowerShell Remoting over WinRM, the ``winrm`` extra).
Port 5985 is WinRM over HTTP (messages still encrypted by NTLM/Kerberos/
CredSSP); any other port is HTTPS. A server may name one of the person's
VPNs (``vpn``); it is then reached through that tunnel via a ``/32`` host
route, exactly like SQL Server connections (``vpn.ensure_host_route``).
"""

from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from hermes_cli.credential_store import (
    Credential,
    CredentialError,
    default_credential_store,
    merge_kept_secrets,
)

PROVIDER = "winrm"
KIND = "winrm"
SERVICE = "winrm"
HTTP_PORT = 5985
HTTPS_PORT = 5986
DEFAULT_PORT = HTTPS_PORT
TRANSPORTS = ("ntlm", "kerberos", "credssp")
CONNECT_TIMEOUT = 15
#: Must exceed pypsrp's WSMan operation timeout (20 s).
READ_TIMEOUT = 30
TEST_SCRIPT = "$PSVersionTable.PSVersion.ToString(); hostname"

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$")
_TEXT_FIELDS = ("host", "username", "vpn", "label")
_BOOL_FIELDS = ("verify_tls", "legacy_tls")
#: Fields that change where/how we connect: editing one clears the last test.
_CONNECTION_FIELDS = (
    "host", "port", "transport", "username", "password", "verify_tls", "legacy_tls", "vpn",
)
_state_lock = threading.Lock()


class WinrmError(Exception):
    """A request the caller can fix; ``status`` is the HTTP status."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_name(name: Any) -> str:
    value = str(name or "").strip()
    if not _NAME_RE.fullmatch(value):
        raise WinrmError(
            "name must be 1-64 letters, digits, spaces, dots, dashes or underscores"
        )
    return value


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


# -- runtime state ----------------------------------------------------------


def _state_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "winrm" / "connection_tests.json"


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
        fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".winrm-", suffix=".tmp")
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
    """The helper's route holder name for this server (stable, opaque)."""
    digest = hashlib.sha256(_key(cred.owner_user_id, cred.name).encode()).hexdigest()
    return f"winrm-{digest[:16]}"


# -- driver -------------------------------------------------------------------


def driver_available() -> bool:
    """True when pypsrp imports (the ``winrm`` extra)."""
    try:
        import pypsrp.client  # noqa: F401
    except Exception:
        return False
    return True


def _client_class():
    try:
        from pypsrp.client import Client
    except ImportError:
        try:
            from tools.lazy_deps import ensure

            ensure("winrm.driver", prompt=False)
            from pypsrp.client import Client
        except Exception as exc:
            raise WinrmError(
                "Windows PowerShell support is not installed on this server (the 'winrm' extra)",
                503,
            ) from exc
    return Client


def port_of(payload: Mapping[str, Any]) -> int:
    return int(payload.get("port") or DEFAULT_PORT)


def uses_https(payload: Mapping[str, Any]) -> bool:
    return port_of(payload) != HTTP_PORT


def _ssl_context(*, verify: bool, legacy_tls: bool):
    import ssl

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # urllib3 matches the host name itself (against ``assert_hostname``).
    ctx.check_hostname = False
    if legacy_tls:
        ctx.minimum_version = ssl.TLSVersion.TLSv1
        ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
    else:
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    if verify:
        ctx.verify_mode = ssl.CERT_REQUIRED
        try:
            import certifi

            ctx.load_verify_locations(cafile=certifi.where())
        except ImportError:  # pragma: no cover - certifi is a core dependency
            ctx.load_default_certs()
    else:
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def tls_adapter(host: str, *, verify: bool, legacy_tls: bool):
    """A requests adapter with our TLS context that checks ``host``'s
    certificate even when we dial its VPN address."""
    from requests.adapters import HTTPAdapter

    ctx = _ssl_context(verify=verify, legacy_tls=legacy_tls)

    class _WinrmTlsAdapter(HTTPAdapter):
        def build_connection_pool_key_attributes(self, request, verify_arg, cert=None):
            host_params, pool_kwargs = super().build_connection_pool_key_attributes(
                request, verify_arg, cert
            )
            if host_params.get("scheme") == "https":
                pool_kwargs["ssl_context"] = ctx
                pool_kwargs["server_hostname"] = host
                pool_kwargs["assert_hostname"] = host if verify else False
                pool_kwargs["cert_reqs"] = "CERT_REQUIRED" if verify else "CERT_NONE"
            return host_params, pool_kwargs

    return _WinrmTlsAdapter()


def connect(payload: Mapping[str, Any], *, ip: Optional[str] = None):
    """A pypsrp ``Client`` for ``payload`` (nothing is sent until a call).

    ``ip`` is the server's address through the VPN: we dial it, but the
    certificate and the Kerberos service name still use ``host``.
    """
    Client = _client_class()
    host = str(payload["host"])
    transport = payload.get("transport") or "ntlm"
    if transport not in TRANSPORTS:
        raise WinrmError(f"transport must be one of {', '.join(TRANSPORTS)}")
    https = uses_https(payload)
    verify = bool(payload.get("verify_tls", True))
    kwargs: Dict[str, Any] = {
        "port": port_of(payload),
        "username": payload["username"],
        "password": payload["password"],
        "ssl": https,
        "auth": transport,
        "cert_validation": verify,
        "connection_timeout": CONNECT_TIMEOUT,
        "read_timeout": READ_TIMEOUT,
        "no_proxy": True,
    }
    if ip:
        kwargs["negotiate_hostname_override"] = host
    client = Client(ip or host, **kwargs)
    if https:
        transport_http = client.wsman.transport
        build = transport_http._build_session

        def _build_session():
            session = build()
            session.mount(
                "https://", tls_adapter(host, verify=verify, legacy_tls=bool(payload.get("legacy_tls")))
            )
            return session

        transport_http._build_session = _build_session
    return client


def _stream_text(records: Any, limit: int = 20) -> List[str]:
    out: List[str] = []
    for record in list(records or [])[:limit]:
        text = str(record).strip()
        if text:
            out.append(text[:2000])
    return out


def execute(payload: Mapping[str, Any], script: str, *, ip: Optional[str] = None) -> Dict[str, Any]:
    """Run ``script`` in Windows PowerShell on the server.

    Returns ``{output, errors, had_errors}``; ``output`` is uncapped (the
    tool caps it like ``terminal``).
    """
    client = connect(payload, ip=ip)
    try:
        output, streams, had_errors = client.execute_ps(script)
    finally:
        with contextlib.suppress(Exception):
            client.close()
    return {
        "output": scrub(str(output or ""), payload),
        "errors": [scrub(e, payload) for e in _stream_text(getattr(streams, "error", None))],
        "had_errors": bool(had_errors),
    }


def check_login(payload: Mapping[str, Any], *, ip: Optional[str] = None) -> Dict[str, Any]:
    """Sign in and read ``$PSVersionTable`` / ``hostname``; ok + plain reason."""
    result: Dict[str, Any] = {"at": _now()}
    try:
        doc = execute(payload, TEST_SCRIPT, ip=ip)
        lines = [ln.strip() for ln in doc["output"].splitlines() if ln.strip()]
        if doc["had_errors"] and not lines:
            raise WinrmError("; ".join(doc["errors"]) or "PowerShell reported an error")
        result.update(
            ok=True,
            ps_version=(lines[0] if lines else "")[:40],
            computer_name=(lines[1] if len(lines) > 1 else "")[:120],
        )
    except Exception as exc:
        result.update(ok=False, error=plain_error(exc, payload))
    return result


def plain_error(exc: BaseException, payload: Mapping[str, Any]) -> str:
    """A user-facing reason that never echoes the password back."""
    server = str(payload.get("host") or "the server")
    where = f"{server}:{port_of(payload)}"
    name = type(exc).__name__
    text = str(exc) or name
    lowered = text.lower()
    if isinstance(exc, WinrmError):
        message = str(exc)
    elif name == "AuthenticationError" or "401" in text and "authenticat" in lowered:
        message = (
            "Sign-in failed: check the user name (DOMAIN\\user or user@domain), the "
            "password and the sign-in method."
        )
    elif name == "SSLError" or "certificate" in lowered or "ssl" in lowered:
        message = (
            f"Could not open a secure connection to {where}: {text[:200]}. "
            "For Windows Server 2008/2012 tick the older-server option; for a "
            "self-signed certificate untick 'Check the server certificate'."
        )
    elif name in ("ConnectTimeout", "ReadTimeout", "Timeout", "TimeoutError") or isinstance(
        exc, TimeoutError
    ):
        message = f"Server {where} did not answer in time."
    elif name == "ConnectionError" or isinstance(exc, (ConnectionError, OSError)):
        message = (
            f"Could not connect to {where}: is WinRM enabled (winrm quickconfig) "
            "and the firewall open?"
        )
    elif "kerberos" in lowered or "gssapi" in lowered:
        message = (
            "Kerberos sign-in is not available here (it needs the Kerberos system "
            "libraries and a domain setup); use NTLM instead."
        )
    else:
        message = text[:500]
    return scrub(message, payload)


def scrub(text: str, payload: Mapping[str, Any]) -> str:
    password = str(payload.get("password") or "")
    if password and password in text:
        text = text.replace(password, "***")
    return text


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
        raise WinrmError(f"the VPN '{vpn_name}' is not set up (Settings -> In&Out)") from None
    doc = await vpn.ensure_host_route(
        vpn_cred, route_user(cred), str(cred.payload["host"]), port_of(cred.payload), agent=agent,
    )
    if not doc.get("routed") or not doc.get("ip"):
        raise WinrmError(str(doc.get("error") or "the VPN route could not be set up"))
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
        "port": port_of(payload),
        "transport": payload.get("transport") or "ntlm",
        "username": payload.get("username", ""),
        "verify_tls": bool(payload.get("verify_tls", True)),
        "legacy_tls": bool(payload.get("legacy_tls")),
        "vpn": payload.get("vpn") or "",
        "password_set": bool(payload.get("password")),
        "state": _state_of(test),
        "last_test": test,
    }


async def own_entries(principal: Any) -> List[Credential]:
    """The caller's OWN servers — never another person's, owner included."""
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
    raise WinrmError("no Windows server with that name", 404)


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
    if port in (None, ""):
        payload["port"] = DEFAULT_PORT
    else:
        try:
            payload["port"] = int(str(port).strip())
        except (TypeError, ValueError):
            raise WinrmError("port must be a number") from None
    transport = body.get("transport") or "ntlm"
    if transport not in TRANSPORTS:
        raise WinrmError(f"transport must be one of {', '.join(TRANSPORTS)}")
    payload["transport"] = transport
    for field in _BOOL_FIELDS:
        value = body.get(field)
        if value is not None:
            if not isinstance(value, bool):
                raise WinrmError(f"{field} must be true or false")
            payload[field] = value
    password = body.get("password")
    if isinstance(password, str) and password:
        payload["password"] = password
    return payload


async def save(principal: Any, name: Any, body: Mapping[str, Any]) -> Dict[str, Any]:
    """Create or replace the caller's server; omitted password is kept."""
    name = normalize_name(name)
    if not isinstance(body, Mapping):
        raise WinrmError("body must be an object")
    payload = _payload_from(body)
    existing = None
    with contextlib.suppress(WinrmError):
        existing = await own_entry(principal, name)
    payload = merge_kept_secrets(KIND, payload, existing.payload if existing else None)
    if not payload.get("password"):
        raise WinrmError("password is required")
    if payload.get("vpn"):
        from hermes_cli import vpn

        try:
            await vpn.find_vpn(principal, payload["vpn"])
        except vpn.VpnNotFound:
            raise WinrmError(f"no VPN named '{payload['vpn']}'") from None
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
        raise WinrmError(scrub(str(exc), payload)) from exc
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
    """Sign into the caller's stored server and record the outcome."""
    import asyncio

    name = normalize_name(name)
    cred = await own_entry(principal, name)
    try:
        ip = await route_for(principal, cred)
    except WinrmError as exc:
        result: Dict[str, Any] = {"at": _now(), "ok": False, "error": str(exc)}
    else:
        result = await asyncio.to_thread(check_login, cred.payload, ip=ip)
    _update_state(_key(cred.owner_user_id, name), result)
    return view_of(cred)


def connection_summary(cred: Credential) -> Tuple[str, Dict[str, Any]]:
    """What the agent may see about a server (no secrets)."""
    view = view_of(cred)
    return cred.name, {
        k: view[k] for k in ("name", "label", "host", "port", "transport", "username", "vpn", "state")
    }
