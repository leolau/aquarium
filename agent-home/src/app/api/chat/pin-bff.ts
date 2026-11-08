/**
 * Shared plumbing for the landing pin BFF routes: principal check, the
 * profile-aware client with the browser's Idempotency-Key forwarded, and
 * upstream errors mapped to their status (502 when unreachable).
 */
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { HermesApiClient, HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export async function withPinClient(
  profile: string | undefined,
  handler: (client: HermesApiClient) => Promise<unknown>,
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  try {
    const client = await apiClientForRequest({ profile });
    const key = await incomingIdempotencyKey();
    if (key) client.forwardIdempotencyKey(key);
    return NextResponse.json(await handler(client));
  } catch (err) {
    if (err instanceof HermesApiError) {
      const raw = err.body ? (err.body as { detail?: unknown }).detail : undefined;
      return NextResponse.json(
        { error: "api_error", detail: typeof raw === "string" ? raw : undefined },
        { status: err.status },
      );
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}

async function incomingIdempotencyKey(): Promise<string | null> {
  try {
    return (await headers()).get("idempotency-key");
  } catch {
    return null;
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
