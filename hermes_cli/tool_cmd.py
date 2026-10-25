"""``hermes tool`` — create/manage in-house tools + the C2/C3 tool registry.

This is the CLI rung of the footprint ladder for FG-07: authoring an in-house
tool (a Next.js app in its own Node process with a web UI + thin MCP server) and
managing the mode-aware, scope-aware tool registry are expressed as
``hermes tool <sub>`` commands — **zero** model-tool footprint, no new core
surface, and nothing that mutates a live conversation's prompt/toolset.

Subcommands:

* ``new <name>`` — scaffold an in-house tool in **dev** mode, register it in the
  C2/C3 :class:`~hermes_cli.tools_registry.ToolRegistry`, and materialize its
  MCP endpoint into the FG-11 :class:`~hermes_cli.mcp_endpoints.MCPEndpointRegistry`
  (for a *future* session — never spliced live).
* ``list`` — list tools visible to the operator (C2-scoped) in a mode.
* ``enable`` / ``disable`` — flip a tool's status (owner or owner-role).
* ``config <name> --json ... | --file ...`` — replace a tool's ``config_json``
  (validated: no ``HERMES_*`` non-secret keys).
* ``promote <name>`` — approval-gated (C6) dev→prod promotion, recording the
  shared C5 approval/change/promotion rows; for a local app it also runs the
  FG-33 local promotion plan (tag, prod migration, release flip, restart).
* ``new <name> --template nextjs-supabase --hosting local|external
  [--provider …]`` — an FG-33 vibe-coded app (local: dev port, MCP token and
  dev database provisioned by the root helpers).
* ``build|start|stop|restart|logs|status|preview <name>`` and ``doctor`` —
  the FG-33 local app runtime (:mod:`hermes_cli.app_runtime`); app verbs
  default to ``--mode dev``.
* ``archive|restore <name>`` and ``purge <name> --yes-destroy <name>`` — the
  FG-33 lifecycle (:mod:`hermes_cli.app_watch`); never from the agent's shell.
* ``set <name> --coder-profile <profile>`` — the tool's kanban coder profile
  (FG-33 §10, :mod:`hermes_cli.app_coder`).

Routine dev authoring/enable/disable/config each record a C5 provenance change
(pre-approved — the operator is performing it directly); only ``promote`` is
C6-gated.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from hermes_cli.access import Principal


def _load_config_arg(args) -> dict:
    raw = getattr(args, "json", None)
    file = getattr(args, "file", None)
    if raw and file:
        raise SystemExit("Specify either --json or --file, not both")
    if file:
        raw = Path(file).read_text(encoding="utf-8")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON config: {exc}") from exc
    if not isinstance(parsed, dict):
        raise SystemExit("Tool config must be a JSON object")
    return parsed


_NO_TICKET = (
    "refused: `hermes tool` from the agent's terminal needs the requester's "
    "principal ticket, and this call has no valid one (missing, forged or "
    "expired). Ask again from a chat signed in as the person the tool is for."
)


def _agent_requester() -> Optional[str]:
    """The requester for an agent-shell call, ``None`` for a person at the box.

    An agent call is one that carries a principal ticket, or that came through
    ``deploy/hermes-tools-cli`` (which sets ``HERMES_TOOLS_CLI``). Either way it
    must verify; it never falls back to the owner.
    """
    from hermes_cli import principal_ticket

    ticket = os.environ.get(principal_ticket.ENV_VAR, "").strip()
    if not ticket and not os.environ.get("HERMES_TOOLS_CLI"):
        return None
    user_id = principal_ticket.verify(ticket)
    if user_id is None:
        raise SystemExit(_NO_TICKET)
    return user_id


async def _resolve_operator(store, as_user: Optional[str]) -> Principal:
    """Resolve the operator principal.

    From the agent's terminal: the requester named by the principal ticket,
    with no owner fallback (FG-33 0.4). From a person's own shell: ``--as
    <user>`` or the enrolled owner, as before.
    """
    from hermes_cli.access import PrincipalStore

    principals = PrincipalStore(store)
    requester = _agent_requester()
    if requester is not None:
        if as_user and as_user != requester:
            raise SystemExit("refused: --as does not match the requester's principal ticket.")
        principal = await principals.get(requester)
        if principal is None or not principal.active:
            raise SystemExit(
                f"refused: {requester!r} is not an active principal in this profile."
            )
        return principal
    if as_user:
        principal = await principals.get(as_user)
        if principal is None:
            raise SystemExit(
                f"No principal enrolled for {as_user!r}. Enrol the user first."
            )
        return principal
    owner = await principals.get_owner()
    if owner is None:
        raise SystemExit(
            "No owner enrolled yet — enrol the owner first, or pass --as <user>."
        )
    return owner


async def _record_provenance(
    prod_store,
    *,
    actor_user_id: str,
    action: str,
    target_ref: str,
    mode: str,
    visibility: str,
    payload: dict,
) -> None:
    """Record a pre-approved C5 provenance change for a routine tool op.

    Best-effort: the tool registry is the source of truth; if the shared change
    log is unavailable the mutation already succeeded, so we surface a warning
    rather than fail the command.
    """
    from hermes_cli.changes import ChangeLog, initialize_changes

    op = [{"op": "record", "path": f"/tools/{target_ref}", "value": payload}]
    try:
        connection = await prod_store.connect()
        try:
            await initialize_changes(connection)
        finally:
            await connection.close()
        await ChangeLog(prod_store).record(
            actor_user_id=actor_user_id,
            target_kind="code",
            op=op,
            inverse_op=op,
            reversible=True,
            action=action,
            target_ref=target_ref,
            mode=mode,
            visibility=visibility,
            payload=payload,
            approved=True,
        )
    except Exception as exc:  # noqa: BLE001 - provenance is best-effort
        print(f"warning: could not record provenance change: {exc}")


#: FG-33 local app verbs (``hermes_cli.app_runtime``).
_APP_VERBS = ("build", "start", "stop", "restart", "logs", "status", "preview", "doctor")
#: FG-33 lifecycle verbs (``hermes_cli.app_watch``); a person's own act only.
_LIFECYCLE_VERBS = ("archive", "restore", "purge")


def _is_app_new(args) -> bool:
    """An FG-33 app, not the FG-07 minimal tool (whose output stays unchanged)."""
    return bool(
        getattr(args, "hosting", None)
        or getattr(args, "provider", None)
        or getattr(args, "template", None) not in (None, "minimal")
    )


async def _run(args, action: str) -> None:
    from hermes_cli.datastore import get_store, resolve_mode
    from hermes_cli.tools_registry import ToolRegistry, promote_tool

    explicit_mode = getattr(args, "mode", None)
    if action in _APP_VERBS or action in _LIFECYCLE_VERBS or (
        action == "new" and _is_app_new(args)
    ):
        # Apps are authored and previewed in dev; prod only when asked for.
        mode = explicit_mode or "dev"
    else:
        mode = explicit_mode or resolve_mode(None)
    prod_store = get_store("supabase-app", "prod")
    principal = await _resolve_operator(prod_store, getattr(args, "as_user", None))

    registry = ToolRegistry(get_store("supabase-app", mode))
    await registry.initialize()

    if action == "new":
        if _is_app_new(args):
            await _cmd_new_app(args, principal, registry, prod_store, mode)
        else:
            await _cmd_new(args, principal, registry, prod_store, mode)
        return

    if action in _APP_VERBS:
        await _cmd_app(args, action, principal, registry)
        return

    if action in _LIFECYCLE_VERBS:
        await _cmd_lifecycle(args, action, principal, registry)
        return

    if action == "set":
        await _cmd_set(args, principal, registry)
        return

    if action == "list":
        tools = await registry.list_for_principal(principal)
        if not tools:
            print(f"No tools visible to {principal.user_id!r} in mode {mode}.")
            return
        print(f"Tools visible to {principal.user_id!r} (mode={mode}):")
        for tool in tools:
            print(
                f"  - {tool.name}  [{tool.kind}]  status={tool.status}  "
                f"visibility={tool.visibility}  "
                f"web_url={tool.web_url or '-'}  "
                f"mcp={tool.mcp_endpoint_ref or '-'}"
            )
        return

    if action in ("enable", "disable"):
        tool = await registry.set_enabled(principal, args.name, action == "enable")
        await _record_provenance(
            prod_store,
            actor_user_id=principal.user_id,
            action=f"hermes tool {action} {tool.name}",
            target_ref=tool.name,
            mode=tool.mode,
            visibility=tool.visibility,
            payload={"status": tool.status},
        )
        print(f"Tool {tool.name!r} is now {tool.status} (mode={tool.mode}).")
        return

    if action == "config":
        config = _load_config_arg(args)
        tool = await registry.set_config(principal, args.name, config)
        await _record_provenance(
            prod_store,
            actor_user_id=principal.user_id,
            action=f"hermes tool config {tool.name}",
            target_ref=tool.name,
            mode=tool.mode,
            visibility=tool.visibility,
            payload={"config_json": tool.config_json},
        )
        print(f"Updated config for tool {tool.name!r} (mode={tool.mode}).")
        return

    if action == "promote":
        result = await promote_tool(
            get_store("supabase-app", "prod"),
            args.name,
            actor=principal.user_id,
        )
        print(
            f"Promoted tool {result.tool_name!r} dev→prod (it lands disabled).\n"
            f"  approval={result.approval_ref}\n"
            f"  change={result.change_ref}\n"
            f"  promotion={result.promotion_ref}"
        )
        _print_source_publish(getattr(result, "source_publish", None))
        return


async def _cmd_new(args, principal, registry, prod_store, mode) -> None:
    from hermes_cli.mcp_endpoints import MCPEndpointRegistry
    from hermes_cli.tool_scaffold import scaffold_in_house_tool
    from hermes_constants import get_hermes_home

    name = args.name
    tools_root = Path(getattr(args, "root", "") or (get_hermes_home() / "tools"))
    scaffold = scaffold_in_house_tool(name, tools_root)

    # Materialize the tool's MCP endpoint into the FG-11 registry (future
    # sessions only — never spliced into a live conversation).
    visibility = "shared" if getattr(args, "shared", False) else None
    endpoints = MCPEndpointRegistry(registry.store)  # same mode store
    await endpoints.initialize()
    endpoint = await endpoints.register(
        principal,
        name,
        "in_house",
        scaffold.mcp_transport(),
        visibility=visibility,
    )

    tool = await registry.create(
        principal,
        name,
        "in_house",
        stack="nextjs-node",
        visibility=visibility,
        status="disabled",
        mcp_endpoint_ref=endpoint.name,
        web_url=scaffold.web_url,
        config={},
    )
    await _record_provenance(
        prod_store,
        actor_user_id=principal.user_id,
        action=f"hermes tool new {name}",
        target_ref=name,
        mode=tool.mode,
        visibility=tool.visibility,
        payload={"kind": "in_house", "stack": tool.stack, "web_url": tool.web_url},
    )

    print(f"Scaffolded in-house tool {name!r} in mode {mode}:")
    print(f"  path:    {scaffold.root}")
    print(f"  web UI:  {scaffold.web_url}  (npm install && npm run dev)")
    print(f"  MCP:     node {' '.join(scaffold.mcp_args)}  (npm run mcp)")
    print(f"  files:   {', '.join(scaffold.files)}")
    print(
        f"Registered in the tool registry (status={tool.status}) and the FG-11 "
        f"MCP endpoint registry (endpoint={endpoint.name})."
    )
    print("Enable it with `hermes tool enable %s`, then promote with "
          "`hermes tool promote %s`." % (name, name))


async def _cmd_new_app(args, principal, registry, prod_store, mode) -> None:
    """``tool new --template/--hosting/--provider``: an FG-33 vibe-coded app."""
    from hermes_cli import app_runtime as rt
    from hermes_cli.mcp_endpoints import MCPEndpointRegistry
    from hermes_cli.tool_scaffold import scaffold_in_house_tool
    from hermes_constants import get_hermes_home

    name = args.name
    template = getattr(args, "template", None) or "nextjs-supabase"
    hosting = getattr(args, "hosting", None) or "local"
    provider = getattr(args, "provider", None)
    if mode != "dev":
        raise SystemExit("refused: apps are created in dev; promote them to prod later.")
    if hosting == "external" and not provider:
        raise SystemExit("refused: --hosting external needs --provider.")
    if hosting == "local" and provider:
        raise SystemExit("refused: --provider is only for --hosting external.")
    try:
        rt.validate_slug(name)
        await rt.admit(registry, principal, "create", tool=name, hosting=hosting)
    except (ValueError, rt.AdmissionRefused) as exc:
        raise SystemExit(f"refused: {exc}") from exc

    visibility = "shared" if getattr(args, "shared", False) else None
    tools_root = Path(getattr(args, "root", "") or (get_hermes_home() / "tools"))
    runtime = rt.AppRuntime(tools_root=tools_root)
    port = None
    try:
        if hosting == "local":
            port, ref = runtime.allocate(name, "dev")
        try:
            scaffold = scaffold_in_house_tool(
                name, tools_root, template=template, hosting=hosting,
                provider=provider, **({"port": port} if port else {}),
            )
        except TypeError as exc:
            raise SystemExit(
                "refused: this build has no app templates yet (FG-33 P8-1.1)."
            ) from exc
        provisioned = runtime.helper.db("create", name, "dev") if hosting == "local" else {}
    except rt.HelperError as exc:
        raise SystemExit(f"error: {exc}") from exc

    app_config: dict = {}
    manifest = Path(scaffold.root) / "tool.config.json"
    if manifest.is_file():
        try:
            app_config = {"app": json.loads(manifest.read_text(encoding="utf-8"))}
        except (OSError, json.JSONDecodeError):
            app_config = {}

    endpoint_ref = None
    if hosting == "local":
        endpoints = MCPEndpointRegistry(registry.store)
        await endpoints.initialize()
        endpoint = await endpoints.register(
            principal, rt.endpoint_name(name), "in_house",
            rt.mcp_transport(port, name, "dev"), visibility=visibility,
            app_kind="local", secret_ref=ref,
        )
        endpoint_ref = endpoint.name
    tool = await registry.create(
        principal, name, "in_house" if hosting == "local" else "external",
        visibility=visibility, status="disabled", mcp_endpoint_ref=endpoint_ref,
        web_url=f"http://127.0.0.1:{port}" if port else None, config=app_config,
        hosting=hosting, repo_path=str(scaffold.root), build_state="draft",
    )
    if hosting == "local":
        await runtime.record_dev_database(registry, tool, {**provisioned, "port": port})
    source_publish = await runtime.publish_source(tool)
    await _record_provenance(
        prod_store,
        actor_user_id=principal.user_id,
        action=f"hermes tool new {name}",
        target_ref=name,
        mode=tool.mode,
        visibility=tool.visibility,
        payload={"kind": tool.kind, "hosting": hosting, "template": template,
                 "provider": provider, "source_publish": source_publish},
    )
    print(f"Scaffolded {hosting} app {name!r} (template {template}) in mode dev:")
    print(f"  path:    {scaffold.root}")
    if hosting == "local":
        print(f"  preview: {rt.app_path(name, 'dev')}  (after `hermes tool build {name}`)")
        print(f"  MCP:     {endpoint_ref} (HTTP, bearer)")
    _print_source_publish(source_publish)
    print(f"Registered (status={tool.status}). Build with `hermes tool build {name}`, "
          f"then promote with `hermes tool promote {name}`.")


def _print_source_publish(result: Optional[dict]) -> None:
    """One line on where the app's source went (decision 14); silent when local-only."""
    if not result or result.get("reason") == "local-only":
        return
    if result.get("published"):
        print(f"  source:  pushed to GitHub {result.get('repo')}")
    else:
        print(f"  source:  kept in the local git repo; GitHub push failed: {result.get('error')}")


