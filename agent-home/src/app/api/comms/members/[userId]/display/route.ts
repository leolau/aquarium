/**
 * PUT /api/comms/members/{userId}/display — rename a user **within this
 * profile** (owner/admin). The box-wide account is untouched: a display name is
 * profile-local, so the same person can be "Mia (support)" here and "Mia"
 * elsewhere. Body: `{ display }`.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

interface DisplayBody {
  display?: unknown;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<NextResponse> {
  const gate = await requireMemberAdmin(request);
  if ("response" in gate) return gate.response;
  const { userId } = await params;
  let body: DisplayBody;
  try {
    body = (await request.json()) as DisplayBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const display = typeof body.display === "string" ? body.display.trim() : "";
  if (!display) {
    return NextResponse.json(
      { error: "invalid_input", detail: "A display name is required." },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(await gate.client.setMemberDisplay(userId, display));
  } catch (err) {
    return forwardMemberError(err);
  }
}
