"""FG-33: the app owner's tier and per-person limits travel to the root helper's start/restart."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from hermes_cli import access, app_quota, app_runtime


def test_start_and_restart_carry_only_well_formed_limits():
    client = app_runtime.HelperClient()
    spec = json.loads(client.helper_spec("restart", {"slug": "demo", "mode": "dev", "limits": {"memory_max_mb": 1024}}))
    assert spec["limits"] == {"memory_max_mb": 1024}
    assert "limits" not in json.loads(client.helper_spec("start", {"slug": "demo", "mode": "dev", "limits": None}))
    for bad in ({"disk_mb": 1}, {"cpu_quota_pct": "50"}, {"memory_max_mb": True}, [1]):
        with pytest.raises(ValueError):
            client.helper_spec("start", {"slug": "demo", "mode": "dev", "limits": bad})
    with pytest.raises(ValueError):
        client.helper_spec("stop", {"slug": "demo", "mode": "dev", "limits": {"memory_max_mb": 1024}})


def _owner(monkeypatch, principal, overrides, policy):
    class Principals:
        def __init__(self, store):
            pass

        async def get(self, user_id):
            return principal if principal and principal.user_id == user_id else None

    class Quotas:
        def __init__(self, store):
            pass

        async def limits_for(self, who):
            return app_quota.effective_limits(who.role, policy=policy, overrides=overrides)

    monkeypatch.setattr(access, "PrincipalStore", Principals)
    monkeypatch.setattr(app_quota, "QuotaStore", Quotas)
    monkeypatch.setattr("hermes_cli.datastore.get_store", lambda *a, **k: object())


def _policy(data):
    return app_quota.QuotaPolicy(data=data, source="test")


def test_admin_tier_and_per_person_overrides_reach_the_unit_limits(monkeypatch):
    policy = _policy({**app_quota.DEFAULT_POLICY, "roles": {"admin": {"per_app": {"cpu_quota_pct": 150}}}})
    alice = access.Principal(user_id="u-alice", display="Alice", role="admin")
    _owner(monkeypatch, alice, {"per_app.memory_max_mb": 1024}, policy)
    limits = asyncio.run(app_runtime.unit_limits(SimpleNamespace(name="notes", owner_user_id="u-alice")))
    assert limits["cpu_quota_pct"] == 150 and limits["memory_max_mb"] == 1024
    assert set(limits) <= set(app_runtime.UNIT_LIMIT_KEYS)


def test_unknown_owner_or_unreachable_store_leaves_the_helper_policy(monkeypatch):
    _owner(monkeypatch, None, {}, _policy(dict(app_quota.DEFAULT_POLICY)))
    assert asyncio.run(app_runtime.unit_limits(SimpleNamespace(name="notes", owner_user_id="u-x"))) is None
    assert asyncio.run(app_runtime.unit_limits(SimpleNamespace(name="notes", owner_user_id=None))) is None

    def boom(*a, **k):
        raise RuntimeError("no database")

    monkeypatch.setattr("hermes_cli.datastore.get_store", boom)
    assert asyncio.run(app_runtime.unit_limits(SimpleNamespace(name="notes", owner_user_id="u-x"))) is None
