#!/usr/bin/python3 -I
"""aquarium — the root-only admin command for an Aquarium server.

Installed as /usr/local/sbin/aquarium (root:root 0755) by install-aquarium.sh and
refreshed from each verified release. It is stdlib-only and never imports code
from the app tree as root; anything that needs the app's own code runs as the
service user through ``python -m hermes_cli.aquarium_probe``.

    aquarium status                          what is installed and running
    aquarium update [--version vX.Y.Z | --channel stable|beta]
    aquarium backup [--to DIR]               encrypted backup (database, data, settings)
    aquarium restore <file> [--test] [--yes] put a backup back (or only test it)
    aquarium doctor [--json]                 health checks with a plain-language fix each
    aquarium logs [service] [-n N] [-f]
    aquarium migrate-layout [--dry-run | --yes | --undo]
    aquarium uninstall [--yes] [--purge-data]

Layout (release layout):
    /opt/aquarium/releases/<version>   root-owned, read-only to the service user
    /opt/aquarium/current              -> releases/<version>
    /opt/data/hermes-agent             -> /opt/aquarium/current (old path kept working)
    /etc/aquarium/*.env                env files, root 0600 (systemd reads them as root)
    /etc/aquarium/aquarium.conf        settings for this command (KEY=VALUE, optional)
    /etc/aquarium/backup.key           backup passphrase, root 0600 — keep a copy off the server
    /var/backups/aquarium/             encrypted backups, root 0700

AQUARIUM_TEST_PREFIX (tests only) puts every absolute path under a fake root.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as _dt
import errno
import fcntl
import hashlib
import hmac
import http.client
import io
import json
import os
import pwd
import re
import secrets
import shutil
import socket
import sqlite3
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------- paths


def P(path: str) -> Path:
    """An absolute on-box path, under the fake root when tests set one."""
    return Path(os.environ.get("AQUARIUM_TEST_PREFIX", "") + path)


def test_mode() -> bool:
    return bool(os.environ.get("AQUARIUM_TEST_PREFIX"))


def real(path: Path) -> str:
    """The on-box path a P() path stands for (what goes into archives and units)."""
    prefix = os.environ.get("AQUARIUM_TEST_PREFIX", "")
    text = str(path)
    return text[len(prefix):] if prefix and text.startswith(prefix) else text


AQ = "/opt/aquarium"
ETC = "/etc/aquarium"
SYSTEMD = "/etc/systemd/system"
SELF_INSTALL = "/usr/local/sbin/aquarium"
VPN_HELPER = "/usr/local/sbin/hermes-vpn-helper"
CADDYFILE = "/etc/caddy/Caddyfile"
LOCK = "/run/aquarium.lock"
AUDIT_LOG = "/var/log/aquarium.log"
UV_PYTHON_DIR = "/usr/local/share/uv/python"
TOOLS_DIR = "/usr/local/lib/aquarium"  # the installer's pinned cosign lives here
ROOT_HELPERS = [  # root-run copies that must match the release (reported, never auto-installed)
    ("/usr/local/sbin/hermes-vpn-helper", "deploy/hermes-vpn-helper", "VPN helper"),
    ("/usr/local/sbin/hermes-wa-bridge-add", "deploy/hermes-wa-bridge-add", "WhatsApp bridge helper"),
    ("/usr/local/sbin/hermes-security-check", "deploy/hermes-security-check", "security check helper"),
]
BUILD_CACHE = "/var/cache/aquarium"

VERSION_RE = re.compile(r"^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,40})?$")
LABEL_RE = re.compile(r"^(?:v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,40})?|git-[0-9a-f]{7,40})$")
TARBALL = "aquarium-{version}-linux-x86_64.tar.gz"

# Must match install-aquarium.sh "Python dependencies" (a test keeps them equal).
PY_EXTRAS = "all,dev,messaging,app-push,documents,edge-tts,bedrock"
PY_PINS = [
    "mcp>=1.26,<2", "websockets>=15,<16", "google-genai==2.13.0", "pymupdf==1.28.2",
    "pymysql==1.2.0", "pytesseract==0.3.13", "tabulate==0.10.0", "tornado==6.5.7", "numpy==2.4.3",
]

DEFAULTS: Dict[str, str] = {
    "REPO": "leolau/aquarium",
    "RELEASE_API": "",  # default https://api.github.com/repos/<REPO>
    "CHANNEL": "stable",
    # Same signer rule as install-aquarium.sh (deploy/install/lib.sh aq_release_identity):
    # this repo's release workflow, running for exactly the tag being installed.
    "RELEASE_WORKFLOW": "release.yml",
    "SIGNER_ISSUER": "https://token.actions.githubusercontent.com",
    "SERVICE_USER": "hermes",
    "DATA_ROOT": "/opt/data",
    "HERMES_HOMES": "",  # space-separated; default: HERMES_HOME of the service env files
    "SUPABASE_DIR": "/opt/data/supabase/docker",
    "DB_CONTAINER": "supabase-db",
    "BACKUP_DIR": "/var/backups/aquarium",
    "BACKUP_KEEP": "10",
    "KEEP_RELEASES": "3",
    "DASHBOARD_URL": "http://127.0.0.1:9119/",
    "AGENT_HOME_URL": "http://127.0.0.1:3100/login",
    "EMBED_URL": "http://127.0.0.1:8791/embed",
    "HOME_DOMAIN": "",
    "DASHBOARD_DOMAIN": "",
    "HEALTH_WAIT_SECONDS": "120",
    "RESTART_SETTLE_SECONDS": "10",
}


class Fail(Exception):
    """A user-facing failure: message plus what to do about it."""

    def __init__(self, message: str, fix: str = "") -> None:
        super().__init__(message)
        self.fix = fix


# --------------------------------------------------------------------------- small utils


def say(text: str = "") -> None:
    print(text, flush=True)


def step(text: str) -> None:
    say(f"\n==> {text}")


def utcnow() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def audit(text: str) -> None:
    try:
        path = P(AUDIT_LOG)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')} {text}\n")
    except OSError:
        pass


def read_kv(path: Path) -> Dict[str, str]:
    """KEY=VALUE lines (systemd EnvironmentFile / .env style). Missing file -> {}."""
    out: Dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return out
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:]
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def load_config() -> Dict[str, str]:
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in read_kv(P(f"{ETC}/aquarium.conf")).items() if k in DEFAULTS})
    if not cfg["RELEASE_API"]:
        cfg["RELEASE_API"] = f"https://api.github.com/repos/{cfg['REPO']}"
    return cfg


def run(argv: Sequence[str], *, check: bool = True, capture: bool = True, input: Optional[bytes] = None,
        env: Optional[Dict[str, str]] = None, cwd: Optional[Path] = None, timeout: Optional[float] = None,
        as_service: Optional[str] = None) -> subprocess.CompletedProcess:
    preexec = None
    if as_service and os.geteuid() == 0:  # windows-footgun: ok — POSIX-only root admin tooling
        pw = pwd.getpwnam(as_service)

        def preexec() -> None:  # drop root before anything from the release runs
            os.setgid(pw.pw_gid)
            os.initgroups(pw.pw_name, pw.pw_gid)
            os.setuid(pw.pw_uid)
    try:
        proc = subprocess.run(
            list(argv), input=input, capture_output=capture, env=env, cwd=cwd,
            timeout=timeout, preexec_fn=preexec, check=False,
        )
    except FileNotFoundError:
        if check:
            raise Fail(f"`{argv[0]}` is not installed on this server")
        return subprocess.CompletedProcess(list(argv), 127, b"", b"")
    except subprocess.TimeoutExpired:
        if check:
            raise Fail(f"`{' '.join(argv[:3])}` did not finish in time")
        return subprocess.CompletedProcess(list(argv), 124, b"", b"")
    if check and proc.returncode != 0:
        tail = (proc.stderr or b"").decode(errors="replace").strip().splitlines()[-5:] if capture else []
        raise Fail(f"`{' '.join(str(a) for a in argv[:4])}` failed (exit {proc.returncode})"
                   + ("\n    " + "\n    ".join(tail) if tail else ""))
    return proc


def out(argv: Sequence[str], **kw) -> str:
    return run(argv, **kw).stdout.decode(errors="replace")


def have(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def chown_tree(path: Path, user: str) -> None:
    """Give a whole tree to ``user`` (root for code, the service user for data).

    Without root (tests) ownership can't change, so this is skipped."""
    if os.geteuid() != 0:  # windows-footgun: ok — POSIX-only root admin tooling
        return
    pw = pwd.getpwnam(user)
    for root, dirs, files in os.walk(path):
        os.lchown(root, pw.pw_uid, pw.pw_gid)
        for name in dirs + files:
            os.lchown(os.path.join(root, name), pw.pw_uid, pw.pw_gid)


def drop_write_bits(path: Path) -> None:
    """Group/other may read code but never write it."""
    for root, dirs, files in os.walk(path):
        for name in [root] + [os.path.join(root, n) for n in dirs + files]:
            st = os.lstat(name)
            if not os.path.islink(name) and st.st_mode & 0o022:
                os.chmod(name, st.st_mode & ~0o022)


def write_private(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def symlink_swap(link: Path, target: str) -> None:
    """Point ``link`` at ``target`` atomically (no moment without a link)."""
    tmp = link.with_name(f".{link.name}.tmp-{os.getpid()}")
    with contextlib.suppress(FileNotFoundError):
        tmp.unlink()
    os.symlink(target, tmp)
    os.replace(tmp, link)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


@contextlib.contextmanager
def admin_lock() -> Iterator[None]:
    path = P(LOCK)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise Fail("another `aquarium` command is already running", "Wait for it to finish and try again.")
        yield


def version_key(label: str) -> Tuple:
    m = re.match(r"^v(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", label)
    if not m:
        return (-1,)
    pre = m.group(4)
    # A final release sorts above its own pre-releases.
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)), 1 if pre is None else 0, pre or "")


# --------------------------------------------------------------------------- state + layout


def state_path() -> Path:
    return P(f"{AQ}/state.json")


def load_state() -> Dict:
    try:
        return json.loads(state_path().read_text())
    except (OSError, ValueError):
        return {}


def save_state(state: Dict) -> None:
    write_private(state_path(), (json.dumps(state, indent=2, sort_keys=True) + "\n").encode())


def compat_path(cfg: Dict[str, str]) -> Path:
    return P(f"{cfg['DATA_ROOT']}/hermes-agent")


def current_release() -> Optional[str]:
    link = P(f"{AQ}/current")
    try:
        return Path(os.readlink(link)).name
    except OSError:
        return None


def layout(cfg: Dict[str, str]) -> str:
    """'release', 'git' (old checkout at /opt/data/hermes-agent) or 'none'."""
    compat = compat_path(cfg)
    if compat.is_symlink() and current_release():
        return "release"
    if compat.is_dir() and not compat.is_symlink():
        return "git"
    return "none"


def code_dir(cfg: Dict[str, str]) -> Path:
    rel = current_release()
    if layout(cfg) == "release" and rel:
        return P(f"{AQ}/releases/{rel}")
    return compat_path(cfg)


# --------------------------------------------------------------------------- systemd


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return run(["systemctl", *args], check=check)


def enabled_units(pattern: str) -> List[str]:
    proc = systemctl("list-unit-files", pattern, "--state=enabled", "--no-legend", check=False)
    return [line.split()[0] for line in proc.stdout.decode().splitlines() if line.strip()]


def service_units() -> List[str]:
    """The long-running units an update restarts (same set as deploy/hermes-deploy.sh)."""
    units = enabled_units("hermes-*.service")
    units += [u for u in bridge_units() if u not in units]
    for extra in ("app-mcp.service", "agent-home.service"):
        if extra not in units and (enabled_units(extra) or extra == "agent-home.service"):
            units.append(extra)
    return units


def unit_text(unit: str) -> str:
    """The unit file; for a template instance (name@inst.service), the template with %i filled in."""
    try:
        return P(f"{SYSTEMD}/{unit}").read_text(encoding="utf-8")
    except OSError:
        pass
    m = re.match(r"^(.+@)(.+)(\.service)$", unit)
    if m:
        try:
            return P(f"{SYSTEMD}/{m.group(1)}{m.group(3)}").read_text(encoding="utf-8").replace("%i", m.group(2))
        except OSError:
            pass
    return ""


def unit_dropins(unit: str) -> List[Path]:
    d = P(f"{SYSTEMD}/{unit}.d")
    return sorted(d.glob("*.conf")) if d.is_dir() else []


def unit_env_files(unit: str) -> List[str]:
    """Effective EnvironmentFile= entries (with any leading '-'), drop-ins applied."""
    files: List[str] = []
    for text in [unit_text(unit)] + [p.read_text() for p in unit_dropins(unit)]:
        for line in text.splitlines():
            m = re.match(r"^\s*EnvironmentFile\s*=\s*(.*)$", line)
            if not m:
                continue
            value = m.group(1).strip()
            if not value:
                files = []
            else:
                files.extend(value.split())
    return files


def unit_session_dir(unit: str) -> Optional[str]:
    m = re.search(r"--session\s+(\S+)", unit_text(unit))
    return m.group(1) if m else None


def unit_port(unit: str) -> Optional[int]:
    text = unit_text(unit)
    m = re.search(r"--port\s+(\d+)", text)
    if m:
        return int(m.group(1))
    m = re.search(r"--port\s+\$\{?(\w+)\}?", text)  # template: port from its env file
    if not m:
        return None
    env: Dict[str, str] = {}
    for line in text.splitlines():
        e = re.match(r"^\s*Environment\s*=\s*(\w+)=(\S*)", line)
        if e:
            env[e.group(1)] = e.group(2)
    for f in unit_env_files(unit):
        env.update(read_kv(P(f.lstrip("-"))))
    value = env.get(m.group(1), "")
    return int(value) if value.isdigit() else None


def unit_log_file(unit: str) -> Optional[str]:
    m = re.search(r"^\s*StandardOutput\s*=\s*append:(\S+)", unit_text(unit), re.M)
    return m.group(1) if m else None


