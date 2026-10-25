"""Python runtime layer for FG-33 local apps (P8-1 item 1.4).

Everything that touches the box goes through two root helpers, called with
``sudo -n`` from the ``hermes`` user only (never from the agent's
``hermes-tools`` shell, which reaches this module through allowlisted
``hermes tool …`` verbs):

* ``/usr/local/sbin/aquarium-app-helper <verb>`` with a JSON spec on stdin
  (``{"slug", "mode", "release_sha"?, "approval_ref"?, "lines"?}``) and JSON on
  stdout. Verbs: ``allocate|build|start|stop|restart|route|unroute|set-secret|
  logs|status|remove`` (item 1.2 owns the helper; it re-validates every spec).
* ``/usr/local/sbin/aquarium apps db <verb> <slug> <mode> [--approval <ref>]``
  (item 1.3), verbs ``create|migrate|status|suspend|drop``.

:class:`HelperClient` builds those argv lists and validates the specs first, so
a bad slug or a prod verb without an approval never reaches sudo.
:class:`AppRuntime` is what the CLI verbs, the API routes and
``promote_tool``'s local promotion plan call. It checks C2 through the tool
registry, admission through ``hermes_cli.app_quota`` (item 1.6; skipped while
that module is absent), records ``app_deployments``/``tool_runtime`` rows and
C5 changes.

Paths (decision 4): a local app is served under the main site at
``/apps/<slug>`` (prod) and ``/apps/<slug>/~dev`` (dev), so one ``/apps/``
prefix carries the strict CSP and the agent-home Origin/Referer refusal.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from hermes_cli.access import Principal

HELPER = "/usr/local/sbin/aquarium-app-helper"
PROVISIONER = "/usr/local/sbin/aquarium"
SUDO: Tuple[str, ...] = ("sudo", "-n")

MODES = ("dev", "prod")
HELPER_VERBS = (
    "allocate", "build", "start", "stop", "restart", "route", "unroute",
    "set-secret", "logs", "status", "remove",
)
DB_VERBS = ("create", "migrate", "status", "suspend", "drop")
#: Helper verbs that change a prod instance; the helper refuses them without
#: an approved ``approval_ref`` (the rows ``promote_tool`` writes).
PROD_GATED_VERBS = frozenset(
    {"allocate", "build", "start", "stop", "restart", "route", "unroute",
     "set-secret", "remove"}
)
PROD_GATED_DB_VERBS = frozenset({"create", "migrate", "suspend", "drop"})

#: A local app's slug is its tool name and becomes a URL path segment and a
#: unit instance name, so it is stricter than a tool name.
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")
_REF_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_SHA_RE = re.compile(r"^[0-9a-f]{7,64}$")

PROD_PATH = "/apps/{slug}"
DEV_PATH = "/apps/{slug}/~dev"

MAX_LOG_LINES = 500
MAX_OUTPUT_CHARS = 64 * 1024
HELPER_TIMEOUT_S = 30 * 60

TEMPLATES = ("minimal", "nextjs-supabase")
HOSTINGS = ("local", "external")
PROVIDERS = ("vercel", "railway", "aws_amplify", "alibaba_fc")

Runner = Callable[[List[str], Optional[str], float], Tuple[int, str, str]]


class HelperError(Exception):
    """A root helper refused or failed; the message is safe to show."""


class AdmissionRefused(Exception):
    """``app_quota.check_admission`` refused the act; the message names why."""

    def __init__(self, reason: str, *, needs_approval: bool = False) -> None:
        super().__init__(reason)
        self.needs_approval = needs_approval


def app_path(slug: str, mode: str) -> str:
    """Browser path of a local app instance on the main site."""
    validate_slug(slug)
    validate_mode(mode)
    return (PROD_PATH if mode == "prod" else DEV_PATH).format(slug=slug)


def validate_slug(slug: str) -> str:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise ValueError(
            f"Invalid app slug: {slug!r} (lowercase letters, digits and '-', "
            "at most 40 characters)"
        )
    return slug


def validate_mode(mode: str) -> str:
    if mode not in MODES:
        raise ValueError(f"Invalid mode: {mode!r}")
    return mode


def app_db_name(slug: str, mode: str) -> str:
    """``lapp_<id>_<mode>``: a slug-derived identifier plus a hash suffix."""
    validate_slug(slug)
    validate_mode(mode)
    ident = slug.replace("-", "_")[:24]
    return f"lapp_{ident}_{hashlib.sha256(slug.encode()).hexdigest()[:6]}_{mode}"


def endpoint_name(slug: str) -> str:
    """The app's FG-11 endpoint name (tools come out as ``mcp_la_<slug>_*``)."""
    return f"la-{validate_slug(slug)}"


