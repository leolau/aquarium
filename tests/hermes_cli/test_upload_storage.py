"""Low-storage warning for unlimited uploads.

Uploads have no default size cap, so the owner is warned when the disk that
holds uploaded files (the Supabase storage volume) runs low: in
``aquarium doctor``, and via ``/api/capacity/upload-storage`` for agent-home.
"""

from __future__ import annotations

from collections import namedtuple
from types import SimpleNamespace

import pytest

from hermes_cli import capacity

_Usage = namedtuple("_Usage", "total used free")
GB = 1024**3


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "home"))
    (tmp_path / "home").mkdir()
    monkeypatch.setenv("AQUARIUM_ROOT", str(tmp_path / "root"))
    return tmp_path


def _disk(monkeypatch, total_gb: float, free_gb: float):
    seen = []

    def fake(path):
        seen.append(path)
        return _Usage(int(total_gb * GB), int((total_gb - free_gb) * GB), int(free_gb * GB))

    monkeypatch.setattr(capacity.shutil, "disk_usage", fake)
    return seen


def test_path_prefers_config_then_supabase_volume_then_hermes_home(tmp_path):
    assert capacity.upload_storage_path({}) == tmp_path / "home"
    volume = tmp_path / "root" / "supabase" / "docker" / "volumes" / "storage"
    volume.mkdir(parents=True)
    assert capacity.upload_storage_path({}) == volume
    assert capacity.upload_storage_path(
        {"capacity": {"upload_storage_path": "/srv/uploads"}}
    ).as_posix() == "/srv/uploads"


def test_plenty_of_room_is_not_low(monkeypatch):
    _disk(monkeypatch, total_gb=100, free_gb=40)
    storage = capacity.collect_upload_storage({})
    assert storage.measured and not storage.low
    assert storage.warning() is None


def test_below_ten_percent_is_low(monkeypatch):
    _disk(monkeypatch, total_gb=500, free_gb=30)  # 6% free, but above 5 GB
    storage = capacity.collect_upload_storage({})
    assert storage.low
    assert "30.0 GB free of 500 GB" in storage.warning()


def test_below_five_gb_is_low_even_on_a_small_disk(monkeypatch):
    _disk(monkeypatch, total_gb=20, free_gb=4)  # 20% free, but under 5 GB
    assert capacity.collect_upload_storage({}).low


def test_thresholds_come_from_config_yaml(monkeypatch):
    _disk(monkeypatch, total_gb=500, free_gb=30)
    config = {"capacity": {"upload_min_free_pct": 0.05, "upload_min_free_gb": 10}}
    assert not capacity.collect_upload_storage(config).low
    # The path key is a string, not a threshold: it must not be warned about.
    assert capacity.CapacityThresholds.from_config(
        {"capacity": {"upload_storage_path": "/x"}}
    ) == capacity.CapacityThresholds()


def test_missing_configured_path_measures_its_nearest_existing_parent(monkeypatch, tmp_path):
    seen = _disk(monkeypatch, total_gb=100, free_gb=50)
    missing = tmp_path / "not" / "there"
    storage = capacity.collect_upload_storage(
        {"capacity": {"upload_storage_path": str(missing)}}
    )
    assert storage.measured
    assert seen == [str(tmp_path)]


def test_unreadable_disk_is_unmeasured_not_an_error(monkeypatch):
    def boom(path):
        raise OSError("nope")

    monkeypatch.setattr(capacity.shutil, "disk_usage", boom)
    storage = capacity.collect_upload_storage({})
    assert not storage.measured and not storage.low
    assert storage.as_dict()["free_bytes"] is None


def test_doctor_warns_when_low(monkeypatch, capsys):
    from hermes_cli import doctor

    _disk(monkeypatch, total_gb=100, free_gb=2)
    doctor._check_upload_storage({})
    out = capsys.readouterr().out
    assert "Upload storage is running low" in out


def test_doctor_says_ok_when_there_is_room(monkeypatch, capsys):
    from hermes_cli import doctor

    _disk(monkeypatch, total_gb=100, free_gb=60)
    doctor._check_upload_storage({})
    assert "Upload storage has room" in capsys.readouterr().out


@pytest.fixture
def client(monkeypatch, tmp_path):
    from starlette.testclient import TestClient

    import hermes_state
    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    member = SimpleNamespace(user_id="a1", display="Mia", role="member", is_owner=False)

    async def _fake_principal(request, *, allow_as=False):
        return member

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    monkeypatch.setattr(app.state, "auth_required", False, raising=False)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def test_endpoint_reports_free_space_and_low_flag(client, monkeypatch):
    _disk(monkeypatch, total_gb=100, free_gb=3)
    resp = client.get("/api/capacity/upload-storage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["free_bytes"] == 3 * GB
    assert body["total_bytes"] == 100 * GB
    assert body["min_free_bytes"] == 10 * GB
    assert body["low"] is True


def test_endpoint_requires_a_session(monkeypatch, tmp_path):
    from starlette.testclient import TestClient
    from fastapi import HTTPException

    import hermes_state
    from hermes_cli import web_server
    from hermes_cli.web_server import app

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")

    async def _deny(request, *, allow_as=False):
        raise HTTPException(status_code=401, detail="unauthenticated")

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _deny)
    resp = TestClient(app).get("/api/capacity/upload-storage")
    assert resp.status_code == 401
