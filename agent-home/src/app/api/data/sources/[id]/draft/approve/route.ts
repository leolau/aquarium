/** POST — the source's owner or an admin approves the open draft, minus rejected tables. */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  const reject = Array.isArray(body.reject) ? body.reject.filter((t): t is string => typeof t === "string") : [];
  if (typeof body.version !== "number") {
    return NextResponse.json({ error: "invalid_body", detail: "Give the draft's version." }, { status: 400 });
  }
  try {
    return NextResponse.json(await (await apiClientForRequest()).approveDictionary(id, { version: body.version, reject }));
  } catch (err) {
    return hermesError(err);
  }
}
