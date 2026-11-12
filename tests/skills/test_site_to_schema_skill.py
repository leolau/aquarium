"""site-to-schema skill: design/recipe checker and the explore / preview
scripts against the local fixture site."""

from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "research" / "site-to-schema"
SCRIPTS = SKILL / "scripts"
FIXTURE = ROOT / "tests" / "fixtures" / "site_fixture" / "server.py"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(SCRIPTS))
check_design = _load(SCRIPTS / "check_design.py", "s2s_check_design")
explore_site = _load(SCRIPTS / "explore_site.py", "s2s_explore_site")
preview_recipe = _load(SCRIPTS / "preview_recipe.py", "s2s_preview_recipe")
fx = _load(FIXTURE, "s2s_site_fixture")

DESIGN = json.loads((SKILL / "references" / "example-design.json").read_text())
RECIPE = json.loads((SKILL / "references" / "example-recipe.json").read_text())


def _entity(design, name):
    return next(e for e in design["entities"] if e["name"] == name)


def test_the_worked_example_is_ready_to_propose():
    problems, warnings, questions = check_design.check(DESIGN, RECIPE)
    assert problems == [] and questions == []


def _mutated(fn):
    design, recipe = copy.deepcopy(DESIGN), copy.deepcopy(RECIPE)
    fn(design, recipe)
    return check_design.check(design, recipe)


@pytest.mark.parametrize("mutate, needle", [
    (lambda d, r: _entity(d, "warehouses").update(kind="fixed"), "must be variable"),
    (lambda d, r: _entity(d, "orders").update(reason=""), "reason"),
    (lambda d, r: _entity(d, "orders").update(key=["order_id"]), "key column"),
    (lambda d, r: _entity(d, "orders")["refresh"].update(cursor="status"), "date/datetime/integer"),
    (lambda d, r: r["entities"]["orders"]["steps"][2].update(value="{{date-30}}"), "uses {{cursor}}"),
    (lambda d, r: _entity(d, "orders")["columns"].pop(), "undeclared columns"),
    (lambda d, r: r["entities"].pop("about"), "missing from recipe"),
    (lambda d, r: r["entities"]["orders"]["steps"].insert(1, {"op": "click", "text": "Add New"}),
     "data-changing action"),
    (lambda d, r: _entity(d, "orders")["refresh"].update(full_every="weekly"), "ISO 8601"),
    (lambda d, r: d.update(timezone="HKT"), "IANA time zone"),
    (lambda d, r: d.update(timezone=""), "IANA time zone"),
])
def test_check_design_finds_each_problem(mutate, needle):
    problems, _, _ = _mutated(mutate)
    assert any(needle in p for p in problems), problems


def _staff_entity(design, recipe, column="password_hash", header="Password Hash"):
    design["entities"].append({
        "name": "staff", "kind": "variable", "reason": "employee table", "source": {"page": "/staff"},
        "key": ["username"], "columns": [{"name": "username", "type": "text"}, {"name": column, "type": "text"}],
        "refresh": {"mode": "full"}, "question": None})
    recipe["entities"]["staff"] = {"kind": "variable", "key": ["username"], "mode": "full", "steps": [
        {"op": "goto", "url": "/staff"},
        {"op": "extract_table", "table": "#staff",
         "columns": {"username": {"header": "Username"}, column: {"header": header}}}]}


@pytest.mark.parametrize("column, header", [("password_hash", "Password Hash"), ("pw", "API Key"),
                                            ("login_token", "Token")])
def test_check_design_flags_an_entity_with_secret_columns(column, header):
    problems, _, _ = _mutated(lambda d, r: _staff_entity(d, r, column, header))
    (problem,) = [p for p in problems if "secret-looking" in p]
    assert problem.startswith("design.staff:") and "Drop the whole entity" in problem
    assert "design.exclusions" in problem


def test_check_design_accepts_exclusions_and_checks_their_shape():
    assert [e["page"] for e in DESIGN["exclusions"] if e.get("security")] == ["/staff"]
    problems, _, _ = _mutated(lambda d, r: d.update(exclusions=[{"page": "/staff"}]))
    assert any("design.exclusions[0]" in p for p in problems)
    problems, _, _ = _mutated(lambda d, r: d.update(exclusions="none"))
    assert any("design.exclusions must be a list" in p for p in problems)


def test_open_questions_are_surfaced():
    _, _, questions = _mutated(lambda d, r: _entity(d, "orders").update(
        question="Do orders change after the day they are created?"))
    assert questions == ["orders: Do orders change after the day they are created?"]


