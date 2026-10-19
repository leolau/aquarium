"""deploy/hermes-vpn-helper: spec validation, generated files, and the
up/down/status/check/idle-check flows against fake system binaries.

The helper is root-only stdlib Python; here it is imported from its file and
pointed at a temp world (fake ``systemd-run``/``systemctl``/``ip``/``mount``/
``umount``/``openfortivpn`` on its ``SAFE_PATH``), so nothing touches the
real network or mounts.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import stat
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

HELPER = Path(__file__).resolve().parents[2] / "deploy" / "hermes-vpn-helper"
GOOD_SHA = "9f2c" + "0" * 60
CERT = {
    "sha256": GOOD_SHA,
    "subject": "FGT60F-Office",
    "issuer": "Fortinet_CA_SSL",
    "not_after": "2027-03-31T00:00:00Z",
}


def load_helper():
    loader = importlib.machinery.SourceFileLoader("hermes_vpn_helper", str(HELPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def base_spec(**over):
    spec = {
        "slug": "office-files",
        "host": "vpn.example.com",
        "port": 443,
        "username": "alice",
        "password": "good",
        "routes": ["10.20.0.0/16"],
        "share_path": "//fileserver01/Shared",
        "idle_minutes": 30,
    }
    spec.update(over)
    return spec


# ---------------------------------------------------------------------------
# Fake world
# ---------------------------------------------------------------------------

FAKE_COMMON = """
import json, os, sys
W = {world!r}
def jload(name, default):
    try:
        with open(os.path.join(W, name)) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default
def jsave(name, doc):
    with open(os.path.join(W, name), "w") as fh:
        json.dump(doc, fh)
def log_call(name):
    calls = jload("calls.json", [])
    calls.append([name] + sys.argv[1:])
    jsave("calls.json", calls)
"""

FAKES = {
    "systemd-run": """
log_call("systemd-run")
args = sys.argv[1:]
unit = [a.split("=", 1)[1] for a in args if a.startswith("--unit=")][0]
if any(a.startswith("--on-active") for a in args):
    open(os.path.join(W, "units", unit + ".timer"), "w").close()
    sys.exit(0)
log = [a.split("append:", 1)[1] for a in args if a.startswith("--property=StandardOutput=")][0]
conf = args[args.index("-c") + 1]
st = os.stat(conf)
with open(conf) as fh:
    text = fh.read()
jsave("conf-seen.json", {"text": text, "mode": st.st_mode & 0o777})
password = [l.split("=", 1)[1].strip() for l in text.splitlines() if l.startswith("password")][0]
out = open(log, "a")
out.write("INFO:   Connected to gateway.\\n")
if password == "good":
    out.write("INFO:   Authenticated.\\nINFO:   Remote gateway has allocated a VPN.\\n")
    out.write("INFO:   Got addresses: [10.212.134.5], ns [10.20.0.53, 0.0.0.0]\\n")
    out.write("INFO:   Interface ppp0 is UP.\\nINFO:   Tunnel is up and running.\\n")
    stats = os.path.join(W, "sysnet", "ppp0", "statistics")
    os.makedirs(stats, exist_ok=True)
    for n in ("rx_bytes", "tx_bytes"):
        with open(os.path.join(stats, n), "w") as fh:
            fh.write("1000")
    open(os.path.join(W, "units", unit), "w").close()
elif password == "cert":
    out.write("ERROR:  Gateway certificate validation failed, and the certificate digest is not in the local whitelist. If you trust it, rerun with:\\n")
    out.write("ERROR:      trusted-cert = " + "ab" * 32 + "\\n")
else:
    out.write("ERROR:  Could not authenticate to gateway. Please check the password, client certificate, etc.\\n")
out.close()
""",
    "systemctl": """
log_call("systemctl")
verb, unit = sys.argv[1], sys.argv[2]
path = os.path.join(W, "units", unit)
if verb == "is-active":
    print("active" if os.path.exists(path) else "inactive")
    sys.exit(0 if os.path.exists(path) else 3)
if verb == "stop":
    if os.path.exists(path):
        os.unlink(path)
    if unit.endswith(".service") and not unit.startswith("hermes-vpn-idle-"):
        import shutil
        shutil.rmtree(os.path.join(W, "sysnet", "ppp0"), ignore_errors=True)
sys.exit(0)
""",
    "ip": """
log_call("ip")
args = sys.argv[1:]
routes = jload("routes.json", [])
if args[:4] == ["-j", "-4", "addr", "show"]:
    links = [
        {"ifname": "lo", "addr_info": [{"local": "127.0.0.1", "prefixlen": 8}]},
        {"ifname": "eth0", "addr_info": [{"local": "95.217.1.2", "prefixlen": 32}]},
        {"ifname": "docker0", "addr_info": [{"local": "172.17.0.1", "prefixlen": 16}]},
        {"ifname": "br-1", "addr_info": [{"local": "172.18.0.1", "prefixlen": 16}]},
    ]
    if os.path.isdir(os.path.join(W, "sysnet", "ppp0")):
        links.append({"ifname": "ppp0", "addr_info": [{"local": "10.212.134.5", "prefixlen": 32}]})
    print(json.dumps(links)); sys.exit(0)
if args[:4] == ["-j", "-4", "route", "show"]:
    table = [
        {"dst": "default", "gateway": "172.31.1.1", "dev": "eth0"},
        {"dst": "172.31.1.1", "dev": "eth0"},
        {"dst": "172.17.0.0/16", "dev": "docker0"},
        {"dst": "172.18.0.0/16", "dev": "br-1"},
        {"dst": "127.0.0.0/8", "dev": "lo", "type": "local"},
    ] + [{"dst": r[0], "dev": r[1]} for r in routes]
    print(json.dumps(table)); sys.exit(0)
if args[:3] == ["-4", "route", "replace"]:
    routes = [r for r in routes if r[0] != args[3]] + [[args[3], args[5]]]
    jsave("routes.json", routes); sys.exit(0)
if args[:3] == ["-4", "route", "del"]:
    jsave("routes.json", [r for r in routes if r[0] != args[3]]); sys.exit(0)
sys.exit(1)
""",
    "mount": """
log_call("mount")
args = sys.argv[1:]
unc, target, opts = args[2], args[3], args[5]
cred = [o.split("=", 1)[1] for o in opts.split(",") if o.startswith("credentials=")][0]
with open(cred) as fh:
    jsave("creds-seen.json", {"text": fh.read(), "mode": os.stat(cred).st_mode & 0o777})
