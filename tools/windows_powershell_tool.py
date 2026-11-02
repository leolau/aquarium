"""Run PowerShell on the signed-in person's own Windows servers (WinRM).

The agent-side half of Settings -> In&Out -> Windows servers
(``hermes_cli/winrm_connections.py``). The password stays in the credential
store (``winrm`` entries are never materialised into the terminal); this tool
connects in-process and only ever acts for the person the tool call is bound
to. Service-gated: it only appears when pypsrp (the ``winrm`` extra) is
installed.

``run`` executes any command, but only after the person approves that exact
command in the chat. ``get_service``, ``get_eventlog`` and ``disk_free`` are
fixed read-only cmdlets built from validated parameters, so they need no
approval. Output is capped like ``terminal``.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Mapping, Optional

from tools.registry import registry

ACTIONS = ("list_connections", "run", "get_service", "get_eventlog", "disk_free")
MAX_COMMAND_CHARS = 4000
MAX_EVENTS = 200
DEFAULT_EVENTS = 50
EVENT_LEVELS = {"critical": 1, "error": 2, "warning": 3, "information": 4}

SCHEMA = {
    "name": "windows_powershell",
    "description": (
        "Run Windows PowerShell on the signed-in person's own Windows servers added "
        "under Settings -> In&Out -> Windows servers (PowerShell). Actions: "
        "list_connections; get_service (services, optionally one name or a * pattern); "
        "get_eventlog (newest events of one log, optional level); disk_free (local "
        "disks: size and free space); run (any PowerShell command — the person must "
        "approve the exact command first, so prefer the fixed actions). Output is "
        "capped like terminal."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "connection": {
                "type": "string",
                "description": "Server name; optional when the person has exactly one.",
            },
            "command": {
                "type": "string",
                "description": "run: the PowerShell command or script (needs approval).",
            },
            "service": {
                "type": "string",
                "description": "get_service: service name, e.g. MSSQLSERVER or W3SVC (* allowed).",
            },
            "log": {
                "type": "string",
                "description": "get_eventlog: log name (System, Application, ...); default System.",
            },
            "level": {"type": "string", "enum": list(EVENT_LEVELS)},
            "max_events": {
                "type": "integer",
                "description": f"get_eventlog: newest N events (<= {MAX_EVENTS}).",
            },
        },
        "required": ["action"],
    },
}

_SERVICE_RE = re.compile(r"^[A-Za-z0-9_.$*\- ]{1,128}$")
_LOG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _./-]{0,127}$")
_TABLE = " | Format-Table -AutoSize | Out-String -Width 220"
_DISK_FREE = (
    "Get-WmiObject -Class Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, "
    "VolumeName, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, "
    "@{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}}, "
    "@{n='FreePct';e={if ($_.Size) {[math]::Round(100*$_.FreeSpace/$_.Size,1)} else {0}}}"
    + _TABLE
)


class PowershellToolError(Exception):
    pass


def check_winrm_requirements() -> bool:
    from hermes_cli.winrm_connections import driver_available

    return driver_available()


def _result(**data: Any) -> str:
    return json.dumps({"success": True, **data}, ensure_ascii=False, default=str)


def _error(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _principal():
    from hermes_cli.access import Principal, normalize_role
    from tools.access_policy import current_principal

    user_id, role = current_principal()
    if not user_id:
        raise PowershellToolError("no signed-in person is bound to this request")
    return Principal(user_id=user_id, display=user_id, role=normalize_role(role))


def _pick(entries: list, name: Optional[str]):
    if not entries:
        raise PowershellToolError(
            "no Windows server is set up; add one in Settings -> In&Out"
        )
    if name:
        wanted = str(name).strip().casefold()
        for entry in entries:
            if entry.name.casefold() == wanted:
                return entry
        raise PowershellToolError("no Windows server with that name")
    if len(entries) > 1:
        raise PowershellToolError(
            "several Windows servers are set up; pass connection= one of "
            + ", ".join(e.name for e in entries)
        )
    return entries[0]


def _quote(value: str) -> str:
    """A PowerShell single-quoted literal (no expansion inside)."""
    return "'" + value.replace("'", "''") + "'"


def service_script(service: Any) -> str:
    base = "Get-Service"
    if service not in (None, ""):
        name = str(service).strip()
        if not _SERVICE_RE.fullmatch(name):
            raise PowershellToolError(
                "service must be a service name (letters, digits, space, . _ - $ *)"
            )
        base += " -Name " + _quote(name)
    return base + " | Select-Object Name, DisplayName, Status, StartType" + _TABLE


def eventlog_script(log: Any, level: Any, max_events: Any) -> str:
    name = str(log or "System").strip()
    if not _LOG_RE.fullmatch(name):
        raise PowershellToolError("log must be a log name such as System or Application")
    try:
        count = int(max_events if max_events not in (None, "") else DEFAULT_EVENTS)
    except (TypeError, ValueError):
        raise PowershellToolError("max_events must be a number") from None
    if not 1 <= count <= MAX_EVENTS:
        raise PowershellToolError(f"max_events must be from 1 to {MAX_EVENTS}")
    flt = "@{LogName=" + _quote(name)
    if level not in (None, ""):
        if level not in EVENT_LEVELS:
            raise PowershellToolError("level must be one of " + ", ".join(EVENT_LEVELS))
        flt += f"; Level={EVENT_LEVELS[level]}"
    flt += "}"
    return (
        f"Get-WinEvent -FilterHashtable {flt} -MaxEvents {count} | Select-Object "
        "TimeCreated, Id, LevelDisplayName, ProviderName, Message "
        "| Format-List | Out-String -Width 300"
    )


def cap_output(output: str) -> str:
    """Head + tail, like ``terminal``."""
    from tools.tool_output_limits import get_max_bytes

    limit = get_max_bytes()
    if len(output) <= limit:
        return output
    head = int(limit * 0.4)
    tail = limit - head
    omitted = len(output) - head - tail
    notice = (
        f"\n\n... [OUTPUT TRUNCATED - {omitted} chars omitted "
        f"out of {len(output)} total] ...\n\n"
    )
    return output[:head] + notice + output[-tail:]


def _approve_run(entry: Any, command: str) -> Optional[str]:
    """Ask the chat's user before ``run``; error text unless approved."""
    try:
        from tools.approval import request_elicitation_consent_detailed

        decision, reason = request_elicitation_consent_detailed(
            f"Windows server '{entry.name}' ({entry.payload.get('host')}) PowerShell:\n{command}",
            f"The agent wants to run a PowerShell command on the Windows server '{entry.name}'.",
            surface="winrm-run",
        )
    except Exception:  # noqa: BLE001 - fail closed
        decision, reason = "error", "error"
    if decision == "accept":
        return None
    return (
        f"The command on '{entry.name}' was not approved ({reason}), so it did not run. "
        "Ask the person before trying again."
    )


