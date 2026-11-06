/**
 * GET /api/comms/members/activity — recent identity-administration events
 * (owner/admin).
 *
 * Reads the C5 change log rather than a private table, so this view and
 * `hermes changes` agree on what happened. No raw invitation token is ever part
 * of a C5 payload, so nothing here can be replayed into an account takeover.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

export async function GET(request: Request): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const raw = Number.parseInt(
    new URL(request.url).searchParams.get("limit") ?? "",
    10,
  );
  try {
    return NextResponse.json(
      await gate.client.memberActivity(
        Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50,
      ),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
