#!/usr/bin/env python3
"""Encrypted offsite backup of the credentials a rebuild cannot regenerate.

`deploy_state.py` makes a box reproducible *except* for the material it
deliberately refuses to hold: `.env`, the interactively-obtained credential
files (Google Workspace tokens, WhatsApp pairings), and the secrets file
`render` reads. Those existed in exactly one place — the live disk — with the
"backups" sitting on that same disk, so any failure that lost the box lost them
too. A lost WhatsApp `creds.json` means re-pairing a phone; a lost Google token
means re-running consent for three accounts.

This closes that with a bundle the box can write but **cannot read**:

    backup    tar the files the state manifest says this deployment needs,
              pipe it through `age` to a *public* recipient, write the
              ciphertext into a private git repo and push.
    verify    is there a recent bundle, and does it cover everything the
              manifest requires? Reads no plaintext; safe to run unprivileged
              from the weekly drift check.
    restore   decrypt a bundle with the private key into a directory, and put
              the recorded modes and owners back.

Public-key encryption is the point. The box holds one `age1...` recipient, so
a compromised box can add backups but cannot decrypt any of them, including its
own history. The private key lives in a password manager, off the box. Losing
it means losing the backups — that is the trade being made.

Plaintext never touches the disk: the tar is built in memory and streamed into
`age` on stdin. The ciphertext is committed with an index recording *paths*
only (already known from the state repo) plus one aggregate digest, so an
unchanged secret set does not produce a new bundle every night.

Exit codes: 0 ok, 1 stale or incomplete coverage, 2 could not run.

Usage:
  sudo python scripts/backup_secrets.py backup --deployment hermes-systest \\
      --state-root /opt/data/hermes-deploy-state \\
      --repo /opt/data/hermes-deploy-backups --push
  python scripts/backup_secrets.py verify --deployment hermes-systest \\
      --state-root /opt/data/hermes-deploy-state \\
      --repo /opt/data/hermes-deploy-backups --max-age-days 8
  python scripts/backup_secrets.py restore --bundle <file.age> \\
      --identity ~/hermes-backup-key.txt --out /tmp/restore
"""

from __future__ import annotations

import argparse
import grp
import hashlib
import io
import json
import os
import pwd
import subprocess
import sys
import tarfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
# Appended, not prepended: root runs these, and a stray module at the repo root
# must never shadow the stdlib or site-packages (F15). Run with `python -I`.
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))

from scripts.check_runtime_drift import (  # noqa: E402  (needs REPO_ROOT on the path)
    SEVERITY_DRIFT,
    SEVERITY_NOTE,
    notify,
)
from scripts.deploy_state import (  # noqa: E402
    MANIFEST_NAME,
    StateError,
    _user,
    deployment_dir,
    load_yaml,
)

INDEX_NAME = "index.yaml"
BUNDLE_SUFFIX = ".tar.gz.age"
INNER_MANIFEST = "MANIFEST.yaml"
# age's binary header. Checked so a bundle that is somehow plaintext is caught
# here rather than discovered by whoever reads the repo.
AGE_MAGIC = b"age-encryption.org/v1"


def _owner(path: Path) -> str:
    info = path.stat()
    try:
        user = pwd.getpwuid(info.st_uid).pw_name
    except KeyError:
        user = str(info.st_uid)
    try:
        group = grp.getgrgid(info.st_gid).gr_name
    except KeyError:
        group = str(info.st_gid)
    return f"{user}:{group}"


