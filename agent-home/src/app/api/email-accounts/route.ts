/**
 * /api/email-accounts — BFF for the deployment email poller's per-account
 * `enabled` flag (Settings → Connected accounts "Email polling" toggle).
 *
 * GET lists the poller's configured accounts; PATCH {address, enabled}
 * flips the flag, creating a Gmail-defaults entry when enabling an address
 * the poller doesn't know yet. The Python side is owner-gated — the poller
 * config is box-global.
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function GET(): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.emailAccounts());
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}

export async function PATCH(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    address?: string;
    enabled?: boolean;
    auth?: unknown;
  };
  const auth =
    body.auth === "password" || body.auth === "xoauth2" ? body.auth : undefined;
  if (
    typeof body.address !== "string" ||
    typeof body.enabled !== "boolean" ||
    (body.auth !== undefined && auth === undefined)
  ) {
    return NextResponse.json(
      { error: "invalid_request", detail: "Expected {address, enabled}." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(
      await client.setEmailPolling(body.address, body.enabled, auth),
    );
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json(
        { error: "api_error", detail: err.message },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
