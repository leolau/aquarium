/**
 * POST /api/session/profile `{ profile }` — switch the profile this session
 * works in (FG-28 B3).
 *
 * Authority is profile-local, so the switch is a fresh `whoami?profile=` with
 * the session's own token: Python re-derives the principal from the target
 * profile's `principals`. Only a 200 rewrites the session (and the last-profile
 * hint); a refusal leaves the cookie exactly as it was, so a failed switch can
 * never leave the browser half in another profile.
 */
import { NextResponse } from "next/server";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { getPrincipal } from "@/lib/auth/principal";
import { readSession, writeLastProfileHint, writeSession } from "@/lib/auth/session";

/** Longest profile name accepted before asking Python (names are short slugs). */
const MAX_PROFILE_NAME = 64;

export async function POST(request: Request): Promise<NextResponse> {
  const session = (await getPrincipal()) ? await readSession() : null;
  if (!session) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { profile?: unknown } | null;
  const profile = typeof body?.profile === "string" ? body.profile.trim() : "";
  if (!profile || profile.length > MAX_PROFILE_NAME) {
    return NextResponse.json({ error: "invalid_profile" }, { status: 400 });
  }

  let answer: Awaited<ReturnType<HermesApiClient["whoami"]>>;
  try {
    answer = await new HermesApiClient({ hermesToken: session.hermesToken, profile }).whoami();
  } catch (err) {
    if (err instanceof HermesApiError && (err.status === 403 || err.status === 409)) {
      return NextResponse.json({ error: "not_enrolled", detail: err.message }, { status: 403 });
    }
    if (err instanceof HermesApiError && err.status === 401) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    return NextResponse.json({ error: "api_unreachable" }, { status: 502 });
  }
  if (!answer.configured || !answer.principal) {
    return NextResponse.json({ error: "no_principal" }, { status: 409 });
  }

  await writeSession({ ...session, profile, principal: answer.principal });
  await writeLastProfileHint(profile);
  return NextResponse.json({ ok: true, profile, principal: answer.principal });
}
