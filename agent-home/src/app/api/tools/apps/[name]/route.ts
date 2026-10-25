/**
 * /api/tools/apps/[name] — GET one app (C2-scoped upstream); DELETE removes
 * it in a mode. DELETE is irreversible data loss, so it needs `?confirm=<name>`
 * (decision 9's one explicit confirmation; no approval step for members).
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, confirmMatches, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export async function GET(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "", { mode: call.mode })),
  );
}

export async function DELETE(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const refused = confirmMatches(call, call.query.get("confirm"));
  if (refused) return refused;
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "", { mode: call.mode, confirm: call.name }), {
      method: "DELETE",
    }),
  );
}
