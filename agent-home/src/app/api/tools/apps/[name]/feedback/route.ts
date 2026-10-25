/** /api/tools/apps/[name]/feedback — POST {text}: feedback for the app's next build. */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";

export const FEEDBACK_MAX_CHARS = 4000;

export async function POST(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const text = typeof call.body.text === "string" ? call.body.text.trim() : "";
  if (!text || text.length > FEEDBACK_MAX_CHARS) {
    return badRequest("bad_text", `Write between 1 and ${FEEDBACK_MAX_CHARS} characters.`);
  }
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/feedback"), {
      method: "POST",
      json: { text, mode: call.mode },
    }),
  );
}
