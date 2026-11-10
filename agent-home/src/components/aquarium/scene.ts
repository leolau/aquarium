/**
 * The aquarium's simulation: plain mutable objects stepped by `stepScene` once
 * per animation frame (dt in seconds). React never sees these — a snapshot
 * only retargets size/speed and adds or retires creatures, which fade.
 */
import type { AquariumProfile, AquariumSnapshot, AquariumUser, CreatureId } from "@/lib/aquarium/creatures";

import {
  busiestScore,
  creatureSize,
  lightestScore,
  creatureSpeed,
  followerCreature,
  followerSeed,
  followerSize,
  sizeT,
} from "./mapping";

/** Time constant of size/speed easing; ~95 % settled after 3τ ≈ 1 s. */
export const EASE_TAU = 0.33;
export const FADE_SECONDS = 0.8;
/** Longest step simulated in one frame, so a stalled tab never teleports. */
export const MAX_DT = 0.1;
export const REDUCED_MOTION_SPEED = 0.3;
export const MAX_BUBBLES = 320;
/** A tap target is dropped after this long, so an unreachable spot never pins a creature. */
export const GOAL_TIMEOUT = 8;
/** Speed floor (CSS px/s) while swimming to a tapped spot, so slow creatures still answer. */
export const GOAL_MIN_SPEED = 170;
/** After a shake each leader cruises at its speed × a factor in this range. */
export const SHAKE_SPEED_MIN = 0.55;
export const SHAKE_SPEED_MAX = 1.9;
/** A turn flips the sprite (scaleX through 0) over this long. */
export const FLIP_SECONDS = 0.32;
/** With more swimmers than this on screen, follower name chips only show for the focused person. */
export const FOLLOWER_CHIP_LIMIT = 60;
export const LEADER_LABEL_H = 18;
export const CHIP_LABEL_H = 15;
const LEADER_LABEL_PAD = 7;
const CHIP_LABEL_PAD = 5;
const LABEL_GAP = 2;
const LEADER_NAME_MAX = 28;
const CHIP_NAME_MAX = 20;
const SEP_FACTOR = 0.5;
const SEP_PAD = 10;
const SEP_ACCEL = 240;
const SEP_CELL = 96;
const FOLLOW_K = 16;

export interface Bounds {
  width: number;
  height: number;
  /** Swim band: creature centres stay between `top` and `bottom`. */
  top: number;
  bottom: number;
}

export function sceneBounds(width: number, height: number): Bounds {
  const seabed = Math.min(96, height * 0.13);
  return { width, height, top: 24, bottom: Math.max(48, height - seabed) };
}

export type LabelKind = "leader" | "chip";

export interface Swimmer {
  creature: CreatureId;
  /** The owning person's `user_id`: swimmers of one group never repel each other. */
  group: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  targetSize: number;
  alpha: number;
  leaving: boolean;
  /** -1 facing left … 1 facing right; passes through 0 during a turn's flip. */
  face: number;
  faceTarget: number;
  /** Radians the body leans into its heading (positive = nose down). */
  tilt: number;
  /** Body-wave phase; advances faster the quicker the creature swims. */
  phase: number;
  bobPhase: number;
  label: string;
  labelX: number;
  /** Top of the label pill, after de-overlap. */
  labelY: number;
  labelW: number;
  labelAlpha: number;
  labelPlaced: boolean;
}

export interface Follower extends Swimmer {
  profile: AquariumProfile;
  /** Stable 0–1 per person + profile: size ratio and sway phase. */
  seed: number;
  slot: number;
}

export interface Goal {
  x: number;
  y: number;
  /** Seconds left before the goal is dropped. */
  ttl: number;
}

export interface Leader extends Swimmer {
  user: AquariumUser;
  speed: number;
  targetSpeed: number;
  /** Multiplies the snapshot speed; set by a shake and kept across snapshots. */
  speedFactor: number;
  /** Where the leader is swimming after a tap, if anywhere. */
  goal: Goal | null;
  heading: number;
  turnRate: number;
  /** Smoothed swim direction; followers' slots hang off it. */
  trailAngle: number;
  bubbleClock: number;
  burstClock: number;
  sepX: number;
  sepY: number;
  followers: Map<string, Follower>;
  slotCount: number;
}

export interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  wobble: number;
}

export interface Scene {
  leaders: Map<string, Leader>;
  bubbles: Bubble[];
  ambientClock: number;
  rng: () => number;
  /** Usage score of the busiest person, the size reference. */
  busiest: number;
  /** Lightest non-zero usage score, the bottom of the size scale. */
  lightest: number;
  /** Person whose follower chips stay visible when the tank is crowded (hover/tap). */
  focus: string | null;
  /** Label text width in CSS px; the renderer swaps in canvas `measureText`. */
  measure: (text: string, kind: LabelKind) => number;
}

export interface StepOptions {
  reducedMotion?: boolean;
}

function estimateWidth(text: string, kind: LabelKind): number {
  return text.length * (kind === "leader" ? 7 : 6);
}

export function createScene(rng: () => number = Math.random): Scene {
  return { leaders: new Map(), bubbles: [], ambientClock: 0, rng, busiest: 0, lightest: 0, focus: null, measure: estimateWidth };
}

/** Frame-rate independent exponential approach of `target`. */
export function easeToward(current: number, target: number, dt: number, tau = EASE_TAU): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

function xRange(b: Bounds, size: number): [number, number] {
  const m = Math.min(size / 2 + 8, b.width / 2);
  return [m, Math.max(m, b.width - m)];
}

