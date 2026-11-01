#!/usr/bin/env python3
"""Log into a classic form-login (or HTTP Basic) site and crawl it.

Reads the password from an environment variable, stdin, or the unified
credential store (kind ``password``) -- never from argv, and never prints
it. Everything written to stdout/stderr and to the output files is run
through :func:`redact` first.

Design notes:
  - One ``requests.Session`` keeps the login cookies for the whole crawl.
  - The login form is auto-detected from the login page so hidden CSRF
    inputs are carried over verbatim.
  - The crawl is breadth-first, same-origin, under the start path by
    default, obeys robots.txt unless explicitly disabled, and stops at
    the page/depth limits.

Run ``--help`` for the full option list.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import socket
import sys
import time
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
from urllib import robotparser
from urllib.parse import urldefrag, urljoin, urlparse

__all__ = [
    "LoginForm",
    "CrawlLimits",
    "detect_login_form",
    "detect_identifier_form",
    "login_succeeded",
    "extract_page",
    "is_crawlable",
    "RobotsPolicy",
    "crawl",
    "redact",
    "resolve_password",
    "perform_login",
]

REDACTED = "[redacted]"
_SKIP_SUFFIXES = (
    ".pdf", ".zip", ".gz", ".tgz", ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".ico", ".css", ".js", ".mp4", ".mp3", ".woff", ".woff2", ".ttf", ".exe",
    ".dmg", ".iso", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
)
_USERNAME_HINT = re.compile(
    r"user|email|mail|login|account|identifier|signin|uid|name", re.I
)
_LOGOUT_HINT = re.compile(r"log\s?out|sign\s?out|log\s?off", re.I)
# Links a crawl never follows: they end the session or change data.
_UNSAFE_LINK = re.compile(
    r"log-?out|sign-?out|log-?off|delete|destroy|remove|unsubscribe|revoke", re.I
)
_LOGIN_FAILURE_HINT = re.compile(
    r"invalid (?:username|password|credentials|login)"
    r"|incorrect (?:username|password)"
    r"|login failed|authentication failed|wrong password"
    r"|try again|not authorized|unauthorized",
    re.I,
)


# --------------------------------------------------------------------------
# redaction
# --------------------------------------------------------------------------


def redact(value: Any, secrets: Iterable[str] = ()) -> Any:
    """Return ``value`` with every secret substring replaced.

    Strings are rewritten; lists/tuples/dicts are walked. Dict keys that
    look like a secret (``password``, ``passwd``, ``token``, ``secret``)
    have their value replaced outright, so a carried-over form payload
    can be logged safely.
    """
    needles = sorted({s for s in secrets if s}, key=len, reverse=True)

    def _walk(item: Any) -> Any:
        if isinstance(item, str):
            out = item
            for needle in needles:
                if needle in out:
                    out = out.replace(needle, REDACTED)
            return out
        if isinstance(item, dict):
            result = {}
            for key, val in item.items():
                if isinstance(key, str) and re.search(
                    r"pass(?:wd|word)?|secret|token", key, re.I
                ):
                    result[key] = REDACTED
                else:
                    result[key] = _walk(val)
            return result
        if isinstance(item, (list, tuple)):
            walked = [_walk(i) for i in item]
            return type(item)(walked) if isinstance(item, tuple) else walked
        return item

    return _walk(value)


# --------------------------------------------------------------------------
# URL safety
# --------------------------------------------------------------------------


def _fallback_url_is_safe(url: str) -> bool:
    """Private/loopback/link-local block used when the repo check is absent."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        return False
    if os.getenv("HERMES_ALLOW_PRIVATE_URLS", "").strip().lower() in {"1", "true", "yes"}:
        return True
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror:
        return False
    for *_, sockaddr in infos:
        raw = str(sockaddr[0]).split("%")[0]
        try:
            addr = ipaddress.ip_address(raw)
        except ValueError:
            return False
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            return False
    return True


