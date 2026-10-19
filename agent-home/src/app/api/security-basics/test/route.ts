/**
 * POST /api/security-basics/test — run the read-only server security checks now.
 *
 * Owner/admin only (checked here and again by Hermes). A second press while a
 * check is running comes back as Hermes's 409.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";

export async function POST(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden", detail: ADMIN_ONLY_DENIED }, { status: 403 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.testSecurityBasics());
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
