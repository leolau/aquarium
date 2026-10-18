/**
 * POST /api/auth/setup/check — is this first-run setup link still usable?
 * **Unauthenticated on purpose**: the owner has no login yet. Forwards to the
 * dashboard's `/api/setup/check` (rate-limited there, neutral 400 on any token
 * problem). The token travels only in the JSON body, never in a URL or log.
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
      await new HermesApiClient().setupCheck(str(body.token), callerIp(request)),
    );
  } catch (err) {
    return setupFailure(err);
  }
}
