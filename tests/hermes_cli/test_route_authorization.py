"""Every dashboard API route says who may call it (security review F2).

The dashboard-auth gate only proves someone is signed in. This test walks the
real route table (``iter_route_contexts`` sees routes inside included routers
and mounted plugins too) and requires each route to be exactly one of:

* declared with a role dependency (``dependencies=_ADMIN`` / ``_OWNER`` /
  ``_TOOLS_MANAGER`` — see ``hermes_cli.route_roles``),
* in ``PUBLIC`` (no sign-in needed),
* in ``SIGNED_IN`` (any signed-in user; the handler scopes data to them), or
* in ``HANDLER_CHECKED`` (the handler enforces the role itself; the named
  check must still be in its source).

A new route that is none of these fails ``test_every_route_declares_who_may_call_it``.
The behaviour tests below send real requests as a member, viewer, admin, owner
and a no-login operator against a throwaway ``HERMES_HOME``.
"""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace

import pytest

OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)
MEMBER = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
VIEWER = SimpleNamespace(user_id="tom", display="Tom", role="viewer", is_owner=False)

#: No sign-in needed (matches ``dashboard_auth`` public paths / SPA shell).
PUBLIC = {
    "GET /api/status",
    "GET /api/config/defaults",
    "GET /api/config/schema",
    "GET /api/model/info",
    "GET /api/dashboard/themes",
    "GET /api/dashboard/plugins",
    "POST /api/cron/fire",
    "POST /api/auth/invitations/redeem",
    "POST /api/auth/invitations/request",
    "POST /api/seminar/survey/state",
    "POST /api/seminar/survey/submit",
    "GET /login",
    "GET /api/auth/providers",
    "GET /auth/login",
    "GET /auth/callback",
    "POST /auth/password-login",
    "POST /auth/logout",
    "GET /{full_path:path}",
    # first_run: one-time owner setup link; refuses everything without a token file
    "POST /api/setup/check",
    "POST /api/setup/owner",
    "POST /api/setup/model",
    "POST /api/setup/region",
    "POST /api/setup/domain",
}

#: The handler enforces the role itself: route -> (role, check in its source).
HANDLER_CHECKED = {
    "POST /api/comms/members": ("admin", "_comms_member_service"),
    "POST /api/comms/members/import": ("admin", "_comms_member_service"),
    "POST /api/comms/members/{user_id}/invitation": ("admin", "_comms_member_service"),
    "DELETE /api/comms/members/{user_id}/invitation": ("admin", "_comms_member_service"),
    "PUT /api/comms/members/{user_id}/role": ("admin", "_comms_member_service"),
    "PUT /api/comms/members/{user_id}/display": ("admin", "_comms_member_service"),
    "POST /api/comms/members/{user_id}/channels": ("admin", "_comms_member_service"),
    "DELETE /api/comms/members/{user_id}/channels": ("admin", "_comms_member_service"),
    "GET /api/comms/members/activity": ("admin", "_comms_member_service"),
    "POST /api/comms/members/{user_id}/deactivate": ("admin", "_comms_set_member_active"),
    "POST /api/comms/members/{user_id}/activate": ("admin", "_comms_set_member_active"),
    "DELETE /api/comms/members/{user_id}": ("owner", "_comms_member_service"),
    "PUT /api/access/roles/{role}": ("admin", "_require_role_limits_editor"),
    "POST /api/profiles/suggestions/{suggestion_id}/adopt": ("owner", "principal.is_owner"),
    "POST /api/profiles/suggestions/{suggestion_id}/dismiss": ("owner", "principal.is_owner"),
    "GET /api/email-accounts": ("owner", "_owner_principal"),
    "PATCH /api/email-accounts": ("owner", "_owner_principal"),
    # wa_bridge_api: only the person a bridge belongs to (bridge-owners.json;
    # unrecorded bridges = the install owner) sees its QR or controls it
    "GET /api/wa-bridges/{name}/qr": ("bridge person", "_require_bridge_person"),
    "POST /api/wa-bridges/{name}/restart": ("bridge person", "_require_bridge_person"),
    "POST /api/wa-bridges/{name}/stop": ("bridge person", "_require_bridge_person"),
    "POST /api/wa-bridges/{name}/rebind": ("bridge person", "_require_bridge_person"),
    "POST /api/wa-bridges/{name}/test": ("bridge person", "_require_bridge_person"),
    "PATCH /api/registry/goals/entity": ("owner", "principal.is_owner"),
    "GET /api/internal/vpn/folders": ("internal", "_require_app_mcp"),
    "POST /api/internal/vpn/folders/ensure": ("internal", "_require_app_mcp"),
    "POST /api/internal/vpn/folders/import": ("internal", "_require_app_mcp"),
    "WS /api/pty": ("admin", "_ws_ticket_is_admin"),
    "WS /api/ws": ("admin", "_ws_ticket_is_admin"),
    "WS /api/pub": ("admin", "_ws_ticket_is_admin"),
}

