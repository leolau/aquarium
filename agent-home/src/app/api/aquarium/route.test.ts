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
import type { AquariumSnapshot } from "@/lib/aquarium/creatures";

import { GET } from "./route";

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

beforeAll(() => {
  process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
});
beforeEach(() => {
  jar.clear();
  seen.length = 0;
  upstream = () => Response.json({});
  vi.stubGlobal("fetch", fetchMock);
});

const SNAPSHOT: AquariumSnapshot = {
  generated_at: 1_700_000_000,
  idle_seconds: 30,
  users: [
    {
      user_id: "u1",
      name: "U",
      creature: "octopus",
      is_self: true,
      metrics: { chats: 2, projects: 1, tokens_in: 10, tokens_out: 5, tokens_24h: 15, active_now: false },
      profiles: [{ name: "default", display_name: "default" }],
    },
  ],
};

describe("GET /api/aquarium", () => {
  it("needs a session", async () => {
    expect((await GET()).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("proxies the Python snapshot box-wide (no profile scoping)", async () => {
    signIn();
    upstream = () => Response.json(SNAPSHOT);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SNAPSHOT);
    expect(seen[0].url.pathname).toBe("/api/aquarium/snapshot");
    expect(seen[0].url.search).toBe("");
  });

  it("passes an upstream refusal through", async () => {
    signIn();
    upstream = () => Response.json({ detail: "nope" }, { status: 409 });
    const res = await GET();
    expect(res.status).toBe(409);
    expect((await res.json()).detail).toBe("nope");
  });
});
