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
import {
  AQUARIUM_NAME_DEFAULT,
  AQUARIUM_NAME_MAX,
  IDLE_SECONDS_MAX,
  IDLE_SECONDS_MIN,
} from "@/lib/aquarium/creatures";

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

const URL_ = "http://x/api/aquarium/settings";

describe("/api/aquarium/settings", () => {
  it("needs a session", async () => {
    expect((await GET()).status).toBe(401);
    expect((await PUT(put(URL_, { idle_seconds: 60 }))).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("lets any signed-in person read the settings", async () => {
    signIn("member");
    upstream = () => Response.json({ idle_seconds: 30, name: AQUARIUM_NAME_DEFAULT });
    const res = await GET();
    expect(await res.json()).toEqual({ idle_seconds: 30, name: AQUARIUM_NAME_DEFAULT });
    expect(seen[0].url.pathname).toBe("/api/aquarium/settings");
    expect(seen[0].url.search).toBe("");
  });

  it.each([{ idle_seconds: 60 }, { name: "Reef" }])(
    "refuses a member's change before anything is sent (%j)",
    async (body) => {
      signIn("member");
      expect((await PUT(put(URL_, body))).status).toBe(403);
      expect(seen).toHaveLength(0);
    },
  );

  it.each(["owner", "admin"] as const)("forwards a %s's change", async (role) => {
    signIn(role);
    upstream = () => Response.json({ idle_seconds: 60 });
    const res = await PUT(put(URL_, { idle_seconds: 60 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ idle_seconds: 60 });
    expect(seen[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ idle_seconds: 60 });
  });

  it.each([IDLE_SECONDS_MIN - 1, IDLE_SECONDS_MAX + 1, 0, 30.5, "30", null])(
    "400s an out-of-range or non-integer value (%s)",
    async (idle) => {
      signIn("admin");
      expect((await PUT(put(URL_, { idle_seconds: idle }))).status).toBe(400);
      expect(seen).toHaveLength(0);
    },
  );

  it.each([
    [{ name: "  Reef  " }, { name: "  Reef  " }],
    [{ idle_seconds: 90, name: "" }, { idle_seconds: 90, name: "" }],
    [{ name: "x", other: true }, { name: "x" }],
  ])("forwards only the given fields (%j)", async (body, sent) => {
    signIn("admin");
    upstream = () => Response.json({ idle_seconds: 90, name: "Reef" });
    const res = await PUT(put(URL_, body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ idle_seconds: 90, name: "Reef" });
    expect(JSON.parse(String(seen[0].init?.body))).toEqual(sent);
  });

  it.each([
    {},
    { other: 1 },
    { name: null },
    { name: 7 },
    { name: ["Reef"] },
    { name: "n".repeat(AQUARIUM_NAME_MAX + 1) },
    { idle_seconds: 60, name: 7 },
    { idle_seconds: 1, name: "Reef" },
  ])("400s a bad or empty body (%j)", async (body) => {
    signIn("owner");
    expect((await PUT(put(URL_, body))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it.each(["not json", "null", "5"])("400s a non-object body (%s)", async (body) => {
    signIn("owner");
    expect((await PUT(put(URL_, body))).status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it("measures the name like Python: trimmed, without control characters, by code point", async () => {
    signIn("admin");
    upstream = () => Response.json({ idle_seconds: 30, name: "ok" });
    for (const name of [
      ` ${"a".repeat(AQUARIUM_NAME_MAX)}\n`,
      `${"b".repeat(AQUARIUM_NAME_MAX)}\u0000\u202e`,
      "🐙".repeat(AQUARIUM_NAME_MAX),
    ]) {
      expect((await PUT(put(URL_, { name }))).status).toBe(200);
    }
  });

  it("accepts the bounds", async () => {
    signIn("admin");
    for (const idle of [IDLE_SECONDS_MIN, IDLE_SECONDS_MAX]) {
      upstream = () => Response.json({ idle_seconds: idle });
      expect((await PUT(put(URL_, { idle_seconds: idle }))).status).toBe(200);
    }
  });
});
