import { describe, expect, it } from "vitest";

import type { AquariumSnapshot, AquariumUser } from "@/lib/aquarium/creatures";

import { busiestScore, creatureSize, creatureSpeed, followerSize } from "./mapping";
import {
  FADE_SECONDS,
  FLIP_SECONDS,
  FOLLOWER_CHIP_LIMIT,
  applySnapshot,
  createScene,
  easeToward,
  followerSlot,
  hitTest,
  layoutLabels,
  locate,
  maxTrail,
  minBehind,
  sceneBounds,
  stepScene,
  type LabelBox,
  type Scene,
} from "./scene";

function seeded(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function user(id: string, over: Partial<AquariumUser> = {}): AquariumUser {
  return {
    user_id: id,
    name: id,
    creature: "clownfish",
    is_self: false,
    metrics: { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 0, active_now: false },
    profiles: [],
    ...over,
  };
}

function snap(users: AquariumUser[]): AquariumSnapshot {
  return { generated_at: 0, idle_seconds: 30, name: "Aquarium", users };
}

const bounds = sceneBounds(1200, 800);

function run(scene: Scene, seconds: number, dt = 1 / 60, reducedMotion = false): void {
  for (let t = 0; t < seconds; t += dt) stepScene(scene, dt, bounds, { reducedMotion });
}

describe("easeToward", () => {
  it("settles in about a second regardless of frame rate", () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 60; i++) a = easeToward(a, 100, 1 / 60);
    for (let i = 0; i < 30; i++) b = easeToward(b, 100, 1 / 30);
    expect(a).toBeGreaterThan(94);
    expect(a).toBeLessThanOrEqual(100);
    expect(Math.abs(a - b)).toBeLessThan(0.001);
    expect(easeToward(5, 100, 0)).toBe(5);
  });
});

describe("applySnapshot", () => {
  it("adds people with their followers and fades them in", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a", { profiles: [{ name: "default", display_name: "Default" }] })]), bounds);
    const a = scene.leaders.get("a")!;
    expect(a.alpha).toBe(0);
    expect(a.followers.size).toBe(1);
    run(scene, FADE_SECONDS + 0.1);
    expect(a.alpha).toBe(1);
    expect(a.followers.get("default")!.alpha).toBe(1);
  });

  it("retargets size and speed and eases them over about a second", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a")]), bounds);
    run(scene, 1);
    const busy = user("a", {
      metrics: { chats: 100, projects: 10, tokens_in: 1e6, tokens_out: 1e6, tokens_24h: 1e6, active_now: true },
    });
    applySnapshot(scene, snap([busy]), bounds);
    const a = scene.leaders.get("a")!;
    const from = a.size;
    const target = creatureSize(busy.metrics, busiestScore([busy.metrics]));
    expect(a.targetSize).toBe(target);
    expect(a.targetSpeed).toBe(creatureSpeed(busy.metrics, target));
    run(scene, 0.2);
    expect(a.size).toBeGreaterThan(from);
    expect(a.size).toBeLessThan(target);
    run(scene, 1);
    expect(Math.abs(a.size - target)).toBeLessThan((target - from) * 0.05);
    expect(Math.abs(a.speed - a.targetSpeed)).toBeLessThan(a.targetSpeed * 0.05);
  });

  it("fades out and then drops people and profiles that left", () => {
    const scene = createScene(seeded());
    const profiles = [
      { name: "default", display_name: "Default" },
      { name: "sales", display_name: "Sales" },
    ];
    applySnapshot(scene, snap([user("a", { profiles }), user("b")]), bounds);
    run(scene, 1);
    applySnapshot(scene, snap([user("a", { profiles: profiles.slice(0, 1) })]), bounds);
    expect(scene.leaders.get("b")!.leaving).toBe(true);
    expect(scene.leaders.get("a")!.followers.get("sales")!.leaving).toBe(true);
    run(scene, FADE_SECONDS + 0.1);
    expect(scene.leaders.has("b")).toBe(false);
    expect([...scene.leaders.get("a")!.followers.keys()]).toEqual(["default"]);
  });

  it("revives someone who comes back while fading", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a")]), bounds);
    run(scene, 1);
    applySnapshot(scene, snap([]), bounds);
    run(scene, 0.2);
    applySnapshot(scene, snap([user("a")]), bounds);
    expect(scene.leaders.get("a")!.leaving).toBe(false);
    run(scene, 1);
    expect(scene.leaders.get("a")!.alpha).toBe(1);
  });
});

