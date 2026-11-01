"""install-aquarium.sh from a git clone: options, instance settings, preflight, copy, update.

Runs the real helpers from deploy/install/lib.sh in bash against temp dirs; system
commands the preflight reads (ss, getent, hostname, df, uname, nproc, id) are stubs.
"""
import importlib.util
import os
import stat
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "deploy" / "install" / "lib.sh"
INSTALLER = ROOT / "install-aquarium.sh"
UPDATE = ROOT / "scripts" / "aquarium-update.sh"


def _bash(body, env=None, cwd=None):
    script = f"set -Eeuo pipefail\n. '{LIB}'\n{textwrap.dedent(body)}"
    full = {k: v for k, v in os.environ.items() if not k.startswith("AQUARIUM_")}
    full.update(env or {})
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, env=full, cwd=cwd)


def _parse(*args, env=None):
    quoted = " ".join("'" + a.replace("'", "'\\''") + "'" for a in args)
    return _bash(
        f"""BRANCH=develop
        aq_parse_args {quoted}
        echo "mode=$SOURCE_MODE check=$CHECK_ONLY yes=$ASSUME_YES set=[$ARG_SET] home=$ARG_HOME_DOMAIN org=$ARG_ORG_NAME"
        """,
        env=env,
    )


# ------------------------------------------------------------------ options

def test_a_clone_is_installed_by_default_and_a_pipe_still_gets_the_stable_release():
    assert _parse(env={"AQ_CHECKOUT": "/src"}).stdout.startswith("mode=checkout ")
    assert _parse().stdout.startswith("mode=release ")
    # An explicit source or the older AQUARIUM_BRANCH wins over the clone.
    assert _parse("--version", "v1.2.3", env={"AQ_CHECKOUT": "/src"}).stdout.startswith("mode=release ")
    assert _parse(env={"AQ_CHECKOUT": "/src", "AQUARIUM_BRANCH": "develop"}).stdout.startswith("mode=branch ")


def test_from_checkout_needs_a_clone_and_excludes_other_sources():
    out = _parse("--from-checkout")
    assert out.returncode != 0 and "git clone" in out.stderr
    out = _parse("--from-checkout", "--from-branch", "x", env={"AQ_CHECKOUT": "/src"})
    assert out.returncode != 0 and "only one of" in out.stderr


def test_instance_options_check_and_yes():
    out = _parse("--check", "--yes", "--home-domain=App.Example.org", "--org-name", "Example Org",
                 "--dashboard-domain", "", env={"AQ_CHECKOUT": "/src"})
    assert out.returncode == 0, out.stderr
    line = out.stdout.strip()
    assert "check=1 yes=1" in line
    assert "set=[ HOME_DOMAIN ORG_NAME DASHBOARD_DOMAIN ]" in line
    assert "home=App.Example.org org=Example Org" in line
    for bad in (["--home-domain"], ["--bogus"]):
        assert _parse(*bad).returncode != 0


# ------------------------------------------------------------------ settings

def _resolve(tmp_path, *args, env=None, answers=None):
    env = dict(env or {}, AQ_INSTANCE_CONF=str(tmp_path / "aquarium.conf"))
    if answers is not None:
        (tmp_path / "tty").write_text("".join(a + "\n" for a in answers))
        env["AQ_TTY"] = str(tmp_path / "tty")
    else:
        env["AQ_TTY"] = str(tmp_path / "no-tty")
    quoted = " ".join("'" + a + "'" for a in args)
    return _bash(
        f"""aq_parse_args {quoted}
        aq_resolve_instance
        for k in $AQ_INSTANCE_KEYS; do echo "$k=${{!k}}"; done
        aq_save_instance DATA_ROOT=/opt/data INSTALL_SOURCE=checkout
        """,
        env=env,
    )


def _settings(out):
    return dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)


def test_non_interactive_defaults_and_precedence(tmp_path):
    out = _resolve(tmp_path, "--org-name", "From Option", env={
        "AQUARIUM_ORG_NAME": "From Env", "AQUARIUM_HOME_DOMAIN": "Home.Example.ORG."})
    assert out.returncode == 0, out.stderr
    assert _settings(out) == {"ORG_NAME": "From Option", "HOME_DOMAIN": "home.example.org",
                              "DASHBOARD_DOMAIN": "", "OWNER_ID": "admin", "OWNER_EMAIL": ""}


