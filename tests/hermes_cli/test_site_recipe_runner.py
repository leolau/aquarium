"""Site-to-schema recipe runner: validation, read-only guard, templating, and
end-to-end runs against the local fixture site (Playwright, skipped when it or
a Chromium build is not installed)."""

from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
import time
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import pytest

from hermes_cli import site_recipe_runner as srr
from hermes_cli.site_recipe_runner import (
    ExtractedItem,
    ForbiddenTarget,
    LoginFailed,
    RecipeError,
    RecipeRunError,
    RunReport,
    run_recipe,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "site_fixture" / "server.py"
TODAY = dt.date(2026, 11, 11)


def _load_fixture():
    spec = importlib.util.spec_from_file_location("site_fixture_server", FIXTURE)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["site_fixture_server"] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


fx = _load_fixture()

ORDER_COLUMNS = {
    "order_no": {"header": "Order No"},
    "created_on": {"header": "Created", "type": "date", "format": "%d/%m/%Y"},
    "customer": {"header": "Customer"},
    "qty": {"header": "Qty", "type": "int"},
    "status": {"header": "Status"},
}


def fixture_recipe(base_url: str = "http://127.0.0.1:1") -> Dict[str, Any]:
    return {
        "version": 1,
        "site": "fixture",
        "base_url": base_url,
        "timeout_ms": 10_000,
        "login": {
            "url": "/login",
            "username_field": "input[name=username]",
            "password_field": "input[name=password]",
            "submit": "button[type=submit]",
            "success": {"text": "Welcome"},
            "failure_text": "Invalid username",
        },
        "entities": {
            "orders": {
                "kind": "variable",
                "key": ["order_no"],
                "cursor": "created_on",
                "steps": [
                    {"op": "goto", "url": "/dashboard"},
                    {"op": "click", "text": "Orders"},
                    {"op": "fill", "selector": "#date_from", "value": "{{cursor}}", "default": "{{date-3650}}"},
                    {"op": "fill", "selector": "#date_to", "value": "{{today}}"},
                    {"op": "submit", "selector": "#btn-search"},
                    {"op": "paginate", "next": {"text": "Next"},
                     "steps": [{"op": "extract_table", "table": "#results", "columns": ORDER_COLUMNS}]},
                ],
            },
            "warehouses": {
                "kind": "variable",
                "key": ["code"],
                "mode": "full",
                "steps": [
                    {"op": "goto", "url": "/reference"},
                    {"op": "click", "text": "Warehouse Table"},
                    {"op": "wait", "selector": "#wh"},
                    {"op": "extract_table", "table": "#wh", "row": "tr", "columns": {
                        "code": {"header": "Code"}, "name": {"header": "Name"}, "region": {"header": "Region"}}},
                ],
            },
            "about": {
                "kind": "fixed",
                "steps": [
                    {"op": "goto", "url": "/about"},
                    {"op": "extract_fields", "key": "about", "fields": {
                        "title": {"selector": "h1"}, "body": {"selector": "#about"},
                        "version": {"selector": ".version"}}},
                ],
            },
        },
    }


CRED = {"username": fx.USERNAME, "password": fx.PASSWORD}


# --------------------------------------------------------------------------
# validation + read-only guard
# --------------------------------------------------------------------------


def test_the_fixture_recipe_is_valid():
    assert srr.recipe_problems(fixture_recipe()) == []


@pytest.mark.parametrize("label", [
    "Add New", "Save", "Edit", "Delete", "Logout", "Log out", "Sign Out", "Change password",
    "#btnSave", "#btnAddNew", "a[href='/login/logout/']", "button.btn-delete", "/admin/change_passwd",
])
def test_data_changing_labels_are_forbidden(label):
    assert srr.is_forbidden_text(label) or srr.is_forbidden_url(label)


@pytest.mark.parametrize("label", [
    "Search", "Next", "Orders", "Throughput Report", "Device Enquiry", "Address", "News",
    "Warehouse Table", "Set WorkFlow", "#btn-search", "Cancelled", "Dropdown",
])
def test_read_only_labels_are_allowed(label):
    assert not srr.is_forbidden_text(label)


@pytest.mark.parametrize("step", [
    {"op": "click", "text": "Add New"},
    {"op": "click", "selector": "#btnSave"},
    {"op": "submit", "selector": "button.update"},
    {"op": "goto", "url": "/login/logout/"},
    {"op": "goto", "url": "/admin/change_passwd"},
    {"op": "goto", "url": "/rma/add"},
])
def test_validate_rejects_forbidden_steps(step):
    recipe = fixture_recipe()
    recipe["entities"]["orders"]["steps"].insert(1, step)
    with pytest.raises(ForbiddenTarget):
        srr.validate_recipe(recipe)


def test_forbidden_paginate_next_is_rejected():
    recipe = fixture_recipe()
    recipe["entities"]["orders"]["steps"][-1]["next"] = {"text": "Delete"}
    with pytest.raises(ForbiddenTarget):
        srr.validate_recipe(recipe)


@pytest.mark.parametrize("mutate, needle", [
    (lambda r: r.pop("base_url"), "base_url"),
    (lambda r: r["entities"]["orders"].pop("key"), "needs a 'key'"),
    (lambda r: r["entities"]["orders"]["steps"][2].pop("default"), "without a 'default'"),
    (lambda r: r["entities"]["about"]["steps"].pop(), "no extract_table"),
    (lambda r: r["entities"]["orders"]["steps"].append({"op": "hover"}), "unknown op"),
    (lambda r: r["entities"]["orders"]["steps"].append({"op": "press", "selector": "#q", "key": "Delete"}), "key must be"),
    (lambda r: r["entities"].update({"Bad-Name": r["entities"]["about"]}), "lower_snake_case"),
    (lambda r: r["entities"]["orders"]["steps"][2].update(value="{{window_from}}"), "only works inside date_windows"),
])
def test_validate_reports_each_problem(mutate, needle):
    recipe = fixture_recipe()
    mutate(recipe)
    problems = srr.recipe_problems(recipe)
    assert any(needle in p for p in problems), problems


def test_network_guard_blocks_forbidden_urls_and_off_site_navigation():
    guard = srr._network_guard("https://wms.example.test/", allow_private=True)
    assert guard("https://wms.example.test/orders", "document", "GET") is None
    assert guard("https://wms.example.test/login/logout/", "document", "GET")
    assert guard("https://wms.example.test/api/orders/delete?id=1", "xhr", "POST")
    assert guard("https://evil.example.test/", "document", "GET")
    assert guard("https://cdn.example.test/app.js", "script", "GET") is None


# --------------------------------------------------------------------------
# templates + values
# --------------------------------------------------------------------------


def test_templates_render_dates_offsets_and_cursor():
    r = srr.render_template
    assert r("{{today}}", {}, today=TODAY) == "2026-11-11"
    assert r("{{date-7}}", {}, today=TODAY) == "2026-11-04"
    assert r("{{ today + 1 }}", {}, today=TODAY) == "2026-11-12"
    assert r("{{cursor}}", {"cursor": "2026-10-01"}, date_format="%d/%m/%Y") == "01/10/2026"
    assert r("{{cursor-1}}", {"cursor": "2026-10-01T09:30:00"}) == "2026-09-30"
    assert r("{{cursor}}", {"cursor": 4711}) == "4711"
    with pytest.raises(RecipeError):
        r("{{cursor+1}}", {"cursor": "RMA-9"})
    with pytest.raises(RecipeError):
        r("{{cursor}}", {})


@pytest.mark.parametrize("raw, spec, expected", [
    (" Acme \u00a0Ltd ", {}, "Acme Ltd"),
    ("", {}, None),
    ("1,234", {"type": "int"}, 1234),
    ("(12.50)", {"type": "numeric"}, -12.5),
    ("HK$1,000.25", {"type": "numeric"}, 1000.25),
    ("11/10/2026", {"type": "date", "format": "%d/%m/%Y"}, "2026-10-11"),
    ("2026-10-11", {"type": "date"}, "2026-10-11"),
    ("2026-10-11 08:05", {"type": "datetime"}, "2026-10-11T08:05:00"),
    ("Yes", {"type": "bool"}, True),
    ("-", {"type": "int"}, None),
])
def test_convert_value(raw, spec, expected):
    assert srr.convert_value(raw, spec) == expected


def test_convert_value_rejects_garbage():
    with pytest.raises(ValueError):
        srr.convert_value("abc", {"type": "int"})


def test_build_key_single_and_composite():
    assert srr.build_key({"a": "X1"}, ["a"]) == "X1"
    assert srr.build_key({"a": "X|1", "b": 2}, ["a", "b"]) == "X\\|1|2"
    assert srr.build_key({"a": ""}, ["a"]) is None


# --------------------------------------------------------------------------
# runner logic with a fake browser
# --------------------------------------------------------------------------


class FakeDriver(srr.Driver):
    """A scripted browser: pages are dicts with elements, a table and fields."""

    def __init__(self, pages: Mapping[str, Dict[str, Any]], *, login_ok: bool = True):
        self.pages = pages
        self.url = ""
        self.typed: List[str] = []
        self.clicked: List[str] = []
        self.login_ok = login_ok

    def goto(self, url: str) -> None:
        self.url = "/" + url.split("://", 1)[-1].split("/", 1)[-1]

    def current_url(self) -> str:
        return "https://wms.example.test" + self.url

    def _el(self, target):
        return self.pages.get(self.url, {}).get("elements", {}).get(target.get("selector") or target.get("text"))

    def click(self, target):
        el = self._el(target)
        self.clicked.append(target.get("selector") or target.get("text"))
        if el and el.get("goes"):
            self.url = el["goes"]

    def describe(self, target):
        return dict(self._el(target) or {}, goes=None)

    def exists(self, target, *, enabled=False):
        el = self._el(target)
        return bool(el) and not (enabled and el.get("disabled"))

    def fill(self, selector, value, *, secret=False):
        self.typed.append(value)

    def select(self, selector, value, label):
        pass

    def press(self, selector, key, *, timeout_ms=None):
        pass

    def submit(self, selector, *, timeout_ms=None):
        pass

    def wait(self, step):
        pass

    def text_present(self, text):
        return text == "Welcome" and self.login_ok

    def table_headers(self, spec):
        page = self.pages.get(self.url, {})
        return page.get("headers")

    def table_rows(self, spec):
        page = self.pages.get(self.url, {})
        idx = {name: col["index"] for name, col in spec["columns"].items()}
        return [{name: row[i] for name, i in idx.items()} for row in page.get("rows", [])]

    def fields(self, spec):
        return {k: self.pages.get(self.url, {}).get("fields", {}).get(k) for k in spec}

    def close(self):
        pass


def _fake_site(rows_page2=None):
    headers = ["Order No", "Created", "Customer", "Qty", "Status"]
    return {
        "/login": {"elements": {"button[type=submit]": {"text": "Login", "goes": "/dashboard"}}},
        "/dashboard": {"elements": {"Orders": {"text": "Orders", "goes": "/orders"}}},
        "/orders": {
            "elements": {
                "#btn-search": {"tag": "BUTTON", "text": "Search"},
                "#btn-3": {"tag": "BUTTON", "text": "Add New", "onclick": "location.href='/orders/new'"},
                "Next": {"text": "Next", "goes": "/orders/2"},
            },
            "headers": headers,
            "rows": [["SO-1", "10/11/2026", "Acme", "1", "Open"], ["SO-2", "09/11/2026", "Bolt", "x", "Open"]],
        },
        "/orders/2": {
            "elements": {"Next": {"text": "Next", "disabled": True}},
            "headers": headers,
            "rows": rows_page2 if rows_page2 is not None else [["SO-3", "01/11/2026", "Cedar", "3", "Closed"]],
        },
        "/about": {"fields": {"title": "About", "body": "Hello", "version": "1"}},
    }


def _fake_recipe():
    recipe = fixture_recipe("https://wms.example.test")
    recipe["entities"].pop("warehouses")
    return recipe


def test_fake_run_yields_typed_rows_and_reports_counts():
    report = RunReport()
    driver = FakeDriver(_fake_site())
    items = list(run_recipe(_fake_recipe(), CRED, driver=driver, report=report, today=TODAY, allow_private=True))
    orders = [i for i in items if i.entity == "orders"]
    assert [i.key for i in orders] == ["SO-1", "SO-2", "SO-3"]
    assert orders[0] == ExtractedItem("orders", "variable", "SO-1", {
        "order_no": "SO-1", "created_on": "2026-11-10", "customer": "Acme", "qty": 1, "status": "Open"})
    assert orders[1].payload["qty"] is None and any("qty" in w for w in report.warnings)
    assert items[-1] == ExtractedItem("about", "fixed", "about", {"title": "About", "body": "Hello", "version": "1"})
    assert report.rows == {"orders": 3, "about": 1}
    assert report.completed == ["orders", "about"]
    assert report.full_entities == ["orders", "about"]
    assert report.cursors == {"orders": "2026-11-10"}
    assert driver.typed[0] == fx.USERNAME
    assert driver.typed[2] == "2016-11-13"  # {{date-3650}}: no cursor on a first run


def test_incremental_uses_the_cursor_and_is_not_a_full_refresh():
    report = RunReport()
    driver = FakeDriver(_fake_site())
    list(run_recipe(_fake_recipe(), CRED, driver=driver, report=report, today=TODAY, allow_private=True,
                    cursors={"orders": "2026-11-01"}))
    assert "2026-11-01" in driver.typed
    assert report.full_entities == ["about"]
    full = RunReport()
    list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(_fake_site()), report=full, today=TODAY, allow_private=True,
                    mode="full", cursors={"orders": "2026-11-01"}))
    assert full.full_entities == ["orders", "about"]


