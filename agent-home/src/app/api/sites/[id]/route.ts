/**
 * GET / PATCH / DELETE (= pause) /api/sites/{id}. Hermes answers 404 to anyone
 * without a grant on the site.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { SiteInput } from "@/types/sites";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.site(id));
  } catch (err) {
    return hermesError(err);
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.patchSite(id, body as SiteInput));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.pauseSite(id));
  } catch (err) {
    return hermesError(err);
  }
}