describe("stepScene", () => {
  it("keeps everyone inside the water and moving, and followers near their leader", () => {
    const scene = createScene(seeded(7));
    const users = Array.from({ length: 12 }, (_, i) =>
      user(`u${i}`, {
        metrics: { chats: i * 10, projects: i, tokens_in: 10 ** i, tokens_out: 0, tokens_24h: 10 ** (i % 8), active_now: i % 3 === 0 },
        profiles: [
          { name: "default", display_name: "Default" },
          { name: `p${i}`, display_name: `P${i}` },
        ],
      }),
    );
    applySnapshot(scene, snap(users), bounds);
    const start = new Map([...scene.leaders].map(([id, l]) => [id, l.x]));
    run(scene, 20);
    for (const [id, l] of scene.leaders) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThanOrEqual(bounds.width);
      expect(l.y).toBeGreaterThanOrEqual(bounds.top);
      expect(l.y).toBeLessThanOrEqual(bounds.bottom);
      expect(Number.isFinite(l.vx) && Number.isFinite(l.vy)).toBe(true);
      expect(l.x).not.toBe(start.get(id));
      for (const f of l.followers.values()) {
        expect(f.size).toBeCloseTo(followerSize(l.size, f.seed), 0);
        expect(Math.hypot(f.x - l.x, f.y - l.y)).toBeLessThanOrEqual(maxTrail(l.size, f.size) + 1e-6);
      }
    }
    expect(scene.bubbles.length).toBeGreaterThan(0);
  });

  it("clamps a long stall instead of teleporting", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a", { metrics: { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 1e9, active_now: false } })]), bounds);
    const a = scene.leaders.get("a")!;
    const x = a.x;
    const y = a.y;
    stepScene(scene, 30, bounds);
    expect(Math.hypot(a.x - x, a.y - y)).toBeLessThan(40);
  });

  it("drifts slower and without bubbles under reduced motion", () => {
    const fast = createScene(seeded(3));
    const slow = createScene(seeded(3));
    const u = user("a", { metrics: { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 1e6, active_now: true } });
    applySnapshot(fast, snap([u]), bounds);
    applySnapshot(slow, snap([u]), bounds);
    run(fast, 5);
    run(slow, 5, 1 / 60, true);
    const speed = (s: Scene) => Math.hypot(s.leaders.get("a")!.vx, s.leaders.get("a")!.vy);
    expect(speed(slow)).toBeLessThan(speed(fast));
    expect(slow.bubbles).toHaveLength(0);
  });

  it("steps 200 people with followers well inside a frame budget", () => {
    const scene = createScene(seeded(11));
    const users = Array.from({ length: 200 }, (_, i) =>
      user(`u${i}`, {
        profiles: [0, 1, 2].map((j) => ({ name: `p${j}`, display_name: `P${j}` })),
        metrics: { chats: i, projects: 1, tokens_in: i * 1000, tokens_out: 0, tokens_24h: i * 100, active_now: i % 5 === 0 },
      }),
    );
    applySnapshot(scene, snap(users), bounds);
    run(scene, 0.5);
    const t0 = performance.now();
    run(scene, 2);
    const perFrame = (performance.now() - t0) / 120;
    expect(perFrame).toBeLessThan(8);
  });
});

describe("followers", () => {
  const profiles = (n: number) => Array.from({ length: n }, (_, j) => ({ name: `p${j}`, display_name: `Profile ${j}` }));

  it("never get level with or ahead of their leader and stay within ~2 leader lengths", () => {
    const scene = createScene(seeded(5));
    const users = Array.from({ length: 6 }, (_, i) =>
      user(`u${i}`, {
        profiles: profiles(1 + i),
        metrics: { chats: i * 30, projects: i, tokens_in: 10 ** (i + 1), tokens_out: 0, tokens_24h: 10 ** (i + 1), active_now: false },
      }),
    );
    applySnapshot(scene, snap(users), bounds);
    for (let frame = 0; frame < 60 * 30; frame++) {
      stepScene(scene, 1 / 60, bounds);
      for (const l of scene.leaders.values()) {
        const ax = Math.cos(l.trailAngle);
        const ay = Math.sin(l.trailAngle);
        for (const f of l.followers.values()) {
          const along = (f.x - l.x) * ax + (f.y - l.y) * ay;
          expect(along).toBeLessThanOrEqual(-minBehind(l.size) + 1e-6);
          expect(Math.hypot(f.x - l.x, f.y - l.y)).toBeLessThanOrEqual(maxTrail(l.size, f.size) + 1e-6);
        }
      }
    }
  });

  it("lays out slots in an arc behind the leader, inside the trail limit", () => {
    for (const n of [1, 2, 3, 5, 8, 12]) {
      const seen = new Set<string>();
      for (let i = 0; i < n; i++) {
        const { back, lateral } = followerSlot(i, n, 100, 40);
        expect(back).toBeGreaterThan(minBehind(100));
        expect(back).toBeLessThanOrEqual(maxTrail(100, 40));
        seen.add(`${back.toFixed(1)}/${lateral.toFixed(1)}`);
      }
      expect(seen.size).toBe(n);
    }
  });

  it("swim as a per-person creature that is not the leader's", () => {
    const scene = createScene(seeded());
    const p = [{ name: "default", display_name: "Default" }];
    applySnapshot(scene, snap(Array.from({ length: 30 }, (_, i) => user(`u${i}`, { profiles: p }))), bounds);
    const looks = new Set([...scene.leaders.values()].map((l) => l.followers.get("default")!.creature));
    expect(looks.size).toBeGreaterThan(5);
    for (const l of scene.leaders.values()) expect(l.followers.get("default")!.creature).not.toBe(l.creature);
  });

  it("show name chips unless the tank is crowded, then only for the focused person", () => {
    const quiet = createScene(seeded());
    applySnapshot(quiet, snap([user("a", { profiles: profiles(2) })]), bounds);
    run(quiet, 1.5);
    for (const f of quiet.leaders.get("a")!.followers.values()) expect(f.labelAlpha).toBeGreaterThan(0.9);

    const busy = createScene(seeded());
    const people = Math.ceil(FOLLOWER_CHIP_LIMIT / 3) + 2;
    applySnapshot(busy, snap(Array.from({ length: people }, (_, i) => user(`u${i}`, { profiles: profiles(2) }))), bounds);
    busy.focus = "u1";
    run(busy, 1.5);
    for (const f of busy.leaders.get("u0")!.followers.values()) expect(f.labelAlpha).toBeLessThan(0.1);
    for (const f of busy.leaders.get("u1")!.followers.values()) expect(f.labelAlpha).toBeGreaterThan(0.9);
    for (const l of busy.leaders.values()) expect(l.labelAlpha).toBeGreaterThan(0.9);
  });
});

