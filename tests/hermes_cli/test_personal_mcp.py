"""Per-person MCP servers (Get ready item 8): storage, checks and routes.

Real FastAPI app + real file credential store under a temp HERMES_HOME; only
the login (who is calling) and DNS answers are faked.
"""

from __future__ import annotations

import pytest

from hermes_cli import personal_mcp
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore

OWNER = Principal(user_id="root", display="Owner", role="owner")
ADMIN = Principal(user_id="ann", display="Ann", role="admin")
AMY = Principal(user_id="amy", display="Amy", role="member")
BEN = Principal(user_id="ben", display="Ben", role="member")
VIEWER = Principal(user_id="tom", display="Tom", role="viewer")

_PUBLIC = {"mcp.example.com": ["93.184.215.14"], "notion.example.com": ["93.184.215.15"]}
_INTERNAL = {
    "localhost": ["127.0.0.1"],
    "internal.example.com": ["10.0.0.5"],
    "metadata.example.com": ["169.254.169.254"],
    "mixed.example.com": ["93.184.215.14", "192.168.1.2"],
}


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    def _resolve(host):
        if host in _PUBLIC:
            return _PUBLIC[host]
        if host in _INTERNAL:
            return _INTERNAL[host]
        try:
            import ipaddress

            return [str(ipaddress.ip_address(host))]
        except ValueError:
            raise OSError("no such host")

    monkeypatch.setattr(personal_mcp, "_resolve", _resolve)


@pytest.fixture
def store(tmp_path, monkeypatch):
    s = FileCredentialStore(tmp_path / "credentials")
    monkeypatch.setattr(personal_mcp, "_store", lambda: s)
    import hermes_cli.credentials_api as credentials_api

    monkeypatch.setattr(credentials_api, "_store", lambda: s)
    return s


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": AMY}

    async def _principal(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _principal)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["as"].user_id)
    return state


@pytest.fixture
def client(acting, store):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


# -- checks -------------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:9220/mcp",
        "http://127.0.0.1:8651/mcp",
        "https://internal.example.com/mcp",
        "http://metadata.example.com/latest",
        "https://mixed.example.com/mcp",
        "http://[::1]/mcp",
        "file:///etc/passwd",
        "https://${OPENROUTER_API_KEY}.example.com/mcp",
        "https://user:pw@mcp.example.com/mcp",
        "https://nowhere.invalid/mcp",
        "",
    ],
)
def test_url_refused(url):
    with pytest.raises(personal_mcp.PersonalMcpError):
        personal_mcp.check_url(url)


def test_public_url_accepted():
    assert personal_mcp.check_url(" https://mcp.example.com/mcp ") == "https://mcp.example.com/mcp"


@pytest.mark.parametrize(
    "headers",
    [
        {"Authorization": "Bearer ${OPENROUTER_API_KEY}"},
        {"X-Key": "a\r\nInjected: 1"},
        {"bad name": "x"},
        "not-a-dict",
    ],
)
def test_headers_refused(headers):
    with pytest.raises(personal_mcp.PersonalMcpError):
        personal_mcp.check_headers(headers)


def test_payload_has_no_stdio():
    with pytest.raises(personal_mcp.PersonalMcpError):
        personal_mcp.check_payload({"url": "https://mcp.example.com/mcp", "command": "bash"})


# -- routes -------------------------------------------------------------------


def _add(client, name="notion", url="https://notion.example.com/mcp", **extra):
    return client.post("/api/mcp/personal", json={"name": name, "url": url, **extra})


def test_add_list_remove_own_server(client, acting, store, tmp_path):
    res = _add(client, headers={"Authorization": "Bearer amy-secret"})
    assert res.status_code == 200, res.text
    assert res.json()["header_names"] == ["Authorization"]
    assert "amy-secret" not in res.text

    listed = client.get("/api/mcp/personal").json()
    assert [s["name"] for s in listed["servers"]] == ["notion"]
    assert "amy-secret" not in str(listed)

    # Stored as Amy's private credential, secret included, file mode 0600.
    path = tmp_path / "credentials" / "amy" / "mcp" / "notion.json"
    assert path.exists() and (path.stat().st_mode & 0o777) == 0o600
    assert '"private:amy"' in path.read_text()

    assert _add(client).status_code == 409
    assert client.delete("/api/mcp/personal/notion").status_code == 200
    assert client.get("/api/mcp/personal").json()["servers"] == []


def test_others_cannot_see_or_touch_my_servers(client, acting):
    assert _add(client, headers={"X-Api-Key": "amy-key"}).status_code == 200
    for who in (BEN, VIEWER, ADMIN, OWNER):
        acting["as"] = who
        assert client.get("/api/mcp/personal").json()["servers"] == [], who.role
        assert client.delete("/api/mcp/personal/notion").status_code == 404, who.role
        assert client.post("/api/mcp/personal/notion/test").status_code == 404, who.role
        assert client.post("/api/mcp/personal/notion/oauth/start").status_code == 404, who.role
    acting["as"] = AMY
    assert [s["name"] for s in client.get("/api/mcp/personal").json()["servers"]] == ["notion"]


