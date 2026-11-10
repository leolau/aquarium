"""The 40 sea creatures a person can be in the Aquarium dashboard (FG-35).

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
    # FG-35 v2 additions. Append only: never reorder.
    "hammerhead", "beluga", "manatee", "seal", "sea-otter",
    "penguin", "sea-urchin", "nautilus", "cuttlefish", "swordfish",
    "lionfish", "moray-eel", "sunfish", "anglerfish", "butterflyfish",
    "parrotfish", "hermit-crab", "nudibranch", "walrus", "sea-dragon",
)

# The original 20: ``fallback_creature`` keeps indexing these so people without a
# saved pref keep the creature they already had.
_FALLBACK_CREATURES: tuple[str, ...] = CREATURES[:20]

IDLE_SECONDS_DEFAULT = 30
IDLE_SECONDS_MIN = 5
IDLE_SECONDS_MAX = 3600

AQUARIUM_NAME_DEFAULT = "Aquarium"
AQUARIUM_NAME_MAX = 60


def is_creature(value: object) -> bool:
    return isinstance(value, str) and value in CREATURES


def random_creature() -> str:
    """The creature given to a newly created person."""
    return secrets.choice(CREATURES)


def fallback_creature(user_id: str) -> str:
    """Stable creature for a person created before FG-35 (no pref saved)."""
    digest = hashlib.sha256(user_id.encode("utf-8")).digest()
    return _FALLBACK_CREATURES[digest[0] % len(_FALLBACK_CREATURES)]