function yRange(b: Bounds, size: number): [number, number] {
  const lo = b.top + size / 2;
  return [lo, Math.max(lo, b.bottom - size * 0.3)];
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** How far behind its leader a follower may hang: ~2 leader lengths, with room for small leaders. */
export function maxTrail(leaderSize: number, size: number): number {
  return Math.max(2 * leaderSize, leaderSize * 0.5 + size * 3.5);
}

/** The gap a follower always keeps behind its leader's centre, along the heading. */
export function minBehind(leaderSize: number): number {
  return leaderSize * 0.25;
}

/**
 * Slot `i` of `n` in the arc behind a leader: `back` along the reversed
 * heading, `lateral` across it. Rows of up to 3–4, outer slots a bit further
 * back so the school forms a chevron.
 */
export function followerSlot(i: number, n: number, leaderSize: number, size: number): { back: number; lateral: number } {
  const count = Math.max(1, n);
  const perRow = count <= 3 ? count : count <= 8 ? 3 : 4;
  const row = Math.floor(i / perRow);
  const inRow = Math.max(1, Math.min(perRow, count - row * perRow));
  const col = i % perRow;
  const lateral = (col - (inRow - 1) / 2) * size * 1.1;
  const back = leaderSize * 0.5 + size * (0.8 + 1.05 * row) + Math.abs(lateral) * 0.4;
  return { back: clamp(back, minBehind(leaderSize) + size * 0.5, maxTrail(leaderSize, size)), lateral };
}

function swimmerBase(creature: CreatureId, group: string, x: number, y: number, size: number, face: number, rng: () => number): Swimmer {
  return {
    creature,
    group,
    x,
    y,
    vx: 0,
    vy: 0,
    size,
    targetSize: size,
    alpha: 0,
    leaving: false,
    face,
    faceTarget: face,
    tilt: 0,
    phase: rng() * Math.PI * 2,
    bobPhase: rng() * Math.PI * 2,
    label: "",
    labelX: x,
    labelY: y,
    labelW: 0,
    labelAlpha: 0,
    labelPlaced: false,
  };
}

function spawnFollower(profile: AquariumProfile, leader: Leader, slot: number, n: number, rng: () => number): Follower {
  const seed = followerSeed(leader.user.user_id, profile.name);
  const size = followerSize(leader.targetSize, seed);
  const { back, lateral } = followerSlot(slot, n, leader.size, size);
  const ax = Math.cos(leader.trailAngle);
  const ay = Math.sin(leader.trailAngle);
  const creature = followerCreature(leader.user.user_id, profile.name, leader.user.creature);
  const f: Follower = {
    ...swimmerBase(creature, leader.user.user_id, leader.x - ax * back - ay * lateral, leader.y - ay * back + ax * lateral, size, leader.face, rng),
    profile,
    seed,
    slot,
  };
  f.vx = leader.vx;
  f.vy = leader.vy;
  return f;
}

/** Diffs a snapshot into the scene: new people fade in, missing ones fade out. */
export function applySnapshot(scene: Scene, snapshot: AquariumSnapshot, bounds: Bounds): void {
  const { rng } = scene;
  const metrics = snapshot.users.map((u) => u.metrics);
  scene.busiest = busiestScore(metrics);
  scene.lightest = lightestScore(metrics);
  const seen = new Set<string>();
  for (const user of snapshot.users) {
    seen.add(user.user_id);
    const size = creatureSize(user.metrics, scene.busiest, scene.lightest);
    const speed = creatureSpeed(user.metrics, size);
    let leader = scene.leaders.get(user.user_id);
    if (!leader) {
      const [x0, x1] = xRange(bounds, size);
      const [y0, y1] = yRange(bounds, size);
      const heading = (rng() - 0.5) * 0.8 + (rng() < 0.5 ? 0 : Math.PI);
      const face = Math.cos(heading) >= 0 ? 1 : -1;
      leader = {
        ...swimmerBase(user.creature, user.user_id, x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0), size, face, rng),
        user,
        speed,
        targetSpeed: speed,
        speedFactor: 1,
        goal: null,
        heading,
        turnRate: 0,
        trailAngle: heading,
        bubbleClock: rng(),
        burstClock: 3 + rng() * 6,
        sepX: 0,
        sepY: 0,
        followers: new Map(),
        slotCount: 0,
      };
      leader.vx = Math.cos(heading) * speed;
      leader.vy = Math.sin(heading) * speed * 0.4;
      scene.leaders.set(user.user_id, leader);
    }
    leader.user = user;
    leader.creature = user.creature;
    leader.leaving = false;
    leader.targetSize = size;
    leader.targetSpeed = speed;
    leader.label = truncate(user.name, LEADER_NAME_MAX);

    const names = new Set<string>();
    const n = user.profiles.length;
    leader.slotCount = n;
    user.profiles.forEach((profile, slot) => {
      names.add(profile.name);
      let f = leader.followers.get(profile.name);
      if (!f) {
        f = spawnFollower(profile, leader, slot, n, rng);
        leader.followers.set(profile.name, f);
      }
      f.profile = profile;
      f.slot = slot;
      f.leaving = false;
      f.creature = followerCreature(user.user_id, profile.name, user.creature);
      f.targetSize = followerSize(size, f.seed);
      f.label = truncate(profile.display_name || profile.name, CHIP_NAME_MAX);
    });
    for (const [name, f] of leader.followers) if (!names.has(name)) f.leaving = true;
  }
  for (const [id, leader] of scene.leaders) if (!seen.has(id)) leader.leaving = true;
}

function fade(s: Swimmer, dt: number): void {
  s.alpha = clamp(s.alpha + ((s.leaving ? -1 : 1) * dt) / FADE_SECONDS, 0, 1);
}

/** Turns toward `dir` (±1; 0 keeps the current target) through a quick flip. */
function flip(s: Swimmer, dir: number, dt: number, reduced: boolean): void {
  if (dir !== 0) s.faceTarget = dir;
  if (reduced) {
    s.face = s.faceTarget;
    return;
  }
  const step = (2 / FLIP_SECONDS) * dt;
  s.face = s.face < s.faceTarget ? Math.min(s.faceTarget, s.face + step) : Math.max(s.faceTarget, s.face - step);
}

function lean(s: Swimmer, vx: number, vy: number, dt: number): void {
  s.tilt = easeToward(s.tilt, clamp(Math.atan2(vy, Math.abs(vx) + 1), -0.35, 0.35), dt, 0.25);
}

function wave(s: Swimmer, speed: number, dt: number): void {
  s.phase += dt * (2.2 + (3.5 * speed) / (s.size + 30));
}

