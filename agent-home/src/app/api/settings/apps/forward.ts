/**
 * Shared proxy for Settings -> App limits / App storage / GitHub token
 * (FG-33 P8-2 2.10). Each route checks owner/admin itself (route-roles);
 * Python re-checks and is the authority.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { Principal } from "@/types";

export type Gate = (principal: Pick<Principal, "role" | "is_owner">) => boolean;

export async function gate(allowed: Gate): Promise<NextResponse | null> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!allowed(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: "Only the owner or an admin can change app settings." },
      { status: 403 },
    );
  }
  return null;
}

export async function readObject(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return NextResponse.json({ error: "bad_json" }, { status: 400 });
}

export function badBody(detail: string): NextResponse {
  return NextResponse.json({ error: "bad_body", detail }, { status: 400 });
}

export async function forward<T>(
  path: string,
  method: "GET" | "PUT" | "DELETE",
  json?: unknown,
  shape: (data: T) => unknown = (d) => d,
): Promise<NextResponse> {
  try {
    const client = await apiClientForRequest();
    const data = await client.request<T>(path, json === undefined ? { method } : { method, json });
    return NextResponse.json(shape(data));
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
