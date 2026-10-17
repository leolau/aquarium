"""Role matrix and edge cases for per-role tool and file limits.

Complements ``test_access_policy.py``: the config knobs (toolset names,
``files: any`` / ``own_folder``), folder naming for odd user ids, members not
reaching each other's folders, the principal binding unwinding, and the agent's
advertised tool list matching what the dispatcher allows.
"""

from __future__ import annotations

import json
import threading
from unittest.mock import MagicMock, patch

import pytest

COMMAND_TOOLS = {
    "terminal", "process", "read_terminal", "close_terminal",
    "execute_code", "cronjob", "skill_manage",
}


@pytest.fixture
def home(tmp_path, monkeypatch):
    hermes_home = tmp_path / "home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


@pytest.fixture
def access_config(monkeypatch):
    import hermes_cli.config as cfg

    def _set(roles):
        monkeypatch.setattr(cfg, "load_config_readonly", lambda: {"access": {"roles": roles}})

    return _set


def _call(name, args, user=None, role=None, task_id="t-roles"):
    import model_tools

    model_tools.discover_builtin_tools()
    out = model_tools.handle_function_call(
        name, args, task_id=task_id, principal_user_id=user, principal_role=role,
        skip_pre_tool_call_hook=True, skip_tool_request_middleware=True,
    )
    return json.loads(out) if out.strip().startswith("{") else {"raw": out}


@pytest.mark.parametrize("role,denied", [
    ("owner", set()),
    ("admin", set()),
    ("member", COMMAND_TOOLS),
    ("viewer", COMMAND_TOOLS | {"write_file", "patch"}),
    ("superuser", COMMAND_TOOLS),
    ("", COMMAND_TOOLS),
])
def test_role_matrix(home, role, denied):
    from tools.access_policy import denied_tools

    got = denied_tools("someone", role)
    assert denied <= got
    assert not ({"read_file", "search_files", "web_search", "browser_navigate"} & got)
    if role in ("owner", "admin"):
        assert got == frozenset()


def test_no_person_means_no_limits_whatever_the_role(home):
    from tools.access_policy import denied_tools, files_root

    for role in ("viewer", "member", None):
        assert denied_tools(None, role) == frozenset()
        assert denied_tools("", role) == frozenset()
        assert files_root(None, role) is None


def test_deny_tools_accepts_toolset_names(home, access_config):
    from tools.access_policy import denied_tools

    access_config({"member": {"deny_tools": ["terminal", "file", " ", ""]}})
    got = denied_tools("mia", "member")
    assert {"terminal", "process", "read_file", "write_file", "patch", "search_files"} <= got
    assert "execute_code" not in got


def test_empty_deny_list_lifts_member_limits(home, access_config):
    from tools.access_policy import denied_tools

    access_config({"member": {"deny_tools": []}})
    assert denied_tools("mia", "member") == frozenset()


def test_files_setting_per_role(home, access_config):
    from tools.access_policy import files_root

    assert files_root("ann", "admin") is None
    assert files_root("mia", "member") == (home / "workspaces" / "mia").resolve()

    access_config({"member": {"files": "any"}, "admin": {"files": "own_folder"}})
    assert files_root("mia", "member") is None
    assert files_root("ann", "admin") == (home / "workspaces" / "ann").resolve()


def test_malformed_role_config_keeps_defaults(home, monkeypatch):
    import hermes_cli.config as cfg
    from tools.access_policy import denied_tools

    for bad in ({"access": {"roles": ["member"]}}, {"access": {"roles": {"member": "all"}}}, {"access": None}):
        monkeypatch.setattr(cfg, "load_config_readonly", lambda bad=bad: bad)
        assert COMMAND_TOOLS <= denied_tools("mia", "member")

    def boom():
        raise RuntimeError("config unreadable")

    monkeypatch.setattr(cfg, "load_config_readonly", boom)
    assert COMMAND_TOOLS <= denied_tools("mia", "member")


@pytest.mark.parametrize("user_id", ["../../etc", "..", ".hidden", "a/b", "x\\y", "名字", "user@example.com"])
def test_own_folder_stays_under_workspaces(home, user_id):
    from tools.access_policy import files_root

    root = files_root(user_id, "member")
    workspaces = (home / "workspaces").resolve()
    assert root.parent == workspaces
    assert root.is_dir()
    assert not root.name.startswith(".")


def test_members_cannot_reach_each_other(home):
    assert "error" not in _call("write_file", {"path": "diary.txt", "content": "mia only\n"}, "mia", "member")
    mia_file = home / "workspaces" / "mia" / "diary.txt"
    assert mia_file.read_text() == "mia only\n"

    for user, role in (("max", "member"), ("vic", "viewer")):
        res = _call("read_file", {"path": str(mia_file)}, user, role, task_id=f"t-{user}")
        assert "own folder" in res.get("error", ""), (user, res)
        res = _call("read_file", {"path": "../mia/diary.txt"}, user, role, task_id=f"t-{user}")
        assert "own folder" in res.get("error", ""), (user, res)
        res = _call("search_files", {"pattern": "mia", "path": str(home / "workspaces")}, user, role, task_id=f"t-{user}")
        assert "own folder" in res.get("error", ""), (user, res)

    res = _call("write_file", {"path": str(mia_file), "content": "max was here"}, "max", "member", task_id="t-max")
    assert "own folder" in res.get("error", "")
    assert mia_file.read_text() == "mia only\n"


