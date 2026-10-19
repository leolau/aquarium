/**
 * POST /api/account/two-factor/{start|confirm|disable|recovery-codes} — the
 * caller's own two-factor login. Secrets and recovery codes pass through to
 * the browser once and are never logged or stored here.
 */
import { NextResponse } from "next/server";

import { TWO_FACTOR_ACTIONS, type TwoFactorAction } from "@/lib/api/client";
import { callerIp } from "@/lib/api/callerIp";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

import { accountFailure, readJson, str } from "../../route-common";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  if (!(await getPrincipal())) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const { action } = await params;
  if (!(TWO_FACTOR_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await readJson(request);
  if (body === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const client = await apiClientForRequest();
    const result = await client.twoFactor(
      action as TwoFactorAction,
      { password: str(body.password), code: str(body.code) },
      callerIp(request),
    );
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return accountFailure(err);
  }
}