def check_url_allowed(url: str) -> Optional[str]:
    """Return a refusal reason, or ``None`` when the URL may be fetched.

    Prefers the repo's ``tools.url_safety`` / ``tools.website_policy`` so a
    crawl obeys the same SSRF and website-blocklist rules as the native web
    tools; falls back to a local private-address check when the skill runs
    outside a Hermes checkout.
    """
    try:
        from tools.url_safety import is_safe_url  # type: ignore

        safe = bool(is_safe_url(url))
    except Exception:
        safe = _fallback_url_is_safe(url)
    if not safe:
        return "blocked by URL safety (private/internal address or bad scheme)"
    try:
        from tools.website_policy import check_website_access  # type: ignore

        blocked = check_website_access(url)
    except Exception:
        blocked = None
    if blocked:
        return str(blocked.get("message") or "blocked by website policy")
    return None


# --------------------------------------------------------------------------
# login form detection
# --------------------------------------------------------------------------


@dataclass
class LoginForm:
    """A login form found on a page."""

    action: str
    method: str = "post"
    username_field: Optional[str] = None
    password_field: Optional[str] = None
    fields: Dict[str, str] = field(default_factory=dict)

    def payload(self, username: Optional[str], password: Optional[str]) -> Dict[str, str]:
        """The POST body: carried-over fields plus the credentials."""
        data = dict(self.fields)
        if self.username_field and username is not None:
            data[self.username_field] = username
        if self.password_field and password is not None:
            data[self.password_field] = password
        return data


