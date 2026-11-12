/**
 * GET /api/triage/skill-file/history — saved versions of one triage skill
 * file, newest first (any signed-in person; bound to `?profile=`).
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { badRequest, str } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const url = new URL(request.url);
  const kind = str(url.searchParams.get("kind"));
  const path = str(url.searchParams.get("path"));
  if (!kind || !path) return badRequest("kind and path are required.");
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageSkillFileHistory(kind, path));
  } catch (err) {
    return hermesError(err);
  }
}
