/**
 * Shared server-side helpers for the member-management BFF routes (PR-4).
 *
 * The owner/admin gate and the upstream-error mapping are identical across the
 * five `/api/comms/members[...]` handlers, so they live here. This is a
 * *server-side* authorization check for a clean UX — the Python layer enforces
 * the same guard independently as the authority. No browser code and no
 * service-role key ever touch this path.
 */
import "server-only";

import { NextResponse } from "next/server";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { readSession } from "@/lib/auth/session";
import { explicitProfile, explicitProfileFromUrl } from "@/lib/profile";
import type { Role } from "@/types";

/** A gate's outcome: a client bound to the target profile, or the refusal. */
export type MemberGate =
  | { client: HermesApiClient; profile: string }
  | { response: NextResponse };

/** Which profile a members request addresses (FG-28 C1). */
export interface MemberTarget {
  /**
   * An explicit profile (create/import read it off the body). Without one,
   * `?profile=` on the request decides, and without that the session's.
   */
  profile?: string;
}

const isAdmin = (role: Role) => role === "owner" || role === "admin";

/**
 * The caller's role in `target`, re-derived where the session cannot vouch.
 *
 * The session's principal is the snapshot for the session's profile only
 * (authority is profile-local), so for any other profile — the Users screen's
 * admin switcher — the role is whatever Python's `whoami?profile=` answers
 * from that profile's own `principals`: not enrolled or suspended there is a
 * 403, never the session role carried across.
 */
async function gate(
  request: Request | undefined,
  target: MemberTarget,
  allowed: (role: Role) => boolean,
  forbidden: () => NextResponse,
): Promise<MemberGate> {
  const named =
    explicitProfile(target.profile) ??
    (request ? explicitProfileFromUrl(request.url) : undefined);
  const session = named ? await readSession() : null;
  if (!named || (session && named === session.profile)) {
    // The session's own profile: its principal snapshot is the role there.
    const principal = session?.principal ?? (await getPrincipal());
    if (!principal) {
      return { response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
    }
    if (!allowed(principal.role)) return { response: forbidden() };
    const client = await apiClientForRequest(named ? { profile: named } : {});
    return { client, profile: named ?? session?.profile ?? "default" };
  }
  if (!session) {
    return { response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  const profile = named;
  const client = await apiClientForRequest({ profile });
  let role: Role;
  try {
    const answer = await client.whoami();
    if (!answer.configured || !answer.principal) {
      return { response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    }
    role = answer.principal.role;
  } catch (err) {
    if (err instanceof HermesApiError && (err.status === 403 || err.status === 409)) {
      return {
        response: NextResponse.json({ error: "forbidden", detail: err.message }, { status: 403 }),
      };
    }
    return { response: forwardMemberError(err) };
  }
  if (!allowed(role)) return { response: forbidden() };
  return { client, profile };
}

/**
 * Resolve an owner/admin API client for the request's profile, or a
 * `NextResponse` carrying the right status (401 unauthenticated, 403 not
 * owner/admin *in that profile*). Callers branch on `"client" in gate`.
 */
export async function requireMemberAdmin(
  request?: Request,
  target: MemberTarget = {},
): Promise<MemberGate> {
  return gate(request, target, isAdmin, () =>
    NextResponse.json({ error: "forbidden" }, { status: 403 }),
  );
}

/**
 * Resolve an **owner-only** API client, or a `NextResponse` with the right
 * status. FG-26 keeps account-level operations (hard delete) owner-only: the
 * doc's finer rule — "the target is enrolled solely in profiles the actor
 * administers" — cannot be evaluated from one profile's process at all, since
 * FG-27 fail-closes a cross-profile read, so the console does not approximate
 * it. Python enforces the same guard independently.
 */
export async function requireMemberOwner(
  detail = "Only the owner can delete a user: the account is box-wide and " +
    "may serve other profiles.",
  request?: Request,
): Promise<MemberGate> {
  return gate(
    request,
    {},
    (role) => role === "owner",
    () => NextResponse.json({ error: "forbidden", detail }, { status: 403 }),
  );
}

/**
 * Resolve a client for **any enrolled principal** — the directory's gate. A
 * member who cannot see who else is in the profile cannot delegate to them, so
 * this read is deliberately not owner/admin-only. It still requires a session
 * (the roster is not public) and, for a profile other than the session's, an
 * enrolment there.
 */
export async function requireEnrolled(request?: Request): Promise<MemberGate> {
  return gate(request, {}, () => true, () =>
    NextResponse.json({ error: "forbidden" }, { status: 403 }),
  );
}

/**
 * The profile a create/import addresses: `?profile=` and the body's `profile`
 * must agree when both are present (one is the scope, the other what Python
 * compares it with); either alone names it. Undefined when neither does.
 */
export function bodyTarget(
  request: Request,
  bodyProfile: unknown,
): { profile?: string } | { response: NextResponse } {
  const query = explicitProfileFromUrl(request.url);
  const body = explicitProfile(bodyProfile);
  if (query && body && query !== body) {
    return {
      response: NextResponse.json(
        {
          error: "profile_mismatch",
          detail: `The request names ${query} but the form names ${body}.`,
        },
        { status: 400 },
      ),
    };
  }
  return { profile: query ?? body };
}

/** Map an upstream failure onto the BFF's error envelope + status. */
export function forwardMemberError(err: unknown): NextResponse {
  if (err instanceof HermesApiError) {
    return NextResponse.json(
      { error: "api_error", detail: err.message },
      { status: err.status },
    );
  }
  return NextResponse.json(
    { error: "api_unreachable", detail: "The AI layer could not be reached." },
    { status: 502 },
  );
}
