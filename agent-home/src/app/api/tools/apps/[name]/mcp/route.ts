/**
 * /api/tools/apps/[name]/mcp — GET the app's MCP status; PUT {enabled} turns
 * its tools on or off for chats. Changes take effect in the next new chat.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function GET(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/mcp", { mode: call.mode })),
  );
}

export async function PUT(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const { enabled } = call.body;
  if (typeof enabled !== "boolean") return badRequest("bad_enabled", "enabled must be a boolean");
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/mcp"), {
      method: "PUT",
      json: { enabled, mode: call.mode },
    }),
  );
}
