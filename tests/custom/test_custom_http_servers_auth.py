"""F1: the custom email/WhatsApp MCP servers and the Telegram contact-merge
callback must not be open to anyone who can reach the port: loopback bind by
default, bearer token (MCP) / signed expiring links (callback), no wildcard
CORS. Real servers on an ephemeral port, real HTTP requests."""

import importlib.util
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MCP_SERVERS = [
    ("custom/email/email_mcp_server.py", "EMAIL_MCP_TOKEN", "EMAIL_MCP_HOST"),
    ("custom/whatsapp/mcp_server.py", "WHATSAPP_MCP_TOKEN", "WHATSAPP_MCP_HOST"),
]
CALLBACK_HANDLERS = ["custom/shared/telegram_callback_handler.py", "custom/whatsapp/telegram_callback_handler.py"]
CONTACT_MANAGERS = ["custom/shared/contact_manager.py", "custom/whatsapp/contact_manager.py"]


def _load(rel):
    spec = importlib.util.spec_from_file_location("_t_" + rel.replace("/", "_").removesuffix(".py"), REPO_ROOT / rel)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def serve():
    servers = []

    def _serve(handler):
        server = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
        return f"http://127.0.0.1:{server.server_address[1]}"

    yield _serve
    for server in servers:
        server.shutdown()
        server.server_close()


def _request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None,
                                 headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


@pytest.mark.parametrize("rel,token_env,_host_env", MCP_SERVERS)
def test_mcp_server_requires_bearer_token_and_sends_no_wildcard_cors(rel, token_env, _host_env, serve, monkeypatch):
    module = _load(rel)
    tool = next(iter(module.TOOLS))
    calls = []
    monkeypatch.setitem(module.TOOLS, tool, {**module.TOOLS[tool], "fn": lambda p: calls.append(p) or {"ok": 1}})
    monkeypatch.setenv(token_env, "s3cret-token")
    base = serve(module.MCPHandler)
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": {}}}

    for url, body, headers in [
        (f"{base}/call?tool={tool}", None, {}),
        (f"{base}/call", {"tool": tool, "params": {}}, {}),
        (f"{base}/jsonrpc", rpc, {}),
        (f"{base}/tools", None, {}),
        (f"{base}/jsonrpc", rpc, {"Authorization": "Bearer wrong"}),
    ]:
        status, resp_headers, _ = _request(url, body, headers)
        assert status == 401, url
        assert "Access-Control-Allow-Origin" not in resp_headers
    assert calls == []

    auth = {"Authorization": "Bearer s3cret-token"}
    status, resp_headers, body = _request(f"{base}/jsonrpc", rpc, auth)
    assert status == 200 and "result" in json.loads(body)
    assert "Access-Control-Allow-Origin" not in resp_headers
    assert _request(f"{base}/call", {"tool": tool, "params": {}}, auth)[0] == 200
    assert _request(f"{base}/tools", None, auth)[0] == 200
    assert _request(f"{base}/call", {"tool": tool, "params": {}}, {"X-MCP-Token": "s3cret-token"})[0] == 200
    assert len(calls) == 3
    # GET /call is gone even with the token: a link must never run a tool
    assert _request(f"{base}/call?tool={tool}", None, auth)[0] == 405
    assert len(calls) == 3
    # /health stays open for local monitoring (status only, no data)
    assert _request(f"{base}/health")[0] == 200


@pytest.mark.parametrize("rel,token_env,_host_env", MCP_SERVERS)
def test_mcp_server_fails_closed_without_configured_token(rel, token_env, _host_env, serve, monkeypatch):
    module = _load(rel)
    monkeypatch.delenv(token_env, raising=False)
    base = serve(module.MCPHandler)
    assert _request(f"{base}/tools", None, {"Authorization": "Bearer "})[0] == 401


@pytest.mark.parametrize("rel,_token_env,host_env", MCP_SERVERS)
def test_mcp_server_binds_loopback_by_default(rel, _token_env, host_env, monkeypatch):
    module = _load(rel)
    monkeypatch.delenv(host_env, raising=False)
    bound = []

    class FakeServer:
        def __init__(self, addr, handler):
            bound.append(addr)

        def serve_forever(self):
            pass

    monkeypatch.setattr(module, "HTTPServer", FakeServer)
    module.main()
    assert bound == [("127.0.0.1", module.PORT)]


