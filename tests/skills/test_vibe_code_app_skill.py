"""Contract checks for the FG-33 vibe-code-app skill (P8-2 item 2.3).

The skill's commands must actually run: every ``hermes ...`` line in its code
blocks parses with the real CLI parsers, and every ``hermes tool``/``kanban``
line also passes the agent shell's allowlist (deploy/hermes-tools-cli).
"""

from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import re
import shlex
from pathlib import Path

import pytest

from hermes_cli import app_runtime
from hermes_cli.kanban import build_parser as build_kanban_parser
from hermes_cli.projects_cli import register_projects_subparser
from hermes_cli.tool_cmd import register_tool_subparser
from tools.skill_manager_tool import _validate_frontmatter

REPO = Path(__file__).resolve().parents[2]
SKILLS = REPO / "skills"
SKILL = SKILLS / "software-development" / "vibe-code-app" / "SKILL.md"
LEGACY = SKILLS / "software-development" / "create-in-house-tool" / "SKILL.md"
TEMPLATE = REPO / "hermes_cli" / "app_templates" / "nextjs-supabase" / "base"

CONTENT = SKILL.read_text(encoding="utf-8")
SAMPLES = {"<slug>": "lunch-orders", "<path>": "/srv/hermes/tools/lunch-orders"}


def _commands() -> list[list[str]]:
    blocks = re.findall(r"```bash\n(.*?)```", CONTENT, re.DOTALL)
    out = []
    for block in blocks:
        for line in block.splitlines():
            line = line.strip()
            if not line.startswith("hermes "):
                continue
            for key, value in SAMPLES.items():
                line = line.replace(key, value)
            line = re.sub(r"<[^>]+>", "x", line)
            out.append(shlex.split(line, comments=True)[1:])
    return out


COMMANDS = _commands()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hermes", exit_on_error=False)
    sub = parser.add_subparsers(dest="command")
    register_tool_subparser(sub)
    build_kanban_parser(sub)
    register_projects_subparser(sub)
    return parser


def _allowlist():
    cli = REPO / "deploy" / "hermes-tools-cli"
    loader = importlib.machinery.SourceFileLoader("hermes_tools_cli_skill", str(cli))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def _related(content: str) -> list[str]:
    match = re.search(r"related_skills: \[(.*?)\]", content)
    return [s.strip() for s in match.group(1).split(",")] if match else []


def test_frontmatter_is_valid_and_related_skills_exist() -> None:
    assert _validate_frontmatter(CONTENT) is None
    assert re.search(r"^name: vibe-code-app$", CONTENT, re.MULTILINE)
    names = {
        m.group(1)
        for p in SKILLS.rglob("SKILL.md")
        if (m := re.search(r"^name: (\S+)$", p.read_text(encoding="utf-8"), re.MULTILINE))
    }
    assert _related(CONTENT) and set(_related(CONTENT)) <= names


def test_documents_scaffold_build_card_and_promote_commands() -> None:
    paths = {tuple(argv[:2]) for argv in COMMANDS}
    assert {("tool", "new"), ("tool", "promote"), ("projects", "create")} <= paths
    assert any(argv[0] == "kanban" and "create" in argv for argv in COMMANDS)


@pytest.mark.parametrize("argv", COMMANDS, ids=" ".join)
def test_every_command_parses_with_the_real_cli(argv) -> None:
    _parser().parse_args(argv)


@pytest.mark.parametrize(
    "argv", [a for a in COMMANDS if a[0] in ("tool", "kanban")], ids=" ".join
)
def test_tool_and_kanban_commands_pass_the_agent_shell_allowlist(argv) -> None:
    _allowlist().check(argv)


def test_scaffold_uses_the_app_template_for_both_hostings() -> None:
    news = [_parser().parse_args(a) for a in COMMANDS if a[:2] == ["tool", "new"]]
    assert {n.hosting for n in news} == {"local", "external"}
    assert all(n.template == "nextjs-supabase" for n in news)
    assert all(n.provider for n in news if n.hosting == "external")


def test_build_cards_go_to_the_coder_profile_in_the_app_workspace() -> None:
    cards = [a for a in COMMANDS if a[0] == "kanban" and "create" in a]
    for argv in cards:
        ns = _parser().parse_args(argv)
        assert ns.workspace.startswith("dir:")
        assert ns.assignee  # placeholder resolved by coder_profile_for
    assert "coder_profile_for" in CONTENT
    assert "`internal-coder` for local" in CONTENT
    assert "`external-coder` for external" in CONTENT


def test_preview_and_prod_paths_match_the_runtime() -> None:
    slug = SAMPLES["<slug>"]
    rendered = CONTENT.replace("<slug>", slug)
    assert app_runtime.app_path(slug, "dev") in rendered
    assert app_runtime.app_path(slug, "prod") in rendered


def test_definition_of_done_matches_the_template() -> None:
    import json

    scripts = json.loads((TEMPLATE / "package.json").read_text())["scripts"]
    assert "check" in scripts
    assert (TEMPLATE / "tests" / "mcp.test.mjs").is_file()
    for needle in ("npm ci && npm run check", "initialize → tools/list → tools/call",
                   "screenshot", "`dev` branch"):
        assert needle in CONTENT


def test_safety_rules() -> None:
    assert "exactly one question" in CONTENT.lower()
    assert "**Local** as the first (pre-selected) choice" in CONTENT
    assert "data-appmcp-deny" in CONTENT
    assert "exactly one explicit confirmation" in CONTENT
    assert "without a C6 approval request" in CONTENT
    assert "**next** chat" in CONTENT
    assert not re.search(r"export HERMES_\w+=|HERMES_\w+=", CONTENT)


def test_create_in_house_tool_points_at_the_new_workflow() -> None:
    legacy = LEGACY.read_text(encoding="utf-8")
    assert _validate_frontmatter(legacy) is None
    assert "vibe-code-app" in _related(legacy)
    assert "**vibe-code-app**" in legacy
