"""Release install helpers of install-aquarium.sh (deploy/install/lib.sh).

Each helper runs for real in bash against temp directories: real tarballs, real sha256 checks,
a real git repository for the pinned Supabase checkout. Only the outside world is stubbed —
cosign (the signature check itself needs Sigstore), apt-get/modprobe/visudo/sshd.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
LIB = REPO_ROOT / "deploy" / "install" / "lib.sh"
PINS = REPO_ROOT / "deploy" / "install" / "pins.env"
LOCK = REPO_ROOT / "deploy" / "install" / "supabase-images.lock"
SCRIPT = REPO_ROOT / "install-aquarium.sh"
TEXT = SCRIPT.read_text()
OWNER = f"{os.getuid()}:{os.getgid()}"


def _lib(snippet: str, env: dict | None = None, stubs: Path | None = None) -> subprocess.CompletedProcess:
    base = {k: v for k, v in os.environ.items() if not k.startswith(("AQUARIUM_", "AQ_"))}
    full = {**base, "AQ_CODE_OWNER": OWNER, **(env or {})}
    if stubs:
        full["PATH"] = f"{stubs}:{full['PATH']}"
    return subprocess.run(
        ["bash", "-c", f"set -Eeuo pipefail\n. '{LIB}'\n. '{PINS}'\n{snippet}"],
        capture_output=True, text=True, env=full, timeout=60,
    )


def _stub(bin_dir: Path, name: str, body: str) -> None:
    bin_dir.mkdir(parents=True, exist_ok=True)
    path = bin_dir / name
    path.write_text(f"#!/usr/bin/env bash\n{body}\n")
    path.chmod(0o755)


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _parse(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    quoted = " ".join(f"'{a}'" for a in args)
    return _lib(
        f'BRANCH=develop\naq_parse_args {quoted}\n'
        'echo "mode=$SOURCE_MODE version=$REQ_VERSION channel=$CHANNEL branch=$BRANCH"',
        env,
    )


# ------------------------------------------------------------------ command line
@pytest.mark.parametrize(
    "args, expected",
    [
        ((), "mode=release version= channel=stable branch=develop"),
        (("--version", "v1.2.3"), "mode=release version=v1.2.3 channel=stable branch=develop"),
        (("--version", "v1.2.3-rc.1"), "mode=release version=v1.2.3-rc.1 channel=stable branch=develop"),
        (("--channel", "beta"), "mode=release version= channel=beta branch=develop"),
        (("--from-branch", "feature/x"), "mode=branch version= channel=stable branch=feature/x"),
    ],
)
def test_parse_args_picks_the_source(args, expected):
    out = _parse(*args)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == expected


def test_aquarium_branch_env_keeps_the_old_branch_install():
    out = _parse(env={"AQUARIUM_BRANCH": "develop"})
    assert out.stdout.strip().startswith("mode=branch")
    # An explicit release option still wins over the environment.
    assert _parse("--version", "v2.0.0", env={"AQUARIUM_BRANCH": "develop"}).stdout.startswith("mode=release")


@pytest.mark.parametrize(
    "args, message",
    [
        (("--version", "1.2.3"), "must look like v1.2.3"),
        (("--version", "v1.2.3;rm -rf /"), "must look like v1.2.3"),
        (("--version", "../v1.2.3"), "must look like v1.2.3"),
        (("--channel", "nightly"), "stable or beta"),
        (("--version", "v1.2.3", "--channel", "beta"), "only one of"),
        (("--version",), "needs a value"),
        (("--bogus",), "unknown option"),
    ],
)
def test_parse_args_rejects_bad_input(args, message):
    out = _parse(*args)
    assert out.returncode != 0
    assert message in out.stderr


def test_installer_help_and_bad_options_exit_before_touching_the_machine():
    # Runs the real script (not as root): option errors must stop it before the root guard.
    env = {k: v for k, v in os.environ.items() if not k.startswith("AQUARIUM_")}
    ok = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True, env=env, cwd=REPO_ROOT)
    assert ok.returncode == 0 and "--version vX.Y.Z" in ok.stdout
    bad = subprocess.run(["bash", str(SCRIPT), "--channel", "x"], capture_output=True, text=True, env=env, cwd=REPO_ROOT)
    assert bad.returncode != 0 and "stable or beta" in bad.stderr


# ------------------------------------------------------------------ channel -> tag
RELEASES = [
    {"tag_name": "v2.0.0-rc.1", "prerelease": True, "draft": False},
    {"tag_name": "v1.9.0", "prerelease": False, "draft": True},
    {"tag_name": "nightly", "prerelease": False, "draft": False},
    {"tag_name": "v1.8.0", "prerelease": False, "draft": False},
]


@pytest.mark.parametrize("channel, tag", [("stable", "v1.8.0"), ("beta", "v2.0.0-rc.1")])
def test_pick_release_by_channel(tmp_path, channel, tag):
    (tmp_path / "r.json").write_text(json.dumps(RELEASES))
    out = _lib(f"aq_pick_release {channel} < '{tmp_path / 'r.json'}'")
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == tag


def test_resolve_version_fails_clearly_when_nothing_is_published(tmp_path):
    api = tmp_path / "api" / "repos" / "leolau" / "aquarium"
    api.mkdir(parents=True)
    (api / "releases").write_text(json.dumps([{"tag_name": "v1.0.0-beta", "prerelease": True}]))
    # curl treats the query string as part of a file:// path, so serve the list via a stub.
    stubs = tmp_path / "bin"
    _stub(stubs, "curl", f'cat "{api / "releases"}"')
    out = _lib("CHANNEL=stable REQ_VERSION=\naq_resolve_version", stubs=stubs)
    assert out.returncode != 0 and "no stable release" in out.stderr
    out = _lib("CHANNEL=beta REQ_VERSION=\naq_resolve_version", stubs=stubs)
    assert out.returncode == 0 and out.stdout.strip() == "v1.0.0-beta"


# ------------------------------------------------------------------ pinned downloads
def test_fetch_verified_keeps_only_a_matching_file(tmp_path):
    src = tmp_path / "blob"
    src.write_bytes(b"real bytes")
    dest = tmp_path / "out"
    good = _lib(f"aq_fetch_verified 'file://{src}' {_sha(src)} '{dest}'")
    assert good.returncode == 0, good.stderr
    assert dest.read_bytes() == b"real bytes"
    dest.unlink()
    bad = _lib(f"aq_fetch_verified 'file://{src}' {'0' * 64} '{dest}'")
    assert bad.returncode != 0 and "checksum mismatch" in bad.stderr
    assert not dest.exists() and list(tmp_path.glob("out.*")) == []


def test_install_cosign_uses_the_pinned_digest(tmp_path):
    dl = tmp_path / "dl" / "sigstore" / "cosign" / "releases" / "download" / "v9.9.9"
    dl.mkdir(parents=True)
    (dl / "cosign-linux-amd64").write_bytes(b"#!/bin/sh\necho cosign\n")
    digest = _sha(dl / "cosign-linux-amd64")
    env = {"AQ_GITHUB_DL": f"file://{tmp_path / 'dl'}", "AQ_TOOLS": str(tmp_path / "tools")}
    pins = f"COSIGN_VERSION=v9.9.9 COSIGN_SHA256={digest}\n"
    first = _lib(pins + "aq_install_cosign", env)
    assert first.returncode == 0, first.stderr
    installed = Path(first.stdout.strip())
    assert installed == tmp_path / "tools" / "cosign-v9.9.9" and os.access(installed, os.X_OK)
    # Already-installed and intact: no download needed.
    (dl / "cosign-linux-amd64").unlink()
    assert _lib(pins + "aq_install_cosign", env).returncode == 0
    # A modified binary on disk is not trusted.
    installed.write_bytes(b"evil")
    again = _lib(pins + "aq_install_cosign", env)
    assert again.returncode != 0 and "download failed" in again.stderr
    wrong = _lib(f"COSIGN_VERSION=v9.9.9 COSIGN_SHA256={'1' * 64}\naq_install_cosign", env)
    assert wrong.returncode != 0


def test_install_uv_checks_the_tarball(tmp_path):
    name = "uv-x86_64-unknown-linux-gnu"
    pkg = tmp_path / "pkg" / name
    pkg.mkdir(parents=True)
    for tool in ("uv", "uvx"):
        (pkg / tool).write_text("#!/bin/sh\necho 'uv 9.9.9'\n")
    dl = tmp_path / "dl" / "astral-sh" / "uv" / "releases" / "download" / "9.9.9"
    dl.mkdir(parents=True)
    with tarfile.open(dl / f"{name}.tar.gz", "w:gz") as tar:
        tar.add(pkg, arcname=name)
    rootfs = tmp_path / "root"
    (rootfs / "usr" / "local" / "bin").mkdir(parents=True)
    env = {"AQ_GITHUB_DL": f"file://{tmp_path / 'dl'}", "AQ_ROOTFS": str(rootfs)}
    good = _lib(f"UV_VERSION=9.9.9 UV_SHA256={_sha(dl / f'{name}.tar.gz')}\naq_install_uv", env)
    assert good.returncode == 0, good.stderr
    assert os.access(rootfs / "usr/local/bin/uv", os.X_OK) and (rootfs / "usr/local/bin/uvx").exists()
    (rootfs / "usr/local/bin/uv").unlink()
    bad = _lib(f"UV_VERSION=9.9.9 UV_SHA256={'2' * 64}\naq_install_uv", env)
    assert bad.returncode != 0 and not (rootfs / "usr/local/bin/uv").exists()


# ------------------------------------------------------------------ signature + checksum
def _release(tmp_path: Path, version: str = "v1.2.3", extra: list[tuple[str, bytes]] | None = None) -> Path:
    tree = tmp_path / "tree" / f"aquarium-{version}"
    (tree / "agent-home" / ".next").mkdir(parents=True)
    (tree / "agent-home" / ".next" / "BUILD_ID").write_text("abc")
    (tree / "run.py").write_text("print('hi')\n")
    (tree / "link").symlink_to("run.py")
    dl = tmp_path / "dl"
    dl.mkdir(exist_ok=True)
    tarball = dl / f"aquarium-{version}-linux-x86_64.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(tree, arcname=f"aquarium-{version}")
        for arcname, data in extra or []:
            info = tarfile.TarInfo(arcname)
            info.size = len(data)
            import io

            tar.addfile(info, io.BytesIO(data))
    (dl / "SHA256SUMS").write_text(f"{_sha(tarball)}  {tarball.name}\n{'3' * 64}  other.txt\n")
    (dl / "SHA256SUMS.sig").write_text("sig")
    (dl / "SHA256SUMS.pem").write_text("pem")
    return dl


def _fake_cosign(tmp_path: Path, exit_code: int = 0) -> Path:
    path = tmp_path / "cosign"
    path.write_text(f'#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "{tmp_path}/cosign.args"\nexit {exit_code}\n')
    path.chmod(0o755)
    return path


def test_verify_release_checks_signer_identity_then_checksum(tmp_path):
    dl = _release(tmp_path)
    cosign = _fake_cosign(tmp_path)
    out = _lib(f"aq_verify_release '{cosign}' '{dl}' v1.2.3")
    assert out.returncode == 0, out.stderr
    args = (tmp_path / "cosign.args").read_text().splitlines()
    assert args[0] == "verify-blob" and args[-1] == f"{dl}/SHA256SUMS"
    flags = dict(zip(args[1:-1:2], args[2:-1:2]))
    assert flags == {
        "--certificate": f"{dl}/SHA256SUMS.pem",
        "--signature": f"{dl}/SHA256SUMS.sig",
        "--certificate-identity":
            "https://github.com/leolau/aquarium/.github/workflows/release.yml@refs/tags/v1.2.3",
        "--certificate-oidc-issuer": "https://token.actions.githubusercontent.com",
    }


def test_verify_release_rejects_a_bad_signature(tmp_path):
    dl = _release(tmp_path)
    out = _lib(f"aq_verify_release '{_fake_cosign(tmp_path, 1)}' '{dl}' v1.2.3")
    assert out.returncode != 0 and "signature check failed" in out.stderr


def test_verify_release_rejects_a_swapped_tarball(tmp_path):
    dl = _release(tmp_path)
    with (dl / "aquarium-v1.2.3-linux-x86_64.tar.gz").open("ab") as f:
        f.write(b"tampered")
    out = _lib(f"aq_verify_release '{_fake_cosign(tmp_path)}' '{dl}' v1.2.3")
    assert out.returncode != 0 and "checksum mismatch" in out.stderr


@pytest.mark.parametrize("sums", ["", "{sha}  {name}\n{sha}  {name}\n", "{sha}  aquarium-v1.2.4-linux-x86_64.tar.gz\n"])
def test_verify_release_needs_exactly_one_matching_entry(tmp_path, sums):
    dl = _release(tmp_path)
    tarball = dl / "aquarium-v1.2.3-linux-x86_64.tar.gz"
    (dl / "SHA256SUMS").write_text(sums.format(sha=_sha(tarball), name=tarball.name))
    out = _lib(f"aq_verify_release '{_fake_cosign(tmp_path)}' '{dl}' v1.2.3")
    assert out.returncode != 0 and "no single entry" in out.stderr


def test_installer_verifies_before_it_unpacks():
    release = TEXT[TEXT.index("aq_check_compat_path \"$APP\""):]
    assert release.index("aq_verify_release") < release.index("aq_unpack_release") < release.index("aq_activate_release")


# ------------------------------------------------------------------ layout
def test_unpack_and_activate_build_the_versioned_layout(tmp_path):
    dl = _release(tmp_path)
    opt, compat = tmp_path / "opt", tmp_path / "data" / "hermes-agent"
    env = {"AQ_OPT": str(opt)}
    out = _lib(
        f"aq_unpack_release '{dl}/aquarium-v1.2.3-linux-x86_64.tar.gz' v1.2.3\n"
        f"aq_activate_release v1.2.3 '{compat}'", env,
    )
    assert out.returncode == 0, out.stderr
    rel = opt / "releases" / "v1.2.3"
    assert (rel / "agent-home" / ".next" / "BUILD_ID").read_text() == "abc"
    assert os.readlink(opt / "current") == "releases/v1.2.3"
    assert os.readlink(compat) == str(opt / "current")
    assert (compat / "run.py").exists()
    assert not (rel / "run.py").stat().st_mode & 0o022, "release code must not be group/world writable"
    assert [p.name for p in (opt / "releases").iterdir()] == ["v1.2.3"], "no staging leftovers"

    # A second release flips both links; the first stays for rollback.
    dl2 = _release(tmp_path / "second", "v1.3.0")
    out = _lib(
        f"aq_unpack_release '{dl2}/aquarium-v1.3.0-linux-x86_64.tar.gz' v1.3.0\n"
        f"aq_activate_release v1.3.0 '{compat}'", env,
    )
    assert out.returncode == 0, out.stderr
    assert os.readlink(opt / "current") == "releases/v1.3.0"
    assert (opt / "releases" / "v1.2.3").is_dir()
    rollback = _lib(f"aq_activate_release v1.2.3 '{compat}'", env)
    assert rollback.returncode == 0 and os.readlink(opt / "current") == "releases/v1.2.3"


@pytest.mark.parametrize(
    "extra, message",
    [
        ([("aquarium-v1.2.3/../../etc/cron.d/x", b"x")], "entry outside"),
        ([("other-top/file", b"x")], "entry outside"),
    ],
)
def test_unpack_rejects_entries_outside_the_release_folder(tmp_path, extra, message):
    dl = _release(tmp_path, extra=extra)
    out = _lib(f"aq_unpack_release '{dl}/aquarium-v1.2.3-linux-x86_64.tar.gz' v1.2.3", {"AQ_OPT": str(tmp_path / "opt")})
    assert out.returncode != 0 and message in out.stderr
    assert not (tmp_path / "opt" / "releases" / "v1.2.3").exists()


def test_unpack_rejects_links_that_leave_the_release(tmp_path):
    dl = _release(tmp_path)
    tree = tmp_path / "tree" / "aquarium-v1.2.3"
    (tree / "escape").symlink_to("/etc/passwd")
    tarball = dl / "aquarium-v1.2.3-linux-x86_64.tar.gz"
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(tree, arcname="aquarium-v1.2.3")
    out = _lib(f"aq_unpack_release '{tarball}' v1.2.3", {"AQ_OPT": str(tmp_path / "opt")})
    assert out.returncode != 0 and "link pointing outside" in out.stderr
    assert not (tmp_path / "opt" / "releases" / "v1.2.3").exists()


def test_activate_never_replaces_a_real_checkout(tmp_path):
    dl = _release(tmp_path)
    checkout = tmp_path / "hermes-agent"
    (checkout / ".git").mkdir(parents=True)
    out = _lib(
        f"aq_unpack_release '{dl}/aquarium-v1.2.3-linux-x86_64.tar.gz' v1.2.3\n"
        f"aq_activate_release v1.2.3 '{checkout}'", {"AQ_OPT": str(tmp_path / "opt")},
    )
    assert out.returncode != 0 and "real folder" in out.stderr
    assert (checkout / ".git").is_dir() and not checkout.is_symlink()


# ------------------------------------------------------------------ pins
def test_pins_are_exact():
    pins = dict(
        line.split("=", 1) for line in PINS.read_text().splitlines() if line and not line.startswith("#")
    )
    assert re.fullmatch(r"[0-9a-f]{64}", pins["COSIGN_SHA256"])
    assert re.fullmatch(r"[0-9a-f]{64}", pins["UV_SHA256"])
    assert re.fullmatch(r"[0-9a-f]{40}", pins["SUPABASE_COMMIT"]), "Supabase must be a commit, not a branch"
    for key in ("COSIGN_VERSION", "UV_VERSION", "NODE_DEB_VERSION", "CADDY_DEB_VERSION"):
        assert re.match(r"v?\d+\.\d+\.\d+", pins[key]), key
    for line in LOCK.read_text().splitlines():
        if line and not line.startswith("#"):
            assert re.fullmatch(r"[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}", line), line


def test_installer_no_longer_uses_moving_sources():
    code = "\n".join(l for l in TEXT.splitlines() if not l.lstrip().startswith("#"))
    assert "setup_22.x" not in code and "astral.sh/uv/install.sh" not in code
    assert "--branch \"$SUPABASE_REF\"" not in code and ":-master}" not in code
    assert 'aq_pin_compose_images "$SUPA/docker-compose.yml"' in code


COMPOSE = """services:
  db:
    image: supabase/postgres:17.6.1.136
  studio:
    image: "supabase/studio:2026.10.12-sha-3699278"
    environment:
      IMGPROXY_IMAGE: not-an-image-line
