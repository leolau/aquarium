/**
 * /api/wa-bridges — BFF for the deployment's WhatsApp bridge units
 * (Settings → WhatsApp bridges).
 *
 * GET lists every hermes-wa-bridge-* unit with pairing/QR state; POST
 * {name} provisions a new bridge unit via the host's root-owned
 * /usr/local/sbin/hermes-wa-bridge-add helper.
 * The Python side is owner-gated — bridges are box-global.
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
    return NextResponse.json(await client.waBridges());
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

export async function POST(req: Request): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: { name?: string };
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const name = (body.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) {
    return NextResponse.json(
      { error: "bad_name", detail: "lowercase letters, digits, hyphens" },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.waBridgeAdd(name));
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
