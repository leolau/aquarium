/**
 * POST /api/auth/invitations/request — ask an administrator for a reset link.
 * **Unauthenticated**: somebody who has lost their password cannot sign in to
 * ask.
 *
 * Always answers `{ ok: true }`, whatever happened. "No such account" and "not
 * enrolled in this profile" are exactly the enumeration oracle a sign-in page
 * must not offer, and the link itself is never returned to the requester — it
 * is minted for an admin to hand over — so this cannot be turned into a
 * takeover of somebody else's account. `profile` (the sign-in page's
 * `?profile=`) is forwarded as a hint for which of the person's enrolments
 * the request lands in.
 */
import { NextResponse } from "next/server";

import { HermesApiClient } from "@/lib/api/client";
import { callerIp } from "@/lib/api/callerIp";

interface RequestBody {
  email?: unknown;
  profile?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    body = {};
  }
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const profile = typeof body.profile === "string" ? body.profile.trim() : "";
  if (email) {
    try {
      await new HermesApiClient().requestInvitation(email, callerIp(request), profile);
    } catch {
      // Deliberately swallowed: an error here would distinguish an address the
      // box knows from one it does not.
    }
  }
  return NextResponse.json({ ok: true });
}
