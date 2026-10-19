/**
 * POST /api/account/password — change the caller's own password. The API
 * re-checks the current password (and code when two-factor is on); the target
 * is always the signed-in login, never an id from the body.
 */
import { NextResponse } from "next/server";

import { callerIp } from "@/lib/api/callerIp";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { accountFailure, readJson, str } from "../route-common";

export async function POST(request: Request): Promise<NextResponse> {
  if (!(await getPrincipal())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = await readJson(request);
  if (body === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.changePassword(
        {
          current_password: str(body.current_password),
          new_password: str(body.new_password),
          code: str(body.code),
        },
        callerIp(request),
      ),
    );
  } catch (err) {
    return accountFailure(err);
  }
}
