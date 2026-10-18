/**
 * /api/access/roles/[role] — PUT {deny_tools: string[]} replaces a role's
 * blocked tools; PUT {reset: true} goes back to the defaults. Owner and admin
 * only (Python re-checks; it is the authority).
 */
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

type Body = { deny_tools?: unknown; reset?: unknown };

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ role: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (principal.role !== "owner" && principal.role !== "admin") {
    return NextResponse.json(
      {
        error: "forbidden",
        detail: "Only the owner or an admin can change what each role can use.",
      },
      { status: 403 },
    );
  }
  const { role } = await params;
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  let change: { deny_tools: string[] } | { reset: true };
  if (body.reset === true) {
    change = { reset: true };
  } else if (
    Array.isArray(body.deny_tools) &&
    body.deny_tools.every((t) => typeof t === "string")
  ) {
    change = { deny_tools: body.deny_tools as string[] };
  } else {
    return NextResponse.json(
      { error: "bad_body", detail: "Send deny_tools (a list of names) or reset: true." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    return NextResponse.json(await client.setRoleLimits(role, change));
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
