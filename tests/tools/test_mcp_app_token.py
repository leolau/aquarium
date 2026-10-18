"""F19: Hermes sends app-mcp's bearer token, and terminals never see app-mcp secrets."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

from tools import mcp_tool
from tools.environments.local import _sanitize_subprocess_env

APP = {"url": "http://127.0.0.1:9220/mcp"}


@pytest.fixture
def token_file(tmp_path, monkeypatch):
    path = tmp_path / ".mcp-token"
    monkeypatch.setattr(mcp_tool, "APP_MCP_TOKEN_FILE", path)
    monkeypatch.setattr(mcp_tool._app_mcp_token, "__defaults__", (path,))
    return path


def test_token_created_0600_and_stable(token_file):
    first = mcp_tool._app_mcp_token()
    assert len(first) == 64
    assert stat.S_IMODE(os.stat(token_file).st_mode) == 0o600
    assert mcp_tool._app_mcp_token() == first


def test_existing_app_entry_gets_authorization_header(token_file):
    headers: dict = {}
    mcp_tool._add_app_mcp_token("app", dict(APP), headers)
    assert headers == {"Authorization": f"Bearer {token_file.read_text().strip()}"}


def test_configured_authorization_is_kept(token_file):
    headers = {"authorization": "Bearer mine"}
    mcp_tool._add_app_mcp_token("app", dict(APP), headers)
    assert headers == {"authorization": "Bearer mine"}
    assert not token_file.exists()


@pytest.mark.parametrize(
    "name,config",
    [("github", {"url": "https://api.githubcopilot.com/mcp/"}), ("figma", {"command": "npx"})],
)
def test_other_servers_never_get_the_token(token_file, name, config):
    headers: dict = {}
    mcp_tool._add_app_mcp_token(name, config, headers)
    assert headers == {}
    assert not token_file.exists()


def test_unwritable_location_falls_back_to_no_token(tmp_path, monkeypatch):
    path = tmp_path / "missing-dir" / ".mcp-token"
    monkeypatch.setattr(mcp_tool._app_mcp_token, "__defaults__", (path,))
    headers: dict = {}
    mcp_tool._add_app_mcp_token("app", dict(APP), headers)
    assert headers == {}


def test_hermes_and_app_mcp_use_the_same_file():
    sys.path.insert(0, str(Path(mcp_tool.__file__).resolve().parents[1] / "app-mcp"))
    try:
        from app_mcp.mcp_auth import TOKEN_FILE
    finally:
        sys.path.pop(0)
    assert TOKEN_FILE == mcp_tool.APP_MCP_TOKEN_FILE


@pytest.mark.parametrize(
    "key", ["APP_MCP_HERMES_TOKEN", "APP_MCP_TICKET_SECRET", "AGENT_HOME_APP_MCP_SECRET"]
)
def test_terminal_env_drops_app_mcp_secrets(key):
    env = _sanitize_subprocess_env({key: "s3cret", "PATH": "/usr/bin"})
    assert key not in env
    assert env["PATH"] == "/usr/bin"
