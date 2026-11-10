/**
 * The 40 sea creatures a person can be in the Aquarium dashboard (FG-35).
 * Mirrors `hermes_cli/aquarium_creatures.py::CREATURES`; ids are stored in user prefs.
 */
export const CREATURES = [
  { id: "clownfish", label: "Clownfish" },
  { id: "blue-tang", label: "Blue tang" },
  { id: "angelfish", label: "Angelfish" },
  { id: "pufferfish", label: "Pufferfish" },
  { id: "seahorse", label: "Seahorse" },
  { id: "octopus", label: "Octopus" },
  { id: "squid", label: "Squid" },
  { id: "jellyfish", label: "Jellyfish" },
  { id: "sea-turtle", label: "Sea turtle" },
  { id: "dolphin", label: "Dolphin" },
  { id: "orca", label: "Orca" },
  { id: "whale", label: "Whale" },
  { id: "shark", label: "Shark" },
  { id: "manta-ray", label: "Manta ray" },
  { id: "stingray", label: "Stingray" },
  { id: "starfish", label: "Starfish" },
  { id: "crab", label: "Crab" },
  { id: "lobster", label: "Lobster" },
  { id: "shrimp", label: "Shrimp" },
  { id: "narwhal", label: "Narwhal" },
  // FG-35 v2 additions. Append only: never reorder (the Python fallback indexes the first 20).
  { id: "hammerhead", label: "Hammerhead shark" },
  { id: "beluga", label: "Beluga" },
  { id: "manatee", label: "Manatee" },
  { id: "seal", label: "Seal" },
  { id: "sea-otter", label: "Sea otter" },
  { id: "penguin", label: "Penguin" },
  { id: "sea-urchin", label: "Sea urchin" },
  { id: "nautilus", label: "Nautilus" },
  { id: "cuttlefish", label: "Cuttlefish" },
  { id: "swordfish", label: "Swordfish" },
  { id: "lionfish", label: "Lionfish" },
  { id: "moray-eel", label: "Moray eel" },
  { id: "sunfish", label: "Sunfish" },
  { id: "anglerfish", label: "Anglerfish" },
  { id: "butterflyfish", label: "Butterflyfish" },
  { id: "parrotfish", label: "Parrotfish" },
  { id: "hermit-crab", label: "Hermit crab" },
  { id: "nudibranch", label: "Nudibranch" },
  { id: "walrus", label: "Walrus" },
  { id: "sea-dragon", label: "Leafy sea dragon" },
] as const;

export type CreatureId = (typeof CREATURES)[number]["id"];

export const CREATURE_IDS: readonly CreatureId[] = CREATURES.map((c) => c.id);

export function isCreatureId(v: unknown): v is CreatureId {
  return typeof v === "string" && (CREATURE_IDS as readonly string[]).includes(v);
}

/** Default and bounds for the landing page's idle switch to the dashboard. */
export const IDLE_SECONDS_DEFAULT = 30;
export const IDLE_SECONDS_MIN = 5;
export const IDLE_SECONDS_MAX = 3600;

/** Canva-made transparent WebP sprite for a creature, facing right (`public/aquarium/creatures`). */
export function creatureSprite(id: CreatureId): string {
  return `/aquarium/creatures/${id}.webp`;
}

/** Canva-made scenery under `public/aquarium/decor`; `backdrop` is opaque, the rest are transparent. */
export const DECOR = ["backdrop", "kelp", "seagrass", "coral-branch", "coral-brain", "anemone", "rocks"] as const;
export type DecorId = (typeof DECOR)[number];
export function decorSprite(id: DecorId): string {
  return `/aquarium/decor/${id}.webp`;
}

/** The aquarium's display name (config.yaml `aquarium.name`, box-wide). Trimmed; empty means the default. */
export const AQUARIUM_NAME_DEFAULT = "Aquarium";
export const AQUARIUM_NAME_MAX = 60;

/** Seconds the dashboard legend stays up before fading out (it reopens from an info button). */
export const LEGEND_HIDE_MS = 8000;

/** How often the dashboard refreshes its snapshot. */
export const SNAPSHOT_POLL_MS = 5000;

export interface AquariumProfile {
  name: string;
  display_name: string;
}

export interface AquariumMetrics {
  chats: number;
  projects: number;
  tokens_in: number;
  tokens_out: number;
  /** In+out tokens in the last 24 h — drives swim speed. */
  tokens_24h: number;
  /** A chat turn is running for this person right now. */
  active_now: boolean;
}

export interface AquariumUser {
  user_id: string;
  name: string;
  creature: CreatureId;
  is_self: boolean;
  metrics: AquariumMetrics;
  profiles: AquariumProfile[];
}

/** `GET /api/aquarium` (BFF) → `GET /api/aquarium/snapshot` (Python). */
export interface AquariumSnapshot {
  generated_at: number;
  idle_seconds: number;
  /** Aquarium display name; never empty (falls back to `AQUARIUM_NAME_DEFAULT`). */
  name: string;
  users: AquariumUser[];
}

/** `GET|PUT /api/aquarium/settings`. PUT takes any subset of these fields (owner/admin only) and returns the full object. */
export interface AquariumSettings {
  idle_seconds: number;
  name: string;
}
