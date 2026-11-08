// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchSessionTitle,
  mayGetAutoTitle,
  sessionLabel,
  useSessionTitle,
  waitForAutoTitle,
} from "@/lib/landing/titles";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(cleanup);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = async () => {};

describe("sessionLabel / mayGetAutoTitle", () => {
  it("prefers the title, then the preview", () => {
    expect(sessionLabel({ title: "Trip", preview: "plan a trip" })).toBe("Trip");
    expect(sessionLabel({ title: null, preview: "plan a trip" })).toBe("plan a trip");
    expect(sessionLabel({ title: "  ", preview: null })).toBe("New chat");
  });

  it("only waits for untitled, young sessions", () => {
    expect(mayGetAutoTitle(undefined)).toBe(true);
    expect(mayGetAutoTitle({ title: null, message_count: 2 })).toBe(true);
    expect(mayGetAutoTitle({ title: "Named", message_count: 2 })).toBe(false);
    expect(mayGetAutoTitle({ title: null, message_count: 12 })).toBe(false);
  });
});

describe("fetchSessionTitle", () => {
  it("reads the title route with the profile", async () => {
    const f = vi.fn(async () => jsonResponse({ session_id: "s1", title: "Trip" }));
    await expect(fetchSessionTitle("s1", "research", f as unknown as typeof fetch)).resolves.toBe(
      "Trip",
    );
    expect(f).toHaveBeenCalledWith(
      "/api/chat/sessions/rename?sessionId=s1&profile=research",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("is undefined on failure and null when untitled", async () => {
    const fail = vi.fn(async () => jsonResponse({}, 502));
    await expect(fetchSessionTitle("s1", undefined, fail as unknown as typeof fetch)).resolves.toBe(
      undefined,
    );
    const empty = vi.fn(async () => jsonResponse({ session_id: "s1", title: null }));
    await expect(fetchSessionTitle("s1", undefined, empty as unknown as typeof fetch)).resolves.toBe(
      null,
    );
  });
});

describe("waitForAutoTitle", () => {
  it("polls until the title appears", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ session_id: "s1", title: null }))
      .mockResolvedValueOnce(jsonResponse({ session_id: "s1", title: "Trip" }));
    const title = await waitForAutoTitle("s1", {
      fetchImpl: f as unknown as typeof fetch,
      sleep: noSleep,
      delaysMs: [1, 1, 1],
    });
    expect(title).toBe("Trip");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and stops when aborted", async () => {
    const f = vi.fn(async () => jsonResponse({ session_id: "s1", title: null }));
    await expect(
      waitForAutoTitle("s1", { fetchImpl: f as unknown as typeof fetch, sleep: noSleep, delaysMs: [1, 1] }),
    ).resolves.toBeNull();
    expect(f).toHaveBeenCalledTimes(2);

    const c = new AbortController();
    c.abort();
    f.mockClear();
    await expect(
      waitForAutoTitle("s1", { fetchImpl: f as unknown as typeof fetch, signal: c.signal, delaysMs: [1] }),
    ).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("useSessionTitle", () => {
  it("picks up the auto-title after a turn", async () => {
    const f = vi.fn(async () => jsonResponse({ session_id: "s1", title: "Trip to Lisbon" }));
    const onTitle = vi.fn();
    const { result } = renderHook(() =>
      useSessionTitle({
        sessionId: "s1",
        title: null,
        onTitle,
        fetchImpl: f as unknown as typeof fetch,
        delaysMs: [0],
      }),
    );
    act(() => result.current.watchForAutoTitle());
    await waitFor(() => expect(result.current.title).toBe("Trip to Lisbon"));
    expect(onTitle).toHaveBeenCalledWith("Trip to Lisbon", "agent");
  });

  it("does not watch a titled session", () => {
    const f = vi.fn();
    const { result } = renderHook(() =>
      useSessionTitle({
        sessionId: "s1",
        title: "Named",
        fetchImpl: f as unknown as typeof fetch,
        delaysMs: [0],
      }),
    );
    act(() => result.current.watchForAutoTitle());
    expect(f).not.toHaveBeenCalled();
  });

  it("renames in place via PATCH with an Idempotency-Key, and the rename wins", async () => {
    let resolveAuto: (r: Response) => void = () => {};
    const f = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ok: true, title: "My name" }));
      }
      return new Promise<Response>((r) => {
        resolveAuto = r;
      });
    });
    const onTitle = vi.fn();
    const { result } = renderHook(() =>
      useSessionTitle({
        sessionId: "s1",
        profile: "research",
        title: null,
        onTitle,
        fetchImpl: f as unknown as typeof fetch,
        delaysMs: [0],
      }),
    );
    act(() => result.current.watchForAutoTitle());
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1));

    let ok = false;
    await act(async () => {
      ok = await result.current.rename("  My name ");
    });
    expect(ok).toBe(true);
    expect(result.current.title).toBe("My name");
    const patch = f.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/chat/sessions/rename");
    const init = patch?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      sessionId: "s1",
      title: "My name",
      profile: "research",
    });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(onTitle).toHaveBeenCalledWith("My name", "user");

    // A late auto-title answer must not replace the person's name.
    await act(async () => {
      resolveAuto(jsonResponse({ session_id: "s1", title: "Auto name" }));
    });
    expect(result.current.title).toBe("My name");
  });

  it("surfaces a rejected rename as an error and keeps the old title", async () => {
    const f = vi.fn(async () => jsonResponse({ detail: "Title already in use" }, 400));
    const { result } = renderHook(() =>
      useSessionTitle({ sessionId: "s1", title: "Old", fetchImpl: f as unknown as typeof fetch }),
    );
    let ok = true;
    await act(async () => {
      ok = await result.current.rename("Dup");
    });
    expect(ok).toBe(false);
    expect(result.current.title).toBe("Old");
    expect(result.current.error).toBeTruthy();
  });

  it("follows a new server title", () => {
    const { result, rerender } = renderHook(
      ({ title }: { title: string | null }) => useSessionTitle({ sessionId: "s1", title }),
      { initialProps: { title: null as string | null } },
    );
    expect(result.current.title).toBeNull();
    rerender({ title: "From list" });
    expect(result.current.title).toBe("From list");
  });
});
