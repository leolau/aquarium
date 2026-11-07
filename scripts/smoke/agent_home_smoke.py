#!/usr/bin/env python3
"""Post-deploy HTTP smoke test for agent-home (stdlib only, ~1 min, no browser).

Runs on the production box against ``http://127.0.0.1:3100`` after
``/opt/data/deploy-hermes.sh develop``::

    python3 /opt/data/hermes-agent/scripts/smoke/agent_home_smoke.py          # read-only
    python3 /opt/data/hermes-agent/scripts/smoke/agent_home_smoke.py --write  # + lifecycle

Credentials come from ``/root/.aquarium-smoke.env`` (``--env-file``), or from
the same variables in the environment: ``SMOKE_{ADMIN,MEMBER,VIEWER}_{EMAIL,PASSWORD}``.
A role without credentials is reported as SKIP. Secrets are never printed.

Checks (see docs/testing/agent-home-test-plan.md for the full plan):

- logged out: every protected page redirects to ``/login``, public pages render,
  every read BFF ``/api/*`` GET answers 401;
- per role: every page renders (``data-component`` markers present, role-gated
  markers absent) and every read BFF GET answers the expected status;
- privacy: member/viewer chat lists only hold their own chats, admin-visible
  projects that a member can't list are not readable by slug, the directory
  carries no e-mail addresses;
- ``/api/status/summary`` fields are sane;
- the served build SHA is the checkout's ``HEAD`` (or no agent-home file
  changed since the build — deploy only rebuilds agent-home when it moved).

``--write`` also creates a ``[smoke]`` private project and a ``[smoke]`` chat
as the admin test account, checks the basic reads and that member/viewer
can't see them, and ALWAYS deletes both in ``finally``. The project is
archived, then removed with ``DELETE /api/projects/<slug>?confirm=<slug>&purge=smoke``
(the test-data purge: an archived ``[smoke]`` project the caller created goes
with any runs, cards and run sessions), falling back to the plain delete. The chat is deleted
through the Python dashboard API (``--api-url``, default 127.0.0.1:9119):
agent-home has no delete route for chats.

Rows are PASS, WARN (passed only on the one retry after a 5xx/timeout or an
error-state page — the dashboard was struggling), FAIL or SKIP. Exit code 0 when
nothing FAILed (WARN does not fail the run), 1 otherwise, 2 on bad usage.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

DEFAULT_BASE_URL = "http://127.0.0.1:3100"
DEFAULT_API_URL = "http://127.0.0.1:9119"
DEFAULT_ENV_FILE = "/root/.aquarium-smoke.env"
DEFAULT_REPO = "/opt/data/hermes-agent"
SESSION_COOKIE = "__Host-agent_home_session"
SMOKE_PREFIX = "[smoke]"
RETRY_DELAY_S = 2.0

ANON, VIEWER, MEMBER, ADMIN = "anon", "viewer", "member", "admin"
ROLES = (VIEWER, MEMBER, ADMIN)
ALL = (ANON,) + ROLES

# Rendered by every signed-in page (layout + shell).
SHELL_MARKERS = ("RootLayout", "MobileShell", "StatusStrip")
# Shown only to owner/admin; must never reach a member/viewer's HTML.
ADMIN_ONLY_MARKERS = ("CreateUserForm", "CsvImportPanel", "UserRow", "IdentityActivityPanel")

# ---------------------------------------------------------------------------
# Specs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PageSpec:
    path: str
    markers: Tuple[str, ...] = ()
    # Logged-out expectation: "login" (redirect to /login) or "public".
    anon: str = "login"
    anon_markers: Tuple[str, ...] = ()
    # Signed-in redirect target, if the page always redirects.
    redirect: Optional[str] = None
    not_found: bool = False
    # 404 for admins only (members/viewers get the not-available page first).
    admin_not_found: bool = False
    admin_markers: Tuple[str, ...] = ()
    member_markers: Tuple[str, ...] = ()
    # Members/viewers are redirected here instead (a server-side redirect).
    member_redirect: Optional[str] = None
    # Public pages render outside the signed-in shell even for a session.
    shell: bool = True
    quick: bool = False


PAGES: Tuple[PageSpec, ...] = (
    PageSpec("/", ("PrincipalCard", "ProjectsHomeCard", "LogoutButton"), quick=True),
    PageSpec("/login", anon="public", anon_markers=("LoginForm",), redirect="/", quick=True),
    PageSpec("/setup", ("SetupChecking",), shell=False, anon="public", anon_markers=("SetupChecking",)),
    PageSpec("/activate/smoke-bogus-token", ("ActivateForm",), shell=False, anon="public", anon_markers=("ActivateForm",)),
    PageSpec("/activate/default/smoke-bogus-token", ("ActivateForm",), shell=False, anon="public", anon_markers=("ActivateForm",)),
    PageSpec("/survey/smoke-bogus-token", ("SurveyLinkInvalid",), shell=False, anon="public", anon_markers=("SurveyLinkInvalid",)),
    PageSpec("/fb/smoke-bogus-token"),
    PageSpec("/onboarding", ("OnboardingWizard",)),
    # ProfilePicker renders only for an account enrolled in two or more profiles.
    PageSpec("/chat", ("ChatPane", "Composer", "SessionTabs"), quick=True),
    PageSpec("/projects", ("ProjectsList", "ProjectsFilters", "NewProjectAction"), quick=True),
    PageSpec("/projects?view=task", ("ModeSwitch", "TaskHome")),
    PageSpec("/projects?view=project", ("ModeSwitch", "ProjectsList")),
    PageSpec("/projects/new", ("NewProjectForm",)),
    PageSpec("/projects/zz-smoke-missing", not_found=True),
    PageSpec("/projects/zz-smoke-missing/cards/zz-smoke-missing", not_found=True),
    PageSpec("/projects/zz-smoke-missing/runs/1", not_found=True),
    PageSpec("/todos", ("TodosList",), quick=True),
    PageSpec("/todos/zz-smoke-missing", not_found=True),
    PageSpec("/inbox", ("InboxView",), quick=True),
    PageSpec("/inbox/zz-smoke-missing", not_found=True),
    PageSpec("/files", ("FilesView", "FilesTabs"), quick=True),
    PageSpec("/files/browse", ("BrowseView", "FilesTabs")),
    PageSpec("/files/bridge", ("FilesTabs",)),
    PageSpec("/bridge"),
    PageSpec("/memory", ("MemoryView",), quick=True),
    PageSpec("/graph", ("GtsCentreView",)),
    PageSpec("/core", ("CoreAreaView",)),
    PageSpec("/activity", ("TraceTimeline",)),
    PageSpec("/activity/zz-smoke-missing", ("TraceDetailError",)),
    PageSpec("/capacity", ("CapacityView",)),
    PageSpec("/models", ("ModelsView",), quick=True),
    PageSpec("/tools", ("ToolsRegistry",), quick=True),
    PageSpec("/tools/zz-smoke-missing", ("ToolsError",)),
    PageSpec("/settings", ("SettingsView", "AccountSecurity"), quick=True),
    PageSpec("/settings/tools", ("ToolsSettings", "RoleLimitsSection")),
    PageSpec("/settings/get-ready", ("GetReadyView",)),
    PageSpec(
        "/settings/upgrade",
        admin_markers=("SoftwareUpgradeView",),
        member_redirect="/not-available",
    ),
    PageSpec("/profiles/suggestions", ("ProfileSuggestionsView",)),
    # Owner/admin only: members and viewers get the not-available page.
    PageSpec("/profiles", admin_markers=("ProfilesView",), member_markers=("NotAvailableForRole",)),
    PageSpec("/skills", admin_markers=("SkillsView",), member_markers=("NotAvailableForRole",)),
    PageSpec("/skills/zz-smoke-missing", admin_not_found=True, member_markers=("NotAvailableForRole",)),
    PageSpec("/skills/zz-smoke-missing/edit", admin_not_found=True, member_markers=("NotAvailableForRole",)),
    PageSpec("/webview", ("WebviewConsole",)),
    PageSpec(
        "/users",
        ("UsersView", "DirectoryPanel"),
        admin_markers=("CreateUserForm", "UsersList"),
        member_markers=("UsersReadOnlyNotice",),
        quick=True,
    ),
    PageSpec("/members", anon="redirect:/users", redirect="/users"),
    PageSpec("/not-available", ("NotAvailableForRole",)),
    PageSpec("/default-profile-only", ("DefaultProfileOnly",)),
)


def _same(status: int) -> Dict[str, int]:
    return {VIEWER: status, MEMBER: status, ADMIN: status}


OK = _same(200)
ADMIN_ONLY = {VIEWER: 403, MEMBER: 403, ADMIN: 200}
OWNER_ONLY = _same(403)  # the test accounts are never the owner
NEEDS_PARAMS = _same(400)


@dataclass(frozen=True)
class ApiSpec:
    path: str
    expect: Mapping[str, int]
    anon: int = 401
    quick: bool = False


APIS: Tuple[ApiSpec, ...] = (
    ApiSpec("/api/status/summary", OK, quick=True),
    ApiSpec("/api/access/roles", OK),
    ApiSpec("/api/activity/running", OK),
    ApiSpec("/api/settings/menu", OK),
    ApiSpec("/api/account/security", OK),
    ApiSpec("/api/browse/places", OK),
    ApiSpec("/api/browse/list", NEEDS_PARAMS),
    ApiSpec("/api/browse/file", NEEDS_PARAMS),
    ApiSpec("/api/chat/lead", OK),
    ApiSpec("/api/chat/profiles", OK, quick=True),
    ApiSpec("/api/chat/sessions", OK, quick=True),
    ApiSpec("/api/chat/sessions?archived=only", OK),
    ApiSpec("/api/chat/sessions/search?q=smoke", OK),
    ApiSpec("/api/chat/sessions/tags", OK),
    ApiSpec("/api/chat/sessions/tags/get", NEEDS_PARAMS),
    ApiSpec("/api/chat/active", NEEDS_PARAMS),
    ApiSpec("/api/chat/messages", NEEDS_PARAMS),
    ApiSpec("/api/chat/media", NEEDS_PARAMS),
    ApiSpec("/api/chat/media/content", NEEDS_PARAMS),
    ApiSpec("/api/comms/changes", OK),
    ApiSpec("/api/comms/directory", OK),
    ApiSpec("/api/comms/notifications", OK),
    ApiSpec("/api/comms/members", ADMIN_ONLY, quick=True),
    ApiSpec("/api/comms/members/activity", ADMIN_ONLY),
    ApiSpec("/api/credentials", OK),
    ApiSpec("/api/email-accounts", _same(403)),
    ApiSpec("/api/email/mailboxes", OK),
    ApiSpec("/api/files", OK, quick=True),
    ApiSpec("/api/files/surfaces", OK),
    ApiSpec("/api/files/by-path", NEEDS_PARAMS),
    ApiSpec("/api/get-ready", OK),
    ApiSpec("/api/get-ready/people", ADMIN_ONLY),
    ApiSpec("/api/goals/entity", OK),
    ApiSpec("/api/google-client", OWNER_ONLY),
    ApiSpec("/api/backups/offsite", OWNER_ONLY),
    # Read-only status: GET never starts an upgrade (start/rollback are POST + password).
    ApiSpec("/api/software-upgrade", ADMIN_ONLY),
    ApiSpec("/api/incomings", OK, quick=True),
    ApiSpec("/api/incomings/facets", OK),
    ApiSpec("/api/incomings/zz-smoke-missing", _same(404)),
    ApiSpec("/api/memory/projection", OK),
    ApiSpec("/api/memory/rows", OK, quick=True),
    ApiSpec("/api/models/fallback", OK),
    ApiSpec("/api/models/options", OK),
    ApiSpec("/api/models/overview", OK, quick=True),
    ApiSpec("/api/models/performance", OK),
    ApiSpec("/api/models/pinned", OK),
    ApiSpec("/api/notifications/vapid-public-key", OK),
    ApiSpec("/api/notifications/config", _same(401)),  # internal: never a browser session
    ApiSpec("/api/profiles", ADMIN_ONLY),
    ApiSpec("/api/profiles/suggestions", OK),
    ApiSpec("/api/project-categories", OK),
    ApiSpec("/api/projects", OK, quick=True),
    ApiSpec("/api/projects?archived=true", OK),
    ApiSpec("/api/projects/doctor", OK),
    ApiSpec("/api/projects/zz-smoke-missing", _same(404)),
    ApiSpec("/api/security-basics", ADMIN_ONLY),
    ApiSpec("/api/skills", ADMIN_ONLY),
    ApiSpec("/api/skills/details?name=zz-smoke-missing", {VIEWER: 403, MEMBER: 403, ADMIN: 404}),
    ApiSpec("/api/settings/apps/github", ADMIN_ONLY),
    ApiSpec("/api/settings/apps/limits", ADMIN_ONLY),
    ApiSpec("/api/settings/apps/storage", ADMIN_ONLY),
    ApiSpec("/api/telegram-bot", OK),
    ApiSpec("/api/todos", OK, quick=True),
    ApiSpec("/api/todos/facets", OK),
    ApiSpec("/api/todos/zz-smoke-missing", _same(404)),
    ApiSpec("/api/tools/personal-mcp", OK),
    ApiSpec("/api/tools/personal-mcp/catalog", OK),
    ApiSpec("/api/tools/personal-mcp/people", ADMIN_ONLY),
    ApiSpec("/api/vpn", OK),
    ApiSpec("/api/vpn/folders", OK),
    ApiSpec("/api/wa-bridges", OK),
    ApiSpec("/api/webview/session", OK),
    ApiSpec("/api/sw", OK, anon=200),
)

# ---------------------------------------------------------------------------
# Pure helpers (unit-tested in tests/scripts/test_agent_home_smoke.py)
# ---------------------------------------------------------------------------

_MARKER_RE = re.compile(r'data-component="([^"]+)"')
_REDIRECT_RE = re.compile(r"NEXT_REDIRECT;(?:replace|push);([^;\"\\]+)")
_NOT_FOUND_RE = re.compile(r"NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND")


def parse_env_file(text: str) -> Dict[str, str]:
    """``KEY=value`` lines (optional ``export``, quotes, ``#`` comments)."""
    out: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def load_credentials(env_text: Optional[str], environ: Mapping[str, str]) -> Dict[str, Tuple[str, str]]:
    """Role -> (email, password). Environment variables win over the file."""
    merged = dict(parse_env_file(env_text or ""))
    merged.update({k: v for k, v in environ.items() if k.startswith("SMOKE_")})
    creds: Dict[str, Tuple[str, str]] = {}
    for role in ROLES:
        email = merged.get(f"SMOKE_{role.upper()}_EMAIL", "")
        password = merged.get(f"SMOKE_{role.upper()}_PASSWORD", "")
        if email and password:
            creds[role] = (email, password)
    return creds


def markers(html: str) -> set:
    return set(_MARKER_RE.findall(html))


def streamed_redirect(html: str) -> Optional[str]:
    """Target of a server ``redirect()`` streamed into a 200 page, if any."""
    match = _REDIRECT_RE.search(html)
    return match.group(1) if match else None


def streamed_not_found(html: str) -> bool:
    return bool(_NOT_FOUND_RE.search(html))


def session_cookie(set_cookie_headers: Iterable[str], name: str = SESSION_COOKIE) -> Optional[str]:
    """``name=value`` for the session cookie (Secure cookies are dropped by
    cookie jars over plain http, so it is forwarded by hand)."""
    for header in set_cookie_headers:
        match = re.search(rf"(?:^|[\s,]){re.escape(name)}=([^;,\s]+)", header)
        if match and match.group(1):
            return f"{name}={match.group(1)}"
    return None


def cookie_header(set_cookie_headers: Iterable[str]) -> str:
    """Every cookie from ``Set-Cookie`` headers as one ``Cookie`` header."""
    pairs = []
    for header in set_cookie_headers:
        first = header.split(";", 1)[0].strip()
        if "=" in first and first.split("=", 1)[1]:
            pairs.append(first)
    return "; ".join(pairs)


def page_verdict(spec: PageSpec, role: str, status: int, html: str) -> Tuple[bool, str]:
    """(ok, detail) for one page fetch as ``role``."""
    if status != 200:
        return False, f"HTTP {status}"
    found = markers(html)
    target = streamed_redirect(html)
    if role == ANON:
        if spec.anon == "login" or spec.anon.startswith("redirect:"):
            want = "/login" if spec.anon == "login" else spec.anon.split(":", 1)[1]
            return (target == want, f"redirect -> {target or 'none'} (want {want})")
        missing = [m for m in spec.anon_markers if m not in found]
        if target:
            return False, f"unexpected redirect -> {target}"
        return (not missing, "missing " + ",".join(missing) if missing else "rendered")
    want_redirect = spec.redirect or (spec.member_redirect if role != ADMIN else None)
    if want_redirect:
        return (target == want_redirect, f"redirect -> {target or 'none'} (want {want_redirect})")
    if target:
        return False, f"unexpected redirect -> {target}"
    if spec.not_found or (spec.admin_not_found and role == ADMIN):
        return (streamed_not_found(html), "404 page" if streamed_not_found(html) else "no 404 marker")
    want = (list(SHELL_MARKERS) if spec.shell else []) + list(spec.markers)
    want += list(spec.admin_markers if role == ADMIN else spec.member_markers)
    missing = [m for m in want if m not in found]
    leaked = [m for m in ADMIN_ONLY_MARKERS if role != ADMIN and m in found]
    problems = []
    if missing:
        problems.append("missing " + ",".join(missing))
        errors = sorted(m for m in found if m.endswith(("Error", "NoPrincipal")))
        if errors:
            problems.append("rendered " + ",".join(errors))
    if leaked:
        problems.append("admin-only markers leaked: " + ",".join(leaked))
    return (not problems, "; ".join(problems) or f"{len(found)} markers")


def summary_problems(summary: Mapping[str, Any]) -> List[str]:
    """Sanity problems in a ``/api/status/summary`` payload (empty = sane)."""
    problems: List[str] = []
    for key in ("cpu_pct", "mem_pct", "disk_pct"):
        value = summary.get(key)
        if not isinstance(value, (int, float)) or not 0 <= value <= 100:
            problems.append(f"{key}={value!r}")
    tokens = summary.get("tokens_month")
    if not isinstance(tokens, dict) or any(
        not isinstance(tokens.get(k), int) or tokens.get(k) < 0 for k in ("input", "output")
    ):
        problems.append(f"tokens_month={tokens!r}")
    for key in ("active_conversations", "running_cards", "cron_total", "cron_enabled"):
        value = summary.get(key)
        if not isinstance(value, int) or value < 0:
            problems.append(f"{key}={value!r}")
    if isinstance(summary.get("cron_total"), int) and isinstance(summary.get("cron_enabled"), int):
        if summary["cron_enabled"] > summary["cron_total"]:
            problems.append("cron_enabled > cron_total")
    collected = summary.get("collected_at")
    if not isinstance(collected, (int, float)) or abs(time.time() - collected) > 600:
        problems.append(f"collected_at={collected!r}")
    if not summary.get("build"):
        problems.append("build missing")
    return problems


def build_verdict(served: Optional[str], head: str, changed_since: Callable[[str], Optional[List[str]]]) -> Tuple[bool, str]:
    """Served build vs checkout HEAD. A lagging build is fine when nothing under
    agent-home/ (or the lockfile) changed since it: deploy skips the rebuild."""
    if not served:
        return False, "summary has no build SHA"
    if head.startswith(served) or served.startswith(head):
        return True, f"build {served} == HEAD"
    changed = changed_since(served)
    if changed is None:
        return False, f"build {served} != HEAD {head[:9]} (build SHA unknown to git)"
    relevant = [p for p in changed if p.startswith("agent-home/") or p == "package-lock.json"]
    if relevant:
        return False, f"build {served} != HEAD {head[:9]}; {len(relevant)} agent-home files changed (stale build)"
    return True, f"build {served}, HEAD {head[:9]}: no agent-home changes since the build"


def row_status(ok: Optional[bool], retried: bool = False) -> str:
    if ok is None:
        return "SKIP"
    if not ok:
        return "FAIL"
    return "WARN" if retried else "PASS"


def summary_line(rows: Sequence[Tuple[str, str, str]], elapsed: float, base_url: str, write: bool) -> str:
    counts = {s: sum(1 for r in rows if r[0] == s) for s in ("PASS", "WARN", "FAIL", "SKIP")}
    return (
        f"{counts['PASS']} PASS, {counts['WARN']} WARN (passed only on retry), "
        f"{counts['FAIL']} FAIL, {counts['SKIP']} SKIP in {elapsed:.1f}s against {base_url}"
        + (" (--write)" if write else "")
    )


def format_table(rows: Sequence[Tuple[str, str, str]]) -> str:
    """Rows of (status, check, detail) as an aligned text table."""
    width = max([len(r[1]) for r in rows] + [5])
    lines = [f"{'RESULT':<6}  {'CHECK':<{width}}  DETAIL", f"{'-' * 6}  {'-' * width}  {'-' * 6}"]
    lines += [f"{s:<6}  {c:<{width}}  {d}" for s, c, d in rows]
    return "\n".join(lines)


def smoke_name(kind: str, stamp: object) -> str:
    return f"{SMOKE_PREFIX} {kind} {stamp}"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401 - urllib hook
        return None


@dataclass
class Resp:
    status: int
    body: bytes
    set_cookies: List[str] = field(default_factory=list)
    location: str = ""
    elapsed: float = 0.0

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None


class Http:
    def __init__(self, base_url: str, timeout: float = 45.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._opener = urllib.request.build_opener(_NoRedirect)

    def request(self, method: str, path: str, *, cookie: str = "", body: Any = None) -> Resp:
        headers = {"Accept": "*/*"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        started = time.monotonic()
        try:
            resp = self._opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as err:
            resp = err
        except (urllib.error.URLError, OSError) as err:
            return Resp(0, str(err).encode(), elapsed=time.monotonic() - started)
        with resp:
            raw = resp.read()
            return Resp(
                status=resp.status,
                body=raw,
                set_cookies=resp.headers.get_all("Set-Cookie") or [],
                location=resp.headers.get("Location", ""),
                elapsed=time.monotonic() - started,
            )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


class Report:
    def __init__(self) -> None:
        self.rows: List[Tuple[str, str, str]] = []

    def add(self, ok: Optional[bool], name: str, detail: str = "", *, retried: bool = False) -> bool:
        """``ok=None`` is SKIP; a pass that needed the retry is WARN, not PASS."""
        self.rows.append((row_status(ok, retried), name, detail))
        return bool(ok)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.rows if r[0] == "FAIL")


def _status_detail(resp: Resp) -> str:
    if resp.status == 0:
        return f"unreachable: {resp.text[:80]}"
    data = resp.json()
    if isinstance(data, dict) and (data.get("error") or data.get("detail")):
        return f"HTTP {resp.status} {str(data.get('detail') or data.get('error'))[:80]}"
    return f"HTTP {resp.status}"


class Smoke:
    def __init__(self, args: argparse.Namespace, creds: Dict[str, Tuple[str, str]]) -> None:
        self.args = args
        self.http = Http(args.base_url)
        self.creds = creds
        self.cookies: Dict[str, str] = {ANON: ""}
        self.user_ids: Dict[str, str] = {}
        self.report = Report()

    # -- helpers -----------------------------------------------------------

    def get(self, role: str, path: str) -> Resp:
        return self.http.request("GET", path, cookie=self.cookies.get(role, ""))

    def parallel(self, jobs: Sequence[Tuple[Any, ...]], fn: Callable[..., Any]) -> List[Any]:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, self.args.concurrency)) as pool:
            return list(pool.map(lambda job: fn(*job), jobs))

    def roles(self) -> List[str]:
        return [r for r in ROLES if r in self.cookies]

    # -- checks ------------------------------------------------------------

    def login(self) -> None:
        for role in ROLES:
            if role not in self.creds:
                self.report.add(None, f"login {role}", "no credentials")
                continue
            email, password = self.creds[role]
            resp = self.http.request(
                "POST", "/api/session/login",
                body={"provider": "supabase", "username": email, "password": password},
            )
            cookie = session_cookie(resp.set_cookies)
            if self.report.add(resp.status == 200 and bool(cookie), f"login {role}", _status_detail(resp)):
                self.cookies[role] = cookie or ""
        bad = self.http.request(
            "POST", "/api/session/login",
            body={"provider": "supabase", "username": "nobody-smoke@example.invalid", "password": "wrong-password"},
        )
        self.report.add(
            bad.status in (400, 401, 403) and not session_cookie(bad.set_cookies),
            "login refuses bad password", _status_detail(bad),
        )
        for role in self.roles():
            data = self.get(role, "/api/webview/session").json() or {}
            if isinstance(data, dict) and data.get("principal"):
                self.user_ids[role] = str(data["principal"])

    def pages(self) -> None:
        specs = [p for p in PAGES if p.quick or not self.args.quick]
        jobs = [(role, spec) for role in [ANON] + self.roles() for spec in specs]

        def run(role: str, spec: PageSpec) -> Tuple[str, PageSpec, bool, str, bool]:
            resp = self.get(role, spec.path)
            ok, detail = page_verdict(spec, role, resp.status, resp.text)
            retried = False
            if not ok:
                # One retry: a page whose server fetch timed out under the
                # parallel load renders its error state. Still reported.
                time.sleep(RETRY_DELAY_S)
                retry = self.get(role, spec.path)
                ok, again = page_verdict(spec, role, retry.status, retry.text)
                retried = ok
                detail = f"{again} (1st try: {detail})" if ok else detail
            return role, spec, ok, detail, retried

        for role, spec, ok, detail, retried in self.parallel(jobs, run):
            self.report.add(ok, f"page {role:<6} {spec.path}", detail, retried=retried)

    def apis(self) -> None:
        specs = [a for a in APIS if a.quick or not self.args.quick]
        jobs = [(role, spec) for role in [ANON] + self.roles() for spec in specs]

        def run(role: str, spec: ApiSpec) -> Tuple[str, ApiSpec, bool, str, bool]:
            want = spec.anon if role == ANON else spec.expect[role]
            resp = self.get(role, spec.path)
            detail = f"{_status_detail(resp)} (want {want})"
            if resp.status != want and (resp.status == 0 or resp.status >= 500):
                # One retry for a transient upstream error / timeout. Still reported.
                time.sleep(RETRY_DELAY_S)
                retry = self.get(role, spec.path)
                if retry.status == want:
                    return role, spec, True, f"HTTP {retry.status} (1st try: {detail})", True
            return role, spec, resp.status == want, detail, False

        for role, spec, ok, detail, retried in self.parallel(jobs, run):
            self.report.add(ok, f"api  {role:<6} {spec.path}", detail, retried=retried)

    def privacy(self) -> None:
        for role in (MEMBER, VIEWER):
            if role not in self.cookies:
                continue
            uid = self.user_ids.get(role)
            data = self.get(role, "/api/chat/sessions").json() or {}
            sessions = data.get("sessions", []) if isinstance(data, dict) else []
            foreign = [s.get("id") for s in sessions if s.get("user_id") not in (uid, None)]
            self.report.add(
                bool(uid) and not foreign, f"privacy {role}: chat list holds only own chats",
                f"{len(sessions)} sessions, {len(foreign)} foreign" if uid else "own user id unknown",
            )
            directory = self.get(role, "/api/comms/directory").json() or {}
            entries = directory.get("entries", []) if isinstance(directory, dict) else []
            with_email = [e for e in entries if isinstance(e, dict) and (e.get("email") or "@" in str(e.get("display", "")))]
            self.report.add(not with_email, f"privacy {role}: directory has no e-mail addresses", f"{len(entries)} entries")
        if ADMIN in self.cookies:
            admin_list = self.get(ADMIN, "/api/projects?limit=200").json() or {}
            admin_slugs = [p.get("slug") for p in admin_list.get("items", [])] if isinstance(admin_list, dict) else []
            for role in (MEMBER, VIEWER):
                if role not in self.cookies:
                    continue
                mine = self.get(role, "/api/projects?limit=200").json() or {}
                visible = {p.get("slug") for p in mine.get("items", [])} if isinstance(mine, dict) else set()
                hidden = [s for s in admin_slugs if s and s not in visible][:3]
                if not hidden:
                    self.report.add(None, f"privacy {role}: unlisted project not readable", "no admin-only project to probe")
                    continue
                statuses = [self.get(role, f"/api/projects/{urllib.parse.quote(s)}").status for s in hidden]
                boards = [self.get(role, f"/api/projects/{urllib.parse.quote(s)}/board").status for s in hidden[:1]]
                self.report.add(
                    all(s in (403, 404) for s in statuses + boards),
                    f"privacy {role}: unlisted project not readable",
                    f"{len(hidden)} probed, detail {statuses}, board {boards}",
                )

    def summary(self) -> None:
        role = next((r for r in (ADMIN, MEMBER, VIEWER) if r in self.cookies), None)
        if role is None:
            self.report.add(None, "status summary sane", "no signed-in role")
            self.report.add(None, "served build == deployed SHA", "no signed-in role")
            return
        resp = self.get(role, "/api/status/summary")
        data = resp.json() if resp.status == 200 else None
        problems = summary_problems(data) if isinstance(data, dict) else [_status_detail(resp)]
        self.report.add(not problems, f"status summary sane ({role})", "; ".join(problems) or "ok")
        served = data.get("build") if isinstance(data, dict) else None
        repo = self.args.repo
        if not repo or not os.path.isdir(os.path.join(repo, ".git")):
            self.report.add(None, "served build == deployed SHA", f"no checkout at {repo or '-'}; served {served}")
            return
        head = _git(repo, "rev-parse", "HEAD")

        def changed_since(sha: str) -> Optional[List[str]]:
            out = _git(repo, "diff", "--name-only", sha, "HEAD")
            return None if out is None else [line for line in out.splitlines() if line]

        if head is None:
            self.report.add(False, "served build == deployed SHA", "git rev-parse failed")
            return
        ok, detail = build_verdict(served, head, changed_since)
        self.report.add(ok, "served build == deployed SHA", detail)

    # -- write mode --------------------------------------------------------

    def write(self) -> None:
        if ADMIN not in self.cookies:
            self.report.add(None, "write: lifecycle", "admin not signed in")
            return
        stamp = f"{int(time.time())}-{secrets.token_hex(3)}"
        slug: Optional[str] = None
        session_id: Optional[str] = None
        try:
            slug = self._write_project(stamp)
            session_id = self._write_chat(stamp)
        finally:
            if slug:
                self._cleanup_project(slug)
            if session_id:
                self._cleanup_chat(session_id)

    def _write_project(self, stamp: str) -> Optional[str]:
        payload = {
            "name": smoke_name("project", stamp),
            "goal": f"{SMOKE_PREFIX} throwaway project from the agent-home smoke test",
            "description": f"{SMOKE_PREFIX} created and deleted by scripts/smoke/agent_home_smoke.py --write",
            "outputs": [{"title": f"{SMOKE_PREFIX} output"}],
            "host_profile": "default",
            "visibility": "private",
        }
        resp = self.http.request("POST", "/api/projects", cookie=self.cookies[ADMIN], body=payload)
        data = resp.json() if resp.status == 200 else None
        slug = data.get("slug") if isinstance(data, dict) else None
        if not self.report.add(bool(slug), "write: create [smoke] project", _status_detail(resp) + (f" slug={slug}" if slug else "")):
            return None
        q = urllib.parse.quote(slug)
        detail = self.get(ADMIN, f"/api/projects/{q}")
        name = (detail.json() or {}).get("name") if detail.status == 200 else None
        self.report.add(name == payload["name"], "write: project detail readable", _status_detail(detail))
        for sub in ("board", "runs", "changes", "directives", "playbook", "events", "doctor"):
            r = self.get(ADMIN, f"/api/projects/{q}/{sub}")
            self.report.add(r.status == 200, f"write: project {sub}", _status_detail(r))
        listing = self.get(ADMIN, "/api/projects?limit=200").json() or {}
        listed = slug in {p.get("slug") for p in listing.get("items", [])}
        self.report.add(listed, "write: project in admin list", "listed" if listed else "missing")
        page = self.get(ADMIN, f"/projects/{q}")
        self.report.add(
            page.status == 200 and "ProjectDetailView" in markers(page.text),
            "write: /projects/[slug] renders", _status_detail(page),
        )
        for role in (MEMBER, VIEWER):
            if role not in self.cookies:
                continue
            r = self.get(role, f"/api/projects/{q}")
            mine = self.get(role, "/api/projects?limit=200").json() or {}
            seen = slug in {p.get("slug") for p in mine.get("items", [])}
            self.report.add(
                r.status in (403, 404) and not seen,
                f"write: {role} can't see private project", f"{_status_detail(r)}, listed={seen}",
            )
        return slug

    def _write_chat(self, stamp: str) -> Optional[str]:
        resp = self.http.request("POST", "/api/chat/new", cookie=self.cookies[ADMIN], body={})
        data = resp.json() if resp.status == 200 else None
        sid = (data.get("session_id") or data.get("sessionId")) if isinstance(data, dict) else None
        if not self.report.add(bool(sid), "write: create chat", _status_detail(resp)):
            return None
        title = smoke_name("chat", stamp)
        r = self.http.request("PATCH", "/api/chat/sessions/rename", cookie=self.cookies[ADMIN], body={"sessionId": sid, "title": title})
        self.report.add(r.status == 200, "write: rename chat to [smoke]", _status_detail(r))
        q = urllib.parse.quote(sid)
        r = self.get(ADMIN, f"/api/chat/messages?sessionId={q}")
        self.report.add(r.status == 200, "write: chat messages readable", _status_detail(r))
        r = self.http.request("PATCH", "/api/chat/sessions/archive", cookie=self.cookies[ADMIN], body={"sessionId": sid, "archived": True})
        archived = self.get(ADMIN, "/api/chat/sessions?archived=only").json() or {}
        in_archive = sid in {s.get("id") for s in archived.get("sessions", [])}
        self.report.add(r.status == 200 and in_archive, "write: archive chat", f"{_status_detail(r)}, in archive={in_archive}")
        for role in (MEMBER, VIEWER):
            if role not in self.cookies:
                continue
            r = self.get(role, f"/api/chat/messages?sessionId={q}")
            self.report.add(r.status in (403, 404), f"write: {role} can't read admin chat", _status_detail(r))
        return sid

    def _cleanup_project(self, slug: str) -> None:
        q = urllib.parse.quote(slug)
        cookie = self.cookies[ADMIN]
        archive = self.http.request("POST", f"/api/projects/{q}/archive", cookie=cookie, body={"reason": "smoke cleanup"})
        delete = self.http.request("DELETE", f"/api/projects/{q}?confirm={q}&purge=smoke", cookie=cookie)
        if delete.status not in (200, 404):
            delete = self.http.request("DELETE", f"/api/projects/{q}?confirm={q}", cookie=cookie)
        gone = self.get(ADMIN, f"/api/projects/{q}")
        # 404 on delete = something else (a parallel smoke run's sweep) already
        # removed it; what matters is that it is gone.
        self.report.add(
            delete.status in (200, 404) and gone.status == 404, "cleanup: [smoke] project deleted",
            f"archive {archive.status}, delete {_status_detail(delete)}, then {gone.status}",
        )

    def _cleanup_chat(self, sid: str) -> None:
        email, password = self.creds[ADMIN]
        api = Http(self.args.api_url)
        login = api.request("POST", "/auth/password-login", body={"provider": "supabase", "username": email, "password": password})
        cookie = cookie_header(login.set_cookies)
        detail = f"dashboard login {login.status}"
        deleted = False
        if login.status == 200 and cookie:
            r = api.request("DELETE", f"/api/sessions/{urllib.parse.quote(sid)}", cookie=cookie)
            deleted = r.status == 200
            detail += f", delete {_status_detail(r)}"
        gone = self.get(ADMIN, f"/api/chat/messages?sessionId={urllib.parse.quote(sid)}")
        detail += f", then {gone.status}"
        self.report.add(deleted and gone.status == 404, "cleanup: [smoke] chat deleted", detail)

    def logout(self) -> None:
        for role in self.roles():
            self.http.request("POST", "/api/session/logout", cookie=self.cookies[role], body={})

    def run(self) -> int:
        started = time.monotonic()
        self.login()
        try:
            self.pages()
            self.apis()
            self.privacy()
            self.summary()
            if self.args.write:
                self.write()
        finally:
            self.logout()
        rows = self.report.rows
        if self.args.failures_only:
            rows = [r for r in rows if r[0] != "PASS"]  # keeps WARN
        print(format_table(rows) if rows else "(no failures)")
        print("\n" + summary_line(self.report.rows, time.monotonic() - started, self.args.base_url, self.args.write))
        return 1 if self.report.failed else 0


