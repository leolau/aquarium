import { describe, expect, it } from "vitest";

import { HEALTH_THRESHOLDS, healthVerdict } from "./health";
import { MOCK_SUMMARY } from "./mockData";

describe("healthVerdict", () => {
  it("is ok when every reading is under its threshold and the read is fresh", () => {
    expect(healthVerdict({ summary: MOCK_SUMMARY, stale: false, buildMismatch: false })).toEqual({
      verdict: "ok",
      reasons: [],
    });
  });

  it("degrades at each threshold and says why", () => {
    for (const key of ["cpu", "mem", "disk"] as const) {
      const summary = { ...MOCK_SUMMARY, [`${key}_pct`]: HEALTH_THRESHOLDS[key] };
      const r = healthVerdict({ summary, stale: false, buildMismatch: false });
      expect(r.verdict).toBe("degraded");
      expect(r.reasons).toHaveLength(1);
    }
  });

  it("degrades on low upload storage, a build mismatch, or stale readings", () => {
    const low = { ...MOCK_SUMMARY, upload_storage: { ...MOCK_SUMMARY.upload_storage!, low: true } };
    expect(healthVerdict({ summary: low, stale: false, buildMismatch: false }).verdict).toBe("degraded");
    expect(healthVerdict({ summary: MOCK_SUMMARY, stale: false, buildMismatch: true }).verdict).toBe("degraded");
    expect(healthVerdict({ summary: MOCK_SUMMARY, stale: true, buildMismatch: false }).verdict).toBe("degraded");
  });

  it("is unknown before the first read and down when that read fails", () => {
    expect(healthVerdict({ summary: null, stale: false, buildMismatch: false }).verdict).toBe("unknown");
    expect(healthVerdict({ summary: null, stale: true, buildMismatch: false }).verdict).toBe("down");
  });
});
