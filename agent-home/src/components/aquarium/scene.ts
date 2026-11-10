/**
 * The aquarium's simulation: plain mutable objects stepped by `stepScene` once
 * per animation frame (dt in seconds). React never sees these — a snapshot
 * only retargets size/speed and adds or retires creatures, which fade.
 */
import type { AquariumProfile, AquariumSnapshot, AquariumUser, CreatureId } from "@/lib/aquarium/creatures";

import { creatureSize, creatureSpeed, followerSize, profileCreature } from "./mapping";

/** Time constant of size/speed easing; ~95 % settled after 3τ ≈ 1 s. */
export const EASE_TAU = 0.33;
export const FADE_SECONDS = 0.8;
/** Longest step simulated in one frame, so a stalled tab never teleports. */
export const MAX_DT = 0.1;
export const REDUCED_MOTION_SPEED = 0.3;
export const MAX_BUBBLES = 320;

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

export interface Swimmer {
  creature: CreatureId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  targetSize: number;
  alpha: number;
  leaving: boolean;
  /** -1 facing left … 1 facing right; eased so turns flip smoothly. */
  face: number;
  phase: number;
}

export interface Follower extends Swimmer {
  profile: AquariumProfile;
}

export interface Leader extends Swimmer {
  user: AquariumUser;
  speed: number;
  targetSpeed: number;
  heading: number;
  turnRate: number;
  bubbleClock: number;
  followers: Map<string, Follower>;
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
}

export interface StepOptions {
  reducedMotion?: boolean;
}

export function createScene(rng: () => number = Math.random): Scene {
  return { leaders: new Map(), bubbles: [], ambientClock: 0, rng };
}

/** Frame-rate independent exponential approach of `target`. */
export function easeToward(current: number, target: number, dt: number, tau = EASE_TAU): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function xRange(b: Bounds, size: number): [number, number] {
  const m = Math.min(size / 2 + 8, b.width / 2);
  return [m, Math.max(m, b.width - m)];
}

function yRange(b: Bounds, size: number): [number, number] {
  const lo = b.top + size / 2;
  return [lo, Math.max(lo, b.bottom - size * 0.3)];
}

function spawnFollower(profile: AquariumProfile, leader: Leader, rng: () => number): Follower {
  return {
    creature: profileCreature(profile.name),
    profile,
    x: leader.x - (rng() - 0.5) * leader.size,
    y: leader.y + (rng() - 0.5) * leader.size,
    vx: leader.vx,
    vy: leader.vy,
    size: followerSize(leader.targetSize),
    targetSize: followerSize(leader.targetSize),
    alpha: 0,
    leaving: false,
    face: leader.face,
    phase: rng() * Math.PI * 2,
  };
}

/** Diffs a snapshot into the scene: new people fade in, missing ones fade out. */
export function applySnapshot(scene: Scene, snapshot: AquariumSnapshot, bounds: Bounds): void {
  const { rng } = scene;
  const seen = new Set<string>();
  for (const user of snapshot.users) {
    seen.add(user.user_id);
    const size = creatureSize(user.metrics);
    const speed = creatureSpeed(user.metrics);
    let leader = scene.leaders.get(user.user_id);
    if (!leader) {
      const [x0, x1] = xRange(bounds, size);
      const [y0, y1] = yRange(bounds, size);
      const heading = (rng() - 0.5) * 0.8 + (rng() < 0.5 ? 0 : Math.PI);
      leader = {
        creature: user.creature,
        user,
        x: x0 + rng() * (x1 - x0),
        y: y0 + rng() * (y1 - y0),
        vx: Math.cos(heading) * speed,
        vy: Math.sin(heading) * speed * 0.4,
        size,
        targetSize: size,
        speed,
        targetSpeed: speed,
        heading,
        turnRate: 0,
        alpha: 0,
        leaving: false,
        face: Math.cos(heading) >= 0 ? 1 : -1,
        phase: rng() * Math.PI * 2,
        bubbleClock: rng(),
        followers: new Map(),
      };
      scene.leaders.set(user.user_id, leader);
    }
    leader.user = user;
    leader.creature = user.creature;
    leader.leaving = false;
    leader.targetSize = size;
    leader.targetSpeed = speed;

    const fSize = followerSize(size);
    const names = new Set<string>();
    for (const profile of user.profiles) {
      names.add(profile.name);
      let f = leader.followers.get(profile.name);
      if (!f) {
        f = spawnFollower(profile, leader, rng);
        leader.followers.set(profile.name, f);
      }
      f.profile = profile;
      f.leaving = false;
      f.targetSize = fSize;
    }
    for (const [name, f] of leader.followers) if (!names.has(name)) f.leaving = true;
  }
  for (const [id, leader] of scene.leaders) if (!seen.has(id)) leader.leaving = true;
}

