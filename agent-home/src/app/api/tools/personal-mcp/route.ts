/**
 * /api/tools/personal-mcp — the signed-in person's own MCP servers.
 * GET lists them (only theirs), POST adds one.
 */
import type { NextResponse } from "next/server";

import type { HermesApiClient } from "@/lib/api/client";
import { proxy, unauthenticated } from "@/lib/api/personal-mcp-route";
import { getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  return proxy((c) => c.personalMcpServers());
}

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) return unauthenticated();
  const body = (await req.json().catch(() => ({}))) as Parameters<
    HermesApiClient["addPersonalMcpServer"]
  >[0];
  return proxy((c) => c.addPersonalMcpServer(body));
}
