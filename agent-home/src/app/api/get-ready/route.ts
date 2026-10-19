/** /api/get-ready — BFF for the Get ready checklist (Settings → Get ready). */
import type { NextResponse } from "next/server";

import { apiClientForRequest } from "@/lib/auth/principal";

import { forward } from "./_forward";

export async function GET(): Promise<NextResponse> {
  return forward(async () => (await apiClientForRequest()).getReady());
}
