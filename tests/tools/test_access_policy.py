"""Per-role tool and file limits, exercised through the real dispatcher.

Temp ``HERMES_HOME``; Mia is a member, Vic a viewer, Ann an admin. Members and
viewers can't reach the terminal/code tools and their file tools are confined
to ``$HERMES_HOME/workspaces/<user_id>``; owner, admin and identity-less
sessions (CLI, cron) are unaffected.
"""

from __future__ import annotations

import json
import os

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    hermes_home = tmp_path / "home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    secret = tmp_path / "secret.txt"
    secret.write_text("owner secret\n")
    return hermes_home, secret


def _call(name, args, user=None, role=None, task_id="t-access"):
    import model_tools

    model_tools.discover_builtin_tools()
    out = model_tools.handle_function_call(
        name, args, task_id=task_id, principal_user_id=user, principal_role=role,
        skip_pre_tool_call_hook=True, skip_tool_request_middleware=True,
    )
    return json.loads(out) if out.strip().startswith("{") else {"raw": out}


def test_default_role_limits(home):
    from tools.access_policy import denied_tools

    member = denied_tools("mia", "member")
    assert {"terminal", "execute_code", "cronjob", "skill_manage"} <= member
    assert "browser_navigate" not in member and "read_file" not in member
    assert {"write_file", "patch"} <= denied_tools("vic", "viewer")
    assert denied_tools("ann", "admin") == frozenset()
    assert denied_tools("root", "owner") == frozenset()
    assert denied_tools(None, None, trusted_local=True) == frozenset()
    # An enrolled-but-unresolved role degrades to member limits.
    assert "terminal" in denied_tools("x", None)


def test_config_override_replaces_defaults(home, monkeypatch):
    import hermes_cli.config as cfg
    from tools.access_policy import denied_tools

    monkeypatch.setattr(
        cfg, "load_config_readonly",
        lambda: {"access": {"roles": {"member": {"deny_tools": ["code_execution"]}, "admin": {"deny_tools": ["terminal"]}}}},
    )
    assert denied_tools("mia", "member") == frozenset({"execute_code"})
    assert "terminal" in denied_tools("ann", "admin")


@pytest.mark.parametrize("tool,args", [
    ("terminal", {"command": "cat /etc/passwd"}),
    ("execute_code", {"code": "print(1)"}),
    ("cronjob", {"action": "list"}),
])
def test_member_is_refused_command_tools(home, tool, args):
    res = _call(tool, args, "mia", "member")
    assert "not available to your role" in res.get("error", "")


def test_tool_call_bridge_cannot_reach_denied_tool(home):
    res = _call("tool_call", {"name": "terminal", "arguments": {"command": "id"}}, "mia", "member")
    assert res.get("error")
    assert res.get("output") is None


def test_member_files_stay_in_own_folder(home, tmp_path):
    hermes_home, secret = home
    own = hermes_home / "workspaces" / "mia"

    res = _call("write_file", {"path": "notes.txt", "content": "hi\n"}, "mia", "member")
    assert "error" not in res, res
    assert (own / "notes.txt").read_text() == "hi\n"
    assert "hi" in json.dumps(_call("read_file", {"path": "notes.txt"}, "mia", "member"))

    for path in (str(secret), "../../secret.txt", str(hermes_home / "state.db"), "/etc/passwd"):
        res = _call("read_file", {"path": path}, "mia", "member")
        assert "own folder" in res.get("error", ""), (path, res)
        res = _call("write_file", {"path": path, "content": "x"}, "mia", "member")
        assert "own folder" in res.get("error", ""), (path, res)
    assert secret.read_text() == "owner secret\n"

    os.symlink(secret, own / "link.txt")
    res = _call("read_file", {"path": "link.txt"}, "mia", "member")
    assert "own folder" in res.get("error", "")

    res = _call("search_files", {"pattern": "secret", "path": str(tmp_path)}, "mia", "member")
    assert "own folder" in res.get("error", "")


def test_member_v4a_patch_headers_must_stay_inside(home):
    hermes_home, secret = home
    patch = f"*** Begin Patch\n*** Update File: {secret}\n@@\n-owner secret\n+pwned\n*** End Patch\n"
    res = _call("patch", {"mode": "patch", "patch": patch}, "mia", "member")
    assert "own folder" in res.get("error", "")
    rel = "*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch\n"
    res = _call("patch", {"mode": "patch", "patch": rel}, "mia", "member")
    assert "full paths" in res.get("error", "")
    assert secret.read_text() == "owner secret\n"


def test_viewer_cannot_write(home):
    res = _call("write_file", {"path": "a.txt", "content": "x"}, "vic", "viewer")
    assert "not available to your role" in res.get("error", "")


def test_owner_admin_and_cli_read_anywhere(home):
    _, secret = home
    for user, role in (("root", "owner"), ("ann", "admin"), (None, None)):
        res = _call("read_file", {"path": str(secret)}, user, role, task_id=f"t-{user}")
        assert "owner secret" in json.dumps(res), (user, res)


def test_member_browser_cannot_open_local_files(home):
    from tools.access_policy import acting_as
    from tools.browser_tool import browser_navigate

    with acting_as("mia", "member"):
        res = json.loads(browser_navigate("file:///etc/passwd", task_id="t-access"))
    assert res["success"] is False and "http" in res["error"]


def test_subagent_inherits_the_person(monkeypatch):
    import inspect

    from tools import delegate_tool

    src = inspect.getsource(delegate_tool)
    assert 'internal_user_id=getattr(parent_agent, "_internal_user_id", None)' in src
