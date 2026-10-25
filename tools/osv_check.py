"""OSV malware check for MCP extension packages.

Before launching an MCP server via npx/uvx, queries the OSV (Open Source
Vulnerabilities) API to check if the package has any known malware advisories
(MAL-* IDs).  Regular CVEs are ignored — only confirmed malware is blocked.

The API is free, public, and maintained by Google.  Typical latency is ~300ms.
Fail-open: network errors allow the package to proceed.

``check_lockfile`` is the other mode, for FG-33 local apps: it checks every
package in a committed ``package-lock.json`` and is fail-closed (a missing or
unpinned lockfile, a package outside the npm registry, an OSV error or an
incomplete answer all refuse). The root build gate in
``deploy/aquarium-app-egress`` applies the same rules (a parity test pins them).

Inspired by Block/goose's extension malware check.
"""

import json
import logging
import os
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from typing import Optional, Tuple, Union

logger = logging.getLogger(__name__)

_OSV_ENDPOINT = os.getenv("OSV_ENDPOINT", "https://api.osv.dev/v1/query")
_TIMEOUT = 10  # seconds
_OSV_BATCH_ENDPOINT = "https://api.osv.dev/v1/querybatch"
_OSV_BATCH = 1000
_NPM_REGISTRY = "https://registry.npmjs.org/"
_NPM_NAME_RE = re.compile(r"^(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9._~-][a-z0-9._~-]*$", re.I)
_VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,64}$")
MAX_LOCK_PACKAGES = 3000
MAX_LOCK_BYTES = 20 * 1024 * 1024


def check_package_for_malware(
    command: str, args: list
) -> Optional[str]:
    """Check if an MCP server package has known malware advisories.

    Inspects the *command* (e.g. ``npx``, ``uvx``) and *args* to infer the
    package name and ecosystem.  Queries the OSV API for MAL-* advisories.

    Returns:
        An error message string if malware is found, or None if clean/unknown.
        Returns None (allow) on network errors or unrecognized commands.
    """
    ecosystem = _infer_ecosystem(command)
    if not ecosystem:
        return None  # not npx/uvx — skip

    package, version = _parse_package_from_args(args, ecosystem)
    if not package:
        return None

    try:
        malware = _query_osv(package, ecosystem, version)
    except Exception as exc:
        # Fail-open: network errors, timeouts, parse failures → allow
        logger.debug("OSV check failed for %s/%s (allowing): %s", ecosystem, package, exc)
        return None

    if malware:
        ids = ", ".join(m["id"] for m in malware[:3])
        summaries = "; ".join(
            m.get("summary", m["id"])[:100] for m in malware[:3]
        )
        return (
            f"BLOCKED: Package '{package}' ({ecosystem}) has known malware "
            f"advisories: {ids}. Details: {summaries}"
        )
    return None


def _infer_ecosystem(command: str) -> Optional[str]:
    """Infer package ecosystem from the command name."""
    base = os.path.basename(command).lower()
    if base in {"npx", "npx.cmd"}:
        return "npm"
    if base in {"uvx", "uvx.cmd", "pipx"}:
        return "PyPI"
    return None


def _parse_package_from_args(
    args: list, ecosystem: str
) -> Tuple[Optional[str], Optional[str]]:
    """Extract package name and optional version from command args.

    Returns (package_name, version) or (None, None) if not parseable.
    """
    if not args:
        return None, None

    # Skip flags to find the package token.
    # Honor npx's explicit install target: --package=NAME / --package NAME and
    # the -p NAME short form, which name a package distinct from the executed
    # binary. Without this the first bare positional (often the command name)
    # is mistaken for the package.
    package_token = None
    take_next = False
    for arg in args:
        if not isinstance(arg, str):
            continue
        if take_next:
            package_token = arg
            break
        if arg in ("--package", "-p"):
            take_next = True
            continue
        if arg.startswith("--package="):
            package_token = arg[len("--package="):]
            break
        if arg.startswith("-"):
            continue
        package_token = arg
        break

    if not package_token:
        return None, None

    if ecosystem == "npm":
        return _parse_npm_package(package_token)
    elif ecosystem == "PyPI":
        return _parse_pypi_package(package_token)
    return package_token, None