def test_answers_are_saved_and_a_rerun_asks_nothing(tmp_path):
    out = _resolve(tmp_path, answers=["Example Org", "not a domain!", "app.example.org",
                                      "admin.example.org", "", "It@Example.org", "y"])
    assert out.returncode == 0, out.stderr
    assert "is not a host name" in out.stderr  # asked again after a bad answer
    first = _settings(out)
    assert first["ORG_NAME"] == "Example Org" and first["OWNER_EMAIL"] == "it@example.org"
    conf = (tmp_path / "aquarium.conf").read_text()
    assert 'ORG_NAME="Example Org"' in conf and "INSTALL_SOURCE=checkout" in conf
    assert stat.S_IMODE((tmp_path / "aquarium.conf").stat().st_mode) == 0o644
    # Re-run with a terminal but no answers left: everything comes from the file.
    again = _resolve(tmp_path, answers=[])
    assert again.returncode == 0, again.stderr
    assert _settings(again) == first
    assert (tmp_path / "aquarium.conf").read_text() == conf


def test_the_saved_file_reads_the_same_in_the_aquarium_admin_command(tmp_path):
    assert _resolve(tmp_path, "--org-name", "Ex Org", "--owner-email", "a@b.org").returncode == 0
    spec = importlib.util.spec_from_file_location("aq_admin", ROOT / "deploy" / "aquarium.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    kv = mod.read_kv(tmp_path / "aquarium.conf")
    assert kv["ORG_NAME"] == "Ex Org" and kv["OWNER_EMAIL"] == "a@b.org" and kv["DATA_ROOT"] == "/opt/data"


def test_declining_the_summary_changes_nothing(tmp_path):
    out = _resolve(tmp_path, answers=["Org", "", "", "", "", "n"])
    assert out.returncode != 0 and "nothing was changed" in out.stderr
    assert not (tmp_path / "aquarium.conf").exists()


@pytest.mark.parametrize("args", [
    ["--home-domain", "https://app.example.org"],
    ["--home-domain", "app.example.org:8443"],
    ["--home-domain", "same.example.org", "--dashboard-domain", "same.example.org"],
    ["--owner-email", "nobody"],
    ["--org-name", 'Bad "quote"'],
    ["--owner-id", "has space"],
])
def test_invalid_settings_are_refused_before_anything_is_written(tmp_path, args):
    out = _resolve(tmp_path, *args)
    assert out.returncode != 0
    assert not (tmp_path / "aquarium.conf").exists()


def test_conf_set_replaces_keys_and_keeps_other_lines(tmp_path):
    conf = tmp_path / "aquarium.conf"
    conf.write_text("# mine\nREPO=leolau/aquarium\nORG_NAME=Old\nORG_NAME=Dup\n")
    out = _bash(f"aq_conf_set '{conf}' ORG_NAME='New Org' HOME_DOMAIN=a.example.org\n"
                f"aq_conf_get '{conf}' ORG_NAME; aq_conf_get '{conf}' MISSING || echo absent")
    assert out.returncode == 0, out.stderr
    assert out.stdout.split("\n")[:2] == ["New Org", "absent"]
    assert conf.read_text() == '# mine\nREPO=leolau/aquarium\nORG_NAME="New Org"\nHOME_DOMAIN=a.example.org\n'


# ------------------------------------------------------------------ preflight

def _stub(bin_dir, name, body):
    path = bin_dir / name
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


def _preflight(tmp_path, *domains, os_id="ubuntu", ver="24.04", mem_kb=16 * 1048576, disk="80G",
               ss="", resolves=None):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    rootfs = tmp_path / "rootfs"
    (rootfs / "etc").mkdir(parents=True, exist_ok=True)
    (rootfs / "proc").mkdir(exist_ok=True)
    (rootfs / "etc" / "os-release").write_text(f'ID={os_id}\nVERSION_ID="{ver}"\n')
    (rootfs / "proc" / "meminfo").write_text(f"MemTotal: {mem_kb} kB\n")
    _stub(bin_dir, "uname", "echo x86_64")
    _stub(bin_dir, "nproc", "echo 4")
    _stub(bin_dir, "id", "echo 0")
    _stub(bin_dir, "df", f"printf 'Avail\\n {disk}\\n'")
    _stub(bin_dir, "hostname", "echo 203.0.113.5")
    (tmp_path / "ss.out").write_text(ss)
    _stub(bin_dir, "ss", f"cat '{tmp_path / 'ss.out'}'")
    cases = "".join(f'  {d}) echo "{ip} STREAM {d}";;\n' for d, ip in (resolves or {}).items())
    _stub(bin_dir, "getent", f'case "$2" in\n{cases}  *) exit 2;;\nesac')
    quoted = " ".join(f"'{d}'" for d in domains)
    return _bash(f"aq_preflight {quoted}", env={
        "PATH": f"{bin_dir}:{os.environ['PATH']}", "AQ_ROOTFS": str(rootfs)})


def test_preflight_ready_server(tmp_path):
    out = _preflight(tmp_path, "app.example.org", resolves={"app.example.org": "203.0.113.5"})
    assert out.returncode == 0, out.stdout + out.stderr
    assert "FAIL" not in out.stdout and "warn" not in out.stdout
    assert "DNS: app.example.org -> 203.0.113.5 (this server)" in out.stdout


def test_preflight_reports_blockers(tmp_path):
    ss = 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))\n'
    out = _preflight(tmp_path, "app.example.org", "dash.example.org", os_id="debian", ver="12",
                     mem_kb=2 * 1048576, disk="10G", ss=ss,
                     resolves={"dash.example.org": "198.51.100.7"})
    assert out.returncode == 1
    text = out.stdout
    for needle in ("FAIL  OS: debian 12", "FAIL  memory: 2 GB", "FAIL  free disk: 10 GB",
                   "FAIL  port 80 is in use", "ok    port 443 is free",
                   "warn  DNS: app.example.org does not resolve yet",
                   "warn  DNS: dash.example.org -> 198.51.100.7, but this server"):
        assert needle in text, text


