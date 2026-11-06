/**
 * GET /api/chat/profiles — the profiles the signed-in account may chat in
 * (FG-28 D3).
 *
 * Feeds the chat profile picker. Each profile is an independent `HERMES_HOME`,
 * so choosing one changes which brain answers the turn. The list is the
 * account's *active* enrolments from the Python API
 * (`GET /api/auth/my-profiles`) — never every profile the box serves, and
 * never a hard-coded name. Python re-checks enrolment on every chat call; this
 * only keeps the picker honest.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { activeEnrolments } from "@/lib/api/my-profiles";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest();
    // Only what the picker needs — a profile's model, credentials and paths are
    // operator information and stay in the dashboard.
    const profiles = activeEnrolments(await client.myProfiles());
    return NextResponse.json({ profiles });
  } catch (err) {
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
}