class _FormParser(HTMLParser):
    """Collect every ``<form>`` with its input/select/textarea controls."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: List[Dict[str, Any]] = []
        self._current: Optional[Dict[str, Any]] = None

    def handle_starttag(self, tag: str, attrs: Sequence[Tuple[str, Optional[str]]]) -> None:
        attributes = {k.lower(): (v or "") for k, v in attrs}
        if tag == "form":
            self._current = {
                "action": attributes.get("action", ""),
                "method": (attributes.get("method") or "get").lower(),
                "controls": [],
            }
            self.forms.append(self._current)
            return
        if tag in {"input", "select", "textarea"} and self._current is not None:
            self._current["controls"].append(
                {
                    "tag": tag,
                    "type": (attributes.get("type") or "").lower(),
                    "name": attributes.get("name", ""),
                    "id": attributes.get("id", ""),
                    "value": attributes.get("value", ""),
                    "autocomplete": (attributes.get("autocomplete") or "").lower(),
                }
            )

    def handle_startendtag(self, tag: str, attrs: Sequence[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self._current = None


def detect_login_form(html: str, page_url: str) -> Optional[LoginForm]:
    """Return the login form on ``html``, or ``None`` when there is none.

    A login form is one that holds a password input. Its hidden inputs
    (CSRF tokens, ``next`` redirects, flow ids) are carried over with
    their rendered values so the POST matches what a browser would send.
    """
    parser = _FormParser()
    parser.feed(html or "")
    for form in parser.forms:
        controls = form["controls"]
        password = next(
            (
                c
                for c in controls
                if c["type"] == "password"
                or (not c["type"] and "password" in c["autocomplete"])
            ),
            None,
        )
        if password is None or not password["name"]:
            continue
        username = None
        for control in controls:
            if control is password or not control["name"]:
                continue
            if control["type"] in {"text", "email", "tel"} or (
                control["tag"] == "input" and not control["type"]
            ):
                if username is None or _USERNAME_HINT.search(
                    control["name"] + " " + control["id"] + " " + control["autocomplete"]
                ):
                    username = control
                    if _USERNAME_HINT.search(control["name"]):
                        break
        carried = {
            c["name"]: c["value"]
            for c in controls
            if c["name"]
            and c is not password
            and (username is None or c is not username)
            and c["type"] not in {"submit", "button", "reset", "password", "file"}
        }
        return LoginForm(
            action=urljoin(page_url, form["action"] or page_url),
            method=form["method"] or "post",
            username_field=username["name"] if username else None,
            password_field=password["name"],
            fields=carried,
        )
    return None


def has_password_field(html: str) -> bool:
    """True when the markup still renders a password input."""
    parser = _FormParser()
    parser.feed(html or "")
    return any(
        control["type"] == "password"
        for form in parser.forms
        for control in form["controls"]
    )


def detect_identifier_form(html: str, page_url: str) -> Optional[LoginForm]:
    """The first step of an identifier-first login (no password input yet).

    Matches a form with exactly one visible text/email field whose name or
    id looks like a login name.
    """
    parser = _FormParser()
    parser.feed(html or "")
    for form in parser.forms:
        controls = form["controls"]
        visible = [
            c
            for c in controls
            if c["name"]
            and c["tag"] == "input"
            and (c["type"] in {"text", "email", "tel"} or not c["type"])
        ]
        if len(visible) != 1:
            continue
        ident = visible[0]
        if not _USERNAME_HINT.search(" ".join((ident["name"], ident["id"], ident["autocomplete"]))):
            continue
        carried = {
            c["name"]: c["value"]
            for c in controls
            if c["name"] and c is not ident and c["type"] not in {"submit", "button", "reset", "file"}
        }
        return LoginForm(
            action=urljoin(page_url, form["action"] or page_url),
            method=form["method"] or "post",
            username_field=ident["name"],
            fields=carried,
        )
    return None


def login_succeeded(
    *,
    html: str,
    status_code: int,
    url: str,
    login_url: str,
    cookies_before: Iterable[str] = (),
    cookies_after: Iterable[str] = (),
    success_text: Optional[str] = None,
    failure_text: Optional[str] = None,
) -> Tuple[bool, str]:
    """Decide whether a login POST authenticated us, with the reason.

    Signals, in order: caller-supplied markers, an HTTP error, a logout
    link, the password field still being rendered (failure), a new or
    rotated session cookie, a redirect away from the login page.
    ``cookies_*`` are ``name=value`` strings.
    """
    body = html or ""
    if failure_text and failure_text in body:
        return False, "failure marker found in response"
    if success_text:
        if success_text in body:
            return True, "success marker found in response"
        return False, "success marker missing from response"
    if status_code >= 400:
        return False, f"login request returned HTTP {status_code}"
    if _LOGOUT_HINT.search(body):
        return True, "logout link present"
    if has_password_field(body):
        if _LOGIN_FAILURE_HINT.search(body):
            return False, "login form re-rendered with an error message"
        return False, "still on a page with a password field"
    if set(cookies_after) - set(cookies_before):
        return True, "session cookie set by the login response"
    if urldefrag(url)[0] != urldefrag(login_url)[0]:
        return True, "redirected away from the login form"
    return True, "password field no longer rendered (weak signal: verify a page)"


# --------------------------------------------------------------------------
# page extraction
# --------------------------------------------------------------------------


class _TextParser(HTMLParser):
    """Readable text, the title, and every ``href`` on the page."""

    _SKIP = {"script", "style", "noscript", "template", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.links: List[str] = []
        self._chunks: List[str] = []
        self._skip_depth = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: Sequence[Tuple[str, Optional[str]]]) -> None:
        if tag in self._SKIP:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title = True
        if tag == "a":
            for key, value in attrs:
                if key.lower() == "href" and value:
                    self.links.append(value.strip())
        if tag in {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self._chunks.append("\n")

    def handle_startendtag(self, tag: str, attrs: Sequence[Tuple[str, Optional[str]]]) -> None:
        if tag == "br":
            self._chunks.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._in_title:
            self.title += data.strip()
            return
        if data.strip():
            self._chunks.append(data.strip())

    @property
    def text(self) -> str:
        joined = " ".join(self._chunks)
        joined = re.sub(r"[ \t]*\n[ \t]*", "\n", joined)
        joined = re.sub(r"\n{3,}", "\n\n", joined)
        return re.sub(r"[ \t]{2,}", " ", joined).strip()


def extract_page(html: str, url: str) -> Dict[str, Any]:
    """Title, readable text and absolute links for one fetched page."""
    parser = _TextParser()
    parser.feed(html or "")
    links: List[str] = []
    for href in parser.links:
        if href.lower().startswith(("javascript:", "mailto:", "tel:", "#")):
            continue
        absolute = urldefrag(urljoin(url, href))[0]
        if absolute not in links:
            links.append(absolute)
    return {"url": url, "title": parser.title.strip(), "text": parser.text, "links": links}


# --------------------------------------------------------------------------
# crawl scope
# --------------------------------------------------------------------------


@dataclass
class CrawlLimits:
    """Crawl bounds. Defaults stay deliberately small."""

    max_pages: int = 25
    max_depth: int = 2
    delay: float = 1.0
    include: Tuple[str, ...] = ()
    exclude: Tuple[str, ...] = ()
    stay_under_start_path: bool = True
    respect_robots: bool = True


def _origin(url: str) -> Tuple[str, str, int]:
    parsed = urlparse(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, (parsed.hostname or "").lower(), port


def _base_path(url: str) -> str:
    path = urlparse(url).path or "/"
    if not path.endswith("/"):
        path = path.rsplit("/", 1)[0] + "/"
    return path


def is_crawlable(url: str, start_url: str, limits: CrawlLimits) -> bool:
    """True when ``url`` is in scope for a crawl started at ``start_url``."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    if _origin(url) != _origin(start_url):
        return False
    if parsed.path.lower().endswith(_SKIP_SUFFIXES):
        return False
    if _UNSAFE_LINK.search(parsed.path + "?" + parsed.query):
        return False
    if limits.stay_under_start_path and not (parsed.path or "/").startswith(
        _base_path(start_url)
    ):
        return False
    if limits.include and not any(re.search(p, url) for p in limits.include):
        return False
    if any(re.search(p, url) for p in limits.exclude):
        return False
    return True


