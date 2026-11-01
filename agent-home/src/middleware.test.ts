import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.fn();
const hiddenFor = vi.fn<(p: { role: string; is_owner?: boolean }) => Promise<string[]>>();

vi.mock("@/lib/auth/session", () => ({
  sessionCookieValue: () => "cookie",
  deserializeSession: () => session(),
}));
vi.mock("@/lib/nav/hidden-apps", () => ({
  getHiddenAppsForMiddleware: (p: { role: string; is_owner?: boolean }) => hiddenFor(p),
}));

import { config, middleware } from "@/middleware";

const HIDDEN: Record<string, string[]> = { admin: [], member: ["graph", "todos"], viewer: ["graph"] };

function as(role: string, is_owner = false) {
  session.mockReturnValue({ principal: { user_id: "u", role, is_owner }, hermesToken: "t" });
}

const get = (path: string) => middleware(new NextRequest(`http://localhost${path}`));

describe("middleware role gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hiddenFor.mockImplementation(async (p) => (p.is_owner ? [] : HIDDEN[p.role] ?? []));
  });

  it("rewrites a hidden page to the not-available page", async () => {
    as("member");
    const res = await get("/graph");
    expect(res.headers.get("x-middleware-rewrite")).toContain("/not-available?app=graph");
  });

  it("403s a hidden app's API", async () => {
    as("member");
    const res = await get("/api/todos");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_available_for_role", app: "todos" });
  });

  it("applies each role's own list", async () => {
    as("viewer");
    expect((await get("/api/todos")).status).toBe(200);
    expect((await get("/graph")).headers.get("x-middleware-rewrite")).toContain("/not-available");
    as("admin");
    expect((await get("/graph")).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("lets the owner through", async () => {
    as("admin", true);
    expect((await get("/graph")).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("skips the lookup for paths no app owns and for signed-out requests", async () => {
    as("member");
    await get("/settings");
    await get("/projects/p1");
    expect(hiddenFor).not.toHaveBeenCalled();
    session.mockReturnValue(null);
    expect((await get("/graph")).headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each(["/todos/", "//todos", "/%74odos", "/todos?x=1", "/%2Ftodos", "/x/../todos", "/x/%2e%2e/todos"])(
    "blocks the page variant %s",
    async (path) => {
      as("member");
      expect((await get(path)).headers.get("x-middleware-rewrite")).toContain("/not-available?app=todos");
    },
  );

  it.each(["/api/todos/", "//api/todos", "/api/%74odos", "/api//todos/x", "/api/todos?x=1"])(
    "403s the API variant %s",
    async (path) => {
      as("member");
      expect((await get(path)).status).toBe(403);
    },
  );
});

describe("middleware matcher", () => {
  // Next compiles each matcher as an anchored path-to-regexp; this one is a
  // plain regex group, so anchoring it reproduces what Next runs.
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it.each(["/api/todos", "/api/todos/", "/todos", "/graph", "/api/models/overview"])("runs on %s", (p) => {
    expect(matcher.test(p)).toBe(true);
  });

  it("skips static assets", () => {
    expect(matcher.test("/_next/static/chunk.js")).toBe(false);
  });
});
