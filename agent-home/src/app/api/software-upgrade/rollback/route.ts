/**
 * POST /api/software-upgrade/rollback {password} — owner or admin. Puts back the
 * version the last upgrade came from, with its pre-upgrade backup.
 */
import { NextResponse } from "next/server";

import { BAD_JSON, badRequest, readJsonBody } from "@/lib/api/admin-route";
import { forwardMemberError, requireMemberAdmin } from "@/lib/api/member-bff";

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await requireMemberAdmin();
  if ("response" in gate) return gate.response;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) return badRequest("Enter your password to confirm.");
  try {
    return NextResponse.json(await gate.client.rollbackSoftwareUpgrade({ password }), {
      status: 202,
    });
  } catch (err) {
    return forwardMemberError(err);
  }
}