class RobotsPolicy:
    """robots.txt per origin, fetched through the logged-in session."""

    def __init__(self, session: Any, user_agent: str, enabled: bool = True) -> None:
        self._session = session
        self._agent = user_agent
        self._enabled = enabled
        self._parsers: Dict[Tuple[str, str, int], Optional[robotparser.RobotFileParser]] = {}

    def _parser(self, url: str) -> Optional[robotparser.RobotFileParser]:
        key = _origin(url)
        if key in self._parsers:
            return self._parsers[key]
        parsed = urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        parser: Optional[robotparser.RobotFileParser] = None
        try:
            response = self._session.get(robots_url, timeout=15)
            if getattr(response, "status_code", 0) == 200:
                parser = robotparser.RobotFileParser()
                parser.parse((response.text or "").splitlines())
        except Exception:
            parser = None
        self._parsers[key] = parser
        return parser

    def allows(self, url: str) -> bool:
        """True when robots.txt permits fetching ``url`` (or is unavailable)."""
        if not self._enabled:
            return True
        parser = self._parser(url)
        if parser is None:
            return True
        return bool(parser.can_fetch(self._agent, url))


# --------------------------------------------------------------------------
# crawl
# --------------------------------------------------------------------------


def crawl(
    session: Any,
    start_url: str,
    limits: Optional[CrawlLimits] = None,
    *,
    robots: Optional[RobotsPolicy] = None,
    sleep: Any = time.sleep,
    on_event: Any = None,
) -> Iterator[Dict[str, Any]]:
    """Breadth-first crawl from ``start_url``, yielding one dict per page."""
    limits = limits or CrawlLimits()
    queue: List[Tuple[str, int]] = [(urldefrag(start_url)[0], 0)]
    seen = {queue[0][0]}
    fetched = 0

    def note(message: str) -> None:
        if on_event:
            on_event(message)

    while queue and fetched < limits.max_pages:
        url, depth = queue.pop(0)
        refusal = check_url_allowed(url)
        if refusal:
            note(f"skip {url}: {refusal}")
            continue
        if robots is not None and not robots.allows(url):
            note(f"skip {url}: disallowed by robots.txt")
            continue
        if fetched and limits.delay:
            sleep(limits.delay)
        try:
            response = session.get(url, timeout=30)
        except Exception as exc:  # network errors must not abort the crawl
            note(f"error {url}: {type(exc).__name__}: {exc}")
            continue
        fetched += 1
        status = int(getattr(response, "status_code", 0) or 0)
        content_type = str((getattr(response, "headers", {}) or {}).get("Content-Type", ""))
        if status >= 400 or ("html" not in content_type.lower() and content_type):
            note(f"skip {url}: HTTP {status} {content_type or 'unknown type'}")
            continue
        final_url = str(getattr(response, "url", url) or url)
        if _origin(final_url) != _origin(start_url):
            note(f"skip {url}: redirected off-site to {final_url}")
            continue
        html = getattr(response, "text", "") or ""
        if has_password_field(html):
            note(f"warn {url}: page shows a login form (session expired or not logged in?)")
        page = extract_page(html, final_url)
        page["depth"] = depth
        page["status_code"] = status
        yield page
        if depth >= limits.max_depth:
            continue
        for link in page["links"]:
            if link in seen or not is_crawlable(link, start_url, limits):
                continue
            seen.add(link)
            queue.append((link, depth + 1))


