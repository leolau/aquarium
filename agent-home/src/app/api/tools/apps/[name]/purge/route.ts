/**
 * /api/tools/apps/[name]/purge — POST {mode?, confirm}: delete an archived
 * app's data for good. `confirm` must be the app's name (decision 9).
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, confirmMatches, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function POST(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const refused = confirmMatches(call, call.body.confirm);
  if (refused) return refused;
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/purge"), {
      method: "POST",
      json: { mode: call.mode, confirm: call.name },
    }),
  );
}