def test_removal_safe_false_keeps_an_entity_out_of_full_entities():
    recipe = _fake_recipe()
    recipe["entities"]["orders"]["removal_safe"] = False
    report = RunReport()
    list(run_recipe(recipe, CRED, driver=FakeDriver(_fake_site()), report=report, today=TODAY, allow_private=True))
    assert report.full_entities == ["about"]


def test_an_innocent_selector_on_an_add_new_button_is_refused_at_run_time():
    recipe = _fake_recipe()
    recipe["entities"]["orders"]["steps"].insert(4, {"op": "click", "selector": "#btn-3"})
    report = RunReport()
    driver = FakeDriver(_fake_site())
    with pytest.raises(RecipeRunError) as err:
        list(run_recipe(recipe, CRED, driver=driver, report=report, today=TODAY, allow_private=True))
    assert "#btn-3" not in driver.clicked
    assert "ForbiddenTarget" in report.failed["orders"] and "Add New" in report.failed["orders"]
    assert report.completed == ["about"]  # the other entity still ran
    assert err.value.report is report


def test_a_changed_page_layout_fails_the_entity_instead_of_writing_nulls():
    site = _fake_site()
    site["/orders"]["headers"] = ["Order", "Created", "Customer", "Qty", "Status"]
    report = RunReport()
    with pytest.raises(RecipeRunError):
        list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(site), report=report, today=TODAY, allow_private=True))
    assert "Order No" in report.failed["orders"]
    assert "orders" not in report.full_entities


def test_a_repeated_page_stops_pagination():
    site = _fake_site()
    site["/orders/2"]["rows"] = site["/orders"]["rows"]
    site["/orders/2"]["elements"]["Next"] = {"text": "Next", "goes": "/orders/2"}
    report = RunReport()
    items = list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(site), report=report, today=TODAY, allow_private=True))
    assert len([i for i in items if i.entity == "orders"]) == 4
    assert any("repeated" in w for w in report.warnings)


def test_failed_login_raises_without_the_password():
    with pytest.raises(LoginFailed) as err:
        list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(_fake_site(), login_ok=False), today=TODAY, allow_private=True))
    assert fx.PASSWORD not in str(err.value)


def test_errors_never_carry_the_password():
    class Leaky(FakeDriver):
        def table_rows(self, spec):
            raise RuntimeError(f"boom while typing {fx.PASSWORD}")

    report = RunReport()
    with pytest.raises(RecipeRunError) as err:
        list(run_recipe(_fake_recipe(), CRED, driver=Leaky(_fake_site()), report=report, today=TODAY, allow_private=True))
    assert fx.PASSWORD not in str(err.value)
    assert srr.REDACTED in report.failed["orders"]


def test_unknown_entities_and_private_base_url_are_refused():
    with pytest.raises(RecipeError):
        list(run_recipe(_fake_recipe(), CRED, entities=["nope"], driver=FakeDriver({})))
    with pytest.raises(RecipeError, match="private"):
        list(run_recipe(fixture_recipe("http://127.0.0.1:9"), CRED, driver=FakeDriver({})))


def test_credential_store_objects_are_accepted():
    from hermes_cli.credential_store import Credential

    fields = Credential.__dataclass_fields__ if hasattr(Credential, "__dataclass_fields__") else {}
    if "payload" not in fields or "kind" not in fields:
        pytest.skip("Credential shape changed")

    class C:
        kind = "password"
        payload = {"username": "u", "password": "p"}

    assert srr._credential_parts(C()) == ("u", "p")
    assert srr._credential_parts(("u", "p")) == ("u", "p")

    class Wrong:
        kind = "mssql"
        payload = {}

    with pytest.raises(RecipeError):
        srr._credential_parts(Wrong())


# --------------------------------------------------------------------------
# end to end against the fixture site
# --------------------------------------------------------------------------


def _browser_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return False
    try:
        driver = srr.PlaywrightDriver(timeout_ms=5000)
    except Exception:
        return False
    driver.close()
    return True


needs_browser = pytest.mark.skipif(not _browser_available(), reason="playwright + Chromium not installed")


def _block_playwright(monkeypatch):
    import tools.lazy_deps

    for name in [m for m in sys.modules if m == "playwright" or m.startswith("playwright.")]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.setitem(sys.modules, "playwright", None)

    def no_install(*_a, **_k):
        raise tools.lazy_deps.FeatureUnavailable("sites.playwright", ("playwright",), "lazy installs are disabled")

    monkeypatch.setattr(tools.lazy_deps, "ensure", no_install)


