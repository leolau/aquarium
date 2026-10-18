#!/usr/bin/env python3
"""Release gate: live check of per-user access on a TEST install (PRs #520, #521, #522, #529).

Creates throwaway users (admin, member, viewer; the owner's checks are opt-in),
logs each one in through the real dashboard, checks what they can and can't do,
then deletes everything it created. PASS/FAIL/SKIP per check, a JSON summary at
the end, exit 1 on any FAIL.

What it checks:

a. Tool limits (#522): the effective ``access.roles`` policy per role (printed),
   ``terminal`` refused for member/viewer through ``model_tools`` (and its
   ``touch`` marker never appears), ``terminal`` not denied for admin/owner (never
   run), and an agent built for each user (no model call) has their identity and
   none of their denied tools.
b. File confinement (#522): member writes in its own folder, can't read another
   test user's folder or ``/etc/hostname``, can't open ``file://`` in the
   browser; viewer can't ``write_file``; admin can read ``/etc/hostname``.
c. Chat privacy (#520): each user creates a chat via ``POST /api/sessions``; no
   other test user sees it in ``GET /api/sessions`` or can open it (403/404).
d. Chat identity (#521, ``--chat-turn``, on by default): one turn ("Reply with
   the word OK only.") per member/viewer via ``POST /api/sessions/{id}/chat``;
   the stored session belongs to that user and the turn's interaction trace
   names them as the actor.

e. Approvals: the agent's own clicks on Approve / Always approve / Allow /
   "Trusted for import" are gated in app-mcp (security review F17/F18), and a
   pending gateway command approval can't be resolved by another user (F22).
f. Network folders: every VPN folder mounted under ``/opt/data/vpn-files`` is
   mounted ``ro`` and each terminal user's ``touch`` into it fails (SKIP when
   none is mounted).
g. Secrets (F16): for each test user allowed ``terminal`` (admin, owner with
   ``--include-owner``), one real ``terminal`` call lists the *names* of
   environment variables, which of ``/etc/aquarium/*``, ``/opt/data/*.env`` and
   ``agent-home.env`` are readable, and whether the gateway's
   ``/proc/<pid>/environ`` is readable. FAIL on any secret-looking name
   (``DATABASE_URL``, ``*SECRET*``, ``*PASSWORD*``, ``*_TOKEN``, ``*API_KEY*``
   ...), any readable file or environ. Values are never read into the report.

What it creates, all tagged ``zz-accesscheck-<unix ts>``:

- per role: a GoTrue account ``zz-accesscheck-<ts>-<role>@example.invalid``
  (random password, never printed), its enrolment in this profile (display
  ``zz-accesscheck-<ts>-<role>``) and the one-time invitation used to set the
  password;
- one chat session per user (plus the messages of the one chat turn);
- ``$HERMES_HOME/workspaces/<user id>/`` with a probe file.

What it deletes (in ``finally``, and with ``--cleanup``): those sessions, those
folders, the enrolments (``MemberService.delete_member(strategy="purge")``) and
the GoTrue accounts (``GoTrueAdminClient.delete_user``), then re-lists accounts,
members, sessions and folders and reports anything left. Only accounts whose
email starts with the tag and ends ``@example.invalid`` and members whose
display starts with the tag are ever touched; the owner never is. Audit rows
(``user.create``/``user.delete``), interaction traces and model-call rows for
the test turns stay, as they do for any deleted user.

It sends no WhatsApp or other channel message and changes no config.

TEST install only. It refuses to run (exit 2) when ``--base-url``, a public-URL
env var or this machine's own name/IP is the production box
(``home.leolau.ai-and-i.io`` / ``188.245.219.105``); ``--allow-production``
overrides that for the old pre-gate use. On a TEST box laid out like
production (checkout ``/opt/data/hermes-agent``, dashboard on port 9119), run
it as the ``hermes`` service user with the services' environment, so check g
sees what the agent sees::

    cd /opt/data/hermes-agent && sudo -u hermes -H bash -c 'set -a; . /opt/data/hermes-messaging.env; set +a; export HERMES_HOME=/opt/data/hermes-home-staging; .venv/bin/python scripts/live_access_check.py --base-url http://127.0.0.1:9119'

Add ``--dry-run`` to print the plan and policy only, ``--skip eg`` to skip
check groups (reported as SKIP), ``--no-chat-turn`` to skip
the model calls, ``--include-owner`` for the owner's in-process checks, or
``--cleanup zz-accesscheck-<ts>`` / ``--cleanup all-zz-accesscheck`` to remove
leftovers of an interrupted run.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, cast

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

TAG_PREFIX = "zz-accesscheck-"
ALL_TAGS = "all-zz-accesscheck"
EMAIL_DOMAIN = "@example.invalid"
TEST_ROLES = ("admin", "member", "viewer")
CHAT_ROLES = ("member", "viewer")
CHAT_PROMPT = "Reply with the word OK only."
SESSION_COOKIE = "hermes_session_at"
_TAG_RE = re.compile(r"^zz-accesscheck-\d+$")


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


@dataclass
class Report:
    out: Callable[[str], None] = print
    results: List[Dict[str, str]] = field(default_factory=list)

    def _add(self, status: str, name: str, detail: str) -> None:
        self.results.append({"status": status, "check": name, "detail": detail})
        self.out(f"{status:<4} {name}" + (f" — {detail}" if detail else ""))

    def check(self, name: str, ok: bool, detail: str = "") -> bool:
        self._add("PASS" if ok else "FAIL", name, detail)
        return ok

    def skip(self, name: str, detail: str) -> None:
        self._add("SKIP", name, detail)

    def count(self, status: str) -> int:
        return sum(1 for r in self.results if r["status"] == status)

    @property
    def failed(self) -> List[str]:
        return [r["check"] for r in self.results if r["status"] == "FAIL"]


def _short(text: Any, limit: int = 160) -> str:
    s = str(text).replace("\n", " ")
    return s if len(s) <= limit else s[: limit - 1] + "…"


# ---------------------------------------------------------------------------
# HTTP (stdlib) with a manual cookie jar: loopback is plain HTTP, so cookies
# are unprefixed and urllib's jar would be needless indirection.
# ---------------------------------------------------------------------------


@dataclass
class Response:
    status: int
    body: Any
    cookies: Dict[str, str]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


class Http:
    def __init__(self, base_url: str, *, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect)

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        cookies: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> Response:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if cookies:
            req.add_header("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
        try:
            resp = self._opener.open(req, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as exc:
            resp = exc
        raw = resp.read() or b""
        jar: Dict[str, str] = {}
        for header in resp.headers.get_all("Set-Cookie") or []:
            parsed = SimpleCookie()
            parsed.load(header)
            for name, morsel in parsed.items():
                if morsel.value:
                    jar[name] = morsel.value
        try:
            parsed_body: Any = json.loads(raw) if raw else None
        except ValueError:
            parsed_body = raw.decode(errors="replace")
        return Response(
            status=int(getattr(resp, "status", 0) or 0), body=parsed_body, cookies=jar
        )


# ---------------------------------------------------------------------------
# Member service adapter (the real one; tests substitute ``build_members``)
# ---------------------------------------------------------------------------


class LiveMembers:
    """The box's own user management: ``MemberService`` + GoTrue admin + store."""

    def __init__(self) -> None:
        from hermes_cli.access import PrincipalStore
        from hermes_cli.config import load_config
        from hermes_cli.datastore import get_store
        from hermes_cli.members import MemberService, load_admin_client

        self._config = load_config() or {}
        admin = load_admin_client()
        if admin is None:
            raise SystemExit(
                "User management is not configured (no Supabase service-role "
                "key/url in this environment) — run with the services' env."
            )
        self.admin = admin
        self.app_store = get_store("supabase-app", "prod", config=self._config)
        self.store = PrincipalStore(self.app_store)
        self.service = MemberService(self.store, self.admin, config=self._config)

    def owner(self):
        return asyncio.run(self.store.get_owner())

    def create(self, actor, *, email: str, display: str, role: str) -> tuple[str, str]:
        from hermes_cli.members import administered_profile

        created = asyncio.run(
            self.service.create_member(
                actor,
                email=email,
                profile=administered_profile(),
                display=display,
                role=cast(Any, role),
            )
        )
        if created.enrolled_existing or not created.invitation_token:
            raise RuntimeError(f"{email} already had an account; refusing to reuse it")
        return created.principal.user_id, created.invitation_token

    def delete_member(self, actor, user_id: str) -> None:
        asyncio.run(
            self.service.delete_member(actor, user_id=user_id, strategy="purge")
        )

    def delete_account(self, user_id: str) -> None:
        self.admin.delete_user(user_id=user_id)

    def accounts(self) -> Dict[str, str]:
        return {
            uid: str(u.get("email") or "") for uid, u in self.admin.list_users().items()
        }

    def principals(self) -> list:
        return asyncio.run(self.store.list_principals())

    def traces(self, principal) -> Optional[list]:
        """Interaction-trace summaries visible to *principal*; ``None`` if tracing is off."""
        from hermes_cli.interactions import ActionTrackingConfig, InteractionLedger

        if (
            not ActionTrackingConfig.from_config(self._config).enabled
            or not self.app_store.dsn
        ):
            return None
        ledger = InteractionLedger(self.app_store, config=self._config)
        return asyncio.run(ledger.list_traces(principal, limit=50))


