/** POST: "Was this right?" → Yes. The answer's question and SQL become a suggested example (propose access). */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { hermesError, objectBody, unauthenticated } from "@/app/api/sites/_shared";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { id } = await ctx.params;
  const body = await objectBody(req);
  if (body instanceof NextResponse) return body;
  try {
    return NextResponse.json(await (await apiClientForRequest()).dictionaryFeedback(id, body));
  } catch (err) {
    return hermesError(err);
  }
}