def test_missing_playwright_package_is_browser_not_installed(monkeypatch):
    _block_playwright(monkeypatch)
    recipe = {"version": 1, "site": "s", "base_url": "http://127.0.0.1:9", "entities": {
        "about": {"kind": "fixed", "steps": [{"op": "extract_fields", "fields": {"t": {"selector": "h1"}}}]}}}
    with pytest.raises(srr.BrowserNotInstalled) as err:
        list(srr.run_recipe(recipe, {"username": "u", "password": "hunter2"}, mode="full", allow_private=True))
    message = str(err.value)
    assert message.startswith("browser engine not installed (the playwright Python package is missing)")
    assert err.value.__cause__ is None and "hunter2" not in message


@pytest.mark.skipif(importlib.util.find_spec("playwright") is None, reason="playwright not installed")
def test_missing_chromium_is_browser_not_installed(monkeypatch, tmp_path):
    """Real playwright, empty browser cache, no system Chrome: one readable line, not Playwright's banner."""
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    monkeypatch.setattr(srr, "_chromium_candidates", lambda: [])
    with pytest.raises(srr.BrowserNotInstalled) as err:
        srr.PlaywrightDriver(timeout_ms=5000)
    message = str(err.value)
    assert message.startswith("browser engine not installed (Chromium does not start: ")
    assert "\n" not in message and len(message) < 400


@pytest.fixture
def site():
    with fx.serve_fixture() as running:
        yield running


def _run(site, recipe=None, **kwargs):
    report = kwargs.pop("report", None) or RunReport()
    items = list(run_recipe(recipe or fixture_recipe(site.base_url), CRED, report=report,
                            allow_private=True, **kwargs))
    return items, report


@needs_browser
def test_e2e_full_run_extracts_every_entity_read_only(site):
    items, report = _run(site)
    orders = [i for i in items if i.entity == "orders"]
    assert len(orders) == len(site.state.orders) == 45
    assert len({i.key for i in orders}) == 45
    first = next(i for i in orders if i.key == "SO-1001")
    assert first.payload == {"order_no": "SO-1001", "created_on": site.state.today.isoformat(),
                             "customer": "Acme Ltd", "qty": 10, "status": "Closed"}
    assert {i.key for i in items if i.entity == "warehouses"} == {"HK1", "HK2", "SZ1"}
    about = [i for i in items if i.entity == "about"]
    assert about == [ExtractedItem("about", "fixed", "about", {
        "title": "About Fixture WMS", "body": "Fixture WMS keeps stock records.\nSupport: ops@example.test",
        "version": "Version 3.2"})]
    assert report.full_entities == ["orders", "warehouses", "about"]
    assert report.cursors["orders"] == site.state.today.isoformat()
    assert site.state.forbidden_hits == []
    assert site.state.logins == 1
    assert not any(fx.PASSWORD in r for r in site.state.requests)


@needs_browser
def test_e2e_incremental_run_only_reads_rows_since_the_cursor(site):
    cursor = (site.state.today - dt.timedelta(days=4)).isoformat()
    items, report = _run(site, entities=["orders"], cursors={"orders": cursor})
    assert sorted(i.key for i in items) == [f"SO-{1001 + i}" for i in range(5)]
    assert report.full_entities == []


@needs_browser
def test_e2e_page_param_and_date_windows(site):
    recipe = fixture_recipe(site.base_url)
    recipe["entities"] = {"orders": {
        "kind": "variable", "key": ["order_no"], "cursor": "created_on",
        "steps": [{"op": "date_windows", "from": "{{cursor}}", "default": "{{date-29}}", "days": 7, "steps": [
            {"op": "goto", "url": "/orders"},
            {"op": "fill", "selector": "#date_from", "value": "{{window_from}}"},
            {"op": "fill", "selector": "#date_to", "value": "{{window_to}}"},
            {"op": "submit", "selector": "#search-form"},
            {"op": "paginate", "page_param": "page", "steps": [
                {"op": "extract_table", "table": "#results", "columns": ORDER_COLUMNS}]},
        ]}],
    }}
    items, report = _run(site, recipe)
    assert sorted(i.key for i in items) == sorted(f"SO-{1001 + i}" for i in range(30))
    assert report.failed == {}


@needs_browser
def test_e2e_add_new_button_is_never_clicked(site):
    recipe = fixture_recipe(site.base_url)
    recipe["entities"]["orders"]["steps"].insert(2, {"op": "click", "selector": "#btn-3"})
    report = RunReport()
    with pytest.raises(RecipeRunError):
        _run(site, recipe, report=report)
    assert "ForbiddenTarget" in report.failed["orders"]
    assert report.completed == ["warehouses", "about"]
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_wrong_password_fails_login(site):
    with pytest.raises(LoginFailed) as err:
        list(run_recipe(fixture_recipe(site.base_url), {"username": fx.USERNAME, "password": "wrong-pass-123"},
                        allow_private=True))
    assert "wrong-pass-123" not in str(err.value)
    assert site.state.failed_logins == 1 and site.state.logins == 0


@needs_browser
def test_e2e_expired_session_logs_in_again(site):
    report = RunReport()
    gen = run_recipe(fixture_recipe(site.base_url), CRED, report=report, allow_private=True)
    seen: List[ExtractedItem] = []
    for item in gen:
        seen.append(item)
        if item.entity == "orders" and len(seen) == 45:
            site.state.expire_sessions()
    assert {i.entity for i in seen} == {"orders", "warehouses", "about"}
    assert site.state.logins == 2
    assert any("logged in again" in w for w in report.warnings)
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_network_guard_aborts_a_scripted_logout(site):
    recipe = copy.deepcopy(fixture_recipe(site.base_url))
    # A harmless-looking menu click whose page script then navigates to /logout.
    recipe["entities"] = {"about": {"kind": "fixed", "steps": [
        {"op": "goto", "url": "/about"},
        {"op": "extract_fields", "key": "about", "fields": {"title": {"selector": "h1"}}},
    ]}}
    report = RunReport()
    driver = srr.PlaywrightDriver(timeout_ms=10_000, guard=srr._network_guard(site.base_url, True),
                                  on_blocked=report.blocked_requests.append)
    try:
        items = list(run_recipe(recipe, CRED, report=report, driver=driver, allow_private=True))
        driver._page.evaluate("location.href = '/logout'")
        driver._settle()
    finally:
        driver.close()
    assert items and site.state.forbidden_hits == []
    assert any("/logout" in b for b in report.blocked_requests)


def test_browse_rejects_forbidden_probe_steps_before_logging_in():
    with pytest.raises(ForbiddenTarget):
        list(srr.browse(fixture_recipe(), [{"name": "x", "steps": [{"op": "click", "text": "Add New"}]}], CRED,
                        driver=FakeDriver({}), allow_private=True))


def test_annotate_inventory_flags_controls_that_change_data():
    inv = srr.annotate_inventory({
        "links": [{"text": "Logout", "href": "/login/logout/"}, {"text": "Orders", "href": "/orders"}],
        "buttons": [{"text": "", "id": "btnAddNew"}, {"text": "Search", "id": "btn-search"},
                    {"text": "Go", "onclick": "location.href='/rma/delete'"}],
        "forms": [{"action": "/orders"}, {"action": "/admin/change_passwd"}],
    })
    assert [x["forbidden"] for x in inv["links"]] == [True, False]
    assert [x["forbidden"] for x in inv["buttons"]] == [True, False, True]
    assert [x["forbidden"] for x in inv["forms"]] == [False, True]


@needs_browser
def test_e2e_browse_inventories_buttons_forms_and_tables(site):
    probes = [
        {"name": "dashboard", "steps": [{"op": "goto", "url": "/dashboard"}]},
        {"name": "orders", "steps": [{"op": "goto", "url": "/dashboard"}, {"op": "click", "text": "Orders"},
                                     {"op": "submit", "selector": "#btn-search", "allow_empty_filters": True}]},
        {"name": "broken", "steps": [{"op": "click", "selector": "#does-not-exist"}]},
    ]
    recipe = fixture_recipe(site.base_url)
    recipe["timeout_ms"] = 2000
    got = dict(srr.browse(recipe, probes, CRED, allow_private=True))
    dash = got["dashboard"]
    assert any(b["text"] == "Orders" and not b["forbidden"] for b in dash["buttons"])
    assert any(link["text"] == "Logout" and link["forbidden"] for link in dash["links"])
    orders = got["orders"]
    assert any(b["text"] == "Add New" and b["forbidden"] for b in orders["buttons"])
    table = next(t for t in orders["tables"] if t["selector"] == "#results")
    assert table["headers"][:2] == ["Order No", "Created"] and table["rows"] == 10
    assert any(p["text"] == "Next" for p in orders["pagination"])
    form = next(f for f in orders["forms"] if any(x["name"] == "date_from" for x in f["fields"]))
    assert {x["name"] for x in form["fields"]} >= {"date_from", "date_to"}
    assert "error" in got["broken"]
    assert site.state.forbidden_hits == []


# --------------------------------------------------------------------------
# extract_datatable / extract_json
# --------------------------------------------------------------------------

CASE_COLUMNS = {"case_no": {"field": "case_no"}, "opened": {"field": "opened", "type": "date"},
                "customer": {"field": "customer.name"}, "qty": {"field": "qty", "type": "int"}}


def _one_entity(site, steps, key, **ent):
    recipe = fixture_recipe(site.base_url)
    recipe["entities"] = {"data": {"kind": "variable", "key": key, "steps": steps, **ent}}
    return recipe


