import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: () => {},
  })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import { SESSION_COOKIE, serializeSession } from "@/lib/auth/session";

import { GET, PUT } from "./route";

const seen: { url: URL; init: RequestInit | undefined }[] = [];
let upstream: () => Response = () => Response.json({});
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  seen.push({ url: new URL(String(url)), init });
  return upstream();
});

function signIn(role: "owner" | "admin" | "member" = "member") {
  jar.set(
    SESSION_COOKIE,
    serializeSession({
      hermesToken: "tok",
      profile: "default",
      principal: { user_id: "u1", display: "U", role, channels: [], is_owner: role === "owner" },
      issuedAt: 1_700_000_000,
    }),
  );
}

const put = (url: string, body: unknown) =>
  new Request(url, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(() => {
  process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
});
beforeEach(() => {
  jar.clear();
  seen.length = 0;
  upstream = () => Response.json({});
  vi.stubGlobal("fetch", fetchMock);
});

const URL_ = "http://x/api/me/creature";

describe("/api/me/creature", () => {
  it("needs a session", async () => {
    expect((await GET()).status).toBe(401);
    expect((await PUT(put(URL_, { creature: "octopus" }))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("reads the caller's own creature", async () => {
    signIn();
    upstream = () => Response.json({ creature: "crab", chosen: false });
    const res = await GET();
    expect(await res.json()).toEqual({ creature: "crab", chosen: false });
    expect(seen[0].url.pathname).toBe("/api/me/creature");
  });

  it("saves a known creature and never forwards a user id", async () => {
    signIn();
    upstream = () => Response.json({ creature: "octopus", chosen: true });
    const res = await PUT(put(URL_, { creature: "octopus", user_id: "someone-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ creature: "octopus", chosen: true });
    expect(seen[0].init?.method).toBe("PUT");
    const sent = JSON.parse(String(seen[0].init?.body));
    expect(sent.creature).toBe("octopus");
    expect(sent).not.toHaveProperty("user_id");
  });

  it.each(["kraken", "", 3, null])("400s an unknown creature (%s)", async (creature) => {
    signIn();
    expect((await PUT(put(URL_, { creature }))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("400s an unreadable body", async () => {
    signIn();
    expect((await PUT(put(URL_, "not json"))).status).toBe(400);
  });
});
