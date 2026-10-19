/** PUT /api/google-client/steps — store the owner's ticks for Google step A (**owner only**). */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function PUT(request: Request): Promise<NextResponse> {
  const gate = await requireMemberOwner();
  if ("response" in gate) return gate.response;
  let steps: unknown;
  try {
    steps = ((await request.json()) as { steps?: unknown }).steps;
  } catch {
    steps = undefined;
  }
  if (!steps || typeof steps !== "object") {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_steps" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await gate.client.saveGoogleClientSteps(steps as Record<string, boolean>),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
