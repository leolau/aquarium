import { describe, expect, it } from "vitest";

import { CREATURE_IDS, type AquariumMetrics } from "@/lib/aquarium/creatures";

import {
  FOLLOWER_SIZE_MAX,
  FOLLOWER_SIZE_MIN,
  SIZE_MAX,
  SIZE_MIN,
  SPEED_MAX,
  SPEED_MIN,
  creatureSize,
  creatureSpeed,
  followerSize,
  formatCount,
  profileCreature,
  usageScore,
} from "./mapping";

function metrics(over: Partial<AquariumMetrics> = {}): AquariumMetrics {
  return { chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 0, active_now: false, ...over };
}

const LADDER = [0, 1, 3, 10, 50, 200, 1_000, 10_000, 1e5, 1e6, 1e7, 1e9, 1e12];

describe("creatureSize", () => {
  it("starts at the minimum for a new person", () => {
    expect(creatureSize(metrics())).toBe(SIZE_MIN);
  });

  it("grows monotonically with every usage input and stays bounded", () => {
    for (const key of ["chats", "projects", "tokens_in", "tokens_out"] as const) {
      let prev = -Infinity;
      for (const n of LADDER) {
        const size = creatureSize(metrics({ [key]: n }));
        expect(size).toBeGreaterThanOrEqual(prev);
        expect(size).toBeGreaterThanOrEqual(SIZE_MIN);
        expect(size).toBeLessThanOrEqual(SIZE_MAX);
        prev = size;
      }
    }
    expect(creatureSize(metrics({ chats: 1e9, projects: 1e9, tokens_in: 1e15, tokens_out: 1e15 }))).toBe(SIZE_MAX);
  });

  it("follows the plan's score: log10 tokens + chats/20 + projects/5", () => {
    expect(usageScore(metrics({ tokens_in: 600, tokens_out: 399, chats: 20, projects: 5 }))).toBeCloseTo(5);
    expect(creatureSize(metrics({ chats: 40 }))).toBeGreaterThan(creatureSize(metrics({ chats: 20 })));
  });

  it("treats junk numbers as zero", () => {
    expect(creatureSize(metrics({ chats: -5, tokens_in: Number.NaN, projects: Number.POSITIVE_INFINITY }))).toBe(SIZE_MIN);
  });
});

describe("creatureSpeed", () => {
  it("is monotonic in tokens_24h and bounded", () => {
    let prev = -Infinity;
    for (const n of LADDER) {
      const v = creatureSpeed({ tokens_24h: n });
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(SPEED_MIN);
      expect(v).toBeLessThanOrEqual(SPEED_MAX);
      prev = v;
    }
    expect(creatureSpeed({ tokens_24h: 0 })).toBe(SPEED_MIN);
    expect(creatureSpeed({ tokens_24h: 1e12 })).toBe(SPEED_MAX);
  });
});

describe("followerSize", () => {
  it("is smaller than its leader, monotonic and bounded", () => {
    let prev = -Infinity;
    for (let s = SIZE_MIN; s <= SIZE_MAX; s += 4) {
      const f = followerSize(s);
      expect(f).toBeLessThan(s);
      expect(f).toBeGreaterThanOrEqual(prev);
      expect(f).toBeGreaterThanOrEqual(FOLLOWER_SIZE_MIN);
      expect(f).toBeLessThanOrEqual(FOLLOWER_SIZE_MAX);
      prev = f;
    }
  });
});

describe("profileCreature", () => {
  it("is deterministic per name and always a known creature", () => {
    const names = ["default", "sales", "research", "ops", "家", "a".repeat(200)];
    for (const n of names) {
      expect(CREATURE_IDS).toContain(profileCreature(n));
      expect(profileCreature(n)).toBe(profileCreature(n));
    }
  });

  it("spreads names over many creatures", () => {
    const used = new Set(Array.from({ length: 200 }, (_, i) => profileCreature(`profile-${i}`)));
    expect(used.size).toBeGreaterThanOrEqual(15);
  });
});

describe("formatCount", () => {
  it("abbreviates", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(2_500_000)).toBe("2.5M");
    expect(formatCount(-3)).toBe("0");
  });
});