function stepLeader(scene: Scene, l: Leader, dt: number, b: Bounds, reduced: boolean): void {
  const { rng } = scene;
  l.size = easeToward(l.size, l.targetSize, dt);
  l.speed = easeToward(l.speed, l.targetSpeed, dt);
  const base = l.speed * l.speedFactor * (reduced ? REDUCED_MOTION_SPEED : 1);
  const [x0, x1] = xRange(b, l.size);
  const [y0, y1] = yRange(b, l.size);

  if (l.goal) {
    l.goal.ttl -= dt;
    const dx = l.goal.x - l.x;
    const dy = l.goal.y - l.y;
    const dist = Math.hypot(dx, dy);
    if (l.goal.ttl <= 0 || dist < Math.max(10, l.size * 0.3)) {
      l.goal = null;
    } else {
      const cruise = Math.max(base * 1.6, GOAL_MIN_SPEED * (reduced ? REDUCED_MOTION_SPEED : 1));
      l.heading -= angleDiff(l.heading, Math.atan2(dy, dx)) * clamp(dt * 5, 0, 1);
      l.turnRate = 0;
      // Ease off near the spot so the creature arrives instead of overshooting.
      const arrive = Math.min(1, dist / Math.max(40, l.size));
      const steer = 1 - Math.exp(-dt * 3.5);
      l.vx += (Math.cos(l.heading) * cruise * arrive - l.vx) * steer + l.sepX * dt;
      l.vy += (Math.sin(l.heading) * cruise * arrive - l.vy) * steer + l.sepY * dt;
      l.x = clamp(l.x + l.vx * dt, x0, x1);
      l.y = clamp(l.y + l.vy * dt, y0, y1);
      finishLeaderStep(scene, l, dt, cruise, reduced);
      return;
    }
  }
  const cruise = base;
  const heavy = sizeT(l.size);

  // Smooth wander: the turn rate is a damped random walk (calmer for big bodies), the heading integrates it.
  l.turnRate += (rng() - 0.5) * 3.2 * (1 - 0.6 * heavy) * dt;
  l.turnRate *= Math.exp(-dt * 1.2);
  l.turnRate = clamp(l.turnRate, -0.9, 0.9);
  l.heading += l.turnRate * dt;

  // Soft walls: inside the margin the heading bends toward the open water.
  const mx = Math.min(Math.max(70, l.size * 1.4), (x1 - x0) / 2 || 1);
  const my = Math.min(Math.max(50, l.size), (y1 - y0) / 2 || 1);
  let px = 0;
  let py = 0;
  if (l.x - x0 < mx) px += (1 - (l.x - x0) / mx) ** 2;
  if (x1 - l.x < mx) px -= (1 - (x1 - l.x) / mx) ** 2;
  if (l.y - y0 < my) py += (1 - (l.y - y0) / my) ** 2;
  if (y1 - l.y < my) py -= (1 - (y1 - l.y) / my) ** 2;
  const push = Math.hypot(px, py);
  if (push > 0) {
    const inward = Math.atan2(py, px);
    l.heading -= angleDiff(l.heading, inward) * clamp(push * 2.5 * dt, 0, 1);
  }
  const sep = Math.hypot(l.sepX, l.sepY);
  if (sep > 0) l.heading -= angleDiff(l.heading, Math.atan2(l.sepY, l.sepX)) * clamp((sep / SEP_ACCEL) * 2 * dt, 0, 1);

  const wantX = Math.cos(l.heading) * cruise;
  const wantY = Math.sin(l.heading) * cruise * 0.45;
  const steer = 1 - Math.exp(-dt * (1.8 - 0.6 * heavy));
  l.vx += (wantX - l.vx) * steer + px * cruise * 1.5 * dt + l.sepX * dt;
  l.vy += (wantY - l.vy) * steer + py * cruise * 1.5 * dt + l.sepY * dt;
  l.x = clamp(l.x + l.vx * dt, x0, x1);
  l.y = clamp(l.y + l.vy * dt, y0, y1);
  finishLeaderStep(scene, l, dt, cruise, reduced);
}

