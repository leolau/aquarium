"""Coverage for the WhatsApp bridge management API (owner-gated control
surface over the hermes-wa-bridge-* systemd units + session dirs). Route
functions are invoked directly with a stubbed owner principal; systemctl and
the filesystem are faked — no FastAPI TestClient, no systemd."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import hermes_cli.wa_bridge_api as api


class _FakeRequest:
    def __init__(self, body: dict | None = None):
        self._body = body or {}

    async def json(self):
        return self._body


OWNER = SimpleNamespace(user_id="leo", display="Leo", role="owner", is_owner=True)


@pytest.fixture
def wa_home(tmp_path, monkeypatch):
    wa = tmp_path / "whatsapp"
    wa.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    async def _as_owner(_request):
        return OWNER

    monkeypatch.setattr(api, "_caller", _as_owner)
    return wa


class _Proc:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def _mk_session(wa, name, creds=True, qr=False):
    d = wa / f"session-{name}"
    d.mkdir()
    if creds:
        (d / "creds.json").write_text("{}")
    if qr:
        (d / "qr.txt").write_text("2@pairing-payload")
    return d


def test_list_discovers_session_dirs(wa_home, monkeypatch):
    _mk_session(wa_home, "personal")
    _mk_session(wa_home, "connectar", qr=True)
    monkeypatch.setattr(
        api, "_is_active", lambda n: {"personal": "failed", "connectar": "active"}[n]
    )
    import asyncio

    out = asyncio.run(api.list_bridges(_FakeRequest()))
    by_name = {b["name"]: b for b in out["bridges"]}
    assert set(by_name) == {"personal", "connectar"}
    assert by_name["personal"]["paired"] is True
    assert by_name["personal"]["qr_pending"] is False
    assert by_name["connectar"]["qr_pending"] is True
    assert by_name["connectar"]["active"] == "active"


def test_get_qr_returns_payload(wa_home):
    _mk_session(wa_home, "personal", qr=True)
    import asyncio

    out = asyncio.run(api.get_qr(_FakeRequest(), "personal"))
    assert out["payload"] == "2@pairing-payload"
    assert out["stale"] is False


def test_get_qr_404_when_no_pending(wa_home):
    _mk_session(wa_home, "personal")
    import asyncio

    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.get_qr(_FakeRequest(), "personal"))
    assert exc.value.status_code == 404


def test_name_validation(wa_home):
    import asyncio

    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.stop_bridge(_FakeRequest(), "Bad Name!"))
    assert exc.value.status_code == 400


def test_rebind_moves_session_aside_and_restarts(wa_home, monkeypatch):
    sess = _mk_session(wa_home, "personal")
    calls = []
    monkeypatch.setattr(
        api, "_service_control", lambda n, v: calls.append((n, v))
    )
    import asyncio

    out = asyncio.run(api.rebind_bridge(_FakeRequest(), "personal"))
    assert calls == [("personal", "stop"), ("personal", "start")]
    # Old session moved aside, fresh empty dir created.
    assert sess.is_dir() and not any(sess.iterdir())
    backups = [d for d in wa_home.iterdir() if d.name.startswith("session-personal.rebind-")]
    assert len(backups) == 1
    assert (backups[0] / "creds.json").is_file()
    assert out["bridge"]["paired"] is False


def test_service_control_surfaces_failure(wa_home, monkeypatch):
    monkeypatch.setattr(
        api,
        "_systemctl",
        lambda *a, **k: _Proc(returncode=1, stderr="access denied"),
    )
    import asyncio

    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.stop_bridge(_FakeRequest(), "personal"))
    assert exc.value.status_code == 502
    assert "access denied" in exc.value.detail


def test_add_bridge_rejects_existing(wa_home, monkeypatch):
    _mk_session(wa_home, "personal")
    monkeypatch.setattr(api, "_is_active", lambda n: "active")
    import asyncio

    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.add_bridge(_FakeRequest({"name": "personal"})))
    assert exc.value.status_code == 409


def test_add_bridge_sudo_runs_root_owned_helper_not_checkout(wa_home, monkeypatch):
    """F14: the hermes user can write the checkout, so sudo must only ever run
    the fixed root-owned copy — never a path derived from this module's file."""
    import asyncio
    from pathlib import Path

    calls = []
    monkeypatch.setattr(api, "_bridge_names", lambda: [])
    monkeypatch.setattr(api, "_add_helper_installed", lambda: True)
    monkeypatch.setattr(api, "_is_active", lambda n: "active")
    monkeypatch.setattr(
        api.subprocess, "run", lambda cmd, **kw: calls.append(cmd) or _Proc()
    )

    asyncio.run(api.add_bridge(_FakeRequest({"name": "newphone"})))

    assert calls == [["sudo", "-n", "/usr/local/sbin/hermes-wa-bridge-add", "newphone"]]
    checkout = str(Path(api.__file__).resolve().parent.parent)
    assert not any(checkout in part for part in calls[0])


def test_add_bridge_reports_missing_root_helper(wa_home, monkeypatch):
    import asyncio

    monkeypatch.setattr(api, "_bridge_names", lambda: [])
    monkeypatch.setattr(api, "_add_helper_installed", lambda: False)
    monkeypatch.setattr(
        api.subprocess, "run",
        lambda *a, **k: pytest.fail("must not fall back to another helper"),
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(api.add_bridge(_FakeRequest({"name": "newphone"})))
    assert exc.value.status_code == 501
    assert "/usr/local/sbin/hermes-wa-bridge-add" in exc.value.detail
