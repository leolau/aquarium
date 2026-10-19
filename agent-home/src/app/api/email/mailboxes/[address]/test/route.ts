/**
 * POST /api/email/mailboxes/{address}/test — log into IMAP and SMTP with the
 * caller's saved settings. No mail is sent; a failed login is a 200 with
 * the reason in `mailbox.last_test`.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "../../_shared";

type Ctx = { params: Promise<{ address: string }> };

export async function POST(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { address } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.testEmailMailbox(address));
  } catch (err) {
    return hermesError(err);
  }
}
