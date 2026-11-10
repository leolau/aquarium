/**
 * Canvas drawing for the scenery (`scenery.ts`). Decor sprites are decoded
 * once and pre-tinted/blurred per depth layer; seaweed is drawn as stacked
 * horizontal strips, each skewed so neighbouring strips meet, which bends
 * the sprite smoothly along `strandOffset`.
 */
import { decorSprite } from "@/lib/aquarium/creatures";

import {
  LAYERS,
  gustAt,
  strandOffset,
  type LayerIndex,
  type Prop,
  type PropKind,
  type Scenery,
  type Strand,
  type StrandKind,
} from "./scenery";

type Kind = StrandKind | PropKind;
const KINDS: readonly Kind[] = ["kelp", "seagrass", "coral-branch", "coral-brain", "anemone", "rocks"];
const LAYER_RES = [0.5, 0.75, 1] as const;
const STRIPS: Partial<Record<Kind, number>> = { kelp: 18, seagrass: 12, anemone: 10 };
const WATER = "12, 84, 140";

type Tex = HTMLCanvasElement;
const images = new Map<Kind, CanvasImageSource>();
const textures = new Map<string, Tex>();
let pending: Promise<boolean> | null = null;
let shared: { caustic: Tex | null; ray: Tex | null; dot: Tex | null; bubble: Tex | null; shadow: Tex | null } | null = null;

function makeCanvas(w: number, h: number): [Tex, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  return ctx ? [canvas, ctx] : null;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => (img.decode ? img.decode().catch(() => undefined) : Promise.resolve()).then(() => resolve(img));
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * The branch-coral sprite carries leftover water and fish from its source
 * render: drop bluish/white pixels and keep only the largest opaque island.
 */
function cleanCoral(img: HTMLImageElement): CanvasImageSource {
  const made = makeCanvas(img.naturalWidth, img.naturalHeight);
  if (!made) return img;
  const [canvas, ctx] = made;
  ctx.drawImage(img, 0, 0);
  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return img;
  }
  const { width: w, height: h } = canvas;
  const px = data.data;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 4];
    const g = px[i * 4 + 1];
    const b = px[i * 4 + 2];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const junk = (b > r + 8 && b > 100) || (mn > 150 && mx - mn < 50 && b >= r - 10);
    solid[i] = px[i * 4 + 3] > 40 && !junk ? 1 : 0;
  }
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (!solid[i] || label[i]) continue;
    next++;
    let size = 0;
    let top = 0;
    stack[top++] = i;
    label[i] = next;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= w * h || !solid[q] || label[q]) continue;
        label[q] = next;
        stack[top++] = q;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  for (let i = 0; i < w * h; i++) if (label[i] !== best) px[i * 4 + 3] = 0;
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Starts decoding the decor sprites once; resolves true when they are ready to draw. */
export function loadSceneryImages(): Promise<boolean> {
  if (pending) return pending;
  if (typeof Image === "undefined") return Promise.resolve(false);
  pending = Promise.all(
    KINDS.map(async (kind) => {
      const img = await loadImage(decorSprite(kind));
      if (img) images.set(kind, kind === "coral-branch" ? cleanCoral(img) : img);
    }),
  ).then(() => images.size > 0);
  return pending;
}

function sourceSize(src: CanvasImageSource): [number, number] {
  if (src instanceof HTMLImageElement) return [src.naturalWidth, src.naturalHeight];
  const s = src as { width: number; height: number };
  return [s.width, s.height];
}