@pytest.mark.parametrize("step, needle", [
    ({"op": "extract_datatable", "columns": {"a": {"field": "a"}}}, "needs 'table'"),
    ({"op": "extract_datatable", "table": "#t", "columns": {"a": {"field": "a", "index": 1}}}, "exactly one"),
    ({"op": "extract_json", "url": "/orders/delete", "columns": {"a": {"field": "a"}}}, "data-changing"),
    ({"op": "extract_json", "url": "/x", "method": "POST", "form": {"action": "delete"},
      "columns": {"a": {"field": "a"}}}, "data-changing"),
    ({"op": "extract_json", "url": "/x", "method": "PUT", "columns": {"a": {"field": "a"}}}, "GET or POST"),
    ({"op": "extract_json", "url": "/x", "form": {"a": "1"}, "columns": {"a": {"field": "a"}}}, "GET has no body"),
    ({"op": "extract_json", "url": "/x", "params": {"f": "{{window_from}}"}, "columns": {"a": {"field": "a"}}},
     "only works inside date_windows"),
    ({"op": "extract_json", "url": "/x", "params": {"f": "{{cursor}}"}, "columns": {"a": {"field": "a"}}},
     "without a 'default'"),
    ({"op": "extract_json", "url": "/x", "headers": {"Cookie": "sid=1"}, "columns": {"a": {"field": "a"}}},
     "set by the browser"),
    ({"op": "extract_json", "url": "/x", "page": {"start_param": "start"}, "columns": {"a": {"field": "a"}}},
     "'length' must be"),
    ({"op": "extract_json", "url": "/x", "max_bytes": 0, "columns": {"a": {"field": "a"}}}, "max_bytes"),
    ({"op": "date_windows", "from": "{{today}}", "days": 1, "split_min_minutes": 0,
      "steps": [{"op": "extract_json", "url": "/x", "params": {"f": "{{window_start}}"},
                 "columns": {"a": {"field": "a"}}}]}, "split_min_minutes"),
    ({"op": "date_windows", "from": "{{today}}", "days": 1, "split_min_minutes": 60,
      "steps": [{"op": "extract_json", "url": "/x", "params": {"f": "{{window_from}}"},
                 "columns": {"a": {"field": "a"}}}]}, "window_start"),
    ({"op": "date_windows", "from": "{{today}}", "days": 1, "split_min_minutes": 60,
      "steps": [{"op": "extract_json", "url": "/x", "params": {"f": "{{window_from}}", "t": "{{window_end}}"},
                 "columns": {"a": {"field": "a"}}}]}, "window_start"),
])
def test_validate_datatable_and_json_steps(step, needle):
    recipe = fixture_recipe()
    recipe["entities"] = {"x": {"kind": "variable", "key": ["a"], "steps": [step]}}
    problems = srr.recipe_problems(recipe)
    assert any(needle in p for p in problems), problems


def test_dig_reads_dotted_paths_and_list_items():
    data = {"data": [{"a": {"b": 1}}, {"a": None}], "n": 2}
    assert srr._dig(data, "") is data
    assert srr._dig(data, "data.0.a.b") == 1
    assert srr._dig(data, "data.1.a.b") is None
    assert srr._dig(["x", "y"], 1) == "y" and srr._dig(["x"], 3) is None


@needs_browser
@pytest.mark.parametrize("jquery", [True, False], ids=["jquery-plugin", "datatable-global"])
def test_e2e_extract_datatable_reads_every_row_not_just_the_rendered_page(site, jquery):
    url = "/devices" if jquery else "/devices?jquery=0"
    recipe = _one_entity(site, [
        {"op": "goto", "url": url},
        {"op": "extract_datatable", "table": "#devices", "columns": {
            "imei": {"field": "imei"}, "model": {"header": "Model"}, "brand": {"field": "model.brand"},
            "grade": {"index": 3}, "link": {"header": "Action", "attr": "href"}}},
    ], ["imei"])
    recipe["entities"]["parts"] = {"kind": "variable", "key": ["part_no"], "steps": [
        {"op": "goto", "url": url},
        {"op": "extract_datatable", "table": "#parts", "columns": {
            "part_no": {"header": "Part No"}, "name": {"index": 1}, "stock": {"header": "Stock", "type": "int"}}},
    ]}
    items, report = _run(site, recipe)
    devices = [i for i in items if i.entity == "data"]
    assert len(devices) == len({i.key for i in devices}) == len(site.state.devices) == 2500
    assert devices[1].payload == {"imei": "35" + "1".zfill(13), "model": "Galaxy S24", "brand": "Samsung",
                                  "grade": "B", "link": "/devices/view?id=2"}
    parts = [i for i in items if i.entity == "parts"]
    assert len(parts) == 1200 and parts[0].payload == {"part_no": "P-0001", "name": "Part 1", "stock": 3}
    assert report.failed == {} and site.state.forbidden_hits == []


@needs_browser
def test_e2e_extract_datatable_errors_point_to_the_right_op(site):
    def failure(table):
        recipe = _one_entity(site, [{"op": "goto", "url": "/devices"},
                                    {"op": "extract_datatable", "table": table, "timeout_ms": 1500,
                                     "columns": {"a": {"index": 0}}}], ["a"])
        report = RunReport()
        with pytest.raises(RecipeRunError):
            _run(site, recipe, report=report)
        return report.failed["data"]

    assert "server-side DataTable" in failure("#cases") and "/api/rma_cases" in failure("#cases")
    assert "is not a DataTables table; use extract_table" in failure("#plain")
    assert "not found" in failure("#nope")
    assert "column(s) ['Nope'] not found" in _run_columns_error(site)


def _run_columns_error(site):
    recipe = _one_entity(site, [{"op": "goto", "url": "/devices"},
                                {"op": "extract_datatable", "table": "#parts",
                                 "columns": {"a": {"header": "Nope"}}}], ["a"])
    report = RunReport()
    with pytest.raises(RecipeRunError):
        _run(site, recipe, report=report)
    return report.failed["data"]


@needs_browser
def test_e2e_extract_json_pages_a_server_side_endpoint_with_draw_start_length(site):
    recipe = _one_entity(site, [{"op": "extract_json", "url": "/api/rma_cases", "method": "POST",
                                 "form": {"search[value]": ""}, "records": "data", "columns": CASE_COLUMNS,
                                 "page": {"start_param": "start", "length_param": "length", "length": 100,
                                          "draw_param": "draw", "total": "recordsFiltered"},
                                 "delay_ms": 50}],
                         ["case_no"])
    sleeps: List[float] = []
    report = RunReport()
    driver = srr.PlaywrightDriver(timeout_ms=10_000, guard=srr._network_guard(site.base_url, True))
    try:
        run = srr._Run(recipe, driver, fx.USERNAME, fx.PASSWORD, report, sleep=sleeps.append)
        run.login()
        ctx = {"name": "data", "kind": "variable", "key": ["case_no"], "cursor_col": None, "date_format": "%Y-%m-%d",
               "vars": {"cursor": None}, "last_count": 0, "page_keys": []}
        items = list(run.steps(recipe["entities"]["data"]["steps"], ctx))
    finally:
        driver.close()
    assert len(items) == len({i.key for i in items}) == 230
    assert items[0].payload == {"case_no": "RMA-5001", "opened": site.state.today.isoformat(),
                                "customer": "Acme Ltd", "qty": 1}
    calls = [c for c in site.state.json_calls if c["path"] == "/api/rma_cases"]
    assert [(c["values"]["start"], c["values"]["length"], c["values"]["draw"]) for c in calls] == [
        ("0", "100", "1"), ("100", "100", "2"), ("200", "100", "3")]
    assert all(c["xhr"] == "XMLHttpRequest" for c in calls)
    assert sleeps == [0.05] * 3


@needs_browser
@pytest.mark.parametrize("body", ["form", "json"])
def test_e2e_extract_json_inside_date_windows_and_incremental(site, body):
    step = {"op": "extract_json", "url": "/search/rma_case", "method": "POST", "records": "",
            body: {"date_from": "{{window_from}}", "date_to": "{{window_to}}"}, "columns": CASE_COLUMNS}
    recipe = _one_entity(site, [{"op": "date_windows", "from": "{{cursor}}", "default": "{{date-60}}", "days": 10,
                                 "steps": [step]}], ["case_no"], cursor="opened")
    items, report = _run(site, recipe)
    assert len(items) == 230 and report.full_entities == ["data"]
    calls = [c for c in site.state.json_calls if c["path"] == "/search/rma_case"]
    assert len(calls) == 7 and calls[0]["values"]["date_from"] == (site.state.today - dt.timedelta(days=60)).isoformat()
    site.state.json_calls.clear()
    cursor = (site.state.today - dt.timedelta(days=2)).isoformat()
    items, report = _run(site, recipe, cursors={"data": cursor})
    assert len(items) == 15 and report.full_entities == []
    assert report.cursors["data"] == site.state.today.isoformat()


def _split_recipe(site, days, max_bytes, split=60):
    step = {"op": "extract_json", "url": "/search/rma_case", "method": "POST", "records": "", "max_bytes": max_bytes,
            "json": {"date_from": "{{window_start}}", "date_to": "{{window_end}}"}, "columns": CASE_COLUMNS}
    return _one_entity(site, [{"op": "date_windows", "from": "{{date-%d}}" % (days - 1), "days": days,
                               "split_min_minutes": split, "steps": [step]}], ["case_no"])