#: Any signed-in user; the handler limits what they see or change to their own
#: data (chat scope, principal, project membership).
SIGNED_IN = {
    # user_prefs: the acting person's own language; no user id is taken from the request
    "GET /api/me/preferences",
    "PUT /api/me/preferences",
    # own login only (session subject, never a body id): password + two-factor
    "GET /api/account/security",
    "POST /api/account/password",
    "POST /api/account/two-factor/start",
    "POST /api/account/two-factor/confirm",
    "POST /api/account/two-factor/disable",
    "POST /api/account/two-factor/recovery-codes",
    # fastapi.applications: API schema pages
    "GET /openapi.json",
    "GET /docs",
    "GET /docs/oauth2-redirect",
    "GET /redoc",
    # capacity: free space on the upload disk (read)
    "GET /api/capacity/upload-storage",
    # memory_oauth: memory-provider OAuth status (read)
    "GET /api/memory/providers/{provider}/oauth/status",
    # memory_explorer: memory rows filtered to what the caller may read
    "GET /api/memory/explorer/summary",
    "GET /api/memory/explorer/rows",
    "GET /api/memory/explorer/projection",
    "POST /api/memory/explorer/projection/query",
    "GET /api/memory/explorer/documents",
    # files_api: file registry rows scoped to the caller
    "GET /api/registry/files",
    "GET /api/registry/files/surfaces",
    "POST /api/registry/files/register",
    "GET /api/registry/files/by-path",
    "GET /api/registry/files/{asset_id}",
    "GET /api/registry/files/{asset_id}/link",
    # incomings_api: incomings scoped to the caller
    "GET /api/registry/incomings",
    "GET /api/registry/incomings/facets",
    "GET /api/registry/incomings/{item_id}",
    "POST /api/registry/incomings/{item_id}/tags",
    "DELETE /api/registry/incomings/{item_id}/tags/{tag_id}",
    "POST /api/registry/incomings/{item_id}/remember",
    # todos_api: to-dos scoped to the caller
    "GET /api/registry/todos",
    "GET /api/registry/todos/facets",
    "POST /api/registry/todos",
    "GET /api/registry/todos/{todo_id}",
    "POST /api/registry/todos/{todo_id}/start",
    "PATCH /api/registry/todos/{todo_id}",
    "POST /api/registry/todos/{todo_id}/stage",
    "POST /api/registry/todos/{todo_id}/complete",
    "POST /api/registry/todos/{todo_id}/snooze",
    "POST /api/registry/todos/{todo_id}/promote",
    # personal_mcp: the caller's own MCP servers (owner checks in the handler)
    "GET /api/mcp/personal",
    "POST /api/mcp/personal",
    "DELETE /api/mcp/personal/{name}",
    "POST /api/mcp/personal/{name}/test",
    "GET /api/mcp/personal/catalog",
    "POST /api/mcp/personal/{name}/oauth/start",
    "GET /api/mcp/personal/{name}/oauth/status",
    "POST /api/mcp/personal/{name}/oauth/redirect",
    "POST /api/mcp/personal/{name}/oauth/cancel",
    # credentials_api: the caller's own credentials
    "GET /api/credentials",
    "GET /api/credentials/{provider}/{name}",
    "PUT /api/credentials/{provider}/{name}",
    "PATCH /api/credentials/{provider}/{name}",
    "DELETE /api/credentials/{provider}/{name}",
    # email_mailboxes_api: the caller's own IMAP/SMTP mailboxes
    "GET /api/email/mailboxes",
    "PUT /api/email/mailboxes/{address}",
    "DELETE /api/email/mailboxes/{address}",
    "POST /api/email/mailboxes/{address}/test",
    "POST /api/credentials/google/start",
    "POST /api/credentials/google/complete",
    "POST /api/credentials/google/{name}/refresh",
    # telegram_bot_api: the caller's own Telegram bot
    "GET /api/telegram-bot",
    "PUT /api/telegram-bot",
    "DELETE /api/telegram-bot",
    "POST /api/telegram-bot/test",
    "POST /api/telegram-bot/link/start",
    "POST /api/telegram-bot/link/check",
    "DELETE /api/telegram-bot/link",
    # wa_bridge_api: the caller's own bridges (others' only as a status for
    # owner/admin); adding one makes it the caller's
    "GET /api/wa-bridges",
    "POST /api/wa-bridges",
    # vpn_api: the caller's own VPN folders
    "GET /api/vpn/folders",
    "POST /api/vpn/folders",
    "PUT /api/vpn/folders/{name}",
    "DELETE /api/vpn/folders/{name}",
    "POST /api/vpn/folders/{name}/test",
    "POST /api/vpn/folders/{name}/disconnect",
    "GET /api/vpn",
    "POST /api/vpn/{name}/connect",
    "POST /api/vpn/{name}/disconnect",
    "POST /api/vpn/{name}/test",
    "POST /api/vpn/{name}/trust",
    # goals_api: goal reads
    "GET /api/registry/goals/entity",
    "GET /api/registry/goals/purpose",
    # projects_api: project membership and project role checked per project
    "GET /api/registry/projects",
    "POST /api/registry/projects",
    "GET /api/registry/projects/doctor",
    "GET /api/registry/projects/{slug}",
    "PATCH /api/registry/projects/{slug}",
    "POST /api/registry/projects/{slug}/archive",
    "POST /api/registry/projects/{slug}/restore",
    "DELETE /api/registry/projects/{slug}",
    "POST /api/registry/projects/{slug}/outputs",
    "PATCH /api/registry/projects/{slug}/outputs/{output_id}",
    "DELETE /api/registry/projects/{slug}/outputs/{output_id}",
    "POST /api/registry/projects/{slug}/outputs/{output_id}/deliver",
    "POST /api/registry/projects/{slug}/outputs/{output_id}/accept",
    "POST /api/registry/projects/{slug}/members",
    "DELETE /api/registry/projects/{slug}/members/{user_id}",
    "POST /api/registry/projects/{slug}/profiles",
    "DELETE /api/registry/projects/{slug}/profiles/{name}",
    "POST /api/registry/projects/{slug}/contacts",
    "PATCH /api/registry/projects/{slug}/contacts/{contact_id}",
    "DELETE /api/registry/projects/{slug}/contacts/{contact_id}",
    "POST /api/registry/projects/{slug}/links",
    "DELETE /api/registry/projects/{slug}/links",
    "GET /api/registry/projects/{slug}/board",
    "GET /api/registry/projects/{slug}/events",
    "POST /api/registry/projects/{slug}/summarise",
    "POST /api/registry/projects/{slug}/cards",
    "GET /api/registry/projects/{slug}/cards/{task_id}",
    "GET /api/registry/projects/{slug}/cards/{task_id}/stream",
    "PATCH /api/registry/projects/{slug}/cards/{task_id}",
    "POST /api/registry/projects/{slug}/cards/{task_id}/reclaim",
    "POST /api/registry/projects/{slug}/cards/{task_id}/stop",
    "GET /api/registry/projects/{slug}/playbook",
    "POST /api/registry/projects/{slug}/playbook",
    "POST /api/registry/projects/{slug}/playbook/toolsets",
    "POST /api/registry/projects/{slug}/playbook/draft",
    "GET /api/registry/projects/{slug}/playbook/draft",
    "POST /api/registry/projects/{slug}/playbook/{rev}/activate",
    "DELETE /api/registry/projects/{slug}/playbook/{rev}",
    "GET /api/registry/projects/{slug}/directives",
    "POST /api/registry/projects/{slug}/directives",
    "POST /api/registry/projects/{slug}/directives/{directive_id}/retire",
    "POST /api/registry/projects/{slug}/directives/{directive_id}/activate",
    "GET /api/registry/projects/{slug}/runs",
    "GET /api/registry/projects/{slug}/runs/{run_no}",
    "POST /api/registry/projects/{slug}/runs",
    "POST /api/registry/projects/{slug}/runs/{run_no}/continue",
    "POST /api/registry/projects/{slug}/runs/{run_no}/resume",
    "POST /api/registry/projects/{slug}/runs/{run_no}/cancel",
    "GET /api/registry/projects/{slug}/runs/{run_no}/stream",
    "GET /api/registry/projects/{slug}/events/stream",
    "GET /api/registry/projects/{slug}/runs/{run_no}/activity",
    "POST /api/registry/projects/{slug}/runs/{run_no}/stop",
    "POST /api/registry/projects/{slug}/runs/{run_no}/retro",
    "POST /api/registry/projects/{slug}/runs/{run_no}/score",
    "PATCH /api/registry/projects/{slug}/tools",
    "PATCH /api/registry/projects/{slug}/autonomy",
    "PUT /api/registry/projects/{slug}/schedule",
    "DELETE /api/registry/projects/{slug}/schedule",
    "GET /api/registry/projects/{slug}/doctor",
    # projects_ask_api: project membership checked per project
    "POST /api/registry/projects/{slug}/ask",
    # projects_clarify_api: project membership checked per project
    "GET /api/registry/projects/{slug}/clarify",
    "POST /api/registry/projects/{slug}/clarify/questions",
    "POST /api/registry/projects/{slug}/clarify/answers",
    "POST /api/registry/projects/{slug}/clarify/confirm",
    # projects_outputs_api: project membership checked per project
    "GET /api/registry/projects/{slug}/artifacts",
    "GET /api/registry/projects/{slug}/artifacts/{artifact_id}/content",
    # projects_live_api: project membership checked per project
    "GET /api/registry/projects/{slug}/cards/{task_id}/activity",
    # projects_changes_api: project membership checked per project
    "GET /api/registry/projects/{slug}/changes",
    "POST /api/registry/projects/{slug}/changes",
    "POST /api/registry/projects/{slug}/changes/{change_id}/draft",
    "POST /api/registry/projects/{slug}/changes/{change_id}/approve",
    # projects_board_api: project membership checked per project
    "GET /api/registry/projects/{slug}/board/context",
    "POST /api/registry/projects/{slug}/cards/approve",
    "POST /api/registry/projects/{slug}/cards/{task_id}/unblock",
    "POST /api/registry/projects/{slug}/cards/{task_id}/approvals",
    # web_server: reads, and per-user chat/notification/goal/audio actions scoped by the handler
    "GET /api/media",
    "GET /api/system/stats",
    "GET /api/curator",
    "GET /api/learning/graph",
    "GET /api/learning/node",
    "GET /api/portal",
    "GET /api/comms/whoami",
    "GET /api/comms/members",
    "GET /api/comms/directory",
    "GET /api/comms/notifications",
    "POST /api/comms/notifications/{notification_id}/answer",
    "GET /api/comms/goals",
    "POST /api/comms/goals",
    "PUT /api/comms/goals/{goal_id}/priority",
    "POST /api/comms/goals/{goal_id}/links",
    "POST /api/comms/goals/{goal_id}/advance",
    "POST /api/comms/goals/{goal_id}/close",
    "GET /api/comms/goals/{goal_id}/context",
    "GET /api/comms/changes",
    "GET /api/comms/traces",
    "GET /api/comms/traces/{trace_id}",
    "GET /api/core/manifest",
    "GET /api/gts/graph",
    "GET /api/webview/session",
    "POST /api/webview/session",
    "DELETE /api/webview/session",
    "POST /api/webview/action",
    "POST /api/webview/approval/{approval_id}",
    "POST /api/comms/changes/{change_ref}/undo",
    "POST /api/comms/changes/{change_ref}/redo",
    "GET /api/comms/memory",
    "GET /api/hermes/update/check",
    "POST /api/audio/transcribe",
    "GET /api/audio/elevenlabs/voices",
    "POST /api/audio/speak",
    "GET /api/sessions",
    "GET /api/profiles/sessions",
    "GET /api/sessions/search",
    "GET /api/config",
    "GET /api/onboarding/readiness",
    "GET /api/model/options",
    "GET /api/model/recommended-default",
    "GET /api/model/auxiliary",
    "GET /api/model/moa",
    "POST /api/sessions/bulk-delete",
    "GET /api/sessions/empty/count",
    "DELETE /api/sessions/empty",
    "GET /api/sessions/stats",
    "GET /api/sessions/lead",
    "GET /api/sessions/tags",
    "POST /api/sessions/tags",
    "DELETE /api/sessions/tags/{tag_id}",
    "GET /api/sessions/{session_id}",
    "GET /api/sessions/{session_id}/latest-descendant",
    "GET /api/sessions/{session_id}/messages",
    "GET /api/sessions/{session_id}/tags",
    "POST /api/sessions/{session_id}/tags",
    "DELETE /api/sessions/{session_id}/tags/{tag_id}",
    "POST /api/sessions/{session_id}/tags/suggest",
    "POST /api/sessions/{session_id}/chat",
    "POST /api/sessions/{session_id}/chat/stream",
    "GET /api/sessions/{session_id}/active_run",
    "POST /api/sessions/{session_id}/chat/stream/attach",
    "POST /api/sessions/{session_id}/chat/stream/cancel",
    "POST /v1/runs/{run_id}/approval",
    "POST /api/sessions",
    "DELETE /api/sessions/{session_id}",
    "PATCH /api/sessions/{session_id}",
    "GET /api/sessions/{session_id}/export",
    "POST /api/sessions/prune",
    "GET /api/cron/jobs",
    "GET /api/mcp/servers",
    "GET /api/mcp/servers/{name}/oauth/status",
    "GET /api/tools",
    "GET /api/tools/{name}/health",
    "GET /api/tools/changes",
    "GET /api/mcp/catalog",
    "GET /api/memory",
    "GET /api/skills/hub/sources",
    "GET /api/skills/hub/search",
    "GET /api/skills/hub/preview",
    "GET /api/skills/hub/scan",
    "GET /api/profiles",
    "GET /api/profiles/active",
    "GET /api/profiles/{name}/soul",
    "GET /api/capacity",
    "GET /api/profiles/suggestions",
    "GET /api/skills",
    "GET /api/skills/content",
    "GET /api/tools/toolsets",
    "GET /api/access/roles",
    "GET /api/tools/toolsets/{name}/config",
    "GET /api/tools/computer-use/status",
    "GET /api/analytics/usage",
    "GET /api/analytics/models",
    "GET /api/analytics/models/performance",
    "WS /api/events",
    "GET /api/dashboard/font",
    "GET /dashboard-plugins/{plugin_name}/{file_path:path}",
    # dashboard_auth.routes: the caller's own login session
    "GET /api/auth/me",
    "POST /api/auth/ws-ticket",
}