def build_members():
    return LiveMembers()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class TestUser:
    role: str
    email: str
    display: str
    user_id: str = ""
    password: str = field(default="", repr=False)
    cookies: Dict[str, str] = field(default_factory=dict, repr=False)
    session_id: str = ""

    def principal(self):
        from hermes_cli.access import Principal

        return Principal(
            user_id=self.user_id, display=self.display, role=cast(Any, self.role)
        )


def _new_password() -> str:
    return secrets.token_urlsafe(24) + "-Aa9"


def _workspaces() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "workspaces"


def _folder_for(user_id: str) -> Path:
    from tools.access_policy import _folder_name

    return _workspaces() / _folder_name(user_id)


def _session_db():
    from hermes_state import SessionDB

    return SessionDB()


def _tool(name: str, args: dict, user: Optional[TestUser], task_id: str) -> str:
    import model_tools

    model_tools.discover_builtin_tools()
    return model_tools.handle_function_call(
        name,
        args,
        task_id=task_id,
        principal_user_id=user.user_id if user else None,
        principal_role=user.role if user else None,
        skip_pre_tool_call_hook=True,
        skip_tool_request_middleware=True,
    )


def _error_of(raw: str) -> str:
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    if isinstance(data, dict):
        if data.get("error"):
            return str(data["error"])
        if data.get("success") is False:
            return str(data.get("message") or data)
    return ""


