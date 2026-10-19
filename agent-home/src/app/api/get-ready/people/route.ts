/**
 * /api/get-ready/people — each person's connection status (owner/admin only;
 * the Python route is admin-gated). Status only, never secrets.
 */
import type { NextResponse } from "next/server";

import { apiClientForRequest } from "@/lib/auth/principal";

import { forward } from "../_forward";

export async function GET(): Promise<NextResponse> {
  return forward(async () => (await apiClientForRequest()).getReadyPeople());
}