@pytest.mark.parametrize("handler_rel,cm_rel", list(zip(CALLBACK_HANDLERS, CONTACT_MANAGERS)))
def test_callback_links_are_signed_and_unsigned_links_refused(handler_rel, cm_rel, serve, monkeypatch):
    sys.path.insert(0, str(REPO_ROOT / Path(handler_rel).parent))
    handler = _load(handler_rel)
    cm = _load(cm_rel)
    for mod in (handler, cm):
        monkeypatch.setattr(mod, "TELEGRAM_BOT_TOKEN", "123:bot-token")
    monkeypatch.delenv("CALLBACK_SIGNING_SECRET", raising=False)
    merged = []
    monkeypatch.setattr(handler, "handle_merge", lambda sid: merged.append(sid) or (True, "ok"))
    monkeypatch.setattr(handler, "handle_reject", lambda sid: merged.append(("reject", sid)) or (True, "ok"))
    base = serve(handler.CallbackHandler)
    monkeypatch.setattr(cm, "CALLBACK_SERVER_BASE", base)

    # the old unsigned link, a tampered id, a forged sig: all refused, no DB change
    signed = cm.sign_callback_url("merge", "sug-1")
    path_q = urlsplit(signed)
    for url in [f"{base}/action/merge/sug-1", f"{base}/action/merge/sug-2?{path_q.query}",
                f"{base}/action/reject/sug-1?{path_q.query}", f"{base}/action/merge/sug-1?exp=9999999999&sig=00"]:
        assert _request(url)[0] == 403, url
    assert merged == []

    assert _request(signed)[0] == 200
    assert _request(cm.sign_callback_url("reject", "sug-3"))[0] == 200
    assert merged == ["sug-1", ("reject", "sug-3")]

    expired = cm.sign_callback_url("merge", "sug-4", now=0)
    assert _request(expired)[0] == 403
    assert _request(f"{base}/health")[0] == 200


@pytest.mark.parametrize("handler_rel", CALLBACK_HANDLERS)
def test_callback_refuses_everything_without_a_signing_key(handler_rel, serve, monkeypatch):
    sys.path.insert(0, str(REPO_ROOT / Path(handler_rel).parent))
    handler = _load(handler_rel)
    monkeypatch.setattr(handler, "TELEGRAM_BOT_TOKEN", "")
    monkeypatch.delenv("CALLBACK_SIGNING_SECRET", raising=False)
    merged = []
    monkeypatch.setattr(handler, "handle_merge", lambda sid: merged.append(sid) or (True, "ok"))
    base = serve(handler.CallbackHandler)
    # a signature made with an empty key must not be accepted
    import hashlib
    import hmac
    key = hmac.new(b"", b"contact-merge-callback", hashlib.sha256).digest()
    sig = hmac.new(key, b"merge:sug-1:9999999999", hashlib.sha256).hexdigest()
    assert _request(f"{base}/action/merge/sug-1?exp=9999999999&sig={sig}")[0] == 403
    assert merged == []


@pytest.mark.parametrize("cm_rel", CONTACT_MANAGERS)
def test_contact_manager_has_no_hardcoded_callback_host(cm_rel, monkeypatch):
    monkeypatch.delenv("CALLBACK_SERVER_BASE", raising=False)
    cm = _load(cm_rel)
    assert cm.CALLBACK_SERVER_BASE == ""
    assert "8.217.86.90" not in (REPO_ROOT / cm_rel).read_text(encoding="utf-8")


@pytest.mark.parametrize("handler_rel", CALLBACK_HANDLERS)
def test_callback_server_binds_loopback_by_default(handler_rel, monkeypatch):
    handler = _load(handler_rel)
    monkeypatch.setattr(handler, "TELEGRAM_BOT_TOKEN", "t")
    monkeypatch.setattr(handler, "TELEGRAM_USER_ID", "1")
    bound = []

    class FakeServer:
        def __init__(self, addr, h):
            bound.append(addr)

        def serve_forever(self):
            pass

    monkeypatch.setattr(handler, "HTTPServer", FakeServer)
    handler.main()
    assert bound == [("127.0.0.1", handler.PORT)]


@pytest.mark.parametrize("rel,needle", [
    ("custom/email/email_poller.py", "EMAIL_HEALTH_HOST', '127.0.0.1'"),
    ("custom/calendar/calendar_poller.py", "CALENDAR_HEALTH_HOST', '127.0.0.1'"),
    ("custom/whatsapp/batcher.py", "WA_BATCHER_HEALTH_HOST', '127.0.0.1'"),
    ("custom/whatsapp/batcher.mjs", "WA_BATCHER_HEALTH_HOST || '127.0.0.1'"),
])
def test_health_servers_default_to_loopback(rel, needle):
    src = (REPO_ROOT / rel).read_text(encoding="utf-8")
    assert "'0.0.0.0'" not in src
    assert needle in src


@pytest.mark.parametrize("rel,token_env,_host_env", MCP_SERVERS)
def test_hermes_mcp_client_still_connects_with_token_header(rel, token_env, _host_env, serve, monkeypatch, tmp_path):
    """The legit client (Hermes' own MCP client, config.yaml ``headers`` with
    ``${TOKEN}`` interpolation) still lists the tools through the new gate."""
    import asyncio

    from tools import mcp_tool

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv(token_env, "s3cret-token")
    module = _load(rel)
    base = serve(module.MCPHandler)
    cfg = mcp_tool._interpolate_env_vars({
        "url": f"{base}/jsonrpc",
        "headers": {"Authorization": "Bearer ${%s}" % token_env},
        "connect_timeout": 8,
    })

    async def _connect():
        server = await asyncio.wait_for(mcp_tool._connect_server("custom", cfg), 20)
        try:
            return {t.name for t in server._tools}
        finally:
            await server.shutdown()

    assert asyncio.run(_connect()) == set(module.TOOLS)