def members(
    deployment: str, state_root: Path, hermes_home: Path | None = None
) -> list[Path]:
    """The files worth backing up, taken from the state manifest.

    Driven by the manifest rather than a hardcoded list so a credential added
    to the deployment is backed up as soon as it is captured — the two stay in
    step by construction.
    """
    manifest_path = deployment_dir(deployment, state_root) / MANIFEST_NAME
    if not manifest_path.is_file():
        raise StateError(
            f"no manifest at {manifest_path} — run `deploy_state.py capture` first"
        )
    manifest = load_yaml(manifest_path)
    if not isinstance(manifest, dict):
        raise StateError(f"{manifest_path} is not a mapping")

    home = hermes_home or Path(str(manifest["hermes_home"]))
    paths = [home / ".env"]
    for entry in manifest.get("credential_files") or []:
        paths.append(home / str(entry["path"]))

    secrets = manifest.get("secrets_file")
    if secrets:
        paths.append(Path(str(secrets)))
    return paths


def build_tar(paths: list[Path]) -> tuple[bytes, str, list[dict[str, str]]]:
    """Tar the given files in memory, with an inner manifest of modes/owners.

    Deterministic (sorted, zeroed timestamps and ids) so an unchanged secret
    set produces an identical digest — which is what lets `backup` skip writing
    a bundle when nothing has changed. Real modes and owners travel in
    ``MANIFEST.yaml`` inside the archive, where `restore` can put them back and
    nothing outside the ciphertext reveals them.
    """
    inventory: list[dict[str, str]] = []
    payload = io.BytesIO()
    ordered: list[Path] = sorted(set(paths))
    with tarfile.open(fileobj=payload, mode="w:gz", compresslevel=9) as archive:
        for path in ordered:
            if not path.is_file():
                continue
            data = path.read_bytes()
            record = {
                "path": str(path),
                "mode": oct(path.stat().st_mode & 0o777)[2:],
                "owner": _owner(path),
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": str(len(data)),
            }
            inventory.append(record)
            info = tarfile.TarInfo(name=str(path).lstrip("/"))
            info.size = len(data)
            info.mtime = 0
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(data))

        manifest = yaml.safe_dump(
            {"files": inventory}, sort_keys=False, default_flow_style=False
        ).encode()
        info = tarfile.TarInfo(name=INNER_MANIFEST)
        info.size = len(manifest)
        info.mtime = 0
        info.mode = 0o600
        archive.addfile(info, io.BytesIO(manifest))

    digest = hashlib.sha256(
        "".join(
            f"{r['path']}:{r['mode']}:{r['owner']}:{r['sha256']}\n" for r in inventory
        ).encode()
    ).hexdigest()
    return payload.getvalue(), digest, inventory


def encrypt(plaintext: bytes, recipient: str) -> bytes:
    """Stream the tar through `age` to a public recipient.

    stdin/stdout only — the plaintext is never a file, so there is nothing to
    shred and nothing to leave behind if this dies halfway.
    """
    try:
        result = subprocess.run(
            ["age", "--recipient", recipient],
            input=plaintext,
            capture_output=True,
            check=True,
        )
    except FileNotFoundError:
        raise StateError("age is not installed — `apt-get install age`") from None
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode(errors="replace").strip()
        raise StateError(f"age failed: {detail}") from None
    if not result.stdout.startswith(AGE_MAGIC):
        raise StateError(
            "age produced something that is not an age file — refusing to write it"
        )
    return result.stdout


def read_index(repo: Path, deployment: str) -> dict[str, Any]:
    path = repo / deployment / INDEX_NAME
    if not path.is_file():
        return {}
    index = load_yaml(path)
    return index if isinstance(index, dict) else {}


def write_index(repo: Path, deployment: str, index: dict[str, Any]) -> Path:
    path = repo / deployment / INDEX_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        yaml.safe_dump(index, handle, sort_keys=False, default_flow_style=False)
    return path


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        raise StateError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def prune(directory: Path, keep: int) -> list[Path]:
    """Drop old bundles from the working tree. Git history keeps them all."""
    bundles = sorted(directory.glob(f"*{BUNDLE_SUFFIX}"), key=lambda p: p.name)
    removed = bundles[:-keep] if keep > 0 and len(bundles) > keep else []
    for bundle in removed:
        bundle.unlink()
    return removed


