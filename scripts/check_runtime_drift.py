#!/usr/bin/env python3
"""Check that a deployment's runtime still matches what the repo declares.

Three layers make up a running Hermes deployment, and only two of them are
covered by something that watches for staleness:

  1. Source code       — git tells you when it drifts.
  2. Python packages   — exact-pinned in pyproject.toml.
  3. The interpreter   — nothing watches this at all.

Layer 3 is the gap this script closes. Hermes runs from a venv built on a
uv-managed CPython under ``/opt/uv/python/...`` (or wherever
``UV_PYTHON_INSTALL_DIR`` points), and that interpreter **statically bundles
its own OpenSSL**. On a hermes-systest box the two copies diverge:

    python ssl:  OpenSSL 3.5.7    <- every TLS connection Hermes makes
    system:      OpenSSL 3.0.13   <- what apt/unattended-upgrades patches

So the OS auto-updater can install an OpenSSL security fix, report success,
leave ``apt list --upgradable`` empty, and leave Hermes on the unpatched
copy — a box that is behind while every dashboard says it is current. The
danger is the false confidence, not the CVE.

The expected interpreter and its crypto floor are declared in pyproject.toml
under ``[tool.hermes.runtime-baseline]``, so bumping them is a reviewable
commit rather than an undocumented act on one box.

Exit codes:
  0 — runtime matches the baseline (notes may still be printed)
  1 — drift found
  2 — script error (could not read the baseline)

Usage:
  python scripts/check_runtime_drift.py
  python scripts/check_runtime_drift.py --json
  python scripts/check_runtime_drift.py --notify   # Telegram, only on drift
  python scripts/check_runtime_drift.py --tool-doctor   # + FG-33 app reconciliation

Where the FG-33 local-app runtime is installed (``/usr/local/sbin/aquarium-app-helper``),
the weekly run also calls ``hermes tool doctor --json`` (registry rows × app
instances × app databases) and reports each problem as drift; ``--no-tool-doctor``
skips it.

Run it with the *deployment's* interpreter — it reports on the Python that
executes it, not on any Python it can find:

  /opt/data/hermes-agent/.venv/bin/python scripts/check_runtime_drift.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import tomllib
from importlib import metadata
from pathlib import Path
from typing import Any

from packaging.requirements import InvalidRequirement, Requirement

REPO_ROOT = Path(__file__).resolve().parent.parent

# A finding the operator must act on; anything else is informational.
SEVERITY_DRIFT = "drift"
SEVERITY_NOTE = "note"


def _parse_version(text: str) -> tuple[int, ...]:
    """Return the leading numeric components of *text* as a comparable tuple.

    Tolerates the shapes these versions actually arrive in: ``3.11.15``,
    ``OpenSSL 3.5.7 9 Jun 2026``, ``3.0.13-0ubuntu3.12``. Trailing
    non-numeric segments are dropped rather than guessed at, so a comparison
    is only ever made between the parts that are unambiguously numeric.
    """
    match = re.search(r"(\d+(?:\.\d+)*)", text)
    if not match:
        return ()
    return tuple(int(part) for part in match.group(1).split("."))


def _exact_pins(dependencies: list[str]) -> dict[str, str]:
    """Extract ``name==version`` pins that apply to the running platform.

    Ranges are skipped (there is nothing exact to assert), and so are
    requirements whose environment marker excludes this platform — several
    pins are Windows-only (``tzdata``, ``concurrent-log-handler``), and
    flagging those as missing on Linux would make the report cry wolf.
    """
    pins: dict[str, str] = {}
    for raw in dependencies:
        try:
            requirement = Requirement(raw)
        except InvalidRequirement:
            continue
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        specifiers = list(requirement.specifier)
        if len(specifiers) != 1 or specifiers[0].operator != "==":
            continue
        version = specifiers[0].version
        if "*" not in version:
            pins[requirement.name] = version
    return pins


class IncompleteBaseline(Exception):
    """The baseline table is missing a floor the check is supposed to enforce."""


REQUIRED_FLOORS = ("python", "openssl")


def load_baseline(pyproject: Path) -> tuple[dict[str, str], dict[str, Any]]:
    """Return (package pins, runtime baseline) declared in *pyproject*.

    Every floor in ``REQUIRED_FLOORS`` must be present. A missing table — or
    a table that has lost a key to a merge or a rename — would otherwise make
    that layer unwatched while the run still printed "no drift" and exited 0:
    indistinguishable from a healthy deployment, which is precisely the false
    confidence this script exists to remove. Refuse to run instead.
    """
    with pyproject.open("rb") as handle:
        data = tomllib.load(handle)
    pins = _exact_pins(data.get("project", {}).get("dependencies", []))
    baseline = data.get("tool", {}).get("hermes", {}).get("runtime-baseline", {})
    missing = [floor for floor in REQUIRED_FLOORS if not baseline.get(floor)]
    if missing:
        raise IncompleteBaseline(
            f"[tool.hermes.runtime-baseline] in {pyproject} is missing: "
            f"{', '.join(missing)}. Every floor must be declared, otherwise "
            "that layer goes unchecked and the run still reports clean."
        )
    return pins, baseline


def check_packages(pins: dict[str, str]) -> list[dict[str, str]]:
    """Compare each exact pin against what is importable right now."""
    findings = []
    for name, expected in sorted(pins.items()):
        try:
            installed = metadata.version(name)
        except metadata.PackageNotFoundError:
            findings.append(
                {
                    "severity": SEVERITY_DRIFT,
                    "component": name,
                    "expected": expected,
                    "actual": "not installed",
                    "detail": f"{name} is pinned but missing from this environment",
                }
            )
            continue
        if installed != expected:
            findings.append(
                {
                    "severity": SEVERITY_DRIFT,
                    "component": name,
                    "expected": expected,
                    "actual": installed,
                    "detail": f"{name} is {installed}, pyproject pins {expected}",
                }
            )
    return findings


def _check_floor(
    component: str, actual: str, floor: str, why: str
) -> list[dict[str, str]]:
    """Compare *actual* against a minimum *floor*.

    Below the floor is drift the operator must fix. Above it is a note: the
    runtime was upgraded without the repo pin following, so the baseline no
    longer describes the deployment and the next check would not catch a
    downgrade back to the old version.
    """
    actual_parts, floor_parts = _parse_version(actual), _parse_version(floor)
    if not actual_parts or not floor_parts:
        return [
            {
                "severity": SEVERITY_DRIFT,
                "component": component,
                "expected": floor,
                "actual": actual,
                "detail": f"could not compare {component} versions",
            }
        ]
    if actual_parts < floor_parts:
        return [
            {
                "severity": SEVERITY_DRIFT,
                "component": component,
                "expected": f">={floor}",
                "actual": actual,
                "detail": why,
            }
        ]
    if actual_parts > floor_parts:
        return [
            {
                "severity": SEVERITY_NOTE,
                "component": component,
                "expected": floor,
                "actual": actual,
                "detail": (
                    f"{component} is ahead of the baseline — bump "
                    f"[tool.hermes.runtime-baseline] to {actual} so the repo "
                    "keeps describing the deployment"
                ),
            }
        ]
    return []


def check_runtime(baseline: dict[str, Any]) -> list[dict[str, str]]:
    """Compare the running interpreter and its bundled OpenSSL to the baseline."""
    findings: list[dict[str, str]] = []

    python_floor = baseline.get("python")
    if python_floor:
        running = ".".join(str(part) for part in sys.version_info[:3])
        findings += _check_floor(
            "python",
            running,
            str(python_floor),
            "the interpreter is older than the baseline — it will not receive "
            "OS security updates, rebuild the venv (see docs/deployment/"
            "runtime-drift.md)",
        )

    openssl_floor = baseline.get("openssl")
    if openssl_floor:
        findings += _check_floor(
            "openssl",
            ssl.OPENSSL_VERSION,
            str(openssl_floor),
            "the OpenSSL bundled inside the interpreter is below the baseline. "
            "apt does not patch this copy — every TLS connection Hermes makes "
            "uses it. Rebuild the venv on a newer interpreter.",
        )

    return findings


def collect(pyproject: Path) -> list[dict[str, str]]:
    pins, baseline = load_baseline(pyproject)
    return check_packages(pins) + check_runtime(baseline)


def format_report(findings: list[dict[str, str]]) -> str:
    drift = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
    notes = [f for f in findings if f["severity"] == SEVERITY_NOTE]
    lines = []
    if drift:
        lines.append(f"Runtime drift on {os.uname().nodename}: {len(drift)} finding(s)")
        for finding in drift:
            lines.append(
                f"  [drift] {finding['component']}: "
                f"expected {finding['expected']}, found {finding['actual']}"
            )
            lines.append(f"          {finding['detail']}")
    else:
        lines.append(f"No runtime drift on {os.uname().nodename}")
    for finding in notes:
        lines.append(
            f"  [note]  {finding['component']}: {finding['actual']} "
            f"(baseline {finding['expected']})"
        )
        lines.append(f"          {finding['detail']}")
    lines.append(f"  python {sys.version.split()[0]} — {ssl.OPENSSL_VERSION}")
    return "\n".join(lines)


def _notify_lib():
    """``scripts/lib/notify.py``, loaded by path (``python -I`` safe; lazy so a
    bare copy of this script still answers ``--help``)."""
    import importlib.util

    name = "aquarium_scripts_lib_notify"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().parent / "lib" / "notify.py"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.modules[name] = module
    return module


def _telegram_target() -> tuple[str, str, str]:
    """(token, chat_id, thread_id); see ``scripts/lib/notify.py``."""
    return _notify_lib().telegram_target()


def notify(text: str) -> bool:
    """Send *text* to the operator's Telegram (``scripts/lib/notify.py``)."""
    return _notify_lib().notify(text, tag="drift")