def _route_keys(route):
    methods = getattr(route, "methods", None)
    if not methods:
        return [f"WS {route.path}"]
    return [f"{m} {route.path}" for m in sorted(methods) if m != "HEAD"]


def _route_contexts(routes) -> list:
    """Every effective route. Newer FastAPI keeps included routers nested
    (``iter_route_contexts`` walks them); older FastAPI copies them flat into
    ``app.routes`` with the router's dependencies merged in."""
    try:
        from fastapi.routing import iter_route_contexts
    except ImportError:
        return [r for r in routes if hasattr(r, "path") and hasattr(r, "endpoint")]
    return list(iter_route_contexts(routes))


def undeclared_routes(app) -> list[str]:
    """Routes in ``app`` that declare no role and are in no allowlist."""
    from hermes_cli.route_roles import declared_role

    missing = []
    for ctx in _route_contexts(app.routes):
        if declared_role(ctx):
            continue
        for key in _route_keys(ctx):
            if key not in PUBLIC and key not in SIGNED_IN and key not in HANDLER_CHECKED:
                missing.append(key)
    return missing


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    try:
        import hermes_constants

        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    except (ImportError, AttributeError):
        pass
    return tmp_path


def _contexts():
    from hermes_cli.web_server import app

    return _route_contexts(app.routes)


