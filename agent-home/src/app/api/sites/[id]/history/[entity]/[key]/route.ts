/**
 * GET /api/sites/{id}/history/{entity}/{key} — a row's change log (and, for
 * fixed content, its versions).
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string; entity: string; key: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id, entity, key } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.siteHistory(id, entity, key));
  } catch (err) {
    return hermesError(err);
  }
}

