/**
 * The aquarium's scenery model (FG-35 v2): seeded seabed layout, seaweed
 * sway with current gusts and creature pushes, plankton and vent bubbles.
 * Plain mutable objects stepped once per frame (dt in seconds); drawing
 * lives in `sceneryDraw.ts`.
 */

export const STRAND_PERIOD = [3, 9] as const;
export const FLUTTER_PERIOD = [0.9, 2.2] as const;
export const GUST_INTERVAL = [20, 40] as const;
export const FIRST_GUST = [6, 14] as const;
export const GUST_DURATION = [7, 11] as const;
export const MAX_DT = 0.1;
export const MAX_VENT_BUBBLES = 180;

/** Size of `decorSprite("backdrop")` and where its sand horizon sits (fraction of its height). */
export const BACKDROP_PX = { width: 1680, height: 944 } as const;
export const BACKDROP_HORIZON = 0.72;

export type StrandKind = "kelp" | "seagrass";
export type PropKind = "coral-branch" | "coral-brain" | "anemone" | "rocks";

/** Pixel size of the transparent decor sprites, for aspect ratios. */
export const DECOR_PX: Record<StrandKind | PropKind, { width: number; height: number }> = {
  kelp: { width: 109, height: 512 },
  seagrass: { width: 486, height: 512 },
  "coral-branch": { width: 483, height: 512 },
  "coral-brain": { width: 512, height: 435 },
  anemone: { width: 505, height: 512 },
  rocks: { width: 512, height: 210 },
};

/** Depth layers, back to front: smaller, slower, bluer and softer further away. */
export const LAYERS = [
  { scale: 0.5, sway: 0.6, tint: 0.5, blur: 1.6, alpha: 0.85 },
  { scale: 0.75, sway: 0.8, tint: 0.22, blur: 0.6, alpha: 0.95 },
  { scale: 1, sway: 1, tint: 0, blur: 0, alpha: 1 },
] as const;
export type LayerIndex = 0 | 1 | 2;

export interface Strand {
  kind: StrandKind;
  layer: LayerIndex;
  x: number;
  baseY: number;
  width: number;
  height: number;
  flip: boolean;
  /** Main sway: seconds per cycle (3–9 s), own phase, tip amplitude as a fraction of height. */
  period: number;
  phase: number;
  amplitude: number;
  /** Secondary flutter near the tip. */
  flutterPeriod: number;
  flutterPhase: number;
  /** Spring-damped lean (fraction of height) driven by gusts and passing creatures. */
  lean: number;
  leanV: number;
}

export interface Prop {
  kind: PropKind;
  layer: LayerIndex;
  x: number;
  baseY: number;
  width: number;
  height: number;
  flip: boolean;
  period: number;
  phase: number;
}

export interface Vent {
  x: number;
  y: number;
  layer: LayerIndex;
  clock: number;
  burstClock: number;
  burstLeft: number;
}

/** A shaft of light from the surface: x as a fraction of width, own pulse and drift. */
export interface Ray {
  u: number;
  width: number;
  skew: number;
  period: number;
  phase: number;
  driftPeriod: number;
}

export interface Layout {
  width: number;
  height: number;
  horizon: number;
  strands: Strand[];
  props: Prop[];
  vents: Vent[];
  rays: Ray[];
}

export interface Plankton {
  x: number;
  y: number;
  depth: number;
  r: number;
  phase: number;
  twinkle: number;
  drift: number;
}

export interface VentBubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  wobble: number;
  age: number;
}

export interface Gusts {
  clock: number;
  /** Seconds since the start of the scenery when the next gust begins. */
  next: number;
  start: number;
  duration: number;
  strength: number;
  /** True while a gust is sweeping through. */
  active: boolean;
}

/** Anything swimming that pushes seaweed aside (the creature scene's leaders fit). */
export interface Pusher {
  x: number;
  y: number;
  size: number;
  alpha?: number;
}

export interface Scenery {
  layout: Layout;
  plankton: Plankton[];
  bubbles: VentBubble[];
  gusts: Gusts;
  time: number;
  rng: () => number;
}

/** Small deterministic PRNG (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function hashSeed(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) h = Math.imul(h ^ (p >>> 0), 16777619) ^ (h >>> 13);
  return h >>> 0;
}

function between(rng: () => number, [lo, hi]: readonly [number, number]): number {
  return lo + rng() * (hi - lo);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

const GOLDEN = 0.6180339887;

/** y of the backdrop's sand horizon under `background-size: cover; background-position: center`. */
export function horizonY(width: number, height: number): number {
  const s = Math.max(width / BACKDROP_PX.width, height / BACKDROP_PX.height);
  return (height - BACKDROP_PX.height * s) / 2 + BACKDROP_PX.height * s * BACKDROP_HORIZON;
}

