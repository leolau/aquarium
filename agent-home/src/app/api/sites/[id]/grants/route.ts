/**
 * GET / POST / DELETE /api/sites/{id}/grants — who may read or manage a site
 * (site admins only; Hermes checks).
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.siteGrants(id));
  } catch (err) {
    return hermesError(err);
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.user_id !== "string" || (body.grant !== "read" && body.grant !== "admin")) {
    return NextResponse.json({ error: "invalid_body", detail: "Give user_id and grant (read or admin)." }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putSiteGrant(id, { user_id: body.user_id, grant: body.grant }));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  let userId = new URL(req.url).searchParams.get("user_id") ?? "";
  if (!userId) {
    const body = await objectBody(req);
    if (body instanceof NextResponse) return body;
    userId = typeof body.user_id === "string" ? body.user_id : "";
  }
  if (!userId) return NextResponse.json({ error: "invalid_body", detail: "Give user_id." }, { status: 400 });
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.revokeSiteGrant(id, userId));
  } catch (err) {
    return hermesError(err);
  }
}
