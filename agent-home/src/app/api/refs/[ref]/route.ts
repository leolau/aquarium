/**
 * GET /api/refs/:ref — what a short ref (`P12`, `T345`, `P12-R3`) names:
 * kind, internal id, title, status and the agent-home URL (FG-36).
 *
 * Forwards to the Python `/api/refs/{ref}` under the bridged principal,
 * which answers 404 alike for a ref that names nothing and for an item the
 * caller may not see.
 */
import { NextResponse } from "next/server";

import { parseRef } from "@/lib/refs";

import { withPrincipal } from "../../projects/hermes-bridge";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ref: string }> },
): Promise<NextResponse> {
  const { ref } = await params;
  const parsed = parseRef(ref);
  if (!parsed) {
    return NextResponse.json({ error: "not_found", detail: "ref not found" }, { status: 404 });
  }
  return withPrincipal((client) => client.resolveRef(parsed.ref));
}
