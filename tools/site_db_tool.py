"""site_db: the agent's way into site-to-schema data (plan 2026-11-10-001 §3.5).

Every action acts for the person the tool call is bound to and checks their
access to the site exactly like the Aquarium API does. Reads run as the
site's own read-only database role, so a query can only see that site's
schema. Designs are proposed here and approved by a site admin — in
agent-home, or here with ``approve_design`` when the person says so.
``explore`` / ``preview`` run the logged-in study steps of the
site-to-schema skill here, where the credential store and the bound person
are, because the agent's terminal may be a sandboxed user without either.
Service-gated: it only appears when the app database is configured.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

from tools.registry import registry

ACTIONS = (
    "list_sites",
    "create_site",
    "get_design",
    "propose_design",
    "approve_design",
    "describe",
    "query",
    "refresh",
    "run_status",
    "explore",
    "preview",
)

SCHEMA = {
    "name": "site_db",
    "description": (
        "Work with source sites stored as database schemas (site-to-schema). Actions: "
        "list_sites; create_site (name, base_url, login_url, username, password); "
        "get_design (site); propose_design (site, design, recipe) — stores a design for "
        "approval, creates nothing; approve_design (site, version) — only when the person "
        "explicitly approves; describe (site, entity?) — tables with row counts, or one table's "
        "columns with fill, distinct counts and common values: use before writing SQL; query (site, sql: one SELECT over the site's tables, at most "
        "500 rows); refresh (site, entities?, mode? incremental|full) — starts a backend "
        "refresh; run_status (site) — recent refresh runs. Studying a site (logs in with the "
        "site's saved login, read-only, writes nothing): explore (site, recipe = draft with "
        "base_url + login, goto: page paths and/or probes: [{name, steps}]) — page inventories: "
        "buttons, forms, tables, DataTables, JSON calls, never-click controls; preview (site, "
        "recipe? default the newest proposed, entities?, mode? default full, cursors?, max_rows "
        "per entity, default 50, sample) — dry run: counts, sample rows, duplicate keys, failures."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "site": {"type": "string", "description": "Site slug or id."},
            "name": {"type": "string"},
            "base_url": {"type": "string"},
            "login_url": {"type": "string"},
            "username": {"type": "string"},
            "password": {"type": "string"},
            "design": {"type": "object", "description": "propose_design: design.json"},
            "recipe": {"type": "object", "description": "propose_design / explore / preview: recipe.json"},
            "goto": {"type": "array", "items": {"type": "string"}, "description": "explore: page paths"},
            "probes": {
                "type": "array",
                "items": {"type": "object"},
                "description": 'explore: [{"name": ..., "steps": [read-only recipe steps]}]',
            },
            "cursors": {"type": "object", "description": "preview: {entity: cursor value} (incremental)"},
            "sample": {"type": "integer", "description": "preview: sample rows per entity (default 3)"},
            "version": {"type": "integer", "description": "approve_design: design version"},
            "entity": {"type": "string", "description": "describe: one table name"},
            "sql": {"type": "string", "description": "query: one SELECT statement"},
            "max_rows": {"type": "integer"},
            "entities": {"type": "array", "items": {"type": "string"}},
            "mode": {"type": "string", "enum": ["incremental", "full"]},
        },
        "required": ["action"],
    },
}


def check_site_db_requirements() -> bool:
    try:
        from hermes_cli import site_sources

        return site_sources.database().configured()
    except Exception:  # noqa: BLE001
        return False


def _result(**data: Any) -> str:
    return json.dumps({"success": True, **data}, ensure_ascii=False, default=str)


def _error(message: str) -> str:
    return json.dumps({"success": False, "error": message}, ensure_ascii=False)


def _principal():
    from hermes_cli.access import Principal, normalize_role
    from hermes_cli.site_sources import SiteError
    from tools.access_policy import current_principal

    user_id, role = current_principal()
    if not user_id:
        raise SiteError("no signed-in person is bound to this request")
    return Principal(user_id=user_id, display=user_id, role=normalize_role(role))


async def _site(principal: Any, ref: Any, *, need: str = "read"):
    from hermes_cli import site_sources as ss

    if not ref:
        raise ss.SiteError("site= is required")
    site = await ss.find_site(str(ref), profile=ss.current_profile())
    grant = None
    if site is not None and not ss._is_profile_admin(principal) and site.owner_user_id != principal.user_id:
        grant = await ss.grant_for(site.id, principal.user_id)
    access = ss.access_level(site, principal, grant) if site is not None else None
    if access is None:
        raise ss.SiteError(f"no site {ref!r}")
    if need == "admin" and access != "admin":
        raise ss.SiteError("you can read this site but not manage it")
    return site, access


async def site_db_tool(args: Mapping[str, Any], **_kw: Any) -> str:
    from hermes_cli import site_sources as ss
    from hermes_cli.config import load_config_readonly

    action = str(args.get("action") or "")
    if action not in ACTIONS:
        return _error(f"action must be one of {', '.join(ACTIONS)}")
    try:
        principal = _principal()
        if action == "list_sites":
            sites = await ss.list_sites(profile=ss.current_profile())
            grants = {} if ss._is_profile_admin(principal) else await ss.grants_of(principal.user_id)
            out = []
            for site in sites:
                access = ss.access_level(site, principal, grants.get(site.id))
                if access is not None:
                    out.append(site.view(access))
            return _result(sites=out)
        if action == "create_site":
            if not ss.can_create(principal, load_config_readonly() or {}):
                raise ss.SiteError("your role can't add sites; ask the owner or an admin")
            body = {k: args.get(k) for k in ("name", "base_url", "login_url", "username", "password") if args.get(k)}
            site = await ss.create_site(principal, body)
            return _result(site=site.view("admin"))
        need = "admin" if action in ("propose_design", "approve_design", "refresh", "explore", "preview") else "read"
        site, access = await _site(principal, args.get("site"), need=need)
        if action == "get_design":
            designs = await ss.list_designs(site)
            if access != "admin":
                for item in designs:
                    item.pop("recipe", None)
            return _result(site=site.view(access), designs=designs[:3])
        if action == "propose_design":
            proposed = await ss.propose_design(
                site, args.get("design"), args.get("recipe"), by=principal.user_id
            )
            return _result(
                proposed=proposed,
                next="Show the person the design and wait for their approval before approve_design.",
            )
        if action == "approve_design":
            if args.get("version") is None:
                raise ss.SiteError("approve_design needs version=")
            return _result(approved=await ss.apply_design(site, int(args["version"]), approved_by=principal.user_id))
        if action == "describe":
            if args.get("entity"):
                return _result(site=site.slug, table=await ss.describe_entity(site, str(args["entity"])))
            return _result(site=site.slug, tables=await ss.table_summaries(site))
        if action == "query":
            result = await ss.query(site, str(args.get("sql") or ""), max_rows=int(args.get("max_rows") or ss.MAX_QUERY_ROWS))
            return _result(site=site.slug, **result)
        if action == "refresh":
            run = await ss.start_refresh(
                site, trigger="agent", entities=args.get("entities") or None, mode=args.get("mode")
            )
            return _result(run=run, next="Use run_status to follow it.")
        if action == "explore":
            return _result(site=site.slug, **(await ss.explore_site(
                site, principal, recipe=args.get("recipe"), probes=args.get("probes"), goto=args.get("goto"))))
        if action == "preview":
            return _result(site=site.slug, **(await ss.preview_recipe(
                site, principal, recipe=args.get("recipe"), entities=args.get("entities") or None,
                mode=args.get("mode"), cursors=args.get("cursors"), row_limit=args.get("max_rows"),
                sample=args.get("sample"))))
        return _result(runs=(await ss.list_runs(site, limit=10)))
    except ss.SiteError as exc:
        return _error(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _error(f"{type(exc).__name__}: {exc}")


registry.register(
    name="site_db",
    toolset="site_db",
    schema=SCHEMA,
    handler=site_db_tool,
    check_fn=check_site_db_requirements,
    is_async=True,
    emoji="🗄️",
)