"""


def test_pin_compose_images_adds_digests_and_is_idempotent(tmp_path):
    compose = tmp_path / "docker-compose.yml"
    compose.write_text(COMPOSE)
    out = _lib(f"aq_pin_compose_images '{compose}' '{LOCK}'\naq_pin_compose_images '{compose}' '{LOCK}'")
    assert out.returncode == 0, out.stderr
    text = compose.read_text()
    assert re.search(r"image: supabase/postgres:17\.6\.1\.136@sha256:[0-9a-f]{64}$", text, re.M)
    assert re.search(r"image: supabase/studio:2026\.10\.12-sha-3699278@sha256:[0-9a-f]{64}$", text, re.M)
    assert text.count("@sha256:") == 2


def test_pin_compose_images_refuses_an_unpinned_image(tmp_path):
    compose = tmp_path / "docker-compose.yml"
    compose.write_text(COMPOSE + "  extra:\n    image: someone/new:latest\n")
    out = _lib(f"aq_pin_compose_images '{compose}' '{LOCK}'")
    assert out.returncode != 0 and "someone/new:latest" in out.stderr
    assert compose.read_text().endswith("someone/new:latest\n"), "file left untouched"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def test_fetch_supabase_checks_out_exactly_the_commit(tmp_path):
    upstream = tmp_path / "upstream"
    (upstream / "docker").mkdir(parents=True)
    _git(tmp_path, "init", "-q", str(upstream))
    for n in (1, 2):
        (upstream / "docker" / "docker-compose.yml").write_text(f"version {n}\n")
        (upstream / "big-other-folder.txt").write_text("not needed\n")
        _git(upstream, "add", "-A")
        _git(upstream, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", f"c{n}")
        if n == 1:
            first = _git(upstream, "rev-parse", "HEAD")
    _git(upstream, "config", "uploadpack.allowFilter", "true")
    dest = tmp_path / "src"
    out = _lib(f"aq_fetch_supabase {first} '{dest}' 'file://{upstream}'")
    assert out.returncode == 0, out.stderr
    assert (dest / "docker" / "docker-compose.yml").read_text() == "version 1\n"
    missing = _lib(f"aq_fetch_supabase {'4' * 40} '{tmp_path / 'src2'}' 'file://{upstream}'")
    assert missing.returncode != 0


# ------------------------------------------------------------------ system components
def _system_stubs(tmp_path: Path, *, extra_available=True, nls=True, visudo_ok=True) -> Path:
    stubs = tmp_path / "bin"
    log = tmp_path / "calls.log"
    _stub(stubs, "apt-get", f'echo "apt-get $*" >> "{log}"')
    _stub(stubs, "apt-cache", f'echo "apt-cache $*" >> "{log}"; exit {0 if extra_available else 100}')
    _stub(stubs, "modprobe", f'echo "modprobe $*" >> "{log}"; exit {0 if nls else 1}')
    _stub(stubs, "visudo", f"exit {0 if visudo_ok else 1}")
    _stub(stubs, "uname", 'echo 6.8.0-45-generic')
    return stubs


def test_vpn_support_installs_helper_sudoers_and_modules(tmp_path):
    rootfs = tmp_path / "root"
    out = _lib(f"aq_install_vpn_support '{REPO_ROOT}'", {"AQ_ROOTFS": str(rootfs)}, _system_stubs(tmp_path))
    assert out.returncode == 0, out.stderr
    calls = (tmp_path / "calls.log").read_text()
    assert "openfortivpn" in calls and "cifs-utils" in calls
    assert "apt-get install -y -q linux-modules-extra-6.8.0-45-generic" in calls
    assert "modprobe nls_utf8" in calls
    assert (rootfs / "etc/modules-load.d/aquarium-nls.conf").read_text().strip() == "nls_utf8"
    helper = rootfs / "usr/local/sbin/hermes-vpn-helper"
    assert helper.read_bytes() == (REPO_ROOT / "deploy/hermes-vpn-helper").read_bytes()
    assert helper.stat().st_mode & 0o777 == 0o755
    sudoers = rootfs / "etc/sudoers.d/hermes-vpn"
    assert sudoers.read_text() == (REPO_ROOT / "deploy/sudoers.d/hermes-vpn").read_text()
    assert sudoers.stat().st_mode & 0o777 == 0o440


def test_vpn_support_warns_when_the_kernel_extras_are_missing(tmp_path):
    out = _lib(
        f"aq_install_vpn_support '{REPO_ROOT}'", {"AQ_ROOTFS": str(tmp_path / "root")},
        _system_stubs(tmp_path, extra_available=False, nls=False),
    )
    assert out.returncode == 0, out.stderr
    assert "linux-modules-extra-6.8.0-45-generic is not available" in out.stderr
    assert "nls_utf8" in out.stderr
    assert not (tmp_path / "root/etc/modules-load.d/aquarium-nls.conf").exists()


def test_vpn_support_refuses_a_broken_sudoers_file(tmp_path):
    rootfs = tmp_path / "root"
    out = _lib(f"aq_install_vpn_support '{REPO_ROOT}'", {"AQ_ROOTFS": str(rootfs)}, _system_stubs(tmp_path, visudo_ok=False))
    assert out.returncode != 0 and "visudo" in out.stderr
    assert not (rootfs / "etc/sudoers.d/hermes-vpn").exists()


def test_unattended_upgrades_on_fresh_box_and_operator_choice_kept(tmp_path):
    rootfs = tmp_path / "root"
    stubs = _system_stubs(tmp_path)
    out = _lib("aq_enable_unattended_upgrades", {"AQ_ROOTFS": str(rootfs)}, stubs)
    assert out.returncode == 0, out.stderr
    conf = rootfs / "etc/apt/apt.conf.d/20auto-upgrades"
    assert 'APT::Periodic::Unattended-Upgrade "1";' in conf.read_text()
    assert "apt-get install -y -q unattended-upgrades" in (tmp_path / "calls.log").read_text()
    conf.write_text('APT::Periodic::Unattended-Upgrade "0";\n')
    out = _lib("aq_enable_unattended_upgrades", {"AQ_ROOTFS": str(rootfs)}, stubs)
    assert out.returncode == 0 and "switched off" in out.stderr
    assert conf.read_text() == 'APT::Periodic::Unattended-Upgrade "0";\n'


def test_ssh_check_only_warns(tmp_path):
    weak = "permitrootlogin yes\npasswordauthentication yes\npermitemptypasswords no\nport 22\n"
    stubs = tmp_path / "bin"
    _stub(stubs, "sshd", f"printf '{weak}'")
    out = _lib("aq_ssh_check; echo still-running", stubs=stubs)
    assert out.returncode == 0 and out.stdout.strip() == "still-running"
    assert "PermitRootLogin yes" in out.stderr and "PasswordAuthentication yes" in out.stderr
    assert "PermitEmptyPasswords" not in out.stderr
    _stub(stubs, "sshd", "printf 'permitrootlogin prohibit-password\\npasswordauthentication no\\n'")
    assert _lib("aq_ssh_check", stubs=stubs).stderr == ""
    _stub(stubs, "sshd", "exit 1")
    unreadable = _lib("aq_ssh_check", stubs=stubs)
    assert unreadable.returncode == 0 and "could not read" in unreadable.stderr


def test_whatsapp_bridge_template_unit():
    unit = (REPO_ROOT / "deploy" / "hermes-wa-bridge@.service").read_text()
    assert "User=hermes" in unit and "%i" in unit
    assert "EnvironmentFile=/etc/aquarium/wa-bridge-%i.env" in unit
    assert "--port ${WA_BRIDGE_PORT}" in unit
    assert 'deploy/hermes-wa-bridge@.service' in TEXT
    # fix_paths moves every path the template uses when AQUARIUM_ROOT is not /opt/data.
    for path in re.findall(r"/opt/data/[\w-]+", unit):
        assert path in ("/opt/data/hermes-agent", "/opt/data/hermes-home"), path
