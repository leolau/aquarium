/**
 * GET /api/email/mailboxes — the caller's own IMAP/SMTP mailboxes (Get
 * ready item 7). Hermes scopes the list to the signed-in person and never
 * returns a password.
 */
import { NextResponse } from "next/server";

import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { hermesError, unauthenticated } from "./_shared";

export async function GET(): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.emailMailboxes());
  } catch (err) {
    return hermesError(err);
  }
}
