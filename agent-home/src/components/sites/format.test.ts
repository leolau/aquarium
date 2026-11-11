import { describe, expect, it } from "vitest";

import {
  cronToPreset,
  designEntities,
  entityChange,
  nextCronRun,
  pickDesigns,
  presetToCron,
  type SchedulePreset,
} from "@/components/sites/format";
import type { SiteDesign } from "@/types/sites";

const HKT = -480; // getTimezoneOffset() in Hong Kong (UTC+8)

function design(version: number, status: string, entities: unknown[]): SiteDesign {
  return {
    version,
    status,
    design: { entities },
    proposed_by: "u1",
    proposed_at: null,
    approved_by: null,
    approved_at: null,
  };
}

describe("schedule presets", () => {
  it.each<SchedulePreset>([
    { kind: "hours", every: 6 },
    { kind: "daily", time: "06:30" },
    { kind: "daily", time: "02:00" },
    { kind: "weekly", day: 1, time: "06:00" },
    { kind: "weekly", day: 0, time: "03:15" },
  ])("round-trips %o through the stored UTC cron", (preset) => {
    for (const offset of [0, HKT, 300]) {
      expect(cronToPreset(presetToCron(preset, offset), offset)).toEqual(preset);
    }
  });

  it("converts local wall time to UTC, wrapping the day", () => {
    expect(presetToCron({ kind: "daily", time: "06:00" }, HKT)).toBe("0 22 * * *");
    // Monday 06:00 in HK is Sunday 22:00 UTC.
    expect(presetToCron({ kind: "weekly", day: 1, time: "06:00" }, HKT)).toBe("0 22 * * 0");
  });

  it("treats off as no cron and anything unusual as custom", () => {
    expect(presetToCron({ kind: "off" }, 0)).toBeNull();
    expect(cronToPreset(null, 0)).toEqual({ kind: "off" });
    expect(cronToPreset("*/15 8-18 * * 1-5", 0)).toEqual({ kind: "custom", cron: "*/15 8-18 * * 1-5" });
  });
});

describe("nextCronRun", () => {
  const from = new Date("2026-11-11T05:52:30Z"); // a Wednesday

  it("finds the next UTC firing", () => {
    expect(nextCronRun("0 22 * * *", from)?.toISOString()).toBe("2026-11-11T22:00:00.000Z");
    expect(nextCronRun("0 */6 * * *", from)?.toISOString()).toBe("2026-11-11T06:00:00.000Z");
    expect(nextCronRun("30 1 * * 0", from)?.toISOString()).toBe("2026-11-15T01:30:00.000Z");
    expect(nextCronRun("0 9 1 * *", from)?.toISOString()).toBe("2026-12-01T09:00:00.000Z");
  });

  it("returns null for what it can't read", () => {
    expect(nextCronRun("0 9 * * MON", from)).toBeNull();
    expect(nextCronRun("", from)).toBeNull();
    expect(nextCronRun("0 9 * *", from)).toBeNull();
  });
});

describe("designs", () => {
  const approved = design(2, "approved", [
    { name: "skus", kind: "fixed", key: ["sku"], columns: [{ name: "sku", type: "text" }], refresh: { mode: "full" } },
  ]);
  const proposed = design(3, "proposed", [
    {
      name: "skus",
      kind: "fixed",
      key: ["sku"],
      columns: [{ name: "sku", type: "text" }, { name: "weight_kg", type: "numeric" }],
      refresh: { mode: "full" },
    },
    { name: "rma_cases", kind: "variable", key: "rma_no", columns: [], refresh: {}, question: "Keep closed RMAs?" },
  ]);

  it("picks the design in force and the newer proposal", () => {
    const old = design(1, "superseded", []);
    expect(pickDesigns([old, proposed, approved])).toEqual({ approved, proposed });
    expect(pickDesigns([approved]).proposed).toBeNull();
    expect(pickDesigns([design(1, "proposed", []), approved]).proposed).toBeNull();
  });

  it("normalises entities and reports additive changes", () => {
    const [skus, rma] = designEntities(proposed);
    expect(rma).toMatchObject({ key: ["rma_no"], kind: "variable", question: "Keep closed RMAs?" });
    const before = designEntities(approved);
    expect(entityChange(skus, before)).toEqual({ kind: "columns", added: ["weight_kg"] });
    expect(entityChange(rma, before)).toEqual({ kind: "new" });
    expect(entityChange(before[0], before)).toEqual({ kind: "same" });
  });

  it("tolerates a malformed design", () => {
    expect(designEntities({ ...approved, design: { entities: "nope" } })).toEqual([]);
    expect(designEntities(null)).toEqual([]);
  });
});
