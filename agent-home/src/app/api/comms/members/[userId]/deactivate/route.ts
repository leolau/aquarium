/**
 * POST /api/comms/members/{userId}/deactivate — suspend a member's enrolment in
 * **this profile** (owner/admin).
 *
 * Deliberately profile-local: the box-wide GoTrue account is left alone because
 * it may serve other profiles on the same Supabase, and banning it here would
 * lock somebody out of a profile this console has no authority over. The
 * principal row and everything it owns survive, so Restore is a one-click undo.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  try {
    return NextResponse.json(await gate.client.deactivateMember(userId));
  } catch (err) {
    return forwardMemberError(err);
  }
}
