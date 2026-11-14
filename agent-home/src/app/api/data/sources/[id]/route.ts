/** GET /api/data/sources/{id} — the approved dictionary (and the draft for proposers). */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await (await apiClientForRequest()).dataSource(id));
  } catch (err) {
    return hermesError(err);
  }
}
