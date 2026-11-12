/**
 * GET /api/access/viewable-people — whose data the caller may pick in "Whose
 * data" (FG-38 P4). Python decides from the caller's role and
 * `memory.sharing.role_reads`; every read still re-checks scope and RLS.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import type { ViewablePeople } from "@/lib/whose-data";

export async function GET(): Promise<NextResponse> {
  return withPrincipal((client) => client.request<ViewablePeople>("/api/access/viewable-people"));
}
