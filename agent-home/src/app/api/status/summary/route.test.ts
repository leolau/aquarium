/**
 * BFF route tests for GET /api/status/summary — the shell status strip's
 * aggregate. Contract: every leg is independent (a failing upstream read
 * yields null fields, never a failed response), and the counts compose
 * correctly (running kanban cards from the count endpoint, cron jobs split
 * enabled/total), and the upstream fan-out is cached per session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/status/summary/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const systemStats = vi.fn();
const usageAnalytics = vi.fn();
const capacity = vi.fn();
const cronJobs = vi.fn();
const projectsRunningCards = vi.fn();
const uploadStorage = vi.fn();
const unstableCache =
  vi.fn<
    (
      fn: () => Promise<unknown>,
      keyParts?: string[],
      opts?: unknown,
    ) => () => Promise<unknown>
  >((fn) => fn);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({
    systemStats,
    usageAnalytics,
    capacity,
    cronJobs,
    projectsRunningCards,
    uploadStorage,
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: async () => ({ hermesToken: "secret-token" }),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) =>
    unstableCache(fn, keyParts, opts),
}));

function get(): Promise<Response> {
  return GET() as unknown as Promise<Response>;
}

describe("GET /api/status/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue({
      user_id: "leo",
      display: "Leo",
      role: "owner",
      channels: [],
      is_owner: true,
    });
    systemStats.mockResolvedValue({
      cpu_percent: 42.4,
      memory: { percent: 61.2 },
      disk: { percent: 33.3 },
    });
    usageAnalytics.mockResolvedValue({
      totals: { total_input: 1_500_000, total_output: 250_000, total_actual_cost: 12.34 },
    });
    capacity.mockResolvedValue({ indicators: { active_conversations: 2 } });
    cronJobs.mockResolvedValue([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
      { id: "c", enabled: false },
    ]);
    projectsRunningCards.mockResolvedValue({ running_cards: 3 });
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
  });

  it("aggregates stats, usage, tasks, and cron counts", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cpu_pct).toBe(42.4);
    expect(body.mem_pct).toBe(61.2);
    expect(body.disk_pct).toBe(33.3);
    expect(body.tokens_month).toEqual({
      input: 1_500_000,
      output: 250_000,
      cost_usd: 12.34,
    });
    expect(body.active_conversations).toBe(2);
    expect(body.running_cards).toBe(3);
    expect(body.cron_total).toBe(3);
    expect(body.cron_enabled).toBe(2);
    expect(body.collected_at).toBeTypeOf("number");
  });

  it("caches per session under a token hash, never the raw token", async () => {
    await get();
    expect(unstableCache).toHaveBeenCalledTimes(1);
    const [, keyParts, opts] = unstableCache.mock.calls[0];
    expect(keyParts).toHaveLength(3);
    expect(keyParts?.[0]).toBe("status-summary");
    expect(keyParts?.[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(keyParts?.join(" ")).not.toContain("secret-token");
    expect(keyParts?.[2]).toBe("admin");
    expect(opts).toEqual({ revalidate: 15 });
  });

  it("nulls running_cards when the count read fails", async () => {
    projectsRunningCards.mockRejectedValue(new Error("down"));
    const body = await (await get()).json();
    expect(body.running_cards).toBeNull();
    expect(body.cpu_pct).toBe(42.4);
  });

  it("passes the upload-storage reading to owners/admins", async () => {
    const reading = {
      path: "/opt/data/supabase/docker/volumes/storage",
      free_bytes: 1,
      total_bytes: 100,
      min_free_bytes: 10,
      low: true,
    };
    uploadStorage.mockResolvedValue(reading);
    const body = await (await get()).json();
    expect(body.upload_storage).toEqual(reading);
  });

  it("hides the upload-storage reading from members", async () => {
    getPrincipal.mockResolvedValue({
      user_id: "mia",
      display: "Mia",
      role: "member",
      channels: [],
      is_owner: false,
    });
    uploadStorage.mockResolvedValue({ low: true });
    const body = await (await get()).json();
    expect(body.upload_storage).toBeNull();
    expect(uploadStorage).not.toHaveBeenCalled();
  });

  it("degrades to null fields when a leg fails", async () => {
    systemStats.mockRejectedValue(new Error("psutil gone"));
    capacity.mockRejectedValue(new Error("capacity down"));
    projectsRunningCards.mockRejectedValue(new Error("projects down"));
    cronJobs.mockRejectedValue(new Error("cron down"));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cpu_pct).toBeNull();
    expect(body.disk_pct).toBeNull();
    expect(body.active_conversations).toBeNull();
    expect(body.running_cards).toBeNull();
    expect(body.cron_total).toBe(0);
    // The surviving leg still reports.
    expect(body.tokens_month.input).toBe(1_500_000);
  });
});
