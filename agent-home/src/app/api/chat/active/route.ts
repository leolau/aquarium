/**
 * GET /api/chat/active?sessionId=… — the in-flight turn for a session, if
 * any. A reloaded page asks this first and re-attaches to the stream so a
 * prompt that is still running keeps flowing after the reload. `pending`
 * lists messages sent while it works that have not reached the model yet,
 * so the reloaded composer redraws their chips.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";
import { pendingFromActive } from "@/lib/chat/pending-inputs";

export async function GET(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json(
      { error: "missing_session", detail: "sessionId is required" },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    const data = await client.activeChatRun(sessionId);
    const pending = pendingFromActive(
      (data.pending ?? []).map((p) => ({ itemId: p?.item_id, mode: p?.mode, text: p?.text })),
    );
    return NextResponse.json({ runId: data.run_id, pending });
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