function finishLeaderStep(scene: Scene, l: Leader, dt: number, cruise: number, reduced: boolean): void {
  const { rng } = scene;
  const speed = Math.hypot(l.vx, l.vy);
  if (speed > 2) l.trailAngle += angleDiff(Math.atan2(l.vy, l.vx), l.trailAngle) * (1 - Math.exp(-dt / 0.25));
  const threshold = Math.max(4, cruise * 0.2);
  flip(l, l.vx > threshold ? 1 : l.vx < -threshold ? -1 : 0, dt, reduced);
  lean(l, l.vx, l.vy, dt);
  wave(l, speed, dt);
  l.bobPhase += dt * 0.9;
  fade(l, dt);

  if (!reduced && l.user.metrics.active_now && !l.leaving) {
    const dir = l.faceTarget;
    l.bubbleClock -= dt;
    if (l.bubbleClock <= 0) {
      l.bubbleClock = 0.14 + rng() * 0.14;
      addBubble(scene, l.x - dir * l.size * 0.46, l.y + (rng() - 0.5) * l.size * 0.12, 1 + rng() * (1.5 + l.size * 0.012));
    }
    l.burstClock -= dt;
    if (l.burstClock <= 0) {
      l.burstClock = 4 + rng() * 5;
      const count = 6 + Math.floor(rng() * 4);
      for (let i = 0; i < count; i++) {
        addBubble(scene, l.x + dir * l.size * (0.42 + rng() * 0.1), l.y - l.size * 0.1 + (rng() - 0.5) * 8, 1.5 + rng() * 3);
      }
    }
  }
}

function stepFollowers(l: Leader, dt: number, b: Bounds, reduced: boolean): void {
  const ax = Math.cos(l.trailAngle);
  const ay = Math.sin(l.trailAngle);
  const k = reduced ? FOLLOW_K * 0.5 : FOLLOW_K;
  const c = 2 * Math.sqrt(k) * 0.85;
  const n = Math.max(l.slotCount, 1);
  const behind = minBehind(l.size);
  const dir = ax > 0.15 ? 1 : ax < -0.15 ? -1 : 0;
  for (const f of l.followers.values()) {
    f.size = easeToward(f.size, f.targetSize, dt);
    const { back, lateral } = followerSlot(f.slot, n, l.size, f.size);
    const sway = (reduced ? 0 : Math.sin(l.bobPhase * 1.3 + f.seed * Math.PI * 2)) * f.size * 0.18;
    const tx = l.x - ax * back - ay * (lateral + sway);
    const ty = l.y - ay * back + ax * (lateral + sway);
    f.vx += (k * (tx - f.x) + c * (l.vx - f.vx)) * dt;
    f.vy += (k * (ty - f.y) + c * (l.vy - f.vy)) * dt;
    f.x = clamp(f.x + f.vx * dt, f.size * 0.3, Math.max(f.size * 0.3, b.width - f.size * 0.3));
    f.y = clamp(f.y + f.vy * dt, b.top, Math.max(b.top, b.bottom + f.size * 0.3));

    // Hard limits: never level with or ahead of the leader, never far off.
    const along = (f.x - l.x) * ax + (f.y - l.y) * ay;
    if (along > -behind) {
      const shift = -behind - along;
      f.x += ax * shift;
      f.y += ay * shift;
      const rel = (f.vx - l.vx) * ax + (f.vy - l.vy) * ay;
      if (rel > 0) {
        f.vx -= ax * rel;
        f.vy -= ay * rel;
      }
    }
    const dx = f.x - l.x;
    const dy = f.y - l.y;
    const d = Math.hypot(dx, dy);
    const far = maxTrail(l.size, f.size);
    if (d > far) {
      f.x = l.x + (dx / d) * far;
      f.y = l.y + (dy / d) * far;
      const out = ((f.vx - l.vx) * dx + (f.vy - l.vy) * dy) / d;
      if (out > 0) {
        f.vx -= (dx / d) * out;
        f.vy -= (dy / d) * out;
      }
    }

    flip(f, dir, dt, reduced);
    lean(f, ax, ay, dt);
    wave(f, Math.hypot(f.vx, f.vy), dt);
    f.bobPhase += dt * (1.1 + f.seed * 0.6);
    fade(f, dt);
  }
  for (const [name, f] of l.followers) if (f.leaving && f.alpha <= 0) l.followers.delete(name);
}

