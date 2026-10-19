/** /api/tools/personal-mcp/[name]/oauth/redirect — sign-in for one of your own servers. */
import type { NextResponse } from "next/server";

import { proxy, unauthenticated } from "@/lib/api/personal-mcp-route";
import { getPrincipal } from "@/lib/auth/principal";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  const { name } = await params;
  const body = (await req.json().catch(() => ({}))) as { url?: string };
  return proxy((c) => c.personalMcpOauth(name, "redirect", body.url));
}
