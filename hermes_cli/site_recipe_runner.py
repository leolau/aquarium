"""Deterministic executor for site-to-schema extraction recipes (no LLM).

A recipe (``recipe.json``, plan section 3.4) says how to log into a source
site and, per entity, which read-only steps reach its data and how to extract
it. :func:`run_recipe` replays those steps in a headless Chromium (Playwright)
and yields one :class:`ExtractedItem` per table row (variable entities) or per
page (fixed entities). The backend writer stores them; no model is involved.

Read-only on the source site:

- ``click`` / ``submit`` / ``goto`` targets that look like save, add, new,
  edit, delete, logout or change-password are rejected, both statically
  (recipe text) and at run time (the element's text, value, id, class, href,
  onclick and form action);
- every navigation or XHR to such a URL is aborted by a network guard;
- JavaScript ``confirm()`` dialogs are dismissed.

The password comes from the credential object and is only ever typed into the
login form; it never reaches argv, logs, the report or an exception message.

Recipe shape (``version`` 1)::

    {"version": 1, "site": "hsdos", "base_url": "https://hsdos.example",
     "date_format": "%Y-%m-%d", "timeout_ms": 30000, "delay_ms": 0,
     "login": {"url": "/", "username_field": "input[name=username]",
               "password_field": "input[name=password]",
               "submit": "button[type=submit]",
               "success": {"selector": "a[href*=logout]"},
               "failure_text": "Invalid"},
     "entities": {
       "orders": {"kind": "variable", "key": ["order_no"], "cursor": "created_on",
                  "steps": [
                    {"op": "goto", "url": "/orders"},
                    {"op": "fill", "selector": "#date_from", "value": "{{cursor}}",
                     "default": "{{date-3650}}"},
                    {"op": "fill", "selector": "#date_to", "value": "{{today}}"},
                    {"op": "submit", "selector": "#btn-search"},
                    {"op": "paginate", "next": {"text": "Next"}, "steps": [
                      {"op": "extract_table", "table": "#results", "columns": {
                        "order_no": {"header": "Order No"},
                        "created_on": {"header": "Created", "type": "date",
                                       "format": "%d/%m/%Y"}}}]}]},
       "about": {"kind": "fixed", "steps": [
                    {"op": "goto", "url": "/about"},
                    {"op": "extract_fields", "key": "about",
                     "fields": {"title": {"selector": "h1"}}}]}}}

Ops: ``goto``, ``click``, ``fill``, ``select``, ``press``, ``submit``,
``wait``, ``extract_table``, ``extract_fields``, ``extract_datatable`` (every
row of a client-side DataTables table, read through the page's own
DataTables API), ``extract_json`` (a same-origin JSON read endpoint fetched in
the logged-in page, optionally paged by start/length), ``paginate`` and
``date_windows``. Value templates: ``{{today}}``, ``{{date-N}}``,
``{{cursor}}`` (falls back to the step's ``default`` on a full run or a first
run), ``{{window_from}}`` / ``{{window_to}}`` inside ``date_windows``.

The Playwright sync API must not run on a thread with a running asyncio loop:
async callers use ``asyncio.to_thread``.
"""

from __future__ import annotations

import datetime as dt
import glob
import json
import logging
import os
import re
import shutil
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

logger = logging.getLogger(__name__)

__all__ = [
    "RECIPE_VERSION",
    "ExtractedItem",
    "RunReport",
    "RecipeError",
    "ForbiddenTarget",
    "LoginFailed",
    "RecipeRunError",
    "BrowserNotInstalled",
    "recipe_problems",
    "validate_recipe",
    "is_forbidden_text",
    "is_forbidden_url",
    "render_template",
    "run_recipe",
    "PlaywrightDriver",
]

RECIPE_VERSION = 1
KINDS = ("variable", "fixed")
MODES = ("incremental", "full")
COLUMN_TYPES = ("text", "int", "numeric", "date", "datetime", "bool")
STEP_OPS = (
    "goto", "click", "fill", "select", "press", "submit", "wait",
    "extract_table", "extract_fields", "extract_datatable", "extract_json", "paginate", "date_windows",
)
_NESTING_OPS = ("paginate", "date_windows")
# Optional per-step ``when``: run the step only on full loads (no cursor) or only incremental ones.
STEP_WHEN = ("full", "incremental")
_EXTRACT_OPS = ("extract_table", "extract_fields", "extract_datatable", "extract_json")
_ALLOWED_KEYS = ("Enter", "Tab")
_TIMEOUT_OPS = ("click", "submit", "press", "wait", "extract_datatable", "extract_json")
DEFAULT_DATE_FORMAT = "%Y-%m-%d"
DEFAULT_TIMEOUT_MS = 30_000
# Clicks/submits/presses on heavy back-office pages (huge dropdowns, slow
# searches) get this many times the recipe's ``timeout_ms`` unless the step
# sets its own.
ACTION_TIMEOUT_FACTOR = 2
MAX_STEP_TIMEOUT_MS = 600_000
# Explore: same-origin XHR/fetch calls reported per step, and the largest JSON
# answer whose shape is summarised.
STEP_REQUESTS_MAX = 30
SHAPE_MAX_BYTES = 5_000_000
REQUEST_SAMPLE_CHARS = 300
# Explore: an XHR/fetch answer the page gets is cut off past this many bytes
# (a search clicked without a filter can return the whole database).
DEFAULT_CALL_MAX_BYTES = 2_000_000
CALL_MAX_BYTES_RANGE = (10_000, 50_000_000)
# Column names that hold secrets a page should never send to a browser.
_SECRET_COLUMN = re.compile(
    r"(^|[^a-z])(password|passwd|pwd|pass ?hash|hash|salt|secret|token|api ?key|private ?key|access ?key"
    r"|credentials?|otp|pin code|session ?(id|key)|sessid)($|[^a-z])")
_TOKEN_RUN = re.compile(r"(?<![A-Za-z0-9+/=._$-])[A-Za-z0-9+/=._$-]{24,}")
_SENSITIVE_PARAM = re.compile(
    r"pass|pwd|secret|token|csrf|xsrf|auth|session|sess_?id|(^|[_.-])sid$|^sid|cookie|api_?key|access_?key"
    r"|private_?key|client_?key|signature|(^|[_.-])sig$|otp|credential|bearer|jwt|nonce|(^|[_.-])pin$", re.I)
# A long run of letters and digits (a key, a session id, a JWT) is masked whatever it is called.
_TOKEN_LIKE = re.compile(r"[A-Za-z0-9_\-+/=.]{24,}")
DEFAULT_MAX_PAGES = 10_000
DEFAULT_MAX_BYTES = 10_000_000
DATATABLE_CHUNK = 2_000
_HTTP_METHODS = ("GET", "POST")
_PAGE_IN = ("params", "form", "json")
_FIXED_HEADERS = ("cookie", "authorization", "host", "content-length", "origin", "referer")
REDACTED = "[redacted]"


class ExtractedItem(NamedTuple):
    """One record for the writer: a table row or a fixed page."""

    entity: str
    kind: str  # "variable" | "fixed"
    key: str
    payload: Dict[str, Any]


@dataclass
class RunReport:
    """What a run did, filled in while :func:`run_recipe` is consumed.

    ``full_entities`` lists the entities that finished without error, without
    a cursor, with ``removal_safe`` not false and with every extraction step
    having produced at least one record (unless the step sets
    ``allow_empty: true``): only for those may the writer mark unseen rows
    removed. ``cursors`` holds the largest value of
    each entity's ``cursor`` column seen in this run.
    """

    pages: int = 0
    rows: Dict[str, int] = field(default_factory=dict)
    completed: List[str] = field(default_factory=list)
    full_entities: List[str] = field(default_factory=list)
    failed: Dict[str, str] = field(default_factory=dict)
    cursors: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    blocked_requests: List[str] = field(default_factory=list)
    capped: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "pages": self.pages,
            "rows": dict(self.rows),
            "completed": list(self.completed),
            "full_entities": list(self.full_entities),
            "failed": dict(self.failed),
            "cursors": dict(self.cursors),
            "warnings": list(self.warnings),
            "blocked_requests": list(self.blocked_requests),
            "capped": list(self.capped),
        }


class RecipeError(ValueError):
    """The recipe is malformed or asks for something the runner refuses."""


class ForbiddenTarget(RecipeError):
    """A step would click, submit or open something that changes the site."""


class LoginFailed(RuntimeError):
    """The site did not accept the saved login."""


class RecipeRunError(RuntimeError):
    """Raised after the last item when one or more entities failed."""

    def __init__(self, report: RunReport):
        self.report = report
        detail = "; ".join(f"{name}: {err}" for name, err in report.failed.items())
        super().__init__(f"{len(report.failed)} entit{'y' if len(report.failed) == 1 else 'ies'} failed: {detail}")


class BrowserNotInstalled(RuntimeError):
    """The Python playwright package or its Chromium is missing on this box."""

    def __init__(self, detail: str):
        super().__init__(
            f"browser engine not installed ({detail}); an admin runs "
            "`sudo deploy/install-site-browser` from the checkout"
        )


# --------------------------------------------------------------------------
# read-only guard
# --------------------------------------------------------------------------

_FORBIDDEN_WORDS = re.compile(
    r"\b(?:save|add|new|create|insert|edit|modify|update|delete|del|remove|destroy|drop"
    r"|approve|reject|void|cancel|upload|import|reset|purge"
    r"|log\s?out|sign\s?out|log\s?off"
    r"|change\s?pass(?:word|wd)?|passwd|set\s?password)\b",
    re.I,
)


def _words(text: str) -> str:
    """Split camelCase and punctuation so ``btnAddNew`` reads ``btn Add New``."""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text or "")
    return re.sub(r"[^A-Za-z0-9]+", " ", text)


def is_forbidden_text(text: Optional[str]) -> bool:
    """True when a label/selector/attribute names a data-changing action."""
    if not text:
        return False
    return bool(_FORBIDDEN_WORDS.search(_words(str(text))))


def is_forbidden_url(url: Optional[str]) -> bool:
    """True when a URL's path or query names a data-changing action."""
    if not url:
        return False
    parsed = urlparse(str(url))
    if parsed.scheme in ("javascript",):
        return is_forbidden_text(parsed.path)
    return is_forbidden_text(f"{parsed.path} {parsed.query}")


def _check_static_target(where: str, step: Mapping[str, Any]) -> None:
    for name in ("selector", "text", "url"):
        value = step.get(name)
        if not isinstance(value, str):
            continue
        bad = is_forbidden_url(value) if name == "url" else is_forbidden_text(value)
        if bad:
            raise ForbiddenTarget(f"{where}: {name} {value!r} looks like a data-changing action")


def _check_element(where: str, info: Mapping[str, Any]) -> None:
    """Run-time check of the element a click/submit would hit."""
    for name, value in info.items():
        if not value:
            continue
        if name in ("href", "action", "formaction"):
            bad = is_forbidden_url(str(value))
        else:
            bad = is_forbidden_text(str(value))
        if bad:
            raise ForbiddenTarget(
                f"{where}: the target element's {name} {str(value)[:80]!r} looks like a data-changing action"
            )


# --------------------------------------------------------------------------
# validation
# --------------------------------------------------------------------------


def _target_problems(where: str, step: Mapping[str, Any], *, required: bool) -> List[str]:
    if step.get("selector") or step.get("text"):
        return []
    return [f"{where}: needs 'selector' or 'text'"] if required else []


def _template_names(value: Any) -> List[str]:
    if not isinstance(value, str):
        return []
    return [m.group(1) for m in _TEMPLATE.finditer(value)]


