"""FG-26 E2E — invitation activation against **real GoTrue** and real Postgres.

The doc requires the invitation negatives against a real auth server rather
than a mock, and for good reason: every interesting claim here is a claim about
*GoTrue's* behaviour, not about our code's opinion of it. A mocked admin client
would happily "ban" an account and "reject" a login because the fake said so.
So this module boots a throwaway Postgres **and** a throwaway
``supabase/gotrue`` against it, and asserts:

* a created account is **banned**: the real token endpoint refuses the login
  before redemption and accepts it afterwards, with the password the invitee
  chose (never one an admin picked);
* only a **SHA-256 hash** is stored — the raw token appears in no column;
* every failure mode (unknown / tampered / expired / used / revoked / not
  enrolled) is refused **identically**, so the endpoint is not an existence
  oracle, and a second redemption of a spent token fails;
* the token never reaches a list response, a log line, or a C5 payload;
* redemption sets the password, lifts the ban, marks ``used_at``, and audits;
* an email that already has an account is an **enrolment**: no invitation, and
  the password it already logs in with keeps working.

Standalone GoTrue serves its API at the root (``/admin/users``), while a
Supabase deployment fronts it with Kong under ``/auth/v1``. The fixture puts a
~30-line prefix-stripping reverse proxy in front of the container to stand in
for Kong, so the client under test speaks the exact paths it speaks in
production and the auth server doing the work is genuinely GoTrue.
"""

from __future__ import annotations

import asyncio
import http.server
import json
import logging
import secrets
import shutil
import socket
import subprocess
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import asyncpg
import httpx
import pytest
import yaml

from hermes_cli.access import Principal, PrincipalStore, initialize_access
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.invitations import (
    InvitationError,
    hash_token,
    initialize_invitations,
)
from hermes_cli.members import (
    GoTrueAdminClient,
    MemberError,
    MemberProfileMismatchError,
    MemberService,
)

_POSTGRES_IMAGE = (
    "postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
)
_GOTRUE_IMAGE = "supabase/gotrue:v2.158.1"
_JWT_SECRET = "fg26-test-jwt-secret-with-at-least-32-characters"
_PLACEHOLDER = "Existing-account-password-9"
_CHOSEN = "the-invitee-chose-this-1"
_OWNER = "leo_owner"


# --------------------------------------------------------------------------
# infrastructure
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Auth:
    """A live GoTrue: the URL our client uses and its service-role key."""

    url: str
    service_role_key: str
    dsn: str


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _docker_or_skip() -> None:
    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the FG-26 GoTrue E2E test")
    daemon = subprocess.run(
        ["docker", "info"], check=False, capture_output=True, text=True
    )
    if daemon.returncode != 0:
        pytest.skip("Docker daemon is unavailable for the FG-26 GoTrue E2E test")


def _service_role_key() -> str:
    """A service-role JWT GoTrue will accept on its ``/admin`` routes."""
    import jwt

    now = int(time.time())
    return jwt.encode(
        {
            "role": "service_role",
            "iss": "supabase",
            "iat": now,
            "exp": now + 3600,
        },
        _JWT_SECRET,
        algorithm="HS256",
    )


class _KongShim(http.server.ThreadingHTTPServer):
    """Strips the ``/auth/v1`` prefix Kong adds in a Supabase deployment."""

    daemon_threads = True
    upstream = ""


class _ShimHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_: object) -> None:  # noqa: A003 - quiet the shim
        return

    def _forward(self) -> None:
        server = self.server
        assert isinstance(server, _KongShim)
        path = self.path
        if path.startswith("/auth/v1"):
            path = path[len("/auth/v1") :] or "/"
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower() not in ("host", "content-length", "connection")
        }
        upstream = httpx.request(
            self.command,
            f"{server.upstream}{path}",
            content=body,
            headers=headers,
            timeout=15.0,
        )
        payload = upstream.content
        self.send_response(upstream.status_code)
        self.send_header(
            "content-type", upstream.headers.get("content-type", "application/json")
        )
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    do_GET = _forward
    do_POST = _forward
    do_PUT = _forward
    do_DELETE = _forward


