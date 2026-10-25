"""In-house tool scaffolder — ``hermes tool new <name>`` (FG-07 / D3, FG-33 P8-1).

An in-house tool is a **Next.js app in its own Node process** that exposes BOTH
a **web UI** (for humans) and an **MCP server** (for the agent). This module
only *generates the project on disk* and reports a structured
:class:`ScaffoldResult`. Registering the tool in the C2/C3 registry and its MCP
endpoint in the FG-11 registry is the CLI command's job (``tool_cmd.py``), so
file generation stays unit-testable and free of DB / live-conversation coupling.

Templates are files under ``hermes_cli/app_templates/<template>/`` (shipped as
package data), rendered by exact ``{{token}}`` substitution only:

* ``minimal`` — the FG-07 tool: Next.js UI + dependency-free stdio
  ``mcp/server.mjs``. Output is byte-identical to the original inline template.
* ``nextjs-supabase`` — the FG-33 app template: pinned to agent-home's resolved
  versions, Streamable-HTTP MCP at ``/api/mcp`` (bearer) inside the app's own
  process, ``/api/health``, a generated ``app/icon.png``,
  ``supabase/migrations``, and a git repo with ``main`` + ``dev`` branches.
  ``base/`` holds the shared tree and ``hosting/<local|provider>/`` the files
  that differ by where the app runs.

Behavioural config lives in ``tool.config.json`` (and the registry row's
``config_json``) — never a new ``HERMES_*`` env var.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import subprocess
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Tuple

#: Deterministic port window for in-house tools (config-overridable, never an
#: env var). A tool's port is stable across scaffolds of the same name.
DEFAULT_PORT_BASE = 4300
DEFAULT_PORT_SPAN = 400

TEMPLATES: Tuple[str, ...] = ("minimal", "nextjs-supabase")
HOSTINGS: Tuple[str, ...] = ("local", "external")
#: External hosting providers (= FG-33 ``tool_hosting.provider`` / ``--provider``).
PROVIDERS: Tuple[str, ...] = ("vercel", "railway", "aws_amplify", "alibaba_fc")
DEFAULT_PROVIDER = "vercel"
APP_MODES: Tuple[str, ...] = ("dev", "prod")
#: Version of the ``nextjs-supabase`` template written into ``tool.config.json``.
TEMPLATE_VERSION = 1

TEMPLATES_DIR = Path(__file__).resolve().parent / "app_templates"

#: Template files whose names start with ``dot_`` are written as ``.<rest>``
#: (package data globs skip dotfiles).
_DOT_PREFIX = "dot_"
_SLUG = re.compile(r"[^a-z0-9-]+")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

#: Secret and runtime names a ``nextjs-supabase`` app reads (names only).
APP_ENV_NAMES: Tuple[str, ...] = (
    "DATABASE_URL",
    "DATABASE_URL_RO",
    "APP_MCP_TOKEN",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "PORT",
    "APP_MODE",
    "APP_PUBLIC_URL",
    "APP_BASE_PATH",
)


class ScaffoldError(RuntimeError):
    """The scaffold could not be completed (e.g. ``git`` is missing)."""


@dataclass(frozen=True)
class ScaffoldResult:
    """Structured description of a freshly scaffolded in-house tool."""

    name: str
    root: Path
    port: int
    web_url: str
    mcp_command: str
    mcp_args: List[str]
    files: List[str] = field(default_factory=list)
    template: str = "minimal"
    hosting: str = "local"
    provider: Optional[str] = None
    #: ``{"dev": ..., "prod": ...}`` URL prefixes (empty for external apps).
    base_paths: Dict[str, str] = field(default_factory=dict)
    #: Loopback MCP URL of the dev instance for HTTP-MCP templates, else None.
    mcp_url: Optional[str] = None
    #: The tool.config.json manifest as written.
    manifest: Dict[str, object] = field(default_factory=dict)

    def mcp_transport(self) -> dict:
        """The MCP transport the FG-11 endpoint registry consumes."""
        if self.mcp_url:
            return {"type": "http", "url": self.mcp_url, "auth": "bearer"}
        return {
            "type": "stdio",
            "command": self.mcp_command,
            "args": list(self.mcp_args),
        }


def _slug(name: str) -> str:
    return _SLUG.sub("-", name.strip().lower()).strip("-") or "tool"


def resolve_port(name: str, *, base: int = DEFAULT_PORT_BASE,
                 span: int = DEFAULT_PORT_SPAN) -> int:
    """Deterministically map a tool name to a stable port in ``[base, base+span)``.

    Deprecated for FG-33 apps, whose ports the root helper allocates; kept as
    the default for the ``minimal`` template and for callers that pass none.
    """
    digest = 0
    for char in name:
        digest = (digest * 31 + ord(char)) & 0xFFFFFFFF
    return base + (digest % span)


def app_base_path(slug: str, mode: str, *, hosting: str = "local") -> str:
    """URL prefix an app is served under on the main site.

    Local apps: ``/apps/<slug>`` (prod) and ``/apps-dev/<slug>`` (dev), so the
    two never share a cookie path. External apps own their origin: ``""``.
    """
    if mode not in APP_MODES:
        raise ValueError(f"mode must be one of {APP_MODES}, got {mode!r}")
    if hosting not in HOSTINGS:
        raise ValueError(f"hosting must be one of {HOSTINGS}, got {hosting!r}")
    if not slug or _slug(slug) != slug:
        raise ValueError(f"Invalid app slug: {slug!r}")
    if hosting != "local":
        return ""
    return f"/apps/{slug}" if mode == "prod" else f"/apps-dev/{slug}"


def _check_choices(template: str, hosting: str, provider: Optional[str]) -> Optional[str]:
    if template not in TEMPLATES:
        raise ValueError(f"template must be one of {TEMPLATES}, got {template!r}")
    if hosting not in HOSTINGS:
        raise ValueError(f"hosting must be one of {HOSTINGS}, got {hosting!r}")
    if hosting == "local":
        if provider is not None:
            raise ValueError("provider applies only to hosting='external'")
        return None
    if template == "minimal":
        raise ValueError("the minimal template supports hosting='local' only")
    provider = provider or DEFAULT_PROVIDER
    if provider not in PROVIDERS:
        raise ValueError(f"provider must be one of {PROVIDERS}, got {provider!r}")
    return provider


def _render(text: str, tokens: Mapping[str, str]) -> str:
    for key, value in tokens.items():
        text = text.replace("{{" + key + "}}", value)
    return text


def _template_files(template_dir: Path) -> Dict[str, Path]:
    """Map output-relative paths to template source files under ``template_dir``."""
    out: Dict[str, Path] = {}
    for source in sorted(template_dir.rglob("*")):
        if not source.is_file() or "__pycache__" in source.parts:
            continue
        parts = list(source.relative_to(template_dir).parts)
        if parts[-1].startswith(_DOT_PREFIX):
            parts[-1] = "." + parts[-1][len(_DOT_PREFIX):]
        out["/".join(parts)] = source
    return out


def _template_sources(template: str, hosting: str, provider: Optional[str]) -> Dict[str, Path]:
    root = TEMPLATES_DIR / template
    if template == "minimal":
        return _template_files(root)
    sources = _template_files(root / "base")
    sources.update(_template_files(root / "hosting" / (provider or hosting)))
    return sources


# ── generated icon (initials on a name-hashed palette hue) ──────────────────

#: Eight palette hues (degrees); an app's hue is picked by hashing its name.
ICON_PALETTE_HUES: Tuple[int, ...] = (0, 30, 50, 140, 175, 210, 255, 300)

_GLYPHS: Dict[str, Tuple[str, ...]] = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01110", "10001", "10000", "10000", "10000", "10001", "01110"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01110", "10001", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("01110", "00100", "00100", "00100", "00100", "00100", "01110"),
    "J": ("00111", "00010", "00010", "00010", "00010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "10001", "11001", "10101", "10011", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "10001", "01010", "00100", "01010", "10001", "10001"),
    "Y": ("10001", "10001", "01010", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11111", "00010", "00100", "00010", "00001", "10001", "01110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
}


def app_icon_initials(name: str) -> str:
    """One or two initials: first letters of the first two words, else the first two characters."""
    words = [w for w in re.split(r"[^A-Za-z0-9]+", name) if w]
    if not words:
        return "?"
    if len(words) >= 2:
        return (words[0][0] + words[1][0]).upper()
    return words[0][:2].upper()


def app_icon_hue(name: str) -> int:
    """The palette hue for ``name`` (deterministic; always in :data:`ICON_PALETTE_HUES`)."""
    index = hashlib.sha256(name.encode("utf-8")).digest()[0] % len(ICON_PALETTE_HUES)
    return ICON_PALETTE_HUES[index]


def app_icon_rgb(name: str) -> Tuple[int, int, int]:
    """Background colour of the generated icon: the palette hue at fixed saturation/lightness."""
    import colorsys

    red, green, blue = colorsys.hls_to_rgb(app_icon_hue(name) / 360.0, 0.42, 0.6)
    return round(red * 255), round(green * 255), round(blue * 255)


def render_app_icon(name: str, size: int = 256) -> bytes:
    """A deterministic RGBA PNG: initials in white on a rounded square of the app's hue."""
    background = app_icon_rgb(name) + (255,)
    clear = (0, 0, 0, 0)
    white = (255, 255, 255, 255)
    radius = size * 0.22
    initials = [c for c in app_icon_initials(name) if c in _GLYPHS]
    cols = len(initials) * 6 - 1 if initials else 0
    cell = max(1, int(size * 0.55 / max(cols, 7)))
    text_w, text_h = cols * cell, 7 * cell
    left, top = (size - text_w) // 2, (size - text_h) // 2

    def inside_rounded(x: int, y: int) -> bool:
        cx = min(max(x + 0.5, radius), size - radius)
        cy = min(max(y + 0.5, radius), size - radius)
        return (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2

    def ink(x: int, y: int) -> bool:
        gx, gy = (x - left) // cell, (y - top) // cell
        if not (0 <= gx < cols and 0 <= gy < 7) or x < left or y < top:
            return False
        glyph_index, column = divmod(gx, 6)
        if column == 5:
            return False
        return _GLYPHS[initials[glyph_index]][gy][column] == "1"

    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            if not inside_rounded(x, y):
                rows.extend(clear)
            elif ink(x, y):
                rows.extend(white)
            else:
                rows.extend(background)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


# ── git ──────────────────────────────────────────────────────────────────────

def _git(project: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=Aquarium scaffold", "-c", "user.email=scaffold@aquarium.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
        cwd=project, check=True, capture_output=True, text=True, timeout=60,
    )


def _git_init(project: Path, message: str) -> None:
    """``main`` holds the scaffold commit; ``dev`` (checked out) is where work happens."""
    if shutil.which("git") is None:
        raise ScaffoldError("git is required to scaffold this template")
    try:
        _git(project, "init", "-q")
        _git(project, "symbolic-ref", "HEAD", "refs/heads/main")
        _git(project, "add", "-A")
        _git(project, "commit", "-q", "-m", message)
        _git(project, "checkout", "-q", "-b", "dev")
    except subprocess.CalledProcessError as exc:
        raise ScaffoldError(f"git init failed: {exc.stderr.strip()}") from exc


# ── scaffold ─────────────────────────────────────────────────────────────────

def _app_manifest(name: str, slug: str, *, port: int, web_url: str, hosting: str,
                  provider: Optional[str], base_paths: Mapping[str, str]) -> Dict[str, object]:
    return {
        "name": name,
        "stack": "nextjs-supabase",
        "template": "nextjs-supabase",
        "template_version": TEMPLATE_VERSION,
        "hosting": hosting,
        "provider": provider,
        "port": port,
        "web_url": web_url,
        "base_path": dict(base_paths),
        "health_path": "/api/health",
        "icon": "app/icon.png",
        "auth": "aquarium" if hosting == "local" else "supabase",
        "db": {"migrations": "supabase/migrations"},
        "mcp": {"transport": "http", "path": "/api/mcp", "auth": "bearer"},
        "env": list(APP_ENV_NAMES),
        # Behavioural config lives here (and in the registry row), never in a
        # HERMES_* env var. Secrets are delivered by the runtime, never written.
        "config": {},
    }


def scaffold_in_house_tool(
    name: str,
    root: Path,
    *,
    port: int | None = None,
    host: str = "127.0.0.1",
    template: str = "minimal",
    hosting: str = "local",
    provider: str | None = None,
) -> ScaffoldResult:
    """Generate an in-house tool under ``root/<name>`` from ``template``.

    ``hosting`` is ``local`` or ``external``; ``provider`` (external only,
    default :data:`DEFAULT_PROVIDER`) is one of :data:`PROVIDERS`. ``minimal``
    is idempotent per file (a re-scaffold refreshes the template);
    ``nextjs-supabase`` refuses to overwrite an existing app repository.
    """
    if not _NAME.fullmatch(name or ""):
        raise ValueError(f"Invalid tool name: {name!r}")
    provider = _check_choices(template, hosting, provider)

    slug = _slug(name)
    tool_port = port if port is not None else resolve_port(name)
    project = root / name
    app = template != "minimal"
    base_paths: Dict[str, str] = {}
    if app:
        if (project / ".git").exists():
            raise FileExistsError(f"{project} is already an app repository")
        base_paths = {mode: app_base_path(slug, mode, hosting=hosting) for mode in APP_MODES}
    web_url = f"http://{host}:{tool_port}{base_paths.get('dev', '')}"

    tokens = {
        "name": name,
        "slug": slug,
        "port": str(tool_port),
        "web_url": web_url,
        "hosting": hosting,
        "provider": provider or "",
        "auth": "aquarium" if hosting == "local" else "supabase",
        "template_version": str(TEMPLATE_VERSION),
    }

    written: List[str] = []

    def _write(relative: str, content: bytes) -> None:
        target = project / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        written.append(relative)

    for relative, source in _template_sources(template, hosting, provider).items():
        _write(relative, _render(source.read_text(encoding="utf-8"), tokens).encode("utf-8"))

    manifest: Dict[str, object] = {}
    if app:
        manifest = _app_manifest(name, slug, port=tool_port, web_url=web_url, hosting=hosting,
                                 provider=provider, base_paths=base_paths)
        _write("tool.config.json", (json.dumps(manifest, indent=2) + "\n").encode("utf-8"))
        _write("app/icon.png", render_app_icon(name))
        _git_init(project, f"chore: scaffold {name} from the {template} template v{TEMPLATE_VERSION}")
        return ScaffoldResult(
            name=name,
            root=project,
            port=tool_port,
            web_url=web_url,
            mcp_command="",
            mcp_args=[],
            files=sorted(written),
            template=template,
            hosting=hosting,
            provider=provider,
            base_paths=base_paths,
            mcp_url=f"{web_url}/api/mcp",
            manifest=manifest,
        )

    return ScaffoldResult(
        name=name,
        root=project,
        port=tool_port,
        web_url=web_url,
        mcp_command="node",
        mcp_args=["mcp/server.mjs"],
        files=sorted(written),
        manifest=json.loads((project / "tool.config.json").read_text(encoding="utf-8")),
    )


__all__ = [
    "APP_ENV_NAMES",
    "APP_MODES",
    "DEFAULT_PORT_BASE",
    "DEFAULT_PORT_SPAN",
    "DEFAULT_PROVIDER",
    "HOSTINGS",
    "ICON_PALETTE_HUES",
    "PROVIDERS",
    "TEMPLATES",
    "TEMPLATE_VERSION",
    "ScaffoldError",
    "ScaffoldResult",
    "app_base_path",
    "app_icon_hue",
    "app_icon_initials",
    "app_icon_rgb",
    "render_app_icon",
    "resolve_port",
    "scaffold_in_house_tool",
]