def test_same_name_for_two_people_is_two_servers(client, acting):
    assert _add(client).status_code == 200
    acting["as"] = BEN
    assert _add(client, url="https://mcp.example.com/mcp").status_code == 200
    assert client.get("/api/mcp/personal").json()["servers"][0]["url"] == "https://mcp.example.com/mcp"
    from tools.personal_mcp import internal_name

    assert internal_name("amy", "notion") != internal_name("ben", "notion")


@pytest.mark.parametrize(
    "body",
    [
        {"name": "x", "url": "http://127.0.0.1:9220/mcp"},
        {"name": "x", "url": "https://internal.example.com/mcp"},
        {"name": "x", "command": "bash", "url": "https://mcp.example.com/mcp"},
        {"name": "Bad Name", "url": "https://mcp.example.com/mcp"},
        {"name": "x", "url": "https://mcp.example.com/mcp", "headers": {"A": "${SECRET}"}},
    ],
)
def test_add_refuses_unsafe_servers(client, body):
    res = client.post("/api/mcp/personal", json=body)
    assert res.status_code == 400, res.text


def test_generic_credentials_route_applies_the_same_rules(client):
    res = client.put(
        "/api/credentials/mcp/sneaky",
        json={"kind": "mcp-server", "payload": {"url": "http://127.0.0.1:9220/mcp"}},
    )
    assert res.status_code == 400
    assert "private network" in res.text


def test_server_limit(client, monkeypatch):
    monkeypatch.setattr(personal_mcp, "MAX_SERVERS", 2)
    assert _add(client, name="a").status_code == 200
    assert _add(client, name="b").status_code == 200
    assert _add(client, name="c").status_code == 400


def test_people_status_is_admin_only_and_counts_only(client, acting):
    assert _add(client, headers={"X-Api-Key": "amy-key"}).status_code == 200
    acting["as"] = BEN
    assert client.get("/api/mcp/personal/people").status_code == 403
    acting["as"] = VIEWER
    assert client.get("/api/mcp/personal/people").status_code == 403
    for who in (ADMIN, OWNER):
        acting["as"] = who
        res = client.get("/api/mcp/personal/people")
        assert res.status_code == 200
        assert res.json() == {"people": [{"user_id": "amy", "servers": 1}]}
        assert "notion" not in res.text and "amy-key" not in res.text


def test_test_route_needs_sign_in_for_oauth_servers(client):
    assert _add(client, auth="oauth").status_code == 200
    body = client.post("/api/mcp/personal/notion/test").json()
    assert body["ok"] is False and body.get("needs_sign_in") is True


def test_test_route_probes_under_the_per_person_name(client, monkeypatch):
    import hermes_cli.mcp_config as mcp_config

    seen = {}

    def _probe(name, cfg, connect_timeout=30):
        seen["name"], seen["cfg"] = name, cfg
        return [("search", "Search pages")]

    monkeypatch.setattr(mcp_config, "_probe_single_server", _probe)
    assert _add(client, headers={"Authorization": "Bearer k"}).status_code == 200
    body = client.post("/api/mcp/personal/notion/test").json()
    assert body == {"ok": True, "tools": [{"name": "search", "description": "Search pages"}]}
    from tools.personal_mcp import internal_name

    assert seen["name"] == internal_name("amy", "notion")
    assert seen["cfg"] == {"url": "https://notion.example.com/mcp", "headers": {"Authorization": "Bearer k"}}


def test_install_wide_list_is_unchanged(client, acting, monkeypatch):
    """config.yaml mcp_servers keep showing (and loading) as before."""
    import hermes_cli.mcp_config as mcp_config

    monkeypatch.setattr(mcp_config, "_get_mcp_servers", lambda: {"app": {"url": "http://127.0.0.1:9220/mcp"}})
    assert _add(client).status_code == 200
    names = [s["name"] for s in client.get("/api/mcp/servers").json()["servers"]]
    assert names == ["app"]


def test_catalog_lists_internet_http_entries(client):
    entries = client.get("/api/mcp/personal/catalog").json()["entries"]
    assert entries, "the repo catalog ships remote HTTP servers"
    assert all(e["url"].startswith("https://") for e in entries)


def test_load_runtime_configs_reads_only_that_person(store):
    import asyncio

    asyncio.run(
        store.put(AMY, provider="mcp", name="notion", kind="mcp-server",
                  payload={"url": "https://notion.example.com/mcp", "headers": {"X": "1"}},
                  visibility=AMY.private_visibility)
    )
    asyncio.run(
        store.put(BEN, provider="mcp", name="other", kind="mcp-server",
                  payload={"url": "https://mcp.example.com/mcp"},
                  visibility=BEN.private_visibility)
    )
    assert personal_mcp.load_runtime_configs("amy") == {
        "notion": {"url": "https://notion.example.com/mcp", "headers": {"X": "1"}}
    }
    assert set(personal_mcp.load_runtime_configs("ben")) == {"other"}
    assert personal_mcp.load_runtime_configs("nobody") == {}


def test_reader_principal_is_not_owner():
    reader = personal_mcp._reader("amy")
    assert not reader.is_owner and reader.private_visibility == "private:amy"