@pytest.fixture(scope="module")
def auth_stack() -> Iterator[_Auth]:
    """Boot Postgres + GoTrue + the Kong-shaped prefix shim for this module."""
    _docker_or_skip()
    pytest.importorskip("jwt", reason="PyJWT is needed to mint a service-role key")

    subprocess.run(["docker", "pull", _POSTGRES_IMAGE], check=True, capture_output=True)
    subprocess.run(["docker", "pull", _GOTRUE_IMAGE], check=True, capture_output=True)

    suffix = uuid.uuid4().hex[:12]
    pg_name = f"hermes-fg26-pg-{suffix}"
    gotrue_name = f"hermes-fg26-gotrue-{suffix}"
    shim: _KongShim | None = None
    try:
        subprocess.run(
            [
                "docker",
                "run",
                "--detach",
                "--rm",
                "--name",
                pg_name,
                "--env",
                "POSTGRES_PASSWORD=hermes-test",
                "--env",
                "POSTGRES_DB=hermes_test",
                "--publish",
                "127.0.0.1::5432",
                _POSTGRES_IMAGE,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        port = (
            subprocess
            .run(
                ["docker", "port", pg_name, "5432/tcp"],
                check=True,
                capture_output=True,
                text=True,
            )
            .stdout.strip()
            .rsplit(":", 1)[1]
        )
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"
        _await_postgres(dsn)

        # GoTrue owns the ``auth`` schema but does not create it.
        asyncio.run(_create_auth_schema(dsn))

        gotrue_port = _free_port()
        subprocess.run(
            [
                "docker",
                "run",
                "--detach",
                "--rm",
                "--name",
                gotrue_name,
                "--network",
                "host",
                "--env",
                "GOTRUE_DB_DRIVER=postgres",
                "--env",
                (
                    "DATABASE_URL=postgres://postgres:hermes-test@127.0.0.1:"
                    f"{port}/hermes_test?search_path=auth&sslmode=disable"
                ),
                "--env",
                "GOTRUE_DB_NAMESPACE=auth",
                "--env",
                "GOTRUE_API_HOST=127.0.0.1",
                "--env",
                f"PORT={gotrue_port}",
                "--env",
                f"API_EXTERNAL_URL=http://127.0.0.1:{gotrue_port}",
                "--env",
                "GOTRUE_SITE_URL=http://127.0.0.1",
                "--env",
                f"GOTRUE_JWT_SECRET={_JWT_SECRET}",
                "--env",
                "GOTRUE_JWT_EXP=3600",
                "--env",
                "GOTRUE_JWT_AUD=authenticated",
                "--env",
                "GOTRUE_DISABLE_SIGNUP=false",
                "--env",
                "GOTRUE_MAILER_AUTOCONFIRM=true",
                "--env",
                "GOTRUE_LOG_LEVEL=warn",
                _GOTRUE_IMAGE,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        _await_gotrue(f"http://127.0.0.1:{gotrue_port}", gotrue_name)

        shim_port = _free_port()
        shim = _KongShim(("127.0.0.1", shim_port), _ShimHandler)
        shim.upstream = f"http://127.0.0.1:{gotrue_port}"
        threading.Thread(target=shim.serve_forever, daemon=True).start()

        yield _Auth(
            url=f"http://127.0.0.1:{shim_port}",
            service_role_key=_service_role_key(),
            dsn=dsn,
        )
    finally:
        if shim is not None:
            shim.shutdown()
        for name in (gotrue_name, pg_name):
            subprocess.run(
                ["docker", "rm", "--force", name], check=False, capture_output=True
            )


def _await_postgres(dsn: str) -> None:
    async def probe() -> None:
        connection = await asyncpg.connect(dsn, ssl=False)
        await connection.close()

    for _ in range(120):
        try:
            asyncio.run(probe())
            return
        except (OSError, asyncpg.PostgresError):
            time.sleep(0.25)
    raise RuntimeError("Throwaway Postgres did not become ready")


async def _create_auth_schema(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        await connection.execute("CREATE SCHEMA IF NOT EXISTS auth")
    finally:
        await connection.close()


def _await_gotrue(base: str, container: str) -> None:
    for _ in range(160):
        try:
            if httpx.get(f"{base}/health", timeout=2.0).status_code == 200:
                return
        except httpx.RequestError:
            pass
        time.sleep(0.25)
    logs = subprocess.run(
        ["docker", "logs", "--tail", "40", container],
        check=False,
        capture_output=True,
        text=True,
    )
    raise RuntimeError(f"GoTrue did not become ready:\n{logs.stdout}{logs.stderr}")


# --------------------------------------------------------------------------
# service fixtures
# --------------------------------------------------------------------------


@pytest.fixture
def default_profile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Run as the *default* profile, whose schema is the historical ``app_prod``."""
    import hermes_cli.datastore as datastore

    home = tmp_path / "hermes-home"
    (home / "profiles").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(home))
    datastore._verified_schemas.clear()
    return home


@pytest.fixture
def service(auth_stack: _Auth, default_profile: Path) -> Iterator[MemberService]:
    """A :class:`MemberService` over real Postgres + real GoTrue, freshly reset."""
    asyncio.run(_reset(auth_stack.dsn))
    config = {"datastore": {"supabase_app": {"dsn": auth_stack.dsn}}}
    # The account-level guard reads each profile's principals through the
    # profile's own config.yaml, as production does.
    (default_profile / "config.yaml").write_text(yaml.safe_dump(config))
    store = PrincipalStore(get_store("supabase-app", "prod", config=config))
    admin = GoTrueAdminClient(
        url=auth_stack.url, service_role_key=auth_stack.service_role_key
    )
    yield MemberService(store, admin, config=config)


async def _reset(dsn: str) -> None:
    """Recreate the app schema and clear GoTrue's users between tests."""
    import hermes_cli.datastore as datastore

    raw = await asyncpg.connect(dsn, ssl=False)
    try:
        await raw.execute("DROP SCHEMA IF EXISTS app_prod CASCADE")
        await raw.execute("DELETE FROM auth.identities")
        await raw.execute("DELETE FROM auth.users")
        await initialize_supabase_app(raw)
    finally:
        await raw.close()

    # The schema initialisers run on a store connection, whose ``search_path``
    # is pinned to this profile's schema — the same seam production uses.
    datastore._verified_schemas.clear()
    store = get_store(
        "supabase-app", "prod", config={"datastore": {"supabase_app": {"dsn": dsn}}}
    )
    connection = await store.connect()
    try:
        await initialize_access(connection)
        await initialize_invitations(connection)
        await connection.execute(
            """
            INSERT INTO principals (user_id, display, role)
            VALUES ($1, 'Leo', 'owner')
            ON CONFLICT (user_id) DO NOTHING
            """,
            _OWNER,
        )
    finally:
        await connection.close()


def _owner() -> Principal:
    return Principal(user_id=_OWNER, display="Leo", role="owner")


def _login(auth: _Auth, email: str, password: str) -> int:
    """Attempt a real password grant; return the HTTP status GoTrue gave."""
    response = httpx.post(
        f"{auth.url}/auth/v1/token?grant_type=password",
        json={"email": email, "password": password},
        headers={"apikey": auth.service_role_key},
        timeout=15.0,
    )
    return response.status_code


async def _invitation_rows(dsn: str) -> list[dict[str, object]]:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        rows = await connection.fetch(
            "SELECT * FROM app_prod.invitations ORDER BY created_at"
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_created_account_is_banned_until_the_invitation_is_redeemed(
    service: MemberService, auth_stack: _Auth
) -> None:
    """The whole point of FG-26: no login until the invitee activates."""
    created = await service.create_member(
        _owner(), email="mia@x.io", profile="default", display="Mia", role="member"
    )
    assert created.enrolled_existing is False
    assert created.invitation_token

    # Banned: even the *correct* server-side password could not log in, and the
    # password the invitee is about to choose certainly cannot yet.
    assert _login(auth_stack, "mia@x.io", _CHOSEN) == 400

    assert await service.redeem_invitation(
        token=created.invitation_token, password=_CHOSEN
    )

    assert _login(auth_stack, "mia@x.io", _CHOSEN) == 200
    rows = await _invitation_rows(auth_stack.dsn)
    assert len(rows) == 1
    assert rows[0]["used_at"] is not None


@pytest.mark.asyncio
async def test_only_the_token_hash_is_stored(
    service: MemberService, auth_stack: _Auth
) -> None:
    """A stolen database backup must not yield a usable activation link."""
    created = await service.create_member(
        _owner(), email="hash@x.io", profile="default"
    )
    token = created.invitation_token or ""
    rows = await _invitation_rows(auth_stack.dsn)
    assert bytes(rows[0]["token_hash"]) == hash_token(token, "default")
    assert all(token not in str(value) for value in rows[0].values())


@pytest.mark.asyncio
async def test_every_invalid_token_is_refused_identically(
    service: MemberService, auth_stack: _Auth
) -> None:
    """Unknown / tampered / expired / used / revoked must be indistinguishable.

    All five return the same ``False``, which is what lets the unauthenticated
    endpoint answer with one neutral body and stay a non-oracle.
    """
    created = await service.create_member(
        _owner(), email="neutral@x.io", profile="default"
    )
    good = created.invitation_token or ""
    assert await service.redeem_invitation(token=good, password=_CHOSEN)

    expired = await service.create_member(
        _owner(), email="expired@x.io", profile="default"
    )
    connection = await asyncpg.connect(auth_stack.dsn, ssl=False)
    try:
        await connection.execute(
            "UPDATE app_prod.invitations SET expires_at = $1 WHERE token_hash = $2",
            datetime.now(timezone.utc) - timedelta(minutes=1),
            hash_token(expired.invitation_token or "", "default"),
        )
    finally:
        await connection.close()

    revoked = await service.create_member(
        _owner(), email="revoked@x.io", profile="default"
    )
    assert await service.revoke_invitation(_owner(), user_id=revoked.principal.user_id)

    outcomes = {
        "unknown": await service.redeem_invitation(
            token=secrets.token_urlsafe(32), password=_CHOSEN
        ),
        "tampered": await service.redeem_invitation(
            token=good[:-1] + ("A" if good[-1] != "A" else "B"), password=_CHOSEN
        ),
        "used": await service.redeem_invitation(token=good, password=_CHOSEN),
        "expired": await service.redeem_invitation(
            token=expired.invitation_token or "", password=_CHOSEN
        ),
        "revoked": await service.redeem_invitation(
            token=revoked.invitation_token or "", password=_CHOSEN
        ),
        "empty": await service.redeem_invitation(token="", password=_CHOSEN),
    }
    assert set(outcomes.values()) == {False}, outcomes


@pytest.mark.asyncio
async def test_regenerated_link_supersedes_the_one_the_admin_missed(
    service: MemberService, auth_stack: _Auth
) -> None:
    """Regenerate revokes the previous link rather than leaving two live."""
    created = await service.create_member(
        _owner(), email="again@x.io", profile="default"
    )
    first = created.invitation_token or ""
    _, second = await service.issue_invitation(
        _owner(), user_id=created.principal.user_id
    )
    assert second != first

    assert await service.redeem_invitation(token=first, password=_CHOSEN) is False
    assert await service.redeem_invitation(token=second, password=_CHOSEN)
    assert _login(auth_stack, "again@x.io", _CHOSEN) == 200


@pytest.mark.asyncio
async def test_token_never_reaches_a_list_response_a_log_or_a_c5_payload(
    service: MemberService, auth_stack: _Auth, caplog: pytest.LogCaptureFixture
) -> None:
    """The token exists in exactly one place: the admin's screen, once."""
    with caplog.at_level(logging.DEBUG):
        created = await service.create_member(
            _owner(), email="quiet@x.io", profile="default"
        )
    token = created.invitation_token or ""
    assert token

    page = await service.list_members(_owner())
    assert token not in json.dumps([view.as_dict() for view in page.members])
    assert token not in caplog.text

    connection = await asyncpg.connect(auth_stack.dsn, ssl=False)
    try:
        payloads = await connection.fetch(
            "SELECT payload::text AS payload, op::text AS op FROM app_prod.changes"
        )
    finally:
        await connection.close()
    assert payloads, "the create should have written a C5 change event"
    for row in payloads:
        assert token not in str(row["payload"])
        assert token not in str(row["op"])


@pytest.mark.asyncio
async def test_redeem_audits_the_activation(
    service: MemberService, auth_stack: _Auth
) -> None:
    """Activation is an identity event, and the ledger must say so."""
    from hermes_cli.identity_audit import list_identity_events

    created = await service.create_member(
        _owner(), email="audited@x.io", profile="default"
    )
    assert await service.redeem_invitation(
        token=created.invitation_token or "", password=_CHOSEN
    )
    config = {"datastore": {"supabase_app": {"dsn": auth_stack.dsn}}}
    events = await list_identity_events(
        store=get_store("supabase-app", "prod", config=config),
        principal=_owner(),
        config=config,
    )
    actions = [event["action"] for event in events]
    assert "user.activate" in actions
    assert "user.create" in actions


@pytest.mark.asyncio
async def test_a_weak_password_is_a_form_error_not_a_spent_link(
    service: MemberService, auth_stack: _Auth
) -> None:
    """A refused password must not burn the invitee's only link."""
    created = await service.create_member(
        _owner(), email="weak@x.io", profile="default"
    )
    token = created.invitation_token or ""
    with pytest.raises(InvitationError):
        await service.redeem_invitation(token=token, password="short")
    with pytest.raises(InvitationError):
        await service.redeem_invitation(token=token, password="weak@x.io")

    assert await service.redeem_invitation(token=token, password=_CHOSEN)
    assert _login(auth_stack, "weak@x.io", _CHOSEN) == 200


@pytest.mark.asyncio
async def test_an_existing_account_enrols_without_an_invitation_or_a_new_password(
    service: MemberService, auth_stack: _Auth
) -> None:
    """The second-profile case: enrolment, not an error, and no credential churn."""
    admin = GoTrueAdminClient(
        url=auth_stack.url, service_role_key=auth_stack.service_role_key
    )
    account = admin.create_user(
        email="already@x.io", password=_PLACEHOLDER, display="Ada"
    )
    assert _login(auth_stack, "already@x.io", _PLACEHOLDER) == 200

    created = await service.create_member(
        _owner(), email="already@x.io", profile="default", display="Ada", role="viewer"
    )
    assert created.enrolled_existing is True
    assert created.invitation is None
    assert created.invitation_token is None
    assert created.principal.user_id == str(account["id"])
    assert await _invitation_rows(auth_stack.dsn) == []

    # The password they already log in with is untouched.
    assert _login(auth_stack, "already@x.io", _PLACEHOLDER) == 200


@pytest.mark.asyncio
async def test_self_service_reset_sets_a_new_password_on_a_live_account(
    service: MemberService, auth_stack: _Auth
) -> None:
    """The recovery kind rides the same single-use, hashed-token machinery.

    There is no mail transport in this FG, so a self-service request records a
    recovery invitation and surfaces "reset requested" on the console; the admin
    hands over a freshly regenerated link, shown once, exactly as for a new
    user. That is the flow asserted here.
    """
    created = await service.create_member(
        _owner(), email="reset@x.io", profile="default"
    )
    assert await service.redeem_invitation(
        token=created.invitation_token or "", password=_CHOSEN
    )

    recovery = await service.request_password_reset(email="reset@x.io")
    assert recovery is not None
    _, token = await service.issue_invitation(
        _owner(), user_id=created.principal.user_id, kind="recovery"
    )
    assert await service.redeem_invitation(token=token, password="a-brand-new-one-2")
    assert _login(auth_stack, "reset@x.io", "a-brand-new-one-2") == 200
    assert _login(auth_stack, "reset@x.io", _CHOSEN) == 400


@pytest.mark.asyncio
async def test_a_foreign_profile_is_refused_before_any_account_exists(
    service: MemberService, auth_stack: _Auth
) -> None:
    """The orphan-account failure mode, asserted against the real account table.

    A 409 that had already created the GoTrue account would leave a box-wide
    account nobody is enrolled with — and, because ``auth.users`` is shared,
    it would also make the *correct* profile's later attempt look like a
    duplicate. So the refusal has to come first, and the only way to know it
    did is to ask GoTrue whether the account exists.
    """
    admin = GoTrueAdminClient(
        url=auth_stack.url, service_role_key=auth_stack.service_role_key
    )
    with pytest.raises(MemberProfileMismatchError) as excinfo:
        await service.create_member(
            _owner(), email="elsewhere@x.io", profile="maintenance", role="member"
        )
    assert "FG-28" in str(excinfo.value)
    assert admin.find_user_by_email("elsewhere@x.io") is None
    assert await _invitation_rows(auth_stack.dsn) == []

    # An omitted profile is refused the same way, and equally early.
    with pytest.raises(MemberError):
        await service.create_member(_owner(), email="elsewhere@x.io", profile="")
    assert admin.find_user_by_email("elsewhere@x.io") is None


@pytest.mark.asyncio
async def test_reset_for_an_unknown_email_is_indistinguishable(
    service: MemberService,
) -> None:
    """A reset form must not confirm whether an address has an account."""
    assert await service.request_password_reset(email="nobody@x.io") is None


# --------------------------------------------------------------------------
# FG-28 C2: links carry their profile; redeem/request run in that profile
# --------------------------------------------------------------------------


@dataclass
class _Box:
    root: Path
    hr: Path
    client: object


async def _init_profile_schema(dsn: str) -> None:
    """Create the *current* ``HERMES_HOME`` profile's tables + its owner row."""
    import hermes_cli.datastore as datastore

    datastore._verified_schemas.clear()
    store = get_store(
        "supabase-app", "prod", config={"datastore": {"supabase_app": {"dsn": dsn}}}
    )
    connection = await store.connect()
    try:
        await initialize_access(connection)
        await initialize_invitations(connection)
        await connection.execute(
            "INSERT INTO principals (user_id, display, role) VALUES ($1, 'Leo', "
            "'owner') ON CONFLICT (user_id) DO NOTHING",
            _OWNER,
        )
    finally:
        await connection.close()


@pytest.fixture
def box(
    auth_stack: _Auth, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[_Box]:
    """A real two-profile box (default + ``hr``) on one database and one GoTrue.

    The web server acts as the default profile, exactly the deployment where a
    link minted in ``hr`` used to be refused as invalid.
    """
    import hermes_constants
    from fastapi.testclient import TestClient

    from hermes_cli import web_server
    from hermes_cli.datastore import app_schema

    root = tmp_path / "hermes-root"
    hr = root / "profiles" / "hr"
    hr.mkdir(parents=True)
    config = {"datastore": {"supabase_app": {"dsn": auth_stack.dsn}}}
    for home in (root, hr):
        (home / "config.yaml").write_text(yaml.safe_dump(config))
    monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
    # Box-wide GoTrue (D2): one set of credentials in the process environment.
    monkeypatch.setenv("SUPABASE_URL", auth_stack.url)
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", auth_stack.service_role_key)
    monkeypatch.setattr(web_server, "_REDEEM_THROTTLE", None)

    monkeypatch.setenv("HERMES_HOME", str(root))
    asyncio.run(_reset(auth_stack.dsn))

    async def _drop_hr() -> None:
        raw = await asyncpg.connect(auth_stack.dsn, ssl=False)
        try:
            await raw.execute(
                f'DROP SCHEMA IF EXISTS "{app_schema("prod", profile="hr")}" CASCADE'
            )
        finally:
            await raw.close()

    asyncio.run(_drop_hr())
    monkeypatch.setenv("HERMES_HOME", str(hr))
    asyncio.run(_init_profile_schema(auth_stack.dsn))
    monkeypatch.setenv("HERMES_HOME", str(root))
    yield _Box(root=root, hr=hr, client=TestClient(web_server.app))


async def _create_in(
    home: Path,
    auth: _Auth,
    monkeypatch: pytest.MonkeyPatch,
    email: str,
    profile: str,
):
    """Create a member *as* ``home``'s console would, then act as default again."""
    import hermes_cli.datastore as datastore

    previous = str(home.parents[1]) if profile != "default" else str(home)
    monkeypatch.setenv("HERMES_HOME", str(home))
    datastore._verified_schemas.clear()
    config = {"datastore": {"supabase_app": {"dsn": auth.dsn}}}
    service = MemberService(
        PrincipalStore(get_store("supabase-app", "prod", config=config)),
        GoTrueAdminClient(url=auth.url, service_role_key=auth.service_role_key),
        config=config,
    )
    try:
        return service, await service.create_member(
            _owner(), email=email, profile=profile
        )
    finally:
        monkeypatch.setenv("HERMES_HOME", previous)
        datastore._verified_schemas.clear()


def _redeem(box: _Box, token: str, profile: str | None = None):
    body: dict[str, str] = {"token": token, "password": _CHOSEN}
    if profile is not None:
        body["profile"] = profile
    return box.client.post("/api/auth/invitations/redeem", json=body)


async def _rows_in(dsn: str, profile: str) -> list[dict[str, object]]:
    from hermes_cli.datastore import app_schema

    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        rows = await connection.fetch(
            f'SELECT * FROM "{app_schema("prod", profile=profile)}".invitations '
            "ORDER BY created_at"
        )
        return [dict(row) for row in rows]
    finally:
        await connection.close()


@pytest.mark.asyncio
async def test_an_hr_link_redeems_in_hr(
    box: _Box, auth_stack: _Auth, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, created = await _create_in(box.hr, auth_stack, monkeypatch, "hr@x.io", "hr")
    token = created.invitation_token or ""
    assert created.as_dict()["activation_path"] == f"/activate/hr/{token}"

    response = _redeem(box, token, "hr")
    assert response.status_code == 200, response.text
    assert _login(auth_stack, "hr@x.io", _CHOSEN) == 200


@pytest.mark.asyncio
async def test_a_tampered_profile_is_the_same_neutral_400(
    box: _Box, auth_stack: _Auth, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Renaming the profile in a link — to a real one or not — reveals nothing."""
    _, created = await _create_in(box.hr, auth_stack, monkeypatch, "tamper@x.io", "hr")
    token = created.invitation_token or ""

    refusals = [
        _redeem(box, token),  # the legacy shape: the default profile
        _redeem(box, token, "default"),
        _redeem(box, token, "no-such-profile"),
        _redeem(box, token, "../hr"),
        _redeem(box, "not-a-real-token", "hr"),
    ]
    assert {r.status_code for r in refusals} == {400}
    assert len({r.json()["detail"] for r in refusals}) == 1

    # Nothing was consumed: the genuine link still works.
    assert _redeem(box, token, "hr").status_code == 200


@pytest.mark.asyncio
async def test_a_token_presented_under_another_profile_is_refused(
    box: _Box, auth_stack: _Auth, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A default-profile token renamed into ``hr`` matches no row there."""
    _, created = await _create_in(
        box.root, auth_stack, monkeypatch, "cross@x.io", "default"
    )
    token = created.invitation_token or ""
    assert created.as_dict()["activation_path"] == f"/activate/{token}"

    assert _redeem(box, token, "hr").status_code == 400
    assert _redeem(box, token).status_code == 200


@pytest.mark.asyncio
async def test_a_legacy_v1_link_still_works_in_the_default_profile(
    box: _Box, auth_stack: _Auth, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Links minted before the binding stored the bare hash; they keep working."""
    _, created = await _create_in(
        box.root, auth_stack, monkeypatch, "legacy@x.io", "default"
    )
    token = created.invitation_token or ""
    connection = await asyncpg.connect(auth_stack.dsn, ssl=False)
    try:
        updated = await connection.execute(
            "UPDATE app_prod.invitations SET token_hash = $1 WHERE token_hash = $2",
            hash_token(token),
            hash_token(token, "default"),
        )
    finally:
        await connection.close()
    assert updated == "UPDATE 1"

    assert _redeem(box, token, "hr").status_code == 400
    assert _redeem(box, token).status_code == 200
    assert _login(auth_stack, "legacy@x.io", _CHOSEN) == 200


@pytest.mark.asyncio
async def test_a_reset_request_for_an_hr_only_person_is_minted_in_hr(
    box: _Box, auth_stack: _Auth, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The request used to run in the acting profile and silently do nothing."""
    from hermes_cli.identity_audit import list_identity_events

    _, created = await _create_in(box.hr, auth_stack, monkeypatch, "hronly@x.io", "hr")
    assert _redeem(box, created.invitation_token or "", "hr").status_code == 200

    for hint in (None, "default"):  # a hint they are not enrolled in is ignored
        body = {"email": "hronly@x.io"}
        if hint:
            body["profile"] = hint
        response = box.client.post("/api/auth/invitations/request", json=body)
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    recovery = [r for r in await _rows_in(auth_stack.dsn, "hr") if r["kind"] == "recovery"]
    assert len(recovery) >= 1
    assert all(r["user_id"] == created.principal.user_id for r in recovery)
    assert await _rows_in(auth_stack.dsn, "default") == []

    # Audited where it was minted, so hr's admins see the request.
    import hermes_cli.datastore as datastore

    monkeypatch.setenv("HERMES_HOME", str(box.hr))
    datastore._verified_schemas.clear()
    config = {"datastore": {"supabase_app": {"dsn": auth_stack.dsn}}}
    events = await list_identity_events(
        store=get_store("supabase-app", "prod", config=config),
        principal=_owner(),
        config=config,
    )
    assert "user.reset_requested" in [event["action"] for event in events]

    # An unknown address answers exactly the same.
    response = box.client.post(
        "/api/auth/invitations/request", json={"email": "nobody@x.io", "profile": "hr"}
    )
    assert response.json() == {"ok": True}
