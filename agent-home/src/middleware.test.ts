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

import { middleware } from "@/middleware";

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
});
