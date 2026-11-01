"""Tests for the bundled auth-web-crawler skill (mocked HTTP, no network)."""

import importlib.util
import io
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SKILL_DIR = Path(__file__).resolve().parents[2] / "skills" / "research" / "auth-web-crawler"
SECRET = "S3cr3t-Pa55!"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SKILL_DIR / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def ac(monkeypatch):
    module = _load("auth_crawl_under_test", "auth_crawl.py")
    monkeypatch.setattr(module, "check_url_allowed", lambda url: None)
    yield module
    sys.modules.pop("auth_crawl_under_test", None)


class FakeResponse:
    def __init__(self, url, text="", status_code=200, content_type="text/html", headers=None):
        self.url = url
        self.text = text
        self.status_code = status_code
        self.headers = {"Content-Type": content_type, **(headers or {})}


class FakeSession:
    """Routes ``(METHOD, url)`` to a response or a callable(session, **kw)."""

    def __init__(self, routes):
        self.routes = routes
        self.cookies = {}
        self.calls = []

    def _dispatch(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        route = self.routes.get((method, url))
        if route is None:
            return FakeResponse(url, "not found", status_code=404)
        return route(self, **kwargs) if callable(route) else route

    def get(self, url, params=None, timeout=None):
        return self._dispatch("GET", url, params=params)

    def post(self, url, data=None, timeout=None):
        return self._dispatch("POST", url, data=data)


LOGIN_HTML = """
<html><body>
<form action="/search" method="get"><input type="text" name="q"></form>
<form action="/session" method="post">
  <input type="hidden" name="csrf_token" value="tok-123">
  <input type="hidden" name="next" value="/docs/">
  <input type="email" name="email" id="email">
  <input type="password" name="pass">
  <input type="checkbox" name="remember" value="1">
  <input type="submit" name="commit" value="Sign in">
</form></body></html>
"""
FAILED_HTML = (
    '<p class="error">Invalid username or password</p>'
    '<form action="/session" method="post"><input type="password" name="pass"></form>'
)
HOME_HTML = '<title>Docs</title><a href="/logout">Log out</a><p>Members only</p>'


# -- SKILL.md standards ------------------------------------------------------


def test_skill_frontmatter_and_sections():
    content = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    assert re.search(r"^name: auth-web-crawler$", content, re.M)
    description = re.search(r"^description: (.+)$", content, re.M).group(1).strip()
    assert len(description) <= 60 and description.endswith(".")
    assert re.search(r"^platforms: \[.+\]$", content, re.M)
    assert re.search(r"^author: .+$", content, re.M)
    sections = [
        "# Auth Web Crawler Skill",
        "## When to Use",
        "## Prerequisites",
        "## How to Run",
        "## Quick Reference",
        "## Procedure",
        "## Pitfalls",
        "## Verification",
    ]
    positions = [content.index(s) for s in sections]
    assert positions == sorted(positions)
    for tool in ("browser_navigate", "browser_type", "browser_click", "browser_snapshot"):
        assert f"`{tool}`" in content
    for script in ("scripts/auth_crawl.py", "scripts/save_login.py"):
        assert script in content
        assert (SKILL_DIR / script).is_file()


def test_cli_has_no_password_argument(ac):
    with pytest.raises(SystemExit):
        ac.build_parser().parse_args(["--start-url", "https://x.test/", "--password", SECRET])
    options = {o for a in ac.build_parser()._actions for o in a.option_strings}
    assert not {o for o in options if re.fullmatch(r"--(password|pass|pw)", o)}


# -- form detection ----------------------------------------------------------


def test_detects_login_form_and_carries_hidden_fields(ac):
    form = ac.detect_login_form(LOGIN_HTML, "https://site.test/login")
    assert form.action == "https://site.test/session"
    assert form.method == "post"
    assert form.username_field == "email"
    assert form.password_field == "pass"
    assert form.fields["csrf_token"] == "tok-123"
    assert form.fields["next"] == "/docs/"
    assert "commit" not in form.fields
    payload = form.payload("alice@example.com", SECRET)
    assert payload["email"] == "alice@example.com"
    assert payload["pass"] == SECRET
    assert payload["csrf_token"] == "tok-123"


def test_form_without_password_is_not_a_login_form(ac):
    html = '<form action="/search"><input name="q"></form>'
    assert ac.detect_login_form(html, "https://site.test/") is None


def test_identifier_first_form(ac):
    html = (
        '<form action="/identify" method="post">'
        '<input type="hidden" name="flow" value="f1">'
        '<input type="text" name="username"><button>Next</button></form>'
    )
    step = ac.detect_identifier_form(html, "https://site.test/login")
    assert step.action == "https://site.test/identify"
    assert step.payload("alice", None) == {"flow": "f1", "username": "alice"}


# -- login verification -------------------------------------------------------


def _login_routes(after_post):
    return {
        ("GET", "https://site.test/login"): FakeResponse("https://site.test/login", LOGIN_HTML),
        ("POST", "https://site.test/session"): after_post,
    }


def test_login_success_posts_csrf_and_credentials(ac):
    def post(session, data):
        session.cookies["sid"] = "abc"
        return FakeResponse("https://site.test/docs/", HOME_HTML)

    session = FakeSession(_login_routes(post))
    result = ac.perform_login(session, "https://site.test/login", "alice@example.com", SECRET)
    assert result["ok"] is True
    method, url, kwargs = session.calls[-1]
    assert (method, url) == ("POST", "https://site.test/session")
    assert kwargs["data"]["csrf_token"] == "tok-123"
    assert kwargs["data"]["pass"] == SECRET
    assert SECRET not in json.dumps(result)


def test_login_failure_detected_when_form_rerenders(ac):
    session = FakeSession(_login_routes(FakeResponse("https://site.test/session", FAILED_HTML)))
    result = ac.perform_login(session, "https://site.test/login", "alice", SECRET)
    assert result["ok"] is False
    assert "error" in result["reason"]


@pytest.mark.parametrize(
    "kwargs, expected",
    [
        ({"html": HOME_HTML, "status_code": 200}, True),
        ({"html": "<p>Welcome</p>", "status_code": 200, "cookies_after": ["sid=1"]}, True),
        ({"html": "<p>Dashboard</p>", "status_code": 200, "url": "https://s.test/home"}, True),
        ({"html": FAILED_HTML, "status_code": 200, "cookies_after": ["sid=2"]}, False),
        ({"html": "<p>Oops</p>", "status_code": 403}, False),
        ({"html": "<p>Hi</p>", "status_code": 200, "success_text": "Welcome back"}, False),
        ({"html": HOME_HTML, "status_code": 200, "failure_text": "Members only"}, False),
    ],
)
def test_login_succeeded_signals(ac, kwargs, expected):
    base = {"url": "https://s.test/login", "login_url": "https://s.test/login"}
    ok, reason = ac.login_succeeded(**{**base, **kwargs})
    assert ok is expected, reason


def test_rotated_session_cookie_counts_as_success(ac):
    ok, _ = ac.login_succeeded(
        html="<p>Welcome</p>",
        status_code=200,
        url="https://s.test/login",
        login_url="https://s.test/login",
        cookies_before=["sid=anon"],
        cookies_after=["sid=user"],
    )
    assert ok


def test_identifier_first_login_flow(ac):
    first = (
        '<form action="/identify" method="post">'
        '<input type="hidden" name="flow" value="f1"><input type="email" name="login"></form>'
    )
    second = (
        '<form action="/password" method="post"><input type="hidden" name="flow" value="f1">'
        '<input type="password" name="secret"></form>'
    )
    session = FakeSession(
        {
            ("GET", "https://site.test/login"): FakeResponse("https://site.test/login", first),
            ("POST", "https://site.test/identify"): FakeResponse("https://site.test/identify", second),
            ("POST", "https://site.test/password"): FakeResponse("https://site.test/home", HOME_HTML),
        }
    )
    result = ac.perform_login(session, "https://site.test/login", "alice", SECRET)
    assert result["ok"]
    assert session.calls[1][2]["data"] == {"flow": "f1", "login": "alice"}
    assert session.calls[2][2]["data"] == {"flow": "f1", "secret": SECRET}


def test_refuses_password_over_plain_http(ac):
    html = LOGIN_HTML
    session = FakeSession({("GET", "http://site.test/login"): FakeResponse("http://site.test/login", html)})
    with pytest.raises(SystemExit, match="plain HTTP"):
        ac.perform_login(session, "http://site.test/login", "alice", SECRET)
    assert all(method == "GET" for method, _, _ in session.calls)


def test_js_rendered_login_points_to_browser_path(ac):
    session = FakeSession(
        {("GET", "https://app.test/login"): FakeResponse("https://app.test/login", "<div id=root></div>")}
    )
    with pytest.raises(SystemExit, match="browser_"):
        ac.perform_login(session, "https://app.test/login", "alice", SECRET)


# -- crawl scope and limits -----------------------------------------------------


def _site():
    pages = {
        "https://site.test/docs/": '<title>Index</title><a href="a">A</a><a href="/docs/b#x">B</a>'
        '<a href="https://other.test/docs/x">Off</a><a href="/blog/">Blog</a>'
        '<a href="/docs/logout">Log out</a><a href="/docs/file.pdf">PDF</a>'
        '<a href="mailto:x@y.z">mail</a>',
        "https://site.test/docs/a": '<title>A</title><a href="/docs/a/deep">Deep</a><p>Alpha</p>',
        "https://site.test/docs/b": "<title>B</title><p>Beta</p><script>var x=1</script>",
        "https://site.test/docs/a/deep": "<title>Deep</title><p>too deep</p>",
        "https://site.test/blog/": "<title>Blog</title>",
    }
    return FakeSession({("GET", u): FakeResponse(u, h) for u, h in pages.items()})


def _urls(pages):
    return [p["url"] for p in pages]


def test_crawl_is_same_origin_under_start_path_and_depth_limited(ac):
    session = _site()
    limits = ac.CrawlLimits(max_depth=1, delay=0)
    pages = list(ac.crawl(session, "https://site.test/docs/", limits))
    assert _urls(pages) == [
        "https://site.test/docs/",
        "https://site.test/docs/a",
        "https://site.test/docs/b",
    ]
    fetched = [u for _, u, _ in session.calls]
    assert not any("other.test" in u or "logout" in u or u.endswith(".pdf") for u in fetched)
    assert "https://site.test/blog/" not in fetched
    assert pages[2]["text"] == "Beta"
    assert pages[0]["title"] == "Index"


def test_crawl_respects_max_pages_any_path_and_patterns(ac):
    pages = list(
        ac.crawl(_site(), "https://site.test/docs/", ac.CrawlLimits(max_pages=2, delay=0))
    )
    assert len(pages) == 2
    pages = list(
        ac.crawl(
            _site(),
            "https://site.test/docs/",
            ac.CrawlLimits(max_depth=1, delay=0, stay_under_start_path=False, exclude=(r"/docs/a",)),
        )
    )
    assert "https://site.test/blog/" in _urls(pages)
    assert "https://site.test/docs/a" not in _urls(pages)
    pages = list(
        ac.crawl(
            _site(),
            "https://site.test/docs/",
            ac.CrawlLimits(max_depth=3, delay=0, include=(r"/docs/a",)),
        )
    )
    assert _urls(pages) == [
        "https://site.test/docs/",
        "https://site.test/docs/a",
        "https://site.test/docs/a/deep",
    ]


def test_crawl_sleeps_between_requests(ac):
    sleeps = []
    list(ac.crawl(_site(), "https://site.test/docs/", ac.CrawlLimits(max_depth=1, delay=0.5), sleep=sleeps.append))
    assert sleeps == [0.5, 0.5]


def test_crawl_skips_offsite_redirect_and_blocked_urls(ac, monkeypatch):
    session = FakeSession(
        {
            ("GET", "https://site.test/docs/"): FakeResponse(
                "https://site.test/docs/", '<a href="/docs/sso">x</a><a href="/docs/internal">y</a>'
            ),
            ("GET", "https://site.test/docs/sso"): FakeResponse("https://idp.test/login", "<p>idp</p>"),
        }
    )
    monkeypatch.setattr(
        ac, "check_url_allowed", lambda url: "blocked" if url.endswith("/internal") else None
    )
    events = []
    pages = list(
        ac.crawl(session, "https://site.test/docs/", ac.CrawlLimits(delay=0), on_event=events.append)
    )
    assert _urls(pages) == ["https://site.test/docs/"]
    assert any("off-site" in e for e in events)
    assert any("internal" in e and "blocked" in e for e in events)
    assert ("GET", "https://site.test/docs/internal", {"params": None}) not in session.calls


def test_real_url_safety_blocks_private_addresses():
    module = _load("auth_crawl_safety", "auth_crawl.py")
    try:
        assert module.check_url_allowed("http://127.0.0.1/admin")
        assert module.check_url_allowed("http://169.254.169.254/latest/meta-data/")
        assert module.check_url_allowed("file:///etc/passwd")
    finally:
        sys.modules.pop("auth_crawl_safety", None)


def test_redirect_hook_refuses_unsafe_target(ac, monkeypatch):
    monkeypatch.setattr(ac, "check_url_allowed", lambda url: "private" if "10.0.0.1" in url else None)
    redirect = SimpleNamespace(
        is_redirect=True, url="https://site.test/a", headers={"Location": "http://10.0.0.1/x"}
    )
    with pytest.raises(RuntimeError, match="refused"):
        ac._check_redirect(redirect)
    ok = SimpleNamespace(is_redirect=True, url="https://site.test/a", headers={"Location": "/b"})
    assert ac._check_redirect(ok) is ok


# -- robots.txt -------------------------------------------------------------------


def _robots_site():
    session = _site()
    session.routes[("GET", "https://site.test/robots.txt")] = FakeResponse(
        "https://site.test/robots.txt", "User-agent: *\nDisallow: /docs/a\n", content_type="text/plain"
    )
    return session


def test_robots_disallow_is_respected_by_default(ac):
    session = _robots_site()
    robots = ac.RobotsPolicy(session, "test-agent")
    pages = list(ac.crawl(session, "https://site.test/docs/", ac.CrawlLimits(delay=0), robots=robots))
    assert "https://site.test/docs/a" not in _urls(pages)
    assert "https://site.test/docs/b" in _urls(pages)
    assert [u for _, u, _ in session.calls].count("https://site.test/robots.txt") == 1


def test_robots_can_be_ignored_explicitly(ac):
    session = _robots_site()
    robots = ac.RobotsPolicy(session, "test-agent", enabled=False)
    pages = list(ac.crawl(session, "https://site.test/docs/", ac.CrawlLimits(delay=0), robots=robots))
    assert "https://site.test/docs/a" in _urls(pages)


def test_missing_robots_allows_crawl(ac):
    robots = ac.RobotsPolicy(_site(), "test-agent")
    assert robots.allows("https://site.test/docs/a")


# -- credentials and redaction ------------------------------------------------------


def test_redact_strings_nested_and_secret_keys(ac):
    data = {"text": f"echo {SECRET}", "fields": {"password": "x", "csrf_token": "t"}, "l": [SECRET]}
    out = ac.redact(data, [SECRET])
    assert SECRET not in json.dumps(out)
    assert out["fields"]["password"] == ac.REDACTED
    assert out["fields"]["csrf_token"] == ac.REDACTED


def test_resolve_password_sources(ac, monkeypatch):
    parser = ac.build_parser()
    base = ["--start-url", "https://site.test/", "--username", "alice"]
    monkeypatch.setenv("AUTH_CRAWL_PASSWORD", SECRET)
    assert ac.resolve_password(parser.parse_args(base)) == ("alice", SECRET)
    monkeypatch.setenv("MY_PW", "other")
    assert ac.resolve_password(parser.parse_args(base + ["--password-env", "MY_PW"]))[1] == "other"
    monkeypatch.setattr(sys, "stdin", io.StringIO(SECRET + "\n"))
    assert ac.resolve_password(parser.parse_args(base + ["--password-stdin"]))[1] == SECRET
    monkeypatch.setattr(ac, "credential_from_store", lambda ref: ("bob", "from-store"))
    assert ac.resolve_password(
        parser.parse_args(["--start-url", "https://s.test/", "--credential", "web-login/s"])
    ) == ("bob", "from-store")
    monkeypatch.delenv("AUTH_CRAWL_PASSWORD")
    with pytest.raises(SystemExit, match="no password"):
        ac.resolve_password(parser.parse_args(base))


def test_credential_from_store_reads_password_kind(ac, monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from hermes_cli import credential_store as cs

    class Store:
        async def get(self, principal, provider, name):
            assert (provider, name) == ("web-login", "site.test")
            return SimpleNamespace(kind="password", payload={"username": "u", "password": SECRET})

    async def owner(principal=None):
        return "owner"

    monkeypatch.setattr(cs, "default_credential_store", lambda: Store())
    monkeypatch.setattr(cs, "resolve_owner_principal", owner)
    assert ac.credential_from_store("web-login/site.test") == ("u", SECRET)


def test_password_never_in_stdout_stderr_or_files(ac, monkeypatch, tmp_path, capsys):
    def post(session, data):
        session.cookies["sid"] = "abc"
        return FakeResponse("https://site.test/docs/", HOME_HTML)

    routes = _login_routes(post)
    routes[("GET", "https://site.test/docs/")] = FakeResponse(
        "https://site.test/docs/",
        f'<title>Profile {SECRET}</title><p>Your password is {SECRET}</p><a href="/docs/boom">x</a>',
    )
    routes[("GET", "https://site.test/docs/boom")] = lambda s, **kw: (_ for _ in ()).throw(
        ConnectionError(f"failed for pw={SECRET}")
    )
    session = FakeSession(routes)
    monkeypatch.setattr(ac, "build_session", lambda agent, basic=None: session)
    monkeypatch.setenv("AUTH_CRAWL_PASSWORD", SECRET)
    out = tmp_path / "out"
    code = ac.main(
        [
            "--login-url", "https://site.test/login",
            "--start-url", "https://site.test/docs/",
            "--username", "alice",
            "--delay", "0",
            "--out", str(out),
        ]
    )
    assert code == 0
    captured = capsys.readouterr()
    assert "login: ok" in captured.out
    assert SECRET not in captured.out + captured.err
    files = sorted(out.iterdir())
    assert [f.name for f in files] == ["pages.jsonl", "pages.md"]
    for f in files:
        assert SECRET not in f.read_text(encoding="utf-8")
    record = json.loads((out / "pages.jsonl").read_text(encoding="utf-8").splitlines()[0])
    assert record["url"] == "https://site.test/docs/"
    assert ac.REDACTED in record["text"]


def test_failed_login_exits_2_without_crawling(ac, monkeypatch, tmp_path, capsys):
    session = FakeSession(_login_routes(FakeResponse("https://site.test/session", FAILED_HTML)))
    monkeypatch.setattr(ac, "build_session", lambda agent, basic=None: session)
    monkeypatch.setenv("AUTH_CRAWL_PASSWORD", SECRET)
    code = ac.main(
        ["--login-url", "https://site.test/login", "--start-url", "https://site.test/docs/",
         "--username", "alice", "--out", str(tmp_path / "o")]
    )
    assert code == 2
    assert "FAILED" in capsys.readouterr().out
    assert not (tmp_path / "o").exists()


def test_basic_auth_401_is_a_failed_login(ac, monkeypatch, tmp_path):
    seen = {}

    def fake_build(agent, basic=None):
        seen["basic"] = basic
        return FakeSession({("GET", "https://site.test/"): FakeResponse("https://site.test/", "", 401)})

    monkeypatch.setattr(ac, "build_session", fake_build)
    monkeypatch.setenv("AUTH_CRAWL_PASSWORD", SECRET)
    code = ac.main(
        ["--basic-auth", "--start-url", "https://site.test/", "--username", "alice",
         "--out", str(tmp_path / "o")]
    )
    assert code == 2
    assert seen["basic"] == ("alice", SECRET)


def test_save_login_stores_password_kind_without_printing(monkeypatch, capsys):
    module = _load("save_login_under_test", "save_login.py")
    stored = {}

    class Store:
        async def put(self, principal, **kwargs):
            stored.update(kwargs)

    async def owner(principal=None):
        return "owner"

    fake_cs = SimpleNamespace(default_credential_store=lambda: Store(), resolve_owner_principal=owner)
    monkeypatch.setattr(module, "_import_store", lambda: fake_cs)
    monkeypatch.setattr(sys, "stdin", io.StringIO(SECRET + "\n"))
    try:
        code = module.main(["--name", "site.test", "--username", "alice", "--password-stdin"])
    finally:
        sys.modules.pop("save_login_under_test", None)
    assert code == 0
    assert stored["kind"] == "password"
    assert stored["provider"] == "web-login"
    assert stored["payload"] == {"username": "alice", "password": SECRET}
    out = capsys.readouterr()
    assert SECRET not in out.out + out.err
    assert "web-login/site.test" in out.out
