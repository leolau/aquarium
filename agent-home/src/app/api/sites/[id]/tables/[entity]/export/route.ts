/**
 * GET /api/sites/{id}/tables/{entity}/export?format=csv|xlsx — the table as a
 * download, streamed through from Hermes.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string; entity: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id, entity } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const format = (sp.get("format") ?? "csv").toLowerCase();
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format", detail: "format must be csv or xlsx." }, { status: 400 });
  }
  const includeRemoved = ["1", "true", "yes"].includes((sp.get("include_removed") ?? "").toLowerCase());
  try {
    const client = await apiClientForRequest();
    const upstream = await client.exportSiteTable(id, entity, format, includeRemoved);
    const headers = new Headers({ "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
    for (const name of ["content-type", "content-disposition", "content-length"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return hermesError(err);
  }
}
