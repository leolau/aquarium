/**
 * Shared plumbing for the owner/admin BFF routes behind the Profiles and
 * Skills pages. The BFF refuses members and viewers up front (403) so the
 * browser never fans a refused change out to Python; the Python layer's own
 * `_ADMIN` gate stays the authority and its errors are replayed as-is.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { ADMIN_ONLY_DENIED } from "@/lib/auth/roles";
import type { Principal } from "@/types";

/**
 * The 401 (not signed in) or 403 (member/viewer) refusal. Handlers call
 * `canAdminister(principal)` themselves so the route-roles check sees it:
 * `if (!principal || !canAdminister(principal)) return refuse(principal);`
 */
export function refuse(principal: Principal | null): NextResponse {
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({ error: "forbidden", detail: ADMIN_ONLY_DENIED }, { status: 403 });
}

/** Run an upstream call, mapping Hermes errors onto the BFF's error shape. */
export async function upstream<T>(
  call: () => Promise<T>,
  shape: (data: T) => unknown = (data) => data,
): Promise<NextResponse> {
  try {
    return NextResponse.json(shape(await call()));
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json({ error: "api_error", detail: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}

/** Parse a JSON object body, or null when it is missing or malformed. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const BAD_JSON = () => NextResponse.json({ error: "bad_json" }, { status: 400 });

export function badRequest(detail: string): NextResponse {
  return NextResponse.json({ error: "bad_request", detail }, { status: 400 });
}

export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
