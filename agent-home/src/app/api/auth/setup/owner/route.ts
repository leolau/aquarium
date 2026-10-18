/**
 * POST /api/auth/setup/owner — create the owner's login from the one-time
 * first-run link (`hermes setup-link`). **Unauthenticated on purpose**: the
 * owner has no login yet; the one-time token is the credential. Forwards to the
 * dashboard's `/api/setup/owner` and passes its answer through unchanged. The
 * token and password travel only in the JSON body and are never logged.
 */
import { NextResponse } from "next/server";

import { HermesApiClient } from "@/lib/api/client";
import { callerIp } from "@/lib/api/callerIp";

import { readSetupBody, setupFailure, str } from "../route-common";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await readSetupBody(request);
  if (body === null) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      await new HermesApiClient().setupOwner(
        { token: str(body.token), email: str(body.email), password: str(body.password) },
        callerIp(request),
      ),
    );
  } catch (err) {
    return setupFailure(err);
  }
}
