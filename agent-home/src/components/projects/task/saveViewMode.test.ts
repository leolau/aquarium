import { describe, expect, it, vi } from "vitest";

import { createViewModeSaver } from "./saveViewMode";

function deferredFetch() {
  const calls: { body: string; resolve: () => void }[] = [];
  const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ body: String(init?.body), resolve: () => resolve(new Response(null, { status: 204 })) });
    }),
  ) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createViewModeSaver", () => {
  it("keeps one PUT in flight and coalesces rapid taps into one save of the latest mode", async () => {
    const { calls, fetchImpl } = deferredFetch();
    const save = createViewModeSaver(fetchImpl);
    const first = save("phone", "task");
    void save("phone", "project");
    void save("phone", "task");
    void save("phone", "project");
    expect(calls).toHaveLength(1);

    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body)).toEqual({ device: "phone", mode: "project" });

    calls[1].resolve();
    await first;
    expect(calls).toHaveLength(2);
  });

  it("never rejects when the request fails", async () => {
    const save = createViewModeSaver((() => Promise.reject(new Error("offline"))) as unknown as typeof fetch);
    await expect(save("desktop", "task")).resolves.toBeUndefined();
  });
});