def _steps_problems(where: str, steps: Any, *, depth: int = 0, in_window: bool = False,
                    incremental_only: bool = False) -> List[str]:
    problems: List[str] = []
    if not isinstance(steps, list) or not steps:
        return [f"{where}: 'steps' must be a non-empty list"]
    if depth > 4:
        return [f"{where}: steps nested too deep"]
    for i, step in enumerate(steps):
        at = f"{where}.steps[{i}]"
        if not isinstance(step, dict):
            problems.append(f"{at}: must be an object")
            continue
        op = step.get("op")
        if op not in STEP_OPS:
            problems.append(f"{at}: unknown op {op!r} (one of {', '.join(STEP_OPS)})")
            continue
        at = f"{at} ({op})"
        when = step.get("when")
        if when is not None and when not in STEP_WHEN:
            problems.append(f"{at}: 'when' must be one of {', '.join(STEP_WHEN)}")
        # A step that only runs incrementally always has a cursor: no 'default' needed.
        no_cursor = not (incremental_only or when == "incremental")
        try:
            if op in ("goto", "click", "submit", "press"):
                _check_static_target(at, step)
        except ForbiddenTarget as exc:
            problems.append(str(exc))
        if "timeout_ms" in step and op not in _TIMEOUT_OPS:
            problems.append(f"{at}: 'timeout_ms' works on {', '.join(_TIMEOUT_OPS)}")
        elif "timeout_ms" in step and not (
            isinstance(step["timeout_ms"], int) and not isinstance(step["timeout_ms"], bool)
            and 100 <= step["timeout_ms"] <= MAX_STEP_TIMEOUT_MS
        ):
            problems.append(f"{at}: 'timeout_ms' must be a whole number of milliseconds, 100 to {MAX_STEP_TIMEOUT_MS}")
        if "allow_empty" in step and (op not in _EXTRACT_OPS or not isinstance(step["allow_empty"], bool)):
            problems.append(f"{at}: 'allow_empty' is a true/false option of the extract_* ops")
        if op == "goto" and not isinstance(step.get("url"), str):
            problems.append(f"{at}: needs 'url'")
        elif op == "click":
            problems.extend(_target_problems(at, step, required=True))
        elif op in ("fill", "select"):
            if not step.get("selector"):
                problems.append(f"{at}: needs 'selector'")
            if "value" not in step and not (op == "select" and "label" in step):
                problems.append(f"{at}: needs 'value'")
            names = _template_names(step.get("value"))
            if "cursor" in names and "default" not in step and no_cursor:
                problems.append(f"{at}: uses {{{{cursor}}}} without a 'default' for full/first runs")
            if any(n in ("window_from", "window_to") for n in names) and not in_window:
                problems.append(f"{at}: {{{{window_*}}}} only works inside date_windows")
            for name in names + _template_names(step.get("default")):
                if name not in _TEMPLATE_VARS:
                    problems.append(f"{at}: unknown template {{{{{name}}}}}")
        elif op == "press":
            if not step.get("selector"):
                problems.append(f"{at}: needs 'selector'")
            if step.get("key", "Enter") not in _ALLOWED_KEYS:
                problems.append(f"{at}: key must be one of {', '.join(_ALLOWED_KEYS)}")
        elif op == "wait":
            if not any(step.get(k) for k in ("selector", "text", "ms", "gone")):
                problems.append(f"{at}: needs 'selector', 'text', 'gone' or 'ms'")
        elif op == "extract_table":
            cols = step.get("columns")
            if not isinstance(cols, dict) or not cols:
                problems.append(f"{at}: needs 'columns' {{name: spec}}")
            else:
                for name, spec in cols.items():
                    problems.extend(_column_problems(f"{at}.columns.{name}", spec, table=True))
        elif op == "extract_fields":
            fields_ = step.get("fields")
            if not isinstance(fields_, dict) or not fields_:
                problems.append(f"{at}: needs 'fields' {{name: spec}}")
            else:
                for name, spec in fields_.items():
                    problems.extend(_column_problems(f"{at}.fields.{name}", spec, table=False))
        elif op == "extract_datatable":
            if not isinstance(step.get("table"), str) or not step.get("table"):
                problems.append(f"{at}: needs 'table' (selector of the DataTables <table>)")
            problems.extend(_data_columns_problems(at, step.get("columns"), header_ok=True))
        elif op == "extract_json":
            problems.extend(_json_step_problems(at, step, in_window=in_window, needs_default=no_cursor))
        elif op == "paginate":
            nxt = step.get("next")
            if nxt is not None:
                if not isinstance(nxt, dict):
                    problems.append(f"{at}: 'next' must be {{selector|text}}")
                else:
                    problems.extend(_target_problems(f"{at}.next", nxt, required=True))
                    try:
                        _check_static_target(f"{at}.next", nxt)
                    except ForbiddenTarget as exc:
                        problems.append(str(exc))
            elif not step.get("page_param"):
                problems.append(f"{at}: needs 'next' or 'page_param'")
            max_pages = step.get("max_pages")
            if max_pages is not None and (not isinstance(max_pages, int) or max_pages < 1):
                problems.append(f"{at}: 'max_pages' must be a positive integer")
            problems.extend(_steps_problems(at, step.get("steps"), depth=depth + 1, in_window=in_window,
                                            incremental_only=not no_cursor))
        elif op == "date_windows":
            days = step.get("days")
            if not isinstance(days, int) or days < 1:
                problems.append(f"{at}: 'days' must be a positive integer")
            if not step.get("from"):
                problems.append(f"{at}: needs 'from'")
            if "cursor" in _template_names(step.get("from")) and "default" not in step and no_cursor:
                problems.append(f"{at}: uses {{{{cursor}}}} without a 'default' for full/first runs")
            problems.extend(_steps_problems(at, step.get("steps"), depth=depth + 1, in_window=True,
                                            incremental_only=not no_cursor))
    return problems


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def _positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _data_columns_problems(where: str, cols: Any, *, header_ok: bool) -> List[str]:
    """Columns of ``extract_datatable`` / ``extract_json``: ``field`` (dotted path), ``index``, ``header``."""
    if not isinstance(cols, dict) or not cols:
        return [f"{where}: needs 'columns' {{name: spec}}"]
    problems: List[str] = []
    allowed = ("field", "index", "header") if header_ok else ("field", "index")
    for name, spec in cols.items():
        at = f"{where}.columns.{name}"
        if not isinstance(spec, dict):
            problems.append(f"{at}: must be an object")
            continue
        if sum(k in spec for k in allowed) != 1:
            problems.append(f"{at}: needs exactly one of {', '.join(repr(k) for k in allowed)}")
        if "field" in spec and not isinstance(spec["field"], str):
            problems.append(f"{at}: 'field' must be a (dotted) key")
        if "index" in spec and (not isinstance(spec["index"], int) or isinstance(spec["index"], bool)
                                or spec["index"] < 0):
            problems.append(f"{at}: 'index' must be a non-negative integer")
        if spec.get("type", "text") not in COLUMN_TYPES:
            problems.append(f"{at}: type must be one of {', '.join(COLUMN_TYPES)}")
    return problems


def _json_step_problems(at: str, step: Mapping[str, Any], *, in_window: bool, needs_default: bool = True) -> List[str]:
    problems: List[str] = []
    url = step.get("url")
    if not isinstance(url, str) or not url:
        problems.append(f"{at}: needs 'url' (same-origin JSON endpoint)")
    elif _TEMPLATE.search(url):
        problems.append(f"{at}: 'url' cannot hold templates; put them in 'params'")
    elif is_forbidden_url(url):
        problems.append(f"{at}: url {url!r} looks like a data-changing action")
    method = str(step.get("method") or "GET").upper()
    if method not in _HTTP_METHODS:
        problems.append(f"{at}: method must be GET or POST")
    if "form" in step and "json" in step:
        problems.append(f"{at}: give 'form' or 'json', not both")
    if method == "GET" and ("form" in step or "json" in step):
        problems.append(f"{at}: a GET has no body; put the values in 'params'")
    for name in ("params", "form"):
        body = step.get(name)
        if body is not None and (not isinstance(body, dict) or not all(
                isinstance(v, (str, int, float, bool)) for v in body.values())):
            problems.append(f"{at}: '{name}' must be an object of strings/numbers")
    headers = step.get("headers")
    if headers is not None:
        if not isinstance(headers, dict) or not all(isinstance(v, str) for v in headers.values()):
            problems.append(f"{at}: 'headers' must be an object of strings")
        else:
            fixed = [h for h in headers if str(h).lower() in _FIXED_HEADERS or str(h).lower().startswith("proxy-")]
            if fixed:
                problems.append(f"{at}: headers {fixed} are set by the browser and cannot be given")
    values = [v for name in ("params", "form", "json") for v in _strings(step.get(name))]
    for value in values:
        if is_forbidden_text(_TEMPLATE.sub(" ", value)):
            problems.append(f"{at}: request value {value!r} looks like a data-changing action")
        names = _template_names(value)
        if "cursor" in names and "default" not in step and needs_default:
            problems.append(f"{at}: uses {{{{cursor}}}} without a 'default' for full/first runs")
        if any(n in ("window_from", "window_to") for n in names) and not in_window:
            problems.append(f"{at}: {{{{window_*}}}} only works inside date_windows")
        for name in names + _template_names(step.get("default")):
            if name not in _TEMPLATE_VARS:
                problems.append(f"{at}: unknown template {{{{{name}}}}}")
    records = step.get("records", "")
    if not isinstance(records, str):
        problems.append(f"{at}: 'records' must be a dotted path ('' = the top-level array)")
    for name in ("max_bytes", "delay_ms"):
        if name in step and not (_positive_int(step[name]) or (name == "delay_ms" and step[name] == 0)):
            problems.append(f"{at}: '{name}' must be a positive integer")
    page = step.get("page")
    if page is not None:
        if not isinstance(page, dict):
            problems.append(f"{at}: 'page' must be an object")
        else:
            for name in ("start_param", "length_param"):
                if not isinstance(page.get(name), str) or not page.get(name):
                    problems.append(f"{at}.page: needs '{name}'")
            if not _positive_int(page.get("length")):
                problems.append(f"{at}.page: 'length' must be a positive integer")
            if "start" in page and (not isinstance(page["start"], int) or page["start"] < 0):
                problems.append(f"{at}.page: 'start' must be a non-negative integer")
            if page.get("in") is not None and page["in"] not in _PAGE_IN:
                problems.append(f"{at}.page: 'in' must be one of {', '.join(_PAGE_IN)}")
            if page.get("in") == "json" and not isinstance(step.get("json"), dict):
                problems.append(f"{at}.page: paging into 'json' needs a 'json' object body")
            if page.get("max_pages") is not None and not _positive_int(page.get("max_pages")):
                problems.append(f"{at}.page: 'max_pages' must be a positive integer")
            for name in ("draw_param", "total"):
                if page.get(name) is not None and not isinstance(page.get(name), str):
                    problems.append(f"{at}.page: '{name}' must be a string")
    problems.extend(_data_columns_problems(at, step.get("columns"), header_ok=False))
    return problems


def _column_problems(where: str, spec: Any, *, table: bool) -> List[str]:
    if not isinstance(spec, dict):
        return [f"{where}: must be an object"]
    problems = []
    if table:
        if not any(k in spec for k in ("header", "index", "selector")):
            problems.append(f"{where}: needs 'header', 'index' or 'selector'")
    elif not spec.get("selector"):
        problems.append(f"{where}: needs 'selector'")
    if spec.get("type", "text") not in COLUMN_TYPES:
        problems.append(f"{where}: type must be one of {', '.join(COLUMN_TYPES)}")
    return problems


def _contains_op(steps: Any, ops: Sequence[str]) -> bool:
    for step in steps if isinstance(steps, list) else []:
        if not isinstance(step, dict):
            continue
        if step.get("op") in ops or _contains_op(step.get("steps"), ops):
            return True
    return False


def recipe_problems(recipe: Any) -> List[str]:
    """Every problem in ``recipe`` (empty list = runnable)."""
    if not isinstance(recipe, dict):
        return ["recipe must be a JSON object"]
    problems: List[str] = []
    if recipe.get("version") != RECIPE_VERSION:
        problems.append(f"version must be {RECIPE_VERSION}")
    base = recipe.get("base_url")
    if not isinstance(base, str) or urlparse(base).scheme not in ("http", "https") or not urlparse(base).netloc:
        problems.append("base_url must be an absolute http(s) URL")
    if "explore_max_call_bytes" in recipe:
        lo, hi = CALL_MAX_BYTES_RANGE
        cap = recipe["explore_max_call_bytes"]
        if isinstance(cap, bool) or not isinstance(cap, int) or not lo <= cap <= hi:
            problems.append(f"explore_max_call_bytes must be a whole number from {lo} to {hi}")
    login = recipe.get("login")
    if login is not None:
        if not isinstance(login, dict) or not isinstance(login.get("url"), str):
            problems.append("login: needs 'url'")
        else:
            success = login.get("success")
            if success is not None and (
                not isinstance(success, dict)
                or not any(success.get(k) for k in ("selector", "text", "url_contains", "url_not_contains"))
            ):
                problems.append("login.success: needs 'selector', 'text', 'url_contains' or 'url_not_contains'")
    entities = recipe.get("entities")
    if not isinstance(entities, dict) or not entities:
        problems.append("entities must be a non-empty object {name: {...}}")
        return problems
    for name, ent in entities.items():
        where = f"entities.{name}"
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", str(name)):
            problems.append(f"{where}: name must be lower_snake_case (a-z, 0-9, _), max 63 chars")
        if not isinstance(ent, dict):
            problems.append(f"{where}: must be an object")
            continue
        kind = ent.get("kind")
        if kind not in KINDS:
            problems.append(f"{where}: kind must be 'variable' or 'fixed'")
        key = ent.get("key")
        if key is not None and (not isinstance(key, list) or not all(isinstance(k, str) and k for k in key)):
            problems.append(f"{where}: key must be a list of column names")
        if ent.get("mode") is not None and ent.get("mode") not in MODES:
            problems.append(f"{where}: mode must be 'incremental' or 'full'")
        steps = ent.get("steps")
        problems.extend(_steps_problems(where, steps))
        if isinstance(steps, list) and not _contains_op(steps, _EXTRACT_OPS):
            problems.append(f"{where}: has no extract_table / extract_fields step")
        if kind == "variable" and not key:
            problems.append(f"{where}: a variable entity needs a 'key' (the columns that identify a row)")
    return problems


def validate_recipe(recipe: Any) -> None:
    """Raise :class:`RecipeError` (or :class:`ForbiddenTarget`) listing every problem."""
    problems = recipe_problems(recipe)
    if not problems:
        return
    message = "invalid recipe: " + "; ".join(problems)
    if any("data-changing action" in p for p in problems):
        raise ForbiddenTarget(message)
    raise RecipeError(message)


# --------------------------------------------------------------------------
# templates and values
# --------------------------------------------------------------------------

_TEMPLATE = re.compile(r"\{\{\s*([a-z_]+)\s*(?:([+-])\s*(\d+)\s*)?\}\}")
_TEMPLATE_VARS = ("today", "date", "cursor", "window_from", "window_to")


def _as_date(value: Any) -> Optional[dt.date]:
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def render_template(value: Any, variables: Mapping[str, Any], *, date_format: str = DEFAULT_DATE_FORMAT,
                    today: Optional[dt.date] = None) -> str:
    """Fill ``{{today}}``, ``{{date-N}}``, ``{{cursor}}``, ``{{window_from}}`` ...

    Dates render with ``date_format``; ``±N`` shifts a date by N days. A
    non-date ``cursor`` (an ID) renders as-is and cannot be shifted.
    """
    if not isinstance(value, str):
        return "" if value is None else str(value)
    base_today = today or dt.date.today()

    def _sub(match: "re.Match[str]") -> str:
        name, sign, num = match.group(1), match.group(2), match.group(3)
        if name in ("today", "date"):
            raw: Any = base_today
        else:
            raw = variables.get(name)
            if raw is None:
                raise RecipeError(f"template {{{{{name}}}}} has no value here")
        as_date = _as_date(raw)
        if as_date is None:
            if sign:
                raise RecipeError(f"template {{{{{name}}}}} is not a date and cannot be shifted")
            return str(raw)
        if sign:
            delta = dt.timedelta(days=int(num))
            as_date = as_date + delta if sign == "+" else as_date - delta
        return as_date.strftime(date_format)

    return _TEMPLATE.sub(_sub, value)


_DATE_GUESSES = ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y", "%d.%m.%Y", "%d %b %Y", "%d %B %Y",
                 "%b %d, %Y", "%B %d, %Y", "%Y%m%d")
_DATETIME_GUESSES = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M:%S",
                     "%d/%m/%Y %H:%M", "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M")


class _BadValue(ValueError):
    pass


def convert_value(raw: Any, spec: Mapping[str, Any]) -> Any:
    """Turn extracted text into the column's type. Raises ``_BadValue``."""
    if isinstance(raw, list):
        return [convert_value(item, spec) for item in raw]
    kind = spec.get("type", "text")
    if raw is None:
        return None
    text = re.sub(r"[ \t\r\f\v\u00a0]+", " ", str(raw)).strip()
    if kind == "text":
        return text or None
    if not text or text in ("-", "--", "N/A", "n/a"):
        return None
    fmt = spec.get("format")
    if kind in ("int", "numeric"):
        cleaned = re.sub(r"[,\s$€£¥]|HK\$|US\$", "", text)
        negative = cleaned.startswith("(") and cleaned.endswith(")")
        cleaned = cleaned.strip("()")
        try:
            number: Any = int(cleaned) if kind == "int" else float(cleaned)
        except ValueError:
            raise _BadValue(f"{text!r} is not {'an integer' if kind == 'int' else 'a number'}")
        return -number if negative else number
    if kind == "bool":
        low = text.lower()
        if low in ("yes", "y", "true", "1", "on", "✓", "✔", "active", "enabled"):
            return True
        if low in ("no", "n", "false", "0", "off", "✗", "✘", "inactive", "disabled"):
            return False
        raise _BadValue(f"{text!r} is not yes/no")
    if kind in ("date", "datetime"):
        formats = (fmt,) if fmt else (_DATE_GUESSES if kind == "date" else _DATETIME_GUESSES + _DATE_GUESSES)
        for candidate in formats:
            try:
                parsed = dt.datetime.strptime(text, candidate)
            except ValueError:
                continue
            return parsed.date().isoformat() if kind == "date" else parsed.isoformat()
        raise _BadValue(f"{text!r} does not match {fmt or 'a known ' + kind + ' format'}")
    return text


