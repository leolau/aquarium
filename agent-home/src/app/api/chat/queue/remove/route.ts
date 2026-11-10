/**
 * POST /api/chat/queue/remove — drop a message queued on a running turn
 * before it starts. Body: `{ sessionId, runId, itemId, profile? }`. Forwards
 * to the Python `POST /api/sessions/{id}/chat/stream/queue/remove`, which
 * answers `{ removed }` (false once the item has started).
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromBody } from "@/lib/chat/profile";

interface RemoveBody {
  sessionId?: unknown;
  runId?: unknown;
  itemId?: unknown;
  profile?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json(
      { error: "unauthenticated", detail: "Sign in to continue." },
      { status: 401 },
    );
  }
  let body: RemoveBody;
  try {
    body = (await request.json()) as RemoveBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "Malformed request body." },
      { status: 400 },
    );
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const runId = typeof body.runId === "string" ? body.runId : "";
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  if (!sessionId || !runId || !itemId) {
    return NextResponse.json(
      { error: "missing_ids", detail: "sessionId, runId and itemId are required." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const resp = await client.removeQueuedChatInput(sessionId, runId, itemId);
    return NextResponse.json({ removed: Boolean(resp?.removed) });
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
