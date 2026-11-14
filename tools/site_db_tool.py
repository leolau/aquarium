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
    "app_describe",
    "app_query",
    "dictionary",
    "study",
    "propose_dictionary",
)

SCHEMA = {
    "name": "site_db",
    "description": (
        "Work with source sites stored as database schemas (site-to-schema). Actions: "
        "list_sites; create_site (name, base_url, login_url, username, password); "
        "get_design (site); propose_design (site, design, recipe) — stores a design for "
        "approval, creates nothing; approve_design (site, version) — only when the person "
        "explicitly approves; describe (site, entity?, q? keywords) — tables with row counts, or one table's "
        "columns with fill, distinct counts and common values: use before writing SQL; query (site, sql: one SELECT over the site's tables, at most "
        "500 rows); refresh (site, entities?, mode? incremental|full) — starts a backend "
        "refresh; run_status (site) — recent refresh runs. Studying a site (logs in with the "
        "site's saved login, read-only, writes nothing): explore (site, recipe = draft with "
        "base_url + login, goto: page paths and/or probes: [{name, steps}]) — page inventories: "
        "buttons, forms, tables, DataTables, JSON calls, never-click controls; preview (site, "
        "recipe? default the newest proposed, entities?, mode? default full, cursors?, max_rows "
        "per entity, default 50, sample) — dry run: counts, sample rows, duplicate keys, failures. "
        "Aquarium's own data (no site): app_describe — areas (todos, goals, files, inbox) with "
        "columns and the rows this person can see; app_query (areas, sql) — one SELECT over "
        "private copies of those areas, each a table named after its area, at most 500 rows. "
        "Data dictionary (source = site slug, or app for Aquarium's own data): dictionary — the "
        "approved meaning of each table, its grain, joins, metrics and examples; read it before "
        "writing SQL; study — structure and samples of every table plus which are undescribed; "
        "propose_dictionary (source, tables: {table: {meaning, row, grain, columns: {col: text}, "
        "joins: [{to, on}], metrics: [{name, definition, sql}], examples: [{question, sql}]}}, "
        "remove?, glossary?, note, origin? chat|study|feedback) — adds to the draft the owner "
        "approves in agent-home; never call it unless the person asked or confirmed."
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
            "q": {"type": "string", "description": "describe: keep tables matching these words"},
            "source": {"type": "string", "description": "dictionary actions: site slug, or app"},
            "tables": {"type": "object", "description": "propose_dictionary: {table: entry}"},
            "remove": {"type": "array", "items": {"type": "string"}},
            "glossary": {"type": "array", "items": {"type": "object"}},
            "note": {"type": "string"},
            "origin": {"type": "string", "enum": ["chat", "study", "feedback"]},
            "areas": {"type": "array", "items": {"type": "string"}, "description": "app_query: areas to copy"},
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


STUDY_TABLES = 20


async def _dict_source(principal: Any, ref: Any, *, need: str = "read"):
    from hermes_cli import data_dictionary as dd
    from hermes_cli import site_sources as ss

    ref = str(ref or "app").strip()
    sources = await dd.sync_sources(ss.current_profile())
    site = None
    if ref == "app":
        source = next((s for s in sources if s.kind == "app"), None)
    else:
        site, _access = await _site(principal, ref)
        source = next((s for s in sources if s.site_id == site.id), None)
    access = await dd.resolve_access(source, principal) if source is not None else None
    if access is None:
        raise ss.SiteError(
            f"no dictionary for {ref!r} is shared with you; answer from the table structure"
        )
    if not dd.allows(access, need):
        raise ss.SiteError("you can read this dictionary but not suggest changes to it")
    return source, access, site


async def _dictionary_action(action: str, principal: Any, args: Mapping[str, Any]) -> str:
    from hermes_cli import app_data
    from hermes_cli import data_dictionary as dd
    from hermes_cli import site_sources as ss

    need = "read" if action == "dictionary" else "propose"
    source, access, site = await _dict_source(principal, args.get("source"), need=need)
    found = await dd.dictionary(source, draft=dd.allows(access, "propose"))
    approved = found["approved"]
    if action == "dictionary":
        out = {"source": source.view(access), "approved": approved and {
            "version": approved["version"], "entries": approved["entries"]}}
        if found.get("draft"):
            out["draft"] = {k: found["draft"][k] for k in ("version", "changed_tables")}
        if approved is None:
            out["note"] = "Nothing approved yet: answer from describe, and say the tables aren't described."
        return _result(**out)
    if action == "study":
        if site is not None:
            tables = await ss.table_summaries(site)
            detail = [await ss.describe_entity(site, t["name"]) for t in tables[:STUDY_TABLES]]
        else:
            detail = tables = await app_data.describe(principal)
        names = [t.get("name") or t.get("table") for t in tables]
        described = set(((approved or {}).get("entries") or {}).get("tables") or {})
        return _result(
            source=source.view(access),
            tables=detail,
            undescribed=[n for n in names if n not in described],
            approved_version=approved and approved["version"],
            next=("Draft entries from this, ask the person about anything unclear, then "
                  "propose_dictionary with origin=study."),
        )
    origin = str(args.get("origin") or "chat")
    if origin not in ("chat", "study", "feedback"):
        raise ss.SiteError("origin must be chat, study or feedback")
    proposed = await dd.propose(
        source, tables=args.get("tables"), remove=args.get("remove") or [],
        glossary=args.get("glossary"), origin=origin, note=str(args.get("note") or ""),
        by=principal.user_id,
    )
    return _result(
        proposed=proposed,
        next=(f"Tell the person draft v{proposed['version']} waits for the source owner's "
              "approval in agent-home under Data. Answers keep using the approved version."),
    )


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
        if action == "app_describe":
            from hermes_cli import app_data

            return _result(areas=await app_data.describe(principal))
        if action == "app_query":
            from hermes_cli import app_data

            return _result(**await app_data.query(
                principal, args.get("areas") or [], str(args.get("sql") or ""),
                max_rows=int(args.get("max_rows") or ss.MAX_QUERY_ROWS),
            ))
        if action in ("dictionary", "study", "propose_dictionary"):
            return await _dictionary_action(action, principal, args)
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
            return _result(
                site=site.slug, tables=await ss.table_summaries(site, q=args.get("q") or None)
            )
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