def secret_ref(slug: str, mode: str) -> str:
    """Token file name under ``$HERMES_HOME/auth/mcp-secrets/`` for one instance."""
    return f"la-{validate_slug(slug)}-{validate_mode(mode)}"


def mcp_transport(port: int, slug: str, mode: str) -> dict:
    """The loopback Streamable-HTTP MCP transport of one instance (bearer auth)."""
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise HelperError(f"helper returned an invalid port: {port!r}")
    return {
        "type": "http",
        "url": f"http://127.0.0.1:{port}/api/mcp",
        "auth": "bearer",
    }


def _default_runner(argv: List[str], stdin: Optional[str], timeout: float) -> Tuple[int, str, str]:
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv, input=stdin, capture_output=True, text=True, timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        return 127, "", str(exc)
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {int(timeout)} s"
    return proc.returncode, proc.stdout, proc.stderr


def _cap(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    text = text or ""
    return text if len(text) <= limit else text[-limit:]


def _parse(stdout: str) -> dict:
    text = (stdout or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {"output": _cap(text)}
    return data if isinstance(data, dict) else {"result": data}


class HelperClient:
    """Builds and runs the exact argv of the two root helpers."""

    def __init__(
        self,
        runner: Optional[Runner] = None,
        *,
        helper: str = HELPER,
        provisioner: str = PROVISIONER,
        sudo: Sequence[str] = SUDO,
        timeout: float = HELPER_TIMEOUT_S,
    ) -> None:
        self._run = runner or _default_runner
        self.helper = helper
        self.provisioner = provisioner
        self.sudo = tuple(sudo)
        self.timeout = timeout

    # -- argv (pure; what the sudoers rules must allow) ----------------------

    def helper_argv(self, verb: str) -> List[str]:
        if verb not in HELPER_VERBS:
            raise ValueError(f"Unknown helper verb: {verb!r}")
        return [*self.sudo, self.helper, verb]

    def helper_spec(self, verb: str, spec: Dict[str, Any]) -> str:
        spec = dict(spec)
        if verb == "status" and spec.get("all"):
            if set(spec) != {"all"}:
                raise ValueError("status --all takes no other field")
            return json.dumps({"all": True}, sort_keys=True)
        validate_slug(spec.get("slug"))
        validate_mode(spec.get("mode"))
        ref = spec.get("approval_ref")
        if ref is not None and not _REF_RE.fullmatch(str(ref)):
            raise ValueError(f"Invalid approval_ref: {ref!r}")
        if spec["mode"] == "prod" and verb in PROD_GATED_VERBS and not ref:
            raise PermissionError(
                f"`{verb}` on a prod instance needs an approved approval_ref "
                "(promote the app first)"
            )
        sha = spec.get("release_sha")
        if sha is not None and not _SHA_RE.fullmatch(str(sha)):
            raise ValueError(f"Invalid release_sha: {sha!r}")
        if "lines" in spec:
            spec["lines"] = max(1, min(int(spec["lines"]), MAX_LOG_LINES))
        allowed = {"slug", "mode", "approval_ref", "release_sha", "lines"}
        extra = set(spec) - allowed
        if extra:
            raise ValueError(f"Unknown helper spec fields: {sorted(extra)}")
        return json.dumps({k: v for k, v in spec.items() if v is not None}, sort_keys=True)

    def db_argv(
        self, verb: str, slug: str, mode: str, *, approval_ref: Optional[str] = None,
    ) -> List[str]:
        if verb not in DB_VERBS:
            raise ValueError(f"Unknown apps db verb: {verb!r}")
        validate_slug(slug)
        validate_mode(mode)
        argv = [*self.sudo, self.provisioner, "apps", "db", verb, slug, mode]
        if approval_ref is not None:
            if not _REF_RE.fullmatch(approval_ref):
                raise ValueError(f"Invalid approval_ref: {approval_ref!r}")
            argv += ["--approval", approval_ref]
        elif mode == "prod" and verb in PROD_GATED_DB_VERBS:
            raise PermissionError(
                f"`apps db {verb}` on prod needs an approved approval_ref"
            )
        return argv

    # -- calls ---------------------------------------------------------------

    def _exec(self, argv: List[str], stdin: Optional[str], what: str) -> dict:
        code, out, err = self._run(argv, stdin, self.timeout)
        if code == 127:
            raise HelperError(
                f"{what}: not installed on this box ({argv[len(self.sudo)]}); "
                "the owner has to install the FG-33 app runtime first"
            )
        if code != 0:
            detail = (_cap(err, 2000) or _cap(out, 2000)).strip() or f"exit {code}"
            raise HelperError(f"{what} failed: {detail}")
        return _parse(out)

    def call(self, verb: str, **spec: Any) -> dict:
        argv = self.helper_argv(verb)
        return self._exec(argv, self.helper_spec(verb, spec), f"aquarium-app-helper {verb}")

    def db(self, verb: str, slug: str, mode: str, *, approval_ref: Optional[str] = None) -> dict:
        argv = self.db_argv(verb, slug, mode, approval_ref=approval_ref)
        return self._exec(argv, None, f"aquarium apps db {verb}")


# ---------------------------------------------------------------------------
# admission (item 1.6) — guarded so this layer works before it lands
# ---------------------------------------------------------------------------


def _verdict(result: Any) -> Tuple[str, str]:
    """Normalise ``check_admission``'s result to ``(verdict, reason)``."""
    if result is None or result is True:
        return "ok", ""
    if result is False:
        return "refused", "refused by the app quota policy"
    if isinstance(result, str):
        return result, ""
    if isinstance(result, (tuple, list)) and result:
        return str(result[0]), str(result[1]) if len(result) > 1 else ""
    if isinstance(result, dict):
        verdict = result.get("verdict") or result.get("status") or (
            "ok" if result.get("ok") else "refused"
        )
        return str(verdict), str(result.get("reason") or "")
    for attr in ("verdict", "status", "decision"):
        value = getattr(result, attr, None)
        if isinstance(value, str):
            return value, str(getattr(result, "reason", "") or "")
    ok = getattr(result, "ok", None)
    if isinstance(ok, bool):
        return ("ok" if ok else "refused"), str(getattr(result, "reason", "") or "")
    return "ok", ""


def check_admission(
    principal: Principal, action: str, *, usage: Any = None, box: Any = None, **context: Any,
) -> None:
    """Raise :class:`AdmissionRefused` unless ``app_quota`` admits ``action``.

    With item 1.6's pure ``check_admission(principal, action, *, usage, box,
    request)``, ``usage``/``box`` are measured by :func:`measure_usage`.
    """
    try:
        from hermes_cli import app_quota
    except ImportError:
        return
    check = getattr(app_quota, "check_admission", None)
    if check is None:
        return
    if usage is not None and box is not None:
        request_cls = getattr(app_quota, "AdmissionRequest", None)
        kwargs: Dict[str, Any] = {"usage": usage, "box": box}
        if request_cls is not None:
            kwargs["request"] = request_cls(tool=str(context.get("tool") or ""))
        result = check(principal, action, **kwargs)
    else:
        try:
            result = check(principal, action, **context)
        except TypeError:
            result = check(principal, action)
    if hasattr(result, "__await__"):
        raise RuntimeError("app_quota.check_admission must be synchronous here")
    verdict, reason = _verdict(result)
    if verdict == "ok":
        return
    if verdict == "needs_approval":
        raise AdmissionRefused(
            reason or f"{action} needs the owner's approval under the app quota policy",
            needs_approval=True,
        )
    raise AdmissionRefused(reason or f"{action} refused by the app quota policy")


async def measure_usage(registry: Any, principal: Principal) -> Tuple[Any, Any]:
    """``(MemberUsage, BoxUsage)`` for item 1.6's admission, or ``(None, None)``.

    Counts the member's local apps (registered, and running in either mode)
    from the registry and ``tool_runtime`` of the registry's mode; the box
    side is ``app_quota.probe_box`` (slice memory, MemAvailable, free space).
    """
    try:
        from hermes_cli import app_quota
    except ImportError:
        return None, None
    member_cls = getattr(app_quota, "MemberUsage", None)
    probe = getattr(app_quota, "probe_box", None)
    if member_cls is None or probe is None:
        return None, None
    conn = await registry.store.connect()
    try:
        rows = await conn.fetch(
            """
            SELECT t.name, t.owner_user_id, r.runtime_state
            FROM tools t LEFT JOIN tool_runtime r ON r.tool_id = t.id
            WHERE t.hosting = 'local'
            """
        ) if await conn.fetchval("SELECT to_regclass('tool_runtime')") is not None else await conn.fetch(
            "SELECT name, owner_user_id, NULL AS runtime_state FROM tools WHERE hosting = 'local'"
        )
    finally:
        await conn.close()
    mine = [r for r in rows if r["owner_user_id"] == principal.user_id]
    usage = member_cls(
        registered=frozenset(r["name"] for r in mine),
        running=frozenset(r["name"] for r in mine if r["runtime_state"] in ("running", "starting")),
    )
    box = await asyncio.to_thread(lambda: probe(apps_registered=len({r["name"] for r in rows})))
    return usage, box


async def admit(registry: Any, principal: Principal, action: str, **context: Any) -> None:
    usage, box = await measure_usage(registry, principal)
    check_admission(principal, action, usage=usage, box=box, **context)


# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------


@dataclass
class LocalPromotion:
    """What the local promotion plan did (FG-33 §3.7), for ``promote_tool``."""

    slug: str
    release_sha: str
    tag: str
    port: int
    secret_ref: str
    transport: dict
    db_name: str
    backup_ref: Optional[str] = None
    applied_migrations: List[Any] = field(default_factory=list)


def _can_manage(principal: Principal, tool: Any) -> bool:
    if principal.role == "viewer":
        return False
    return (
        principal.is_owner
        or principal.role == "admin"
        or tool.owner_user_id == principal.user_id
    )


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(  # noqa: S603 - fixed argv
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise HelperError(f"git {args[0]} failed: {_cap(proc.stderr, 500).strip()}")
    return proc.stdout.strip()


class AppRuntime:
    """Lifecycle of local apps: provision, build, start/stop, logs, promote, remove."""

    def __init__(
        self,
        helper: Optional[HelperClient] = None,
        *,
        tools_root: Optional[Path] = None,
        secrets_dir: Optional[Path] = None,
        config: Optional[dict] = None,
    ) -> None:
        self.helper = helper or HelperClient()
        #: Datastore config for the prod audit store (``None`` = config.yaml).
        self.config = config
        self._tools_root = tools_root
        self._secrets_dir = secrets_dir

    # -- paths ---------------------------------------------------------------

    @property
    def tools_root(self) -> Path:
        if self._tools_root is not None:
            return self._tools_root
        from hermes_constants import get_hermes_home

        return get_hermes_home() / "tools"

    @property
    def secrets_dir(self) -> Path:
        if self._secrets_dir is not None:
            return self._secrets_dir
        from tools.registry_mcp import _secrets_dir

        return _secrets_dir()

    def repo_for(self, tool: Any) -> Path:
        return Path(tool.repo_path) if getattr(tool, "repo_path", None) else self.tools_root / tool.name

    def write_secret(self, ref: str, token: str) -> None:
        """Store an instance's MCP bearer where ``registry_mcp.read_secret`` reads it."""
        if not token or not isinstance(token, str) or "\n" in token.strip():
            raise HelperError("helper returned no usable MCP token")
        directory = self.secrets_dir
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / ref
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, token.strip().encode("utf-8"))
        finally:
            os.close(fd)
        os.chmod(path, 0o600)

    # -- helper calls off the event loop -------------------------------------

    async def _call(self, verb: str, **spec: Any) -> dict:
        return await asyncio.to_thread(lambda: self.helper.call(verb, **spec))

    async def _db(self, verb: str, slug: str, mode: str, *, approval_ref: Optional[str] = None) -> dict:
        return await asyncio.to_thread(self.helper.db, verb, slug, mode, approval_ref=approval_ref)

    # -- tool resolution (C2) ------------------------------------------------

    @staticmethod
    async def resolve(registry: Any, principal: Principal, name: str, *, write: bool) -> Any:
        """The tool if ``principal`` may see it (else ``KeyError``, never a leak)."""
        tool = await registry.get_for_principal(principal, name)
        if tool is None:
            raise KeyError(f"No such tool: {name}")
        if write and not _can_manage(principal, tool):
            raise PermissionError(f"{principal.user_id} may not manage tool {name!r}")
        return tool

    @staticmethod
    def require_local(tool: Any) -> str:
        if getattr(tool, "hosting", None) != "local":
            raise ValueError(f"Tool {tool.name!r} is not a local app")
        return validate_slug(tool.name)

    @staticmethod
    def _store_for(registry: Any):
        from hermes_cli.app_store import AppStore

        return AppStore(registry.store)

    # -- provisioning (``hermes tool new --hosting local``) ------------------

    def allocate(self, slug: str, mode: str, *, approval_ref: Optional[str] = None) -> Tuple[int, str]:
        """Allocate the instance port and store its MCP token; returns ``(port, secret_ref)``."""
        out = self.helper.call("allocate", slug=slug, mode=mode, approval_ref=approval_ref)
        port = out.get("port")
        mcp_transport(port, slug, mode)
        ref = secret_ref(slug, mode)
        self.write_secret(ref, out.get("mcp_token") or "")
        return port, ref

    async def record_dev_database(self, registry: Any, tool: Any, provisioned: dict) -> dict:
        store = self._store_for(registry)
        await store.initialize()
        db = await store.upsert_database(
            tool.id, "dev", provisioned.get("db_name") or app_db_name(tool.name, "dev"),
            status="ready",
        )
        await store.set_runtime(tool.id, runtime="local", unit=f"aquarium-app@{tool.name}-dev",
                                port=provisioned.get("port"), runtime_state="stopped")
        return db.as_dict()

    # -- build / start / stop / restart --------------------------------------

    async def build(self, registry: Any, principal: Principal, name: str) -> dict:
        """Build the ``dev`` HEAD into a release and (re)start the dev instance."""
        mode = registry.mode
        if mode != "dev":
            raise PermissionError(
                "prod releases are built only by `hermes tool promote` (after approval)"
            )
        tool = await self.resolve(registry, principal, name, write=True)
        slug = self.require_local(tool)
        await admit(registry, principal, "build", tool=tool.name, mode=mode)
        sha = await asyncio.to_thread(
            _git, self.repo_for(tool), "rev-parse", "--verify", "dev^{commit}"
        )
        store = self._store_for(registry)
        await store.initialize()
        await store.set_tool_build(tool.id, "building")
        await store.set_runtime(tool.id, runtime="local", runtime_state="building")
        try:
            built = await self._call("build", slug=slug, mode=mode, release_sha=sha)
            started = await self._call("restart", slug=slug, mode=mode, release_sha=sha)
        except HelperError as exc:
            await store.set_tool_build(tool.id, "failed")
            await store.set_runtime(tool.id, runtime="local", runtime_state="failed")
            await store.record_deployment(
                tool.id, mode=mode, target="dev", source_sha=sha,
                actor_user_id=principal.user_id, ready_state="failed", error=str(exc),
            )
            raise
        await store.set_tool_build(tool.id, "ready", release_sha=sha)
        await store.set_runtime(
            tool.id, runtime="local", unit=f"aquarium-app@{slug}-{mode}",
            port=started.get("port") or built.get("port"), runtime_state="running",
        )
        deployment = await store.record_deployment(
            tool.id, mode=mode, target="dev", source_sha=sha,
            actor_user_id=principal.user_id, ready_state="ready", url=app_path(slug, mode),
        )
        await self._record(registry, principal, tool, f"hermes tool build {slug}",
                           {"release_sha": sha, "deployment": deployment})
        return {"tool": slug, "mode": mode, "release_sha": sha, "deployment": deployment,
                "path": app_path(slug, mode), "log": _cap(built.get("output", ""), 4000)}

    async def control(self, registry: Any, principal: Principal, name: str, verb: str) -> dict:
        """``start|stop|restart`` the instance of the registry's mode."""
        if verb not in ("start", "stop", "restart"):
            raise ValueError(f"Unknown control verb: {verb!r}")
        mode = registry.mode
        tool = await self.resolve(registry, principal, name, write=True)
        slug = self.require_local(tool)
        store = self._store_for(registry)
        await store.initialize()
        approval_ref = None
        if mode == "prod":
            approval_ref = await store.latest_approval_ref(tool.id)
            if approval_ref is None:
                raise PermissionError(f"{slug!r} has no approved prod release; promote it first")
        if verb != "stop":
            await admit(registry, principal, "start", tool=tool.name, mode=mode)
            if not tool.release_sha:
                raise ValueError(f"{slug!r} has no release yet; run `hermes tool build {slug}`")
        out = await self._call(verb, slug=slug, mode=mode, approval_ref=approval_ref)
        state = "stopped" if verb == "stop" else "running"
        runtime = await store.set_runtime(
            tool.id, runtime="local", unit=f"aquarium-app@{slug}-{mode}", runtime_state=state,
            **({"port": out["port"]} if isinstance(out.get("port"), int) else {}),
        )
        await self._record(registry, principal, tool, f"hermes tool {verb} {slug}",
                           {"mode": mode, "runtime_state": state})
        return {"tool": slug, "mode": mode, "runtime_state": runtime["runtime_state"]}

    # -- reads ---------------------------------------------------------------

    async def logs(self, registry: Any, principal: Principal, name: str, *, lines: int = 200) -> dict:
        tool = await self.resolve(registry, principal, name, write=True)
        slug = self.require_local(tool)
        out = await self._call("logs", slug=slug, mode=registry.mode, lines=lines)
        text = out.get("output") if isinstance(out.get("output"), str) else out.get("lines", "")
        if isinstance(text, list):
            text = "\n".join(str(x) for x in text)
        return {"tool": slug, "mode": registry.mode, "lines": _cap(str(text or ""))}

    async def runtime(self, registry: Any, principal: Principal, name: str) -> dict:
        tool = await self.resolve(registry, principal, name, write=False)
        store = self._store_for(registry)
        await store.initialize()
        payload = {
            "tool": tool.name, "mode": registry.mode, "hosting": tool.hosting,
            "build_state": tool.build_state, "release_sha": tool.release_sha,
            "runtime": await store.get_runtime(tool.id),
            "deployments": await store.list_deployments(tool.id, limit=10),
        }
        if tool.hosting == "local":
            payload["path"] = app_path(tool.name, registry.mode)
        return payload

    async def status(self, registry: Any, principal: Principal, name: str) -> dict:
        """Live helper status of the instance, mirrored into ``tool_runtime``."""
        tool = await self.resolve(registry, principal, name, write=False)
        slug = self.require_local(tool)
        out = await self._call("status", slug=slug, mode=registry.mode)
        store = self._store_for(registry)
        await store.initialize()
        active = out.get("active")
        if isinstance(active, bool):
            await store.set_runtime(
                tool.id, runtime="local",
                runtime_state="running" if active else (
                    "idle_stopped" if registry.mode == "dev" and tool.release_sha else "stopped"
                ),
            )
        payload = await self.runtime(registry, principal, name)
        payload["live"] = {k: v for k, v in out.items() if k in ("active", "port", "since", "state")}
        return payload

    async def database(self, registry: Any, principal: Principal, name: str) -> dict:
        tool = await self.resolve(registry, principal, name, write=False)
        slug = self.require_local(tool)
        store = self._store_for(registry)
        await store.initialize()
        db = await store.get_database(tool.id, registry.mode)
        payload = {"tool": slug, "mode": registry.mode, "database": db.as_dict() if db else None}
        if db is not None and _can_manage(principal, tool):
            try:
                live = await self._db("status", slug, registry.mode)
            except HelperError as exc:
                live = {"error": str(exc)}
            payload["live"] = {k: v for k, v in live.items() if k != "dsn"}
        return payload

    def preview(self, tool: Any, mode: str) -> str:
        return app_path(self.require_local(tool), mode)

    async def doctor(self, registries: Dict[str, Any], principal: Principal) -> dict:
        """Reconcile registry rows × helper instances × app databases (read-only)."""
        problems: List[dict] = []
        try:
            instances = (await self._call("status", all=True)).get("instances") or []
        except HelperError as exc:
            return {"ok": False, "problems": [{"kind": "helper", "detail": str(exc)}]}
        live = {(i.get("slug"), i.get("mode")): i for i in instances if isinstance(i, dict)}
        seen = set()
        sees_all = principal.is_owner or principal.role == "admin"
        for mode, registry in registries.items():
            store = self._store_for(registry)
            await store.initialize()
            tools = {t.id: t for t in await registry.list_for_principal(principal)}
            for tool in tools.values():
                if tool.hosting != "local":
                    continue
                seen.add((tool.name, mode))
                if tool.release_sha and (tool.name, mode) not in live:
                    problems.append({"kind": "missing_instance", "tool": tool.name, "mode": mode})
                db = await store.get_database(tool.id, mode)
                if db is None or db.status in ("dropped", "failed"):
                    problems.append({"kind": "missing_database", "tool": tool.name, "mode": mode})
            if sees_all:
                for db in await store.list_databases():
                    if db.tool_id not in tools and db.status != "dropped":
                        problems.append({"kind": "orphan_database", "db_name": db.db_name,
                                         "mode": mode})
        if sees_all:
            for (slug, mode) in sorted(k for k in live if k not in seen and None not in k):
                problems.append({"kind": "orphan_instance", "tool": slug, "mode": mode})
        return {"ok": not problems, "problems": problems}

    # -- remove (one explicit confirmation; irreversible) ---------------------

    async def remove(self, registry: Any, principal: Principal, name: str, *, confirm: str) -> dict:
        """Delete an app in the registry's mode: instance, database, rows."""
        mode = registry.mode
        tool = await self.resolve(registry, principal, name, write=True)
        if confirm != tool.name:
            raise ValueError(
                f"Removing {tool.name!r} deletes its {mode} data for good; "
                f"confirm by passing the tool name ({tool.name!r})"
            )
        store = self._store_for(registry)
        await store.initialize()
        dropped = None
        if tool.hosting == "local":
            slug = validate_slug(tool.name)
            approval_ref = None
            if mode == "prod":
                approval_ref = await self._approve(registry, principal, "tool.remove", slug)
            await self._call("remove", slug=slug, mode=mode, approval_ref=approval_ref)
            db = await store.get_database(tool.id, mode)
            if db is not None and db.status != "dropped":
                out = await self._db("drop", slug, mode, approval_ref=approval_ref)
                await store.upsert_database(tool.id, mode, db.db_name, status="dropped",
                                            last_backup_ref=out.get("backup_ref"))
                dropped = db.db_name
            try:
                (self.secrets_dir / secret_ref(slug, mode)).unlink()
            except OSError:
                pass
        await store.forget_tool(tool.id)
        if tool.mcp_endpoint_ref:
            await _delete_endpoint(registry, tool.mcp_endpoint_ref)
        await registry.delete(principal, tool.name)
        await self._record(registry, principal, tool, f"hermes tool delete {tool.name}",
                           {"mode": mode, "dropped_database": dropped}, reversible=False)
        return {"tool": tool.name, "mode": mode, "removed": True, "dropped_database": dropped}

    # -- promotion (called by tools_registry.promote_tool after C6) ----------

    def promote_local(self, tool: Any, *, approval_ref: str, has_prod_db: bool) -> LocalPromotion:
        """FG-33 §3.7 steps 1-3: tag ``vN`` on ``main``, migrate prod, build, flip, restart.

        ``approval_ref`` must already be committed as an approved row, because
        the provisioner and the helper check it before any prod verb.
        """
        slug = self.require_local(tool)
        repo = self.repo_for(tool)
        sha = _git(repo, "rev-parse", "--verify", "dev^{commit}")
        has_main = subprocess.run(  # noqa: S603
            ["git", "-C", str(repo), "rev-parse", "--verify", "-q", "main^{commit}"],
            capture_output=True, text=True, check=False,
        ).returncode == 0
        if has_main and subprocess.run(  # noqa: S603
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", "main", sha],
            capture_output=True, check=False,
        ).returncode != 0:
            raise HelperError(f"`main` of {slug!r} is not an ancestor of `dev`; refusing a non-fast-forward promote")
        tags = _git(repo, "tag", "--list", "v*").split()
        numbers = [int(t[1:]) for t in tags if t[1:].isdigit()]
        tag = f"v{max(numbers, default=0) + 1}"

        if not has_prod_db:
            self.helper.db("create", slug, "prod", approval_ref=approval_ref)
        migrated = self.helper.db("migrate", slug, "prod", approval_ref=approval_ref)
        port, ref = self.allocate(slug, "prod", approval_ref=approval_ref)
        self.helper.call("build", slug=slug, mode="prod", release_sha=sha, approval_ref=approval_ref)
        self.helper.call("restart", slug=slug, mode="prod", release_sha=sha, approval_ref=approval_ref)

        _git(repo, "update-ref", "refs/heads/main", sha)
        _git(repo, "tag", tag, sha)
        return LocalPromotion(
            slug=slug, release_sha=sha, tag=tag, port=port, secret_ref=ref,
            transport=mcp_transport(port, slug, "prod"),
            db_name=migrated.get("db_name") or app_db_name(slug, "prod"),
            backup_ref=migrated.get("backup_ref"),
            applied_migrations=list(migrated.get("applied") or migrated.get("applied_migrations") or []),
        )

    async def record_promotion(
        self, connection: Any, prod_tool_id: str, plan: LocalPromotion, *,
        actor: str, approval_ref: str, change_ref: str,
    ) -> None:
        """Mirror a local promotion into the prod schema's runtime tables."""
        from hermes_cli.app_store import AppStore

        store = AppStore(_NoStore())
        await store.initialize(connection=connection)
        await store.upsert_database(
            prod_tool_id, "prod", plan.db_name, status="ready",
            last_backup_ref=plan.backup_ref, applied_migrations=plan.applied_migrations,
            connection=connection,
        )
        await store.record_deployment(
            prod_tool_id, mode="prod", target="prod", source_sha=plan.release_sha,
            actor_user_id=actor, ready_state="ready", approval_ref=approval_ref,
            change_ref=change_ref, url=app_path(plan.slug, "prod"),
            connection=connection,
        )
        await store.set_runtime(
            prod_tool_id, runtime="local", unit=f"aquarium-app@{plan.slug}-prod",
            port=plan.port, runtime_state="running", connection=connection,
        )

    # -- audit ---------------------------------------------------------------

    async def _approve(self, registry: Any, principal: Principal, action: str, slug: str) -> str:
        """Commit the explicit confirmation as an approved C6 row the helpers can check."""
        from hermes_cli.changes import initialize_changes
        from hermes_cli.datastore import app_schema, get_store

        prod_store = get_store("supabase-app", "prod", config=self.config)
        ref = f"apr_{uuid.uuid4().hex}"
        conn = await prod_store.connect()
        try:
            await initialize_changes(conn)
            await conn.execute(
                f"INSERT INTO {app_schema('prod')}.approvals (id, action, target_ref, actor, decision) "
                "VALUES ($1, $2, $3, $4, 'approved')",
                ref, action, f"tool:{slug}", principal.user_id,
            )
        finally:
            await conn.close()
        return ref

    async def _record(
        self, registry: Any, principal: Principal, tool: Any, action: str, payload: dict,
        *, reversible: bool = True,
    ) -> None:
        """A pre-approved C5 change; best-effort like ``tool_cmd._record_provenance``."""
        from hermes_cli.changes import ChangeLog, initialize_changes
        from hermes_cli.datastore import get_store

        op = {"op": "record", "path": f"/tools/{tool.name}", "value": payload}
        try:
            prod_store = get_store("supabase-app", "prod", config=self.config)
            conn = await prod_store.connect()
            try:
                await initialize_changes(conn)
            finally:
                await conn.close()
            await ChangeLog(prod_store).record(
                actor_user_id=principal.user_id, target_kind="code", op=[op],
                inverse_op=[op] if reversible else None, reversible=reversible,
                action=action, target_ref=tool.name, mode=registry.mode,
                visibility=tool.visibility, payload=payload, approved=True,
            )
        except Exception as exc:  # noqa: BLE001 - provenance is best-effort
            print(f"warning: could not record provenance change: {exc}")


class _NoStore:
    """``AppStore`` needs a store only when it opens its own connection."""

    mode = "prod"
    schema = ""

    async def connect(self):  # pragma: no cover - always given a connection
        raise RuntimeError("record_promotion runs on promote_tool's connection")


async def _delete_endpoint(registry: Any, name: str) -> None:
    """Drop the app's FG-11 endpoint row (the caller already owns the tool)."""
    conn = await registry.store.connect()
    try:
        if await conn.fetchval("SELECT to_regclass('mcp_endpoints')") is not None:
            await conn.execute("DELETE FROM mcp_endpoints WHERE name = $1", name)
    finally:
        await conn.close()


__all__ = [
    "AdmissionRefused",
    "AppRuntime",
    "DEV_PATH",
    "HelperClient",
    "HelperError",
    "LocalPromotion",
    "PROD_PATH",
    "app_db_name",
    "app_path",
    "check_admission",
    "endpoint_name",
    "mcp_transport",
    "secret_ref",
    "validate_slug",
]
