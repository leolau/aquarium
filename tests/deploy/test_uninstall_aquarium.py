"""uninstall-aquarium.sh: the reverse of install-aquarium.sh.

The coverage tests read what the installer (and the deploy/ helpers it runs) writes and check that
the uninstaller's own --list covers each item, so adding a new path or unit to the installer without
teaching the uninstaller about it fails here. The behaviour tests run the uninstaller against a fake
root filesystem (AQ_ROOTFS) with stub systemctl/docker/account tools; nothing touches the real host.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
UNINSTALL = REPO / "uninstall-aquarium.sh"
INSTALL = REPO / "install-aquarium.sh"
LIB = REPO / "deploy" / "install" / "lib.sh"
TOOLS_SETUP = REPO / "deploy" / "hermes-tools-setup"
GUIDE = REPO / "docs" / "guides" / "installation-guide.md"
VISUDO = shutil.which("visudo") or ("/usr/sbin/visudo" if Path("/usr/sbin/visudo").exists() else None)
needs_visudo = pytest.mark.skipif(VISUDO is None, reason="visudo not installed")


# ------------------------------------------------------------------ the uninstaller's manifest
def manifest(**kw) -> dict[str, list[str]]:
    proc = subprocess.run(["bash", str(UNINSTALL), "--list", *kw.get("args", [])], capture_output=True,
                          text=True, env={**os.environ, "AQ_ROOTFS": kw.get("root", "/nonexistent-root")})
    assert proc.returncode == 0, proc.stderr
    out: dict[str, list[str]] = {}
    for line in proc.stdout.splitlines():
        kind, value = line.split("\t", 1)
        out.setdefault(kind, []).append(value)
    return out


def covered(path: str, m: dict[str, list[str]]) -> bool:
    """PATH (or a folder it is in) is removed, or deliberately kept / left to --purge-packages."""
    pats = m["path"] + m["unit"] + m["unit-dropin"] + m["keep"] + m["purge-path"] + m["caddy"]
    parts = Path(path).parts
    for i in range(len(parts), 1, -1):
        p = str(Path(*parts[:i]))
        if any(fnmatch.fnmatchcase(p, pat) for pat in pats):
            return True
    return False


# ------------------------------------------------------------------ what the installer writes
ASSIGN = re.compile(r'^([A-Z_]+)=(?:\$\{[A-Z_]+:-([^}]*)\}|"?([$/][^\s"$()]*(?:\$[A-Z_]+[^\s"()]*)*)"?)\s*$')
TEMP_VARS = {"DL", "tmp", "stage", "f", "B", "anc", "dir", "BACKUP"}  # mktemp / loop variables


def _vars(text: str, extra: dict[str, str]) -> dict[str, str]:
    env = dict(extra)
    for line in text.splitlines():
        m = ASSIGN.match(line.strip())
        if m and m.group(1) not in env:
            env[m.group(1)] = m.group(2) if m.group(2) is not None else m.group(3)
    return env


def _resolve(word: str, env: dict[str, str]) -> str | None:
    word = word.strip("\"'")
    for _ in range(5):
        new = re.sub(r"\$\{?([A-Za-z_]+)\}?", lambda m: env.get(m.group(1), m.group(0)), word)
        if new == word:
            break
        word = new
    left = re.findall(r"\$\{?([A-Za-z_]+)", word)
    if left:
        if set(left) <= TEMP_VARS:
            return None
        raise AssertionError(f"cannot resolve {word!r}: teach this test about ${left[0]}")
    return word


def written_paths(script: Path, extra: dict[str, str]) -> set[str]:
    """Every absolute path SCRIPT writes with install/redirect/mkdir/touch/cp/git clone/uv venv."""
    text = script.read_text()
    env = _vars(text, extra)
    out: set[str] = set()
    lines = re.sub(r"\\\n\s*", " ", text).splitlines()
    for raw in lines:
        line = raw.split(" #", 1)[0].strip()
        if line.startswith("#"):
            continue
        targets: list[str] = []
        for m in re.finditer(r"(?<![0-9&<])>{1,2}\s*(\"[^\"]+\"|[^\s;)|&]+)", line):
            targets.append(m.group(1))
        for m in re.finditer(r"\binstall\s+((?:-[a-zA-Z]+\s+(?:\S+\s+)?)*)(.+?)(?:\s*(?:&&|\|\||;|\)|$))", line):
            opts, args = m.group(1), m.group(2).split()
            targets += args if "-d" in opts.split() else args[-1:]
        for m in re.finditer(r"\b(?:mkdir -p|touch|fallocate -l \S+)\s+(.+?)(?:\s*(?:&&|\|\||;|$))", line):
            targets += m.group(1).split()
        for m in re.finditer(r"\b(?:cp -a|git clone|aq_sync_checkout|aq_fetch_supabase|mkvenv|uv venv -q)\s+(.+?)(?:\s*(?:&&|\|\||;|$))", line):
            targets += [a for a in m.group(1).split() if not a.startswith("-")][-1:]
        for t in targets:
            r = _resolve(t, env)
            if r and r.startswith("/") and not r.startswith(("/dev/", "/proc/")):
                out.add(re.sub(r"/\.?$", "", r) or "/")
    return out


def installer_paths() -> set[str]:
    # The dashboard/gateway units are written in a `for svc in dashboard gateway` loop.
    text = INSTALL.read_text()
    svcs = re.search(r"for svc in ([a-z ]+); do", text).group(1).split()
    paths = set()
    for svc in svcs:
        paths |= written_paths(INSTALL, {"svc": svc})
    paths |= written_paths(TOOLS_SETUP, {"HH": "/opt/data/hermes-home", "BACKUP": "/var/backups/hermes-tools-install",
                                         "unit": "hermes-gateway.service"})
    return paths


def test_script_parses():
    proc = subprocess.run(["bash", "-n", str(UNINSTALL)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


@pytest.mark.skipif(shutil.which("shellcheck") is None, reason="shellcheck not installed")
def test_shellcheck_clean():
    proc = subprocess.run(["shellcheck", "--severity=warning", str(UNINSTALL)], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout


def test_extractor_sees_the_installer():
    """Guards the coverage test below against silently extracting nothing."""
    paths = installer_paths()
    for p in ("/opt/data/aquarium-secrets.env", "/etc/aquarium/db-admin.env", "/usr/local/sbin/aquarium",
              "/etc/systemd/system/hermes-gateway.service", "/etc/sudoers.d/hermes-tools", "/etc/caddy/Caddyfile"):
        assert p in paths


def test_every_path_the_installer_writes_is_removed_or_kept():
    m = manifest()
    missing = sorted(p for p in installer_paths() if not covered(p, m))
    assert not missing, f"install-aquarium.sh / hermes-tools-setup write these but uninstall-aquarium.sh does not cover them: {missing}"


def test_every_unit_the_installer_can_install_is_removed():
    m = manifest()
    units = {Path(p).name for p in installer_paths()
             if re.fullmatch(r"/etc/systemd/system/[^/]+\.(service|timer|slice)", p)}
    # deploy/install/lib.sh copies every deploy/aquarium*.{service,timer,slice}; hermes-deploy.sh the hermes-* ones.
    units |= {f.name for f in (REPO / "deploy").iterdir() if re.match(r"(aquarium|hermes-).*\.(service|timer|slice)$", f.name)}
    # Units `aquarium` writes later (offsite backups) and those `systemctl enable` names.
    units |= set(re.findall(r'"((?:hermes|aquarium)-[a-z@-]+\.(?:service|timer|slice))"', (REPO / "deploy/aquarium.py").read_text()))
    enable = re.search(r"systemctl enable -q ((?:[a-z-]+ ?)+)\n", INSTALL.read_text()).group(1).split()
    units |= {u if "." in u else f"{u}.service" for u in enable}
    assert len(units) > 10
    unit_pats = [Path(u).name for u in m["unit"]]
    missing = sorted(u for u in units if not any(fnmatch.fnmatchcase(u, pat) for pat in unit_pats))
    assert not missing, f"units the uninstaller does not remove: {missing}"
    not_stopped = sorted(u for u in units if not any(fnmatch.fnmatchcase(u, pat) for pat in m["unit-stop"]))
    assert not not_stopped, f"units the uninstaller does not stop: {not_stopped}"


def test_every_root_helper_and_sudoers_file_is_removed():
    m = manifest()
    want = {f"/etc/sudoers.d/{f.name}" for f in (REPO / "deploy/sudoers.d").iterdir()}
    want |= {f"/usr/local/sbin/{f.name}" for f in (REPO / "deploy").glob("aquarium-app-*")
             if not f.name.endswith((".service", ".timer", ".slice"))}
    py = (REPO / "deploy/aquarium.py").read_text() + (REPO / "deploy/hermes-deploy.sh").read_text()
    want |= set(re.findall(r"(/usr/local/sbin/[a-z][a-z-]+)", py))
    want |= set(re.findall(r'^(?:ETC|TOOLS_DIR|UV_PYTHON_DIR|AQ|AUDIT_LOG|LOCK)\s*=\s*"([^"]+)"', py, re.M))
    missing = sorted(p for p in want if not covered(p, m))
    assert not missing, missing


def test_service_accounts_the_installer_creates_are_removed():
    m = manifest()
    created = set(re.findall(r"useradd [^\n]*?--home-dir /home/([a-z-]+)", re.sub(r"\\\n\s*", " ", INSTALL.read_text())))
    assert created and created <= set(m["user"])


def test_documented_in_the_installation_guide():
    guide = GUIDE.read_text()
    assert "uninstall-aquarium.sh" in guide
    usage = subprocess.run(["bash", str(UNINSTALL), "--help"], capture_output=True, text=True).stdout
    for flag in set(re.findall(r"(--[a-z-]+)", usage)) - {"--help"}:
        assert flag in guide, f"{flag} is not documented in {GUIDE.name}"


# ------------------------------------------------------------------ a fake installed box
DOCKER_STUB = r'''#!/usr/bin/env python3
import json, os, sys
state_f = os.environ["STUB_DOCKER"]
st = json.load(open(state_f))
a = sys.argv[1:]
open(state_f + ".log", "a").write(" ".join(a) + "\n")
def flt(items):
    for i, x in enumerate(a):
        if x == "--filter":
            k, _, v = a[i + 1].partition("=")
            if k == "label":
                lk, _, lv = v.partition("=")
                items = [c for c in items if c.get("labels", {}).get(lk) == lv]
    return items
def save(): json.dump(st, open(state_f, "w"))
if a[0] == "info": sys.exit(0)
if a[0] == "ps":
    cs = flt(st["containers"])
    if "-a" not in a and "-aq" not in a: cs = [c for c in cs if c.get("running", True)]
    fmt = a[a.index("--format") + 1] if "--format" in a else None
    for c in cs:
        if fmt is None: print(c["id"])
        elif "{{.Label" in fmt:
            l = c.get("labels", {})
            print("\t".join([c["name"], l.get("com.docker.compose.project", ""), l.get("com.docker.compose.project.working_dir", "")]))
        else: print(c["name"])
elif a[0] in ("volume", "network"):
    key = a[0] + "s"
    if a[1] == "ls":
        for v in flt(st[key]): print(v["name"])
    elif a[1] == "rm":
        names = [x for x in a[2:] if not x.startswith("-")]
        st[key] = [v for v in st[key] if v["name"] not in names]; save()
elif a[0] == "rm":
    ids = [x for x in a[1:] if not x.startswith("-")]
    st["containers"] = [c for c in st["containers"] if c["id"] not in ids]; save()
elif a[0] == "inspect":
    for x in a[3:]: print("sha256:img-" + x)
elif a[0] == "start": pass
elif a[0] == "exec":
    cmd = [x for x in a[1:]]
    if "pg_isready" in cmd: sys.exit(0)
    if "pg_dump" in cmd:
        if os.environ.get("STUB_PG_DUMP_FAIL"): sys.exit(1)
        print("PGDUMP-postgres")
    if "pg_dumpall" in cmd: print("-- globals")
elif a[0] == "rmi": pass
'''

STUBS = {
    "systemctl": '#!/bin/sh\necho "$*" >> "$STUB_LOG/systemctl"\ncase $1 in list-units|list-unit-files) cat "$STUB_LOG/loaded" 2>/dev/null;; esac\nexit 0\n',
    "getent": '#!/bin/sh\n[ "$1" = passwd ] || { grep -q "^$2:" "$STUB_LOG/group" 2>/dev/null; exit $?; }\ngrep "^$2:" "$STUB_LOG/passwd"\n',
    "userdel": '#!/bin/sh\necho "$*" >> "$STUB_LOG/userdel"\nsed -i "/^$1:/d" "$STUB_LOG/passwd"\nsed -i "/^$1:/d" "$STUB_LOG/group"\n',
    "groupdel": '#!/bin/sh\necho "$*" >> "$STUB_LOG/groupdel"\nsed -i "/^$1:/d" "$STUB_LOG/group"\n',
    "pkill": '#!/bin/sh\necho "$*" >> "$STUB_LOG/pkill"\n',
    "pgrep": "#!/bin/sh\nexit 1\n",
    "hostname": "#!/bin/sh\necho testbox\n",
    "apt-get": '#!/bin/sh\necho "$*" >> "$STUB_LOG/apt-get"\n',
    "dpkg-query": "#!/bin/sh\necho 'install ok installed'\n",
    "sleep": "#!/bin/sh\n",
}

OURS_CADDY = "home.example.com {\n    handle {\n        reverse_proxy 127.0.0.1:3100\n    }\n}\n"


class Box:
    def __init__(self, tmp: Path):
        self.tmp, self.root, self.stub = tmp, tmp / "root", tmp / "stub"
        self.bin = tmp / "bin"
        for d in (self.root, self.stub, self.bin):
            d.mkdir(parents=True, exist_ok=True)
        for name, body in {**STUBS, "docker": DOCKER_STUB}.items():
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        (self.stub / "passwd").write_text("hermes:x:998:998::/home/hermes:/usr/sbin/nologin\n"
                                          "hermes-tools:x:997:997::/home/hermes-tools:/usr/sbin/nologin\n")
        (self.stub / "group").write_text("hermes:x:998:\nhermes-tools:x:997:hermes\n")
        (self.stub / "loaded").write_text("hermes-gateway.service loaded active running\n"
                                          "aquarium-app@notes.service loaded active running\n")
        supa = {"com.docker.compose.project": "docker", "com.docker.compose.project.working_dir": "/opt/data/supabase/docker"}
        other = {"com.docker.compose.project": "shop", "com.docker.compose.project.working_dir": "/srv/shop"}
        self.docker = self.stub / "docker.json"
        self.docker.write_text(json.dumps({
            "containers": [{"id": "c1", "name": "supabase-db", "labels": {**supa, "com.docker.compose.service": "db"}},
                           {"id": "c2", "name": "supabase-kong", "labels": {**supa, "com.docker.compose.service": "kong"}},
                           {"id": "c9", "name": "shop-web", "labels": other}],
            "volumes": [{"name": "docker_db-config", "labels": supa}, {"name": "shop_data", "labels": other}],
            "networks": [{"name": "docker_default", "labels": supa}, {"name": "shop_default", "labels": other}],
        }))
        (self.root / "etc").mkdir(exist_ok=True)
        (self.root / "etc/gitconfig").write_text("[safe]\n\tdirectory = /opt/data/hermes-agent\n\tdirectory = /srv/other\n")

    def env(self, **extra):
        return {**os.environ, "AQ_ROOTFS": str(self.root), "AQ_TEST_SYSTEMCTL": "1", "STUB_LOG": str(self.stub),
                "STUB_DOCKER": str(self.docker), "PATH": f"{self.bin}:{os.environ['PATH']}",
                "GIT_CONFIG_SYSTEM": str(self.root / "etc/gitconfig"), "GIT_CONFIG_NOSYSTEM": "", **extra}

    def write(self, rel: str, text: str = "x"):
        f = self.root / rel.lstrip("/")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        return f

    def run(self, *args, stdin=subprocess.DEVNULL, **env):
        return subprocess.run(["bash", str(UNINSTALL), *args], capture_output=True, text=True, stdin=stdin,
                              env=self.env(**env))

    def exists(self, rel: str) -> bool:
        p = self.root / rel.lstrip("/")
        return p.exists() or p.is_symlink()

    def log(self, name: str) -> str:
        f = self.stub / name
        return f.read_text() if f.exists() else ""

    def docker_state(self):
        return json.loads(self.docker.read_text())


UNRELATED = ["/etc/sudoers.d/90-cloud-init-users", "/etc/systemd/system/nginx.service", "/usr/local/sbin/backup-tool",
             "/usr/local/bin/uv", "/etc/fstab", "/swapfile", "/var/backups/aquarium/hermes-old.tar.zst",
             "/home/ubuntu/.bashrc", "/opt/other/app.txt", "/var/lib/docker/keep"]


def installed_box(tmp_path: Path) -> tuple[Box, set[str]]:
    """Every path the installer writes, plus some unrelated files that must survive."""
    box = Box(tmp_path)
    m = manifest(root=str(box.root))
    extra = {"/etc/aquarium/aquarium.conf", "/home/hermes/.profile", "/home/hermes-tools/.profile",
             "/etc/systemd/system/multi-user.target.wants/hermes-gateway.service",
             "/etc/systemd/system/aquarium-app@notes.service.d/override.conf",
             "/var/lib/aquarium-apps/notes/data.db", "/opt/aquarium/releases/v1/README"}
    paths = {p for p in installer_paths() | extra
             if not any(fnmatch.fnmatchcase(p, k) or p.startswith(k + "/") for k in m["keep"])}
    dirs = {str(a) for p in paths for a in Path(p).parents}
    created = set()
    for p in sorted(paths - dirs):
        text = {"/etc/caddy/Caddyfile": OURS_CADDY, "/etc/aquarium/aquarium.conf": "DATA_ROOT=/opt/data\n"}.get(p, "x")
        box.write(p, text)
        created.add(p)
    for p in UNRELATED:
        box.write(p, "keep me")
    return box, created


# ------------------------------------------------------------------ behaviour
def test_removes_everything_the_installer_wrote_and_nothing_else(tmp_path):
    box, created = installed_box(tmp_path)
    proc = box.run("--yes", "--no-backup")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    left = sorted(p for p in created if box.exists(p))
    assert not left, f"still present after uninstall: {left}"
    assert not box.exists("/opt/data"), "the data root is removed once empty"
    for p in UNRELATED:
        assert (box.root / p.lstrip("/")).read_text() == "keep me", p
    # Docker: only this install's compose project.
    st = box.docker_state()
    assert [c["name"] for c in st["containers"]] == ["shop-web"]
    assert [v["name"] for v in st["volumes"]] == ["shop_data"]
    assert [n["name"] for n in st["networks"]] == ["shop_default"]
    # Units stopped, accounts removed, git config cleaned, packages kept.
    assert "disable --now -q hermes-gateway.service" in box.log("systemctl")
    assert "disable --now -q aquarium-app@notes.service" in box.log("systemctl")
    assert set(box.log("userdel").split()) == {"hermes", "hermes-tools"}
    assert "/opt/data/hermes-agent" not in (box.root / "etc/gitconfig").read_text()
    assert "/srv/other" in (box.root / "etc/gitconfig").read_text()
    assert "purge" not in box.log("apt-get")


def test_second_run_is_a_no_op(tmp_path):
    box, _ = installed_box(tmp_path)
    assert box.run("--yes", "--no-backup").returncode == 0
    (box.stub / "loaded").write_text("")
    again = box.run("--yes", "--no-backup")
    assert again.returncode == 0, again.stderr
    assert "Nothing to remove" in again.stdout


def test_half_removed_box_is_finished_off(tmp_path):
    box, created = installed_box(tmp_path)
    shutil.rmtree(box.root / "opt/data/hermes-agent")
    shutil.rmtree(box.root / "etc/aquarium")
    st = box.docker_state()
    st["containers"] = [c for c in st["containers"] if c["name"] != "supabase-db"]
    box.docker.write_text(json.dumps(st))
    proc = box.run("--yes")  # no database container left: backup goes on without a dump
    assert proc.returncode == 0, proc.stderr
    assert not [p for p in created if box.exists(p)]
    assert [c["name"] for c in box.docker_state()["containers"]] == ["shop-web"]


def test_refuses_without_yes_and_without_a_terminal(tmp_path):
    box, created = installed_box(tmp_path)
    proc = box.run("--no-backup")
    assert proc.returncode != 0
    assert "--yes" in proc.stderr
    assert "/opt/data/aquarium-secrets.env" in proc.stdout, "the plan is printed before refusing"
    assert all(box.exists(p) for p in created)
    assert len(box.docker_state()["containers"]) == 3


def test_typed_confirmation_must_match_the_host_name(tmp_path):
    box, created = installed_box(tmp_path)
    answer = tmp_path / "tty"
    answer.write_text("yes\n")
    proc = box.run("--no-backup", AQ_TTY=str(answer))
    assert proc.returncode != 0 and all(box.exists(p) for p in created)
    answer.write_text("testbox\n")
    proc = box.run("--no-backup", AQ_TTY=str(answer))
    assert proc.returncode == 0, proc.stderr
    assert not [p for p in created if box.exists(p)]


def test_dry_run_changes_nothing(tmp_path):
    box, created = installed_box(tmp_path)
    proc = box.run("--dry-run")
    assert proc.returncode == 0
    assert all(box.exists(p) for p in created)
    assert box.log("systemctl").count("disable") == 0 and box.log("userdel") == ""


def test_backup_is_written_first_outside_what_is_removed(tmp_path):
    box, _ = installed_box(tmp_path)
    box.write("/opt/data/aquarium-secrets.env", "POSTGRES_PASSWORD=placeholder\n")
    proc = box.run("--yes")
    assert proc.returncode == 0, proc.stderr
    [dest] = list((box.root / "var/backups/aquarium-uninstall").iterdir())
    assert (dest / "postgres.dump").read_text().startswith("PGDUMP-postgres")
    assert (dest / "postgres-globals.sql").exists()
    assert dest.stat().st_mode & 0o077 == 0
    with tarfile.open(dest / "files.tar.gz") as tf:
        names = set(tf.getnames())
    assert {"opt/data/aquarium-secrets.env", "etc/aquarium/aquarium.conf", "etc/caddy/Caddyfile"} <= names
    assert not any(n.startswith("opt/data/hermes-agent/") for n in names), "the code is not backed up"
    assert f"Backup: /var/backups/aquarium-uninstall/{dest.name}" in proc.stdout


def test_failed_backup_removes_nothing(tmp_path):
    box, created = installed_box(tmp_path)
    proc = box.run("--yes", STUB_PG_DUMP_FAIL="1")
    assert proc.returncode != 0
    assert "nothing was removed" in proc.stderr
    assert all(box.exists(p) for p in created)
    assert len(box.docker_state()["containers"]) == 3


def test_backup_dir_inside_a_removed_folder_is_refused(tmp_path):
    box, created = installed_box(tmp_path)
    proc = box.run("--yes", "--backup-dir", "/opt/data/backup")
    assert proc.returncode != 0 and all(box.exists(p) for p in created)


def test_foreign_caddyfile_and_accounts_are_left_alone(tmp_path):
    box, _ = installed_box(tmp_path)
    box.write("/etc/caddy/Caddyfile", "shop.example.com {\n    reverse_proxy 127.0.0.1:8080\n}\n")
    (box.stub / "passwd").write_text("hermes:x:1001:1001::/srv/hermes:/bin/bash\n")
    proc = box.run("--yes", "--no-backup")
    assert proc.returncode == 0, proc.stderr
    assert "shop.example.com" in (box.root / "etc/caddy/Caddyfile").read_text()
    assert "disable --now -q caddy" not in box.log("systemctl")
    assert box.log("userdel") == ""


def test_purge_packages_only_when_asked_and_keeps_shared_docker(tmp_path):
    box, _ = installed_box(tmp_path)
    proc = box.run("--yes", "--no-backup", "--purge-packages")
    assert proc.returncode == 0, proc.stderr
    purge = box.log("apt-get")
    assert "purge" in purge and "caddy" in purge and "nodejs" in purge
    assert "docker.io" not in purge, "another compose project still uses Docker"
    assert not box.exists("/usr/local/bin/uv")


@pytest.mark.parametrize("root", ["/", "/etc", "relative/dir", "/usr"])
def test_refuses_a_system_folder_as_data_root(tmp_path, root):
    box, created = installed_box(tmp_path)
    proc = box.run("--yes", "--no-backup", "--data-root", root)
    assert proc.returncode != 0
    assert all(box.exists(p) for p in created)


@needs_visudo
def test_lib_install_steps_are_undone(tmp_path):
    """Run the real deploy/install/lib.sh install steps into a fake root, then uninstall."""
    box = Box(tmp_path)
    (box.root / "etc/caddy").mkdir(parents=True)
    for name, body in {"visudo": f'#!/bin/sh\nexec {VISUDO} "$@"\n', "modprobe": "#!/bin/sh\n",
                       "apt-cache": "#!/bin/sh\nexit 1\n", "uname": "#!/bin/sh\necho 6.8.0\n"}.items():
        (box.bin / name).write_text(body)
        (box.bin / name).chmod(0o755)
    before = {p for p in box.root.rglob("*")}
    script = (f'set -euo pipefail; . "{LIB}"; '
              f'aq_install_vpn_support "{REPO}"; aq_install_security_check "{REPO}"; '
              f'aq_install_app_runtime "{REPO}" /opt/data/hermes-home')
    proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                          env=box.env(AQ_CODE_OWNER=f"{os.getuid()}:{os.getgid()}"))  # windows-footgun: ok — bash installer, Linux only
    assert proc.returncode == 0, proc.stderr
    made = {p for p in box.root.rglob("*") if p.is_file()} - before - {box.root / "etc/gitconfig"}
    assert len(made) > 10
    proc = box.run("--yes", "--no-backup")
    assert proc.returncode == 0, proc.stderr
    left = sorted(str(p.relative_to(box.root)) for p in made if p.exists())
    assert not left, f"lib.sh installed these but the uninstaller left them: {left}"
