/**
 * GET /api/models/pinned — cards whose `model_override` pins them to a
 * model other than whatever the slots say. One upstream call
 * (`/api/registry/projects/pinned-models`) gathers them across the
 * caller's readable projects; a per-project board fan-out from here
 * exhausted the datastore pool and took ~25 s.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    const { pinned } = await client.projectsPinnedModels();
    return NextResponse.json({ pinned });
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