@needs_browser
def test_e2e_date_windows_split_a_window_whose_answer_is_too_large(site):
    days = 8
    by_day: Dict[str, list] = {}
    for case in site.state.cases:
        by_day.setdefault(case["opened"], []).append(case)
    recent = [(site.state.today - dt.timedelta(days=i)).isoformat() for i in range(days)]
    biggest_day = max(len(json.dumps(by_day.get(d, []))) for d in recent)
    whole = len(json.dumps([c for d in recent for c in by_day.get(d, [])]))
    assert whole > biggest_day + 100
    items, report = _run(site, _split_recipe(site, days, biggest_day + 100))
    assert len({i.key for i in items}) == sum(len(by_day.get(d, [])) for d in recent)
    calls = [c for c in site.state.json_calls if c["path"] == "/search/rma_case"]
    assert calls[0]["values"] == {"date_from": f"{recent[-1]} 00:00:00", "date_to": f"{recent[0]} 23:59:59"}
    assert len(calls) > 1 and any("split it in two" in w for w in report.warnings)


@needs_browser
def test_e2e_date_windows_split_stops_at_the_minimum_and_fails(site):
    report = RunReport()
    with pytest.raises(RecipeRunError):
        _run(site, _split_recipe(site, 1, 1, split=360), report=report)
    assert "answered more than max_bytes=1 " in report.failed["data"]
    calls = [c for c in site.state.json_calls if c["path"] == "/search/rma_case"]
    # 1 day, then 2 x 12 h, then 4 x 6 h; a 3 h half is below the 6 h minimum, so it stops at the first 6 h.
    assert [c["values"]["date_from"][11:] for c in calls] == ["00:00:00", "00:00:00", "00:00:00"]
    assert calls[-1]["values"]["date_to"][11:] == "05:59:59"


@needs_browser
def test_e2e_date_windows_split_does_not_replay_rows_of_earlier_steps(site):
    old_day = {"op": "extract_json", "url": "/search/rma_case", "method": "POST", "records": "",
               "json": {"date_from": "{{date-40}}", "date_to": "{{date-40}}"}, "columns": CASE_COLUMNS}
    recipe = _split_recipe(site, 8, len(json.dumps(site.state.cases[:5])) + 100)
    recipe["entities"]["data"]["steps"][0]["steps"].insert(0, old_day)
    items, report = _run(site, recipe)
    assert any("split it in two" in w for w in report.warnings)
    assert len(items) == len({i.key for i in items}) == 5 + 8 * 5


@needs_browser
@pytest.mark.parametrize("url", ["/search/rma_case", "/api/rma_stream"], ids=["content-length", "chunked"])
def test_e2e_extract_json_stops_at_max_bytes(site, url):
    recipe = _one_entity(site, [{"op": "extract_json", "url": url, "method": "POST", "max_bytes": 2000,
                                 "columns": CASE_COLUMNS}], ["case_no"])
    report = RunReport()
    with pytest.raises(RecipeRunError):
        _run(site, recipe, report=report)
    assert "answered more than max_bytes=2000" in report.failed["data"]
    assert "page" in report.failed["data"]


@needs_browser
def test_e2e_extract_json_is_same_origin_and_read_only(site):
    def failure(url, **extra):
        recipe = _one_entity(site, [{"op": "extract_json", "url": url, "columns": {"a": {"field": "a"}}, **extra}],
                             ["a"])
        report = RunReport()
        with pytest.raises((RecipeRunError, RecipeError)) as err:
            _run(site, recipe, report=report)
        return report.failed.get("data") or str(err.value)

    assert "leaves the site" in failure("http://example.com/api/x")
    assert "data-changing" in failure("/api/rma_cases/delete")
    assert "did not answer JSON" in failure("/about")
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_extract_json_logs_in_again_when_the_session_expired(site):
    recipe = _one_entity(site, [{"op": "goto", "url": "/about"},
                                {"op": "extract_json", "url": "/search/rma_case", "method": "POST",
                                 "form": {"date_from": "", "date_to": ""}, "columns": CASE_COLUMNS}], ["case_no"])
    report = RunReport()
    driver = srr.PlaywrightDriver(timeout_ms=10_000, guard=srr._network_guard(site.base_url, True))
    try:
        original = driver.fetch

        def expire_first(*args, **kwargs):
            if not report.warnings:
                site.state.expire_sessions()
            return original(*args, **kwargs)

        driver.fetch = expire_first  # type: ignore[method-assign]
        items = list(run_recipe(recipe, CRED, report=report, driver=driver, allow_private=True))
    finally:
        driver.close()
    assert len(items) == 230 and site.state.logins == 2
    assert any("logged in again" in w for w in report.warnings)
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_browse_lists_datatables_and_json_requests_without_values(site):
    probes = [{"name": "devices", "steps": [{"op": "goto", "url": "/devices"}, {"op": "wait", "ms": 800}]}]
    got = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))
    inv = got["devices"]
    tables = {t["selector"]: t for t in inv["datatables"]}
    assert tables["#devices"]["total"] == 2500 and not tables["#devices"]["server_side"]
    assert tables["#devices"]["columns"][1] == {"header": "Model", "data": "model.name"}
    assert tables["#parts"]["total"] == 1200
    assert tables["#cases"]["server_side"] and tables["#cases"]["ajax_url"] == "/api/rma_cases"
    assert "#plain" not in tables
    seen = {(r["method"], r["url"].replace(site.base_url, "")): r for r in inv["json_requests"]}
    assert ("GET", "/api/devices") in seen
    assert seen[("POST", "/api/rma_cases")]["body_keys"] == ["draw", "length", "start"]
    assert "0" not in json.dumps(seen[("POST", "/api/rma_cases")]["body_keys"])


@needs_browser
def test_e2e_extract_datatable_skips_the_scroll_header_clone(site):
    def run(url, table):
        recipe = _one_entity(site, [{"op": "goto", "url": url},
                                    {"op": "extract_datatable", "table": table,
                                     "columns": {"imei": {"field": "imei"}, "model": {"header": "Model"}}}],
                             ["imei"])
        report = RunReport()
        try:
            items, _ = _run(site, recipe, report=report)
        except RecipeRunError:
            return None, report
        return items, report

    for table in ("table.dataTable", "table", "#scrolled1"):
        items, report = run("/devices/scroll", table)
        assert items is not None and len(items) == 2500, (table, report.failed)
        assert items[0].payload["model"] == "iPhone 15" and report.full_entities == ["data"]
    items, report = run("/devices/scroll?tables=2", "table.dataTable")
    assert items is None
    assert "ambiguous selector 'table.dataTable'" in report.failed["data"]
    assert "#scrolled1, #scrolled2" in report.failed["data"]
    assert report.full_entities == []


@needs_browser
@pytest.mark.parametrize("allow_empty", [False, True])
def test_e2e_full_entity_with_an_empty_extraction_is_not_a_full_load(site, allow_empty):
    step = {"op": "extract_json", "url": "/search/rma_case", "method": "POST",
            "form": {"date_from": "2000-01-01", "date_to": "2000-12-31"}, "columns": CASE_COLUMNS}
    if allow_empty:
        step["allow_empty"] = True
    recipe = _one_entity(site, [step], ["case_no"], mode="full")
    items, report = _run(site, recipe, mode="full")
    assert items == [] and report.completed == ["data"] and report.rows == {"data": 0}
    if allow_empty:
        assert report.full_entities == ["data"]
    else:
        assert report.full_entities == []
        assert any("not a full load" in w and "allow_empty" in w for w in report.warnings)


def test_empty_extraction_counts_across_pages():
    report = RunReport()
    run_recipe_items = list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(_fake_site(rows_page2=[])),
                                       report=report, today=TODAY, allow_private=True))
    assert len([i for i in run_recipe_items if i.entity == "orders"]) == 2
    assert report.full_entities == ["orders", "about"]

    site = _fake_site()
    site["/orders"]["rows"] = []
    report = RunReport()
    items = list(run_recipe(_fake_recipe(), CRED, driver=FakeDriver(site), report=report, today=TODAY,
                            allow_private=True))
    assert [i.entity for i in items] == ["about"]
    assert report.completed == ["orders", "about"] and report.full_entities == ["about"]
    assert any(w.startswith("orders: not a full load") and "(extract_table)" in w for w in report.warnings)


def test_validate_allow_empty():
    recipe = fixture_recipe()
    recipe["entities"]["orders"]["steps"].insert(0, {"op": "goto", "url": "/a", "allow_empty": True})
    assert any("allow_empty" in p for p in srr.recipe_problems(recipe))


def test_validate_when():
    recipe = fixture_recipe()
    recipe["entities"]["orders"]["steps"][0]["when"] = "sometimes"
    assert any("'when' must be one of full, incremental" in p for p in srr.recipe_problems(recipe))
    recipe = fixture_recipe()
    recipe["entities"]["x"] = {"kind": "variable", "key": ["a"], "steps": [
        {"op": "date_windows", "when": "incremental", "from": "{{cursor}}", "days": 1, "steps": [
            {"op": "extract_json", "url": "/x", "params": {"f": "{{cursor}}", "t": "{{window_to}}"},
             "columns": {"a": {"field": "a"}}}]},
        {"op": "extract_json", "url": "/y", "when": "full", "columns": {"a": {"field": "a"}}},
    ]}
    assert srr.recipe_problems(recipe) == []
    recipe["entities"]["x"]["steps"][0]["when"] = "full"
    assert any("without a 'default'" in p for p in srr.recipe_problems(recipe))