describe("swimming", () => {
  it("pushes different people apart", () => {
    const scene = createScene(seeded(2));
    applySnapshot(scene, snap([user("a"), user("b")]), bounds);
    const a = scene.leaders.get("a")!;
    const b = scene.leaders.get("b")!;
    b.x = a.x + 1;
    b.y = a.y;
    run(scene, 2);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan((a.size + b.size) * 0.4);
  });

  it("turns with a flip through edge-on instead of mirroring instantly", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a", { metrics: { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 1e6, active_now: false } })]), bounds);
    const a = scene.leaders.get("a")!;
    Object.assign(a, { x: bounds.width / 2, face: 1, faceTarget: 1, heading: Math.PI, turnRate: 0, vx: -80, vy: 0 });
    stepScene(scene, 1 / 60, bounds);
    expect(a.face).toBeLessThan(1);
    expect(a.face).toBeGreaterThan(-1);
    run(scene, FLIP_SECONDS + 0.05);
    expect(a.face).toBe(-1);

    const reduced = createScene(seeded());
    applySnapshot(reduced, snap([user("a")]), bounds);
    const r = reduced.leaders.get("a")!;
    Object.assign(r, { x: bounds.width / 2, face: 1, faceTarget: 1, heading: Math.PI, turnRate: 0, vx: -80, vy: 0 });
    stepScene(reduced, 1 / 60, bounds, { reducedMotion: true });
    expect(r.face).toBe(-1);
  });
});

describe("layoutLabels", () => {
  function overlaps(a: { x: number; y: number }, b: { x: number; y: number }, w: [number, number], h: [number, number]): boolean {
    return Math.abs(a.x - b.x) < (w[0] + w[1]) / 2 && a.y < b.y + h[1] && a.y + h[0] > b.y;
  }

  it("keeps a lone label where it wants to be", () => {
    expect(layoutLabels([{ x: 300, y: 200, w: 60, h: 18 }], 1200, 800)).toEqual([{ x: 300, y: 200 }]);
  });

  it("separates colliding labels and keeps them inside the tank", () => {
    const rng = seeded(9);
    const boxes: LabelBox[] = Array.from({ length: 80 }, (_, i) => ({
      x: 100 + rng() * 400,
      y: 100 + rng() * 300,
      w: 40 + rng() * 80,
      h: i % 3 === 0 ? 15 : 18,
      rank: i % 3 === 0 ? 1 : 0,
    }));
    const out = layoutLabels(boxes, 1200, 800);
    out.forEach((p, i) => {
      expect(p.x - boxes[i].w / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + boxes[i].w / 2).toBeLessThanOrEqual(1200);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y + boxes[i].h).toBeLessThanOrEqual(800);
      for (let j = 0; j < i; j++) expect(overlaps(p, out[j], [boxes[i].w, boxes[j].w], [boxes[i].h, boxes[j].h])).toBe(false);
    });
  });

  it("clamps labels at the edges", () => {
    const [p] = layoutLabels([{ x: -50, y: 900, w: 80, h: 18 }], 400, 300);
    expect(p.x).toBeGreaterThanOrEqual(40);
    expect(p.y + 18).toBeLessThanOrEqual(300);
  });
});

describe("hitTest / locate", () => {
  it("finds the leader or the follower under the pointer", () => {
    const scene = createScene(seeded());
    applySnapshot(scene, snap([user("a", { profiles: [{ name: "default", display_name: "Default" }] })]), bounds);
    run(scene, 1);
    const a = scene.leaders.get("a")!;
    expect(hitTest(scene, a.x, a.y)).toEqual({ userId: "a" });
    const f = a.followers.get("default")!;
    f.x = a.x + 300;
    f.y = a.y;
    expect(hitTest(scene, f.x, f.y)).toEqual({ userId: "a", profile: "default" });
    expect(locate(scene, { userId: "a", profile: "default" })).toBe(f);
    expect(hitTest(scene, a.x, a.y + a.size + 200)).toBeNull();
    expect(locate(scene, { userId: "zz" })).toBeNull();
  });
});
