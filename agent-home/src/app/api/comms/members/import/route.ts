/**
 * POST /api/comms/members/import — bulk enrolment from `email,display,role`
 * CSV (owner/admin).
 *
 * `dry_run` defaults to **true** and has to be turned off explicitly: the
 * difference between a preview and an apply is forty invitations to the wrong
 * addresses, so the safe reading of a missing flag is "show me first".
 */
import { NextResponse } from "next/server";

import { bodyTarget, forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

interface ImportBody {
  csv?: unknown;
  profile?: unknown;
  dry_run?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const target = bodyTarget(request, body.profile);
  if ("response" in target) return target.response;
  const gate = await requireMemberAdmin(request, target);
  if ("response" in gate) return gate.response;
  const csv = typeof body.csv === "string" ? body.csv : "";
  const profile = target.profile ?? "";
  if (!csv.trim()) {
    return NextResponse.json(
      { error: "invalid_input", detail: "Paste at least one CSV row." },
      { status: 400 },
    );
  }
  if (!profile) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: "A profile is required — choose which profile to enrol into.",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json(
      await gate.client.importMembers({
        csv,
        profile,
        dry_run: body.dry_run !== false,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