def test_every_route_declares_who_may_call_it():
    from hermes_cli.web_server import app

    missing = undeclared_routes(app)
    assert not missing, (
        "These routes say nothing about who may call them. Add "
        "dependencies=_ADMIN (or _OWNER) for anything that changes the whole "
        "profile or reaches the host, or list them in PUBLIC / SIGNED_IN / "
        f"HANDLER_CHECKED in this test with a reason: {missing}"
    )


def test_a_new_route_without_a_role_is_caught():
    """Proof the check fails closed: an unlisted route on a real app is reported."""
    from fastapi import APIRouter, FastAPI

    from hermes_cli.route_roles import ADMIN

    app = FastAPI()
    router = APIRouter()

    @app.put("/api/brand-new-setting")
    async def brand_new_setting():
        return {}

    @app.put("/api/brand-new-gated-setting", dependencies=ADMIN)
    async def brand_new_gated_setting():
        return {}

    @router.post("/api/brand-new-router-thing")
    async def brand_new_router_thing():
        return {}

    app.include_router(router)
    missing = undeclared_routes(app)
    assert "PUT /api/brand-new-setting" in missing
    assert "POST /api/brand-new-router-thing" in missing
    assert "PUT /api/brand-new-gated-setting" not in missing


def test_allowlists_have_no_stale_or_double_entries():
    from hermes_cli.route_roles import declared_role

    declared, undeclared = set(), set()
    for ctx in _contexts():
        (declared if declared_role(ctx) else undeclared).update(_route_keys(ctx))
    listed = PUBLIC | SIGNED_IN | set(HANDLER_CHECKED)
    assert not (listed - undeclared - declared), sorted(listed - undeclared - declared)
    assert not (listed & declared), (
        "already declare a role; drop them from the allowlist",
        sorted(listed & declared),
    )
    assert not (PUBLIC & SIGNED_IN) and not (PUBLIC & set(HANDLER_CHECKED))
    assert not (SIGNED_IN & set(HANDLER_CHECKED))


