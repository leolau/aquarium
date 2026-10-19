/** POST /api/google-client/test — ask Google if the saved client is accepted (**owner only**). */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function POST(): Promise<NextResponse> {
  const gate = await requireMemberOwner();
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.testGoogleClient());
  } catch (err) {
    return forwardMemberError(err);
  }
}
