/**
 * POST /api/auth/setup/domain — first-run read-only domain check (DNS + HTTPS).
 * **Unauthenticated on purpose**: the owner has no login yet; the one-time
 * setup token is the credential, and the dashboard refuses the step once the
 * owner exists. Secrets travel only in the JSON body and are never logged.
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
      await new HermesApiClient().setupDomain(
        { token: str(body.token), host: str(body.host) },
        callerIp(request),
      ),
    );
  } catch (err) {
    return setupFailure(err);
  }
}
