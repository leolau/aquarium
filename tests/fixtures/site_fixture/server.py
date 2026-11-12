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
- ``/devices``: big client-side DataTables tables (only 10 rows in the DOM):
  ``#devices`` loads every row once from ``/api/devices`` (objects, nested
  fields, HTML cells) through the jQuery plugin; ``#parts`` is a DOM-sourced
  table started with the DataTables 2 ``window.DataTable`` global; ``#cases``
  is server-side (``serverSide: true``) on ``POST /api/rma_cases``
  (draw/start/length, ``{draw, recordsTotal, recordsFiltered, data}``).
  ``/static/datatables-shim.js`` implements the subset of the DataTables
  public API the runner uses, so the fixture stays offline.
- ``POST /search/rma_case``: a JSON read endpoint (top-level array) filtered
  by ``date_from`` / ``date_to``; ``/api/rma_stream`` sends it without a
  Content-Length.
- ``/query``: a query-builder page whose results table stays empty until
  the "Search" button posts the date filter as JSON to ``POST /query/search``
  (``{"status", "result": {"rows": [...], "total"}}``); nothing on page load.
- ``/stock``: a search page whose "Search" button (XMLHttpRequest) posts a
  JSON filter list to ``POST /stock/search``; with no filter (``[]``) it
  streams a huge answer without a Content-Length, and "Export all" (fetch)
  gets ``GET /stock/all``, a huge answer with one. Bytes actually sent are in
  ``state.big_sent``.
- ``/setup/functions``: a configuration screen holding a read-only lookup
  table (function definitions) next to Edit buttons.
- ``/staff``: an employee table that sends a ``Password Hash`` column.
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
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import parse_qs, urlparse

USERNAME = "reader"
PASSWORD = "Fixture-Pa55-xyz!"
PAGE_SIZE = 10
TRAP_PATHS = ("/logout", "/admin/change_passwd", "/orders/new", "/orders/edit", "/orders/delete",
              "/api/rma_cases/delete")


def _default_devices(count: int = 2500) -> List[Dict[str, Any]]:
    models = [("iPhone 15", "Apple"), ("Galaxy S24", "Samsung"), ("Pixel 9", "Google")]
    return [
        {
            "id": i + 1,
            "imei": f"35{i:013d}",
            "model": {"name": models[i % 3][0], "brand": models[i % 3][1]},
            "grade": "<span class='badge'>" + "ABC"[i % 3] + "</span>",
            "link": f"<a href='/devices/view?id={i + 1}'>view</a>",
        }
        for i in range(count)
    ]