async def windows_powershell_tool(args: Mapping[str, Any], **_kw: Any) -> str:
    from hermes_cli import winrm_connections as winrm

    action = str(args.get("action") or "")
    if action not in ACTIONS:
        return _error(f"action must be one of {', '.join(ACTIONS)}")
    payload: Mapping[str, Any] = {}
    try:
        principal = _principal()
        entries = await winrm.own_entries(principal)
        if action == "list_connections":
            return _result(connections=[winrm.connection_summary(e)[1] for e in entries])
        entry = _pick(entries, args.get("connection"))
        payload = entry.payload
        if action == "get_service":
            script = service_script(args.get("service"))
        elif action == "get_eventlog":
            script = eventlog_script(args.get("log"), args.get("level"), args.get("max_events"))
        elif action == "disk_free":
            script = _DISK_FREE
        else:
            script = str(args.get("command") or "").strip()
            if not script:
                raise PowershellToolError("run needs command=")
            if len(script) > MAX_COMMAND_CHARS:
                raise PowershellToolError(
                    f"command is longer than {MAX_COMMAND_CHARS} characters"
                )
            refusal = await asyncio.to_thread(_approve_run, entry, script)
            if refusal:
                return _error(refusal)
        ip = await winrm.route_for(principal, entry, agent=True)
        result = await asyncio.to_thread(winrm.execute, payload, script, ip=ip)
        return _result(
            connection=entry.name,
            output=cap_output(result["output"]),
            errors=result["errors"],
            had_errors=result["had_errors"],
        )
    except (PowershellToolError, winrm.WinrmError) as exc:
        return _error(winrm.scrub(str(exc), payload))
    except Exception as exc:  # noqa: BLE001 - driver/network errors, scrubbed
        return _error(winrm.plain_error(exc, payload))


registry.register(
    name="windows_powershell",
    toolset="winrm",
    schema=SCHEMA,
    handler=windows_powershell_tool,
    check_fn=check_winrm_requirements,
    is_async=True,
    emoji="🪟",
)
