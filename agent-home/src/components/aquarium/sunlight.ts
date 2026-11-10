/**
 * Sunlight from the surface: a shimmering band and twinkling glints at the
 * top of the tank, and moving light ripples painted over the creatures
 * (only where a creature is drawn, via `source-atop`).
 */
import { BACKDROP_HORIZON, BACKDROP_PX } from "./scenery";

const GOLDEN = 0.618033988749895;
export const GLINTS_PER_PX = 1 / 45;
export const RIPPLE_ALPHA = 0.4;

/** How bright a light beam is for a slow pulse and a fast flicker, both in [0, 1]. */
export function rayAlpha(pulse: number, flicker: number): number {
  return 0.09 + 0.17 * pulse + 0.05 * flicker;
}

/** y where the shimmering surface band ends: the top ~16% of the backdrop, at least 48 px. */
export function surfaceDepth(width: number, height: number): number {
  const s = Math.max(width / BACKDROP_PX.width, height / BACKDROP_PX.height);
  const top = (height - BACKDROP_PX.height * s) / 2;
  const surface = top + BACKDROP_PX.height * s * (BACKDROP_HORIZON * 0.22);
  return Math.max(48, Math.min(height * 0.3, surface));
}

export interface Glint {
  x: number;
  y: number;
  r: number;
  rate: number;
  phase: number;
}

/** Deterministic sparkle spots spread evenly across the surface band. */
export function surfaceGlints(width: number, depth: number): Glint[] {
  const n = Math.max(8, Math.min(60, Math.round(width * GLINTS_PER_PX)));
  const out: Glint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i * GOLDEN) % 1;
    const b = (i * 0.7548776662466927) % 1;
    out.push({ x: a * width, y: depth * (0.08 + 0.8 * b * b), r: 4 + 9 * (1 - b), rate: 0.9 + 2.2 * ((i * 0.381) % 1), phase: i * 2.399 });
  }
  return out;
}

/** 0 most of the time, a short bright flash about once per cycle. */
export function twinkle(t: number, g: Glint): number {
  return Math.max(0, Math.sin(t * g.rate + g.phase)) ** 10;
}

function movingPattern(pattern: CanvasPattern, x: number, y: number, sx: number, sy: number): boolean {
  if (typeof pattern.setTransform !== "function" || typeof DOMMatrix === "undefined") return false;
  pattern.setTransform(new DOMMatrix().translateSelf(x, y).scaleSelf(sx, sy));
  return true;
}

export interface SunlightOptions {
  width: number;
  height: number;
  dpr: number;
}

/** The surface band: two caustic layers squashed into a moving shimmer, plus glints. Expects `ctx` at dpr scale. */
export function drawSurface(
  ctx: CanvasRenderingContext2D,
  t: number,
  opts: SunlightOptions,
  caustic: CanvasImageSource | null,
  dot: CanvasImageSource | null,
  glints: readonly Glint[],
): void {
  const depth = surfaceDepth(opts.width, opts.height);
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  const pattern = caustic ? ctx.createPattern(caustic, "repeat") : null;
  if (pattern) {
    ctx.fillStyle = pattern;
    const passes = [
      { sx: 2.6, sy: 0.32, vx: 22, a: 0.3 },
      { sx: 3.4, sy: 0.42, vx: -15, a: 0.22 },
    ];
    const bands = 6;
    for (const p of passes) {
      movingPattern(pattern, t * p.vx, Math.sin(t * 0.7 + p.sx) * 6, p.sx, p.sy);
      const swell = 0.8 + 0.2 * Math.sin(t * 0.9 + p.sx * 2);
      for (let i = 0; i < bands; i++) {
        ctx.globalAlpha = p.a * swell * (1 - i / bands) ** 1.6;
        ctx.fillRect(0, (depth * i) / bands, opts.width, depth / bands + 0.5);
      }
    }
  }
  if (dot) {
    for (const g of glints) {
      const f = twinkle(t, g);
      if (f < 0.02) continue;
      ctx.globalAlpha = 0.85 * f;
      const s = g.r * (1.2 + f);
      ctx.drawImage(dot, g.x - s, g.y - s / 2, s * 2, s);
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

/**
 * Light ripples over everything already on `ctx` (the creatures): brightest
 * near the surface, fading with depth. Call after the creatures, before labels.
 */
export function drawCreatureRipples(
  ctx: CanvasRenderingContext2D,
  t: number,
  opts: SunlightOptions,
  caustic: CanvasImageSource | null,
): void {
  if (!caustic) return;
  const pattern = ctx.createPattern(caustic, "repeat");
  if (!pattern) return;
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = pattern;
  const passes = [
    { s: 0.9, vx: 14, vy: 9, a: RIPPLE_ALPHA },
    { s: 1.3, vx: -10, vy: 6, a: RIPPLE_ALPHA * 0.7 },
  ];
  const bands = 6;
  for (const p of passes) {
    movingPattern(pattern, t * p.vx, t * p.vy, p.s, p.s);
    for (let i = 0; i < bands; i++) {
      ctx.globalAlpha = p.a * (1 - (0.75 * i) / bands);
      ctx.fillRect(0, (opts.height * i) / bands, opts.width, opts.height / bands + 0.5);
    }
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}
