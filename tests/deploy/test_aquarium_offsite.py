"""`aquarium offsite` — encrypted copies in S3-compatible storage, against a fake box.

Same fake box as test_aquarium_cli.py (fake root, fake systemctl/docker, real gpg and tar).
The storage is a real local S3 server (moto), so uploads, listing, retention and downloads go
over HTTP with real signatures. Nothing may run before the owner saves a target.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import socket
import sys
from pathlib import Path

import pytest

boto3 = pytest.importorskip("boto3")
moto_server = pytest.importorskip("moto.server")

from test_aquarium_cli import Box, Handler, aq, released_box, server  # noqa: E402,F401

KEY_ID = "AKIATESTKEY1234"
SECRET = "s3cr3t-NEVER-SHOWN"


@pytest.fixture(scope="module")
def s3_url():
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = moto_server.ThreadedMotoServer(ip_address="127.0.0.1", port=port, verbose=False)
    srv.start()
    yield f"http://127.0.0.1:{port}"
    srv.stop()


@pytest.fixture
def bucket(s3_url):
    client = boto3.client("s3", endpoint_url=s3_url, region_name="us-east-1",
                          aws_access_key_id=KEY_ID, aws_secret_access_key=SECRET)
    name = f"b{hashlib.sha1(str(dt.datetime.now()).encode()).hexdigest()[:10]}"
    client.create_bucket(Bucket=name)
    return client, name


@pytest.fixture
def box(tmp_path, monkeypatch, server):  # noqa: F811
    b = Box(tmp_path, monkeypatch, server)
    Handler.routes["/health"] = Handler.routes["/bridge/health"]
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "unused")  # moto must not need real credentials
    return released_box(b)


def call(box, monkeypatch, capsys, *argv, stdin: str = "") -> tuple[int, dict]:
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO(stdin))
    code = box.run("offsite", *argv)
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")]
    return code, (json.loads(lines[-1]) if lines else {})


def settings(s3_url, bucket_name, **over) -> str:
    body = {"provider": "other", "endpoint": s3_url, "bucket": bucket_name, "key_id": KEY_ID,
            "secret": SECRET, "time": "03:00", "keep_days": 30}
    body.update(over)
    return json.dumps(body)


def configured(box, monkeypatch, capsys, s3_url, bucket_name, **over) -> dict:
    code, answer = call(box, monkeypatch, capsys, "configure", stdin=settings(s3_url, bucket_name, **over))
    assert code == 0 and answer["ok"], answer
    return answer


def objects(bucket) -> list[str]:
    client, name = bucket
    return sorted(o["Key"] for o in client.list_objects_v2(Bucket=name).get("Contents", []))


# ------------------------------------------------------------------ nothing runs before setup

def test_nothing_runs_before_a_target_is_saved(box, monkeypatch, capsys):
    code, st = call(box, monkeypatch, capsys, "status")
    assert code == 0 and st["configured"] is False
    before = box.log()
    for verb in ("run", "restore-test", "test"):
        code, answer = call(box, monkeypatch, capsys, verb)
        assert code == 1 and answer["ok"] is False and "no offsite storage" in answer["error"]
    assert "offsite" not in box.log()[len(before):]
    assert not list(box.p("/etc/systemd/system").glob("hermes-offsite-*"))
    assert not box.p("/etc/aquarium/offsite.env").exists()
    # the scheduled job itself also refuses without a target
    assert box.run("offsite", "run", "--foreground") == 1


def test_wrong_key_saves_nothing(box, monkeypatch, capsys, s3_url, bucket):
    code, answer = call(box, monkeypatch, capsys, "configure",
                        stdin=settings(s3_url, bucket[1], bucket="no-such-bucket-here"))
    assert code == 1 and "bucket was not found" in answer["error"]
    assert not box.p("/etc/aquarium/offsite.env").exists()
    assert not box.p("/etc/aquarium/offsite.json").exists()
    assert not list(box.p("/etc/systemd/system").glob("hermes-offsite-*"))
    assert SECRET not in json.dumps(answer)


@pytest.mark.parametrize("over,error", [
    ({"provider": "ftp"}, "choose where"),
    ({"bucket": "a"}, "bucket name"),
    ({"secret": ""}, "Secret key"),
    ({"secret": "has space"}, "Secret key"),
    ({"time": "3am"}, "03:00"),
    ({"keep_days": 0}, "1 to 3650"),
    ({"endpoint": ""}, "storage address"),
    ({"prefix": "../up"}, "folder name"),
])
def test_bad_settings_are_refused(box, monkeypatch, capsys, s3_url, bucket, over, error):
    code, answer = call(box, monkeypatch, capsys, "configure", stdin=settings(s3_url, bucket[1], **over))
    assert code == 1 and error in answer["error"]
    assert not box.p("/etc/aquarium/offsite.env").exists()


# ------------------------------------------------------------------ configure

def test_configure_keeps_keys_root_only_and_shows_the_backup_key_once(box, monkeypatch, capsys, s3_url, bucket):
    answer = configured(box, monkeypatch, capsys, s3_url, bucket[1])
    env = box.p("/etc/aquarium/offsite.env")
    assert env.stat().st_mode & 0o777 == 0o600
    assert SECRET in env.read_text()
    assert box.p("/etc/aquarium/offsite.json").stat().st_mode & 0o777 == 0o600
    status_file = box.p(aq.OFFSITE_STATUS)
    assert status_file.stat().st_mode & 0o777 == 0o640
    for text in (status_file.read_text(), box.p("/etc/aquarium/offsite.json").read_text(),
                 json.dumps(answer["status"])):
        assert SECRET not in text and KEY_ID not in text
    key = box.p("/etc/aquarium/backup.key").read_text().strip()
    assert answer["new_key"] == key
    assert answer["status"]["target"]["key_id_hint"] == "…1234"
    timer = box.p("/etc/systemd/system/hermes-offsite-backup.timer").read_text()
    assert "OnCalendar=*-*-* 03:00:00" in timer
    assert "enable --now hermes-offsite-backup.timer" in box.log()
    service = box.p("/etc/systemd/system/hermes-offsite-backup.service").read_text()
    assert "[Install]" not in service  # never "enabled", so `aquarium update` never restarts it
    assert "ExecStart=/usr/local/sbin/aquarium offsite run --foreground" in service
    assert objects(bucket) == []  # the access check cleans up after itself
    # saving again without retyping the secret keeps it, and the key is not shown again
    again = configured(box, monkeypatch, capsys, s3_url, bucket[1], secret="", keep_days=7,
                       schedule=False)
    assert "new_key" not in again
    assert SECRET in env.read_text()
    assert again["status"]["schedule"] == {"enabled": False, "time": "03:00", "keep_days": 7}
    assert "disable --now hermes-offsite-backup.timer" in box.log()


def test_existing_backup_key_is_reused_not_shown(box, monkeypatch, capsys, s3_url, bucket):
    assert box.run("backup") == 0  # the owner already used `aquarium backup`
    key = box.p("/etc/aquarium/backup.key").read_text()
    answer = configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert "new_key" not in answer
    assert box.p("/etc/aquarium/backup.key").read_text() == key


def test_b2_finds_its_s3_address_from_the_key(box, monkeypatch, capsys, s3_url, bucket):
    Handler.routes["/b2auth"] = (200, {"apiInfo": {"storageApi": {"s3ApiUrl": s3_url}}})
    monkeypatch.setattr(aq, "B2_AUTHORIZE_URL", box.url + "/b2auth")
    answer = configured(box, monkeypatch, capsys, s3_url, bucket[1], provider="b2", endpoint="")
    assert answer["status"]["target"]["endpoint"] == s3_url
    assert answer["status"]["target"]["provider"] == "b2"


def test_b2_rejected_key_is_explained(box, monkeypatch, capsys, s3_url, bucket):
    Handler.routes["/b2auth"] = (401, {"code": "unauthorized"})
    monkeypatch.setattr(aq, "B2_AUTHORIZE_URL", box.url + "/b2auth")
    code, answer = call(box, monkeypatch, capsys, "configure",
                        stdin=settings(s3_url, bucket[1], provider="b2", endpoint=""))
    assert code == 1 and "Backblaze did not accept the key" in answer["error"]


# ------------------------------------------------------------------ backup now

def test_back_up_now_starts_the_job_once(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    code, answer = call(box, monkeypatch, capsys, "run")
    assert code == 0 and answer["started"] is True
    assert "start --no-block hermes-offsite-backup.service" in box.log()
    assert answer["status"]["running"]["kind"] == "backup"
    code, answer = call(box, monkeypatch, capsys, "run")  # a second click does not start another
    assert code == 0 and answer["started"] is False
    assert box.log().count("start --no-block hermes-offsite-backup.service") == 1


def test_backup_is_encrypted_before_upload_and_has_the_database(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert box.run("offsite", "run", "--foreground") == 0
    keys = objects(bucket)
    assert len(keys) == 1 and keys[0].startswith("aquarium/aquarium-backup-") and keys[0].endswith("-offsite.tar.gz.gpg")
    raw = bucket[0].get_object(Bucket=bucket[1], Key=keys[0])["Body"].read()
    assert not raw.startswith(b"\x1f\x8b")  # not a plain gzip
    for secret in (b"TOPSECRETPW", b"sk-or-SECRET", SECRET.encode(), b"PGDMP"):
        assert secret not in raw
    copy = box.tmp / "copy.gpg"
    copy.write_bytes(raw)
    dest = box.tmp / "opened"
    dest.mkdir()
    manifest = aq.open_backup(copy, box.p("/etc/aquarium/backup.key"), dest)
    assert "db/postgres.dump" in manifest["files"] and manifest["db"]["tables"]["auth.users"] == 1
    st = json.loads(box.p(aq.OFFSITE_STATUS).read_text())
    assert st["running"] is None and st["last_good_backup"]["ok"] is True
    assert st["last_good_backup"]["name"] == keys[0].split("/")[-1] and st["copies"] == 1
    assert not list(box.p("/var/backups/aquarium/offsite").glob("*.gpg"))  # local copy removed


def test_failed_upload_is_reported_and_keeps_the_last_good_one(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert box.run("offsite", "run", "--foreground") == 0
    good = json.loads(box.p(aq.OFFSITE_STATUS).read_text())["last_good_backup"]
    for o in objects(bucket):
        bucket[0].delete_object(Bucket=bucket[1], Key=o)
    bucket[0].delete_bucket(Bucket=bucket[1])
    assert box.run("offsite", "run", "--foreground") == 1
    st = json.loads(box.p(aq.OFFSITE_STATUS).read_text())
    assert st["last_backup"]["ok"] is False and "bucket was not found" in st["last_backup"]["error"]
    assert st["last_good_backup"] == good and st["running"] is None


def test_retention_deletes_old_copies_but_never_the_newest(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1], keep_days=30)
    client, name = bucket
    old = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=40)).strftime("%Y%m%dT%H%M%SZ")
    recent = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=3)).strftime("%Y%m%dT%H%M%SZ")
    for stamp in (old, recent):
        client.put_object(Bucket=name, Key=f"aquarium/aquarium-backup-{stamp}-offsite.tar.gz.gpg", Body=b"x")
    client.put_object(Bucket=name, Key="aquarium/someone-elses-file.txt", Body=b"keep me")
    assert box.run("offsite", "run", "--foreground") == 0
    keys = objects(bucket)
    assert f"aquarium/aquarium-backup-{old}-offsite.tar.gz.gpg" not in keys
    assert f"aquarium/aquarium-backup-{recent}-offsite.tar.gz.gpg" in keys
    assert "aquarium/someone-elses-file.txt" in keys
    # only one very old copy left: it is the newest, so it stays
    conf = json.loads(box.p("/etc/aquarium/offsite.json").read_text())
    for k in keys:
        if k.endswith("-offsite.tar.gz.gpg") and old not in k:
            client.delete_object(Bucket=name, Key=k)
    client.put_object(Bucket=name, Key=f"aquarium/aquarium-backup-{old}-offsite.tar.gz.gpg", Body=b"x")
    assert aq.offsite_prune(aq.offsite_client(conf, aq.read_kv(box.p("/etc/aquarium/offsite.env"))), conf) == 0
    assert f"aquarium/aquarium-backup-{old}-offsite.tar.gz.gpg" in objects(bucket)


def test_big_backups_go_up_in_parts(box, monkeypatch, s3_url, bucket):
    monkeypatch.setattr(aq, "OFFSITE_PART", 5 * 2**20)
    big = box.tmp / "big.bin"
    big.write_bytes(b"a" * (5 * 2**20) + b"b" * (5 * 2**20) + b"tail")
    seen: list[int] = []
    client = aq.S3(s3_url, "us-east-1", bucket[1], KEY_ID, SECRET)
    client.upload("aquarium/big.bin", big, seen.append)
    assert seen[-1] == 100 and len(seen) >= 3
    body = bucket[0].get_object(Bucket=bucket[1], Key="aquarium/big.bin")["Body"].read()
    assert hashlib.sha256(body).hexdigest() == hashlib.sha256(big.read_bytes()).hexdigest()


# ------------------------------------------------------------------ restore test

def _tree_digest(root: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p).encode() + p.read_bytes())
    return h.hexdigest()


def test_restore_test_uses_a_scratch_copy_and_changes_nothing(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    code, answer = call(box, monkeypatch, capsys, "restore-test")
    assert code == 1 and "run a backup first" in answer["error"]
    assert box.run("offsite", "run", "--foreground") == 0
    live = _tree_digest(box.p("/opt/data")) + _tree_digest(box.p("/etc/aquarium"))
    before = box.log()
    code, answer = call(box, monkeypatch, capsys, "restore-test")
    assert code == 0 and "start --no-block hermes-offsite-restore-test.service" in box.log()
    assert box.run("offsite", "restore-test", "--foreground") == 0
    new = box.log()[len(before):]
    assert "CREATE DATABASE aquarium_restore_test" in new and "DROP DATABASE IF EXISTS aquarium_restore_test" in new
    assert "pg_restore -U supabase_admin -d aquarium_restore_test" in new
    assert "-d postgres --clean" not in new and "systemctl stop" not in new and "restart" not in new
    status_file = box.p(aq.OFFSITE_STATUS)
    st = json.loads(status_file.read_text())
    assert st["last_restore_test"]["ok"] is True and st["last_restore_test"]["tables"] == 2
    assert st["running"] is None
    # live data untouched (the status file is the only thing written), scratch space emptied
    status_file.unlink()
    assert _tree_digest(box.p("/opt/data")) + _tree_digest(box.p("/etc/aquarium")) == live
    assert not any(box.p("/var/backups/aquarium/restore-test").iterdir())


def test_restore_test_with_the_wrong_key_fails_safely(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert box.run("offsite", "run", "--foreground") == 0
    box.write("/etc/aquarium/backup.key", "a-different-key\n", mode=0o600)
    assert box.run("offsite", "restore-test", "--foreground") == 1
    st = json.loads(box.p(aq.OFFSITE_STATUS).read_text())
    assert st["last_restore_test"]["ok"] is False and "cannot" in st["last_restore_test"]["error"]
    assert not any(box.p("/var/backups/aquarium/restore-test").iterdir())


# ------------------------------------------------------------------ database through db-admin.env

FAKE_PG = r'''#!/bin/sh
echo "$(basename "$0") $* user=$PGUSER host=$PGHOST db=$PGDATABASE pw_set=${PGPASSWORD:+yes}" >> "$FAKE_CALLS"
case "$(basename "$0")" in
  pg_dump) cat "$FAKE_DUMP" ;;
  pg_dumpall) echo "-- globals" ;;
  psql) case "$*" in *COUNT*|*count*|*pg_stat*|*reltuples*|*FROM*) cat "$FAKE_COUNTS" ;; esac ;;
esac
'''


def test_database_outside_this_server_uses_the_owner_address(box, monkeypatch, capsys, s3_url, bucket):
    monkeypatch.setenv("FAKE_DB", "0")  # no local supabase-db container
    for name in ("pg_dump", "pg_dumpall", "psql", "pg_restore"):
        f = box.bin / name
        f.write_text(FAKE_PG)
        f.chmod(0o755)
    box.write("/etc/aquarium/db-admin.env",
              "HERMES_DB_ADMIN_URL=postgresql://postgres:OWNERPW%21@db.example.com:5432/postgres?sslmode=require\n",
              mode=0o600)
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert box.run("offsite", "run", "--foreground") == 0
    log = box.log()
    assert "pg_dump -Fc -d postgres user=postgres host=db.example.com db=postgres pw_set=yes" in log
    assert "OWNERPW" not in log  # the password goes in the environment, never on the command line
    raw = bucket[0].get_object(Bucket=bucket[1], Key=objects(bucket)[0])["Body"].read()
    copy = box.tmp / "c.gpg"
    copy.write_bytes(raw)
    dest = box.tmp / "o"
    dest.mkdir()
    manifest = aq.open_backup(copy, box.p("/etc/aquarium/backup.key"), dest)
    assert manifest["db"]["via"] == "db-admin.env" and "db/postgres.dump" in manifest["files"]
    assert box.run("offsite", "restore-test", "--foreground") == 0
    assert "CREATE DATABASE aquarium_restore_test" in box.log()


# ------------------------------------------------------------------ remove

def test_remove_stops_backups_and_keeps_results(box, monkeypatch, capsys, s3_url, bucket):
    configured(box, monkeypatch, capsys, s3_url, bucket[1])
    assert box.run("offsite", "run", "--foreground") == 0
    code, answer = call(box, monkeypatch, capsys, "remove")
    assert code == 0 and answer["ok"]
    assert "disable --now hermes-offsite-backup.timer" in box.log()
    assert not list(box.p("/etc/systemd/system").glob("hermes-offsite-*"))
    assert not box.p("/etc/aquarium/offsite.env").exists()
    code, st = call(box, monkeypatch, capsys, "status")
    assert st["configured"] is False and st["last_good_backup"]["ok"] is True
    assert len(objects(bucket)) == 1  # copies already in storage are left alone


def test_sudoers_rule_allows_only_the_offsite_verbs():
    rule = (Path(aq.__file__).parent / "sudoers.d" / "hermes-backup").read_text()
    cmds = [ln.split("NOPASSWD:", 1)[1].strip() for ln in rule.splitlines() if "NOPASSWD:" in ln]
    assert cmds == [f"/usr/local/sbin/aquarium offsite {v}"
                    for v in ("status", "configure", "test", "run", "restore-test", "remove")]
    assert not any("--foreground" in c or "*" in c for c in cmds)
