"""deploy/aquarium-app-egress (FG-33 P8-2 2.6): local-app egress + supply-chain gate.

The helper is imported from its file and pointed at a temp world (fixed paths
redirected into tmp_path, fake ``nft``/``systemctl`` on SAFE_PATH, a fake
cgroup tree), so nothing touches nftables or systemd. The proxy is exercised
for real on loopback with an upstream echo server.
"""

from __future__ import annotations

import asyncio
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import socket
import subprocess
import tarfile
from pathlib import Path

import pytest

from tools import osv_check

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy"
HELPER = DEPLOY / "aquarium-app-egress"
SUDOERS = DEPLOY / "sudoers.d" / "aquarium-apps"
PROXY_UNIT = DEPLOY / "aquarium-app-egress-proxy.service"

FAKES = {
    # nft: `-f -` stores the script in $W/nft.rules (refused when $W/nft_bad exists);
    # `list table` succeeds once a script was loaded.
    "nft": """#!/bin/sh
echo "nft $*" >> "$W/calls"
if [ "$1" = -f ]; then
  [ -e "$W/nft_bad" ] && { echo "Error: cgroupv2 path fails" >&2; exit 1; }
  cat > "$W/nft.rules"; exit 0
fi
if [ "$1" = list ]; then [ -e "$W/nft.rules" ]; exit $?; fi
exit 0
""",
    "systemctl": "#!/bin/sh\necho \"systemctl $*\" >> \"$W/calls\"\n[ \"$1\" = is-active ] && echo active\nexit 0\n",
}


