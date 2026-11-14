/** POST — make an earlier approved version current again (as a new version). */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string; version: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id, version } = await ctx.params;
  try {
    return NextResponse.json(await (await apiClientForRequest()).restoreDictionary(id, version));
  } catch (err) {
    return hermesError(err);
  }
}
