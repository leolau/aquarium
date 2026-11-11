"""site-to-schema skill: design/recipe checker and the explore / preview
scripts against the local fixture site."""

from __future__ import annotations

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
])
def test_check_design_finds_each_problem(mutate, needle):
    problems, _, _ = _mutated(mutate)
    assert any(needle in p for p in problems), problems


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
