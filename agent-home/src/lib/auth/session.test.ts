import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type SetCall = { name: string; value: string; options: Record<string, unknown> };
const jar = new Map<string, string>();
const sets: SetCall[] = [];
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    has: (name: string) => jar.has(name),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      sets.push({ name, value, options });
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  })),
}));

import {
  clearSession,
  deserializeSession,
  LEGACY_SESSION_COOKIE,
  readSession,
  serializeSession,
  SESSION_COOKIE,
  writeSession,
  type AgentHomeSession,
} from "@/lib/auth/session";
import type { Principal } from "@/types";

const PRINCIPAL: Principal = {
  user_id: "u_alice",
  display: "Alice",
  role: "member",
  channels: [],
  is_owner: false,
};

const SESSION: AgentHomeSession = {
  hermesToken: "upstream-token-xyz",
  principal: PRINCIPAL,
  issuedAt: 1_700_000_000,
};

describe("agent-home session cookie", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });

  it("round-trips a signed session", () => {
    const cookie = serializeSession(SESSION);
    const parsed = deserializeSession(cookie);
    expect(parsed).toEqual(SESSION);
  });

  it("rejects a tampered payload", () => {
    const cookie = serializeSession(SESSION);
    const [payload, sig] = cookie.split(".");
    // Flip a byte in the payload; the HMAC must no longer verify.
    const tampered = `${payload}x.${sig}`;
    expect(deserializeSession(tampered)).toBeNull();
  });

  it("rejects a forged signature", () => {
    const [payload] = serializeSession(SESSION).split(".");
    expect(deserializeSession(`${payload}.deadbeef`)).toBeNull();
  });

  it("returns null for empty/garbage input", () => {
    expect(deserializeSession(undefined)).toBeNull();
    expect(deserializeSession("")).toBeNull();
    expect(deserializeSession("nodot")).toBeNull();
  });
});

describe("agent-home session cookie name (__Host- prefix, FG-33 P8-2 2.12)", () => {
  beforeAll(() => {
    process.env.AGENT_HOME_SESSION_SECRET = "test-secret-for-hmac";
  });
  beforeEach(() => {
    jar.clear();
    sets.length = 0;
  });

  const OTHER: AgentHomeSession = {
    ...SESSION,
    principal: { ...PRINCIPAL, user_id: "u_mallory" },
  };

  it("writes a __Host- cookie the browser only accepts host-wide and Secure", async () => {
    await writeSession(SESSION);
    expect(SESSION_COOKIE.startsWith("__Host-")).toBe(true);
    const set = sets.find((c) => c.name === SESSION_COOKIE)!;
    expect(set.options).toMatchObject({ httpOnly: true, secure: true, path: "/", sameSite: "lax" });
    expect(set.options).not.toHaveProperty("domain");
    expect(await readSession()).toEqual(SESSION);
  });

  it("keeps a pre-deploy legacy cookie signed in, and clears it on the next write", async () => {
    jar.set(LEGACY_SESSION_COOKIE, serializeSession(SESSION));
    expect(await readSession()).toEqual(SESSION);
    await writeSession(SESSION);
    expect(jar.has(LEGACY_SESSION_COOKIE)).toBe(false);
    expect(sets.find((c) => c.name === LEGACY_SESSION_COOKIE)?.options).toMatchObject({
      path: "/",
      maxAge: 0,
    });
    expect(await readSession()).toEqual(SESSION);
  });

  it("never lets a legacy-named cookie override the __Host- session", async () => {
    await writeSession(SESSION);
    jar.set(LEGACY_SESSION_COOKIE, serializeSession(OTHER));
    expect((await readSession())?.principal.user_id).toBe("u_alice");
  });

  it("logs out both names", async () => {
    await writeSession(SESSION);
    jar.set(LEGACY_SESSION_COOKIE, serializeSession(SESSION));
    await clearSession();
    expect(jar.size).toBe(0);
    expect(await readSession()).toBeNull();
  });
});
