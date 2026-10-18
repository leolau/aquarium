/**
 * /api/tools/toolsets/[name] — POST {enabled} turns a tool group on/off for
 * Aquarium chats (`platform_toolsets.api_server`, the platform
 * `build_session_agent` uses). Applies to new chats only.
 */
import { NextResponse } from "next/server";

import { CHAT_TOOLSET_PLATFORM, HermesApiError } from "@/lib/api/client";
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
  let body: { enabled?: boolean; platform?: string };
  try {
    body = (await request.json()) as { enabled?: boolean; platform?: string };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "bad_enabled", detail: "enabled must be a boolean" },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.setToolsetEnabled(
        name,
        body.enabled,
        typeof body.platform === "string" && body.platform
          ? body.platform
          : CHAT_TOOLSET_PLATFORM,
      ),
    );
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