@needs_browser
def test_e2e_when_runs_full_steps_on_full_loads_and_incremental_steps_otherwise(site):
    def search(by, **step):
        return {"op": "extract_json", "url": "/search/rma_case", "method": "POST", "columns": CASE_COLUMNS,
                "form": {"date_from": "{{window_from}}", "date_to": "{{window_to}}", "by": by}, **step}

    recipe = _one_entity(site, [
        {"op": "date_windows", "when": "full", "from": "{{date-60}}", "days": 30, "steps": [search(by="opened")]},
        {"op": "date_windows", "when": "incremental", "from": "{{cursor}}", "days": 5, "steps": [
            search(by="updated"),
            search(by="shipped", when="incremental"),
            search(by="never", when="full"),
        ]},
    ], ["case_no"], cursor="opened")
    assert srr.recipe_problems(recipe) == []
    today = site.state.today

    items, report = _run(site, recipe, mode="full")
    by = [c["values"]["by"] for c in site.state.json_calls]
    assert by == ["opened"] * 3 and len({i.key for i in items}) == 230
    assert report.full_entities == ["data"] and report.warnings == []

    site.state.json_calls.clear()
    cursor = (today - dt.timedelta(days=1)).isoformat()
    items, report = _run(site, recipe, mode="incremental", cursors={"data": cursor})
    calls = site.state.json_calls
    assert [c["values"]["by"] for c in calls] == ["updated", "shipped"]
    assert calls[0]["values"]["date_from"] == cursor and calls[0]["values"]["date_to"] == today.isoformat()
    assert len(items) == 2 * 10 and report.full_entities == []

    site.state.json_calls.clear()
    items, report = _run(site, recipe, mode="incremental")
    assert [c["values"]["by"] for c in site.state.json_calls] == ["opened"] * 3
    assert report.full_entities == ["data"]


# --------------------------------------------------------------------------
# explore: requests each step triggered
# --------------------------------------------------------------------------


def test_json_shape_guesses_the_records_path():
    assert srr.json_shape([{"a": 1, "m": {"n": 2}}, {"a": 2}]) == {
        "type": "array", "records_path": "", "records": 2, "record_keys": ["a", "m.n"]}
    shape = srr.json_shape({"status": "ok", "recordsTotal": 9, "meta": {"tags": ["x"]},
                            "result": {"rows": [{"id": 1}, {"id": 2}], "total": 2}})
    assert shape["records_path"] == "result.rows" and shape["records"] == 2
    assert shape["record_keys"] == ["id"] and shape["keys"][:2] == ["status", "recordsTotal"]
    assert shape["totals"] == {"recordsTotal": 9}
    assert srr.json_shape({"data": []})["records_path"] == "data"
    assert srr.json_shape("x") == {"type": "str"}


def test_request_sample_masks_secret_looking_values_and_truncates():
    form = srr.request_sample("user=leo&password=hunter2&date_from=2026-01-01", "application/x-www-form-urlencoded")
    assert "hunter2" not in form and f"password={srr.REDACTED}" in form and "date_from=2026-01-01" in form
    body = srr.request_sample(json.dumps({"q": {"from": "2026-01-01", "csrf_token": "abc"}}), "application/json")
    assert json.loads(body) == {"q": {"from": "2026-01-01", "csrf_token": srr.REDACTED}}
    assert len(srr.request_sample("a=" + "x" * 2000, "")) <= srr.REQUEST_SAMPLE_CHARS + 1
    assert srr.request_sample("\x00binary", "application/octet-stream").startswith("(7 characters")
    assert srr.request_sample("plain words", "text/plain") == "plain words"
    assert srr.request_sample("", "") is None
    leaky = srr.request_sample("api_key=k1&sid=s1&apiKey=k2&q=abc&tag=" + "a1B2" * 8, "")
    assert leaky == "api_key={r}&sid={r}&apiKey={r}&q=abc&tag={r}".format(r=srr.REDACTED)
    nested = json.loads(srr.request_sample(json.dumps({"ids": ["Zx9" * 10], "d": "2026-01-01T00:00:00.000+08:00"})))
    assert nested == {"ids": [srr.REDACTED], "d": "2026-01-01T00:00:00.000+08:00"}


@pytest.mark.parametrize("value", [0, 50, "1000", True, srr.MAX_STEP_TIMEOUT_MS + 1])
def test_validate_rejects_bad_step_timeouts(value):
    recipe = fixture_recipe()
    recipe["entities"]["about"]["steps"].insert(0, {"op": "click", "text": "About", "timeout_ms": value})
    assert any("'timeout_ms'" in p for p in srr.recipe_problems(recipe))
    recipe["entities"]["about"]["steps"][0]["timeout_ms"] = 90_000
    assert not any("'timeout_ms'" in p for p in srr.recipe_problems(recipe))
    recipe["entities"]["about"]["steps"][0] = {"op": "goto", "url": "/about", "timeout_ms": 5000}
    assert any("'timeout_ms' works on" in p for p in srr.recipe_problems(recipe))


def _query_steps(site, *extra):
    lo = (site.state.today - dt.timedelta(days=3)).isoformat()
    return [{"op": "goto", "url": "/query"}, {"op": "fill", "selector": "#q-from", "value": lo},
            {"op": "fill", "selector": "#q-to", "value": site.state.today.isoformat()},
            {"op": "click", "text": "Search"}, *extra]


@needs_browser
def test_e2e_browse_reports_the_endpoint_a_search_button_calls(site):
    probes = [{"name": "query", "steps": _query_steps(site, {"op": "wait", "selector": "#q-results tbody tr"})}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))["query"]
    assert "error" not in inv
    groups = {g["step"]: g for g in inv["step_requests"]}
    assert list(groups) == [4] and groups[4]["op"] == "click"
    (req,) = groups[4]["requests"]
    assert "pending" not in req
    assert req["method"] == "POST" and req["path"] == "/query/search" and req["status"] == 200
    assert req["request_type"].startswith("application/json") and "json" in req["content_type"]
    sent = json.loads(req["body"])
    assert sent["date_to"] == site.state.today.isoformat() and sent["token"] == srr.REDACTED
    shape = req["shape"]
    assert shape["records_path"] == "result.rows" and shape["records"] == 20
    assert {"case_no", "opened", "customer.name"} <= set(shape["record_keys"])
    assert req["bytes"] > 100
    table = next(t for t in inv["tables"] if t["selector"] == "#q-results")
    assert table["rows"] == 20
    assert len([c for c in site.state.json_calls if c["path"] == "/query/search"]) == 1
    summary = srr.inventory_summary("query", inv)
    assert "after step 4 (click): POST /query/search" in summary and "'result.rows': 20" in summary
    assert CRED["password"] not in json.dumps(inv)
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_browse_keeps_the_requests_when_a_step_times_out(site):
    probes = [{"name": "query", "steps": _query_steps(site, {"op": "wait", "selector": "#never", "timeout_ms": 800})},
              {"name": "slow_click", "steps": [{"op": "goto", "url": "/query"},
                                               {"op": "click", "selector": "#missing", "timeout_ms": 600}]}]
    started = time.monotonic()
    got = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))
    assert time.monotonic() - started < 20
    inv = got["query"]
    assert "Timeout" in inv["error"] and "step_requests" in inv["hint"]
    paths = [r["path"] for g in inv["step_requests"] for r in g["requests"]]
    assert paths == ["/query/search"]
    assert any(t["selector"] == "#q-results" for t in inv["tables"])
    assert "hint:" in srr.inventory_summary("query", inv)
    assert "Timeout" in got["slow_click"]["error"] and got["slow_click"]["hint"]


@needs_browser
def test_e2e_browse_labels_nested_steps_and_reports_pending_calls(site):
    window = {"op": "date_windows", "from": "{{date-3}}", "days": 2, "steps": [
        {"op": "fill", "selector": "#q-from", "value": "{{window_from}}"},
        {"op": "fill", "selector": "#q-to", "value": "{{window_to}}"},
        {"op": "click", "text": "Search"}, {"op": "wait", "ms": 300}]}
    probes = [{"name": "windows", "steps": [{"op": "goto", "url": "/query"}, window]},
              {"name": "slow", "steps": [{"op": "goto", "url": "/query"}, {"op": "click", "text": "Slow search",
                                                                          "allow_empty_filters": True},
                                         {"op": "wait", "selector": "#never", "timeout_ms": 500}]}]
    recipe = fixture_recipe(site.base_url)
    recipe["timeout_ms"] = 1000
    got = dict(srr.browse(recipe, probes, CRED, allow_private=True))
    groups = got["windows"]["step_requests"]
    assert [(g["step"], g["op"]) for g in groups] == [("2.3", "click"), ("2.3", "click")]
    assert all(g["requests"][0]["path"] == "/query/search" for g in groups)
    slow = got["slow"]
    assert "Timeout" in slow["error"]
    (req,) = [r for g in slow["step_requests"] for r in g["requests"]]
    assert req["path"] == "/query/search" and "pending" in req and "status" not in req
    summary = srr.inventory_summary("slow", slow)
    assert "POST /query/search" in summary and "-> PENDING" in summary