def restart_services(units: Sequence[str]) -> None:
    systemctl("daemon-reload")
    for unit in units:
        # app-mcp must restart on every update or new MCP tools are never registered.
        systemctl("restart", unit)


def bridge_units() -> List[str]:
    """Per-phone WhatsApp bridges: hand-made units and instances of hermes-wa-bridge@.service."""
    units = enabled_units("hermes-wa-bridge-*.service")
    proc = systemctl("list-units", "hermes-wa-bridge@*.service", "--all", "--no-legend", "--plain", check=False)
    for line in proc.stdout.decode().splitlines():
        parts = line.split()
        if parts and parts[0].endswith(".service") and "@" in parts[0] and parts[1:2] == ["loaded"]:
            if parts[0] not in units:
                units.append(parts[0])
    return units


# --------------------------------------------------------------------------- env


def service_env_files(cfg: Dict[str, str]) -> List[Path]:
    for unit in ("hermes-dashboard.service", "hermes-gateway.service"):
        files = unit_env_files(unit)
        if files:
            return [P(f.lstrip("-")) for f in files]
    return [P(f"{ETC}/hermes.env")]


def app_env(cfg: Dict[str, str], release: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for path in service_env_files(cfg):
        env.update(read_kv(path))
    env["PATH"] = f"{release}/.venv/bin:/usr/local/bin:/usr/bin:/bin"
    env.setdefault("HOME", "/nonexistent")
    if test_mode() and "HERMES_HOME" in env:
        env["HERMES_HOME"] = str(P(env["HERMES_HOME"]))
    return env


def hermes_homes(cfg: Dict[str, str]) -> List[str]:
    if cfg["HERMES_HOMES"].strip():
        return cfg["HERMES_HOMES"].split()
    homes: List[str] = []
    for unit in service_units() + ["hermes-dashboard.service", "hermes-gateway.service"]:
        for f in unit_env_files(unit):
            home = read_kv(P(f.lstrip("-"))).get("HERMES_HOME")
            if home and home not in homes:
                homes.append(home)
    return homes


# --------------------------------------------------------------------------- health


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):  # report 302 as 302
        return None


def http_status(url: str, *, data: Optional[bytes] = None, timeout: float = 10.0) -> Optional[int]:
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if data else {})
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError, ValueError):
        return None


def db_ready(cfg: Dict[str, str]) -> bool:
    return run(["docker", "exec", cfg["DB_CONTAINER"], "pg_isready", "-U", "postgres", "-h", "localhost"],
               check=False, timeout=30).returncode == 0


def health_checks(cfg: Dict[str, str], units: Sequence[str]) -> List[Tuple[str, Callable[[], bool]]]:
    """Same checks as install-aquarium.sh step 11 and PRODUCTION.md §5.7."""
    checks: List[Tuple[str, Callable[[], bool]]] = []
    for unit in units:
        checks.append((f"service {unit} active",
                       lambda u=unit: systemctl("is-active", "-q", u, check=False).returncode == 0))
    checks.append(("supabase containers healthy", lambda: run(
        ["docker", "ps", "--filter", "health=unhealthy", "-q"], check=False).stdout.strip() == b""))
    checks.append(("postgres ready", lambda: db_ready(cfg)))
    checks.append(("agent-home answers", lambda: http_status(cfg["AGENT_HOME_URL"]) == 200))
    checks.append(("dashboard answers", lambda: http_status(cfg["DASHBOARD_URL"]) in (200, 302, 401)))
    if "hermes-embed.service" in units:
        checks.append(("embedding service answers", lambda: http_status(
            cfg["EMBED_URL"], data=b'{"texts":["ok"]}', timeout=30) == 200))
    if cfg["HOME_DOMAIN"]:
        checks.append((f"https://{cfg['HOME_DOMAIN']}/login",
                       lambda: http_status(f"https://{cfg['HOME_DOMAIN']}/login") == 200))
    return checks


def running_units(units: Sequence[str]) -> List[str]:
    """The units that are up right now. A change is judged only on these: a unit that was
    already down before (e.g. a failed oneshot) must not turn a good update into a rollback."""
    up = [u for u in units if systemctl("is-active", "-q", u, check=False).returncode == 0]
    for u in units:
        if u not in up:
            say(f"  note: {u} was not running before this change; it is restarted but not required")
    return up


def wait_healthy(cfg: Dict[str, str], units: Sequence[str]) -> List[str]:
    """Retry until every check passes or HEALTH_WAIT_SECONDS runs out; returns failures."""
    deadline = time.monotonic() + float(cfg["HEALTH_WAIT_SECONDS"])
    time.sleep(float(cfg["RESTART_SETTLE_SECONDS"]))
    checks = health_checks(cfg, units)
    while True:
        failed = [name for name, fn in checks if not fn()]
        if not failed or time.monotonic() >= deadline:
            break
        time.sleep(min(5.0, max(0.0, deadline - time.monotonic())))
        checks = [(n, f) for n, f in checks if n in failed]
    for name, _ in health_checks(cfg, units):
        say(f"  {'FAIL' if name in failed else 'ok  '}  {name}")
    return failed


# --------------------------------------------------------------------------- releases


def api_get(url: str, timeout: float = 30.0) -> object:
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "aquarium-admin"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as error:
        if error.code == 404:
            raise Fail(f"release not found ({url})", "Check the version number: `aquarium status` lists what is current.")
        raise Fail(f"GitHub answered HTTP {error.code} for {url}", "Try again in a few minutes.")
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise Fail(f"cannot reach GitHub ({error.__class__.__name__})",
                   "Check this server's internet connection and DNS, then try again.")


def pick_release(cfg: Dict[str, str], version: Optional[str], channel: Optional[str]) -> Dict:
    if version:
        if not VERSION_RE.match(version):
            raise Fail(f"'{version}' is not a version like v1.2.3")
        rel = api_get(f"{cfg['RELEASE_API']}/releases/tags/{version}")
        if not isinstance(rel, dict) or rel.get("draft"):
            raise Fail(f"release {version} is not published")
        return rel
    channel = channel or cfg["CHANNEL"]
    if channel not in ("stable", "beta"):
        raise Fail(f"unknown channel '{channel}' (use stable or beta)")
    releases = api_get(f"{cfg['RELEASE_API']}/releases?per_page=100")
    candidates = [
        r for r in (releases if isinstance(releases, list) else [])
        if not r.get("draft") and VERSION_RE.match(str(r.get("tag_name", "")))
        and (channel == "beta" or not r.get("prerelease"))
    ]
    if not candidates:
        raise Fail(f"no published {channel} release found")
    return max(candidates, key=lambda r: version_key(r["tag_name"]))


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "aquarium-admin", "Accept": "application/octet-stream"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as fh:
            shutil.copyfileobj(resp, fh, 1 << 20)
    except (urllib.error.URLError, OSError) as error:
        raise Fail(f"download failed: {dest.name} ({error.__class__.__name__})",
                   "Check the internet connection and try again.")
    os.replace(tmp, dest)


def find_cosign() -> Optional[str]:
    pinned = sorted(P(TOOLS_DIR).glob("cosign-v*"), key=lambda p: version_key(p.name[len("cosign-"):]))
    pinned = [p for p in pinned if os.access(p, os.X_OK)]
    if pinned:
        return str(pinned[-1])
    return shutil.which("cosign")


def verify_release(cfg: Dict[str, str], folder: Path, version: str) -> Path:
    """cosign keyless signature on SHA256SUMS, then the tarball's checksum. Fails closed."""
    sums, sig, pem = folder / "SHA256SUMS", folder / "SHA256SUMS.sig", folder / "SHA256SUMS.pem"
    cosign = find_cosign()
    if not cosign:
        raise Fail("cosign is not installed, so the release signature can't be checked",
                   "Re-run install-aquarium.sh (it installs a pinned cosign) and run the update again. "
                   "Updates never skip this check.")
    identity = f"https://github.com/{cfg['REPO']}/.github/workflows/{cfg['RELEASE_WORKFLOW']}@refs/tags/{version}"
    proc = run([cosign, "verify-blob", "--certificate", str(pem), "--signature", str(sig),
                "--certificate-identity", identity,
                "--certificate-oidc-issuer", cfg["SIGNER_ISSUER"], str(sums)], check=False, timeout=180)
    if proc.returncode != 0:
        raise Fail("the release signature is NOT valid — this download was not built by the Aquarium release workflow",
                   "Nothing was installed. Do not install this file; report it.")
    name = TARBALL.format(version=version)
    expected = None
    for line in sums.read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip("*") == name:
            expected = parts[0].lower()
    if not expected:
        raise Fail(f"{name} is not listed in SHA256SUMS")
    tarball = folder / name
    if sha256_file(tarball) != expected:
        raise Fail(f"{name} does not match its checksum (corrupt or tampered download)",
                   "Nothing was installed. Run the update again to download it fresh.")
    return tarball


def unpack(tarball: Path, dest: Path) -> None:
    """Extract with the 'data' filter: no absolute paths, no '..', no links out, no devices."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    try:
        with tarfile.open(tarball, "r:gz") as tar:
            tar.extractall(dest, filter="data")
    except (tarfile.TarError, OSError) as error:
        shutil.rmtree(dest, ignore_errors=True)
        raise Fail(f"the release tarball is unsafe or damaged ({error.__class__.__name__}: {error})",
                   "Nothing was installed. Report this release.")
    entries = list(dest.iterdir())
    if len(entries) == 1 and entries[0].is_dir() and not (dest / "pyproject.toml").exists():
        inner = entries[0]
        for child in list(inner.iterdir()):
            os.rename(child, dest / child.name)
        inner.rmdir()
    if not (dest / "pyproject.toml").exists():
        raise Fail("the release tarball does not look like Aquarium (no pyproject.toml)")


def build_release(cfg: Dict[str, str], rel: Path) -> None:
    """Build what the tarball doesn't ship, as the service user, then hand the tree to root."""
    user = cfg["SERVICE_USER"]
    cache = P(BUILD_CACHE)
    cache.mkdir(parents=True, exist_ok=True)
    chown_tree(cache, user)
    chown_tree(rel, user)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(cache), "UV_CACHE_DIR": str(cache / "uv"),
           "UV_PYTHON_INSTALL_DIR": UV_PYTHON_DIR, "npm_config_cache": str(cache / "npm"),
           "NEXT_TELEMETRY_DISABLED": "1"}
    if not (rel / ".venv/bin/python").exists():
        step("Python environment")
        run(["uv", "venv", "-q", str(rel / ".venv"), "--python", "3.11"], env=env, cwd=rel, as_service=user)
        run(["uv", "pip", "install", "-q", "--python", str(rel / ".venv/bin/python"),
             "-e", f"{rel}[{PY_EXTRAS}]", *PY_PINS], env=env, cwd=rel, as_service=user, timeout=3600)
    need_node = not (rel / "node_modules").is_dir() and (rel / "package-lock.json").exists()
    if need_node:
        step("Node dependencies")
        run(["npm", "ci", "--no-audit", "--no-fund"], env=env, cwd=rel, as_service=user, timeout=3600)
    if (rel / "agent-home").is_dir() and not (rel / "agent-home/.next/BUILD_ID").exists():
        step("Building agent-home")
        run(["npm", "run", "build", "--workspace", "agent-home"], env=env, cwd=rel, as_service=user, timeout=3600)
    if (rel / "web").is_dir() and not (rel / "hermes_cli/web_dist/index.html").exists():
        step("Building the dashboard")
        run(["npm", "run", "build"], env=env, cwd=rel / "web", as_service=user, timeout=3600)
    bridge = rel / "scripts/whatsapp-bridge"
    if (bridge / "package.json").exists() and not (bridge / "node_modules").is_dir():
        step("WhatsApp bridge dependencies")
        cmd = ["npm", "ci"] if (bridge / "package-lock.json").exists() else ["npm", "install"]
        run(cmd + ["--no-audit", "--no-fund"], env=env, cwd=bridge, as_service=user, timeout=1800)
    seal_release(cfg, rel)


def seal_release(cfg: Dict[str, str], rel: Path) -> None:
    """Code is root-owned and read-only to the service user (F13/F15); only .next is writable."""
    chown_tree(rel, "root")
    drop_write_bits(rel)
    next_dir = rel / "agent-home/.next"
    if next_dir.is_dir():
        # `next start` writes its cache here (agent-home.service ReadWritePaths).
        chown_tree(next_dir, cfg["SERVICE_USER"])


def run_probe(cfg: Dict[str, str], rel: Path, check: str, timeout: float = 600) -> Tuple[int, List[Dict]]:
    python = rel / ".venv/bin/python"
    if not python.exists():
        return 127, [{"check": check, "status": "warn", "message": "the installed release has no Python environment", "fix": ""}]
    argv, stdin = [str(python), "-I", "-m", "hermes_cli.aquarium_probe", check], None
    admin = P(f"{ETC}/db-admin.env")
    if check == "migrate" and admin.is_file():
        # Schema owner's address, over stdin so it never sits in the service user's env.
        argv.append("--dsn-stdin")
        stdin = admin.read_bytes()
    proc = run(argv, check=False, input=stdin,
               env=app_env(cfg, rel), cwd=rel, as_service=cfg["SERVICE_USER"], timeout=timeout)
    rows: List[Dict] = []
    for line in proc.stdout.decode(errors="replace").splitlines():
        with contextlib.suppress(ValueError):
            row = json.loads(line)
            if isinstance(row, dict):
                rows.append(row)
    if proc.returncode != 0 and not rows:
        err = proc.stderr.decode(errors="replace").strip().splitlines()[-1:] or ["no output"]
        if "No module named hermes_cli.aquarium_probe" in proc.stderr.decode(errors="replace"):
            rows.append({"check": check, "status": "warn",
                         "message": "this release is too old to run the check", "fix": "Update with `aquarium update`."})
        else:
            rows.append({"check": check, "status": "fail", "message": f"check crashed: {err[0][:200]}", "fix": ""})
    return proc.returncode, rows


