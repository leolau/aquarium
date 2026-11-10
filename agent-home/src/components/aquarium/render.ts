/**
 * Canvas drawing for the aquarium. Creatures are the Canva sprites, decoded
 * once and baked with a soft drop shadow; until a sprite has loaded the v1
 * vector art stands in. A frame is transformed `drawImage` calls (a fish's
 * body wave is a few sheared slices) plus cached label pills.
 */
import { creatureSprite, type CreatureId } from "@/lib/aquarium/creatures";

import { CREATURE_ART, VIEWBOX, type CreatureArt } from "./creatures";
import { circle, ellipse } from "./creatures/shapes";
import {
  CHIP_LABEL_H,
  LEADER_LABEL_H,
  drawOrder,
  type HitTarget,
  type LabelKind,
  type Scene,
  type Swimmer,
} from "./scene";
import { causticLight } from "./sceneryDraw";
import { imageSize, loadImage } from "./sprites";
import { drawCreatureRipples } from "./sunlight";

const ART_PX = 256;
const SHADOW_PAD = 14;
const SELF_COLOR = "#ffd84a";
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const LABEL_FONT: Record<LabelKind, string> = { leader: `600 12px ${FONT}`, chip: `600 10px ${FONT}` };

/** How a creature moves its body. */
type Motion = "fish" | "mammal" | "pulse" | "flap" | "crawl" | "spin" | "upright";

const MOTION: Partial<Record<CreatureId, Motion>> = {
  dolphin: "mammal",
  orca: "mammal",
  whale: "mammal",
  narwhal: "mammal",
  beluga: "mammal",
  manatee: "mammal",
  seal: "mammal",
  "sea-otter": "mammal",
  walrus: "mammal",
  jellyfish: "pulse",
  octopus: "pulse",
  squid: "pulse",
  nautilus: "pulse",
  cuttlefish: "pulse",
  "manta-ray": "flap",
  stingray: "flap",
  "sea-turtle": "flap",
  penguin: "flap",
  crab: "crawl",
  lobster: "crawl",
  shrimp: "crawl",
  "hermit-crab": "crawl",
  nudibranch: "crawl",
  starfish: "spin",
  "sea-urchin": "spin",
  seahorse: "upright",
  "sea-dragon": "upright",
};

const NO_TILT = new Set<Motion>(["pulse", "spin", "upright"]);

interface Art {
  image: CanvasImageSource;
  /** Drawn width/height for a body of size 1 (longest side of the creature = 1). */
  w: number;
  h: number;
  /** Fully decoded Canva sprite (sliceable); the vector fallback is drawn whole. */
  sprite: boolean;
}

const baked = new Map<CreatureId, Art>();
const fallbacks = new Map<CreatureId, Art | null>();
let glowSprite: HTMLCanvasElement | null | undefined;

const GENERIC_ART: CreatureArt = {
  parts: [
    { d: "M26 50L8 36Q5 50 8 64Z", fill: "#7fd6e8", stroke: "#1d5a73", width: 2 },
    { d: ellipse(56, 50, 34, 20), fill: "#9be7f2", stroke: "#1d5a73", width: 2 },
    { d: circle(76, 45, 4.5), fill: "#ffffff", stroke: "#14171f", width: 0.8 },
    { d: circle(77.5, 45, 2.4), fill: "#14171f" },
  ],
};

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const ctx = canvas.getContext("2d");
  return ctx ? [canvas, ctx] : null;
}

function bakeSprite(id: CreatureId): Art | null {
  const hit = baked.get(id);
  if (hit) return hit;
  const img = loadImage(creatureSprite(id));
  if (!img) return null;
  const [iw, ih] = imageSize(img);
  if (!iw || !ih) return null;
  const made = makeCanvas(iw + SHADOW_PAD * 2, ih + SHADOW_PAD * 2);
  const long = Math.max(iw, ih);
  const art: Art = made
    ? { image: made[0], w: (iw + SHADOW_PAD * 2) / long, h: (ih + SHADOW_PAD * 2) / long, sprite: true }
    : { image: img, w: iw / long, h: ih / long, sprite: true };
  if (made) {
    const ctx = made[1];
    ctx.shadowColor = "rgba(0, 14, 34, 0.5)";
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 5;
    ctx.drawImage(img, SHADOW_PAD, SHADOW_PAD);
  }
  baked.set(id, art);
  return art;
}

function vectorArt(id: CreatureId): Art | null {
  if (fallbacks.has(id)) return fallbacks.get(id) ?? null;
  const made = typeof Path2D === "undefined" ? null : makeCanvas(ART_PX, ART_PX);
  if (!made) {
    fallbacks.set(id, null);
    return null;
  }
  const [canvas, ctx] = made;
  ctx.scale(ART_PX / VIEWBOX, ART_PX / VIEWBOX);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const part of (CREATURE_ART[id] ?? GENERIC_ART).parts) {
    const path = new Path2D(part.d);
    ctx.globalAlpha = part.opacity ?? 1;
    if (part.fill) {
      ctx.fillStyle = part.fill;
      ctx.fill(path);
    }
    if (part.stroke) {
      ctx.strokeStyle = part.stroke;
      ctx.lineWidth = part.width ?? 1;
      ctx.stroke(path);
    }
  }
  const art: Art = { image: canvas, w: 1, h: 1, sprite: false };
  fallbacks.set(id, art);
  return art;
}