def test_preflight_without_domains_only_warns_about_busy_ports(tmp_path):
    ss = 'LISTEN 0 511 [::]:443 [::]:* users:(("nginx",pid=1,fd=6))\n'
    out = _preflight(tmp_path, "", "", ss=ss)
    assert out.returncode == 0, out.stdout
    assert "warn  port 443 is in use" in out.stdout


def test_check_mode_runs_without_root_and_changes_nothing(tmp_path):
    conf = tmp_path / "etc" / "aquarium.conf"
    env = {k: v for k, v in os.environ.items() if not k.startswith("AQUARIUM_")}
    env.update(AQ_INSTANCE_CONF=str(conf), AQUARIUM_ROOT=str(tmp_path / "data"))
    out = subprocess.run(["bash", str(INSTALLER), "--check", "--home-domain", "app.invalid"],
                         capture_output=True, text=True, env=env, stdin=subprocess.DEVNULL)
    assert out.returncode in (0, 1), out.stderr
    assert "Preflight (read-only" in out.stdout and "DNS: app.invalid" in out.stdout
    assert not conf.exists() and not (tmp_path / "data").exists()


def test_help_lists_the_new_options():
    out = subprocess.run(["bash", str(INSTALLER), "--help"], capture_output=True, text=True)
    assert out.returncode == 0
    for opt in ("--from-checkout", "--org-name", "--home-domain", "--owner-email", "--yes", "--check"):
        assert opt in out.stdout


# ------------------------------------------------------------------ copying the clone

def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd,
                   check=True, capture_output=True)


def test_sync_checkout_copies_the_clone_and_keeps_installed_dependencies(tmp_path):
    src = tmp_path / "clone"
    (src / "agent-home").mkdir(parents=True)
    (src / "app.py").write_text("v1\n")
    (src / "agent-home" / "page.tsx").write_text("x\n")
    _git(src, "init", "-q", "-b", "develop")
    _git(src, "add", ".")
    _git(src, "commit", "-qm", "init")
    (src / "node_modules").mkdir()
    (src / "node_modules" / "dev-only").write_text("x")
    (src / ".env").write_text("SECRET=1\n")
    dest = tmp_path / "data" / "hermes-agent"
    (dest / "node_modules").mkdir(parents=True)
    (dest / "node_modules" / "installed").write_text("keep")
    (dest / "stale.py").write_text("gone\n")

    out = _bash(f"aq_sync_checkout '{src}' '{dest}'")
    assert out.returncode == 0, out.stderr
    assert (dest / "app.py").read_text() == "v1\n" and (dest / ".git").is_dir()
    assert (dest / "node_modules" / "installed").exists()
    assert not (dest / "node_modules" / "dev-only").exists()
    assert not (dest / ".env").exists() and not (dest / "stale.py").exists()
    head = subprocess.run(["git", "-C", str(dest), "rev-parse", "--abbrev-ref", "HEAD"],
                          capture_output=True, text=True).stdout.strip()
    assert head == "develop"

    (src / "app.py").write_text("v2-uncommitted\n")
    out = _bash(f"aq_sync_checkout '{src}' '{dest}'")
    assert out.returncode == 0 and "uncommitted changes" in out.stderr
    # Installing a clone into itself copies nothing; into a folder inside it is refused.
    assert _bash(f"aq_sync_checkout '{src}' '{src}'").returncode == 0
    assert _bash(f"aq_sync_checkout '{src}' '{src}/sub'").returncode != 0
    assert _bash(f"aq_sync_checkout '{tmp_path / 'data'}' '{dest}'").returncode != 0


