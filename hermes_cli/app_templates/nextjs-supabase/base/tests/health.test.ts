import { describe, expect, it } from "vitest";
import { healthReport } from "@/lib/health";
import type { Queryable } from "@/lib/db";

const ok: Queryable = {
  query: async (text) =>
    text.includes("to_regclass") ? { rows: [{ present: true }] } : text.includes("max(version)") ? { rows: [{ version: "20260101000000" }] } : { rows: [{ "?column?": 1 }] },
};

describe("healthReport", () => {
  it("reports no database when none is configured, and stays healthy", async () => {
    const report = await healthReport(null);
    expect(report.db).toBe("none");
    expect(report.ok).toBe(true);
    expect(report.migration).toBeNull();
  });

  it("reports the latest applied migration when the database answers", async () => {
    const report = await healthReport(ok);
    expect(report).toMatchObject({ ok: true, db: "ok", migration: "20260101000000" });
  });

  it("marks the app unhealthy when the database fails or hangs", async () => {
    const failing: Queryable = { query: async () => Promise.reject(new Error("password=hunter2")) };
    const hanging: Queryable = { query: () => new Promise(() => undefined) };
    for (const database of [failing, hanging]) {
      const report = await healthReport(database, { timeoutMs: 50 });
      expect(report.ok).toBe(false);
      expect(report.db).toBe("error");
      expect(JSON.stringify(report)).not.toContain("hunter2");
    }
  });

  it("never echoes secrets from the environment", async () => {
    const env = { APP_MODE: "prod", APP_MCP_TOKEN: "tok-123", DATABASE_URL: "postgres://u:pw-456@h/db" };
    const text = JSON.stringify(await healthReport(null, { env }));
    expect(text).not.toContain("tok-123");
    expect(text).not.toContain("pw-456");
    expect(JSON.parse(text).mode).toBe("prod");
  });
});
