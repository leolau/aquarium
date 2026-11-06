/**
 * POST /api/comms/members/{userId}/activate — restore a suspended enrolment in
 * **this profile** (owner/admin).
 *
 * The counterpart to `/deactivate`, and equally profile-local: it does not touch
 * the box-wide account, so it cannot open an account that is locked because it
 * was never activated. That one needs an invitation link.
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
    return NextResponse.json(await gate.client.activateMember(userId));
  } catch (err) {
    return forwardMemberError(err);
  }
}
