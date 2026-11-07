/**
 * GET /api/comms/people/{userId}/profiles — one person's enrolment in each
 * profile the signed-in account administers (the Users screen's "Profiles &
 * roles" panel).
 *
 * Box-wide on the Python side (never bound to the session's profile): Python
 * lists only profiles where the caller holds an active owner/admin row, so
 * nothing is said about profiles the caller cannot administer, and a caller
 * who administers nothing gets an empty list. Every add / re-role / remove goes
 * through `/api/comms/members*?profile=`, which re-checks the role there.
 */
import { NextResponse } from "next/server";

import { forwardMemberError } from "@/lib/api/member-bff";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { userId } = await params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.personProfiles(userId));
  } catch (err) {
    return forwardMemberError(err);
  }
}
