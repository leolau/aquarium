/**
 * /api/tools/apps/[name]/icon — PUT the app's icon: a generated monogram or
 * emoji on a palette colour, an uploaded `file_assets` id, or the favicon.
 */
import { NextResponse } from "next/server";

import { withPrincipal } from "@/app/api/projects/hermes-bridge";
import { appCall, badRequest, toolPath, type AppCtx } from "@/app/api/tools/apps/bridge";
import { isAppIconColor } from "@/components/tools/appIconColor";

const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function PUT(request: Request, ctx: AppCtx): Promise<NextResponse> {
  const call = await appCall(request, ctx);
  if (call instanceof NextResponse) return call;
  const { icon_source: source, icon, icon_color: color, icon_asset_id: assetId } = call.body;
  const json: Record<string, unknown> = { icon_source: source, mode: call.mode };
  if (source === "generated") {
    if (typeof icon !== "string" || [...icon.trim()].length === 0 || [...icon.trim()].length > 2) {
      return badRequest("bad_icon", "Use one or two letters or one emoji.");
    }
    if (color !== undefined && !isAppIconColor(color)) {
      return badRequest("bad_icon_color", "Pick one of the listed colours.");
    }
    json.icon = icon.trim();
    if (color !== undefined) json.icon_color = color;
  } else if (source === "uploaded") {
    if (typeof assetId !== "string" || !ASSET_ID_RE.test(assetId)) {
      return badRequest("bad_icon_asset", "icon_asset_id must be a file id");
    }
    json.icon_asset_id = assetId;
  } else if (source !== "favicon") {
    return badRequest("bad_icon_source", "icon_source must be generated, uploaded or favicon");
  }
  return withPrincipal((client) =>
    client.request(toolPath(call.name, "/icon"), { method: "PUT", json }),
  );
}
