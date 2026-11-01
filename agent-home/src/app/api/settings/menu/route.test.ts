import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const agentHomeNav = vi.fn();

vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ agentHomeNav }),
}));

import { GET } from "@/app/api/settings/menu/route";

describe("GET /api/settings/menu", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when signed out", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("returns the API's view for any signed-in role", async () => {
    getPrincipal.mockResolvedValue({ user_id: "u", role: "viewer" } as Principal);
    agentHomeNav.mockResolvedValue({ role: "viewer", hidden: ["graph"] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "viewer", hidden: ["graph"] });
  });
});
