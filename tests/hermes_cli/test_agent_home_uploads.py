"""Settings → Uploads: the agent-home upload size limit.

Real ``hermes_cli.agent_home_uploads`` and real config.yaml under a throwaway
``HERMES_HOME``; only the C1 principal resolver is stubbed. Default 1 GB,
only owner/admin may change it, and agent-home's per-upload storage probe
carries the value.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="vic", display="Vic", role="viewer", is_owner=False)
GB = 1024**3


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server, "_comms_session_subject", lambda request: state["as"].user_id
    )
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _saved():
    from hermes_cli.config import load_config

    return ((load_config().get("agent_home") or {}).get("uploads") or {}).get("max_bytes")


def test_default_is_one_gigabyte_for_every_reader(client, acting):
    for who in (OWNER, ADMIN, MEMBER, VIEWER):
        acting["as"] = who
        body = client.get("/api/agent-home/uploads").json()
        assert body["max_bytes"] == GB == body["default_max_bytes"]


@pytest.mark.parametrize("who", [OWNER, ADMIN], ids=["owner", "admin"])
def test_owner_and_admin_set_the_limit(client, acting, who):
    acting["as"] = who
    resp = client.put("/api/agent-home/uploads", json={"max_bytes": 5 * GB})
    assert resp.status_code == 200, resp.text
    assert resp.json()["max_bytes"] == 5 * GB
    assert _saved() == 5 * GB
    acting["as"] = MEMBER
    assert client.get("/api/agent-home/uploads").json()["max_bytes"] == 5 * GB


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
def test_member_and_viewer_get_403(client, acting, who):
    acting["as"] = who
    resp = client.put("/api/agent-home/uploads", json={"max_bytes": 5 * GB})
    assert resp.status_code == 403
    assert _saved() is None


@pytest.mark.parametrize("value", [0, 1024, 2 * 1024**4, -1])
def test_out_of_range_values_are_rejected(client, acting, value):
    resp = client.put("/api/agent-home/uploads", json={"max_bytes": value})
    assert resp.status_code == 400
    assert _saved() is None


def test_hand_edited_garbage_falls_back_to_the_default(client, acting):
    from hermes_cli.config import load_config, save_config

    config = load_config()
    config["agent_home"] = {"uploads": {"max_bytes": "lots"}}
    save_config(config)
    assert client.get("/api/agent-home/uploads").json()["max_bytes"] == GB


def test_upload_storage_probe_carries_the_limit(client, acting):
    assert client.get("/api/capacity/upload-storage").json()["max_bytes"] == GB
    client.put("/api/agent-home/uploads", json={"max_bytes": 3 * GB})
    assert client.get("/api/capacity/upload-storage").json()["max_bytes"] == 3 * GB
