import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, PUT } from "@/app/api/settings/accounts/route";
import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const request = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ request, forwardIdempotencyKey: () => {} }),
}));

function as(role: Principal["role"]) {
  getPrincipal.mockResolvedValue({ user_id: "u", role, is_owner: role === "owner" } as Principal);
}

function put(body: unknown): Request {
  return new Request("http://localhost/api/settings/accounts", { method: "PUT", body: JSON.stringify(body) });
}

const valid = { surface: "email", account: "info@example.com", owner_user_id: "sam" };

describe("/api/settings/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    request.mockResolvedValue({ accounts: [], people: [], unreadable: [] });
  });

  it("is owner only: 401 signed out, 403 for admin, member and viewer, never reaching Python", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await PUT(put(valid))).status).toBe(401);
    for (const role of ["admin", "member", "viewer"] as const) {
      as(role);
      expect((await GET()).status).toBe(403);
      expect((await PUT(put(valid))).status).toBe(403);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards the owner's read and choice", async () => {
    as("owner");
    expect((await GET()).status).toBe(200);
    expect((await PUT(put(valid))).status).toBe(200);
    expect((await PUT(put({ ...valid, owner_user_id: null }))).status).toBe(200);
    expect(request.mock.calls).toEqual([
      ["/api/settings/accounts"],
      ["/api/settings/accounts", { method: "PUT", json: valid }],
      ["/api/settings/accounts", { method: "PUT", json: { ...valid, owner_user_id: null } }],
    ]);
  });

  it("rejects malformed choices before Python", async () => {
    as("owner");
    for (const body of [
      { ...valid, surface: "sms" },
      { ...valid, account: " " },
      { surface: "email", account: "info@example.com" },
      { ...valid, owner_user_id: "" },
      { ...valid, owner_user_id: 7 },
    ]) {
      expect((await PUT(put(body))).status).toBe(400);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
