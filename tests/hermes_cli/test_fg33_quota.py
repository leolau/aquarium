"""FG-33 P8-1 1.6 — quota policy, admission and the quotas router.

Invariants, not snapshots: the policy can only get stricter when its file is
untrustworthy; box-wide limits refuse everyone including the owner and name
the binding constraint; per-member limits ask for approval and the owner is
exempt; an admin cannot raise their own limits; every override write is a C5
change.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException

from hermes_cli import app_quota, quotas_api
from hermes_cli.access import Principal
from hermes_cli.app_quota import (
    AdmissionRequest,
    BoxUsage,
    MemberUsage,
    QuotaError,
    check_admission,
    effective_limits,
    load_policy,
)

OWNER = Principal(user_id="root", display="Root", role="owner")  # type: ignore[arg-type]
ADMIN = Principal(user_id="ann", display="Ann", role="admin")  # type: ignore[arg-type]
ADMIN2 = Principal(user_id="abe", display="Abe", role="admin")  # type: ignore[arg-type]
MEMBER = Principal(user_id="mia", display="Mia", role="member")  # type: ignore[arg-type]
VIEWER = Principal(user_id="tom", display="Tom", role="viewer")  # type: ignore[arg-type]

ROOMY = BoxUsage(
    apps_registered=0, slice_memory_mb=0.0, mem_available_mb=16000.0,
    storage_free_mb=50000.0, storage_path="/srv/apps",
)
EXAMPLE = Path(__file__).resolve().parents[2] / "deploy" / "install" / "app-quotas.yaml.example"


@pytest.fixture()
def policy():
    return load_policy(Path("/nonexistent/app-quotas.yaml"))


@pytest.fixture()
def as_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app_quota, "_ROOT_UID", os.getuid())


def _write(tmp_path: Path, data: dict, mode: int = 0o644) -> Path:
    path = tmp_path / "app-quotas.yaml"
    path.write_text(yaml.safe_dump(data))
    path.chmod(mode)
    return path


# ── policy file ────────────────────────────────────────────────────────────


def test_shipped_template_states_exactly_the_built_in_defaults(as_root) -> None:
    raw = yaml.safe_load(EXAMPLE.read_text())
    assert raw == app_quota.DEFAULT_POLICY


def test_decision_8_defaults(policy) -> None:
    limits = effective_limits("member", policy=policy)
    assert limits.per_member["apps_registered"] == 3
    assert limits.per_member["apps_running"] == 2
    assert limits.per_member["ram_mb"] == 1024
    assert limits.per_member["disk_mb"] == 4096
    assert limits.per_member["db_mb"] == 1024
    assert limits.per_app["memory_max_mb"] == 512
    assert limits.per_app["cpu_quota_pct"] == 50
    assert policy.section("box")["ceiling_mb"] == 6144
    assert policy.section("box")["reserved_mb"] == 3072


def test_trusted_root_file_overrides_defaults(tmp_path, as_root) -> None:
    path = _write(tmp_path, {"per_member": {"apps_running": 1}, "storage": {"base_path": "/srv/apps"}})
    policy = load_policy(path)
    assert policy.source == str(path)
    assert effective_limits("member", policy=policy).per_member["apps_running"] == 1
    assert app_quota.storage_base_path(policy) == Path("/srv/apps")


@pytest.mark.parametrize("mode", [0o666, 0o664, 0o646])
def test_writable_file_is_ignored_so_limits_cannot_be_loosened(tmp_path, as_root, mode) -> None:
    path = _write(tmp_path, {"per_member": {"apps_running": 99}}, mode)
    policy = load_policy(path)
    assert policy.source == "defaults" and policy.warnings
    assert effective_limits("member", policy=policy).per_member["apps_running"] == 2


def test_file_not_owned_by_root_is_ignored(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(app_quota, "_ROOT_UID", os.getuid() + 1)
    policy = load_policy(_write(tmp_path, {"per_member": {"apps_running": 99}}))
    assert effective_limits("member", policy=policy).per_member["apps_running"] == 2


def test_symlinked_policy_file_is_ignored(tmp_path, as_root) -> None:
    real = _write(tmp_path, {"per_member": {"apps_running": 99}})
    link = tmp_path / "link.yaml"
    link.symlink_to(real)
    assert effective_limits("member", policy=load_policy(link)).per_member["apps_running"] == 2


def test_bad_values_keep_defaults(tmp_path, as_root) -> None:
    path = _write(tmp_path, {
        "per_member": {"apps_running": -1, "ram_mb": "lots", "disk_mb": True},
        "storage": {"base_path": "/etc/aquarium"},
        "nonsense": {"x": 1},
    })
    policy = load_policy(path)
    limits = effective_limits("member", policy=policy)
    assert limits.per_member["apps_running"] == 2
    assert limits.per_member["ram_mb"] == 1024
    assert limits.per_member["disk_mb"] == 4096
    assert policy.section("storage")["base_path"] is None
    assert len(policy.warnings) >= 4


def test_unparsable_file_keeps_defaults(tmp_path, as_root) -> None:
    path = tmp_path / "q.yaml"
    path.write_text("per_member: [unclosed")
    path.chmod(0o644)
    assert load_policy(path).source == "defaults"


# ── admission ──────────────────────────────────────────────────────────────


def test_member_within_limits_needs_no_approval(policy) -> None:
    for action in app_quota.ACTIONS:
        result = check_admission(MEMBER, action, usage=MemberUsage(), box=ROOMY, policy=policy)
        assert result.verdict == "ok", (action, result.reason)


def test_viewer_is_refused(policy) -> None:
    result = check_admission(VIEWER, "create", usage=MemberUsage(), box=ROOMY, policy=policy)
    assert result.verdict == "refused" and result.constraint == "role"


def test_unknown_action_raises(policy) -> None:
    with pytest.raises(ValueError):
        check_admission(MEMBER, "delete", usage=MemberUsage(), box=ROOMY, policy=policy)


def test_third_running_app_needs_approval_but_dev_and_prod_share_a_slot(policy) -> None:
    usage = MemberUsage(registered=frozenset({"a", "b", "c"}), running=frozenset({"a", "b"}), ram_mb=300)
    third = check_admission(MEMBER, "start", usage=usage, box=ROOMY, policy=policy,
                            request=AdmissionRequest(tool="c"))
    assert third.verdict == "needs_approval"
    assert third.constraint == "per_member.apps_running"
    # the dev copy of an app whose prod copy already runs takes no new slot
    same = check_admission(MEMBER, "start", usage=usage, box=ROOMY, policy=policy,
                           request=AdmissionRequest(tool="a", memory_mb=200))
    assert same.verdict == "ok"


def test_fourth_registered_app_needs_approval_and_owner_is_exempt(policy) -> None:
    usage = MemberUsage(registered=frozenset({"a", "b", "c"}))
    member = check_admission(MEMBER, "create", usage=usage, box=ROOMY, policy=policy,
                             request=AdmissionRequest(tool="d"))
    assert member.verdict == "needs_approval"
    assert member.constraint == "per_member.apps_registered"
    owner = check_admission(OWNER, "create", usage=usage, box=ROOMY, policy=policy,
                            request=AdmissionRequest(tool="d"))
    assert owner.verdict == "ok"


def test_admin_gets_higher_defaults(policy) -> None:
    usage = MemberUsage(registered=frozenset({"a", "b", "c"}))
    assert check_admission(ADMIN, "create", usage=usage, box=ROOMY, policy=policy,
                           request=AdmissionRequest(tool="d")).verdict == "ok"


def test_member_ram_total_needs_approval(policy) -> None:
    usage = MemberUsage(running=frozenset({"a"}), ram_mb=600)
    result = check_admission(MEMBER, "start", usage=usage, box=ROOMY, policy=policy,
                             request=AdmissionRequest(tool="b"))
    assert result.verdict == "needs_approval" and result.constraint == "per_member.ram_mb"


def test_member_db_and_disk_totals_need_approval(policy) -> None:
    db = check_admission(MEMBER, "create", usage=MemberUsage(db_mb=800), box=ROOMY, policy=policy)
    assert db.constraint == "per_member.db_mb"
    disk = check_admission(MEMBER, "create", usage=MemberUsage(disk_mb=3000), box=ROOMY, policy=policy)
    assert disk.constraint == "per_member.disk_mb"


@pytest.mark.parametrize("principal", [MEMBER, OWNER])
def test_slice_ceiling_refuses_everyone_and_names_it(policy, principal) -> None:
    box = BoxUsage(apps_registered=1, slice_memory_mb=5800, mem_available_mb=16000,
                   storage_free_mb=50000)
    for action in ("start", "build", "promote"):
        result = check_admission(principal, action, usage=MemberUsage(), box=box, policy=policy)
        assert result.verdict == "refused"
        assert result.constraint == "aquarium.slice"
        assert "aquarium.slice" in result.reason


@pytest.mark.parametrize("principal", [MEMBER, OWNER])
def test_box_reserve_refuses_everyone(policy, principal) -> None:
    box = BoxUsage(apps_registered=1, slice_memory_mb=0, mem_available_mb=3300,
                   storage_free_mb=50000)
    result = check_admission(principal, "start", usage=MemberUsage(), box=box, policy=policy)
    assert result.verdict == "refused" and result.constraint == "box.reserved_mb"


def test_box_refusal_wins_over_member_approval(policy) -> None:
    usage = MemberUsage(running=frozenset({"a", "b"}))
    box = BoxUsage(apps_registered=2, slice_memory_mb=6000, mem_available_mb=16000,
                   storage_free_mb=50000)
    result = check_admission(MEMBER, "start", usage=usage, box=box, policy=policy,
                             request=AdmissionRequest(tool="c"))
    assert result.verdict == "refused"


def test_unmeasured_box_refuses_rather_than_admits(policy) -> None:
    unknown = BoxUsage()
    for action in ("create", "start", "build", "promote"):
        result = check_admission(OWNER, action, usage=MemberUsage(), box=unknown, policy=policy)
        assert result.verdict == "refused", action


def test_box_app_count_refuses_create(policy) -> None:
    box = BoxUsage(apps_registered=6, storage_free_mb=50000)
    result = check_admission(OWNER, "create", usage=MemberUsage(), box=box, policy=policy,
                             request=AdmissionRequest(tool="new"))
    assert result.verdict == "refused" and result.constraint == "box.apps_max"


def test_low_disk_at_storage_location_refuses(policy) -> None:
    box = BoxUsage(apps_registered=0, storage_free_mb=3000, storage_path="/srv/apps")
    result = check_admission(OWNER, "create", usage=MemberUsage(), box=box, policy=policy)
    assert result.verdict == "refused" and result.constraint == "storage"
    assert "/srv/apps" in result.reason
    ok = check_admission(OWNER, "create", usage=MemberUsage(), box=box, policy=policy,
                         box_overrides={"storage.min_free_mb": 100})
    assert ok.verdict == "ok"


def test_external_app_count(policy) -> None:
    result = check_admission(MEMBER, "provision-external", usage=MemberUsage(external_apps=5),
                             box=BoxUsage(), policy=policy)
    assert result.constraint == "per_member.external_apps"


def test_member_override_raises_and_unlimited_removes_a_limit(policy) -> None:
    usage = MemberUsage(running=frozenset({"a", "b"}))
    req = AdmissionRequest(tool="c", memory_mb=100)
    raised = check_admission(MEMBER, "start", usage=usage, box=ROOMY, policy=policy, request=req,
                             overrides={"per_member.apps_running": 3})
    assert raised.verdict == "ok"
    unlimited = effective_limits("member", policy=policy,
                                 overrides={"per_member.apps_running": "unlimited"})
    assert unlimited.per_member["apps_running"] is None


def test_probe_box_measures_free_space_at_the_configured_location(tmp_path, policy) -> None:
    box = app_quota.probe_box(apps_registered=0, policy=policy,
                              box_overrides={"storage.base_path": str(tmp_path / "not" / "yet")})
    assert box.storage_path == str(tmp_path / "not" / "yet")
    assert box.storage_free_mb is not None and box.storage_free_mb > 0
    assert box.mem_available_mb is not None


# ── override validation and authority ─────────────────────────────────────


@pytest.mark.parametrize("path", ["relative/x", "/etc/aquarium", "/proc/1", "/srv/../etc", "/", ""])
def test_storage_path_rejects_unsafe_locations(path) -> None:
    with pytest.raises(QuotaError):
        app_quota.validate_storage_path(path)


def test_box_ceilings_are_file_only() -> None:
    with pytest.raises(QuotaError):
        app_quota.validate_override("box.ceiling_mb", 99999, scope="box", actor_is_owner=True)
    with pytest.raises(QuotaError):
        app_quota.validate_override("storage.base_path", "/srv", scope="member", actor_is_owner=True)


def test_only_the_owner_may_set_unlimited() -> None:
    with pytest.raises(QuotaError):
        app_quota.validate_override("per_member.ram_mb", "unlimited", scope="member", actor_is_owner=False)
    assert app_quota.validate_override(
        "per_member.ram_mb", "unlimited", scope="member", actor_is_owner=True
    ) == "unlimited"


class _NoDB:
    mode = "prod"
    schema = "app_prod"

    async def connect(self):  # pragma: no cover - must never be reached
        raise AssertionError("a refused write must not touch the database")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "actor,target,role",
    [
        (MEMBER, MEMBER.user_id, "member"),
        (VIEWER, MEMBER.user_id, "member"),
        (MEMBER, app_quota.BOX, None),
        (ADMIN, ADMIN.user_id, "admin"),
        (ADMIN, ADMIN2.user_id, "admin"),
        (ADMIN, OWNER.user_id, "owner"),
    ],
)
async def test_no_self_escalation(actor, target, role) -> None:
    store = app_quota.QuotaStore(_NoDB())  # type: ignore[arg-type]
    with pytest.raises(PermissionError):
        await store.set_overrides(actor, target, {"per_member.apps_running": 9}, target_role=role)


# ── router ─────────────────────────────────────────────────────────────────


def test_every_quota_route_requires_owner_or_admin() -> None:
    routes = [r for r in quotas_api.router.routes if getattr(r, "path", "").startswith("/api/quotas")]
    assert {f"{sorted(r.methods)[0]} {r.path}" for r in routes} == {
        "GET /api/quotas/box", "PUT /api/quotas/box",
        "GET /api/quotas/{user_id}", "PUT /api/quotas/{user_id}",
        # P8-2 2.10 Settings panels
        "GET /api/quotas/defaults", "PUT /api/quotas/defaults",
        "GET /api/quotas/storage", "PUT /api/quotas/storage",
        "GET /api/quotas/github", "PUT /api/quotas/github", "DELETE /api/quotas/github",
    }
    for route in routes:
        roles = {getattr(d.dependency, "required_role", None) for d in route.dependencies}
        assert "admin" in roles, route.path


def _bind(monkeypatch, actor, principals):
    async def _resolve(request, *, allow_as=False):
        return actor

    class _PS:
        def __init__(self, store):
            pass

        async def get(self, user_id):
            return principals.get(user_id)

    monkeypatch.setattr("hermes_cli.web_server._comms_resolve_principal", _resolve, raising=False)
    monkeypatch.setattr("hermes_cli.web_server._comms_app_store", lambda: _NoDB(), raising=False)
    monkeypatch.setattr("hermes_cli.access.PrincipalStore", _PS)


@pytest.mark.asyncio
async def test_api_admin_cannot_raise_own_quota(monkeypatch) -> None:
    _bind(monkeypatch, ADMIN, {ADMIN.user_id: ADMIN})
    with pytest.raises(HTTPException) as excinfo:
        await quotas_api.put_user_quotas(
            ADMIN.user_id, quotas_api.QuotaUpdate(values={"per_member.ram_mb": 9000}), object()  # type: ignore[arg-type]
        )
    assert excinfo.value.status_code == 403


@pytest.mark.asyncio
async def test_api_unknown_user_is_404(monkeypatch) -> None:
    _bind(monkeypatch, OWNER, {})
    with pytest.raises(HTTPException) as excinfo:
        await quotas_api.put_user_quotas(
            "ghost", quotas_api.QuotaUpdate(values={"per_member.ram_mb": 1}), object()  # type: ignore[arg-type]
        )
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_api_bad_key_is_400_before_any_write(monkeypatch) -> None:
    _bind(monkeypatch, OWNER, {MEMBER.user_id: MEMBER})
    with pytest.raises(HTTPException) as excinfo:
        await quotas_api.put_user_quotas(
            MEMBER.user_id, quotas_api.QuotaUpdate(values={"box.ceiling_mb": 1}), object()  # type: ignore[arg-type]
        )
    assert excinfo.value.status_code == 400


# ── throwaway Postgres: writes are C5-recorded and read back ──────────────

_PG_IMAGE = (
    "pgvector/pgvector@sha256:"
    "1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb"
)


@pytest.fixture(scope="module")
def postgres_dsn() -> Iterator[str]:
    import asyncpg

    if shutil.which("docker") is None:
        pytest.skip("Docker is required for the quota store E2E test")
    if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
        pytest.skip("Docker daemon is unavailable")
    subprocess.run(["docker", "pull", _PG_IMAGE], check=True, capture_output=True)
    container = f"hermes-fg33q-{uuid.uuid4().hex[:12]}"
    subprocess.run(
        ["docker", "run", "--detach", "--rm", "--name", container,
         "--env", "POSTGRES_PASSWORD=hermes-test", "--env", "POSTGRES_DB=hermes_test",
         "--publish", "127.0.0.1::5432", _PG_IMAGE],
        check=True, capture_output=True, text=True,
    )
    try:
        port = subprocess.run(
            ["docker", "port", container, "5432/tcp"], check=True, capture_output=True, text=True
        ).stdout.strip().splitlines()[0].rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:hermes-test@127.0.0.1:{port}/hermes_test"

        async def _probe() -> None:
            conn = await asyncpg.connect(dsn, ssl=False)
            await conn.close()

        for _ in range(80):
            try:
                asyncio.run(_probe())
                break
            except (OSError, asyncpg.PostgresError):
                time.sleep(0.25)
        else:
            raise RuntimeError("Throwaway Postgres did not become ready")
        yield dsn
    finally:
        subprocess.run(["docker", "rm", "--force", container], capture_output=True)


@pytest.mark.asyncio
async def test_override_write_is_recorded_and_applied(postgres_dsn: str) -> None:
    import asyncpg

    from hermes_cli.datastore import get_store, initialize_supabase_app

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        await conn.execute("DROP SCHEMA IF EXISTS app_dev CASCADE; DROP SCHEMA IF EXISTS app_prod CASCADE;")
        await initialize_supabase_app(conn)
    finally:
        await conn.close()
    config = {"datastore": {"supabase_app": {"dsn": postgres_dsn}}}
    store = app_quota.QuotaStore(get_store("supabase-app", "prod", config=config), config=config)

    out = await store.set_overrides(ADMIN, MEMBER.user_id, {"per_member.apps_running": 3}, target_role="member")
    assert out["overrides"] == {"per_member.apps_running": 3}
    limits = await store.limits_for(MEMBER, policy=load_policy(Path("/nonexistent")))
    assert limits.per_member["apps_running"] == 3

    box = await store.set_overrides(OWNER, app_quota.BOX, {"storage.base_path": "/srv/apps"})
    assert box["overrides"] == {"storage.base_path": "/srv/apps"}

    removed = await store.set_overrides(OWNER, MEMBER.user_id, {"per_member.apps_running": None},
                                        target_role="member")
    assert removed["overrides"] == {}

    conn = await asyncpg.connect(postgres_dsn, ssl=False)
    try:
        changes = await conn.fetch(
            "SELECT actor_user_id, target_kind, inverse_op FROM app_prod.changes "
            "WHERE payload->>'user_id' IS NOT NULL ORDER BY ts"
        )
        rows = await conn.fetch("SELECT set_by, change_ref FROM app_prod.quota_overrides")
    finally:
        await conn.close()
    assert [c["actor_user_id"] for c in changes] == [ADMIN.user_id, OWNER.user_id, OWNER.user_id]
    assert {c["target_kind"] for c in changes} == {"config"}
    assert all(r["change_ref"] for r in rows) and {r["set_by"] for r in rows} == {OWNER.user_id}
