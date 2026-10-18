#!/usr/bin/env python3
"""Capture, render and audit the deployment state that git does not hold.

A long-lived Hermes deployment is more than its checkout. On the systest box
the checkout is 100% reproducible from `develop`, while everything that makes
it *that* deployment lives only on the disk:

    config.yaml          10 MCP servers, approval gates, model + memory wiring
    .env                 the secrets
    systemd units        the unprivileged `hermes` model, drop-ins, timers
    credential files     Google/WhatsApp/Canva tokens obtained interactively

Rebuild the box and the agent comes back mute. Worse, an edit to any of it —
by an operator, by a deploy step, or by the agent itself acting on a prompt —
leaves no trace anywhere a reviewer would look.

This script closes that gap without pretending the repo can own the file:

    capture   sanitize the live state into the repo, secrets replaced by
              ${PLACEHOLDER}. Review it as a PR. This is the normal loop.
              --secrets-out writes the values to a root-owned file so the
              rebuild path has something to render from.

    render    snapshot + a root-owned secrets file -> a real config.yaml.
              Used when rebuilding a box, never on a schedule.
    check     diff the live state against the committed snapshot and report.
              Never writes. Wired into the weekly drift timer.
    handover  report whether docs/deployment/README.md still describes this
              deployment. Prose is state too: the document that claims to say
              what is true of the live box went three deploys stale in silence.
              Drift means the deploy tooling it documents moved after it was
              last written — not merely that HEAD moved, which happens on
              every deploy and would make the check permanently red.

`check` is deliberately read-only, because Hermes itself rewrites config.yaml
(`/model` from Telegram, `hermes tools`, memory setup — ~30 call sites). A
scheme that treated the repo as authoritative and overwrote the file would
silently discard changes made from a phone. So the repo holds the reviewed
baseline, the box stays authoritative, and divergence becomes a report.

Where the captured state is kept is a separate decision from where this tool
lives. `--state-root` defaults to `deploy/` in this checkout, which is right
for a private repo; point it at a private clone when the repo holding the
tooling is public. A snapshot contains no credentials, but it does describe a
box in detail — account names, service layout, which identities are enrolled.

Exit codes: 0 clean, 1 drift found, 2 the state could not be read.

Usage:
  python scripts/deploy_state.py capture --deployment hermes-systest \
      --hermes-home /opt/data/hermes-home-staging --state-root /opt/data/deploy/state
  python scripts/deploy_state.py render  --deployment hermes-systest \
      --secrets /opt/data/deploy/state-secrets.env --out /tmp/config.yaml
  python scripts/deploy_state.py check   --deployment hermes-systest [--json]
  python scripts/deploy_state.py handover [--notify]
"""

from __future__ import annotations

import argparse
import grp
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys
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

DEPLOY_ROOT = REPO_ROOT / "deploy"
SNAPSHOT_NAME = "config.snapshot.yaml"
MANIFEST_NAME = "state.manifest.yaml"
SYSTEMD_DIRNAME = "systemd"

# Units to capture. `agent-home*` is here because it is the one service on the
# box not named `hermes-*` (FG-23 A0): with only the first pattern, the drift
# check cannot see the unit that serves the phone.
DEFAULT_UNIT_GLOBS = ("hermes-*", "agent-home*")

# Keys whose value is a credential regardless of what it looks like. Matched
# against the leaf key only, so `mcp_servers.github.headers.Authorization`
# hits and `tools.include` does not.
SECRET_KEY_RE = re.compile(
    r"(?i)(token|secret|password|api[_-]?key|credential|authorization|cookie"
    r"|access[_-]?key|client[_-]?id)"
)

# Keys that name a *location* for credentials rather than holding one.
# `WORKSPACE_MCP_CREDENTIALS_DIR` contains "credential" and is a path; turning
# it into a placeholder would move real configuration into the secrets file,
# where it stops being reviewable. Checked before SECRET_KEY_RE.
LOCATION_KEY_RE = re.compile(r"(?i)(_dir|_path|_home|_file|dir$|path$|home$)")

# Shapes that are credentials wherever they appear. This is the safety net:
# anything matching these must never reach the snapshot, whatever its key is
# called.
CREDENTIAL_SHAPES = re.compile(
    r"(ghp_[A-Za-z0-9]{16,}"
    r"|github_pat_[A-Za-z0-9_]{16,}"
    r"|gho_[A-Za-z0-9]{16,}"
    r"|sk-[A-Za-z0-9_-]{16,}"
    r"|GOCSPX-[A-Za-z0-9_-]{8,}"
    r"|ya29\.[A-Za-z0-9_-]{16,}"
    r"|1//[A-Za-z0-9_-]{16,}"
    r"|AKIA[0-9A-Z]{12,}"
    r"|xox[baprs]-[A-Za-z0-9-]{8,}"
    r"|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\."
    r"|postgres(?:ql)?://[^\s:]+:[^\s@]+@)"
)

