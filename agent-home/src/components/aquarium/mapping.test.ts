import { describe, expect, it } from "vitest";

import { CREATURE_IDS, type AquariumMetrics } from "@/lib/aquarium/creatures";

import {
  FOLLOWER_SIZE_MAX,
  FOLLOWER_SIZE_MIN,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_SCORE_FLOOR,
  SPEED_MAX,
  SPEED_MIN,
  busiestScore,
  creatureSize,
  lightestScore,
  creatureSpeed,
  followerCreature,
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

  it("is relative to the busiest person: they are the biggest, and 120x the tokens is obviously bigger", () => {
    const light = metrics({ tokens_in: 10_000 });
    const heavy = metrics({ tokens_in: 1_200_000 });
    const busiest = busiestScore([light, heavy]);
    const lightest = lightestScore([light, heavy]);
    expect(creatureSize(heavy, busiest, lightest)).toBe(SIZE_MAX);
    expect(creatureSize(heavy, busiest, lightest) / creatureSize(light, busiest, lightest)).toBeGreaterThan(1.8);
    expect(creatureSize(metrics(), busiest, lightest)).toBe(SIZE_MIN);
  });

  it("spreads a box of very different people across the whole range, in usage order", () => {
    const box = [
      metrics({ chats: 900, projects: 40, tokens_in: 80_000_000 }),
      metrics({ chats: 500, projects: 20, tokens_in: 25_000_000 }),
      metrics({ chats: 150, projects: 6, tokens_in: 2_600_000 }),
      metrics({ chats: 60, projects: 3, tokens_in: 500_000 }),
      metrics({ chats: 4, tokens_in: 3_900 }),
      metrics({ chats: 1, tokens_in: 280 }),
    ];
    const ms = [...box];
    const sizes = box.map((m) => creatureSize(m, busiestScore(ms), lightestScore(ms)));
    expect(sizes[0]).toBe(SIZE_MAX);
    expect(sizes[sizes.length - 1]).toBe(SIZE_MIN);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    // The second-busiest person is still obviously big, and the middle of the box is not squashed to the minimum.
    expect(sizes[1]).toBeGreaterThan(SIZE_MAX * 0.75);
    expect(sizes[3]).toBeGreaterThan(SIZE_MIN * 2.5);
  });

  it("keeps near-equal people near-equal in size", () => {
    const a = metrics({ chats: 100, tokens_in: 1_000_000 });
    const b = metrics({ chats: 95, tokens_in: 900_000 });
    const sizes = [a, b].map((m) => creatureSize(m, busiestScore([a, b]), lightestScore([a, b])));
    expect(sizes[1] / sizes[0]).toBeGreaterThan(0.85);
  });

  it("puts the lightest active person at the bottom and ignores people with no usage", () => {
    const none = metrics();
    const light = metrics({ tokens_in: 99 });
    expect(lightestScore([none, light])).toBeCloseTo(2);
    expect(lightestScore([none])).toBe(0);
  });

  it("is monotonic and bounded for any busiest reference, and shrinks as the reference grows", () => {
    for (const busiest of [0, SIZE_SCORE_FLOOR, 6, 9, 15, Number.NaN]) {
      let prev = -Infinity;
      for (const n of LADDER) {
        const size = creatureSize(metrics({ tokens_in: n }), busiest);
        expect(size).toBeGreaterThanOrEqual(prev);
        expect(size).toBeGreaterThanOrEqual(SIZE_MIN);
        expect(size).toBeLessThanOrEqual(SIZE_MAX);
        prev = size;
      }
    }
    const m = metrics({ tokens_in: 50_000 });
    expect(creatureSize(m, 9)).toBeLessThanOrEqual(creatureSize(m, 6));
  });

  it("never lets a box of light users grow past the floor reference", () => {
    const tiny = metrics({ tokens_in: 9 });
    expect(busiestScore([tiny])).toBe(SIZE_SCORE_FLOOR);
    expect(creatureSize(tiny, busiestScore([tiny]))).toBeLessThan(SIZE_MAX / 2);
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

  it("slows big creatures a little but keeps them inside the bounds", () => {
    let prev = Infinity;
    for (let size = SIZE_MIN; size <= SIZE_MAX; size += 8) {
      const v = creatureSpeed({ tokens_24h: 1e6 }, size);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(SPEED_MIN);
      prev = v;
    }
    expect(creatureSpeed({ tokens_24h: 1e6 }, SIZE_MAX)).toBeGreaterThan(creatureSpeed({ tokens_24h: 1e6 }, SIZE_MIN) * 0.6);
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

  it("is 35-45 % of a normal leader, with a minimum", () => {
    for (const seed of [0, 0.5, 1]) {
      const f = followerSize(120, seed);
      expect(f / 120).toBeGreaterThanOrEqual(0.35);
      expect(f / 120).toBeLessThanOrEqual(0.45);
    }
    expect(followerSize(SIZE_MIN, 0)).toBe(FOLLOWER_SIZE_MIN);
  });
});

describe("followerCreature", () => {
  it("is deterministic per person + profile, varies per person, and avoids the leader's creature", () => {
    expect(followerCreature("u1", "default")).toBe(followerCreature("u1", "default"));
    const looks = new Set(Array.from({ length: 80 }, (_, i) => followerCreature(`user-${i}`, "default")));
    expect(looks.size).toBeGreaterThanOrEqual(20);
    for (let i = 0; i < 200; i++) {
      const leader = CREATURE_IDS[i % CREATURE_IDS.length];
      const f = followerCreature(`user-${i}`, `p${i % 7}`, leader);
      expect(CREATURE_IDS).toContain(f);
      expect(f).not.toBe(leader);
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
