"""Sessions with no resolved person are limited unless they are trusted local.

The local CLI/TUI/cron/ACP run unlimited with no person; a gateway session with
a principal store configured gets ``access.unresolved_role`` (default viewer)
and a per-session folder.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    hermes_home = tmp_path / "home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


def _call(name, args, *, trusted_local, session_id="sess-a"):
    import model_tools

    model_tools.discover_builtin_tools()
    out = model_tools.handle_function_call(
        name, args, task_id="t-unresolved", session_id=session_id,
        principal_user_id=None, principal_role="member",
        principal_trusted_local=trusted_local,
        skip_pre_tool_call_hook=True, skip_tool_request_middleware=True,
    )
    return json.loads(out) if out.strip().startswith("{") else {"raw": out}


def test_untrusted_unresolved_gets_viewer_limits(home):
    from tools.access_policy import denied_tools

    for role in (None, "member", "owner"):
        denied = denied_tools(None, role)
        assert {"terminal", "execute_code", "process", "cronjob", "skill_manage"} <= denied
        assert {"write_file", "patch"} <= denied
    assert denied_tools(None, "member", trusted_local=True) == frozenset()
    assert denied_tools(None, None, trusted_local=True) == frozenset()


def test_unresolved_role_is_configurable(home, monkeypatch):
    import hermes_cli.config as cfg
    from tools.access_policy import denied_tools

    monkeypatch.setattr(cfg, "load_config_readonly", lambda: {"access": {"unresolved_role": "member"}})
    denied = denied_tools(None, None)
    assert "terminal" in denied and "write_file" not in denied
    monkeypatch.setattr(cfg, "load_config_readonly", lambda: {"access": {"unresolved_role": "owner"}})
    assert "write_file" in denied_tools(None, None)


def test_untrusted_unresolved_files_are_confined_per_session(home):
    from tools.access_policy import acting_as, current_files_root, files_root

    assert files_root(None, None, trusted_local=True) is None
    a = files_root(None, "member", session_key="sess-a")
    b = files_root(None, "member", session_key="sess-b")
    assert a is not None and b is not None and a != b
    assert a.is_relative_to((home / "workspaces" / "_unresolved").resolve())
    with acting_as(None, "member", session_key="sess-a"):
        assert current_files_root() == a
    with acting_as(None, None, trusted_local=True):
        assert current_files_root() is None
    assert current_files_root() is None


@pytest.mark.parametrize("tool,args", [
    ("terminal", {"command": "id"}),
    ("execute_code", {"code": "print(1)"}),
])
def test_dispatcher_refuses_command_tools_when_untrusted(home, tool, args):
    res = _call(tool, args, trusted_local=False)
    assert "not available to your role" in res.get("error", "")


def test_dispatcher_confines_read_file_when_untrusted(home, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("owner secret\n")
    res = _call("read_file", {"path": str(secret)}, trusted_local=False)
    assert "owner secret" not in json.dumps(res)
    trusted = _call("read_file", {"path": str(secret)}, trusted_local=True)
    assert "owner secret" in json.dumps(trusted)


def _tool_defs(*names):
    return [
        {"type": "function", "function": {
            "name": n, "description": n, "parameters": {"type": "object", "properties": {}},
        }}
        for n in names
    ]


def _agent(**kwargs):
    from run_agent import AIAgent

    with (
        patch("run_agent.get_tool_definitions",
              return_value=_tool_defs("terminal", "execute_code", "read_file", "session_search")),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        return AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            **kwargs,
        )


def test_gateway_agent_without_principal_loses_command_tools(home):
    agent = _agent(internal_user_id=None, trusted_local=False)
    names = {t["function"]["name"] for t in agent.tools}
    assert "terminal" not in names and "execute_code" not in names
    assert "read_file" in names


def test_local_agent_without_principal_is_unchanged(home):
    agent = _agent(trusted_local=True)
    names = {t["function"]["name"] for t in agent.tools}
    assert {"terminal", "execute_code", "read_file"} <= names


def test_default_agent_without_principal_is_untrusted(home):
    import inspect

    from agent.agent_init import init_agent
    from tools.access_policy import files_root

    assert inspect.signature(init_agent).parameters["trusted_local"].default is False
    agent = _agent()
    assert agent._trusted_local is False
    names = {t["function"]["name"] for t in agent.tools}
    assert "terminal" not in names and "execute_code" not in names
    root = files_root(agent._internal_user_id, agent._internal_user_role,
                      trusted_local=agent._trusted_local, session_key="s")
    assert root is not None and "_unresolved" in root.parts



def test_sandbox_tool_calls_keep_the_bound_principal():
    from tools.code_execution_tool import _bound_principal_kwargs

    from tools.access_policy import acting_as

    with acting_as("vic", "viewer", trusted_local=False):
        assert _bound_principal_kwargs() == {
            "principal_user_id": "vic",
            "principal_role": "viewer",
            "principal_trusted_local": False,
        }
    with acting_as(None, None, trusted_local=True):
        assert _bound_principal_kwargs()["principal_trusted_local"] is True