vers = [o.split("=", 1)[1] for o in opts.split(",") if o.startswith("vers=")][0]
refused = os.path.join(W, "mount-refuse-vers")
if os.path.exists(refused) and vers in open(refused).read().split():
    print("mount error(95): Operation not supported", file=sys.stderr); sys.exit(32)
if os.path.exists(os.path.join(W, "mount-fail")):
    print("mount error(13): Permission denied", file=sys.stderr); sys.exit(32)
with open(os.path.join(W, "mounts"), "a") as fh:
    fh.write(unc.replace(" ", "\\\\040") + " " + target + " cifs ro 0 0\\n")
""",
    "umount": """
log_call("umount")
target = sys.argv[-1]
path = os.path.join(W, "mounts")
lines = open(path).read().splitlines() if os.path.exists(path) else []
with open(path, "w") as fh:
    fh.writelines(l + "\\n" for l in lines if l.split()[1] != target)
""",
    "openfortivpn": "sys.exit(0)\n",
}


@pytest.fixture
def h(tmp_path, monkeypatch):
    helper = load_helper()
    world = tmp_path / "world"
    for sub in ("units", "sysnet", "bin"):
        (world / sub).mkdir(parents=True)
    (world / "mounts").write_text("")
    for name, body in FAKES.items():
        path = world / "bin" / name
        path.write_text(
            f"#!{sys.executable}\n"
            + FAKE_COMMON.format(world=str(world))
            + textwrap.dedent(body)
        )
        path.chmod(0o755)
    data = tmp_path / "data"
    data.mkdir(mode=0o755)
    os.chmod(data, 0o755)
    os.chmod(tmp_path, 0o755)
    monkeypatch.setattr(helper, "SAFE_PATH", f"{world / 'bin'}:/usr/bin:/bin")
    monkeypatch.setattr(helper, "RUN_DIR", str(tmp_path / "run"))
    monkeypatch.setattr(helper, "MOUNT_ROOT", str(data / "vpn-files"))
    monkeypatch.setattr(helper, "TOOLS_GROUP", "no-such-group-for-tests")
    monkeypatch.setattr(helper, "SYS_NET", str(world / "sysnet"))
    monkeypatch.setattr(helper, "PROC_MOUNTS", str(world / "mounts"))
    monkeypatch.setattr(helper, "TRUSTED_UIDS", (0, os.getuid()))  # windows-footgun: ok — POSIX-only helper test
    monkeypatch.setattr(helper, "RESOLV_FILES", ())
    monkeypatch.setattr(helper, "UP_TIMEOUT", 5.0)

    def fake_resolve(host):
        table = {"vpn.example.com": ["203.0.113.10"]}
        if host in table:
            return table[host]
        try:
            helper.ipaddress.IPv4Address(host)
            return [host]
        except ValueError:
            raise OSError("not found")

    monkeypatch.setattr(helper, "resolve_ipv4", fake_resolve)
    monkeypatch.setattr(
        helper,
        "dns_query_a",
        lambda name, ns, iface, timeout=3.0: (
            ["10.20.1.5"]
            if name == "fileserver01" and ns == "10.20.0.53" and iface == "ppp0"
            else []
        ),
    )
    monkeypatch.setattr(
        helper, "fetch_cert", lambda host, ip, port: (dict(CERT), False)
    )
    helper.world = world
    helper.spool = tmp_path / "spool"
    helper.spool.mkdir(mode=0o700)
    os.chmod(helper.spool, 0o700)
    monkeypatch.delenv("SUDO_UID", raising=False)
    return helper


def write_spec(h, spec, name="spec-abc.json", mode=0o600):
    path = h.spool / name
    path.write_text(json.dumps(spec))
    os.chmod(path, mode)
    return str(path)


def calls(h, name=None):
    path = h.world / "calls.json"
    doc = json.loads(path.read_text()) if path.exists() else []
    return [c for c in doc if name is None or c[0] == name]


def up(h, **over):
    return h.cmd_up(write_spec(h, base_spec(trusted_cert=GOOD_SHA, **over)))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_valid_spec_normalises():
    h = load_helper()
    spec = h.validate_spec(
        base_spec(share_path=r"\\fileserver01\Shared\Reports\Q3", realm="staff")
    )
    assert spec["share"] == ("fileserver01", "Shared", ["Reports", "Q3"])
    assert spec["port"] == 443 and spec["idle_minutes"] == 30


@pytest.mark.parametrize(
    "over",
    [
        {"password": "a\nset-routes = 1"},
        {"password": "x\rpppd-plugin = /tmp/evil.so"},
        {"username": "alice\n"},
        {"password": " leading"},
        {"host": "vpn.example.com\nuser-key = /etc/shadow"},
        {"host": "-oProxyCommand"},
        {"host": "127.0.0.1"},
        {"host": "169.254.169.254"},
        {"port": 0},
        {"port": "443"},
        {"port": True},
        {"realm": "a b"},
        {"trusted_cert": "9F:2C"},
        {"trusted_cert": "g" * 64},
        {"routes": ["0.0.0.0/0"]},
        {"routes": ["10.0.0.0/7"]},
        {"routes": ["127.0.0.0/8"]},
        {"routes": ["169.254.1.0/24"]},
        {"routes": ["172.17.5.0/24"]},
        {"routes": ["172.18.0.0/16"]},
        {"routes": ["10.20.1.0/16"]},
        {"routes": ["10.20.0.0/16", "10.20.5.0/24"]},
        {"routes": "10.0.0.0/8"},
        {"routes": [f"10.{i}.0.0/16" for i in range(40)]},
        {"share_path": "//fileserver01"},
        {"share_path": "//fileserver01/Shared/../../etc"},
        {"share_path": "//fileserver01/Sh,ared"},
        {"share_path": "fileserver01/Shared"},
        {"share_username": "bob\npassword=x"},
        {"share_username": "bob,uid=0"},
        {"share_domain": "CORP%x"},
        {"idle_minutes": -1},
        {"slug": "../etc"},
        {"slug": "Office"},
        {"pppd-plugin": "/tmp/evil.so"},
        {"user_key": "/etc/shadow"},
    ],
)
def test_bad_spec_rejected(over):
    h = load_helper()
    with pytest.raises(h.InputError):
        h.validate_spec(base_spec(**over))


def test_generated_config_is_allowlisted_and_forces_routing_off():
    h = load_helper()
    spec = h.validate_spec(
        base_spec(password="p=w#rd", realm="staff", trusted_cert=GOOD_SHA)
    )
    text = h.render_openfortivpn_config(spec)
    keys = [line.split("=", 1)[0].strip() for line in text.splitlines()]
    assert keys == [
        "host",
        "port",
        "username",
        "password",
        "realm",
        "trusted-cert",
        "set-routes",
        "set-dns",
        "pppd-use-peerdns",
        "half-internet-routes",
    ]
    assert "password = p=w#rd\n" in text
    for key in ("set-routes", "set-dns", "pppd-use-peerdns", "half-internet-routes"):
        assert f"{key} = 0\n" in text


def test_smb_credentials_default_to_vpn_login():
    h = load_helper()
    spec = h.validate_spec(base_spec())
    assert h.render_smb_credentials(spec) == "username=alice\npassword=good\n"
    spec = h.validate_spec(
        base_spec(share_username="svc", share_password="s3", share_domain="CORP")
    )
    assert h.render_smb_credentials(spec) == "username=svc\npassword=s3\ndomain=CORP\n"


@pytest.mark.parametrize(
    "routes, gateway",
    [
        (["95.217.1.2/32"], "203.0.113.10"),  # the box's own address
        (["172.31.1.0/24"], "203.0.113.10"),  # Hetzner default gateway
        (["203.0.113.0/24"], "203.0.113.10"),  # the VPN gateway itself
    ],
)
def test_routes_overlapping_the_box_are_refused(h, routes, gateway):
    with pytest.raises(h.InputError):
        h.check_routes_against_box(routes, [gateway])


def test_routes_clear_of_the_box_pass(h):
    h.check_routes_against_box(["10.20.0.0/16", "192.168.50.0/24"], ["203.0.113.10"])


# ---------------------------------------------------------------------------
# Spec file handling
# ---------------------------------------------------------------------------


def test_spec_file_is_read_then_deleted(h):
    path = write_spec(h, base_spec())
    assert h.read_spec_file(path)["host"] == "vpn.example.com"
    assert not os.path.exists(path)


def test_spec_symlink_refused_and_target_kept(h, tmp_path):
    target = tmp_path / "precious"
    target.write_text("{}")
    os.chmod(target, 0o600)
    link = h.spool / "spec-link.json"
    link.symlink_to(target)
    with pytest.raises(h.InputError):
        h.read_spec_file(str(link))
    assert target.exists()


def test_spec_world_readable_refused(h):
    with pytest.raises(h.InputError):
        h.read_spec_file(write_spec(h, base_spec(), mode=0o644))


def test_spec_in_shared_directory_refused(h):
    path = write_spec(h, base_spec())
    os.chmod(h.spool, 0o777)
    try:
        with pytest.raises(h.InputError):
            h.read_spec_file(path)
    finally:
        os.chmod(h.spool, 0o700)


def test_spec_from_other_user_refused(h, monkeypatch):
    monkeypatch.setattr(h, "caller_uid", lambda: os.getuid() + 1)  # windows-footgun: ok — POSIX-only helper test
    with pytest.raises(h.InputError):
        h.read_spec_file(write_spec(h, base_spec()))


def test_spec_relative_or_odd_name_refused(h):
    with pytest.raises(h.InputError):
        h.read_spec_file("spec.json")
    with pytest.raises(h.InputError):
        h.read_spec_file(str(h.spool / "spec;rm.json"))


# ---------------------------------------------------------------------------
# up / status / check / down
# ---------------------------------------------------------------------------


def test_up_connects_routes_and_mounts_read_only(h):
    doc = up(h)
    assert doc["state"] == "connected", doc
    assert doc["local_ip"] == "10.212.134.5" and doc["iface"] == "ppp0"
    assert doc["mounted"] is True and doc["error"] is None
    conf = json.loads((h.world / "conf-seen.json").read_text())
    assert conf["mode"] == 0o600 and "set-routes = 0" in conf["text"]
    assert json.loads((h.world / "routes.json").read_text()) == [
        ["10.20.0.0/16", "ppp0"]
    ]
    mount = calls(h, "mount")[0]
    assert mount[1:5] == [
        "-t",
        "cifs",
        "//fileserver01/Shared",
        os.path.join(h.MOUNT_ROOT, "office-files"),
    ]
    opts = mount[6].split(",")
    for opt in (
        "ro",
        "nosuid",
        "nodev",
        "noexec",
        "file_mode=0440",
        "dir_mode=0550",
        "vers=default",
        "iocharset=utf8",
        "ip=10.20.1.5",
        "uid=hermes",
        "gid=hermes",
    ):
        assert opt in opts
    assert not any(o.startswith(("password", "username")) for o in opts)
    creds = json.loads((h.world / "creds-seen.json").read_text())
    assert creds["mode"] == 0o600 and creds["text"] == "username=alice\npassword=good\n"
    run_dir = Path(h.RUN_DIR) / "office-files"
    assert not (run_dir / "openfortivpn.conf").exists()
    assert not (run_dir / "smb.cred").exists()
    assert stat.S_IMODE(os.stat(h.RUN_DIR).st_mode) == 0o700
    timers = [
        c
        for c in calls(h, "systemd-run")
        if any(a.startswith("--on-active") for a in c)
    ]
    assert timers and timers[0][-2:] == ["idle-check", "office-files"]
    assert "good" not in (run_dir / "state.json").read_text()


def test_up_is_idempotent_for_same_spec(h):
    up(h)
    before = len(calls(h, "systemd-run"))
    assert up(h)["state"] == "connected"
    assert len(calls(h, "systemd-run")) == before


def test_up_with_changed_spec_reconnects(h):
    up(h)
    before = len(calls(h, "mount"))
    assert up(h, routes=["10.20.0.0/16", "10.30.0.0/16"])["state"] == "connected"
    assert len(calls(h, "mount")) == before + 1


def test_down_cleans_up_and_is_idempotent(h):
    up(h)
    doc = h.cmd_down("office-files")
    assert doc["state"] == "disconnected" and doc["mounted"] is False
    assert json.loads((h.world / "routes.json").read_text()) == []
    assert not (h.world / "units" / "hermes-vpn-office-files.service").exists()
    assert not (h.world / "units" / "hermes-vpn-idle-office-files.timer").exists()
    assert h.cmd_down("office-files")["state"] == "disconnected"


def test_status_unknown_slug_is_disconnected(h):
    assert h.cmd_status("never-seen")["state"] == "disconnected"


def test_untrusted_cert_stops_before_password(h):
    doc = h.cmd_up(write_spec(h, base_spec()))
    assert doc["state"] == "needs_cert"
    assert (
        doc["cert"]["sha256"] == GOOD_SHA and doc["cert"]["subject"] == "FGT60F-Office"
    )
    assert calls(h, "systemd-run") == []
    assert not (h.world / "conf-seen.json").exists()


def test_system_trusted_cert_needs_no_pin(h, monkeypatch):
    monkeypatch.setattr(h, "fetch_cert", lambda host, ip, port: (dict(CERT), True))
    assert h.cmd_up(write_spec(h, base_spec()))["state"] == "connected"


def test_unreachable_gateway(h, monkeypatch):
    def boom(host, ip, port):
        raise ConnectionRefusedError(111, "Connection refused")

    monkeypatch.setattr(h, "fetch_cert", boom)
    doc = up(h)
    assert doc["state"] == "error"
    assert doc["error"].startswith("Can't reach the VPN server vpn.example.com:443")


def test_unknown_gateway_name(h):
    doc = up(h, host="nope.example.com")
    assert doc["state"] == "error" and "Can't find the VPN server" in doc["error"]


def test_bad_password_maps_to_login_failed(h):
    doc = up(h, password="wrong")
    assert doc["state"] == "error"
    assert doc["error"] == "Login failed: wrong username or password"
    assert not (h.world / "units" / "hermes-vpn-office-files.service").exists()
    assert h.cmd_status("office-files")["error"] == doc["error"]


def test_openfortivpn_cert_rejection_maps_to_needs_cert(h):
    doc = up(h, password="cert")
    assert doc["state"] == "needs_cert" and doc["cert"]["sha256"] == "ab" * 32


def test_share_outside_routes_refused(h):
    doc = up(h, routes=["192.168.50.0/24"])
    assert doc["state"] == "error" and "outside the VPN routes" in doc["error"]
    assert calls(h, "mount") == []


def test_no_routes_routes_only_the_file_server(h):
    assert up(h, routes=[])["state"] == "connected"
    assert json.loads((h.world / "routes.json").read_text()) == [
        ["10.20.1.5/32", "ppp0"]
    ]


def test_mount_permission_denied_keeps_tunnel_up(h):
    (h.world / "mount-fail").touch()
    doc = up(h)
    assert doc["state"] == "connected" and doc["mounted"] is False
    assert doc["error"] is None and doc["share_error"].startswith("File share login failed")
    assert json.loads((h.world / "routes.json").read_text()) == [["10.20.0.0/16", "ppp0"]]
    assert not (Path(h.RUN_DIR) / "office-files" / "smb.cred").exists()
    check = h.cmd_check("office-files")["check"]
    assert check["ok"] is False and "File share login failed" in check["message"]


def test_up_again_retries_a_failed_share_mount(h):
    (h.world / "mount-fail").touch()
    up(h)
    (h.world / "mount-fail").unlink()
    before = len(calls(h, "mount"))
    doc = up(h)
    assert doc["state"] == "connected" and doc["mounted"] is True
    assert doc["share_error"] is None
    assert len(calls(h, "mount")) == before + 1
    assert h.cmd_check("office-files")["check"]["ok"] is True


def test_smb2_only_server_falls_back_to_vers_2_0(h):
    (h.world / "mount-refuse-vers").write_text("default\n")
    doc = up(h)
    assert doc["state"] == "connected" and doc["mounted"] is True
    tried = [c[6].split(",") for c in calls(h, "mount")]
    assert ["vers=default" in o for o in tried] == [True, False]
    assert "vers=2.0" in tried[1]


def test_smb1_only_server_is_refused_with_a_clear_message(h):
    (h.world / "mount-refuse-vers").write_text("default 2.0\n")
    doc = up(h)
    assert doc["state"] == "connected" and doc["mounted"] is False
    assert "only offers SMB 1.0" in doc["share_error"]
    assert not any("vers=1.0" in c[6] for c in calls(h, "mount"))


def test_symlinked_mount_root_refused(h, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    os.symlink(elsewhere, h.MOUNT_ROOT)
    doc = up(h)
    assert doc["state"] == "error" and "real directory" in doc["error"]
    assert not (elsewhere / "office-files").exists()


def test_writable_parent_of_mount_root_refused(h):
    parent = os.path.dirname(h.MOUNT_ROOT)
    os.chmod(parent, 0o777)
    try:
        doc = up(h)
    finally:
        os.chmod(parent, 0o755)
    assert doc["state"] == "error" and "writable" in doc["error"]


def test_check_counts_files(h):
    up(h)
    root = Path(h.MOUNT_ROOT) / "office-files"
    (root / "Reports").mkdir()
    for name in ("a.txt", "b.txt", "Reports/q3.xlsx"):
        (root / name).write_text("x")
    doc = h.cmd_check("office-files")
    assert doc["check"]["ok"] is True and doc["check"]["file_count"] == 3
    assert doc["check"]["message"] == "File server reachable, 3 files listed."


def test_check_when_disconnected(h):
    doc = h.cmd_check("office-files")
    assert doc["check"]["ok"] is False


def _age_activity(h, minutes):
    path = Path(h.RUN_DIR) / "office-files" / "state.json"
    state = json.loads(path.read_text())
    old = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    state["last_activity"] = old.strftime("%Y-%m-%dT%H:%M:%SZ")
    path.write_text(json.dumps(state))


def test_idle_check_disconnects_after_idle_minutes(h):
    up(h, idle_minutes=5)
    _age_activity(h, 6)
    assert h.cmd_idle_check("office-files")["state"] == "disconnected"
    assert h.cmd_status("office-files")["mounted"] is False


def test_idle_check_keeps_busy_tunnel(h):
    up(h, idle_minutes=5)
    _age_activity(h, 6)
    stats = h.world / "sysnet" / "ppp0" / "statistics" / "rx_bytes"
    stats.write_text(str(1000 + h.IDLE_NOISE_BYTES + 1))
    assert h.cmd_idle_check("office-files")["state"] == "connected"


def test_idle_check_ignores_keepalive_noise(h):
    up(h, idle_minutes=5)
    _age_activity(h, 6)
    (h.world / "sysnet" / "ppp0" / "statistics" / "rx_bytes").write_text("1200")
    assert h.cmd_idle_check("office-files")["state"] == "disconnected"


def test_dropped_tunnel_reports_error_and_idle_check_cleans(h):
    up(h)
    (h.world / "units" / "hermes-vpn-office-files.service").unlink()
    assert h.cmd_status("office-files")["state"] == "error"
    doc = h.cmd_idle_check("office-files")
    assert doc["state"] == "error" and doc["mounted"] is False


@pytest.mark.parametrize(
    "log, expected",
    [
        ("ERROR:  connect: Connection timed out\n", "Can't reach the VPN server"),
        (
            "ERROR:  getaddrinfo: Name or service not known\n",
            "Can't find the VPN server",
        ),
        ("Please enter one-time password:\n", "one-time code"),
        ("ERROR:  Timed out waiting for the ppp interface to be UP.\n", "ppp timeout"),
        ("ERROR:  something odd\n", "VPN client failed: something odd"),
        ("", "VPN client exited unexpectedly"),
    ],
)
def test_classify_log(log, expected):
    h = load_helper()
    assert expected in h.classify_log(log, "vpn.example.com", 443)[1]


def test_main_exit_codes(h, monkeypatch, capsys):
    assert h.main(["status", "office-files"]) == 1  # not root
    assert "must run as root" in json.loads(capsys.readouterr().out)["error"]
    monkeypatch.setattr(h.os, "geteuid", lambda: 0)
    assert h.main(["status", "../x"]) == 2
    assert json.loads(capsys.readouterr().out)["bad_input"] is True
    assert h.main(["bogus", "x"]) == 2
    capsys.readouterr()
    path = write_spec(h, base_spec(routes=["0.0.0.0/0"], trusted_cert=GOOD_SHA))
    assert h.main(["up", path]) == 2
    assert "too broad" in json.loads(capsys.readouterr().out)["error"]
    assert h.main(["up", write_spec(h, base_spec(trusted_cert=GOOD_SHA))]) == 0
    assert json.loads(capsys.readouterr().out)["state"] == "connected"


# ---------------------------------------------------------------------------
# Real network paths on localhost (no fakes)
# ---------------------------------------------------------------------------


def test_fetch_cert_against_local_tls_server(tmp_path):
    import hashlib
    import shutil
    import socket
    import ssl
    import subprocess
    import threading

    if not shutil.which("openssl"):
        pytest.skip("openssl not available")
    key, crt = tmp_path / "k.pem", tmp_path / "c.pem"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key),
            "-out",
            str(crt),
            "-days",
            "30",
            "-subj",
            "/CN=FGT60F-Office/O=Fortinet",
        ],
        check=True,
        capture_output=True,
    )
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(str(crt), str(key))
    server = socket.socket()
    server.bind(("127.0.0.1", 0))
    server.listen(4)
    port = server.getsockname()[1]
    stop = threading.Event()

    def serve():
        server.settimeout(0.5)
        while not stop.is_set():
            try:
                conn, _ = server.accept()
            except OSError:
                continue
            try:
                with ctx.wrap_socket(conn, server_side=True):
                    pass
            except (ssl.SSLError, OSError):
                pass

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        h = load_helper()
        info, trusted = h.fetch_cert("localhost", "127.0.0.1", port)
    finally:
        stop.set()
        thread.join(2)
        server.close()
    der = ssl.PEM_cert_to_DER_cert(crt.read_text())
    assert trusted is False
    assert info["sha256"] == hashlib.sha256(der).hexdigest()
    assert info["subject"] == "FGT60F-Office"
    assert info["not_after"] and info["not_after"].endswith("Z")


def test_dns_query_a_parses_answer(tmp_path):
    import socket
    import struct
    import threading

    h = load_helper()
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("127.0.0.1", 0))
    port = server.getsockname()[1]

    def answer():
        data, addr = server.recvfrom(512)
        qid = data[:2]
        question = data[12:]
        reply = qid + struct.pack(">HHHHH", 0x8180, 1, 1, 0, 0) + question
        reply += (
            b"\xc0\x0c"
            + struct.pack(">HHIH", 1, 1, 60, 4)
            + socket.inet_aton("10.20.1.5")
        )
        server.sendto(reply, addr)

    thread = threading.Thread(target=answer, daemon=True)
    thread.start()
    real_socket = socket.socket

    class Redirect:
        """Sends to the local fake server; tolerates unprivileged BINDTODEVICE."""

        def __init__(self, *args):
            self._sock = real_socket(*args)

        def setsockopt(self, *args):
            try:
                return self._sock.setsockopt(*args)
            except PermissionError:
                return None

        def sendto(self, data, address):
            return self._sock.sendto(data, ("127.0.0.1", port))

        def __getattr__(self, name):
            return getattr(self._sock, name)

    original = h.socket.socket
    h.socket.socket = Redirect
    try:
        assert h.dns_query_a("fileserver01.corp.local", "10.20.0.53", "lo") == [
            "10.20.1.5"
        ]
    finally:
        h.socket.socket = original
        server.close()


# ---------------------------------------------------------------------------
# Network folders: mount / umount / fstatus / fcheck
# ---------------------------------------------------------------------------


def folder_spec(**over):
    spec = {
        "vpn_slug": "office-files",
        "folder_slug": "tenders",
        "share_path": "//10.20.1.9/Projects/Tenders",
        "share_username": "bob",
        "share_password": "folder-pw",
    }
    spec.update(over)
    return {k: v for k, v in spec.items() if v is not None}


def fmount(h, **over):
    return h.cmd_mount(write_spec(h, folder_spec(**over), name="spec-folder.json"))


def folder_mount_path(h, slug="tenders"):
    return os.path.join(h.MOUNT_ROOT, f"net-{slug}")


def test_mount_folder_through_connected_vpn(h):
    up(h)
    doc = fmount(h)
    assert doc["mounted"] is True and doc["error"] is None, doc
    assert doc["vpn_slug"] == "office-files"
    assert doc["mount_path"] == folder_mount_path(h)
    mount = calls(h, "mount")[-1]
    assert mount[1:5] == [
        "-t",
        "cifs",
        "//10.20.1.9/Projects/Tenders",
        folder_mount_path(h),
    ]
    opts = mount[6].split(",")
    for opt in (
        "ro",
        "nosuid",
        "nodev",
        "noexec",
        "file_mode=0440",
        "dir_mode=0550",
        "vers=default",
        "iocharset=utf8",
        "ip=10.20.1.9",
        "uid=hermes",
        "gid=hermes",
    ):
        assert opt in opts
    assert not any(o.startswith(("password", "username")) for o in opts)
    creds = json.loads((h.world / "creds-seen.json").read_text())
    assert (
        creds["mode"] == 0o600 and creds["text"] == "username=bob\npassword=folder-pw\n"
    )
    run_dir = Path(h.RUN_DIR) / "office-files"
    assert not list(run_dir.glob("*.cred"))
    state = json.loads((run_dir / "state.json").read_text())
    assert "tenders" in state["folders"]
    folder_state = (Path(h.RUN_DIR) / "net-tenders" / "state.json").read_text()
    assert "folder-pw" not in folder_state and "folder-pw" not in json.dumps(state)
    # the VPN's own share stays mounted alongside
    assert h.cmd_status("office-files")["mounted"] is True


def test_mount_folder_resolves_name_through_vpn_dns(h):
    up(h)
    doc = fmount(h, share_path=r"\\fileserver01\Other", share_domain="CORP")
    assert doc["mounted"] is True, doc
    assert "ip=10.20.1.5" in calls(h, "mount")[-1][6].split(",")
    creds = json.loads((h.world / "creds-seen.json").read_text())
    assert creds["text"].endswith("domain=CORP\n")


def test_mount_folder_needs_connected_vpn(h):
    doc = fmount(h)
    assert doc["mounted"] is False and doc["error"] == "VPN is not connected"
    assert calls(h, "mount") == []
    assert not os.path.exists(folder_mount_path(h))


def vpn_state(h, slug="office-files"):
    return json.loads((Path(h.RUN_DIR) / slug / "state.json").read_text())


def tunnel_routes(h):
    return json.loads((h.world / "routes.json").read_text())


def test_mount_folder_outside_routes_adds_a_host_route(h):
    up(h)
    doc = fmount(h, share_path="//10.99.0.5/Projects")
    assert doc["mounted"] is True, doc
    assert tunnel_routes(h) == [["10.20.0.0/16", "ppp0"], ["10.99.0.5/32", "ppp0"]]
    state = vpn_state(h)
    assert state["folder_routes"] == {"10.99.0.5/32": ["tenders"]}
    assert h.cmd_status("office-files")["routes"] == ["10.20.0.0/16", "10.99.0.5/32"]


def test_mount_folder_inside_vpn_routes_adds_no_route(h):
    up(h)
    fmount(h)
    assert tunnel_routes(h) == [["10.20.0.0/16", "ppp0"]]
    assert vpn_state(h).get("folder_routes", {}) == {}


def connection_only(h, **over):
    """A VPN entry that is only the connection: no routes, no share."""
    spec = base_spec(trusted_cert=GOOD_SHA, **over)
    spec.pop("routes")
    spec.pop("share_path")
    return h.cmd_up(write_spec(h, spec))


def test_up_without_routes_or_share_is_a_bare_tunnel(h):
    doc = connection_only(h)
    assert doc["state"] == "connected", doc
    assert doc["routes"] == [] and doc["mounted"] is False
    assert not (h.world / "routes.json").exists() or tunnel_routes(h) == []
    assert calls(h, "mount") == []
    assert not any(c[1:4] == ["-4", "route", "replace"] for c in calls(h, "ip"))
    check = h.cmd_check("office-files")["check"]
    assert check["ok"] is True and "no file share" in check["message"]
    assert h.cmd_down("office-files")["state"] == "disconnected"


def test_folder_route_lifecycle_on_a_connection_only_vpn(h):
    connection_only(h)
    assert fmount(h)["mounted"] is True
    assert fmount(h, folder_slug="hr", share_path="//10.20.1.9/HR")["mounted"] is True
    assert tunnel_routes(h) == [["10.20.1.9/32", "ppp0"]]
    assert vpn_state(h)["folder_routes"] == {"10.20.1.9/32": ["hr", "tenders"]}
    # re-mounting the same spec is a no-op: no route churn
    before = len(calls(h, "ip"))
    assert fmount(h)["mounted"] is True
    assert not any(c[1:4] in (["-4", "route", "del"], ["-4", "route", "replace"])
                   for c in calls(h, "ip")[before:])
    # one of two users leaves: route stays
    h.cmd_umount("tenders")
    assert tunnel_routes(h) == [["10.20.1.9/32", "ppp0"]]
    assert vpn_state(h)["folder_routes"] == {"10.20.1.9/32": ["hr"]}
    # last user leaves: route goes
    h.cmd_umount("hr")
    assert tunnel_routes(h) == []
    state = vpn_state(h)
    assert state["folder_routes"] == {} and state["routes"] == []
    assert h.cmd_status("office-files")["state"] == "connected"


def test_folder_moving_to_another_server_swaps_its_route(h):
    connection_only(h)
    fmount(h)
    assert fmount(h, share_path="//10.20.1.7/Projects")["mounted"] is True
    assert tunnel_routes(h) == [["10.20.1.7/32", "ppp0"]]
    assert vpn_state(h)["folder_routes"] == {"10.20.1.7/32": ["tenders"]}


def test_down_removes_folder_routes(h):
    connection_only(h)
    fmount(h)
    h.cmd_down("office-files")
    assert tunnel_routes(h) == []
    assert "folder_routes" not in vpn_state(h)


def test_failed_folder_mount_gives_the_route_back(h):
    connection_only(h)
    (h.world / "mount-fail").touch()
    doc = fmount(h)
    assert doc["mounted"] is False and doc["error"].startswith("File share login failed")
    assert tunnel_routes(h) == []
    assert vpn_state(h)["folder_routes"] == {}


def test_moving_folder_to_another_vpn_releases_its_route(h):
    connection_only(h)
    fmount(h)
    fmount(h, vpn_slug="other-vpn")
    assert tunnel_routes(h) == []
    assert vpn_state(h)["folder_routes"] == {}


@pytest.mark.parametrize(
    "share_path, reason",
    [
        ("//95.217.1.2/Projects", "overlaps this server's network"),
        ("//172.31.1.1/Projects", "overlaps this server's network"),
        ("//172.17.0.9/Projects", "overlaps reserved network"),
        ("//203.0.113.10/Projects", "VPN gateway's own address"),
    ],
)
def test_folder_route_overlapping_the_box_is_refused(h, share_path, reason):
    connection_only(h)
    doc = fmount(h, share_path=share_path)
    assert doc["mounted"] is False and reason in doc["error"], doc
    assert calls(h, "mount") == []
    assert not (h.world / "routes.json").exists() or tunnel_routes(h) == []
    assert vpn_state(h)["folder_routes"] == {}


def test_legacy_share_retry_adds_host_route_when_vpn_has_no_routes(h):
    (h.world / "mount-fail").touch()
    up(h, routes=[])
    state = vpn_state(h)
    # an older tunnel whose /32 is gone (e.g. state from before this helper)
    h.run([h.bin_path("ip"), "-4", "route", "del", "10.20.1.5/32", "dev", "ppp0"])
    state["routes"] = []
    (Path(h.RUN_DIR) / "office-files" / "state.json").write_text(json.dumps(state))
    (h.world / "mount-fail").unlink()
    doc = up(h, routes=[])
    assert doc["mounted"] is True and doc["share_error"] is None, doc
    assert tunnel_routes(h) == [["10.20.1.5/32", "ppp0"]]
    assert doc["routes"] == ["10.20.1.5/32"]


def test_mount_folder_unknown_server(h):
    up(h)
    doc = fmount(h, share_path="//nowhere/Projects")
    assert (
        doc["mounted"] is False and "Can't find the file server nowhere" in doc["error"]
    )


def test_mount_folder_login_failure_cleans_creds(h):
    up(h)
    (h.world / "mount-fail").touch()
    doc = fmount(h)
    assert doc["mounted"] is False and doc["error"].startswith(
        "File share login failed"
    )
    assert not list((Path(h.RUN_DIR) / "office-files").glob("*.cred"))
    assert not os.path.exists(folder_mount_path(h))
    # the failure is remembered for fstatus, and the VPN itself stays up
    assert h.cmd_fstatus("tenders")["error"].startswith("File share login failed")
    assert h.cmd_status("office-files")["state"] == "connected"


def test_mount_folder_is_idempotent_and_remounts_on_change(h):
    up(h)
    fmount(h)
    before = len(calls(h, "mount"))
    assert fmount(h)["mounted"] is True
    assert len(calls(h, "mount")) == before
    assert fmount(h, share_password="rotated")["mounted"] is True
    assert len(calls(h, "mount")) == before + 1
    assert calls(h, "umount")[-1][-1] == folder_mount_path(h)


def test_down_unmounts_folders(h):
    up(h)
    fmount(h)
    fmount(h, folder_slug="hr", share_path="//10.20.1.9/HR")
    h.cmd_down("office-files")
    for slug in ("tenders", "hr"):
        doc = h.cmd_fstatus(slug)
        assert doc["mounted"] is False and doc["error"] is None
        assert doc["vpn_state"] == "disconnected"
        assert not os.path.exists(folder_mount_path(h, slug))


def test_idle_disconnect_unmounts_folders(h):
    up(h, idle_minutes=5)
    fmount(h)
    _age_activity(h, 6)
    assert h.cmd_idle_check("office-files")["state"] == "disconnected"
    assert h.cmd_fstatus("tenders")["mounted"] is False


def test_reconnect_with_changed_vpn_spec_unmounts_folders(h):
    up(h)
    fmount(h)
    up(h, routes=["10.20.0.0/16", "10.30.0.0/16"])
    assert h.cmd_fstatus("tenders")["mounted"] is False


def test_umount_folder(h):
    up(h)
    fmount(h)
    doc = h.cmd_umount("tenders")
    assert doc["mounted"] is False and not os.path.exists(folder_mount_path(h))
    state = json.loads((Path(h.RUN_DIR) / "office-files" / "state.json").read_text())
    assert "tenders" not in state.get("folders", {})
    assert h.cmd_status("office-files")["state"] == "connected"
    assert h.cmd_umount("tenders")["mounted"] is False  # idempotent
    assert h.cmd_umount("never-seen")["mounted"] is False


def test_moving_folder_to_another_vpn_unmounts_old(h):
    up(h)
    fmount(h)
    doc = fmount(h, vpn_slug="other-vpn")
    assert doc["mounted"] is False and doc["error"] == "VPN is not connected"
    state = json.loads((Path(h.RUN_DIR) / "office-files" / "state.json").read_text())
    assert "tenders" not in state.get("folders", {})


def test_fstatus_and_fcheck(h):
    up(h)
    fmount(h)
    root = Path(folder_mount_path(h))
    (root / "2026").mkdir()
    for name in ("a.pdf", "2026/b.docx"):
        (root / name).write_text("x")
    _age_activity(h, 20)
    doc = h.cmd_fcheck("tenders")
    assert doc["check"]["ok"] is True and doc["check"]["file_count"] == 2
    assert doc["vpn_state"] == "connected"
    state = json.loads((Path(h.RUN_DIR) / "office-files" / "state.json").read_text())
    age = datetime.now(timezone.utc) - datetime.strptime(
        state["last_activity"], "%Y-%m-%dT%H:%M:%SZ"
    ).replace(tzinfo=timezone.utc)
    assert age < timedelta(minutes=1)
    status = h.cmd_fstatus("tenders")
    assert status == {**{k: doc[k] for k in status}}


def test_fcheck_when_not_mounted(h):
    doc = h.cmd_fcheck("tenders")
    assert doc["check"]["ok"] is False and doc["mounted"] is False


@pytest.mark.parametrize(
    "over",
    [
        {"folder_slug": "Tenders"},
        {"folder_slug": "../etc"},
        {"folder_slug": "a" * 42},
        {"folder_slug": None},
        {"vpn_slug": "net-office"},
        {"vpn_slug": "../x"},
        {"share_path": None},
        {"share_path": "//10.20.1.9"},
        {"share_path": "//10.20.1.9/Projects/../../etc"},
        {"share_path": "//10.20.1.9/Pro,jects"},
        {"share_path": "//127.0.0.1/Projects"},
        {"share_username": None},
        {"share_username": "bob\npassword=x"},
        {"share_username": "bob,uid=0"},
        {"share_password": "pw\nusername=root"},
        {"share_password": " pw"},
        {"share_domain": "CORP%x"},
        {"host": "vpn.example.com"},
        {"options": "rw"},
    ],
)
def test_bad_mount_spec_rejected(over):
    h = load_helper()
    with pytest.raises(h.InputError):
        h.validate_mount_spec(folder_spec(**over))


def test_mount_spec_symlink_refused(h, tmp_path):
    target = h.spool / "real.json"
    target.write_text(json.dumps(folder_spec()))
    os.chmod(target, 0o600)
    link = h.spool / "spec-link.json"
    os.symlink(target, link)
    with pytest.raises(h.InputError):
        h.cmd_mount(str(link))
    assert target.exists()


def test_mount_spec_read_then_deleted(h):
    up(h)
    path = write_spec(h, folder_spec(), name="spec-del.json")
    h.cmd_mount(path)
    assert not os.path.exists(path)


@pytest.mark.parametrize("command", ["down", "status", "check", "idle-check"])
def test_vpn_commands_refuse_folder_prefix(h, command):
    with pytest.raises(h.InputError):
        {
            "down": h.cmd_down,
            "status": h.cmd_status,
            "check": h.cmd_check,
            "idle-check": h.cmd_idle_check,
        }[command]("net-tenders")


def test_up_refuses_folder_prefix_slug():
    h = load_helper()
    with pytest.raises(h.InputError):
        h.validate_spec(base_spec(slug="net-office"))


def test_main_folder_commands(h, monkeypatch, capsys):
    monkeypatch.setattr(h.os, "geteuid", lambda: 0)
    assert h.main(["fstatus", "Bad/slug"]) == 2
    capsys.readouterr()
    assert h.main(["mount", write_spec(h, folder_spec(share_username=""))]) == 2
    assert "share_username" in json.loads(capsys.readouterr().out)["error"]
    assert h.main(["up", write_spec(h, base_spec(trusted_cert=GOOD_SHA))]) == 0
    capsys.readouterr()
    assert h.main(["mount", write_spec(h, folder_spec())]) == 0
    assert json.loads(capsys.readouterr().out)["mounted"] is True
    assert h.main(["fcheck", "tenders"]) == 0
    assert json.loads(capsys.readouterr().out)["check"]["ok"] is True
    assert h.main(["umount", "tenders"]) == 0
    assert json.loads(capsys.readouterr().out)["mounted"] is False


@pytest.mark.parametrize(
    "stderr, expected",
    [
        ("mount error(13): Permission denied", "File share login failed"),
        (
            "mount error(2): No such file or directory",
            "was not found on the file server",
        ),
        ("mount error(112): Host is down", "is not reachable through the VPN"),
        ("mount error(95): Operation not supported", "only offers SMB 1.0"),
        ("mount error(22): Invalid argument", "Could not mount //fs01/Projects"),
        (
            "mount error(79): Can not access a needed shared library",
            "missing the kernel's UTF-8 file name support",
        ),
        (
            "CIFS: VFS: CIFS mount error: iocharset utf8 not found",
            "install linux-modules-extra-$(uname -r)",
        ),
    ],
)
def test_mount_cifs_error_messages(h, monkeypatch, stderr, expected):
    class Proc:
        returncode = 32
        stdout = ""

    proc = Proc()
    proc.stderr = stderr
    monkeypatch.setattr(h, "run", lambda argv, **kw: proc)
    message = h.mount_cifs(("fs01", "Projects", []), "/x", "/c", "10.20.1.9")
    assert expected in message


def test_elibacc_message_is_exact_and_not_retried_as_smb1(h, monkeypatch):
    tried = []

    class Proc:
        returncode = 32
        stdout = ""
        stderr = "mount error(79): Can not access a needed shared library"

    def fake_run(argv, **kw):
        tried.append(argv)
        return Proc()

    monkeypatch.setattr(h, "run", fake_run)
    message = h.mount_cifs(("fs01", "Projects", []), "/x", "/c", "10.20.1.9")
    assert message == (
        "The server is missing the kernel's UTF-8 file name support "
        "(install linux-modules-extra-$(uname -r))"
    )
    assert len(tried) == 1


def test_check_message_for_a_full_count(h, tmp_path):
    (tmp_path / "share" / "a").mkdir(parents=True)
    (tmp_path / "share" / "a" / "HSD 員工假期及加班表格.xlsx").write_text("x")
    check = h.walk_check(str(tmp_path / "share"))
    assert check == {"ok": True, "file_count": 1,
                     "message": "File server reachable, 1 files listed."}


def test_check_message_when_counting_hits_the_time_budget(h, tmp_path, monkeypatch):
    monkeypatch.setattr(h, "count_files", lambda root, deadline, progress=None: (26412, "time"))
    check = h.walk_check(str(tmp_path))
    assert check["ok"] is True and check["file_count"] == 26412
    assert check["message"] == (
        "File server reachable, at least 26,412 files (stopped counting after 20 s)."
    )


def test_count_files_reports_why_it_stopped(h, tmp_path, monkeypatch):
    tmp_path = tmp_path / "share"
    tmp_path.mkdir()
    for i in range(3):
        (tmp_path / f"f{i}").write_text("x")
    assert h.count_files(str(tmp_path), h.time.monotonic() + 5) == (3, None)
    assert h.count_files(str(tmp_path), h.time.monotonic() - 1) == (0, "time")
    monkeypatch.setattr(h, "CHECK_MAX_ENTRIES", 2)
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "g").write_text("x")
    count, stop = h.count_files(str(tmp_path), h.time.monotonic() + 5)
    assert stop == "entries" and count >= 2


def test_check_message_when_the_file_server_hangs(h, tmp_path, monkeypatch):
    import threading

    release = threading.Event()
    monkeypatch.setattr(h, "count_files", lambda root, deadline, progress=None: (release.wait(5), (0, None))[1])
    monkeypatch.setattr(h, "CHECK_TIMEOUT", 0.05)
    monkeypatch.setattr(h, "CHECK_GRACE", 0.05)
    try:
        check = h.walk_check(str(tmp_path))
    finally:
        release.set()
    assert check["ok"] is False and check["file_count"] is None
    assert check["message"].startswith("File server is too slow to answer (no reply within")


def test_check_reports_the_partial_count_when_a_listing_outlasts_the_budget(h, tmp_path, monkeypatch):
    import threading

    release = threading.Event()

    def stuck_after_root(root, deadline, progress=None):
        progress.update(root_listed=True, count=2095)
        release.wait(5)
        return 2095, None

    monkeypatch.setattr(h, "count_files", stuck_after_root)
    monkeypatch.setattr(h, "CHECK_TIMEOUT", 0.05)
    monkeypatch.setattr(h, "CHECK_GRACE", 0.05)
    try:
        check = h.walk_check(str(tmp_path))
    finally:
        release.set()
    assert check == {"ok": True, "file_count": 2095,
                     "message": "File server reachable, at least 2,095 files (stopped counting after 0.1 s)."}


def test_count_files_publishes_progress(h, tmp_path):
    tmp_path = tmp_path / "share"
    (tmp_path / "sub").mkdir(parents=True)
    for name in ("a", "b", "sub/c"):
        (tmp_path / name).write_text("x")
    progress = {}
    assert h.count_files(str(tmp_path), h.time.monotonic() + 5, progress) == (3, None)
    assert progress == {"count": 3, "root_listed": True}


def test_count_files_checks_the_clock_inside_a_directory(h, tmp_path, monkeypatch):
    tmp_path = tmp_path / "share"
    tmp_path.mkdir()
    for i in range(5):
        (tmp_path / f"f{i}").write_text("x")
    clock = iter([0.0] + [100.0] * 50)
    monkeypatch.setattr(h.time, "monotonic", lambda: next(clock))
    assert h.count_files(str(tmp_path), 10.0) == (1, "time")


def test_slow_message_matches_the_contract_with_default_budget():
    h = load_helper()
    assert h.slow_message() == "File server is too slow to answer (no reply within 25 s)."


def test_mounts_get_the_hermes_tools_group_when_it_exists(monkeypatch):
    helper = load_helper()
    monkeypatch.setattr(helper, "TOOLS_GROUP", "root")
    assert helper.mount_group() == "root"
    monkeypatch.setattr(helper, "TOOLS_GROUP", "no-such-group-for-tests")
    assert helper.mount_group() == helper.MOUNT_USER
