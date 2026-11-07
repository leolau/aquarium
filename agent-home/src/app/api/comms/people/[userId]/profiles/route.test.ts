import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: () => {},
  })),
}));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import { SESSION_COOKIE, serializeSession } from "@/lib/auth/session";

import { GET } from "./route";

const seen: URL[] = [];
const fetchMock = vi.fn(async (url: unknown) => {
  const u = new URL(String(url));
  seen.push(u);
  return Response.json({ user_id: "pat", profiles: [] });
});

const call = () =>
  GET(new Request("http://x/api/comms/people/pat/profiles"), {
    params: Promise.resolve({ userId: "pat" }),
  });

describe("GET /api/comms/people/[userId]/profiles", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    seen.length = 0;
    vi.stubGlobal("fetch", fetchMock);
  });

  it("needs a session", async () => {
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("forwards box-wide, never naming the session's profile", async () => {
    jar.set(
      SESSION_COOKIE,
      serializeSession({
        hermesToken: "tok",
        profile: "hr",
        principal: { user_id: "u1", display: "U", role: "member", channels: [], is_owner: false },
        issuedAt: 1_700_000_000,
      }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(seen.map((u) => [u.pathname, u.searchParams.get("profile")])).toEqual([
      ["/api/comms/people/pat/profiles", null],
    ]);
  });
});
