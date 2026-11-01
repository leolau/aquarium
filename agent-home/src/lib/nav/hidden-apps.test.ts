import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import {
  clearLocalNavCache,
  getHiddenApps,
  getHiddenAppsForMiddleware,
  NAV_CACHE_SECONDS,
} from "@/lib/nav/hidden-apps";

const STATE_KEY = Symbol.for("agent-home.nav.hidden");

describe("getHiddenApps", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheKeys.length = 0;
    delete (globalThis as Record<symbol, unknown>)[STATE_KEY];
    agentHomeNav.mockResolvedValue({ hidden: ["graph", "home"] });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
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

  it("shows everything only when no list was ever fetched, and warns", async () => {
    agentHomeNav.mockRejectedValue(new Error("down"));
    expect(await getHiddenApps({ role: "member" }, "tok")).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no list known yet"));
    expect(await getHiddenApps({ role: "member" }, undefined)).toEqual([]);
  });

  it("serves the last known list when a later lookup fails", async () => {
    expect(await getHiddenApps({ role: "member" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockRejectedValue(new Error("down"));
    expect(await getHiddenApps({ role: "member" }, "tok")).toEqual(["graph"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("serving the last known list"));
    // Another role's list is not borrowed.
    expect(await getHiddenApps({ role: "viewer" }, "tok")).toEqual([]);
  });

  it("middleware copy is reused within the TTL and refetched after it", async () => {
    vi.useFakeTimers();
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockResolvedValue({ hidden: ["todos"] });
    vi.advanceTimersByTime((NAV_CACHE_SECONDS - 1) * 1000);
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["graph"]);
    vi.advanceTimersByTime(2000);
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["todos"]);
  });

  it("keeps the middleware TTL at 30 s or less", () => {
    expect(NAV_CACHE_SECONDS).toBeLessThanOrEqual(30);
  });

  it("middleware refetches right after a save in this process", async () => {
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockResolvedValue({ hidden: ["todos"] });
    clearLocalNavCache();
    expect(await getHiddenAppsForMiddleware({ role: "viewer" }, "tok")).toEqual(["todos"]);
  });

  it("middleware serves the last known list on error, even after a save or the TTL", async () => {
    vi.useFakeTimers();
    expect(await getHiddenAppsForMiddleware({ role: "member" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockRejectedValue(new Error("down"));
    clearLocalNavCache();
    vi.advanceTimersByTime((NAV_CACHE_SECONDS + 5) * 1000);
    expect(await getHiddenAppsForMiddleware({ role: "member" }, "tok")).toEqual(["graph"]);
    expect(warn).toHaveBeenCalled();
  });

  it("middleware shows everything only when nothing was ever fetched", async () => {
    agentHomeNav.mockRejectedValue(new Error("down"));
    expect(await getHiddenAppsForMiddleware({ role: "member" }, "tok")).toEqual([]);
  });

  it("shares the last known list between the page and middleware paths", async () => {
    expect(await getHiddenApps({ role: "member" }, "tok")).toEqual(["graph"]);
    agentHomeNav.mockRejectedValue(new Error("down"));
    clearLocalNavCache();
    expect(await getHiddenAppsForMiddleware({ role: "member" }, "tok")).toEqual(["graph"]);
  });
});
