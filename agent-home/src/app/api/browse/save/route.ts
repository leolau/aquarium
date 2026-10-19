/**
 * POST /api/browse/save `{place, path}` — copy one file into the caller's own
 * Files (it then shows on Files → Arrived). Pressing the button is the
 * person's approval; the page asks first for a network folder that isn't
 * "trusted for import".
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { badRequest, browseFail, placeAndPath, unauthenticated } from "@/lib/browse/bff";

export async function POST(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const target = placeAndPath(await req.json().catch(() => null), { pathRequired: true });
  if (!target) return badRequest();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.browseSave(target.place, target.path));
  } catch (err) {
    return browseFail(err);
  }
}
