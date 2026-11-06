/**
 * Activation links for one user (owner/admin).
 *
 * - `POST`   → mint or **regenerate** a link. The raw token is returned exactly
 *   once and stored only as a hash, so a lost or expired link is regenerated,
 *   never recovered; minting revokes any previous open link for that user.
 * - `DELETE` → revoke every open link, for when one went to the wrong address.
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
    return NextResponse.json(await gate.client.issueMemberInvitation(userId));
  } catch (err) {
    return forwardMemberError(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  try {
    return NextResponse.json(await gate.client.revokeMemberInvitation(userId));
  } catch (err) {
    return forwardMemberError(err);
  }
}