def effective_policy(roles) -> Dict[str, Dict[str, Any]]:
    """Per role: denied tools, where that list came from, and the files rule."""
    from tools.access_policy import DEFAULT_DENIED_TOOLS, _expand, _role_config

    policy: Dict[str, Dict[str, Any]] = {}
    for role in roles:
        cfg = _role_config(role)
        override = "deny_tools" in cfg
        deny = (
            _expand(cfg.get("deny_tools"))
            if override
            else _expand(DEFAULT_DENIED_TOOLS.get(role, ()))
        )
        files = cfg.get("files")
        if files is None:
            files = "any" if role in ("owner", "admin") else "own folder"
        policy[role] = {
            "deny_tools": sorted(deny),
            "source": f"config.yaml access.roles.{role}.deny_tools"
            if override
            else "defaults",
            "files": files,
        }
    return policy


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_tool_policy(
    report: Report, users: Dict[str, TestUser], policy, tag: str
) -> None:
    from tools.access_policy import blocked_tool_error, denied_tools

    for role, user in users.items():
        expected = policy[role]
        effective = denied_tools(user.user_id, role)
        report.check(
            f"[a] {role}: denied tools match {expected['source']}",
            sorted(effective) == expected["deny_tools"],
            f"denied={sorted(effective)}",
        )
        if expected["source"] == "defaults":
            must = {
                "owner": set(),
                "admin": set(),
                "member": {"terminal", "execute_code"},
                "viewer": {"terminal", "execute_code", "write_file", "patch"},
            }[role]
            ok = must <= effective if must else not effective
            report.check(
                f"[a] {role}: default limits are in force",
                ok,
                f"expected {'nothing' if not must else sorted(must)} denied",
            )
        if role in ("owner", "admin"):
            report.check(
                f"[a] {role}: terminal not denied (not run)",
                "terminal" not in effective or "terminal" in expected["deny_tools"],
                "denied by config override" if "terminal" in effective else "",
            )
            continue
        if "terminal" not in effective:
            report.skip(
                f"[a] {role}: terminal refused",
                "config allows terminal for this role; not run",
            )
            continue
        marker = Path(tempfile.gettempdir()) / f"{tag}-{role}.marker"
        raw = _tool(
            "terminal",
            {"command": f"touch {shlex.quote(str(marker))}"},
            user,
            f"{tag}-{role}",
        )
        refused = blocked_tool_error("terminal") in _error_of(raw)
        report.check(f"[a] {role}: terminal refused", refused, _short(raw))
        report.check(
            f"[a] {role}: terminal marker not created", not marker.exists(), str(marker)
        )


