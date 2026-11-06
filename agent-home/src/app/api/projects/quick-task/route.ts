/**
 * POST /api/projects/quick-task — Task mode's Start task: one request becomes
 * an ordinary one-off project; the agent words the brief, drafts the plan,
 * activates it and starts run 1 (or stops after the draft with
 * `check_plan_first`). Same create + activation gates as Project mode.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "../hermes-bridge";
import type { ProjectAutonomy } from "@/types";

const AUTONOMY: readonly ProjectAutonomy[] = ["supervised", "autonomous", "manual"];

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readBody(req);
  const request = String(body.request ?? "").trim();
  const hostProfile = String(body.host_profile ?? "").trim();
  if (!request || !hostProfile) {
    return NextResponse.json(
      { error: "invalid_body", detail: "Say what the agent should do and pick a profile." },
      { status: 400 },
    );
  }
  const autonomy = (AUTONOMY as readonly string[]).includes(String(body.autonomy))
    ? (body.autonomy as ProjectAutonomy)
    : "supervised";
  return withPrincipal((client) =>
    client.createQuickTask({
      request,
      host_profile: hostProfile,
      autonomy,
      check_plan_first: body.check_plan_first === true,
    }),
  );
}
