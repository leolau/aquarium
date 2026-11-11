// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INCOMINGS_POLL_MS, isUrgent, surfaceGroup, useIncomingsAttention } from "./incomings";
import type { IncomingItem } from "@/types";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function countFetch(counts: number[]) {
  let call = 0;
  const f = vi.fn(async () => {
    const n = counts[Math.min(call++, counts.length - 1)];
    return n < 0
      ? new Response("{}", { status: 502 })
      : new Response(JSON.stringify({ count: n, urgent: 0, by_surface: {} }), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}

describe("useIncomingsAttention", () => {
  it("refetches when the profile changes and never shows the old profile's count", async () => {
    const f = countFetch([5, 2]);
    const { result, rerender } = renderHook(({ p }) => useIncomingsAttention(p), {
      initialProps: { p: "default" },
    });
    await waitFor(() => expect(result.current.count).toBe(5));
    rerender({ p: "work" });
    expect(result.current.count).toBeNull();
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("polls every 15 s while visible, keeps the last good count, and caps at 99", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    countFetch([150, -1, 3]);
    const { result } = renderHook(() => useIncomingsAttention("default"));
    await waitFor(() => expect(result.current.count).toBe(99));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCOMINGS_POLL_MS);
    });
    expect(result.current.count).toBe(99);
    expect(result.current.stale).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INCOMINGS_POLL_MS);
    });
    await waitFor(() => expect(result.current.count).toBe(3));
    expect(result.current.stale).toBe(false);
  });
});

describe("grouping", () => {
  const it_ = (over: Partial<IncomingItem>) => over as IncomingItem;
  it("urgent = a critical event, or an escalation at urgent/high priority", () => {
    expect(isUrgent(it_({ attention_reason: "critical_event" }))).toBe(true);
    expect(isUrgent(it_({ attention_reason: "escalated", attention_priority: "high" }))).toBe(true);
    expect(isUrgent(it_({ attention_reason: "escalated", attention_priority: "medium" }))).toBe(false);
    expect(isUrgent(it_({ attention_reason: "todo", attention_priority: "urgent" }))).toBe(false);
  });
  it("every IM channel files under Messages", () => {
    expect(["whatsapp", "telegram", "slack"].map(surfaceGroup)).toEqual(["messages", "messages", "messages"]);
    expect(surfaceGroup("email")).toBe("email");
    expect(surfaceGroup("calendar")).toBe("calendar");
  });
});