/** Item `i` of a kind: a low-discrepancy x (any prefix spreads evenly) and its own seeded rng. */
function slot(seed: number, kind: number, layer: number, i: number): [number, () => number] {
  const rng = seededRng(hashSeed(seed, kind, layer, i));
  const u = (((kind * 0.137 + layer * 0.291 + i * GOLDEN) % 1) + (rng() - 0.5) * 0.08 + 1) % 1;
  return [u, rng];
}

function layerBase(layer: LayerIndex, height: number, horizon: number, rng: () => number): number {
  const sand = Math.max(24, height - horizon);
  const band = [
    [0.04, 0.16],
    [0.3, 0.5],
    [0.82, 1.04],
  ][layer] as [number, number];
  return horizon + sand * between(rng, band);
}

/** How many items of a kind sit in a layer at this width: one per `spacing` px, at least `min`. */
function count(width: number, spacing: number, min: number, max: number): number {
  return clamp(Math.round(width / spacing), min, max);
}

const STRAND_SPEC: Record<StrandKind, { spacing: [number, number, number]; height: [number, number] }> = {
  kelp: { spacing: [150, 210, 300], height: [0.34, 0.6] },
  seagrass: { spacing: [190, 230, 280], height: [0.13, 0.22] },
};

const PROP_SPEC: Record<PropKind, { spacing: [number, number, number]; height: [number, number] }> = {
  "coral-branch": { spacing: [700, 900, 1300], height: [0.17, 0.27] },
  "coral-brain": { spacing: [800, 1000, 1500], height: [0.09, 0.14] },
  anemone: { spacing: [900, 800, 1200], height: [0.12, 0.18] },
  rocks: { spacing: [650, 750, 900], height: [0.07, 0.12] },
};

/**
 * Seeded seabed layout. The same seed and size always give the same layout,
 * and resizing keeps every item at the same relative x (wider screens only
 * add items), so a resize never reshuffles the tank.
 */
export function layoutScenery(width: number, height: number, seed = 35): Layout {
  const horizon = horizonY(width, height);
  const unit = Math.min(height, width * 0.9);
  const strands: Strand[] = [];
  const props: Prop[] = [];

  (["kelp", "seagrass"] as const).forEach((kind, k) => {
    const spec = STRAND_SPEC[kind];
    for (const layer of [0, 1, 2] as const) {
      const n = count(width, spec.spacing[layer], 2, 40);
      for (let i = 0; i < n; i++) {
        const [u, rng] = slot(seed, k, layer, i);
        const h = unit * between(rng, spec.height) * LAYERS[layer].scale;
        const px = DECOR_PX[kind];
        strands.push({
          kind,
          layer,
          x: u * width,
          baseY: layerBase(layer, height, horizon, rng),
          height: h,
          width: (h * px.width) / px.height,
          flip: rng() < 0.5,
          period: between(rng, STRAND_PERIOD),
          phase: rng() * Math.PI * 2,
          amplitude: (kind === "kelp" ? 0.07 : 0.1) * (0.7 + rng() * 0.6),
          flutterPeriod: between(rng, FLUTTER_PERIOD),
          flutterPhase: rng() * Math.PI * 2,
          lean: 0,
          leanV: 0,
        });
      }
    }
  });

  (["coral-branch", "coral-brain", "anemone", "rocks"] as const).forEach((kind, k) => {
    const spec = PROP_SPEC[kind];
    for (const layer of [0, 1, 2] as const) {
      const n = count(width, spec.spacing[layer], layer === 0 ? 1 : 0, 12);
      for (let i = 0; i < n; i++) {
        const [u, rng] = slot(seed, 10 + k, layer, i);
        const h = unit * between(rng, spec.height) * LAYERS[layer].scale;
        const px = DECOR_PX[kind];
        props.push({
          kind,
          layer,
          x: u * width,
          baseY: layerBase(layer, height, horizon, rng) + (kind === "rocks" || kind === "coral-brain" ? h * 0.12 : 0),
          height: h,
          width: (h * px.width) / px.height,
          flip: rng() < 0.5,
          period: between(rng, [3.5, 6]),
          phase: rng() * Math.PI * 2,
        });
      }
    }
  });

  const ventRng = seededRng(hashSeed(seed, 99));
  const vents: Vent[] = [];
  const nVents = count(width, 520, 2, 4);
  for (let i = 0; i < nVents; i++) {
    const layer = (i % 2) as LayerIndex;
    const u = (i + 0.3 + ventRng() * 0.4) / nVents;
    vents.push({
      x: u * width,
      y: layerBase(layer, height, horizon, ventRng),
      layer,
      clock: ventRng(),
      burstClock: between(ventRng, [3, 12]),
      burstLeft: 0,
    });
  }

  const rayRng = seededRng(hashSeed(seed, 77));
  const rays: Ray[] = [];
  const nRays = count(width, 300, 4, 7);
  for (let i = 0; i < nRays; i++) {
    const u = 0.08 + ((i + 0.5 + (rayRng() - 0.5) * 0.6) / nRays) * 0.84;
    rays.push({
      u,
      width: width * (0.04 + rayRng() * 0.07),
      skew: (u - 0.5) * 0.55,
      period: 9 + rayRng() * 9,
      phase: rayRng() * Math.PI * 2,
      driftPeriod: 25 + rayRng() * 20,
    });
  }

  // Back to front, so drawing in array order layers correctly.
  strands.sort((a, b) => a.layer - b.layer || a.baseY - b.baseY);
  props.sort((a, b) => a.layer - b.layer || a.baseY - b.baseY);
  return { width, height, horizon, strands, props, vents, rays };
}

