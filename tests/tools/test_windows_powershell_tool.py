"""windows_powershell tool: the person's own Windows servers (no network)."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

import hermes_cli.winrm_connections as wr
import tools.windows_powershell_tool as tool
from tools.access_policy import acting_as

SECRET = "win-pass-5a90c2"


def _entry(name="APP01", **over):
    payload = {"host": "app01", "port": 5986, "transport": "ntlm", "username": "ops",
               "password": SECRET}
    payload.update(over)
    return SimpleNamespace(name=name, owner_user_id="u1", payload=payload)


@pytest.fixture
def entries(monkeypatch):
    found = [_entry()]

    async def own(principal):
        assert principal.user_id == "u1"
        return found

    async def no_route(principal, cred, *, agent=False):
        assert agent is True
        return None

    monkeypatch.setattr(wr, "own_entries", own)
    monkeypatch.setattr(wr, "route_for", no_route)
    monkeypatch.setattr(wr, "_last_test", lambda *a: None)
    return found


@pytest.fixture
def executed(monkeypatch):
    calls = []

    def fake_execute(payload, script, *, ip=None):
        calls.append(script)
        return {"output": "ok", "errors": [], "had_errors": False}

    monkeypatch.setattr(wr, "execute", fake_execute)
    return calls


@pytest.fixture
def approvals(monkeypatch):
    import tools.approval as approval

    asked = []
    answer = {"decision": ("decline", "user_denied")}

    def ask(message, description, **kw):
        asked.append(message)
        return answer["decision"]

    monkeypatch.setattr(approval, "request_elicitation_consent_detailed", ask)
    return SimpleNamespace(asked=asked, answer=answer)


def call(**args):
    with acting_as("u1", "member"):
        return json.loads(asyncio.run(tool.windows_powershell_tool(args)))


def test_registered_in_the_winrm_toolset_and_gated_on_pypsrp(monkeypatch):
    from tools.registry import registry

    spec = registry._tools["windows_powershell"] if hasattr(registry, "_tools") else None
    if spec is not None:
        assert spec.toolset == "winrm" and spec.check_fn is tool.check_winrm_requirements
    monkeypatch.setattr(wr, "driver_available", lambda: False)
    assert tool.check_winrm_requirements() is False
    monkeypatch.setattr(wr, "driver_available", lambda: True)
    assert tool.check_winrm_requirements() is True


def test_in_api_server_toolset():
    from toolsets import _HERMES_CORE_TOOLS, resolve_toolset

    assert "windows_powershell" in resolve_toolset("hermes-api-server")
    assert "windows_powershell" in _HERMES_CORE_TOOLS
    assert resolve_toolset("winrm") == ["windows_powershell"]


def test_needs_a_signed_in_person():
    out = json.loads(asyncio.run(tool.windows_powershell_tool({"action": "list_connections"})))
    assert out["success"] is False


def test_list_connections_has_no_password(entries):
    out = call(action="list_connections")
    assert out["success"] and out["connections"][0]["name"] == "APP01"
    assert SECRET not in json.dumps(out)


def test_fixed_actions_need_no_approval(entries, executed, approvals):
    assert call(action="get_service", service="MSSQL$SQLEXPRESS")["success"]
    assert call(action="get_eventlog", log="Microsoft-Windows-PowerShell/Operational",
                level="error", max_events=5)["success"]
    assert call(action="disk_free")["success"]
    assert approvals.asked == []
    assert "Get-Service -Name 'MSSQL$SQLEXPRESS'" in executed[0]
    assert "LogName='Microsoft-Windows-PowerShell/Operational'; Level=2" in executed[1]
    assert "-MaxEvents 5" in executed[1]
    assert "Win32_LogicalDisk" in executed[2]


@pytest.mark.parametrize(
    "args",
    [
        {"action": "get_service", "service": "x'; Stop-Computer; '"},
        {"action": "get_service", "service": "a`b"},
        {"action": "get_service", "service": "$(Remove-Item C:\\)"},
        {"action": "get_eventlog", "log": "System'}; Stop-Computer; #"},
        {"action": "get_eventlog", "log": "System", "max_events": "5; Stop-Computer"},
        {"action": "get_eventlog", "max_events": 100000},
        {"action": "get_eventlog", "level": "debug"},
    ],
)
def test_fixed_action_parameters_cannot_inject(entries, executed, args):
    out = call(**args)
    assert out["success"] is False and executed == []


def test_run_needs_approval_showing_the_command(entries, executed, approvals):
    out = call(action="run", command="Restart-Service W3SVC")
    assert out["success"] is False and "not approved" in out["error"] and executed == []
    assert "Restart-Service W3SVC" in approvals.asked[0]

    approvals.answer["decision"] = ("accept", "approved")
    out = call(action="run", command="Restart-Service W3SVC")
    assert out["success"] and executed == ["Restart-Service W3SVC"]
    assert len(approvals.asked) == 2


def test_run_approval_failure_fails_closed(entries, executed, monkeypatch):
    import tools.approval as approval

    def broken(*a, **kw):
        raise RuntimeError("no chat")

    monkeypatch.setattr(approval, "request_elicitation_consent_detailed", broken)
    out = call(action="run", command="Get-Date")
    assert out["success"] is False and executed == []


def test_run_rejects_empty_and_oversized_commands(entries, executed, approvals):
    assert call(action="run")["success"] is False
    assert call(action="run", command="x" * (tool.MAX_COMMAND_CHARS + 1))["success"] is False
    assert approvals.asked == [] and executed == []


def test_output_is_capped_like_terminal(entries, monkeypatch):
    from tools.tool_output_limits import get_max_bytes

    big = "A" * (get_max_bytes() * 2) + "TAIL"
    monkeypatch.setattr(wr, "execute", lambda payload, script, *, ip=None: {
        "output": big, "errors": [], "had_errors": False})
    out = call(action="disk_free")
    assert "OUTPUT TRUNCATED" in out["output"] and out["output"].endswith("TAIL")
    assert len(out["output"]) < len(big)


def test_several_servers_need_a_name(entries, executed):
    entries.append(_entry(name="APP02"))
    out = call(action="disk_free")
    assert out["success"] is False and "APP02" in out["error"]
    assert call(action="disk_free", connection="app02")["success"]


def test_driver_errors_never_leak_the_password(entries, monkeypatch):
    def boom(payload, script, *, ip=None):
        raise RuntimeError(f"transport failed for {SECRET}")

    monkeypatch.setattr(wr, "execute", boom)
    out = call(action="disk_free")
    assert out["success"] is False and SECRET not in out["error"]


def test_route_error_is_reported(entries, executed, monkeypatch):
    async def bad_route(principal, cred, *, agent=False):
        raise wr.WinrmError("the VPN 'Office' is not set up")

    monkeypatch.setattr(wr, "route_for", bad_route)
    out = call(action="get_service")
    assert out["success"] is False and "VPN" in out["error"] and executed == []
