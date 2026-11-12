/**
 * BFF route tests for GET /api/landing/bar. Contract: unauthenticated →
 * 401; the bar composes stats, usage, activity and the needs-you count;
 * one failed leg degrades its field, every leg failing is a 502; the read
 * is cached per session under a hashed token + role.
 */
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/landing/bar/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";
import type { LandingBarResponse } from "@/types/landing";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const readSession = vi.fn<() => Promise<{ hermesToken?: string } | null>>();
const client = {
  systemStats: vi.fn(),
  usageAnalytics: vi.fn(),
  cronJobs: vi.fn(),
  uploadStorage: vi.fn(),
  activityRunning: vi.fn(),
  request: vi.fn(),
};
const unstableCache = vi.fn<
  (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) => () => Promise<unknown>
>((fn) => fn);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => client,
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: () => readSession(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) =>
    unstableCache(fn, keyParts, opts),
}));

function principal(role: Principal["role"]): Principal {
  return { user_id: "u", display: "U", role, channels: [], is_owner: role === "owner" };
}

async function get(query = ""): Promise<Response> {
  return (await GET(new Request(`http://x/api/landing/bar${query}`))) as unknown as Response;
}

describe("GET /api/landing/bar", () => {
  const prevBuild = process.env.NEXT_PUBLIC_HERMES_BUILD;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_HERMES_BUILD = "abc123";
    getPrincipal.mockResolvedValue(principal("owner"));
    readSession.mockResolvedValue({ hermesToken: "secret-token" });
    client.systemStats.mockResolvedValue({
      cpu_percent: 12, memory: { percent: 40 }, disk: { percent: 55 },
    });
    client.usageAnalytics.mockResolvedValue({ totals: { total_input: 1000, total_output: 250 } });
    client.cronJobs.mockResolvedValue([{ enabled: true }, { enabled: false }, {}]);
    client.uploadStorage.mockResolvedValue({ low: false });
    client.activityRunning.mockResolvedValue([
      { status: "running" }, { status: "running" }, { status: "waiting" },
    ]);
    client.request.mockResolvedValue({
      items: [], count: 3, by_severity: { blocking: 2, approval: 1, review: 0, fyi: 0 },
      collected_at: 1,
    });
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_HERMES_BUILD = prevBuild;
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
    expect(client.systemStats).not.toHaveBeenCalled();
  });

  it("composes one bar from every leg", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as LandingBarResponse;
    expect(body.health).toEqual({
      verdict: "ok", cpu_pct: 12, mem_pct: 40, disk_pct: 55,
      build_mismatch: false, low_storage: false,
    });
    expect(body.usage).toEqual({ tokens_month: 1250 });
    expect(body.work).toEqual({ running: 2, waiting: 1, cron_enabled: 2 });
    expect(body.needs_you).toEqual({ count: 3, blocking: 2 });
    expect(client.request).toHaveBeenCalledWith("/api/needs-you?include=count");
  });

  it("is degraded when a resource runs hot or uploads run low", async () => {
    client.systemStats.mockResolvedValue({ cpu_percent: 95, memory: { percent: 40 }, disk: null });
    expect(((await (await get()).json()) as LandingBarResponse).health.verdict).toBe("degraded");
    client.systemStats.mockResolvedValue({ cpu_percent: 5 });
    client.uploadStorage.mockResolvedValue({ low: true });
    const body = (await (await get()).json()) as LandingBarResponse;
    expect(body.health.verdict).toBe("degraded");
    expect(body.health.low_storage).toBe(true);
  });

  it("only reads upload storage for admins", async () => {
    getPrincipal.mockResolvedValue(principal("member"));
    await get();
    expect(client.uploadStorage).not.toHaveBeenCalled();
    expect(unstableCache.mock.calls[0][1]?.[2]).toBe("member");
  });

  it("tolerates a failed leg", async () => {
    client.request.mockRejectedValue(new Error("down"));
    client.usageAnalytics.mockRejectedValue(new Error("down"));
    const body = (await (await get()).json()) as LandingBarResponse;
    expect(body.needs_you).toEqual({ count: 0, blocking: 0 });
    expect(body.usage.tokens_month).toBeNull();
    expect(body.work.running).toBe(2);
  });

  it("is a 502 when every leg is down", async () => {
    client.systemStats.mockRejectedValue(new Error("down"));
    client.activityRunning.mockRejectedValue(new Error("down"));
    client.request.mockRejectedValue(new Error("down"));
    expect((await get()).status).toBe(502);
  });

  it("flags a browser bundle that differs from the server build", async () => {
    const stale = (await (await get("?build=old999")).json()) as LandingBarResponse;
    expect(stale.health.build_mismatch).toBe(true);
    const same = (await (await get("?build=abc123")).json()) as LandingBarResponse;
    expect(same.health.build_mismatch).toBe(false);
  });

  it("caches under a hashed token, never the raw one", async () => {
    await get();
    const key = unstableCache.mock.calls[0][1];
    expect(key).toEqual([
      "landing-bar", createHash("sha256").update("secret-token").digest("hex"), "admin",
    ]);
  });

  it("is a 401 when any leg says the session's token expired", async () => {
    client.usageAnalytics.mockRejectedValue(new HermesApiError(401, "Unauthorized"));
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("still degrades a leg that fails with another upstream status", async () => {
    client.usageAnalytics.mockRejectedValue(new HermesApiError(403, "forbidden"));
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as LandingBarResponse).usage.tokens_month).toBeNull();
  });
});