@needs_browser
def test_e2e_captured_search_endpoint_works_as_extract_json(site):
    step = {"op": "extract_json", "url": "/query/search", "method": "POST", "records": "result.rows",
            "json": {"date_from": "{{window_from}}", "date_to": "{{window_to}}"}, "columns": CASE_COLUMNS}
    recipe = _one_entity(site, [{"op": "date_windows", "from": "{{cursor}}", "default": "{{date-60}}", "days": 10,
                                 "steps": [step]}], ["case_no"], cursor="opened")
    items, report = _run(site, recipe)
    assert len(items) == 230 and report.full_entities == ["data"]
    assert site.state.forbidden_hits == []


def test_explore_call_cap_must_be_bounded():
    recipe = fixture_recipe()
    assert srr.recipe_problems(dict(recipe, explore_max_call_bytes=500_000)) == []
    for bad in (0, 9_999, 50_000_001, "2MB", True):
        problems = srr.recipe_problems(dict(recipe, explore_max_call_bytes=bad))
        assert any("explore_max_call_bytes" in p for p in problems), bad
    with pytest.raises(srr.RecipeError, match="explore_max_call_bytes"):
        list(srr.browse(recipe, [{"name": "x", "steps": []}], CRED, max_call_bytes=10**9))


@pytest.mark.parametrize("name, secret", [
    ("password_hash", True), ("passwordHash", True), ("Password Hash", True), ("api_key", True),
    ("access_token", True), ("session_id", True), ("salt", True),
    ("passport_no", False), ("hashtag", False), ("customer.name", False), ("opened", False),
])
def test_secret_looking_column_names(name, secret):
    assert srr.looks_like_secret_column(name) is secret


def _stock_search(*filters, allow_empty_filters=False):
    click = {"op": "click", "text": "Search", **({"allow_empty_filters": True} if allow_empty_filters else {})}
    return [{"op": "goto", "url": "/stock"}, *filters, click,
            {"op": "wait", "selector": "#s-status:has-text('aborted'), #s-results tbody tr", "timeout_ms": 20000}]


@needs_browser
def test_e2e_explore_cuts_off_an_unfiltered_search_and_warns_before_it(site):
    probes = [{"name": "stock", "steps": _stock_search(allow_empty_filters=True)}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))["stock"]
    assert "error" not in inv and "refused" not in inv, inv
    (group,) = inv["step_requests"]
    assert group["step"] == 2 and group["op"] == "click"
    (req,) = group["requests"]
    assert req["method"] == "POST" and req["path"] == "/stock/search" and req["body"] == "[]"
    assert req["aborted"] == "too_large" and "pending" not in req and "shape" not in req
    assert srr.DEFAULT_CALL_MAX_BYTES < req["bytes_seen"] < 3 * srr.DEFAULT_CALL_MAX_BYTES
    assert "narrower filter" in req["hint"]
    assert "narrow" in inv["hint"]
    # the server stopped sending soon after the cut-off: the 40 MB answer was never downloaded
    time.sleep(1)
    assert site.state.big_sent["search"] < 4 * srr.DEFAULT_CALL_MAX_BYTES
    (warning,) = inv["warnings"]
    assert warning["step"] == 2 and set(warning["empty_filters"]) == {"#s-from", "#s-to", "#s-wh"}
    assert "narrowest filter" in warning["warning"]
    summary = srr.inventory_summary("stock", inv)
    assert "POST /stock/search [application/json] body [] -> CUT OFF (too large" in summary
    assert "WARNING at step 2" in summary
    assert len([c for c in site.state.json_calls if c["path"] == "/stock/search"]) == 1
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_explore_cut_off_uses_the_announced_size_and_the_recipe_cap(site):
    recipe = dict(fixture_recipe(site.base_url), explore_max_call_bytes=100_000)
    probes = [{"name": "all", "steps": [{"op": "goto", "url": "/stock"}, {"op": "click", "text": "Export all",
                                                                         "allow_empty_filters": True},
                                        {"op": "wait", "selector": "#s-status:has-text('export failed')"}]}]
    inv = dict(srr.browse(recipe, probes, CRED, allow_private=True))["all"]
    (req,) = inv["step_requests"][0]["requests"]
    assert req["path"] == "/stock/all" and req["aborted"] == "too_large"
    assert req["content_length"] > 30_000_000 and req["bytes_seen"] <= 100_000
    assert "100000 bytes" in req["hint"]
    time.sleep(1)
    assert site.state.big_sent["all"] < 5_000_000
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_a_narrow_search_is_not_cut_off_or_warned(site):
    day = (site.state.today - dt.timedelta(days=2)).isoformat()
    probes = [{"name": "stock", "steps": _stock_search({"op": "fill", "selector": "#s-from", "value": day},
                                                       {"op": "fill", "selector": "#s-to", "value": day})}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))["stock"]
    assert "warnings" not in inv and "hint" not in inv
    (req,) = inv["step_requests"][0]["requests"]
    assert req["status"] == 200 and "aborted" not in req and req["shape"]["records"] == 10
    assert next(t for t in inv["tables"] if t["selector"] == "#s-results")["rows"] == 10


def _stock_probe(name, button, done, url="/stock"):
    return {"name": name, "steps": [{"op": "goto", "url": url},
                                    {"op": "click", "text": button, "allow_empty_filters": True},
                                    {"op": "wait", "selector": done, "timeout_ms": 20000}]}


@needs_browser
def test_e2e_explore_cuts_off_a_call_whose_answer_the_page_never_reads(site):
    probe = _stock_probe("count", "Count", "#s-status:has-text('counting')")
    probe["steps"].append({"op": "wait", "ms": 1500})
    inv = dict(srr.browse(fixture_recipe(site.base_url), [probe], CRED, allow_private=True))["count"]
    reqs = [r for g in inv["step_requests"] for r in g["requests"]]
    (req,) = [r for r in reqs if r["path"] == "/stock/search"]
    assert req["aborted"] == "too_large" and req["bytes_seen"] > srr.DEFAULT_CALL_MAX_BYTES
    time.sleep(1)
    assert site.state.big_sent["search"] < 4 * srr.DEFAULT_CALL_MAX_BYTES
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_explore_refuses_a_synchronous_xhr(site):
    probe = _stock_probe("legacy", "Legacy search", "#s-status:has-text('legacy failed')")
    inv = dict(srr.browse(fixture_recipe(site.base_url), [probe], CRED, allow_private=True))["legacy"]
    assert "error" not in inv, inv.get("error")
    (req,) = [r for g in inv["step_requests"] for r in g["requests"]]
    assert req["method"] == "POST" and req["path"] == "/stock/search" and req["aborted"] == "sync_xhr"
    assert "extract_json" in req["hint"]
    assert "REFUSED (synchronous XHR)" in srr.inventory_summary("legacy", inv)
    assert "search" not in site.state.big_sent
    assert [c for c in site.state.json_calls if c["path"] == "/stock/search"] == []


@needs_browser
def test_e2e_explore_reports_a_call_cut_off_inside_an_iframe(site):
    probe = _stock_probe("framed", "Search in frame", "#f", url="/stock/framed")
    probe["steps"].append({"op": "wait", "ms": 2500})
    inv = dict(srr.browse(fixture_recipe(site.base_url), [probe], CRED, allow_private=True))["framed"]
    reqs = [r for g in inv["step_requests"] for r in g["requests"]]
    (req,) = [r for r in reqs if r["path"] == "/stock/search"]
    assert req["aborted"] == "too_large" and "narrower filter" in req["hint"]
    time.sleep(1)
    assert site.state.big_sent["search"] < 4 * srr.DEFAULT_CALL_MAX_BYTES


@needs_browser
@pytest.mark.parametrize("warehouse", ["HK1", "HK"])  # HK is "All Hong Kong warehouses": a subset
def test_e2e_a_search_narrowed_by_a_non_date_filter_is_not_warned(site, warehouse):
    probes = [{"name": "stock", "steps": _stock_search({"op": "select", "selector": "#s-wh", "value": warehouse})}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))["stock"]
    assert "warnings" not in inv
    (req,) = inv["step_requests"][0]["requests"]
    assert "aborted" not in req and req["status"] == 200


@needs_browser
def test_e2e_explore_finds_a_lookup_list_on_a_setup_page(site):
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "setup", "steps": [
        {"op": "goto", "url": "/setup/functions"}]}], CRED, allow_private=True))["setup"]
    table = next(t for t in inv["tables"] if t["selector"] == "#functions")
    assert table["rows"] == 4 and table["headers"][:3] == ["Code", "Function", "Workflow step"]
    assert "security" not in inv and "secret_columns" not in table
    assert {b["text"] for b in inv["buttons"] if b["forbidden"]} == {"Edit"}
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_explore_flags_and_masks_a_password_hash_column(site):
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "staff", "steps": [
        {"op": "goto", "url": "/staff"}]}], CRED, allow_private=True))["staff"]
    table = next(t for t in inv["tables"] if t["selector"] == "#staff")
    assert table["secret_columns"] == ["Password Hash"]
    assert all(row[2] == srr.REDACTED for row in table["sample"])
    (note,) = inv["security"]
    assert "Exclude the whole entity" in note and "site owner" in note
    assert "$2y$" not in json.dumps(inv)
    assert "SECURITY:" in srr.inventory_summary("staff", inv)
    form = next(f for f in inv["forms"] if f["selector"] == "#api-settings")
    assert {f["name"]: f["value"] for f in form["fields"]} == {"api_key": srr.REDACTED, "_token": srr.REDACTED}
    assert fx.STAFF_API_KEY not in json.dumps(inv)
    assert "filled-in fields ['api_key']" in note


