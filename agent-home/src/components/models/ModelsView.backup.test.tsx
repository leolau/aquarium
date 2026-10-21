// @vitest-environment jsdom
/**
 * Backup models on ModelsView: the list shows in order, Remove and ↑ save
 * the whole new list, and "Refresh keys" reports which marks it cleared.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelsView } from "@/components/models/ModelsView";
import type { ModelsOverviewResponse } from "@/types";

const OVERVIEW: ModelsOverviewResponse = {
  info: {
    model: "deepseek-v4-flash",
    provider: "deepseek",
    auto_context_length: 1_048_576,
    config_context_length: 0,
    effective_context_length: 1_048_576,
    capabilities: {},
  },
  auxiliary: { main: { provider: "deepseek", model: "deepseek-v4-flash" }, tasks: [] },
  usage: [],
  fallback: [
    { provider: "alibaba", model: "qwen3.8-max" },
    { provider: "opencode-go", model: "deepseek-v4.1-flash" },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch() {
  const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/models/fallback")) return Promise.resolve(json({ ok: true, providers: JSON.parse(String(init?.body)).providers }));
    if (url.includes("/api/models/refresh-keys")) return Promise.resolve(json({ ok: true, reloaded: 0, cleared: { alibaba: 1 } }));
    if (url.includes("/api/models/overview")) return Promise.resolve(json(OVERVIEW));
    if (url.includes("/api/models/performance")) return Promise.resolve(json({ period: { days: 7, months: 6 }, models: [], monthly: [], collecting: true }));
    return Promise.resolve(json({ pinned: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function putBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([u, init]) => String(u).includes("/api/models/fallback") && (init as RequestInit)?.method === "PUT")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)).providers);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelsView backup models", () => {
  it("lists the backups in order", () => {
    stubFetch();
    const { container } = render(<ModelsView initial={OVERVIEW} />);
    const text = container.querySelector('[data-component="BackupModels"]')?.textContent ?? "";
    expect(text.indexOf("qwen3.8-max")).toBeLessThan(text.indexOf("deepseek-v4.1-flash"));
  });

  it("Remove saves the list without that entry", async () => {
    const fetchMock = stubFetch();
    const { getAllByRole } = render(<ModelsView initial={OVERVIEW} />);
    fireEvent.click(getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    expect(putBodies(fetchMock)[0]).toEqual([{ provider: "opencode-go", model: "deepseek-v4.1-flash" }]);
  });

  it("moving the second backup up swaps the order", async () => {
    const fetchMock = stubFetch();
    const { getByRole } = render(<ModelsView initial={OVERVIEW} />);
    fireEvent.click(getByRole("button", { name: "Move deepseek-v4.1-flash up" }));
    await waitFor(() => expect(putBodies(fetchMock)).toHaveLength(1));
    expect(putBodies(fetchMock)[0].map((f: { model: string }) => f.model)).toEqual([
      "deepseek-v4.1-flash",
      "qwen3.8-max",
    ]);
  });

  it("Refresh keys reports the providers it cleared", async () => {
    stubFetch();
    const { getByRole, findByText } = render(<ModelsView initial={OVERVIEW} />);
    fireEvent.click(getByRole("button", { name: "Refresh keys" }));
    await findByText(/Cleared the old "key failed" mark for alibaba/);
  });
});
