/** /api/tools/apps/[name]/logs — GET ?mode&lines: a capped journal tail of a local app (FG-33 §7). */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export const LOG_LINES_DEFAULT = 200;
export const LOG_LINES_MAX = 1000;

export async function GET(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const raw = call.query.get("lines");
  const lines = raw === null || raw === "" ? LOG_LINES_DEFAULT : Number(raw);
  if (!Number.isInteger(lines) || lines < 1 || lines > LOG_LINES_MAX) {
    return badRequest("bad_lines", `lines must be a whole number from 1 to ${LOG_LINES_MAX}`);
  }
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/logs", { mode: call.mode, lines })),
  );
}
