/**
 * POST /api/sites/{id}/designs/{version}/approve — a site admin approves a
 * design; Hermes then creates or extends the tables (additive only).
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string; version: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id, version } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.approveSiteDesign(id, version));
  } catch (err) {
    return hermesError(err);
  }
}