PLACEHOLDER_RE = re.compile(r"\$\{([A-Z][A-Z0-9_]*)\}")

# The handover document claims, in its own first lines, which revision of the
# application it was verified against. Nothing made that claim true, so it went
# three deploys stale in silence — the same failure the rest of this script
# exists to report, applied to the prose. Parsed here so the claim is checked.
HANDOVER_DOC = Path("docs/deployment/README.md")
HANDOVER_RE = re.compile(
    r"^Last verified: (?P<date>\d{4}-\d{2}-\d{2}), "
    r"application at `(?P<revision>[0-9a-f]{7,40})`",
    re.MULTILINE,
)

# What the handover document actually describes. Staleness is "something the
# document explains changed after it was last written", not "HEAD moved" —
# every deploy moves HEAD, so the latter reports drift on every single deploy
# forever, including the deploy that ships the doc update itself. A check that
# is always red is a check nobody reads. A feature commit does not invalidate
# the box inventory; a change to the deploy tooling does.
HANDOVER_WATCHED = (
    "deploy",
    "scripts/deploy_state.py",
    "scripts/backup_secrets.py",
    "scripts/check_runtime_drift.py",
)

# Credentials are often carried with a scheme prefix. Keeping the prefix in
# the snapshot means the secrets file holds the secret and nothing else.
PREFIX_RE = re.compile(r"^(Bearer |Basic |token |Token )")


class StateError(Exception):
    """The deployment state could not be read or is internally inconsistent."""


def placeholder_name(path: tuple[str, ...]) -> str:
    """Derive a unique placeholder name from a config path.

    Path-derived rather than key-derived on purpose: three AWS servers each
    carry an ``AWS_SECRET_ACCESS_KEY`` for a *different* account, and
    collapsing them onto one name would render the wrong credential into two
    of the three.
    """
    joined = "_".join(str(part) for part in path)
    return re.sub(r"[^A-Za-z0-9]+", "_", joined).strip("_").upper()


def _split_prefix(value: str) -> tuple[str, str]:
    match = PREFIX_RE.match(value)
    return (match.group(1), value[match.end() :]) if match else ("", value)


def is_secret(leaf: str, value: str, known_values: dict[str, str]) -> bool:
    _, rest = _split_prefix(value)
    if not rest:
        return False
    if rest in known_values or CREDENTIAL_SHAPES.search(rest):
        return True
    return bool(
        SECRET_KEY_RE.search(str(leaf)) and not LOCATION_KEY_RE.search(str(leaf))
    )


def sanitize(
    config: Any, known_values: dict[str, str] | None = None
) -> tuple[Any, dict[str, str]]:
    """Return (snapshot, {placeholder: real value}) for *config*.

    *known_values* maps a secret value to the name it is known by elsewhere
    (typically the deployment's `.env`), which catches credentials whose key
    name gives nothing away — a `url:` holding a signed endpoint, say.
    """
    known = known_values or {}
    secrets: dict[str, str] = {}

    def walk(node: Any, path: tuple[str, ...]) -> Any:
        if isinstance(node, dict):
            return {key: walk(value, path + (str(key),)) for key, value in node.items()}
        if isinstance(node, list):
            return [walk(item, path + (str(index),)) for index, item in enumerate(node)]
        if isinstance(node, str) and path and is_secret(path[-1], node, known):
            prefix, rest = _split_prefix(node)
            name = placeholder_name(path)
            secrets[name] = rest
            return f"{prefix}${{{name}}}"
        return node

    snapshot = walk(config, ())
    return snapshot, secrets


def find_leaks(snapshot: Any, known_values: dict[str, str] | None = None) -> list[str]:
    """Return descriptions of credential material still present in *snapshot*.

    Called before anything is written to the repo. Sanitization is driven by
    heuristics, and a heuristic that quietly misses is how a token gets
    committed; this is the assertion that turns a miss into a failed run.
    """
    known = known_values or {}
    leaks: list[str] = []

    def walk(node: Any, path: tuple[str, ...]) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, path + (str(key),))
        elif isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, path + (str(index),))
        elif isinstance(node, str):
            where = ".".join(path) or "<root>"
            _, rest = _split_prefix(node)
            if CREDENTIAL_SHAPES.search(node):
                leaks.append(f"{where}: value matches a known credential shape")
            elif rest and rest in known:
                leaks.append(f"{where}: value equals the secret {known[rest]}")

    walk(snapshot, ())
    return leaks


