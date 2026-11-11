"""send_message must survive per-platform tool resolution for agent-home only.

``hermes-api-server`` lists ``send_message``, but agent-home sessions get
their toolsets from ``_get_platform_tools(config, "api_server")``, which
used to drop it because no toolset owned the tool.
"""

import pytest

from hermes_cli.tools_config import _get_platform_tools
from toolsets import resolve_toolset


def _tools_for(config, platform):
    tools = set()
    for ts in _get_platform_tools(config, platform, include_default_mcp_servers=False):
        tools.update(resolve_toolset(ts))
    return tools


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


def test_api_server_default_config_enables_send_message(home):
    assert "send_message" in _tools_for({}, "api_server")


def test_api_server_saved_tool_config_keeps_send_message(home):
    config = {"platform_toolsets": {"api_server": ["web", "file", "terminal"]}}
    tools = _tools_for(config, "api_server")
    assert "send_message" in tools
    assert "web_search" in tools


@pytest.mark.parametrize("platform", ["cli", "telegram", "whatsapp", "cron"])
def test_other_platforms_never_get_send_message(home, platform):
    assert "send_message" not in _tools_for({}, platform)
