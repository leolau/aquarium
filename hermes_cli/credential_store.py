"""Unified per-user credential store.

Design doc: ``docs/design/unified-credential-store.md``. One generic,
per-principal store for provider credentials (Google OAuth2 first; Telegram
bot tokens, WhatsApp sessions, passwords supported by the kind registry).

Two backends behind one surface:

* :class:`SupabaseCredentialStore` — the source of truth on deployments with
  the app datastore. Rows live in the C3 prod schema under contract C2
  (``owner_user_id`` + ``visibility``, RLS via :func:`apply_scope_rls`).
* :class:`FileCredentialStore` — portable fallback for upstream installs
  without Supabase; ``$HERMES_HOME/credentials/<user>/<provider>/<name>.json``.

Selection: ``credentials.backend`` in config.yaml (``auto`` default = Supabase
when the app-store DSN resolves, else file).

Security contract:

* Secret fields never leave the store unredacted through the HTTP surface —
  every API-facing read goes through :func:`redact_payload`.
* Pollers and other in-process service code use
  :meth:`resolve_for_service`, the only read path that returns full payloads.
* Token refresh persistence is a conditional single-writer update
  (:meth:`update_tokens`); a concurrent refresher whose refresh token was
  superseded loses the write and re-reads.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import quote

logger = logging.getLogger(__name__)

CREDENTIALS_TABLE = "credentials"

#: Opt-in service flags a credential entry can volunteer for. Background
#: pollers consume an entry only when the matching flag is set (R5).
SERVICES: Tuple[str, ...] = ("email", "calendar", "drive", "workspace")

#: Inner spaces allowed (VPN names like "Office files"); no other whitespace,
#: no edge spaces, no path separators.
_VALID_NAME = re.compile(r"^[^\s/\\](?:[^\t\n\r\f\v/\\]{0,252}[^\s/\\])?$")


class CredentialError(Exception):
    """Invalid kind/payload/visibility or a store-level rejection."""


@dataclass(frozen=True)
class KindSpec:
    """Declarative credential kind: payload schema + redaction set."""

    name: str
    required: Tuple[str, ...]
    optional: Tuple[str, ...] = ()
    secret_fields: Tuple[str, ...] = ()
    #: Replacing an existing entry keeps a secret field the caller omitted or
    #: sent empty, so an edit form need not ask for the password again.
    keep_secrets_on_put: bool = False
    #: Copied into ``credentials-materialized/`` for agent terminals. Off for
    #: kinds only root-side services may read (VPN logins).
    materialize: bool = True
    #: Extra per-kind payload checks beyond required/optional/unknown.
    validator: Optional[Callable[[Mapping[str, Any]], None]] = None


_FORTI_HOST = re.compile(
    r"^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$"
)
_FORTI_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_FORTI_REALM = re.compile(r"^[A-Za-z0-9._@-]{1,128}$")
_FORTI_ACCOUNT = re.compile(r"^[A-Za-z0-9._@ -]{1,128}$")
_FORTI_SHARE = re.compile(
    r"^(//|\\\\)[A-Za-z0-9.-]{1,253}[/\\][A-Za-z0-9 ._$-]{1,80}"
    r"([/\\][^/\\\x00-\x1f\x7f:*?\"<>|,]{1,255})*[/\\]?$"
)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def _validate_fortinet_vpn(payload: Mapping[str, Any]) -> None:
    """Shape checks for ``fortinet-vpn``; the root helper re-validates all of
    it (plus overlap with the box's own networks) before acting."""
    import ipaddress

    def fail(msg: str) -> None:
        raise CredentialError(f"fortinet-vpn: {msg}")

    host = str(payload.get("host") or "")
    try:
        ipaddress.IPv4Address(host)
    except ValueError:
        if not _FORTI_HOST.fullmatch(host) or host.replace(".", "").isdigit():
            fail("host must be a hostname or IPv4 address")
    for key in ("username", "password", "share_password"):
        value = payload.get(key)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or len(value) > 256:
            fail(f"{key} must be a string of at most 256 characters")
        if _CONTROL.search(value) or value != value.strip():
            fail(f"{key} must not contain control characters or edge spaces")
    port = payload.get("port")
    if port is not None and (
        isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535
    ):
        fail("port must be an integer 1-65535")
    realm = payload.get("realm")
    if realm not in (None, "") and (
        not isinstance(realm, str) or not _FORTI_REALM.fullmatch(realm)
    ):
        fail("realm may only contain letters, digits and ._@-")
    cert = payload.get("trusted_cert")
    if cert not in (None, "") and (
        not isinstance(cert, str) or not _FORTI_SHA256.fullmatch(cert)
    ):
        fail("trusted_cert must be a sha256 digest: 64 lowercase hex characters")
    routes = payload.get("routes")
    if routes is not None:
        if not isinstance(routes, list) or len(routes) > 32:
            fail("routes must be a list of at most 32 IPv4 CIDRs")
        for route in routes:
            try:
                net = ipaddress.IPv4Network(str(route), strict=True)
            except ValueError as exc:
                fail(f"route {route!r} is not a valid IPv4 CIDR ({exc})")
            else:
                if net.prefixlen < 8:
                    fail(f"route {route} is too broad (use /8 or longer)")
    share = payload.get("share_path")
    if share not in (None, "") and (
        not isinstance(share, str) or not _FORTI_SHARE.fullmatch(share)
    ):
        fail("share_path must look like //server/share or \\\\server\\share")
    for key in ("share_username", "share_domain"):
        value = payload.get(key)
        if value not in (None, "") and (
            not isinstance(value, str) or not _FORTI_ACCOUNT.fullmatch(value)
        ):
            fail(f"{key} may only contain letters, digits, spaces and ._@-")
    if payload.get("auto_connect") is not None and not isinstance(
        payload.get("auto_connect"), bool
    ):
        fail("auto_connect must be true or false")
    idle = payload.get("idle_minutes")
    if idle is not None and (
        isinstance(idle, bool) or not isinstance(idle, int) or not 0 <= idle <= 1440
    ):
        fail("idle_minutes must be an integer 0-1440")


_SMB_PATH = re.compile(
    r"^//[A-Za-z0-9.-]{1,253}/[A-Za-z0-9 ._$-]{1,80}"
    r"(/[^/\\\x00-\x1f\x7f:*?\"<>|,]{1,255})*$"
)


def _validate_smb_folder(payload: Mapping[str, Any]) -> None:
    """Shape checks for ``smb-folder`` (a network folder reached through a
    ``fortinet-vpn`` entry); the root helper re-validates before mounting."""

    def fail(msg: str) -> None:
        raise CredentialError(f"smb-folder: {msg}")

    vpn_name = payload.get("vpn")
    if not isinstance(vpn_name, str) or not _VALID_NAME.fullmatch(vpn_name):
        fail("vpn must be the name of a saved VPN")
    share = payload.get("share_path")
    if (
        not isinstance(share, str)
        or not _SMB_PATH.fullmatch(share)
        or any(part in (".", "..") for part in share[2:].split("/"))
    ):
        fail("share_path must look like //server/share[/folder]")
    password = payload.get("share_password")
    if password not in (None, ""):
        if not isinstance(password, str) or len(password) > 256:
            fail("share_password must be a string of at most 256 characters")
        if _CONTROL.search(password) or password != password.strip():
            fail("share_password must not contain control characters or edge spaces")
    for key in ("share_username", "share_domain"):
        value = payload.get(key)
        if value not in (None, "") and (
            not isinstance(value, str) or not _FORTI_ACCOUNT.fullmatch(value)
        ):
            fail(f"{key} may only contain letters, digits, spaces and ._@-")
    trusted = payload.get("trusted_for_import")
    if trusted is not None and not isinstance(trusted, bool):
        fail("trusted_for_import must be true or false")


def _validate_mcp_server(payload: Mapping[str, Any]) -> None:
    from hermes_cli.personal_mcp import validate_credential_payload

    validate_credential_payload(payload)


_MAIL_SECURITY = ("ssl", "starttls")


def _validate_email_imap(payload: Mapping[str, Any]) -> None:
    def fail(msg: str) -> None:
        raise CredentialError(f"email-imap: {msg}")

    address = str(payload.get("address") or "").strip()
    if address.count("@") != 1 or _CONTROL.search(address) or " " in address:
        fail("address must be an email address")
    if _CONTROL.search(str(payload.get("username") or "")):
        fail("username contains control characters")
    for side in ("imap", "smtp"):
        host = str(payload.get(f"{side}_host") or "").strip()
        if not _FORTI_HOST.fullmatch(host):
            fail(f"{side}_host must be a host name")
        port = payload.get(f"{side}_port")
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            fail(f"{side}_port must be a number from 1 to 65535")
        security = payload.get(f"{side}_security", "ssl")
        if security not in _MAIL_SECURITY:
            fail(f"{side}_security must be one of {', '.join(_MAIL_SECURITY)}")


CREDENTIAL_KINDS: Dict[str, KindSpec] = {
    "google-oauth2": KindSpec(
        name="google-oauth2",
        required=("client_id", "client_secret", "refresh_token", "token_uri"),
        optional=("token", "expiry", "scopes", "type"),
        secret_fields=("client_secret", "refresh_token", "token"),
    ),
    "telegram-token": KindSpec(
        name="telegram-token",
        required=("bot_token",),
        secret_fields=("bot_token",),
    ),
    "whatsapp-session": KindSpec(
        name="whatsapp-session",
        required=("session",),
        secret_fields=("session",),
    ),
    "password": KindSpec(
        name="password",
        required=("username", "password"),
        secret_fields=("password",),
    ),
    "fortinet-vpn": KindSpec(
        name="fortinet-vpn",
        required=("host", "username", "password"),
        optional=(
            "port", "realm", "trusted_cert", "routes", "share_path",
            "share_username", "share_password", "share_domain",
            "auto_connect", "idle_minutes",
        ),
        secret_fields=("password", "share_password"),
        keep_secrets_on_put=True,
        materialize=False,
        validator=_validate_fortinet_vpn,
    ),
    "email-imap": KindSpec(
        name="email-imap",
        required=(
            "address", "username", "password",
            "imap_host", "imap_port", "smtp_host", "smtp_port",
        ),
        optional=("imap_security", "smtp_security", "preset"),
        secret_fields=("password",),
        keep_secrets_on_put=True,
        materialize=False,
        validator=_validate_email_imap,
    ),
    "smb-folder": KindSpec(
        name="smb-folder",
        required=("vpn", "share_path"),
        optional=("share_username", "share_password", "share_domain", "trusted_for_import"),
        secret_fields=("share_password",),
        keep_secrets_on_put=True,
        materialize=False,
        validator=_validate_smb_folder,
    ),
    # A person's own MCP server (hermes_cli/personal_mcp.py). Header values
    # are API keys; only the chat runtime reads them.
    "mcp-server": KindSpec(
        name="mcp-server",
        required=("url",),
        optional=("headers", "auth"),
        secret_fields=("headers",),
        materialize=False,
        validator=_validate_mcp_server,
    ),
    # A person's own @BotFather bot (Get ready item 6). The gateway runs it
    # only for its owner and only once ``linked_user_id`` is set.
    "telegram-bot": KindSpec(
        name="telegram-bot",
        required=("token",),
        optional=(
            "bot_id", "bot_username", "bot_name", "linked_user_id",
            "linked_username", "link_code_hash", "link_code_expires",
            "last_test_at", "last_test_ok", "last_test_error",
        ),
        secret_fields=("token", "link_code_hash"),
        keep_secrets_on_put=True,
        materialize=False,
    ),
    # Settings -> GitHub token (FG-33 decision 14): app source is pushed to
    # GitHub with it by hermes_cli/app_source_publish.py. Never materialized:
    # agent terminals and app processes must not hold it.
    "github-token": KindSpec(
        name="github-token",
        required=("token",),
        secret_fields=("token",),
        materialize=False,
    ),
}


def merge_kept_secrets(
    kind: str, payload: Mapping[str, Any], existing: Optional[Mapping[str, Any]]
) -> Dict[str, Any]:
    """``payload`` with omitted/empty secret fields refilled from ``existing``
    (only for kinds with ``keep_secrets_on_put``)."""
    merged = dict(payload)
    spec = CREDENTIAL_KINDS.get(kind)
    if spec is None or not spec.keep_secrets_on_put or not existing:
        return merged
    for key in spec.secret_fields:
        if merged.get(key) in (None, "") and existing.get(key) not in (None, ""):
            merged[key] = existing[key]
    return merged


def validate_payload(kind: str, payload: Mapping[str, Any]) -> None:
    """Raise :class:`CredentialError` unless ``payload`` fits ``kind``."""
    spec = CREDENTIAL_KINDS.get(kind)
    if spec is None:
        raise CredentialError(f"Unknown credential kind: {kind!r}")
    if not isinstance(payload, Mapping):
        raise CredentialError("credential payload must be an object")
    missing = [k for k in spec.required if not str(payload.get(k) or "").strip()]
    if missing:
        raise CredentialError(
            f"kind {kind!r} requires fields: {', '.join(missing)}"
        )
    allowed = set(spec.required) | set(spec.optional)
    unknown = sorted(set(payload) - allowed)
    if unknown:
        raise CredentialError(
            f"kind {kind!r} does not accept fields: {', '.join(unknown)}"
        )
    if spec.validator is not None:
        spec.validator(payload)


def redact_payload(kind: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
    """Return ``payload`` with every secret field removed."""
    spec = CREDENTIAL_KINDS.get(kind)
    secrets = set(spec.secret_fields) if spec else set(payload)
    return {k: v for k, v in dict(payload).items() if k not in secrets}


def validate_services(services: Any) -> List[str]:
    if services is None:
        return []
    if not isinstance(services, (list, tuple)):
        raise CredentialError("services must be a list")
    clean = sorted({str(s) for s in services})
    unknown = [s for s in clean if s not in SERVICES]
    if unknown:
        raise CredentialError(f"unknown services: {', '.join(unknown)}")
    return clean


@dataclass
class Credential:
    """One stored credential entry (full, unredacted payload)."""

    owner_user_id: str
    provider: str
    name: str
    kind: str
    visibility: str
    services: List[str] = field(default_factory=list)
    payload: Dict[str, Any] = field(default_factory=dict)
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    def redacted(self) -> Dict[str, Any]:
        """The HTTP-safe view: metadata + redacted payload."""
        return {
            "owner_user_id": self.owner_user_id,
            "provider": self.provider,
            "name": self.name,
            "kind": self.kind,
            "visibility": self.visibility,
            "services": list(self.services),
            "payload": redact_payload(self.kind, self.payload),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


MIGRATION_SQL = f"""
CREATE TABLE IF NOT EXISTS {CREDENTIALS_TABLE} (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'shared'
        CHECK (visibility = 'shared' OR visibility LIKE 'private:%'),
    services TEXT[] NOT NULL DEFAULT '{{}}',
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (owner_user_id, provider, name)
);
CREATE INDEX IF NOT EXISTS credentials_service_idx
    ON {CREDENTIALS_TABLE} USING GIN (services);
"""


def _sanitize_segment(value: str) -> str:
    """Filesystem-safe encoding for owner/provider/name path segments."""
    return quote(value, safe="@._-")


def _check_entry_ids(provider: str, name: str) -> None:
    if not provider or not provider.strip():
        raise CredentialError("provider cannot be empty")
    if not _VALID_NAME.fullmatch(name or ""):
        raise CredentialError(f"invalid credential name: {name!r}")


class FileCredentialStore:
    """Portable file backend; ``$HERMES_HOME/credentials/<u>/<p>/<n>.json``."""

    backend = "file"

    def __init__(self, root: Optional[Path] = None) -> None:
        if root is None:
            from hermes_constants import get_hermes_home

            root = get_hermes_home() / "credentials"
        self._root = Path(root)

    async def initialize(self, *, connection: Any = None) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        os.chmod(self._root, 0o700)

    # -- helpers -----------------------------------------------------------

    def _entry_path(self, owner: str, provider: str, name: str) -> Path:
        return (
            self._root
            / _sanitize_segment(owner)
            / _sanitize_segment(provider)
            / (_sanitize_segment(name) + ".json")
        )

    def _read_doc(self, path: Path) -> Optional[Dict[str, Any]]:
        try:
            return json.loads(path.read_text())  # noqa: PLW1514 — must match the locale-default writes below
        except (OSError, ValueError):
            return None

    def _write_doc(self, path: Path, doc: Dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        fd, tmp = tempfile.mkstemp(
            dir=str(path.parent), prefix=".cred-", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(doc, fh, indent=2, default=str)
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _iter_docs(self) -> List[Dict[str, Any]]:
        docs: List[Dict[str, Any]] = []
        if not self._root.exists():
            return docs
        for user_dir in sorted(self._root.iterdir()):
            if not user_dir.is_dir():
                continue
            for prov_dir in sorted(user_dir.iterdir()):
                if not prov_dir.is_dir():
                    continue
                for entry in sorted(prov_dir.glob("*.json")):
                    doc = self._read_doc(entry)
                    if doc:
                        docs.append(doc)
        return docs

    @staticmethod
    def _visible(doc: Dict[str, Any], principal: Any) -> bool:
        from hermes_cli.access import parse_private_owner

        if principal.is_owner:
            return True
        vis = doc.get("visibility", "shared")
        if vis == "shared":
            return True
        return parse_private_owner(vis) == principal.user_id

    @staticmethod
    def _doc_to_credential(doc: Dict[str, Any]) -> Credential:
        return Credential(
            owner_user_id=str(doc.get("owner_user_id", "")),
            provider=str(doc.get("provider", "")),
            name=str(doc.get("name", "")),
            kind=str(doc.get("kind", "")),
            visibility=str(doc.get("visibility", "shared")),
            services=list(doc.get("services") or []),
            payload=dict(doc.get("payload") or {}),
        )

    # -- surface -----------------------------------------------------------

    async def list(self, principal: Any) -> List[Credential]:
        return [
            self._doc_to_credential(d)
            for d in self._iter_docs()
            if self._visible(d, principal)
        ]

    async def get(
        self, principal: Any, provider: str, name: str
    ) -> Optional[Credential]:
        for doc in self._iter_docs():
            if (
                doc.get("provider") == provider
                and doc.get("name") == name
                and self._visible(doc, principal)
            ):
                return self._doc_to_credential(doc)
        return None

    async def put(
        self,
        principal: Any,
        *,
        provider: str,
        name: str,
        kind: str,
        payload: Mapping[str, Any],
        services: Optional[List[str]] = None,
        visibility: Optional[str] = None,
    ) -> Credential:
        from hermes_cli.access import normalize_visibility, parse_private_owner

        _check_entry_ids(provider, name)
        validate_payload(kind, payload)
        vis = normalize_visibility(visibility or principal.private_visibility)
        owner_of_vis = parse_private_owner(vis)
        if owner_of_vis is not None and owner_of_vis != principal.user_id:
            raise CredentialError("cannot store a private entry for another user")
        path = self._entry_path(principal.user_id, provider, name)
        existing = self._read_doc(path)
        now = datetime.now().astimezone()
        doc = {
            "owner_user_id": principal.user_id,
            "provider": provider,
            "name": name,
            "kind": kind,
            "visibility": vis,
            "services": validate_services(services),
            "payload": dict(payload),
            "created_at": (existing or {}).get("created_at") or now.isoformat(),
            "updated_at": now.isoformat(),
        }
        self._write_doc(path, doc)
        return self._doc_to_credential(doc)

    async def patch(
        self,
        principal: Any,
        provider: str,
        name: str,
        *,
        services: Optional[List[str]] = None,
        visibility: Optional[str] = None,
    ) -> Optional[Credential]:
        from hermes_cli.access import normalize_visibility, parse_private_owner

        path = self._entry_path(principal.user_id, provider, name)
        doc = self._read_doc(path)
        if doc is None:
            return None
        if services is not None:
            doc["services"] = validate_services(services)
        if visibility is not None:
            vis = normalize_visibility(visibility)
            owner_of_vis = parse_private_owner(vis)
            if owner_of_vis is not None and owner_of_vis != principal.user_id:
                raise CredentialError(
                    "cannot store a private entry for another user"
                )
            doc["visibility"] = vis
        doc["updated_at"] = datetime.now().astimezone().isoformat()
        self._write_doc(path, doc)
        return self._doc_to_credential(doc)

    async def delete(self, principal: Any, provider: str, name: str) -> bool:
        path = self._entry_path(principal.user_id, provider, name)
        if not path.exists():
            return False
        path.unlink()
        return True

    async def resolve_for_service(
        self, service: str, *, provider: str = "google"
    ) -> List[Credential]:
        """Full-payload entries opting into ``service`` (in-process callers only)."""
        if service not in SERVICES:
            raise CredentialError(f"unknown service: {service!r}")
        return [
            self._doc_to_credential(d)
            for d in self._iter_docs()
            if d.get("provider") == provider and service in (d.get("services") or [])
        ]

    async def resolve_by_kind(self, kind: str, *, provider: str) -> List[Credential]:
        """Every owner's full-payload ``kind`` entries (in-process callers only)."""
        return [
            self._doc_to_credential(d)
            for d in self._iter_docs()
            if d.get("provider") == provider and d.get("kind") == kind
        ]

    async def update_tokens(
        self,
        provider: str,
        name: str,
        *,
        owner_user_id: str,
        old_refresh_token: str,
        payload_fragment: Mapping[str, Any],
    ) -> bool:
        path = self._entry_path(owner_user_id, provider, name)
        doc = self._read_doc(path)
        if doc is None:
            return False
        payload = doc.get("payload") or {}
        if payload.get("refresh_token") != old_refresh_token:
            return False
        payload.update(dict(payload_fragment))
        doc["payload"] = payload
        doc["updated_at"] = datetime.now().astimezone().isoformat()
        self._write_doc(path, doc)
        return True


class SupabaseCredentialStore:
    """Supabase backend over the C3 app schema, contract C2."""

    backend = "supabase"

    def __init__(self, app_store: Any) -> None:
        self._store = app_store

    @property
    def mode(self) -> str:
        return self._store.mode

    async def _connect(self) -> Any:
        return await self._store.connect()

    async def initialize(self, *, connection: Any = None) -> None:
        """Create the credentials table + C2 RLS policy. Idempotent."""
        from hermes_cli.access import apply_scope_rls, initialize_access

        own = connection is None
        conn = connection or await self._connect()
        try:
            await initialize_access(conn)
            await conn.execute(MIGRATION_SQL)
            await apply_scope_rls(conn, CREDENTIALS_TABLE)
        finally:
            if own:
                await conn.close()

    @staticmethod
    def _row_to_credential(row: Any) -> Credential:
        payload = row["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        return Credential(
            owner_user_id=str(row["owner_user_id"]),
            provider=str(row["provider"]),
            name=str(row["name"]),
            kind=str(row["kind"]),
            visibility=str(row["visibility"]),
            services=list(row["services"] or []),
            payload=dict(payload or {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    async def list(self, principal: Any) -> List[Credential]:
        from hermes_cli.access import bind_principal, scope_filter

        predicate = scope_filter(principal, start_index=1)
        conn = await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                rows = await conn.fetch(
                    f"""
                    SELECT owner_user_id, provider, name, kind, visibility,
                           services, payload, created_at, updated_at
                    FROM {CREDENTIALS_TABLE}
                    WHERE {predicate.sql}
                    ORDER BY provider, name
                    """,
                    *predicate.params,
                )
            return [self._row_to_credential(r) for r in rows]
        finally:
            await conn.close()

    async def get(
        self, principal: Any, provider: str, name: str
    ) -> Optional[Credential]:
        from hermes_cli.access import bind_principal, scope_filter

        predicate = scope_filter(principal, start_index=3)
        conn = await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""
                    SELECT owner_user_id, provider, name, kind, visibility,
                           services, payload, created_at, updated_at
                    FROM {CREDENTIALS_TABLE}
                    WHERE provider = $1 AND name = $2 AND {predicate.sql}
                    """,
                    provider,
                    name,
                    *predicate.params,
                )
            return self._row_to_credential(row) if row else None
        finally:
            await conn.close()

    async def put(
        self,
        principal: Any,
        *,
        provider: str,
        name: str,
        kind: str,
        payload: Mapping[str, Any],
        services: Optional[List[str]] = None,
        visibility: Optional[str] = None,
    ) -> Credential:
        from hermes_cli.access import (
            bind_principal,
            normalize_visibility,
            parse_private_owner,
        )

        _check_entry_ids(provider, name)
        validate_payload(kind, payload)
        vis = normalize_visibility(visibility or principal.private_visibility)
        owner_of_vis = parse_private_owner(vis)
        if owner_of_vis is not None and owner_of_vis != principal.user_id:
            raise CredentialError("cannot store a private entry for another user")
        clean_services = validate_services(services)
        conn = await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {CREDENTIALS_TABLE} (
                        owner_user_id, provider, name, kind, visibility,
                        services, payload)
                    VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb)
                    ON CONFLICT (owner_user_id, provider, name) DO UPDATE
                        SET kind = EXCLUDED.kind,
                            visibility = EXCLUDED.visibility,
                            services = EXCLUDED.services,
                            payload = EXCLUDED.payload,
                            updated_at = NOW()
                    RETURNING owner_user_id, provider, name, kind, visibility,
                              services, payload, created_at, updated_at
                    """,
                    principal.user_id,
                    provider,
                    name,
                    kind,
                    vis,
                    clean_services,
                    json.dumps(dict(payload)),
                )
            return self._row_to_credential(row)
        finally:
            await conn.close()

    async def patch(
        self,
        principal: Any,
        provider: str,
        name: str,
        *,
        services: Optional[List[str]] = None,
        visibility: Optional[str] = None,
    ) -> Optional[Credential]:
        from hermes_cli.access import (
            bind_principal,
            normalize_visibility,
            parse_private_owner,
        )

        sets: List[str] = []
        params: List[Any] = [provider, name, principal.user_id]
        if services is not None:
            params.append(validate_services(services))
            sets.append(f"services = ${len(params)}::text[]")
        if visibility is not None:
            vis = normalize_visibility(visibility)
            owner_of_vis = parse_private_owner(vis)
            if owner_of_vis is not None and owner_of_vis != principal.user_id:
                raise CredentialError(
                    "cannot store a private entry for another user"
                )
            params.append(vis)
            sets.append(f"visibility = ${len(params)}")
        if not sets:
            return await self.get(principal, provider, name)
        sets.append("updated_at = NOW()")
        conn = await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                row = await conn.fetchrow(
                    f"""
                    UPDATE {CREDENTIALS_TABLE}
                    SET {', '.join(sets)}
                    WHERE provider = $1 AND name = $2
                      AND owner_user_id = $3
                    RETURNING owner_user_id, provider, name, kind, visibility,
                              services, payload, created_at, updated_at
                    """,
                    *params,
                )
            return self._row_to_credential(row) if row else None
        finally:
            await conn.close()

    async def delete(self, principal: Any, provider: str, name: str) -> bool:
        from hermes_cli.access import bind_principal

        conn = await self._connect()
        try:
            async with conn.transaction():
                await bind_principal(conn, principal)
                tag = await conn.execute(
                    f"""
                    DELETE FROM {CREDENTIALS_TABLE}
                    WHERE provider = $1 AND name = $2 AND owner_user_id = $3
                    """,
                    provider,
                    name,
                    principal.user_id,
                )
            return tag.endswith("1")
        finally:
            await conn.close()

    async def resolve_for_service(
        self, service: str, *, provider: str = "google"
    ) -> List[Credential]:
        """Full-payload entries opting into ``service``.

        Binds the owner principal (service context reads every opted-in row
        regardless of visibility); in-process callers only.
        """
        from hermes_cli.access import PrincipalStore, bind_principal

        if service not in SERVICES:
            raise CredentialError(f"unknown service: {service!r}")
        conn = await self._connect()
        try:
            async with conn.transaction():
                owner = await PrincipalStore(self._store).get_owner(
                    connection=conn
                )
                if owner is None:
                    return []
                await bind_principal(conn, owner)
                rows = await conn.fetch(
                    f"""
                    SELECT owner_user_id, provider, name, kind, visibility,
                           services, payload, created_at, updated_at
                    FROM {CREDENTIALS_TABLE}
                    WHERE provider = $1 AND $2 = ANY(services)
                    ORDER BY name
                    """,
                    provider,
                    service,
                )
            return [self._row_to_credential(r) for r in rows]
        finally:
            await conn.close()

    async def resolve_by_kind(self, kind: str, *, provider: str) -> List[Credential]:
        """Every owner's full-payload ``kind`` entries (in-process callers only).

        Binds the owner principal like :meth:`resolve_for_service`.
        """
        from hermes_cli.access import PrincipalStore, bind_principal

        conn = await self._connect()
        try:
            async with conn.transaction():
                owner = await PrincipalStore(self._store).get_owner(
                    connection=conn
                )
                if owner is None:
                    return []
                await bind_principal(conn, owner)
                rows = await conn.fetch(
                    f"""
                    SELECT owner_user_id, provider, name, kind, visibility,
                           services, payload, created_at, updated_at
                    FROM {CREDENTIALS_TABLE}
                    WHERE provider = $1 AND kind = $2
                    ORDER BY owner_user_id, name
                    """,
                    provider,
                    kind,
                )
            return [self._row_to_credential(r) for r in rows]
        finally:
            await conn.close()

    async def update_tokens(
        self,
        provider: str,
        name: str,
        *,
        owner_user_id: str,
        old_refresh_token: str,
        payload_fragment: Mapping[str, Any],
    ) -> bool:
        """Conditional single-writer token persistence.

        The update lands only while the stored refresh token still equals
        ``old_refresh_token``; a concurrent refresher that already rotated the
        token loses this write (returns ``False``) and must re-read.
        """
        conn = await self._connect()
        try:
            row = await conn.fetchrow(
                f"""
                UPDATE {CREDENTIALS_TABLE}
                SET payload = payload || $4::jsonb, updated_at = NOW()
                WHERE owner_user_id = $1 AND provider = $2 AND name = $3
                  AND payload->>'refresh_token' = $5
                RETURNING id
                """,
                owner_user_id,
                provider,
                name,
                json.dumps(dict(payload_fragment)),
                old_refresh_token,
            )
            return row is not None
        finally:
            await conn.close()


def default_credential_store(config: Optional[Mapping[str, Any]] = None) -> Any:
    """The configured backend: Supabase when its DSN resolves, else file."""
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    loaded = dict(config) if config is not None else (load_config() or {})
    creds_cfg = loaded.get("credentials") or {}
    backend = str(creds_cfg.get("backend") or "auto").strip().lower()
    if backend in ("auto", "supabase"):
        app_store = get_store("supabase-app", "prod", config=loaded)
        if app_store.dsn:
            return SupabaseCredentialStore(app_store)
        if backend == "supabase":
            # Explicitly requested but unconfigured: surface the store so the
            # caller gets the datastore's own "not configured" error on use.
            return SupabaseCredentialStore(app_store)
    return FileCredentialStore()


def materialize_root() -> Path:
    """Where Supabase-backed entries are materialized for sandbox mounts."""
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "credentials-materialized"


async def resolve_owner_principal(principal: Any = None) -> Any:
    """The acting principal for service-context reads (owner fallback).

    Background consumers (sandbox mounts, platform adapters) have no logged-in
    user; they act under the enrolled owner, mirroring the dashboard's
    no-session fallback.
    """
    if principal is not None:
        return principal
    store = default_credential_store()
    if store.backend == "supabase":
        from hermes_cli.access import PrincipalStore

        return await PrincipalStore(store._store).get_owner()
    from hermes_cli.access import Principal

    return Principal(user_id="owner", display="owner", role="owner")


async def materialize_for_mounts(principal: Any = None) -> List[str]:
    """Write the principal's readable entries as 0600 files for mounting.

    Returns HERMES_HOME-relative paths suitable for
    :func:`tools.credential_files.register_credential_file`. Works for both
    backends: entries are copied out of the store (Supabase rows or file
    backend docs) into ``credentials-materialized/`` so mount paths are
    uniform and never expose the store tree itself.
    """
    actor = await resolve_owner_principal(principal)
    if actor is None:
        return []
    store = default_credential_store()
    entries = await store.list(actor)
    root = materialize_root()
    shutil.rmtree(root, ignore_errors=True)
    paths: List[str] = []
    for cred in entries:
        kind_spec = CREDENTIAL_KINDS.get(cred.kind)
        if kind_spec is not None and not kind_spec.materialize:
            continue
        rel = (
            Path("credentials-materialized")
            / _sanitize_segment(cred.owner_user_id)
            / _sanitize_segment(cred.provider)
            / (_sanitize_segment(cred.name) + ".json")
        )
        dest = root / rel.relative_to(Path("credentials-materialized"))
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(dest.parent, 0o700)
        fd, tmp = tempfile.mkstemp(dir=str(dest.parent), prefix=".cred-")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(
                    {
                        "owner_user_id": cred.owner_user_id,
                        "provider": cred.provider,
                        "name": cred.name,
                        "kind": cred.kind,
                        "visibility": cred.visibility,
                        "services": cred.services,
                        "payload": cred.payload,
                    },
                    fh,
                    indent=2,
                    default=str,
                )
            os.chmod(tmp, 0o600)
            os.replace(tmp, dest)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        paths.append(str(rel))
    return paths


def materialize_for_mounts_sync(principal: Any = None) -> List[str]:
    """Sync facade over :func:`materialize_for_mounts`.

    Skill activation runs both inside the event loop (gateway) and in plain
    threads (CLI); a running loop gets a dedicated thread so ``asyncio.run``
    stays legal.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(materialize_for_mounts(principal))
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, materialize_for_mounts(principal)).result()