def render(
    snapshot: Any, secrets: dict[str, str], managed: set[str] | None = None
) -> tuple[Any, list[str]]:
    """Substitute ``${NAME}`` placeholders in *snapshot* from *secrets*.

    Only names in *managed* (the manifest's ``config_secrets``, i.e. the ones
    `capture` introduced) are substituted. Hermes resolves ``${VAR}`` in
    config.yaml itself against `.env` — the live file really does contain
    ``dsn: ${DATABASE_URL}`` — and expanding that here would bake a secret
    into the file that the deployment was deliberately keeping out of it.

    Returns (config, missing names). A missing placeholder is reported rather
    than rendered as an empty string: a config.yaml with a blank API key
    starts a gateway that authenticates as nobody and fails at the first
    message.
    """
    missing: list[str] = []

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            return {key: walk(value) for key, value in node.items()}
        if isinstance(node, list):
            return [walk(item) for item in node]
        if isinstance(node, str):

            def substitute(match: re.Match[str]) -> str:
                name = match.group(1)
                if managed is not None and name not in managed:
                    return match.group(0)
                if name not in secrets:
                    missing.append(name)
                    return match.group(0)
                return secrets[name]

            return PLACEHOLDER_RE.sub(substitute, node)
        return node

    return walk(snapshot), sorted(set(missing))


