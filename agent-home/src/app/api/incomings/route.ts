/**
 * GET /api/incomings — BFF listing of the unified inbox.
 *
 * Forwards to the Python `GET /api/registry/incomings` under the bridged C1
 * principal, which scopes the rows. Filters pass straight through; the cursor
 * is opaque and belongs to the client's scroll position, not to a shareable
 * filter URL.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

/** Only the three values the upstream knows; anything else means "any". */
function attentionParam(value: string | null): "open" | "cleared" | "any" | undefined {
  return value === "open" || value === "cleared" || value === "any" ? value : undefined;
}

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const remembered = params.get("remembered");
  const hasAttachments = params.get("has_attachments");
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.incomings({
        q: params.get("q") ?? undefined,
        surface: params.get("surface") ?? undefined,
        kind: params.get("kind") ?? undefined,
        sender: params.get("sender") ?? undefined,
        importance: params.get("importance") ?? undefined,
        tag: params.get("tag") ?? undefined,
        tag_match: params.get("tag_match") ?? undefined,
        exclude_tag: params.get("exclude_tag") ?? undefined,
        remembered: remembered == null ? undefined : remembered === "true",
        has_attachments:
          hasAttachments == null ? undefined : hasAttachments === "true",
        since: params.get("since") ?? undefined,
        until: params.get("until") ?? undefined,
        limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        cursor: params.get("cursor") ?? undefined,
        attention: attentionParam(params.get("attention")),
      }),
    );
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