#: The FG-33 local-app runtime; when it is installed the weekly check also
#: reconciles apps (``hermes tool doctor``, FG-33 P8-2 item 2.4).
APP_HELPER = Path("/usr/local/sbin/aquarium-app-helper")
DOCTOR_TIMEOUT_S = 300


def _hermes_bin() -> Path:
    return Path(sys.executable).with_name("hermes")


def check_apps(hermes_bin: Path | None = None) -> list[dict[str, str]]:
    """``hermes tool doctor --json`` as findings: every problem is drift.

    Registry rows × app instances × app databases disagree (an orphan database,
    a missing instance, ...). A doctor that cannot run is a note, not drift:
    this check reports on the box, it does not page for its own tooling.
    """
    import subprocess

    hermes = hermes_bin or _hermes_bin()
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv
            [str(hermes), "tool", "doctor", "--json"],
            capture_output=True, text=True, timeout=DOCTOR_TIMEOUT_S, check=False,
        )
        result = json.loads(proc.stdout) if proc.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, ValueError):
        result = None
    if not isinstance(result, dict) or not isinstance(result.get("problems"), list):
        return [{
            "severity": SEVERITY_NOTE, "component": "apps", "expected": "doctor report",
            "actual": "unavailable",
            "detail": "`hermes tool doctor --json` did not run; app reconciliation skipped",
        }]
    findings = []
    for problem in result["problems"]:
        if not isinstance(problem, dict):
            continue
        kind = str(problem.get("kind", "problem"))
        where = problem.get("tool") or problem.get("db_name") or "-"
        findings.append({
            "severity": SEVERITY_DRIFT, "component": f"apps:{kind}",
            "expected": "registry, instances and databases agree",
            "actual": f"{where} ({problem.get('mode', '-')})",
            "detail": ", ".join(f"{k}={v}" for k, v in sorted(problem.items())),
        })
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--json", action="store_true", help="emit findings as JSON on stdout"
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="send a Telegram message when drift is found (silent otherwise)",
    )
    parser.add_argument(
        "--tool-doctor",
        action=argparse.BooleanOptionalAction,
        default=None,
        help="also reconcile FG-33 local apps (default: when the app runtime is installed)",
    )
    parser.add_argument(
        "--pyproject",
        type=Path,
        default=REPO_ROOT / "pyproject.toml",
        help="path to the pyproject.toml holding the baseline",
    )
    args = parser.parse_args(argv)

    try:
        findings = collect(args.pyproject)
    except (OSError, tomllib.TOMLDecodeError, IncompleteBaseline) as exc:
        print(f"error: could not read baseline from {args.pyproject}: {exc}")
        return 2
    run_doctor = args.tool_doctor if args.tool_doctor is not None else APP_HELPER.exists()
    if run_doctor:
        findings += check_apps()

    drifted = [f for f in findings if f["severity"] == SEVERITY_DRIFT]
    report = format_report(findings)

    if args.json:
        print(json.dumps(findings, indent=2))
    else:
        print(report)

    if args.notify and drifted:
        notify(report)

    return 1 if drifted else 0


if __name__ == "__main__":
    sys.exit(main())
