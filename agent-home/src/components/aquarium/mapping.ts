/**
 * FG-35 usage → look mapping. Every curve is monotonic in its inputs and
 * clamped, so a heavy user can never outgrow the tank or outrun the frame.
 */
import { CREATURE_IDS, type AquariumMetrics, type CreatureId } from "@/lib/aquarium/creatures";

export const SIZE_MIN = 28;
export const SIZE_MAX = 120;
/** Usage score at which a creature reaches `SIZE_MAX`. */
export const SIZE_SCORE_MAX = 10;

/** Swim speed in CSS px per second. */
export const SPEED_MIN = 22;
export const SPEED_MAX = 110;
/** `log10(1 + tokens_24h)` at which a creature reaches `SPEED_MAX` (10 M tokens). */
export const SPEED_LOG_MAX = 7;

export const FOLLOWER_SIZE_MIN = 16;
export const FOLLOWER_SIZE_MAX = 40;
const FOLLOWER_RATIO = 0.38;

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** `log10(1 + tokens_in + tokens_out) + chats / 20 + projects / 5`. */
export function usageScore(m: Pick<AquariumMetrics, "chats" | "projects" | "tokens_in" | "tokens_out">): number {
  const tokens = nonNegative(m.tokens_in) + nonNegative(m.tokens_out);
  return Math.log10(1 + tokens) + nonNegative(m.chats) / 20 + nonNegative(m.projects) / 5;
}

/** Leader body size in CSS px, `SIZE_MIN`–`SIZE_MAX`. */
export function creatureSize(m: AquariumMetrics): number {
  const t = clamp(usageScore(m) / SIZE_SCORE_MAX, 0, 1);
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * t;
}

/** Leader cruising speed in CSS px/s, `SPEED_MIN`–`SPEED_MAX`. */
export function creatureSpeed(m: Pick<AquariumMetrics, "tokens_24h">): number {
  const t = clamp(Math.log10(1 + nonNegative(m.tokens_24h)) / SPEED_LOG_MAX, 0, 1);
  return SPEED_MIN + (SPEED_MAX - SPEED_MIN) * t;
}

/** A profile follower's size for a leader of `leaderSize`. */
export function followerSize(leaderSize: number): number {
  return clamp(nonNegative(leaderSize) * FOLLOWER_RATIO, FOLLOWER_SIZE_MIN, FOLLOWER_SIZE_MAX);
}

/** FNV-1a, 32-bit. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The creature a profile swims as: stable for its name, the same on every screen. */
export function profileCreature(profileName: string): CreatureId {
  return CREATURE_IDS[hash(profileName) % CREATURE_IDS.length];
}

/** `1234` → `1.2k`, `2_500_000` → `2.5M`. */
export function formatCount(n: number): string {
  const v = nonNegative(n);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}
