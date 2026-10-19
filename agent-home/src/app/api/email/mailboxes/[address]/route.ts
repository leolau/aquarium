/**
 * PUT / DELETE /api/email/mailboxes/{address} — save or remove one of the
 * caller's own mailboxes. Hermes owns validation and the owner check.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import type { EmailMailboxInput } from "@/types";

import { hermesError, unauthenticated } from "../_shared";

type Ctx = { params: Promise<{ address: string }> };

export async function PUT(req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { address } = await ctx.params;
  let body: EmailMailboxInput;
  try {
    body = (await req.json()) as EmailMailboxInput;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.putEmailMailbox(address, body));
  } catch (err) {
    return hermesError(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const { address } = await ctx.params;
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.deleteEmailMailbox(address));
  } catch (err) {
    return hermesError(err);
  }
}
