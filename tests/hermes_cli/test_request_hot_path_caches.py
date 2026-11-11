"""Per-request setup the dashboard now does once per home / per db file.

The hot read paths used to redo ``ensure_hermes_home`` (mkdir + chmod pass),
``Path.resolve()`` of every profile home, ``SessionDB`` schema setup and the
login / refresh provider round-trip on the event loop on every request. These
pin down the caches against real temp homes and real SQLite files, including
the isolation invariants: every context still resolves its own profile's
``HERMES_HOME`` and config, a removed home or replaced db is set up again, and
card counts stay principal-scoped.
"""

from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import pytest

import hermes_state
from hermes_cli import config as config_mod
from hermes_constants import (
    reset_hermes_home_override,
    resolve_path_cached,
    set_hermes_home_override,
)

PROFILES = ("alpha", "beta", "gamma")


@pytest.fixture
def homes(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setattr(config_mod, "_ENSURED_HOMES", {})
    out = {"default": root}
    for name in PROFILES:
        home = root / "profiles" / name
        home.mkdir(parents=True)
        out[name] = home
    for name, home in out.items():
        (home / "config.yaml").write_text(f"model:\n  default: model-{name}\n")
    return out


def _count_ensures(monkeypatch) -> list[Path]:
    calls: list[Path] = []
    real = config_mod.ensure_hermes_home

    def counting():
        calls.append(config_mod.get_hermes_home())
        real()

    monkeypatch.setattr(config_mod, "ensure_hermes_home", counting)
    return calls


def _in_home(home: Path, fn):
    token = set_hermes_home_override(home)
    try:
        return fn()
    finally:
        reset_hermes_home_override(token)


def test_config_reads_set_up_each_home_once(homes, monkeypatch):
    calls = _count_ensures(monkeypatch)
    for _ in range(5):
        for home in homes.values():
            _in_home(home, config_mod.load_config_readonly)
    assert sorted(calls) == sorted(homes.values())
    for home in homes.values():
        assert (home / "sessions").is_dir() and (home / "logs").is_dir()


def test_removed_home_is_set_up_again(homes, monkeypatch, tmp_path):
    import shutil

    calls = _count_ensures(monkeypatch)
    alpha = homes["alpha"]
    _in_home(alpha, config_mod.load_config_readonly)
    shutil.rmtree(alpha)
    _in_home(alpha, config_mod.load_config_readonly)
    assert calls == [alpha, alpha]
    assert (alpha / "sessions").is_dir()


def test_explicit_ensure_hermes_home_still_runs_every_time(homes):
    beta = homes["beta"]
    _in_home(beta, config_mod.load_config_readonly)
    (beta / "cron").rmdir()
    # Hot reads trust the per-process setup; setup/save paths do not.
    _in_home(beta, config_mod.load_config_readonly)
    assert not (beta / "cron").exists()
    _in_home(beta, config_mod.ensure_hermes_home)
    assert (beta / "cron").is_dir()


def test_concurrent_profiles_each_get_their_own_home_and_config(homes, monkeypatch):
    from hermes_cli.datastore import active_profile_slug
    from hermes_cli.profiles import get_active_profile_name

    calls = _count_ensures(monkeypatch)
    barrier = threading.Barrier(len(homes) * 2)

    def worker(name: str):
        def body():
            barrier.wait()
            seen = []
            for _ in range(50):
                cfg = config_mod.load_config_readonly()
                seen.append((
                    get_active_profile_name(),
                    cfg["model"]["default"],
                    config_mod.get_hermes_home(),
                    active_profile_slug(),
                ))
            return seen

        return name, _in_home(homes[name], body)

    with ThreadPoolExecutor(len(homes) * 2) as pool:
        results = list(pool.map(worker, list(homes) * 2))
    for name, seen in results:
        assert {s[:3] for s in seen} == {(name, f"model-{name}", homes[name])}
        assert len({s[3] for s in seen}) == 1
    # Every home was set up, none was skipped. Racing first reads may set a
    # home up more than once; that is the idempotent full pass, not a leak.
    assert set(calls) == set(homes.values())


def test_resolve_path_cached_does_not_cache_missing_paths(tmp_path):
    target = tmp_path / "later"
    assert resolve_path_cached(target) == target.resolve()
    real = tmp_path / "real"
    real.mkdir()
    target.symlink_to(real)
    assert resolve_path_cached(target) == real.resolve()


# ---------------------------------------------------------------------------
# SessionDB schema setup
# ---------------------------------------------------------------------------


@pytest.fixture
def schema_calls(monkeypatch):
    monkeypatch.setattr(hermes_state, "_SCHEMA_READY", {})
    calls: list[str] = []
    real = hermes_state.SessionDB._init_schema

    def counting(self):
        calls.append(str(self.db_path))
        return real(self)

    monkeypatch.setattr(hermes_state.SessionDB, "_init_schema", counting)
    return calls


def _open(path: Path):
    db = hermes_state.SessionDB(db_path=path)
    try:
        return db._fts_enabled, [s["id"] for s in db.list_sessions_rich()]
    finally:
        db.close()


def test_session_db_schema_runs_once_per_file(tmp_path, schema_calls):
    a, b = tmp_path / "a" / "state.db", tmp_path / "b" / "state.db"
    a.parent.mkdir()
    b.parent.mkdir()
    db = hermes_state.SessionDB(db_path=a)
    db.create_session("only-in-a", "cli")
    db.close()
    for _ in range(5):
        assert _open(a)[1] == ["only-in-a"]
        assert _open(b)[1] == []
    assert sorted(schema_calls) == sorted([str(a), str(b)])


def test_concurrent_first_opens_share_one_schema_setup(tmp_path, schema_calls):
    path = tmp_path / "state.db"
    barrier = threading.Barrier(16)

    def worker(_):
        barrier.wait()
        return _open(path)

    with ThreadPoolExecutor(16) as pool:
        results = list(pool.map(worker, range(16)))
    assert schema_calls == [str(path)]
    assert len({r[0] for r in results}) == 1


def test_replaced_or_migrated_db_reruns_schema(tmp_path, schema_calls):
    path = tmp_path / "state.db"
    _open(path)
    _open(path)
    assert len(schema_calls) == 1

    # Another process rewinds the data version: the migration must run again.
    conn = sqlite3.connect(path)
    conn.execute("UPDATE schema_version SET version = version - 1")
    conn.commit()
    conn.close()
    _open(path)
    assert len(schema_calls) == 2

    # A replaced file (new inode) is set up from scratch.
    path.unlink()
    for suffix in ("-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    _open(path)
    assert len(schema_calls) == 3
    _open(path)
    assert len(schema_calls) == 3


# ---------------------------------------------------------------------------
# Card rollup: counted in SQL, same principal scoping as list_tasks
# ---------------------------------------------------------------------------


def test_card_rollup_matches_list_tasks_for_every_principal(tmp_path, monkeypatch):
    from hermes_cli import kanban_db, projects_api
    from hermes_cli.access import Principal, private

    monkeypatch.setenv("HERMES_KANBAN_DB", str(tmp_path / "kanban.db"))
    owner = Principal(user_id="leo", display="Leo", role="owner")  # type: ignore[arg-type]
    ada = Principal(user_id="ada", display="Ada", role="member")  # type: ignore[arg-type]
    vic = Principal(user_id="vic", display="Vic", role="member")  # type: ignore[arg-type]
    statuses = ["running", "blocked", "done", "archived", "todo", "review", "scheduled"]
    visibilities = ["shared", private("ada"), private("vic")]
    with kanban_db.connect_closing() as conn:
        for i in range(36):
            task_id = kanban_db.create_task(conn, title=f"card {i}")
            with kanban_db.write_txn(conn):
                conn.execute(
                    "UPDATE tasks SET status = ?, visibility = ?, project_id = ?"
                    " WHERE id = ?",
                    (statuses[i % len(statuses)], visibilities[i % 3],
                     "p1" if i % 4 else "p2", task_id),
                )

        def reference(project_id, principal):
            tasks = kanban_db.list_tasks(
                conn, project_id=project_id, principal=principal,
                include_archived=True, resolve_project=False,
            )
            live = [t for t in tasks if t.status != "archived"]
            return {
                "total": len(live),
                "done": sum(t.status == "done" for t in live),
                "running": sum(t.status == "running" for t in live),
                "blocked": sum(t.status == "blocked" for t in live),
                "scheduled": sum(t.status == "scheduled" for t in live),
                "total_with_archived": len(tasks),
                "total_all_principals": len(kanban_db.list_tasks(
                    conn, project_id=project_id, include_archived=True,
                    resolve_project=False,
                )),
            }

        rollups = {}
        for project_id in ("p1", "p2", "missing"):
            for principal in (None, owner, ada, vic):
                got = projects_api._card_rollup_sync(conn, project_id, principal)
                assert got == reference(project_id, principal)
                rollups[(project_id, principal and principal.user_id)] = got
    # Sanity: the scoping is actually exercised.
    assert rollups[("p1", "ada")]["total_with_archived"] < rollups[("p1", "leo")][
        "total_with_archived"
    ]
    assert rollups[("p1", "ada")] != rollups[("p1", "vic")]


# ---------------------------------------------------------------------------
# Login / refresh provider calls run off the event loop
# ---------------------------------------------------------------------------


def _off_loop() -> bool:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return True
    return False


def test_login_and_refresh_provider_calls_run_off_the_event_loop():
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth import clear_providers, register_provider
    from hermes_cli.dashboard_auth.routes import _reset_password_rate_limit
    from tests.hermes_cli.test_dashboard_auth_password_login import PasswordProvider

    delay = 0.3
    seen: list[tuple[str, bool]] = []

    class SlowProvider(PasswordProvider):
        def complete_password_login(self, **kwargs):
            seen.append(("login", _off_loop()))
            time.sleep(delay)
            return super().complete_password_login(**kwargs)

        def refresh_session(self, **kwargs):
            seen.append(("refresh", _off_loop()))
            time.sleep(delay)
            return super().refresh_session(**kwargs)

    provider = SlowProvider(ttl=0)
    clear_providers()
    register_provider(provider)
    _reset_password_rate_limit()
    state = web_server.app.state
    prev = {k: getattr(state, k, None) for k in ("auth_required", "bound_host", "bound_port")}
    state.auth_required, state.bound_host, state.bound_port = True, "fly-app.fly.dev", 443

    async def scenario():
        transport = httpx.ASGITransport(app=web_server.app)
        base = "https://fly-app.fly.dev"
        body = {"provider": "testpw", "username": "admin", "password": "hunter2"}
        clients = [httpx.AsyncClient(transport=transport, base_url=base) for _ in range(3)]
        try:
            started = time.monotonic()
            logins = await asyncio.gather(
                *(c.post("/auth/password-login", json=body) for c in clients)
            )
            login_elapsed = time.monotonic() - started
            assert [r.status_code for r in logins] == [200] * 3
            provider._ttl = 3600
            started = time.monotonic()
            mes = await asyncio.gather(*(c.get("/api/auth/me") for c in clients))
            refresh_elapsed = time.monotonic() - started
            assert [r.status_code for r in mes] == [200] * 3
            assert {r.json()["user_id"] for r in mes} == {"admin"}
            return login_elapsed, refresh_elapsed
        finally:
            for c in clients:
                await c.aclose()

    try:
        login_elapsed, refresh_elapsed = asyncio.run(scenario())
    finally:
        clear_providers()
        _reset_password_rate_limit()
        for k, v in prev.items():
            setattr(state, k, v)
    assert {kind for kind, _ in seen} == {"login", "refresh"}
    assert all(off for _, off in seen), seen
    # Serialised on the loop these would take >= 3 * delay each.
    assert login_elapsed < 2.5 * delay
    assert refresh_elapsed < 2.5 * delay
