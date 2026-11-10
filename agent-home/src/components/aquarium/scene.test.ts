import { describe, expect, it } from "vitest";

import type { AquariumSnapshot, AquariumUser } from "@/lib/aquarium/creatures";

import { creatureSize, creatureSpeed, followerSize } from "./mapping";
import {
  FADE_SECONDS,
  applySnapshot,
  createScene,
  easeToward,
  hitTest,
  locate,
  sceneBounds,
  stepScene,
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
    const target = creatureSize(busy.metrics);
    expect(a.targetSize).toBe(target);
    expect(a.targetSpeed).toBe(creatureSpeed(busy.metrics));
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
        expect(f.size).toBeCloseTo(followerSize(l.size), 0);
        expect(Math.hypot(f.x - l.x, f.y - l.y)).toBeLessThan(l.size + f.size * 4 + 60);
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
