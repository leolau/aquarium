"""FG-33 P8-2 2.10: Settings -> App limits / App storage / GitHub token.

Invariants: the root helper's ``configure`` keeps APPS_BASE equal to the
storage base and owns the App limits file; admission reads where apps
really live; only the owner raises the admins' tier; the GitHub token never
reaches an argv, a response or the browser, and publishing is a no-op
without one.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import json
import os
import subprocess
from pathlib import Path

import pytest

from hermes_cli import app_quota, app_source_publish, quotas_api
from hermes_cli.access import Principal

REPO = Path(__file__).resolve().parents[2]
HELPER = REPO / "deploy" / "aquarium-app-helper"

OWNER = Principal(user_id="root", display="Root", role="owner")  # type: ignore[arg-type]
ADMIN = Principal(user_id="ann", display="Ann", role="admin")  # type: ignore[arg-type]
MEMBER = Principal(user_id="mia", display="Mia", role="member")  # type: ignore[arg-type]
TOKEN = "ghp_SECRETsecretSECRETsecret1234"


# --------------------------------------------------------------------------- root helper


@pytest.fixture
def h(tmp_path, monkeypatch):
    loader = importlib.machinery.SourceFileLoader("aquarium_app_helper_settings", str(HELPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    etc = tmp_path / "etc" / "aquarium"
    etc.mkdir(parents=True)
    monkeypatch.setattr(mod, "CONF_PATH", str(etc / "apps.conf"))
    monkeypatch.setattr(mod, "TRUSTED_UIDS", (0, os.getuid()))  # windows-footgun: ok — Linux root helper
    monkeypatch.setattr(mod, "FORBIDDEN_BASES", ("/etc", "/opt/data", "/proc"))
    (etc / "apps.conf").write_text(json.dumps({"storage_base": str(tmp_path / "srv" / "apps"),
                                               "tools_root": str(tmp_path / "tools")}))
    (etc / "aquarium.conf").write_text("# box settings\nDOMAIN=home.example\nAPPS_BASE=/old\n")
    os.chmod(etc / "aquarium.conf", 0o640)
    mod.ETC = etc
    mod.TMP = tmp_path
    return mod


def test_configure_moves_apps_base_with_storage_base(h):
    new = str(h.TMP / "vol" / "apps")
    out = h.cmd_configure(h.load_conf(), {"storage_base": new, "min_free_mb": 4096})
    assert out["storage_base"] == new and out["min_free_mb"] == 4096
    conf = (h.ETC / "aquarium.conf").read_text().splitlines()
    assert conf == ["# box settings", "DOMAIN=home.example", f"APPS_BASE={new}"]
    assert oct(os.stat(h.ETC / "aquarium.conf").st_mode & 0o777) == "0o640"
    assert json.loads((h.ETC / "apps.conf").read_text())["tools_root"].endswith("tools")
    assert h.load_conf()["min_free_mb"] == 4096


def test_configure_refuses_an_untrusted_aquarium_conf(h):
    os.chmod(h.ETC / "aquarium.conf", 0o666)
    with pytest.raises(h.HelperError, match="root-owned"):
        h.cmd_configure(h.load_conf(), {"storage_base": str(h.TMP / "vol" / "apps")})


def test_configure_writes_and_resets_limit_tiers(h):
    c = h.load_conf()
    h.cmd_configure(c, {"limits": {"member": {"per_member": {"apps_running": 1}},
                                   "admin": {"per_app": {"memory_max_mb": 768}}}})
    out = h.cmd_configure(c, {"limits": {"admin": None}})
    assert out["limits"] == {"member": {"per_member": {"apps_running": 1}}}
    assert json.loads((h.ETC / "app-limits.json").read_text()) == {"roles": out["limits"]}
    for bad in ({"root": {}}, {"member": {"per_app": {"nope": 1}}},
                {"member": {"per_app": {"disk_mb": -1}}}, {"member": {"per_app": {"disk_mb": True}}},
                {"member": {"box": {"apps_max": 1}}}, {}):
        with pytest.raises(h.InputError):
            h.cmd_configure(c, {"limits": bad})
    with pytest.raises(h.InputError):
        h.cmd_configure(c, {"min_free_mb": "lots"})


def test_helper_limit_keys_match_the_quota_policy(h):
    assert {s: set(k) for s, k in h.LIMIT_KEYS.items()} == {
        s: set(app_quota.DEFAULT_POLICY[s]) for s in ("per_app", "per_member")}


def test_sudoers_allows_configure_with_no_argument():
    rules = (REPO / "deploy" / "sudoers.d" / "aquarium-apps").read_text().splitlines()
    assert "hermes ALL=(root) NOPASSWD: /usr/local/sbin/aquarium-app-helper configure" in rules


# --------------------------------------------------------------------------- policy + storage


@pytest.fixture
def root_is_me(monkeypatch):
    monkeypatch.setattr(app_quota, "_ROOT_UID", os.getuid())  # windows-footgun: ok — Linux root helper


def _limits_file(tmp_path, roles, mode=0o644):
    path = tmp_path / "app-limits.json"
    path.write_text(json.dumps({"roles": roles}))
    os.chmod(path, mode)
    return path


def test_settings_limits_apply_over_the_policy(tmp_path, root_is_me):
    path = _limits_file(tmp_path, {"member": {"per_member": {"apps_running": 1}},
                                   "admin": {"per_member": {"apps_running": 7}}})
    policy = app_quota.load_policy(tmp_path / "missing.yaml", limits_path=path)
    assert app_quota.effective_limits("member", policy=policy).per_member["apps_running"] == 1
    assert app_quota.effective_limits("admin", policy=policy).per_member["apps_running"] == 7
    tiers = app_quota.tier_limits(policy)
    assert tiers["member"]["per_member"]["apps_registered"] == 3  # decision 8 default kept
    assert tiers["admin"]["per_member"]["apps_running"] == 7


def test_untrusted_limits_file_keeps_defaults(tmp_path, root_is_me):
    path = _limits_file(tmp_path, {"member": {"per_member": {"apps_running": 99}}}, mode=0o666)
    policy = app_quota.load_policy(tmp_path / "missing.yaml", limits_path=path)
    assert app_quota.effective_limits("member", policy=policy).per_member["apps_running"] == 2
    assert any("ignored" in w for w in policy.warnings)


def test_storage_location_follows_override_then_helper_then_policy(tmp_path):
    policy = app_quota.QuotaPolicy(data={**app_quota.DEFAULT_POLICY,
                                         "storage": {"base_path": "/srv/policy", "min_free_mb": 10}})
    helper = {"storage_base": "/srv/helper", "min_free_mb": 20}
    assert app_quota.storage_base_path(policy, {}, helper_conf={}) == Path("/srv/policy")
    assert app_quota.storage_base_path(policy, {}, helper_conf=helper) == Path("/srv/helper")
    assert app_quota.storage_base_path(policy, {"storage.base_path": "/srv/ov"},
                                       helper_conf=helper) == Path("/srv/ov")
    assert app_quota.min_free_mb(policy, {}, helper_conf=helper) == 20
    assert app_quota.min_free_mb(policy, {"storage.min_free_mb": 5}, helper_conf=helper) == 5


def test_read_helper_conf_needs_a_root_file(tmp_path, root_is_me):
    path = tmp_path / "apps.conf"
    path.write_text(json.dumps({"storage_base": "/srv/x"}))
    os.chmod(path, 0o644)
    assert app_quota.read_helper_conf(path)["storage_base"] == "/srv/x"
    os.chmod(path, 0o664)
    assert app_quota.read_helper_conf(path) == {}


def test_tier_edits_owner_both_admin_member_only():
    assert app_quota.may_edit_tier(OWNER, "admin") is None
    assert app_quota.may_edit_tier(ADMIN, "member") is None
    assert app_quota.may_edit_tier(ADMIN, "admin")
    assert app_quota.may_edit_tier(MEMBER, "member")


@pytest.mark.parametrize("bad", [
    {"viewer": {}}, {"member": {"per_app": {"nope": 1}}}, {"member": {"per_app": {"disk_mb": -1}}},
    {"member": {"per_app": {"memory_high_mb": 900, "memory_max_mb": 512}}}, {},
    {"member": {"per_app": {"cpu_quota_pct": 0}}}, {"admin": {"per_app": {"memory_max_mb": 99999}}},
])
def test_tier_limit_validation(bad):
    with pytest.raises(app_quota.QuotaError):
        app_quota.validate_tier_limits(bad)


def test_configure_helper_sends_json_on_stdin_and_surfaces_refusals():
    calls = []

    def runner(argv, stdin, timeout):
        calls.append((argv, json.loads(stdin)))
        return 1, json.dumps({"error": "apps already live under /srv", "refused": True}), ""

    with pytest.raises(app_quota.QuotaError, match="already live"):
        app_quota.configure_helper({"storage_base": "/srv/new"}, runner=runner)
    assert calls == [(["sudo", "-n", app_quota.APP_HELPER, "configure"], {"storage_base": "/srv/new"})]


def test_github_overrides_hold_a_reference_never_the_token():
    ok = app_quota.validate_override("github.credential", {"owner_user_id": "root", "name": "x"},
                                     scope="box", actor_is_owner=False)
    assert ok == {"owner_user_id": "root", "name": "x"}
    for key, bad in (("github.credential", {"owner_user_id": "root", "name": "x", "token": TOKEN}),
                     ("github.owner", "bad/owner"), ("github.use_box_git", "yes")):
        with pytest.raises(app_quota.QuotaError):
            app_quota.validate_override(key, bad, scope="box", actor_is_owner=True)
    with pytest.raises(app_quota.QuotaError):
        app_quota.validate_override("github.owner", "acme", scope="member", actor_is_owner=True)


# --------------------------------------------------------------------------- publishing


def _repo(tmp_path) -> Path:
    repo = tmp_path / "app"
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True, env=env)
    (repo / "README.md").write_text("hi\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True, env=env)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "init"], check=True, env=env)
    return repo


def test_publish_is_a_noop_without_a_token(tmp_path):
    def boom(*a, **k):
        raise AssertionError("must not run git or call GitHub")

    out = app_source_publish.publish("demo", tmp_path, settings=app_source_publish.GithubSettings(owner="acme"),
                                     token=None, git=boom, http=boom)
    assert out == {"published": False, "reason": "local-only"}


def test_publish_pushes_with_the_token_in_env_only(tmp_path):
    repo = _repo(tmp_path)
    remote = tmp_path / "gh" / "acme" / "aquarium-app-demo.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    seen = {}

    def git(argv, env, timeout):
        seen["argv"], seen["env"] = argv, env
        proc = subprocess.run(argv, env=dict(env), capture_output=True, text=True)
        return proc.returncode, proc.stdout, proc.stderr

    http_calls = []

    def http(method, url, token, body):
        http_calls.append((method, url))
        return 200, {}

    out = app_source_publish.publish(
        "demo", repo, settings=app_source_publish.GithubSettings(owner="acme"), token=TOKEN,
        git=git, http=http, web=f"file://{tmp_path / 'gh'}")
    assert out == {"published": True, "reason": "token", "repo": "acme/aquarium-app-demo"}
    assert not any(TOKEN in a for a in seen["argv"])
    assert TOKEN not in (repo / ".git" / "config").read_text()
    assert seen["env"]["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraheader"
    assert seen["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert http_calls == [("GET", "https://api.github.com/repos/acme/aquarium-app-demo")]
    log = subprocess.run(["git", "--git-dir", str(remote), "log", "--oneline", "main"],
                         capture_output=True, text=True, check=True).stdout
    assert "init" in log


def test_publish_scrubs_the_token_from_errors(tmp_path):
    repo = _repo(tmp_path)
    out = app_source_publish.publish(
        "demo", repo, settings=app_source_publish.GithubSettings(owner="acme"), token=TOKEN,
        git=lambda argv, env, t: (128, "", f"fatal: auth {TOKEN} rejected"),
        http=lambda *a: (200, {}))
    assert out["published"] is False and TOKEN not in out["error"]


def test_publish_creates_a_missing_repo_private_under_the_org(tmp_path):
    calls = []

    def http(method, url, token, body):
        calls.append((method, url, body))
        return {"GET": 404 if url.endswith("/repos/acme/aquarium-app-demo") else 200,
                "POST": 201}[method], {"login": "someone-else"}

    assert app_source_publish.ensure_repo("acme", "aquarium-app-demo", TOKEN, http=http) is None
    method, url, body = calls[-1]
    assert (method, url) == ("POST", "https://api.github.com/orgs/acme/repos")
    assert body["private"] is True


def test_token_status_shows_only_the_last_four():
    assert app_source_publish.token_status(TOKEN) == {"set": True, "last4": "1234"}
    assert app_source_publish.token_status(None) == {"set": False, "last4": None}


# --------------------------------------------------------------------------- HTTP routes


class _Cred:
    def __init__(self, owner, name, token):
        self.owner_user_id, self.name, self.payload = owner, name, {"token": token}


class _CredStore:
    def __init__(self):
        self.rows = {}

    async def put(self, principal, *, provider, name, kind, payload, **_):
        assert kind == "github-token"
        self.rows[(principal.user_id, name)] = payload["token"]

    async def delete(self, principal, provider, name):
        return self.rows.pop((principal.user_id, name), None) is not None

    async def resolve_by_kind(self, kind, *, provider):
        return [_Cred(o, n, t) for (o, n), t in self.rows.items()]


class _Quotas:
    box: dict = {}
    changes: list = []

    def __init__(self, store, **_):
        pass

    async def overrides_for(self, user_id):
        return dict(self.box)

    async def set_overrides(self, actor, user_id, values, *, target_role=None):
        denied = app_quota._may_edit(actor, user_id, target_role)
        if denied:
            raise PermissionError(denied)
        for k, v in values.items():
            v = app_quota.validate_override(k, v, scope="box", actor_is_owner=actor.is_owner)
            if v is None:
                self.box.pop(k, None)
            else:
                self.box[k] = v
        self.changes.append(values)
        return {"user_id": user_id, "overrides": dict(self.box), "change_ref": "chg_1"}

    async def record_settings_change(self, actor, **kw):
        self.changes.append(kw)
        return "chg_2"


@pytest.fixture
def api(monkeypatch):
    cred = _CredStore()
    _Quotas.box, _Quotas.changes = {}, []
    helper_calls = []
    state = {"actor": OWNER}

    async def resolve(request, *, allow_as=False):
        return state["actor"]

    monkeypatch.setattr("hermes_cli.web_server._comms_resolve_principal", resolve, raising=False)
    monkeypatch.setattr("hermes_cli.web_server._comms_app_store", lambda: object(), raising=False)
    monkeypatch.setattr(app_quota, "QuotaStore", _Quotas)
    monkeypatch.setattr("hermes_cli.credential_store.default_credential_store", lambda *a: cred)
    monkeypatch.setattr(app_quota, "configure_helper", lambda spec, **k: helper_calls.append(spec) or {})
    return state, cred, helper_calls


def _run(coro):
    return asyncio.run(coro)


def test_github_route_stores_the_token_by_reference_and_echoes_only_last4(api):
    state, cred, _ = api
    out = _run(quotas_api.put_github(quotas_api.GithubUpdate(owner="acme", token=TOKEN), None))
    assert TOKEN not in json.dumps(out) and TOKEN not in json.dumps(_Quotas.changes)
    assert out["token"] == {"set": True, "last4": "1234"} and out["mode"] == "token"
    assert _Quotas.box["github.credential"] == {"owner_user_id": "root", "name": "aquarium-apps"}
    assert cred.rows == {("root", "aquarium-apps"): TOKEN}
    out = _run(quotas_api.delete_github_token(None))
    assert out["token"] == {"set": False, "last4": None} and out["mode"] == "local-only"
    assert cred.rows == {}


def test_settings_writes_refuse_members(api):
    state, _, helper_calls = api
    state["actor"] = MEMBER
    for call in (lambda: quotas_api.put_github(quotas_api.GithubUpdate(owner="acme"), None),
                 lambda: quotas_api.put_storage(quotas_api.StorageUpdate(base_path="/srv/x"), None),
                 lambda: quotas_api.put_default_limits(
                     quotas_api.LimitsUpdate(limits={"member": {"per_member": {"apps_running": 1}}}), None)):
        with pytest.raises(quotas_api.HTTPException) as exc:
            _run(call())
        assert exc.value.status_code == 403
    assert helper_calls == [] and _Quotas.changes == []


def test_admin_cannot_raise_the_admin_tier(api):
    state, _, helper_calls = api
    state["actor"] = ADMIN
    with pytest.raises(quotas_api.HTTPException) as exc:
        _run(quotas_api.put_default_limits(
            quotas_api.LimitsUpdate(limits={"admin": {"per_member": {"apps_running": 9}}}), None))
    assert exc.value.status_code == 403 and helper_calls == []
    out = _run(quotas_api.put_default_limits(
        quotas_api.LimitsUpdate(limits={"member": {"per_member": {"apps_running": 1}}}), None))
    assert helper_calls == [{"limits": {"member": {"per_member": {"apps_running": 1}}}}]
    assert out["change_ref"] == "chg_2" and out["editable"] == {"member": True, "admin": False}


def test_storage_route_moves_the_helper_before_the_override(api):
    _, _, helper_calls = api
    out = _run(quotas_api.put_storage(quotas_api.StorageUpdate(base_path="/srv/apps2", min_free_mb=1024), None))
    assert helper_calls == [{"storage_base": "/srv/apps2", "min_free_mb": 1024}]
    assert out["base_path"] == "/srv/apps2" and out["min_free_mb"] == 1024
    with pytest.raises(quotas_api.HTTPException) as exc:
        _run(quotas_api.put_storage(quotas_api.StorageUpdate(base_path="/etc/apps"), None))
    assert exc.value.status_code == 400 and len(helper_calls) == 1


def test_a_helper_refusal_writes_no_override(api, monkeypatch):
    def refuse(spec, **_):
        raise app_quota.QuotaError("apps already live under /srv/apps")

    monkeypatch.setattr(app_quota, "configure_helper", refuse)
    with pytest.raises(quotas_api.HTTPException) as exc:
        _run(quotas_api.put_storage(quotas_api.StorageUpdate(base_path="/srv/apps2"), None))
    assert exc.value.status_code == 409 and _Quotas.box == {}
