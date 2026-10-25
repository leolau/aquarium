/** /api/tools/apps/[name]/restart — POST {mode?}: restart the app's instance (FG-33 §7). */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function POST(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/restart"), {
      method: "POST",
      json: { mode: call.mode },
    }),
  );
}