def _parse_npm_package(token: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse npm package: @scope/name@version or name@version."""
    if token.startswith("@"):
        # Scoped: @scope/name@version
        match = re.match(r"^(@[^/]+/[^@]+)(?:@(.+))?$", token)
        if match:
            return match.group(1), match.group(2)
        return token, None
    # Unscoped: name@version
    if "@" in token:
        parts = token.rsplit("@", 1)
        name = parts[0]
        version = parts[1] if len(parts) > 1 and parts[1] != "latest" else None
        return name, version
    return token, None


def _parse_pypi_package(token: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse PyPI package: name==version or name[extras]==version."""
    # Strip extras: name[extra1,extra2]==version
    match = re.match(r"^([a-zA-Z0-9._-]+)(?:\[[^\]]*\])?(?:==(.+))?$", token)
    if match:
        return match.group(1), match.group(2)
    return token, None


def _query_osv(
    package: str, ecosystem: str, version: Optional[str] = None
) -> list:
    """Query the OSV API for MAL-* advisories. Returns list of malware vulns."""
    payload = {"package": {"name": package, "ecosystem": ecosystem}}
    if version:
        payload["version"] = version

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _OSV_ENDPOINT,
        data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "hermes-agent-osv-check/1.0",
        },
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        result = json.loads(resp.read())

    vulns = result.get("vulns", [])
    # Only malware advisories — ignore regular CVEs
    return [v for v in vulns if v.get("id", "").startswith("MAL-")]


# ---------------------------------------------------------------------------
# Fail-closed lockfile mode (FG-33 local apps)
# ---------------------------------------------------------------------------


@dataclass
class LockfileVerdict:
    """Result of :func:`check_lockfile`; ``ok`` is False unless everything passed."""

    ok: bool
    reasons: list = field(default_factory=list)
    malware: list = field(default_factory=list)
    packages: int = 0


def lockfile_findings(lock, max_packages: int = MAX_LOCK_PACKAGES):
    """(reasons, sorted [(name, version)]) for a parsed package-lock.json.

    Any reason means the lockfile is refused before OSV is asked."""
    reasons, pkgs = [], set()
    if not isinstance(lock, dict) or lock.get("lockfileVersion") not in (2, 3):
        return ["package-lock.json must be lockfileVersion 2 or 3 (npm 7+)"], []
    packages = lock.get("packages")
    if not isinstance(packages, dict):
        return ["package-lock.json has no packages map"], []
    entries = [(k, v) for k, v in packages.items() if k != ""]
    if len(entries) > max_packages:
        reasons.append(f"{len(entries)} packages exceed the ceiling of {max_packages}")
    for key, entry in entries:
        if not isinstance(entry, dict) or not isinstance(key, str) or "node_modules/" not in key:
            reasons.append(f"{str(key)[:80]}: not an installed package (workspaces/links are not allowed)")
            continue
        name = entry.get("name") or key.rsplit("node_modules/", 1)[1]
        version = entry.get("version")
        if entry.get("link"):
            reasons.append(f"{name}: linked packages are not allowed")
            continue
        if not isinstance(name, str) or not _NPM_NAME_RE.fullmatch(name) or \
                not isinstance(version, str) or not _VERSION_RE.fullmatch(version):
            reasons.append(f"{str(key)[:80]}: missing or invalid name/version")
            continue
        if not entry.get("inBundle"):
            resolved, integrity = entry.get("resolved"), entry.get("integrity")
            if not isinstance(resolved, str) or not resolved.startswith(_NPM_REGISTRY):
                reasons.append(f"{name}@{version}: resolved outside {_NPM_REGISTRY}")
            if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
                reasons.append(f"{name}@{version}: no sha512 integrity")
        pkgs.add((name, version))
    return reasons, sorted(pkgs)


