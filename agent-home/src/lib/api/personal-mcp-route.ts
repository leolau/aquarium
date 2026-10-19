/**
 * Shared bits for the `/api/tools/personal-mcp/**` BFF routes: each route
 * checks the sign-in itself, then hands the call to the Python API, which
 * scopes everything to the signed-in person (their own servers only).
 */
import { NextResponse } from "next/server";

import { HermesApiError, type HermesApiClient } from "@/lib/api/client";
import { apiClientForRequest } from "@/lib/auth/principal";

export function unauthenticated(): NextResponse {
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}

export async function proxy(
  call: (client: HermesApiClient) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await call(client));
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
