/**
 * POST /api/chat/pin-suggestions/dismiss — body `DismissPinSuggestionsRequest`
 * `{ sessionIds, profile? }`. Dismissed suggestions never come back.
 */
import { NextResponse } from "next/server";

import { readJson, withPinClient } from "@/app/api/chat/pin-bff";
import { profileFromBody } from "@/lib/chat/profile";

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const ids = Array.isArray(body.sessionIds)
    ? body.sessionIds.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "missing_sessions" }, { status: 400 });
  }
  return withPinClient(profileFromBody(body), (client) =>
    client.dismissPinSuggestions(ids.slice(0, 100)),
  );
}
