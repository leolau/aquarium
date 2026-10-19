/** /api/tools/personal-mcp/[name]/oauth/status — where your sign-in is. */
import type { NextResponse } from "next/server";

import { proxy, unauthenticated } from "@/lib/api/personal-mcp-route";
import { getPrincipal } from "@/lib/auth/principal";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  const { name } = await params;
  return proxy((c) => c.personalMcpOauth(name, "status"));
}