# --------------------------------------------------------------------------
# credentials
# --------------------------------------------------------------------------


def credential_from_store(entry: str) -> Tuple[Optional[str], Optional[str]]:
    """``username, password`` from a ``provider/name`` store entry.

    Reads a ``password``-kind entry from the unified credential store
    (``hermes_cli.credential_store``). Raises when the entry is missing or
    is not a password entry.
    """
    import asyncio

    provider, _, name = entry.partition("/")
    if not provider or not name:
        raise SystemExit("--credential expects provider/name")
    repo_root = Path(os.environ.get("HERMES_AGENT_ROOT") or Path(__file__).resolve().parents[4])
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    from hermes_cli.credential_store import (  # type: ignore
        default_credential_store,
        resolve_owner_principal,
    )

    async def _load() -> Any:
        store = default_credential_store()
        principal = await resolve_owner_principal()
        return await store.get(principal, provider, name)

    credential = asyncio.run(_load())
    if credential is None:
        raise SystemExit(f"credential {entry} not found in the store")
    if credential.kind != "password":
        raise SystemExit(f"credential {entry} is kind {credential.kind!r}, not 'password'")
    payload = credential.payload or {}
    return payload.get("username"), payload.get("password")


def resolve_password(args: argparse.Namespace) -> Tuple[Optional[str], Optional[str]]:
    """Username/password from the store, an env var, or stdin -- never argv."""
    username = args.username
    if args.credential:
        stored_user, password = credential_from_store(args.credential)
        return (username or stored_user), password
    if args.password_stdin:
        password = sys.stdin.readline().rstrip("\n")
        if not password:
            raise SystemExit("--password-stdin got an empty line")
        return username, password
    var = args.password_env
    password = os.environ.get(var)
    if not password:
        raise SystemExit(
            f"no password: set {var}, or pass --password-stdin / --credential provider/name"
        )
    return username, password


# --------------------------------------------------------------------------
# login
# --------------------------------------------------------------------------


def _cookie_pairs(session: Any) -> List[str]:
    """``name=value`` for every cookie in the session jar."""
    jar = getattr(session, "cookies", None)
    if jar is None:
        return []
    pairs: List[str] = []
    for item in jar:
        if hasattr(item, "name"):
            pairs.append(f"{item.name}={getattr(item, 'value', '')}")
        else:  # plain dict jar (tests)
            pairs.append(f"{item}={jar[item]}")
    return pairs


def _require_safe_target(url: str, *, allow_http: bool = True) -> None:
    refusal = check_url_allowed(url)
    if refusal:
        raise SystemExit(f"refusing to submit to {url}: {refusal}")
    if not allow_http and urlparse(url).scheme != "https":
        raise SystemExit(
            f"refusing to send the password over plain HTTP to {url} "
            "(pass --allow-http only if the user accepts that risk)"
        )


