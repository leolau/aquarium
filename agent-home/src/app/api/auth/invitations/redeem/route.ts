/**
 * POST /api/auth/invitations/redeem — activate an account from an invitation.
 * **Unauthenticated on purpose**: somebody setting their first password has no
 * session yet, which is the whole point of the link.
 *
 * This handler adds no gate and no judgement of its own. It forwards the token
 * and the chosen password, and passes the upstream answer through unchanged —
 * because upstream returns an *identical* neutral 400 for every failure mode
 * (unknown, tampered, expired, already used, revoked, rate-limited), and any
 * local pre-check here would leak the distinction the neutrality is protecting.
 * The token is never logged. `profile` (from `/activate/<profile>/<token>`)
 * is forwarded as-is; upstream validates it and answers the same neutral 400
 * for an unknown one.
 */
import { NextResponse } from "next/server";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { callerIp } from "@/lib/api/callerIp";

interface RedeemBody {
  token?: unknown;
  password?: unknown;
  profile?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: RedeemBody;
  try {
    body = (await request.json()) as RedeemBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const password = typeof body.password === "string" ? body.password : "";
  const profile = typeof body.profile === "string" ? body.profile.trim() : "";
  try {
    return NextResponse.json(
      await new HermesApiClient().redeemInvitation(
        { token, password, ...(profile ? { profile } : {}) },
        callerIp(request),
      ),
    );
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "activation_failed", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
