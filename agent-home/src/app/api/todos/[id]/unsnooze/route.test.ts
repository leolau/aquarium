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

import { POST } from "./route";

const seen: { url: URL; init: RequestInit | undefined }[] = [];
let upstream: () => Response = () => Response.json({ id: "t1", snoozed_until: null });
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  seen.push({ url: new URL(String(url)), init });
  return upstream();
});

const call = (body: unknown) =>
  POST(
    new Request("http://x/api/todos/t1/unsnooze", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "t1" }) },
  );

function signIn() {
  jar.set(
    SESSION_COOKIE,
    serializeSession({
      hermesToken: "tok",
      profile: "default",
      principal: { user_id: "u1", display: "U", role: "member", channels: [], is_owner: false },
      issuedAt: 1_700_000_000,
    }),
  );
}

describe("POST /api/todos/[id]/unsnooze", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    seen.length = 0;
    upstream = () => Response.json({ id: "t1", snoozed_until: null });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("needs a session", async () => {
    expect((await call({})).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("forwards the pre-snooze state to the upstream unsnooze", async () => {
    signIn();
    const res = await call({ until: null, notified_at: "2026-08-11T09:00:00Z" });
    expect(res.status).toBe(200);
    expect(seen[0].url.pathname).toBe("/api/registry/todos/t1/unsnooze");
    expect(seen[0].init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({
      until: null,
      notified_at: "2026-08-11T09:00:00Z",
    });
  });

  it("an empty or unreadable body just clears the snooze", async () => {
    signIn();
    await call("not json");
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({});
  });

  it("passes the upstream's refusal through", async () => {
    signIn();
    upstream = () => Response.json({ detail: "No such to-do" }, { status: 404 });
    const res = await call({});
    expect(res.status).toBe(404);
  });
});
