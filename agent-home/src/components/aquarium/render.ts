/**
 * Canvas drawing for the aquarium. Each creature is rasterised once into a
 * sprite (Path2D from the shared drawings), so a frame is just transformed
 * `drawImage` calls plus labels — cheap enough for hundreds of swimmers.
 */
import type { CreatureId } from "@/lib/aquarium/creatures";

import { CREATURE_ART, VIEWBOX } from "./creatures";
import { drawOrder, type HitTarget, type Leader, type Scene, type Swimmer } from "./scene";

const SPRITE_PX = 256;
const SELF_COLOR = "#ffd84a";
const LABEL_FONT = "600 12px system-ui, -apple-system, 'Segoe UI', sans-serif";

type Sprite = HTMLCanvasElement;
const sprites = new Map<CreatureId, Sprite | null>();
let glowSprite: Sprite | null | undefined;

function makeCanvas(px: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined" || typeof Path2D === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  return ctx ? [canvas, ctx] : null;
}

function sprite(id: CreatureId): Sprite | null {
  if (sprites.has(id)) return sprites.get(id) ?? null;
  const made = makeCanvas(SPRITE_PX);
  const art = CREATURE_ART[id];
  if (!made || !art) {
    sprites.set(id, null);
    return null;
  }
  const [canvas, ctx] = made;
  ctx.scale(SPRITE_PX / VIEWBOX, SPRITE_PX / VIEWBOX);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const part of art.parts) {
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
  sprites.set(id, canvas);
  return canvas;
}

function glow(): Sprite | null {
  if (glowSprite !== undefined) return glowSprite;
  const made = makeCanvas(128);
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
}

function drawSwimmer(ctx: CanvasRenderingContext2D, s: Swimmer, alpha: number, reduced: boolean): void {
  const img = sprite(s.creature);
  if (!img || alpha <= 0.01) return;
  const upright = CREATURE_ART[s.creature]?.upright === true;
  const bob = reduced ? 0 : Math.sin(s.phase) * Math.min(3, s.size * 0.05);
  const face = Math.sign(s.face || 1) * Math.max(0.12, Math.abs(s.face));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(s.x, s.y + bob);
  ctx.scale(face, 1);
  if (!upright) ctx.rotate(Math.max(-0.45, Math.min(0.45, Math.atan2(s.vy, Math.abs(s.vx) + 1))));
  if (!reduced) {
    const w = Math.sin(s.phase * 2.2) * 0.035;
    ctx.scale(1 + w, 1 - w);
  }
  ctx.drawImage(img, -s.size / 2, -s.size / 2, s.size, s.size);
  ctx.restore();
}

function ring(ctx: CanvasRenderingContext2D, s: Swimmer, color: string, alpha: number, dash: boolean): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (dash) ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.size * 0.58 + 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, l: Leader): void {
  ctx.globalAlpha = l.alpha;
  const y = l.y + l.size * 0.5 + 6;
  ctx.strokeText(l.user.name, l.x, y);
  ctx.fillStyle = l.user.is_self ? SELF_COLOR : "#f2fbff";
  ctx.fillText(l.user.name, l.x, y);
}

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene, opts: DrawOptions): void {
  ctx.setTransform(opts.dpr, 0, 0, opts.dpr, 0, 0);
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
      const pulse = opts.reducedMotion ? 1 : 0.85 + Math.sin(l.phase * 1.3) * 0.15;
      const r = l.size * 1.1 * pulse;
      ctx.globalAlpha = l.alpha;
      ctx.drawImage(halo, l.x - r, l.y - r, r * 2, r * 2);
    }
    for (const f of l.followers.values()) drawSwimmer(ctx, f, f.alpha * l.alpha, opts.reducedMotion);
    drawSwimmer(ctx, l, l.alpha, opts.reducedMotion);
    if (l.user.is_self) ring(ctx, l, SELF_COLOR, l.alpha * 0.9, true);
  }

  const sel = opts.selected;
  if (sel) {
    const l = scene.leaders.get(sel.userId);
    const target = sel.profile ? l?.followers.get(sel.profile) : l;
    if (target) ring(ctx, target, "#ffffff", 0.85 * target.alpha, false);
  }

  ctx.font = LABEL_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(4, 22, 46, 0.75)";
  for (const l of order) label(ctx, l);
  ctx.globalAlpha = 1;
}
