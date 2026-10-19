/**
 * Google step A — the install's OAuth client (**owner only**).
 *
 * GET  /api/google-client → status (saved? which kind? last check) + step ticks.
 * PUT  /api/google-client → save + check a client (uploaded JSON or pasted id
 *      and secret); an existing client needs `replace: true`.
 *
 * The secret only travels browser → BFF → Python; no response carries it.
 * Python enforces the same owner guard independently.
 */
import { NextResponse } from "next/server";

import { forwardMemberError, requireMemberOwner } from "@/lib/api/member-bff";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMemberOwner();
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await gate.client.googleClientStatus());
  } catch (err) {
    return forwardMemberError(err);
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const gate = await requireMemberOwner();
  if ("response" in gate) return gate.response;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_input", detail: "invalid_request" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  try {
    return NextResponse.json(
      await gate.client.saveGoogleClient({
        client_json: str(body.client_json),
        client_id: str(body.client_id),
        client_secret: str(body.client_secret),
        replace: body.replace === true,
      }),
    );
  } catch (err) {
    return forwardMemberError(err);
  }
}
