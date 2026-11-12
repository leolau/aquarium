// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActivityItem, ScheduledSummary } from "@/types";

import { fmtElapsed, resetActivityRunningCache, useActivityRunning } from "./useActivityRunning";

afterEach(() => {
  cleanup();
  resetActivityRunningCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = 1_700_000_000_000;
const SCHEDULED: ScheduledSummary = { total: 3, projects: 1, cards: 2, cron_jobs: 0, next_run_at: null };

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    kind: "chat",
    id: "s1",
    name: "Plan the launch",
    started_at: NOW / 1000 - 75,
    href: "/chat?session=s1",
    profile: null,
    status: "running",
    ...over,
  };
}

function mockFeed(body: unknown | null) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("err", { status: 502 }),
  );
}

describe("fmtElapsed", () => {
  it("formats compactly by magnitude", () => {
    expect(fmtElapsed(42_000)).toBe("42s");
    expect(fmtElapsed(12 * 60_000)).toBe("12m");
    expect(fmtElapsed(65 * 60_000)).toBe("1h 05m");
    expect(fmtElapsed(51 * 3_600_000)).toBe("2d 3h");
    expect(fmtElapsed(-5)).toBe("0s");
  });
});

describe("useActivityRunning", () => {
  it("keeps the scheduled summary from the payload and reports loaded", async () => {
    mockFeed({ items: [item()], scheduled: SCHEDULED });
    const { result } = renderHook(() => useActivityRunning());
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.scheduled).toEqual(SCHEDULED);
  });

  it("treats a missing or null scheduled leg as null (older BFF, failed leg)", async () => {
    mockFeed({ items: [item()] });
    const { result } = renderHook(() => useActivityRunning());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.scheduled).toBeNull();
  });

  it("keeps the last good rows and summary, flagged stale, when a read fails", async () => {
    const fetchSpy = mockFeed({ items: [item()], scheduled: SCHEDULED });
    const { result } = renderHook(() => useActivityRunning());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    fetchSpy.mockImplementation(async () => new Response("err", { status: 502 }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.scheduled).toEqual(SCHEDULED);
  });

  it("ticks the clock locally without refetching", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    const fetchSpy = mockFeed({ items: [item()] });
    const { result } = renderHook(() => useActivityRunning());
    // RTL's waitFor polls on the faked setInterval; vi.waitFor drives fake timers itself.
    await vi.waitFor(() => expect(result.current.items).toHaveLength(1));
    const before = result.current.now;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.now - before).toBeGreaterThanOrEqual(59_000);
    // 60s elapsed → four 15s polls, but the clock itself never fetched.
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("shares one in-flight read between focus wakes", async () => {
    let release: (r: Response) => void = () => {};
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => new Promise<Response>((r) => (release = r)));
    renderHook(() => useActivityRunning());
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(fetchSpy).toHaveBeenCalledOnce();
    await act(async () => {
      release(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    });
  });

  it("reuses a fresh read across remounts instead of refetching", async () => {
    const fetchSpy = mockFeed({ items: [item()], scheduled: SCHEDULED });
    const first = renderHook(() => useActivityRunning());
    await waitFor(() => expect(first.result.current.loaded).toBe(true));
    first.unmount();
    const second = renderHook(() => useActivityRunning());
    expect(second.result.current.items).toHaveLength(1);
    expect(second.result.current.scheduled).toEqual(SCHEDULED);
    expect(second.result.current.loaded).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

const expired = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("@/lib/replace-location", () => ({
  replaceLocation: (href: string) => expired.replace(href),
}));

describe("useActivityRunning on an expired login", () => {
  afterEach(async () => {
    const { resetExpiredSession } = await import("@/lib/auth/expired-session");
    resetExpiredSession();
    expired.replace.mockReset();
  });

  it("a 401 clears the session and goes to /login", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("{}", { status: 401 }));

    const { result } = renderHook(() => useActivityRunning());

    await waitFor(() => expect(expired.replace).toHaveBeenCalledWith("/login"));
    expect(fetchSpy).toHaveBeenCalledWith("/api/session/logout", { method: "POST" });
    expect(result.current.stale).toBe(true);
  });

  it("a 502 only marks the rows stale", async () => {
    mockFeed(null);

    const { result } = renderHook(() => useActivityRunning());

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(expired.replace).not.toHaveBeenCalled();
  });
});