/** A decor sprite tinted towards the water colour and softened for its depth layer. */
function texture(kind: Kind, layer: LayerIndex): Tex | null {
  const key = `${kind}:${layer}`;
  const hit = textures.get(key);
  if (hit) return hit;
  const src = images.get(kind);
  if (!src) return null;
  const [w, h] = sourceSize(src);
  const res = LAYER_RES[layer];
  const made = makeCanvas(w * res, h * res);
  if (!made) return null;
  const [canvas, ctx] = made;
  const { blur, tint } = LAYERS[layer];
  if (blur > 0 && "filter" in ctx) ctx.filter = `blur(${blur * res}px)`;
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  ctx.filter = "none";
  if (tint > 0) {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = `rgba(${WATER}, ${tint})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  textures.set(key, canvas);
  return canvas;
}

/** Tileable caustic network: bright Voronoi edges, built once. */
function causticTexture(): Tex | null {
  const N = 160;
  const made = makeCanvas(N, N);
  if (!made) return null;
  const [canvas, ctx] = made;
  const pts: [number, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 14; i++) pts.push([rnd() * N, rnd() * N]);
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      for (const [px, py] of pts) {
        let dx = Math.abs(x - px);
        let dy = Math.abs(y - py);
        dx = Math.min(dx, N - dx);
        dy = Math.min(dy, N - dy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) d2 = d;
      }
      const v = Math.max(0, 1 - (d2 - d1) / 7) ** 3;
      const i = (y * N + x) * 4;
      img.data[i] = 210;
      img.data[i + 1] = 255;
      img.data[i + 2] = 240;
      img.data[i + 3] = Math.round(v * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function rayTexture(): Tex | null {
  const made = makeCanvas(64, 256);
  if (!made) return null;
  const [canvas, ctx] = made;
  const across = ctx.createLinearGradient(0, 0, 64, 0);
  across.addColorStop(0, "rgba(255,255,255,0)");
  across.addColorStop(0.5, "rgba(220,250,255,1)");
  across.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, 64, 256);
  ctx.globalCompositeOperation = "destination-in";
  const down = ctx.createLinearGradient(0, 0, 0, 256);
  down.addColorStop(0, "rgba(0,0,0,1)");
  down.addColorStop(0.55, "rgba(0,0,0,0.45)");
  down.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = down;
  ctx.fillRect(0, 0, 64, 256);
  return canvas;
}

function radial(px: number, stops: [number, string][]): Tex | null {
  const made = makeCanvas(px, px);
  if (!made) return null;
  const [canvas, ctx] = made;
  const g = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  return canvas;
}

function bubbleTexture(): Tex | null {
  const made = makeCanvas(32, 32);
  if (!made) return null;
  const [canvas, ctx] = made;
  ctx.fillStyle = "rgba(200, 240, 255, 0.14)";
  ctx.strokeStyle = "rgba(235, 250, 255, 0.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.beginPath();
  ctx.arc(11, 10, 3.5, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

function sharedTextures() {
  return (shared ??= {
    caustic: causticTexture(),
    ray: rayTexture(),
    dot: radial(16, [
      [0, "rgba(230, 255, 250, 1)"],
      [0.4, "rgba(190, 240, 255, 0.5)"],
      [1, "rgba(190, 240, 255, 0)"],
    ]),
    bubble: bubbleTexture(),
    shadow: radial(64, [
      [0, "rgba(2, 20, 40, 0.55)"],
      [1, "rgba(2, 20, 40, 0)"],
    ]),
  });
}

export interface SceneryDrawOptions {
  width: number;
  height: number;
  dpr: number;
  reducedMotion: boolean;
}

/**
 * Draws `tex` standing on (x, baseY), `w`×`h` px, as `strips` horizontal slices.
 * Each slice is skewed from offset(s0) at its bottom to offset(s1) at its top,
 * so the slices join into one smooth bend.
 */
function drawBent(
  ctx: CanvasRenderingContext2D,
  tex: Tex,
  x: number,
  baseY: number,
  w: number,
  h: number,
  flip: boolean,
  strips: number,
  dpr: number,
  offset: (s: number) => number,
  widen?: (s: number) => number,
): void {
  const th = tex.height;
  const srcH = th / strips;
  const dh = h / strips;
  const overlap = 0.8;
  let o0 = offset(0);
  for (let i = 0; i < strips; i++) {
    const s1 = (i + 1) / strips;
    const o1 = offset(s1);
    const k = widen ? widen((i + 0.5) / strips) : 1;
    const srcTop = th - (i + 1) * srcH;
    const sh = Math.min(th - srcTop, srcH * (1 + overlap / dh));
    ctx.setTransform(dpr * (flip ? -k : k), 0, (dpr * (o0 - o1)) / dh, dpr, dpr * (x + o1), dpr * (baseY - s1 * h));
    ctx.drawImage(tex, 0, srcTop, tex.width, sh, -w / 2, 0, w, (sh / srcH) * dh);
    o0 = o1;
  }
}

function drawShadow(ctx: CanvasRenderingContext2D, shadow: Tex | null, x: number, y: number, w: number, alpha: number): void {
  if (!shadow) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(shadow, x - w * 0.6, y - w * 0.12, w * 1.2, w * 0.24);
}

function drawStrand(ctx: CanvasRenderingContext2D, st: Strand, t: number, sway: number, dpr: number): void {
  const tex = texture(st.kind, st.layer);
  if (!tex) return;
  ctx.globalAlpha = LAYERS[st.layer].alpha;
  const swayK = sway * LAYERS[st.layer].sway;
  drawBent(ctx, tex, st.x, st.baseY, st.width, st.height, st.flip, STRIPS[st.kind] ?? 12, dpr, (s) =>
    strandOffset(st, s, t, swayK),
  );
}

function drawProp(ctx: CanvasRenderingContext2D, p: Prop, t: number, sway: number, dpr: number, gust: number): void {
  const tex = texture(p.kind, p.layer);
  if (!tex) return;
  ctx.globalAlpha = LAYERS[p.layer].alpha;
  if (p.kind === "anemone") {
    const w = (2 * Math.PI) / p.period;
    const pulse = Math.sin(w * t + p.phase) * sway;
    const h = p.height * (1 + 0.03 * pulse);
    drawBent(
      ctx,
      tex,
      p.x,
      p.baseY,
      p.width,
      h,
      p.flip,
      STRIPS.anemone ?? 10,
      dpr,
      (s) => h * s ** 2 * (0.035 * Math.sin(w * 0.7 * t + p.phase * 1.7 - s * 2) * sway + gust * 0.06),
      (s) => 1 + 0.07 * s ** 2 * pulse,
    );
    return;
  }
  ctx.setTransform(dpr * (p.flip ? -1 : 1), 0, 0, dpr, dpr * p.x, dpr * p.baseY);
  ctx.drawImage(tex, -p.width / 2, -p.height, p.width, p.height);
}

function drawRays(ctx: CanvasRenderingContext2D, sc: Scenery, t: number, opts: SceneryDrawOptions, ray: Tex | null): void {
  if (!ray) return;
  const { layout } = sc;
  const len = layout.horizon * 1.05;
  ctx.globalCompositeOperation = "lighter";
  for (const r of layout.rays) {
    const pulse = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / r.period + r.phase);
    const drift = Math.sin((2 * Math.PI * t) / r.driftPeriod + r.phase) * opts.width * 0.025;
    ctx.globalAlpha = 0.05 + 0.09 * pulse;
    const x = r.u * opts.width + drift - r.width / 2;
    ctx.setTransform((opts.dpr * r.width) / 64, 0, opts.dpr * r.skew, (opts.dpr * len) / 256, opts.dpr * x, 0);
    ctx.drawImage(ray, 0, 0);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawCaustics(ctx: CanvasRenderingContext2D, sc: Scenery, t: number, opts: SceneryDrawOptions, tex: Tex | null): void {
  if (!tex) return;
  const pattern = ctx.createPattern(tex, "repeat");
  if (!pattern) return;
  const top = sc.layout.horizon;
  const band = opts.height - top;
  if (band <= 0) return;
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = pattern;
  const passes = [
    { sx: 1.6, sy: 0.55, vx: 9, vy: 2.5, a: 0.16 },
    { sx: 2.2, sy: 0.75, vx: -6, vy: 4, a: 0.12 },
  ];
  const canMove = typeof pattern.setTransform === "function" && typeof DOMMatrix !== "undefined";
  const bands = 8;
  for (const p of passes) {
    if (canMove) pattern.setTransform(new DOMMatrix().translateSelf(t * p.vx, top + t * p.vy).scaleSelf(p.sx, p.sy));
    const pulse = 0.8 + 0.2 * Math.sin(t * 0.6 + p.sx);
    for (let i = 0; i < bands; i++) {
      ctx.globalAlpha = p.a * pulse * ((i + 0.5) / bands) ** 0.8;
      const y = top + (band * i) / bands;
      ctx.fillRect(0, y, opts.width, band / bands + 0.5);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawPlankton(ctx: CanvasRenderingContext2D, sc: Scenery, t: number, lo: number, hi: number, dot: Tex | null): void {
  if (!dot) return;
  for (const p of sc.plankton) {
    if (p.depth < lo || p.depth >= hi) continue;
    ctx.globalAlpha = (0.18 + 0.45 * p.depth) * (0.55 + 0.45 * Math.sin(t * p.twinkle + p.phase));
    const s = p.r * 3;
    ctx.drawImage(dot, p.x - s / 2, p.y - s / 2, s, s);
  }
}

function drawBubbles(ctx: CanvasRenderingContext2D, sc: Scenery, bubble: Tex | null): void {
  if (!bubble) return;
  for (const b of sc.bubbles) {
    ctx.globalAlpha = Math.min(1, b.age * 3) * 0.9;
    ctx.drawImage(bubble, b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
  }
}

/** Paints the whole scenery layer. Reduced motion paints a still frame: no sway, particles or bubbles. */
export function drawScenery(ctx: CanvasRenderingContext2D, sc: Scenery, opts: SceneryDrawOptions): void {
  const tex = sharedTextures();
  const { dpr } = opts;
  const reduced = opts.reducedMotion;
  const t = reduced ? 0 : sc.time;
  const sway = reduced ? 0 : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, opts.width, opts.height);

  drawRays(ctx, sc, t, opts, tex.ray);
  drawCaustics(ctx, sc, t, opts, tex.caustic);

  const { strands, props } = sc.layout;
  let si = 0;
  let pi = 0;
  for (const layer of [0, 1, 2] as const) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let i = si; i < strands.length && strands[i].layer === layer; i++) {
      const st = strands[i];
      if (st.kind === "kelp") drawShadow(ctx, tex.shadow, st.x, st.baseY, st.width * 1.4, 0.5);
    }
    for (let i = pi; i < props.length && props[i].layer === layer; i++) {
      const p = props[i];
      drawShadow(ctx, tex.shadow, p.x, p.baseY - p.height * 0.04, p.width, 0.7);
    }
    while (si < strands.length && strands[si].layer === layer) drawStrand(ctx, strands[si++], t, sway, dpr);
    while (pi < props.length && props[pi].layer === layer) {
      const p = props[pi++];
      drawProp(ctx, p, t, sway, dpr, reduced ? 0 : gustAt(sc.gusts, p.x / opts.width));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!reduced) {
      if (layer === 1) drawBubbles(ctx, sc, tex.bubble);
      drawPlankton(ctx, sc, t, layer / 3, layer === 2 ? 1.01 : (layer + 1) / 3, tex.dot);
    }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
}
