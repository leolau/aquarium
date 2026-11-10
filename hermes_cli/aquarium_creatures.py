"""The 20 sea creatures a person can be in the Aquarium dashboard (FG-35).

Mirrors ``agent-home/src/lib/aquarium/creatures.ts``; ids are stored in the
person's user prefs under ``creature``.
"""

from __future__ import annotations

import hashlib
import secrets

CREATURES: tuple[str, ...] = (
    "clownfish", "blue-tang", "angelfish", "pufferfish", "seahorse",
    "octopus", "squid", "jellyfish", "sea-turtle", "dolphin",
    "orca", "whale", "shark", "manta-ray", "stingray",
    "starfish", "crab", "lobster", "shrimp", "narwhal",
)

IDLE_SECONDS_DEFAULT = 30
IDLE_SECONDS_MIN = 5
IDLE_SECONDS_MAX = 3600


def is_creature(value: object) -> bool:
    return isinstance(value, str) and value in CREATURES


def random_creature() -> str:
    """The creature given to a newly created person."""
    return secrets.choice(CREATURES)


def fallback_creature(user_id: str) -> str:
    """Stable creature for a person created before FG-35 (no pref saved)."""
    digest = hashlib.sha256(user_id.encode("utf-8")).digest()
    return CREATURES[digest[0] % len(CREATURES)]
