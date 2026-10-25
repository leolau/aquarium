"""FG-33 P8-2 item 2.8: link a vibe-coded app to an FG-32 project.

An app (a ``tools`` row, local or external) is tied to a project by three
existing mechanisms — nothing here copies app data into the project:

* a ``project_links`` pointer with ``kind='tool'`` and ``ref=<tool name>``
  (authority stays in the app registry; FG-33 decision 17: links are for
  navigation and outputs, never for visibility);
* one ``project_outputs`` row with ``kind='code'`` per app, delivered with
  ``link_kind='url'`` deliveries pointing at the running app;
* the app's MCP toolset ``mcp-la-<slug>`` (``mcp-xa-<slug>`` for external
  apps) added to the project's ``toolsets`` narrowing list — only when the
  project already narrows; an empty list already means "everything the host
  profile enables", so adding one name there would silently *remove* tools.

``tools.project_slug`` mirrors the link on the registry side
(:func:`mirror_project_slug`). The ``vibe-code-app`` skill drives this
module through ``python -m hermes_cli.projects_links_apps``.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, List, Optional
from urllib.parse import urlparse

from hermes_cli import projects_db
from hermes_cli.app_runtime import app_path, validate_mode, validate_slug
from hermes_cli.mcp_endpoints import APP_NAME_PREFIXES

LINK_KIND = "tool"
OUTPUT_KIND = "code"
OUTPUT_TITLE_PREFIX = "App: "
DEFAULT_LINK_PROFILE = "default"


class LinkRefused(PermissionError):
    """The principal may not perform this link act."""


# --- naming ----------------------------------------------------------------


def app_toolset_name(slug: str, hosting: str = "local") -> str:
    """The project toolset that reaches the app's MCP endpoint."""
    try:
        prefix = APP_NAME_PREFIXES[hosting]
    except KeyError:
        raise ValueError(f"unknown app hosting {hosting!r}") from None
    return f"mcp-{prefix}{validate_slug(slug)}"


