"""``hermes projects`` — the agent's route into Projects (design §14, step 9).

Footprint-ladder rung 2, exactly as ``incomings``, ``goal`` and ``todos``:
a CLI command plus a skill (``skills/productivity/projects/SKILL.md``), no
new model tool.

Every verb talks to the ``projects_api`` router **in process** through its
real ASGI surface — permissions are enforced there and only there (§11
rule 1), so this module carries no access logic of its own. The acting
principal comes from ``--actor`` (the ``goal_tree_cmd`` convention) or the
enrolled owner.

``hermes project`` (singular, ``projects_cmd.py``) stays the folder
workspace surface; this tree is the Projects-feature surface of §3–§12.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Optional

_PREFIX = "/api/registry/projects"

#: Cadence glyphs — the same ones the /projects list renders (§13).
_GLYPHS = {"one_off": "▣", "repeatable": "↻", "standing": "∞"}


# ---------------------------------------------------------------------------
# Principal resolution — the goal_tree_cmd / todos_cmd convention
# ---------------------------------------------------------------------------


async def _resolve_principal(actor: Optional[str]):
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config
    from hermes_cli.datastore import get_store

    store = get_store("supabase-app", "prod", config=load_config() or {})
    principals = PrincipalStore(store)
    principal = (
        await principals.get(actor) if actor else await principals.get_owner()
    )
    if principal is None:
        raise RuntimeError(
            "unknown --actor" if actor else "no owner is enrolled yet"
        )
    return principal


class _Api:
    """The projects router, in process, under one resolved principal.

    Patching the two principal seams is safe: a CLI invocation is a
    short-lived single-actor process, and the patch is restored on close.
    The human-only seam (§8.1/§8.2) is different: it is claimed only when
    the operator passes ``--as-human`` — an agent turn driving this CLI
    gets the router's 403 exactly like any session-less caller.
    """

    def __init__(self, principal, *, as_human: bool = False):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from hermes_cli import projects_api

        async def _as(request):
            return principal

        async def _subject(request):
            # ``--as-human``: the operator says this terminal is them,
            # making this judgement themselves — the claim is explicit,
            # never automatic.
            return principal.user_id

        self._saved = (
            projects_api._principal_read,  # noqa: SLF001 - same package
            projects_api._principal_write,  # noqa: SLF001 - same package
            projects_api._interactive_subject,  # noqa: SLF001 - same package
        )
        projects_api._principal_read = _as  # noqa: SLF001
        projects_api._principal_write = _as  # noqa: SLF001
        if as_human:
            projects_api._interactive_subject = _subject  # noqa: SLF001
        app = FastAPI()
        app.include_router(projects_api.router)
        self.client = TestClient(app, raise_server_exceptions=False)

    def close(self) -> None:
        from hermes_cli import projects_api

        (
            projects_api._principal_read,  # noqa: SLF001
            projects_api._principal_write,  # noqa: SLF001
            projects_api._interactive_subject,  # noqa: SLF001
        ) = self._saved

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Optional[dict] = None,
    ):
        return self.client.request(
            method, _PREFIX + path, json=json_body, params=params
        )


def _detail_of(resp) -> Optional[str]:
    """The human sentence inside an error response (never raises)."""
    try:
        data = resp.json()
    except Exception:
        return f"HTTP {resp.status_code}"
    detail = data.get("detail", data)
    if isinstance(detail, dict):
        return str(detail.get("message") or detail)
    return str(detail)


def _fail(resp) -> int:
    detail = _detail_of(resp)
    print(f"projects: {detail}", file=sys.stderr)
    if resp.status_code == 403 and "human act" in detail:
        print(
            "projects: re-run with --as-human if you are the operator "
            "making this judgement yourself.",
            file=sys.stderr,
        )
    return 1


def _print_json(obj: Any) -> None:
    print(json.dumps(obj, indent=2, default=str))


def _csv(value: str) -> list[str]:
    return [p.strip() for p in (value or "").split(",") if p.strip()]


def _read_description(value: str) -> str:
    """``--description file.md|-`` (§14): a mandatory long brief typed as a
    shell argument is a brief nobody writes."""
    if value == "-":
        return sys.stdin.read().strip()
    path = os.path.expanduser(value)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip()
    raise ValueError(
        "--description must be a readable file path or '-' for stdin"
    )


# ---------------------------------------------------------------------------
# Read verbs
# ---------------------------------------------------------------------------


def _cmd_list(api: _Api, args) -> int:
    params: dict[str, Any] = {"limit": args.limit}
    if args.status:
        params["status"] = args.status
    if args.cadence:
        params["cadence"] = args.cadence
    if args.health:
        params["health"] = args.health
    if args.archived:
        params["archived"] = "1"
    resp = api.request("GET", "/", params=params)
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    items = data.get("items") or []
    if not items:
        print("No projects yet. Create one with `hermes projects create`.")
        return 0
    for p in items:
        glyph = _GLYPHS.get(p.get("cadence") or "one_off", "▣")
        health = p.get("health") or ""
        status = p.get("status") or ""
        ref = p.get("ref") or ""
        line = f"{glyph} {ref:<6} {p.get('slug', ''):<28} {p.get('name', '')}  [{status}"
        if health:
            line += f", {health}"
        line += "]"
        progress = (p.get("progress") or {}).get("headline")
        if progress:
            line += f"  {progress}"
        print(line)
        if p.get("goal"):
            print(f"    {p['goal']}")
    return 0


def _cmd_show(api: _Api, args) -> int:
    resp = api.request("GET", f"/{args.slug}")
    if resp.status_code != 200:
        return _fail(resp)
    d = resp.json()
    if args.json:
        _print_json(d)
        return 0
    glyph = _GLYPHS.get(d.get("cadence") or "one_off", "▣")
    ref = f"{d['ref']} " if d.get("ref") else ""
    print(f"{glyph} {ref}{d.get('name')}  ({d.get('slug')})")
    print(
        f"  {d.get('cadence')} · {d.get('status')} · autonomy {d.get('autonomy')}"
        f" · health {d.get('health')}"
    )
    if d.get("goal"):
        print(f"  goal: {d['goal']}")
    if d.get("description"):
        print(f"  brief: {d['description']}")
    if d.get("target_audience"):
        print(f"  audience: {d['target_audience']}")
    if d.get("next_run_at"):
        print(f"  next run: {d['next_run_at']}")
    score = d.get("score")
    if score:
        print(f"  score: {score.get('mean')} (last {score.get('runs')} runs)")
    if d.get("score_rubric"):
        print(f"  rubric: {d['score_rubric']}")
    progress = d.get("progress") or {}
    if progress.get("headline"):
        print(f"  progress: {progress['headline']}")
    if d.get("summary"):
        print(f"  where this stands: {d['summary']}")
    outputs = d.get("outputs") or []
    if outputs:
        print("  outputs:")
        for o in outputs:
            req = "" if o.get("required") else " (optional)"
            print(f"    [{o.get('status')}] {o.get('title')}{req}  ({o.get('id')})")
    members = d.get("members") or []
    profiles = d.get("profiles") or []
    if members:
        who = ", ".join(
            f"{m.get('user_id')} ({m.get('role')})" for m in members
        )
        print(f"  people: {who}")
    if profiles:
        prof = ", ".join(
            f"{p.get('profile')} ({p.get('role')})" for p in profiles
        )
        print(f"  profiles: {prof}")
    links = d.get("links") or {}
    kinds = [k for k, rows in links.items() if rows]
    if kinds:
        print("  links: " + ", ".join(f"{k}×{len(links[k])}" for k in kinds))
    runs = d.get("runs") or []
    if runs:
        latest = runs[0]
        print(
            f"  latest run: {latest.get('run_no')} "
            f"[{latest.get('status')}] ({latest.get('trigger')})"
        )
    return 0


def _cmd_cards(api: _Api, args) -> int:
    resp = api.request("GET", f"/{args.slug}/board")
    if resp.status_code != 200:
        return _fail(resp)
    board = resp.json()
    if args.json:
        _print_json(board)
        return 0
    shown = 0
    for col in board.get("columns") or []:
        for t in col.get("tasks") or []:
            if args.status and t.get("status") != args.status:
                continue
            assignee = t.get("assignee") or "-"
            ref = f"{t['ref']} " if t.get("ref") else ""
            print(f"[{t.get('status'):>8}] {ref}{t.get('title')}  ({assignee})  {t.get('id')}")
            shown += 1
    if not shown:
        print("No cards" + (f" in status '{args.status}'" if args.status else "") + ".")
    return 0


def _cmd_runs(api: _Api, args) -> int:
    resp = api.request("GET", f"/{args.slug}/runs")
    if resp.status_code != 200:
        return _fail(resp)
    runs = resp.json().get("runs") or []
    runs = runs[: args.limit]
    if args.json:
        _print_json({"runs": runs})
        return 0
    if not runs:
        print("No runs yet.")
        return 0
    for r in runs:
        cost = r.get("cost")
        cost_s = f"${cost:.2f}" if isinstance(cost, (int, float)) else "cost n/a"
        dur = r.get("duration_seconds")
        dur_s = f"{dur // 60}m" if isinstance(dur, int) else ""
        retro = " retro" if r.get("retro") else ""
        score = (
            f" score={r['score_user']}/5" if r.get("score_user") is not None
            else ""
        )
        diverges = ""
        self_s, user_s = r.get("score_self"), r.get("score_user")
        if (
            self_s is not None and user_s is not None
            and abs(int(self_s) - int(user_s)) >= 2
        ):
            diverges = f" self={self_s}/5 ⚠ diverges"
        print(
            f"run {r.get('run_no'):>3} {r.get('ref') or ''} [{r.get('status'):>8}] "
            f"{r.get('trigger')}  {dur_s} {cost_s} "
            f"outcome={r.get('outcome') or '-'}{score}{diverges}{retro}"
        )
    return 0


_PROPOSAL_KINDS = ("playbook", "directive", "skill")


def _parse_propose_flags(values: list[str]) -> Optional[list[dict]]:
    """``--propose kind=body`` (repeatable, max 3 — §8.1). Returns None on
    a malformed flag after printing why."""
    proposals: list[dict] = []
    for raw in values or []:
        kind, sep, body = raw.partition("=")
        kind = kind.strip().lower()
        if not sep or kind not in _PROPOSAL_KINDS or not body.strip():
            print(
                "projects: --propose takes kind=body with kind one of "
                f"{', '.join(_PROPOSAL_KINDS)}",
                file=sys.stderr,
            )
            return None
        proposals.append({"kind": kind, "body": body.strip()})
    if len(proposals) > 3:
        print(
            "projects: at most three concrete proposals per retro (§8.1)",
            file=sys.stderr,
        )
        return None
    return proposals


def _print_proposals(landed: list[dict]) -> None:
    for p in landed or []:
        if p.get("kind") == "playbook":
            print(
                f"  proposed playbook revision {p.get('rev')} (inactive) — "
                "a lead/admin activates it"
            )
        elif p.get("kind") == "directive":
            print(
                f"  proposed directive {p.get('id')} (inactive) — any "
                "member activates it"
            )
        elif p.get("kind") == "skill":
            print(
                f"  recorded skill candidate {p.get('id')} — provenance: "
                "this project and run"
            )


def _cmd_retro(api: _Api, args) -> int:
    if args.write:
        retro = sys.stdin.read().strip()
        if not retro:
            print("projects: nothing to write on stdin", file=sys.stderr)
            return 2
        proposals = _parse_propose_flags(args.propose)
        if proposals is None:
            return 2
        payload: dict[str, Any] = {"retro": retro}
        if proposals:
            payload["proposals"] = proposals
        resp = api.request(
            "POST", f"/{args.slug}/runs/{args.run_no}/retro",
            json_body=payload,
        )
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
            return 0
        print(f"Retro saved for run {args.run_no} of {args.slug}.")
        _print_proposals(data.get("proposals") or [])
        return 0
    resp = api.request("GET", f"/{args.slug}/runs/{args.run_no}")
    if resp.status_code != 200:
        return _fail(resp)
    run = resp.json()
    if args.json:
        _print_json(run)
        return 0
    retro = run.get("retro") or ""
    print(f"Run {run.get('run_no')} of {args.slug} [{run.get('status')}]")
    print(retro if retro else "(no retro yet — write one with --write)")
    return 0


def _cmd_summarise(api: _Api, args) -> int:
    """Write the rolling \"where this stands\" (§2.2) — read from stdin,
    the same contract as ``retro --write``."""
    summary = sys.stdin.read().strip()
    if not summary:
        print("projects: nothing to write on stdin", file=sys.stderr)
        return 2
    resp = api.request(
        "POST", f"/{args.slug}/summarise", json_body={"summary": summary}
    )
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    print(f"Summary updated for {args.slug} (at {data.get('summary_at')}).")
    print(f"  {data.get('summary')}")
    return 0


def _cmd_doctor(api: _Api, args) -> int:
    params = {"slug": args.slug} if args.slug else None
    resp = api.request("GET", "/doctor", params=params)
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    items = data.get("items") or []
    if not items:
        print("All readable projects look healthy.")
        return 0
    for item in items:
        print(f"{item.get('slug')}  [{item.get('cadence')}]")
        for finding in item.get("findings") or []:
            print(f"  - {finding}")
    return 1


def _cmd_archive(api: _Api, args) -> int:
    """Shelve a project (§13, decision 17): reversible, keeps the record,
    stops it running."""
    body = {"reason": args.reason} if getattr(args, "reason", None) else None
    resp = api.request("POST", f"/{args.slug}/archive", json_body=body)
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    print(f"Archived {data.get('slug')} — restore it with "
          f"`hermes projects restore {data.get('slug')}`.")
    return 0


def _cmd_restore(api: _Api, args) -> int:
    """Bring an archived project back — lands in ``paused``, never straight
    to ``active``; the schedule is not re-created (§12)."""
    resp = api.request("POST", f"/{args.slug}/restore")
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    print(f"Restored {data.get('slug')} — status '{data.get('status')}'. "
          "Re-schedule it with PUT /schedule when it should run again.")
    return 0


def _cmd_delete(api: _Api, args) -> int:
    """Hard delete — the narrow exception (decision 17). Human-only: needs
    ``--as-human`` on the command line and ``--confirm <slug>`` here."""
    resp = api.request(
        "DELETE", f"/{args.slug}", params={"confirm": args.confirm}
    )
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    print(f"Deleted {data.get('deleted')} — the record is gone, "
          "not archived.")
    return 0


# ---------------------------------------------------------------------------
# Write verbs
# ---------------------------------------------------------------------------


def _cmd_create(api: _Api, args) -> int:
    try:
        description = _read_description(args.description)
    except ValueError as exc:
        print(f"projects: {exc}", file=sys.stderr)
        return 2
    body: dict[str, Any] = {
        "goal": args.goal,
        "description": description,
        "host_profile": args.host_profile,
        "outputs": [{"title": t} for t in args.output],
    }
    if args.name:
        body["name"] = args.name
    if args.cadence:
        body["cadence"] = args.cadence
    if args.audience:
        body["target_audience"] = args.audience
    if args.goal_id:
        body["goal_link"] = {"ref": args.goal_id}
    resp = api.request("POST", "/", json_body=body)
    if resp.status_code != 200:
        return _fail(resp)
    project = resp.json()
    if args.json:
        _print_json(project)
    else:
        print(
            f"Created project {project.get('slug')} [{project.get('status')}]"
        )
        print(
            "It starts in planning — activate it on /projects or with "
            "`hermes projects` once the record is complete."
        )
    return 0


def _cmd_link(api: _Api, args) -> int:
    body: dict[str, Any] = {"kind": args.kind, "ref": args.ref}
    if args.profile:
        body["profile"] = args.profile
    if args.label:
        body["label"] = args.label
    resp = api.request("POST", f"/{args.slug}/links", json_body=body)
    if resp.status_code != 200:
        return _fail(resp)
    if args.json:
        _print_json(resp.json())
    else:
        print(f"Linked {args.kind}:{args.ref} to {args.slug}.")
    return 0


def _cmd_outputs(api: _Api, args) -> int:
    slug = args.slug
    action = args.outputs_action or "list"
    if action == "list":
        resp = api.request("GET", f"/{slug}")
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json({"outputs": data.get("outputs") or []})
            return 0
        for o in data.get("outputs") or []:
            req = "" if o.get("required") else " (optional)"
            deliveries = o.get("deliveries") or []
            print(
                f"[{o.get('status')}] {o.get('title')}{req}  "
                f"({o.get('id')})  {len(deliveries)} delivery(ies)"
            )
        return 0
    if action == "add":
        title = args.title_or_id
        if not title:
            print(
                "projects: outputs add needs the output's title",
                file=sys.stderr,
            )
            return 2
        body: dict[str, Any] = {
            "title": title,
            "required": not args.optional,
        }
        if args.spec:
            body["spec"] = args.spec
        if args.recurring:
            body["recurring"] = True
        resp = api.request("POST", f"/{slug}/outputs", json_body=body)
        if resp.status_code != 200:
            return _fail(resp)
        row = resp.json()
        if args.json:
            _print_json(row)
        else:
            print(f"Added output '{row.get('title')}' ({row.get('id')}).")
        return 0
    if action in ("deliver", "accept"):
        output_id = args.title_or_id
        if not output_id:
            print(
                f"projects: outputs {action} needs the output id",
                file=sys.stderr,
            )
            return 2
    if action == "deliver":
        if not args.ref:
            print(
                "projects: outputs deliver needs --ref (the delivery pointer)",
                file=sys.stderr,
            )
            return 2
        body = {"link_ref": args.ref}
        if args.note:
            body["note"] = args.note
        # Run inside a kanban worker, the delivery belongs to that card (and
        # through it, to the card's run).
        task_id = args.task or os.environ.get("HERMES_KANBAN_TASK")
        if task_id:
            body["task_id"] = task_id
        if args.run:
            body["run_id"] = args.run
        if os.environ.get("HERMES_KANBAN_TASK") and os.environ.get("HERMES_PROFILE"):
            body["profile"] = os.environ["HERMES_PROFILE"]
        resp = api.request(
            "POST", f"/{slug}/outputs/{output_id}/deliver", json_body=body
        )
        if resp.status_code != 200:
            return _fail(resp)
        if args.json:
            _print_json(resp.json())
        else:
            print(f"Delivered output {output_id}.")
        return 0
    if action == "accept":
        resp = api.request(
            "POST", f"/{slug}/outputs/{output_id}/accept", json_body={}
        )
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
        else:
            print(f"Accepted output {output_id}.")
            if data.get("offers_closure"):
                print(
                    "Every required output is now accepted — this one-off "
                    "project offers closure (decide it on /projects)."
                )
        return 0
    print(f"projects: unknown outputs action: {action}", file=sys.stderr)
    return 2


def _cmd_contacts(api: _Api, args) -> int:
    slug = args.slug
    action = args.contacts_action or "list"
    if action == "list":
        resp = api.request("GET", f"/{slug}")
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json({"contacts": data.get("contacts") or []})
            return 0
        contacts = data.get("contacts") or []
        if not contacts:
            print("No contacts.")
        for c in contacts:
            bits = [c.get("name") or "(unnamed)"]
            if c.get("role"):
                bits.append(f"({c['role']})")
            if c.get("platform"):
                bits.append(f"on {c['platform']}")
            if c.get("address"):
                bits.append(f"<{c['address']}>")
            print("  " + " ".join(bits) + f"  ({c.get('id')})")
        return 0
    if action == "add":
        body: dict[str, Any] = {"name": args.name}
        if args.role:
            body["role"] = args.role
        if args.platform:
            body["platform"] = args.platform
        if args.address:
            body["address"] = args.address
        resp = api.request("POST", f"/{slug}/contacts", json_body=body)
        if resp.status_code != 200:
            return _fail(resp)
        row = resp.json()
        if args.json:
            _print_json(row)
        else:
            print(f"Added contact '{row.get('name')}' ({row.get('id')}).")
        return 0
    print(f"projects: unknown contacts action: {action}", file=sys.stderr)
    return 2


def _cmd_tools(api: _Api, args) -> int:
    slug = args.slug
    action = args.tools_action or "show"
    if action == "show":
        resp = api.request("GET", f"/{slug}")
        if resp.status_code != 200:
            return _fail(resp)
        d = resp.json()
        if args.json:
            _print_json(
                {"toolsets": d.get("toolsets"), "skills": d.get("skills")}
            )
            return 0
        toolsets = d.get("toolsets") or "(unset — runs inherit the host profile)"
        skills = d.get("skills") or "(unset)"
        print(f"toolsets: {toolsets}")
        print(f"skills:   {skills}")
        print("A narrowing filter, never a grant (§4.1).")
        return 0
    if action == "set":
        body: dict[str, Any] = {}
        if args.toolsets is not None:
            body["toolsets"] = _csv(args.toolsets)
        if args.skills is not None:
            body["skills"] = _csv(args.skills)
        if not body:
            print(
                "projects: set needs --toolsets and/or --skills",
                file=sys.stderr,
            )
            return 2
        resp = api.request("PATCH", f"/{slug}/tools", json_body=body)
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
            return 0
        print(f"effective toolsets: {', '.join(data.get('effective_toolsets') or []) or '(none)'}")
        if data.get("dropped_toolsets"):
            print(
                "dropped (host profile does not enable them): "
                + ", ".join(data["dropped_toolsets"])
            )
        print(f"effective skills: {', '.join(data.get('effective_skills') or []) or '(none)'}")
        if data.get("dropped_skills"):
            print("dropped skills: " + ", ".join(data["dropped_skills"]))
        return 0
    print(f"projects: unknown tools action: {action}", file=sys.stderr)
    return 2


def _cmd_members(api: _Api, args) -> int:
    slug = args.slug
    if args.add:
        resp = api.request(
            "POST", f"/{slug}/members",
            json_body={"user_id": args.add, "role": args.role},
        )
        if resp.status_code != 200:
            return _fail(resp)
        if args.json:
            _print_json(resp.json())
        else:
            print(f"Added {args.add} as {args.role} on {slug}.")
        return 0
    resp = api.request("GET", f"/{slug}")
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(
            {"members": data.get("members"), "profiles": data.get("profiles")}
        )
        return 0
    for m in data.get("members") or []:
        print(f"  {m.get('user_id')}  [{m.get('role')}]")
    for p in data.get("profiles") or []:
        print(f"  profile {p.get('profile')}  [{p.get('role')}]")
    return 0


def _cmd_card_add(api: _Api, args) -> int:
    body: dict[str, Any] = {"title": args.title}
    if args.assignee:
        body["assignee"] = args.assignee
    if args.from_todo:
        body["from_todo"] = {"id": args.from_todo}
    resp = api.request("POST", f"/{args.slug}/cards", json_body=body)
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
    else:
        extra = " (promoted from to-do)" if data.get("from_todo") else ""
        print(
            f"Card {data.get('task_id')} created in '{data.get('status')}'"
            f"{extra}."
        )
    return 0


def _cmd_playbook(api: _Api, args) -> int:
    slug = args.slug
    action = args.playbook_action or "show"
    if action == "show":
        resp = api.request("GET", f"/{slug}/playbook")
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
            return 0
        active = data.get("active")
        if not active:
            print("No playbook yet — save one with `playbook save <file.json>`.")
        else:
            print(f"active revision {active.get('rev')}")
            if active.get("body"):
                print(active["body"])
            for step in active.get("steps") or []:
                hold = "  (checkpoint)" if step.get("checkpoint") else ""
                after = (
                    f"  after {','.join(step['after'])}"
                    if step.get("after") else ""
                )
                assignee = f"  [{step['assignee']}]" if step.get("assignee") else ""
                print(f"  - {step.get('key')}: {step.get('title')}"
                      f"{assignee}{after}{hold}")
        pending = [r for r in data.get("revisions") or [] if not r.get("active")]
        if pending:
            print("proposed (not active): "
                  + ", ".join(f"rev {r.get('rev')}" for r in pending))
        return 0
    if action == "save":
        if not args.file_or_rev:
            print(
                "projects: playbook save needs the spec file path",
                file=sys.stderr,
            )
            return 2
        try:
            with open(os.path.expanduser(args.file_or_rev), encoding="utf-8") as fh:
                spec = json.load(fh)
        except (OSError, ValueError) as exc:
            print(f"projects: cannot read playbook file: {exc}", file=sys.stderr)
            return 2
        body: dict[str, Any] = {
            "body": spec.get("body") or "",
            "steps": spec.get("steps") or [],
        }
        if args.note:
            body["note"] = args.note
        resp = api.request("POST", f"/{slug}/playbook", json_body=body)
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
        else:
            print(
                f"Saved playbook revision {data.get('rev')} — a proposal. "
                "Activate it with `playbook activate "
                f"{data.get('rev')}`."
            )
        return 0
    if action == "activate":
        if not args.file_or_rev:
            print(
                "projects: playbook activate needs the revision number",
                file=sys.stderr,
            )
            return 2
        try:
            rev = int(args.file_or_rev)
        except ValueError:
            print(
                "projects: playbook activate expects a numeric revision",
                file=sys.stderr,
            )
            return 2
        body = {"note": args.note} if args.note else {}
        resp = api.request(
            "POST", f"/{slug}/playbook/{rev}/activate", json_body=body
        )
        if resp.status_code != 200:
            return _fail(resp)
        print(f"Playbook revision {rev} is now active.")
        return 0
    if action == "toolsets":
        resp = api.request("POST", f"/{slug}/playbook/toolsets", json_body={})
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
            return 0
        filled = set(data.get("filled") or [])
        print(
            f"Saved playbook revision {data.get('rev')} — rev "
            f"{data.get('from_rev')} with tool lists on {len(filled)} step(s):"
        )
        for step in data.get("steps") or []:
            mark = "+" if step.get("key") in filled else " "
            tools = ", ".join(step.get("toolsets") or []) or "(full tool surface)"
            print(f"  {mark} {step.get('key')}: {tools}")
        print(f"Activate it with `playbook activate {data.get('rev')}`.")
        return 0
    print(f"projects: unknown playbook action: {action}", file=sys.stderr)
    return 2


def _cmd_guidance(api: _Api, args) -> int:
    slug = args.slug
    action = args.guidance_action or "list"
    if action == "list":
        resp = api.request("GET", f"/{slug}/directives")
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
            return 0
        directives = data.get("directives") or []
        if not directives:
            print("No standing instructions.")
        for dv in directives:
            print(f"  [{dv.get('kind')}] {dv.get('body')}  ({dv.get('id')})")
        proposed = data.get("proposed") or []
        if proposed:
            print("Proposed by runs — inactive until a member activates:")
            for dv in proposed:
                print(f"  [{dv.get('kind')}] {dv.get('body')}  ({dv.get('id')})")
        print(f"({data.get('applies_from', 'next run')})")
        return 0
    if action == "add":
        if not args.body_or_id:
            print(
                "projects: guidance add needs the instruction body",
                file=sys.stderr,
            )
            return 2
        body: dict[str, Any] = {"body": args.body_or_id, "kind": args.kind}
        resp = api.request("POST", f"/{slug}/directives", json_body=body)
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
        else:
            print(
                f"Added instruction {data.get('id')} — applies from the "
                f"{data.get('applies_from', 'next run')}."
            )
        return 0
    if action == "retire":
        if not args.body_or_id:
            print(
                "projects: guidance retire needs the instruction id",
                file=sys.stderr,
            )
            return 2
        resp = api.request(
            "POST", f"/{slug}/directives/{args.body_or_id}/retire",
            json_body={},
        )
        if resp.status_code != 200:
            return _fail(resp)
        print(f"Retired instruction {args.body_or_id}.")
        return 0
    if action == "activate":
        if not args.body_or_id:
            print(
                "projects: guidance activate needs the proposed instruction id",
                file=sys.stderr,
            )
            return 2
        resp = api.request(
            "POST", f"/{slug}/directives/{args.body_or_id}/activate",
            json_body={},
        )
        if resp.status_code != 200:
            return _fail(resp)
        data = resp.json()
        if args.json:
            _print_json(data)
        else:
            print(
                f"Activated instruction {args.body_or_id} — applies from the "
                f"{data.get('applies_from', 'next run')}."
            )
        return 0
    print(f"projects: unknown guidance action: {action}", file=sys.stderr)
    return 2


def _cmd_score(api: _Api, args) -> int:
    """``score_user`` (§8.1): human-only, editable — the CLI is the
    operator's terminal, the router's session gate does the refusing."""
    body: dict[str, Any] = {"score": args.score}
    if args.note:
        body["note"] = args.note
    resp = api.request(
        "POST", f"/{args.slug}/runs/{args.run_no}/score", json_body=body
    )
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
    else:
        note = f" — {data['score_note']}" if data.get("score_note") else ""
        print(
            f"Scored run {data.get('scored')} of {args.slug}: "
            f"{data.get('score_user')}/5{note}."
        )
    return 0


def _cmd_run(api: _Api, args) -> int:
    slug = args.slug
    if args.dry_run:
        return _run_dry(api, slug, playbook_rev=args.playbook_rev)
    body: dict[str, Any] = {"trigger": args.trigger}
    if args.playbook_rev:
        body["playbook_rev"] = args.playbook_rev
    resp = api.request("POST", f"/{slug}/runs", json_body=body)
    if resp.status_code != 200:
        return _fail(resp)
    data = resp.json()
    if args.json:
        _print_json(data)
        return 0
    run = data.get("run") or {}
    print(f"Run {run.get('run_no')} opened [{run.get('status')}] on {slug}.")
    cards = data.get("cards") or []
    if cards:
        print(f"  {len(cards)} card(s) on the board.")
    if data.get("toolsets_dropped") or data.get("skills_dropped"):
        print(
            "  dropped by the host profile: "
            + ", ".join(
                (data.get("toolsets_dropped") or [])
                + (data.get("skills_dropped") or [])
            )
        )
    if data.get("budget_gate"):
        print(f"  budget gate: {data['budget_gate']}")
    return 0


def _run_dry(api: _Api, slug: str, *, playbook_rev: Optional[int]) -> int:
    """§14: print the cards a run *would* create and the compiled guidance
    block — the single most useful check before turning a schedule on."""
    # The read gate first: an invisible project stays a 404 even in preview.
    resp = api.request("GET", f"/{slug}")
    if resp.status_code != 200:
        return _fail(resp)
    resp = api.request("GET", f"/{slug}/playbook")
    if resp.status_code != 200:
        return _fail(resp)
    playbooks = resp.json()
    playbook = playbooks.get("active")
    if playbook_rev:
        playbook = next(
            (
                r for r in playbooks.get("revisions") or []
                if r.get("rev") == playbook_rev
            ),
            playbook,
        )
    if not playbook or not playbook.get("steps"):
        print(
            "projects: no playbook with steps to preview — save one first.",
            file=sys.stderr,
        )
        return 1

    from hermes_cli import projects_clarify_context, projects_db, projects_run

    with projects_db.connect_closing() as conn:
        project = projects_db.get_project(conn, slug)
        if project is None:
            print(f"projects: no such project: {slug}", file=sys.stderr)
            return 1
        runs = projects_db.list_project_runs(conn, project.id)
        next_run_no = max((r.get("run_no") or 0 for r in runs), default=0) + 1
        guidance = projects_run.compile_guidance(
            project,
            run_no=next_run_no,
            outputs=projects_db.get_project_outputs(conn, project.id),
            deliveries_by_output=projects_run._deliveries_by_output(  # noqa: SLF001
                conn, project.id
            ),
            sample_links=projects_run._sample_links(conn, project.id),  # noqa: SLF001
            directives=projects_db.list_project_directives(conn, project.id),
            last_run=projects_run._previous_run(  # noqa: SLF001
                conn, project.id, next_run_no
            ),
            clarify_lines=projects_clarify_context.clarify_context_lines(
                conn, project.id
            ),
        )
    print(f"# Dry run — what run {next_run_no} of {slug} would start with")
    print("\n## Cards it would create")
    for step in playbook.get("steps") or []:
        hold = "  (checkpoint — holds its successors)" if step.get("checkpoint") else ""
        print(f"  - {step.get('key')}: {step.get('title')}{hold}")
    print("\n## Compiled guidance block")
    print(guidance)
    return 0


# ---------------------------------------------------------------------------
# argparse wiring
# ---------------------------------------------------------------------------


def _run(coro) -> int:
    try:
        return asyncio.run(coro)
    except (RuntimeError, ValueError) as error:
        print(f"projects: {error}", file=sys.stderr)
        return 1


async def _dispatch(args: argparse.Namespace) -> int:
    principal = await _resolve_principal(args.actor)
    api = _Api(principal, as_human=getattr(args, "as_human", False))
    try:
        verb = args.projects_command
        if verb == "list":
            return _cmd_list(api, args)
        if verb == "show":
            return _cmd_show(api, args)
        if verb == "create":
            return _cmd_create(api, args)
        if verb == "link":
            return _cmd_link(api, args)
        if verb == "outputs":
            return _cmd_outputs(api, args)
        if verb == "contacts":
            return _cmd_contacts(api, args)
        if verb == "tools":
            return _cmd_tools(api, args)
        if verb == "members":
            return _cmd_members(api, args)
        if verb == "cards":
            return _cmd_cards(api, args)
        if verb == "card":
            return _cmd_card_add(api, args)
        if verb == "playbook":
            return _cmd_playbook(api, args)
        if verb == "guidance":
            return _cmd_guidance(api, args)
        if verb == "run":
            return _cmd_run(api, args)
        if verb == "runs":
            return _cmd_runs(api, args)
        if verb == "score":
            return _cmd_score(api, args)
        if verb == "retro":
            return _cmd_retro(api, args)
        if verb == "summarise":
            return _cmd_summarise(api, args)
        if verb == "doctor":
            return _cmd_doctor(api, args)
        if verb == "archive":
            return _cmd_archive(api, args)
        if verb == "restore":
            return _cmd_restore(api, args)
        if verb == "delete":
            return _cmd_delete(api, args)
        print(f"projects: unknown command: {verb}", file=sys.stderr)
        return 2
    finally:
        api.close()


def projects_cli_command(args: argparse.Namespace) -> int:
    return _run(_dispatch(args))


def register_projects_subparser(
    subparsers: argparse._SubParsersAction,
) -> None:
    """Register ``hermes projects`` beside ``todos``, ``incomings``, ``goal``."""
    parser = subparsers.add_parser(
        "projects",
        help="Projects: multi-sitting work with cadence, runs and a record",
        description=(
            "The Projects feature's operator surface (design §14). Reads and "
            "writes go through the same permission gate as the HTTP API. "
            "`hermes project` (singular) remains the folder-workspace "
            "command."
        ),
    )
    parser.add_argument(
        "--actor",
        default=None,
        help="Principal to act as (default: the enrolled owner)",
    )
    parser.add_argument(
        "--as-human",
        action="store_true",
        help=(
            "Claim the human-only surface (§8.1/§8.2) for accepting "
            "outputs, scoring runs and activating directives/playbooks. "
            "Use only when you — the operator — are making the judgement "
            "yourself; an agent must never set this on its own say-so."
        ),
    )
    sub = parser.add_subparsers(dest="projects_command", required=True)

    json_flag = {"action": "store_true", "help": "Machine-readable JSON output"}

    listing = sub.add_parser("list", aliases=["ls"], help="Readable projects")
    listing.add_argument("--status", default="", help="planning|active|paused|done")
    listing.add_argument("--cadence", default="", help="one_off|repeatable|standing")
    listing.add_argument("--health", default="", help="ok|attention|stalled")
    listing.add_argument("--archived", action="store_true")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--json", **json_flag)

    show = sub.add_parser("show", help="The whole record in one read")
    show.add_argument("slug")
    show.add_argument("--json", **json_flag)

    create = sub.add_parser(
        "create",
        help="Create a project under the §2.2 mandatory contract",
        description=(
            "Refused without goal, description, at least one output and a "
            "host profile. --description reads a file or '-' for stdin."
        ),
    )
    create.add_argument("goal", help="The outcome sentence (≤160 chars)")
    create.add_argument(
        "--description", required=True, help="The brief: a file path or '-'"
    )
    create.add_argument(
        "--output", action="append", required=True, dest="output",
        help="A declared output title (repeatable)",
    )
    create.add_argument("--name", default=None, help="Short label (defaults from goal)")
    create.add_argument(
        "--cadence", default=None, choices=["one_off", "repeatable", "standing"]
    )
    create.add_argument(
        "--host-profile", default="default", help="The profile runs start in"
    )
    create.add_argument("--audience", default=None, help="Who the outputs are for")
    create.add_argument("--goal-id", default=None, help="Linked FG-29 goal id")
    create.add_argument("--json", **json_flag)

    link = sub.add_parser("link", help="Attach a pointer to a project")
    link.add_argument("slug")
    link.add_argument(
        "--kind", required=True,
        help="file|arrival|todo|goal|memory|conversation|url|sample|reference",
    )
    link.add_argument("--ref", required=True, help="The id or path it points at")
    link.add_argument("--profile", default=None)
    link.add_argument("--label", default=None)
    link.add_argument("--json", **json_flag)

    outputs = sub.add_parser("outputs", help="Declared outputs lifecycle")
    outputs.add_argument("slug")
    outputs.add_argument(
        "outputs_action", nargs="?", default="list",
        choices=["list", "add", "deliver", "accept"],
    )
    outputs.add_argument("title_or_id", nargs="?", default="")
    outputs.add_argument("--spec", default=None)
    outputs.add_argument("--optional", action="store_true")
    outputs.add_argument("--recurring", action="store_true")
    outputs.add_argument("--ref", default=None, help="Delivery pointer")
    outputs.add_argument("--note", default=None)
    outputs.add_argument(
        "--task", default=None,
        help="Card that produced it (default: $HERMES_KANBAN_TASK)",
    )
    outputs.add_argument(
        "--run", default=None,
        help="Run id it belongs to (default: the card's run)",
    )
    outputs.add_argument("--json", **json_flag)

    contacts = sub.add_parser("contacts", help="People the work involves")
    contacts.add_argument("slug")
    contacts.add_argument(
        "contacts_action", nargs="?", default="list", choices=["list", "add"]
    )
    contacts.add_argument("name", nargs="?", default="")
    contacts.add_argument("--role", default=None)
    contacts.add_argument("--platform", default=None)
    contacts.add_argument("--address", default=None)
    contacts.add_argument("--json", **json_flag)

    tools = sub.add_parser(
        "tools", help="Toolsets/skills narrowing (never a grant)"
    )
    tools.add_argument("slug")
    tools.add_argument(
        "tools_action", nargs="?", default="show", choices=["show", "set"]
    )
    tools.add_argument("--toolsets", default=None, help="Comma-separated names")
    tools.add_argument("--skills", default=None, help="Comma-separated names")
    tools.add_argument("--json", **json_flag)

    members = sub.add_parser("members", help="Participants: people + profiles")
    members.add_argument("slug")
    members.add_argument("--add", default=None, help="User id to add")
    members.add_argument(
        "--role", default="member", choices=["lead", "member", "viewer"]
    )
    members.add_argument("--json", **json_flag)

    cards = sub.add_parser("cards", help="The project's board")
    cards.add_argument("slug")
    cards.add_argument("--status", default="")
    cards.add_argument("--json", **json_flag)

    card = sub.add_parser("card", help="Card actions")
    card.add_argument("card_action", choices=["add"])
    card.add_argument("slug")
    card.add_argument("title")
    card.add_argument("--assignee", default=None)
    card.add_argument(
        "--from-todo", default=None,
        help="Promote this to-do into the card (§10)",
    )
    card.add_argument("--json", **json_flag)

    playbook = sub.add_parser("playbook", help="The plan (prose + step DAG)")
    playbook.add_argument("slug")
    playbook.add_argument(
        "playbook_action", nargs="?", default="show",
        choices=["show", "save", "activate", "toolsets"],
    )
    playbook.add_argument("file_or_rev", nargs="?", default="")
    playbook.add_argument("--note", default=None)
    playbook.add_argument("--json", **json_flag)

    guidance = sub.add_parser("guidance", help="Standing instructions (§5)")
    guidance.add_argument("slug")
    guidance.add_argument(
        "guidance_action", nargs="?", default="list",
        choices=["list", "add", "retire", "activate"],
    )
    guidance.add_argument("body_or_id", nargs="?", default="")
    guidance.add_argument(
        "--kind", default="directive", choices=["directive", "feedback"]
    )
    guidance.add_argument("--json", **json_flag)

    run = sub.add_parser(
        "run",
        help="Start a run now (what the cron job calls)",
        description=(
            "--dry-run prints the cards the run would create and the "
            "compiled guidance block, without opening anything."
        ),
    )
    run.add_argument("slug")
    run.add_argument(
        "--trigger", default="manual",
        choices=["schedule", "manual", "event", "review"],
    )
    run.add_argument("--playbook-rev", type=int, default=None)
    run.add_argument("--dry-run", action="store_true")
    run.add_argument("--json", **json_flag)

    runs = sub.add_parser("runs", help="The run record")
    runs.add_argument("slug")
    runs.add_argument("--limit", type=int, default=10)
    runs.add_argument("--json", **json_flag)

    score = sub.add_parser(
        "score",
        help="Score a run 1–5 (human-only, editable, §8.1)",
    )
    score.add_argument("slug")
    score.add_argument("run_no", type=int)
    score.add_argument("score", type=int, choices=range(1, 6), metavar="1-5")
    score.add_argument("--note", default=None, help="Why that score")
    score.add_argument("--json", **json_flag)

    retro = sub.add_parser("retro", help="A run's retrospective")
    retro.add_argument("slug")
    retro.add_argument("run_no", type=int)
    retro.add_argument(
        "--write", action="store_true", help="Read the retro from stdin"
    )
    retro.add_argument(
        "--propose", action="append", default=[],
        metavar="KIND=BODY",
        help=(
            "A concrete proposal (repeatable, max 3 — §8.1): kind is "
            "playbook, directive or skill; it lands inactive (§8.2)"
        ),
    )
    retro.add_argument("--json", **json_flag)

    summarise = sub.add_parser(
        "summarise",
        help="Write the rolling 'where this stands' summary (stdin)",
    )
    summarise.add_argument("slug")
    summarise.add_argument("--json", **json_flag)

    doctor = sub.add_parser(
        "doctor", help="Diagnosable breaks (broken schedules, stalls)"
    )
    doctor.add_argument("--slug", default=None)
    doctor.add_argument("--json", **json_flag)

    archive = sub.add_parser(
        "archive",
        help="Shelve a project — reversible, keeps the record, stops it "
             "running (§13)",
    )
    archive.add_argument("slug")
    archive.add_argument(
        "--reason", default=None, help="Why it is being shelved (recorded)"
    )
    archive.add_argument("--json", **json_flag)

    restore = sub.add_parser(
        "restore", help="Bring an archived project back (lands in 'paused')"
    )
    restore.add_argument("slug")
    restore.add_argument("--json", **json_flag)

    delete = sub.add_parser(
        "delete",
        help="Hard delete — only for the genuinely empty mistake "
             "(needs --as-human and --confirm <slug>)",
    )
    delete.add_argument("slug")
    delete.add_argument(
        "--confirm", required=True, help="Must equal the project slug"
    )
    delete.add_argument("--json", **json_flag)

    parser.set_defaults(func=projects_cli_command)


__all__ = ["projects_cli_command", "register_projects_subparser"]
