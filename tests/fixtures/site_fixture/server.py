"""A small read-only "WMS" site for the site-to-schema recipe runner tests.

Plain stdlib HTTP server, one process, no JavaScript framework. It mimics the
shapes the runner must handle on real back-office sites:

- ``/login``: HTML form login (``username``, ``password``, hidden CSRF field);
  every other page redirects to it without a session.
- ``/dashboard``: menu items are ``<button onclick=...>``, not links.
- ``/orders``: a POST search form (date range + status) whose results are kept
  in the session and shown 10 per page with a ``Next`` link; an ``Add New``
  button and per-row ``Edit`` links that must never be followed.
- ``/reference``: a "Warehouse Table" button that loads a table with ``fetch``.
- ``/about``: a fixed text page.
- ``/logout``, ``/admin/change_passwd``, ``/orders/new``, ``/orders/edit``,
  ``/orders/delete``: traps. Every hit is recorded in ``state.forbidden_hits``.

Run it by hand with ``python tests/fixtures/site_fixture/server.py --port 8765``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import secrets
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import parse_qs, urlparse

USERNAME = "reader"
PASSWORD = "Fixture-Pa55-xyz!"
PAGE_SIZE = 10
TRAP_PATHS = ("/logout", "/admin/change_passwd", "/orders/new", "/orders/edit", "/orders/delete")


def _default_orders(today: dt.date, count: int = 45) -> List[Dict[str, object]]:
    customers = ["Acme Ltd", "Bolt & Co", "Cedar HK", "Delta Mobile"]
    return [
        {
            "order_no": f"SO-{1001 + i}",
            "created_on": today - dt.timedelta(days=i),
            "customer": customers[i % len(customers)],
            "qty": 10 + i,
            "status": "Open" if i % 3 else "Closed",
        }
        for i in range(count)
    ]


@dataclass
class FixtureState:
    today: dt.date = field(default_factory=dt.date.today)
    orders: List[Dict[str, Any]] = field(default_factory=list)
    warehouses: List[Dict[str, str]] = field(
        default_factory=lambda: [
            {"code": "HK1", "name": "Kwai Chung", "region": "HK"},
            {"code": "HK2", "name": "Tsuen Wan", "region": "HK"},
            {"code": "SZ1", "name": "Futian", "region": "CN"},
        ]
    )
    about_title: str = "About Fixture WMS"
    about_body: str = "Fixture WMS keeps stock records.\nSupport: ops@example.test"
    about_version: str = "3.2"
    sessions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    logins: int = 0
    failed_logins: int = 0
    forbidden_hits: List[str] = field(default_factory=list)
    requests: List[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        if not self.orders:
            self.orders = _default_orders(self.today)

    def expire_sessions(self) -> None:
        with self.lock:
            self.sessions.clear()


_STYLE = "<style>body{font-family:sans-serif} .disabled{color:#999}</style>"


def _page(title: str, body: str, *, logged_in: bool = True) -> str:
    menu = ""
    if logged_in:
        menu = (
            '<nav><a href="/dashboard">Home</a> | '
            '<a href="/admin/change_passwd">Change password</a> | '
            '<a href="/logout">Logout</a></nav>'
        )
    return (
        f"<!doctype html><html><head><title>{html.escape(title)}</title>{_STYLE}</head>"
        f"<body>{menu}<main>{body}</main></body></html>"
    )


def _parse_date(value: str) -> Optional[dt.date]:
    try:
        return dt.date.fromisoformat(value.strip())
    except ValueError:
        return None


class _Handler(BaseHTTPRequestHandler):
    server_version = "FixtureWMS/1.0"
    state: FixtureState

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        return

    # ---- plumbing ---------------------------------------------------------

    def _session(self) -> Optional[Dict[str, object]]:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "sid":
                return self.state.sessions.get(value)
        return None

    def _send(self, status: int, body: str, *, ctype: str = "text/html; charset=utf-8",
              headers: Optional[Dict[str, str]] = None) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, location: str, headers: Optional[Dict[str, str]] = None) -> None:
        self.send_response(303)
        self.send_header("Location", location)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _form(self) -> Dict[str, str]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def _route(self, method: str) -> None:
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        with self.state.lock:
            self.state.requests.append(f"{method} {path}")
        if path in TRAP_PATHS:
            with self.state.lock:
                self.state.forbidden_hits.append(f"{method} {path}")
            if path == "/logout":
                self.state.expire_sessions()
            self._send(200, _page("Trap", f"<p>{html.escape(path)} must never be visited</p>"))
            return
        if path == "/login":
            return self._login(method)
        session = self._session()
        if session is None:
            return self._redirect("/login")
        handler = {
            "/": self._dashboard,
            "/dashboard": self._dashboard,
            "/orders": self._orders,
            "/reference": self._reference,
            "/api/warehouses": self._warehouses_api,
            "/about": self._about,
        }.get(path)
        if handler is None:
            return self._send(404, _page("Not found", "<p>Not found</p>"))
        handler(method, session, parse_qs(url.query))

    def do_GET(self) -> None:  # noqa: N802
        self._route("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._route("POST")

    # ---- pages ------------------------------------------------------------

    def _login(self, method: str) -> None:
        error = ""
        if method == "POST":
            form = self._form()
            if form.get("username") == USERNAME and form.get("password") == PASSWORD and form.get("csrf"):
                sid = secrets.token_hex(8)
                with self.state.lock:
                    self.state.sessions[sid] = {"search": None}
                    self.state.logins += 1
                return self._redirect("/dashboard", {"Set-Cookie": f"sid={sid}; Path=/; HttpOnly"})
            with self.state.lock:
                self.state.failed_logins += 1
            error = '<p class="error">Invalid username or password</p>'
        body = (
            "<h1>Sign in</h1>" + error +
            '<form method="post" action="/login" id="login-form">'
            f'<input type="hidden" name="csrf" value="{secrets.token_hex(4)}">'
            '<label>User <input name="username"></label>'
            '<label>Password <input type="password" name="password"></label>'
            '<button type="submit">Login</button></form>'
        )
        self._send(200, _page("Sign in", body, logged_in=False))

    def _dashboard(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        body = (
            "<h1>Dashboard</h1><p class='welcome'>Welcome, reader</p>"
            "<script>function go(el){location.href=el.dataset.target}</script>"
            '<div class="menu">'
            '<button type="button" data-target="/orders" onclick="go(this)">Orders</button>'
            '<button type="button" data-target="/reference" onclick="go(this)">Reference</button>'
            '<button type="button" data-target="/about" onclick="go(this)">About</button>'
            "</div>"
        )
        self._send(200, _page("Dashboard", body))

    def _orders(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        if method == "POST":
            form = self._form()
            session["search"] = {
                "from": _parse_date(form.get("date_from", "")),
                "to": _parse_date(form.get("date_to", "")),
                "status": form.get("status", ""),
            }
            return self._redirect("/orders?page=1")
        search: Any = session.get("search")
        form = (
            '<form method="post" action="/orders" id="search-form">'
            '<label>From <input name="date_from" id="date_from" placeholder="YYYY-MM-DD"></label>'
            '<label>To <input name="date_to" id="date_to" placeholder="YYYY-MM-DD"></label>'
            '<select name="status" id="status"><option value="">All</option>'
            '<option>Open</option><option>Closed</option></select>'
            '<button type="submit" id="btn-search">Search</button> '
            '<button type="button" id="btn-3" onclick="location.href=\'/orders/new\'">Add New</button>'
            "</form>"
        )
        results = "<p class='hint'>Enter a date range and press Search.</p>"
        if search is not None:
            rows = [
                o for o in self.state.orders
                if (search["from"] is None or o["created_on"] >= search["from"])
                and (search["to"] is None or o["created_on"] <= search["to"])
                and (not search["status"] or o["status"] == search["status"])
            ]
            rows.sort(key=lambda o: (o["created_on"], o["order_no"]), reverse=True)
            try:
                page = max(1, int((query.get("page") or ["1"])[0]))
            except ValueError:
                page = 1
            pages = max(1, -(-len(rows) // PAGE_SIZE))
            chunk = rows[(page - 1) * PAGE_SIZE: page * PAGE_SIZE]
            body_rows = "".join(
                "<tr>"
                f"<td>{html.escape(str(o['order_no']))}</td>"
                f"<td>{o['created_on'].strftime('%d/%m/%Y')}</td>"
                f"<td>{html.escape(str(o['customer']))}</td>"
                f"<td>{int(o['qty']):,}</td>"  # type: ignore[call-overload]
                f"<td>{html.escape(str(o['status']))}</td>"
                f"<td><a href='/orders/edit?id={html.escape(str(o['order_no']))}'>Edit</a></td>"
                "</tr>"
                for o in chunk
            )
            nxt = (
                f'<li><a class="page-link" href="/orders?page={page + 1}">Next</a></li>'
                if page < pages else '<li class="disabled"><span>Next</span></li>'
            )
            results = (
                f"<p class='total'>{len(rows)} records, page {page} of {pages}</p>"
                '<table id="results"><thead><tr><th>Order No</th><th>Created</th>'
                "<th>Customer</th><th>Qty</th><th>Status</th><th>Action</th></tr></thead>"
                f"<tbody>{body_rows}</tbody></table>"
                f'<ul class="pagination">{nxt}</ul>'
            )
        self._send(200, _page("Orders", "<h1>Orders</h1>" + form + results))

    def _reference(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        body = (
            "<h1>Reference</h1>"
            '<button type="button" id="show-wh">Warehouse Table</button>'
            '<div id="ref"></div>'
            "<script>"
            "document.getElementById('show-wh').addEventListener('click', async () => {"
            "  const rows = await (await fetch('/api/warehouses')).json();"
            "  const tr = rows.map(r => `<tr><td>${r.code}</td><td>${r.name}</td><td>${r.region}</td></tr>`).join('');"
            "  document.getElementById('ref').innerHTML = '<table id=\"wh\"><tr><th>Code</th><th>Name</th>'"
            "    + '<th>Region</th></tr>' + tr + '</table>';"
            "});"
            "</script>"
        )
        self._send(200, _page("Reference", body))

    def _warehouses_api(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        self._send(200, json.dumps(self.state.warehouses), ctype="application/json")

    def _about(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        paras = "".join(f"<p>{html.escape(line)}</p>" for line in self.state.about_body.split("\n"))
        body = (
            f"<h1>{html.escape(self.state.about_title)}</h1>"
            f"<div id='about'>{paras}</div>"
            f"<p class='version'>Version {html.escape(self.state.about_version)}</p>"
        )
        self._send(200, _page("About", body))


@dataclass
class FixtureSite:
    base_url: str
    state: FixtureState


@contextmanager
def serve_fixture(state: Optional[FixtureState] = None, *, port: int = 0) -> Iterator[FixtureSite]:
    """Run the fixture site on 127.0.0.1 in a background thread."""
    state = state or FixtureState()
    handler = type("FixtureHandler", (_Handler,), {"state": state})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield FixtureSite(base_url=f"http://127.0.0.1:{server.server_address[1]}", state=state)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with serve_fixture(port=args.port) as site:
        print(f"fixture site on {site.base_url} (login {USERNAME} / see PASSWORD in server.py)")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
