import { beforeEach, describe, expect, it, vi } from "vitest";

const agentHomeNav = vi.fn();
const cacheKeys: unknown[][] = [];

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown, key: unknown[]) => {
    cacheKeys.push(key);
    return fn;
  },
}));
vi.mock("@/lib/api/client", () => ({
  HermesApiClient: class {
    agentHomeNav = agentHomeNav;
  },
}));

import { clearLocalNavCache, getHiddenApps, getHiddenAppsForMiddleware } from "@/lib/nav/hidden-apps";

describe("getHiddenApps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheKeys.length = 0;
    clearLocalNavCache();
    agentHomeNav.mockResolvedValue({ hidden: ["graph", "home"] });
  });

  it("returns nothing for the owner without asking the API", async () => {
    expect(await getHiddenApps({ role: "owner", is_owner: true }, "tok")).toEqual([]);
    expect(await getHiddenApps({ role: "admin", is_owner: true }, "tok")).toEqual([]);
    expect(agentHomeNav).not.toHaveBeenCalled();
  });

  it("returns the role's sanitized list, keyed by role and never the token", async () => {
    expect(await getHiddenApps({ role: "member" }, "secret-token")).toEqual(["graph"]);
    expect(cacheKeys).toEqual([["agent-home-nav-hidden", "member"]]);
    expect(JSON.stringify(cacheKeys)).not.toContain("secret-token");
  });

  it("shows everything when the API fails or there is no token", async () => {
    agentHomeNav.mockRejectedValue(new Error("down"));
    expect(await getHiddenApps({ role: "member" }, "tok")).toEqual([]);
    expect(await getHiddenApps({ role: "member" }, undefined)).toEqual([]);
  });

  it("middleware variant caches per role until cleared", async () => {
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockResolvedValue({ hidden: ["todos"] });
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["graph"]);
    clearLocalNavCache();
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["todos"]);
  });
});
