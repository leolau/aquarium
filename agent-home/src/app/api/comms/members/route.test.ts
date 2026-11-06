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
import type { Principal, Role } from "@/types";

import { GET as directoryGET } from "../directory/route";
import { POST as invitePOST } from "./[userId]/invitation/route";
import { DELETE as memberDELETE } from "./[userId]/route";
import { GET, POST } from "./route";

const principal = (role: Role): Principal => ({
  user_id: "u1",
  display: "U",
  role,
  channels: [],
  is_owner: role === "owner",
});

// The Python authority: whoami?profile= answers from that profile's own
// principals. The caller is a member of default (the session's profile), an
// admin of hr, a viewer of ops, and not enrolled in finance.
const ENROLLED: Record<string, Role> = { default: "member", hr: "admin", ops: "viewer" };
const calls: { path: string; profile: string | null; body: unknown }[] = [];
const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
  const u = new URL(String(url));
  const profile = u.searchParams.get("profile");
  calls.push({
    path: u.pathname,
    profile,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  });
  if (u.pathname === "/api/comms/whoami") {
    const role = ENROLLED[profile ?? "default"];
    return role
      ? Response.json({ configured: true, principal: principal(role) })
      : Response.json({ detail: "Not enrolled in this profile" }, { status: 403 });
  }
  return Response.json({ configured: true, members: [], entries: [], total: 0, profile });
});

function signIn(profile = "default") {
  jar.set(
    SESSION_COOKIE,
    serializeSession({
      hermesToken: "tok",
      profile,
      principal: principal(ENROLLED[profile]),
      issuedAt: 1_700_000_000,
    }),
  );
}

const upstream = (path: string) => calls.filter((c) => c.path === path);

describe("member BFF — profile-aware gate (FG-28 C1)", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    calls.length = 0;
    vi.stubGlobal("fetch", fetchMock);
    signIn();
  });

  it("refuses a member of the session's profile without asking upstream", async () => {
    const res = await GET(new Request("http://x/api/comms/members"));
    expect(res.status).toBe(403);
    expect(upstream("/api/comms/members")).toHaveLength(0);
  });

  it("lets someone who is a member here but admin in hr list hr, forwarding ?profile", async () => {
    const res = await GET(new Request("http://x/api/comms/members?profile=hr&limit=5"));
    expect(res.status).toBe(200);
    expect(upstream("/api/comms/whoami").map((c) => c.profile)).toEqual(["hr"]);
    expect(upstream("/api/comms/members").map((c) => c.profile)).toEqual(["hr"]);
  });

  it("refuses ?profile= where the caller is not an admin, or not enrolled", async () => {
    for (const profile of ["ops", "finance"]) {
      const res = await GET(new Request(`http://x/api/comms/members?profile=${profile}`));
      expect(res.status).toBe(403);
    }
    expect(upstream("/api/comms/members")).toHaveLength(0);
  });

  it("gates a per-user mutation on the role in the named profile", async () => {
    const ctx = { params: Promise.resolve({ userId: "p9" }) };
    const ok = await invitePOST(
      new Request("http://x/api/comms/members/p9/invitation?profile=hr", { method: "POST" }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(upstream("/api/comms/members/p9/invitation").map((c) => c.profile)).toEqual(["hr"]);
    const refused = await invitePOST(
      new Request("http://x/api/comms/members/p9/invitation?profile=ops", { method: "POST" }),
      ctx,
    );
    expect(refused.status).toBe(403);
  });

  it("creates in the named profile, sending it as both scope and form value", async () => {
    const res = await POST(
      new Request("http://x/api/comms/members?profile=hr", {
        method: "POST",
        body: JSON.stringify({ email: "n@x.io", profile: "hr", role: "member" }),
      }),
    );
    expect(res.status).toBe(200);
    const [create] = calls.filter((c) => c.path === "/api/comms/members");
    expect(create.profile).toBe("hr");
    expect(create.body).toMatchObject({ email: "n@x.io", profile: "hr" });
  });

  it("refuses a create whose query and body name different profiles", async () => {
    const res = await POST(
      new Request("http://x/api/comms/members?profile=hr", {
        method: "POST",
        body: JSON.stringify({ email: "n@x.io", profile: "default" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(upstream("/api/comms/members")).toHaveLength(0);
  });

  it("addresses default explicitly from a session working in hr", async () => {
    signIn("hr");
    const res = await GET(new Request("http://x/api/comms/members?profile=default"));
    // A member of default: the session's hr admin role does not carry across.
    expect(res.status).toBe(403);
    expect(upstream("/api/comms/whoami").map((c) => c.profile)).toEqual([null]);
  });

  it("keeps hard delete owner-only in the named profile", async () => {
    const res = await memberDELETE(
      new Request("http://x/api/comms/members/p9?strategy=purge&profile=hr", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ userId: "p9" }) },
    );
    expect(res.status).toBe(403);
    expect(upstream("/api/comms/members/p9")).toHaveLength(0);
  });

  it("reads the directory of a profile only where the caller is enrolled", async () => {
    expect((await directoryGET(new Request("http://x/api/comms/directory?profile=ops"))).status).toBe(200);
    expect(upstream("/api/comms/directory").map((c) => c.profile)).toEqual(["ops"]);
    expect(
      (await directoryGET(new Request("http://x/api/comms/directory?profile=finance"))).status,
    ).toBe(403);
  });
});
