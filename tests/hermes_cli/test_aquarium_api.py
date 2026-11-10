"""FG-35 aquarium: creature prefs, idle setting and name, snapshot aggregation + routes.

Real path: a throwaway box root with real per-profile ``state.db`` files and a
real projects DB; only the profile registry, the per-profile principal
directory and the principal resolver are replaced.
"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from hermes_cli.aquarium_creatures import (
    AQUARIUM_NAME_DEFAULT,
    AQUARIUM_NAME_MAX,
    CREATURES,
    IDLE_SECONDS_DEFAULT,
    IDLE_SECONDS_MAX,
    IDLE_SECONDS_MIN,
    fallback_creature,
    random_creature,
)

DEFAULTS = {"idle_seconds": IDLE_SECONDS_DEFAULT, "name": AQUARIUM_NAME_DEFAULT}
REPO = Path(__file__).resolve().parents[2]


def _person(user_id, display, role="member"):
    return SimpleNamespace(user_id=user_id, display=display, role=role, is_owner=role == "owner")


AMY = _person("amy", "Amy")
BEN = _person("ben", "Ben", "admin")


@pytest.fixture
def root(tmp_path, monkeypatch):
    root = tmp_path / "root"
    root.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("HERMES_PROJECTS_DB", str(root / "projects.db"))
    from hermes_cli import aquarium_api

    aquarium_api.invalidate_snapshot()
    yield root
    aquarium_api.invalidate_snapshot()


# -- creature list ------------------------------------------------------------


def test_creatures_are_unique_and_match_the_ui_list():
    import re

    ts = (REPO / "agent-home/src/lib/aquarium/creatures.ts").read_text(encoding="utf-8")
    block = ts.split("export const CREATURES = [", 1)[1].split("] as const", 1)[0]
    assert tuple(re.findall(r'\bid: "([a-z-]+)"', block)) == CREATURES
    assert len(set(CREATURES)) == len(CREATURES) == 40


def test_every_creature_has_a_sprite():
    sprites = REPO / "agent-home/public/aquarium/creatures"
    assert [c for c in CREATURES if not (sprites / f"{c}.webp").is_file()] == []


def test_fallback_stays_within_the_original_twenty():
    original = CREATURES[:20]
    picks = {fallback_creature(f"user-{i}") for i in range(2000)}
    assert picks == set(original)
    assert fallback_creature("amy") == fallback_creature("amy")


def test_random_creature_reaches_the_new_ids(monkeypatch):
    from hermes_cli import aquarium_creatures

    assert {random_creature() for _ in range(2000)} <= set(CREATURES)
    monkeypatch.setattr(aquarium_creatures.secrets, "choice", lambda seq: seq[-1])
    assert random_creature() == CREATURES[-1]
    assert random_creature() not in CREATURES[:20]


# -- creature preference -----------------------------------------------------


def test_creature_roundtrip_validation_and_fallback(root):
    from hermes_cli import user_prefs

    assert user_prefs.creature_for("amy") == (fallback_creature("amy"), False)
    assert user_prefs.creature_for("amy") == user_prefs.creature_for("amy")
    user_prefs.set_language("amy", "zh-Hant")
    assert user_prefs.set_creature("amy", "octopus") == "octopus"
    assert user_prefs.creature_for("amy") == ("octopus", True)
    assert user_prefs.get_language("amy") == "zh-Hant"
    for bad in ("kraken", "", None, 3, "Octopus"):
        with pytest.raises(ValueError):
            user_prefs.set_creature("amy", bad)
    assert user_prefs.get_creature("amy") == "octopus"


def test_a_hand_edited_unknown_creature_falls_back(root):
    from hermes_cli import user_prefs

    user_prefs._write("amy", {"creature": "kraken"})
    assert user_prefs.get_creature("amy") is None
    assert user_prefs.creature_for("amy") == (fallback_creature("amy"), False)


def test_random_assignment_only_fills_an_empty_slot(root):
    from hermes_cli import user_prefs

    assigned = user_prefs.assign_random_creature("amy")
    assert assigned in CREATURES
    assert user_prefs.creature_for("amy") == (assigned, True)
    user_prefs.set_creature("ben", "whale")
    assert user_prefs.assign_random_creature("ben") is None
    assert user_prefs.get_creature("ben") == "whale"


def test_random_assignment_never_raises(root, monkeypatch):
    from hermes_cli import user_prefs

    def _boom(*_a, **_k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(user_prefs, "_write", _boom)
    assert user_prefs.assign_random_creature("amy") is None


# -- idle setting -------------------------------------------------------------


def test_idle_seconds_default_bounds_and_hand_edits():
    from hermes_cli.aquarium_api import idle_seconds, set_idle_seconds

    assert idle_seconds({}) == IDLE_SECONDS_DEFAULT
    for bad in (0, IDLE_SECONDS_MIN - 1, IDLE_SECONDS_MAX + 1, "30", 30.0, True, None):
        assert idle_seconds({"aquarium": {"idle_seconds": bad}}) == IDLE_SECONDS_DEFAULT
        with pytest.raises(ValueError):
            set_idle_seconds({}, bad)
    config = {"aquarium": "junk"}
    for good in (IDLE_SECONDS_MIN, IDLE_SECONDS_MAX):
        assert set_idle_seconds(config, good) == good
        assert idle_seconds(config) == good
    assert config == {"aquarium": {"idle_seconds": IDLE_SECONDS_MAX}}


def test_name_default_trim_control_chars_and_hand_edits():
    from hermes_cli.aquarium_api import aquarium_name, set_aquarium_name

    assert aquarium_name({}) == AQUARIUM_NAME_DEFAULT
    config = {"aquarium": {"idle_seconds": 60}}
    assert set_aquarium_name(config, "  Reef Team  ") == "Reef Team"
    assert config == {"aquarium": {"idle_seconds": 60, "name": "Reef Team"}}
    assert set_aquarium_name(config, "Re\x00ef\x1b\u202e Te\x7fam\n") == "Reef Team"
    assert set_aquarium_name(config, "海底 🐙") == "海底 🐙"
    assert set_aquarium_name(config, "x" * AQUARIUM_NAME_MAX) == "x" * AQUARIUM_NAME_MAX
    assert set_aquarium_name(config, f"  {'y' * AQUARIUM_NAME_MAX}  ") == "y" * AQUARIUM_NAME_MAX
    assert aquarium_name(config) == "y" * AQUARIUM_NAME_MAX
    for blank in ("", "   ", "\t\n", "\x00\x01"):
        config["aquarium"]["name"] = "Reef"
        assert set_aquarium_name(config, blank) == AQUARIUM_NAME_DEFAULT
        assert "name" not in config["aquarium"]
        assert aquarium_name(config) == AQUARIUM_NAME_DEFAULT
    for bad in ("z" * (AQUARIUM_NAME_MAX + 1), None, 3, True, ["Reef"], {"n": 1}):
        with pytest.raises(ValueError):
            set_aquarium_name(config, bad)
        assert aquarium_name({"aquarium": {"name": bad}}) == AQUARIUM_NAME_DEFAULT
    assert config == {"aquarium": {"idle_seconds": 60}}
    assert aquarium_name({"aquarium": {"name": " Reef\x07 "}}) == "Reef"


# -- snapshot aggregation -----------------------------------------------------


def _entry(name, home):
    return SimpleNamespace(name=name, hermes_home=home, is_default=name == "default", served=True)


def _sessions(home: Path, rows):
    from hermes_state import SessionDB

    db = SessionDB(db_path=home / "state.db")
    db.close()
    import sqlite3

    conn = sqlite3.connect(home / "state.db")
    for sid, user_id, parent, started_at, t_in, t_out in rows:
        conn.execute(
            "INSERT INTO sessions (id, source, user_id, parent_session_id, started_at,"
            " input_tokens, output_tokens) VALUES (?, 'web', ?, ?, ?, ?, ?)",
            (sid, user_id, parent, started_at, t_in, t_out),
        )
    conn.commit()
    conn.close()


def _projects(rows, members):
    from hermes_cli import projects_db

    conn = projects_db.connect()
    for pid, owner, archived in rows:
        conn.execute(
            "INSERT INTO projects (id, slug, name, created_at, archived, owner_user_id)"
            " VALUES (?, ?, ?, 0, ?, ?)",
            (pid, pid, pid, archived, owner),
        )
    for pid, user_id in members:
        conn.execute(
            "INSERT INTO project_members (project_id, user_id, added_at) VALUES (?, ?, 0)",
            (pid, user_id),
        )
    conn.commit()
    conn.close()


@pytest.fixture
def box(root, monkeypatch):
    """Two profiles: ``default`` (Amy member, Ben admin) and ``hr`` (Amy, Cat;
    Dan suspended there and nowhere else)."""
    import hermes_constants
    from hermes_cli import access, profile_registry, web_server

    hr = root / "profiles" / "hr"
    hr.mkdir(parents=True)
    monkeypatch.setattr(
        profile_registry,
        "get_profile_registry",
        lambda: [_entry("default", root), _entry("hr", hr)],
    )
    principals = {
        root.resolve(): [AMY, BEN],
        hr.resolve(): [_person("amy", ""), _person("cat", "Cat")],
    }
    calls = {"list": 0}

    class _Store:
        def __init__(self, _app_store):
            pass

        async def list_principals(self, *, active=None, **_k):
            assert active is True
            calls["list"] += 1
            return list(principals[Path(hermes_constants.get_hermes_home()).resolve()])

    monkeypatch.setattr(access, "PrincipalStore", _Store)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    now = time.time()
    _sessions(
        root,
        [
            ("a1", "amy", None, now - 60, 100, 10),
            ("a1c", "amy", "a1", now - 30, 5, 1),
            ("a-old", "amy", None, now - 3 * 86400, 1000, 1000),
            ("b1", "ben", None, now - 60, 7, 3),
            ("x1", None, None, now, 999, 999),
        ],
    )
    _sessions(hr, [("h1", "amy", None, now - 10, 20, 2), ("c1", "cat", None, now - 10, 1, 1)])
    _projects(
        [("p1", "amy", 0), ("p2", "ben", 0), ("p3", "amy", 1)],
        [("p1", "amy"), ("p2", "amy"), ("p2", "cat"), ("p3", "ben")],
    )
    return SimpleNamespace(root=root, hr=hr, principals=principals, calls=calls)


def _by_id(snapshot):
    return {u["user_id"]: u for u in snapshot["users"]}


@pytest.mark.asyncio
async def test_snapshot_aggregates_every_profile(box):
    from hermes_cli import user_prefs
    from hermes_cli.aquarium_api import build_snapshot

    user_prefs.set_creature("ben", "whale")
    snap = await build_snapshot()
    assert snap["idle_seconds"] == IDLE_SECONDS_DEFAULT
    assert snap["name"] == AQUARIUM_NAME_DEFAULT
    assert abs(snap["generated_at"] - time.time()) < 60
    users = _by_id(snap)
    assert set(users) == {"amy", "ben", "cat"}

    amy = users["amy"]
    assert amy["name"] == "Amy"
    assert amy["creature"] == fallback_creature("amy")
    assert amy["metrics"] == {
        "chats": 3,
        "projects": 2,
        "tokens_in": 1125,
        "tokens_out": 1013,
        "tokens_24h": 138,
        "active_now": False,
    }
    assert [p["name"] for p in amy["profiles"]] == ["default", "hr"]

    ben = users["ben"]
    assert ben["creature"] == "whale"
    assert ben["metrics"]["projects"] == 1
    assert ben["metrics"]["tokens_24h"] == 10

    cat = users["cat"]
    assert [p["name"] for p in cat["profiles"]] == ["hr"]
    assert cat["metrics"]["chats"] == 1 and cat["metrics"]["projects"] == 1


@pytest.mark.asyncio
async def test_admins_also_get_the_default_profile(box):
    from hermes_cli.aquarium_api import build_snapshot

    box.principals[box.root.resolve()] = [AMY]
    box.principals[box.hr.resolve()] = [_person("cat", "Cat", "admin")]
    users = _by_id(await build_snapshot())
    assert [p["name"] for p in users["cat"]["profiles"]] == ["default", "hr"]
    assert [p["name"] for p in users["amy"]["profiles"]] == ["default"]


@pytest.mark.asyncio
async def test_active_now_follows_running_chat_turns(box, monkeypatch):
    from hermes_cli import web_server
    from hermes_cli.aquarium_api import build_snapshot

    monkeypatch.setattr(
        web_server,
        "_CHAT_RUNS",
        {
            "r1": {"session_id": "a1c", "profile": None, "done": False},
            "r2": {"session_id": "c1", "profile": "hr", "done": True},
            "r3": {"session_id": "b1", "profile": "hr", "done": False},
        },
    )
    users = _by_id(await build_snapshot())
    assert users["amy"]["metrics"]["active_now"] is True
    assert users["cat"]["metrics"]["active_now"] is False
    assert users["ben"]["metrics"]["active_now"] is False


@pytest.mark.asyncio
async def test_missing_databases_mean_zero_usage(root, monkeypatch):
    import hermes_constants
    from hermes_cli import access, profile_registry, web_server
    from hermes_cli.aquarium_api import build_snapshot

    monkeypatch.setattr(profile_registry, "get_profile_registry", lambda: [_entry("default", root)])

    class _Store:
        def __init__(self, _app_store):
            pass

        async def list_principals(self, **_k):
            return [AMY]

    monkeypatch.setattr(access, "PrincipalStore", _Store)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    amy = _by_id(await build_snapshot())["amy"]
    assert amy["metrics"] == {
        "chats": 0,
        "projects": 0,
        "tokens_in": 0,
        "tokens_out": 0,
        "tokens_24h": 0,
        "active_now": False,
    }
    assert not (Path(hermes_constants.get_hermes_home()) / "state.db").exists()


@pytest.mark.asyncio
async def test_a_profile_without_a_user_directory_is_skipped(box, monkeypatch):
    from hermes_cli import web_server
    from hermes_cli.aquarium_api import build_snapshot

    real = web_server._comms_app_store

    def _store():
        import hermes_constants

        if Path(hermes_constants.get_hermes_home()).resolve() == box.hr.resolve():
            raise RuntimeError("no datastore")
        return real()

    monkeypatch.setattr(web_server, "_comms_app_store", _store)
    assert set(_by_id(await build_snapshot())) == {"amy", "ben"}


@pytest.mark.asyncio
async def test_snapshot_is_cached_for_at_most_four_seconds(box, monkeypatch):
    from hermes_cli import aquarium_api

    assert aquarium_api.SNAPSHOT_TTL_SECONDS <= 4
    clock = {"now": 1000.0}
    monkeypatch.setattr(aquarium_api.time, "monotonic", lambda: clock["now"])
    first = await aquarium_api.cached_snapshot()
    assert box.calls["list"] == 2
    clock["now"] += aquarium_api.SNAPSHOT_TTL_SECONDS - 0.1
    assert await aquarium_api.cached_snapshot() is first
    assert box.calls["list"] == 2
    clock["now"] += 0.2
    assert await aquarium_api.cached_snapshot() is not first
    assert box.calls["list"] == 4
    aquarium_api.invalidate_snapshot()
    await aquarium_api.cached_snapshot()
    assert box.calls["list"] == 6


# -- routes -------------------------------------------------------------------


ROUTES = [
    ("GET", "/api/aquarium/snapshot", None),
    ("GET", "/api/aquarium/settings", None),
    ("PUT", "/api/aquarium/settings", {"idle_seconds": 60}),
    ("GET", "/api/me/creature", None),
    ("PUT", "/api/me/creature", {"creature": "octopus"}),
]


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": AMY, "subject": ""}

    async def _fake(request, *, allow_as=False):
        assert allow_as is False
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["subject"])
    return state


@pytest.fixture
def client(acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.mark.parametrize("method,path,body", ROUTES)
def test_routes_need_sign_in(root, method, path, body):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import app

    c = TestClient(app, raise_server_exceptions=False)
    assert c.request(method, path, json=body).status_code == 401


def test_snapshot_route_marks_only_the_caller(box, client, acting):
    users = _by_id(client.get("/api/aquarium/snapshot").json())
    assert [u for u in users if users[u]["is_self"]] == ["amy"]
    acting["as"] = BEN
    users = _by_id(client.get("/api/aquarium/snapshot").json())
    assert [u for u in users if users[u]["is_self"]] == ["ben"]


@pytest.mark.parametrize(
    "body", [{"idle_seconds": 60}, {"name": "Reef"}, {"idle_seconds": 60, "name": "Reef"}]
)
def test_a_member_reads_but_cannot_change_the_settings(root, client, acting, body):
    acting["subject"] = "amy-session"
    assert client.get("/api/aquarium/settings").json() == DEFAULTS
    r = client.put("/api/aquarium/settings", json=body)
    assert r.status_code == 403
    assert client.get("/api/aquarium/settings").json() == DEFAULTS


@pytest.mark.parametrize("who", [BEN, _person("own", "Own", "owner")])
def test_owner_and_admin_change_idle_seconds(root, client, acting, who):
    acting["as"], acting["subject"] = who, "session"
    r = client.put("/api/aquarium/settings", json={"idle_seconds": 120})
    assert r.status_code == 200 and r.json() == {**DEFAULTS, "idle_seconds": 120}
    acting["as"] = AMY
    assert client.get("/api/aquarium/settings").json() == {**DEFAULTS, "idle_seconds": 120}
    from hermes_cli.config import load_config

    assert load_config()["aquarium"]["idle_seconds"] == 120


def test_settings_put_takes_any_subset_and_returns_everything(root, client, acting):
    from hermes_cli.config import load_config

    acting["as"], acting["subject"] = BEN, "session"
    r = client.put("/api/aquarium/settings", json={"name": "  Reef Team "})
    assert r.status_code == 200 and r.json() == {**DEFAULTS, "name": "Reef Team"}
    r = client.put("/api/aquarium/settings", json={"idle_seconds": 90})
    assert r.json() == {"idle_seconds": 90, "name": "Reef Team"}
    r = client.put("/api/aquarium/settings", json={"idle_seconds": 45, "name": "Kelp"})
    assert r.json() == {"idle_seconds": 45, "name": "Kelp"}
    assert load_config()["aquarium"] == {"idle_seconds": 45, "name": "Kelp"}
    r = client.put("/api/aquarium/settings", json={"name": "   "})
    assert r.json() == {"idle_seconds": 45, "name": AQUARIUM_NAME_DEFAULT}
    assert "name" not in load_config()["aquarium"]
    acting["as"] = AMY
    assert client.get("/api/aquarium/settings").json() == {
        "idle_seconds": 45,
        "name": AQUARIUM_NAME_DEFAULT,
    }


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"other": 1},
        {"idle_seconds": 0},
        {"idle_seconds": IDLE_SECONDS_MIN - 1},
        {"idle_seconds": IDLE_SECONDS_MAX + 1},
        {"idle_seconds": "60"},
        {"idle_seconds": 6.5},
        {"idle_seconds": None},
        {"name": "n" * (AQUARIUM_NAME_MAX + 1)},
        {"name": None},
        {"name": 7},
        {"name": ["Reef"]},
        {"idle_seconds": 60, "name": 7},
        {"idle_seconds": 1, "name": "Reef"},
    ],
)
def test_bad_settings_are_400_and_save_nothing(root, client, acting, body):
    acting["as"], acting["subject"] = BEN, "session"
    r = client.put("/api/aquarium/settings", json=body)
    assert r.status_code == 400
    assert client.get("/api/aquarium/settings").json() == DEFAULTS


def test_a_renamed_aquarium_shows_in_the_next_snapshot(box, client, acting):
    assert client.get("/api/aquarium/snapshot").json()["name"] == AQUARIUM_NAME_DEFAULT
    acting["as"], acting["subject"] = BEN, "session"
    assert client.put("/api/aquarium/settings", json={"name": "Reef"}).status_code == 200
    acting["as"], acting["subject"] = AMY, ""
    snap = client.get("/api/aquarium/snapshot").json()
    assert snap["name"] == "Reef" and snap["idle_seconds"] == IDLE_SECONDS_DEFAULT


def test_creature_routes_act_only_on_the_caller(root, client, acting):
    from hermes_cli import user_prefs

    assert client.get("/api/me/creature").json() == {
        "creature": fallback_creature("amy"),
        "chosen": False,
    }
    r = client.put("/api/me/creature", json={"creature": "octopus", "user_id": "ben"})
    assert r.status_code == 200 and r.json() == {"creature": "octopus", "chosen": True}
    assert client.get("/api/me/creature").json() == {"creature": "octopus", "chosen": True}
    assert user_prefs.get_creature("ben") is None
    acting["as"] = BEN
    assert client.get("/api/me/creature").json()["chosen"] is False


@pytest.mark.parametrize("value", ["kraken", "", 3, None])
def test_unknown_creature_is_400(root, client, value):
    r = client.put("/api/me/creature", json={"creature": value})
    assert r.status_code == 400
    assert client.get("/api/me/creature").json()["chosen"] is False


def test_a_saved_creature_shows_in_the_next_snapshot(box, client, monkeypatch):
    first = _by_id(client.get("/api/aquarium/snapshot").json())["amy"]["creature"]
    pick = "narwhal" if first != "narwhal" else "crab"
    client.put("/api/me/creature", json={"creature": pick})
    assert _by_id(client.get("/api/aquarium/snapshot").json())["amy"]["creature"] == pick



# -- random creature at creation (channel auto-enrol, owner init) -------------


class _PairingStore:
    def __init__(self, fail=False):
        self.fail = fail
        self.enrolled = {}

    @property
    def _store(self):
        async def _connect():
            return SimpleNamespace(close=_noop)

        return SimpleNamespace(connect=_connect)

    async def resolve_by_channel(self, *_a, **_k):
        return None

    async def enroll(self, user_id, *, display, role, connection=None):
        self.enrolled[user_id] = SimpleNamespace(user_id=user_id, display=display, role=role, active=True)
        return self.enrolled[user_id]

    async def link_channel(self, *_a, **_k):
        return None

    async def get(self, user_id, connection=None):
        return self.enrolled.get(user_id)


async def _noop():
    return None


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_a_paired_channel_user_enrolled_on_first_contact_gets_a_creature(root, monkeypatch, fail):
    from hermes_cli import user_prefs
    from hermes_cli.access import resolve_principal

    if fail:
        monkeypatch.setattr(user_prefs, "_write", lambda *_a: (_ for _ in ()).throw(OSError("ro")))
    source = SimpleNamespace(platform="telegram", user_id="tg-1", user_name="Tia")
    principal = await resolve_principal(source, store=_PairingStore(), is_paired=lambda *_: True)
    assert principal.user_id == "tg-1"
    assert user_prefs.creature_for("tg-1")[1] is (not fail)


def test_owner_init_gives_the_owner_a_creature(root, monkeypatch):
    import argparse

    from hermes_cli import owner, user_prefs

    class _Store:
        async def get_owner(self):
            return None

        async def enroll(self, user_id, *, display, role):
            return SimpleNamespace(user_id=user_id, display=display, role=role)

    monkeypatch.setattr(owner, "_prod_store", _Store)
    assert owner.owner_init_command(argparse.Namespace(user_id="own-1", display="Own")) == 0
    assert user_prefs.creature_for("own-1")[1] is True
