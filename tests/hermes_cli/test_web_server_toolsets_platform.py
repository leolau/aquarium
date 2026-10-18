"""Toolset switches must control the platform Aquarium chats are built with.

Agent-home's Settings → Tools & Integrations toggles reach
``PUT /api/tools/toolsets/{name}``. Aquarium chats build their agent with
``platform="api_server"`` (``gateway.session_chat.build_session_agent``), so a
toggle sent with ``platform=api_server`` must land in
``platform_toolsets.api_server`` and change what the next chat agent gets,
while the default (no platform) keeps writing ``platform_toolsets.cli``.
"""
import pytest
import yaml


@pytest.fixture
def client(monkeypatch, _isolate_hermes_home):
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")

    import hermes_state
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    (get_hermes_home() / "config.yaml").write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", get_hermes_home() / "state.db")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _cfg():
    from hermes_constants import get_hermes_home

    return yaml.safe_load((get_hermes_home() / "config.yaml").read_text()) or {}


def _listing(client, **params):
    resp = client.get("/api/tools/toolsets", params=params)
    assert resp.status_code == 200
    return {t["name"]: t for t in resp.json()}


def test_toggle_with_platform_writes_that_platform_only(client):
    assert _listing(client, platform="api_server")["terminal"]["enabled"] is True

    resp = client.put(
        "/api/tools/toolsets/terminal",
        json={"enabled": False, "platform": "api_server"},
    )
    assert resp.status_code == 200
    assert resp.json() == {
        "ok": True, "name": "terminal", "platform": "api_server", "enabled": False,
    }

    saved = _cfg().get("platform_toolsets", {})
    assert "terminal" not in saved["api_server"]
    assert "cli" not in saved
    assert _listing(client, platform="api_server")["terminal"]["enabled"] is False
    # The default (cli) view is untouched.
    assert _listing(client)["terminal"]["enabled"] is True


def test_platform_query_param_is_accepted_on_put(client):
    resp = client.put(
        "/api/tools/toolsets/terminal",
        params={"platform": "api_server"},
        json={"enabled": False},
    )
    assert resp.status_code == 200
    assert "terminal" not in _cfg()["platform_toolsets"]["api_server"]


def test_default_platform_stays_cli(client):
    resp = client.put("/api/tools/toolsets/terminal", json={"enabled": False})
    assert resp.status_code == 200
    assert resp.json()["platform"] == "cli"
    saved = _cfg()["platform_toolsets"]
    assert "terminal" not in saved["cli"]
    assert "api_server" not in saved


def test_unknown_platform_is_rejected(client):
    assert client.get("/api/tools/toolsets", params={"platform": "nope"}).status_code == 400
    resp = client.put(
        "/api/tools/toolsets/terminal", json={"enabled": False, "platform": "nope"}
    )
    assert resp.status_code == 400
    assert "platform_toolsets" not in _cfg()


def test_platform_restricted_toolset_is_hidden_and_rejected(client):
    from hermes_cli.tools_config import _toolset_allowed_for_platform

    assert not _toolset_allowed_for_platform("discord", "api_server")
    assert "discord" not in _listing(client, platform="api_server")
    resp = client.put(
        "/api/tools/toolsets/discord", json={"enabled": True, "platform": "api_server"}
    )
    assert resp.status_code == 400
    assert "platform_toolsets" not in _cfg()


def test_build_session_agent_resolution_follows_the_toggle(client, monkeypatch):
    """The toolsets the next Aquarium chat agent is built with reflect the switch."""
    import gateway.run as grun
    import run_agent
    from gateway.session_chat import build_session_agent

    captured: dict = {}

    class _FakeAgent:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(grun, "_resolve_runtime_agent_kwargs", lambda: {})
    monkeypatch.setattr(grun, "_resolve_gateway_model", lambda: "m")
    monkeypatch.setattr(grun, "_current_max_iterations", lambda: 3)
    monkeypatch.setattr(grun.GatewayRunner, "_load_reasoning_config", staticmethod(lambda: None))
    monkeypatch.setattr(grun.GatewayRunner, "_load_fallback_model", staticmethod(lambda: None))
    monkeypatch.setattr(grun, "_load_gateway_config", _cfg)
    monkeypatch.setattr(run_agent, "AIAgent", _FakeAgent)

    build_session_agent(session_db=None)
    assert captured["platform"] == "api_server"
    assert "terminal" in captured["enabled_toolsets"]

    for enabled in (False, True):
        resp = client.put(
            "/api/tools/toolsets/terminal",
            json={"enabled": enabled, "platform": "api_server"},
        )
        assert resp.status_code == 200
        captured.clear()
        build_session_agent(session_db=None)
        assert ("terminal" in captured["enabled_toolsets"]) is enabled


def test_disabled_mcp_server_is_left_out_of_chat_toolsets():
    """``mcp_servers.<name>.enabled: false`` drops the server from the toolsets
    ``build_session_agent`` resolves for Aquarium chats."""
    from hermes_cli.tools_config import _get_platform_tools

    cfg = {
        "mcp_servers": {
            "canva": {"url": "https://mcp.canva.com/mcp"},
            "figma": {"command": "npx", "enabled": False},
        }
    }
    resolved = _get_platform_tools(cfg, "api_server")
    assert "canva" in resolved
    assert "figma" not in resolved


def test_chat_default_keeps_terminal_once_all_tools_are_registered():
    """With no ``platform_toolsets.api_server`` saved, the default Aquarium chat
    set must keep the terminal group after every tool module has registered.
    ``read_terminal``/``close_terminal`` register under the ``terminal``
    toolset; ``hermes-api-server`` must list them or the subset inference in
    ``_get_platform_tools`` silently drops the whole group."""
    import model_tools  # noqa: F401  — registers every built-in tool
    from hermes_cli.tools_config import _get_platform_tools
    from toolsets import resolve_toolset

    assert set(resolve_toolset("terminal")) <= set(resolve_toolset("hermes-api-server"))
    assert "terminal" in _get_platform_tools({}, "api_server")