function artFor(id: CreatureId): Art | null {
  return bakeSprite(id) ?? vectorArt(id);
}

function glow(): HTMLCanvasElement | null {
  if (glowSprite !== undefined) return glowSprite;
  const made = makeCanvas(128, 128);
  if (!made) return (glowSprite = null);
  const [canvas, ctx] = made;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, "rgba(140, 255, 236, 0.55)");
  g.addColorStop(0.5, "rgba(90, 220, 255, 0.22)");
  g.addColorStop(1, "rgba(90, 220, 255, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return (glowSprite = canvas);
}

export interface DrawOptions {
  width: number;
  height: number;
  dpr: number;
  reducedMotion: boolean;
  selected: HitTarget | null;
  /** Seconds, for the sunlight ripples over the creatures; omitted means no ripples. */
  time?: number;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Vertical bob in CSS px. */
function bob(s: Swimmer, reduced: boolean): number {
  return reduced ? 0 : Math.sin(s.bobPhase) * Math.min(4, s.size * 0.04);
}

function sliceCount(size: number, motion: Motion, reduced: boolean): number {
  if (reduced || (motion !== "fish" && motion !== "mammal" && motion !== "flap")) return 1;
  return size < 40 ? 2 : size < 90 ? 3 : 4;
}

function drawSwimmer(ctx: CanvasRenderingContext2D, s: Swimmer, alpha: number, dpr: number, reduced: boolean): void {
  if (alpha <= 0.01) return;
  const art = artFor(s.creature);
  if (!art) return;
  const motion = MOTION[s.creature] ?? "fish";
  const w = s.size * art.w;
  const h = s.size * art.h;
  const p = s.phase;

  const turning = Math.abs(s.face);
  let fx = Math.sign(s.face || s.faceTarget || 1) * Math.max(0.06, smoothstep(Math.min(1, turning)));
  let fy = 1 + 0.06 * (1 - turning);
  let rot = NO_TILT.has(motion) ? 0 : s.tilt * Math.sign(s.faceTarget || 1);
  let dy = bob(s, reduced);
  if (!reduced) {
    if (motion === "pulse") {
      const beat = Math.sin(p * 0.55);
      fx *= 1 + 0.06 * beat;
      fy *= 1 - 0.08 * beat;
    } else if (motion === "flap") {
      fy *= 1 + 0.1 * Math.sin(p * 0.6);
    } else if (motion === "crawl") {
      rot += 0.07 * Math.sin(p * 0.9);
      dy -= Math.abs(Math.sin(p * 0.9)) * Math.min(3, s.size * 0.03);
    } else if (motion === "spin") {
      rot += s.bobPhase * 0.35;
    } else if (motion === "upright") {
      rot += 0.07 * Math.sin(s.bobPhase * 1.4);
      fy *= 1 + 0.03 * Math.sin(p * 0.8);
    } else {
      fy *= 1 + 0.025 * Math.sin(p * 2);
    }
  }

  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const a = dpr * cos * fx;
  const b = dpr * sin * fx;
  const c = -dpr * sin * fy;
  const d = dpr * cos * fy;
  const e = dpr * s.x;
  const f = dpr * (s.y + dy);
  ctx.globalAlpha = alpha;

  const n = art.sprite ? sliceCount(s.size, motion, reduced) : 1;
  if (n === 1) {
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(art.image, -w / 2, -h / 2, w, h);
    return;
  }
  // Body wave: the tail (left, u = 0) swings most, the head barely moves.
  const amp = h * (motion === "mammal" ? 0.07 : motion === "flap" ? 0.035 : 0.05);
  const rate = motion === "mammal" ? 0.7 : 1;
  const offset = (u: number) => amp * (1 - u) ** 1.6 * Math.sin(p * rate - u * 2.4);
  const img = art.image as HTMLCanvasElement;
  const srcW = img.width;
  const srcH = img.height;
  let o0 = offset(0);
  for (let j = 0; j < n; j++) {
    const u0 = j / n;
    const u1 = (j + 1) / n;
    const o1 = offset(u1);
    const x0 = -w / 2 + w * u0;
    const sw = w / n;
    const shear = (o1 - o0) / sw;
    const t = o0 - shear * x0;
    ctx.setTransform(a + c * shear, b + d * shear, c, d, e + c * t, f + d * t);
    const overlap = j < n - 1 ? 0.6 : 0;
    ctx.drawImage(img, srcW * u0, 0, (srcW / n) * (1 + overlap / sw), srcH, x0, -h / 2, sw + overlap, h);
    o0 = o1;
  }
}

function ring(ctx: CanvasRenderingContext2D, s: Swimmer, color: string, alpha: number, self: boolean, reduced: boolean): void {
  const r = s.size * 0.55 + 5;
  const y = s.y + bob(s, reduced);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(s.x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(2, 14, 32, 0.55)";
  ctx.lineWidth = self ? 5 : 4;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = self ? 2.5 : 2;
  if (self) {
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = reduced ? 0 : -s.bobPhase * 9;
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

const widths = new Map<string, number>();
const pills = new Map<string, HTMLCanvasElement | null>();
const LABEL_CACHE_MAX = 4000;
const measured = new WeakSet<Scene>();

function measurer(ctx: CanvasRenderingContext2D): Scene["measure"] {
  return (text, kind) => {
    const key = `${kind}|${text}`;
    let w = widths.get(key);
    if (w === undefined) {
      if (widths.size > LABEL_CACHE_MAX) widths.clear();
      ctx.font = LABEL_FONT[kind];
      w = ctx.measureText(text).width;
      widths.set(key, w);
    }
    return w;
  };
}

/** A label pill (rounded background + text) rasterised once at device scale. */
function pill(text: string, kind: LabelKind, w: number, self: boolean, dpr: number): HTMLCanvasElement | null {
  const key = `${kind}|${self ? 1 : 0}|${dpr}|${w}|${text}`;
  if (pills.has(key)) return pills.get(key) ?? null;
  if (pills.size > LABEL_CACHE_MAX) pills.clear();
  const h = kind === "leader" ? LEADER_LABEL_H : CHIP_LABEL_H;
  const made = makeCanvas(w * dpr, h * dpr);
  if (!made) {
    pills.set(key, null);
    return null;
  }
  const [canvas, ctx] = made;
  ctx.scale(dpr, dpr);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(0.5, 0.5, w - 1, h - 1, h / 2);
  else ctx.rect(0.5, 0.5, w - 1, h - 1);
  ctx.fillStyle = kind === "leader" ? "rgba(3, 20, 44, 0.72)" : "rgba(6, 46, 72, 0.7)";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = self ? "rgba(255, 216, 74, 0.75)" : "rgba(255, 255, 255, 0.2)";
  ctx.stroke();
  ctx.font = LABEL_FONT[kind];
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = self ? SELF_COLOR : kind === "leader" ? "#f2fbff" : "#cfefff";
  ctx.fillText(text, w / 2, h / 2 + 0.5);
  pills.set(key, canvas);
  return canvas;
}

function drawLabel(ctx: CanvasRenderingContext2D, s: Swimmer, kind: LabelKind, alpha: number, self: boolean, dpr: number): void {
  const a = alpha * s.labelAlpha;
  if (a <= 0.02 || !s.label || !s.labelPlaced) return;
  const img = pill(s.label, kind, s.labelW, self, dpr);
  if (!img) return;
  ctx.globalAlpha = a;
  ctx.drawImage(img, s.labelX - s.labelW / 2, s.labelY, s.labelW, kind === "leader" ? LEADER_LABEL_H : CHIP_LABEL_H);
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, opts: DrawOptions): void {
  const { dpr } = opts;
  if (!measured.has(scene) && typeof ctx.measureText === "function") {
    measured.add(scene);
    scene.measure = measurer(ctx);
  }
  scene.focus = opts.selected?.userId ?? null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, opts.width, opts.height);

  if (scene.bubbles.length > 0) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const b of scene.bubbles) {
      ctx.moveTo(b.x + b.r, b.y);
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();
  }

  const order = drawOrder(scene);
  const halo = glow();
  for (const l of order) {
    if (halo && l.user.metrics.active_now) {
      const pulse = opts.reducedMotion ? 1 : 0.85 + Math.sin(l.phase * 0.5) * 0.15;
      const r = l.size * 1.1 * pulse;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = l.alpha;
      ctx.drawImage(halo, l.x - r, l.y - r, r * 2, r * 2);
    }
    for (const f of l.followers.values()) drawSwimmer(ctx, f, f.alpha * l.alpha, dpr, opts.reducedMotion);
    drawSwimmer(ctx, l, l.alpha, dpr, opts.reducedMotion);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (l.user.is_self) ring(ctx, l, SELF_COLOR, l.alpha * 0.95, true, opts.reducedMotion);
  }
  if (opts.time !== undefined && order.length > 0) {
    drawCreatureRipples(ctx, opts.reducedMotion ? 0 : opts.time, opts, causticLight());
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sel = opts.selected;
  if (sel) {
    const l = scene.leaders.get(sel.userId);
    const target = sel.profile ? l?.followers.get(sel.profile) : l;
    if (target) ring(ctx, target, "#ffffff", 0.85 * target.alpha, false, opts.reducedMotion);
  }

  for (const l of order) {
    for (const f of l.followers.values()) drawLabel(ctx, f, "chip", f.alpha * l.alpha, false, dpr);
  }
  for (const l of order) drawLabel(ctx, l, "leader", l.alpha, l.user.is_self, dpr);
  ctx.globalAlpha = 1;
}
