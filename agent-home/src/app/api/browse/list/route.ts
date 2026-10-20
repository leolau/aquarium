/**
 * GET /api/browse/list?place=&path= — one folder level of a place. Hermes
 * scopes `place` to the caller and never walks deeper than this one folder.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { badRequest, browseFail, placeAndPath, unauthenticated } from "@/lib/browse/bff";

export async function GET(req: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const sp = new URL(req.url).searchParams;
  const target = placeAndPath(
    { place: sp.get("place"), path: sp.get("path") ?? "" },
    { pathRequired: false },
  );
  if (!target) return badRequest();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.browseList(target.place, target.path));
  } catch (err) {
    return browseFail(err);
  }
}
