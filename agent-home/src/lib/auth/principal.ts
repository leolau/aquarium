/**
 * Principal resolution for the C1 bridge (FG-20 Wave A2).
 *
 * Small server-side helpers that sit between the signed `agent-home` session
 * (`session.ts`) and the two consumers of a principal: the typed Python-API
 * client and the server-side Supabase context. Keeping resolution here means a
 * route handler or RSC never re-derives "who is this request" ad hoc.
 */
import "server-only";

import { redirect } from "next/navigation";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { readSession } from "@/lib/auth/session";
import type { Principal } from "@/types";

/** Return the current request's principal, or null if unauthenticated. */
export async function getPrincipal(): Promise<Principal | null> {
  const session = await readSession();
  return session?.principal ?? null;
}

/**
 * Return the current principal or redirect to `/login`. Use in RSC/route
 * handlers that require an authenticated principal.
 */
export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) {
    redirect("/login");
  }
  return principal;
}

/**
 * A Python-API client bound to the current request's bridged token and to a
 * profile (FG-28) so every call in that request — the turn and the reads
 * around it — addresses the same `HERMES_HOME`. Without an explicit
 * `profile` it is the session's profile; for `default` the client sends no
 * `?profile=` at all, so single-profile installs are unchanged.
 */
export async function apiClientForRequest(
  opts: { profile?: string } = {},
): Promise<HermesApiClient> {
  const session = await readSession();
  return new HermesApiClient({
    hermesToken: session?.hermesToken,
    profile: opts.profile ?? session?.profile,
  });
}

/**
 * Resolve a C1 principal from a freshly-obtained upstream Hermes token by
 * asking the Python API `whoami` (the authority on identity) in `profile`,
 * where the role is re-derived from that profile's own `principals`. Returns
 * null when the token doesn't map to an enrolled principal.
 */
export async function resolvePrincipalFromToken(
  hermesToken: string,
  profile?: string,
): Promise<Principal | null> {
  const client = new HermesApiClient({ hermesToken, profile });
  const res = await client.whoami();
  return res.configured ? res.principal : null;
}

/** Outcome of a login's identity step: enrolled, suspended, or neither. */
export type PrincipalResolution =
  | { kind: "principal"; principal: Principal }
  | { kind: "suspended" }
  | { kind: "none" };

/**
 * `resolvePrincipalFromToken`, separating a **suspended** enrolment from an
 * absent one.
 *
 * Both refuse the login, but they are different facts and the sign-in page has
 * to say which: the account and password are fine — they are shared box-wide and
 * may still work in another profile — and it is *this profile's* enrolment that
 * has been switched off. Reported as "no principal is enrolled" it reads as a
 * broken setup, and the person retries their password forever.
 */
export async function resolvePrincipalOrStatus(
  hermesToken: string,
  profile?: string,
): Promise<PrincipalResolution> {
  try {
    const principal = await resolvePrincipalFromToken(hermesToken, profile);
    return principal ? { kind: "principal", principal } : { kind: "none" };
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 403) {
      return { kind: "suspended" };
    }
    throw err;
  }
}