def test_handler_checked_routes_still_contain_their_check():
    for ctx in _contexts():
        for key in _route_keys(ctx):
            if key in HANDLER_CHECKED:
                _role, marker = HANDLER_CHECKED[key]
                assert marker in inspect.getsource(ctx.endpoint), (key, marker)


def test_public_api_routes_match_the_login_gate_allowlist():
    from hermes_cli.dashboard_auth.middleware import _path_is_public

    for key in PUBLIC:
        path = key.split(" ", 1)[1]
        if "{" not in path:
            assert _path_is_public(path), key


# Admin-grade routes named in the review (and a sample of each family). Body
# shapes are realistic so owner/admin requests reach the handler.
ADMIN_ROUTES = [
    ("put", "/api/env", {"key": "OPENAI_API_KEY", "value": "sk-test"}),
    ("delete", "/api/env", {"key": "OPENAI_API_KEY"}),
    ("post", "/api/env/reveal", {"key": "OPENAI_API_KEY"}),
    ("get", "/api/env", None),
    ("put", "/api/config", {"config": {}}),
    ("get", "/api/config/raw", None),
    ("put", "/api/config/raw", {"yaml_text": "model: {}\n"}),
    ("post", "/api/model/set", {"scope": "main", "provider": "openrouter", "model": "x"}),
    ("post", "/api/hermes/update", None),
    ("get", "/api/files", None),
    ("post", "/api/fs/write-text", {"path": "/tmp/x", "content": "x"}),
    ("get", "/api/logs", None),
    ("post", "/api/gateway/restart", None),
    ("post", "/api/profiles", {"name": "evil"}),
    ("post", "/api/skills/hub/install", {"identifier": "x"}),
    ("post", "/api/memory/providers/honcho/oauth/start", None),
    ("post", "/api/mcp/servers", {"name": "evil", "command": "/bin/sh", "args": ["-c", "id"]}),
    ("get", "/api/security-basics", None),
]