def _git(repo: str, *args: str) -> Optional[str]:
    try:
        return subprocess.run(
            ["git", "-C", repo, *args], capture_output=True, text=True, check=True, timeout=30
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="agent-home origin (default %(default)s)")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="Python dashboard origin, for --write chat cleanup")
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE, help="credentials file (default %(default)s)")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="checkout whose HEAD the build must match ('' to skip)")
    parser.add_argument("--write", action="store_true", help="also create + delete a [smoke] project and chat")
    parser.add_argument("--quick", action="store_true", help="only the quick smoke subset of pages/APIs")
    parser.add_argument("--failures-only", action="store_true", help="print only FAIL/SKIP rows")
    parser.add_argument(
        "--concurrency", type=int, default=2,
        help="parallel requests (default %(default)s; higher overloads the prod dashboard)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    env_text = None
    if args.env_file and os.path.exists(args.env_file):
        try:
            with open(args.env_file, encoding="utf-8") as fh:
                env_text = fh.read()
        except OSError as err:
            print(f"cannot read {args.env_file}: {err}", file=sys.stderr)
            return 2
    creds = load_credentials(env_text, os.environ)
    if not creds:
        print(f"no SMOKE_* credentials in {args.env_file} or the environment", file=sys.stderr)
        return 2
    return Smoke(args, creds).run()


if __name__ == "__main__":
    sys.exit(main())
