/**
 * GET /api/comms/directory — the colleague list, readable by **every enrolled
 * principal** (FG-26 §3.1), not just owner/admin.
 *
 * A member who cannot see who else is in the profile cannot address or delegate
 * to them, so this deliberately has a weaker gate than the management routes —
 * and a correspondingly narrower payload: no email, no ban state, no invitation
 * lifecycle. Upstream builds it from this profile's `principals`, never from the
 * box-wide account table, so it cannot expose people enrolled elsewhere.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireEnrolled } from "@/lib/api/member-bff";

export async function GET(request: Request): Promise<NextResponse> {
  const gate = await requireEnrolled(request);
  if ("response" in gate) return gate.response;
  const params = new URL(request.url).searchParams;
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  const offset = Number.parseInt(params.get("offset") ?? "", 10);
  try {
    return NextResponse.json(
      await gate.client.directory({
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
        q: (params.get("q") ?? "").trim() || undefined,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
