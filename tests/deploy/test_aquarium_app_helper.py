"""deploy/aquarium-app-helper (FG-33 P8-1 1.2): the root helper for local apps.

The helper is imported from its file and pointed at a temp world: every fixed
path is redirected into tmp_path and its SAFE_PATH holds fake ``systemctl``,
``caddy``, ``journalctl`` and ``systemd-run``, so nothing touches systemd,
Caddy or real users. The units, slices and sudoers file are checked as text
(and with ``visudo -c`` when available).
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy"
HELPER = DEPLOY / "aquarium-app-helper"
SHA = "6521184d6ce3d21eefc9b120fc67be96ca790796"

FAKES = {
    # `systemctl show` answers from $W/active (one unit name per line = active).
    "systemctl": """#!/bin/sh
echo "systemctl $*" >> "$W/calls"
if [ "$1" = show ]; then
  if grep -qx "$2" "$W/active" 2>/dev/null; then echo ActiveState=active; echo SubState=running;
  else echo ActiveState=inactive; echo SubState=dead; fi
  [ "$2" = aquarium.slice ] && echo "MemoryCurrent=$(cat "$W/slice_mem" 2>/dev/null || echo 0)"
fi
exit 0
""",
    "caddy": "#!/bin/sh\necho \"caddy $*\" >> \"$W/calls\"\n[ -e \"$W/caddy_bad\" ] && { echo bad >&2; exit 1; }\nexit 0\n",
    "journalctl": "#!/bin/sh\necho \"journalctl $*\" >> \"$W/calls\"\necho 'line one'\n",
    "systemd-run": "#!/bin/sh\necho \"systemd-run $*\" >> \"$W/calls\"\n",
}


def load_helper():
    loader = importlib.machinery.SourceFileLoader("aquarium_app_helper", str(HELPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.fixture
def h(tmp_path, monkeypatch):
    mod = load_helper()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    monkeypatch.setenv("W", str(tmp_path))
    real_run = mod.run

    def run(cmd, timeout=60, **kw):  # keep $W visible to the fakes
        kw.setdefault("capture_output", True)
        kw.setdefault("text", True)
        return subprocess.run(cmd, timeout=timeout, env={"PATH": mod.SAFE_PATH, "W": str(tmp_path)}, **kw)

    assert real_run
    monkeypatch.setattr(mod, "run", run)
    monkeypatch.setattr(mod, "SAFE_PATH", f"{bin_dir}:/usr/bin:/bin")
    for attr, sub in {
        "CONF_PATH": "etc/aquarium/apps.conf", "QUOTA_PATH": "etc/aquarium/app-quotas.yaml",
        "ETC_APPS": "etc/aquarium/apps", "UNIT_DIR": "etc/systemd/system",
        "RUN_UNIT_DIR": "run/systemd/system", "RUN_DIR": "run/aquarium-apps",
        "CADDYFILE": "etc/caddy/Caddyfile", "CADDY_DIR": "etc/caddy/apps.d",
        "PROC_MEMINFO": "proc/meminfo", "AGENT_HOME_ENV": "etc/aquarium/agent-home.env",
    }.items():
        monkeypatch.setattr(mod, attr, str(tmp_path / sub))
    monkeypatch.setattr(mod, "PROC_NET_TCP", (str(tmp_path / "proc/net/tcp"),))
    monkeypatch.setattr(mod, "TRUSTED_UIDS", (0, os.getuid()))
    monkeypatch.setattr(mod, "FORBIDDEN_BASES", ("/etc", "/opt/data", "/proc"))
    (tmp_path / "proc/net").mkdir(parents=True)
    (tmp_path / "proc/meminfo").write_text("MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n")
    (tmp_path / "etc/aquarium").mkdir(parents=True)
    (tmp_path / "etc/systemd/system").mkdir(parents=True)
    base = tmp_path / "srv" / "apps"
    (tmp_path / "etc/aquarium/apps.conf").write_text(json.dumps({
        "storage_base": str(base), "tools_root": str(tmp_path / "tools")}))
    mod.W = tmp_path
    mod.BASE = base
    return mod


def conf(h):
    return h.load_conf()


def calls(h):
    path = h.W / "calls"
    return path.read_text() if path.exists() else ""


def fake_release(h, slug, mode, sha=SHA):
    rel = h.BASE / slug / "releases" / f"{mode}-{sha}"
    (rel / ".next" / "cache").mkdir(parents=True)
    (rel / "server.js").write_text("// built\n")
    (h.BASE / slug / mode).symlink_to(f"releases/{mode}-{sha}")
    return rel


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize("slug", ["../etc", "a/b", "Demo", "-x", "x-", "a--b", "", "a" * 41, "a b", "1app", None, 5])
def test_rejects_bad_slugs(h, slug):
    with pytest.raises(h.InputError):
        h.cmd_allocate(conf(h), {"slug": slug, "mode": "dev"})


def test_rejects_unknown_mode_and_fields(h):
    with pytest.raises(h.InputError):
        h.cmd_allocate(conf(h), {"slug": "demo", "mode": "staging"})
    with pytest.raises(h.InputError, match="unknown field"):
        h.cmd_allocate(conf(h), {"slug": "demo", "mode": "dev", "port": 22})


def test_prod_build_requires_approval_ref(h):
    with pytest.raises(h.InputError, match="approval_ref"):
        h.cmd_build(conf(h), {"slug": "demo", "mode": "prod", "sha": SHA})
    with pytest.raises(h.InputError, match="sha"):
        h.cmd_build(conf(h), {"slug": "demo", "mode": "dev", "sha": "HEAD"})


def test_main_refuses_extra_argv_and_non_root(h, monkeypatch, capsys):
    monkeypatch.setattr(h.os, "geteuid", lambda: 0)
    assert h.main(["start", "demo"], stdin=io.StringIO("")) == 2
    assert h.main(["idle-check", "demo-prod"], stdin=io.StringIO("")) == 2
    monkeypatch.setattr(h.os, "geteuid", lambda: 1000)
    assert h.main(["status"], stdin=io.StringIO("{}")) == 1
    assert "root" in capsys.readouterr().out


def test_in_unit_entry_points_refuse_root(h, monkeypatch, capsys):
    monkeypatch.setattr(h.os, "geteuid", lambda: 0)
    assert h.main(["run-app"]) == 1
    assert h.main(["build-run"]) == 1
    assert "never as root" in capsys.readouterr().err


# --------------------------------------------------------------------------- ports + env


def test_allocate_picks_ports_per_mode_and_reuses_them(h):
    c = conf(h)
    dev = h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    prod = h.cmd_allocate(c, {"slug": "demo", "mode": "prod"})
    other = h.cmd_allocate(c, {"slug": "other", "mode": "prod"})
    assert 4500 <= dev["port"] <= 4699 and 4300 <= prod["port"] <= 4499
    assert other["port"] != prod["port"]
    assert h.cmd_allocate(c, {"slug": "demo", "mode": "prod"})["port"] == prod["port"]
    assert dev["base_path"] == "/apps-dev/demo" and prod["base_path"] == "/apps/demo"
    env = h.W / "etc/aquarium/apps/demo/prod.env"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    text = env.read_text()
    assert f"PORT={prod['port']}" in text and "HOSTNAME=127.0.0.1" in text and "APP_BASE_PATH=/apps/demo" in text


# --------------------------------------------------------------------------- secrets + drop-in


@pytest.mark.parametrize("name", ["DATABASE_URL", "DATABASE_URL_RO", "NEXT_PUBLIC_KEY", "PORT", "APP_MODE",
                                  "NODE_OPTIONS", "LD_PRELOAD", "lower", "../X"])
def test_set_secret_refuses_reserved_and_bad_names(h, name):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    with pytest.raises(h.InputError):
        h.cmd_set_secret(c, {"slug": "demo", "mode": "dev", "name": name, "value": "x"})


def test_set_secret_writes_0600_and_never_echoes_value(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    doc = h.cmd_set_secret(c, {"slug": "demo", "mode": "dev", "name": "STRIPE_KEY", "value": "sk_live_zzz"})
    assert doc["secret_names"] == ["STRIPE_KEY"] and "sk_live_zzz" not in json.dumps(doc)
    f = h.W / "etc/aquarium/apps/demo/dev/STRIPE_KEY"
    assert f.read_text() == "sk_live_zzz" and stat.S_IMODE(f.stat().st_mode) == 0o600
    h.cmd_set_secret(c, {"slug": "demo", "mode": "dev", "name": "STRIPE_KEY", "delete": True})
    assert not f.exists()


def test_set_secret_accepts_the_runtime_managed_mcp_token(h):
    # hermes_cli/app_runtime.py AppRuntime.allocate delivers the app's MCP bearer this way.
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    doc = h.cmd_set_secret(c, {"slug": "demo", "mode": "dev", "name": "APP_MCP_TOKEN", "value": "tok"})
    assert doc["secret_names"] == ["APP_MCP_TOKEN"]
    with pytest.raises(h.InputError):
        h.cmd_set_secret(c, {"slug": "demo", "mode": "dev", "name": "APP_TICKET_KEY", "value": "x"})


def test_start_delivers_the_app_db_dsns_and_its_own_ticket_key(h):
    import hashlib
    import hmac
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    fake_release(h, "demo", "dev")
    etc = h.W / "etc/aquarium/apps/demo"
    # what `aquarium apps db create demo dev` (deploy/aquarium.py) writes
    for kind in ("owner", "rw", "ro"):
        (etc / f"db-dev-{kind}.dsn").write_text(f"postgresql://{kind}@127.0.0.1:54331/x\n")
    (h.W / "etc/aquarium/agent-home.env").write_text("PORT=3100\nAGENT_HOME_APPS_TICKET_SECRET=master-secret\n")
    h.cmd_start(c, {"slug": "demo", "mode": "dev"})
    dropin = (h.W / "etc/systemd/system/aquarium-app@demo-dev.service.d/10-instance.conf").read_text()
    assert f"LoadCredential=DATABASE_URL:{etc}/db-dev-rw.dsn" in dropin
    assert f"LoadCredential=DATABASE_URL_RO:{etc}/db-dev-ro.dsn" in dropin
    assert "owner.dsn" not in dropin and "postgresql://" not in dropin
    key = (etc / "ticket-dev.key")
    want = hmac.new(b"master-secret", b"aquarium-app-ticket/v1/demo/dev", hashlib.sha256).hexdigest()
    assert key.read_text() == want and stat.S_IMODE(key.stat().st_mode) == 0o600
    assert f"LoadCredential=APP_TICKET_KEY:{key}" in dropin and "master-secret" not in dropin


def test_run_app_strips_the_trailing_newline_of_credential_files(h, tmp_path, monkeypatch):
    creds = tmp_path / "creds"
    creds.mkdir()
    (creds / "DATABASE_URL").write_text("postgresql://x/y\n")
    seen = {}
    monkeypatch.setattr(h.os, "execve", lambda path, argv, env: seen.update(env))
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(creds))
    h.cmd_run_app()
    assert seen["DATABASE_URL"] == "postgresql://x/y"


def test_start_writes_instance_dropin_pinning_release_and_credentials(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "prod"})
    with pytest.raises(h.InputError, match="build first"):
        h.cmd_start(c, {"slug": "demo", "mode": "prod"})
    rel = fake_release(h, "demo", "prod")
    h.cmd_set_secret(c, {"slug": "demo", "mode": "prod", "name": "MY_KEY", "value": "v"})
    h.cmd_start(c, {"slug": "demo", "mode": "prod"})
    dropin = (h.W / "etc/systemd/system/aquarium-app@demo-prod.service.d/10-instance.conf").read_text()
    assert f"TemporaryFileSystem={h.BASE}:ro" in dropin
    assert f"BindReadOnlyPaths={rel}\n" in dropin and f"WorkingDirectory={rel}\n" in dropin
    assert "LoadCredential=MY_KEY:" in dropin and "\nv\n" not in dropin
    assert re.search(r"^User=aqapp-[0-9a-f]{16}$", dropin, re.M)
    log = calls(h)
    assert "systemctl enable --quiet aquarium-app@demo-prod.service" in log
    assert "systemctl start aquarium-app@demo-prod.service" in log


def test_each_instance_gets_its_own_dynamic_user(h):
    names = {h.dynamic_user("aqapp", i) for i in ("a-dev", "a-prod", "b-dev")}
    assert len(names) == 3 and all(len(n) <= 31 for n in names)


def test_dev_start_arms_idle_timer_and_is_not_enabled(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    fake_release(h, "demo", "dev")
    h.cmd_start(c, {"slug": "demo", "mode": "dev"})
    log = calls(h)
    assert "enable" not in log
    assert "systemd-run --unit=aquarium-app-idle-demo-dev" in log and "idle-check demo-dev" in log


def test_idle_check_stops_dev_after_idle_window(h, monkeypatch):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    (h.W / "active").write_text("aquarium-app@demo-dev.service\n")
    state = h.W / "run/aquarium-apps"
    state.mkdir(parents=True, exist_ok=True)
    (state / "demo-dev.idle.json").write_text(json.dumps({"last_activity": 0}))
    assert h.cmd_idle_check(c, "demo-dev")["idle"] == "stopped"
    assert "systemctl stop aquarium-app@demo-dev.service" in calls(h)
    with pytest.raises(h.InputError):
        h.cmd_idle_check(c, "demo-prod")


def test_established_counts_only_connections_to_the_port(h):
    (h.W / "proc/net/tcp").write_text(
        "  sl  local_address rem_address   st\n"
        "   0: 0100007F:1194 0100007F:D431 01 0\n"
        "   1: 0100007F:1194 00000000:0000 0A 0\n"
        "   2: 0100007F:1195 0100007F:D432 01 0\n")
    assert h._established(0x1194) == 1


# --------------------------------------------------------------------------- admission


def test_admission_refuses_past_slice_ceiling_and_box_reserve(h):
    (h.W / "slice_mem").write_text(str(6 * 1024 ** 3 - 100 * 1024 ** 2))
    with pytest.raises(h.Refused, match="6 GB"):
        h.admit(h.START_REQUEST, "start")
    (h.W / "slice_mem").write_text("0")
    (h.W / "proc/meminfo").write_text("MemAvailable: 3200000 kB\n")
    with pytest.raises(h.Refused, match="reserve"):
        h.admit(h.START_REQUEST, "start")
    (h.W / "etc/aquarium/app-quotas.yaml").write_text("box:\n  reserved_mb: 1024\nper_member:\n  reserved_mb: 99999\n")
    h.admit(h.START_REQUEST, "start")


def test_build_refuses_when_disk_is_short(h, monkeypatch):
    c = conf(h)
    monkeypatch.setattr(h, "free_bytes", lambda p: 10 * 1024 ** 2)
    with pytest.raises(h.Refused, match="free"):
        h.cmd_build(c, {"slug": "demo", "mode": "dev", "sha": SHA})


def test_build_refuses_while_the_slot_is_held(h):
    c = conf(h)
    with h.flock("build.lock"):
        pid = os.fork()
        if pid == 0:
            try:
                h.cmd_build(c, {"slug": "demo", "mode": "dev", "sha": SHA})
                os._exit(0)
            except h.Refused:
                os._exit(3)
            except BaseException:
                os._exit(1)
        _, status = os.waitpid(pid, 0)
    assert os.WEXITSTATUS(status) == 3


def test_existing_release_is_reused_without_building(h):
    c = conf(h)
    rel = h.BASE / "demo" / "releases" / f"dev-{SHA}"
    rel.mkdir(parents=True)
    doc = h.cmd_build(c, {"slug": "demo", "mode": "dev", "sha": SHA})
    assert doc["built"] is False and doc["release"] == f"dev-{SHA}"
    assert "aquarium-app-build@" not in calls(h)


# --------------------------------------------------------------------------- front door


def test_route_block_has_forward_auth_and_csp(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "prod"})
    (h.W / "etc/caddy").mkdir(parents=True)
    (h.W / "etc/caddy/Caddyfile").write_text("home.example {\n\timport /etc/caddy/apps.d/*.caddy\n}\n")
    doc = h.cmd_route(c, {"slug": "demo", "mode": "prod"})
    assert doc["routed"] and doc["front_door"] == "ok"
    text = (h.W / "etc/caddy/apps.d/aquarium-demo-prod.caddy").read_text()
    assert "path /apps/demo /apps/demo/*" in text
    assert text.index("request_header -X-Aquarium-Principal") < text.index("forward_auth 127.0.0.1:3100")
    assert text.index("forward_auth") < text.index("reverse_proxy 127.0.0.1:")
    assert "uri /api/apps/auth?slug=demo&mode=prod" in text and "Content-Security-Policy" in text
    # the front-door contract of agent-home/deploy/Caddyfile.agent-home (item 1.5)
    assert 'header_up X-Aquarium-App "demo/prod"' in text
    assert text.index("forward_auth") < text.index("request_header Cookie") < text.index("reverse_proxy")
    assert "connect-src https://{host}/apps/demo https://{host}/apps/demo/;" in text
    assert "frame-ancestors 'none'" in text and "-Service-Worker-Allowed" in text
    assert "agent_home_session_refused=; Max-Age=0" in text
    # both the __Host- session cookie and its legacy name (agent-home session.ts)
    assert 'request_header Cookie "(^|;\\s*)(__Host-)?agent_home_session=[^;]*" ""' in text
    assert 'Set-Cookie "(?i)^\\s*(__Host-)?agent_home_session=.*$"' in text
    assert "caddy validate" in calls(h) and "systemctl reload caddy" in calls(h)


@pytest.mark.parametrize("mutate", [
    lambda t: t.replace("\t\tforward_auth 127.0.0.1:3100 {\n", "\t\tbasicauth {\n"),
    lambda t: t.replace("/api/apps/auth?", "/login?"),
    lambda t: t.replace("\t\trequest_header -X-Aquarium-Principal\n", "\t\treverse_proxy 127.0.0.1:1\n"),
    lambda t: "".join(ln for ln in t.splitlines(True) if "X-Aquarium-App" not in ln),
    lambda t: "".join(ln for ln in t.splitlines(True) if "request_header Cookie" not in ln),
    lambda t: t.replace("(__Host-)?agent_home_session=[^;]*", "agent_home_session=[^;]*"),
])
def test_block_without_forward_auth_is_refused(h, mutate):
    c = conf(h)
    with pytest.raises(h.HelperError, match="refusing"):
        h.check_caddy_block(mutate(h.caddy_block(c, "demo", "prod", 4300)), c)


def test_route_rolls_back_when_caddy_validate_fails(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    (h.W / "etc/caddy").mkdir(parents=True)
    (h.W / "etc/caddy/Caddyfile").write_text("x\n")
    (h.W / "caddy_bad").write_text("1")
    with pytest.raises(h.HelperError, match="validate"):
        h.cmd_route(c, {"slug": "demo", "mode": "dev"})
    assert not (h.W / "etc/caddy/apps.d/aquarium-demo-dev.caddy").exists()
    assert "reload caddy" not in calls(h)


# --------------------------------------------------------------------------- remove / configure / logs


def test_remove_needs_confirmation_then_clears_instance(h):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "dev"})
    fake_release(h, "demo", "dev")
    with pytest.raises(h.Refused, match="confirm"):
        h.cmd_remove(c, {"slug": "demo", "mode": "dev"})
    with pytest.raises(h.Refused):
        h.cmd_remove(c, {"slug": "demo", "mode": "dev", "confirm": "other"})
    assert h.cmd_remove(c, {"slug": "demo", "mode": "dev", "confirm": "demo"})["removed"]
    assert not (h.BASE / "demo").exists()
    assert not (h.W / "etc/aquarium/apps/demo/dev.env").exists()


def test_configure_validates_and_refuses_moving_live_apps(h):
    c = conf(h)
    for bad in ("relative/path", "/etc/apps", "/opt/data/x", "/", "/srv/../etc"):
        with pytest.raises(h.InputError):
            h.cmd_configure(c, {"storage_base": bad})
    new = str(h.W / "vol" / "apps")
    assert h.cmd_configure(c, {"storage_base": new})["storage_base"] == new
    c = conf(h)
    (Path(new) / "demo").mkdir(parents=True)
    with pytest.raises(h.Refused, match="already live"):
        h.cmd_configure(c, {"storage_base": str(h.W / "vol2")})


def test_conf_writable_by_others_is_refused(h):
    os.chmod(h.CONF_PATH, 0o666)
    with pytest.raises(h.HelperError, match="root-owned"):
        h.load_conf()


def test_logs_are_capped(h):
    c = conf(h)
    with pytest.raises(h.InputError):
        h.cmd_logs(c, {"slug": "demo", "mode": "dev", "lines": 10_000})
    doc = h.cmd_logs(c, {"slug": "demo", "mode": "dev", "lines": 5, "build": True})
    assert doc["unit"] == "aquarium-app-build@demo-dev.service" and "line one" in doc["lines"]


def test_status_all_reports_enabled_instances_that_are_down(h, monkeypatch):
    c = conf(h)
    h.cmd_allocate(c, {"slug": "demo", "mode": "prod"})
    real = h.show
    monkeypatch.setattr(h, "show", lambda unit, *p: {**real(unit, *p), "UnitFileState": "enabled"})
    doc = h.cmd_status(c, {"all": True})
    assert doc["problems"] == ["aquarium-app@demo-prod.service is inactive (dead)"]


# --------------------------------------------------------------------------- archive safety


def _tar(entries):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for info, data in entries:
            tar.addfile(info, io.BytesIO(data) if data is not None else None)
    buf.seek(0)
    return buf


def _file(name, data=b"x", mode=0o644):
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), mode
    return info, data


def _link(name, target, kind=tarfile.SYMTYPE):
    info = tarfile.TarInfo(name)
    info.type, info.linkname = kind, target
    return info, None


@pytest.mark.parametrize("entries", [
    [_file("../evil")],
    [_file("/etc/evil")],
    [_link("l", "/etc")],
    [_link("l", "../../x")],
    [_link("d", "sub"), _file("d/x")],
    [_link("h", "server.js", tarfile.LNKTYPE)],
    [_link("dev", "", tarfile.CHRTYPE)],
    [_file("a"), _file("a")],
])
def test_safe_extract_rejects_escapes(h, tmp_path, entries):
    dest = tmp_path / "out"
    dest.mkdir()
    with pytest.raises(h.InputError):
        h.safe_extract(_tar(entries), str(dest), 10 ** 6)
    assert not (tmp_path / "evil").exists()


def test_safe_extract_strips_special_bits_and_keeps_inner_links(h, tmp_path):
    dest = tmp_path / "out"
    dest.mkdir()
    h.safe_extract(_tar([_file("bin/run", b"#!", 0o4755), _file("a/b.txt"), _link("a/c", "b.txt")]),
                   str(dest), 10 ** 6)
    assert stat.S_IMODE((dest / "bin/run").stat().st_mode) == 0o755
    assert (dest / "a/c").is_symlink() and (dest / "a/c").read_text() == "x"
    with pytest.raises(h.InputError, match="too large"):
        h.safe_extract(_tar([_file("big", b"x" * 100)]), str(tmp_path / "out2"), 10)


# --------------------------------------------------------------------------- units, slices, sudoers


def _unit(name):
    return (DEPLOY / name).read_text()


def test_app_units_are_never_hermes_named():
    for path in DEPLOY.glob("aquarium*"):
        assert not path.name.startswith("hermes-")
    deploy = (DEPLOY / "hermes-deploy.sh").read_text()
    assert "list-unit-files 'hermes-*.service'" in deploy
    assert "aquarium-app@" not in re.search(r"^UNITS=.*?^VERIFY_UNITS=.*?$", deploy, re.S | re.M).group(0)


def test_service_units_never_include_app_instances(monkeypatch):
    loader = importlib.machinery.SourceFileLoader("aquarium_cli_mod", str(DEPLOY / "aquarium.py"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    aq = importlib.util.module_from_spec(spec)
    loader.exec_module(aq)
    enabled = ["hermes-gateway.service", "aquarium-app@demo-prod.service", "app-mcp.service"]
    monkeypatch.setattr(aq, "enabled_units", lambda pat: [u for u in enabled if re.fullmatch(
        pat.replace(".", r"\.").replace("*", ".*"), u)])
    monkeypatch.setattr(aq, "bridge_units", lambda: [])
    assert not [u for u in aq.service_units() if u.startswith("aquarium-app")]


def test_app_unit_hardening_and_limits():
    text = _unit("aquarium-app@.service")
    for line in ("DynamicUser=yes", "Slice=aquarium-apps.slice", "MemoryHigh=384M", "MemoryMax=512M",
                 "CPUQuota=50%", "CPUWeight=20", "TasksMax=128", "ProtectSystem=strict", "ProtectHome=yes",
                 "PrivateTmp=yes", "PrivateDevices=yes", "NoNewPrivileges=yes", "UMask=0077",
                 "SystemCallFilter=@system-service", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
                 "IPAddressDeny=any", "IPAddressAllow=localhost", "Restart=on-failure", "StartLimitBurst=5"):
        assert re.search(rf"^{re.escape(line)}$", text, re.M), line
    inaccessible = re.search(r"^InaccessiblePaths=(.*)$", text, re.M).group(1)
    for path in ("/opt/data", "/etc/aquarium", "/var/run/docker.sock", "/root"):
        assert f"-{path}" in inaccessible.split()
    assert "ExecStart=/usr/bin/python3 -I /usr/local/sbin/aquarium-app-helper run-app" in text


def test_build_unit_runs_in_build_slice_without_loopback():
    text = _unit("aquarium-app-build@.service")
    for line in ("DynamicUser=yes", "Slice=aquarium-build.slice", "MemoryMax=2G", "CPUQuota=200%",
                 "Nice=15", "Type=oneshot"):
        assert re.search(rf"^{re.escape(line)}$", text, re.M), line
    assert re.search(r"^IPAddressDeny=localhost ", text, re.M)
    assert "/var/lib/aquarium-apps" in re.search(r"^InaccessiblePaths=(.*)$", text, re.M).group(1)


def _max_bytes(name):
    value = re.search(r"^MemoryMax=(\d+)([MG])$", _unit(name), re.M)
    return int(value.group(1)) * (1024 if value.group(2) == "G" else 1)


def test_child_slices_fit_the_6g_parent():
    assert _max_bytes("aquarium.slice") == 6 * 1024
    children = ["aquarium-apps.slice", "aquarium-build.slice", "aquarium-db.slice"]
    assert [_max_bytes(c) for c in children] == [3 * 1024, 2 * 1024, 1024]
    assert sum(_max_bytes(c) for c in children) <= _max_bytes("aquarium.slice")
    # systemd nests by name: every child is aquarium-<x>.slice.
    assert all(c.startswith("aquarium-") for c in children)


SUDOERS = DEPLOY / "sudoers.d" / "aquarium-apps"
HELPER_VERBS = ("allocate", "build", "start", "stop", "restart", "route", "unroute", "set-secret",
                "logs", "status", "remove", "configure")


def _rules():
    return [ln for ln in SUDOERS.read_text().splitlines() if ln and not ln.startswith("#")]


def test_sudoers_helper_lines_allow_only_the_verb():
    rules = _rules()
    for verb in HELPER_VERBS:
        assert f"hermes ALL=(root) NOPASSWD: /usr/local/sbin/aquarium-app-helper {verb}" in rules
    helper_rules = [r for r in rules if "aquarium-app-helper" in r]
    # Exactly one argument (the verb): sudo then refuses any further argument.
    assert len(helper_rules) == len(HELPER_VERBS)
    assert all(len(r.split("NOPASSWD: ", 1)[1].split()) == 2 for r in helper_rules)
    assert not any("run-app" in r or "build-run" in r or "idle-check" in r for r in rules)
    assert not any(r.startswith("hermes-tools") for r in rules)


def test_sudoers_db_argv_for_item_1_3():
    db = sorted(r.split("NOPASSWD: ", 1)[1] for r in _rules() if "aquarium apps db" in r)
    expected = sorted(f"/usr/local/sbin/aquarium apps db {v} * {m}"
                      for v in ("create", "migrate", "status", "suspend", "resume", "drop") for m in ("dev", "prod"))
    assert db == expected


@pytest.mark.skipif(shutil.which("visudo") is None and not Path("/usr/sbin/visudo").exists(),
                    reason="visudo not installed")
def test_sudoers_file_passes_visudo():
    visudo = shutil.which("visudo") or "/usr/sbin/visudo"
    proc = subprocess.run([visudo, "-cf", str(SUDOERS)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_session_cookie_regexes_strip_both_names_and_nothing_else(h):
    for name in ("__Host-agent_home_session", "agent_home_session"):
        assert re.sub(h.SESSION_COOKIE_RE, "", f"a=1; {name}=v.s; b=2") == "a=1; b=2"
        assert re.match(h.SESSION_SET_COOKIE_RE, f"{name}=forged; Path=/; Secure")
    assert re.sub(h.SESSION_COOKIE_RE, "", "app_session=1") == "app_session=1"


@pytest.mark.parametrize("mode", ["dev", "prod"])
def test_app_csp_never_allows_eval(h, mode):
    csp = h.app_csp(f"/apps{'-dev' if mode == 'dev' else ''}/demo", mode)
    assert "'unsafe-eval'" not in csp and "script-src https://{host}/apps" in csp
