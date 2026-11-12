/**
 * POST /api/memory/query — BFF query placement (FG-23 A1/A4).
 *
 * Forwards `{ text }` to the Python API
 * `POST /api/memory/explorer/projection/query` under the bridged C1 principal.
 * The typed query is never persisted upstream (FG-22 embeds and discards it).
 * Deliberately does NOT forward `mode` (FG-23 D3).
 */
import { NextRequest, NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json(
        { error: "bad_request", detail: "`text` is required" },
        { status: 400 },
      );
    }
    const client = await apiClientForRequest();
    // Nearest points come from the same people as the map ("Whose data").
    const owners = Array.isArray(body?.owners)
      ? (body.owners as unknown[]).filter((o): o is string => typeof o === "string")
      : undefined;
    const resp = await client.memoryQuery(text, owners);
    return NextResponse.json(resp);
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