def build_key(record: Mapping[str, Any], key_columns: Sequence[str]) -> Optional[str]:
    """The writer's ``_key``: one column as-is, several joined with ``|``."""
    parts = []
    for col in key_columns:
        value = record.get(col)
        if value is None or value == "":
            return None
        parts.append(str(value).replace("\\", "\\\\").replace("|", "\\|"))
    return "|".join(parts)


def _content_key(payload: Mapping[str, Any]) -> str:
    import hashlib

    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]


# --------------------------------------------------------------------------
# credential + redaction
# --------------------------------------------------------------------------


def _credential_parts(credential: Any) -> Tuple[Optional[str], Optional[str]]:
    """``(username, password)`` from a credential-store ``Credential``, a dict or a pair."""
    if credential is None:
        return None, None
    payload = getattr(credential, "payload", None)
    if isinstance(payload, Mapping):
        kind = getattr(credential, "kind", "password")
        if kind != "password":
            raise RecipeError(f"credential kind {kind!r} is not 'password'")
        return payload.get("username"), payload.get("password")
    if isinstance(credential, Mapping):
        return credential.get("username"), credential.get("password")
    if isinstance(credential, (tuple, list)) and len(credential) == 2:
        return credential[0], credential[1]
    raise RecipeError("credential must be a password credential, {username, password} or (username, password)")


def _redact(text: str, secret: Optional[str]) -> str:
    if secret and len(secret) >= 3:
        text = text.replace(secret, REDACTED)
    return text


def _redact_all(value: Any, secret: Optional[str]) -> Any:
    if isinstance(value, str):
        return _redact(value, secret)
    if isinstance(value, Mapping):
        return {k: _redact_all(v, secret) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_redact_all(v, secret) for v in value]
    return value


def looks_like_secret_column(name: Any) -> bool:
    """True for a column/key name like ``password_hash``, ``passwordHash``, ``API Key`` or ``token``."""
    words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(name or "")).lower()
    return bool(_SECRET_COLUMN.search(re.sub(r"[_.\-]+", " ", words)))


def _mask_token_runs(text: str) -> str:
    """``text`` with long letter-and-digit runs (hashes, keys, tokens) masked."""
    def sub(m: "re.Match[str]") -> str:
        run = m.group(0)
        return REDACTED if re.search(r"\d", run) and re.search(r"[A-Za-z]", run) else run
    return _TOKEN_RUN.sub(sub, text)


def _mask_value(name: Any, value: Any) -> Any:
    if _SENSITIVE_PARAM.search(str(name)):
        return REDACTED
    if isinstance(value, str) and _TOKEN_LIKE.fullmatch(value) and re.search(r"\d", value) \
            and re.search(r"[A-Za-z]", value):
        return REDACTED
    return value


def request_sample(text: Optional[str], content_type: str = "") -> Optional[str]:
    """A short sample of a request body or query string, secret-looking values masked."""
    if not text:
        return None
    text = str(text)
    sample = text
    stripped = text.lstrip()
    if "json" in content_type or stripped.startswith(("{", "[")):
        try:
            decoded = json.loads(text)
        except ValueError:
            decoded = None
        if decoded is not None:
            def mask(value: Any) -> Any:
                if isinstance(value, Mapping):
                    return {k: mask(v) if isinstance(v, (Mapping, list)) and not _SENSITIVE_PARAM.search(str(k))
                            else _mask_value(k, v) for k, v in value.items()}
                if isinstance(value, str):
                    return _mask_value("", value)
                if isinstance(value, list):
                    return [mask(v) for v in value[:5]]
                return value

            sample = json.dumps(mask(decoded), ensure_ascii=False)
    elif "=" in text and "multipart" not in content_type:
        pairs = parse_qsl(text, keep_blank_values=True)
        if pairs:
            sample = "&".join(f"{k}={_mask_value(k, v)}" for k, v in pairs)
    elif "multipart" in content_type or not text.replace("\n", " ").replace("\t", " ").isprintable():
        sample = f"({len(text)} characters, {content_type or 'unknown type'})"
    return sample if len(sample) <= REQUEST_SAMPLE_CHARS else sample[:REQUEST_SAMPLE_CHARS] + "…"


def _record_keys(record: Any) -> List[str]:
    if not isinstance(record, Mapping):
        return []
    keys: List[str] = []
    for k, v in record.items():
        if isinstance(v, Mapping) and v:
            keys.extend(f"{k}.{sub}" for sub in list(v)[:10])
        else:
            keys.append(str(k))
    return keys[:60]


def json_shape(value: Any) -> Dict[str, Any]:
    """Where the records sit in a JSON answer: keys, the likely ``records`` path, count and record keys."""
    if isinstance(value, list):
        return {"type": "array", "records_path": "", "records": len(value),
                "record_keys": _record_keys(value[0]) if value else []}
    if not isinstance(value, Mapping):
        return {"type": type(value).__name__}
    shape: Dict[str, Any] = {"type": "object", "keys": [str(k) for k in list(value)[:40]]}
    best: Optional[Tuple[str, List[Any]]] = None
    stack: List[Tuple[str, Any, int]] = [("", value, 0)]
    while stack:
        prefix, obj, depth = stack.pop()
        for k, v in obj.items():
            path = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, list) and (best is None or len(v) > len(best[1])):
                if not v or isinstance(v[0], (Mapping, list)):
                    best = (path, v)
            elif isinstance(v, Mapping) and depth < 2:
                stack.append((path, v, depth + 1))
    if best is not None:
        shape.update(records_path=best[0], records=len(best[1]),
                     record_keys=_record_keys(best[1][0]) if best[1] else [])
    for k in ("recordsTotal", "recordsFiltered", "total", "count", "totalCount"):
        if isinstance(value.get(k), int):
            shape.setdefault("totals", {})[k] = value[k]
    return shape


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------


