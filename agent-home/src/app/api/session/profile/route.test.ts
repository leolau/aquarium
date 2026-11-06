import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
const sets: string[] = [];
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, options: { maxAge?: number }) => {
      sets.push(name);
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  })),
}));
vi.mock("@/lib/env", async (orig) => ({
  ...(await orig<typeof import("@/lib/env")>()),
  hermesApiBaseUrl: () => "http://api",
}));

import {
  LAST_PROFILE_COOKIE,
  readLastProfileHint,
  readSession,
  serializeSession,
  SESSION_COOKIE,
  type AgentHomeSession,
} from "@/lib/auth/session";
import type { Principal, Role } from "@/types";

import { POST } from "./route";

const principal = (role: Role): Principal => ({
  user_id: "u1",
  display: "U",
  role,
  channels: [],
  is_owner: false,
});

const START: AgentHomeSession = {
  hermesToken: "tok",
  profile: "default",
  principal: principal("owner"),
  issuedAt: 1_700_000_000,
};

// The Python authority: whoami?profile= answers from the target profile's
// own principals — a role there, or 403 where the account is not enrolled.
const ENROLLED: Record<string, Role> = { default: "owner", hr: "member" };
const asked: string[] = [];
const fetchMock = vi.fn(async (url: unknown) => {
  const u = new URL(String(url));
  const profile = u.searchParams.get("profile") ?? "default";
  asked.push(`${u.pathname}?${profile}`);
  const role = ENROLLED[profile];
  return role
    ? Response.json({ configured: true, principal: principal(role) })
    : Response.json({ detail: "Not enrolled in this profile" }, { status: 403 });
});

const switchTo = (profile: unknown) =>
  POST(new Request("http://x/api/session/profile", { method: "POST", body: JSON.stringify({ profile }) }));

describe("POST /api/session/profile", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    sets.length = 0;
    asked.length = 0;
    jar.set(SESSION_COOKIE, serializeSession(START));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("refuses a profile the account is not enrolled in and leaves the cookie as it was", async () => {
    const before = jar.get(SESSION_COOKIE);
    const res = await switchTo("finance");
    expect(res.status).toBe(403);
    expect(sets).toEqual([]);
    expect(jar.get(SESSION_COOKIE)).toBe(before);
    expect(jar.has(LAST_PROFILE_COOKIE)).toBe(false);
  });

  it("switches to an enrolled profile with that profile's role and remembers it", async () => {
    const res = await switchTo("hr");
    expect(res.status).toBe(200);
    // The role is re-derived in the target with the session's own token.
    expect(asked).toEqual(["/api/comms/whoami?hr"]);
    const session = await readSession();
    expect(session).toMatchObject({ profile: "hr", hermesToken: "tok", principal: { role: "member" } });
    expect(await readLastProfileHint()).toBe("hr");
  });

  it("switches back to default without naming it upstream", async () => {
    jar.set(SESSION_COOKIE, serializeSession({ ...START, profile: "hr", principal: principal("member") }));
    const res = await switchTo("default");
    expect(res.status).toBe(200);
    expect((await readSession())?.principal.role).toBe("owner");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).not.toContain("profile=");
  });

  it("needs a signed-in session", async () => {
    jar.clear();
    expect((await switchTo("hr")).status).toBe(401);
    expect(asked).toEqual([]);
  });
});