def check_agent_tools(report: Report, users: Dict[str, TestUser]) -> None:
    """Build each user's chat agent (no model call): identity + filtered tools."""
    from gateway.session_chat import build_session_agent
    from tools.access_policy import denied_tools

    for role, user in users.items():
        agent = None
        try:
            agent = build_session_agent(session_db=None, principal=user.principal())
            ident = (
                getattr(agent, "_internal_user_id", None),
                getattr(agent, "_internal_user_role", None),
            )
            report.check(
                f"[a] {role}: agent runs as the user",
                ident == (user.user_id, role),
                f"agent identity={ident}",
            )
            names = {t["function"]["name"] for t in (agent.tools or [])}
            leaked = sorted(names & denied_tools(user.user_id, role))
            report.check(
                f"[a] {role}: agent tool list has no denied tool",
                not leaked,
                f"leaked={leaked}" if leaked else f"{len(names)} tools offered",
            )
        except Exception as exc:  # noqa: BLE001 - report, don't abort the run
            report.check(
                f"[a] {role}: agent build",
                False,
                f"{type(exc).__name__}: {_short(exc)}",
            )
        finally:
            close = getattr(agent, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:  # noqa: BLE001
                    pass


def check_files(report: Report, users: Dict[str, TestUser], tag: str) -> None:
    from tools.access_policy import files_root

    task = f"{tag}-files"
    member, viewer, admin = users.get("member"), users.get("viewer"), users.get("admin")
    hostname = Path("/etc/hostname")
    if member:
        own = files_root(member.user_id, "member")
        report.check(
            "[b] member: confined to own folder",
            own is not None and own == _folder_for(member.user_id).resolve(),
            str(own),
        )
        probe = _folder_for(member.user_id) / "probe.txt"
        raw = _tool("write_file", {"path": str(probe), "content": tag}, member, task)
        written = probe.exists() and probe.read_text(encoding="utf-8") == tag
        report.check(
            "[b] member: write_file in own folder allowed",
            not _error_of(raw) and written,
            _short(raw),
        )
        if viewer:
            other = _folder_for(viewer.user_id)
            other.mkdir(parents=True, exist_ok=True)
            secret = other / "secret.txt"
            secret.write_text(f"{tag}-secret", encoding="utf-8")
            raw = _tool("read_file", {"path": str(secret)}, member, task)
            report.check(
                "[b] member: read of another user's folder refused",
                "Access denied" in _error_of(raw) and f"{tag}-secret" not in raw,
                _short(raw),
            )
        raw = _tool("read_file", {"path": str(hostname)}, member, task)
        report.check(
            "[b] member: read /etc/hostname refused",
            "Access denied" in _error_of(raw),
            _short(raw),
        )
        raw = _tool("browser_navigate", {"url": f"file://{hostname}"}, member, task)
        err = _error_of(raw)
        if "only http(s)" in err:
            report.check("[b] member: browser file:// blocked", True, _short(err))
        elif "Unknown tool" in err or "not available" in err.lower():
            report.skip("[b] member: browser file:// blocked", _short(err))
        else:
            report.check("[b] member: browser file:// blocked", False, _short(raw))
    if viewer:
        probe = _folder_for(viewer.user_id) / "viewer-probe.txt"
        raw = _tool("write_file", {"path": str(probe), "content": tag}, viewer, task)
        report.check(
            "[b] viewer: write_file refused",
            "not available to your role" in _error_of(raw) and not probe.exists(),
            _short(raw),
        )
    if admin:
        if not hostname.exists():
            report.skip(
                "[b] admin: read /etc/hostname allowed",
                "/etc/hostname does not exist here",
            )
        else:
            raw = _tool("read_file", {"path": str(hostname)}, admin, task)
            want = hostname.read_text(encoding="utf-8").strip()
            report.check(
                "[b] admin: read /etc/hostname allowed",
                not _error_of(raw) and want in raw,
                _short(raw),
            )
    for cleanup in (_cleanup_terminal, _cleanup_browser):
        cleanup(task)


def _cleanup_terminal(task_id: str) -> None:
    try:
        from tools.terminal_tool import cleanup_vm

        cleanup_vm(task_id)
    except Exception:  # noqa: BLE001
        pass


def _cleanup_browser(task_id: str) -> None:
    try:
        from tools.browser_tool import cleanup_browser

        cleanup_browser(task_id)
    except Exception:  # noqa: BLE001
        pass


def _listed_ids(resp: Response) -> set:
    rows = (resp.body or {}).get("sessions", []) if isinstance(resp.body, dict) else []
    return {r.get("id") for r in rows if isinstance(r, dict)}


def check_privacy(report: Report, http: Http, users: Dict[str, TestUser]) -> None:
    db = _session_db()
    try:
        for role, user in users.items():
            resp = http.request("POST", "/api/sessions", body={}, cookies=user.cookies)
            sid = (
                (resp.body or {}).get("session_id", "")
                if isinstance(resp.body, dict)
                else ""
            )
            user.session_id = sid
            report.check(
                f"[c] {role}: POST /api/sessions",
                resp.status == 200 and bool(sid),
                f"{resp.status} {sid}",
            )
            if sid:
                owner = db.session_owner_user_id(sid)
                report.check(
                    f"[c] {role}: new chat stored as theirs",
                    owner == user.user_id,
                    f"owner={owner}",
                )
    finally:
        db.close()
    for role, viewer in users.items():
        resp = http.request("GET", "/api/sessions?limit=500", cookies=viewer.cookies)
        ids = _listed_ids(resp)
        if viewer.session_id:
            report.check(
                f"[c] {role}: own chat listed",
                resp.status == 200 and viewer.session_id in ids,
                f"{resp.status}, {len(ids)} listed",
            )
            own = http.request(
                "GET", f"/api/sessions/{viewer.session_id}", cookies=viewer.cookies
            )
            report.check(
                f"[c] {role}: own chat opens", own.status == 200, str(own.status)
            )
        for other_role, other in users.items():
            if other is viewer or not other.session_id:
                continue
            report.check(
                f"[c] {role}: {other_role}'s chat not listed",
                resp.status == 200 and other.session_id not in ids,
                str(resp.status),
            )
            detail = http.request(
                "GET", f"/api/sessions/{other.session_id}", cookies=viewer.cookies
            )
            report.check(
                f"[c] {role}: {other_role}'s chat refused",
                detail.status in (403, 404),
                str(detail.status),
            )


def check_chat_identity(
    report: Report, http: Http, users: Dict[str, TestUser], members, timeout: float
) -> None:
    for role in CHAT_ROLES:
        user = users.get(role)
        if not user or not user.session_id:
            continue
        resp = http.request(
            "POST",
            f"/api/sessions/{user.session_id}/chat",
            body={"message": CHAT_PROMPT},
            cookies=user.cookies,
            timeout=timeout,
        )
        body = resp.body if isinstance(resp.body, dict) else {}
        reply = ((body.get("message") or {}).get("content") or "") if body else ""
        ok = report.check(
            f"[d] {role}: chat turn answered",
            resp.status == 200,
            f"{resp.status} reply={_short(reply, 40)!r}",
        )
        if not ok:
            continue
        sid = body.get("session_id") or user.session_id
        db = _session_db()
        try:
            row = db.get_session(sid) or {}
            owner = db.session_owner_user_id(sid)
            report.check(
                f"[d] {role}: turn's session stored as theirs",
                owner == user.user_id and row.get("user_id") in (None, user.user_id),
                f"session={sid} owner={owner}",
            )
            texts = [
                m.get("content")
                for m in db.get_messages(sid)
                if m.get("role") == "user"
            ]
            report.check(
                f"[d] {role}: turn stored in their session",
                CHAT_PROMPT in texts,
                f"{len(texts)} user message(s)",
            )
        finally:
            db.close()
        try:
            traces = members.traces(user.principal())
        except Exception as exc:  # noqa: BLE001
            report.check(
                f"[d] {role}: turn traced with them as actor",
                False,
                f"{type(exc).__name__}: {_short(exc)}",
            )
            continue
        if traces is None:
            report.skip(
                f"[d] {role}: turn traced with them as actor",
                "interaction tracing is off on this box",
            )
            continue
        mine = [t for t in traces if t.session_key in (user.session_id, sid)]
        report.check(
            f"[d] {role}: turn traced with them as actor",
            bool(mine) and all(t.actor_user_id == user.user_id for t in mine),
            f"{len(mine)} trace(s) for the session",
        )


# ---------------------------------------------------------------------------
# Provisioning
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Release-gate checks (e-g) and the TEST-install guard
# ---------------------------------------------------------------------------

PRODUCTION_HOSTS = frozenset({"home.leolau.ai-and-i.io", "188.245.219.105"})
APPROVAL_LABELS = ("Approve", "Approve for this chat", "Always approve", "Allow", "Trusted for import")
SECRET_FILE_GLOBS = (
    "/etc/aquarium/*",
    "/etc/aquarium/*/*",
    "/opt/data/*.env",
    "/opt/data/hermes-agent/agent-home/agent-home.env",
)
_SECRET_NAME_RE = re.compile(
    r"(^DATABASE_URL$|_DSN$|^PG(PASSWORD|PASS)$|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|"
    r"API_KEY|_TOKEN$|^SUPABASE_.*KEY|SERVICE_ROLE)",
    re.IGNORECASE,
)
_PROBE_START = "__zz_gate_begin__"
_PROBE_END = "__zz_gate_end__"


def local_addresses() -> set:
    """Hostnames and IPs of this machine (best effort, no network calls out)."""
    import socket

    names = {socket.gethostname(), socket.getfqdn()}
    addrs = set(names)
    for name in names:
        try:
            addrs.update(i[4][0] for i in socket.getaddrinfo(name, None))
        except OSError:
            pass
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5)
        addrs.update(out.stdout.split())
    except (OSError, subprocess.SubprocessError):
        pass
    return {a.lower() for a in addrs if a}