@pytest.fixture
def acting(monkeypatch):
    """``acting["as"]`` is the logged-in principal (``None`` → no login)."""
    from hermes_cli import web_server

    state = {"as": OWNER}

    async def _fake_principal(request, *, allow_as=False):
        return state["as"] or OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: state["as"].user_id if state["as"] else "",
    )
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _call(client, method, path, body):
    if body is None:
        return client.request(method.upper(), path)
    return client.request(method.upper(), path, json=body)


@pytest.mark.parametrize("who", [MEMBER, VIEWER], ids=["member", "viewer"])
@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES, ids=[f"{m} {p}" for m, p, _ in ADMIN_ROUTES])
def test_member_and_viewer_get_403_on_admin_routes(client, acting, who, method, path, body):
    acting["as"] = who
    resp = _call(client, method, path, body)
    assert resp.status_code == 403, (path, resp.status_code, resp.text[:200])


def test_secret_reveal_and_env_write_blocked_for_member(client, acting, tmp_path):
    from hermes_cli.config import load_env, save_env_value

    save_env_value("OPENAI_API_KEY", "sk-real-secret")
    acting["as"] = MEMBER
    reveal = client.post("/api/env/reveal", json={"key": "OPENAI_API_KEY"})
    assert reveal.status_code == 403
    assert "sk-real-secret" not in reveal.text
    write = client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "sk-evil"})
    assert write.status_code == 403
    assert load_env().get("OPENAI_API_KEY") == "sk-real-secret"


