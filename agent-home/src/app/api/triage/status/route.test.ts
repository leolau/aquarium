/**
 * BFF tests for GET /api/triage/status: signed-in only, bound to the
 * requested profile, Hermes errors passed through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/triage/status/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal, TriageStatus } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const triageStatus = vi.fn();
const apiClientForRequest = vi.fn<(opts?: { profile?: string }) => Promise<{ triageStatus: typeof triageStatus }>>(
  async () => ({ triageStatus }),
);

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: (opts?: { profile?: string }) => apiClientForRequest(opts),
}));

const ALICE: Principal = { user_id: "alice", display: "Alice", role: "member", channels: [], is_owner: false };
const STATUS: TriageStatus = { profile: null, kinds: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(ALICE);
});

describe("GET /api/triage/status", () => {
  it("401s without a signed-in principal and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/triage/status"));
    expect(res.status).toBe(401);
    expect(triageStatus).not.toHaveBeenCalled();
  });

  it("forwards under a client bound to ?profile=", async () => {
    triageStatus.mockResolvedValue({ ...STATUS, profile: "hr" });
    const res = await GET(new Request("http://localhost/api/triage/status?profile=hr"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ profile: "hr", kinds: [] });
    expect(apiClientForRequest).toHaveBeenCalledWith({ profile: "hr" });
  });

  it("passes Hermes errors through", async () => {
    triageStatus.mockRejectedValue(new HermesApiError(403, "not enrolled"));
    const res = await GET(new Request("http://localhost/api/triage/status?profile=hr"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "api_error", detail: "not enrolled" });
  });
});
