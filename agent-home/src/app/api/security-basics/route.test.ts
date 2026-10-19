/**
 * BFF routes for Get ready → Security basics: owner/admin only, checked here
 * before Hermes is called; Hermes errors (409 "already running") pass through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/security-basics/route";
import { POST } from "@/app/api/security-basics/test/route";
import { HermesApiError } from "@/lib/api/client";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const securityBasics = vi.fn();
const testSecurityBasics = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ securityBasics, testSecurityBasics }),
}));

function who(role: Principal["role"], is_owner = false): Principal {
  return { user_id: role, display: role, role, channels: [], is_owner };
}

const RESULT = { checked_at: null, status: "not_started", passed: 0, total: 0, helper: "", checks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getPrincipal.mockResolvedValue(who("admin"));
});

describe.each([
  ["GET /api/security-basics", () => GET(), securityBasics],
  ["POST /api/security-basics/test", () => POST(), testSecurityBasics],
] as const)("%s", (_name, call, upstream) => {
  it("401s when unauthenticated and never calls Hermes", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["member", "viewer"] as const)("403s a %s and never calls Hermes", async (role) => {
    getPrincipal.mockResolvedValue(who(role));
    expect((await call()).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([who("admin"), who("owner", true)])("forwards for $role", async (principal) => {
    getPrincipal.mockResolvedValue(principal);
    upstream.mockResolvedValue(RESULT);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
  });

  it("passes a Hermes error (e.g. 409 already running) through", async () => {
    upstream.mockRejectedValue(new HermesApiError(409, "A security check is already running."));
    const res = await call();
    expect(res.status).toBe(409);
  });

  it("502s when Hermes is unreachable", async () => {
    upstream.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await call()).status).toBe(502);
  });
});
