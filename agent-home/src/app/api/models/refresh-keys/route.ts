/**
 * POST /api/models/refresh-keys — make saved provider keys take effect now:
 * reloads `.env` and clears the "this key failed" marks left by an old key.
 * Running chats pick the key up on their next message. Owners/admins only.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden", detail: ADMIN_ONLY_DENIED }, { status: 403 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.refreshProviderKeys());
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json({ error: "api_error", detail: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
