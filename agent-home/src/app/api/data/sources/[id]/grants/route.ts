/** GET / POST / DELETE — who may read or propose changes to a source's dictionary (managers only). */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await (await apiClientForRequest()).dataGrants(id));
  } catch (err) {
    return hermesError(err);
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.user_id !== "string" || (body.grant !== "read" && body.grant !== "propose")) {
    return NextResponse.json({ error: "invalid_body", detail: "Give user_id and grant (read or propose)." }, { status: 400 });
  }
  try {
    return NextResponse.json(await (await apiClientForRequest()).putDataGrant(id, { user_id: body.user_id, grant: body.grant }));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const userId = new URL(req.url).searchParams.get("user_id") ?? "";
  if (!userId) return NextResponse.json({ error: "invalid_body", detail: "Give user_id." }, { status: 400 });
  try {
    return NextResponse.json(await (await apiClientForRequest()).revokeDataGrant(id, userId));
  } catch (err) {
    return hermesError(err);
  }
}
