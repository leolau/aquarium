"""The inbox-facts file is injected into the owner's system prompt, so the
triage bridge must keep it inside a rolling budget: oldest bridged facts are
evicted first."""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def bridge():
    sys.path.insert(0, str(REPO_ROOT / "custom"))
    spec = importlib.util.spec_from_file_location(
        "_test_memory_bridge", REPO_ROOT / "custom" / "shared" / "memory_bridge.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _entries(path):
    return [e.strip() for e in path.read_text(encoding="utf-8").split("\n§\n") if e.strip()]


def test_rolling_budget_evicts_oldest_bridged(bridge, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    inbox = tmp_path / "memories" / "INBOX_FACTS.md"
    monkeypatch.setattr(bridge, "DEFAULT_MAX_FILE_CHARS", 400)

    for i in range(30):
        bridge.remember_facts(
            [{"fact": f"fact {i} " + "y" * 40, "category": "x"}],
            source="calendar", sender="a@b.c",
        )

    entries = _entries(inbox)
    assert len(inbox.read_text(encoding="utf-8")) <= 400
    assert any("fact 29" in e for e in entries)
    assert not any("fact 0 " in e for e in entries)


def test_returns_zero_when_nothing_fits(bridge, tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(bridge, "DEFAULT_MAX_FILE_CHARS", 100)
    assert bridge.remember_facts(["z" * 200], source="email", sender="a@b.c") == 0
    assert not (tmp_path / "memories" / "INBOX_FACTS.md").exists()