async def _cmd_app(args, action, principal, registry) -> None:
    from hermes_cli import app_runtime as rt
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    runtime = rt.AppRuntime()
    try:
        if action == "doctor":
            registries = {}
            for m in ("dev", "prod"):
                registries[m] = ToolRegistry(get_store("supabase-app", m))
                await registries[m].initialize()
            result = await runtime.doctor(registries, principal)
            if getattr(args, "json", False):
                print(json.dumps(result, indent=2, sort_keys=True))
                return
            if result["ok"]:
                print("No problems: registry rows, app instances and databases agree.")
            for problem in result["problems"]:
                print("  - " + ", ".join(f"{k}={v}" for k, v in problem.items()))
            return
        if action == "build":
            result = await runtime.build(registry, principal, args.name)
            print(f"Built {result['tool']!r} at {result['release_sha'][:12]}; "
                  f"dev preview: {result['path']}")
            _print_source_publish(result.get("source_publish"))
        elif action in ("start", "stop", "restart"):
            result = await runtime.control(registry, principal, args.name, action)
            print(f"{result['tool']} ({result['mode']}): {result['runtime_state']}")
        elif action == "logs":
            result = await runtime.logs(registry, principal, args.name,
                                        lines=getattr(args, "lines", 200) or 200)
            print(result["lines"])
        elif action == "status":
            print(json.dumps(await runtime.status(registry, principal, args.name),
                             indent=2, sort_keys=True, default=str))
        elif action == "preview":
            tool = await runtime.resolve(registry, principal, args.name, write=False)
            print(runtime.preview(tool, registry.mode))
    except KeyError as exc:
        raise SystemExit(f"error: no tool named {args.name!r} visible to you") from exc
    except (PermissionError, ValueError, rt.AdmissionRefused) as exc:
        raise SystemExit(f"refused: {exc}") from exc
    except rt.HelperError as exc:
        raise SystemExit(f"error: {exc}") from exc


