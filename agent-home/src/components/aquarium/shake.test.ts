import { describe, expect, it } from "vitest";

import { SHAKE_THRESHOLD, createShakeDetector } from "./shake";

describe("createShakeDetector", () => {
  const jolt = (i: number, t: number) => ({ x: i % 2 ? SHAKE_THRESHOLD : -SHAKE_THRESHOLD / 2, y: 0, z: 9.8, t });

  it("reports a shake after three sharp jolts inside a second", () => {
    const feed = createShakeDetector();
    const hits = [0, 100, 200, 300].map((t, i) => feed(jolt(i, t)));
    expect(hits).toEqual([false, false, false, true]);
  });

  it("ignores gentle tilting and jolts spread too far apart", () => {
    const tilt = createShakeDetector();
    for (let i = 0; i < 50; i++) expect(tilt({ x: Math.sin(i / 5) * 3, y: 0, z: 9.8, t: i * 50 })).toBe(false);
    const slow = createShakeDetector();
    const hits = [0, 700, 1400, 2100, 2800].map((t, i) => slow(jolt(i, t)));
    expect(hits.some(Boolean)).toBe(false);
  });

  it("starts counting again after a shake", () => {
    const feed = createShakeDetector();
    [0, 50, 100, 150].forEach((t, i) => feed(jolt(i, t)));
    expect(feed(jolt(4, 200))).toBe(false);
  });
});
