// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { landingApi } from "@/lib/landing/api";
import type { NeedsYouResponse } from "@/types/landing";

import { MOCK_NEEDS_YOU, mockEntry } from "./mockData";
import { NEEDS_YOU_POLL_MS, resetNeedsYouCache, sortNeedsYou, useNeedsYou } from "./useNeedsYou";

afterEach(() => {
  cleanup();
  resetNeedsYouCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function response(items = MOCK_NEEDS_YOU): NeedsYouResponse {
  return {
    items,
    count: items.length,
    by_severity: {
      blocking: items.filter((i) => i.severity === "blocking").length,
      approval: items.filter((i) => i.severity === "approval").length,
      review: items.filter((i) => i.severity === "review").length,
      fyi: items.filter((i) => i.severity === "fyi").length,
    },
    collected_at: 1,
  };
}

describe("sortNeedsYou", () => {
  it("orders by severity, then oldest first", () => {
    const items = [
      mockEntry({ id: "fyi", severity: "fyi", created_at: 1 }),
      mockEntry({ id: "new-block", severity: "blocking", created_at: 20 }),
      mockEntry({ id: "review", severity: "review", created_at: 2 }),
      mockEntry({ id: "old-block", severity: "blocking", created_at: 10 }),
    ];
    expect(sortNeedsYou(items).map((i) => i.id)).toEqual(["old-block", "new-block", "review", "fyi"]);
  });
});

describe("useNeedsYou", () => {
  it("reads the feed, most urgent first, with counts", async () => {
    const spy = vi.spyOn(landingApi, "needsYou").mockResolvedValue(response([...MOCK_NEEDS_YOU].reverse()));
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(spy).toHaveBeenCalledWith({ countOnly: false });
    expect(result.current.items[0].severity).toBe("blocking");
    expect(result.current.blocking).toBe(1);
    expect(result.current.stale).toBe(false);
  });

  it("passes countOnly through for the badge-only read", async () => {
    const spy = vi.spyOn(landingApi, "needsYou").mockResolvedValue({ ...response(), items: [] });
    const { result } = renderHook(() => useNeedsYou({ countOnly: true }));
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(spy).toHaveBeenCalledWith({ countOnly: true });
  });

  it("keeps the last good data and flags stale when a read fails (404/502)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const spy = vi.spyOn(landingApi, "needsYou").mockResolvedValueOnce(response()).mockResolvedValue(null);
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.count).toBe(3));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_POLL_MS);
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result.current.count).toBe(3);
  });

  it("is unknown (null) when the route is missing from the start", async () => {
    vi.spyOn(landingApi, "needsYou").mockResolvedValue(null);
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.count).toBeNull();
    expect(result.current.items).toEqual([]);
  });

  it("re-reads on focus", async () => {
    const spy = vi.spyOn(landingApi, "needsYou").mockResolvedValue(response());
    renderHook(() => useNeedsYou());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