def app_url(
    slug: str,
    mode: str = "prod",
    *,
    hosting: str = "local",
    public_url: Optional[str] = None,
) -> str:
    """Where the running app is opened from a delivery.

    A local app is path-routed on the main site (decision 4), so the link is
    relative and works on every hostname the site answers on. An external app
    has no main-site route: its ``public_url`` (http/https) is required.
    """
    validate_slug(slug)
    validate_mode(mode)
    if public_url:
        parsed = urlparse(public_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(f"app url must be http(s): {public_url!r}")
        return public_url
    if hosting != "local":
        raise ValueError(f"external app {slug!r} has no public_url to deliver")
    return app_path(slug, mode) + "/"


def _tool_field(tool: Any, name: str, default: Any = None) -> Any:
    if isinstance(tool, dict):
        return tool.get(name, default)
    return getattr(tool, name, default)


def _tool_hosting(tool: Any) -> str:
    hosting = _tool_field(tool, "hosting")
    if hosting not in APP_NAME_PREFIXES:
        raise ValueError(f"{_tool_field(tool, 'name')!r} is not an app (hosting={hosting!r})")
    return hosting


def _tool_label(tool: Any) -> str:
    return _tool_field(tool, "display_name") or _tool_field(tool, "name")


# --- permissions -----------------------------------------------------------


def _is_instance_admin(principal: Any) -> bool:
    if getattr(principal, "is_owner", False):
        return True
    return getattr(principal, "role", "") in ("owner", "admin")


def can_manage_app(principal: Any, tool: Any) -> bool:
    """Owner/admin act on any app; a member on the apps they own (decision 9)."""
    if _is_instance_admin(principal):
        return True
    owner = _tool_field(tool, "owner_user_id")
    return bool(owner) and owner == getattr(principal, "user_id", None)


def _require_project_act(conn, project, principal) -> None:
    """Links and deliveries are member judgement acts (FG-32 §11 rule 3)."""
    from hermes_cli.projects_api import _can_member_act, _member_role_sync

    role = _member_role_sync(conn, project.id, principal.user_id)
    if not _can_member_act(project, role, principal):
        raise LinkRefused(
            f"{principal.user_id} may not link apps into project {project.slug!r}"
        )


def _require_app_manage(principal, tool) -> None:
    if not can_manage_app(principal, tool):
        raise LinkRefused(
            f"{principal.user_id} may not manage app {_tool_field(tool, 'name')!r}"
        )


def _resolve_project(conn, project_ref: str):
    project = projects_db.get_project(conn, project_ref)
    if project is None:
        raise LookupError(f"no such project: {project_ref!r}")
    return project


# --- project toolsets ------------------------------------------------------


def _toolsets_list(project) -> List[str]:
    from hermes_cli.projects_run import parse_csv_field

    return parse_csv_field(project.toolsets)


def _attach_toolset(conn, project, toolset: str) -> bool:
    current = _toolsets_list(project)
    if not current or toolset in current:
        return False
    projects_db.update_project_fields(
        conn, project.id, {"toolsets": ",".join([*current, toolset])}
    )
    return True


def _detach_toolset(conn, project, toolset: str) -> bool:
    current = _toolsets_list(project)
    if toolset not in current:
        return False
    remaining = [t for t in current if t != toolset]
    if not remaining:
        # Emptying the list would mean "every enabled toolset": never widen.
        return False
    projects_db.update_project_fields(
        conn, project.id, {"toolsets": ",".join(remaining)}
    )
    return True


# --- link / unlink / list --------------------------------------------------


def link_app(
    conn,
    project_ref: str,
    tool: Any,
    principal: Any,
    *,
    profile: str = DEFAULT_LINK_PROFILE,
) -> dict:
    """Link ``tool`` (a :class:`~hermes_cli.tools_registry.Tool` or mapping,
    already resolved through the principal's C2 scope) into a project.

    Idempotent. Returns what changed.
    """
    slug = validate_slug(_tool_field(tool, "name") or "")
    project = _resolve_project(conn, project_ref)
    _require_project_act(conn, project, principal)
    _require_app_manage(principal, tool)
    toolset = app_toolset_name(slug, _tool_hosting(tool))
    linked = projects_db.add_project_link(
        conn,
        project_id=project.id,
        kind=LINK_KIND,
        profile=profile,
        ref=slug,
        label=_tool_label(tool),
        added_by=principal.user_id,
    )
    attached = _attach_toolset(conn, project, toolset)
    return {
        "project": project.slug,
        "app": slug,
        "linked": linked,
        "toolset": toolset,
        "toolset_attached": attached,
    }


def unlink_app(
    conn,
    project_ref: str,
    slug: str,
    principal: Any,
    *,
    hosting: str = "local",
) -> dict:
    """Remove the link and the app toolset. Deliveries stay as history."""
    slug = validate_slug(slug)
    project = _resolve_project(conn, project_ref)
    _require_project_act(conn, project, principal)
    removed = False
    for link in projects_db.get_project_links(conn, project.id, kind=LINK_KIND):
        if link["ref"] == slug:
            removed |= projects_db.remove_project_link(
                conn,
                project_id=project.id,
                kind=LINK_KIND,
                profile=link["profile"],
                ref=slug,
            )
    toolset = app_toolset_name(slug, hosting)
    detached = _detach_toolset(conn, project, toolset)
    return {
        "project": project.slug,
        "app": slug,
        "unlinked": removed,
        "toolset": toolset,
        "toolset_detached": detached,
    }


def linked_apps(conn, project_ref: str) -> List[dict]:
    """The apps linked to a project (navigation only — not a visibility grant)."""
    project = _resolve_project(conn, project_ref)
    seen: dict = {}
    for link in projects_db.get_project_links(conn, project.id, kind=LINK_KIND):
        seen.setdefault(
            link["ref"],
            {"app": link["ref"], "label": link["label"], "added_at": link["added_at"]},
        )
    return list(seen.values())


def projects_for_app(conn, slug: str) -> List[str]:
    """Slugs of the projects an app is linked to."""
    validate_slug(slug)
    rows = conn.execute(
        "SELECT DISTINCT p.slug FROM project_links l JOIN projects p ON p.id = l.project_id "
        "WHERE l.kind = ? AND l.ref = ? ORDER BY p.slug",
        (LINK_KIND, slug),
    ).fetchall()
    return [r[0] for r in rows]


# --- code output + url deliveries ------------------------------------------


def _app_output(conn, project, slug: str, label: str, output_id: Optional[str]) -> str:
    outputs = projects_db.get_project_outputs(conn, project.id)
    if output_id:
        for out in outputs:
            if out["id"] == output_id:
                if out["kind"] != OUTPUT_KIND:
                    raise ValueError(f"output {output_id} is not a code output")
                return output_id
        raise LookupError(f"no output {output_id} in project {project.slug!r}")
    app_paths = {app_path(slug, m) for m in ("prod", "dev")}
    for out in outputs:
        if out["kind"] != OUTPUT_KIND or out["status"] == "dropped":
            continue
        for d in projects_db.get_output_deliveries(conn, output_id=out["id"]):
            ref = (d.get("link_ref") or "").rstrip("/")
            if ref in app_paths or d.get("label") == f"{OUTPUT_TITLE_PREFIX}{slug}":
                return out["id"]
        if out["title"] == f"{OUTPUT_TITLE_PREFIX}{label}":
            return out["id"]
    return projects_db.add_project_output(
        conn,
        project_id=project.id,
        title=f"{OUTPUT_TITLE_PREFIX}{label}",
        spec=f"The running app `{slug}`.",
        kind=OUTPUT_KIND,
        required=False,
    )


def deliver_app(
    conn,
    project_ref: str,
    tool: Any,
    principal: Any,
    *,
    mode: str = "prod",
    output_id: Optional[str] = None,
    run_id: Optional[str] = None,
    task_id: Optional[str] = None,
    profile: str = DEFAULT_LINK_PROFILE,
) -> dict:
    """Record a ``link_kind='url'`` delivery of the running app on the
    project's code output for it (created on first delivery, reused after).

    Links the app first if it is not linked yet. Refused on archived
    projects (archive freezes growth).
    """
    slug = validate_slug(_tool_field(tool, "name") or "")
    project = _resolve_project(conn, project_ref)
    if project.archived:
        raise LinkRefused(f"project {project.slug!r} is archived")
    url = app_url(
        slug,
        mode,
        hosting=_tool_hosting(tool),
        public_url=_tool_field(tool, "public_url") if mode == "prod" else None,
    )
    link = link_app(conn, project.slug, tool, principal, profile=profile)
    label = _tool_label(tool)
    oid = _app_output(conn, project, slug, label, output_id)
    sha = _tool_field(tool, "release_sha")
    note = f"{mode} release {sha}" if sha else mode
    delivery_id = projects_db.record_output_delivery(
        conn,
        output_id=oid,
        run_id=run_id,
        task_id=task_id,
        link_kind="url",
        link_ref=url,
        profile=profile,
        label=f"{OUTPUT_TITLE_PREFIX}{slug}",
        note=note,
    )
    out = next(o for o in projects_db.get_project_outputs(conn, project.id) if o["id"] == oid)
    if out["status"] in ("pending", "in_progress"):
        projects_db.update_project_output(conn, oid, status="delivered")
    return {**link, "output_id": oid, "delivery_id": delivery_id, "url": url}


# --- registry mirror -------------------------------------------------------


async def mirror_project_slug(
    registry,
    principal: Any,
    slug: str,
    project_slug: Optional[str],
) -> bool:
    """Set ``tools.project_slug`` (the registry-side pointer). Returns False
    when the app has no row in this registry's mode."""
    from hermes_cli.tools_registry import TOOLS_TABLE, _row_to_tool, _COLUMNS

    validate_slug(slug)
    conn = await registry._connect()
    try:
        row = await conn.fetchrow(
            f"SELECT {_COLUMNS} FROM {TOOLS_TABLE} WHERE name = $1", slug
        )
        if row is None:
            return False
        _require_app_manage(principal, _row_to_tool(row))
        await conn.execute(
            f"UPDATE {TOOLS_TABLE} SET project_slug = $2, updated_at = NOW() WHERE name = $1",
            slug,
            project_slug,
        )
        return True
    finally:
        await conn.close()


# --- CLI (used by the vibe-code-app skill) ---------------------------------


async def _load(args):
    from hermes_cli.datastore import get_store
    from hermes_cli.tool_cmd import _resolve_operator
    from hermes_cli.tools_registry import ToolRegistry

    principal = await _resolve_operator(get_store("supabase-app", "prod"), args.as_user)
    registry = ToolRegistry(get_store("supabase-app", args.mode))
    await registry.initialize()
    tool = None
    if getattr(args, "app", None):
        tool = await registry.get_for_principal(principal, validate_slug(args.app))
        if tool is None and args.action != "unlink":
            raise SystemExit(f"No such app: {args.app}")
    return principal, registry, tool


async def _run(args) -> dict:
    if args.action == "list":
        with projects_db.connect_closing() as conn:
            return {"project": args.project, "apps": linked_apps(conn, args.project)}
    principal, registry, tool = await _load(args)
    with projects_db.connect_closing() as conn:
        if args.action == "link":
            result = link_app(conn, args.project, tool, principal)
        elif args.action == "deliver":
            result = deliver_app(
                conn, args.project, tool, principal,
                mode=args.deliver_mode, run_id=args.run_id, task_id=args.task_id,
            )
        else:
            hosting = _tool_hosting(tool) if tool is not None else "local"
            result = unlink_app(conn, args.project, args.app, principal, hosting=hosting)
        project_slug = _resolve_project(conn, args.project).slug
    if args.action in ("link", "deliver"):
        result["mirrored"] = await mirror_project_slug(registry, principal, args.app, project_slug)
    elif tool is not None and _tool_field(tool, "project_slug") == project_slug:
        result["mirrored"] = await mirror_project_slug(registry, principal, args.app, None)
    return result


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m hermes_cli.projects_links_apps")
    sub = p.add_subparsers(dest="action", required=True)
    for name in ("link", "unlink", "deliver", "list"):
        sp = sub.add_parser(name)
        sp.add_argument("project")
        if name != "list":
            sp.add_argument("app")
            sp.add_argument("--as", dest="as_user")
            sp.add_argument("--mode", choices=("dev", "prod"), default="dev",
                            help="registry the app row is read from")
        if name == "deliver":
            sp.add_argument("--deliver-mode", choices=("dev", "prod"), default="prod")
            sp.add_argument("--run-id")
            sp.add_argument("--task-id")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = asyncio.run(_run(args))
    except (LinkRefused, LookupError, ValueError) as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
