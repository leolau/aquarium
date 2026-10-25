/** /api/tools/apps/[name]/visibility — PUT {visibility}: private or shared with members. */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function PUT(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const { visibility } = call.body;
  if (visibility !== "private" && visibility !== "shared") {
    return badRequest("bad_visibility", "visibility must be private or shared");
  }
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/visibility"), {
      method: "PUT",
      json: { visibility, mode: call.mode },
    }),
  );
}
