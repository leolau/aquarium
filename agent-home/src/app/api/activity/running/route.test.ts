/**
 * BFF route tests for GET /api/activity/running — the activity bar's feed.
 * Contract: unauthenticated → 401; rows are relayed as `{items, scheduled}`;
 * a running-rows failure is a 502 (never a silent empty bar) while a
 * scheduled-summary failure is `scheduled: null`; and both upstream reads are
 * cached together per session under a hashed token + role, never the raw
 * token.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/activity/running/route";
import { HermesApiError } from "@/lib/api/client";
import type { ActivityItem, Principal, ScheduledSummary } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const activityRunning = vi.fn<() => Promise<ActivityItem[]>>();
const activityScheduled = vi.fn<() => Promise<ScheduledSummary>>();
const readSession = vi.fn<() => Promise<{ hermesToken?: string } | null>>();
const unstableCache = vi.fn<
  (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) => () => Promise<unknown>
>((fn) => fn);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ activityRunning, activityScheduled }),
}));

vi.mock("@/lib/auth/session", () => ({
  readSession: () => readSession(),
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>, keyParts?: string[], opts?: unknown) =>
    unstableCache(fn, keyParts, opts),
}));

const ROW: ActivityItem = {
  kind: "chat",
  id: "s1",
  name: "Plan the launch",
  started_at: 1700000000,
  href: "/chat?session=s1",
  profile: null,
  status: "running",
};

const SCHEDULED: ScheduledSummary = {
  total: 6,
  projects: 3,
  cards: 2,
  cron_jobs: 1,
  next_run_at: 1762850000,
};

function principal(role: Principal["role"]): Principal {
  return { user_id: "u", display: "U", role, channels: [], is_owner: role === "owner" };
}

function get(): Promise<Response> {
  return GET() as unknown as Promise<Response>;
}

describe("GET /api/activity/running", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPrincipal.mockResolvedValue(principal("owner"));
    readSession.mockResolvedValue({ hermesToken: "secret-token" });
    activityRunning.mockResolvedValue([ROW]);
    activityScheduled.mockResolvedValue(SCHEDULED);
  });

  it("returns 401 when unauthenticated", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(activityRunning).not.toHaveBeenCalled();
    expect(activityScheduled).not.toHaveBeenCalled();
  });

  it("relays the caller's running rows with the scheduled summary", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [ROW], scheduled: SCHEDULED });
  });

  it("reads both upstreams in parallel", async () => {
    let releaseRunning: (rows: ActivityItem[]) => void = () => {};
    activityRunning.mockImplementation(() => new Promise((r) => (releaseRunning = r)));
    const pending = get();
    await vi.waitFor(() => expect(activityScheduled).toHaveBeenCalledOnce());
    releaseRunning([ROW]);
    expect((await pending).status).toBe(200);
  });

  it("a failed scheduled leg is scheduled:null, not a 502", async () => {
    activityScheduled.mockRejectedValue(new Error("404"));
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [ROW], scheduled: null });
  });

  it("surfaces a running-rows failure as 502, not an empty bar", async () => {
    activityRunning.mockRejectedValue(new Error("down"));
    const res = await get();
    expect(res.status).toBe(502);
  });

  it("caches both legs in one entry under the unchanged key", async () => {
    await get();
    expect(unstableCache).toHaveBeenCalledOnce();
    const [fn] = unstableCache.mock.calls[0];
    activityRunning.mockClear();
    activityScheduled.mockClear();
    expect(await fn()).toEqual({ items: [ROW], scheduled: SCHEDULED });
    expect(activityRunning).toHaveBeenCalledOnce();
    expect(activityScheduled).toHaveBeenCalledOnce();
  });

  it("caches per session under a hashed token and the role", async () => {
    await get();
    const [, keyParts, opts] = unstableCache.mock.calls[0];
    const hash = createHash("sha256").update("secret-token").digest("hex");
    expect(keyParts).toEqual(["activity-running", hash, "admin"]);
    expect(keyParts?.join("|")).not.toContain("secret-token");
    expect(opts).toEqual({ revalidate: 10 });
  });

  it("never shares a cache entry across sessions or roles", async () => {
    await get();
    readSession.mockResolvedValue({ hermesToken: "other-token" });
    await get();
    getPrincipal.mockResolvedValue(principal("member"));
    await get();
    const keys = unstableCache.mock.calls.map(([, k]) => k?.join("|"));
    expect(new Set(keys).size).toBe(3);
    expect(unstableCache.mock.calls[2][1]?.[2]).toBe("member");
  });

  it("reads uncached when the session carries no token", async () => {
    readSession.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(unstableCache).not.toHaveBeenCalled();
    expect(activityRunning).toHaveBeenCalledOnce();
  });

  it("keeps an upstream 401 (expired token) a 401, not a 502", async () => {
    activityRunning.mockRejectedValue(new HermesApiError(401, "Unauthorized"));
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});
