"""FG-28 profile registry — the control-plane view the multi-profile admin
console switches over.

These are *behaviour* tests, not change-detectors: they assert how the
registry relates a profile's identity to its routing prefix, served flag and
derived schema (invariants), and that the health probe degrades gracefully
when there is no app datastore to bind to. The live Postgres path is already
covered by FG-27's ``describe_binding`` tests; the registry only composes it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hermes_cli.datastore import app_schema
from hermes_cli.profile_registry import (
    HEALTH_CORE_ONLY,
    HEALTH_UNKNOWN,
    ProfileRegistryEntry,
    _base_url_for,
    get_profile_registry,
    probe_registry_health,
)


@pytest.fixture
def hermes_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A throwaway HERMES_HOME with a ``profiles/`` subdir and a default home."""
    root = tmp_path / "hermes-root"
    (root / "profiles").mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(root))
    return root


def _make_profile_home(root: Path, name: str, *, dsn: str = "") -> Path:
    """Write a named profile home with a minimal config (no DSN by default)."""
    home = root / "profiles" / name
    home.mkdir(parents=True, exist_ok=True)
    dsn_line = f"    dsn: {dsn}\n" if dsn else ""
    (home / "config.yaml").write_text(
        f"datastore:\n  supabase_app:\n{dsn_line}", encoding="utf-8"
    )
    return home


# -- _base_url_for: the routing-prefix invariant ---------------------------


def test_base_url_default_profile_has_no_prefix_even_when_served() -> None:
    # The default profile owns the single shared listener and serves the root;
    # there is no /p/default/ prefix under the one-gateway consolidation.
    assert _base_url_for("default", is_default=True, served=True) == ""


def test_base_url_secondary_profile_gets_path_prefix_when_served() -> None:
    assert _base_url_for("engineers", is_default=False, served=True) == "/p/engineers/"


def test_base_url_unserved_profile_is_unreachable() -> None:
    # A profile not in the multiplexed served set is not reachable through the
    # gateway at all — empty, not a guessed prefix.
    assert _base_url_for("engineers", is_default=False, served=False) == ""


# -- get_profile_registry: derived view over the served set ----------------


def test_registry_lists_default_and_named_profile_with_routing_and_schema(
    hermes_root: Path,
) -> None:
    _make_profile_home(hermes_root, "engineers")

    entries = get_profile_registry()
    by_name = {e.name: e for e in entries}

    assert set(by_name) == {"default", "engineers"}

    default = by_name["default"]
    assert default.is_default is True
    assert default.served is True
    assert default.base_url == ""  # owns the listener
    assert default.schema == app_schema("prod", profile="default")
    assert default.health == HEALTH_UNKNOWN  # no DB calls until probed

    engineers = by_name["engineers"]
    assert engineers.is_default is False
    assert engineers.served is True
    assert engineers.base_url == "/p/engineers/"
    assert engineers.schema == app_schema("prod", profile="engineers")
    assert engineers.health == HEALTH_UNKNOWN


def test_registry_holds_no_authority_data(hermes_root: Path) -> None:
    """The registry entry carries only routing/schema/health — never a role,
    enrolment or principal. That is the whole defence against the repo's
    "profiles are independent islands" rule: there is nothing here to keep in
    sync with each profile's principals table."""
    _make_profile_home(hermes_root, "hr")

    entry = next(e for e in get_profile_registry() if e.name == "hr")
    # Assert by absence of any authority-shaped field: the dataclass is the
    # contract, so a future field added here would be caught at the assertion.
    authority_fields = {"role", "principal", "user_id", "admins", "enrolment"}
    assert authority_fields.isdisjoint(entry.__dataclass_fields__)


# -- probe_registry_health: graceful degradation --------------------------


def test_probe_health_is_core_only_when_no_app_datastore(hermes_root: Path) -> None:
    # A profile whose config resolves no DSN is core-only (SQLite in its own
    # HERMES_HOME). It cannot host the principals table a console administers,
    # and the switcher must badge that before routing a turn there.
    _make_profile_home(hermes_root, "coreonly", dsn="")

    entries = {e.name: e for e in get_profile_registry()}
    probed = probe_registry_health(entries["coreonly"])
    assert probed.health == HEALTH_CORE_ONLY
    assert "no app datastore" in probed.health_detail


def test_probe_health_missing_home_is_unreachable() -> None:
    # A registry entry whose home directory no longer exists is unreachable;
    # the probe must not crash trying to read a config that isn't there.
    entry = ProfileRegistryEntry(
        name="ghost",
        hermes_home=Path("/nonexistent/hermes/profiles/ghost"),
        is_default=False,
        served=True,
        base_url="/p/ghost/",
        schema="app_prod_ghost",
        has_env=False,
        gateway_running=False,
    )
    probed = probe_registry_health(entry)
    assert probed.health == "unreachable"
    assert probed.health_detail == "profile home missing"


def test_projects_enrolment_fan_out_walks_the_registry_profile_set(
    hermes_root: Path,
) -> None:
    """Projects' shared-read fan-out iterates the same (name, home) set as the
    full registry — it just skips the per-profile config/skill/gateway reads."""
    from hermes_cli.projects_api import _profile_homes

    for name in ("engineers", "hr"):
        _make_profile_home(hermes_root, name)
    (hermes_root / "profiles" / "Not A Profile").mkdir()
    assert [(p.name, p.hermes_home) for p in _profile_homes()] == [
        (e.name, e.hermes_home) for e in get_profile_registry()
    ]