class Driver:
    """What the runner needs from a browser. :class:`PlaywrightDriver` implements it."""

    def goto(self, url: str) -> None:
        raise NotImplementedError
    def current_url(self) -> str:
        raise NotImplementedError
    def click(self, target: Mapping[str, Any]) -> None:
        raise NotImplementedError
    def describe(self, target: Mapping[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError
    def exists(self, target: Mapping[str, Any], *, enabled: bool = False) -> bool:
        raise NotImplementedError
    def fill(self, selector: str, value: str, *, secret: bool = False) -> None:
        raise NotImplementedError
    def select(self, selector: str, value: Optional[str], label: Optional[str]) -> None:
        raise NotImplementedError
    def press(self, selector: str, key: str, *, timeout_ms: Optional[int] = None) -> None:
        raise NotImplementedError
    def submit(self, selector: Optional[str], *, timeout_ms: Optional[int] = None) -> None:
        raise NotImplementedError
    def wait(self, step: Mapping[str, Any]) -> None:
        raise NotImplementedError
    def text_present(self, text: str) -> bool:
        raise NotImplementedError
    def table_headers(self, spec: Mapping[str, Any]) -> Optional[List[str]]:
        raise NotImplementedError
    def table_rows(self, spec: Mapping[str, Any]) -> List[Dict[str, Any]]:
        raise NotImplementedError
    def fields(self, spec: Mapping[str, Any]) -> Dict[str, Any]:
        raise NotImplementedError
    def inventory(self) -> Dict[str, Any]:
        raise NotImplementedError
    def datatable(self, table: str, columns: Optional[Mapping[str, Any]], start: int, length: int) -> Dict[str, Any]:
        """``{"state": ...}`` of a DataTables table; with ``columns``, ``rows[start:start+length]``."""
        raise NotImplementedError
    def fetch(self, url: str, *, method: str, params: Mapping[str, str], body: Optional[str],
              content_type: Optional[str], headers: Mapping[str, str], max_bytes: int,
              timeout_ms: int) -> Dict[str, Any]:
        """A same-origin request from the logged-in page.

        Returns ``{"status", "content_type", "text"}``, ``{"redirected": True}``,
        ``{"too_big": bytes_read}`` or ``{"error": message}``.
        """
        raise NotImplementedError
    def step_requests(self) -> List[Dict[str, Any]]:
        """Same-origin XHR/fetch calls the page made since the last call (for explore)."""
        return []
    def empty_filters(self, target: Mapping[str, Any]) -> Optional[List[str]]:
        """Before a search click (explore): the empty date/filter inputs of the target's form, if it looks like one."""
        return None
    def close(self) -> None:
        raise NotImplementedError


_DESCRIBE_JS = """
(el) => {
  const form = el.form || el.closest('form');
  const label = el.getAttribute('aria-label') || '';
  return {
    tag: el.tagName,
    text: (el.innerText || el.textContent || '').slice(0, 200),
    value: el.tagName === 'INPUT' ? (el.value || '') : '',
    title: el.getAttribute('title') || '', label: label,
    id: el.id || '', name: el.getAttribute('name') || '',
    class: el.getAttribute('class') || '',
    href: el.getAttribute('href') || '', onclick: el.getAttribute('onclick') || '',
    formaction: el.getAttribute('formaction') || '',
    target: el.getAttribute('data-target') || el.getAttribute('data-url') || el.getAttribute('data-href') || '',
    action: form ? (form.getAttribute('action') || '') : '',
  };
}
"""

_ENABLED_JS = """
(el) => {
  const off = (n) => n && (n.disabled || n.getAttribute('aria-disabled') === 'true'
                           || /(^|\\s)disabled(\\s|$)/.test(n.getAttribute('class') || ''));
  return !(off(el) || off(el.parentElement));
}
"""

_TABLE_HEADERS_JS = """
([tableSel, headerSel]) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const table = document.querySelector(tableSel || 'table');
  if (!table) return null;
  let cells = headerSel ? Array.from(table.querySelectorAll(headerSel)) : [];
  if (!cells.length) {
    const tr = table.querySelector('thead tr') || table.querySelector('tr');
    cells = tr ? Array.from(tr.children) : [];
  }
  return cells.map((c) => norm(c.innerText || c.textContent));
}
"""

_TABLE_ROWS_JS = """
([tableSel, rowSel, columns]) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const table = document.querySelector(tableSel || 'table');
  if (!table) return null;
  let rows = Array.from(table.querySelectorAll(rowSel || 'tbody tr'));
  if (!rowSel && !rows.length) rows = Array.from(table.querySelectorAll('tr'));
  rows = rows.filter((r) => r.querySelector('td'));
  return rows.map((r) => {
    const cells = Array.from(r.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    const out = {};
    for (const [name, col] of Object.entries(columns)) {
      let el = null;
      if (col.selector) el = r.querySelector(col.selector);
      else if (col.index !== undefined && col.index !== null) el = cells[col.index] || null;
      if (el && col.attr && !el.hasAttribute(col.attr)) el = el.querySelector('[' + col.attr + ']') || el;
      out[name] = el ? (col.attr ? el.getAttribute(col.attr) : norm(el.innerText || el.textContent)) : null;
    }
    return out;
  });
}
"""

_FIELDS_JS = """
(fields) => {
  const tidy = (s) => (s || '').split('\\n').map((l) => l.replace(/[ \\t\\u00a0]+/g, ' ').trim())
                               .filter(Boolean).join('\\n');
  const read = (el, col) => col.attr ? el.getAttribute(col.attr) : tidy(el.innerText || el.textContent);
  const out = {};
  for (const [name, col] of Object.entries(fields)) {
    if (col.all) out[name] = Array.from(document.querySelectorAll(col.selector)).map((el) => read(el, col));
    else { const el = document.querySelector(col.selector); out[name] = el ? read(el, col) : null; }
  }
  return out;
}
"""


_INVENTORY_JS = r"""
() => {
  const txt = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
  const sel = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 4 && n !== document.body; n = n.parentElement) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const same = Array.from(n.parentElement ? n.parentElement.children : []).filter(c => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? `:nth-of-type(${same.indexOf(n) + 1})` : ''));
    }
    return parts.join(' > ');
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const labelFor = (el) => {
    if (el.labels && el.labels.length) return txt(el.labels[0]);
    const cell = el.closest('td');
    return cell && cell.previousElementSibling ? txt(cell.previousElementSibling) : '';
  };
  const links = Array.from(document.querySelectorAll('a[href]')).filter(visible).slice(0, 300).map(a => ({
    text: txt(a), href: a.href, selector: sel(a), onclick: (a.getAttribute('onclick') || '').slice(0, 200)}));
  const buttons = Array.from(document.querySelectorAll(
      'button, input[type=button], input[type=submit], input[type=reset], [onclick]:not(a), [role=button]'))
    .filter(visible).slice(0, 300).map(b => ({
      text: txt(b), tag: b.tagName, type: b.getAttribute('type') || '', id: b.id || '',
      name: b.getAttribute('name') || '', cls: b.className && b.className.baseVal === undefined ? b.className : '',
      selector: sel(b), onclick: (b.getAttribute('onclick') || '').slice(0, 200),
      form_action: b.form ? (b.form.getAttribute('action') || '') : ''}));
  const forms = Array.from(document.forms).slice(0, 50).map(f => ({
    selector: sel(f), id: f.id || '', name: f.getAttribute('name') || '',
    action: f.getAttribute('action') || '', method: (f.getAttribute('method') || 'get').toLowerCase(),
    fields: Array.from(f.elements).filter(e => e.name || e.id).slice(0, 60).map(e => ({
      tag: e.tagName, type: e.type || '', name: e.name || '', id: e.id || '', selector: sel(e),
      label: labelFor(e), placeholder: e.getAttribute('placeholder') || '',
      value: e.type === 'password' ? '' : String(e.value || '').slice(0, 60),
      options: e.tagName === 'SELECT' ? Array.from(e.options).slice(0, 40).map(o => [o.value, o.text.trim()]) : undefined,
    }))}));
  const tables = Array.from(document.querySelectorAll('table')).filter(visible).slice(0, 30).map(t => {
    const rows = Array.from(t.rows);
    const head = t.tHead && t.tHead.rows.length ? t.tHead.rows[t.tHead.rows.length - 1]
      : rows.find(r => r.querySelector('th')) || rows[0];
    const body = rows.filter(r => r !== head && !(t.tHead && t.tHead.contains(r)));
    const cells = (r) => Array.from(r.cells).map(c => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 80));
    return {selector: sel(t), headers: head ? cells(head) : [], rows: body.length,
            sample: body.slice(0, 3).map(cells), nested: !!t.querySelector('table')};
  });
  const pager = /^(next|prev|previous|first|last|more|load more|[0-9]{1,4}|[<>«»‹›]+)$/i;
  const pagination = links.concat(buttons).filter(x => pager.test(x.text)).map(x => ({text: x.text, selector: x.selector}));
  const main = document.querySelector('main') || document.body;
  return {url: location.href, title: document.title,
          headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(txt).filter(Boolean).slice(0, 40),
          links, buttons, forms, tables, pagination,
          text: (main ? main.innerText : '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3000)};
}
"""


# DataTables 1.10+ (jQuery plugin) and 2.x (``window.DataTable``) share this
# public API: ``isDataTable``, ``new Api(el)``, ``table().node()``,
# ``rows({search: 'none'})``, ``column(i).dataSrc()`` / ``.header()``,
# ``cell(r, c).data()``, ``ajax.url()``. With ``scrollX`` / ``scrollY`` the
# header (and footer) are cloned <table>s for which ``isDataTable`` is also
# true; every match is resolved to its instance's real ``table().node()``.
_DATATABLE_JS = r"""
([sel, columns, start, length]) => {
  const DT = (window.jQuery && window.jQuery.fn && window.jQuery.fn.dataTable) || window.DataTable;
  const found = Array.from(document.querySelectorAll(sel));
  if (!found.length) return {state: 'no_table'};
  if (!DT || typeof DT.isDataTable !== 'function' || typeof DT.Api !== 'function') return {state: 'no_datatables'};
  const clone = '.dataTables_scrollHead, .dataTables_scrollFoot, .dt-scroll-head, .dt-scroll-foot';
  const nodes = [];
  for (const el of found) {
    if (!DT.isDataTable(el)) continue;
    let node = null;
    try { node = new DT.Api(el).table().node(); } catch (e) { node = null; }
    if (!node && !el.closest(clone)) node = el;
    if (node && !nodes.includes(node)) nodes.push(node);
  }
  if (!nodes.length) return {state: 'not_initialised'};
  if (nodes.length > 1) {
    return {state: 'ambiguous', matches: nodes.map((n) => n.id ? '#' + n.id : n.tagName.toLowerCase() +
            (n.className ? '.' + String(n.className).trim().split(/\s+/).join('.') : ''))};
  }
  const el = nodes[0];
  const api = new DT.Api(el);
  const s = api.settings()[0] || {};
  if (s._bInitComplete === false) return {state: 'loading'};
  const serverSide = !!(s.oFeatures && s.oFeatures.bServerSide);
  let ajax = null;
  try { ajax = api.ajax.url() || null; } catch (e) { ajax = null; }
  if (typeof ajax !== 'string') ajax = null;
  const cols = [];
  const ncol = api.columns().count();
  for (let i = 0; i < ncol; i++) {
    const c = api.column(i), h = c.header(), src = c.dataSrc();
    cols.push({header: h ? (h.textContent || '').replace(/\s+/g, ' ').trim() : '',
               data: (typeof src === 'string' || typeof src === 'number') ? src : null});
  }
  const rows = api.rows({search: 'none', order: 'index'});
  const info = {state: 'ready', server_side: serverSide, ajax_url: ajax, total: rows.count(), columns: cols};
  if (!columns) return info;
  const get = (row, path) => {
    if (typeof path === 'number') return row == null ? null : row[path];
    let v = row;
    for (const p of String(path).split('.')) { if (v == null) return null; v = v[p]; }
    return v;
  };
  const parser = new DOMParser();
  const text = (v, col) => {
    if (typeof v !== 'string' || col.html === false || (!col.attr && v.indexOf('<') < 0 && v.indexOf('&') < 0)) {
      return col.attr ? null : v;
    }
    const doc = parser.parseFromString(v, 'text/html');
    if (col.attr) { const n = doc.querySelector('[' + col.attr + ']'); return n ? n.getAttribute(col.attr) : null; }
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const idx = rows.indexes().toArray().slice(start, start + length);
  const data = rows.data().toArray().slice(start, start + length);
  info.rows = data.map((row, k) => {
    const out = {};
    for (const [name, col] of Object.entries(columns)) {
      const v = col.cell !== undefined ? api.cell(idx[k], col.cell).data() : get(row, col.path);
      out[name] = v === undefined ? null : text(v, col);
    }
    return out;
  });
  return info;
}
"""

_DATATABLES_LIST_JS = "() => { const probe = " + _DATATABLE_JS.strip() + r""";
  const clone = '.dataTables_scrollHead, .dataTables_scrollFoot, .dt-scroll-head, .dt-scroll-foot';
  return Array.from(document.querySelectorAll('table[id]')).filter((t) => !t.closest(clone)).map((t) => {
    const selector = '#' + CSS.escape(t.id);
    return Object.assign({selector}, probe([selector, null, 0, 0]));
  }).filter((x) => x.state === 'ready');
}"""

# Explore: installed before any page script, it cuts off XHR/fetch answers
# past ``cap`` bytes (Content-Length or bytes received so far, whether or not
# the page reads the body) and records them in ``window.__aqCallCap.aborted``,
# so a search without a filter cannot pull the whole database through the
# browser. A synchronous XHR can't be cut off part way, so it is refused
# (reason ``sync``). It never sends a request.
_CALL_CAP_JS = r"""
(cap) => {
  if (window.__aqCallCap) return;
  const aborted = [];
  const origFetch = window.fetch;
  Object.defineProperty(window, '__aqCallCap', {value: {cap, aborted, fetch: origFetch && origFetch.bind(window)}});
  const note = (method, url, seen, total, reason) => {
    try {
      aborted.push({method: String(method || 'GET').toUpperCase(), url: new URL(String(url), location.href).href,
                    seen, total: total || null, reason: reason || 'too_large'});
      if (aborted.length > 100) aborted.shift();
    } catch (e) {}
  };
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open, send = XHR.send;
    XHR.open = function (method, url) {
      this.__aqCall = {method, url, async: arguments.length < 3 || arguments[2] !== false};
      return open.apply(this, arguments);
    };
    XHR.send = function () {
      const xhr = this, info = xhr.__aqCall;
      if (info && !info.async) {
        note(info.method, info.url, 0, null, 'sync');
        throw new DOMException('synchronous XHR is refused while exploring (no size cap possible)', 'NetworkError');
      }
      if (info && info.async) {
        let stopped = false;
        const stop = (seen, total) => {
          if (stopped) return;
          stopped = true;
          note(info.method, info.url, seen, total);
          try { xhr.abort(); } catch (e) {}
        };
        xhr.addEventListener('readystatechange', () => {
          if (xhr.readyState === 2) {
            const n = parseInt(xhr.getResponseHeader('content-length') || '', 10);
            if (n > cap) stop(0, n);
          }
        });
        xhr.addEventListener('progress', (e) => { if (e.loaded > cap) stop(e.loaded, e.lengthComputable ? e.total : null); });
      }
      return send.apply(this, arguments);
    };
  }
  if (origFetch) {
    window.fetch = function (input, init) {
      const isReq = typeof Request !== 'undefined' && input instanceof Request;
      const method = (init && init.method) || (isReq ? input.method : 'GET');
      const url = isReq ? input.url : String(input);
      const ctl = new AbortController();
      const outer = (init && init.signal) || (isReq ? input.signal : null);
      if (outer) {
        if (outer.aborted) ctl.abort(outer.reason);
        else outer.addEventListener('abort', () => ctl.abort(outer.reason));
      }
      const tooBig = () => new DOMException('answer over the explore size cap', 'AbortError');
      return origFetch.call(window, input, Object.assign({}, init || {}, {signal: ctl.signal})).then((res) => {
        const n = parseInt(res.headers.get('content-length') || '', 10);
        if (n > cap) { note(method, url, 0, n); ctl.abort(); throw tooBig(); }
        if (!res.body || [101, 204, 205, 304].includes(res.status)) return res;
        const reader = res.body.getReader();
        let seen = 0;
        // Read the real body at once, whether or not the page reads ours: an
        // ignored answer still counts against the cap. The queue holds at
        // most ``cap`` bytes, since the call is aborted past it.
        let done = false;
        const stream = new ReadableStream({
          start(c) {
            (async () => {
              try {
                for (;;) {
                  const part = await reader.read();
                  if (part.done || done) { if (!done) c.close(); return; }
                  seen += part.value.byteLength;
                  if (seen > cap) { note(method, url, seen, null); ctl.abort(); c.error(tooBig()); return; }
                  c.enqueue(part.value);
                }
              } catch (e) {
                if (!done) { try { c.error(e); } catch (_) {} }
              }
            })();
          },
          cancel(reason) { done = true; return reader.cancel(reason); },
        });
        const out = new Response(stream, {status: res.status, statusText: res.statusText, headers: res.headers});
        for (const k of ['url', 'redirected', 'type']) {
          try { Object.defineProperty(out, k, {value: res[k]}); } catch (e) {}
        }
        return out;
      });
    };
  }
}"""

_EMPTY_FILTERS_JS = r"""
(el) => {
  const words = (x) => String(x || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/);
  const DATE = new Set(['date', 'from', 'to', 'start', 'end', 'since', 'until', 'period', 'day', 'month', 'year',
                        'begin', 'dt', 'time']);
  const text = [el.innerText, el.value, el.id, el.name, el.className, el.getAttribute('aria-label')].join(' ');
  const scope = el.form || el.closest('form') || el.closest('fieldset, .panel, .card, .modal, section, .row')
    || document;
  const skip = ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'password', 'file'];
  const visible = (x) => !!(x.offsetWidth || x.offsetHeight || x.getClientRects().length);
  const fields = Array.from(scope.querySelectorAll('input, select, textarea')).filter((x) =>
    !skip.includes((x.type || '').toLowerCase()) && visible(x) && !x.disabled);
  const label = (x) => {
    const own = x.labels && x.labels[0] ? x.labels[0].innerText : '';
    return (x.id ? '#' + x.id : x.name || x.placeholder || own || x.tagName.toLowerCase()).slice(0, 60);
  };
  const isDate = (x) => ['date', 'datetime-local', 'month', 'week'].includes((x.type || '').toLowerCase())
    || words([x.id, x.name, x.placeholder, x.className, x.labels && x.labels[0] ? x.labels[0].innerText : '']
      .join(' ')).some((w) => DATE.has(w) || w.includes('date'));
  const ANY = /^\s*(-+.*-+|\*|all|any|全部|所有|(please )?(select|choose)\b.*)\s*$/i;
  const empty = (x) => {
    const v = String(x.value || '').trim();
    if (!v) return true;
    if (x.tagName === 'SELECT') {
      const o = x.options[x.selectedIndex];
      return !!o && (ANY.test(o.text) || ANY.test(v));
    }
    return false;
  };
  const dates = fields.filter(isDate);
  const searchy = /search|query|filter|find|look ?up|apply|enquir|retriev|load|show|go\b|查|搜|搵/i.test(text)
    || dates.length > 0;
  if (!searchy || !fields.length) return null;
  // A filled non-date filter (one warehouse, one id) already narrows the search.
  if (fields.some((x) => !isDate(x) && !empty(x))) return [];
  const emptyDates = dates.filter(empty);
  if (emptyDates.length) return emptyDates.map(label).slice(0, 10);
  if (fields.every(empty)) return fields.map(label).slice(0, 10);
  return [];
}"""

# A same-origin fetch in the logged-in page: the browser adds the session
# cookies, the network guard (context.route) sees it, redirects are not
# followed and the body is cancelled as soon as it passes max_bytes.
_FETCH_JS = r"""
async ([url, method, body, contentType, headers, maxBytes, timeoutMs]) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const h = Object.assign({'X-Requested-With': 'XMLHttpRequest',
                             'Accept': 'application/json, text/javascript, */*; q=0.01'}, headers);
    if (contentType) h['Content-Type'] = contentType;
    const fetchFn = (window.__aqCallCap && window.__aqCallCap.fetch) || fetch;
    const res = await fetchFn(url, {method, headers: h, body: body === null ? undefined : body,
                                  credentials: 'same-origin', redirect: 'manual', signal: ctrl.signal,
                                  cache: 'no-store'});
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return {redirected: true};
    const declared = parseInt(res.headers.get('content-length') || '', 10);
    if (declared > maxBytes) { ctrl.abort(); return {too_big: declared}; }
    const reader = res.body ? res.body.getReader() : null;
    const parts = [];
    let size = 0;
    while (reader) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { ctrl.abort(); return {too_big: size}; }
      parts.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { all.set(p, at); at += p.byteLength; }
    return {status: res.status, content_type: res.headers.get('content-type') || '',
            text: new TextDecoder().decode(all)};
  } catch (e) {
    return {error: ctrl.signal.aborted ? 'timed out after ' + timeoutMs + ' ms' : String(e && e.message || e)};
  } finally {
    clearTimeout(timer);
  }
}
"""


def _chromium_candidates() -> List[str]:
    """Browsers already on the box (system Chrome, agent-browser's Playwright builds)."""
    found: List[str] = []
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"):
        path = shutil.which(name)
        if path:
            found.append(path)
    roots = []
    env_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "").strip()
    if env_path and env_path != "0":
        roots.append(env_path)
    home = os.path.expanduser("~")
    roots.append(os.path.join(home, ".cache", "ms-playwright"))
    if sys.platform == "darwin":
        roots.append(os.path.join(home, "Library", "Caches", "ms-playwright"))
    for root in roots:
        for pattern in ("chromium-*/chrome-linux/chrome", "chromium_headless_shell-*/chrome-linux/headless_shell",
                        "chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"):
            found.extend(sorted(glob.glob(os.path.join(root, pattern)), reverse=True))
    return found


def _import_playwright() -> Tuple[Any, Any]:
    """``(sync_playwright, TimeoutError)``; a dev checkout may lazy-install the package."""
    try:
        from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright
    except ImportError:
        try:
            from tools.lazy_deps import ensure

            ensure("sites.playwright", prompt=False)
            from playwright.sync_api import TimeoutError as PlaywrightTimeout, sync_playwright
        except Exception:
            raise BrowserNotInstalled("the playwright Python package is missing") from None
    return sync_playwright, PlaywrightTimeout


class PlaywrightDriver(Driver):
    """Headless Chromium through the Playwright sync API.

    ``guard(url, resource_type, method) -> Optional[str]`` returns a reason to
    abort a request (the read-only and SSRF network guard).
    """

    def __init__(self, *, timeout_ms: int = DEFAULT_TIMEOUT_MS, guard: Optional[Callable[..., Optional[str]]] = None,
                 on_blocked: Optional[Callable[[str], None]] = None, headless: bool = True,
                 call_max_bytes: Optional[int] = None):
        sync_playwright, PlaywrightTimeout = _import_playwright()

        self._timeout_error = PlaywrightTimeout
        self._timeout_ms = timeout_ms
        self._pw = sync_playwright().start()
        try:
            self._browser = self._launch(headless)
            self._context = self._browser.new_context(accept_downloads=False)
            self._context.set_default_timeout(timeout_ms)
            self._call_max_bytes = call_max_bytes
            if call_max_bytes:
                self._context.add_init_script(script=f"({_CALL_CAP_JS})({int(call_max_bytes)})")
            if guard is not None:
                def _route(route: Any) -> None:
                    req = route.request
                    reason = guard(req.url, req.resource_type, req.method)
                    if reason:
                        if on_blocked:
                            on_blocked(f"{req.method} {req.url}: {reason}")
                        route.abort("blockedbyclient")
                    else:
                        route.continue_()

                self._context.route("**/*", _route)
            self._page = self._context.new_page()
            self._page.on("dialog", lambda dialog: dialog.dismiss())
            self._nav_pending: set = set()
            self._nav_done = 0
            self._commits = 0
            self._page.on("request", self._on_request)
            self._page.on("requestfinished", self._on_request_finished)
            self._page.on("requestfailed", self._on_request_failed)
            self._page.on("framenavigated", self._on_frame_navigated)
            self._json_seen: List[Dict[str, Any]] = []
            # id(request) -> [request, response or None, "pending" | "answered" | "finished" | "failed"]
            self._step_seen: Dict[int, List[Any]] = {}
            self._page.on("response", self._on_response)
        except Exception:
            self._pw.stop()
            raise

    def _launch(self, headless: bool) -> Any:
        try:
            return self._pw.chromium.launch(headless=headless)
        except Exception as first:
            for exe in _chromium_candidates():
                try:
                    return self._pw.chromium.launch(headless=headless, executable_path=exe)
                except Exception:
                    continue
            line = next((ln.strip() for ln in str(first).splitlines() if ln.strip()), "")
            raise BrowserNotInstalled(f"Chromium does not start: {line[:200]}") from None

    # -- helpers -------------------------------------------------------------

    def _locator(self, target: Mapping[str, Any]) -> Any:
        page = self._page
        nth = int(target.get("nth") or 0)
        if target.get("selector"):
            return page.locator(target["selector"]).nth(nth)
        text = str(target["text"])
        exact = bool(target.get("exact", True))
        loc = (
            page.get_by_role("button", name=text, exact=exact)
            .or_(page.get_by_role("link", name=text, exact=exact))
            .or_(page.locator(f"input[type=submit][value={json.dumps(text)}], input[type=button][value={json.dumps(text)}]"))
        )
        return loc.nth(nth)

    def _is_main_navigation(self, req: Any) -> bool:
        try:
            return bool(req.is_navigation_request()) and req.frame == self._page.main_frame
        except Exception:
            return False

    def _on_request(self, req: Any) -> None:
        if self._is_main_navigation(req):
            self._nav_pending.add(id(req))
        elif self._same_origin_xhr(req) and len(self._step_seen) < 200:
            self._step_seen[id(req)] = [req, None, "pending"]

    def _on_request_finished(self, req: Any) -> None:
        seen = self._step_seen.get(id(req))
        if seen is not None and seen[0] is req:
            seen[2] = "finished"
        if id(req) not in self._nav_pending:
            return
        self._nav_pending.discard(id(req))
        try:
            status = req.response().status
        except Exception:
            status = 200
        if not (300 <= status < 400 or status in (204, 205)):
            self._nav_done += 1

    def _on_request_failed(self, req: Any) -> None:
        self._nav_pending.discard(id(req))
        seen = self._step_seen.get(id(req))
        if seen is not None and seen[0] is req:
            seen[2] = "failed"

    def _same_origin_xhr(self, req: Any) -> bool:
        try:
            if req.resource_type not in ("xhr", "fetch"):
                return False
            here, there = urlparse(self._page.url), urlparse(req.url)
            return (here.scheme, here.netloc) == (there.scheme, there.netloc)
        except Exception:
            return False

    def _action_timeout(self, timeout_ms: Optional[int]) -> int:
        return int(timeout_ms or self._timeout_ms * ACTION_TIMEOUT_FACTOR)

    def _on_frame_navigated(self, frame: Any) -> None:
        if frame == self._page.main_frame:
            self._commits += 1

    def _mark(self) -> Tuple[int, int]:
        return self._nav_done, self._commits

    def _settle(self, mark: Optional[Tuple[int, int]] = None, timeout_ms: Optional[int] = None) -> None:
        """Wait until any navigation an action started has loaded.

        ``wait_for_load_state`` alone returns at once while a click/submit
        navigation is still in flight (the old document is already loaded),
        so in-flight main-frame navigations are tracked through page events.
        """
        self._page.wait_for_timeout(30)
        timeout_ms = timeout_ms or self._timeout_ms
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            waiting_commit = mark is not None and self._nav_done > mark[0] and self._commits <= mark[1]
            if not self._nav_pending and not waiting_commit:
                break
            self._page.wait_for_timeout(25)
        try:
            self._page.wait_for_load_state("load", timeout=timeout_ms)
            self._page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 10_000))
        except self._timeout_error:
            pass

    # -- Driver --------------------------------------------------------------

    def goto(self, url: str) -> None:
        self._page.goto(url, wait_until="load")
        self._settle()

    def current_url(self) -> str:
        return self._page.url

    def click(self, target: Mapping[str, Any]) -> None:
        timeout = self._action_timeout(target.get("timeout_ms"))
        mark = self._mark()
        self._locator(target).click(timeout=timeout)
        self._settle(mark, timeout)

    def describe(self, target: Mapping[str, Any]) -> Dict[str, Any]:
        return self._locator(target).evaluate(_DESCRIBE_JS, timeout=self._action_timeout(target.get("timeout_ms")))

    def exists(self, target: Mapping[str, Any], *, enabled: bool = False) -> bool:
        loc = self._locator(target)
        if not loc.is_visible():
            return False
        return bool(loc.evaluate(_ENABLED_JS)) if enabled else True

    def fill(self, selector: str, value: str, *, secret: bool = False) -> None:
        self._page.locator(selector).first.fill(value)

    def select(self, selector: str, value: Optional[str], label: Optional[str]) -> None:
        loc = self._page.locator(selector).first
        if label is not None:
            loc.select_option(label=label)
        else:
            loc.select_option(value=value)

    def press(self, selector: str, key: str, *, timeout_ms: Optional[int] = None) -> None:
        timeout = self._action_timeout(timeout_ms)
        mark = self._mark()
        self._page.locator(selector).first.press(key, timeout=timeout)
        self._settle(mark, timeout)

    def submit(self, selector: Optional[str], *, timeout_ms: Optional[int] = None) -> None:
        timeout = self._action_timeout(timeout_ms)
        mark = self._mark()
        if selector:
            loc = self._page.locator(selector).first
            if loc.evaluate("(el) => el.tagName", timeout=timeout) == "FORM":
                loc.evaluate("(f) => f.requestSubmit()")
            else:
                loc.click(timeout=timeout)
        else:
            self._page.locator("form").first.evaluate("(f) => f.requestSubmit()", timeout=timeout)
        self._settle(mark, timeout)

    def wait(self, step: Mapping[str, Any]) -> None:
        timeout = step.get("timeout_ms") or self._timeout_ms
        if step.get("selector"):
            self._page.locator(step["selector"]).first.wait_for(state="visible", timeout=timeout)
        if step.get("text"):
            self._page.get_by_text(str(step["text"])).first.wait_for(state="visible", timeout=timeout)
        if step.get("gone"):
            self._page.locator(step["gone"]).first.wait_for(state="hidden", timeout=timeout)
        if step.get("ms"):
            self._page.wait_for_timeout(int(step["ms"]))

    def text_present(self, text: str) -> bool:
        return self._page.get_by_text(text).count() > 0

    def table_headers(self, spec: Mapping[str, Any]) -> Optional[List[str]]:
        return self._page.evaluate(_TABLE_HEADERS_JS, [spec.get("table"), spec.get("header")])

    def table_rows(self, spec: Mapping[str, Any]) -> List[Dict[str, Any]]:
        return self._page.evaluate(_TABLE_ROWS_JS, [spec.get("table"), spec.get("row"), spec["columns"]]) or []

    def fields(self, spec: Mapping[str, Any]) -> Dict[str, Any]:
        return self._page.evaluate(_FIELDS_JS, dict(spec))

    def inventory(self) -> Dict[str, Any]:
        inventory = self._page.evaluate(_INVENTORY_JS)
        inventory["json_requests"], self._json_seen = self._json_seen, []
        inventory["datatables"] = self._page.evaluate(_DATATABLES_LIST_JS)
        return inventory

    def datatable(self, table: str, columns: Optional[Mapping[str, Any]], start: int, length: int) -> Dict[str, Any]:
        return self._page.evaluate(_DATATABLE_JS, [table, dict(columns) if columns else None, start, length])

    def fetch(self, url: str, *, method: str, params: Mapping[str, str], body: Optional[str],
              content_type: Optional[str], headers: Mapping[str, str], max_bytes: int,
              timeout_ms: int) -> Dict[str, Any]:
        if params:
            parsed = urlparse(url)
            query = parse_qsl(parsed.query, keep_blank_values=True) + list(params.items())
            url = urlunparse(parsed._replace(query=urlencode(query)))
        return self._page.evaluate(_FETCH_JS, [url, method, body, content_type, dict(headers), max_bytes, timeout_ms])

    def empty_filters(self, target: Mapping[str, Any]) -> Optional[List[str]]:
        try:
            return self._locator(target).evaluate(_EMPTY_FILTERS_JS, timeout=min(
                self._action_timeout(target.get("timeout_ms")), 5_000))
        except Exception:
            return None

    def _cut_off_calls(self) -> List[Dict[str, Any]]:
        if not self._call_max_bytes:
            return []
        out: List[Dict[str, Any]] = []
        for frame in self._page.frames:  # each frame keeps its own list
            try:
                out.extend(frame.evaluate(
                    "() => (window.__aqCallCap ? window.__aqCallCap.aborted.splice(0) : [])") or [])
            except Exception:
                continue
        return out

    def step_requests(self) -> List[Dict[str, Any]]:
        seen, self._step_seen = list(self._step_seen.values()), {}
        cut = self._cut_off_calls()
        out: List[Dict[str, Any]] = []
        for req, response, state in seen[:STEP_REQUESTS_MAX]:
            try:
                entry = self._describe_request(req, response, state)
            except Exception:
                logger.debug("describing a page request failed", exc_info=True)
                continue
            hit = next((c for c in cut if c.get("method") == req.method and c.get("url") == req.url), None)
            if hit is not None:
                cut.remove(hit)
                out.append(self._too_large(entry, hit))
            else:
                out.append(entry)
        for hit in cut[:5]:  # cut off, but not seen as a step's call (a frame, an earlier step)
            there = urlparse(str(hit.get("url") or ""))
            out.append(self._too_large({"method": hit.get("method"), "path": there.path or "/", "cut_later": True},
                                       hit))
        if len(seen) > STEP_REQUESTS_MAX:
            out.append({"more": len(seen) - STEP_REQUESTS_MAX})
        return out

    def _too_large(self, entry: Dict[str, Any], hit: Mapping[str, Any]) -> Dict[str, Any]:
        entry = {k: v for k, v in entry.items() if k not in ("failed", "pending", "shape", "bytes")}
        if hit.get("reason") == "sync":
            entry["aborted"] = "sync_xhr"
            entry["hint"] = ("the page asked for this with a synchronous XHR, which explore can't cut off at its "
                             "size cap, so it was refused: read this endpoint with an extract_json step (it has "
                             "max_bytes) and a narrow filter instead")
            return entry
        entry["aborted"] = "too_large"
        entry["bytes_seen"] = int(hit.get("seen") or 0)
        if hit.get("total"):
            entry["content_length"] = int(hit["total"])
        entry["hint"] = (f"the answer passed the explore cap of {self._call_max_bytes} bytes and was cut off: "
                         "add a narrower filter (one day, or one known value) before clicking")
        return entry

    def _describe_request(self, req: Any, response: Any, state: str) -> Dict[str, Any]:
        """One same-origin XHR/fetch call, with its answer's JSON shape (reads what the page already got)."""
        there = urlparse(req.url)
        req_type = (req.headers.get("content-type") or "").lower()
        entry: Dict[str, Any] = {
            "method": req.method, "path": there.path or "/",
            "query": request_sample(there.query, "application/x-www-form-urlencoded") if there.query else None,
            "request_type": req_type[:80] or None,
            "body": request_sample(req.post_data, req_type) if req.post_data else None,
        }
        if state == "failed":
            entry["failed"] = str(getattr(req, "failure", None) or "no answer")[:200]
            return {k: v for k, v in entry.items() if v is not None}
        if response is None:
            entry["pending"] = "no answer yet (still running when the step ended)"
            return {k: v for k, v in entry.items() if v is not None}
        ctype = (response.headers.get("content-type") or "").lower()
        size = int(response.headers.get("content-length") or 0) or None
        entry.update(status=response.status, content_type=ctype[:80] or None, bytes=size)
        if state != "finished":
            entry["pending"] = "answer still downloading when the step ended"
        elif "json" in ctype or "javascript" in ctype:
            if size is not None and size > SHAPE_MAX_BYTES:
                entry["shape"] = {"skipped": f"answer over {SHAPE_MAX_BYTES} bytes"}
            else:
                try:
                    raw = response.body()
                    entry["bytes"] = len(raw)
                    entry["shape"] = (json_shape(json.loads(raw)) if len(raw) <= SHAPE_MAX_BYTES
                                      else {"skipped": f"answer over {SHAPE_MAX_BYTES} bytes"})
                except Exception as exc:
                    entry["shape"] = {"unreadable": type(exc).__name__}
        return {k: v for k, v in entry.items() if v is not None}

    def _on_response(self, response: Any) -> None:
        """Remember same-origin JSON XHR/fetch answers for :meth:`inventory` (keys only, never values)."""
        try:
            req = response.request
            seen = self._step_seen.get(id(req))
            if seen is not None and seen[0] is req:
                seen[1] = response
                if seen[2] == "pending":
                    seen[2] = "answered"
            if req.resource_type not in ("xhr", "fetch"):
                return
            ctype = (response.headers.get("content-type") or "").lower()
            if "json" not in ctype and "javascript" not in ctype:
                return
            here, there = urlparse(self._page.url), urlparse(req.url)
            if (here.scheme, here.netloc) != (there.scheme, there.netloc):
                return
            post = req.post_data or ""
            keys: List[str] = []
            if post.lstrip().startswith(("{", "[")):
                try:
                    decoded = json.loads(post)
                except ValueError:
                    decoded = None
                keys = sorted(str(k) for k in decoded) if isinstance(decoded, dict) else []
            elif post:
                keys = sorted({k for k, _ in parse_qsl(post, keep_blank_values=True)})
            entry = {"method": req.method, "url": there._replace(query="").geturl(),
                     "query_keys": sorted({k for k, _ in parse_qsl(there.query, keep_blank_values=True)}),
                     "body_keys": keys[:80], "status": response.status, "content_type": ctype[:60],
                     "bytes": int(response.headers.get("content-length") or 0) or None}
            if len(self._json_seen) < 50 and entry not in self._json_seen:
                self._json_seen.append(entry)
        except Exception:
            logger.debug("recording a JSON response failed", exc_info=True)

    def close(self) -> None:
        # Tearing the browser down can release requests still paused in the
        # network guard; cancel pending navigations and let the guard answer
        # every intercepted request first.
        try:
            self._page.goto("about:blank", timeout=5000)
            self._page.wait_for_timeout(50)
        except Exception:
            logger.debug("quiescing the recipe browser failed", exc_info=True)
        try:
            self._context.close()
            self._browser.close()
        finally:
            self._pw.stop()


