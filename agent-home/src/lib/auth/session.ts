/**
 * `agent-home` server-side session — the C1 principal bridge (FG-20 Wave A2,
 * Decision 1 = BRIDGE, not GoTrue).
 *
 * We do NOT adopt Supabase Auth/GoTrue for `agent-home`. Instead the app
 * *bridges* the existing `hermes_cli/dashboard_auth` login: the login route
 * authenticates the user against the Python API, captures the upstream Hermes
 * session token, resolves the user's C1 principal, and stores both in a
 * signed, HttpOnly `agent-home` session cookie. Thereafter:
 *   - the typed Python-API client replays the upstream token so `/api/*` calls
 *     are authenticated exactly as the dashboard's are; and
 *   - the server-side Supabase context binds the stored principal into the
 *     `hermes.principal_*` GUCs so Postgres RLS scopes reads.
 *
 * The cookie is signed with an HMAC (Node `crypto`, no external dep) so a
 * tampered payload is rejected. It is NOT encrypted — it carries an opaque
 * upstream token (already a bearer secret behind HttpOnly) and the principal
 * snapshot, never a password.
 */
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { sessionSecret } from "@/lib/env";
import type { Principal } from "@/types";

/**
 * `__Host-` makes the browser accept this cookie only with `Secure`, `Path=/`
 * and no `Domain`, so a local app under `/apps/*` (same origin, FG-33
 * decision 4) cannot plant a path- or domain-scoped cookie of the same name
 * that shadows it. Browsers treat `http://localhost` as secure, so `next dev`
 * still works there.
 */
export const SESSION_COOKIE = "__Host-agent_home_session";

/**
 * Pre-`__Host-` name. Still read so a deploy logs nobody out; every write or
 * logout clears it. Drop after one release (the cookie lives 12 h).
 */
export const LEGACY_SESSION_COOKIE = "agent_home_session";

/** Max cookie lifetime; the upstream token's own TTL is the real authority. */
const MAX_AGE_SECONDS = 12 * 60 * 60;

/**
 * The payload stored (signed) in the session cookie.
 *  - `hermesToken`: the upstream Hermes access token replayed to `/api/*`.
 *  - `principal`: the resolved C1 principal snapshot bound into the RLS GUCs.
 */
export interface AgentHomeSession {
  hermesToken: string;
  principal: Principal;
  /** Unix seconds when this session was minted. */
  issuedAt: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function sign(payload: string): string {
  return b64url(createHmac("sha256", sessionSecret()).update(payload).digest());
}

/** Serialise + sign a session into the cookie value `<payload>.<sig>`. */
export function serializeSession(session: AgentHomeSession): string {
  const payload = b64url(JSON.stringify(session));
  return `${payload}.${sign(payload)}`;
}

/** Verify + parse a cookie value; returns null on any tampering/format error. */
export function deserializeSession(value: string | undefined): AgentHomeSession | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(payload).toString("utf8"));
    if (
      typeof parsed?.hermesToken === "string" &&
      parsed?.principal?.user_id &&
      typeof parsed.principal.role === "string"
    ) {
      return parsed as AgentHomeSession;
    }
    return null;
  } catch {
    return null;
  }
}

type CookieReader = { get(name: string): { value: string } | undefined };

/** The session cookie value: the `__Host-` cookie wins whenever it is present. */
export function sessionCookieValue(store: CookieReader): string | undefined {
  return store.get(SESSION_COOKIE)?.value ?? store.get(LEGACY_SESSION_COOKIE)?.value;
}

const COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", secure: true, path: "/" } as const;

function expireLegacyCookie(store: Awaited<ReturnType<typeof cookies>>): void {
  store.set(LEGACY_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

/** Read + verify the current request's session (or null if unauthenticated). */
export async function readSession(): Promise<AgentHomeSession | null> {
  const store = await cookies();
  return deserializeSession(sessionCookieValue(store));
}

/** Set the signed session cookie on the response (via `next/headers`). */
export async function writeSession(session: AgentHomeSession): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, serializeSession(session), {
    ...COOKIE_OPTIONS,
    maxAge: MAX_AGE_SECONDS,
  });
  if (store.has(LEGACY_SESSION_COOKIE)) expireLegacyCookie(store);
}

/** Clear the session cookie (logout). */
export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...COOKIE_OPTIONS, maxAge: 0 });
  expireLegacyCookie(store);
}
