"""Per-person language preference: store + ``/api/me/preferences`` routes.

Real path: a throwaway ``HERMES_HOME`` and the real FastAPI app; only the
principal resolver is replaced (as in test_route_authorization).
"""

from __future__ import annotations

import stat
from types import SimpleNamespace

import pytest

AMY = SimpleNamespace(user_id="amy", display="Amy", role="member", is_owner=False)
BEN = SimpleNamespace(user_id="ben", display="Ben", role="admin", is_owner=False)


@pytest.fixture(autouse=True)
def _home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def test_store_roundtrip_and_file_mode(_home):
    from hermes_cli import user_prefs

    assert user_prefs.get_language("amy") is None
    user_prefs.set_language("amy", "zh-Hant")
    assert user_prefs.get_language("amy") == "zh-Hant"
    assert user_prefs.get_language("ben") is None
    files = list((_home / "auth" / "user_prefs").glob("*.json"))
    assert len(files) == 1
    assert stat.S_IMODE(files[0].stat().st_mode) == 0o600
    assert stat.S_IMODE(files[0].parent.stat().st_mode) == 0o700
    assert "amy" not in files[0].name


def test_store_rejects_unknown_language_and_path_like_ids(_home):
    from hermes_cli import user_prefs

    with pytest.raises(ValueError):
        user_prefs.set_language("amy", "fr")
    user_prefs.set_language("../../etc/passwd", "en")
    assert all(p.parent == _home / "auth" / "user_prefs"
               for p in (_home / "auth" / "user_prefs").iterdir())


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": AMY}

    async def _fake(request, *, allow_as=False):
        assert allow_as is False
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake)
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_routes_need_sign_in():
    from starlette.testclient import TestClient

    from hermes_cli.web_server import app

    c = TestClient(app, raise_server_exceptions=False)
    assert c.get("/api/me/preferences").status_code == 401
    assert c.put("/api/me/preferences", json={"language": "en"}).status_code == 401


def test_each_person_reads_and_writes_only_their_own(client, acting):
    assert client.get("/api/me/preferences").json() == {"language": None}
    r = client.put("/api/me/preferences", json={"language": "zh-Hant"})
    assert r.status_code == 200 and r.json() == {"language": "zh-Hant"}
    assert client.get("/api/me/preferences").json() == {"language": "zh-Hant"}

    acting["as"] = BEN
    assert client.get("/api/me/preferences").json() == {"language": None}
    # A user id in the request is ignored: the write lands on the actor.
    client.put("/api/me/preferences?as=amy", json={"language": "en", "user_id": "amy"})
    acting["as"] = AMY
    assert client.get("/api/me/preferences").json() == {"language": "zh-Hant"}


def test_unsupported_language_is_400(client):
    assert client.put("/api/me/preferences", json={"language": "fr"}).status_code == 400
    assert client.put("/api/me/preferences", json={}).status_code == 422


def test_without_user_directory_is_503(client, monkeypatch):
    from hermes_cli import web_server

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no store")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    assert client.get("/api/me/preferences").status_code == 503
