"""deploy/aquarium.py — the root `aquarium` admin command, against a fake box.

Every absolute path goes under a temp "fake root" (AQUARIUM_TEST_PREFIX). The
system tools it drives (systemctl, docker, cosign, journalctl, tail) are small
fakes on PATH that log their arguments; gpg, git and tar are real, so backups
are really encrypted and really restored. Releases come from a local HTTP
server that mimics the GitHub Releases API and also answers the health URLs.
"""

from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "deploy" / "aquarium.py"
INSTALLER = REPO / "install-aquarium.sh"


def _load():
    spec = importlib.util.spec_from_file_location("aquarium_cli", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


aq = _load()

# systemctl here is the fake on PATH (it never reaches the real systemd), but the
# conftest guard matches on the command text, so opt out for this module.
pytestmark = pytest.mark.live_system_guard_bypass

FAKE_SYSTEMCTL = r'''#!PY
import fnmatch, json, os, sys
root = os.environ["AQUARIUM_TEST_PREFIX"]
with open(os.environ["FAKE_CALLS"], "a") as fh:
    fh.write("systemctl " + " ".join(sys.argv[1:]) + "\n")
state = json.load(open(os.environ["FAKE_STATE"]))
args = [a for a in sys.argv[1:]]
if args[0] == "list-unit-files":
    for unit in state["enabled"]:
        if fnmatch.fnmatch(unit, args[1]):
            print(unit + " enabled enabled")
    sys.exit(0)
if args[0] == "list-units":
    for unit in state.get("instances", []):
        if fnmatch.fnmatch(unit, args[1]):
            print(unit + " loaded active running bridge")
    sys.exit(0)
if args[0] == "is-active":
    unit = args[-1]
    try:
        cur = os.path.basename(os.readlink(root + "/opt/aquarium/current"))
    except OSError:
        cur = "git"
    broken = os.environ.get("FAKE_BROKEN", "")
    down = (broken and cur.startswith(broken)) or unit in state.get("down", [])
    if "-q" not in args:
        print("failed" if down else "active")
    sys.exit(3 if down else 0)
sys.exit(0)
'''

FAKE_DOCKER = r'''#!PY
import os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_CALLS"], "a") as fh:
    fh.write("docker " + " ".join(a if len(a) < 80 else a[:20] + "..." for a in args) + "\n")
if args[0] == "inspect":
    print("true" if os.environ.get("FAKE_DB", "1") == "1" else "false"); sys.exit(0)
if args[0] == "ps":
    if "{{.Names}}" in args and "health=unhealthy" not in " ".join(args):
        print("supabase-db\nsupabase-kong")
    sys.exit(0)
if args[0] == "exec":
    rest = args[1:]
    if rest[0] == "-i":
        rest = rest[1:]
    tool = rest[1]
    if tool == "pg_isready":
        sys.exit(0)
    if tool == "pg_dump":
        sys.stdout.buffer.write(open(os.environ["FAKE_DUMP"], "rb").read()); sys.exit(0)
    if tool == "pg_dumpall":
        print("-- globals"); sys.exit(0)
    if tool == "pg_restore":
        data = sys.stdin.buffer.read()
        with open(os.environ["FAKE_CALLS"], "a") as fh:
            fh.write("pg_restore-input " + hashlib_hex(data) if False else "pg_restore-input %d\n" % len(data))
        sys.exit(0)
    if tool == "psql":
        sql = rest[-1]
        if "query_to_xml" in sql:
            print(open(os.environ["FAKE_COUNTS"]).read().strip())
        sys.exit(0)
sys.exit(0)
'''

FAKE_LOGGER = r'''#!PY
import os, sys
with open(os.environ["FAKE_CALLS"], "a") as fh:
    fh.write(os.path.basename(sys.argv[0]) + " " + " ".join(sys.argv[1:]) + "\n")
sys.exit(int(os.environ.get("FAKE_" + os.path.basename(sys.argv[0]).upper() + "_EXIT", "0")))
'''

# The release's own python: answers the probe calls the admin command makes.
FAKE_RELEASE_PYTHON = r'''#!/bin/sh
case "$*" in
  *"aquarium_probe migrate"*)
    [ -f "$HERMES_HOME/FAIL_MIGRATE" ] && { echo '{"check":"database","status":"fail","message":"boom"}'; exit 1; }
    echo "migrated: true" >> "$HERMES_HOME/config.yaml"
    echo '{"check":"database","status":"ok","message":"database schema and roles are up to date"}' ;;
  *"aquarium_probe model-key"*)
    echo '{"check":"model key","status":"ok","message":"openrouter accepts the API key"}' ;;
  *"aquarium_probe google"*)
    echo '{"check":"google","status":"ok","message":"no Google account connected (nothing to check)"}' ;;
esac
'''


class Handler(BaseHTTPRequestHandler):
    routes: dict = {}

    def log_message(self, *a):
        pass

    def _answer(self):
        path = self.path
        if path in self.routes:
            code, body = self.routes[path]
        else:
            code, body = 404, b"{}"
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        if code == 302:
            self.send_header("Location", "/login")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._answer()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._answer()


class Box:
    """A fake server: root dir, fakes on PATH, GitHub/health HTTP server."""

    def __init__(self, tmp: Path, monkeypatch, server):
        self.tmp, self.server, self.mp = tmp, server, monkeypatch
        self.root = tmp / "root"
        self.root.mkdir()
        self.bin = tmp / "bin"
        self.bin.mkdir()
        self.calls = tmp / "calls.log"
        self.calls.write_text("")
        self.state_file = tmp / "systemd.json"
        self.units = ["hermes-gateway.service", "hermes-dashboard.service", "hermes-embed.service",
                      "hermes-wa-bridge-personal.service", "app-mcp.service", "agent-home.service"]
        self.set_systemd(down=[])
        for name, text in (("systemctl", FAKE_SYSTEMCTL), ("docker", FAKE_DOCKER), ("cosign", FAKE_LOGGER),
                           ("journalctl", FAKE_LOGGER), ("tail", FAKE_LOGGER)):
            f = self.bin / name
            f.write_text(text.replace("#!PY", "#!" + sys.executable))
            f.chmod(0o755)
        (tmp / "dump").write_bytes(b"PGDMP fake dump")
        self.counts = tmp / "counts"
        self.counts.write_text("app_prod.notes|3\nauth.users|1")
        port = server.server_address[1]
        self.url = f"http://127.0.0.1:{port}"
        for k, v in {
            "AQUARIUM_TEST_PREFIX": str(self.root), "FAKE_CALLS": str(self.calls),
            "FAKE_STATE": str(self.state_file), "FAKE_DUMP": str(tmp / "dump"), "FAKE_COUNTS": str(self.counts),
            "PATH": f"{self.bin}:/usr/bin:/bin",
        }.items():
            monkeypatch.setenv(k, v)
        for k in ("FAKE_BROKEN", "FAKE_MIGRATE_FAIL", "FAKE_DB", "FAKE_COSIGN_EXIT"):
            monkeypatch.delenv(k, raising=False)
        Handler.routes = {
            "/login": (200, b"ok"), "/": (302, b""), "/embed": (200, b"{}"),
            "/bridge/health": (200, {"status": "connected"}),
        }
        self.releases: list = []
        self.write("/etc/aquarium/aquarium.conf", "\n".join([
            f"RELEASE_API={self.url}/api", f"DASHBOARD_URL={self.url}/", f"AGENT_HOME_URL={self.url}/login",
            f"EMBED_URL={self.url}/embed", "HEALTH_WAIT_SECONDS=0.5", "RESTART_SETTLE_SECONDS=0",
            f"SERVICE_USER={os.environ.get('USER', 'root')}",
        ]) + "\n")
        self.write_units()
        self.write("/etc/aquarium/hermes.env",
                   "DATABASE_URL=postgresql://postgres:TOPSECRETPW@127.0.0.1:5432/postgres\n"
                   "HERMES_HOME=/opt/data/hermes-home\n", mode=0o600)
        self.write("/opt/data/hermes-home/config.yaml", "model: x\n")
        self.write("/opt/data/hermes-home/.env", "OPENROUTER_API_KEY=sk-or-SECRET\n", mode=0o600)
        self.write("/opt/data/hermes-home/whatsapp/session-personal/creds.json", '{"me": "phone"}')
        db = sqlite3.connect(self.p("/opt/data/hermes-home/state.db"))
        db.execute("create table t(x)")
        db.execute("insert into t values (42)")
        db.commit()
        db.close()

    # helpers
    def p(self, path: str) -> Path:
        return Path(str(self.root) + path)

    def write(self, path: str, text: str, mode: int = 0o644) -> Path:
        f = self.p(path)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        f.chmod(mode)
        return f

    def set_systemd(self, down, instances=()):
        self.state_file.write_text(json.dumps({"enabled": self.units, "down": down, "instances": list(instances)}))

    def write_units(self, env_for_agent_home="/etc/aquarium/agent-home.env"):
        for unit in self.units:
            body = "[Service]\nEnvironmentFile=/etc/aquarium/hermes.env\nEnvironmentFile=-/opt/data/hermes-home/.env\n"
            if unit == "agent-home.service":
                body = f"[Service]\nEnvironmentFile={env_for_agent_home}\n"
            if unit == "app-mcp.service":
                body = "[Service]\nEnvironmentFile=/opt/data/hermes-agent/app-mcp/app-mcp.env\n"
            if unit.startswith("hermes-wa-bridge"):
                port = self.server.server_address[1]
                body = (f"[Service]\nExecStart=/usr/bin/node bridge.js --port {port} --session "
                        "/opt/data/hermes-home/whatsapp/session-personal\n"
                        "StandardOutput=append:/var/log/hermes-wa-bridge-personal.log\n")
            self.write(f"/etc/systemd/system/{unit}", body)

    def make_release(self, version: str, *, extra: dict | None = None, prerelease=False, draft=False,
                     tamper=False, cli_text="# new aquarium\n"):
        files = {
            "pyproject.toml": "[project]\nname='hermes-agent'\n",
            ".venv/bin/python": FAKE_RELEASE_PYTHON,
            "node_modules/.keep": "",
            "agent-home/.next/BUILD_ID": "build",
            "hermes_cli/web_dist/index.html": "<html>",
            "deploy/aquarium.py": cli_text,
            "deploy/hermes-vpn-helper": "#!/usr/bin/python3\n# helper " + version + "\n",
            "VERSION": version,
        }
        files.update(extra or {})
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for name, text in files.items():
                data = text.encode()
                info = tarfile.TarInfo(f"aquarium-{version}/{name}" if not name.startswith("..") else name)
                info.size = len(data)
                info.mode = 0o755 if name.endswith("python") else 0o644
                tar.addfile(info, io.BytesIO(data))
        tarball = buf.getvalue()
        name = f"aquarium-{version}-linux-x86_64.tar.gz"
        digest = hashlib.sha256(b"tampered" if tamper else tarball).hexdigest()
        assets = {name: tarball, "SHA256SUMS": f"{digest}  {name}\n".encode(),
                  "SHA256SUMS.sig": b"sig", "SHA256SUMS.pem": b"pem"}
        rel = {"tag_name": version, "prerelease": prerelease, "draft": draft, "assets": []}
        for n, data in assets.items():
            Handler.routes[f"/assets/{version}/{n}"] = (200, data)
            rel["assets"].append({"name": n, "browser_download_url": f"{self.url}/assets/{version}/{n}"})
        self.releases.append(rel)
        Handler.routes["/api/releases?per_page=100"] = (200, self.releases)
        Handler.routes[f"/api/releases/tags/{version}"] = (200, rel)
        return rel

    def install_release(self, version: str):
        """A box already on the release layout at ``version``."""
        rel = self.p(f"/opt/aquarium/releases/{version}")
        (rel / ".venv/bin").mkdir(parents=True)
        (rel / ".venv/bin/python").write_text(FAKE_RELEASE_PYTHON)
        (rel / ".venv/bin/python").chmod(0o755)
        (rel / "deploy").mkdir()
        (rel / "deploy/hermes-vpn-helper").write_text("#!/usr/bin/python3\n# helper " + version + "\n")
        (rel / "deploy/aquarium.py").write_text("# old aquarium\n")
        (rel / "app-mcp").mkdir()
        os.symlink(f"releases/{version}", self.p("/opt/aquarium/current"))
        os.symlink(str(self.p("/opt/aquarium/current")), self.p("/opt/data/hermes-agent"))
        # a fresh install writes this env file inside the release (install-aquarium.sh step 8)
        self.write("/opt/data/hermes-agent/app-mcp/app-mcp.env", "APP_MCP_TICKET_SECRET=x\n", mode=0o600)
        self.write("/etc/aquarium/agent-home.env", "PORT=3100\n", mode=0o600)
        self.write("/usr/local/sbin/aquarium", "# old aquarium\n", mode=0o755)

    def run(self, *argv) -> int:
        return aq.main(list(argv))

    def log(self) -> str:
        return self.calls.read_text()


@pytest.fixture(scope="module")
def server():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()


@pytest.fixture
def box(tmp_path, monkeypatch, server):
    b = Box(tmp_path, monkeypatch, server)
    # The bridge unit's --port is the test server; route /health there.
    Handler.routes["/health"] = Handler.routes["/bridge/health"]
    return b


def released_box(box):
    box.install_release("v1.0.0")
    box.make_release("v1.0.0")
    box.make_release("v1.1.0")
    box.make_release("v1.2.0-beta.1", prerelease=True)
    box.make_release("v9.9.9", draft=True)
    return box


# --------------------------------------------------------------------------- basics


def test_refuses_without_root(tmp_path):
    env = {k: v for k, v in os.environ.items() if k != "AQUARIUM_TEST_PREFIX"}
    if os.geteuid() == 0:
        pytest.skip("running as root")
    proc = subprocess.run([sys.executable, str(CLI), "status"], capture_output=True, text=True, env=env)
    assert proc.returncode == 2
    assert "must run as root" in proc.stdout


def test_stdlib_only_and_isolated_shebang():
    text = CLI.read_text()
    assert text.startswith("#!/usr/bin/python3 -I\n"), "root must not pick up modules from the cwd or PYTHON* env"
    tree = __import__("ast").parse(text)
    imported = set()
    for node in __import__("ast").walk(tree):
        if isinstance(node, __import__("ast").Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, __import__("ast").ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not imported - set(sys.stdlib_module_names) - {"__future__"}, imported


def test_installer_installs_the_command_root_owned():
    text = INSTALLER.read_text()
    assert "install -m 755 -o root -g root deploy/aquarium.py /usr/local/sbin/aquarium" in text


def test_python_deps_match_the_installer():
    text = INSTALLER.read_text()
    block = text[text.index('log "Python dependencies"'):text.index('log "Node dependencies')]
    extras = block.split('-e ".[', 1)[1].split(']"', 1)[0]
    assert extras == aq.PY_EXTRAS
    pins = [p for p in __import__("re").findall(r'"([^"]+)"|(\S+==\S+)', block.split(']"', 1)[1])]
    found = {a or b for a, b in pins}
    assert set(aq.PY_PINS) <= found, set(aq.PY_PINS) - found


def test_status(box, capsys):
    released_box(box)
    assert box.run("status") == 0
    text = capsys.readouterr().out
    assert "Version:   v1.0.0" in text
    assert "Latest:    v1.1.0  (update available" in text
    assert "app-mcp.service" in text


# --------------------------------------------------------------------------- update


def test_update_installs_verified_stable_release(box, capsys):
    released_box(box)
    box.write("/usr/local/sbin/hermes-vpn-helper", "# helper from long ago\n", mode=0o755)
    assert box.run("update") == 0, capsys.readouterr().out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.1.0"
    rel = box.p("/opt/aquarium/releases/v1.1.0")
    assert (rel / "VERSION").read_text() == "v1.1.0"
    assert not list(box.p("/opt/aquarium/releases").glob(".*partial"))
    log = box.log()
    assert "cosign verify-blob" in log
    assert "--certificate-identity https://github.com/leolau/aquarium/.github/workflows/release.yml@refs/tags/v1.1.0 " in log
    assert "--certificate-oidc-issuer https://token.actions.githubusercontent.com" in log
    # app-mcp restarts on every update, or new MCP tools are never registered.
    assert "systemctl restart app-mcp.service" in log
    assert "systemctl restart agent-home.service" in log
    assert "systemctl restart hermes-gateway.service" in log
    # backup taken before the switch, migration ran, the command refreshed itself
    assert list(box.p("/var/backups/aquarium").glob("aquarium-backup-*-pre-update-v1.1.0.tar.gz.gpg"))
    assert "migrated: true" in box.p("/opt/data/hermes-home/config.yaml").read_text()
    # the env file the installer put inside the old release goes along
    carried = rel / "app-mcp/app-mcp.env"
    assert carried.read_text() == "APP_MCP_TICKET_SECRET=x\n" and carried.stat().st_mode & 0o777 == 0o600
    assert box.p("/usr/local/sbin/aquarium").read_text() == "# new aquarium\n"
    state = json.loads(box.p("/opt/aquarium/state.json").read_text())
    assert state["current"] == "v1.1.0" and state["previous"] == "v1.0.0"
    assert state["history"][-1]["result"] == "ok"
    out = capsys.readouterr().out
    assert "VPN HELPER STALE" in out  # reported, never auto-installed (it runs as root via sudo)
    assert box.p("/usr/local/sbin/hermes-vpn-helper").read_text() == "# helper from long ago\n"
    assert "TOPSECRETPW" not in out


def test_update_beta_channel_and_explicit_version(box, capsys):
    released_box(box)
    assert box.run("update", "--channel", "beta") == 0
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.2.0-beta.1"
    assert box.run("update", "--version", "v1.1.0") == 0
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.1.0"


def test_update_already_current_does_nothing(box, capsys):
    box.install_release("v1.1.0")
    box.make_release("v1.1.0")
    assert box.run("update") == 0
    assert "Already up to date" in capsys.readouterr().out
    assert "restart" not in box.log()


def test_update_rejects_bad_version_text(box, capsys):
    released_box(box)
    assert box.run("update", "--version", "../../etc") == 1
    assert "not a version" in capsys.readouterr().out


def test_bad_checksum_installs_nothing(box, capsys):
    box.install_release("v1.0.0")
    box.make_release("v1.1.0", tamper=True)
    assert box.run("update") == 1
    out = capsys.readouterr().out
    assert "does not match its checksum" in out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"
    assert not box.p("/opt/aquarium/releases/v1.1.0").exists()
    assert "restart" not in box.log()


def test_bad_signature_installs_nothing(box, capsys, monkeypatch):
    box.install_release("v1.0.0")
    box.make_release("v1.1.0")
    monkeypatch.setenv("FAKE_COSIGN_EXIT", "1")
    assert box.run("update") == 1
    assert "signature is NOT valid" in capsys.readouterr().out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"
    assert not box.p("/opt/aquarium/releases/v1.1.0").exists()


def test_missing_cosign_fails_closed(box, capsys):
    box.install_release("v1.0.0")
    box.make_release("v1.1.0")
    (box.bin / "cosign").unlink()
    assert box.run("update") == 1
    assert "cosign is not installed" in capsys.readouterr().out
    assert not box.p("/opt/aquarium/releases/v1.1.0").exists()


def test_failed_health_check_rolls_back(box, capsys, monkeypatch):
    released_box(box)
    monkeypatch.setenv("FAKE_BROKEN", "v1.1.0")  # every service fails while v1.1.0 is current
    assert box.run("update") == 1
    out = capsys.readouterr().out
    assert "rolling back to v1.0.0" in out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"
    # the migrated config.yaml is put back with the code
    assert "migrated" not in box.p("/opt/data/hermes-home/config.yaml").read_text()
    state = json.loads(box.p("/opt/aquarium/state.json").read_text())
    assert state["current"] == "v1.0.0" and state["failed"] == "v1.1.0"
    assert state["history"][-1]["result"] == "rolled back"
    assert box.log().count("systemctl restart app-mcp.service") == 2
    assert box.p("/usr/local/sbin/aquarium").read_text() == "# old aquarium\n"


def test_failed_migration_never_switches(box, capsys, monkeypatch):
    released_box(box)
    box.write("/opt/data/hermes-home/FAIL_MIGRATE", "")
    assert box.run("update") == 1
    assert "migration step failed" in capsys.readouterr().out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"
    assert "restart" not in box.log()


def test_tarball_with_path_traversal_is_refused(box, capsys):
    box.install_release("v1.0.0")
    box.make_release("v1.1.0", extra={"../../evil.txt": "pwned"})
    assert box.run("update") == 1
    assert not (box.p("/opt/aquarium/releases") / ".." / ".." / "evil.txt").exists()
    assert not list(box.root.rglob("evil.txt"))
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"


def test_update_refuses_git_layout(box, capsys):
    box.write("/opt/data/hermes-agent/pyproject.toml", "x")
    assert box.run("update") == 1
    assert "migrate-layout" in capsys.readouterr().out


def test_build_runs_as_service_user_when_release_ships_no_venv(box, monkeypatch, tmp_path):
    rel = tmp_path / "rel"
    rel.mkdir()
    (rel / "package-lock.json").write_text("{}")
    (rel / "agent-home").mkdir()
    calls = []

    def fake_run(argv, **kw):
        calls.append((list(argv), kw.get("as_service")))
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(aq, "run", fake_run)
    aq.build_release(aq.load_config(), rel)
    joined = [" ".join(a) for a, _ in calls]
    assert any(j.startswith("uv venv") for j in joined)
    assert any(j.startswith("uv pip install") and f"{rel}[{aq.PY_EXTRAS}]" in j for j in joined)
    assert any(j == "npm ci --no-audit --no-fund" for j in joined)
    assert any(j == "npm run build --workspace agent-home" for j in joined)
    # third-party install scripts never run as root
    assert all(user == aq.load_config()["SERVICE_USER"] for _, user in calls)


def test_seal_release_drops_group_and_other_write(tmp_path, box):
    rel = tmp_path / "r"
    (rel / "agent-home/.next").mkdir(parents=True)
    f = rel / "code.py"
    f.write_text("x")
    f.chmod(0o666)
    aq.seal_release(aq.load_config(), rel)
    assert f.stat().st_mode & 0o777 == 0o644


# --------------------------------------------------------------------------- backup / restore


def _backup(box) -> Path:
    assert box.run("backup") == 0
    files = sorted(box.p("/var/backups/aquarium").glob("aquarium-backup-*.tar.gz.gpg"))
    assert files
    return files[-1]


def test_backup_is_encrypted_and_complete(box, capsys):
    released_box(box)
    path = _backup(box)
    assert path.stat().st_mode & 0o777 == 0o600
    assert box.p("/var/backups/aquarium").stat().st_mode & 0o777 == 0o700
    key = box.p("/etc/aquarium/backup.key")
    assert key.stat().st_mode & 0o777 == 0o600
    raw = path.read_bytes()
    assert b"TOPSECRETPW" not in raw and b"sk-or-SECRET" not in raw
    out = capsys.readouterr().out
    assert "copy this file somewhere safe" in out
    dest = box.tmp / "opened"
    dest.mkdir()
    manifest = aq.open_backup(path, key, dest)
    files = manifest["files"]
    assert "db/postgres.dump" in files and "db/globals.sql" in files
    assert "root/etc/aquarium/hermes.env" in files
    assert "root/opt/data/hermes-home/.env" in files
    assert "root/opt/data/hermes-home/whatsapp/session-personal/creds.json" in files
    assert "root/etc/systemd/system/app-mcp.service" in files
    assert manifest["db"]["tables"] == {"app_prod.notes": 3, "auth.users": 1}
    assert manifest["release"] == "v1.0.0"
    # the live SQLite database is copied consistently and opens
    db = sqlite3.connect(dest / "root/opt/data/hermes-home/state.db")
    assert db.execute("select x from t").fetchone() == (42,)


def test_backup_without_database_still_backs_up_files(box, monkeypatch):
    released_box(box)
    monkeypatch.setenv("FAKE_DB", "0")
    path = _backup(box)
    dest = box.tmp / "o"
    dest.mkdir()
    manifest = aq.open_backup(path, box.p("/etc/aquarium/backup.key"), dest)
    assert manifest["db"] is None and "root/etc/aquarium/hermes.env" in manifest["files"]


def test_backup_keeps_only_the_newest(box, monkeypatch):
    released_box(box)
    box.write("/etc/aquarium/aquarium.conf", box.p("/etc/aquarium/aquarium.conf").read_text() + "BACKUP_KEEP=2\n")
    for i in range(3):
        monkeypatch.setattr(aq, "utcnow", lambda i=i: f"2026101{i}T000000Z")
        _backup(box)
    assert len(list(box.p("/var/backups/aquarium").glob("*.gpg"))) == 2


def test_restore_test_passes_and_changes_nothing(box, capsys):
    released_box(box)
    path = _backup(box)
    before = box.log()
    assert box.run("restore", str(path), "--test") == 0
    out = capsys.readouterr().out
    assert "Restore test passed" in out
    new = box.log()[len(before):]
    assert "CREATE DATABASE aquarium_restore_test" in new and "DROP DATABASE IF EXISTS aquarium_restore_test" in new
    assert "pg_restore -U supabase_admin -d aquarium_restore_test" in new
    assert "systemctl stop" not in new and "systemctl restart" not in new


def test_restore_test_catches_row_count_mismatch(box, capsys):
    released_box(box)
    path = _backup(box)
    box.counts.write_text("app_prod.notes|2\nauth.users|1")
    assert box.run("restore", str(path), "--test") == 1
    assert "row count differs: app_prod.notes" in capsys.readouterr().out


def test_damaged_or_wrong_key_backup_is_refused(box, capsys):
    released_box(box)
    path = _backup(box)
    data = bytearray(path.read_bytes())
    data[len(data) // 2] ^= 0xFF
    bad = box.tmp / "bad.gpg"
    bad.write_bytes(bytes(data))
    assert box.run("restore", str(bad), "--test") == 1
    wrong = box.tmp / "wrong.key"
    wrong.write_text("not the key\n")
    assert box.run("restore", str(path), "--test", "--key-file", str(wrong)) == 1
    assert "Wrong backup key" in capsys.readouterr().out


def test_restore_without_yes_changes_nothing(box, capsys):
    released_box(box)
    path = _backup(box)
    box.write("/opt/data/hermes-home/config.yaml", "changed\n")
    assert box.run("restore", str(path)) == 0
    assert "Re-run with --yes" in capsys.readouterr().out
    assert box.p("/opt/data/hermes-home/config.yaml").read_text() == "changed\n"


def test_restore_puts_data_back_and_keeps_the_replaced_copy(box, capsys):
    released_box(box)
    path = _backup(box)
    box.write("/opt/data/hermes-home/config.yaml", "changed after backup\n")
    box.write("/etc/aquarium/hermes.env", "BROKEN=1\n")
    before = box.log()
    assert box.run("restore", str(path), "--yes") == 0, capsys.readouterr().out
    assert box.p("/opt/data/hermes-home/config.yaml").read_text() == "model: x\n"
    assert "TOPSECRETPW" in box.p("/etc/aquarium/hermes.env").read_text()
    aside = list(box.p("/opt/data").glob("hermes-home.pre-restore-*"))
    assert aside and (aside[0] / "config.yaml").read_text() == "changed after backup\n"
    new = box.log()[len(before):]
    assert "systemctl stop app-mcp.service" in new
    assert "docker stop supabase-kong" in new and "docker start supabase-kong" in new
    assert "pg_restore -U supabase_admin -d postgres --clean --if-exists" in new
    assert "pg_restore-input 15" in new  # the dump bytes went in
    assert "systemctl restart app-mcp.service" in new
    # a safety backup of the pre-restore state exists
    assert list(box.p("/var/backups/aquarium").glob("*-pre-restore.tar.gz.gpg"))


# --------------------------------------------------------------------------- doctor


def test_doctor_all_good(box, capsys):
    released_box(box)
    (box.p("/opt/aquarium/releases/v1.0.0/deploy/aquarium.py")).write_text("# old aquarium\n")
    _backup(box)
    capsys.readouterr()
    code = box.run("doctor")
    out = capsys.readouterr().out
    assert code == 0, out
    for text in ("disk /", "layout: release", "service app-mcp.service: active", "database: accepting connections",
                 "agent-home: HTTP 200", "dashboard API: HTTP 302", "embedding service: HTTP 200",
                 "model key: openrouter accepts the API key", "google:", "WhatsApp personal: paired and connected",
                 "VPN helper: not installed", "WhatsApp bridge helper: not installed", "backups: newest is 0 days old"):
        assert text in out, text
    assert "TOPSECRETPW" not in out and "sk-or-SECRET" not in out


def test_doctor_json_is_one_line_with_every_row(box, capsys):
    released_box(box)
    box.set_systemd(down=["hermes-gateway.service"])
    capsys.readouterr()
    code = box.run("doctor", "--json")
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    assert code == 1
    data = json.loads(lines[-1])
    assert data["failed"] >= 1 and len(data["rows"]) >= 5
    row = next(r for r in data["rows"] if r["text"] == "service hermes-gateway.service: failed")
    assert row["status"] == "fail" and "aquarium logs hermes-gateway.service" in row["fix"]
    assert all(r["fix"] == "" for r in data["rows"] if r["status"] == "ok")
    assert "TOPSECRETPW" not in lines[-1] and "problem(s)" not in "\n".join(lines)


def test_doctor_explains_each_failure(box, capsys):
    released_box(box)
    box.set_systemd(down=["hermes-gateway.service"])
    Handler.routes["/health"] = (200, {"status": "disconnected"})
    Handler.routes["/login"] = (500, b"")
    box.write("/usr/local/sbin/hermes-vpn-helper", "# old helper\n", mode=0o755)
    box.write("/etc/aquarium/agent-home.env", "PORT=3100\n", mode=0o644)
    code = box.run("doctor")
    out = capsys.readouterr().out
    assert code == 1
    assert "FAIL  service hermes-gateway.service: failed" in out
    assert "Fix: See why: `aquarium logs hermes-gateway.service`" in out
    assert "FAIL  WhatsApp personal: disconnected (phone not linked)" in out
    assert "scan the QR code" in out
    assert "FAIL  VPN helper: older than the installed Aquarium version" in out
    assert "install -m 755 -o root -g root /opt/aquarium/releases/v1.0.0/deploy/hermes-vpn-helper /usr/local/sbin/hermes-vpn-helper" in out
    assert "FAIL  agent-home: HTTP 500" in out
    assert "settings file /etc/aquarium/agent-home.env is readable by others" in out
    assert "WARN  backups: none yet" in out


def test_doctor_cert_check_reports_unreachable_tls(box, capsys, monkeypatch):
    released_box(box)
    box.write("/etc/caddy/Caddyfile", "home.example.com {\n  reverse_proxy 127.0.0.1:3100\n}\n")
    monkeypatch.setattr(aq, "cert_days_left", lambda d: (_ for _ in ()).throw(ConnectionRefusedError()))
    rows = aq.check_certs(aq.load_config())
    assert rows[0][0] == "fail" and "home.example.com" in rows[0][1] and "DNS" in rows[0][2]
    monkeypatch.setattr(aq, "cert_days_left", lambda d: 3.0)
    assert aq.check_certs(aq.load_config())[0][0] == "fail"
    monkeypatch.setattr(aq, "cert_days_left", lambda d: 60.0)
    assert aq.check_certs(aq.load_config())[0][0] == "ok"


# --------------------------------------------------------------------------- logs


def test_logs(box, capsys):
    released_box(box)
    assert box.run("logs", "gateway", "-n", "50") == 0
    assert "journalctl -u hermes-gateway.service -n 50 --no-pager" in box.log()
    assert box.run("logs", "personal") == 0  # the bridge logs to a file, not the journal
    assert "tail -n 200 /var/log/hermes-wa-bridge-personal.log" in box.log()
    assert box.run("logs") == 0
    assert "-u app-mcp.service" in box.log()
    assert box.run("logs", "../../etc/shadow") == 1
    assert "unknown service" in capsys.readouterr().out


# --------------------------------------------------------------------------- migrate-layout


def git_box(box):
    """The current production layout: a git checkout with env files inside it."""
    ck = box.p("/opt/data/hermes-agent")
    ck.mkdir(parents=True)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    (ck / "pyproject.toml").write_text("[project]\n")
    (ck / ".gitignore").write_text("*.env\n.venv/\n.next/\n")
    (ck / "deploy").mkdir()
    (ck / "deploy/hermes-vpn-helper").write_text("helper\n")
    (ck / "app-mcp").mkdir()
    subprocess.run(["git", "init", "-q", str(ck)], check=True, env=env)
    subprocess.run(["git", "-C", str(ck), "add", "-A"], check=True, env=env)
    subprocess.run(["git", "-C", str(ck), "commit", "-qm", "init"], check=True, env=env)
    (ck / "app-mcp/app-mcp.env").write_text("APP_MCP_TICKET_SECRET=abc\n")
    (ck / "agent-home/.next").mkdir(parents=True)
    (ck / "agent-home/agent-home.env").write_text("AGENT_HOME_SESSION_SECRET=s3cret\n")
    (ck / ".venv/bin").mkdir(parents=True)
    (ck / ".venv/bin/python").write_text(FAKE_RELEASE_PYTHON)
    (ck / ".venv/bin/python").chmod(0o755)
    box.write_units(env_for_agent_home="/opt/data/hermes-agent/agent-home/agent-home.env")
    box.p("/etc/aquarium/agent-home.env").unlink(missing_ok=True)
    sha = subprocess.run(["git", "-C", str(ck), "rev-parse", "--short=12", "HEAD"], capture_output=True,
                         text=True, check=True).stdout.strip()
    return ck, f"git-{sha}"


def test_migrate_layout_dry_run_changes_nothing(box, capsys):
    ck, label = git_box(box)
    assert box.run("migrate-layout", "--dry-run") == 0
    out = capsys.readouterr().out
    assert f"/opt/aquarium/releases/{label}" in out
    assert "/opt/data/hermes-agent/agent-home/agent-home.env -> /etc/aquarium/agent-home.env" in out
    assert "/opt/data/hermes-agent/app-mcp/app-mcp.env -> /etc/aquarium/app-mcp.env" in out
    assert "/etc/systemd/system/agent-home.service.d/99-aquarium-env.conf" in out
    assert "Dry run: nothing changed" in out
    assert ck.is_dir() and not ck.is_symlink()
    assert not box.p("/opt/aquarium").exists()
    assert "restart" not in box.log()
    assert box.run("migrate-layout") == 0  # without --yes it is also only a plan
    assert not ck.is_symlink()


def test_migrate_layout_apply_and_undo(box, capsys):
    ck, label = git_box(box)
    assert box.run("migrate-layout", "--yes") == 0, capsys.readouterr().out
    rel = box.p(f"/opt/aquarium/releases/{label}")
    assert ck.is_symlink() and os.readlink(ck) == str(box.p("/opt/aquarium/current"))
    assert os.readlink(box.p("/opt/aquarium/current")) == f"releases/{label}"
    assert (rel / "pyproject.toml").exists() and (rel / ".venv/bin/python").exists()
    assert not (rel / ".git").exists()
    assert not (rel / "agent-home/agent-home.env").exists(), "secrets must not stay in the code tree"
    moved = box.p("/etc/aquarium/agent-home.env")
    assert moved.read_text() == "AGENT_HOME_SESSION_SECRET=s3cret\n"
    assert moved.stat().st_mode & 0o777 == 0o600
    dropin = box.p("/etc/systemd/system/agent-home.service.d/99-aquarium-env.conf").read_text()
    assert "EnvironmentFile=\nEnvironmentFile=/etc/aquarium/agent-home.env\n" in dropin
    gw = box.p("/etc/systemd/system/hermes-gateway.service.d/99-aquarium-env.conf")
    assert not gw.exists(), "units already reading /etc/aquarium need no drop-in"
    assert aq.unit_env_files("app-mcp.service") == ["/etc/aquarium/app-mcp.env"]
    old = list(box.p("/opt/data").glob("hermes-agent.pre-release-*"))
    assert old and (old[0] / ".git").is_dir()
    assert "systemctl restart app-mcp.service" in box.log()
    assert list(box.p("/var/backups/aquarium").glob("*-pre-migrate-layout.tar.gz.gpg"))
    # now updates work from here
    assert aq.layout(aq.load_config()) == "release"

    assert box.run("migrate-layout", "--undo") == 0
    assert ck.is_dir() and not ck.is_symlink() and (ck / ".git").is_dir()
    assert (ck / "agent-home/agent-home.env").exists()
    assert not box.p("/etc/systemd/system/agent-home.service.d/99-aquarium-env.conf").exists()
    assert not box.p("/etc/aquarium/agent-home.env").exists()
    assert not rel.exists() and not box.p("/opt/aquarium/current").exists()


def test_migrate_layout_undoes_itself_when_health_check_fails(box, capsys, monkeypatch):
    ck, label = git_box(box)
    monkeypatch.setenv("FAKE_BROKEN", "git-")
    assert box.run("migrate-layout", "--yes") == 1
    out = capsys.readouterr().out
    assert "everything was put back as it was" in out
    assert ck.is_dir() and not ck.is_symlink() and (ck / "agent-home/agent-home.env").exists()
    assert not box.p("/etc/systemd/system/agent-home.service.d/99-aquarium-env.conf").exists()
    assert not box.p(f"/opt/aquarium/releases/{label}").exists()
    assert not list(box.p("/opt/data").glob("hermes-agent.pre-release-*"))


def test_migrate_layout_refuses_when_already_migrated(box, capsys):
    released_box(box)
    assert box.run("migrate-layout", "--dry-run") == 1
    assert "already on the release layout" in capsys.readouterr().out


# --------------------------------------------------------------------------- uninstall


def test_uninstall_needs_yes_and_keeps_data(box, capsys):
    released_box(box)
    assert box.run("uninstall") == 0
    assert box.p("/opt/aquarium/current").exists()
    assert box.run("uninstall", "--yes") == 0
    assert not box.p("/opt/aquarium").exists() and not box.p("/opt/data/hermes-agent").exists()
    assert not box.p("/etc/systemd/system/app-mcp.service").exists()
    assert "systemctl disable --now app-mcp.service" in box.log()
    assert box.p("/opt/data/hermes-home/config.yaml").exists(), "data stays unless --purge-data"
    assert list(box.p("/var/backups/aquarium").glob("*-pre-uninstall.tar.gz.gpg"))
    assert box.p("/var/backups/aquarium/backup.key").exists()
    assert "docker compose down" not in box.log()


def test_uninstall_purge_data(box, capsys):
    released_box(box)
    box.p("/opt/data/supabase/docker").mkdir(parents=True)
    assert box.run("uninstall", "--yes", "--purge-data") == 0
    assert not box.p("/opt/data/hermes-home").exists()
    assert not box.p("/opt/data/supabase").exists()
    assert "docker compose down -v" in box.log()
    assert list(box.p("/var/backups/aquarium").glob("*.gpg")), "backups always survive"


def test_pinned_cosign_from_the_installer_is_used(box, capsys):
    released_box(box)
    (box.bin / "cosign").rename(box.tmp / "cosign-real")
    pinned = box.p("/usr/local/lib/aquarium/cosign-v2.6.5")
    pinned.parent.mkdir(parents=True)
    os.symlink(box.tmp / "cosign-real", pinned)
    assert box.run("update") == 0
    assert "cosign-v2.6.5 verify-blob" in box.log()


def test_template_bridge_instances_are_restarted_and_checked(box, capsys):
    released_box(box)
    port = box.server.server_address[1]
    box.write("/etc/systemd/system/hermes-wa-bridge@.service", (REPO / "deploy/hermes-wa-bridge@.service").read_text())
    box.write("/etc/aquarium/wa-bridge-shop.env", f"WA_BRIDGE_PORT={port}\n", mode=0o600)
    box.set_systemd(down=[], instances=["hermes-wa-bridge@shop.service"])
    assert aq.unit_port("hermes-wa-bridge@shop.service") == port
    assert "hermes-wa-bridge@shop.service" in aq.service_units()
    rows = aq.check_whatsapp(aq.load_config())
    assert (aq.OK, "WhatsApp shop: paired and connected", "") in rows
    assert box.run("update") == 0
    assert "systemctl restart hermes-wa-bridge@shop.service" in box.log()


def test_stale_whatsapp_bridge_helper_is_reported(box, capsys):
    released_box(box)
    box.p("/opt/aquarium/releases/v1.0.0/deploy/hermes-wa-bridge-add").write_text("new\n")
    box.write("/usr/local/sbin/hermes-wa-bridge-add", "old\n", mode=0o755)
    rows = aq.check_vpn(aq.load_config())
    assert any(r[0] == aq.FAILED and "WhatsApp bridge helper" in r[1] and "hermes-wa-bridge-add" in r[2] for r in rows)


def test_unit_already_down_before_update_does_not_force_a_rollback(box, capsys):
    released_box(box)
    box.set_systemd(down=["hermes-embed.service"])  # e.g. a unit that was failing before
    assert box.run("update") == 0, capsys.readouterr().out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.1.0"


def test_migrate_layout_leaves_env_files_outside_the_checkout_alone(box, capsys):
    ck, label = git_box(box)
    staging = box.write("/opt/data/hermes-staging.env", "DATABASE_URL=x\n", mode=0o640)
    box.write("/etc/systemd/system/hermes-dashboard.service",
              "[Service]\nEnvironmentFile=/opt/data/hermes-staging.env\n")
    box.write("/etc/systemd/system/hermes-dashboard.service.d/10-unprivileged.conf", "[Service]\nUser=hermes\n")
    assert box.run("migrate-layout", "--yes") == 0, capsys.readouterr().out
    assert staging.read_text() == "DATABASE_URL=x\n" and staging.stat().st_mode & 0o777 == 0o640
    assert not box.p("/etc/aquarium/hermes-staging.env").exists()
    assert not box.p("/etc/systemd/system/hermes-dashboard.service.d/99-aquarium-env.conf").exists()
    assert aq.unit_env_files("hermes-dashboard.service") == ["/opt/data/hermes-staging.env"]
    assert aq.unit_env_files("agent-home.service") == ["/etc/aquarium/agent-home.env"]


def test_backup_covers_data_root_env_files_and_timer_units(box):
    released_box(box)
    box.write("/opt/data/hermes-messaging.env", "TELEGRAM_BOT_TOKEN=t\n", mode=0o640)
    box.write("/opt/data/deploy/backup-recipient.env", "R=x\n", mode=0o600)
    box.write("/etc/systemd/system/hermes-secret-backup.service",
              "[Service]\nEnvironmentFile=/opt/data/deploy/backup-recipient.env\n")
    box.write("/etc/systemd/system/hermes-drift-check.timer", "[Timer]\n")
    path = _backup(box)
    dest = box.tmp / "o"
    dest.mkdir()
    files = aq.open_backup(path, box.p("/etc/aquarium/backup.key"), dest)["files"]
    for name in ("root/opt/data/hermes-messaging.env", "root/opt/data/deploy/backup-recipient.env",
                 "root/etc/systemd/system/hermes-secret-backup.service",
                 "root/etc/systemd/system/hermes-drift-check.timer"):
        assert name in files, name


def test_old_deploy_script_refuses_a_release_install(tmp_path):
    text = (REPO / "deploy/hermes-deploy.sh").read_text()
    guard = text[text.index('if [ -L "$REPO" ]'):text.index('cd "$REPO"')]
    (tmp_path / "rel").mkdir()
    os.symlink(tmp_path / "rel", tmp_path / "link")
    proc = subprocess.run(["bash", "-c", f'REPO={tmp_path}/link\n{guard}\necho reached'],
                          capture_output=True, text=True)
    assert proc.returncode == 1 and "sudo aquarium update" in proc.stderr and "reached" not in proc.stdout
    proc = subprocess.run(["bash", "-c", f'REPO={tmp_path}/rel\n{guard}\necho reached'],
                          capture_output=True, text=True)
    assert proc.returncode == 0 and "reached" in proc.stdout


def test_migrate_probe_gets_the_owner_address_on_stdin(box, monkeypatch, tmp_path):
    rel = tmp_path / "rel"
    (rel / ".venv/bin").mkdir(parents=True)
    (rel / ".venv/bin/python").write_text("")
    calls = []

    def fake_run(argv, **kw):
        calls.append((list(argv), kw.get("input")))
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr(aq, "run", fake_run)
    cfg = aq.load_config()
    aq.run_probe(cfg, rel, "migrate")
    assert calls[-1][0][-1] == "migrate" and calls[-1][1] is None
    admin = aq.P(f"{aq.ETC}/db-admin.env")
    admin.parent.mkdir(parents=True, exist_ok=True)
    admin.write_text("HERMES_DB_ADMIN_URL=postgresql://owner@db/x\n")
    aq.run_probe(cfg, rel, "migrate")
    assert calls[-1][0][-2:] == ["migrate", "--dsn-stdin"]
    assert calls[-1][1] == b"HERMES_DB_ADMIN_URL=postgresql://owner@db/x\n"
    aq.run_probe(cfg, rel, "google")
    assert calls[-1][0][-1] == "google" and calls[-1][1] is None
