/**
 * POST /api/software-upgrade/start {version, password} — owner only. The
 * Python API re-checks the password with the login provider, then the box
 * starts the upgrade as its own job and this returns at once (202).
 */
import { NextResponse } from "next/server";

import { BAD_JSON, badRequest, readJsonBody, str } from "@/lib/api/admin-route";
import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

const VERSION = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,40})?$/;

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await requireMemberOwner("Only the owner can upgrade the software.");
  if ("response" in gate) return gate.response;
  const body = await readJsonBody(request);
  if (!body) return BAD_JSON();
  const version = str(body.version);
  const password = typeof body.password === "string" ? body.password : "";
  if (!VERSION.test(version)) return badRequest("Pick a release like v1.2.3.");
  if (!password) return badRequest("Enter your password to confirm.");
  try {
    return NextResponse.json(await gate.client.startSoftwareUpgrade({ version, password }), {
      status: 202,
    });
  } catch (err) {
    return forwardMemberError(err);
  }
}
