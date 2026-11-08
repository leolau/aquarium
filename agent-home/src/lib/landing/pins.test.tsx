// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { usePinSuggestions, usePins } from "@/lib/landing/pins";
import type { SessionSummary } from "@/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

afterEach(cleanup);

function session(id: string, pinned_at: number | null = null): SessionSummary {
  return {
    id,
    source: "agent_home",
    title: id,
    preview: null,
    message_count: 2,
    started_at: 1,
    last_active: 2,
    ended_at: null,
    pinned_at,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("usePins", () => {
  it("pins optimistically, sends an Idempotency-Key, keeps the server stamp", async () => {
    const gate = deferred<Response>();
    const fetchImpl = vi.fn(() => gate.promise) as unknown as typeof fetch;
    const sessions = [session("a"), session("b", 50)];
    const { result } = renderHook(() => usePins(sessions, { fetchImpl, profile: "work" }));
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.togglePin("a");
    });
    expect(result.current.isPinned("a")).toBe(true);
    expect(result.current.busy("a")).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/chat/sessions/pin");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: "a", pinned: true, profile: "work" });
    await act(async () => {
      gate.resolve(json(200, { session_id: "a", pinned_at: 99 }));
      await done;
    });
    expect(result.current.sessions[0].pinned_at).toBe(99);
    expect(result.current.pinned.map((s) => s.id)).toEqual(["a", "b"]);
    expect(result.current.busy("a")).toBe(false);
  });

  it("ignores a double click while the first is in flight", async () => {
    const gate = deferred<Response>();
    const fetchImpl = vi.fn(() => gate.promise) as unknown as typeof fetch;
    const sessions = [session("a")];
    const { result } = renderHook(() => usePins(sessions, { fetchImpl }));
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.togglePin("a");
      second = result.current.togglePin("a");
    });
    expect(await second).toBeNull();
    await act(async () => {
      gate.resolve(json(200, { session_id: "a", pinned_at: 5 }));
      await first;
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rolls back on failure and retries with the same key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(409, { detail: "You can pin up to 20 chats." }))
      .mockResolvedValueOnce(json(200, { session_id: "a", pinned_at: 7 })) as unknown as typeof fetch;
    const sessions = [session("a")];
    const { result } = renderHook(() => usePins(sessions, { fetchImpl }));
    await act(async () => {
      await result.current.togglePin("a");
    });
    expect(result.current.isPinned("a")).toBe(false);
    expect(result.current.error).toBeTruthy();
    await act(async () => {
      await result.current.retry();
    });
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const key = (i: number) => (calls[i][1].headers as Record<string, string>)["Idempotency-Key"];
    expect(key(1)).toBe(key(0));
    expect(result.current.isPinned("a")).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("unpins a server-pinned chat", async () => {
    const fetchImpl = vi.fn(async () => json(200, { session_id: "b", pinned_at: null })) as unknown as typeof fetch;
    const sessions = [session("b", 50)];
    const { result } = renderHook(() => usePins(sessions, { fetchImpl }));
    await act(async () => {
      await result.current.togglePin("b");
    });
    expect(result.current.isPinned("b")).toBe(false);
    expect(result.current.pinned).toEqual([]);
  });
});

describe("usePinSuggestions", () => {
  it("loads, then dismisses optimistically and rolls back on failure", async () => {
    const items = [
      { session_id: "a", title: "A", reason: "Unfinished", last_active: 1 },
      { session_id: "b", title: "B", reason: "Unfinished", last_active: 1 },
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(500, {}))
      .mockResolvedValueOnce(json(200, { dismissed: ["b"] })) as unknown as typeof fetch;
    const globalFetch = vi.fn(async () => json(200, { items, generated_at: 1 }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const { result } = renderHook(() => usePinSuggestions({ fetchImpl, profile: "work" }));
      await waitFor(() => expect(result.current.items).toHaveLength(2));
      expect((globalFetch.mock.calls[0] as unknown[])[0]).toBe("/api/chat/pin-suggestions?profile=work");
      await act(async () => {
        expect(await result.current.dismiss(["a"])).toBe(false);
      });
      expect(result.current.items).toHaveLength(2);
      await act(async () => {
        expect(await result.current.dismiss(["b"])).toBe(true);
      });
      expect(result.current.items.map((i) => i.session_id)).toEqual(["a"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