def read_role_refresh(cfg: Dict[str, str], rel: Path) -> None:
    """Re-grant the read-only agent-home role on tables new code created (installer does the same)."""
    if P(f"{ETC}/db-admin.env").is_file():
        return  # the migrate probe got the owner address and did it (hermes_cli/db_migrate.py)
    password = ""
    for f in (P(f"{ETC}/aquarium-secrets.env"), P(f"{cfg['DATA_ROOT']}/aquarium-secrets.env")):
        password = read_kv(f).get("HERMES_APP_READ_DB_PASSWORD", "") or password
    if not password or not (rel / ".venv/bin/hermes").exists():
        return
    env = app_env(cfg, rel)
    env["HERMES_APP_READ_DB_PASSWORD"] = password
    run([str(rel / ".venv/bin/hermes"), "owner", "read-role"], check=False, env=env, cwd=rel,
        as_service=cfg["SERVICE_USER"], timeout=300)


def prune_releases(cfg: Dict[str, str], state: Dict) -> None:
    keep = max(int(cfg["KEEP_RELEASES"]), 2)
    protected = {current_release(), state.get("previous")}
    rels = sorted((p for p in P(f"{AQ}/releases").iterdir() if p.is_dir() and LABEL_RE.match(p.name)),
                  key=lambda p: p.stat().st_mtime, reverse=True)
    for old in rels[keep:]:
        if old.name not in protected:
            shutil.rmtree(old, ignore_errors=True)
            shutil.rmtree(P(f"{AQ}/downloads/{old.name}"), ignore_errors=True)


def refresh_self(rel: Path) -> None:
    """Install this command from the release just verified, if it changed."""
    src, dest = rel / "deploy/aquarium.py", P(SELF_INSTALL)
    if not src.exists() or (dest.exists() and src.read_bytes() == dest.read_bytes()):
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(".aquarium.new")
    shutil.copyfile(src, tmp)
    os.chmod(tmp, 0o755)
    if os.geteuid() == 0:  # windows-footgun: ok — POSIX-only root admin tooling
        os.chown(tmp, 0, 0)
    os.replace(tmp, dest)
    say(f"  updated {SELF_INSTALL} from the release")


def stale_helpers(rel: Path) -> List[Tuple[str, str]]:
    """(label, install command) for each installed root helper that differs from the release."""
    stale = []
    for installed, source, label in ROOT_HELPERS:
        have_it, reviewed = P(installed), rel / source
        if have_it.exists() and reviewed.exists() and have_it.read_bytes() != reviewed.read_bytes():
            stale.append((label, f"install -m 755 -o root -g root {real(reviewed)} {installed}"))
    return stale


def carry_forward(old: Path, new: Path) -> List[str]:
    """Env files the units read from inside the code tree (agent-home.env, app-mcp.env on a
    fresh install) are not part of a release; copy them into the new one, same owner and mode."""
    carried = []
    old_root = os.path.realpath(old)
    for unit in service_units():
        for f in unit_env_files(unit):
            src = os.path.realpath(P(f.lstrip("-")))
            if not src.startswith(old_root + "/") or not os.path.isfile(src):
                continue
            dest = new / os.path.relpath(src, old_root)
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            st = os.stat(src)
            if os.geteuid() == 0:  # windows-footgun: ok — POSIX-only root admin tooling
                os.chown(dest, st.st_uid, st.st_gid)
            carried.append(os.path.relpath(src, old_root))
    return carried


# --------------------------------------------------------------------------- update


def cmd_update(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    with admin_lock():
        lay = layout(cfg)
        if lay == "git":
            raise Fail("this server still runs from a git checkout (/opt/data/hermes-agent)",
                       "Move it to the release layout once: `aquarium migrate-layout --dry-run`, then `--yes`.")
        if lay != "release":
            raise Fail("no Aquarium installation found", "Install it with install-aquarium.sh first.")
        state = load_state()
        before = current_release()
        previous_before = state.get("previous")
        release = pick_release(cfg, args.version, args.channel)
        version = release["tag_name"]
        say(f"Installed: {before}    Target: {version}")
        if version == before and not args.force:
            say("Already up to date.")
            return 0
        if version_key(version) < version_key(before or "") and not args.version:
            say(f"The {args.channel or cfg['CHANNEL']} channel's newest release ({version}) is older than what is installed; nothing to do.")
            return 0
        assets = {a["name"]: a["browser_download_url"] for a in release.get("assets", [])}
        names = [TARBALL.format(version=version), "SHA256SUMS", "SHA256SUMS.sig", "SHA256SUMS.pem"]
        missing = [n for n in names if n not in assets]
        if missing:
            raise Fail(f"release {version} is missing {', '.join(missing)}")
        free = shutil.disk_usage(P(AQ) if P(AQ).exists() else P("/")).free / 2**30
        if free < 5:
            raise Fail(f"only {free:.1f} GB free disk", "Free some space (old backups in /var/backups/aquarium) and retry.")

        step(f"Downloading {version}")
        folder = P(f"{AQ}/downloads/{version}")
        for n in names:
            download(assets[n], folder / n)
        step("Checking signature and checksum")
        tarball = verify_release(cfg, folder, version)
        say("  signature ok, checksum ok")

        if not args.no_backup:
            step("Backup before the update")
            state["last_backup"] = real(make_backup(cfg, label=f"pre-update-{version}"))

        step(f"Unpacking into /opt/aquarium/releases/{version}")
        rel = P(f"{AQ}/releases/{version}")
        partial = P(f"{AQ}/releases/.{version}.partial")
        unpack(tarball, partial)
        build_release(cfg, partial)
        for name in carry_forward(P(f"{AQ}/releases/{before}"), partial):
            say(f"  kept settings file {name}")
        if rel.exists():
            shutil.rmtree(rel)
        os.rename(partial, rel)

        units = service_units()
        required = running_units(units)
        config_copies = snapshot_configs(cfg, folder)
        step("Migrating database and settings")
        code, rows = run_probe(cfg, rel, "migrate")
        for row in rows:
            say(f"  {row.get('status', '?'):4}  {row.get('message', '')}")
        if code != 0:
            restore_configs(config_copies)
            raise Fail("the migration step failed; the running version was not changed",
                       f"Nothing was switched. Details: journal above; the backup is in {cfg['BACKUP_DIR']}.")

        step(f"Switching to {version} and restarting")
        audit(f"update {before} -> {version}: switching")
        symlink_swap(P(f"{AQ}/current"), f"releases/{version}")
        state.update(previous=before, current=version, layout="release")
        state.setdefault("history", []).append({"version": version, "from": before, "at": utcnow(), "result": "switched"})
        save_state(state)
        restart_services(units)
        step("Health check")
        failed = wait_healthy(cfg, required)
        if failed:
            step(f"Health check failed ({', '.join(failed)}) — rolling back to {before}")
            symlink_swap(P(f"{AQ}/current"), f"releases/{before}")
            restore_configs(config_copies)
            restart_services(units)
            back = wait_healthy(cfg, required)
            state.update(current=before, previous=previous_before, failed=version)
            state["history"][-1]["result"] = "rolled back"
            save_state(state)
            audit(f"update {before} -> {version}: rolled back ({', '.join(failed)})")
            raise Fail(f"{version} did not pass the health check; rolled back to {before}"
                       + ("" if not back else f", but {', '.join(back)} still fail"),
                       f"Look at `aquarium logs` for the failing service. {version} stays in /opt/aquarium/releases for inspection.")
        read_role_refresh(cfg, rel)
        state["history"][-1]["result"] = "ok"
        save_state(state)
        refresh_self(rel)
        prune_releases(cfg, state)
        audit(f"update {before} -> {version}: ok")
        say(f"\nUpdated to {version}. Previous version {before} is kept for rollback.")
        for label, hint in stale_helpers(rel):
            say(f"{label.upper()} STALE: the root-run copy differs from this release. Install it with:\n    {hint}")
        return 0


def snapshot_configs(cfg: Dict[str, str], folder: Path) -> List[Tuple[Path, Path]]:
    copies = []
    for i, home in enumerate(hermes_homes(cfg)):
        src = P(home) / "config.yaml"
        if src.exists():
            dst = folder / f"config.yaml.before.{i}"
            shutil.copy2(src, dst)
            copies.append((src, dst))
    return copies


def restore_configs(copies: List[Tuple[Path, Path]]) -> None:
    for src, saved in copies:
        shutil.copy2(saved, src)


# --------------------------------------------------------------------------- backup

SKIP_DIRS = {"__pycache__", "node_modules", ".venv", "venv", ".npm", ".cache"}
COUNT_SQL = (
    "SELECT table_schema||'.'||table_name, (xpath('/row/c/text()', query_to_xml("
    "format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text "
    "FROM information_schema.tables WHERE table_type='BASE TABLE' AND "
    "(table_schema LIKE 'app\\_%' OR table_schema IN ('auth','storage','public')) ORDER BY 1"
)


def backup_key(create: bool = True) -> Path:
    key = P(f"{ETC}/backup.key")
    if not key.exists():
        if not create:
            raise Fail(f"backup key {ETC}/backup.key is missing",
                       "Put back the copy of backup.key you saved when the first backup was made, or pass --key-file.")
        write_private(key, secrets.token_hex(32).encode() + b"\n")
        say(f"  created the backup key {ETC}/backup.key")
        say("  IMPORTANT: copy this file somewhere safe off this server. Backups can't be opened without it.")
    return key


def gpg_env() -> Dict[str, str]:
    home = tempfile.mkdtemp(prefix="aquarium-gpg-")
    os.chmod(home, 0o700)
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "GNUPGHOME": home}


def db_counts(cfg: Dict[str, str], dbname: str) -> Dict[str, int]:
    proc = run(["docker", "exec", cfg["DB_CONTAINER"], "psql", "-U", "supabase_admin", "-d", dbname,
                "-At", "-F", "|", "-c", COUNT_SQL], check=False, timeout=900)
    counts: Dict[str, int] = {}
    for line in proc.stdout.decode(errors="replace").splitlines():
        name, _, value = line.partition("|")
        if value.strip().isdigit():
            counts[name] = int(value)
    return counts


def db_running(cfg: Dict[str, str]) -> bool:
    return have("docker") and run(["docker", "inspect", "-f", "{{.State.Running}}", cfg["DB_CONTAINER"]],
                                  check=False).stdout.strip() == b"true"


def backup_sources(cfg: Dict[str, str]) -> List[str]:
    """Absolute on-box paths that go into a backup (files or whole folders)."""
    paths: List[str] = []

    def add(p: str) -> None:
        if p and p not in paths and P(p).exists():
            paths.append(p)

    units = set(service_units()) | set(bridge_units()) | {"agent-home.service", "app-mcp.service"}
    # every hermes-* unit on disk, timers and oneshots too (their env files hold secrets as well)
    units |= {p.name for p in P(SYSTEMD).glob("hermes-*") if p.name.endswith((".service", ".timer"))}
    for unit in sorted(units):
        for f in unit_env_files(unit):
            add(f.lstrip("-"))
        add(f"{SYSTEMD}/{unit}")
        add(f"{SYSTEMD}/{unit}.d")
    for folder in (cfg["DATA_ROOT"], f"{cfg['DATA_ROOT']}/deploy"):
        for f in sorted(P(folder).glob("*.env")) if P(folder).is_dir() else []:
            add(real(f))
    add(ETC)
    add(f"{cfg['DATA_ROOT']}/aquarium-secrets.env")
    add(f"{cfg['SUPABASE_DIR']}/.env")
    add(f"{cfg['SUPABASE_DIR']}/docker-compose.override.yml")
    add(CADDYFILE)
    sudoers = P("/etc/sudoers.d")
    if sudoers.is_dir():
        for f in sorted(sudoers.glob("hermes*")):
            add(real(f))
    homes = hermes_homes(cfg)
    for home in homes:
        add(home)
    for unit in bridge_units():  # WhatsApp login state, if kept outside HERMES_HOME
        session = unit_session_dir(unit)
        if session and not any(session.startswith(h.rstrip("/") + "/") for h in homes):
            add(session)
    # A folder inside another listed folder is already covered.
    return [p for p in paths if not any(p != q and p.startswith(q.rstrip("/") + "/") for q in paths)]


def _is_sqlite(path: Path) -> bool:
    try:
        with open(path, "rb") as fh:
            return fh.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def _add_file(tar: tarfile.TarFile, path: Path, arcname: str, manifest: Dict) -> None:
    info = tar.gettarinfo(str(path), arcname)
    if info.isfile():
        spool = tempfile.SpooledTemporaryFile(max_size=64 << 20)
        if _is_sqlite(path):  # a live database: copy it consistently, not byte by byte
            with tempfile.TemporaryDirectory() as tmp:
                copy = Path(tmp) / "db"
                src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                dst = sqlite3.connect(copy)
                with dst:
                    src.backup(dst)
                src.close()
                dst.close()
                with open(copy, "rb") as fh:
                    shutil.copyfileobj(fh, spool)
        else:
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, spool)
        info.size = spool.tell()
        spool.seek(0)
        manifest["files"][arcname] = hashlib.sha256(spool.read()).hexdigest()
        spool.seek(0)
        tar.addfile(info, spool)
        spool.close()
    elif info.isdir() or info.issym():
        tar.addfile(info)


def iter_tree(root: Path) -> Iterator[Path]:
    """``root`` and everything below it (parents first), without following links."""
    yield root
    if root.is_dir() and not root.is_symlink():
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
            for name in dirs + sorted(files):
                yield Path(dirpath) / name