function cellKey(cx: number, cy: number): number {
  return (cx + 2048) * 8192 + (cy + 2048);
}

/** Separation steering: leaders (and followers) of different people push apart; the smaller one yields more. */
function separate(scene: Scene, dt: number): void {
  const grid = new Map<number, Swimmer[]>();
  const all: Swimmer[] = [];
  let maxSize = 0;
  for (const l of scene.leaders.values()) {
    l.sepX = 0;
    l.sepY = 0;
    if (l.leaving) continue;
    all.push(l);
    for (const f of l.followers.values()) if (!f.leaving) all.push(f);
  }
  for (const s of all) {
    maxSize = Math.max(maxSize, s.size);
    const key = cellKey(Math.floor(s.x / SEP_CELL), Math.floor(s.y / SEP_CELL));
    const cell = grid.get(key);
    if (cell) cell.push(s);
    else grid.set(key, [s]);
  }
  for (const s of all) {
    const reach = (s.size + maxSize) * SEP_FACTOR + SEP_PAD;
    const cx0 = Math.floor((s.x - reach) / SEP_CELL);
    const cx1 = Math.floor((s.x + reach) / SEP_CELL);
    const cy0 = Math.floor((s.y - reach) / SEP_CELL);
    const cy1 = Math.floor((s.y + reach) / SEP_CELL);
    let sx = 0;
    let sy = 0;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(cellKey(cx, cy));
        if (!cell) continue;
        for (const o of cell) {
          if (o.group === s.group) continue;
          const min = (s.size + o.size) * SEP_FACTOR + SEP_PAD;
          const dx = s.x - o.x;
          const dy = s.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          const d = Math.sqrt(d2) || 0.01;
          const ux = d2 > 0 ? dx / d : 1;
          const uy = d2 > 0 ? dy / d : 0;
          const strength = (1 - d / min) * SEP_ACCEL * ((2 * o.size) / (s.size + o.size));
          sx += ux * strength;
          sy += uy * strength;
        }
      }
    }
    if (sx === 0 && sy === 0) continue;
    if ("followers" in s) {
      (s as Leader).sepX = sx;
      (s as Leader).sepY = sy;
    } else {
      s.vx += sx * dt;
      s.vy += sy * dt;
    }
  }
}

function addBubble(scene: Scene, x: number, y: number, r: number): void {
  if (scene.bubbles.length >= MAX_BUBBLES) scene.bubbles.shift();
  scene.bubbles.push({ x, y, r, vy: -(24 + r * 9 + scene.rng() * 12), wobble: scene.rng() * Math.PI * 2 });
}

function stepBubbles(scene: Scene, dt: number, b: Bounds, reduced: boolean): void {
  if (reduced) {
    scene.bubbles.length = 0;
    return;
  }
  scene.ambientClock -= dt;
  const rate = clamp(b.width / 900, 0.4, 2.5);
  while (scene.ambientClock <= 0) {
    scene.ambientClock += (0.35 + scene.rng() * 0.6) / rate;
    addBubble(scene, scene.rng() * b.width, b.height - 8, 1.5 + scene.rng() * 4);
  }
  let keep = 0;
  for (const bub of scene.bubbles) {
    bub.y += bub.vy * dt;
    bub.wobble += dt * 2.2;
    bub.x += Math.sin(bub.wobble) * 10 * dt;
    if (bub.y + bub.r > 0) scene.bubbles[keep++] = bub;
  }
  scene.bubbles.length = keep;
}

export interface LabelBox {
  /** Desired centre x and top y. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Lower ranks are placed first and keep their spot (leaders 0, chips 1). */
  rank?: number;
}

function collides(x: number, y: number, w: number, h: number, p: { x: number; y: number; w: number; h: number }): boolean {
  return Math.abs(x - p.x) < (w + p.w) / 2 + LABEL_GAP && y < p.y + p.h + LABEL_GAP && y + h + LABEL_GAP > p.y;
}

