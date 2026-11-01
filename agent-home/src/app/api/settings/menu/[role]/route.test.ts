import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Principal } from "@/types";

const getPrincipal = vi.fn<() => Promise<Principal | null>>();
const setAgentHomeNav = vi.fn();
const revalidateTag = vi.fn();
const clearLocalNavCache = vi.fn();

vi.mock("next/cache", () => ({ revalidateTag: (t: string) => revalidateTag(t) }));
vi.mock("@/lib/nav/hidden-apps", () => ({
  NAV_CACHE_TAG: "agent-home-nav",
  clearLocalNavCache: () => clearLocalNavCache(),
}));
vi.mock("@/lib/auth/principal", () => ({
  getPrincipal: () => getPrincipal(),
  apiClientForRequest: async () => ({ setAgentHomeNav }),
}));

import { PUT } from "@/app/api/settings/menu/[role]/route";
import { HermesApiError } from "@/lib/api/client";

function put(role: string, body: unknown): Promise<Response> {
  return PUT(
    new Request(`http://localhost/api/settings/menu/${role}`, { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ role }) },
  ) as unknown as Promise<Response>;
}

const as = (role: Principal["role"]) => getPrincipal.mockResolvedValue({ user_id: "u", role } as Principal);

describe("PUT /api/settings/menu/[role]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setAgentHomeNav.mockResolvedValue({ ok: true, hidden: [] });
  });

  it("401s when signed out", async () => {
    getPrincipal.mockResolvedValue(null);
    expect((await put("member", { hidden: [] })).status).toBe(401);
  });

  it.each(["member", "viewer"] as const)("403s for a %s and never calls the API", async (role) => {
    as(role);
    expect((await put("member", { hidden: ["graph"] })).status).toBe(403);
    expect(setAgentHomeNav).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("saves for an %s and drops the cached menus", async (role) => {
    as(role);
    expect((await put("viewer", { hidden: ["graph"] })).status).toBe(200);
    expect(setAgentHomeNav).toHaveBeenCalledWith("viewer", ["graph"]);
    expect(revalidateTag).toHaveBeenCalledWith("agent-home-nav");
    expect(clearLocalNavCache).toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    as("owner");
    expect((await put("member", { hidden: "graph" })).status).toBe(400);
    expect((await put("member", { hidden: [1] })).status).toBe(400);
  });

  it("passes the API's 400 through for unknown ids without invalidating", async () => {
    as("admin");
    setAgentHomeNav.mockRejectedValue(new HermesApiError(400, "Unknown menu item: nope"));
    expect((await put("member", { hidden: ["nope"] })).status).toBe(400);
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
