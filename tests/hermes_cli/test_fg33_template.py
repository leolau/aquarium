"""FG-33 P8-1 item 1.1: app templates as files + the scaffold keyword interface.

Behaviour and invariants only:

* ``minimal`` renders byte-identical output to the FG-07 inline template;
* ``nextjs-supabase`` pins equal the versions the root ``package-lock.json``
  resolves for the agent-home workspace, and the template's own lockfile is in
  sync with its ``package.json``;
* hosting/provider choose the deploy files and nothing else leaks (no
  unrendered tokens, no secret values, no ``HERMES_*``);
* the app is a git repo with ``main`` + ``dev``, an HTTP MCP endpoint under the
  app's base path, a generated icon and a Supabase migrations layout;
* the in-app MCP handler completes a real handshake under ``node`` and refuses
  callers without the bearer token.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import subprocess
import zlib
from pathlib import Path

import pytest

from hermes_cli import tool_scaffold
from hermes_cli.mcp_endpoints import _validate_transport
from hermes_cli.tool_scaffold import (
    APP_MODES,
    DEFAULT_PROVIDER,
    HOSTINGS,
    ICON_PALETTE_HUES,
    PROVIDERS,
    TEMPLATES,
    TEMPLATES_DIR,
    ScaffoldResult,
    app_base_path,
    app_icon_hue,
    app_icon_rgb,
    render_app_icon,
    scaffold_in_house_tool,
)
from hermes_cli.tools_registry import validate_tool_config

REPO = Path(__file__).resolve().parents[2]
TOKEN = re.compile(r"\{\{[a-z_]+\}\}")
APP = "nextjs-supabase"

# sha256 of every file the FG-07 inline-string scaffolder wrote (develop @ 3803355).
MINIMAL_GOLDEN = {
    ("invoices", 4321): {
        "README.md": "998e0de12250e3822e4f9de91645a9bdda9f3c0ed7674258d0622e6b562492ca",
        "app/layout.tsx": "ce576593eb6dd7342f808d02893e43c0279b3de76b416cbe28479c4165b4214e",
        "app/page.tsx": "253c25371e92d58fb56f981439f1f6ff8adfebbf229299a42ae4c5d1b0a5cc75",
        "mcp/server.mjs": "3154bd8f6c7e45c6c06184a37a402a7e94339b370fc360ab6031d54b5b5d42cd",
        "next.config.mjs": "c756de99cd5b24fe69b4f51a23a2529415eb5aed745fd66653928338a88a2349",
        "package.json": "ffb1d9d161165b54ebb4e964a671bbe83be3fee346520e56478e8c904812ace2",
        "tool.config.json": "d49ecd0e2f241e483d1aa367180b4d02288620b1f0e6e1b2ef9d3a1d1283eba8",
        "tsconfig.json": "e4f875d140920e49b1347c8ed5a57d60e70bd51527d1e2c4c1da46c1525d113c",
    },
    ("My.Tool_x", 4400): {
        "README.md": "75738497c2024eba71cb3361fc60a08f558c9a76581c94517e11508bcf23b039",
        "app/layout.tsx": "a7a8f55677e85db737c8faa18ad08c44f4632e361be89067d028a05d849e02c1",
        "app/page.tsx": "46f78d363410d4a01462abdafc943a7d90be608502a068cb43d2bab2af1470f8",
        "mcp/server.mjs": "a7398015fcf18b47ea6ed3e8e9ecddf75598d311b00b53d60cc266719a3efc20",
        "next.config.mjs": "c756de99cd5b24fe69b4f51a23a2529415eb5aed745fd66653928338a88a2349",
        "package.json": "b6ec28c00c7369a2994b7e81cb27ec7d9c34d317a68f8f3ea5be8db7a96a7586",
        "tool.config.json": "afabf52d1c1f232df222accf9b8443c53c6d47d6d83fd41f07a82858ebd909d4",
        "tsconfig.json": "e4f875d140920e49b1347c8ed5a57d60e70bd51527d1e2c4c1da46c1525d113c",
    },
}

needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git required")
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node required")


def _text_files(project: Path):
    for path in sorted(project.rglob("*")):
        if path.is_file() and ".git" not in path.relative_to(project).parts and path.suffix != ".png":
            yield path


def _git(project: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=project, check=True, capture_output=True,
                          text=True).stdout.strip()


def _scaffold_app(tmp_path: Path, name: str = "invoices", **kwargs) -> ScaffoldResult:
    kwargs.setdefault("port", 4510)
    return scaffold_in_house_tool(name, tmp_path, template=APP, **kwargs)


# ── minimal: byte-identical to FG-07 ─────────────────────────────────────────

@pytest.mark.parametrize("name,port", sorted(MINIMAL_GOLDEN))
def test_minimal_template_is_byte_identical_to_fg07(tmp_path: Path, name: str, port: int) -> None:
    result = scaffold_in_house_tool(name, tmp_path, port=port)
    written = {
        rel: hashlib.sha256((result.root / rel).read_bytes()).hexdigest() for rel in result.files
    }
    assert written == MINIMAL_GOLDEN[(name, port)]
    assert result.template == "minimal" and result.hosting == "local" and result.provider is None
    assert result.mcp_transport()["type"] == "stdio"
    assert not (result.root / ".git").exists()


# ── the keyword interface ────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "kwargs",
    [
        {"template": "nope"},
        {"template": APP, "hosting": "cloud"},
        {"template": APP, "hosting": "local", "provider": "vercel"},
        {"template": APP, "hosting": "external", "provider": "heroku"},
        {"template": "minimal", "hosting": "external"},
    ],
)
def test_scaffold_rejects_invalid_choices_before_writing(tmp_path: Path, kwargs: dict) -> None:
    with pytest.raises(ValueError):
        scaffold_in_house_tool("app1", tmp_path, **kwargs)
    assert not (tmp_path / "app1").exists()


@needs_git
def test_external_defaults_to_the_default_provider(tmp_path: Path) -> None:
    result = _scaffold_app(tmp_path, hosting="external")
    assert result.provider == DEFAULT_PROVIDER
    assert result.manifest["provider"] == DEFAULT_PROVIDER


def test_base_paths_split_dev_and_prod_and_external_owns_its_origin() -> None:
    for slug in ("invoices", "my-app"):
        dev, prod = (app_base_path(slug, mode) for mode in ("dev", "prod"))
        assert prod == f"/apps/{slug}"
        assert dev != prod and not prod.startswith(dev) and not dev.startswith(prod)
        assert {app_base_path(slug, m, hosting="external") for m in APP_MODES} == {""}
    for bad in ("../x", "Upper", ""):
        with pytest.raises(ValueError):
            app_base_path(bad, "dev")
    with pytest.raises(ValueError):
        app_base_path("ok", "staging")


# ── nextjs-supabase rendering per hosting ────────────────────────────────────

def _hosting_cases():
    yield "local", None
    for provider in PROVIDERS:
        yield "external", provider


@needs_git
@pytest.mark.parametrize("hosting,provider", list(_hosting_cases()))
def test_app_template_renders_completely_for_every_hosting(tmp_path: Path, hosting: str,
                                                           provider) -> None:
    result = _scaffold_app(tmp_path, hosting=hosting, provider=provider)
    project = result.root
    for rel in (
        "package.json", "package-lock.json", ".nvmrc", ".gitignore", ".env.example", "AGENTS.md",
        "next.config.mjs", "lib/db.ts", "lib/auth.ts", "lib/supabase/server.ts",
        "lib/supabase/client.ts", "middleware.ts", "app/api/health/route.ts",
        "app/api/mcp/route.ts", "app/icon.png", "supabase/config.toml",
        "tests/health.test.ts", "tests/mcp.test.mjs", "tool.config.json",
    ):
        assert (project / rel).is_file(), rel
        assert rel in result.files
    assert any((project / "supabase/migrations").glob("*_init.sql"))

    deploy = {p.relative_to(project).as_posix() for p in (project / "deploy").rglob("*") if p.is_file()}
    if hosting == "local":
        assert deploy and all(p.startswith("deploy/local/") for p in deploy)
    else:
        assert deploy and all(p.startswith("deploy/external/") for p in deploy)

    for path in _text_files(project):
        text = path.read_text(encoding="utf-8")
        assert not TOKEN.search(text), f"unrendered token in {path}"
        assert "HERMES_" not in text, path

    # .env.example carries names only.
    for line in (project / ".env.example").read_text().splitlines():
        if line and not line.startswith("#"):
            name, _, value = line.partition("=")
            assert re.fullmatch(r"[A-Z][A-Z0-9_]*", name) and value == "", line

    manifest = json.loads((project / "tool.config.json").read_text())
    assert manifest == result.manifest
    assert validate_tool_config(manifest) == manifest
    assert manifest["hosting"] == hosting and manifest["provider"] == provider
    assert set(manifest["env"]) == {
        line.partition("=")[0]
        for line in (project / ".env.example").read_text().splitlines()
        if line and not line.startswith("#")
    }
    config_js = (project / "app.config.mjs").read_text()
    assert f'HOSTING = "{hosting}"' in config_js


@needs_git
def test_app_mcp_endpoint_is_http_bearer_under_the_dev_base_path(tmp_path: Path) -> None:
    result = _scaffold_app(tmp_path, port=4555)
    transport = result.mcp_transport()
    assert _validate_transport(transport) == transport
    assert transport == {
        "type": "http",
        "url": f"http://127.0.0.1:4555{app_base_path('invoices', 'dev')}/api/mcp",
        "auth": "bearer",
    }
    assert result.web_url + "/api/mcp" == transport["url"]
    assert result.base_paths == {m: app_base_path("invoices", m) for m in APP_MODES}


# ── pins follow agent-home ───────────────────────────────────────────────────

def _agent_home_resolved(lock: dict, dep: str) -> str:
    packages = lock["packages"]
    entry = packages.get(f"agent-home/node_modules/{dep}") or packages[f"node_modules/{dep}"]
    return entry["version"]


def test_app_pins_equal_agent_home_resolved_versions() -> None:
    template = TEMPLATES_DIR / APP / "base"
    pkg = json.loads((template / "package.json").read_text())
    root_lock = json.loads((REPO / "package-lock.json").read_text())
    agent_home = json.loads((REPO / "agent-home/package.json").read_text())
    agent_home_deps = {**agent_home["dependencies"], **agent_home["devDependencies"]}

    ours = {**pkg["dependencies"], **pkg["devDependencies"]}
    assert {"next", "react", "react-dom"} <= set(pkg["dependencies"])
    for dep, version in ours.items():
        assert re.fullmatch(r"\d+\.\d+\.\d+", version), f"{dep} is not an exact pin: {version}"
        if dep in agent_home_deps:
            assert version == _agent_home_resolved(root_lock, dep), dep


def test_app_lockfile_is_in_sync_with_package_json() -> None:
    template = TEMPLATES_DIR / APP / "base"
    pkg = json.loads((template / "package.json").read_text())
    lock = json.loads((template / "package-lock.json").read_text())
    root = lock["packages"][""]
    assert root.get("dependencies", {}) == pkg["dependencies"]
    assert root.get("devDependencies", {}) == pkg["devDependencies"]
    for dep, version in {**pkg["dependencies"], **pkg["devDependencies"]}.items():
        assert lock["packages"][f"node_modules/{dep}"]["version"] == version, dep


# ── git: main + dev ──────────────────────────────────────────────────────────

@needs_git
def test_app_is_a_git_repo_on_dev_with_main_at_the_scaffold_commit(tmp_path: Path) -> None:
    project = _scaffold_app(tmp_path).root
    assert _git(project, "branch", "--show-current") == "dev"
    assert _git(project, "rev-parse", "main") == _git(project, "rev-parse", "dev")
    assert _git(project, "status", "--porcelain") == ""
    tracked = set(_git(project, "ls-files").splitlines())
    assert "app/icon.png" in tracked and "package-lock.json" in tracked
    for ignored in (".env", ".env.local", ".next/x", "node_modules/x", "next-env.d.ts"):
        assert subprocess.run(["git", "check-ignore", "-q", ignored], cwd=project).returncode == 0
    assert subprocess.run(["git", "check-ignore", "-q", ".env.example"], cwd=project).returncode == 1


@needs_git
def test_app_scaffold_never_overwrites_an_existing_app_repo(tmp_path: Path) -> None:
    project = _scaffold_app(tmp_path).root
    (project / "app/page.tsx").write_text("// agent work\n")
    with pytest.raises(FileExistsError):
        _scaffold_app(tmp_path)
    assert (project / "app/page.tsx").read_text() == "// agent work\n"


def test_missing_git_fails_the_app_scaffold(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(tool_scaffold.shutil, "which", lambda _: None)
    with pytest.raises(tool_scaffold.ScaffoldError):
        _scaffold_app(tmp_path)


# ── generated icon ───────────────────────────────────────────────────────────

def _decode_png(data: bytes):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, chunks = 8, {}
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        chunks.setdefault(kind, b"")
        chunks[kind] += data[pos + 8:pos + 8 + length]
        pos += 12 + length
    width, height, depth, colour = struct.unpack(">IIBB", chunks[b"IHDR"][:10])
    raw = zlib.decompress(chunks[b"IDAT"])
    stride = width * 4 + 1
    assert all(raw[row * stride] == 0 for row in range(height))

    def pixel(x: int, y: int):
        start = y * stride + 1 + x * 4
        return tuple(raw[start:start + 4])

    return width, height, depth, colour, pixel


def test_generated_icon_is_a_deterministic_png_in_the_palette() -> None:
    names = ["invoices", "calendar", "weather", "my-app", "x", "Budget Tracker"]
    for name in names:
        data = render_app_icon(name)
        assert data == render_app_icon(name)
        width, height, depth, colour, pixel = _decode_png(data)
        assert (width, height, depth, colour) == (256, 256, 8, 6)
        assert app_icon_hue(name) in ICON_PALETTE_HUES
        assert pixel(0, 0)[3] == 0  # rounded corner is transparent
        assert pixel(128, 10) == app_icon_rgb(name) + (255,)
        assert any(pixel(x, 128) == (255, 255, 255, 255) for x in range(256))  # initials drawn
    hues = {app_icon_hue(n) for n in names + [f"app{i}" for i in range(40)]}
    assert len(hues) > 1


@needs_git
def test_scaffolded_icon_is_the_generated_icon(tmp_path: Path) -> None:
    result = _scaffold_app(tmp_path, name="weather")
    assert (result.root / "app/icon.png").read_bytes() == render_app_icon("weather")


# ── package data ─────────────────────────────────────────────────────────────

def test_every_template_file_ships_as_package_data() -> None:
    pyproject = (REPO / "pyproject.toml").read_text()
    assert '"app_templates/**/*"' in pyproject
    for template in TEMPLATES:
        files = [p for p in (TEMPLATES_DIR / template).rglob("*") if p.is_file()]
        assert files, template
        for path in files:
            # setuptools package-data globs skip dotfiles; templates use dot_ names.
            assert not any(part.startswith(".") for part in path.relative_to(TEMPLATES_DIR).parts)
    assert {p.name for p in (TEMPLATES_DIR / APP / "hosting").iterdir()} == {"local", *PROVIDERS}
    assert set(HOSTINGS) == {"local", "external"}


# ── the in-app MCP handler under node ────────────────────────────────────────

@needs_git
@needs_node
def test_app_mcp_handler_handshakes_and_enforces_bearer(tmp_path: Path) -> None:
    project = _scaffold_app(tmp_path).root
    proc = subprocess.run(["node", "--test", "tests/mcp.test.mjs"], cwd=project,
                          capture_output=True, text=True, timeout=120)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert re.search(r"^# fail 0$", proc.stdout, re.M), proc.stdout
    assert re.search(r"^# pass [1-9]", proc.stdout, re.M), proc.stdout