def backup(
    deployment: str,
    state_root: Path,
    repo: Path,
    recipient: str,
    hermes_home: Path | None = None,
    push: bool = False,
    keep: int = 14,
    force: bool = False,
) -> dict[str, Any]:
    paths = members(deployment, state_root, hermes_home)
    plaintext, digest, inventory = build_tar(paths)
    if not inventory:
        raise StateError("nothing to back up — none of the manifest's files exist")

    index = read_index(repo, deployment)
    if not force and index.get("content_digest") == digest:
        return {"unchanged": True, "digest": digest, "files": len(inventory)}

    ciphertext = encrypt(plaintext, recipient)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    target = repo / deployment / f"{stamp}{BUNDLE_SUFFIX}"
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(ciphertext)

    write_index(
        repo,
        deployment,
        {
            "deployment": deployment,
            "latest": target.name,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "recipient": recipient,
            "content_digest": digest,
            "files": [record["path"] for record in inventory],
            "ciphertext_bytes": len(ciphertext),
        },
    )
    removed = prune(target.parent, keep)

    result: dict[str, Any] = {
        "unchanged": False,
        "bundle": str(target),
        "digest": digest,
        "files": len(inventory),
        "pruned": [path.name for path in removed],
    }
    if push:
        git(repo, "add", "--all", deployment)
        git(
            repo,
            "-c",
            "user.name=hermes-backup",
            "-c",
            "user.email=hermes@localhost",
            "commit",
            "-m",
            f"backup({deployment}): {stamp} — {len(inventory)} files",
        )
        git(repo, "push", "origin", "HEAD")
        result["pushed"] = git(repo, "rev-parse", "--short", "HEAD")
    return result


def offsite(repo: Path, deployment: str) -> list[dict[str, str]]:
    """Has the latest bundle actually left the box?

    A bundle written but not pushed is on the same disk as the secrets it
    protects, which is the situation this tool exists to end — so `verify` must
    not count a local file as an offsite backup.
    """
    try:
        git(repo, "rev-parse", "--git-dir")
    except StateError:
        return [
            {
                "severity": SEVERITY_DRIFT,
                "component": "backup:offsite",
                "expected": f"{repo} is a clone of the private backup repo",
                "actual": "not a git repository",
                "detail": "bundles are being written to the box's own disk and "
                "going nowhere — clone the backup repo over its deploy key",
            }
        ]
    try:
        uncommitted = git(repo, "status", "--porcelain", "--", deployment)
        # Remote-tracking refs move on push, and unlike @{upstream} they do not
        # depend on tracking configuration that `git push origin HEAD` never sets.
        remotes = git(repo, "branch", "--remotes", "--contains", "HEAD")
    except StateError as error:
        return [
            {
                "severity": SEVERITY_NOTE,
                "component": "backup:offsite",
                "expected": "a readable git clone",
                "actual": "git refused",
                "detail": f"cannot confirm the bundles reached the remote: {error}",
            }
        ]
    findings: list[dict[str, str]] = []
    if uncommitted:
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup:offsite",
            "expected": "the latest bundle committed",
            "actual": f"{len(uncommitted.splitlines())} uncommitted path(s)",
            "detail": "a bundle was written but never committed — run `backup "
            "--push`, and check the push credential if it keeps happening",
        })
    if not remotes:
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup:offsite",
            "expected": "HEAD present on a remote branch",
            "actual": "local only",
            "detail": "the commits exist only on the box — the push is failing, "
            "so nothing is actually offsite",
        })
    return findings