# --------------------------------------------------------------------------
# runner
# --------------------------------------------------------------------------


def _norm_header(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower().rstrip(":")


def _resolve_columns(columns: Mapping[str, Mapping[str, Any]], headers: Sequence[str]) -> Tuple[Dict[str, Dict[str, Any]], List[str]]:
    """Header names → cell indexes. Returns (columns for the driver, missing headers)."""
    normalized = [_norm_header(h) for h in headers]
    out: Dict[str, Dict[str, Any]] = {}
    missing: List[str] = []
    for name, spec in columns.items():
        col: Dict[str, Any] = {k: spec[k] for k in ("selector", "index", "attr") if k in spec}
        if "header" in spec and "selector" not in spec and "index" not in spec:
            want = _norm_header(str(spec["header"]))
            idx = next((i for i, h in enumerate(normalized) if h == want), None)
            if idx is None:
                idx = next((i for i, h in enumerate(normalized) if want and want in h), None)
            if idx is None:
                missing.append(str(spec["header"]))
                continue
            col["index"] = idx
        out[name] = col
    return out, missing


class _Run:
    def __init__(self, recipe: Mapping[str, Any], driver: Driver, username: Optional[str], password: Optional[str],
                 report: RunReport, *, today: Optional[dt.date] = None, sleep: Callable[[float], None] = time.sleep):
        self.recipe = recipe
        self.driver = driver
        self.username = username
        self.password = password
        self.report = report
        self.base_url = str(recipe["base_url"])
        self.origin = urlparse(self.base_url)
        self.date_format = recipe.get("date_format") or DEFAULT_DATE_FORMAT
        self.delay = max(0, int(recipe.get("delay_ms") or 0)) / 1000.0
        self.today = today
        self.sleep = sleep
        self.logged_in = False
        self.extracted: Dict[int, List[Any]] = {}
        # Explore only: warnings about the step that is running (empty search filters).
        self.step_warnings: Optional[List[Dict[str, Any]]] = None

    # -- navigation ----------------------------------------------------------

    def url(self, raw: str) -> str:
        absolute = urljoin(self.base_url, raw)
        parsed = urlparse(absolute)
        if (parsed.scheme, parsed.netloc) != (self.origin.scheme, self.origin.netloc):
            raise RecipeError(f"goto {raw!r} leaves the site ({self.origin.netloc})")
        if is_forbidden_url(absolute):
            raise ForbiddenTarget(f"goto {raw!r} looks like a data-changing action")
        return absolute

    def page_loaded(self, delay: Optional[float] = None) -> None:
        self.report.pages += 1
        pause = self.delay if delay is None else delay
        if pause:
            self.sleep(pause)

    def login(self) -> None:
        spec = self.recipe.get("login")
        if not spec:
            return
        if not self.password:
            raise LoginFailed("the credential has no password")
        d = self.driver
        d.goto(self.url(spec["url"]))
        user_field = spec.get("username_field") or "input[name=username]"
        pass_field = spec.get("password_field") or "input[type=password]"
        if self.username:
            d.fill(user_field, self.username)
        if spec.get("next"):
            d.click({"selector": spec["next"]} if isinstance(spec["next"], str) else spec["next"])
        d.fill(pass_field, self.password, secret=True)
        submit = spec.get("submit")
        if submit:
            d.click({"selector": submit} if isinstance(submit, str) else submit)
        else:
            d.press(pass_field, "Enter")
        self.page_loaded()
        failure = spec.get("failure_text")
        if failure and d.text_present(str(failure)):
            raise LoginFailed(f"the site answered {failure!r}")
        success = spec.get("success") or {}
        url = d.current_url()
        ok = True
        if success.get("selector"):
            ok = ok and d.exists({"selector": success["selector"]})
        if success.get("text"):
            ok = ok and d.text_present(str(success["text"]))
        if success.get("url_contains"):
            ok = ok and str(success["url_contains"]) in url
        if success.get("url_not_contains"):
            ok = ok and str(success["url_not_contains"]) not in url
        if not success:
            ok = not d.exists({"selector": pass_field})
        if not ok:
            raise LoginFailed("the success check did not pass after submitting the login form")
        self.logged_in = True

    def login_form_showing(self) -> bool:
        spec = self.recipe.get("login")
        if not spec or not self.logged_in:
            return False
        return self.driver.exists({"selector": spec.get("password_field") or "input[type=password]"})

    def goto(self, raw: str) -> None:
        target = self.url(raw)
        self.driver.goto(target)
        self.page_loaded()
        if self.login_form_showing():
            self.report.warnings.append(f"session expired before {raw}; logged in again")
            self.login()
            self.driver.goto(target)
            self.page_loaded()

    def note_empty_filters(self, ctx: Mapping[str, Any], step: Mapping[str, Any], target: Mapping[str, Any]) -> None:
        if self.step_warnings is None:
            return
        empty = self.driver.empty_filters(target)
        if empty:
            label = ".".join(ctx.get("step_path") or []) or "?"
            self.step_warnings.append({
                "step": int(label) if label.isdigit() else label, "op": step.get("op"), "empty_filters": empty,
                "warning": (f"{step.get('op')} with empty filters {empty}: a search without a filter can return "
                            "everything and slow the site. Set the narrowest filter (one day, or one known value) "
                            "first; if none can be set, do not click, ask the person instead."),
            })

    def guarded_click(self, where: str, target: Mapping[str, Any]) -> None:
        _check_static_target(where, target)
        _check_element(where, self.driver.describe(target))
        self.driver.click(target)
        self.page_loaded()

    # -- entities ------------------------------------------------------------

    def entity(self, name: str, ent: Mapping[str, Any], cursor: Any) -> Iterator[ExtractedItem]:
        ctx = {
            "name": name,
            "kind": ent["kind"],
            "key": list(ent.get("key") or []),
            "cursor_col": ent.get("cursor"),
            "date_format": ent.get("date_format") or self.date_format,
            "vars": {"cursor": cursor},
            "last_count": 0,
            "page_keys": [],
            "run_mode": "full" if cursor is None else "incremental",
        }
        self.extracted = {}
        yield from self.steps(ent["steps"], ctx)

    def empty_extractions(self) -> List[str]:
        """Extraction steps of the last entity that produced no record and do not set ``allow_empty``."""
        return [where for where, allow_empty, count in self.extracted.values() if count == 0 and not allow_empty]

    def render(self, step: Mapping[str, Any], field_name: str, ctx: Dict[str, Any], *,
               date_format: Optional[str] = None) -> str:
        fmt = date_format or step.get("format") or ctx["date_format"]
        raw = step.get(field_name)
        variables = ctx["vars"]
        if "cursor" in _template_names(raw) and variables.get("cursor") is None:
            raw = step.get("default")
        return render_template(raw, variables, date_format=fmt, today=self.today)

    def steps(self, steps: Sequence[Mapping[str, Any]], ctx: Dict[str, Any],
              after_step: Optional[Callable[[str, Mapping[str, Any]], None]] = None) -> Iterator[ExtractedItem]:
        """Run ``steps``; ``after_step(label, step)`` is called after every step, nested ones too ("2.1")."""
        if after_step is not None:
            ctx["after_step"], ctx["step_path"] = after_step, []
        hook = ctx.get("after_step")
        path: List[str] = ctx.setdefault("step_path", [])
        for i, step in enumerate(steps):
            if step.get("when") not in (None, ctx.get("run_mode", "full")):
                continue
            path.append(str(i + 1))
            try:
                yield from self._step(i, step, ctx)
            finally:
                if hook is not None:
                    hook(".".join(path), step)
                path.pop()

    def _step(self, i: int, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        op = step["op"]
        where = f"{ctx['name']}: step {i + 1} ({op})"
        d = self.driver
        if op == "goto":
            self.goto(step["url"])
        elif op == "click":
            self.note_empty_filters(ctx, step, step)
            self.guarded_click(where, step)
        elif op == "fill":
            d.fill(step["selector"], self.render(step, "value", ctx))
        elif op == "select":
            label = step.get("label")
            d.select(step["selector"], None if label is not None else self.render(step, "value", ctx), label)
        elif op == "press":
            _check_static_target(where, step)
            d.press(step["selector"], step.get("key", "Enter"), timeout_ms=step.get("timeout_ms"))
            self.page_loaded()
        elif op == "submit":
            _check_static_target(where, step)
            info = d.describe({"selector": step.get("selector") or "form", "timeout_ms": step.get("timeout_ms")})
            if str(info.get("tag", "")).upper() == "FORM":
                info = {k: info.get(k) for k in ("id", "name", "action")}
            _check_element(where, info)
            self.note_empty_filters(ctx, step, {"selector": step.get("selector") or "form",
                                                "timeout_ms": step.get("timeout_ms")})
            d.submit(step.get("selector"), timeout_ms=step.get("timeout_ms"))
            self.page_loaded()
        elif op == "wait":
            d.wait(step)
        elif op in _EXTRACT_OPS:
            extract = {"extract_table": self.extract_table, "extract_fields": self.extract_fields,
                       "extract_datatable": self.extract_datatable, "extract_json": self.extract_json}[op]
            tally = self.extracted.setdefault(id(step), [where, step.get("allow_empty") is True, 0])
            for item in extract(where, step, ctx):
                tally[2] += 1
                yield item
        elif op == "paginate":
            yield from self.paginate(where, step, ctx)
        elif op == "date_windows":
            yield from self.date_windows(where, step, ctx)

    def emit(self, where: str, ctx: Dict[str, Any], record: Dict[str, Any], key: Optional[str]) -> Optional[ExtractedItem]:
        name = ctx["name"]
        if key is None:
            if ctx["key"]:
                self.report.warnings.append(f"{where}: skipped a row with an empty key {ctx['key']}")
                return None
            key = _content_key(record)
        ctx["page_keys"].append(key)
        ctx["last_count"] += 1
        self.report.rows[name] = self.report.rows.get(name, 0) + 1
        col = ctx["cursor_col"]
        if col and record.get(col) is not None:
            best = self.report.cursors.get(name)
            try:
                if best is None or record[col] > best:
                    self.report.cursors[name] = record[col]
            except TypeError:
                self.report.cursors[name] = record[col]
        return ExtractedItem(name, ctx["kind"], key, record)

    def convert(self, where: str, specs: Mapping[str, Mapping[str, Any]], raw: Mapping[str, Any]) -> Dict[str, Any]:
        record: Dict[str, Any] = {}
        for col, spec in specs.items():
            try:
                record[col] = convert_value(raw.get(col), spec)
            except _BadValue as exc:
                self.report.warnings.append(f"{where}: {col}: {exc}; stored as null")
                record[col] = None
        return record

    def extract_table(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        d = self.driver
        columns = step["columns"]
        headers = d.table_headers(step)
        if headers is None:
            if step.get("optional"):
                return
            raise RecipeError(f"{where}: table {step.get('table') or 'table'!r} not found on {d.current_url()}")
        resolved, missing = _resolve_columns(columns, headers)
        if missing:
            raise RecipeError(f"{where}: column header(s) {missing} not found (page has {headers})")
        spec = {"table": step.get("table"), "row": step.get("row"), "columns": resolved}
        for raw in d.table_rows(spec):
            record = self.convert(where, columns, raw)
            if step.get("skip_empty", True) and all(v in (None, "") for v in record.values()):
                continue
            item = self.emit(where, ctx, record, build_key(record, ctx["key"]))
            if item is not None:
                yield item

    def extract_fields(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        fields_ = step["fields"]
        raw = self.driver.fields({k: {kk: v[kk] for kk in ("selector", "attr", "all") if kk in v} for k, v in fields_.items()})
        record = self.convert(where, fields_, raw)
        required = [k for k, v in fields_.items() if v.get("required", True) and not v.get("all")]
        if required and all(record.get(k) is None for k in required):
            raise RecipeError(f"{where}: none of the fields {required} found on {self.driver.current_url()}")
        if ctx["key"]:
            key = build_key(record, ctx["key"])
        else:
            key = str(step.get("key") or ctx["name"])
        item = self.emit(where, ctx, record, key)
        if item is not None:
            yield item

    def emit_rows(self, where: str, columns: Mapping[str, Any], rows: Iterable[Mapping[str, Any]],
                  ctx: Dict[str, Any], *, skip_empty: bool = True) -> Iterator[ExtractedItem]:
        for raw in rows:
            record = self.convert(where, columns, raw)
            if skip_empty and all(v in (None, "") for v in record.values()):
                continue
            item = self.emit(where, ctx, record, build_key(record, ctx["key"]))
            if item is not None:
                yield item

    def extract_datatable(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        d = self.driver
        table = str(step["table"])
        timeout_ms = int(step.get("timeout_ms") or self.recipe.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
        deadline = time.monotonic() + timeout_ms / 1000
        info = d.datatable(table, None, 0, 0)
        while info.get("state") not in ("ready", "ambiguous") and time.monotonic() < deadline:
            d.wait({"ms": 200})
            info = d.datatable(table, None, 0, 0)
        state = info.get("state")
        if state != "ready":
            if state == "no_table" and step.get("optional"):
                return
            url = d.current_url()
            raise RecipeError(f"{where}: " + {
                "no_table": f"table {table!r} not found on {url}",
                "no_datatables": f"no DataTables library (jQuery.fn.dataTable / window.DataTable) on {url}; "
                                 "use extract_table with paginate",
                "not_initialised": f"{table!r} on {url} is not a DataTables table; use extract_table with paginate",
                "loading": f"the DataTables table {table!r} did not finish loading within {timeout_ms} ms",
                "ambiguous": f"ambiguous selector {table!r}: it matches {len(info.get('matches') or [])} DataTables "
                             f"tables on {url} ({', '.join(info.get('matches') or [])}); use one table's id",
            }.get(str(state), f"cannot read {table!r} on {url} ({state})"))
        if info.get("server_side"):
            raise RecipeError(
                f"{where}: {table!r} is a server-side DataTable (the page only holds the rows on screen); read "
                f"its endpoint {info.get('ajax_url') or '(see the page script)'} with extract_json and a "
                "start/length 'page' block"
            )
        columns = step["columns"]
        dt_cols = info.get("columns") or []
        resolved: Dict[str, Dict[str, Any]] = {}
        missing: List[str] = []
        headers = [_norm_header(c.get("header") or "") for c in dt_cols]
        for name, spec in columns.items():
            col: Dict[str, Any] = {k: spec[k] for k in ("attr", "html") if k in spec}
            if "field" in spec:
                col["path"] = spec["field"]
            else:
                if "index" in spec:
                    idx: Optional[int] = int(spec["index"]) if int(spec["index"]) < len(dt_cols) else None
                    label = f"index {spec['index']}"
                else:
                    want = _norm_header(str(spec["header"]))
                    idx = next((i for i, h in enumerate(headers) if h == want), None)
                    if idx is None:
                        idx = next((i for i, h in enumerate(headers) if want and want in h), None)
                    label = str(spec["header"])
                if idx is None:
                    missing.append(label)
                    continue
                src = dt_cols[idx].get("data")
                if src is None:
                    col["cell"] = idx
                else:
                    col["path"] = src
            resolved[name] = col
        if missing:
            raise RecipeError(f"{where}: column(s) {missing} not found (table has "
                              f"{[c.get('header') for c in dt_cols]})")
        total = int(info.get("total") or 0)
        for start in range(0, total, DATATABLE_CHUNK):
            chunk = d.datatable(table, resolved, start, DATATABLE_CHUNK)
            if chunk.get("state") != "ready":
                raise RecipeError(f"{where}: the DataTables table {table!r} went away while reading it")
            yield from self.emit_rows(where, columns, chunk.get("rows") or [], ctx,
                                      skip_empty=step.get("skip_empty", True))

    def render_value(self, value: Any, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Any:
        """Templates inside a request's params / form / json (strings only; types kept)."""
        if isinstance(value, Mapping):
            return {k: self.render_value(v, step, ctx) for k, v in value.items()}
        if isinstance(value, list):
            return [self.render_value(v, step, ctx) for v in value]
        if not isinstance(value, str):
            return value
        raw = value
        if "cursor" in _template_names(raw) and ctx["vars"].get("cursor") is None:
            raw = step.get("default")
        return render_template(raw, ctx["vars"], date_format=step.get("format") or ctx["date_format"],
                               today=self.today)

    def fetch_json(self, where: str, step: Mapping[str, Any], url: str, params: Dict[str, Any],
                   form: Optional[Dict[str, Any]], body_json: Any) -> Any:
        method = str(step.get("method") or "GET").upper()
        if form is not None:
            body: Optional[str] = urlencode([(k, _scalar(v)) for k, v in form.items()])
            ctype: Optional[str] = "application/x-www-form-urlencoded; charset=UTF-8"
        elif body_json is not None:
            body, ctype = json.dumps(body_json), "application/json"
        else:
            body = ctype = None
        if method == "POST" and body is None:
            body, ctype = "", "application/x-www-form-urlencoded; charset=UTF-8"
        max_bytes = int(step.get("max_bytes") or DEFAULT_MAX_BYTES)
        timeout_ms = int(step.get("timeout_ms") or self.recipe.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
        for attempt in (1, 2):
            res = self.driver.fetch(url, method=method, params={k: _scalar(v) for k, v in params.items()},
                                    body=body, content_type=ctype, headers=dict(step.get("headers") or {}),
                                    max_bytes=max_bytes, timeout_ms=timeout_ms)
            delay = step.get("delay_ms")
            self.page_loaded(None if delay is None else int(delay) / 1000.0)
            if res.get("too_big") is not None:
                raise RecipeError(
                    f"{where}: {method} {urlparse(url).path} answered more than max_bytes={max_bytes} "
                    f"({res['too_big']} bytes read); add a start/length 'page' block or a narrower date_windows"
                )
            if res.get("error"):
                raise RecipeError(f"{where}: {method} {urlparse(url).path} failed: {res['error']}")
            text = str(res.get("text") or "")
            if not res.get("redirected"):
                status = int(res.get("status") or 0)
                if status >= 400:
                    raise RecipeError(f"{where}: {method} {urlparse(url).path} answered HTTP {status}")
                try:
                    return json.loads(text)
                except ValueError:
                    pass
            expired = res.get("redirected") or _LOGIN_FORM.search(text[:200_000])
            if attempt == 1 and expired and self.recipe.get("login") and self.logged_in:
                self.report.warnings.append(f"session expired before {urlparse(url).path}; logged in again")
                self.login()
                continue
            if res.get("redirected"):
                raise RecipeError(f"{where}: {method} {urlparse(url).path} redirected (not followed)")
            head = re.sub(r"\s+", " ", text)[:60]
            raise RecipeError(f"{where}: {method} {urlparse(url).path} did not answer JSON "
                              f"({res.get('content_type') or 'no content type'}: {head!r})")
        raise RecipeError(f"{where}: {method} {urlparse(url).path} failed")

    def extract_json(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        url = self.url(str(step["url"]))
        columns = step["columns"]
        params = dict(self.render_value(step.get("params") or {}, step, ctx))
        form = self.render_value(step["form"], step, ctx) if "form" in step else None
        body_json = self.render_value(step["json"], step, ctx) if "json" in step else None
        if str(step.get("method") or "GET").upper() == "POST" and form is None and body_json is None:
            form = {}
        for value in _strings([params, form, body_json]):
            if is_forbidden_text(value):
                raise ForbiddenTarget(f"{where}: request value {value!r} looks like a data-changing action")
        page = step.get("page")
        records_path = str(step.get("records") or "")
        specs = {name: ({"path": spec["field"]} if "field" in spec else {"path": int(spec["index"])})
                 for name, spec in columns.items()}
        start = int((page or {}).get("start", 0))
        length = int(page["length"]) if page else 0
        max_pages = int((page or {}).get("max_pages") or DEFAULT_MAX_PAGES)
        where_in = (page or {}).get("in") or ("json" if body_json is not None else "form" if form is not None
                                               else "params")
        previous: Optional[List[str]] = None
        for number in range(1, max_pages + 1):
            p_params, p_form, p_json = dict(params), (dict(form) if form is not None else None), body_json
            if page:
                extra: Dict[str, Any] = {page["start_param"]: start, page["length_param"]: length}
                if page.get("draw_param"):
                    extra[page["draw_param"]] = number
                if where_in == "json":
                    p_json = {**dict(body_json or {}), **extra}
                elif where_in == "form":
                    p_form = {**(p_form or {}), **extra}
                else:
                    p_params.update(extra)
            data = self.fetch_json(where, step, url, p_params, p_form, p_json)
            records = _dig(data, records_path)
            if not isinstance(records, list):
                found = sorted(data)[:20] if isinstance(data, dict) else type(data).__name__
                raise RecipeError(f"{where}: records {records_path or '(top level)'!r} is not a list "
                                  f"(response has {found})")
            rows = [{name: _dig(rec, spec["path"]) for name, spec in specs.items()} for rec in records]
            before = len(ctx["page_keys"])
            yield from self.emit_rows(where, columns, rows, ctx, skip_empty=step.get("skip_empty", True))
            this_page = ctx["page_keys"][before:]
            if not page or len(records) < length:
                break
            total = _dig(data, page["total"]) if page.get("total") else None
            if previous is not None and this_page == previous:
                self.report.warnings.append(f"{where}: page {number} repeated the previous page; stopped")
                break
            previous = this_page
            start += length
            try:
                if total is not None and start >= int(total):
                    break
            except (TypeError, ValueError):
                pass
            if number == max_pages:
                self.report.warnings.append(f"{where}: stopped at max_pages={max_pages}")

    def paginate(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        outer_count, outer_keys = ctx["last_count"], ctx["page_keys"]
        all_keys: List[str] = []
        try:
            yield from self._pages(where, step, ctx, all_keys)
        finally:
            ctx["last_count"], ctx["page_keys"] = outer_count + len(all_keys), outer_keys + all_keys

    def _pages(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any],
               all_keys: List[str]) -> Iterator[ExtractedItem]:
        max_pages = int(step.get("max_pages") or DEFAULT_MAX_PAGES)
        nxt = step.get("next")
        param = step.get("page_param")
        page_no = int(step.get("start", 1))
        previous: Optional[List[str]] = None
        for done in range(1, max_pages + 1):
            ctx["last_count"], ctx["page_keys"] = 0, []
            yield from self.steps(step["steps"], ctx)
            this_page = list(ctx["page_keys"])
            all_keys.extend(this_page)
            if not this_page and step.get("stop_on_empty", True):
                break
            if previous is not None and this_page == previous:
                self.report.warnings.append(f"{where}: page {done} repeated the previous page; stopped")
                break
            previous = this_page
            if done == max_pages:
                self.report.warnings.append(f"{where}: stopped at max_pages={max_pages}")
                break
            if nxt:
                if not self.driver.exists(nxt, enabled=True):
                    break
                self.guarded_click(f"{where} next", nxt)
            else:
                page_no += 1
                parsed = urlparse(self.driver.current_url())
                query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != param]
                query.append((str(param), str(page_no)))
                self.goto(urlunparse(parsed._replace(query=urlencode(query))))

    def date_windows(self, where: str, step: Mapping[str, Any], ctx: Dict[str, Any]) -> Iterator[ExtractedItem]:
        start = _as_date(self.render(step, "from", ctx, date_format=DEFAULT_DATE_FORMAT))
        end = _as_date(render_template(step.get("to") or "{{today}}", ctx["vars"], today=self.today))
        if start is None or end is None:
            raise RecipeError(f"{where}: 'from'/'to' must render to dates")
        days = int(step["days"])
        outer = dict(ctx["vars"])
        cursor = start
        while cursor <= end:
            stop = min(end, cursor + dt.timedelta(days=days - 1))
            ctx["vars"] = {**outer, "window_from": cursor, "window_to": stop}
            yield from self.steps(step["steps"], ctx)
            cursor = stop + dt.timedelta(days=1)
        ctx["vars"] = outer


_LOGIN_FORM = re.compile(r"<input[^>]+type\s*=\s*[\"']?password", re.I)


def _scalar(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return "" if value is None else str(value)


def _dig(value: Any, path: Any) -> Any:
    """``value`` at a dotted path (``""`` = itself); list items by number."""
    if isinstance(path, int):
        return value[path] if isinstance(value, list) and -len(value) <= path < len(value) else None
    for part in [p for p in str(path).split(".") if p != ""]:
        if isinstance(value, Mapping):
            value = value.get(part)
        elif isinstance(value, list) and re.fullmatch(r"-?\d+", part) and -len(value) <= int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def _network_guard(base_url: str, allow_private: bool) -> Callable[..., Optional[str]]:
    origin = urlparse(base_url)
    host_ok: Dict[str, bool] = {}

    def _safe_host(url: str) -> bool:
        host = urlparse(url).hostname or ""
        if host not in host_ok:
            try:
                from tools.url_safety import is_safe_url

                host_ok[host] = bool(is_safe_url(url))
            except Exception:
                host_ok[host] = False
        return host_ok[host]

    def guard(url: str, resource_type: str, method: str) -> Optional[str]:
        parsed = urlparse(url)
        if parsed.scheme in ("data", "blob", "about"):
            return None
        same_site = (parsed.scheme, parsed.netloc) == (origin.scheme, origin.netloc)
        if resource_type in ("document", "xhr", "fetch") and is_forbidden_url(url):
            return "looks like a data-changing action"
        if resource_type == "document" and not same_site:
            return "navigation off the source site"
        if not same_site and not allow_private and not _safe_host(url):
            return "private/internal address"
        return None

    return guard


@contextmanager
def _session(recipe: Mapping[str, Any], credential: Any, *, report: RunReport, driver: Optional[Driver],
             allow_private: bool, today: Optional[dt.date] = None,
             call_max_bytes: Optional[int] = None) -> Iterator["_Run"]:
    """A logged-in :class:`_Run` on a guarded browser, closed afterwards."""
    base_url = str(recipe["base_url"])
    if not allow_private:
        from tools.url_safety import is_safe_url

        if not is_safe_url(base_url):
            raise RecipeError(f"base_url {base_url} is a private/internal address (URL safety)")
    username, password = _credential_parts(credential)
    own_driver = driver is None
    if driver is None:
        driver = PlaywrightDriver(
            timeout_ms=int(recipe.get("timeout_ms") or DEFAULT_TIMEOUT_MS),
            guard=_network_guard(base_url, allow_private),
            on_blocked=report.blocked_requests.append,
            call_max_bytes=call_max_bytes,
        )
    run = _Run(recipe, driver, username, password, report, today=today)
    try:
        try:
            run.login()
        except LoginFailed:
            raise
        except Exception as exc:
            raise LoginFailed(_redact(f"{type(exc).__name__}: {exc}", password)) from None
        yield run
    finally:
        if own_driver:
            try:
                driver.close()
            except Exception:
                logger.debug("closing the recipe browser failed", exc_info=True)


def annotate_inventory(inventory: Dict[str, Any]) -> Dict[str, Any]:
    """Flag the links, buttons and forms of a page inventory that must never be used."""
    for link in inventory.get("links") or []:
        link["forbidden"] = is_forbidden_text(link.get("text")) or is_forbidden_url(link.get("href")) or \
            is_forbidden_text(link.get("onclick"))
    for button in inventory.get("buttons") or []:
        button["forbidden"] = any(is_forbidden_text(button.get(k)) for k in ("text", "id", "name", "cls", "onclick")) \
            or is_forbidden_url(button.get("form_action"))
    for form in inventory.get("forms") or []:
        form["forbidden"] = any(is_forbidden_text(form.get(k)) for k in ("id", "name")) or \
            is_forbidden_url(form.get("action"))
    _flag_secrets(inventory)
    return inventory


def _merge_cut_off(groups: List[Dict[str, Any]], entry: Dict[str, Any]) -> bool:
    """Fold a call cut off after its step ended into that step's ``pending`` entry for it."""
    if not entry.pop("cut_later", False):
        return False
    for group in reversed(groups):
        for r in group["requests"]:
            if r.get("pending") and r.get("method") == entry.get("method") and r.get("path") == entry.get("path"):
                kept = {k: v for k, v in r.items() if k in ("method", "path", "query", "request_type", "body",
                                                            "status", "content_type")}
                r.clear()
                r.update(kept, **{k: v for k, v in entry.items() if k not in kept})
                return True
    return False


def _flag_secrets(inventory: Dict[str, Any]) -> None:
    """Note (and mask) columns and JSON keys that look like secrets the site sends to the browser."""
    found: List[str] = []
    for form in inventory.get("forms") or []:
        shown = []
        for f in form.get("fields") or []:
            if not isinstance(f, dict) or not any(looks_like_secret_column(f.get(k)) for k in ("name", "id", "label")):
                continue
            if f.get("value"):
                f["value"] = REDACTED
                if str(f.get("type") or "").lower() != "hidden":  # hidden ones are mostly CSRF tokens
                    shown.append(f.get("name") or f.get("id") or f.get("label"))
        if shown:
            found.append(f"form {form.get('selector')}: filled-in fields {shown}")
    for t in inventory.get("tables") or []:
        bad = [i for i, h in enumerate(t.get("headers") or []) if looks_like_secret_column(h)]
        if bad:
            t["secret_columns"] = [t["headers"][i] for i in bad]
            t["sample"] = [[REDACTED if i in bad else v for i, v in enumerate(row)] if isinstance(row, list) else row
                           for row in t.get("sample") or []]
            found.append(f"table {t.get('selector')}: columns {t['secret_columns']}")
    for t in inventory.get("datatables") or []:
        keys = [c.get("data") or c.get("title") for c in t.get("columns") or [] if isinstance(c, Mapping)]
        bad_keys = [k for k in keys if looks_like_secret_column(k)]
        if bad_keys:
            t["secret_columns"] = bad_keys
            found.append(f"datatable {t.get('selector')}: columns {bad_keys}")
    for r in inventory.get("json_requests") or []:
        bad_keys = [k for k in r.get("record_keys") or [] if looks_like_secret_column(k)]
        if bad_keys:
            found.append(f"json {r.get('url')}: keys {bad_keys}")
    for group in inventory.get("step_requests") or []:
        for r in group.get("requests") or []:
            bad_keys = [k for k in (r.get("shape") or {}).get("record_keys") or [] if looks_like_secret_column(k)]
            if bad_keys:
                r["secret_keys"] = bad_keys
                found.append(f"{r.get('method')} {r.get('path')}: record keys {bad_keys}")
    extracted = inventory.get("extracted")
    if isinstance(extracted, list):
        bad_keys = sorted({k for row in extracted if isinstance(row, Mapping) for k in row
                           if looks_like_secret_column(k)})
        if bad_keys:
            inventory["extracted"] = [{k: REDACTED if k in bad_keys else v for k, v in row.items()}
                                      if isinstance(row, Mapping) else row for row in extracted]
            found.append(f"extracted rows: columns {bad_keys}")
    if isinstance(inventory.get("text"), str):
        inventory["text"] = _mask_token_runs(inventory["text"])
    if found:
        inventory["security"] = [
            "this page sends what looks like secrets (password/hash/token/API key) to the browser: "
            + "; ".join(found)[:600]
            + ". Exclude the whole entity, never store these columns, and list it in the design's exclusions "
            "as a security issue to report to the site owner."]


def inventory_summary(name: str, inv: Mapping[str, Any]) -> str:
    """A few readable lines about one :func:`browse` inventory (what the study reads first)."""
    lines = [f"[{name}] {inv.get('title', '')} — {inv.get('url', '')}"]
    if "error" in inv:
        lines = [f"[{name}] ERROR {inv['error']}"]
        if inv.get("hint"):
            lines.append(f"  hint: {inv['hint']}")
    for group in inv.get("step_requests") or []:
        for r in group.get("requests") or []:
            if "more" in r:
                lines.append(f"  after step {group['step']} ({group['op']}): {r['more']} more requests")
                continue
            sent = " ".join(f"{k} {r[k]}" for k in ("query", "body") if r.get(k))
            got = ("REFUSED (synchronous XHR); read it with extract_json" if r.get("aborted") == "sync_xhr"
                   else f"CUT OFF (too large: {r.get('bytes_seen')} bytes seen"
                   f"{', ' + str(r['content_length']) + ' announced' if r.get('content_length') else ''}); "
                   "add a narrower filter" if r.get("aborted")
                   else f"FAILED {r['failed']}" if r.get("failed")
                   else f"PENDING ({r['pending']})" if "status" not in r
                   else f"{r.get('status')} {r.get('content_type') or ''}{', ' + str(r['bytes']) + ' bytes' if r.get('bytes') else ''}")
            shape = r.get("shape") or {}
            if "records" in shape:
                got += (f"; records at {shape['records_path']!r}: {shape['records']}"
                        f", keys {shape.get('record_keys', [])[:15]}")
            elif shape.get("keys"):
                got += f"; keys {shape['keys'][:15]}"
            lines.append(f"  after step {group['step']} ({group['op']}): {r['method']} {r['path']}"
                         f"{' [' + r['request_type'] + ']' if r.get('request_type') else ''} {sent} -> {got}")
    for w in inv.get("warnings") or []:
        lines.append(f"  WARNING at step {w.get('step')}: {w.get('warning')}")
    for note in inv.get("security") or []:
        lines.append(f"  SECURITY: {note}")
    for t in inv.get("tables") or []:
        lines.append(f"  table {t['selector']}: {t['rows']} rows; headers {t['headers'][:12]}")
    for t in inv.get("datatables") or []:
        mode = "server-side" if t.get("server_side") else "client-side"
        keys = [c.get("data") for c in t.get("columns") or []]
        lines.append(f"  datatable {t['selector']} ({mode}, {t.get('total')} rows in the page"
                     f"{', ajax ' + t['ajax_url'] if t.get('ajax_url') else ''}): data keys {keys[:15]}")
    for r in inv.get("json_requests") or []:
        lines.append(f"  json {r['method']} {r['url']} query {r['query_keys'][:10]} body {r['body_keys'][:15]}"
                     f" -> {r['status']}{', ' + str(r['bytes']) + ' bytes' if r.get('bytes') else ''}")
    for f in inv.get("forms") or []:
        flag = " FORBIDDEN" if f.get("forbidden") else ""
        fields = [x.get("name") or x.get("id") for x in f.get("fields") or [] if x.get("type") != "hidden"]
        lines.append(f"  form {f['selector']} {f['method'].upper()} {f['action'] or '(same page)'}{flag}: {fields[:15]}")
    safe = [b["text"] or b["selector"] for b in inv.get("buttons") or [] if not b.get("forbidden")]
    bad = [b["text"] or b["selector"] for b in inv.get("buttons") or [] if b.get("forbidden")]
    if safe:
        lines.append(f"  buttons: {safe[:30]}")
    if bad:
        lines.append(f"  never click: {bad[:30]}")
    if inv.get("pagination"):
        lines.append(f"  pagination: {[p['text'] for p in inv['pagination']][:12]}")
    if inv.get("extracted_count"):
        lines.append(f"  extracted rows: {inv['extracted_count']}")
    return "\n".join(lines)


def browse(
    recipe: Mapping[str, Any],
    probes: Sequence[Mapping[str, Any]],
    credential: Any,
    *,
    report: Optional[RunReport] = None,
    driver: Optional[Driver] = None,
    allow_private: bool = False,
    today: Optional[dt.date] = None,
    max_call_bytes: Optional[int] = None,
) -> Iterator[Tuple[str, Dict[str, Any]]]:
    """Log in with ``recipe["login"]`` and yield ``(probe name, page inventory)``.

    Each probe is ``{"name": ..., "steps": [...]}`` with the same read-only
    steps and guards as a recipe entity (extract steps are allowed and their
    rows land in ``inventory["extracted"]``). The inventory lists the page's
    links, buttons (incl. ``onclick``), forms with their fields, tables with
    headers and sample rows, pagination controls and text, each control
    flagged ``forbidden`` when it must never be used. Used by the
    site-to-schema skill to study a site; a probe that fails yields
    ``{"error": ...}`` and the others still run.

    ``step_requests`` lists the XHR/fetch calls each step set off; an answer
    over ``max_call_bytes`` (default: the recipe's ``explore_max_call_bytes``,
    else 2 MB) is cut off and reported ``aborted: too_large``.
    ``warnings`` notes clicks/submits made with empty search filters, and
    ``security`` columns that look like secrets the site sends.
    """
    if max_call_bytes is None:
        max_call_bytes = recipe.get("explore_max_call_bytes") or DEFAULT_CALL_MAX_BYTES
    lo, hi = CALL_MAX_BYTES_RANGE
    if isinstance(max_call_bytes, bool) or not isinstance(max_call_bytes, int) or not lo <= max_call_bytes <= hi:
        raise RecipeError(f"explore_max_call_bytes must be a whole number from {lo} to {hi}")
    problems = [p for p in recipe_problems({**recipe, "entities": {}}) if not p.startswith("entities ")]
    for i, probe in enumerate(probes):
        problems += _steps_problems(f"probes[{i}]", probe.get("steps"))
    if problems:
        message = "invalid probes: " + "; ".join(problems)
        raise (ForbiddenTarget if any("data-changing action" in p for p in problems) else RecipeError)(message)
    report = report if report is not None else RunReport()
    with _session(recipe, credential, report=report, driver=driver, allow_private=allow_private,
                  today=today, call_max_bytes=max_call_bytes) as run:
        for i, probe in enumerate(probes):
            name = str(probe.get("name") or f"probe_{i + 1}")
            ctx = {"name": name, "kind": "variable", "key": list(probe.get("key") or []), "cursor_col": None,
                   "date_format": run.date_format, "vars": {"cursor": None}, "last_count": 0, "page_keys": []}
            step_requests: List[Dict[str, Any]] = []

            def note_requests(label: str, step: Mapping[str, Any]) -> None:
                requests = [r for r in run.driver.step_requests() if not _merge_cut_off(step_requests, r)]
                if requests:
                    step_requests.append({"step": int(label) if label.isdigit() else label, "op": step.get("op"),
                                          "requests": _redact_all(requests, run.password)})

            run.driver.step_requests()  # drop the login's and earlier probes' calls
            run.step_warnings = []
            extracted: List[Dict[str, Any]] = []
            try:
                for item in run.steps(probe["steps"], ctx, after_step=note_requests):
                    extracted.append(item.payload)
                inventory = annotate_inventory(run.driver.inventory())
            except Exception as exc:
                error = _redact(f"{type(exc).__name__}: {exc}", run.password)
                try:
                    inventory = annotate_inventory(run.driver.inventory())
                except Exception:
                    inventory = {}
                inventory["error"] = error
                if "timeout" in type(exc).__name__.lower() or "timeout" in str(exc).lower()[:200]:
                    inventory["hint"] = (
                        "a step timed out (a heavy page, a huge dropdown, or an element that never becomes "
                        "clickable). The same-origin requests the steps triggered so far are in step_requests: "
                        "read the endpoint there and use extract_json, or retry with a larger 'timeout_ms' on "
                        "the step, a more specific selector, or a narrower filter.")
            if extracted:
                inventory["extracted"] = extracted[:50]
                inventory["extracted_count"] = len(extracted)
            if step_requests:
                inventory["step_requests"] = step_requests
            if run.step_warnings:
                inventory["warnings"] = run.step_warnings
            run.step_warnings = None
            if any(r.get("aborted") == "too_large" for g in step_requests for r in g["requests"]):
                cut = ("an answer was cut off because it was too large (see step_requests): the search ran "
                       "without a narrow enough filter. Set one day or one known value and try again; do not "
                       "repeat the wide search.")
                inventory["hint"] = f"{inventory['hint']} {cut}" if inventory.get("hint") else cut
            _flag_secrets(inventory)
            yield name, inventory


def run_recipe(
    recipe: Mapping[str, Any],
    credential: Any,
    *,
    entities: Optional[Iterable[str]] = None,
    mode: str = "incremental",
    cursors: Optional[Mapping[str, Any]] = None,
    report: Optional[RunReport] = None,
    driver: Optional[Driver] = None,
    allow_private: bool = False,
    today: Optional[dt.date] = None,
    row_limit: Optional[int] = None,
) -> Iterator[ExtractedItem]:
    """Log in and yield every record the recipe extracts.

    ``entities`` limits the run to some entity names (default: all, recipe
    order). ``mode="full"`` ignores ``cursors`` so every ``{{cursor}}`` falls
    back to its step's ``default``; ``"incremental"`` uses ``cursors[entity]``
    when present. Pass a :class:`RunReport` to read counts, failures,
    ``full_entities`` and new cursors afterwards. ``row_limit`` (previews)
    stops each entity after that many records; such an entity is listed in
    ``report.capped`` and is never a full load nor moves its cursor.

    Raises :class:`RecipeError` / :class:`ForbiddenTarget` before touching the
    site when the recipe is invalid, :class:`LoginFailed` when the login is
    refused, and :class:`RecipeRunError` after the last item when any entity
    failed (the others still ran and were yielded).
    """
    validate_recipe(recipe)
    if mode not in MODES:
        raise RecipeError(f"mode must be one of {MODES}")
    all_entities: Mapping[str, Any] = recipe["entities"]
    names = list(all_entities) if entities is None else list(entities)
    unknown = [n for n in names if n not in all_entities]
    if unknown:
        raise RecipeError(f"unknown entities {unknown}; recipe has {list(all_entities)}")
    report = report if report is not None else RunReport()
    cursors = dict(cursors or {})
    with _session(recipe, credential, report=report, driver=driver, allow_private=allow_private,
                  today=today) as run:
        for name in names:
            ent = all_entities[name]
            use_cursor = mode == "incremental" and ent.get("mode", "incremental") != "full"
            cursor = cursors.get(name) if use_cursor else None
            extraction = run.entity(name, ent, cursor)
            capped = False
            try:
                for count, item in enumerate(extraction, 1):
                    if row_limit and count > row_limit:
                        capped = True
                        report.rows[name] -= 1  # counted, not yielded
                        break
                    yield item
            except LoginFailed:
                raise
            except Exception as exc:
                message = _redact(f"{type(exc).__name__}: {exc}", run.password or None)
                report.failed[name] = message
                logger.warning("site recipe %s/%s failed: %s", recipe.get("site"), name, message)
                continue
            finally:
                extraction.close()
            report.completed.append(name)
            report.rows.setdefault(name, 0)
            if capped:
                report.capped.append(name)
                report.cursors.pop(name, None)
                report.warnings.append(f"{name}: stopped after {row_limit} records (row limit)")
            elif cursor is None and ent.get("removal_safe", True) is not False:
                empty = run.empty_extractions()
                if empty:
                    report.warnings.append(
                        f"{name}: not a full load, so no rows are marked removed: {'; '.join(empty)} produced "
                        "no records (set 'allow_empty': true on the step if empty is expected)"
                    )
                else:
                    report.full_entities.append(name)
        if report.failed:
            raise RecipeRunError(report)
