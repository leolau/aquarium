/**
 * Creature drawings are path data in a 100×100 box, facing right, so one
 * source feeds both the SVG `CreatureIcon` and the canvas (via `Path2D`).
 */
export interface CreaturePart {
  d: string;
  fill?: string;
  stroke?: string;
  width?: number;
  opacity?: number;
}

export interface CreatureArt {
  parts: readonly CreaturePart[];
  /** Drawn upright: never tilted toward the swim direction. */
  upright?: boolean;
}

export const VIEWBOX = 100;

export function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0Z`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A star (or spiky ring) with `points` tips between radii `outer` and `inner`. */
export function star(cx: number, cy: number, outer: number, inner: number, points: number, rotate = -Math.PI / 2): string {
  const out: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotate + (i * Math.PI) / points;
    out.push(`${i === 0 ? "M" : "L"}${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`);
  }
  return `${out.join("")}Z`;
}

/** A pair of eye parts: white with a dark pupil looking forward. */
export function eye(cx: number, cy: number, r: number, pupil = "#14171f"): CreaturePart[] {
  return [
    { d: circle(cx, cy, r), fill: "#ffffff", stroke: pupil, width: 0.8 },
    { d: circle(cx + r * 0.25, cy, r * 0.55), fill: pupil },
    { d: circle(cx + r * 0.45, cy - r * 0.35, r * 0.18), fill: "#ffffff" },
  ];
}
