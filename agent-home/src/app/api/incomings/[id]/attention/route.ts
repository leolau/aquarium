/**
 * POST /api/incomings/:id/attention — Done / Dismiss a flagged arrival, or
 * reopen it (the Undo). Body `{action:"clear", outcome:"done"|"dismissed"}`
 * or `{action:"reopen"}`; returns the updated item. Only the item's owner may
 * write, which the Python API enforces (404 when the item is not visible).
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { IncomingAttentionAction } from "@/types";

function parseAction(body: unknown): IncomingAttentionAction | null {
  if (!body || typeof body !== "object") return null;
  const { action, outcome } = body as { action?: unknown; outcome?: unknown };
  if (action === "reopen") return { action: "reopen" };
  if (action === "clear" && (outcome === "done" || outcome === "dismissed")) {
    return { action: "clear", outcome };
  }
  return null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const action = parseAction(await req.json().catch(() => null));
  if (!action) {
    return NextResponse.json(
      {
        error: "invalid_request",
        detail: 'Send {"action":"clear","outcome":"done"|"dismissed"} or {"action":"reopen"}.',
      },
      { status: 400 },
    );
  }
  const { id } = await params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.setIncomingAttention(id, action));
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
