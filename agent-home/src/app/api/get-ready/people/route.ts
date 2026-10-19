/**
 * /api/get-ready/people — each person's connection status (owner/admin only;
 * the Python route is admin-gated too). Status only, never secrets.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

import { forward } from "../_forward";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (principal && !canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return forward(async () => (await apiClientForRequest()).getReadyPeople());
}
