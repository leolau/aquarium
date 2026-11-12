/**
 * GET/PUT /api/triage/skill-file — one of the skill files a triage pipeline
 * reads (box-wide, `triage.skills_dirs`). Any signed-in person may view it;
 * only an owner or admin may change it. The BFF refuses members and viewers up
 * front and Hermes re-checks the role in the addressed `?profile=`. Hermes
 * only serves files its triage status lists, never an arbitrary path.
 */
import { NextResponse } from "next/server";

import { hermesError, unauthenticated } from "@/app/api/email/mailboxes/_shared";
import { BAD_JSON, badRequest, readJsonBody, refuse, str, upstream } from "@/lib/api/admin-route";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { canAdminister } from "@/lib/auth/roles";
import { profileFromUrl } from "@/lib/chat/profile";

export async function GET(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) return unauthenticated();
  const url = new URL(request.url);
  const kind = str(url.searchParams.get("kind"));
  const path = str(url.searchParams.get("path"));
  if (!kind || !path) return badRequest("kind and path are required.");
  try {
    const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
    return NextResponse.json(await client.triageSkillFile(kind, path));
  } catch (err) {
    return hermesError(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal || !canAdminister(principal)) return refuse(principal);
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const kind = str(body.kind);
  const path = str(body.path);
  if (!kind || !path || typeof body.content !== "string") {
    return badRequest("kind, path and content are required.");
  }
  const content = body.content;
  const client = await apiClientForRequest({ profile: profileFromUrl(request.url) });
  return upstream(() => client.saveTriageSkillFile(kind, path, content));
}
