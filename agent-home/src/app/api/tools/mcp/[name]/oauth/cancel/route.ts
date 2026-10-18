/**
 * /api/tools/mcp/[name]/oauth/cancel — POST aborts a waiting flow (drops an
 * error redirect so the callback poller exits fast rather than timing out).
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canManageTools, TOOLS_MANAGE_DENIED } from "@/lib/auth/roles";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canManageTools(principal)) {
    return NextResponse.json(
      { error: "forbidden", detail: TOOLS_MANAGE_DENIED },
      { status: 403 },
    );
  }
  const { name } = await params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.mcpOauthCancel(name));
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