# --------------------------------------------------------------------------
# explore: empty searches refused; secrets in background and inline data
# --------------------------------------------------------------------------


def _rules_search(*rule, **click):
    return [{"op": "goto", "url": "/rules"}, *rule, {"op": "click", "text": "Search", **click},
            {"op": "wait", "selector": "#rb-results tbody tr", "timeout_ms": 10000}]


@needs_browser
def test_e2e_explore_refuses_an_empty_rule_builder_search(site):
    probes = [{"name": "rules", "steps": _rules_search()}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))["rules"]
    assert inv["refused"] == "empty_filters" and "error" not in inv
    assert inv["refused_step"] == 2 and inv["refused_op"] == "click" and inv["empty_filters"] == ["#rb-field"]
    assert "one day" in inv["hint"] and "step_requests" in inv["hint"]
    assert "step_requests" not in inv
    assert "REFUSED at step 2 (click): empty_filters ['#rb-field']" in srr.inventory_summary("rules", inv)
    assert any(t["selector"] == "#rb-results" for t in inv["tables"])  # the page is still inventoried
    assert [c for c in site.state.json_calls if c["path"] == "/rules/search"] == []
    assert site.state.forbidden_hits == []


@needs_browser
def test_e2e_allow_empty_filters_lets_an_empty_search_through_to_the_cap(site):
    steps = _rules_search(allow_empty_filters=True)
    steps[-1] = {"op": "wait", "ms": 2500}
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "rules", "steps": steps}], CRED,
                          allow_private=True))["rules"]
    assert "refused" not in inv and "error" not in inv, inv
    (req,) = inv["step_requests"][0]["requests"]
    assert req["path"] == "/rules/search" and req["aborted"] == "too_large"
    (warning,) = inv["warnings"]
    assert warning["empty_filters"] == ["#rb-field"]


@needs_browser
def test_e2e_a_one_day_rule_is_searched_and_its_payload_becomes_extract_json(site):
    day = (site.state.today - dt.timedelta(days=1)).isoformat()
    rule = [{"op": "select", "selector": "#rb-field", "value": "stock_in"},
            {"op": "wait", "selector": "#rb-op"},
            {"op": "select", "selector": "#rb-op", "value": "between"},
            {"op": "fill", "selector": "#rb-v1", "value": day}, {"op": "fill", "selector": "#rb-v2", "value": day}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "rules", "steps": _rules_search(*rule)}], CRED,
                          allow_private=True))["rules"]
    assert "refused" not in inv and "error" not in inv and "warnings" not in inv, inv
    (group,) = [g for g in inv["step_requests"] if g["op"] == "click"]
    (req,) = group["requests"]
    assert req["method"] == "POST" and req["path"] == "/rules/search" and req["status"] == 200
    sent = json.loads(req["body"])
    assert sent == {"condition": "AND", "rules": [{"id": "stock_in", "field": "stock_in", "operator": "between",
                                                    "value": [day, day]}]}
    assert req["shape"]["records_path"] == "data" and req["shape"]["records"] == 10
    assert req["shape"]["record_keys"] == ["imei", "stock_in"]
    # the payload read from step_requests, as a bounded extract_json over one-day windows
    body = json.loads(req["body"])
    body["rules"][0]["value"] = ["{{window_from}}", "{{window_to}}"]
    step = {"op": "extract_json", "url": req["path"], "method": "POST", "json": body, "records": "data",
            "columns": {"imei": {"field": "imei"}, "stock_in": {"field": "stock_in", "type": "date"}}}
    recipe = _one_entity(site, [{"op": "date_windows", "from": "{{date-2}}", "days": 1, "steps": [step]}], ["imei"])
    assert srr.recipe_problems(recipe) == []
    items, report = _run(site, recipe)
    assert len(items) == 30 and report.full_entities == ["data"]
    calls = [json.loads(c["values"]["rules"]) for c in site.state.json_calls if c["path"] == "/rules/search"]
    assert all(c and c[0]["value"][0] == c[0]["value"][1] for c in calls)  # every call asked for one day
    assert "rules" not in site.state.big_sent and site.state.forbidden_hits == []


@pytest.mark.parametrize("step, ok", [
    ({"op": "click", "text": "Search", "allow_empty_filters": True}, True),
    ({"op": "submit", "selector": "#f", "allow_empty_filters": False}, True),
    ({"op": "click", "text": "Search", "allow_empty_filters": "yes"}, False),
    ({"op": "fill", "selector": "#a", "value": "x", "allow_empty_filters": True}, False),
])
def test_allow_empty_filters_is_a_true_false_option_of_click_and_submit(step, ok):
    problems = srr._steps_problems("probe", [{"op": "goto", "url": "/"}, step])
    assert (problems == []) is ok, problems
    assert ok or "allow_empty_filters" in problems[0]


@needs_browser
def test_e2e_explore_flags_secrets_in_page_data_behind_a_clean_table(site):
    steps = [{"op": "goto", "url": "/staff/clean"}, {"op": "wait", "selector": "#emps tbody tr"}]
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "emps", "steps": steps}], CRED,
                          allow_private=True))["emps"]
    table = next(t for t in inv["tables"] if t["selector"] == "#emps")
    assert table["headers"] == ["Username", "Name", "Role"] and "secret_columns" not in table
    found = inv["inline_secrets"]
    assert "script 1: STAFF.amy.password_hash" not in found  # where/key only, as the page holds it
    assert any(s.startswith("script") and s.endswith(": password_hash") for s in found), found
    assert "div#me [data-hash]: hash" in found
    assert "hidden input: user_secret" in found
    assert any(s.startswith("datatable table#emps rows") and s.endswith("auth.pwd") for s in found), found
    # CSRF tokens and dated fields are not secrets
    assert not any(k in s for s in found for k in ("_token", "csrf", "password_changed_at", "data-role"))
    (load,) = [r for g in inv["step_requests"] for r in g["requests"] if r["path"] == "/staff/list"]
    assert "data.auth.pwd" in load["secret_keys"]
    (note,) = inv["security"]
    assert "data in the page itself" in note and "/staff/list" in note and "Exclude the whole entity" in note
    dumped = json.dumps(inv)
    assert "$2y$" not in dumped
    assert "SECURITY:" in srr.inventory_summary("emps", inv)


@needs_browser
def test_e2e_a_clean_page_with_csrf_tokens_is_not_flagged(site):
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "q", "steps": [{"op": "goto", "url": "/query"}]},
                                                          {"name": "dt", "steps": [{"op": "goto", "url": "/devices"}]}],
                          CRED, allow_private=True))
    for page in inv.values():
        assert "security" not in page and "inline_secrets" not in page and "inline_data" not in page


def test_secret_paths_in_a_json_answer():
    answer = {"rows": [{"id": 1, "name": "Ann"}], "audit": [{"by": {"pwd_hash": "$2y$10$" + "a" * 53}}],
              "csrf_token": "c" * 40, "password_changed_at": "2026-01-01", "api_key": "k" * 20,
              "session": "eyJhbGciOiJI.eyJzdWIiOiIx.sig", "has_password": True, "token": ""}
    assert sorted(srr.secret_paths(answer)) == ["api_key", "audit.by.pwd_hash", "session"]
    assert srr.json_shape(answer)["secret_keys"]
    assert "secret_keys" not in srr.json_shape({"data": [{"id": 1, "name": "Ann", "token_count": 3}]})


@needs_browser
def test_e2e_a_non_search_button_next_to_empty_filters_is_clicked_not_refused(site):
    probes = [{"name": "next", "steps": [{"op": "goto", "url": "/wizard"}, {"op": "click", "text": "Next"},
                                         {"op": "wait", "selector": "#wz-more"}]},
              {"name": "search", "steps": [{"op": "goto", "url": "/wizard"}, {"op": "click", "text": "Search"}]},
              {"name": "submit", "steps": [{"op": "goto", "url": "/wizard"}, {"op": "click", "text": "Submit"}]}]
    got = dict(srr.browse(fixture_recipe(site.base_url), probes, CRED, allow_private=True))
    assert got["submit"]["refused"] == "empty_filters"  # a plain-labelled submit of a date form is a search
    assert "refused" not in got["next"] and "error" not in got["next"], got["next"]
    (warning,) = got["next"]["warnings"]
    assert warning["empty_filters"] == ["#wz-from"]
    assert got["search"]["refused"] == "empty_filters" and got["search"]["empty_filters"] == ["#wz-from"]


@needs_browser
def test_e2e_many_csrf_tokens_do_not_hide_a_later_password_hash(site):
    inv = dict(srr.browse(fixture_recipe(site.base_url), [{"name": "p", "steps": [{"op": "goto", "url": "/staff/noisy"}]}],
                          CRED, allow_private=True))["p"]
    assert inv["inline_secrets"] == ["hidden input: password_hash"]
    assert inv["security"] and "$2y$" not in json.dumps(inv)