def _default_cases(today: dt.date, count: int = 230) -> List[Dict[str, Any]]:
    return [
        {"case_no": f"RMA-{5001 + i}", "opened": (today - dt.timedelta(days=i // 5)).isoformat(),
         "customer": {"name": ["Acme Ltd", "Bolt & Co"][i % 2]}, "qty": i % 7 + 1}
        for i in range(count)
    ]


_DATATABLES_SHIM = r"""
(function () {
  const tables = new Map();
  // Scroll header clones: isDataTable() is true for them, but new Api(clone) has no instance (0 rows).
  const clones = new Set();
  const none = {table: null, data: [], aoColumns: []};
  function resolve(sel) { return typeof sel === 'string' ? document.querySelector(sel) : (sel && sel.jquery ? sel[0] : sel); }
  function wrap(list) { const a = list.slice(); a.toArray = () => list.slice(); a.count = () => list.length; return a; }
  function Api(sel) {
    const el = resolve(sel);
    this.s = tables.get(el) || (clones.has(el) ? none : null);
    if (!this.s) throw new Error('not a DataTable');
  }
  Api.prototype.settings = function () { return wrap(this.s === none ? [] : [this.s]); };
  Api.prototype.table = function () { const s = this.s; return {node: () => s.table}; };
  Api.prototype.columns = function () { const n = this.s.aoColumns.length; return {count: () => n}; };
  Api.prototype.column = function (i) {
    const c = this.s.aoColumns[i];
    return {header: () => c.nTh, dataSrc: () => c.mData};
  };
  Api.prototype.rows = function () {
    const data = this.s.data;
    return {count: () => data.length, data: () => wrap(data), indexes: () => wrap(data.map((_, i) => i))};
  };
  Api.prototype.cell = function (r, c) { const s = this.s; return {data: () => { const src = s.aoColumns[c].mData; return s.data[r][src]; }}; };
  Object.defineProperty(Api.prototype, 'ajax', {get() { const s = this.s; return {url: () => s.ajaxUrl, json: () => s.json}; }});
  function draw(s) {
    const tbody = s.table.tBodies[0] || s.table.appendChild(document.createElement('tbody'));
    tbody.innerHTML = s.data.slice(s.start, s.start + 10).map((row) => '<tr>' + s.aoColumns.map((c) => {
      let v = row; for (const p of String(c.mData).split('.')) v = v == null ? null : v[p];
      return '<td>' + (v == null ? '' : v) + '</td>';
    }).join('') + '</tr>').join('');
  }
  function init(el, opts) {
    const ths = Array.from(el.tHead.rows[0].cells);
    const s = {table: el, start: 0, data: [], json: undefined, _bInitComplete: false,
               oFeatures: {bServerSide: !!opts.serverSide},
               ajaxUrl: opts.ajax ? (opts.ajax.url || opts.ajax) : null,
               aoColumns: ths.map((th, i) => ({nTh: th, mData: opts.columns ? opts.columns[i].data : i}))};
    tables.set(el, s);
    el.classList.add('dataTable');
    if (opts.scrollX || opts.scrollY) {
      // Like DataTables: the visible header is a clone (no id) in a scroll-head div, before the body table.
      const wrapper = document.createElement('div');
      wrapper.className = 'dataTables_scroll';
      const head = document.createElement('div');
      head.className = 'dataTables_scrollHead';
      const headTable = el.cloneNode(false);
      headTable.removeAttribute('id');
      headTable.appendChild(el.tHead.cloneNode(true));
      head.appendChild(headTable);
      const body = document.createElement('div');
      body.className = 'dataTables_scrollBody';
      el.parentNode.insertBefore(wrapper, el);
      body.appendChild(el);
      wrapper.append(head, body);
      clones.add(headTable);
    }
    const done = () => { s._bInitComplete = true; draw(s); };
    if (opts.serverSide) {
      const body = new URLSearchParams({draw: '1', start: '0', length: '10'});
      fetch(s.ajaxUrl, {method: 'POST', body}).then((r) => r.json()).then((j) => { s.json = j; s.data = j.data; done(); });
    } else if (opts.ajax) {
      setTimeout(() => fetch(s.ajaxUrl).then((r) => r.json()).then((j) => { s.json = j; s.data = j.data; done(); }), 300);
    } else {
      s.data = Array.from(el.tBodies[0].rows).map((tr) => Array.from(tr.cells).map((td) => td.innerHTML));
      done();
    }
    return new Api(el);
  }
  const DataTable = function (sel, opts) { return init(resolve(sel), opts || {}); };
  DataTable.Api = Api;
  DataTable.isDataTable = (sel) => tables.has(resolve(sel)) || clones.has(resolve(sel));
  window.DataTable = DataTable;
  if (window.__withJquery) {
    const $ = (sel) => ({0: resolve(sel), jquery: '3.7.1', DataTable(opts) { return tables.has(resolve(sel)) ? new Api(sel) : init(resolve(sel), opts || {}); }});
    $.fn = {dataTable: DataTable};
    window.jQuery = window.$ = $;
    delete window.DataTable;
  }
})();
"""


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
    devices: List[Dict[str, Any]] = field(default_factory=_default_devices)
    cases: List[Dict[str, Any]] = field(default_factory=list)
    json_calls: List[Dict[str, Any]] = field(default_factory=list)
    sessions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    logins: int = 0
    failed_logins: int = 0
    forbidden_hits: List[str] = field(default_factory=list)
    requests: List[str] = field(default_factory=list)
    big_sent: Dict[str, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        if not self.orders:
            self.orders = _default_orders(self.today)
        if not self.cases:
            self.cases = _default_cases(self.today)

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
        if path == "/static/datatables-shim.js":
            return self._send(200, _DATATABLES_SHIM, ctype="text/javascript")
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
            "/devices": self._devices,
            "/devices/scroll": self._devices_scroll,
            "/api/devices": self._devices_api,
            "/api/rma_cases": self._rma_cases_api,
            "/search/rma_case": self._rma_search,
            "/api/rma_stream": self._rma_stream,
            "/query": self._query_page,
            "/query/search": self._query_search,
            "/stock": self._stock_page,
            "/stock/search": self._stock_search,
            "/stock/all": self._stock_all,
            "/setup/functions": self._setup_functions,
            "/staff": self._staff,
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

    def _query_page(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        body = (
            "<h1>Case query</h1>"
            '<div id="builder"><input type="hidden" id="qtoken" value="tok-123">'
            '<label>From <input type="date" id="q-from"></label>'
            '<label>To <input type="date" id="q-to"></label>'
            '<button type="button" id="q-search">Search</button>'
            '<button type="button" id="q-slow">Slow search</button></div>'
            '<table id="q-results"><thead><tr><th>Case</th><th>Opened</th><th>Customer</th></tr></thead>'
            "<tbody></tbody></table>"
            "<script>"
            "document.getElementById('q-search').addEventListener('click', async () => {"
            "  const body = {date_from: document.getElementById('q-from').value,"
            "    date_to: document.getElementById('q-to').value, token: document.getElementById('qtoken').value};"
            "  const r = await fetch('/query/search', {method: 'POST',"
            "    headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});"
            "  const j = await r.json();"
            "  document.querySelector('#q-results tbody').innerHTML = j.result.rows.map((c) =>"
            "    `<tr><td>${c.case_no}</td><td>${c.opened}</td><td>${c.customer.name}</td></tr>`).join('');"
            "});"
            "document.getElementById('q-slow').addEventListener('click', () => {"
            "  fetch('/query/search', {method: 'POST', headers: {'Content-Type': 'application/json'},"
            "    body: JSON.stringify({slow: '1'})});"
            "});"
            "</script>"
        )
        self._send(200, _page("Case query", body))

    def _query_search(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        if method != "POST":
            return self._send(405, "{}", ctype="application/json")
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
        values = {k: str(v) for k, v in json.loads(raw or "{}").items()}
        self._note_json_call(method, values)
        if values.get("slow"):
            time.sleep(3)
        rows = self._rma_rows(values)
        self._send(200, json.dumps({"status": "ok", "result": {"rows": rows, "total": len(rows)}}),
                   ctype="application/json")

    def _stock_page(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        body = (
            "<h1>Stock search</h1>"
            '<div class="panel" id="s-builder">'
            '<label>Stock-in from <input type="date" id="s-from"></label>'
            '<label>to <input type="date" id="s-to"></label>'
            '<label>Warehouse <select id="s-wh"><option value="">(any)</option><option>HK1</option>'
            "<option>SZ1</option></select></label>"
            '<button type="button" id="s-search">Search</button>'
            '<button type="button" id="s-all">Export all</button></div>'
            '<p id="s-status"></p>'
            '<table id="s-results"><thead><tr><th>Lot</th><th>Stock-in</th></tr></thead><tbody></tbody></table>'
            "<script>"
            "document.getElementById('s-search').addEventListener('click', () => {"
            "  const f = [], from = document.getElementById('s-from').value, to = document.getElementById('s-to').value;"
            "  if (from || to) f.push({field: 'stock_in', op: 'between', value: [from, to]});"
            "  const wh = document.getElementById('s-wh').value; if (wh) f.push({field: 'wh', op: '=', value: wh});"
            "  const x = new XMLHttpRequest(); x.open('POST', '/stock/search');"
            "  x.setRequestHeader('Content-Type', 'application/json');"
            "  x.onload = () => { const rows = JSON.parse(x.responseText);"
            "    document.querySelector('#s-results tbody').innerHTML = rows.map((r) =>"
            "      `<tr><td>${r.lot}</td><td>${r.stock_in}</td></tr>`).join(''); };"
            "  x.onabort = () => { document.getElementById('s-status').textContent = 'aborted'; };"
            "  x.send(JSON.stringify(f));"
            "});"
            "document.getElementById('s-all').addEventListener('click', () => {"
            "  fetch('/stock/all').then((r) => r.json()).catch(() => {"
            "    document.getElementById('s-status').textContent = 'export failed'; });"
            "});"
            "</script>"
        )
        self._send(200, _page("Stock search", body))

    def _stream_big(self, name: str, total: int, *, declare: bool) -> None:
        """A JSON array of ``total`` bytes or so, sent slowly; stops when the browser hangs up."""
        row = json.dumps({"lot": "L-000000", "stock_in": "2026-01-01", "note": "x" * 200}).encode("utf-8")
        count = max(1, total // (len(row) + 1))
        size = 2 + count * len(row) + (count - 1)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if declare:
            self.send_header("Content-Length", str(size))
        self.send_header("Connection", "close")
        self.end_headers()
        sent = 0
        try:
            written = 0
            while written < count:
                n = min(255, count - written)
                part = (b"," if written else b"[") + b",".join([row] * n)
                written += n
                if written >= count:
                    part += b"]"
                self.wfile.write(part)
                self.wfile.flush()
                sent += len(part)
                with self.state.lock:
                    self.state.big_sent[name] = sent
                time.sleep(0.02)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def _stock_search(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        if method != "POST":
            return self._send(405, "[]", ctype="application/json")
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
        filters = json.loads(raw or "[]")
        self._note_json_call(method, {"filters": json.dumps(filters)})
        if not filters:
            return self._stream_big("search", 40_000_000, declare=False)
        lo = hi = None
        for f in filters:
            if f.get("field") == "stock_in":
                lo, hi = _parse_date(f["value"][0] or ""), _parse_date(f["value"][1] or "")
        rows = [{"lot": f"L-{i:06d}", "stock_in": (self.state.today - dt.timedelta(days=i % 30)).isoformat()}
                for i in range(300)]
        rows = [r for r in rows if (lo is None or r["stock_in"] >= lo.isoformat())
                and (hi is None or r["stock_in"] <= hi.isoformat())]
        self._send(200, json.dumps(rows), ctype="application/json")

    def _stock_all(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        self._note_json_call(method, {})
        self._stream_big("all", 40_000_000, declare=True)

    def _setup_functions(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        rows = "".join(
            f"<tr><td>{code}</td><td>{name}</td><td>{step}</td>"
            f"<td><button type=\"button\" onclick=\"location.href='/setup/functions/edit?id={code}'\">Edit</button>"
            "</td></tr>"
            for code, name, step in (("F01", "Stock In", "receive"), ("F02", "Triage", "inspect"),
                                     ("F03", "Packing", "ship"), ("F04", "QA1", "inspect")))
        body = (
            "<h1>Set Function</h1><p>Configure the functions of each workflow step.</p>"
            '<table id="functions"><thead><tr><th>Code</th><th>Function</th><th>Workflow step</th>'
            f"<th></th></tr></thead><tbody>{rows}</tbody></table>"
        )
        self._send(200, _page("Set Function", body))

    def _staff(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        rows = "".join(
            f"<tr><td>{user}</td><td>{name}</td><td>$2y$10${secrets.token_urlsafe(40)[:53]}</td><td>{role}</td></tr>"
            for user, name, role in (("amy", "Amy Chan", "ops"), ("ben", "Ben Lee", "qa")))
        body = (
            "<h1>Employee Setting</h1>"
            '<table id="staff"><thead><tr><th>Username</th><th>Name</th><th>Password Hash</th><th>Role</th></tr>'
            f"</thead><tbody>{rows}</tbody></table>"
        )
        self._send(200, _page("Employee Setting", body))

    def _warehouses_api(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        self._send(200, json.dumps(self.state.warehouses), ctype="application/json")

    def _devices(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        parts = "".join(
            f"<tr><td>P-{i:04d}</td><td><b>Part</b> {i}</td><td>{i * 3}</td></tr>" for i in range(1, 1201)
        )
        jquery = (query.get("jquery") or ["1"])[0] != "0"
        body = (
            "<h1>Devices</h1>"
            f"<script>window.__withJquery = {'true' if jquery else 'false'};</script>"
            '<script src="/static/datatables-shim.js"></script>'
            '<table id="devices"><thead><tr><th>IMEI</th><th>Model</th><th>Brand</th><th>Grade</th>'
            "<th>Action</th></tr></thead><tbody></tbody></table>"
            '<table id="parts"><thead><tr><th>Part No</th><th>Name</th><th>Stock</th></tr></thead>'
            f"<tbody>{parts}</tbody></table>"
            '<table id="cases"><thead><tr><th>Case</th><th>Opened</th></tr></thead><tbody></tbody></table>'
            '<table id="plain"><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'
            "<script>"
            "const DT = window.jQuery ? (s, o) => window.jQuery(s).DataTable(o) : (s, o) => new DataTable(s, o);"
            "DT('#devices', {ajax: '/api/devices', columns: [{data: 'imei'}, {data: 'model.name'},"
            " {data: 'model.brand'}, {data: 'grade'}, {data: 'link'}]});"
            "DT('#parts', {});"
            "DT('#cases', {serverSide: true, ajax: {url: '/api/rma_cases', type: 'POST'},"
            " columns: [{data: 'case_no'}, {data: 'opened'}]});"
            "</script>"
        )
        self._send(200, _page("Devices", body))

    def _devices_scroll(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        tables = int((query.get("tables") or ["1"])[0])
        body = '<h1>Devices (scrolling)</h1><script src="/static/datatables-shim.js"></script>'
        for n in range(1, tables + 1):
            body += (f'<table id="scrolled{n}"><thead><tr><th>IMEI</th><th>Model</th></tr></thead>'
                     "<tbody></tbody></table>")
        body += "<script>" + "".join(
            f"new DataTable('#scrolled{n}', {{ajax: '/api/devices', scrollX: true,"
            " columns: [{data: 'imei'}, {data: 'model.name'}]});"
            for n in range(1, tables + 1)
        ) + "</script>"
        self._send(200, _page("Devices", body))

    def _devices_api(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        self._send(200, json.dumps({"data": self.state.devices}), ctype="application/json")

    def _note_json_call(self, method: str, values: Dict[str, str]) -> None:
        with self.state.lock:
            self.state.json_calls.append({"path": urlparse(self.path).path, "method": method,
                                          "values": values, "xhr": self.headers.get("X-Requested-With")})

    def _rma_cases_api(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        form = self._form() if method == "POST" else {k: v[0] for k, v in query.items()}
        self._note_json_call(method, form)
        start, length = int(form.get("start") or 0), int(form.get("length") or 10)
        cases = self.state.cases
        page = cases[start: start + length] if length > 0 else cases
        self._send(200, json.dumps({"draw": int(form.get("draw") or 0), "recordsTotal": len(cases),
                                    "recordsFiltered": len(cases), "data": page}), ctype="application/json")

    def _rma_rows(self, values: Dict[str, str]) -> List[Dict[str, Any]]:
        lo, hi = _parse_date(values.get("date_from", "")), _parse_date(values.get("date_to", ""))
        return [c for c in self.state.cases
                if (lo is None or c["opened"] >= lo.isoformat()) and (hi is None or c["opened"] <= hi.isoformat())]

    def _rma_search(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        if method != "POST":
            return self._send(405, "[]", ctype="application/json")
        ctype = self.headers.get("Content-Type") or ""
        if ctype.startswith("application/json"):
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
            values = {k: str(v) for k, v in json.loads(raw or "{}").items()}
        else:
            values = self._form()
        self._note_json_call(method, values)
        self._send(200, json.dumps(self._rma_rows(values)), ctype="application/json")

    def _rma_stream(self, method: str, session: Dict[str, Any], query: Dict[str, List[str]]) -> None:
        self._note_json_call(method, {})
        data = json.dumps(self.state.cases).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for i in range(0, len(data), 4096):
                self.wfile.write(data[i: i + 4096])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

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
