/**
 * /api/tools/mcp/[name]/oauth/redirect — POST {url} feeds the pasted browser
 * redirect (the ?code=…&state=… the provider sent to the unreachable
 * 127.0.0.1 callback) into the waiting flow.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canManageTools, TOOLS_MANAGE_DENIED } from "@/lib/auth/roles";

export async function POST(
  request: Request,
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
  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!url) {
    return NextResponse.json(
      { error: "bad_url", detail: "url is required" },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.mcpOauthRedirect(name, url));
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
