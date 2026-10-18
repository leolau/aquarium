import { beforeEach, describe, expect, it, vi } from "vitest";

import { PUT } from "@/app/api/access/roles/[role]/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const setRoleLimits = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ setRoleLimits }),
}));

function put(role: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/access/roles/${role}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ role }) },
  ) as unknown as Promise<Response>;
}

function as(role: Principal["role"]) {
  getPrincipal.mockResolvedValue({ user_id: "u", role } as Principal);
}

describe("PUT /api/access/roles/[role]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRoleLimits.mockResolvedValue({ ok: true, roles: [] });
  });

  it("401s when signed out", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await put("member", { deny_tools: [] })).status).toBe(401);
  });

  it.each(["member", "viewer"] as const)("403s for a %s and never calls the API", async (role) => {
    as(role);
    expect((await put("member", { deny_tools: [] })).status).toBe(403);
    expect(setRoleLimits).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("forwards blocked tools for an %s", async (role) => {
    as(role);
    const res = await put("member", { deny_tools: ["terminal"] });
    expect(res.status).toBe(200);
    expect(setRoleLimits).toHaveBeenCalledWith("member", { deny_tools: ["terminal"] });
  });

  it("forwards a reset", async () => {
    as("admin");
    await put("viewer", { reset: true });
    expect(setRoleLimits).toHaveBeenCalledWith("viewer", { reset: true });
  });

  it("400s on a malformed body", async () => {
    as("owner");
    expect((await put("member", { deny_tools: "terminal" })).status).toBe(400);
    expect((await put("member", {})).status).toBe(400);
    expect(setRoleLimits).not.toHaveBeenCalled();
  });
});
