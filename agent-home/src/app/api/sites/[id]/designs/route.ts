/**
 * GET /api/sites/{id}/designs — design versions (recipes for site admins only).
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.siteDesigns(id));
  } catch (err) {
    return hermesError(err);
  }
}