def make_backup(cfg: Dict[str, str], *, label: str = "manual", to: Optional[Path] = None,
                progress: Optional[Callable[[str, int], None]] = None) -> Path:
    report = progress or (lambda phase, percent: None)
    if not have("gpg"):
        raise Fail("gpg is not installed", "apt-get install -y gnupg")
    key = backup_key()
    dest_dir = to or P(cfg["BACKUP_DIR"])
    dest_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(dest_dir, 0o700)
    stamp = utcnow()
    name = f"aquarium-backup-{stamp}-{re.sub(r'[^A-Za-z0-9.-]', '_', label)}.tar.gz.gpg"
    target = dest_dir / name
    staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=dest_dir))
    manifest: Dict = {"format": 1, "created": stamp, "label": label, "release": current_release(),
                      "layout": layout(cfg), "hostname": socket.gethostname(), "files": {}, "paths": [],
                      "db": None}
    genv = gpg_env()
    try:
        report("database", 5)
        url_env = None if db_running(cfg) else db_admin_env()
        if url_env is not None:
            manifest["db"] = dump_with_admin_url(url_env, staging)
        elif db_running(cfg):
            say("  database dump")
            dbdir = staging / "db"
            dbdir.mkdir()
            with open(dbdir / "postgres.dump", "wb") as fh:
                p = subprocess.run(["docker", "exec", cfg["DB_CONTAINER"], "pg_dump", "-U", "supabase_admin",
                                    "-d", "postgres", "-Fc"], stdout=fh, stderr=subprocess.PIPE, check=False)
            if p.returncode != 0:
                raise Fail("the database dump failed: " + p.stderr.decode(errors="replace").strip()[-300:],
                           "Check `docker ps` — supabase-db must be running and healthy.")
            with open(dbdir / "globals.sql", "wb") as fh:
                subprocess.run(["docker", "exec", cfg["DB_CONTAINER"], "pg_dumpall", "-U", "supabase_admin",
                                "--globals-only"], stdout=fh, stderr=subprocess.PIPE, check=True)
            manifest["db"] = {"database": "postgres", "tables": db_counts(cfg, "postgres")}
        else:
            say("  database not running here: backing up files only")
        sources = backup_sources(cfg)
        manifest["paths"] = sources
        report("files", 30)
        gpg = subprocess.Popen(
            ["gpg", "--batch", "--yes", "--quiet", "--pinentry-mode", "loopback", "--passphrase-file", str(key),
             "--symmetric", "--cipher-algo", "AES256", "-o", str(target) + ".part"],
            stdin=subprocess.PIPE, env=genv)
        assert gpg.stdin is not None
        with tarfile.open(fileobj=gpg.stdin, mode="w|gz") as tar:
            if manifest["db"] is not None:
                for f in ("postgres.dump", "globals.sql"):
                    _add_file(tar, staging / "db" / f, f"db/{f}", manifest)
            for i, src in enumerate(sources):
                say(f"  {src}")
                report("files", 30 + 30 * i // max(len(sources), 1))
                for p in iter_tree(P(src)):
                    _add_file(tar, p, "root" + real(p), manifest)
            data = (json.dumps(manifest, indent=1, sort_keys=True) + "\n").encode()
            info = tarfile.TarInfo("manifest.json")
            info.size, info.mtime, info.mode = len(data), int(time.time()), 0o600
            tar.addfile(info, io.BytesIO(data))
        gpg.stdin.close()
        if gpg.wait() != 0:
            raise Fail("encrypting the backup failed")
        os.chmod(str(target) + ".part", 0o600)
        os.replace(str(target) + ".part", target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(genv["GNUPGHOME"], ignore_errors=True)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(str(target) + ".part")
    size = target.stat().st_size / 2**20
    say(f"  backup written: {real(target)} ({size:.1f} MB, {len(manifest['files'])} files"
        + (f", {len(manifest['db']['tables'])} tables" if manifest["db"] else "") + ")")
    audit(f"backup {real(target)}")
    if to is None:
        prune_backups(cfg)
    return target


def db_admin_env() -> Optional[Dict[str, str]]:
    """libpq settings from the owner address in /etc/aquarium/db-admin.env, if that file exists.

    Used when the database is not the local supabase-db container (e.g. hosted Supabase or
    another Postgres); the local container is dumped as supabase_admin, which sees every schema."""
    url = read_kv(P(f"{ETC}/db-admin.env")).get("HERMES_DB_ADMIN_URL", "")
    parts = urllib.parse.urlsplit(url) if url else None
    if not parts or parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        return None
    env = {**os.environ, "PGHOST": parts.hostname,
           "PGPORT": str(parts.port or 5432), "PGUSER": urllib.parse.unquote(parts.username or "postgres"),
           "PGPASSWORD": urllib.parse.unquote(parts.password or ""),
           "PGDATABASE": urllib.parse.unquote(parts.path.lstrip("/")) or "postgres", "PGCONNECT_TIMEOUT": "20"}
    sslmode = urllib.parse.parse_qs(parts.query).get("sslmode")
    if sslmode:
        env["PGSSLMODE"] = sslmode[0]
    return env


def url_counts(env: Dict[str, str], dbname: str) -> Dict[str, int]:
    proc = run(["psql", "-d", dbname, "-At", "-F", "|", "-c", COUNT_SQL], check=False, timeout=900, env=env)
    counts: Dict[str, int] = {}
    for line in proc.stdout.decode(errors="replace").splitlines():
        name, _, value = line.partition("|")
        if value.strip().isdigit():
            counts[name] = int(value)
    return counts


def dump_with_admin_url(env: Dict[str, str], staging: Path) -> Dict:
    if not have("pg_dump"):
        raise Fail("pg_dump is not installed", "apt-get install -y postgresql-client")
    say("  database dump (owner address from db-admin.env)")
    dbdir = staging / "db"
    dbdir.mkdir()
    with open(dbdir / "postgres.dump", "wb") as fh:
        p = subprocess.run(["pg_dump", "-Fc", "-d", env["PGDATABASE"]], stdout=fh, stderr=subprocess.PIPE,
                           env=env, check=False)
    if p.returncode != 0:
        raise Fail("the database dump failed: " + p.stderr.decode(errors="replace").strip()[-300:],
                   "Check that the database in /etc/aquarium/db-admin.env is reachable.")
    with open(dbdir / "globals.sql", "wb") as fh:
        # roles without passwords: a hosted database does not let the owner read them
        subprocess.run(["pg_dumpall", "--globals-only", "--no-role-passwords"], stdout=fh,
                       stderr=subprocess.PIPE, env=env, check=False)
    return {"database": env["PGDATABASE"], "tables": url_counts(env, env["PGDATABASE"]), "via": "db-admin.env"}


def prune_backups(cfg: Dict[str, str]) -> None:
    keep = max(int(cfg["BACKUP_KEEP"]), 1)
    files = sorted(P(cfg["BACKUP_DIR"]).glob("aquarium-backup-*.tar.gz.gpg"))
    for old in files[:-keep]:
        old.unlink()


def cmd_backup(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    with admin_lock():
        step("Backup")
        target = make_backup(cfg, label=args.label, to=Path(args.to) if args.to else None)
        st = load_state()
        st["last_backup"] = real(target)
        if state_path().parent.exists():
            save_state(st)
    return 0


# --------------------------------------------------------------------------- restore


def open_backup(path: Path, key: Path, dest: Path) -> Dict:
    """Decrypt and unpack into ``dest`` (root-only), then check every file's checksum."""
    genv = gpg_env()
    try:
        gpg = subprocess.Popen(["gpg", "--batch", "--quiet", "--pinentry-mode", "loopback", "--passphrase-file",
                                str(key), "--decrypt", str(path)], stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=genv)
        assert gpg.stdout is not None
        try:
            with tarfile.open(fileobj=gpg.stdout, mode="r|gz") as tar:
                tar.extractall(dest, filter="tar")
        except (tarfile.TarError, EOFError, OSError) as error:
            gpg.kill()
            raise Fail(f"cannot open the backup ({error.__class__.__name__})",
                       "Wrong backup key, or the file is damaged/incomplete.")
        if gpg.wait() != 0:
            raise Fail("cannot decrypt the backup: " + gpg.stderr.read().decode(errors="replace").strip()[-200:],
                       "Wrong backup key (use --key-file with the key saved when the backup was made), or a damaged file.")
    finally:
        shutil.rmtree(genv["GNUPGHOME"], ignore_errors=True)
    try:
        manifest = json.loads((dest / "manifest.json").read_text())
    except (OSError, ValueError):
        raise Fail("the backup has no manifest; it was not made by `aquarium backup` or is incomplete")
    bad = [name for name, digest in manifest.get("files", {}).items()
           if not (dest / name).is_file() or sha256_file(dest / name) != digest]
    if bad:
        raise Fail(f"{len(bad)} file(s) in the backup are damaged, e.g. {bad[0]}", "Use another backup.")
    return manifest


def pg_restore_into(cfg: Dict[str, str], dump: Path, dbname: str, clean: bool) -> int:
    argv = ["docker", "exec", "-i", cfg["DB_CONTAINER"], "pg_restore", "-U", "supabase_admin", "-d", dbname]
    if clean:
        argv += ["--clean", "--if-exists"]
    with open(dump, "rb") as fh:
        p = subprocess.run(argv, stdin=fh, capture_output=True, check=False)
    errors = len(re.findall(rb"pg_restore: error:", p.stderr))
    return errors


def compare_counts(expected: Dict[str, int], actual: Dict[str, int]) -> List[str]:
    return [f"{t}: backup {n}, restored {actual.get(t)}" for t, n in sorted(expected.items()) if actual.get(t) != n]


def psql(cfg: Dict[str, str], sql: str, db: str = "postgres") -> subprocess.CompletedProcess:
    return run(["docker", "exec", cfg["DB_CONTAINER"], "psql", "-U", "supabase_admin", "-d", db,
                "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], check=False, timeout=600)


def restore_test(cfg: Dict[str, str], manifest: Dict, staging: Path) -> List[str]:
    """Restore the database into a scratch database, compare row counts, drop it."""
    problems: List[str] = []
    if not manifest.get("db"):
        return problems
    url_env = None if db_running(cfg) else db_admin_env()
    if url_env is not None:
        return restore_test_url(url_env, manifest, staging)
    if not db_running(cfg):
        return ["the database is not running here, so the dump could not be test-restored"]
    scratch = "aquarium_restore_test"
    psql(cfg, f"DROP DATABASE IF EXISTS {scratch}")
    if psql(cfg, f"CREATE DATABASE {scratch}").returncode != 0:
        return ["could not create the scratch database for the test"]
    try:
        errors = pg_restore_into(cfg, staging / "db/postgres.dump", scratch, clean=False)
        diff = compare_counts(manifest["db"]["tables"], db_counts(cfg, scratch))
        if diff:
            problems += [f"row count differs: {d}" for d in diff[:20]]
        say(f"  database: {len(manifest['db']['tables'])} tables restored into a scratch copy"
            + (f" ({errors} pg_restore warnings, row counts decide)" if errors else ""))
    finally:
        psql(cfg, f"DROP DATABASE IF EXISTS {scratch}")
    return problems


def restore_test_url(env: Dict[str, str], manifest: Dict, staging: Path) -> List[str]:
    """Same test through the db-admin.env owner: a scratch database on that server, then dropped."""
    scratch = "aquarium_restore_test"

    def sql(text: str) -> subprocess.CompletedProcess:
        return run(["psql", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", text], check=False,
                   timeout=600, env=env)

    sql(f"DROP DATABASE IF EXISTS {scratch}")
    if sql(f"CREATE DATABASE {scratch}").returncode != 0:
        return ["could not create the scratch database for the test"]
    try:
        with open(staging / "db/postgres.dump", "rb") as fh:
            subprocess.run(["pg_restore", "--no-owner", "-d", scratch], stdin=fh, capture_output=True,
                           env=env, check=False)
        diff = compare_counts(manifest["db"]["tables"], url_counts(env, scratch))
        say(f"  database: {len(manifest['db']['tables'])} tables restored into a scratch copy")
        return [f"row count differs: {d}" for d in diff[:20]]
    finally:
        sql(f"DROP DATABASE IF EXISTS {scratch}")


def supabase_others(cfg: Dict[str, str]) -> List[str]:
    names = out(["docker", "ps", "--format", "{{.Names}}"], check=False).split()
    return [n for n in names if n.startswith("supabase-") and n != cfg["DB_CONTAINER"]]


def cmd_restore(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    path = Path(args.file)
    if not path.is_file():
        raise Fail(f"{args.file} not found")
    key = Path(args.key_file) if args.key_file else backup_key(create=False)
    with admin_lock():
        base = P(cfg["BACKUP_DIR"])
        base.mkdir(parents=True, exist_ok=True)
        os.chmod(base, 0o700)
        staging = Path(tempfile.mkdtemp(prefix=".restore-", dir=base))
        try:
            step(f"Opening {path.name}")
            manifest = open_backup(path, key, staging)
            say(f"  made {manifest['created']} on {manifest.get('hostname')} (release {manifest.get('release')}, "
                f"label {manifest.get('label')}); {len(manifest['files'])} files, checksums ok")
            if args.test:
                step("Restore test (nothing on this server is changed)")
                problems = restore_test(cfg, manifest, staging)
                if problems:
                    for p in problems:
                        say(f"  FAIL  {p}")
                    raise Fail("the restore test found problems", "Use another backup, and check the database health.")
                say("\nRestore test passed: the backup opens, every file matches, the database restores.")
                audit(f"restore --test {real(path)}: ok")
                return 0
            say("\nThis will REPLACE on this server:")
            for p in manifest["paths"]:
                say(f"  {p}")
            if manifest.get("db"):
                say(f"  the whole database ({len(manifest['db']['tables'])} app/auth/storage tables)")
            if not args.yes:
                say("\nNothing changed. Re-run with --yes to restore (a safety backup of the current state is taken first).")
                return 0
            return _restore_apply(cfg, manifest, staging, args)
        finally:
            shutil.rmtree(staging, ignore_errors=True)


def _restore_apply(cfg: Dict[str, str], manifest: Dict, staging: Path, args: argparse.Namespace) -> int:
    stamp = utcnow()
    if not args.no_safety_backup:
        step("Safety backup of the current state")
        make_backup(cfg, label="pre-restore")
    units = service_units()
    required = running_units(units)
    step("Stopping services")
    for unit in reversed(units):
        systemctl("stop", unit, check=False)
    others = supabase_others(cfg) if manifest.get("db") and db_running(cfg) else []
    for name in others:
        run(["docker", "stop", name], check=False)
    try:
        step("Putting files back")
        moved = []
        for p in manifest["paths"]:
            src = staging / ("root" + p)
            dest = P(p)
            if not src.exists() and not src.is_symlink():
                continue
            if dest.exists() or dest.is_symlink():
                aside = dest.with_name(f"{dest.name}.pre-restore-{stamp}")
                os.rename(dest, aside)
                moved.append(real(aside))
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            say(f"  {p}")
        if manifest.get("db"):
            step("Restoring the database")
            errors = pg_restore_into(cfg, staging / "db/postgres.dump", "postgres", clean=True)
            diff = compare_counts(manifest["db"]["tables"], db_counts(cfg, "postgres"))
            say(f"  pg_restore finished ({errors} warnings); "
                + ("row counts match the backup" if not diff else f"{len(diff)} tables differ"))
            for d in diff[:20]:
                say(f"  FAIL  {d}")
    finally:
        for name in others:
            run(["docker", "start", name], check=False)
    rel = manifest.get("release")
    if rel and LABEL_RE.match(rel) and P(f"{AQ}/releases/{rel}").is_dir() and rel != current_release():
        say(f"  switching code back to {rel} (the version the backup was made with)")
        symlink_swap(P(f"{AQ}/current"), f"releases/{rel}")
    elif rel and rel != current_release():
        say(f"  note: the backup was made with {rel}, which is not installed; keeping {current_release()}")
    step("Starting services")
    restart_services(units)
    failed = wait_healthy(cfg, required)
    audit(f"restore {manifest.get('created')}: {'ok' if not failed else 'health check failed'}")
    if moved:
        say("\nThe replaced files/folders were kept next to the originals:")
        for m in moved:
            say(f"  {m}")
    if failed:
        raise Fail("restored, but the health check fails: " + ", ".join(failed),
                   "Run `aquarium doctor` and `aquarium logs <service>`.")
    say("\nRestore finished; everything is healthy.")
    return 0


# --------------------------------------------------------------------------- offsite backups
#
# `aquarium offsite ...` copies encrypted backups to S3-compatible storage (Backblaze B2, Amazon
# S3, MinIO, ...). Nothing here runs until the owner saves a target (`offsite configure`): until
# then there is no settings file, no timer and no unit. The dashboard calls the five verbs in
# deploy/sudoers.d/hermes-backup through sudo with exact arguments; settings arrive as JSON on
# stdin and every verb answers with one JSON line. The storage keys stay in a root-only file and
# never leave it; the dashboard reads progress and results from OFFSITE_STATUS (no secrets).

OFFSITE_CONF = f"{ETC}/offsite.json"
OFFSITE_ENV = f"{ETC}/offsite.env"
OFFSITE_STATUS = "/var/lib/aquarium/offsite-status.json"
OFFSITE_BACKUP_UNIT = "hermes-offsite-backup"
OFFSITE_TEST_UNIT = "hermes-offsite-restore-test"
OFFSITE_PROVIDERS = ("b2", "s3", "other")
OFFSITE_PART = 64 * 2**20
B2_AUTHORIZE_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account"
OFFSITE_NAME_RE = re.compile(r"^aquarium-backup-(\d{8}T\d{6}Z)-offsite\.tar\.gz\.gpg$")


class OffsiteError(Fail):
    pass


def _q(text: str, safe: str = "-_.~") -> str:
    return urllib.parse.quote(text, safe=safe)


class S3:
    """A small S3 (signature v4) client: enough for put/get/list/delete. stdlib only."""

    def __init__(self, endpoint: str, region: str, bucket: str, key_id: str, secret: str) -> None:
        url = urllib.parse.urlsplit(endpoint)
        if url.scheme not in ("https", "http") or not url.hostname:
            raise OffsiteError("the storage address must look like https://s3.example.com")
        if url.scheme == "http" and not test_mode():
            raise OffsiteError("the storage address must start with https://")
        self.scheme, self.region, self.bucket = url.scheme, region or "us-east-1", bucket
        self.key_id, self.secret = key_id, secret
        host = url.netloc
        # Amazon wants the bucket in the host name; B2, MinIO and the rest take it in the path.
        if host.endswith("amazonaws.com") and "." not in bucket:
            self.host, self.base = f"{bucket}.{host}", ""
        else:
            self.host, self.base = host, "/" + bucket

    def _sign(self, method: str, path: str, query: Dict[str, str], headers: Dict[str, str],
              payload_hash: str) -> Dict[str, str]:
        amzdate = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        date = amzdate[:8]
        hdrs = {k.lower(): str(v).strip() for k, v in headers.items()}
        hdrs.update({"host": self.host, "x-amz-date": amzdate, "x-amz-content-sha256": payload_hash})
        canon_qs = "&".join(f"{_q(k)}={_q(v)}" for k, v in sorted(query.items()))
        signed = ";".join(sorted(hdrs))
        canon = "\n".join([method, _q(path, "/-_.~"), canon_qs,
                           "".join(f"{k}:{hdrs[k]}\n" for k in sorted(hdrs)), signed, payload_hash])
        scope = f"{date}/{self.region}/s3/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope, hashlib.sha256(canon.encode()).hexdigest()])
        k = ("AWS4" + self.secret).encode()
        for part in (date, self.region, "s3", "aws4_request"):
            k = hmac.new(k, part.encode(), hashlib.sha256).digest()
        sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        hdrs["authorization"] = (f"AWS4-HMAC-SHA256 Credential={self.key_id}/{scope}, "
                                 f"SignedHeaders={signed}, Signature={sig}")
        return hdrs

    def request(self, method: str, key: str = "", *, query: Optional[Dict[str, str]] = None,
                body: bytes = b"", sink: Optional[Callable[[bytes], None]] = None,
                ok: Sequence[int] = (200, 204)) -> Tuple[int, Dict[str, str], bytes]:
        query = dict(query or {})
        path = self.base + ("/" + key if key else ("/" if not self.base else ""))
        headers = self._sign(method, path, query, {"content-length": str(len(body))} if body or method in
                             ("PUT", "POST") else {}, hashlib.sha256(body).hexdigest())
        target = _q(path, "/-_.~") + ("?" + "&".join(f"{_q(k)}={_q(v)}" for k, v in sorted(query.items()))
                                      if query else "")
        cls = http.client.HTTPSConnection if self.scheme == "https" else http.client.HTTPConnection
        kw = {"context": ssl.create_default_context()} if self.scheme == "https" else {}
        try:
            conn = cls(self.host, timeout=300, **kw)
            conn.request(method, target, body=body or None, headers=headers)
            resp = conn.getresponse()
            status, rh = resp.status, {k.lower(): v for k, v in resp.getheaders()}
            data = b""
            if sink is not None and status in ok:
                while True:
                    chunk = resp.read(2**20)
                    if not chunk:
                        break
                    sink(chunk)
            else:
                data = resp.read()
            conn.close()
        except (OSError, http.client.HTTPException) as error:
            raise OffsiteError(f"could not reach the storage service ({error.__class__.__name__})",
                               "Check the storage address and that this server can reach the internet.")
        if status not in ok:
            raise OffsiteError(_s3_error(status, data))
        return status, rh, data

    # -- operations
    def put(self, key: str, data: bytes) -> None:
        self.request("PUT", key, body=data)

    def get(self, key: str) -> bytes:
        return self.request("GET", key)[2]

    def delete(self, key: str) -> None:
        self.request("DELETE", key)

    def size(self, key: str) -> int:
        return int(self.request("HEAD", key)[1].get("content-length") or -1)

    def list(self, prefix: str) -> List[Tuple[str, int]]:
        found: List[Tuple[str, int]] = []
        token = ""
        while True:
            query = {"list-type": "2", "prefix": prefix}
            if token:
                query["continuation-token"] = token
            root = _xml(self.request("GET", query=query)[2])
            for item in _children(root, "Contents"):
                found.append((_text(item, "Key"), int(_text(item, "Size") or 0)))
            token = _text(root, "NextContinuationToken")
            if _text(root, "IsTruncated") != "true" or not token:
                return found

    def upload(self, key: str, path: Path, progress: Callable[[int], None]) -> None:
        total = path.stat().st_size
        if total <= OFFSITE_PART:
            self.put(key, path.read_bytes())
            progress(100)
            return
        upload_id = _text(_xml(self.request("POST", key, query={"uploads": ""})[2]), "UploadId")
        parts: List[Tuple[int, str]] = []
        try:
            with open(path, "rb") as fh:
                n = 0
                while True:
                    chunk = fh.read(OFFSITE_PART)
                    if not chunk:
                        break
                    n += 1
                    rh = self.request("PUT", key, query={"partNumber": str(n), "uploadId": upload_id},
                                      body=chunk)[1]
                    parts.append((n, rh.get("etag", "")))
                    progress(min(99, int(fh.tell() * 100 / total)))
            body = ("<CompleteMultipartUpload>" + "".join(
                f"<Part><PartNumber>{n}</PartNumber><ETag>{etag}</ETag></Part>" for n, etag in parts)
                + "</CompleteMultipartUpload>").encode()
            data = self.request("POST", key, query={"uploadId": upload_id}, body=body)[2]
            if b"<Error>" in data:
                raise OffsiteError(_s3_error(500, data))
        except BaseException:
            with contextlib.suppress(Fail):
                self.request("DELETE", key, query={"uploadId": upload_id})
            raise
        progress(100)

    def download(self, key: str, path: Path, total: int, progress: Callable[[int], None]) -> None:
        done = [0]
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            def sink(chunk: bytes) -> None:
                fh.write(chunk)
                done[0] += len(chunk)
                progress(min(99, int(done[0] * 100 / max(total, 1))))
            self.request("GET", key, sink=sink)
        progress(100)


def _xml(data: bytes):
    import xml.etree.ElementTree as ET  # noqa: S405 - responses from the owner's own storage
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        raise OffsiteError("the storage service sent an answer this tool does not understand")


def _children(node, tag: str) -> list:
    return [c for c in list(node) if c.tag.rsplit("}", 1)[-1] == tag]


def _text(node, tag: str) -> str:
    found = _children(node, tag)
    return (found[0].text or "") if found else ""


def _s3_error(status: int, data: bytes) -> str:
    code = ""
    with contextlib.suppress(Exception):
        code = _text(_xml(data), "Code") if data else ""
    if code == "NoSuchBucket" or (status == 404 and not code):
        return "the bucket was not found: check the bucket name"
    if code in ("InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken") or status == 401:
        return "the storage service did not accept the key: check the Key ID and Secret key"
    if status == 403 or code == "AccessDenied":
        return "the key may not use this bucket: give the key read, write and delete access to it"
    return f"the storage service refused the request ({code or status})"


def offsite_status_path() -> Path:
    return P(OFFSITE_STATUS)


def load_offsite_status() -> Dict:
    try:
        return json.loads(offsite_status_path().read_text())
    except (OSError, ValueError):
        return {}


def save_offsite_status(st: Dict) -> None:
    path = offsite_status_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(st, fh, sort_keys=True)
    if os.geteuid() == 0:
        # The dashboard (service user) reads progress and results; no secrets are in this file.
        with contextlib.suppress(KeyError):
            os.chown(tmp, 0, pwd.getpwnam(load_config()["SERVICE_USER"]).pw_gid)
    os.chmod(tmp, 0o640)
    os.replace(tmp, path)


def update_offsite_status(**changes) -> Dict:
    st = load_offsite_status()
    st.update(changes)
    save_offsite_status(st)
    return st


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def load_offsite() -> Tuple[Dict, Dict[str, str]]:
    try:
        conf = json.loads(P(OFFSITE_CONF).read_text())
    except (OSError, ValueError):
        raise OffsiteError("no offsite storage is set up yet")
    creds = read_kv(P(OFFSITE_ENV))
    if not creds.get("AQUARIUM_OFFSITE_KEY_ID") or not creds.get("AQUARIUM_OFFSITE_SECRET_KEY"):
        raise OffsiteError("the storage key is missing: save the storage settings again")
    return conf, creds


def offsite_client(conf: Dict, creds: Dict[str, str]) -> S3:
    return S3(conf["endpoint"], conf.get("region", ""), conf["bucket"],
              creds["AQUARIUM_OFFSITE_KEY_ID"], creds["AQUARIUM_OFFSITE_SECRET_KEY"])


def _public_target(conf: Dict, key_id: str) -> Dict:
    return {"provider": conf["provider"], "bucket": conf["bucket"], "prefix": conf.get("prefix", ""),
            "endpoint": conf["endpoint"], "region": conf.get("region", ""),
            "key_id_hint": ("…" + key_id[-4:]) if len(key_id) > 4 else "…"}


def _validate_offsite(raw: Dict, old_creds: Dict[str, str]) -> Tuple[Dict, str, str]:
    provider = str(raw.get("provider") or "")
    if provider not in OFFSITE_PROVIDERS:
        raise OffsiteError("choose where to keep copies")
    bucket = str(raw.get("bucket") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]", bucket):
        raise OffsiteError("enter the bucket name (letters, digits, dots and dashes)")
    key_id = str(raw.get("key_id") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9+/=._-]{4,256}", key_id):
        raise OffsiteError("enter the Key ID")
    secret = str(raw.get("secret") or "").strip()
    if not secret and old_creds.get("AQUARIUM_OFFSITE_KEY_ID") == key_id:
        secret = old_creds.get("AQUARIUM_OFFSITE_SECRET_KEY", "")
    if not secret or len(secret) > 512 or not all(33 <= ord(c) < 127 for c in secret):
        raise OffsiteError("enter the Secret key")
    prefix = str(raw.get("prefix") if raw.get("prefix") is not None else "aquarium/").strip().lstrip("/")
    if not re.fullmatch(r"[A-Za-z0-9._/-]{0,100}", prefix) or ".." in prefix:
        raise OffsiteError("the folder name may use letters, digits, dots, dashes and /")
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    at = str(raw.get("time") or "03:00")
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", at):
        raise OffsiteError("the backup time must look like 03:00")
    try:
        keep_days = int(raw["keep_days"] if raw.get("keep_days") is not None else 30)
    except (TypeError, ValueError):
        keep_days = 0
    if not 1 <= keep_days <= 3650:
        raise OffsiteError("keep copies for 1 to 3650 days")
    endpoint = str(raw.get("endpoint") or "").strip().rstrip("/")
    region = str(raw.get("region") or "").strip()
    if region and not re.fullmatch(r"[a-z0-9-]{2,40}", region):
        raise OffsiteError("the region must look like us-west-004 or eu-central-1")
    if provider == "other" and not endpoint:
        raise OffsiteError("enter the storage address, e.g. https://s3.example.com")
    conf = {"provider": provider, "bucket": bucket, "prefix": prefix, "endpoint": endpoint, "region": region,
            "time": at, "keep_days": keep_days, "schedule": bool(raw.get("schedule", True))}
    return conf, key_id, secret


def _resolve_endpoint(conf: Dict, key_id: str, secret: str) -> None:
    """Fill in the S3 address and region the owner did not have to type."""
    if conf["provider"] == "b2" and not conf["endpoint"]:
        req = urllib.request.Request(B2_AUTHORIZE_URL, headers={
            "Authorization": "Basic " + base64.b64encode(f"{key_id}:{secret}".encode()).decode()})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https URL
                info = json.loads(resp.read())
        except urllib.error.HTTPError as error:
            raise OffsiteError("Backblaze did not accept the key: check the Key ID and Secret key"
                               if error.code in (401, 403) else f"Backblaze refused the key ({error.code})")
        except (OSError, ValueError):
            raise OffsiteError("could not reach Backblaze", "Check that this server can reach the internet.")
        api = info.get("apiInfo", {}).get("storageApi", info)
        conf["endpoint"] = str(api.get("s3ApiUrl") or "").rstrip("/")
        if not conf["endpoint"]:
            raise OffsiteError("Backblaze did not say where the bucket lives")
    if conf["provider"] == "s3" and not conf["endpoint"]:
        region = conf["region"]
        if not region:
            try:
                req = urllib.request.Request(f"https://s3.amazonaws.com/{_q(conf['bucket'])}", method="HEAD")
                with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                    region = resp.headers.get("x-amz-bucket-region", "")
            except urllib.error.HTTPError as error:
                region = error.headers.get("x-amz-bucket-region", "") if error.headers else ""
            except OSError:
                region = ""
        conf["region"] = region or "us-east-1"
        conf["endpoint"] = f"https://s3.{conf['region']}.amazonaws.com"
    if not conf["region"]:
        m = re.match(r"^https?://s3\.([a-z0-9-]+)\.backblazeb2\.com", conf["endpoint"])
        conf["region"] = m.group(1) if m else "us-east-1"


def offsite_check(client: S3, prefix: str) -> None:
    """Write, read back and delete a small file: proves the key may do what backups need."""
    key = f"{prefix}.aquarium-check-{secrets.token_hex(4)}"
    data = f"aquarium check {now_iso()}\n".encode()
    client.put(key, data)
    try:
        if client.get(key) != data:
            raise OffsiteError("the storage service gave back a different file than was written")
    finally:
        client.delete(key)


def offsite_units() -> Dict[str, str]:
    cmd = SELF_INSTALL
    hardening = ("Nice=10\nIOSchedulingClass=idle\nPrivateTmp=yes\nNoNewPrivileges=yes\n")
    return {
        f"{OFFSITE_BACKUP_UNIT}.service": (
            "[Unit]\nDescription=Aquarium offsite backup (set up in Get ready)\n"
            "Wants=network-online.target\nAfter=network-online.target docker.service\n\n"
            f"[Service]\nType=oneshot\nExecStart={cmd} offsite run --foreground\n{hardening}"),
        f"{OFFSITE_BACKUP_UNIT}.timer": "",
        f"{OFFSITE_TEST_UNIT}.service": (
            "[Unit]\nDescription=Aquarium offsite restore test (set up in Get ready)\n"
            "Wants=network-online.target\nAfter=network-online.target docker.service\n\n"
            f"[Service]\nType=oneshot\nExecStart={cmd} offsite restore-test --foreground\n{hardening}"),
    }


def write_offsite_units(conf: Dict) -> None:
    units = offsite_units()
    units[f"{OFFSITE_BACKUP_UNIT}.timer"] = (
        "[Unit]\nDescription=Nightly Aquarium offsite backup\n\n"
        f"[Timer]\nOnCalendar=*-*-* {conf['time']}:00\nPersistent=true\nRandomizedDelaySec=300\n\n"
        "[Install]\nWantedBy=timers.target\n")
    for name, text in units.items():
        path = P(f"{SYSTEMD}/{name}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        os.chmod(path, 0o644)
    systemctl("daemon-reload", check=False)
    timer = f"{OFFSITE_BACKUP_UNIT}.timer"
    if conf.get("schedule", True):
        systemctl("enable", "--now", timer)
    else:
        systemctl("disable", "--now", timer, check=False)


def _offsite_answer(data: Dict, code: int = 0) -> int:
    sys.stdout.write(json.dumps(data, sort_keys=True) + "\n")
    sys.stdout.flush()
    return code


def _offsite_public_status() -> Dict:
    st = load_offsite_status()
    if not _running_alive(st):
        st["running"] = None
    st["configured"] = P(OFFSITE_CONF).exists()
    st["key_exists"] = P(f"{ETC}/backup.key").exists()
    return st


def offsite_configure(cfg: Dict[str, str]) -> int:
    try:
        raw = json.loads(sys.stdin.read(65536) or "{}")
        if not isinstance(raw, dict):
            raise ValueError
    except ValueError:
        return _offsite_answer({"ok": False, "error": "the settings could not be read"}, 1)
    try:
        conf, key_id, secret = _validate_offsite(raw, read_kv(P(OFFSITE_ENV)))
        _resolve_endpoint(conf, key_id, secret)
        offsite_check(S3(conf["endpoint"], conf["region"], conf["bucket"], key_id, secret), conf["prefix"])
    except Fail as error:
        update_offsite_status(last_check={"at": now_iso(), "ok": False, "error": str(error)})
        return _offsite_answer({"ok": False, "error": str(error)}, 1)
    with admin_lock():
        key_path = P(f"{ETC}/backup.key")
        new_key = None
        if not key_path.exists():
            new_key = backup_key().read_text().strip()
        write_private(P(OFFSITE_ENV), (f"AQUARIUM_OFFSITE_KEY_ID={key_id}\n"
                                       f"AQUARIUM_OFFSITE_SECRET_KEY={secret}\n").encode())
        write_private(P(OFFSITE_CONF), (json.dumps(conf, indent=1, sort_keys=True) + "\n").encode())
        write_offsite_units(conf)
        st = update_offsite_status(target=_public_target(conf, key_id),
                                   schedule={"enabled": conf["schedule"], "time": conf["time"],
                                             "keep_days": conf["keep_days"]},
                                   last_check={"at": now_iso(), "ok": True, "error": ""})
        audit(f"offsite configure {conf['provider']} bucket={conf['bucket']}")
    answer = {"ok": True, "status": dict(st, configured=True, key_exists=True)}
    if new_key:
        answer["new_key"] = new_key  # shown once in Get ready so the owner can keep it elsewhere
    return _offsite_answer(answer)


def offsite_test(cfg: Dict[str, str]) -> int:
    try:
        conf, creds = load_offsite()
        offsite_check(offsite_client(conf, creds), conf.get("prefix", ""))
    except Fail as error:
        update_offsite_status(last_check={"at": now_iso(), "ok": False, "error": str(error)})
        return _offsite_answer({"ok": False, "error": str(error)}, 1)
    st = update_offsite_status(last_check={"at": now_iso(), "ok": True, "error": ""})
    return _offsite_answer({"ok": True, "status": st})


def offsite_remove(cfg: Dict[str, str]) -> int:
    """Stop offsite backups: timer and units go, the key file goes. Copies in the bucket stay."""
    with admin_lock():
        systemctl("disable", "--now", f"{OFFSITE_BACKUP_UNIT}.timer", check=False)
        for name in offsite_units():
            with contextlib.suppress(FileNotFoundError):
                P(f"{SYSTEMD}/{name}").unlink()
        systemctl("daemon-reload", check=False)
        for f in (OFFSITE_ENV, OFFSITE_CONF):
            with contextlib.suppress(FileNotFoundError):
                P(f).unlink()
        st = load_offsite_status()
        for k in ("target", "schedule", "running"):
            st.pop(k, None)
        save_offsite_status(st)
        audit("offsite remove")
    return _offsite_answer({"ok": True})


def _running_alive(st: Dict) -> bool:
    running = st.get("running")
    if not running:
        return False
    pid = running.get("pid")
    if pid:
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True
    started = running.get("started", "")
    try:  # "starting": systemd has not launched the job yet; give it two minutes
        age = (_dt.datetime.now(_dt.timezone.utc) - _dt.datetime.fromisoformat(started)).total_seconds()
    except ValueError:
        return False
    return age < 120


def offsite_start(cfg: Dict[str, str], kind: str) -> int:
    """Ask systemd to run the job (so it survives the web request) and return at once."""
    try:
        load_offsite()
    except Fail as error:
        return _offsite_answer({"ok": False, "error": str(error)}, 1)
    st = load_offsite_status()
    if _running_alive(st):
        return _offsite_answer({"ok": True, "started": False, "status": _offsite_public_status()})
    if kind == "restore-test" and not (st.get("last_good_backup") or {}).get("name"):
        return _offsite_answer({"ok": False, "error": "there is no copy to test yet: run a backup first"}, 1)
    update_offsite_status(running={"kind": kind, "phase": "starting", "percent": 0, "started": now_iso(),
                                   "pid": None})
    unit = OFFSITE_BACKUP_UNIT if kind == "backup" else OFFSITE_TEST_UNIT
    proc = systemctl("start", "--no-block", f"{unit}.service", check=False)
    if proc.returncode != 0:
        update_offsite_status(running=None)
        return _offsite_answer({"ok": False, "error": "could not start the job on this server"}, 1)
    return _offsite_answer({"ok": True, "started": True, "status": _offsite_public_status()})


class _Progress:
    def __init__(self, kind: str) -> None:
        self.kind, self.started, self.last = kind, now_iso(), 0.0
        self.set("starting", 0, force=True)

    def set(self, phase: str, percent: int, *, force: bool = False) -> None:
        if not force and time.monotonic() - self.last < 1.0:
            return
        self.last = time.monotonic()
        update_offsite_status(running={"kind": self.kind, "phase": phase, "percent": int(percent),
                                       "started": self.started, "pid": os.getpid()})


def offsite_backup_now(cfg: Dict[str, str]) -> int:
    conf, creds = load_offsite()
    client = offsite_client(conf, creds)
    began = time.monotonic()
    prog = _Progress("backup")
    work = P(cfg["BACKUP_DIR"]) / "offsite"
    path: Optional[Path] = None
    try:
        with admin_lock():
            # make_backup reports database (0-30%), files (30-60%); upload is 60-100%
            path = make_backup(cfg, label="offsite", to=work,
                               progress=lambda phase, pct: prog.set(phase, pct, force=phase != "files"))
            name = path.name
            size = path.stat().st_size
            key = conf.get("prefix", "") + name
            prog.set("uploading", 60, force=True)
            client.upload(key, path, lambda pct: prog.set("uploading", 60 + pct * 40 // 100))
            if client.size(key) != size:
                raise OffsiteError("the copy in storage is not complete; it will be tried again")
            prog.set("cleanup", 99, force=True)
            removed = offsite_prune(client, conf)
            copies = len([k for k, _ in client.list(conf.get("prefix", "")) if OFFSITE_NAME_RE.match(
                k.rsplit("/", 1)[-1])])
    except Fail as error:
        update_offsite_status(running=None, last_backup={"at": now_iso(), "ok": False, "error": str(error)})
        audit(f"offsite backup failed: {error}")
        raise
    finally:
        if path is not None:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()
    result = {"at": now_iso(), "ok": True, "error": "", "name": name, "size": size,
              "seconds": int(time.monotonic() - began)}
    update_offsite_status(running=None, last_backup=result, last_good_backup=result, copies=copies)
    audit(f"offsite backup {name} ({size} bytes) uploaded, {removed} old copies removed")
    say(f"Offsite backup done: {name}")
    return 0


def offsite_prune(client: S3, conf: Dict) -> int:
    """Delete copies older than keep_days; the newest copy is always kept."""
    prefix = conf.get("prefix", "")
    names = sorted(k for k, _ in client.list(prefix) if OFFSITE_NAME_RE.match(k[len(prefix):]))
    cutoff = (_dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(days=int(conf.get("keep_days", 30))))
    removed = 0
    for k in names[:-1]:
        stamp = OFFSITE_NAME_RE.match(k[len(prefix):]).group(1)  # type: ignore[union-attr]
        made = _dt.datetime.strptime(stamp, "%Y%m%dT%H%M%SZ").replace(tzinfo=_dt.timezone.utc)
        if made < cutoff:
            client.delete(k)
            removed += 1
    return removed


def offsite_restore_test_now(cfg: Dict[str, str]) -> int:
    conf, creds = load_offsite()
    client = offsite_client(conf, creds)
    prefix = conf.get("prefix", "")
    prog = _Progress("restore-test")
    work = Path(tempfile.mkdtemp(prefix=".restore-test-", dir=_scratch_parent(cfg)))
    os.chmod(work, 0o700)
    name = ""
    try:
        copies = sorted((k, s) for k, s in client.list(prefix) if OFFSITE_NAME_RE.match(k[len(prefix):]))
        if not copies:
            raise OffsiteError("there is no copy in storage to test yet")
        key, size = copies[-1]
        name = key[len(prefix):]
        archive = work / name
        prog.set("downloading", 0, force=True)
        client.download(key, archive, size, lambda pct: prog.set("downloading", pct * 50 // 100))
        prog.set("checking", 50, force=True)
        staging = work / "unpacked"
        staging.mkdir(mode=0o700)
        manifest = open_backup(archive, backup_key(create=False), staging)
        archive.unlink()
        prog.set("checking", 70, force=True)
        problems = restore_test(cfg, manifest, staging)
        if problems:
            raise OffsiteError("; ".join(problems[:3]))
    except Fail as error:
        update_offsite_status(running=None, last_restore_test={"at": now_iso(), "ok": False, "name": name,
                                                               "error": str(error)})
        audit(f"offsite restore test failed: {error}")
        raise
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result = {"at": now_iso(), "ok": True, "name": name, "error": "", "files": len(manifest.get("files", {})),
              "tables": len((manifest.get("db") or {}).get("tables", {}))}
    update_offsite_status(running=None, last_restore_test=result)
    audit(f"offsite restore test {name}: ok")
    say(f"Restore test passed: {name}")
    return 0


def _scratch_parent(cfg: Dict[str, str]) -> Path:
    """Scratch space for a restore test: under the backup folder, never under live data."""
    parent = P(cfg["BACKUP_DIR"]) / "restore-test"
    parent.mkdir(parents=True, exist_ok=True)
    os.chmod(parent, 0o700)
    return parent


def cmd_offsite(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    verb = args.verb
    if verb == "status":
        return _offsite_answer(_offsite_public_status())
    if verb == "configure":
        return offsite_configure(cfg)
    if verb == "test":
        return offsite_test(cfg)
    if verb == "remove":
        return offsite_remove(cfg)
    kind = "backup" if verb == "run" else "restore-test"
    if not args.foreground:
        return offsite_start(cfg, kind)
    step("Offsite backup" if kind == "backup" else "Offsite restore test (nothing live is changed)")
    return offsite_backup_now(cfg) if kind == "backup" else offsite_restore_test_now(cfg)


# --------------------------------------------------------------------------- doctor

OK, WARN, FAILED = "ok", "warn", "fail"


def check_disk(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    for mount in sorted({"/", cfg["DATA_ROOT"]}):
        if not P(mount).exists():
            continue
        du = shutil.disk_usage(P(mount))
        free_gb, pct = du.free / 2**30, 100 * (du.total - du.free) / du.total
        status = FAILED if free_gb < 5 else WARN if free_gb < 15 or pct > 90 else OK
        rows.append((status, f"disk {mount}: {free_gb:.0f} GB free ({pct:.0f}% used)",
                     "" if status == OK else "Delete old backups in /var/backups/aquarium, `docker image prune`, "
                     "or resize the server's disk."))
    return rows


def cert_days_left(domain: str) -> float:
    ctx = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", 443), timeout=10) as sock:
        with ctx.wrap_socket(sock, server_hostname=domain) as tls:
            not_after = tls.getpeercert()["notAfter"]
    return (ssl.cert_time_to_seconds(not_after) - time.time()) / 86400


def caddy_domains() -> List[str]:
    try:
        text = P(CADDYFILE).read_text()
    except OSError:
        return []
    return [m.group(1) for m in re.finditer(r"^([A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*\{", text, re.M)]


def check_certs(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    domains = [d for d in (cfg["HOME_DOMAIN"], cfg["DASHBOARD_DOMAIN"]) if d] or caddy_domains()
    rows = []
    for d in domains:
        try:
            days = cert_days_left(d)
        except (OSError, ssl.SSLError, KeyError, ValueError) as error:
            rows.append((FAILED, f"certificate {d}: cannot get a valid certificate ({error.__class__.__name__})",
                         f"Check that DNS for {d} points at this server and ports 80/443 are open; "
                         "then `journalctl -u caddy` shows why Let's Encrypt refused."))
            continue
        status = FAILED if days < 7 else WARN if days < 20 else OK
        rows.append((status, f"certificate {d}: {days:.0f} days left",
                     "" if status == OK else "Caddy renews automatically from 30 days before expiry; if it is "
                     "this close, renewal is failing: `journalctl -u caddy`, check DNS and ports 80/443."))
    if not domains:
        rows.append((WARN, "certificates: no domain configured", "Set HOME_DOMAIN in /etc/aquarium/aquarium.conf."))
    return rows


def check_services(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    for unit in service_units():
        state = systemctl("is-active", unit, check=False).stdout.decode().strip() or "unknown"
        rows.append((OK if state == "active" else FAILED, f"service {unit}: {state}",
                     "" if state == "active" else f"See why: `aquarium logs {unit}`; start it: `systemctl restart {unit}`."))
    return rows


def check_db(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    if not have("docker"):
        return [(FAILED, "database: docker is not installed", "Re-run install-aquarium.sh.")]
    rows = []
    unhealthy = out(["docker", "ps", "--filter", "health=unhealthy", "--format", "{{.Names}}"], check=False).split()
    rows.append((FAILED if unhealthy else OK,
                 "supabase containers: " + (f"unhealthy: {', '.join(unhealthy)}" if unhealthy else "healthy"),
                 f"cd {cfg['SUPABASE_DIR']} && docker compose up -d; then `docker logs <name>`." if unhealthy else ""))
    ok = db_ready(cfg)
    rows.append((OK if ok else FAILED, "database: " + ("accepting connections" if ok else "not answering"),
                 "" if ok else f"cd {cfg['SUPABASE_DIR']} && docker compose up -d, then `docker logs {cfg['DB_CONTAINER']}`."))
    return rows


def check_http(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    code = http_status(cfg["AGENT_HOME_URL"])
    rows.append((OK if code == 200 else FAILED, f"agent-home: HTTP {code}",
                 "" if code == 200 else "`aquarium logs agent-home`; a missing build shows as 'Could not find a production build'."))
    code = http_status(cfg["DASHBOARD_URL"])
    rows.append((OK if code in (200, 302, 401) else FAILED, f"dashboard API: HTTP {code}",
                 "" if code in (200, 302, 401) else "`aquarium logs hermes-dashboard`."))
    if "hermes-embed.service" in service_units():
        code = http_status(cfg["EMBED_URL"], data=b'{"texts":["ok"]}', timeout=30)
        rows.append((OK if code == 200 else FAILED, f"embedding service: HTTP {code}",
                     "" if code == 200 else "`aquarium logs hermes-embed`; first start loads the model (~1 min)."))
    return rows


def check_whatsapp(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    for unit in bridge_units():
        port = unit_port(unit)
        status = None
        if port:
            with contextlib.suppress(urllib.error.URLError, OSError, ValueError):
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as resp:
                    status = json.loads(resp.read().decode()).get("status")
        name = re.sub(r"^hermes-wa-bridge[-@]", "", unit)[:-len(".service")]
        if status == "connected":
            rows.append((OK, f"WhatsApp {name}: paired and connected", ""))
        elif status is None:
            rows.append((FAILED, f"WhatsApp {name}: bridge not answering",
                         f"`systemctl restart {unit}` and look at `aquarium logs {unit}`."))
        else:
            rows.append((FAILED, f"WhatsApp {name}: {status} (phone not linked)",
                         "Open Settings → WhatsApp in Aquarium and scan the QR code with the phone again."))
    return rows


def check_vpn(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    stale = dict(stale_helpers(code_dir(cfg)))
    for installed, _source, label in ROOT_HELPERS:
        if not P(installed).exists():
            rows.append((OK, f"{label}: not installed" + (" (only needed for VPN and network folders)"
                                                            if "VPN" in label else ""), ""))
        elif label in stale:
            rows.append((FAILED, f"{label}: older than the installed Aquarium version", stale[label]))
        else:
            rows.append((OK, f"{label}: matches this version", ""))
    return rows


def check_self(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    lay = layout(cfg)
    rows.append((OK if lay == "release" else WARN, f"layout: {lay}",
                 "" if lay == "release" else "Move to the release layout: `aquarium migrate-layout --dry-run`."))
    src = code_dir(cfg) / "deploy/aquarium.py"
    if src.exists() and P(SELF_INSTALL).exists() and src.read_bytes() != P(SELF_INSTALL).read_bytes():
        rows.append((WARN, "the aquarium command differs from the installed version's copy",
                     f"install -m 755 -o root -g root {real(src)} {SELF_INSTALL}"))
    for unit in service_units():
        for f in unit_env_files(unit):
            path = P(f.lstrip("-"))
            if not path.exists():
                continue
            st = path.stat()
            if any(real(path).startswith(h.rstrip("/") + "/") for h in hermes_homes(cfg)):
                continue  # $HERMES_HOME/.env is written by the app itself
            if st.st_mode & 0o077 or (os.geteuid() == 0 and st.st_uid != 0):  # windows-footgun: ok — POSIX-only root admin tooling
                rows.append((WARN, f"settings file {real(path)} is readable by others (mode {st.st_mode & 0o777:o})",
                             f"chown root:root {real(path)} && chmod 600 {real(path)} (systemd reads it as root)."))
    return rows


def check_backups(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    files = sorted(P(cfg["BACKUP_DIR"]).glob("aquarium-backup-*.tar.gz.gpg")) if P(cfg["BACKUP_DIR"]).is_dir() else []
    if not files:
        return [(WARN, "backups: none yet", "Run `aquarium backup`, then copy it and /etc/aquarium/backup.key off the server.")]
    age = (time.time() - files[-1].stat().st_mtime) / 86400
    return [(OK if age < 8 else WARN, f"backups: newest is {age:.0f} days old ({files[-1].name})",
             "" if age < 8 else "Run `aquarium backup` (and schedule it).")]


def check_probes(cfg: Dict[str, str]) -> List[Tuple[str, str, str]]:
    rows = []
    rel = code_dir(cfg)
    for name in ("model-key", "google"):
        _, results = run_probe(cfg, rel, name, timeout=120)
        for r in results:
            status = r.get("status") if r.get("status") in (OK, WARN, FAILED) else WARN
            rows.append((status, f"{r.get('check', name)}: {r.get('message', '')}", r.get("fix", "")))
    return rows


DOCTOR = [check_disk, check_self, check_services, check_db, check_http, check_certs,
          check_probes, check_whatsapp, check_vpn, check_backups]


def cmd_doctor(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    failed = warned = 0
    as_json = getattr(args, "json", False)
    found: List[Dict[str, str]] = []
    for check in DOCTOR:
        try:
            rows = check(cfg)
        except Fail as error:
            rows = [(FAILED, str(error), error.fix)]
        except Exception as error:  # one broken check must not hide the others
            rows = [(WARN, f"{check.__name__}: could not run ({error.__class__.__name__}: {error})", "")]
        for status, text, fix in rows:
            found.append({"status": status, "text": text, "fix": fix if status != OK else ""})
            if not as_json:
                say(f"  {'ok  ' if status == OK else 'WARN' if status == WARN else 'FAIL'}  {text}")
                if status != OK and fix:
                    say(f"        Fix: {fix}")
            failed += status == FAILED
            warned += status == WARN
    if as_json:
        # One line for deploy/hermes-security-check (Get ready → Security basics).
        print(json.dumps({"rows": found, "failed": failed, "warned": warned}), flush=True)
    else:
        say(f"\n{failed} problem(s), {warned} warning(s).")
    return 1 if failed else 0


# --------------------------------------------------------------------------- status / logs


def cmd_status(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    state = load_state()
    lay = layout(cfg)
    say(f"Layout:    {lay}")
    say(f"Version:   {current_release() or '-'}" + ("" if lay == "release" else " (git checkout)"))
    say(f"Previous:  {state.get('previous') or '-'}")
    say(f"Channel:   {cfg['CHANNEL']}")
    say(f"Backup:    {state.get('last_backup') or '-'}")
    if lay == "release" and not args.offline:
        with contextlib.suppress(Fail):
            latest = pick_release(cfg, None, None)["tag_name"]
            newer = version_key(latest) > version_key(current_release() or "")
            say(f"Latest:    {latest}" + ("  (update available: `aquarium update`)" if newer else ""))
    say("Services:")
    for unit in service_units():
        state_text = systemctl("is-active", unit, check=False).stdout.decode().strip() or "unknown"
        say(f"  {unit:42} {state_text}")
    return 0


def resolve_unit(name: str) -> str:
    known = sorted(set(service_units()) | set(bridge_units()))
    for cand in (name, f"{name}.service", f"hermes-{name}.service", f"hermes-wa-bridge-{name}.service"):
        if cand in known:
            return cand
    raise Fail(f"unknown service '{name}'", "Known: " + ", ".join(u[:-8] for u in known))


def cmd_logs(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    lines = str(max(1, min(args.lines, 100000)))
    if args.service:
        unit = resolve_unit(args.service)
        logfile = unit_log_file(unit)
        argv = (["tail", "-n", lines] + (["-f"] if args.follow else []) + [logfile]) if logfile else \
            (["journalctl", "-u", unit, "-n", lines, "--no-pager"] + (["-f"] if args.follow else []))
    else:
        argv = ["journalctl", "-n", lines, "--no-pager"] + (["-f"] if args.follow else [])
        for unit in service_units():
            argv += ["-u", unit]
    return subprocess.call(argv)


# --------------------------------------------------------------------------- migrate-layout

# Sorts after drop-ins already on a box (e.g. 10-unprivileged.conf), so its reset wins.
DROPIN = "99-aquarium-env.conf"


def git_label(checkout: Path) -> Tuple[str, List[str]]:
    # Root reading a service-user-owned repo: never run its hooks or fsmonitor (F13).
    git = ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
           "-c", f"safe.directory={checkout}", "-C", str(checkout)]
    sha = out(git + ["rev-parse", "--short=12", "HEAD"]).strip()
    mods = [line for line in out(git + ["status", "--porcelain", "--untracked-files=normal"]).splitlines() if line]
    return f"git-{sha}", mods


def plan_layout(cfg: Dict[str, str]) -> Dict:
    checkout = compat_path(cfg)
    if layout(cfg) != "git":
        raise Fail("nothing to migrate: " + ("already on the release layout" if layout(cfg) == "release"
                                             else f"{real(checkout)} not found"))
    if not (checkout / ".git").exists():
        raise Fail(f"{real(checkout)} is not a git checkout")
    label, mods = git_label(checkout)
    units = service_units()
    homes = hermes_homes(cfg)
    env_moves: Dict[str, str] = {}
    dropins: Dict[str, List[str]] = {}
    for unit in units:
        files = unit_env_files(unit)
        new = []
        for f in files:
            optional, path = f.startswith("-"), f.lstrip("-")
            if not path.startswith(real(checkout).rstrip("/") + "/"):
                # Outside the code tree (/opt/data/hermes-*.env, $HERMES_HOME/.env, /etc/aquarium):
                # left exactly where it is, so scripts that source it keep working.
                new.append(f)
                continue
            if path not in env_moves:
                name = Path(path).name
                if name in {Path(v).name for v in env_moves.values()}:
                    name = f"{unit[:-8]}-{name}"
                env_moves[path] = f"{ETC}/{name}"
            new.append(("-" if optional else "") + env_moves[path])
        if new != files:
            dropins[unit] = new
    inside = list(env_moves)
    return {"checkout": real(checkout), "label": label, "local_changes": mods, "units": units,
            "required": running_units(units),
            "env_moves": env_moves, "dropins": dropins, "skip": inside, "homes": homes}


def print_plan(plan: Dict) -> None:
    ck = plan["checkout"]
    say(f"Plan for moving {ck} to the release layout (version label {plan['label']}):")
    say("  1. full backup (database, data folders, settings) — `aquarium backup`")
    say(f"  2. copy {ck} (without .git and without the env files below) to {AQ}/releases/{plan['label']},")
    say("     owned by root and read-only to the service user; agent-home/.next stays writable")
    say("  3. copy the env files that live inside the checkout to /etc/aquarium (root, mode 0600);")
    say("     the originals stay in the old checkout, other env files are not touched:")
    for src, dst in plan["env_moves"].items():
        say(f"       {src} -> {dst}")
    if not plan["env_moves"]:
        say("       (none)")
    say("  4. point the services at them with a drop-in file (old unit files are not edited):")
    for unit in plan["dropins"]:
        say(f"       {SYSTEMD}/{unit}.d/{DROPIN}")
    say(f"  5. rename {ck} -> {ck}.pre-release-<time> and make {ck} a link to {AQ}/current")
    say(f"  6. restart {len(plan['units'])} services and run the health checks; if any check fails, steps 2-5 are undone")
    if plan["local_changes"]:
        say("\n  Note: the checkout has local changes; they are copied as they are:")
        for m in plan["local_changes"][:30]:
            say(f"       {m}")
    say("\n  After this, /opt/data/deploy-hermes.sh (and the sudo rule that runs it) no longer deploys:")
    say("  there is no git checkout any more. Updates come from signed releases with `aquarium update`.")
    say("  Undo later with `aquarium migrate-layout --undo`.")


def cmd_migrate_layout(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    if args.undo:
        with admin_lock():
            return undo_layout(cfg)
    plan = plan_layout(cfg)
    print_plan(plan)
    if args.dry_run or not args.yes:
        say("\nDry run: nothing changed." + ("" if args.dry_run else " Re-run with --yes to do it."))
        return 0
    with admin_lock():
        return apply_layout(cfg, plan)


def apply_layout(cfg: Dict[str, str], plan: Dict) -> int:
    checkout, label, stamp = P(plan["checkout"]), plan["label"], utcnow()
    rel = P(f"{AQ}/releases/{label}")
    step("1. Backup")
    backup = make_backup(cfg, label="pre-migrate-layout")
    P(f"{AQ}/releases").mkdir(parents=True, exist_ok=True)
    os.chmod(P(AQ), 0o755)
    record = {"label": label, "at": stamp, "old_dir": f"{plan['checkout']}.pre-release-{stamp}",
              "dropins": [], "env_copies": [], "backup": real(backup), "release_created": not rel.exists()}
    state = load_state()
    state["migrate_layout"] = record
    save_state(state)
    skip = {P(s) for s in plan["skip"]}
    try:
        step(f"2. Copying the code to {AQ}/releases/{label}")
        if not rel.exists():
            partial = P(f"{AQ}/releases/.{label}.partial")
            if partial.exists():
                shutil.rmtree(partial)

            def ignore(d: str, names: List[str]) -> List[str]:
                return [n for n in names if (d == str(checkout) and n == ".git") or Path(d, n) in skip]
            shutil.copytree(checkout, partial, symlinks=True, ignore=ignore)
            seal_release(cfg, partial)
            os.rename(partial, rel)
        step("3. Env files to /etc/aquarium")
        P(ETC).mkdir(parents=True, exist_ok=True)
        os.chmod(P(ETC), 0o700)
        for src, dst in plan["env_moves"].items():
            if not P(dst).exists():
                write_private(P(dst), P(src).read_bytes())
                record["env_copies"].append(dst)
            say(f"  {dst}")
        step("4. systemd drop-ins")
        for unit, files in plan["dropins"].items():
            path = P(f"{SYSTEMD}/{unit}.d/{DROPIN}")
            body = (f"# Written by `aquarium migrate-layout` at {stamp}. Undo: `aquarium migrate-layout --undo`.\n"
                    "[Service]\nEnvironmentFile=\n" + "".join(f"EnvironmentFile={f}\n" for f in files))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body)
            os.chmod(path, 0o644)
            record["dropins"].append(real(path))
            say(f"  {real(path)}")
        step("5. Switching the code path")
        symlink_swap(P(f"{AQ}/current"), f"releases/{label}")
        os.rename(checkout, P(record["old_dir"]))
        os.symlink(str(P(f"{AQ}/current")), checkout)
        save_state(state)
        step("6. Restarting and checking")
        restart_services(plan["units"])
        failed = wait_healthy(cfg, plan["required"])
        if failed:
            raise Fail("health check failed after the move: " + ", ".join(failed))
    except Exception as error:
        step("Undoing the move")
        _undo(cfg, record, plan["units"], plan["required"])
        state = load_state()
        state.pop("migrate_layout", None)
        save_state(state)
        audit(f"migrate-layout {label}: failed and undone ({error})")
        if isinstance(error, Fail):
            raise Fail(f"{error} — everything was put back as it was", "`aquarium logs <service>` shows why.")
        raise
    state.update(layout="release", current=label, previous=None)
    state.setdefault("history", []).append({"version": label, "from": "git checkout", "at": stamp, "result": "ok"})
    save_state(state)
    audit(f"migrate-layout {label}: ok")
    say(f"\nDone. The code now runs from {AQ}/releases/{label}; the old checkout is at {record['old_dir']}.")
    say("Update from now on with `aquarium update`. Undo with `aquarium migrate-layout --undo`.")
    return 0


def _undo(cfg: Dict[str, str], record: Dict, units: Sequence[str],
          required: Optional[Sequence[str]] = None) -> None:
    checkout, old = compat_path(cfg), P(record["old_dir"])
    if old.is_dir():
        if checkout.is_symlink():
            checkout.unlink()
        if not checkout.exists():
            os.rename(old, checkout)
    for d in record.get("dropins", []):
        with contextlib.suppress(FileNotFoundError):
            P(d).unlink()
    for e in record.get("env_copies", []):
        with contextlib.suppress(FileNotFoundError):
            P(e).unlink()
    with contextlib.suppress(FileNotFoundError):
        P(f"{AQ}/current").unlink()
    if record.get("release_created"):
        shutil.rmtree(P(f"{AQ}/releases/{record['label']}"), ignore_errors=True)
        shutil.rmtree(P(f"{AQ}/releases/.{record['label']}.partial"), ignore_errors=True)
    restart_services(units)
    wait_healthy(cfg, units if required is None else required)


def undo_layout(cfg: Dict[str, str]) -> int:
    state = load_state()
    record = state.get("migrate_layout")
    if not record:
        raise Fail("no layout migration to undo")
    if current_release() != record["label"]:
        raise Fail(f"an update ran since the migration (now on {current_release()})",
                   f"First go back with `aquarium update --version` is not possible for a git label; restore the "
                   f"pre-migration backup instead: {record.get('backup')}")
    if not P(record["old_dir"]).is_dir():
        raise Fail(f"the old checkout {record['old_dir']} is gone; cannot undo")
    step("Putting the git checkout back")
    units = service_units()
    _undo(cfg, record, units, running_units(units))
    state.pop("migrate_layout", None)
    state.update(layout="git", current=None)
    save_state(state)
    audit(f"migrate-layout --undo {record['label']}")
    say("Back on the git checkout layout.")
    return 0


# --------------------------------------------------------------------------- uninstall


def cmd_uninstall(args: argparse.Namespace, cfg: Dict[str, str]) -> int:
    units = sorted(set(service_units()) | set(bridge_units()) | set(enabled_units("hermes-*.timer"))
                   | {p.name for p in P(SYSTEMD).glob("hermes-offsite-*")})
    data = [cfg["SUPABASE_DIR"].rsplit("/docker", 1)[0]] + hermes_homes(cfg) + [ETC, f"{cfg['DATA_ROOT']}/hermes-embed"]
    say("This removes Aquarium from this server:")
    say(f"  stop and remove {len(units)} services: {', '.join(units)}")
    say(f"  remove {AQ}, {real(compat_path(cfg))}, {SELF_INSTALL}, {VPN_HELPER} and /etc/sudoers.d/hermes-*")
    if args.purge_data:
        say("  DELETE ALL DATA: the database (docker compose down -v) and " + ", ".join(data))
    else:
        say("  keeps the data (database, " + ", ".join(data[1:]) + ")")
    say(f"  a final backup goes to {cfg['BACKUP_DIR']} first (kept), together with your backup key")
    if not args.yes:
        say("\nNothing changed. Re-run with --yes to uninstall.")
        return 0
    with admin_lock():
        if not args.no_backup:
            step("Final backup")
            make_backup(cfg, label="pre-uninstall")
            shutil.copy2(backup_key(create=False), P(cfg["BACKUP_DIR"]) / "backup.key")
        step("Removing services")
        for unit in units:
            systemctl("disable", "--now", unit, check=False)
            with contextlib.suppress(FileNotFoundError):
                P(f"{SYSTEMD}/{unit}").unlink()
            shutil.rmtree(P(f"{SYSTEMD}/{unit}.d"), ignore_errors=True)
        systemctl("daemon-reload", check=False)
        compat = compat_path(cfg)
        if compat.is_symlink():
            compat.unlink()
        elif compat.is_dir():
            shutil.rmtree(compat)
        shutil.rmtree(P(AQ), ignore_errors=True)
        for f in [P(VPN_HELPER)] + sorted(P("/etc/sudoers.d").glob("hermes*")):
            with contextlib.suppress(FileNotFoundError):
                f.unlink()
        if args.purge_data:
            step("Deleting data")
            if P(cfg["SUPABASE_DIR"]).is_dir():
                run(["docker", "compose", "down", "-v"], check=False, cwd=P(cfg["SUPABASE_DIR"]))
            for d in data:
                shutil.rmtree(P(d), ignore_errors=True)
        audit("uninstall" + (" --purge-data" if args.purge_data else ""))
        with contextlib.suppress(FileNotFoundError):
            P(SELF_INSTALL).unlink()
    say("\nAquarium is removed. Docker, Node, Caddy and the hermes account were left installed.")
    say(f"Backups and the key are in {cfg['BACKUP_DIR']}.")
    return 0


# --------------------------------------------------------------------------- main


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="aquarium", description="Aquarium server admin (run as root).")
    sub = ap.add_subparsers(dest="command", required=True)
    p = sub.add_parser("status", help="installed version, services, last backup")
    p.add_argument("--offline", action="store_true", help="don't ask GitHub for the latest version")
    p = sub.add_parser("update", help="install a newer verified release, roll back on failure")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--version")
    g.add_argument("--channel", choices=["stable", "beta"])
    p.add_argument("--force", action="store_true", help="reinstall even if already on that version")
    p.add_argument("--no-backup", action="store_true", help=argparse.SUPPRESS)
    p = sub.add_parser("backup", help="encrypted backup of database, data folders and settings")
    p.add_argument("--to", help="folder to write to (default /var/backups/aquarium)")
    p.add_argument("--label", default="manual")
    p = sub.add_parser("restore", help="put a backup back (or --test it without changing anything)")
    p.add_argument("file")
    p.add_argument("--test", action="store_true", help="check the backup opens and restores into a scratch database")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--key-file")
    p.add_argument("--no-safety-backup", action="store_true")
    p = sub.add_parser("offsite", help="encrypted copies in S3-compatible storage (set up in Get ready)")
    p.add_argument("verb", choices=["status", "configure", "test", "run", "restore-test", "remove"])
    p.add_argument("--foreground", action="store_true", help=argparse.SUPPRESS)
    p = sub.add_parser("doctor", help="check everything and say how to fix what fails")
    p.add_argument("--json", action="store_true", help="print the results as one JSON line")
    p = sub.add_parser("logs", help="service logs")
    p.add_argument("service", nargs="?")
    p.add_argument("-n", "--lines", type=int, default=200)
    p.add_argument("-f", "--follow", action="store_true")
    p = sub.add_parser("migrate-layout", help="move a git-checkout install to the release layout (once)")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--yes", action="store_true")
    g.add_argument("--undo", action="store_true")
    p = sub.add_parser("uninstall", help="remove Aquarium (keeps data unless --purge-data)")
    p.add_argument("--yes", action="store_true")
    p.add_argument("--purge-data", action="store_true")
    p.add_argument("--no-backup", action="store_true")
    return ap


COMMANDS = {"status": cmd_status, "update": cmd_update, "backup": cmd_backup, "restore": cmd_restore,
            "doctor": cmd_doctor, "logs": cmd_logs, "migrate-layout": cmd_migrate_layout,
            "uninstall": cmd_uninstall, "offsite": cmd_offsite}


def main(argv: Optional[List[str]] = None) -> int:
    args = parser().parse_args(argv)
    if os.geteuid() != 0 and not test_mode():  # windows-footgun: ok — POSIX-only root admin tooling
        say("aquarium must run as root: sudo aquarium " + " ".join(sys.argv[1:]))
        return 2
    os.umask(0o022)
    try:
        return COMMANDS[args.command](args, load_config())
    except Fail as error:
        say(f"\nERROR: {error}")
        if error.fix:
            say(f"What to do: {error.fix}")
        return 1
    except KeyboardInterrupt:
        say("\nInterrupted.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
