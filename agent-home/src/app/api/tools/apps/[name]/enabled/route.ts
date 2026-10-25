/** /api/tools/apps/[name]/enabled — POST {enabled, mode?}: show or hide the app. */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function POST(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const { enabled } = call.body;
  if (typeof enabled !== "boolean") return badRequest("bad_enabled", "enabled must be a boolean");
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/enabled"), {
      method: "PUT",
      json: { enabled, mode: call.mode },
    }),
  );
}