def _from_agent_shell() -> bool:
    from hermes_cli import principal_ticket

    return bool(os.environ.get(principal_ticket.ENV_VAR, "").strip()
                or os.environ.get("HERMES_TOOLS_CLI"))


async def _cmd_lifecycle(args, action, principal, registry) -> None:
    """``archive|restore|purge``: decision 9, the owner's or an admin's own act."""
    from hermes_cli import app_runtime as rt
    from hermes_cli import app_watch
    from hermes_cli.datastore import get_store
    from hermes_cli.tools_registry import ToolRegistry

    if _from_agent_shell():
        raise SystemExit(f"refused: `hermes tool {action}` is a person's act; "
                         "use the Tools page or your own shell.")
    runtime = rt.AppRuntime()
    try:
        if action == "archive":
            result = await app_watch.archive_app(runtime, registry, principal, args.name)
        elif action == "restore":
            result = await app_watch.restore_app(runtime, registry, principal, args.name)
        else:
            other = ToolRegistry(get_store("supabase-app",
                                           "prod" if registry.mode == "dev" else "dev"))
            await other.initialize()
            result = await app_watch.purge_app(
                runtime, registry, principal, args.name,
                confirm=getattr(args, "yes_destroy", None) or "", other_registry=other,
            )
    except KeyError as exc:
        raise SystemExit(f"error: no tool named {args.name!r} visible to you") from exc
    except (PermissionError, ValueError, rt.AdmissionRefused,
            app_watch.LifecycleConflict) as exc:
        raise SystemExit(f"refused: {exc}") from exc
    except rt.HelperError as exc:
        raise SystemExit(f"error: {exc}") from exc
    print(f"{result['tool']} ({result['mode']}): {result['lifecycle_state']}")
    if result.get("backup_ref"):
        print(f"  final database dump: {result['backup_ref']}")


