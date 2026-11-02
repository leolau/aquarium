/**
 * POST /api/mssql/connections/{name}/test — sign in with the caller's saved
 * settings (through the VPN when one is chosen) and read the server version.
 * A failed sign-in is a 200 with the reason in `connection.last_test`.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { name } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.testMssqlConnection(name));
  } catch (err) {
    return hermesError(err);
  }
}
