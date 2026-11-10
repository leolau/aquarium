/**
 * The 20 sea creatures a person can be in the Aquarium dashboard (FG-35).
 * Mirrors `hermes_cli/aquarium.py::CREATURES`; ids are stored in user prefs.
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
  users: AquariumUser[];
}