/**
 * Greedy label de-overlap: boxes are placed by rank then top, each nudged
 * down past any placed box it hits (or up when it runs out of tank), and
 * clamped inside `width` × `height`. Returns centre x / top y per box.
 */
export function layoutLabels(boxes: readonly LabelBox[], width: number, height: number): { x: number; y: number }[] {
  const order = boxes.map((_, i) => i).sort((a, b) => (boxes[a].rank ?? 0) - (boxes[b].rank ?? 0) || boxes[a].y - boxes[b].y);
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const out: { x: number; y: number }[] = new Array(boxes.length);
  for (const i of order) {
    const { w, h } = boxes[i];
    const x = clamp(boxes[i].x, w / 2 + 2, Math.max(w / 2 + 2, width - w / 2 - 2));
    const maxY = Math.max(2, height - h - 2);
    const desired = clamp(boxes[i].y, 2, maxY);
    let y = desired;
    for (let pass = 0; pass <= placed.length; pass++) {
      const hit = placed.find((p) => collides(x, y, w, h, p));
      if (!hit) break;
      y = hit.y + hit.h + LABEL_GAP;
    }
    if (y > maxY) {
      y = desired;
      for (let pass = 0; pass <= placed.length; pass++) {
        const hit = placed.find((p) => collides(x, y, w, h, p));
        if (!hit) break;
        y = hit.y - h - LABEL_GAP;
      }
      y = clamp(y, 2, maxY);
    }
    placed.push({ x, y, w, h });
    out[i] = { x, y };
  }
  return out;
}

function labelBox(s: Swimmer, kind: LabelKind, measure: Scene["measure"]): LabelBox {
  s.labelW = Math.ceil(measure(s.label, kind)) + 2 * (kind === "leader" ? LEADER_LABEL_PAD : CHIP_LABEL_PAD);
  return kind === "leader"
    ? { x: s.x, y: s.y + s.size * 0.36 + 3, w: s.labelW, h: LEADER_LABEL_H, rank: 0 }
    : { x: s.x, y: s.y + s.size * 0.38 + 1, w: s.labelW, h: CHIP_LABEL_H, rank: 1 };
}

function layoutSceneLabels(scene: Scene, dt: number, b: Bounds): void {
  let visible = 0;
  for (const l of scene.leaders.values()) {
    if (l.alpha > 0.05) visible++;
    for (const f of l.followers.values()) if (f.alpha > 0.05) visible++;
  }
  const crowded = visible > FOLLOWER_CHIP_LIMIT;
  const items: Swimmer[] = [];
  const boxes: LabelBox[] = [];
  for (const l of scene.leaders.values()) {
    if (l.label && l.alpha > 0.02) {
      items.push(l);
      boxes.push(labelBox(l, "leader", scene.measure));
    } else l.labelAlpha = 0;
    const chips = !crowded || scene.focus === l.user.user_id;
    for (const f of l.followers.values()) {
      if (chips && f.label && f.alpha > 0.02) {
        items.push(f);
        boxes.push(labelBox(f, "chip", scene.measure));
      } else {
        f.labelAlpha = easeToward(f.labelAlpha, 0, dt, 0.12);
        if (f.labelAlpha < 0.02) f.labelPlaced = false;
      }
    }
  }
  const spots = layoutLabels(boxes, b.width, b.height);
  items.forEach((s, i) => {
    const { x, y } = spots[i];
    const jump = Math.abs(y - s.labelY) > 80 || Math.abs(x - s.labelX) > 80;
    s.labelX = !s.labelPlaced || jump ? x : easeToward(s.labelX, x, dt, 0.06);
    s.labelY = !s.labelPlaced || jump ? y : easeToward(s.labelY, y, dt, 0.08);
    s.labelPlaced = true;
    s.labelAlpha = easeToward(s.labelAlpha, 1, dt, 0.12);
  });
}

/** The signed-in person's creature, if it is in the tank. */
export function selfLeader(scene: Scene): Leader | null {
  for (const l of scene.leaders.values()) if (l.user.is_self && !l.leaving) return l;
  return null;
}

