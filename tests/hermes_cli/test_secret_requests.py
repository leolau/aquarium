"""FG-37 secret prompt: the request registry and the signed-in answer route.

Real SQLite registry and real file credential store under a temp HERMES_HOME.
The invariant every test leans on: a secret value lands in the credential
store and nowhere else (not the registry file, not a response body).
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time

import pytest

from hermes_cli import secret_requests as sr
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore

VALUE = "ghp_" + "s3cr3tVALUE" * 3
MIA = Principal(user_id="mia", display="Mia", role="member")
TOM = Principal(user_id="tom", display="Tom", role="member")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    import hermes_constants
    from hermes_cli import credential_store

    monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    store = FileCredentialStore(tmp_path / "credentials")
    monkeypatch.setattr(credential_store, "default_credential_store", lambda *a, **k: store)
    return tmp_path


def _open(**over):
    kw = dict(
        owner_user_id="mia",
        profile="default",
        session_key="home_1",
        run_id="run_1",
        name="github-pat",
        label="GitHub personal access token",
        purpose="Push the fix",
        kind="secret",
        channel="agent-home",
    )
    kw.update(over)
    return sr.open_request(**kw)


def _stored(home, principal=MIA, name="github-pat"):
    store = FileCredentialStore(home / "credentials")
    return asyncio.run(store.get(principal, "secret", name))


def _db_bytes(home) -> bytes:
    return b"".join(p.read_bytes() for p in home.glob("secret_requests.db*"))


def test_open_request_shape_and_schema(home):
    req, token = _open()
    assert req.id.startswith("sr_") and len(req.id) == 19
    assert req.status == sr.PENDING and token is None
    assert req.expires_at == pytest.approx(req.created_at + sr.DEFAULT_TTL_SECONDS)
    cols = {r[1] for r in sqlite3.connect(home / "secret_requests.db").execute("PRAGMA table_info(secret_requests)")}
    assert cols == {
        "id", "token_hash", "owner_user_id", "profile", "session_key", "run_id", "name",
        "label", "purpose", "kind", "username", "channel", "status", "created_at",
        "expires_at", "resolved_at",
    }


@pytest.mark.parametrize("bad", ["", "GitHub PAT", "a/b", "x" * 65, "-lead"])
def test_open_request_rejects_bad_names(home, bad):
    with pytest.raises(sr.SecretRequestError):
        _open(name=bad)


def test_fulfil_stores_credential_once_and_never_in_registry(home):
    req, _ = _open()
    done = sr.fulfil(req.id, principal=MIA, values={"value": VALUE})
    assert done.status == sr.STORED and done.resolved_at
    cred = _stored(home)
    assert cred.kind == "secret" and cred.payload["value"] == VALUE
    assert cred.visibility == "private:mia"
    with pytest.raises(sr.SecretRequestNotPending):
        sr.fulfil(req.id, principal=MIA, values={"value": "other"})
    assert _stored(home).payload["value"] == VALUE
    assert VALUE.encode() not in _db_bytes(home)


def test_owner_mismatch_is_forbidden_and_leaves_request_open(home):
    req, _ = _open()
    with pytest.raises(sr.SecretRequestForbidden):
        sr.fulfil(req.id, principal=TOM, values={"value": VALUE})
    with pytest.raises(sr.SecretRequestForbidden):
        sr.decline(req.id, principal=TOM)
    assert sr.get_request(req.id).status == sr.PENDING


def test_unknown_request_is_not_found(home):
    with pytest.raises(sr.SecretRequestNotFound):
        sr.fulfil("sr_0000000000000000", principal=MIA, values={"value": VALUE})
    with pytest.raises(sr.SecretRequestNotFound):
        sr.decline("sr_0000000000000000")


def test_expired_request_cannot_be_fulfilled(home):
    req, token = _open(ttl_seconds=0.05, with_link=True)
    time.sleep(0.1)
    with pytest.raises(sr.SecretRequestNotPending):
        sr.fulfil(req.id, principal=MIA, values={"value": VALUE})
    assert sr.get_request(req.id).status == sr.EXPIRED
    assert sr.get_by_token(token) is None


def test_payload_is_validated_per_kind(home):
    req, _ = _open()
    with pytest.raises(sr.SecretRequestError):
        sr.fulfil(req.id, principal=MIA, values={})
    with pytest.raises(sr.SecretRequestError):
        sr.fulfil(req.id, principal=MIA, values={"value": VALUE, "bogus": "x"})
    assert sr.get_request(req.id).status == sr.PENDING
    pw, _ = _open(name="vpn", kind="password", username="mia@corp")
    sr.fulfil(pw.id, principal=MIA, values={"password": VALUE})
    cred = _stored(home, name="vpn")
    assert cred.payload == {"username": "mia@corp", "password": VALUE}


def test_link_token_is_hashed_single_use(home):
    req, token = _open(with_link=True, channel="telegram")
    assert token and len(token) >= 40
    raw = sqlite3.connect(home / "secret_requests.db").execute(
        "SELECT token_hash FROM secret_requests WHERE id=?", (req.id,)
    ).fetchone()[0]
    assert raw == sr.hash_token(token) and token.encode() not in _db_bytes(home)
    assert sr.get_by_token(token).id == req.id
    assert sr.get_by_token("nope") is None
    sr.fulfil_by_token(token, values={"value": VALUE})
    assert _stored(home).payload["value"] == VALUE
    assert sr.get_by_token(token) is None
    with pytest.raises(sr.SecretRequestNotFound):
        sr.fulfil_by_token(token, values={"value": VALUE})


def test_decline_by_token_and_by_id(home):
    a, token = _open(with_link=True)
    assert sr.decline(token).status == sr.DECLINED
    b, _ = _open()
    assert sr.decline(b.id, principal=MIA).status == sr.DECLINED
    with pytest.raises(sr.SecretRequestNotPending):
        sr.decline(b.id)
    assert sr.wait(a.id, 1) == sr.DECLINED


def test_racing_answers_have_one_winner(home):
    req, _ = _open()
    results = []
    barrier = threading.Barrier(6)

    def answer(i):
        barrier.wait()
        try:
            if i % 2:
                sr.decline(req.id, principal=MIA)
            else:
                sr.fulfil(req.id, principal=MIA, values={"value": f"{VALUE}-{i}"})
            results.append("ok")
        except sr.SecretRequestNotPending:
            results.append("409")

    threads = [threading.Thread(target=answer, args=(i,)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results.count("ok") == 1 and results.count("409") == 5
    assert sr.get_request(req.id).status in (sr.STORED, sr.DECLINED)


def test_failed_store_reopens_request(home, monkeypatch):
    req, _ = _open()

    def boom(*_a, **_k):
        raise RuntimeError("store down")

    monkeypatch.setattr(sr, "_store_credential", boom)
    with pytest.raises(RuntimeError):
        sr.fulfil(req.id, principal=MIA, values={"value": VALUE})
    assert sr.get_request(req.id).status == sr.PENDING


def test_wait_returns_status_and_expires_on_timeout(home):
    req, _ = _open()
    threading.Timer(0.2, lambda: sr.fulfil(req.id, principal=MIA, values={"value": VALUE})).start()
    assert sr.wait(req.id, 5, poll=0.05) == sr.STORED
    slow, _ = _open(name="slow")
    assert sr.wait(slow.id, 0.1, poll=0.05) == sr.EXPIRED
    assert sr.get_request(slow.id).status == sr.EXPIRED
    stop, _ = _open(name="stop")
    assert sr.wait(stop.id, 30, poll=0.05, should_stop=lambda: True) == sr.EXPIRED


# --- POST /api/secret-requests/{id} -------------------------------------------


@pytest.fixture
def client(home, monkeypatch):
    from fastapi.testclient import TestClient

    from hermes_cli import web_server

    who = {"principal": MIA}

    async def _fake_principal(_request, *, allow_as=False):
        return who["principal"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    c = TestClient(web_server.app)
    c.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    c.who = who
    return c


def _post(client, rid, body):
    return client.post(f"/api/secret-requests/{rid}", json=body)


def test_api_stores_value_without_echoing_it(client, home):
    req, _ = _open()
    r = _post(client, req.id, {"values": {"value": VALUE}})
    assert r.status_code == 200, r.text
    assert r.json() == {"request_id": req.id, "status": "stored", "secret": "github-pat", "kind": "secret"}
    assert VALUE not in r.text
    assert r.headers["cache-control"] == "no-store"
    assert _stored(home).payload["value"] == VALUE
    again = _post(client, req.id, {"values": {"value": VALUE}})
    assert again.status_code == 409 and again.headers["cache-control"] == "no-store"


def test_api_errors(client):
    req, _ = _open()
    assert _post(client, "sr_0000000000000000", {"decline": True}).status_code == 404
    client.who["principal"] = TOM
    r = _post(client, req.id, {"values": {"value": VALUE}})
    assert r.status_code == 403 and VALUE not in r.text
    client.who["principal"] = MIA
    assert _post(client, req.id, {"nothing": 1}).status_code == 400
    bad = _post(client, req.id, {"values": {"value": VALUE, "extra": VALUE}})
    assert bad.status_code == 400 and VALUE not in bad.text
    assert _post(client, req.id, {"decline": True}).json()["status"] == "declined"
    assert _post(client, req.id, {"decline": True}).status_code == 409


def test_api_never_logs_values(client, caplog):
    req, _ = _open()
    caplog.set_level("DEBUG")
    _post(client, req.id, {"values": {"value": VALUE}})
    assert VALUE not in caplog.text


def test_no_body_recording_middleware_covers_the_route():
    from hermes_cli import projects_idempotency
    from hermes_cli.secret_requests_api import PREFIX

    assert not any(PREFIX.startswith(p) for p in projects_idempotency.COVERED_PREFIXES)
