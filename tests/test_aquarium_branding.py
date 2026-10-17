"""The product is named Aquarium wherever a user or installer sees its name."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_app_platform_label_matches_plugin_manifest():
    from plugins.platforms.app import adapter

    manifest = yaml.safe_load((REPO_ROOT / "plugins/platforms/app/plugin.yaml").read_text())
    registered = {}

    class _Ctx:
        def register_platform(self, **kwargs):
            registered.update(kwargs)

    adapter.register(_Ctx())
    assert registered["name"] == "app"
    assert registered["label"] == manifest["label"] == "Aquarium"


def test_user_facing_platform_label_is_not_the_old_name():
    for rel in ("plugins/platforms/app/plugin.yaml", "plugins/platforms/app/adapter.py"):
        text = (REPO_ROOT / rel).read_text()
        assert not re.search(r'label[:=]\s*"?Agent Home', text), rel
