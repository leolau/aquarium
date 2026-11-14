/** GET /api/data/sources — the data sources the caller may see (Hermes filters). */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    return NextResponse.json(await (await apiClientForRequest()).dataSources());
  } catch (err) {
    return hermesError(err);
  }
}