def verify(
    deployment: str,
    state_root: Path,
    repo: Path,
    max_age_days: int = 8,
    hermes_home: Path | None = None,
) -> list[dict[str, str]]:
    """Is there a recent bundle, and does it cover what the manifest requires?

    Reads only the index and the ciphertext header, so the weekly check can run
    this as the unprivileged user without any access to the secrets themselves.
    """
    findings: list[dict[str, str]] = offsite(repo, deployment)
    index = read_index(repo, deployment)
    if not index:
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup",
            "expected": f"an index at {repo / deployment / INDEX_NAME}",
            "actual": "absent",
            "detail": "no offsite backup has ever been written for this deployment",
        })
        return findings

    bundle = repo / deployment / str(index.get("latest", ""))
    if not bundle.is_file():
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup:bundle",
            "expected": str(bundle),
            "actual": "absent",
            "detail": "the index names a bundle that is not in the repo",
        })
    elif bundle.read_bytes()[: len(AGE_MAGIC)] != AGE_MAGIC:
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup:bundle",
            "expected": "age-encrypted",
            "actual": "not an age file",
            "detail": "refuse to trust this bundle — it may be plaintext",
        })

    created = str(index.get("created_at", ""))
    try:
        age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(created)).days
    except ValueError:
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "backup:created_at",
            "expected": "an ISO timestamp",
            "actual": created or "missing",
            "detail": "cannot tell how old the backup is",
        })
    else:
        if age_days > max_age_days:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": "backup:age",
                "expected": f"newer than {max_age_days} days",
                "actual": f"{age_days} days old",
                "detail": "the backup timer is not running, or it is failing — "
                "secrets added since then exist only on the box",
            })

    covered = set(index.get("files") or [])
    for path in members(deployment, state_root, hermes_home):
        try:
            present = path.is_file()
        except PermissionError:
            # By design: `verify` runs as the unprivileged checker, and the
            # secrets file is root-only. Say the layer is unverified rather than
            # taking the whole report down over a file it may not reach.
            findings.append({
                "severity": SEVERITY_NOTE,
                "component": f"backup:coverage:{path.name}",
                "expected": "visible to this user",
                "actual": "permission denied",
                "detail": f"cannot tell whether {path} is backed up as "
                f"{_user(os.geteuid())} — run this check as root to include it",  # windows-footgun: ok — Linux-server-only code
            })
            continue
        if not present:
            continue
        if str(path) not in covered:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"backup:coverage:{path.name}",
                "expected": "in the backup",
                "actual": "not in the latest bundle",
                "detail": f"{path} exists on the box but no backup holds it — "
                "run `backup_secrets.py backup`",
            })
    for path in sorted(
        covered - {str(p) for p in members(deployment, state_root, hermes_home)}
    ):
        findings.append({
            "severity": SEVERITY_NOTE,
            "component": f"backup:extra:{Path(path).name}",
            "expected": "in the manifest",
            "actual": "in the backup only",
            "detail": "backed up but no longer required by the manifest — "
            "harmless, and worth knowing before a restore puts it back",
        })
    return findings


def restore(bundle: Path, identity: Path, out: Path) -> list[dict[str, str]]:
    """Decrypt into `out`, preserving the recorded modes and owners.

    Restores under a directory rather than over the live paths: a restore is
    usually a rebuild or an inspection, and silently overwriting a working
    deployment's credentials is not a thing this should make easy.
    """
    try:
        result = subprocess.run(
            ["age", "--decrypt", "--identity", str(identity), str(bundle)],
            capture_output=True,
            check=True,
        )
    except FileNotFoundError:
        raise StateError("age is not installed — `apt-get install age`") from None
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode(errors="replace").strip()
        raise StateError(f"age could not decrypt {bundle}: {detail}") from None

    written: list[dict[str, str]] = []
    with tarfile.open(fileobj=io.BytesIO(result.stdout), mode="r:gz") as archive:
        manifest_member = archive.extractfile(INNER_MANIFEST)
        if manifest_member is None:
            raise StateError(f"{bundle} has no {INNER_MANIFEST}")
        inner = yaml.safe_load(manifest_member.read()) or {}
        recorded = {str(item["path"]): item for item in inner.get("files") or []}

        for member in archive.getmembers():
            if member.name == INNER_MANIFEST:
                continue
            source = archive.extractfile(member)
            if source is None:
                continue
            target = out / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(source.read())

            entry = recorded.get("/" + member.name, {})
            mode = str(entry.get("mode", "600"))
            os.chmod(target, int(mode, 8))
            owner = str(entry.get("owner", ""))
            if owner and os.geteuid() == 0:  # windows-footgun: ok — Linux-server-only code
                user, _, group = owner.partition(":")
                try:
                    os.chown(
                        target, pwd.getpwnam(user).pw_uid, grp.getgrnam(group).gr_gid
                    )
                except KeyError:
                    pass
            written.append({"path": str(target), "mode": mode, "owner": owner})
    return written


