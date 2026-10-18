import { describe, expect, it } from "vitest";
import {
  adminStateFromError,
  adminStateFromWhoami,
  canAdminister,
  isAdminOnlyPage,
  visibleNavItems,
  visiblePluginManifests,
} from "./admin-role";

const principal = (role: string, is_owner = false) => ({
  user_id: "u1",
  display: "U",
  role,
  channels: [],
  is_owner,
});

describe("canAdminister", () => {
  it("matches the server's owner/admin rule", () => {
    expect(canAdminister(principal("owner"))).toBe(true);
    expect(canAdminister(principal("admin"))).toBe(true);
    expect(canAdminister(principal("member", true))).toBe(true);
    expect(canAdminister(principal("member"))).toBe(false);
    expect(canAdminister(principal("viewer"))).toBe(false);
  });
});

describe("adminStateFromWhoami", () => {
  it("members and viewers are not admins", () => {
    for (const role of ["member", "viewer"]) {
      expect(
        adminStateFromWhoami({ configured: true, principal: principal(role) }),
      ).toBe("not-admin");
    }
  });
  it("owners and admins are admins", () => {
    expect(
      adminStateFromWhoami({ configured: true, principal: principal("admin") }),
    ).toBe("admin");
  });
  it("single-user installs without a member datastore keep every control", () => {
    expect(adminStateFromWhoami({ configured: false, principal: null })).toBe(
      "admin",
    );
  });
});

describe("adminStateFromError", () => {
  it("401/403 hide admin controls", () => {
    expect(adminStateFromError(new Error("403: forbidden"))).toBe("not-admin");
    expect(adminStateFromError(new Error("401: no subject"))).toBe("not-admin");
  });
  it("other failures fall back to today's behaviour (server still guards)", () => {
    expect(adminStateFromError(new Error("500: boom"))).toBe("admin");
    expect(adminStateFromError(new TypeError("Failed to fetch"))).toBe("admin");
  });
});

describe("nav filtering", () => {
  const items = [
    { path: "/sessions" },
    { path: "/chat" },
    { path: "/env" },
    { path: "/models" },
    { path: "/system" },
  ];
  it("hides admin-only pages from members", () => {
    expect(visibleNavItems(items, "not-admin").map((i) => i.path)).toEqual([
      "/sessions",
      "/models",
    ]);
  });
  it("never hides anything from admins or while the role is loading", () => {
    expect(visibleNavItems(items, "admin")).toHaveLength(items.length);
    expect(visibleNavItems(items, "loading")).toHaveLength(items.length);
  });
  it("matches paths with a trailing slash", () => {
    expect(isAdminOnlyPage("/env/")).toBe(true);
    expect(isAdminOnlyPage("/sessions")).toBe(false);
  });
});

describe("plugin tabs", () => {
  const manifests = [
    { name: "kanban", has_api: true },
    { name: "theme-only", has_api: false },
  ];
  it("hides plugins whose API is owner/admin-only from members", () => {
    expect(
      visiblePluginManifests(manifests, "not-admin").map((m) => m.name),
    ).toEqual(["theme-only"]);
    expect(visiblePluginManifests(manifests, "admin")).toHaveLength(2);
  });
});