def perform_login(
    session: Any,
    login_url: str,
    username: Optional[str],
    password: Optional[str],
    *,
    extra_fields: Optional[Dict[str, str]] = None,
    success_text: Optional[str] = None,
    failure_text: Optional[str] = None,
    allow_http: bool = False,
) -> Dict[str, Any]:
    """Fetch the login page, submit the detected form, verify the result.

    Handles one-page forms and identifier-first flows (login name on one
    page, password on the next). Refuses to send the password over plain
    HTTP unless ``allow_http`` is set.
    """
    refusal = check_url_allowed(login_url)
    if refusal:
        raise SystemExit(f"refusing to fetch {login_url}: {refusal}")
    page = session.get(login_url, timeout=30)
    page_url = str(getattr(page, "url", login_url) or login_url)
    form = detect_login_form(getattr(page, "text", "") or "", page_url)
    if form is None and username:
        step = detect_identifier_form(getattr(page, "text", "") or "", page_url)
        if step is not None:
            # Identifier-first flow: submit the login name, then expect the
            # password form on the next page.
            _require_safe_target(step.action)
            data = step.payload(username, None)
            if step.method == "get":
                page = session.get(step.action, params=data, timeout=30)
            else:
                page = session.post(step.action, data=data, timeout=30)
            page_url = str(getattr(page, "url", step.action) or step.action)
            form = detect_login_form(getattr(page, "text", "") or "", page_url)
    if form is None:
        raise SystemExit(
            f"no login form (no password input) found at {login_url} -- "
            "the form is probably rendered by JavaScript; use the browser_* tools instead"
        )
    _require_safe_target(form.action, allow_http=allow_http)
    cookies_before = _cookie_pairs(session)
    payload = form.payload(username, password)
    if extra_fields:
        payload.update(extra_fields)
    if form.method == "get":
        response = session.get(form.action, params=payload, timeout=30)
    else:
        response = session.post(form.action, data=payload, timeout=30)
    ok, reason = login_succeeded(
        html=getattr(response, "text", "") or "",
        status_code=int(getattr(response, "status_code", 0) or 0),
        url=str(getattr(response, "url", form.action) or form.action),
        login_url=login_url,
        cookies_before=cookies_before,
        cookies_after=_cookie_pairs(session),
        success_text=success_text,
        failure_text=failure_text,
    )
    return {
        "ok": ok,
        "reason": reason,
        "form_action": form.action,
        "username_field": form.username_field,
        "password_field": form.password_field,
        "carried_fields": sorted(form.fields),
    }


def build_session(user_agent: str, basic_auth: Optional[Tuple[str, str]] = None) -> Any:
    """A ``requests.Session`` with our user agent and optional Basic auth."""
    import requests

    session = requests.Session()
    session.headers.update({"User-Agent": user_agent})
    session.max_redirects = 10
    session.hooks["response"].append(_check_redirect)
    if basic_auth:
        session.auth = basic_auth
    return session


def _check_redirect(response: Any, *args: Any, **kwargs: Any) -> Any:
    """Re-check every redirect target against URL safety before following it."""
    location = (getattr(response, "headers", {}) or {}).get("Location")
    if getattr(response, "is_redirect", False) and location:
        target = urljoin(str(response.url), location)
        refusal = check_url_allowed(target)
        if refusal:
            raise RuntimeError(f"redirect to {target} refused: {refusal}")
    return response


# --------------------------------------------------------------------------
# output
# --------------------------------------------------------------------------