def test_member_search_inside_own_folder(home):
    _call("write_file", {"path": "plan.md", "content": "needle in here\n"}, "mia", "member")
    res = _call("search_files", {"pattern": "needle"}, "mia", "member")
    assert "error" not in res, res
    assert "plan.md" in json.dumps(res)


def test_member_replace_patch_outside_own_folder_refused(home, tmp_path):
    target = tmp_path / "owner.txt"
    target.write_text("keep me\n")
    res = _call(
        "patch",
        {"mode": "replace", "path": str(target), "old_string": "keep", "new_string": "lost"},
        "mia", "member",
    )
    assert "own folder" in res.get("error", "")
    assert target.read_text() == "keep me\n"


def test_member_v4a_move_outside_refused(home, tmp_path):
    own = home / "workspaces" / "mia"
    _call("write_file", {"path": "a.txt", "content": "x\n"}, "mia", "member")
    patch_text = f"*** Begin Patch\n*** Move File: {own / 'a.txt'} -> {tmp_path / 'stolen.txt'}\n*** End Patch\n"
    res = _call("patch", {"mode": "patch", "patch": patch_text}, "mia", "member")
    assert "own folder" in res.get("error", "")
    assert not (tmp_path / "stolen.txt").exists()


def test_viewer_reads_own_folder_but_cannot_patch(home):
    own = home / "workspaces" / "vic"
    own.mkdir(parents=True)
    (own / "brief.txt").write_text("read me\n")
    assert "read me" in json.dumps(_call("read_file", {"path": "brief.txt"}, "vic", "viewer"))
    res = _call("patch", {"mode": "replace", "path": "brief.txt", "old_string": "read", "new_string": "x"}, "vic", "viewer")
    assert "not available to your role" in res.get("error", "")
    assert (own / "brief.txt").read_text() == "read me\n"


def test_refused_command_never_runs(home, tmp_path):
    marker = tmp_path / "ran"
    res = _call("terminal", {"command": f"touch {marker}"}, "mia", "member")
    assert "not available to your role" in res["error"]
    assert "owner or an admin" in res["error"]
    assert not marker.exists()


def test_principal_binding_unwinds(home):
    from tools.access_policy import acting_as, current_files_root

    assert current_files_root() is None
    with pytest.raises(RuntimeError):
        with acting_as("mia", "member"):
            assert current_files_root() is not None
            raise RuntimeError("tool crashed")
    assert current_files_root() is None


def test_principal_binding_is_per_thread(home):
    from tools.access_policy import acting_as, current_files_root

    seen = {}
    inside = threading.Event()
    release = threading.Event()

    def member_call():
        with acting_as("mia", "member"):
            inside.set()
            release.wait(5)
            seen["member"] = current_files_root()

    t = threading.Thread(target=member_call)
    t.start()
    inside.wait(5)
    seen["other"] = current_files_root()
    release.set()
    t.join(5)
    assert seen["other"] is None
    assert seen["member"] == (home / "workspaces" / "mia").resolve()


def test_member_browser_http_passes_the_role_guard(home):
    from tools.access_policy import acting_as
    from tools import browser_tool

    with acting_as("mia", "member"), patch.object(
        browser_tool, "_navigation_session_key", side_effect=RuntimeError("past guard")
    ):
        with pytest.raises(RuntimeError, match="past guard"):
            browser_tool.browser_navigate("https://example.com", task_id="t-roles")


def _tool_defs(*names):
    return [
        {"type": "function", "function": {"name": n, "description": n, "parameters": {"type": "object", "properties": {}}}}
        for n in names
    ]


@pytest.mark.parametrize("role,hidden", [
    ("member", {"terminal", "execute_code"}),
    ("viewer", {"terminal", "execute_code", "write_file"}),
    ("admin", set()),
])
def test_agent_does_not_advertise_denied_tools(home, role, hidden):
    from run_agent import AIAgent

    names = ("terminal", "execute_code", "write_file", "read_file", "web_search")
    with (
        patch("run_agent.get_tool_definitions", return_value=_tool_defs(*names)),
        patch("run_agent.check_toolset_requirements", return_value={}),
        patch("run_agent.OpenAI"),
    ):
        agent = AIAgent(
            api_key="test-key-1234567890",
            base_url="https://openrouter.ai/api/v1",
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            internal_user_id="person-1",
            internal_user_role=role,
        )
        agent.client = MagicMock()
    advertised = {t["function"]["name"] for t in agent.tools}
    assert not (advertised & hidden)
    assert advertised == set(names) - hidden
    assert agent.valid_tool_names == advertised
