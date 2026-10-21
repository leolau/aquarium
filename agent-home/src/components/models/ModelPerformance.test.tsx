import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelPerformance } from "@/components/models/ModelPerformance";
import type { ModelsPerformanceResponse } from "@/types";

const ENTRY = {
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  caller_roles: ["main"],
  calls: 1286,
  failures: 13,
  success_rate: 0.99,
  latency_ms: { min: 700, avg: 4100, p95: 12800, max: 43200 },
  tokens: { input: 2_100_000, output: 186_000, cache_read: 900_000, reasoning: 0 },
  cost_usd: 3.42,
  daily: [
    { date: "2026-10-04", calls: 180, failures: 2, tokens: 310_000, avg_ms: 3900 },
    { date: "2026-10-05", calls: 240, failures: 0, tokens: 410_000, avg_ms: 4200 },
  ],
};

const PERF: ModelsPerformanceResponse = {
  period: { days: 7, months: 6 },
  models: [ENTRY],
  monthly: [
    { month: "2026-09", model: "claude-sonnet-4-6", calls: 900, tokens: 1_800_000, avg_ms: 4000, failures: 4 },
    { month: "2026-10", model: "claude-sonnet-4-6", calls: 1286, tokens: 2_286_000, avg_ms: 4100, failures: 13 },
    { month: "2026-10", model: "gpt-5-mini", calls: 88, tokens: 90_000, avg_ms: 1800, min_ms: 900, max_ms: 316_400, failures: 3 },
  ],
  collecting: false,
};

describe("ModelPerformance", () => {
  it("renders nothing while the lazy read is pending", () => {
    expect(renderToStaticMarkup(<ModelPerformance perf={null} />)).toBe("");
  });

  it("renders per-model stats with calls, success rate, latency, tokens, cost", () => {
    const html = renderToStaticMarkup(<ModelPerformance perf={PERF} />);
    expect(html).toContain("Performance · last 7 days");
    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("1,286");
    expect(html).toContain("99.0% ok");
    expect(html).toContain("13 failed");
    expect(html).toContain("avg 4.1s");
    expect(html).toContain("p95 12.8s");
    expect(html).toContain("min 700ms");
    expect(html).toContain("max 43.2s");
    expect(html).toContain("2.1M in");
    expect(html).toContain("186.0K out");
    expect(html).toContain("$3.42");
    expect(html).toContain("main"); // caller role pill
    expect(html).toContain('data-component="PerfDailyBars"');
  });

  it("names the provider's own label, tags backup calls and says why calls failed", () => {
    const html = renderToStaticMarkup(
      <ModelPerformance
        perf={{
          ...PERF,
          models: [
            { ...ENTRY, model: "deepseek-v4-flash", provider: "deepseek", served_as: ["deepseek-flash"] },
            {
              ...ENTRY,
              model: "qwen3.8-max",
              provider: "alibaba",
              caller_roles: ["backup"],
              failures: 12,
              failure_reasons: [{ status_code: 403, error_type: "PermissionDeniedError", count: 12 }],
            },
          ],
        }}
      />,
    );
    expect(html).toContain("replies name it deepseek-flash");
    expect(html).toContain("backup");
    expect(html).toContain("12 failed: access denied (403)");
  });

  it("shows the collecting note when the ledger is still empty", () => {
    const html = renderToStaticMarkup(
      <ModelPerformance perf={{ ...PERF, models: [], collecting: true }} />,
    );
    expect(html).toContain("Collecting");
    // History still renders from the sessions backfill.
    expect(html).toContain('data-component="ModelPerfHistory"');
  });

  it("renders the monthly history chart with a metric toggle and legend", () => {
    const html = renderToStaticMarkup(<ModelPerformance perf={PERF} />);
    expect(html).toContain("History · past 2 months");
    expect(html).toContain("tokens");
    expect(html).toContain("calls");
    expect(html).toContain("gpt-5-mini"); // legend
    expect(html).toContain("Sep");
    expect(html).toContain("Oct");
  });

  it("warns on failures and hides the section without any history", () => {
    const html = renderToStaticMarkup(
      <ModelPerformance perf={{ ...PERF, monthly: [] }} />,
    );
    expect(html).toContain("ModelPerfCard");
    expect(html).not.toContain("ModelPerfHistory");
  });

  it("offers failed and response-time history and a monthly table", () => {
    const html = renderToStaticMarkup(<ModelPerformance perf={PERF} />);
    expect(html).toContain(">failed<");
    expect(html).toContain(">response time<");
    expect(html).toContain('data-component="ModelPerfMonthly"');
    // gpt-5-mini Oct row: calls, failures, min/avg/max.
    expect(html).toMatch(/gpt-5-mini<\/td>.*?88<\/td>.*?3<\/td>.*?900ms<\/td>.*?1\.8s<\/td>.*?5m 16s<\/td>/);
  });
});
