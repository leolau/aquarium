import { describe, expect, it } from "vitest";

import {
  FIRST_GUST,
  FLUTTER_PERIOD,
  GUST_DURATION,
  GUST_INTERVAL,
  STRAND_PERIOD,
  createGusts,
  createScenery,
  gustAt,
  horizonY,
  layoutScenery,
  pushOn,
  resizeScenery,
  seededRng,
  stepGusts,
  stepScenery,
  strandOffset,
  type Strand,
} from "./scenery";

function strand(over: Partial<Strand> = {}): Strand {
  return {
    kind: "kelp",
    layer: 2,
    x: 100,
    baseY: 500,
    width: 40,
    height: 200,
    flip: false,
    period: 5,
    phase: 0.4,
    amplitude: 0.08,
    flutterPeriod: 1.4,
    flutterPhase: 1,
    lean: 0,
    leanV: 0,
    ...over,
  };
}

describe("layoutScenery", () => {
  it("is deterministic for a seed and size", () => {
    expect(layoutScenery(1280, 800, 7)).toEqual(layoutScenery(1280, 800, 7));
    expect(layoutScenery(1280, 800, 7)).not.toEqual(layoutScenery(1280, 800, 8));
  });

  it("keeps items at the same relative x across resizes and only adds items when wider", () => {
    const small = layoutScenery(800, 700);
    const wide = layoutScenery(1920, 700);
    const key = (s: { kind: string; layer: number; x: number }, w: number) => `${s.kind}:${s.layer}:${(s.x / w).toFixed(6)}`;
    const wideKeys = new Set(wide.strands.map((s) => key(s, 1920)));
    for (const s of small.strands) expect(wideKeys.has(key(s, 800))).toBe(true);
    expect(wide.strands.length).toBeGreaterThan(small.strands.length);
    expect(wide.props.length).toBeGreaterThanOrEqual(small.props.length);
  });

  it("puts everything on the seabed below the sand horizon, inside the tank, back to front", () => {
    const l = layoutScenery(1440, 900);
    expect(l.horizon).toBeCloseTo(horizonY(1440, 900));
    for (const item of [...l.strands, ...l.props]) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.x).toBeLessThanOrEqual(1440);
      expect(item.baseY).toBeGreaterThan(l.horizon);
      expect(item.height).toBeGreaterThan(0);
    }
    const layers = l.strands.map((s) => s.layer);
    expect(layers).toEqual([...layers].sort());
    expect(new Set(l.strands.map((s) => s.layer))).toEqual(new Set([0, 1, 2]));
    expect(l.vents.length).toBeGreaterThanOrEqual(2);
    expect(l.rays.length).toBeGreaterThanOrEqual(4);
  });

  it("gives every strand its own period (3–9 s), flutter and phase", () => {
    const { strands } = layoutScenery(1920, 1080);
    for (const s of strands) {
      expect(s.period).toBeGreaterThanOrEqual(STRAND_PERIOD[0]);
      expect(s.period).toBeLessThanOrEqual(STRAND_PERIOD[1]);
      expect(s.flutterPeriod).toBeGreaterThanOrEqual(FLUTTER_PERIOD[0]);
      expect(s.flutterPeriod).toBeLessThanOrEqual(FLUTTER_PERIOD[1]);
      expect(s.phase).toBeGreaterThanOrEqual(0);
      expect(s.phase).toBeLessThan(Math.PI * 2);
    }
    expect(new Set(strands.map((s) => s.period.toFixed(3))).size).toBeGreaterThan(strands.length * 0.8);
  });
});

describe("strandOffset", () => {
  it("keeps the root still and sways more towards the tip", () => {
    const st = strand();
    const peak = (s: number) => {
      let m = 0;
      for (let t = 0; t < 10; t += 0.05) m = Math.max(m, Math.abs(strandOffset(st, s, t)));
      return m;
    };
    expect(strandOffset(st, 0, 3.3)).toBe(0);
    expect(peak(0.25)).toBeLessThan(peak(0.5));
    expect(peak(0.5)).toBeLessThan(peak(1));
    expect(peak(1)).toBeLessThan(st.height * 0.2);
  });

  it("is still with sway 0 and no lean (reduced motion)", () => {
    expect(strandOffset(strand(), 1, 4.2, 0)).toBe(0);
  });
});

