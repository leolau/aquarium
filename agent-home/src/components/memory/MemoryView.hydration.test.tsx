// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/memory/MemoryMap", () => ({
  MemoryMap: () => null,
}));

import { MemoryView, relativeTime } from "@/components/memory/MemoryView";
import type { MemoryRowsResponse, MemorySummary } from "@/types";

const SUMMARY: MemorySummary = {
  space: { column_dim: 1024, rows_by_model: {}, configured_model: "m", healthy: true },
  totals: { memories: 1, documents: 0, chunks: 0 },
  by_owner: {},
  by_topic: {},
  by_kind: {},
  growth: [],
  recall_use: { never_used: 0, used_7d: 1, top: [] },
};

const SERVER_NOW = Date.parse("2026-11-01T07:00:30Z");
const LAST_USED = "2026-11-01T06:55:00Z";

const ROWS: MemoryRowsResponse = {
  rows: [
    {
      id: "m1",
      owner_user_id: "ada",
      visibility: "private:ada",
      kind: "fact",
      topic: "work",
      text: "Hermes runs on port 9119",
      truncated: false,
      created_at: "2026-08-01T00:00:00Z",
      uses: 3,
      last_used: LAST_USED,
      elevated: false,
      provenance: "",
      score: null,
      source_session: null,
    },
  ],
  total: 1,
  limit: 25,
  offset: 0,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  it.each([
    ["2026-11-01T11:59:40Z", "just now"],
    ["2026-11-01T11:55:00Z", "5m ago"],
    ["2026-11-01T09:00:00Z", "3h ago"],
    ["2026-10-29T12:00:00Z", "3d ago"],
  ])("%s → %s", (iso, label) => {
    expect(relativeTime(iso, now)).toBe(label);
  });
});

describe("MemoryView hydration", () => {
  it("renders no clock-dependent text on the server", () => {
    vi.useFakeTimers({ now: SERVER_NOW, toFake: ["Date"] });
    const html = renderToString(
      <MemoryView summary={SUMMARY} initialRows={ROWS} />,
    );
    expect(html).toContain(`dateTime="${LAST_USED}"`);
    expect(html).toContain("2026-11-01");
    expect(html).not.toMatch(/\d+m ago|just now/);
  });

  it("hydrates without a mismatch when a minute ticks between server and client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    vi.useFakeTimers({ now: SERVER_NOW, toFake: ["Date"] });
    const container = document.createElement("div");
    container.innerHTML = renderToString(
      <MemoryView summary={SUMMARY} initialRows={ROWS} />,
    );
    document.body.appendChild(container);

    // The server said "5m ago" at 07:00:30; the browser hydrates at 07:01:10.
    vi.setSystemTime(SERVER_NOW + 40_000);
    const errors: unknown[] = [];
    await act(async () => {
      hydrateRoot(container, <MemoryView summary={SUMMARY} initialRows={ROWS} />, {
        onRecoverableError: (err) => errors.push(err),
      });
    });
    expect(errors).toEqual([]);
    expect(container.querySelector("time")?.textContent).toBe("6m ago");
  });
});
