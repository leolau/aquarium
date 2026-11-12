/**
 * GET /api/files — BFF listing of the inbound file registry.
 *
 * Forwards to the Python API `GET /api/registry/files` under the bridged C1
 * principal, which scopes the rows. Note the upstream path differs: `/api/files`
 * on the Python side is the dashboard's filesystem browser, an unrelated thing.
 */
import { NextResponse } from "next/server";

import { HermesApiError, ownersParam } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const remembered = params.get("remembered");
  try {
    const client = await apiClientForRequest();
    const resp = await client.files({
      q: params.get("q") ?? undefined,
      surface: params.get("surface") ?? undefined,
      remembered: remembered == null ? undefined : remembered === "true",
      owners: ownersParam(params.get("owners")),
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
      offset: params.get("offset") ? Number(params.get("offset")) : undefined,
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