export function createGusts(rng: () => number): Gusts {
  return { clock: 0, next: between(rng, FIRST_GUST), start: 0, duration: 0, strength: 0, active: false };
}

/** Advances the gust clock; a gust lasts `GUST_DURATION` and the next one starts 20–40 s after the last began. */
export function stepGusts(g: Gusts, dt: number, rng: () => number): void {
  g.clock += dt;
  if (g.active && g.clock >= g.start + g.duration) g.active = false;
  if (!g.active && g.clock >= g.next) {
    g.active = true;
    g.start = g.next;
    g.duration = between(rng, GUST_DURATION);
    g.strength = 0.65 + rng() * 0.35;
    g.next = g.start + between(rng, GUST_INTERVAL);
  }
}

/** Gust strength felt at `u` (0 = left edge … 1 = right edge): a front sweeping left→right with a soft tail. */
export function gustAt(g: Gusts, u: number): number {
  if (!g.active) return 0;
  const p = (g.clock - g.start) / g.duration;
  const front = -0.25 + p * 1.6;
  const d = front - u;
  const shape = d < 0 ? Math.exp(-((d / 0.1) ** 2)) : Math.exp(-d / 0.3);
  const envelope = Math.sin(Math.PI * clamp(p, 0, 1)) ** 0.5;
  return g.strength * shape * envelope;
}

/**
 * Horizontal offset (px) of a strand at fraction `s` of its height (0 = root, 1 = tip).
 * A travelling sine whose amplitude grows towards the tip, a faster flutter near the
 * tip, and the spring-damped lean from gusts and pushes.
 */
export function strandOffset(st: Strand, s: number, t: number, sway = 1): number {
  const w = (2 * Math.PI) / st.period;
  const main = st.amplitude * s ** 1.6 * Math.sin(w * t + st.phase - s * 1.4);
  const flutter = st.amplitude * 0.22 * s ** 2.6 * Math.sin(((2 * Math.PI) / st.flutterPeriod) * t + st.flutterPhase - s * 3.1);
  const lean = st.lean * s ** 1.5;
  return st.height * ((main + flutter) * sway + lean);
}

/** How hard nearby swimmers push a strand sideways (signed, roughly −1…1). */
export function pushOn(st: Strand, pushers: Iterable<Pusher> | null | undefined): number {
  if (!pushers) return 0;
  const top = st.baseY - st.height;
  let push = 0;
  for (const p of pushers) {
    const r = p.size * 0.55 + st.width * 0.35;
    if (p.y < top - r || p.y > st.baseY + r * 0.3) continue;
    const s = clamp((st.baseY - p.y) / st.height, 0, 1);
    const dx = st.x + st.lean * st.height * s ** 1.5 - p.x;
    if (Math.abs(dx) >= r) continue;
    const reach = (1 - Math.abs(dx) / r) * Math.min(1, p.size / 70) * (p.alpha ?? 1) * (0.4 + 0.6 * s);
    push += (dx >= 0 ? 1 : -1) * reach;
  }
  return clamp(push, -1, 1);
}

const LEAN_K = 7;
const LEAN_DAMP = 2 * Math.sqrt(LEAN_K) * 0.45;
const GUST_LEAN = 0.24;
const PUSH_LEAN = 0.18;

function stepStrands(sc: Scenery, dt: number, pushers: Iterable<Pusher> | null | undefined): void {
  const pool = pushers ? [...pushers] : null;
  for (const st of sc.layout.strands) {
    const depth = LAYERS[st.layer].sway;
    const target = (gustAt(sc.gusts, st.x / sc.layout.width) * GUST_LEAN + pushOn(st, pool) * PUSH_LEAN) * depth;
    st.leanV += (LEAN_K * (target - st.lean) - LEAN_DAMP * st.leanV) * dt;
    st.lean += st.leanV * dt;
  }
}

