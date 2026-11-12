/**
 * GET /api/memory/projection — BFF projection map (FG-23 A1/A3).
 *
 * Forwards to the Python API `GET /api/memory/explorer/projection` under the
 * bridged C1 principal. The point set is deterministically sampled server-side
 * (§6) so the phone never receives megabytes of JSON. Deliberately does NOT
 * forward `mode` (FG-23 D3).
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
    const limitParam = sp.get("limit");
    const resp = await client.memoryProjection(
      limitParam ? Number(limitParam) : undefined,
      ownersParam(sp.get("owners")),
    );
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
