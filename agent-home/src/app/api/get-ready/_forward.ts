import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { getPrincipal } from "@/lib/auth/principal";

/** Shared BFF wrapper: 401 without a login, upstream status passed through. */
export async function forward<T>(call: () => Promise<T>): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await call());
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
