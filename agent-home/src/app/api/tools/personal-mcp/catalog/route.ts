/** /api/tools/personal-mcp/catalog — catalog servers a person can add for themselves. */
import type { NextResponse } from "next/server";

import { proxy, unauthenticated } from "@/lib/api/personal-mcp-route";
import { getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  return proxy((c) => c.personalMcpCatalog());
}