function plankton(rng: () => number, w: number, h: number): Plankton {
  const depth = rng();
  return {
    x: rng() * w,
    y: rng() * h,
    depth,
    r: 0.6 + depth * 1.6 + rng() * 0.6,
    phase: rng() * Math.PI * 2,
    twinkle: 1.5 + rng() * 3,
    drift: 4 + rng() * 8,
  };
}

export function planktonCount(width: number, height: number): number {
  return clamp(Math.round((width * height) / 16000), 30, 140);
}

export function createScenery(width: number, height: number, seed = 35, rng: () => number = seededRng(seed + 1)): Scenery {
  const layout = layoutScenery(width, height, seed);
  const sc: Scenery = { layout, plankton: [], bubbles: [], gusts: createGusts(rng), time: 0, rng };
  for (let i = planktonCount(width, height); i > 0; i--) sc.plankton.push(plankton(rng, width, height));
  return sc;
}

/** Re-lays the seabed for a new size, keeping the clock, gusts and particles. */
export function resizeScenery(sc: Scenery, width: number, height: number, seed = 35): void {
  if (sc.layout.width === width && sc.layout.height === height) return;
  const sx = width / (sc.layout.width || width);
  const sy = height / (sc.layout.height || height);
  sc.layout = layoutScenery(width, height, seed);
  for (const p of sc.plankton) {
    p.x *= sx;
    p.y *= sy;
  }
  const want = planktonCount(width, height);
  while (sc.plankton.length > want) sc.plankton.pop();
  while (sc.plankton.length < want) sc.plankton.push(plankton(sc.rng, width, height));
  sc.bubbles.length = 0;
}

function emit(sc: Scenery, v: Vent, big: boolean): void {
  if (sc.bubbles.length >= MAX_VENT_BUBBLES) return;
  const scale = LAYERS[v.layer].scale;
  const r = (big ? 2.2 + sc.rng() * 3.2 : 1 + sc.rng() * 2.2) * (0.6 + scale * 0.6);
  sc.bubbles.push({
    x: v.x + (sc.rng() - 0.5) * 6,
    y: v.y,
    r,
    vy: -(30 + r * 10 + sc.rng() * 14) * (0.7 + scale * 0.3),
    wobble: sc.rng() * Math.PI * 2,
    age: 0,
  });
}

function stepVents(sc: Scenery, dt: number): void {
  for (const v of sc.layout.vents) {
    v.clock -= dt;
    while (v.clock <= 0) {
      v.clock += 0.18 + sc.rng() * 0.5;
      emit(sc, v, false);
    }
    v.burstClock -= dt;
    if (v.burstClock <= 0) {
      v.burstClock = 6 + sc.rng() * 10;
      v.burstLeft = 8 + Math.floor(sc.rng() * 8);
    }
    if (v.burstLeft > 0 && sc.rng() < dt * 22) {
      v.burstLeft--;
      emit(sc, v, true);
    }
  }
  const current = gustAt(sc.gusts, 0.5) * 18;
  let keep = 0;
  for (const b of sc.bubbles) {
    b.age += dt;
    b.y += b.vy * dt;
    b.wobble += dt * (2 + b.r * 0.2);
    b.x += (Math.sin(b.wobble) * Math.min(14, 4 + b.age * 6) + current) * dt;
    b.r *= 1 + dt * 0.04;
    if (b.y + b.r > 0) sc.bubbles[keep++] = b;
  }
  sc.bubbles.length = keep;
}

function stepPlankton(sc: Scenery, dt: number): void {
  const { width: w, height: h } = sc.layout;
  const current = gustAt(sc.gusts, 0.5) * 22;
  for (const p of sc.plankton) {
    p.phase += dt * (0.3 + p.depth * 0.4);
    p.x += (Math.cos(p.phase) * p.drift * 0.6 + 2 + current * (0.4 + p.depth)) * dt;
    p.y += (Math.sin(p.phase * 1.3) * p.drift * 0.5 - 1.2) * dt;
    if (p.x > w + 4) p.x -= w + 8;
    else if (p.x < -4) p.x += w + 8;
    if (p.y < -4) p.y += h + 8;
    else if (p.y > h + 4) p.y -= h + 8;
  }
}

export interface ScenerySteps {
  reducedMotion?: boolean;
  pushers?: Iterable<Pusher> | null;
}

/** One frame. Reduced motion keeps the strands still and has no gusts, plankton motion or bubbles. */
export function stepScenery(sc: Scenery, dt: number, { reducedMotion = false, pushers }: ScenerySteps = {}): void {
  const step = clamp(dt, 0, MAX_DT);
  if (reducedMotion) {
    sc.bubbles.length = 0;
    for (const st of sc.layout.strands) st.lean = st.leanV = 0;
    return;
  }
  if (step === 0) return;
  sc.time += step;
  stepGusts(sc.gusts, step, sc.rng);
  stepStrands(sc, step, pushers);
  stepVents(sc, step);
  stepPlankton(sc, step);
}
