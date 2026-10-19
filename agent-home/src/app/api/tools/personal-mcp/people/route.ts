/**
 * /api/tools/personal-mcp/people — owner/admin: how many own tools each
 * person has. Counts only: never names, addresses or keys.
 */
import { NextResponse } from "next/server";

import { proxy, unauthenticated } from "@/lib/api/personal-mcp-route";
import { getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  if (!canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return proxy((c) => c.personalMcpByPerson());
}