describe("gusts", () => {
  it("schedules the first gust soon and then one every 20–40 s", () => {
    const rng = seededRng(3);
    const g = createGusts(rng);
    expect(g.next).toBeGreaterThanOrEqual(FIRST_GUST[0]);
    expect(g.next).toBeLessThanOrEqual(FIRST_GUST[1]);
    const starts: number[] = [];
    for (let t = 0; t < 400; t += 0.05) {
      const was = g.active;
      stepGusts(g, 0.05, rng);
      if (g.active && !was) {
        starts.push(g.start);
        expect(g.duration).toBeGreaterThanOrEqual(GUST_DURATION[0]);
        expect(g.duration).toBeLessThanOrEqual(GUST_DURATION[1]);
      }
    }
    expect(starts.length).toBeGreaterThan(8);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i] - starts[i - 1];
      expect(gap).toBeGreaterThanOrEqual(GUST_INTERVAL[0]);
      expect(gap).toBeLessThanOrEqual(GUST_INTERVAL[1]);
    }
  });

  it("sweeps left to right and is zero between gusts", () => {
    const rng = seededRng(5);
    const g = createGusts(rng);
    expect(gustAt(g, 0.5)).toBe(0);
    const peakAt = (u: number) => {
      const copy = createGusts(seededRng(5));
      let best = 0;
      let when = 0;
      for (let t = 0; t < 30; t += 0.05) {
        stepGusts(copy, 0.05, rng);
        const v = gustAt(copy, u);
        if (v > best) {
          best = v;
          when = copy.clock;
        }
      }
      return when;
    };
    expect(peakAt(0.1)).toBeLessThan(peakAt(0.5));
    expect(peakAt(0.5)).toBeLessThan(peakAt(0.9));
  });
});

describe("pushOn", () => {
  it("pushes a strand away from a creature swimming through it", () => {
    const st = strand();
    expect(pushOn(st, [{ x: 80, y: 420, size: 80 }])).toBeGreaterThan(0);
    expect(pushOn(st, [{ x: 120, y: 420, size: 80 }])).toBeLessThan(0);
    expect(pushOn(st, [{ x: 600, y: 420, size: 80 }])).toBe(0);
    expect(pushOn(st, [{ x: 100, y: 100, size: 80 }])).toBe(0);
    expect(pushOn(st, null)).toBe(0);
  });
});

describe("stepScenery", () => {
  it("bends strands when a creature passes and emits vent bubbles", () => {
    const sc = createScenery(1280, 800, 35, seededRng(9));
    const st = sc.layout.strands.find((s) => s.layer === 2)!;
    const pusher = { x: st.x - 4, y: st.baseY - st.height * 0.6, size: 90 };
    for (let i = 0; i < 30; i++) stepScenery(sc, 1 / 60, { pushers: [pusher] });
    expect(st.lean).toBeGreaterThan(0);
    expect(sc.bubbles.length).toBeGreaterThan(0);
  });

  it("holds everything still under reduced motion", () => {
    const sc = createScenery(1280, 800, 35, seededRng(9));
    for (let i = 0; i < 60; i++) stepScenery(sc, 1 / 60);
    const before = sc.plankton.map((p) => [p.x, p.y]);
    for (let i = 0; i < 60; i++) stepScenery(sc, 1 / 60, { reducedMotion: true });
    expect(sc.bubbles).toHaveLength(0);
    expect(sc.plankton.map((p) => [p.x, p.y])).toEqual(before);
    expect(sc.layout.strands.every((s) => s.lean === 0)).toBe(true);
  });

  it("re-lays the seabed on resize and keeps particles in the tank", () => {
    const sc = createScenery(1280, 800);
    resizeScenery(sc, 640, 900);
    expect(sc.layout).toEqual(layoutScenery(640, 900));
    for (const p of sc.plankton) {
      expect(p.x).toBeLessThanOrEqual(640 + 4);
      expect(p.y).toBeLessThanOrEqual(900 + 4);
    }
  });
});