function fade(s: Swimmer, dt: number): void {
  s.alpha = clamp(s.alpha + ((s.leaving ? -1 : 1) * dt) / FADE_SECONDS, 0, 1);
}

function turnFace(s: Swimmer, dt: number): void {
  if (Math.abs(s.vx) > 3) s.face = easeToward(s.face, s.vx > 0 ? 1 : -1, dt, 0.12);
}

function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function stepLeader(scene: Scene, l: Leader, dt: number, b: Bounds, reduced: boolean): void {
  const { rng } = scene;
  l.size = easeToward(l.size, l.targetSize, dt);
  l.speed = easeToward(l.speed, l.targetSpeed, dt);
  const cruise = l.speed * (reduced ? REDUCED_MOTION_SPEED : 1);

  // Smooth wander: the turn rate is a damped random walk, the heading integrates it.
  l.turnRate += (rng() - 0.5) * 3.2 * dt;
  l.turnRate *= Math.exp(-dt * 1.2);
  l.turnRate = clamp(l.turnRate, -0.9, 0.9);
  l.heading += l.turnRate * dt;

  // Soft walls: inside the margin the heading bends toward the open water.
  const [x0, x1] = xRange(b, l.size);
  const [y0, y1] = yRange(b, l.size);
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

  const wantX = Math.cos(l.heading) * cruise;
  const wantY = Math.sin(l.heading) * cruise * 0.45;
  const steer = 1 - Math.exp(-dt * 1.8);
  l.vx += (wantX - l.vx) * steer + px * cruise * 1.5 * dt;
  l.vy += (wantY - l.vy) * steer + py * cruise * 1.5 * dt;
  l.x = clamp(l.x + l.vx * dt, x0, x1);
  l.y = clamp(l.y + l.vy * dt, y0, y1);
  turnFace(l, dt);
  l.phase += dt * (1.6 + cruise / 25);
  fade(l, dt);

  if (!reduced && l.user.metrics.active_now && !l.leaving) {
    l.bubbleClock -= dt;
    if (l.bubbleClock <= 0) {
      l.bubbleClock = 0.25 + rng() * 0.35;
      addBubble(scene, l.x + l.face * l.size * 0.42, l.y - l.size * 0.12, 1.5 + rng() * 2.5);
    }
  }
}

function stepFollowers(l: Leader, dt: number, reduced: boolean): void {
  const speed = Math.hypot(l.vx, l.vy);
  const hx = speed > 1 ? l.vx / speed : l.face >= 0 ? 1 : -1;
  const hy = speed > 1 ? l.vy / speed : 0;
  const k = reduced ? 3 : 5;
  const c = 2 * Math.sqrt(k) * 0.75;
  const list = [...l.followers.values()];
  list.forEach((f, i) => {
    f.size = easeToward(f.size, f.targetSize, dt);
    const back = l.size * 0.5 + f.size * (0.9 + 1.05 * i);
    const sway = Math.sin(l.phase * 0.7 + i * 1.9) * f.size * 0.7 * (i % 2 === 0 ? 1 : -1);
    const tx = l.x - hx * back - hy * sway;
    const ty = l.y - hy * back + hx * sway;
    let ax = k * (tx - f.x) - c * f.vx;
    let ay = k * (ty - f.y) - c * f.vy;
    for (let j = 0; j < list.length; j++) {
      if (j === i) continue;
      const o = list[j];
      const dx = f.x - o.x;
      const dy = f.y - o.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const min = (f.size + o.size) * 0.55;
      if (d < min) {
        ax += (dx / d) * (min - d) * 6;
        ay += (dy / d) * (min - d) * 6;
      }
    }
    f.vx += ax * dt;
    f.vy += ay * dt;
    f.x += f.vx * dt;
    f.y += f.vy * dt;
    if (Math.abs(f.vx) > 3) turnFace(f, dt);
    else f.face = easeToward(f.face, l.face, dt, 0.2);
    f.phase += dt * 2.6;
    fade(f, dt);
  });
  for (const [name, f] of l.followers) if (f.leaving && f.alpha <= 0) l.followers.delete(name);
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

export function stepScene(scene: Scene, dt: number, bounds: Bounds, { reducedMotion = false }: StepOptions = {}): void {
  const step = clamp(dt, 0, MAX_DT);
  if (step === 0) return;
  for (const [id, l] of scene.leaders) {
    stepLeader(scene, l, step, bounds, reducedMotion);
    stepFollowers(l, step, reducedMotion);
    if (l.leaving && l.alpha <= 0) scene.leaders.delete(id);
  }
  stepBubbles(scene, step, bounds, reducedMotion);
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
