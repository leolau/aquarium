import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SNAPSHOT_POLL_MS, type AquariumSnapshot } from "@/lib/aquarium/creatures";

import { parseSnapshot, startSnapshotPolling, type VisibilitySource } from "./snapshot";

const EMPTY: AquariumSnapshot = { generated_at: 1, idle_seconds: 30, users: [] };

function visibility(hidden = false) {
  const listeners = new Set<() => void>();
  const source: VisibilitySource & { hidden: boolean; fire(): void } = {
    hidden,
    isHidden: () => source.hidden,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    fire: () => listeners.forEach((cb) => cb()),
  };
  return source;
}

describe("parseSnapshot", () => {
  it("keeps valid people and repairs or drops the rest", () => {
    const out = parseSnapshot({
      generated_at: 5,
      idle_seconds: 30,
      users: [
        {
          user_id: "u1",
          name: "Ann",
          creature: "octopus",
          is_self: true,
          metrics: { chats: 3, projects: 1, tokens_in: 10, tokens_out: 5, tokens_24h: 2, active_now: true },
          profiles: [{ name: "default", display_name: "Default" }, { name: "default" }, { bad: 1 }],
        },
        { user_id: "u2", creature: "kraken", metrics: { chats: -1, tokens_in: "x" } },
        { name: "no id" },
        { user_id: "u1", name: "dupe" },
        null,
      ],
    });
    expect(out.users.map((u) => u.user_id)).toEqual(["u1", "u2"]);
    expect(out.users[0].profiles).toEqual([{ name: "default", display_name: "Default" }]);
    expect(out.users[0].is_self).toBe(true);
    const u2 = out.users[1];
    expect(u2.name).toBe("u2");
    expect(u2.creature).not.toBe("kraken");
    expect(u2.metrics).toEqual({ chats: 0, projects: 0, tokens_in: 0, tokens_out: 0, tokens_24h: 0, active_now: false });
  });

  it("rejects a body without a users list", () => {
    expect(() => parseSnapshot({ detail: "nope" })).toThrow();
    expect(() => parseSnapshot(null)).toThrow();
  });
});

describe("startSnapshotPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches at once, then every SNAPSHOT_POLL_MS after the previous one lands", async () => {
    const load = vi.fn(async () => EMPTY);
    const onSnapshot = vi.fn();
    const stop = startSnapshotPolling({ load, onSnapshot, onError: vi.fn(), visibility: visibility() });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledWith(EMPTY);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("never overlaps a slow request", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const load = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, SNAPSHOT_POLL_MS * 2));
      inFlight--;
      return EMPTY;
    });
    const stop = startSnapshotPolling({ load, onSnapshot: vi.fn(), onError: vi.fn(), visibility: visibility() });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS * 10);
    expect(maxInFlight).toBe(1);
    stop();
  });

  it("reports errors and keeps polling", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(EMPTY);
    const onError = vi.fn();
    const onSnapshot = vi.fn();
    const stop = startSnapshotPolling({ load, onSnapshot, onError, visibility: visibility() });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses while hidden and refreshes as soon as the tab is visible", async () => {
    const vis = visibility();
    const load = vi.fn(async () => EMPTY);
    const stop = startSnapshotPolling({ load, onSnapshot: vi.fn(), onError: vi.fn(), visibility: vis });
    await vi.advanceTimersByTimeAsync(0);
    vis.hidden = true;
    vis.fire();
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS * 5);
    expect(load).toHaveBeenCalledTimes(1);
    vis.hidden = false;
    vis.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(SNAPSHOT_POLL_MS);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
  });

  it("aborts the in-flight request when stopped and stays silent", async () => {
    let signal: AbortSignal | undefined;
    const load = vi.fn(
      (s: AbortSignal) =>
        new Promise<AquariumSnapshot>((_, reject) => {
          signal = s;
          s.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const onError = vi.fn();
    const stop = startSnapshotPolling({ load, onSnapshot: vi.fn(), onError, visibility: visibility() });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