def malware_from_results(pkgs, results) -> list:
    """Map OSV querybatch results onto ``pkgs``; raises ValueError on any incomplete answer."""
    if not isinstance(results, list) or len(results) != len(pkgs):
        raise ValueError("OSV returned an incomplete answer")
    found = []
    for (name, version), res in zip(pkgs, results):
        if not isinstance(res, dict):
            raise ValueError("OSV returned an invalid answer")
        ids = [v.get("id", "") for v in res.get("vulns") or [] if isinstance(v, dict)]
        mal = [i for i in ids if isinstance(i, str) and i.startswith("MAL-")]
        if mal:
            found.append({"package": name, "version": version, "ids": mal[:5]})
        elif res.get("next_page_token"):
            raise ValueError(f"OSV answer for {name}@{version} is paginated; refusing (fail closed)")
    return found


def _query_osv_batch(queries: list) -> list:
    """POST one OSV querybatch; returns its ``results`` list."""
    req = urllib.request.Request(
        _OSV_BATCH_ENDPOINT,
        data=json.dumps({"queries": queries}).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "hermes-agent-osv-check/1.0"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT * 3) as resp:
        return json.loads(resp.read()).get("results")


def check_lockfile(
    lock: Union[str, os.PathLike, dict],
    *,
    max_packages: int = MAX_LOCK_PACKAGES,
    max_bytes: int = MAX_LOCK_BYTES,
) -> LockfileVerdict:
    """Fail-closed malware check over every package in a package-lock.json.

    ``lock`` is a path or an already-parsed lockfile. Returns ``ok=True`` only
    when the lockfile is well formed, every package is pinned to the npm
    registry with sha512 integrity, and OSV answered completely with no MAL-*
    advisory. Never raises for bad input or network trouble: those refuse.
    """
    if isinstance(lock, (str, bytes, os.PathLike)):
        try:
            if os.path.getsize(lock) > max_bytes:
                return LockfileVerdict(False, [f"package-lock.json is larger than {max_bytes} bytes"])
            with open(lock, encoding="utf-8") as fh:
                lock = json.load(fh)
        except FileNotFoundError:
            return LockfileVerdict(False, ["the app has no committed package-lock.json"])
        except (OSError, ValueError) as exc:
            return LockfileVerdict(False, [f"package-lock.json is unreadable: {exc}"])
    reasons, pkgs = lockfile_findings(lock, max_packages)
    if reasons:
        return LockfileVerdict(False, reasons, packages=len(pkgs))
    malware = []
    try:
        for i in range(0, len(pkgs), _OSV_BATCH):
            chunk = pkgs[i:i + _OSV_BATCH]
            results = _query_osv_batch(
                [{"package": {"name": n, "ecosystem": "npm"}, "version": v} for n, v in chunk])
            malware += malware_from_results(chunk, results)
    except Exception as exc:  # noqa: BLE001 - fail closed on anything
        return LockfileVerdict(False, [f"OSV check failed (fail closed): {exc}"], packages=len(pkgs))
    if malware:
        names = ", ".join(f"{m['package']}@{m['version']} ({', '.join(m['ids'])})" for m in malware[:5])
        return LockfileVerdict(False, [f"known malware: {names}"], malware, len(pkgs))
    return LockfileVerdict(True, packages=len(pkgs))


def main(argv=None) -> int:
    """``python -m tools.osv_check package-lock.json``: exit 0 only if the lockfile passes."""
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print("usage: python -m tools.osv_check <package-lock.json>", file=sys.stderr)
        return 2
    verdict = check_lockfile(argv[0])
    print(json.dumps({"ok": verdict.ok, "packages": verdict.packages,
                      "reasons": verdict.reasons, "malware": verdict.malware}))
    return 0 if verdict.ok else 1


if __name__ == "__main__":
    sys.exit(main())