def load_helper():
    loader = importlib.machinery.SourceFileLoader("aquarium_app_egress", str(HELPER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


@pytest.fixture
def e(tmp_path, monkeypatch):
    mod = load_helper()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    monkeypatch.setenv("W", str(tmp_path))

    def run(cmd, timeout=60, **kw):
        kw.setdefault("capture_output", True)
        kw.setdefault("text", True)
        return subprocess.run(cmd, timeout=timeout, env={"PATH": mod.SAFE_PATH, "W": str(tmp_path)}, **kw)

    monkeypatch.setattr(mod, "run", run)
    monkeypatch.setattr(mod, "SAFE_PATH", f"{bin_dir}:/usr/bin:/bin")
    for attr, sub in {
        "ETC_APPS": "etc/aquarium/apps", "POLICY_PATH": "etc/aquarium/app-egress.json",
        "UNIT_DIR": "etc/systemd/system", "RUN_UNIT_DIR": "run/systemd/system",
        "RUN_DIR": "run/aquarium-egress", "CGROUP_ROOT": "sys/fs/cgroup",
    }.items():
        monkeypatch.setattr(mod, attr, str(tmp_path / sub))
    monkeypatch.setattr(mod, "TRUSTED_UIDS", (0, os.getuid()))
    (tmp_path / "etc/aquarium/apps").mkdir(parents=True)
    (tmp_path / "etc/systemd/system").mkdir(parents=True)
    mod.W = tmp_path
    return mod


def allocate(e, slug="notes", mode="dev", port=4500, dsn_port=None):
    d = Path(e.ETC_APPS) / slug
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{mode}.env").write_text(f"PORT={port}\nAPP_BASE_PATH=/apps-dev/{slug}\n")
    if dsn_port:
        (d / f"db-{mode}-rw.dsn").write_text(f"postgresql://u:p@127.0.0.1:{dsn_port}/app_{slug}\n")
    return d


def cgroup(e, rel):
    (Path(e.CGROUP_ROOT) / rel).mkdir(parents=True, exist_ok=True)


def call(e, monkeypatch, argv, spec=None):
    """Run main() as root would (euid patched); returns (exit code, JSON doc)."""
    monkeypatch.setattr(e.os, "geteuid", lambda: 0)
    monkeypatch.setenv("PATH", os.environ["PATH"])  # main() resets PATH; restore after
    old = os.umask(0o022)
    out = io.StringIO()
    monkeypatch.setattr(e.sys, "stdout", out)
    monkeypatch.setattr(e.sys, "stderr", out)
    try:
        rc = e.main(argv, io.StringIO(json.dumps(spec) if spec is not None else ""))
    finally:
        os.umask(old)
    return rc, json.loads(out.getvalue().strip().splitlines()[-1])


def allow_json(e):
    return json.loads((Path(e.RUN_DIR) / "proxy" / "allow.json").read_text())


# --- host names and policy -------------------------------------------------


@pytest.mark.parametrize("host,expected", [
    ("api.example.com", "api.example.com"), ("API.Example.com.", "api.example.com"),
    ("*.supabase.co", "*.supabase.co"), ("a-b.c-d.io", "a-b.c-d.io"),
])
def test_host_names_are_normalised(e, host, expected):
    assert e.normalize_host(host) == expected


@pytest.mark.parametrize("host", [
    "10.0.0.1", "169.254.169.254", "[::1]", "example.com:443", "https://example.com", "localhost",
    "*", "*.com", "exa mple.com", "-bad.com", "a..b", "x" * 300, 42, "*.*.example.com",
])
def test_ip_literals_ports_schemes_and_broad_wildcards_are_rejected(e, host):
    with pytest.raises(e.InputError):
        e.normalize_host(host)


def test_owner_sets_an_allowlist_within_policy_and_it_reaches_the_proxy(e, monkeypatch):
    allocate(e, "notes", "dev", 4500)
    allocate(e, "notes", "prod", 4501)
    rc, doc = call(e, monkeypatch, ["set"], {"slug": "notes", "hosts": ["API.stripe.com", "*.supabase.co"]})
    assert rc == 0, doc
    assert doc["hosts"] == ["*.supabase.co", "api.stripe.com"] and doc["modes"] == ["dev", "prod"]
    listeners = allow_json(e)["listeners"]
    assert listeners["14500"] == {"inst": "notes-dev", "hosts": ["*.supabase.co", "api.stripe.com"]}
    assert listeners["14501"]["hosts"] == ["*.supabase.co", "api.stripe.com"]
    assert listeners["14299"]["hosts"] == ["registry.npmjs.org", "api.osv.dev"]
    rc, doc = call(e, monkeypatch, ["get"], {"slug": "notes"})
    assert doc["egress"] == {"dev": ["*.supabase.co", "api.stripe.com"], "prod": ["*.supabase.co", "api.stripe.com"]}
    # Per mode, and an empty list clears.
    rc, doc = call(e, monkeypatch, ["set"], {"slug": "notes", "mode": "dev", "hosts": []})
    assert rc == 0 and allow_json(e)["listeners"]["14500"]["hosts"] == []
    assert allow_json(e)["listeners"]["14501"]["hosts"] == ["*.supabase.co", "api.stripe.com"]
    # The allowlist file is root-only.
    assert oct(os.stat(e.egress_file("notes", "prod")).st_mode & 0o777) == "0o600"


@pytest.mark.parametrize("host", ["metadata.google.internal", "*.google.internal", "db.internal",
                                  "printer.local", "x.localhost", "1.0.0.10.in-addr.arpa"])
def test_builtin_deny_cannot_be_allowlisted(e, monkeypatch, host):
    allocate(e)
    rc, doc = call(e, monkeypatch, ["set"], {"slug": "notes", "hosts": [host]})
    assert rc == 3 and doc["refused"], doc
    assert not os.path.exists(e.egress_file("notes", "dev"))


def test_admin_policy_bounds_the_owner(e, monkeypatch):
    allocate(e)
    Path(e.POLICY_PATH).write_text(json.dumps({
        "max_hosts": 2, "allow": ["*.example.com", "api.stripe.com"], "deny": ["evil.example.com"]}))
    os.chmod(e.POLICY_PATH, 0o644)
    assert call(e, monkeypatch, ["set"], {"slug": "notes", "hosts": ["a.example.com", "api.stripe.com"]})[0] == 0
    for hosts in (["api.github.com"], ["evil.example.com"], ["*.example.com"],
                  ["a.example.com", "b.example.com", "c.example.com"]):
        rc, doc = call(e, monkeypatch, ["set"], {"slug": "notes", "hosts": hosts})
        assert rc == 3, (hosts, doc)
    assert call(e, monkeypatch, ["set"], {"slug": "notes", "hosts": ["*.x.example.com"]})[0] == 0
    rc, doc = call(e, monkeypatch, ["policy"], {})
    assert doc["max_hosts"] == 2 and "evil.example.com" in doc["deny"] and "*.internal" in doc["deny"]


def test_a_policy_file_writable_by_others_is_ignored(e, monkeypatch):
    allocate(e)
    Path(e.POLICY_PATH).write_text(json.dumps({"max_hosts": 999, "deny": [], "allow": ["*"]}))
    os.chmod(e.POLICY_PATH, 0o666)
    assert e.load_policy()["max_hosts"] == e.DEFAULT_POLICY["max_hosts"]
    monkeypatch.setattr(e, "TRUSTED_UIDS", (0,))
    os.chmod(e.POLICY_PATH, 0o644)  # owned by the test user, not root
    assert e.load_policy()["max_hosts"] == e.DEFAULT_POLICY["max_hosts"]


@pytest.mark.parametrize("spec", [
    {"slug": "notes"}, {"hosts": []}, {"slug": "notes", "hosts": "a.com"},
    {"slug": "notes", "hosts": [], "extra": 1}, {"slug": "Bad", "hosts": []},
    {"slug": "notes", "mode": "staging", "hosts": []}, {"slug": "ghost", "hosts": []},
])
def test_set_rejects_bad_requests(e, monkeypatch, spec):
    allocate(e)
    rc, doc = call(e, monkeypatch, ["set"], spec)
    assert rc == 2 and doc["bad_input"], doc


def test_root_only_forms_and_unknown_verbs(e, monkeypatch):
    for argv in (["attach"], ["attach", "a", "b"], ["frobnicate"], []):
        assert call(e, monkeypatch, argv, {})[0] == 2
    monkeypatch.setattr(e.os, "geteuid", lambda: 1000)
    assert e.main(["policy"], io.StringIO("{}")) == 1


# --- nftables table ---------------------------------------------------------


def test_attach_loads_a_deny_by_default_table_for_the_instance_cgroup(e, monkeypatch):
    allocate(e, "notes", "dev", 4500, dsn_port=6432)
    allocate(e, "shop", "prod", 4600)
    cgroup(e, e.instance_cgroup("notes-dev"))
    cgroup(e, e.BUILD_SLICE)
    rc, doc = call(e, monkeypatch, ["attach", "notes-dev"])
    assert rc == 0, doc
    rules = (e.W / "nft.rules").read_text()
    assert rules.startswith("table inet aquarium_egress\ndelete table inet aquarium_egress\n")
    assert 'socket cgroupv2 level 2 "aquarium.slice/aquarium-apps.slice" jump apps' in rules
    assert 'socket cgroupv2 level 2 "aquarium.slice/aquarium-build.slice" jump build' in rules
    line = [x for x in rules.splitlines() if "aquarium-app@notes-dev.service" in x]
    assert line == ['    socket cgroupv2 level 3 "aquarium.slice/aquarium-apps.slice/aquarium-app@notes-dev.service"'
                    ' ip daddr 127.0.0.1 tcp dport { 4500, 6432, 14500 } accept']
    # No cgroup yet -> no rule (nft would refuse the path); still dropped by the slice chain.
    assert "aquarium-app@shop-prod" not in rules
    apps_chain = rules.split("chain apps {")[1].split("\n  }")[0]
    assert apps_chain.strip().endswith("counter drop")
    build_chain = rules.split("chain build {")[1].split("\n  }")[0]
    assert "ip daddr 127.0.0.1 tcp dport 14299 accept" in build_chain and build_chain.strip().endswith("counter drop")
    for port in ("9119", "8000", "5432"):  # dashboard, Kong, raw postgres: never opened
        assert f" {port}," not in rules and f"{port} }}" not in rules
    env = (Path(e.RUN_DIR) / "env" / "notes-dev.env").read_text()
    assert "HTTPS_PROXY=http://127.0.0.1:14500\n" in env and "NODE_USE_ENV_PROXY=1\n" in env


def test_admin_loopback_ports_are_opened_for_every_app(e, monkeypatch):
    allocate(e, "notes", "dev", 4500)
    cgroup(e, e.instance_cgroup("notes-dev"))
    Path(e.POLICY_PATH).write_text(json.dumps({"loopback_ports": [8765, "x", 70000]}))
    os.chmod(e.POLICY_PATH, 0o644)
    assert call(e, monkeypatch, ["attach", "notes-dev"])[0] == 0
    assert "tcp dport { 4500, 8765, 14500 } accept" in (e.W / "nft.rules").read_text()


def test_attach_fails_closed(e, monkeypatch):
    allocate(e)
    assert call(e, monkeypatch, ["attach", "notes-dev"])[0] == 1  # no cgroup: not run from its unit
    cgroup(e, e.instance_cgroup("notes-dev"))
    (e.W / "nft_bad").write_text("")
    rc, doc = call(e, monkeypatch, ["attach", "notes-dev"])
    assert rc == 1 and "nft refused" in doc["error"]
    assert call(e, monkeypatch, ["attach", "ghost-dev"])[0] == 1
    assert call(e, monkeypatch, ["attach", "../x-dev"])[0] == 2


@pytest.mark.skipif(os.geteuid() != 0 or not Path("/usr/sbin/nft").exists(), reason="needs root + nft")
def test_ruleset_is_valid_nft_syntax(e):
    script = e.ruleset([], apps_slice=False, build_slice=False)
    assert subprocess.run(["/usr/sbin/nft", "-c", "-f", "-"], input=script, text=True).returncode == 0


# --- enable / disable / units / sudoers ------------------------------------


def test_enable_installs_template_dropins_and_the_proxy(e, monkeypatch):
    rc, doc = call(e, monkeypatch, ["enable"])
    assert rc == 0, doc
    app = (Path(e.UNIT_DIR) / "aquarium-app@.service.d" / "20-egress.conf").read_text()
    assert "ExecStartPre=+/usr/bin/python3 -I /usr/local/sbin/aquarium-app-egress attach %i" in app
    assert f"EnvironmentFile=-{e.RUN_DIR}/env/%i.env" in app
    build = (Path(e.UNIT_DIR) / "aquarium-app-build@.service.d" / "20-egress.conf").read_text()
    assert "ExecStartPre=+/usr/bin/python3 -I /usr/local/sbin/aquarium-app-egress attach-build %i" in build
    assert "IPAddressAllow=127.0.0.1/32" in build and "npm_config_https_proxy=http://127.0.0.1:14299" in build
    assert "systemctl enable --now aquarium-app-egress-proxy.service" in (e.W / "calls").read_text()
    rc, doc = call(e, monkeypatch, ["disable"])
    assert rc == 0 and not list(Path(e.UNIT_DIR).glob("*/20-egress.conf"))
    assert "nft delete table inet aquarium_egress" in (e.W / "calls").read_text()


def test_sudoers_grants_only_the_request_verbs():
    lines = [x for x in SUDOERS.read_text().splitlines() if "aquarium-app-egress" in x and not x.startswith("#")]
    assert sorted(x.split()[-1] for x in lines) == ["get", "policy", "set", "status"]
    for x in lines:
        assert x.startswith("hermes ALL=(root) NOPASSWD: /usr/local/sbin/aquarium-app-egress ")
    if Path("/usr/sbin/visudo").exists():
        assert subprocess.run(["/usr/sbin/visudo", "-cf", str(SUDOERS)], capture_output=True).returncode == 0


def test_sudo_verbs_match_the_helper(e):
    granted = {x.split()[-1] for x in SUDOERS.read_text().splitlines() if "aquarium-app-egress " in x
               and not x.startswith("#")}
    assert granted == set(e.SUDO_VERBS)


def test_proxy_unit_is_unprivileged_and_refreshes_first():
    text = PROXY_UNIT.read_text()
    assert "DynamicUser=yes" in text and "CapabilityBoundingSet=\n" in text
    assert "ExecStartPre=+/usr/bin/python3 -I /usr/local/sbin/aquarium-app-egress refresh" in text
    assert "ExecStart=/usr/bin/python3 -I /usr/local/sbin/aquarium-app-egress proxy" in text
    assert re.search(r"^IPAddressDeny=.*10\.0\.0\.0/8", text, re.M)


def test_proxy_refuses_to_run_as_root(e, monkeypatch):
    monkeypatch.setattr(e.os, "geteuid", lambda: 0)
    with pytest.raises(e.HelperError):
        e.cmd_proxy()


# --- supply-chain gate ------------------------------------------------------


def pkg(name, version="1.0.0", **kw):
    entry = {"version": version, "resolved": f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz",
             "integrity": "sha512-AAAA"}
    entry.update(kw)
    return entry


def lockfile(**packages):
    return {"name": "app", "lockfileVersion": 3,
            "packages": {"": {"name": "app"}, **{f"node_modules/{k}": v for k, v in packages.items()}}}


GOOD = lockfile(next=pkg("next", "15.0.0"), react=pkg("react", "19.0.0"))
LOCK_CASES = {
    "good": GOOD,
    "v1": {"lockfileVersion": 1, "dependencies": {}},
    "no_packages": {"lockfileVersion": 3},
    "git_dep": lockfile(evil=pkg("evil", resolved="git+https://github.com/x/evil.git")),
    "tarball_url": lockfile(evil=pkg("evil", resolved="https://evil.example.com/evil.tgz")),
    "no_integrity": lockfile(evil=pkg("evil", integrity=None)),
    "sha1": lockfile(evil=pkg("evil", integrity="sha1-abc")),
    "link": {"lockfileVersion": 3, "packages": {"": {}, "node_modules/x": {"link": True, "resolved": "../x"}}},
    "workspace": {"lockfileVersion": 3, "packages": {"": {}, "packages/x": {"version": "1.0.0"}}},
    "bad_version": lockfile(x=pkg("x", version="1.0.0 || rm -rf")),
    "bundled": lockfile(x=pkg("x"), **{"x/node_modules/y": {"version": "2.0.0", "inBundle": True}}),
    "scoped": lockfile(**{"@scope/x": pkg("@scope/x")}),
    "not_a_dict": [],
}


@pytest.mark.parametrize("case", sorted(LOCK_CASES))
def test_lockfile_rules_match_tools_osv_check(e, case):
    """The root gate and tools/osv_check.check_lockfile must apply identical rules."""
    assert e.lockfile_findings(LOCK_CASES[case], 3000) == osv_check.lockfile_findings(LOCK_CASES[case], 3000)


def test_lockfile_ceiling(e):
    many = lockfile(**{f"p{i}": pkg(f"p{i}") for i in range(5)})
    assert e.lockfile_findings(many, 4)[0] and not e.lockfile_findings(many, 5)[0]


def stage_build(e, lock, inst="notes-dev", name="package-lock.json"):
    src = e.W / "stage" / "source.tar"
    src.parent.mkdir(exist_ok=True)
    with tarfile.open(src, "w") as tar:
        for fname, data in (("package.json", b"{}"), (name, json.dumps(lock).encode())):
            if fname is None:
                continue
            info = tarfile.TarInfo(fname)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    d = Path(e.RUN_UNIT_DIR) / f"aquarium-app-build@{inst}.service.d"
    d.mkdir(parents=True, exist_ok=True)
    (d / "10-stage.conf").write_text(f"[Service]\nStandardInput=file:{src}\nStandardOutput=truncate:/x\n")
    cgroup(e, e.build_cgroup(inst))


def fake_osv(monkeypatch, e, answer):
    asked = []

    def querybatch(queries):
        asked.append(queries)
        if isinstance(answer, Exception):
            raise answer
        return answer(queries) if callable(answer) else answer

    monkeypatch.setattr(e, "osv_querybatch", querybatch)
    return asked


def test_build_gate_passes_a_clean_lockfile(e, monkeypatch):
    stage_build(e, GOOD)
    asked = fake_osv(monkeypatch, e, lambda qs: [{} for _ in qs])
    rc, doc = call(e, monkeypatch, ["attach-build", "notes-dev"])
    assert rc == 0, doc
    assert doc["supply_chain"] == {"packages": 2, "osv": "clean"}
    assert {q["package"]["name"] for q in asked[0]} == {"next", "react"}
    assert all(q["package"]["ecosystem"] == "npm" and q["version"] for q in asked[0])
    assert "chain build" in (e.W / "nft.rules").read_text()


@pytest.mark.parametrize("answer", [
    lambda qs: [{"vulns": [{"id": "MAL-2025-1"}]} if q["package"]["name"] == "react" else {} for q in qs],
    OSError("network unreachable"),
    lambda qs: [{}],                                   # fewer results than packages
    lambda qs: None,
    lambda qs: [{"next_page_token": "x"} for _ in qs],  # incomplete
    lambda qs: ["nope" for _ in qs],
])
def test_build_gate_fails_closed(e, monkeypatch, answer):
    stage_build(e, GOOD)
    fake_osv(monkeypatch, e, answer)
    rc, doc = call(e, monkeypatch, ["attach-build", "notes-dev"])
    assert rc == 3 and doc["refused"], doc


def test_build_gate_ignores_plain_cves(e, monkeypatch):
    stage_build(e, GOOD)
    fake_osv(monkeypatch, e, lambda qs: [{"vulns": [{"id": "GHSA-xxxx"}, {"id": "CVE-2024-1"}]} for _ in qs])
    assert call(e, monkeypatch, ["attach-build", "notes-dev"])[0] == 0


@pytest.mark.parametrize("case", ["git_dep", "tarball_url", "no_integrity", "v1", "link"])
def test_build_gate_refuses_unpinned_lockfiles_before_asking_osv(e, monkeypatch, case):
    stage_build(e, LOCK_CASES[case])
    asked = fake_osv(monkeypatch, e, lambda qs: [{} for _ in qs])
    assert call(e, monkeypatch, ["attach-build", "notes-dev"])[0] == 3
    assert asked == []


def test_build_gate_refuses_a_missing_lockfile_and_a_foreign_stage(e, monkeypatch):
    stage_build(e, GOOD, name="yarn.lock")
    fake_osv(monkeypatch, e, lambda qs: [{} for _ in qs])
    rc, doc = call(e, monkeypatch, ["attach-build", "notes-dev"])
    assert rc == 3 and "package-lock.json" in doc["error"]
    stage_build(e, GOOD)
    monkeypatch.setattr(e, "TRUSTED_UIDS", (0,))  # stage owned by a non-root user
    assert call(e, monkeypatch, ["attach-build", "notes-dev"])[0] == 1


def test_osv_off_still_checks_the_lockfile(e, monkeypatch):
    Path(e.POLICY_PATH).write_text(json.dumps({"osv": "off"}))
    os.chmod(e.POLICY_PATH, 0o644)
    stage_build(e, GOOD)
    asked = fake_osv(monkeypatch, e, OSError("must not be called"))
    assert call(e, monkeypatch, ["attach-build", "notes-dev"])[0] == 0 and asked == []
    stage_build(e, LOCK_CASES["git_dep"])
    assert call(e, monkeypatch, ["attach-build", "notes-dev"])[0] == 3
    assert allow_json(e)["listeners"]["14299"]["hosts"] == ["registry.npmjs.org"]


# --- the allowlisting proxy --------------------------------------------------


@pytest.mark.parametrize("addr,ok", [
    ("93.184.216.34", True), ("2606:4700::1111", True), ("127.0.0.1", False), ("10.1.2.3", False),
    ("172.20.0.5", False), ("192.168.1.1", False), ("169.254.169.254", False), ("100.64.0.1", False),
    ("::1", False), ("fd00::1", False), ("fe80::1%eth0", False), ("::ffff:10.0.0.1", False),
    ("0.0.0.0", False), ("224.0.0.1", False), ("nonsense", False),
])
def test_proxy_connects_only_to_public_addresses(e, addr, ok):
    assert e.addr_ok(addr) is ok


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_proxy_end_to_end(e, tmp_path, monkeypatch):
    listen = free_port()
    allow = tmp_path / "allow.json"
    allow.write_text(json.dumps({"ports": [443, 8443], "deny": [], "allow": ["*"], "listeners": {
        str(listen): {"inst": "notes-dev", "hosts": ["api.example.com", "*.rebind.example.org"]}}}))
    log = []
    proxy = e.Proxy(str(allow), log=log.append)
    resolved = {"api.example.com": "127.0.0.1", "x.rebind.example.org": "10.0.0.7"}

    async def resolve(host, port):
        return [resolved[host]]

    proxy.resolve = resolve
    monkeypatch.setattr(e, "addr_ok", lambda a: a == "127.0.0.1" or e.ipaddress.ip_address(a).is_global)

    async def scenario():
        async def echo(reader, writer):
            writer.write(b"upstream:" + await reader.read(100))
            await writer.drain()
            writer.close()

        upstream = await asyncio.start_server(echo, "127.0.0.1", 0)
        up_port = upstream.sockets[0].getsockname()[1]
        data = json.loads(allow.read_text())
        data["ports"].append(up_port)
        allow.write_text(json.dumps(data))
        stop = asyncio.Event()
        task = asyncio.create_task(proxy.serve(stop, poll=0.05))
        for _ in range(100):
            if listen in proxy.servers:
                break
            await asyncio.sleep(0.02)

        async def ask(line, payload=b""):
            r, w = await asyncio.open_connection("127.0.0.1", listen)
            w.write(line.encode() + b"\r\nHost: x\r\n\r\n")
            await w.drain()
            status = (await r.readline()).decode()
            body = b""
            if " 200 " in status:
                while (await r.readline()) not in (b"\r\n", b""):
                    pass
                w.write(payload)
                await w.drain()
                body = await r.read(100)
            w.close()
            return status, body

        out = {
            "ok": await ask(f"CONNECT api.example.com:{up_port} HTTP/1.1", b"hello"),
            "not_listed": await ask(f"CONNECT api.github.com:{up_port} HTTP/1.1"),
            "bad_port": await ask("CONNECT api.example.com:22 HTTP/1.1"),
            "plain_http": await ask("GET http://api.example.com/ HTTP/1.1"),
            "ip_literal": await ask(f"CONNECT 127.0.0.1:{up_port} HTTP/1.1"),
            "rebind": await ask(f"CONNECT x.rebind.example.org:{up_port} HTTP/1.1"),
        }
        stop.set()
        await task
        upstream.close()
        return out

    out = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert out["ok"] == ("HTTP/1.1 200 Connection Established\r\n", b"upstream:hello")
    for case in ("not_listed", "bad_port", "ip_literal", "rebind"):
        assert out[case][0].startswith("HTTP/1.1 403"), (case, out[case])
    assert out["plain_http"][0].startswith("HTTP/1.1 405")
    reasons = {d.get("host"): d.get("reason") for d in log if d["event"] == "deny"}
    assert reasons["api.github.com"] == "not on this app's egress allowlist"
    assert reasons["x.rebind.example.org"] == "resolves to a non-public address"


def test_proxy_verdict_applies_policy_deny_and_unknown_listeners(e, tmp_path):
    allow = tmp_path / "allow.json"
    allow.write_text(json.dumps({"ports": [443], "deny": ["*.corp.example.com"], "allow": ["*"],
                                 "listeners": {"14500": {"inst": "a-dev", "hosts": ["*.example.com"]}}}))
    proxy = e.Proxy(str(allow), log=lambda d: None)
    proxy.load()
    assert proxy.verdict(14500, "api.example.com", 443) is None
    assert proxy.verdict(14500, "db.corp.example.com", 443) == "denied by the admin policy"
    assert proxy.verdict(14500, "metadata.google.internal", 443) == "denied by the admin policy"
    assert proxy.verdict(14501, "api.example.com", 443) == "no egress for this listener"
    allow.write_text("not json")
    os.utime(allow, ns=(1, 1))
    assert proxy.load() and proxy.verdict(14500, "api.example.com", 443) == "no egress for this listener"
