"""Run the agent's terminal commands as their own Linux user (``terminal.run_as``).

The gateway runs as ``hermes`` and holds every secret. When ``terminal.run_as``
names another user (``hermes-tools`` on a fresh install), the local terminal,
background processes and execute_code start through the root-owned helper
``/usr/local/sbin/hermes-tools-exec`` via sudo, so the agent's commands cannot
read the gateway's ``/proc/<pid>/environ`` or hermes's secret files.

Empty or unset (the default for boxes set up before this) keeps today's
behaviour: commands run as the gateway's own user.
"""

from __future__ import annotations

import getpass
import os
import shlex
import signal as _signal
import stat
import subprocess
from typing import Iterable, Sequence

SETTING = "terminal.run_as"
HELPER = "/usr/local/sbin/hermes-tools-exec"


class RunAsUnavailable(RuntimeError):
    """``terminal.run_as`` is set but the helper cannot be used."""


def _current_user() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return ""


def configured_user() -> str:
    """User named by ``terminal.run_as``, or ``""`` when commands run as us."""
    if os.name == "nt":
        return ""
    try:
        from hermes_cli.config import read_raw_config

        section = read_raw_config().get("terminal") or {}
        value = section.get("run_as") if isinstance(section, dict) else None
    except Exception:
        return ""
    user = str(value or "").strip()
    if not user or user == _current_user():
        return ""
    return user


def _check_helper(user: str) -> None:
    try:
        st = os.stat(HELPER)
    except OSError:
        st = None
    if st is None or st.st_uid != 0 or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RunAsUnavailable(
            f"{SETTING} is set to {user!r}, but {HELPER} is missing or not a "
            "root-owned file. Install it as root (see the header of "
            "deploy/hermes-tools-exec), or turn the setting off with "
            f"`hermes config set {SETTING} ''`."
        )


def command_prefix(user: str) -> list[str]:
    """argv prefix that runs ``bash <args>`` as *user*; raises if unusable."""
    _check_helper(user)
    return ["sudo", "-n", "-E", "-u", user, HELPER, "bash"]


def wrap_bash(argv: Sequence[str], user: str) -> list[str]:
    """Turn ``[<any shell>, *args]`` into the helper invocation for *user*."""
    return command_prefix(user) + list(argv[1:])


def wrap_command(argv: Sequence[str], user: str) -> list[str]:
    """Run an arbitrary argv as *user* (``bash -c 'exec ...'``)."""
    return command_prefix(user) + ["-c", "exec " + shlex.join(argv)]


def run_quiet(user: str, script: str, timeout: float = 10) -> None:
    """Run a short bash *script* as *user*, ignoring every failure."""
    try:
        subprocess.run(
            ["sudo", "-n", "-u", user, HELPER, "bash", "-c", f"{script} 2>/dev/null; exit 0"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=timeout, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def _kill_as(user: str, targets: Iterable[str], sig: int) -> None:
    targets = list(targets)
    if targets:
        run_quiet(user, f"kill -{int(sig)} -- {' '.join(targets)}")


def remove_files(user: str, paths: Iterable[str]) -> None:
    """Delete files *user* created in a sticky directory such as /tmp."""
    paths = list(paths)
    if paths:
        run_quiet(user, "rm -f -- " + " ".join(shlex.quote(p) for p in paths))


def share_with(user: str, path: str, mode: int) -> None:
    """Give *user*'s group access to *path* (the gateway is in that group)."""
    import grp

    os.chown(path, -1, grp.getgrnam(user).gr_gid)
    os.chmod(path, mode)


def signal_group(user: str, pgid: int, sig: int = _signal.SIGTERM) -> None:
    """Signal a process group whose members run as *user*.

    The gateway cannot signal another user's processes itself; it can only
    reach the setuid sudo wrapper, which forwards SIGTERM but not SIGKILL and
    never reaches the command's own children.
    """
    _kill_as(user, [f"-{int(pgid)}"], sig)


def signal_pids(user: str, pids: Iterable[int], sig: int = _signal.SIGTERM) -> None:
    _kill_as(user, [str(int(p)) for p in pids], sig)