# ------------------------------------------------------------------ update script

def _update_env(tmp_path, conf_text):
    rootfs = tmp_path / "rootfs"
    (rootfs / "etc" / "aquarium").mkdir(parents=True)
    (rootfs / "etc" / "aquarium" / "aquarium.conf").write_text(conf_text)
    data = rootfs / "opt" / "data"
    (data / "hermes-agent" / "deploy").mkdir(parents=True)
    log = tmp_path / "calls"
    deploy = data / "deploy-hermes.sh"
    deploy.write_text(f"#!/bin/sh\necho \"deploy $*\" >> '{log}'\n")
    deploy.chmod(0o755)
    (data / "hermes-agent" / "deploy" / "hermes-deploy.sh").write_text(deploy.read_text())
    (rootfs / "usr" / "local" / "sbin").mkdir(parents=True)
    admin = rootfs / "usr" / "local" / "sbin" / "aquarium"
    admin.write_text(f"#!/bin/sh\necho \"aquarium $*\" >> '{log}'\n")
    admin.chmod(0o755)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(bin_dir, "id", "echo 0")
    env = dict(os.environ, AQ_ROOTFS=str(rootfs), PATH=f"{bin_dir}:{os.environ['PATH']}")
    return env, log, data


def _update(env, *args):
    return subprocess.run(["bash", str(UPDATE), *args], capture_output=True, text=True, env=env)


def test_update_runs_the_deploy_script_for_the_installed_branch(tmp_path):
    env, log, data = _update_env(tmp_path, "DATA_ROOT=/opt/data\nINSTALL_SOURCE=checkout\nBRANCH=org-main\n")
    out = _update(env)
    assert out.returncode == 0, out.stderr
    assert log.read_text() == "deploy org-main\n"
    out = _update(env, "develop")
    assert out.returncode == 0 and log.read_text().endswith("deploy develop\n")
    assert _update(env, "--version", "v1.0.0").returncode != 0


def test_update_installs_a_newer_deploy_script_and_runs_it_again(tmp_path):
    env, log, data = _update_env(tmp_path, "DATA_ROOT=/opt/data\nINSTALL_SOURCE=branch\nBRANCH=develop\n")
    newer = data / "hermes-agent" / "deploy" / "hermes-deploy.sh"
    newer.write_text(f"#!/bin/sh\necho \"new-deploy $*\" >> '{log}'\n")
    out = _update(env)
    assert out.returncode == 0, out.stderr
    assert log.read_text() == "deploy develop\nnew-deploy develop\n"
    assert (data / "deploy-hermes.sh").read_text() == newer.read_text()


def test_update_hands_release_installs_to_the_admin_command(tmp_path):
    env, log, _ = _update_env(tmp_path, "DATA_ROOT=/opt/data\nINSTALL_SOURCE=release\n")
    out = _update(env, "--channel", "beta")
    assert out.returncode == 0, out.stderr
    assert log.read_text() == "aquarium update --channel beta\n"


def test_update_refuses_without_the_instance_file_or_root(tmp_path):
    env, _, _ = _update_env(tmp_path, "")
    (Path(env["AQ_ROOTFS"]) / "etc" / "aquarium" / "aquarium.conf").unlink()
    out = _update(env)
    assert out.returncode != 0 and "aquarium.conf not found" in out.stderr
    _stub(tmp_path / "bin", "id", "echo 1000")
    assert "run as root" in _update(env).stderr


def test_update_script_passes_shellcheck():
    from shutil import which
    if not which("shellcheck"):
        pytest.skip("shellcheck not installed")
    out = subprocess.run(["shellcheck", "-S", "warning", str(UPDATE)], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout
