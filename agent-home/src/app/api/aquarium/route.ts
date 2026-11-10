/**
 * GET /api/aquarium — the aquarium snapshot (FG-35): every active person as a
 * creature with their usage. Any signed-in person; Python marks `is_self`
 * from the session.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";

export async function GET(): Promise<NextResponse> {
  return withPrincipal((client) => client.aquariumSnapshot());
}