/**
 * Sends the person's creature toward (x, y), clamped into the swim band.
 * Returns the clamped goal, or null when they have no creature in the tank.
 */
export function steerSelfTo(scene: Scene, x: number, y: number, b: Bounds): Goal | null {
  const l = selfLeader(scene);
  if (!l) return null;
  const [x0, x1] = xRange(b, l.size);
  const [y0, y1] = yRange(b, l.size);
  l.goal = { x: clamp(x, x0, x1), y: clamp(y, y0, y1), ttl: GOAL_TIMEOUT };
  return l.goal;
}

/**
 * After the tank is shaken: every creature takes a new random heading and
 * speed, followers scatter, and a burst of bubbles rises from the seabed.
 */
export function shakeScene(scene: Scene, b: Bounds, { reducedMotion = false }: StepOptions = {}): void {
  const { rng } = scene;
  for (const l of scene.leaders.values()) {
    if (l.leaving) continue;
    const heading = rng() * Math.PI * 2;
    l.goal = null;
    l.heading = heading;
    l.turnRate = (rng() - 0.5) * 1.6;
    l.speedFactor = SHAKE_SPEED_MIN + rng() * (SHAKE_SPEED_MAX - SHAKE_SPEED_MIN);
    const kick = l.speed * l.speedFactor * 1.5;
    l.vx = Math.cos(heading) * kick;
    l.vy = Math.sin(heading) * kick * 0.45;
    for (const f of l.followers.values()) {
      f.vx += (rng() - 0.5) * 160;
      f.vy += (rng() - 0.5) * 120;
    }
  }
  if (reducedMotion) return;
  const count = Math.round(clamp(b.width / 30, 12, 48));
  for (let i = 0; i < count; i++) addBubble(scene, rng() * b.width, b.bottom - rng() * 40, 2 + rng() * 4);
}

export function stepScene(scene: Scene, dt: number, bounds: Bounds, { reducedMotion = false }: StepOptions = {}): void {
  const step = clamp(dt, 0, MAX_DT);
  if (step === 0) return;
  separate(scene, step);
  for (const [id, l] of scene.leaders) {
    stepLeader(scene, l, step, bounds, reducedMotion);
    stepFollowers(l, step, bounds, reducedMotion);
    if (l.leaving && l.alpha <= 0) scene.leaders.delete(id);
  }
  stepBubbles(scene, step, bounds, reducedMotion);
  layoutSceneLabels(scene, step, bounds);
}

/** Back-to-front draw order: big creatures behind small ones. */
export function drawOrder(scene: Scene): Leader[] {
  return [...scene.leaders.values()].sort((a, b) => b.size - a.size);
}

export interface HitTarget {
  userId: string;
  /** Set when the pointer is on one of the person's profile followers. */
  profile?: string;
}

export function sameTarget(a: HitTarget | null, b: HitTarget | null): boolean {
  return a?.userId === b?.userId && a?.profile === b?.profile;
}

function hits(s: Swimmer, x: number, y: number, slack: number): boolean {
  return s.alpha > 0.2 && Math.hypot(s.x - x, s.y - y) <= s.size * 0.5 + slack;
}

/** The front-most creature under (x, y), if any. */
export function hitTest(scene: Scene, x: number, y: number, slack = 4): HitTarget | null {
  const order = drawOrder(scene);
  for (let i = order.length - 1; i >= 0; i--) {
    const l = order[i];
    if (l.leaving) continue;
    if (hits(l, x, y, slack)) return { userId: l.user.user_id };
    for (const f of l.followers.values()) {
      if (!f.leaving && hits(f, x, y, slack)) return { userId: l.user.user_id, profile: f.profile.name };
    }
  }
  return null;
}

/** Where a hit target currently is, for anchoring its card. */
export function locate(scene: Scene, target: HitTarget): Swimmer | null {
  const l = scene.leaders.get(target.userId);
  if (!l || l.leaving) return null;
  if (!target.profile) return l;
  const f = l.followers.get(target.profile);
  return f && !f.leaving ? f : null;
}
