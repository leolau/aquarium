/**
 * FG-35 usage → look mapping. Every curve is monotonic in its inputs and
 * clamped, so a heavy user can never outgrow the tank or outrun the frame.
 */
import { CREATURE_IDS, type AquariumMetrics, type CreatureId } from "@/lib/aquarium/creatures";

export const SIZE_MIN = 24;
export const SIZE_MAX = 200;
/**
 * Sizes sit on a log scale of `usageScore` between the lightest and the
 * busiest person on the box: the busiest reaches `SIZE_MAX`, the lightest
 * `SIZE_MIN`. The span never shrinks below `SIZE_LOG_SPAN_MIN` (in
 * `log10(1 + score)`), so near-equal people stay near-equal in size, and the
 * reference never drops below `SIZE_SCORE_FLOOR`, so a box of light users
 * doesn't swim as whales.
 */
export const SIZE_LOG_SPAN_MIN = 0.25;
export const SIZE_SCORE_FLOOR = 4;

/** Swim speed in CSS px per second. */
export const SPEED_MIN = 22;
export const SPEED_MAX = 110;
/** `log10(1 + tokens_24h)` at which a creature reaches `SPEED_MAX` (10 M tokens). */
export const SPEED_LOG_MAX = 7;
/** The biggest creatures cruise this much slower than their usage alone says. */
export const SIZE_SPEED_DRAG = 0.3;

export const FOLLOWER_SIZE_MIN = 16;
export const FOLLOWER_SIZE_MAX = 80;
const FOLLOWER_RATIO_MIN = 0.35;
const FOLLOWER_RATIO_MAX = 0.45;

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

/** The size reference for a snapshot: the busiest person's score, floored. */
export function busiestScore(metrics: Iterable<AquariumMetrics>): number {
  let max = SIZE_SCORE_FLOOR;
  for (const m of metrics) max = Math.max(max, usageScore(m));
  return Number.isFinite(max) ? max : SIZE_SCORE_FLOOR;
}

/** 0 (smallest) … 1 (biggest) for a body size. */
export function sizeT(size: number): number {
  return clamp((size - SIZE_MIN) / (SIZE_MAX - SIZE_MIN), 0, 1);
}

/** The lightest non-zero score in a snapshot, the bottom of the size scale (`0` when nobody has usage yet). */
export function lightestScore(metrics: Iterable<AquariumMetrics>): number {
  let min = Infinity;
  for (const m of metrics) {
    const score = usageScore(m);
    if (score > 0 && score < min) min = score;
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * Leader body size in CSS px, `SIZE_MIN`–`SIZE_MAX`, on a log scale between
 * `lightest` and `busiest` (see `lightestScore` / `busiestScore`).
 */
export function creatureSize(m: AquariumMetrics, busiest = SIZE_SCORE_FLOOR, lightest = 0): number {
  const ref = Math.max(SIZE_SCORE_FLOOR, Number.isFinite(busiest) ? busiest : SIZE_SCORE_FLOOR);
  const score = usageScore(m);
  if (!(score > 0)) return SIZE_MIN;
  const top = Math.log10(1 + ref);
  const bottom = Math.log10(1 + clamp(Number.isFinite(lightest) ? lightest : 0, 0, ref));
  const span = Math.max(SIZE_LOG_SPAN_MIN, top - bottom);
  const t = clamp(1 - (top - Math.log10(1 + score)) / span, 0, 1);
  return SIZE_MIN + (SIZE_MAX - SIZE_MIN) * t;
}

/** Leader cruising speed in CSS px/s, `SPEED_MIN`–`SPEED_MAX`; a body `size` slows big creatures a little. */
export function creatureSpeed(m: Pick<AquariumMetrics, "tokens_24h">, size = SIZE_MIN): number {
  const t = clamp(Math.log10(1 + nonNegative(m.tokens_24h)) / SPEED_LOG_MAX, 0, 1);
  const speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * t;
  return Math.max(SPEED_MIN, speed * (1 - SIZE_SPEED_DRAG * sizeT(size)));
}

/** A profile follower's size for a leader of `leaderSize`; `seed` picks a ratio in 35–45 %. */
export function followerSize(leaderSize: number, seed = 0.5): number {
  const r = FOLLOWER_RATIO_MIN + (FOLLOWER_RATIO_MAX - FOLLOWER_RATIO_MIN) * clamp(Number.isFinite(seed) ? seed : 0.5, 0, 1);
  return clamp(nonNegative(leaderSize) * r, FOLLOWER_SIZE_MIN, FOLLOWER_SIZE_MAX);
}

/** FNV-1a, 32-bit. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable creature for any string key, the same on every screen. */
export function profileCreature(key: string): CreatureId {
  return CREATURE_IDS[hash(key) % CREATURE_IDS.length];
}

/** The creature a person's profile swims as: varies per person + profile and never matches the leader. */
export function followerCreature(userId: string, profileName: string, leader?: CreatureId): CreatureId {
  const i = hash(`${userId}/${profileName}`) % CREATURE_IDS.length;
  const id = CREATURE_IDS[i];
  return id === leader ? CREATURE_IDS[(i + 1) % CREATURE_IDS.length] : id;
}

/** Stable 0–1 value for a follower, used for its size ratio and slot jitter. */
export function followerSeed(userId: string, profileName: string): number {
  return (hash(`${profileName}#${userId}`) % 1000) / 999;
}

/** `1234` → `1.2k`, `2_500_000` → `2.5M`. */
export function formatCount(n: number): string {
  const v = nonNegative(n);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}