async def _cmd_set(args, principal, registry) -> None:
    """``tool set <name> --coder-profile <profile>`` (FG-33 §10, item 2.9)."""
    import inspect

    from hermes_cli.app_runtime import AppRuntime

    try:
        from hermes_cli.app_coder import set_coder_profile
    except ImportError as exc:
        raise SystemExit("refused: this build has no coder profiles yet (FG-33 P8-2.9).") from exc
    try:
        await AppRuntime.resolve(registry, principal, args.name, write=True)
        result = set_coder_profile(args.name, args.coder_profile)
        if inspect.isawaitable(result):
            await result
    except KeyError as exc:
        raise SystemExit(f"error: no tool named {args.name!r} visible to you") from exc
    except (PermissionError, ValueError) as exc:
        raise SystemExit(f"refused: {exc}") from exc
    print(f"{args.name}: coder profile set to {args.coder_profile!r}.")


def cmd_tool(args) -> None:
    """Dispatch ``hermes tool`` subcommands (default ``list``)."""
    action = getattr(args, "tool_action", None) or "list"
    asyncio.run(_run(args, action))


def register_tool_subparser(subparsers) -> None:
    """Wire the ``hermes tool`` parser (FG-07 in-house tools + registry)."""
    parser = subparsers.add_parser(
        "tool",
        help="Create and manage in-house tools + the tool registry (FG-07)",
        description=(
            "Create in-house tools (Next.js app + thin MCP server, own Node "
            "process) and manage the mode-aware, scope-aware tool registry."
        ),
    )
    parser.add_argument(
        "--as", dest="as_user", default=None,
        help="Operate as this user_id (defaults to the enrolled owner)",
    )
    parser.add_argument(
        "--mode", choices=("dev", "prod"), default=None,
        help="Datastore mode (defaults to config datastore.mode / prod)",
    )
    sub = parser.add_subparsers(dest="tool_action")

    new = sub.add_parser("new", help="Scaffold + register a new in-house tool (dev)")
    new.add_argument("name", help="Tool name (also the project directory)")
    new.add_argument(
        "--root", default=None,
        help="Parent directory for the scaffold (default: $HERMES_HOME/tools)",
    )
    new.add_argument(
        "--shared", action="store_true",
        help="Register as shared instead of private to the operator",
    )
    new.add_argument(
        "--template", choices=("minimal", "nextjs-supabase"), default=None,
        help="App template (FG-33); omit for the FG-07 minimal tool",
    )
    new.add_argument(
        "--hosting", choices=("local", "external"), default=None,
        help="Where the app runs: on this box (local) or a provider (external)",
    )
    new.add_argument(
        "--provider", choices=("vercel", "railway", "aws_amplify", "alibaba_fc"),
        default=None, help="Hosting provider for --hosting external",
    )
    new.set_defaults(func=cmd_tool, tool_action="new")

    listp = sub.add_parser("list", help="List tools visible to the operator")
    listp.set_defaults(func=cmd_tool, tool_action="list")

    enable = sub.add_parser("enable", help="Enable a tool")
    enable.add_argument("name")
    enable.set_defaults(func=cmd_tool, tool_action="enable")

    disable = sub.add_parser("disable", help="Disable a tool")
    disable.add_argument("name")
    disable.set_defaults(func=cmd_tool, tool_action="disable")

    config = sub.add_parser("config", help="Replace a tool's config_json")
    config.add_argument("name")
    config.add_argument("--json", default=None, help="Config as a JSON object string")
    config.add_argument("--file", default=None, help="Path to a JSON config file")
    config.set_defaults(func=cmd_tool, tool_action="config")

    promote = sub.add_parser(
        "promote", help="Approval-gated dev→prod promotion of a tool (C6)"
    )
    promote.add_argument("name")
    promote.set_defaults(func=cmd_tool, tool_action="promote")

    app_help = {
        "build": "Build the app's dev HEAD and (re)start its dev instance",
        "start": "Start the app instance of --mode (default dev)",
        "stop": "Stop the app instance of --mode (default dev)",
        "restart": "Restart the app instance of --mode (default dev)",
        "logs": "Show a capped tail of the app instance's journal",
        "status": "Show the app's runtime state and recent deployments",
        "preview": "Print the app's browser path for --mode (default dev)",
    }
    for verb, text in app_help.items():
        verb_parser = sub.add_parser(verb, help=text)
        verb_parser.add_argument("name")
        # Also accepted after the verb; overrides the group-level --mode.
        verb_parser.add_argument("--mode", choices=("dev", "prod"),
                                 default=argparse.SUPPRESS)
        if verb == "logs":
            verb_parser.add_argument("--lines", type=int, default=200)
        verb_parser.set_defaults(func=cmd_tool, tool_action=verb)
    doctor = sub.add_parser(
        "doctor", help="Reconcile app registry rows, instances and databases (read-only)"
    )
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=cmd_tool, tool_action="doctor")

    lifecycle_help = {
        "archive": "Stop, unroute and suspend a local app (reversible; --mode, default dev)",
        "restore": "Bring an archived or idle-stopped local app back",
        "purge": "Delete an archived app's instance and database for good",
    }
    for verb, text in lifecycle_help.items():
        verb_parser = sub.add_parser(verb, help=text)
        verb_parser.add_argument("name")
        verb_parser.add_argument("--mode", choices=("dev", "prod"),
                                 default=argparse.SUPPRESS)
        if verb == "purge":
            verb_parser.add_argument(
                "--yes-destroy", dest="yes_destroy", metavar="NAME", default=None,
                help="Confirm the data loss by repeating the tool name",
            )
        verb_parser.set_defaults(func=cmd_tool, tool_action=verb)

    setp = sub.add_parser("set", help="Set a tool's properties (FG-33)")
    setp.add_argument("name")
    setp.add_argument("--coder-profile", dest="coder_profile", required=True,
                      help="Kanban coder profile for the tool's build cards")
    setp.set_defaults(func=cmd_tool, tool_action="set")

    parser.set_defaults(func=cmd_tool)


__all__ = ["cmd_tool", "register_tool_subparser"]
