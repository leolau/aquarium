/**
 * PATCH /api/chat/sessions/rename — BFF rename a conversation (FG-20 Wave C1).
 * Forwards `{ sessionId, title }` to the Python API `PATCH /api/sessions/{id}`
 * under the bridged C1 principal. An empty title clears the name; a duplicate
 * title is rejected upstream with 400.
 *
 * GET /api/chat/sessions/rename?sessionId=&profile= — read one conversation's
 * current title, so a client can pick up the agent's auto-title (written a few
 * seconds after the first reply) without re-reading the whole list.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromBody, profileFromUrl } from "@/lib/chat/profile";
import type { SessionTitleResponse } from "@/types/landing";

function upstreamError(err: unknown): NextResponse {
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

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(req.url) });
    const row = await client.request<{ id?: string; title?: string | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
    );
    const body: SessionTitleResponse = {
      session_id: row?.id ?? sessionId,
      title: row?.title || null,
    };
    return NextResponse.json(body);
  } catch (err) {
    return upstreamError(err);
  }
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { sessionId?: unknown; title?: unknown };
  try {
    body = (await req.json()) as { sessionId?: unknown; title?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const title = typeof body.title === "string" ? body.title : "";
  if (!sessionId) {
    return NextResponse.json({ error: "missing_session" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest({ profile: profileFromBody(body) });
    const data = await client.renameSession(sessionId, title);
    return NextResponse.json(data);
  } catch (err) {
    return upstreamError(err);
  }
}