def write_outputs(
    pages: Sequence[Dict[str, Any]],
    out_dir: Path,
    secrets: Iterable[str] = (),
    formats: Sequence[str] = ("jsonl", "markdown"),
) -> List[Path]:
    """Write the crawled pages, redacted, and return the file paths."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written: List[Path] = []
    clean = [redact(page, secrets) for page in pages]
    if "jsonl" in formats:
        path = out_dir / "pages.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for page in clean:
                handle.write(json.dumps(page, ensure_ascii=False) + "\n")
        written.append(path)
    if "markdown" in formats:
        path = out_dir / "pages.md"
        chunks = []
        for page in clean:
            chunks.append(
                f"## {page.get('title') or page.get('url')}\n\n"
                f"{page.get('url')}\n\n{page.get('text', '')}\n"
            )
        path.write_text("\n".join(chunks), encoding="utf-8")
        written.append(path)
    return written


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _parse_fields(values: Sequence[str]) -> Dict[str, str]:
    fields: Dict[str, str] = {}
    for item in values or ():
        key, _, value = item.partition("=")
        if not key or not _:
            raise SystemExit(f"--extra-field expects key=value, got {item!r}")
        fields[key] = value
    return fields


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Log into a site and crawl it (password never on argv).",
    )
    parser.add_argument("--start-url", required=True, help="first page to crawl after login")
    parser.add_argument("--login-url", help="login page URL (skip for Basic auth / public crawl)")
    parser.add_argument("--username", help="login name (not a secret)")
    parser.add_argument(
        "--password-env",
        default="AUTH_CRAWL_PASSWORD",
        help="env var holding the password (default: AUTH_CRAWL_PASSWORD)",
    )
    parser.add_argument("--password-stdin", action="store_true", help="read the password from stdin")
    parser.add_argument(
        "--credential",
        help="read username/password from the credential store entry provider/name",
    )
    parser.add_argument(
        "--basic-auth", action="store_true", help="use HTTP Basic auth instead of a form"
    )
    parser.add_argument("--max-pages", type=int, default=25)
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    parser.add_argument("--include", action="append", default=[], help="regex a URL must match")
    parser.add_argument("--exclude", action="append", default=[], help="regex that skips a URL")
    parser.add_argument(
        "--any-path",
        action="store_true",
        help="allow the whole origin instead of staying under the start path",
    )
    parser.add_argument(
        "--ignore-robots",
        action="store_true",
        help="crawl pages robots.txt disallows (only with the site owner's consent)",
    )
    parser.add_argument(
        "--allow-http",
        action="store_true",
        help="allow sending the password over plain HTTP (not recommended)",
    )
    parser.add_argument("--login-success-text", help="string that proves the login worked")
    parser.add_argument("--login-failure-text", help="string that proves the login failed")
    parser.add_argument(
        "--extra-field",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="extra non-secret login form field",
    )
    parser.add_argument("--out", default="crawl-out", help="output directory")
    parser.add_argument(
        "--format",
        default="both",
        choices=["jsonl", "markdown", "both"],
        help="output format (default: both)",
    )
    parser.add_argument(
        "--user-agent",
        default="HermesAgent-auth-web-crawler/1.0",
        help="User-Agent sent on every request",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    username, password = resolve_password(args)
    secrets = [password] if password else []

    def say(message: str) -> None:
        print(redact(message, secrets), flush=True)

    basic = (username or "", password or "") if args.basic_auth else None
    session = build_session(args.user_agent, basic)
    try:
        if args.login_url and not args.basic_auth:
            result = perform_login(
                session,
                args.login_url,
                username,
                password,
                extra_fields=_parse_fields(args.extra_field),
                success_text=args.login_success_text,
                failure_text=args.login_failure_text,
                allow_http=args.allow_http,
            )
            say(
                "login: {} ({}) via {} [fields: {}]".format(
                    "ok" if result["ok"] else "FAILED",
                    result["reason"],
                    result["form_action"],
                    ", ".join(result["carried_fields"]) or "none",
                )
            )
            if not result["ok"]:
                return 2
        if args.basic_auth:
            _require_safe_target(args.start_url, allow_http=args.allow_http)
            probe = session.get(args.start_url, timeout=30)
            if int(getattr(probe, "status_code", 0) or 0) == 401:
                say("login: FAILED (HTTP 401 with Basic auth)")
                return 2
            say("login: ok (Basic auth accepted)")
        limits = CrawlLimits(
            max_pages=args.max_pages,
            max_depth=args.max_depth,
            delay=args.delay,
            include=tuple(args.include),
            exclude=tuple(args.exclude),
            stay_under_start_path=not args.any_path,
            respect_robots=not args.ignore_robots,
        )
        robots = RobotsPolicy(session, args.user_agent, enabled=limits.respect_robots)
        pages = []
        for page in crawl(session, args.start_url, limits, robots=robots, on_event=say):
            pages.append(page)
            say(f"page {len(pages)}: {page['url']} ({len(page['text'])} chars)")
        formats = ("jsonl", "markdown") if args.format == "both" else (args.format,)
        written = write_outputs(pages, Path(args.out), secrets, formats)
        say(f"{len(pages)} pages -> {', '.join(str(p) for p in written) or 'nothing written'}")
    except SystemExit as exc:
        message = redact(str(exc), secrets)
        if message and message != "0":
            print(message, file=sys.stderr)
        return 1
    except Exception as exc:
        print(redact(f"{type(exc).__name__}: {exc}", secrets), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
