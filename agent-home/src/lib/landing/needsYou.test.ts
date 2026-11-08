// @vitest-environment jsdom
/**
 * `useNeedsYou()` contract: polls only while visible, refetches on focus
 * and on the service worker's refresh message, keeps the last good data on
 * failure, tracks unacknowledged ids, and mirrors the count into the tab
 * title and app badge.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NeedsYouEntry, NeedsYouResponse } from "@/types/landing";

import {
  NEEDS_YOU_POLL_MS,
  NEEDS_YOU_SEEN_KEY,
  titleWithCount,
  useNeedsYou,
} from "./needsYou";

const needsYou = vi.fn<() => Promise<NeedsYouResponse | null>>();

vi.mock("./api", () => ({
  landingApi: { needsYou: () => needsYou() },
}));

function item(id: string): NeedsYouEntry {
  return {
    id,
    source: "card_wait",
    severity: "blocking",
    title: id,
    context: {},
    created_at: 1,
    href: `/x/${id}`,
    actions: [],
  };
}

function resp(...ids: string[]): NeedsYouResponse {
  return {
    items: ids.map(item),
    count: ids.length,
    by_severity: { blocking: ids.length, approval: 0, review: 0, fyi: 0 },
    collected_at: 1,
  };
}

let visibility: DocumentVisibilityState = "visible";
const setAppBadge = vi.fn(() => Promise.resolve());
const clearAppBadge = vi.fn(() => Promise.resolve());

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  needsYou.mockReset();
  setAppBadge.mockClear();
  clearAppBadge.mockClear();
  window.localStorage.clear();
  document.title = "Aquarium";
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  Object.assign(navigator, { setAppBadge, clearAppBadge });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("titleWithCount", () => {
  it("prefixes and strips the count", () => {
    expect(titleWithCount("Aquarium", 3)).toBe("(3) Aquarium");
    expect(titleWithCount("(3) Aquarium", 5)).toBe("(5) Aquarium");
    expect(titleWithCount("(3) Aquarium", 0)).toBe("Aquarium");
    expect(titleWithCount("", 1)).toBe("(1) Aquarium");
  });
});

describe("useNeedsYou", () => {
  it("loads, then mirrors the count into the title and badge", async () => {
    needsYou.mockResolvedValue(resp("a", "b"));
    const { result } = renderHook(() => useNeedsYou());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(document.title).toBe("(2) Aquarium");
    expect(setAppBadge).toHaveBeenLastCalledWith(2);
  });

  it("clears the badge and title at zero", async () => {
    needsYou.mockResolvedValue(resp());
    document.title = "(4) Aquarium";
    renderHook(() => useNeedsYou());
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());
    expect(document.title).toBe("Aquarium");
  });

  it("polls every 15s only while the tab is visible", async () => {
    needsYou.mockResolvedValue(resp("a"));
    renderHook(() => useNeedsYou());
    await waitFor(() => expect(needsYou).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_POLL_MS);
    });
    expect(needsYou).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NEEDS_YOU_POLL_MS * 2);
    });
    expect(needsYou).toHaveBeenCalledTimes(2);
  });

  it("refetches on focus and on becoming visible", async () => {
    needsYou.mockResolvedValue(resp("a"));
    renderHook(() => useNeedsYou());
    await waitFor(() => expect(needsYou).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(needsYou).toHaveBeenCalledTimes(2));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(needsYou).toHaveBeenCalledTimes(3));
  });

  it("keeps the last good data when a read fails", async () => {
    needsYou.mockResolvedValueOnce(resp("a")).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.count).toBe(1));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.stale).toBe(true);
    expect(result.current.items.map((i) => i.id)).toEqual(["a"]);
    expect(document.title).toBe("(1) Aquarium");
  });

  it("flags ids that appear after the first load until marked seen", async () => {
    needsYou.mockResolvedValueOnce(resp("a")).mockResolvedValueOnce(resp("a", "b"));
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.count).toBe(1));
    // First load on this device seeds silently.
    expect(result.current.newIds).toEqual([]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.newIds).toEqual(["b"]);
    act(() => result.current.markSeen());
    expect(result.current.newIds).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(NEEDS_YOU_SEEN_KEY) ?? "[]")).toEqual(["a", "b"]);
  });

  it("remembers what was seen across mounts", async () => {
    window.localStorage.setItem(NEEDS_YOU_SEEN_KEY, JSON.stringify(["a"]));
    needsYou.mockResolvedValue(resp("a", "c"));
    const { result } = renderHook(() => useNeedsYou());
    await waitFor(() => expect(result.current.newIds).toEqual(["c"]));
  });
});