def format_report(deployment: str, findings: list[dict[str, str]]) -> str:
    drift = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
    notes = [f for f in findings if f["severity"] == SEVERITY_NOTE]
    head = (
        f"Offsite backup is stale or incomplete on {deployment} — "
        f"{len(drift)} finding(s)"
        if drift
        else f"Offsite backup on {deployment} is current"
    )
    lines = [head]
    for finding in drift + notes:
        marker = "!" if finding["severity"] == SEVERITY_DRIFT else "[note]"
        lines.append(f"  {marker} {finding['component']}: {finding['detail']}")
        lines.append(f"      expected {finding['expected']}, found {finding['actual']}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--state-root", type=Path, help="the private state store")
    parser.add_argument("--repo", type=Path, help="the private backup repo on this box")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("backup", help="write an encrypted bundle")
    run.add_argument("--deployment", required=True)
    run.add_argument(
        "--recipient", help="age public key; defaults to $HERMES_BACKUP_RECIPIENT"
    )
    run.add_argument("--hermes-home", type=Path)
    run.add_argument("--push", action="store_true")
    run.add_argument("--keep", type=int, default=14)
    run.add_argument(
        "--force", action="store_true", help="write even if nothing changed"
    )

    audit = sub.add_parser("verify", help="check freshness and coverage")
    audit.add_argument("--deployment", required=True)
    audit.add_argument("--hermes-home", type=Path)
    audit.add_argument("--max-age-days", type=int, default=8)
    audit.add_argument("--json", action="store_true")
    audit.add_argument("--notify", action="store_true")

    back = sub.add_parser("restore", help="decrypt a bundle into a directory")
    back.add_argument("--bundle", type=Path, required=True)
    back.add_argument("--identity", type=Path, required=True)
    back.add_argument("--out", type=Path, required=True)

    args = parser.parse_args(argv)

    try:
        if args.command == "backup":
            recipient = args.recipient or os.environ.get("HERMES_BACKUP_RECIPIENT", "")
            if not recipient.startswith("age1"):
                raise StateError(
                    "need an age recipient — pass --recipient age1... or set "
                    "HERMES_BACKUP_RECIPIENT"
                )
            result = backup(
                args.deployment,
                args.state_root,
                args.repo,
                recipient,
                hermes_home=args.hermes_home,
                push=args.push,
                keep=args.keep,
                force=args.force,
            )
            if result["unchanged"]:
                print(
                    f"secrets unchanged since the last bundle ({result['files']} files)"
                )
            else:
                print(f"wrote {result['bundle']} ({result['files']} files)")
                for name in result["pruned"]:
                    print(f"  pruned {name}")
                if "pushed" in result:
                    print(f"  pushed {result['pushed']}")
            return 0

        if args.command == "verify":
            findings = verify(
                args.deployment,
                args.state_root,
                args.repo,
                max_age_days=args.max_age_days,
                hermes_home=args.hermes_home,
            )
            drifted = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
            report = format_report(args.deployment, findings)
            print(json.dumps(findings, indent=2) if args.json else report)
            if args.notify and drifted:
                notify(report)
            return 1 if drifted else 0

        written = restore(args.bundle, args.identity, args.out)
        for item in written:
            print(f"restored {item['path']} ({item['mode']} {item['owner']})")
        return 0
    except StateError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
