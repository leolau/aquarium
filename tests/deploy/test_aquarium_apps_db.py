"""`aquarium apps db|cluster` and app-database backups (FG-33 P8-1 item 1.3).

The pure checks run everywhere. The end-to-end class starts the real pinned Supabase Postgres
image twice (prod apps cluster + the separate dev instance, decision 18) through the shipped
compose file, then drives the root CLI exactly as the sudoers argv does, with JSON on stdin, and
connects with the DSNs it wrote. It is skipped when Docker or the image is unavailable.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "deploy" / "aquarium.py"
IMAGE = ("supabase/postgres:17.6.1.136@sha256:"
         "f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00")


def load_cli():
    spec = importlib.util.spec_from_file_location("aquarium_cli_apps", CLI)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


aq = load_cli()


def cli(root: Path, *argv: str, spec=None, path: str | None = None) -> subprocess.CompletedProcess:
    env = {**os.environ, "AQUARIUM_TEST_PREFIX": str(root)}
    if path:
        env["PATH"] = path
    data = b"" if spec is None else json.dumps(spec).encode()
    return subprocess.run([sys.executable, str(CLI), *argv], input=data, capture_output=True, env=env,
                          timeout=900, check=False)


def answer(proc: subprocess.CompletedProcess) -> dict:
    lines = proc.stdout.decode().strip().splitlines()
    assert lines, proc.stderr.decode()
    return json.loads(lines[-1])


# --------------------------------------------------------------------------- everywhere


@pytest.mark.parametrize("slug", ["../etc", "a/b", "A", "1abc", "a--b", "a-", "", "x" * 41, "a b", "a_b"])
def test_bad_slugs_never_reach_a_path_or_sql(slug):
    with pytest.raises(aq.Fail):
        aq.app_db_name(slug, "prod")
    with pytest.raises(aq.Fail):
        aq.app_dsn_dir(slug)


def test_mode_is_exactly_prod_or_dev(tmp_path):
    with pytest.raises(aq.Fail):
        aq.app_db_name("notes", "staging")
    proc = cli(tmp_path, "apps", "db", "create", "notes", "staging")
    assert proc.returncode == 2


def test_names_are_distinct_per_slug_and_mode_and_fit_postgres_limits():
    slugs = ["notes", "notes-app", "notes-app2", "a", "z" * 40, "a-b-c"]
    names = {aq.app_db_name(s, m) for s in slugs for m in aq.APP_MODES}
    assert len(names) == len(slugs) * 2
    for name in names:
        assert aq.APP_DB_NAME_RE.match(name)
        assert all(len(r.encode()) <= 63 for r in aq.app_roles(name).values())
    assert aq.app_db_name("a-b", "prod") != aq.app_db_name("ab", "prod")


def test_prod_and_dev_are_different_named_targets():
    cfg = dict(aq.DEFAULTS)
    prod, dev = aq.apps_target(cfg, "prod"), aq.apps_target(cfg, "dev")
    assert prod["container"] != dev["container"] and prod["port"] != dev["port"]
    assert cfg["DB_CONTAINER"] not in (prod["container"], dev["container"])
    assert prod["data"] != dev["data"] and prod["data"].startswith(cfg["APPS_BASE"])


def test_refusals_happen_before_any_database_is_touched(tmp_path):
    empty_path = str(tmp_path / "nobin")  # no docker: any attempt to touch a cluster would fail differently
    drop = answer(cli(tmp_path, "apps", "db", "drop", "notes", "dev", spec={}, path=empty_path))
    assert not drop["ok"] and "confirmation" in drop["error"]
    wrong = answer(cli(tmp_path, "apps", "db", "drop", "notes", "dev", spec={"confirm": "other"}, path=empty_path))
    assert not wrong["ok"] and "confirmation" in wrong["error"]
    extra = answer(cli(tmp_path, "apps", "db", "status", "notes", "dev", spec={"approval_ref": "x"}, path=empty_path))
    assert not extra["ok"] and "unexpected" in extra["error"]
    bad = answer(cli(tmp_path, "apps", "db", "create", "../x", "dev", path=empty_path))
    assert not bad["ok"] and "slug" in bad["error"]
    assert not (tmp_path / "etc/aquarium/apps").exists()


def test_scram_verifier_never_contains_the_password():
    v = aq.scram_verifier("s3cret-pw")
    assert v.startswith("SCRAM-SHA-256$4096:") and "s3cret-pw" not in v
    assert aq.scram_verifier("s3cret-pw") != v  # fresh salt each time


def test_compose_file_pins_the_locked_postgres_image_and_binds_loopback():
    text = (ROOT / aq.APPS_COMPOSE).read_text()
    lock = (ROOT / "deploy/install/supabase-images.lock").read_text()
    image = next(line.split()[-1] for line in text.splitlines() if line.strip().startswith("image:"))
    assert image.split("@")[1] in lock
    assert "127.0.0.1:${APPS_DB_PORT" in text
    assert "supabase_default" not in text  # never joins Aquarium's own stack network


# --------------------------------------------------------------------------- end to end


def _docker_ok() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True).returncode == 0


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _dsn(root: Path, slug: str, mode: str, kind: str) -> str:
    return (root / f"etc/aquarium/apps/{slug}/db-{mode}-{kind}.dsn").read_text().strip()


def _q(dsn: str, sql: str, *args):
    import asyncpg

    async def go():
        conn = await asyncpg.connect(dsn, timeout=10)
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()
    return asyncio.run(go())


def _q_as(dsn: str, db: str, sql: str):
    return _q(dsn.rsplit("/", 1)[0] + "/" + db + "?sslmode=disable", sql)


@pytest.fixture(scope="module")
def cluster(tmp_path_factory):
    if not _docker_ok():
        pytest.skip("docker or the pinned supabase/postgres image is not available")
    pytest.importorskip("asyncpg")
    root = tmp_path_factory.mktemp("appsroot")
    tag = uuid.uuid4().hex[:6]
    conf = {
        "APPS_DB_PROD_CONTAINER": f"test-apps-db-{tag}", "APPS_DB_PROD_PORT": str(_free_port()),
        "APPS_DB_DEV_CONTAINER": f"test-apps-dev-db-{tag}", "APPS_DB_DEV_PORT": str(_free_port()),
        "APPS_DB_CGROUP_PARENT": "", "BACKUP_DIR": "/var/backups/aquarium",
    }
    conf["DB_CONTAINER"] = conf["APPS_DB_PROD_CONTAINER"]  # stands in for Aquarium's DB (approvals table)
    (root / "etc/aquarium").mkdir(parents=True)
    (root / "etc/aquarium/aquarium.conf").write_text("".join(f"{k}={v}\n" for k, v in conf.items()))
    (root / "opt/data").mkdir(parents=True)
    (root / "opt/data/hermes-agent").symlink_to(ROOT)
    proc = cli(root, "apps", "cluster", "up", "all")
    try:
        assert proc.returncode == 0, proc.stdout.decode() + proc.stderr.decode()
        subprocess.run(["docker", "exec", "-i", "-u", "postgres", conf["DB_CONTAINER"], "psql", "-U",
                        "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], check=True,
                       input=b"CREATE SCHEMA app_prod; CREATE TABLE app_prod.approvals(id TEXT PRIMARY KEY, "
                             b"action TEXT NOT NULL, target_ref TEXT NOT NULL, actor TEXT NOT NULL, "
                             b"decision TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
        yield root, conf
    finally:
        for name in (conf["APPS_DB_PROD_CONTAINER"], conf["APPS_DB_DEV_CONTAINER"]):
            subprocess.run(["docker", "rm", "-f", "-v", name], capture_output=True)
        data = root / "var/lib/aquarium-apps"
        if data.exists():
            subprocess.run(["docker", "run", "--rm", "-v", f"{data}:/d", "--entrypoint", "sh", IMAGE, "-c",
                            "rm -rf /d/*"], capture_output=True)
        for mode in ("prod", "dev"):
            subprocess.run(["docker", "network", "rm", f"aquarium-apps-db-{mode}_apps"], capture_output=True)


def approve(conf: dict, slug: str, decision: str = "approved") -> str:
    ref = "apr_" + uuid.uuid4().hex
    subprocess.run(["docker", "exec", "-i", "-u", "postgres", conf["DB_CONTAINER"], "psql", "-U", "supabase_admin",
                    "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], check=True,
                   input=(f"INSERT INTO app_prod.approvals(id, action, target_ref, actor, decision) VALUES "
                          f"('{ref}', 'tool.promote', 'tool:{slug}', 'owner', '{decision}');").encode())
    return ref


MIG1 = {"name": "20260101000000_notes.sql",
        "sql": "CREATE TABLE notes (id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(), body text);\n"
               "INSERT INTO notes (body) VALUES ('first');"}
MIG2 = {"name": "20260102000000_more.sql",
        "sql": "ALTER TABLE notes ADD COLUMN done boolean NOT NULL DEFAULT false; CREATE INDEX ON notes(done);"}


class TestAppsDatabasesEndToEnd:
    def test_dev_create_is_isolated_least_privilege_and_root_only(self, cluster):
        root, conf = cluster
        out = answer(cli(root, "apps", "db", "create", "notes", "dev"))
        assert out["ok"] and out["created"] and out["target"] == conf["APPS_DB_DEV_CONTAINER"]
        folder = root / "etc/aquarium/apps/notes"
        assert stat.S_IMODE(folder.stat().st_mode) == 0o700
        cluster_pw = (root / "etc/aquarium/apps-db-dev.env").read_text().split("=", 1)[1].strip()
        for kind in ("rw", "ro", "owner"):
            f = folder / f"db-dev-{kind}.dsn"
            assert stat.S_IMODE(f.stat().st_mode) == 0o600
            text = f.read_text()
            assert f":{conf['APPS_DB_DEV_PORT']}/" in text and cluster_pw not in text
            assert "supabase_admin" not in text and "SUPABASE_JWT_SECRET" not in text
        rw, ro = _dsn(root, "notes", "dev", "rw"), _dsn(root, "notes", "dev", "ro")
        assert _q(rw, "SELECT current_user")[0][0].endswith("_rw")
        for dsn in (rw, ro):
            for other in ("postgres", "template1"):
                with pytest.raises(Exception, match="permission denied|not currently accepting"):
                    _q_as(dsn, other, "SELECT 1")
        with pytest.raises(Exception, match="permission denied"):
            _q(rw, "CREATE TABLE sneaky (x int)")
        flags = _q(rw, "SELECT rolsuper, rolcreatedb, rolcreaterole, rolconnlimit FROM pg_roles "
                       "WHERE rolname = current_user")[0]
        assert not flags[0] and not flags[1] and not flags[2] and flags[3] > 0
        assert _q(rw, "SHOW statement_timeout")[0][0] not in ("0", "")
        # the same app in prod is a different database on a different cluster, with other credentials
        assert f":{conf['APPS_DB_PROD_PORT']}/" not in rw

    def test_second_create_keeps_credentials(self, cluster):
        root, _ = cluster
        before = _dsn(root, "notes", "dev", "rw")
        out = answer(cli(root, "apps", "db", "create", "notes", "dev"))
        assert out["ok"] and not out["created"] and _dsn(root, "notes", "dev", "rw") == before

    def test_two_apps_cannot_reach_each_other(self, cluster):
        root, _ = cluster
        assert answer(cli(root, "apps", "db", "create", "other-app", "dev"))["ok"]
        mine = _dsn(root, "notes", "dev", "rw")
        with pytest.raises(Exception, match="permission denied"):
            _q_as(mine, aq.app_db_name("other-app", "dev"), "SELECT 1")

    def test_migrations_apply_once_in_order_and_grant_runtime_roles(self, cluster):
        root, _ = cluster
        out = answer(cli(root, "apps", "db", "migrate", "notes", "dev", spec={"migrations": [MIG2, MIG1]}))
        assert out["ok"] and out["applied"] == [MIG1["name"], MIG2["name"]] and out["backup_ref"] is None
        again = answer(cli(root, "apps", "db", "migrate", "notes", "dev", spec={"migrations": [MIG1, MIG2]}))
        assert again["ok"] and again["applied"] == []
        rw, ro = _dsn(root, "notes", "dev", "rw"), _dsn(root, "notes", "dev", "ro")
        _q(rw, "INSERT INTO notes (body) VALUES ('second')")
        assert len(_q(ro, "SELECT * FROM notes")) == 2
        # the template's /api/health reads this as the app's runtime/ro role (item 1.1)
        for dsn in (rw, ro):
            assert _q(dsn, "SELECT max(version)::text FROM supabase_migrations.schema_migrations")[0][0] \
                == "20260102000000"
        with pytest.raises(Exception, match="read-only|permission denied"):
            _q(ro, "INSERT INTO notes (body) VALUES ('nope')")
        edited = {**MIG1, "sql": MIG1["sql"] + " -- edited"}
        bad = answer(cli(root, "apps", "db", "migrate", "notes", "dev", spec={"migrations": [edited, MIG2]}))
        assert not bad["ok"] and "changed" in bad["error"]

    def test_failed_migration_leaves_nothing_and_psql_metacommands_are_inert(self, cluster):
        root, conf = cluster
        marker = "/tmp/aq-pwned-" + uuid.uuid4().hex
        evil = {"name": "20260103000000_evil.sql",
                "sql": f"CREATE TABLE half (x int);\n\\! touch {marker}\nSELECT 1;"}
        out = answer(cli(root, "apps", "db", "migrate", "notes", "dev", spec={"migrations": [MIG1, MIG2, evil]}))
        assert not out["ok"]
        assert subprocess.run(["docker", "exec", conf["APPS_DB_DEV_CONTAINER"], "test", "-e", marker]).returncode != 0
        rw = _dsn(root, "notes", "dev", "rw")
        assert not _q(rw, "SELECT 1 FROM pg_tables WHERE tablename = 'half'")
        status = answer(cli(root, "apps", "db", "status", "notes", "dev"))
        assert status["migrations"] == [MIG1["name"], MIG2["name"]]
        escalate = {"name": "20260104000000_escalate.sql", "sql": "ALTER ROLE CURRENT_USER SUPERUSER;"}
        assert not answer(cli(root, "apps", "db", "migrate", "notes", "dev",
                              spec={"migrations": [MIG1, MIG2, escalate]}))["ok"]

    def test_suspend_blocks_connections_and_resume_restores(self, cluster):
        root, _ = cluster
        rw = _dsn(root, "notes", "dev", "rw")
        assert answer(cli(root, "apps", "db", "suspend", "notes", "dev"))["ok"]
        assert answer(cli(root, "apps", "db", "status", "notes", "dev"))["suspended"]
        with pytest.raises(Exception, match="too many connections"):
            _q(rw, "SELECT 1")
        assert answer(cli(root, "apps", "db", "resume", "notes", "dev"))["ok"]
        assert _q(rw, "SELECT count(*) FROM notes")[0][0] == 2

    def test_prod_verbs_need_a_fresh_approved_approval_used_once(self, cluster):
        root, conf = cluster
        refused = answer(cli(root, "apps", "db", "create", "notes", "prod"))
        assert not refused["ok"] and "approval" in refused["error"]
        denied = approve(conf, "notes", decision="denied")
        assert not answer(cli(root, "apps", "db", "create", "notes", "prod", spec={"approval_ref": denied}))["ok"]
        foreign = approve(conf, "other-app")
        assert not answer(cli(root, "apps", "db", "create", "notes", "prod", spec={"approval_ref": foreign}))["ok"]
        assert not (root / "etc/aquarium/apps/notes/db-prod-rw.dsn").exists()
        ref = approve(conf, "notes")
        out = answer(cli(root, "apps", "db", "create", "notes", "prod", spec={"approval_ref": ref}))
        assert out["ok"] and out["target"] == conf["APPS_DB_PROD_CONTAINER"]
        assert not answer(cli(root, "apps", "db", "create", "notes", "prod", spec={"approval_ref": ref}))["ok"]
        mig = answer(cli(root, "apps", "db", "migrate", "notes", "prod",
                         spec={"approval_ref": ref, "migrations": [MIG1]}))
        assert mig["ok"] and mig["applied"] == [MIG1["name"]]
        dump = root / mig["backup_ref"].lstrip("/")
        assert dump.is_file() and stat.S_IMODE(dump.stat().st_mode) == 0o600
        prod_rw, dev_rw = _dsn(root, "notes", "prod", "rw"), _dsn(root, "notes", "dev", "rw")
        assert prod_rw != dev_rw and _q(prod_rw, "SELECT count(*) FROM notes")[0][0] == 1
        assert _q(dev_rw, "SELECT count(*) FROM notes")[0][0] == 2  # dev data never shows up in prod
        assert answer(cli(root, "apps", "db", "status", "notes", "prod"))["exists"]  # status needs no approval

    def test_every_app_database_is_in_the_backup_and_restores_alone(self, cluster):
        if not shutil.which("gpg"):
            pytest.skip("gpg not installed")
        root, conf = cluster
        proc = cli(root, "backup", "--to", str(root / "var/backups/test"))
        assert proc.returncode == 0, proc.stdout.decode() + proc.stderr.decode()
        backup = next((root / "var/backups/test").glob("*.gpg"))
        registered = set()
        for mode in ("prod", "dev"):
            target = aq.apps_target({**aq.DEFAULTS, **conf}, mode)
            names = subprocess.run(["docker", "exec", target["container"], "psql", "-U", "supabase_admin", "-At",
                                    "-c", "SELECT datname FROM pg_database WHERE datname LIKE 'lapp%'"],
                                   capture_output=True, check=True).stdout.decode().split()
            registered |= set(names)
        assert registered >= {aq.app_db_name("notes", "dev"), aq.app_db_name("notes", "prod")}
        staging = root / "open"
        staging.mkdir()
        os.environ["AQUARIUM_TEST_PREFIX"] = str(root)
        try:
            manifest = aq.open_backup(backup, root / "etc/aquarium/backup.key", staging)
        finally:
            del os.environ["AQUARIUM_TEST_PREFIX"]
        assert {e["database"] for e in manifest["apps_db"]} == registered
        notes_dev = next(e for e in manifest["apps_db"] if e["database"] == aq.app_db_name("notes", "dev"))
        assert notes_dev["slug"] == "notes" and notes_dev["tables"]["public.notes"] == 2
        test = cli(root, "restore", str(backup), "--test")
        assert test.returncode == 0, test.stdout.decode()
        rw = _dsn(root, "notes", "dev", "rw")
        _q(rw, "DELETE FROM notes")
        dry = cli(root, "restore", str(backup), "--app", "notes", "--mode", "dev")
        assert dry.returncode == 0 and _q(rw, "SELECT count(*) FROM notes")[0][0] == 0
        done = cli(root, "restore", str(backup), "--app", "notes", "--mode", "dev", "--yes")
        assert done.returncode == 0, done.stdout.decode() + done.stderr.decode()
        rw = _dsn(root, "notes", "dev", "rw")
        assert _q(rw, "SELECT count(*) FROM notes")[0][0] == 2
        _q(rw, "INSERT INTO notes (body) VALUES ('after restore')")  # runtime grants are back
        status = answer(cli(root, "apps", "db", "status", "notes", "dev"))
        assert status["migrations"] == [MIG1["name"], MIG2["name"]]
        # Aquarium's own database was not part of an --app restore
        assert "approvals" in subprocess.run(
            ["docker", "exec", conf["DB_CONTAINER"], "psql", "-U", "supabase_admin", "-At", "-c",
             "SELECT tablename FROM pg_tables WHERE schemaname = 'app_prod'"], capture_output=True).stdout.decode()

    def test_drop_needs_confirmation_keeps_a_final_dump_and_removes_everything(self, cluster):
        root, conf = cluster
        db = aq.app_db_name("other-app", "dev")
        assert not answer(cli(root, "apps", "db", "drop", "other-app", "dev"))["ok"]
        out = answer(cli(root, "apps", "db", "drop", "other-app", "dev", spec={"confirm": "other-app"}))
        assert out["ok"] and (root / out["backup_ref"].lstrip("/")).is_file()
        left = subprocess.run(["docker", "exec", conf["APPS_DB_DEV_CONTAINER"], "psql", "-U", "supabase_admin", "-At",
                               "-c", f"SELECT count(*) FROM pg_roles WHERE rolname LIKE '{db}%'"],
                              capture_output=True).stdout.decode().strip()
        assert left == "0"
        assert not (root / "etc/aquarium/apps/other-app").exists()
        assert answer(cli(root, "apps", "db", "status", "other-app", "dev"))["exists"] is False

    def test_archive_copy_fails_safe_and_restore_reloads_only_a_lost_database(self, cluster, tmp_path):
        root, conf = cluster
        assert answer(cli(root, "apps", "db", "create", "keep", "dev"))["ok"]
        assert answer(cli(root, "apps", "db", "migrate", "keep", "dev", spec={"migrations": [MIG1]}))["ok"]
        rw = _dsn(root, "keep", "dev", "rw")
        backups = root / "var/lib/aquarium-apps/db-backups"

        # A failing pg_dump: nothing is suspended and no partial copy is left behind.
        fake = tmp_path / "bin"
        fake.mkdir()
        real_docker = shutil.which("docker")
        (fake / "docker").write_text(f'#!/bin/sh\ncase "$*" in *pg_dump*) echo boom >&2; exit 1;; esac\n'
                                     f'exec {real_docker} "$@"\n')
        (fake / "docker").chmod(0o755)
        before = set(backups.glob("*")) if backups.exists() else set()
        out = answer(cli(root, "apps", "db", "archive", "keep", "dev", path=f"{fake}:{os.environ['PATH']}"))
        assert not out["ok"] and "boom" in out["error"]
        assert set(backups.glob("*")) == before
        assert _q(rw, "SELECT count(*) FROM notes")[0][0] == 1

        out = answer(cli(root, "apps", "db", "archive", "keep", "dev"))
        assert out["ok"]
        copy = root / out["backup_ref"].lstrip("/")
        assert copy.parent == backups and stat.S_IMODE(backups.stat().st_mode) == 0o700
        assert stat.S_IMODE(copy.stat().st_mode) == 0o600 and out["size_bytes"] == copy.stat().st_size > 0
        with pytest.raises(Exception, match="too many connections|connection limit"):
            _q(rw, "SELECT 1")

        # Only the archive copy of this database is accepted.
        other = aq.app_db_name("notes", "dev")
        for ref in (None, "/etc/passwd", out["backup_ref"].replace(aq.app_db_name("keep", "dev"), other)):
            spec = {} if ref is None else {"backup_ref": ref}
            assert not answer(cli(root, "apps", "db", "restore", "keep", "dev", spec=spec))["ok"]

        # Database still there with its rows: restore only resumes it.
        res = answer(cli(root, "apps", "db", "restore", "keep", "dev", spec={"backup_ref": out["backup_ref"]}))
        assert res["ok"] and res["existed"] and res["restored"] is False
        _q(rw, "INSERT INTO notes (body) VALUES ('kept')")
        assert _q(rw, "SELECT count(*) FROM notes")[0][0] == 2

        # Database lost while archived: restore reloads the copy and the runtime grants work again.
        out = answer(cli(root, "apps", "db", "archive", "keep", "dev"))
        subprocess.run(["docker", "exec", conf["APPS_DB_DEV_CONTAINER"], "psql", "-U", "supabase_admin", "-c",
                        f"DROP DATABASE {aq.app_db_name('keep', 'dev')} WITH (FORCE)"], check=True,
                       capture_output=True)
        res = answer(cli(root, "apps", "db", "restore", "keep", "dev", spec={"backup_ref": out["backup_ref"]}))
        assert res["ok"] and res["existed"] is False and res["restored"] is True
        rw = _dsn(root, "keep", "dev", "rw")
        assert sorted(r[0] for r in _q(rw, "SELECT body FROM notes")) == ["first", "kept"]
        _q(rw, "INSERT INTO notes (body) VALUES ('after restore')")
        assert answer(cli(root, "apps", "db", "status", "keep", "dev"))["migrations"] == [MIG1["name"]]

    def test_prod_archive_and_restore_need_an_approval(self, cluster):
        root, conf = cluster
        assert not answer(cli(root, "apps", "db", "archive", "notes", "prod"))["ok"]
        out = answer(cli(root, "apps", "db", "archive", "notes", "prod", spec={"approval_ref": approve(conf, "notes")}))
        assert out["ok"]
        spec = {"backup_ref": out["backup_ref"]}
        assert not answer(cli(root, "apps", "db", "restore", "notes", "prod", spec=spec))["ok"]
        res = answer(cli(root, "apps", "db", "restore", "notes", "prod",
                         spec={**spec, "approval_ref": approve(conf, "notes")}))
        assert res["ok"] and res["restored"] is False