def test_check_design_cli_exit_codes(tmp_path, capsys):
    (tmp_path / "d.json").write_text(json.dumps(DESIGN))
    (tmp_path / "r.json").write_text(json.dumps(RECIPE))
    assert check_design.main([str(tmp_path / "d.json"), str(tmp_path / "r.json")]) == 0
    assert "ok: ready to propose" in capsys.readouterr().out
    bad = copy.deepcopy(DESIGN)
    _entity(bad, "orders")["kind"] = "fixed"
    (tmp_path / "d.json").write_text(json.dumps(bad))
    assert check_design.main([str(tmp_path / "d.json"), str(tmp_path / "r.json"), "--json"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] is False and result["problems"]


def _browser_available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401

        from hermes_cli.site_recipe_runner import PlaywrightDriver

        PlaywrightDriver(timeout_ms=5000).close()
        return True
    except Exception:
        return False


needs_browser = pytest.mark.skipif(not _browser_available(), reason="playwright + Chromium not installed")


@pytest.fixture
def site(monkeypatch, tmp_path):
    import tools.url_safety

    monkeypatch.setattr(tools.url_safety, "is_safe_url", lambda url: True)
    cred = {"username": fx.USERNAME, "password": fx.PASSWORD}
    for module in (explore_site, preview_recipe):
        monkeypatch.setattr(module, "load_credential", lambda entry: cred)
    with fx.serve_fixture() as running:
        recipe = dict(RECIPE, base_url=running.base_url)
        (tmp_path / "recipe.json").write_text(json.dumps(recipe))
        yield running, tmp_path


@needs_browser
def test_explore_inventories_pages_and_flags_traps(site, capsys):
    running, tmp = site
    (tmp / "probes.json").write_text(json.dumps([
        {"name": "orders", "steps": [{"op": "goto", "url": "/dashboard"}, {"op": "click", "text": "Orders"},
                                     {"op": "submit", "selector": "#btn-search"}]},
    ]))
    code = explore_site.main(["--recipe", str(tmp / "recipe.json"), "--credential", "web-login/fixture",
                              "--probes", str(tmp / "probes.json"), "--goto", "/reference", "--out", str(tmp / "inv")])
    out = capsys.readouterr().out
    assert code == 0, out
    assert "table #results: 10 rows" in out
    assert "never click: ['Add New']" in out
    assert fx.PASSWORD not in out
    inv = json.loads((tmp / "inv" / "reference.json").read_text())
    assert any(b["text"] == "Warehouse Table" for b in inv["buttons"])
    assert running.state.forbidden_hits == []


@needs_browser
def test_preview_counts_every_entity_without_touching_traps(site, capsys):
    running, tmp = site
    code = preview_recipe.main(["--recipe", str(tmp / "recipe.json"), "--credential", "web-login/fixture",
                                "--jsonl", str(tmp / "items.jsonl")])
    out = capsys.readouterr().out
    assert code == 0, out
    assert "== orders: 45 items (ok)" in out
    assert "== warehouses: 3 items (ok)" in out
    assert "== about: 1 items (ok)" in out
    assert len((tmp / "items.jsonl").read_text().splitlines()) == 49
    assert fx.PASSWORD not in out
    assert running.state.forbidden_hits == []


def test_scripts_point_to_site_db_when_the_store_is_hidden(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("HERMES_TERMINAL_DB_CREDENTIALS_HIDDEN", "1")
    (tmp_path / "recipe.json").write_text(json.dumps(RECIPE))
    for module, extra in ((explore_site, ["--goto", "/"]), (preview_recipe, [])):
        with pytest.raises(SystemExit) as stop:
            module.main(["--recipe", str(tmp_path / "recipe.json"), "--credential", "web-login/x.example", *extra])
        assert "use the site_db tool" in str(stop.value) and "explore / preview" in str(stop.value)


def test_scripts_point_to_site_db_when_the_store_cannot_be_read(monkeypatch):
    import hermes_cli.credential_store as store

    def unreadable(*a, **k):
        raise PermissionError(13, "Permission denied", "/opt/data/hermes-home/logs/curator")

    monkeypatch.delenv("HERMES_TERMINAL_DB_CREDENTIALS_HIDDEN", raising=False)
    monkeypatch.setattr(store, "default_credential_store", unreadable)
    common = sys.modules["_common"]
    with pytest.raises(SystemExit, match="not reachable from this terminal.*site_db") as stop:
        common.load_credential("web-login/x.example")
    assert "PermissionError" in str(stop.value)


def test_skill_studies_through_site_db_and_stops_on_missing_prerequisites():
    text = (SKILL / "SKILL.md").read_text()
    assert "action `explore`" in text and "action `preview`" in text
    assert "`login_saved`" in text and "`list_secrets`" in text
    assert "## Stop and report" in text and text.index("## Stop and report") < text.index("## Pitfalls")
    assert "no `sudo`" in text
    assert "use the safe choice (`full`, or `incremental` with a" in text
    assert "**ask\n     the user** before proposing" not in text


def test_skill_rules_for_safe_probing_large_tables_and_secrets():
    text = " ".join((SKILL / "SKILL.md").read_text().split())
    assert "set the narrowest filter the form has: one day" in text
    assert "**Never click with empty filters**" in text and "If no filter can be set, do not click" in text
    assert "`aborted: \"too_large\"`" in text and "explore_max_call_bytes" in text
    assert "1-day `date_windows`" in text and "`P30D`" in text and "nightly `full` is only for tables read cheaply" in text
    assert "exclude the **whole entity**" in text and "`design.exclusions`" in text and "site owner" in text
    assert "**Configuration / setup screens**" in text and "lookup lists" in text
    assert "**Probe budget.**" in text and "more than 10 s" in text and "stop probing" in text
    assert "leaves filters empty" not in text and "{{date-3650}}`..`{{today}}`) or" not in text


@needs_browser
def test_explore_script_cuts_off_a_wide_search(site, capsys):
    running, tmp = site
    (tmp / "probes.json").write_text(json.dumps([{"name": "stock", "steps": [
        {"op": "goto", "url": "/stock"}, {"op": "click", "text": "Search"},
        {"op": "wait", "selector": "#s-status:has-text('aborted')", "timeout_ms": 20000}]}]))
    code = explore_site.main(["--recipe", str(tmp / "recipe.json"), "--credential", "web-login/fixture",
                              "--probes", str(tmp / "probes.json"), "--max-call-bytes", "50000",
                              "--out", str(tmp / "inv")])
    out = capsys.readouterr().out
    assert code == 0, out
    assert "POST /stock/search [application/json] body [] -> CUT OFF (too large" in out
    assert "WARNING at step 2" in out
    (req,) = json.loads((tmp / "inv" / "stock.json").read_text())["step_requests"][0]["requests"]
    assert req["aborted"] == "too_large" and 50_000 < req["bytes_seen"] < 1_000_000
    assert running.state.forbidden_hits == []


@pytest.fixture
def gateway_site(monkeypatch):
    """A site row for the fixture with its login in the real (file) credential store."""
    import tools.url_safety
    from hermes_cli import site_sources as ss
    from hermes_cli.access import Principal
    from hermes_cli.credential_store import default_credential_store

    monkeypatch.setattr(tools.url_safety, "is_safe_url", lambda url: True)
    with fx.serve_fixture() as running:
        site = ss.Site(id="22222222-2222-2222-2222-222222222222", slug="fixture", name="Fixture",
                       base_url=running.base_url, login_url=running.base_url, owner_user_id="alice",
                       schema_name="site_fixture", db_role="site_fixture_rw",
                       credential_ref=f"{ss.CREDENTIAL_PROVIDER}/fixture")
        alice = Principal(user_id="alice", display="alice", role="member")
        asyncio.run(default_credential_store().put(
            alice, provider=ss.CREDENTIAL_PROVIDER, name="fixture", kind=ss.CREDENTIAL_KIND,
            payload={"username": fx.USERNAME, "password": fx.PASSWORD}))

        async def find_site(ref, **_kw):
            return site if ref == "fixture" else None

        async def no_writes(*a, **k):
            raise AssertionError("explore/preview must not touch the site database")

        monkeypatch.setattr(ss, "current_profile", lambda: "default")
        monkeypatch.setattr(ss, "find_site", find_site)
        for name in ("propose_design", "apply_design", "start_refresh", "query", "list_runs"):
            monkeypatch.setattr(ss, name, no_writes)
        yield running


def _tool(user, **args):
    import tools.site_db_tool as tool
    from tools.access_policy import acting_as

    async def go():
        with acting_as(user, "member"):
            return json.loads(await tool.site_db_tool(args))

    return asyncio.run(go())


@needs_browser
def test_site_db_explore_logs_in_with_the_saved_login(gateway_site):
    recipe = {k: v for k, v in RECIPE.items() if k != "entities"}
    recipe["base_url"] = gateway_site.base_url
    out = _tool("alice", action="explore", site="fixture", recipe=recipe, goto=["/reference"],
                probes=[{"name": "orders", "steps": [{"op": "goto", "url": "/dashboard"}, {"op": "click", "text": "Orders"},
                                                     {"op": "submit", "selector": "#btn-search"}]}])
    assert out["success"], out
    assert out["login"] == "site-login/fixture"
    pages = {p["name"]: p for p in out["pages"]}
    assert "table #results: 10 rows" in pages["orders"]["summary"]
    assert "never click: ['Add New']" in pages["orders"]["summary"]
    assert any(b["text"] == "Warehouse Table" for b in pages["reference"]["inventory"]["buttons"])
    assert fx.PASSWORD not in json.dumps(out)
    assert gateway_site.state.forbidden_hits == []
    assert _tool("bob", action="explore", site="fixture", goto=["/"])["success"] is False


@needs_browser
def test_site_db_explore_reports_the_endpoint_behind_a_search_button(gateway_site):
    recipe = {k: v for k, v in RECIPE.items() if k != "entities"}
    recipe["base_url"] = gateway_site.base_url
    today = gateway_site.state.today.isoformat()
    steps = [{"op": "goto", "url": "/query"}, {"op": "fill", "selector": "#q-from", "value": today},
             {"op": "fill", "selector": "#q-to", "value": today}, {"op": "click", "text": "Search", "timeout_ms": 20000},
             {"op": "wait", "selector": "#q-results tbody tr"}]
    out = _tool("alice", action="explore", site="fixture", recipe=recipe, probes=[{"name": "query", "steps": steps}])
    assert out["success"], out
    (page,) = out["pages"]
    (group,) = page["inventory"]["step_requests"]
    assert group["step"] == 4 and group["requests"][0]["path"] == "/query/search"
    assert group["requests"][0]["shape"]["records_path"] == "result.rows"
    assert "after step 4 (click): POST /query/search" in page["summary"]
    assert len([c for c in gateway_site.state.json_calls if c["path"] == "/query/search"]) == 1
    assert fx.PASSWORD not in json.dumps(out)
    assert gateway_site.state.forbidden_hits == []


@needs_browser
def test_site_db_explore_cuts_off_a_wide_search_and_flags_secrets(gateway_site):
    recipe = {k: v for k, v in RECIPE.items() if k != "entities"}
    recipe["base_url"] = gateway_site.base_url
    steps = [{"op": "goto", "url": "/stock"}, {"op": "click", "text": "Search"},
             {"op": "wait", "selector": "#s-status:has-text('aborted')", "timeout_ms": 20000}]
    out = _tool("alice", action="explore", site="fixture", recipe=recipe, goto=["/staff", "/setup/functions"],
                probes=[{"name": "stock", "steps": steps}])
    assert out["success"], out
    pages = {p["name"]: p for p in out["pages"]}
    stock = pages["stock"]["inventory"]
    (req,) = stock["step_requests"][0]["requests"]
    assert req["path"] == "/stock/search" and req["aborted"] == "too_large" and "narrower filter" in req["hint"]
    assert stock["warnings"][0]["empty_filters"] and "narrow" in stock["hint"]
    assert "CUT OFF (too large" in pages["stock"]["summary"]
    assert "Exclude the whole entity" in pages["staff"]["inventory"]["security"][0]
    assert "SECURITY:" in pages["staff"]["summary"] and "$2y$" not in json.dumps(out)
    assert any(t["selector"] == "#functions" and t["rows"] == 4
               for t in pages["setup_functions"]["inventory"]["tables"])
    assert gateway_site.state.big_sent["search"] < 10_000_000
    assert gateway_site.state.forbidden_hits == []


@needs_browser
def test_site_db_preview_dry_runs_with_a_row_cap(gateway_site):
    out = _tool("alice", action="preview", site="fixture", recipe=dict(RECIPE, base_url=gateway_site.base_url), max_rows=20, sample=2)
    assert out["success"] and out["ok"], out
    ents = out["entities"]
    assert ents["orders"]["rows"] == 20 and ents["orders"]["capped"] is True
    assert ents["orders"]["full_load"] is False and len(ents["orders"]["sample"]) == 2
    assert ents["warehouses"] == {**ents["warehouses"], "rows": 3, "capped": False, "full_load": True,
                                  "duplicate_keys": 0}
    assert ents["about"]["rows"] == 1
    assert "orders" not in out["cursors"]
    exact = _tool("alice", action="preview", site="fixture", recipe=dict(RECIPE, base_url=gateway_site.base_url),
                  entities=["warehouses"], max_rows=3)
    assert exact["entities"]["warehouses"]["capped"] is False and exact["entities"]["warehouses"]["full_load"] is True
    assert fx.PASSWORD not in json.dumps(out)
    assert gateway_site.state.forbidden_hits == []
