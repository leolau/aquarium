"""F19: the loopback /mcp endpoint needs the bearer token from app-mcp/.mcp-token."""
from __future__ import annotations

import httpx
import pytest

from app_mcp import mcp_auth
from app_mcp.mcp_auth import BearerTokenMiddleware

TOKEN = "t" * 64


async def _ok_app(scope, receive, send):
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"ok"})


async def _post(app, headers=None):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:9220") as c:
        return await c.post("/mcp", headers=headers or {}, json={})


@pytest.fixture
def token_file(tmp_path):
    path = tmp_path / ".mcp-token"
    path.write_text(TOKEN + "\n", encoding="utf-8")
    return path


@pytest.mark.anyio
async def test_missing_token_is_refused(token_file):
    resp = await _post(BearerTokenMiddleware(_ok_app, token_file))
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"].startswith("Bearer")


@pytest.mark.anyio
async def test_wrong_token_is_refused(token_file):
    resp = await _post(
        BearerTokenMiddleware(_ok_app, token_file), {"Authorization": "Bearer " + "x" * 64}
    )
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_other_scheme_is_refused(token_file):
    resp = await _post(BearerTokenMiddleware(_ok_app, token_file), {"Authorization": TOKEN})
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_right_token_is_accepted(token_file):
    resp = await _post(
        BearerTokenMiddleware(_ok_app, token_file), {"Authorization": f"Bearer {TOKEN}"}
    )
    assert resp.status_code == 200 and resp.text == "ok"


@pytest.mark.anyio
async def test_no_token_file_keeps_endpoint_open(tmp_path):
    resp = await _post(BearerTokenMiddleware(_ok_app, tmp_path / "absent"))
    assert resp.status_code == 200


@pytest.mark.anyio
async def test_token_file_created_later_is_enforced_without_restart(tmp_path):
    path = tmp_path / ".mcp-token"
    app = BearerTokenMiddleware(_ok_app, path)
    assert (await _post(app)).status_code == 200
    path.write_text(TOKEN, encoding="utf-8")
    assert (await _post(app)).status_code == 401
    assert (await _post(app, {"Authorization": f"Bearer {TOKEN}"})).status_code == 200


def test_real_mcp_app_requires_token(token_file):
    """The app the service actually runs (server.mcp_http_app) is behind the check."""
    from starlette.testclient import TestClient

    from app_mcp import server

    init = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"},
        },
    }
    accept = {"Accept": "application/json, text/event-stream"}
    with TestClient(server.mcp_http_app(token_file), base_url="http://127.0.0.1:9220") as c:
        assert c.post("/mcp", json=init, headers=accept).status_code == 401
        bad = c.post("/mcp", json=init, headers={**accept, "Authorization": "Bearer nope"})
        assert bad.status_code == 401
        good = c.post("/mcp", json=init, headers={**accept, "Authorization": f"Bearer {TOKEN}"})
        assert good.status_code == 200, good.text
        assert "serverInfo" in good.text


def test_default_token_file_is_next_to_the_package():
    assert mcp_auth.TOKEN_FILE.name == ".mcp-token"
    assert mcp_auth.TOKEN_FILE.parent.name == "app-mcp"