@pytest.mark.parametrize("who", [OWNER, ADMIN, None], ids=["owner", "admin", "no-login"])
def test_owner_admin_and_operator_can_still_write_env(client, acting, who):
    from hermes_cli.config import load_env

    acting["as"] = who
    resp = client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "sk-owner"})
    assert resp.status_code == 200, resp.text
    assert load_env().get("OPENAI_API_KEY") == "sk-owner"
    revealed = client.post("/api/env/reveal", json={"key": "OPENAI_API_KEY"})
    assert revealed.status_code == 200 and revealed.json().get("value") == "sk-owner"


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES, ids=[f"{m} {p}" for m, p, _ in ADMIN_ROUTES])
def test_admin_routes_do_not_403_for_an_admin(client, acting, method, path, body):
    if path in ("/api/hermes/update", "/api/gateway/restart", "/api/skills/hub/install",
                "/api/memory/providers/honcho/oauth/start", "/api/profiles", "/api/fs/write-text"):
        pytest.skip("side effect on the host; the gate itself is covered by test_role_gate_unit")
    acting["as"] = ADMIN
    resp = _call(client, method, path, body)
    assert resp.status_code != 403, (path, resp.text[:200])


def test_member_keeps_signed_in_reads(client, acting):
    acting["as"] = MEMBER
    for path in ("/api/config", "/api/model/options", "/api/tools/toolsets", "/api/mcp/servers"):
        assert client.get(path).status_code != 403, path


def test_single_user_install_without_datastore_keeps_access(client, monkeypatch):
    from hermes_cli import web_server

    async def _unconfigured(request, *, allow_as=False):
        raise web_server._CommsNotConfigured("no DSN")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _unconfigured)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: "someone")
    assert client.put("/api/env", json={"key": "OPENAI_API_KEY", "value": "v"}).status_code == 200


def test_role_gate_unit():
    """The shared dependency: owner/admin pass, member/viewer 403, no login passes."""
    from fastapi import HTTPException

    from hermes_cli import route_roles, web_server

    def run(who, role="admin"):
        req = SimpleNamespace()
        orig = (web_server._comms_session_subject, web_server._comms_resolve_principal)

        async def _principal(request, *, allow_as=False):
            return who

        web_server._comms_session_subject = lambda r: who.user_id if who else ""
        web_server._comms_resolve_principal = _principal
        try:
            dep = route_roles.require_admin if role == "admin" else route_roles.require_owner
            asyncio.run(dep(req))
            return "ok"
        except HTTPException as exc:
            return exc.status_code
        finally:
            web_server._comms_session_subject, web_server._comms_resolve_principal = orig

    assert [run(w) for w in (OWNER, ADMIN, MEMBER, VIEWER, None)] == ["ok", "ok", 403, 403, "ok"]
    assert [run(w, "owner") for w in (OWNER, ADMIN, MEMBER, None)] == ["ok", 403, 403, "ok"]