def production_markers(base_url: str, addrs=None) -> List[str]:
    """Why this run looks like production (empty list = looks like a TEST install)."""
    from urllib.parse import urlparse

    found = []
    host = (urlparse(base_url).hostname or "").lower()
    if host in PRODUCTION_HOSTS:
        found.append(f"--base-url host {host}")
    for env in ("AGENT_HOME_PUBLIC_URL", "HERMES_PUBLIC_URL", "PUBLIC_URL"):
        h = (urlparse(os.environ.get(env, "")).hostname or "").lower()
        if h in PRODUCTION_HOSTS:
            found.append(f"{env} host {h}")
    hit = (local_addresses() if addrs is None else set(addrs)) & PRODUCTION_HOSTS
    found += [f"this machine is {a}" for a in sorted(hit)]
    return found


def secret_env_names(names) -> List[str]:
    return sorted({n for n in names if _SECRET_NAME_RE.search(n)})


def read_mounts(path: str = "/proc/mounts") -> List[tuple]:
    """(mount point, options) for every mount (octal escapes decoded)."""
    out = []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return out
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            point = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), parts[1])
            out.append((point, parts[3].split(",")))
    return out


def network_folder_mounts(mounts, root: str) -> List[tuple]:
    root = root.rstrip("/") + "/"
    return [(p, o) for p, o in mounts if p.startswith(root)]


def _terminal_output(raw: str) -> str:
    try:
        data = json.loads(raw)
    except ValueError:
        return raw
    return str(data.get("output", "")) if isinstance(data, dict) else raw


def _terminal_users(users: Dict[str, TestUser], policy) -> Dict[str, TestUser]:
    """Users whose effective policy lets them run ``terminal``."""
    return {
        r: u
        for r, u in users.items()
        if "terminal" not in ((policy.get(r) or {}).get("deny_tools") or [])
    }


