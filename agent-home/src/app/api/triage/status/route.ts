/**
 * GET /api/triage/status — which triage kinds (email, WhatsApp, calendar) the
 * signed-in person has set up, the skill files each pipeline reads, and where
 * each is configured. Read-only; Hermes counts only the caller's own
 * mailboxes, numbers and calendars and never returns a secret. `?profile=` is
 * bound like the Skills APIs (Hermes refuses a profile the caller isn't in).
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageStatus());
  } catch (err) {
    return hermesError(err);
  }
}
