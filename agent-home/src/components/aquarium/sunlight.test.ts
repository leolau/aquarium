import { describe, expect, it, vi } from "vitest";

import { horizonY } from "./scenery";
import { drawCreatureRipples, rayAlpha, surfaceDepth, surfaceGlints, twinkle } from "./sunlight";

function fakeCtx() {
  const ops: string[] = [];
  const ctx = {
    globalAlpha: 1,
    _op: "source-over",
    get globalCompositeOperation() {
      return this._op;
    },
    set globalCompositeOperation(v: string) {
      this._op = v;
      ops.push(v);
    },
    fillStyle: "" as unknown,
    setTransform: vi.fn(),
    createPattern: vi.fn(() => ({ setTransform: vi.fn() })),
    fillRect: vi.fn(),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, ops, raw: ctx };
}

describe("sunlight", () => {
  it("makes light beams clearly brighter than before, and bounded", () => {
    expect(rayAlpha(0, 0)).toBeGreaterThan(0.05);
    expect(rayAlpha(1, 1)).toBeGreaterThan(0.14 * 2);
    expect(rayAlpha(1, 1)).toBeLessThan(0.4);
  });

  it("keeps the surface band at the top, above the sand", () => {
    for (const [w, h] of [[1280, 720], [390, 844], [2560, 1080]] as const) {
      const d = surfaceDepth(w, h);
      expect(d).toBeGreaterThanOrEqual(48);
      expect(d).toBeLessThan(horizonY(w, h));
    }
  });

  it("spreads glints across the width inside the surface band", () => {
    const glints = surfaceGlints(1280, 120);
    expect(glints.length).toBeGreaterThanOrEqual(8);
    expect(surfaceGlints(1280, 120)).toEqual(glints);
    for (const g of glints) {
      expect(g.x).toBeGreaterThanOrEqual(0);
      expect(g.x).toBeLessThan(1280);
      expect(g.y).toBeGreaterThan(0);
      expect(g.y).toBeLessThan(120);
    }
    const xs = glints.map((g) => g.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(200);
    expect(xs[xs.length - 1]).toBeGreaterThan(1080);
  });

  it("twinkles: dark most of the time, with short flashes", () => {
    const g = surfaceGlints(800, 100)[0];
    const samples = Array.from({ length: 400 }, (_, i) => twinkle(i * 0.05, g));
    expect(Math.max(...samples)).toBeGreaterThan(0.9);
    expect(samples.filter((v) => v < 0.05).length).toBeGreaterThan(samples.length / 2);
  });

  it("paints creature ripples only on top of what is drawn (source-atop) and restores state", () => {
    const { ctx, ops, raw } = fakeCtx();
    drawCreatureRipples(ctx, 3, { width: 800, height: 600, dpr: 1 }, {} as CanvasImageSource);
    expect(ops[0]).toBe("source-atop");
    expect(raw.fillRect).toHaveBeenCalled();
    expect(raw._op).toBe("source-over");
    expect(raw.globalAlpha).toBe(1);
  });

  it("skips ripples without the caustic texture", () => {
    const { ctx, raw } = fakeCtx();
    drawCreatureRipples(ctx, 3, { width: 800, height: 600, dpr: 1 }, null);
    expect(raw.fillRect).not.toHaveBeenCalled();
  });
});
