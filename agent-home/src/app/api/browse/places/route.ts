/**
 * GET /api/browse/places — Files → Browse: the caller's network folders (own
 * and shared with them) and their workspace. Folders on the person's own
 * computer are listed by the browser itself and never come through here.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { browseFail, unauthenticated } from "@/lib/browse/bff";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.browsePlaces());
  } catch (err) {
    return browseFail(err);
  }
}