def check_approvals(report: Report, users: Dict[str, TestUser]) -> None:
    """[e] Approvals can't be given by someone other than the requester or by the agent."""
    import inspect

    # e1. app-mcp: the agent's own clicks on approval controls must count as gated.
    try:
        app_mcp_dir = str(REPO_ROOT / "app-mcp")
        if app_mcp_dir not in sys.path:
            sys.path.insert(0, app_mcp_dir)
        from app_mcp.guard import looks_destructive

        ungated = [label for label in APPROVAL_LABELS if not looks_destructive(label)]
        report.check(
            "[e] agent clicks on approval buttons are gated (app_act)",
            not ungated,
            "ungated: " + ", ".join(ungated) + " (security review F17/F18)" if ungated else "",
        )
    except Exception as exc:  # noqa: BLE001
        report.check("[e] agent clicks on approval buttons are gated (app_act)", False, _short(exc))

    # e2. Gateway approvals: another user in a shared chat must not approve my command.
    from tools import approval

    params = inspect.signature(approval.resolve_gateway_approval).parameters
    approver = next((p for p in ("approver_id", "approver", "principal") if p in params), None)
    name = "[e] another user can't approve my pending command (gateway)"
    if approver is None:
        report.check(
            name,
            False,
            "resolve_gateway_approval() takes no approver, so any participant resolves "
            "any pending approval (security review F22)",
        )
        return
    roles = [r for r in ("member", "viewer", "admin") if r in users]
    if len(roles) < 2:
        report.skip(name, "needs two test users")
        return
    requester, other = users[roles[0]], users[roles[1]]
    key = f"{TAG_PREFIX}approval-{int(time.time())}"
    entry = approval._ApprovalEntry({"command": "true", "description": "release gate"})
    for attr in ("requester_id", "requester"):
        try:
            setattr(entry, attr, requester.user_id)
        except AttributeError:
            pass
    entry.data.update(requester_id=requester.user_id, user_id=requester.user_id)
    with approval._lock:
        approval._gateway_queues.setdefault(key, []).append(entry)
    try:
        try:
            resolved = approval.resolve_gateway_approval(key, "once", **{approver: other.user_id})
        except (PermissionError, ValueError):
            resolved = 0
        report.check(name, not resolved and entry.result is None, f"resolved={resolved}")
    finally:
        with approval._lock:
            approval._gateway_queues.pop(key, None)
        entry.event.set()


def check_terminal_secrets(
    report: Report, users: Dict[str, TestUser], policy, tag: str
) -> None:
    """[g] The agent terminal can't see secrets. Only names/paths are reported, never values."""
    who = _terminal_users(users, policy)
    if not who:
        report.skip("[g] terminal secrets", "no test user has terminal")
        return
    script = (
        f"echo {_PROBE_START}; env | cut -d= -f1 | sed 's/^/ENV /'; "
        f"for f in {' '.join(SECRET_FILE_GLOBS)}; do "
        '[ -f "$f" ] && [ -r "$f" ] && echo "FILE $f"; done; '
        "for p in $(pgrep -f 'gateway run|hermes-gateway|hermes_cli.main gateway' 2>/dev/null); do "
        '[ "$p" != "$$" ] && [ -r "/proc/$p/environ" ] && echo "PROC $p"; done; '
        f"echo {_PROBE_END}"
    )
    for role, user in who.items():
        raw = _tool("terminal", {"command": script}, user, f"{tag}-{role}-secrets")
        text = _terminal_output(raw)
        if _PROBE_START not in text or _PROBE_END not in text:
            report.check(f"[g] {role}: terminal probe ran", False, _short(_error_of(raw) or "no output"))
            continue
        body = text.split(_PROBE_START, 1)[1].split(_PROBE_END, 1)[0].splitlines()
        env_names = [ln[4:].strip() for ln in body if ln.startswith("ENV ")]
        files = [ln[5:].strip() for ln in body if ln.startswith("FILE ")]
        procs = [ln[5:].strip() for ln in body if ln.startswith("PROC ")]
        leaked = secret_env_names(env_names)
        report.check(
            f"[g] {role}: no secret in the terminal environment",
            not leaked,
            "visible: " + ", ".join(leaked) if leaked else f"{len(env_names)} names checked",
        )
        report.check(
            f"[g] {role}: DATABASE_URL not in the terminal environment",
            "DATABASE_URL" not in env_names,
        )
        report.check(
            f"[g] {role}: secret files not readable (/etc/aquarium, /opt/data/*.env)",
            not files,
            "readable: " + ", ".join(files) if files else "",
        )
        report.check(
            f"[g] {role}: gateway process environment not readable",
            not procs,
            "readable /proc/<pid>/environ for pid " + ", ".join(procs) if procs else "",
        )


def check_network_folders(
    report: Report, users: Dict[str, TestUser], policy, tag: str, *, mounts_path: str = "/proc/mounts"
) -> None:
    """[f] VPN network folders are mounted read-only and the agent terminal can't write to them."""
    from hermes_cli import vpn

    mounts = network_folder_mounts(read_mounts(mounts_path), vpn.MOUNT_ROOT)
    if not mounts:
        report.skip("[f] network folders read-only", f"nothing mounted under {vpn.MOUNT_ROOT}")
        return
    who = _terminal_users(users, policy)
    for point, opts in mounts:
        report.check(f"[f] {point} mounted read-only", "ro" in opts, ",".join(opts[:6]))
        for role, user in who.items():
            probe = f"{point.rstrip('/')}/.{tag}-{role}"
            cmd = (
                f"touch {shlex.quote(probe)} 2>/dev/null && echo WROTE && rm -f {shlex.quote(probe)}; "
                "echo DONE"
            )
            text = _terminal_output(_tool("terminal", {"command": cmd}, user, f"{tag}-{role}-net"))
            report.check(
                f"[f] {role}: can't write into {point}",
                "DONE" in text and "WROTE" not in text,
                "write succeeded (probe removed)" if "WROTE" in text else "",
            )


