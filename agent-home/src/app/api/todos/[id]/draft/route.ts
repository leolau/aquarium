/**
 * GET/PATCH /api/todos/:id/draft — the work session's draft + reply, read and
 * edited live. PATCH persists edits (and amends the pending send proposal
 * when the reply changes) — mirrors `stage/route.ts` for principal + errors.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.todoDraft(id));
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "Couldn't reach the AI layer." },
      { status: 502 },
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    draft_text?: string;
    reply_text?: string;
  };
  if (body.draft_text === undefined && body.reply_text === undefined) {
    return NextResponse.json(
      { error: "invalid_request", detail: "Expected draft_text and/or reply_text." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.updateTodoDraft(id, body));
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "Couldn't reach the AI layer." },
      { status: 502 },
    );
  }
}