@pytest.mark.parametrize(
    "who,expected",
    [(OWNER, True), (ADMIN, True), (MEMBER, False), (VIEWER, False)],
    ids=["owner", "admin", "member", "viewer"],
)
def test_terminal_websocket_ticket_needs_admin(monkeypatch, who, expected):
    from hermes_cli import web_server

    async def _principal(request, *, allow_as=False):
        assert request.state.session.user_id == who.user_id
        return who

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _principal)
    ws = SimpleNamespace(state=SimpleNamespace(ws_ticket={"user_id": who.user_id}))
    assert asyncio.run(web_server._ws_ticket_is_admin(ws)) is expected


def test_terminal_websocket_without_ticket_user_keeps_access():
    from hermes_cli import web_server

    ws = SimpleNamespace(state=SimpleNamespace())
    assert asyncio.run(web_server._ws_ticket_is_admin(ws)) is True


# --- agent-home BFF routes -------------------------------------------------
# ``agent-home/src/lib/auth/route-roles.test.ts`` makes every BFF route declare
# a role. This side checks the two tables agree: a BFF handler that calls an
# API-client method hitting an owner/admin Python route must itself be
# labelled admin/owner, so a member gets a clear 403 before anything is sent.

_REPO = __import__("pathlib").Path(__file__).resolve().parents[2]
_AGENT_HOME = _REPO / "agent-home" / "src"


def _python_admin_route_patterns():
    import re

    from hermes_cli.route_roles import declared_role

    out = []
    for ctx in _contexts():
        if declared_role(ctx) and getattr(ctx, "methods", None):
            rx = "^" + re.sub(r"\\\{[^}]*\\\}", "[^/]+", re.escape(ctx.path)) + "$"
            out.append((set(ctx.methods), re.compile(rx), ctx.path))
    return out


def _client_methods_hitting_admin_routes():
    """``HermesApiClient`` method name -> the owner/admin Python route it calls."""
    import re

    src = (_AGENT_HOME / "lib" / "api" / "client.ts").read_text()
    admin = _python_admin_route_patterns()
    hits = {}
    for m in re.finditer(r"\n  (?:async )?(\w+)\(", src):
        end = src.find("\n  }\n", m.end())
        body = src[m.end():end]
        method = re.search(r'method:\s*"(\w+)"', body)
        verb = method.group(1) if method else "GET"
        for pm in re.finditer(r'[`"](/(?:api|v1)/[^`"]*)[`"]', body):
            path = re.sub(r"\$\{[^}]*\}", "X", pm.group(1)).split("?")[0]
            for methods, rx, route in admin:
                if verb in methods and rx.match(path):
                    hits[m.group(1)] = route
    return hits


def test_bff_routes_that_proxy_admin_routes_are_admin_only():
    import json
    import re

    roles = json.loads((_AGENT_HOME / "lib" / "auth" / "route-roles.json").read_text())
    admin_methods = _client_methods_hitting_admin_routes()
    assert "setEnvVar" in admin_methods and "setModelAssignment" in admin_methods
    wrong = []
    for file in (_AGENT_HOME / "app" / "api").rglob("route.ts"):
        route = "/" + file.parent.relative_to(_AGENT_HOME / "app").as_posix()
        src = file.read_text()
        found = list(re.finditer(r"export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b", src))
        for i, m in enumerate(found):
            body = src[m.end(): found[i + 1].start() if i + 1 < len(found) else len(src)]
            key = f"{m.group(1)} {route}"
            for name, py_route in admin_methods.items():
                if re.search(rf"\.{name}\(", body) and roles.get(key) not in ("admin", "owner"):
                    wrong.append((key, name, py_route, roles.get(key)))
    assert not wrong, wrong