def provision(
    report: Report, http: Http, members, owner, tag: str, provider: str
) -> Dict[str, TestUser]:
    users: Dict[str, TestUser] = {}
    for role in TEST_ROLES:
        user = TestUser(
            role=role, email=f"{tag}-{role}{EMAIL_DOMAIN}", display=f"{tag}-{role}"
        )
        user.user_id, token = members.create(
            owner, email=user.email, display=user.display, role=role
        )
        users[role] = user
        user.password = _new_password()
        resp = http.request(
            "POST",
            "/api/auth/invitations/redeem",
            body={"token": token, "password": user.password},
        )
        report.check(
            f"[setup] {role}: invitation redeemed",
            resp.status == 200,
            f"{resp.status} user={user.user_id}",
        )
        resp = http.request(
            "POST",
            "/auth/password-login",
            body={
                "provider": provider,
                "username": user.email,
                "password": user.password,
            },
        )
        user.cookies = resp.cookies
        report.check(
            f"[setup] {role}: password login",
            resp.status == 200
            and any(k.endswith(SESSION_COOKIE) for k in resp.cookies),
            str(resp.status),
        )
    return users


# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------


def _is_tagged_email(email: str, prefix: str) -> bool:
    return email.startswith(prefix) and email.endswith(EMAIL_DOMAIN)


def _owned_sessions(db, user_ids) -> List[str]:
    sids: List[str] = []
    for uid in sorted(user_ids):
        rows = db.list_sessions_rich(
            user_id=uid,
            limit=100000,
            include_children=True,
            include_archived=True,
            project_compression_tips=False,
        )
        sids.extend(r["id"] for r in rows)
    return sids


def _inventory(members, prefix: str, extra_ids=()) -> Dict[str, Any]:
    accounts = {
        uid: e for uid, e in members.accounts().items() if _is_tagged_email(e, prefix)
    }
    principals = [
        p
        for p in members.principals()
        if p.role != "owner"
        and (
            p.display.startswith(prefix)
            or p.user_id in accounts
            or p.user_id in extra_ids
        )
    ]
    ids = set(accounts) | {p.user_id for p in principals} | set(extra_ids)
    db = _session_db()
    try:
        sessions = _owned_sessions(db, ids)
    finally:
        db.close()
    folders = [
        str(_folder_for(uid)) for uid in sorted(ids) if _folder_for(uid).exists()
    ]
    markers = [str(p) for p in Path(tempfile.gettempdir()).glob(f"{prefix}*.marker")]
    return {
        "accounts": accounts,
        "members": [p.user_id for p in principals],
        "sessions": sessions,
        "folders": folders,
        "markers": markers,
    }


def cleanup(
    report: Report, members, prefix: str, *, owner=None, known=(), dry_run: bool = False
) -> Dict[str, Any]:
    """Delete everything tagged *prefix*; return what was found and what remains."""
    out = report.out
    errors: List[str] = []
    found = _inventory(members, prefix, known)
    counts = {k: len(v) for k, v in found.items()}
    out(f"cleanup {prefix!r}: found {json.dumps(counts)}")
    if dry_run:
        out(
            json.dumps(
                {
                    k: (sorted(v.values()) if k == "accounts" else v)
                    for k, v in found.items()
                },
                indent=2,
            )
        )
        return {"found": counts, "dry_run": True}

    db = _session_db()
    sessions_dir = (
        Path(db.db_path).parent / "sessions" if getattr(db, "db_path", None) else None
    )
    try:
        for sid in found["sessions"]:
            try:
                db.delete_session(
                    sid,
                    sessions_dir=sessions_dir
                    if sessions_dir and sessions_dir.is_dir()
                    else None,
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"session {sid}: {exc}")
    finally:
        db.close()
    workspaces = _workspaces().resolve()
    for folder in found["folders"]:
        path = Path(folder).resolve()
        if path.parent != workspaces:
            errors.append(f"folder {folder}: outside {workspaces}, left alone")
            continue
        shutil.rmtree(path, ignore_errors=True)
    for marker in found["markers"]:
        Path(marker).unlink(missing_ok=True)
    if found["members"]:
        if owner is None:
            owner = members.owner()
        for uid in found["members"]:
            try:
                members.delete_member(owner, uid)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"member {uid}: {exc}")
    for uid, email in found["accounts"].items():
        if not _is_tagged_email(email, prefix):
            continue
        try:
            members.delete_account(uid)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"account {email}: {exc}")

    left = _inventory(
        members, prefix, set(found["accounts"]) | set(found["members"]) | set(known)
    )
    remaining = {k: len(v) for k, v in left.items()}
    clean = not any(remaining.values())
    report.check(
        f"[cleanup] nothing tagged {prefix!r} remains",
        clean and not errors,
        json.dumps(remaining),
    )
    for err in errors:
        out(f"     cleanup error: {_short(err, 300)}")
    return {"found": counts, "remaining": remaining, "errors": errors, "clean": clean}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def _parse(argv) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    p.add_argument(
        "--base-url", default="http://127.0.0.1:9119", help="dashboard URL (loopback)"
    )
    p.add_argument(
        "--auth-provider", default="supabase", help="dashboard password-login provider"
    )
    p.add_argument(
        "--include-owner",
        action="store_true",
        help="also run the in-process checks for the enrolled owner",
    )
    p.add_argument(
        "--chat-turn",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="send one tiny chat turn per member/viewer (default on)",
    )
    p.add_argument(
        "--chat-timeout",
        type=float,
        default=300.0,
        help="seconds to wait for a chat turn",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="print the plan and policy; change nothing",
    )
    p.add_argument(
        "--cleanup",
        metavar="TAG",
        help=f"only delete leftovers of run TAG (zz-accesscheck-<ts>) or {ALL_TAGS}",
    )
    p.add_argument(
        "--skip",
        default="",
        metavar="LETTERS",
        help="skip check groups, e.g. --skip eg (reported as SKIP, never as PASS)",
    )
    p.add_argument(
        "--allow-production",
        action="store_true",
        help="run even though this looks like the production box (not for release gating)",
    )
    args = p.parse_args(argv)
    if args.cleanup and args.cleanup != ALL_TAGS and not _TAG_RE.match(args.cleanup):
        p.error(f"--cleanup takes zz-accesscheck-<unix ts> or {ALL_TAGS}")
    return args


