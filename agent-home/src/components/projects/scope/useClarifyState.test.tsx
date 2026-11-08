// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects", useRouter: () => router }));

import { clarifyState, openState } from "@/components/projects/scope/__fixtures__/clarify";
import { fetchClarify, useClarifyState } from "@/components/projects/scope/useClarifyState";
import type { ClarifyState } from "@/types";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const running = (over: Partial<ClarifyState> = {}) =>
  clarifyState({ job: { status: "running", started_at: 1 }, ...over });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  router.refresh.mockClear();
});

async function flush() {
  await act(async () => {});
}

describe("fetchClarify", () => {
  it("reads with no-store and validates the payload", async () => {
    const fetchImpl = vi.fn(async () => json(200, openState()));
    expect(await fetchClarify("p q", fetchImpl as unknown as typeof fetch)).toEqual(openState());
    expect(fetchImpl).toHaveBeenCalledWith("/api/projects/p%20q/clarify", { cache: "no-store" });
  });

  it("is null on an error, a bad payload or a network failure", async () => {
    expect(await fetchClarify("p", (async () => json(500, {})) as unknown as typeof fetch)).toBeNull();
    expect(await fetchClarify("p", (async () => json(200, { detail: "x" })) as unknown as typeof fetch)).toBeNull();
    expect(
      await fetchClarify("p", (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch),
    ).toBeNull();
  });
});

describe("useClarifyState", () => {
  it("loads on mount and does not poll an idle state", async () => {
    const fetchImpl = vi.fn(async () => json(200, openState()));
    const { result } = renderHook(() =>
      useClarifyState("p", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    expect(result.current.state).toBeNull();
    await flush();
    expect(result.current.state?.status).toBe("open");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("polls every 2s while the job runs, stops when it finishes, and refreshes once", async () => {
    const answers = [running(), running(), openState({ job: { status: "done" } })];
    const fetchImpl = vi.fn(async () => json(200, answers.shift() ?? openState()));
    const { result } = renderHook(() =>
      useClarifyState("p", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await flush();
    expect(result.current.state?.job.status).toBe("running");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(router.refresh).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.current.state?.status).toBe("open");
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("starts polling when a write's answer says running", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, clarifyState()))
      .mockResolvedValueOnce(json(200, openState()));
    const { result } = renderHook(() =>
      useClarifyState("p", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await flush();
    act(() => result.current.apply(running()));
    expect(result.current.state?.job.status).toBe("running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.current.state?.status).toBe("open");
  });

  it("keeps polling through a failed read", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, running()))
      .mockResolvedValueOnce(json(502, {}))
      .mockResolvedValueOnce(json(200, openState()));
    const { result } = renderHook(() =>
      useClarifyState("p", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.loadError).toBeTruthy();
    expect(result.current.state?.job.status).toBe("running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.state?.status).toBe("open");
    expect(result.current.loadError).toBeNull();
  });

  it("a read that started before a write cannot overwrite the write's answer", async () => {
    let resolveGet!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (resolveGet = r)));
    const { result } = renderHook(() =>
      useClarifyState("p", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    );
    act(() => result.current.apply(openState()));
    await act(async () => resolveGet(json(200, clarifyState())));
    expect(result.current.state?.status).toBe("open");
  });

  it("re-reads when the version changes and on reload", async () => {
    const fetchImpl = vi.fn(async () => json(200, clarifyState()));
    const { result, rerender } = renderHook(
      ({ v }) => useClarifyState("p", { version: v, fetchImpl: fetchImpl as unknown as typeof fetch }),
      { initialProps: { v: 1 } },
    );
    await flush();
    rerender({ v: 2 });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    act(() => result.current.reload());
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