def parse_env_file(text: str) -> dict[str, str]:
    """Parse ``KEY=value`` lines. Quotes stripped, comments and blanks skipped."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export ") :].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key:
            values[key] = value
    return values


def secret_env_values(env_values: dict[str, str]) -> dict[str, str]:
    """Map {value: env key} for the entries that are actually credentials.

    Using *every* `.env` value here looks safer and is worse: `AWS_REGION` and
    `READ_OPERATIONS_ONLY` hold `ap-east-1` and `true`, which also appear in
    config as ordinary settings. Matching on those turns real configuration
    into placeholders — it moves reviewable behaviour into the secrets file and
    leaves the snapshot unable to show that two AWS servers point at different
    regions. Short values are excluded for the same reason: a credential is
    never four characters long, but a flag often is.
    """
    return {
        value: name
        for name, value in env_values.items()
        if value
        and len(value) >= 8
        and SECRET_KEY_RE.search(name)
        and not LOCATION_KEY_RE.search(name)
    }


def file_facts(path: Path) -> dict[str, str]:
    info = path.lstat()
    return {
        "mode": oct(stat.S_IMODE(info.st_mode))[2:],
        "owner": f"{_user(info.st_uid)}:{_group(info.st_gid)}",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def _user(uid: int) -> str:
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def _group(gid: int) -> str:
    try:
        return grp.getgrgid(gid).gr_name
    except KeyError:
        return str(gid)


def facts_or_note(
    path: Path, component: str, findings: list[dict[str, str]]
) -> dict[str, str] | None:
    """`file_facts`, but an unreadable file is reported instead of fatal.

    The weekly check runs as the unprivileged `hermes` user by design, so it
    can meet a root-only file. Crashing there would take the whole report down
    — including the layers it *can* verify — over one file it was never meant
    to reach.
    """
    try:
        return file_facts(path)
    except PermissionError:
        findings.append({
            "severity": SEVERITY_NOTE,
            "component": component,
            "expected": "readable",
            "actual": "permission denied",
            "detail": f"cannot inspect {path} as {_user(os.geteuid())} — this "
            "layer is unverified. Make the file readable, or run this check as "
            "root",
        })
        return None


def flatten(node: Any, path: str = "") -> dict[str, Any]:
    """Flatten nested config into ``{dotted.path: scalar}`` for diffing.

    A dotted diff names the exact key that moved, which a YAML text diff does
    not: reordering `mcp_servers` rewrites half the file without changing the
    deployment at all.
    """
    flat: dict[str, Any] = {}
    if isinstance(node, dict):
        for key, value in node.items():
            flat.update(flatten(value, f"{path}.{key}" if path else str(key)))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            flat.update(flatten(item, f"{path}[{index}]"))
    else:
        flat[path] = node
    return flat


def diff_config(expected: Any, actual: Any) -> list[dict[str, str]]:
    """Findings for every key that differs between snapshot and live config."""
    want, have = flatten(expected), flatten(actual)
    findings: list[dict[str, str]] = []
    for key in sorted(set(want) | set(have)):
        if key not in have:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"config:{key}",
                "expected": str(want[key]),
                "actual": "absent",
                "detail": "in the committed snapshot but not on the box",
            })
        elif key not in want:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"config:{key}",
                "expected": "absent",
                "actual": str(have[key]),
                "detail": "on the box but not in the committed snapshot — "
                "run `deploy_state.py capture` and open a PR",
            })
        elif want[key] != have[key]:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"config:{key}",
                "expected": str(want[key]),
                "actual": str(have[key]),
                "detail": "value changed since the snapshot was captured",
            })
    return findings


def load_yaml(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def write_yaml(path: Path, document: Any, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        yaml.safe_dump(document, handle, sort_keys=False, default_flow_style=False)


def deployment_dir(deployment: str, state_root: Path | None = None) -> Path:
    return (state_root or DEPLOY_ROOT) / deployment


def load_manifest(deployment: str, state_root: Path | None = None) -> dict[str, Any]:
    path = deployment_dir(deployment, state_root) / MANIFEST_NAME
    if not path.is_file():
        raise StateError(f"no manifest at {path} — run `capture` on the box first")
    manifest = load_yaml(path)
    if not isinstance(manifest, dict):
        raise StateError(f"{path} is not a mapping")
    return manifest


def capture(
    deployment: str,
    hermes_home: Path,
    systemd_dir: Path,
    unit_globs: list[str],
    deploy_script: Path | None,
    credential_globs: list[str],
    secrets_out: Path | None = None,
    state_root: Path | None = None,
    allow_narrowing: bool = False,
) -> dict[str, Any]:
    """Write the sanitized snapshot, manifest and unit copies into the repo."""
    out = deployment_dir(deployment, state_root)
    if not allow_narrowing:
        lost = _narrowed_coverage(
            deployment,
            {
                "unit_globs": list(unit_globs),
                "credential_globs": list(credential_globs),
                "deploy_script": deploy_script,
                "secrets_file": secrets_out,
            },
            state_root,
        )
        if lost:
            raise StateError(
                "this capture would record less than the last one did, so the"
                " check would go on passing over things nobody is watching any"
                " more:\n  " + "\n  ".join(lost) + "\nPass the missing argument(s),"
                " or --allow-narrowing if the coverage is genuinely gone."
            )

    config_path = hermes_home / "config.yaml"
    env_path = hermes_home / ".env"

    env_values = (
        parse_env_file(env_path.read_text(encoding="utf-8"))
        if env_path.is_file()
        else {}
    )
    known = secret_env_values(env_values)

    snapshot, secrets = sanitize(load_yaml(config_path), known)
    leaks = find_leaks(snapshot, known)
    if leaks:
        raise StateError(
            "refusing to write a snapshot with credential material in it:\n  "
            + "\n  ".join(leaks)
        )

    units: dict[str, dict[str, str]] = {}
    unit_out = out / SYSTEMD_DIRNAME
    for name, unit in installed_units(systemd_dir, unit_globs).items():
        target = unit_out.joinpath(*name.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(unit.read_bytes())
        units[name] = {"sha256": file_facts(unit)["sha256"]}

    credentials: list[dict[str, str]] = []
    for pattern in credential_globs:
        for found in sorted(hermes_home.glob(pattern)):
            if found.is_file():
                facts = file_facts(found)
                credentials.append({
                    "path": str(found.relative_to(hermes_home)),
                    "mode": facts["mode"],
                    "owner": facts["owner"],
                })

    manifest: dict[str, Any] = {
        "deployment": deployment,
        "hermes_home": str(hermes_home),
        "systemd_dir": str(systemd_dir),
        "unit_globs": unit_globs,
        "env_keys": sorted(env_values),
        "config_secrets": sorted(secrets),
        "credential_globs": credential_globs,
        "credential_files": credentials,
        "units": units,
    }
    if secrets_out is not None:
        # Recorded so the offsite backup knows to include it without being told
        # twice; the path, not the contents.
        manifest["secrets_file"] = str(secrets_out)
    if deploy_script and deploy_script.is_file():
        manifest["deploy_script"] = {
            "installed_at": str(deploy_script),
            "repo_copy": "deploy/hermes-deploy.sh",
            "sha256": file_facts(deploy_script)["sha256"],
        }

    write_yaml(out / SNAPSHOT_NAME, snapshot)
    write_yaml(out / MANIFEST_NAME, manifest)

    if secrets_out is not None:
        descriptor = os.open(secrets_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(
                f"# Values for the ${{PLACEHOLDER}}s in deploy/{deployment}/"
                f"{SNAPSHOT_NAME}.\n# Never commit this file. Root-owned, 0600:"
                " the agent runs as an unprivileged\n# user and reads untrusted"
                " input, so a credential it can read is one an\n# injection can"
                " use.\n"
            )
            for name, value in sorted(secrets.items()):
                handle.write(f"{name}={value}\n")

    return {
        "snapshot": str(out / SNAPSHOT_NAME),
        "manifest": str(out / MANIFEST_NAME),
        "placeholders": sorted(secrets),
        "units": sorted(units),
        "credentials": [entry["path"] for entry in credentials],
        "secrets_out": str(secrets_out) if secrets_out else None,
    }


def _narrowed_coverage(
    deployment: str, coverage: dict[str, Any], state_root: Path | None
) -> list[str]:
    """What the previous manifest watched and this one would stop watching.

    Coverage is decided by the arguments on one long command line, and a
    forgotten one does not fail: it writes a smaller record, after which `check`
    reports "no drift" about a box it is no longer looking at. That happened —
    a capture run without `--credential-glob`/`--deploy-script`/`--secrets-out`
    silently dropped 15 credential files and the deploy script's hash, and the
    next check passed. Narrowing must be deliberate.
    """
    path = deployment_dir(deployment, state_root) / MANIFEST_NAME
    if not path.is_file():
        return []
    previous = load_yaml(path)
    if not isinstance(previous, dict):
        return []

    lost: list[str] = []
    for key, argument in (
        ("deploy_script", "--deploy-script"),
        ("secrets_file", "--secrets-out"),
    ):
        if previous.get(key) and not coverage.get(key):
            lost.append(f"{key}: recorded before, absent now — pass {argument}")
    for key, argument in (
        ("credential_globs", "--credential-glob"),
        ("unit_globs", "--unit-glob"),
    ):
        dropped = [
            str(pattern)
            for pattern in previous.get(key) or []
            if pattern not in (coverage.get(key) or [])
        ]
        if dropped:
            lost.append(
                f"{key}: no longer covers {', '.join(dropped)} — pass"
                f" {argument} for each"
            )
    return lost


def _unit_user(unit: Path) -> str | None:
    """The ``User=`` a unit declares, if it declares one.

    Reported with an unknown unit because that is the question worth asking
    first: `hermes-calendar-triage` was not merely uncaptured, it was the one
    process on the box running as root.
    """
    try:
        text = unit.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = re.search(r"^\s*User\s*=\s*(\S+)", text, re.M)
    return match.group(1) if match else None


def installed_units(
    systemd_dir: Path, unit_globs: list[str] | tuple[str, ...]
) -> dict[str, Path]:
    """Every matching unit and drop-in on the box, keyed as the manifest keys it.

    Shared by ``capture`` and ``check`` on purpose: the check's question is
    "what is installed that the snapshot does not know about", and it can only
    ask that if it enumerates the box exactly the way capture did.
    """
    found: dict[str, Path] = {}
    for pattern in unit_globs:
        for unit in sorted(systemd_dir.glob(pattern)):
            if unit.is_file():
                found[unit.name] = unit
        for dropin_dir in sorted(systemd_dir.glob(pattern + ".d")):
            for dropin in sorted(dropin_dir.glob("*.conf")):
                found[f"{dropin_dir.name}/{dropin.name}"] = dropin
    return found


def check(deployment: str, state_root: Path | None = None) -> list[dict[str, str]]:
    """Compare the live deployment against the committed snapshot."""
    manifest = load_manifest(deployment, state_root)
    out = deployment_dir(deployment, state_root)
    hermes_home = Path(str(manifest["hermes_home"]))
    findings: list[dict[str, str]] = []

    env_path = hermes_home / ".env"
    env_values = (
        parse_env_file(env_path.read_text(encoding="utf-8"))
        if env_path.is_file()
        else {}
    )
    known = secret_env_values(env_values)

    config_path = hermes_home / "config.yaml"
    if not config_path.is_file():
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": "config.yaml",
            "expected": "present",
            "actual": "absent",
            "detail": f"{config_path} does not exist — the deployment is unconfigured",
        })
    else:
        live_snapshot, _ = sanitize(load_yaml(config_path), known)
        findings += diff_config(load_yaml(out / SNAPSHOT_NAME), live_snapshot)

    expected_env = [str(key) for key in manifest.get("env_keys") or []]
    for key in expected_env:
        if key not in env_values:
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"env:{key}",
                "expected": "present",
                "actual": "absent",
                "detail": "a secret the manifest says this deployment needs is "
                "missing from .env",
            })
    for key in sorted(set(env_values) - set(expected_env)):
        findings.append({
            "severity": SEVERITY_NOTE,
            "component": f"env:{key}",
            "expected": "not in the manifest",
            "actual": "present",
            "detail": "new secret on the box — capture so a rebuild knows to ask "
            "for it",
        })

    for entry in manifest.get("credential_files") or []:
        target = hermes_home / str(entry["path"])
        if not target.is_file():
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"credential:{entry['path']}",
                "expected": "present",
                "actual": "absent",
                "detail": "an interactively-obtained credential is gone — the "
                "integration using it is silently broken",
            })
            continue
        facts = facts_or_note(target, f"credential:{entry['path']}", findings)
        if facts is None:
            continue
        for field in ("mode", "owner"):
            if str(entry.get(field)) != facts[field]:
                findings.append({
                    "severity": SEVERITY_DRIFT,
                    "component": f"credential:{entry['path']}:{field}",
                    "expected": str(entry.get(field)),
                    "actual": facts[field],
                    "detail": "credential permissions changed",
                })

    systemd_dir = Path(str(manifest["systemd_dir"]))
    expected_units = manifest.get("units") or {}

    # A unit the snapshot has never heard of is the failure this check was
    # written for: `hermes-calendar-triage` ran as root for weeks because it was
    # installed by hand, and every check passed — they all walked the manifest
    # and none of them asked the box what else was there.
    globs = [str(pattern) for pattern in manifest.get("unit_globs") or []]
    for name, unit in installed_units(
        systemd_dir, globs or list(DEFAULT_UNIT_GLOBS)
    ).items():
        if name in expected_units:
            continue
        facts = facts_or_note(unit, f"unit:{name}", findings)
        runs_as = _unit_user(unit) if facts is not None else None
        findings.append({
            "severity": SEVERITY_DRIFT,
            "component": f"unit:{name}",
            "expected": "in the snapshot",
            "actual": f"installed, runs as {runs_as or 'root (no User=)'}",
            "detail": "a unit nobody captured — it is not in the reviewed"
            " privilege model and a rebuild would not recreate it; capture it"
            " or remove it",
        })

    for name, expected in expected_units.items():
        installed = systemd_dir / name
        committed = out / SYSTEMD_DIRNAME / name
        if not installed.is_file():
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"unit:{name}",
                "expected": "installed",
                "actual": "absent",
                "detail": f"{installed} is missing — the service it runs is not "
                "defined on this box",
            })
            continue
        installed_facts = facts_or_note(installed, f"unit:{name}", findings)
        if installed_facts is None:
            continue
        actual_hash = installed_facts["sha256"]
        if actual_hash != str(expected.get("sha256")):
            reference = (
                "matches the repo copy"
                if committed.is_file()
                and hashlib.sha256(committed.read_bytes()).hexdigest() == actual_hash
                else "differs from the repo copy"
            )
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": f"unit:{name}",
                "expected": str(expected.get("sha256"))[:12],
                "actual": f"{actual_hash[:12]} ({reference})",
                "detail": "the installed unit changed since capture — service "
                "definitions are part of the privilege model",
            })

    script = manifest.get("deploy_script")
    if isinstance(script, dict):
        installed = Path(str(script["installed_at"]))
        repo_copy = REPO_ROOT / str(script["repo_copy"])
        if not installed.is_file():
            findings.append({
                "severity": SEVERITY_DRIFT,
                "component": "deploy-script",
                "expected": str(installed),
                "actual": "absent",
                "detail": "the deploy tool is not installed on this box",
            })
        elif repo_copy.is_file():
            script_facts = facts_or_note(installed, "deploy-script", findings)
            installed_hash = script_facts["sha256"] if script_facts else ""
            repo_hash = hashlib.sha256(repo_copy.read_bytes()).hexdigest()
            if script_facts is not None and installed_hash != repo_hash:
                findings.append({
                    "severity": SEVERITY_DRIFT,
                    "component": "deploy-script",
                    "expected": f"{repo_hash[:12]} ({script['repo_copy']})",
                    "actual": f"{installed_hash[:12]} ({installed})",
                    "detail": "the installed deploy script differs from the "
                    "reviewed copy in the repo",
                })

    return findings


def _git(root: Path, *args: str) -> str | None:
    """Run git in `root` and return stdout, or None if it could not be run.

    `safe.directory` because the checkout is owned by `hermes` while the deploy
    runs as root, and git ownership must not become the reason a check aborts.
    """
    command = [
        "git",
        "-c",
        f"safe.directory={root}",
        "-C",
        str(root),
        *args,
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=30, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def deployed_revision(repo_root: Path | None = None) -> str | None:
    """The revision this checkout is actually running, or None if unreadable."""
    return _git(repo_root or REPO_ROOT, "rev-parse", "HEAD") or None


def _last_commit(root: Path, paths: tuple[str, ...]) -> str | None:
    return _git(root, "log", "-1", "--format=%H", "--", *paths) or None


def _is_ancestor(root: Path, revision: str) -> bool:
    """Whether HEAD contains `revision` — False if git cannot say."""
    result = _git(root, "merge-base", "--is-ancestor", revision, "HEAD")
    return result is not None


def _describes_current_tooling(root: Path, doc_revision: str) -> list[str]:
    """Deployment-relevant paths changed after the doc was last written."""
    changed = _git(
        root, "diff", "--name-only", f"{doc_revision}..HEAD", "--", *HANDOVER_WATCHED
    )
    return [line for line in (changed or "").splitlines() if line]


def check_handover_doc(repo_root: Path | None = None) -> list[dict[str, str]]:
    """Report a handover document that no longer describes the deployment.

    The document is authoritative for "what is currently true of the live box",
    which makes it worthless the moment it is stale: an agent picking this up
    cold reads it as fact.

    Staleness is measured against the *tooling it documents*, not against HEAD.
    Requiring its `Last verified` sha to equal HEAD sounds stricter and is worse:
    every deploy moves HEAD, so it would report drift on every deploy forever —
    including the one that ships the doc update — and a check that is always red
    gets muted, which is how the doc went stale in the first place.

    For the same reason a revision behind HEAD with nothing documented changed
    since is *silent*, not a note. It used to be a note, and the note printed on
    every deploy for four days saying nothing was wrong; amber that never goes
    green is read as background colour, and then the red one is too. The one
    behind-HEAD case still worth saying out loud is a documented revision this
    checkout does not contain — that is a doc verified against something other
    than this line of history, and its claims cannot be placed at all.
    """
    root = repo_root or REPO_ROOT
    doc = root / HANDOVER_DOC
    if not doc.is_file():
        return [{
            "severity": SEVERITY_DRIFT,
            "component": "handover-doc",
            "expected": str(HANDOVER_DOC),
            "actual": "absent",
            "detail": "the document a cold pickup starts from is gone",
        }]

    match = HANDOVER_RE.search(doc.read_text(encoding="utf-8"))
    if match is None:
        return [{
            "severity": SEVERITY_DRIFT,
            "component": "handover-doc",
            "expected": "a `Last verified: YYYY-MM-DD, application at `<sha>`.` line",
            "actual": "no parseable claim",
            "detail": f"{HANDOVER_DOC} states no revision, so its freshness "
            "cannot be checked",
        }]

    documented = match.group("revision")
    live = deployed_revision(root)
    if live is None:
        return [{
            "severity": SEVERITY_NOTE,
            "component": "handover-doc",
            "expected": f"compare against {documented}",
            "actual": "checkout revision unreadable",
            "detail": "git could not report HEAD, so doc freshness is unknown",
        }]
    if live.startswith(documented):
        return []

    doc_revision = _last_commit(root, (str(HANDOVER_DOC),))
    if doc_revision is None:
        return [{
            "severity": SEVERITY_NOTE,
            "component": "handover-doc",
            "expected": f"a commit touching {HANDOVER_DOC}",
            "actual": "none in history",
            "detail": "the document is not committed, so its age is unknown",
        }]

    changed = _describes_current_tooling(root, doc_revision)
    if not changed:
        if _is_ancestor(root, documented):
            return []
        return [{
            "severity": SEVERITY_NOTE,
            "component": "handover-doc",
            "expected": f"a revision this checkout contains ({live[:9]} deployed)",
            "actual": f"{documented} (verified {match.group('date')})",
            "detail": "the documented revision is not in this history — the doc "
            "was verified against a different line of development, so nothing "
            "it claims can be placed against what is deployed",
        }]
    return [{
        "severity": SEVERITY_DRIFT,
        "component": "handover-doc",
        "expected": f"a document written after {', '.join(sorted(changed)[:4])}",
        "actual": f"{documented} (verified {match.group('date')})",
        "detail": f"{len(changed)} deployment path(s) changed since "
        f"{HANDOVER_DOC} was last written — re-verify it against the box and "
        "move its `Last verified` line forward",
    }]


def format_report(deployment: str, findings: list[dict[str, str]]) -> str:
    drift = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
    notes = [f for f in findings if f["severity"] == SEVERITY_NOTE]
    lines: list[str] = []
    if drift:
        lines.append(
            f"Deployment state drift on {os.uname().nodename} "
            f"({deployment}): {len(drift)} finding(s)"
        )
        for finding in drift:
            lines.append(
                f"  [drift] {finding['component']}: expected "
                f"{finding['expected']}, found {finding['actual']}"
            )
            lines.append(f"          {finding['detail']}")
    else:
        lines.append(
            f"No deployment state drift on {os.uname().nodename} ({deployment})"
        )
    for finding in notes:
        lines.append(f"  [note]  {finding['component']}: {finding['detail']}")
    return "\n".join(lines)


def _add_capture_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--hermes-home", type=Path, required=True)
    parser.add_argument("--systemd-dir", type=Path, default=Path("/etc/systemd/system"))
    # ``append`` with a non-empty default appends *to* the default, so an
    # explicit --unit-glob could only widen the capture, never narrow it.
    parser.add_argument(
        "--unit-glob",
        action="append",
        default=None,
        help="glob pattern for systemd units to capture (repeatable); "
        f"defaults to {' and '.join(DEFAULT_UNIT_GLOBS)}",
    )
    parser.add_argument("--deploy-script", type=Path, default=None)
    parser.add_argument(
        "--secrets-out",
        type=Path,
        default=None,
        help="also write the placeholder values here (mode 0600). This is the "
        "file `render` reads on a rebuild; it must never be committed",
    )
    parser.add_argument(
        "--credential-glob",
        action="append",
        default=None,
        help="glob under HERMES_HOME for credential files to inventory "
        "(repeatable); names and modes are recorded, never contents",
    )
    parser.add_argument(
        "--allow-narrowing",
        action="store_true",
        help="permit a capture that records less than the previous one — for "
        "when coverage is genuinely gone, not when an argument was forgotten",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    parser.add_argument("--json", action="store_true", help="emit findings as JSON")
    parser.add_argument(
        "--state-root",
        type=Path,
        default=DEPLOY_ROOT,
        help=f"directory holding the captured state (default: {DEPLOY_ROOT}). "
        "Point this at a private clone when this repo is public",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    capture_parser = subparsers.add_parser(
        "capture", help="write the sanitized live state into the repo"
    )
    capture_parser.add_argument("--deployment", required=True)
    _add_capture_args(capture_parser)

    render_parser = subparsers.add_parser(
        "render", help="snapshot + secrets file -> a real config.yaml"
    )
    render_parser.add_argument("--deployment", required=True)
    render_parser.add_argument("--secrets", type=Path, required=True)
    render_parser.add_argument("--out", type=Path, required=True)
    render_parser.add_argument(
        "--mode", default="600", help="permissions for the rendered file (default 600)"
    )

    check_parser = subparsers.add_parser(
        "check", help="report differences between the box and the snapshot"
    )
    check_parser.add_argument("--deployment", required=True)
    check_parser.add_argument(
        "--notify", action="store_true", help="Telegram on drift (silent otherwise)"
    )

    handover_parser = subparsers.add_parser(
        "handover",
        help="report whether the handover doc describes the deployed revision",
    )
    handover_parser.add_argument(
        "--notify", action="store_true", help="Telegram when stale (silent otherwise)"
    )

    args = parser.parse_args(argv)

    try:
        if args.command == "capture":
            result = capture(
                args.deployment,
                args.hermes_home,
                args.systemd_dir,
                args.unit_glob or list(DEFAULT_UNIT_GLOBS),
                args.deploy_script,
                args.credential_glob or [],
                args.secrets_out,
                args.state_root,
                args.allow_narrowing,
            )
            print(
                json.dumps(result, indent=2) if args.json else _capture_report(result)
            )
            return 0

        if args.command == "render":
            manifest = load_manifest(args.deployment, args.state_root)
            snapshot = load_yaml(
                deployment_dir(args.deployment, args.state_root) / SNAPSHOT_NAME
            )
            secrets = parse_env_file(args.secrets.read_text(encoding="utf-8"))
            config, missing = render(
                snapshot,
                secrets,
                {str(name) for name in manifest.get("config_secrets") or []},
            )
            if missing:
                print(
                    "error: "
                    f"{args.secrets} is missing {len(missing)} placeholder(s):\n  "
                    + "\n  ".join(missing)
                )
                return 2
            write_yaml(args.out, config, int(args.mode, 8))
            print(f"rendered {args.out} ({len(flatten(config))} keys)")
            return 0

        if args.command == "handover":
            findings = check_handover_doc()
            if not findings:
                print(f"handover doc current ({HANDOVER_DOC})")
                return 0
            report = "\n".join(
                f"handover doc "
                f"{'STALE' if f['severity'] == SEVERITY_DRIFT else 'note'}: "
                f"{f['actual']} != {f['expected']} — {f['detail']}"
                for f in findings
            )
            print(json.dumps(findings, indent=2) if args.json else report)
            drifted = any(f["severity"] == SEVERITY_DRIFT for f in findings)
            if args.notify and drifted:
                notify(report)
            return 1 if drifted else 0

        findings = check(args.deployment, args.state_root)
    except (StateError, OSError, yaml.YAMLError) as exc:
        print(f"error: {exc}")
        return 2

    report = format_report(args.deployment, findings)
    print(json.dumps(findings, indent=2) if args.json else report)
    drifted = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
    if getattr(args, "notify", False) and drifted:
        notify(report)
    return 1 if drifted else 0


def _capture_report(result: dict[str, Any]) -> str:
    return "\n".join([
        f"wrote {result['snapshot']}",
        f"wrote {result['manifest']}",
        f"  {len(result['placeholders'])} secret placeholder(s)",
        f"  {len(result['units'])} systemd file(s)",
        f"  {len(result['credentials'])} credential file(s) inventoried",
    ])


if __name__ == "__main__":
    sys.exit(main())
