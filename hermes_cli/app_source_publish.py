"""Push a local app's git history to GitHub (FG-33 decision 14, P8-2 2.10).

Settings -> GitHub token (owner/admin) decides where app source lives:

- a token is configured: each app's local repo is pushed to
  ``github.com/<owner>/aquarium-app-<slug>`` (created private on first push);
- no token but ``github.use_box_git``: the box's own git credentials are
  used as they are (the Hetzner box's existing GitHub setup);
- neither: a no-op. Source stays in the local git repo only.

The token lives in the credential store (kind ``github-token``, never
materialized); box overrides hold only a reference to that row. It is handed
to git through ``GIT_CONFIG_*`` environment variables, so it never appears in
an argv (``/proc/*/cmdline``) or in a remote URL stored in ``.git/config``,
and every message returned is scrubbed of it.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

logger = logging.getLogger(__name__)

PROVIDER = "github"
CREDENTIAL_NAME = "aquarium-apps"
CREDENTIAL_KIND = "github-token"
REPO_PREFIX = "aquarium-app-"
API = "https://api.github.com"
WEB = "https://github.com"
_SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_TOKEN = re.compile(r"^[A-Za-z0-9_\-]{8,255}$")

#: (argv, env, timeout) -> (returncode, stdout, stderr)
GitRunner = Callable[[list, Mapping[str, str], float], tuple]
#: (method, url, token, json body or None) -> (status, parsed json or None)
Http = Callable[[str, str, str, Optional[dict]], tuple]


@dataclass(frozen=True)
class GithubSettings:
    owner: Optional[str] = None
    credential: Optional[Mapping[str, str]] = None
    use_box_git: bool = False


def settings_from_overrides(box_overrides: Mapping[str, Any]) -> GithubSettings:
    cred = box_overrides.get("github.credential")
    return GithubSettings(
        owner=box_overrides.get("github.owner") or None,
        credential=dict(cred) if isinstance(cred, Mapping) else None,
        use_box_git=box_overrides.get("github.use_box_git") is True,
    )


def validate_token(token: Any) -> str:
    if not isinstance(token, str) or not _TOKEN.match(token.strip()):
        raise ValueError("That does not look like a GitHub token.")
    return token.strip()


def token_status(token: Optional[str]) -> dict:
    """All the browser ever learns about the token."""
    if not token:
        return {"set": False, "last4": None}
    return {"set": True, "last4": token[-4:]}


def repo_name(slug: str) -> str:
    if not _SLUG.match(slug or ""):
        raise ValueError(f"bad app slug {slug!r}")
    return f"{REPO_PREFIX}{slug}"


def _scrub(text: str, token: Optional[str]) -> str:
    text = text or ""
    if token:
        text = text.replace(token, "***")
        text = text.replace(_basic(token), "***")
    return text[-1500:]


def _basic(token: str) -> str:
    return base64.b64encode(f"x-access-token:{token}".encode()).decode()


def git_env(token: Optional[str], base: Optional[Mapping[str, str]] = None) -> dict:
    """Environment for ``git push``: the token as an auth header via
    ``GIT_CONFIG_*`` (git >= 2.31), never on the command line."""
    env = {k: v for k, v in (base if base is not None else os.environ).items()
           if not k.startswith("GIT_CONFIG_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    if token:
        env.update({
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {_basic(token)}",
        })
    return env


def _default_git(argv: list, env: Mapping[str, str], timeout: float) -> tuple:
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv, env=dict(env), capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {int(timeout)} s"
    return proc.returncode, proc.stdout, proc.stderr


def _default_http(method: str, url: str, token: str, body: Optional[dict]) -> tuple:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "aquarium-app-source-publish",
        **({"Content-Type": "application/json"} if data else {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - fixed https host
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except urllib.error.URLError:
        return 0, None


def ensure_repo(owner: str, name: str, token: str, *, http: Optional[Http] = None,
                api: str = API) -> Optional[str]:
    """Create ``owner/name`` (private) when missing. ``None`` or why not."""
    http = http or _default_http
    status, _ = http("GET", f"{api}/repos/{owner}/{name}", token, None)
    if status == 200:
        return None
    if status != 404:
        return f"GitHub answered {status or 'nothing'} for {owner}/{name}"
    status, me = http("GET", f"{api}/user", token, None)
    login = (me or {}).get("login") if status == 200 else None
    path = "/user/repos" if login and login.lower() == owner.lower() else f"/orgs/{owner}/repos"
    status, _ = http("POST", f"{api}{path}", token, {
        "name": name, "private": True, "auto_init": False,
        "description": "Aquarium app source (pushed from the box)",
    })
    return None if status in (201, 422) else f"could not create {owner}/{name} ({status or 'no answer'})"


def publish(
    slug: str,
    repo_dir: Path,
    *,
    settings: GithubSettings,
    token: Optional[str],
    git: Optional[GitRunner] = None,
    http: Optional[Http] = None,
    web: str = WEB,
) -> dict:
    """Push every branch and tag of ``repo_dir``. Never raises."""
    if not (token or settings.use_box_git):
        return {"published": False, "reason": "local-only"}
    if not settings.owner:
        return {"published": False, "reason": "no-owner",
                "error": "Settings -> GitHub has no account or organisation set."}
    try:
        name = repo_name(slug)
    except ValueError as exc:
        return {"published": False, "reason": "error", "error": str(exc)}
    if not (Path(repo_dir) / ".git").exists() and not (Path(repo_dir) / "HEAD").exists():
        return {"published": False, "reason": "error", "error": f"{repo_dir} is not a git repo"}
    if token:
        problem = ensure_repo(settings.owner, name, token, http=http)
        if problem:
            return {"published": False, "reason": "error", "error": _scrub(problem, token)}
    url = f"{web}/{settings.owner}/{name}.git"
    argv = ["git", "-C", str(repo_dir), "push", "--porcelain", url,
            "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]
    code, out, err = (git or _default_git)(argv, git_env(token), 180.0)
    if code != 0:
        return {"published": False, "reason": "error",
                "error": _scrub((err or out).strip() or f"git push exited {code}", token)}
    return {"published": True, "reason": "token" if token else "box-git",
            "repo": f"{settings.owner}/{name}"}


async def load_settings(app_store: Any = None) -> GithubSettings:
    from hermes_cli import app_quota

    if app_store is None:
        from hermes_cli.web_server import _comms_app_store

        app_store = _comms_app_store()
    return settings_from_overrides(await app_quota.QuotaStore(app_store).overrides_for(app_quota.BOX))


async def resolve_token(settings: GithubSettings, cred_store: Any = None) -> Optional[str]:
    """The configured token, resolved root-side by its reference."""
    ref = settings.credential
    if not ref:
        return None
    if cred_store is None:
        from hermes_cli.credential_store import default_credential_store

        cred_store = default_credential_store()
    for cred in await cred_store.resolve_by_kind(CREDENTIAL_KIND, provider=PROVIDER):
        if cred.owner_user_id == ref.get("owner_user_id") and cred.name == ref.get("name"):
            token = (cred.payload or {}).get("token")
            return token if isinstance(token, str) and token else None
    return None


async def publish_app_source(slug: str, repo_dir: Path, *, app_store: Any = None,
                             cred_store: Any = None) -> dict:
    """Entry point for build/scaffold steps: push when configured, else no-op."""
    import asyncio

    try:
        settings = await load_settings(app_store)
        token = await resolve_token(settings, cred_store)
    except Exception as exc:  # noqa: BLE001 - publishing is best-effort
        logger.warning("app source publish: settings unavailable: %s", exc)
        return {"published": False, "reason": "error", "error": "GitHub settings unavailable"}
    return await asyncio.to_thread(publish, slug, Path(repo_dir), settings=settings, token=token)
