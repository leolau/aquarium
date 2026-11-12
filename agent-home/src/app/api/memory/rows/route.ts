/**
 * GET /api/memory/rows — BFF memory rows (FG-23 A1).
 *
 * Forwards to the Python API `GET /api/memory/explorer/rows` under the bridged
 * C1 principal, returning the C2-scoped rows (paginated + semantic search).
 * Deliberately does NOT forward `mode` (FG-23 D3).
 */
import { NextResponse } from "next/server";

import { HermesApiError, ownersParam } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest();
    const sp = new URL(req.url).searchParams;
    const resp = await client.memoryRows({
      q: sp.get("q") || undefined,
      topic: sp.get("topic") || undefined,
      kind: sp.get("kind") || undefined,
      owners: ownersParam(sp.get("owners")),
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      offset: sp.get("offset") ? Number(sp.get("offset")) : undefined,
    });
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
