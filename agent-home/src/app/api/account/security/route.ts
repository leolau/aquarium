/** GET /api/account/security — two-factor status of the caller's own login. */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { accountFailure } from "../route-common";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    return NextResponse.json(await (await apiClientForRequest()).accountSecurity());
  } catch (err) {
    return accountFailure(err);
  }
}