def _prepare_env() -> None:
    home = os.environ.get("HERMES_HOME", "").strip()
    if not home:
        raise SystemExit("Set HERMES_HOME to the dashboard's home (see the docstring).")
    from hermes_cli.env_loader import load_hermes_dotenv

    load_hermes_dotenv(hermes_home=home)


def main(argv=None, *, out: Callable[[str], None] = print) -> int:
    args = _parse(argv)
    _prepare_env()
    report = Report(out=out)
    summary: Dict[str, Any] = {}

    markers = production_markers(args.base_url)
    if markers and not args.allow_production and not args.dry_run:
        out(
            "REFUSED: this looks like the production box ("
            + "; ".join(markers)
            + "). The release gate runs on a TEST install only. "
            "--allow-production overrides it (old pre-gate behaviour)."
        )
        return 2

    if args.cleanup:
        prefix = TAG_PREFIX if args.cleanup == ALL_TAGS else args.cleanup + "-"
        summary = {"mode": "cleanup", "run_tag": args.cleanup}
        summary["cleanup"] = cleanup(
            report, build_members(), prefix, dry_run=args.dry_run
        )
        return _finish(report, summary, out)

    tag = f"{TAG_PREFIX}{int(time.time())}"
    roles = (("owner",) if args.include_owner else ()) + TEST_ROLES
    policy = effective_policy(roles)
    out(
        f"run tag: {tag}  base url: {args.base_url}  HERMES_HOME: {os.environ['HERMES_HOME']}"
    )
    out(
        "plan: create "
        + ", ".join(f"{tag}-{r}{EMAIL_DOMAIN} ({r})" for r in TEST_ROLES)
        + "; redeem invitations; password-login; run checks a-g"
        + ("" if args.chat_turn else " (no chat turn)")
        + "; delete everything tagged"
    )
    out("effective access policy:")
    for role, entry in policy.items():
        out(
            f"  {role:<6} files={entry['files']:<10} deny={entry['deny_tools']}  ({entry['source']})"
        )
    summary = {
        "mode": "dry-run" if args.dry_run else "run",
        "run_tag": tag,
        "policy": policy,
    }
    if args.dry_run:
        return _finish(report, summary, out)

    http = Http(args.base_url)
    members = build_members()
    owner = None
    users: Dict[str, TestUser] = {}
    try:
        owner = members.owner()
        if owner is None:
            raise RuntimeError("no owner is enrolled on this box")
        users = provision(report, http, members, owner, tag, args.auth_provider)
        if report.failed:
            raise RuntimeError("setup failed; skipping checks")
        in_process = dict(users)
        if args.include_owner:
            in_process = {
                "owner": TestUser(
                    role="owner", email="", display=owner.display, user_id=owner.user_id
                ),
                **users,
            }
        check_tool_policy(report, in_process, policy, tag)
        check_agent_tools(report, in_process)
        check_files(report, users, tag)
        check_privacy(report, http, users)
        if args.chat_turn:
            check_chat_identity(report, http, users, members, args.chat_timeout)
        else:
            report.skip("[d] chat identity", "--no-chat-turn")
        for letter, label, run in (
            ("e", "approvals", lambda: check_approvals(report, users)),
            ("f", "network folders", lambda: check_network_folders(report, in_process, policy, tag)),
            ("g", "terminal secrets", lambda: check_terminal_secrets(report, in_process, policy, tag)),
        ):
            if letter in args.skip:
                report.skip(f"[{letter}] {label}", "--skip")
            else:
                run()
    except Exception as exc:  # noqa: BLE001 - always fall through to cleanup
        report.check(
            "run completed", False, f"{type(exc).__name__}: {_short(exc, 300)}"
        )
    finally:
        known = {u.user_id for u in users.values() if u.user_id}
        try:
            summary["cleanup"] = cleanup(
                report, members, tag + "-", owner=owner, known=known
            )
        except Exception as exc:  # noqa: BLE001
            report.check(
                "[cleanup] completed",
                False,
                f"{type(exc).__name__}: {_short(exc, 300)}",
            )
        summary["users"] = {r: u.user_id for r, u in users.items()}
    return _finish(report, summary, out)


def _finish(report: Report, summary: Dict[str, Any], out) -> int:
    if summary.get("mode") == "run":
        summary.pop("policy", None)
    summary.update({
        "pass": report.count("PASS"),
        "fail": report.count("FAIL"),
        "skip": report.count("SKIP"),
        "failed": report.failed,
        "ok": not report.failed,
    })
    out(json.dumps(summary, sort_keys=True))
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
