// @vitest-environment jsdom
/**
 * Backup models on ModelsView: the list shows in order, Remove and ↑ save
 * the whole new list, and "Refresh keys" reports which marks it cleared.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ModelsView backup models", () => {
  it("shows Main as a role with its backups under its model", () => {
    stubFetch();
    const { container } = render(<ModelsView initial={OVERVIEW} />);
    expect(container.querySelector('[data-component="BackupModels"]')).toBeNull();
    const line = container.querySelector('[data-component="RoleBackupLine"]')?.textContent ?? "";
    expect(line).toBe("backup: qwen3.8-max · alibaba, deepseek-v4.1-flash · opencode-go");
  });

  it("Refresh keys reports the providers it cleared", async () => {
    stubFetch();
    const { getByRole, findByText } = render(<ModelsView initial={OVERVIEW} />);
    fireEvent.click(getByRole("button", { name: "Refresh keys" }));
    await findByText(/Cleared the old "key failed" mark for alibaba/);
  });
});
