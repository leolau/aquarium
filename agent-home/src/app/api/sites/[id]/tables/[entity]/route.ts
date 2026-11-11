/**
 * GET /api/sites/{id}/tables/{entity}?q=&page=&page_size=&include_removed= — one
 * page of a table, read under the site's read-only role.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string; entity: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id, entity } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.siteTableRows(id, entity, {
        q: sp.get("q") ?? undefined,
        page: num(sp.get("page")),
        page_size: num(sp.get("page_size")),
        include_removed: ["1", "true", "yes"].includes((sp.get("include_removed") ?? "").toLowerCase()),
      }),
    );
  } catch (err) {
    return hermesError(err);
  }
}
