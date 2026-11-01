/**
 * /api/settings/menu/[role] — PUT {hidden: string[]} replaces the menu items
 * hidden from one role (admin, member or viewer). Owner and admin only (Python
 * re-checks and validates the ids; it is the authority). A save drops the
 * cached menu lists so the launcher and URL blocking follow within a request.
 */
import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";
import { ADMIN_ONLY_DENIED, canAdminister } from "@/lib/auth/roles";
import { clearLocalNavCache, NAV_CACHE_TAG } from "@/lib/nav/hidden-apps";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ role: string }> },
): Promise<NextResponse> {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!canAdminister(principal)) {
    return NextResponse.json({ error: "forbidden", detail: ADMIN_ONLY_DENIED }, { status: 403 });
  }
  const { role } = await params;
  let body: { hidden?: unknown };
  try {
    body = (await request.json()) as { hidden?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!Array.isArray(body.hidden) || !body.hidden.every((id) => typeof id === "string")) {
    return NextResponse.json(
      { error: "bad_body", detail: "Send hidden: a list of menu item ids." },
      { status: 400 },
    );
  }
  try {
    const client = await apiClientForRequest();
    const result = await client.setAgentHomeNav(role, body.hidden as string[]);
    revalidateTag(NAV_CACHE_TAG);
    clearLocalNavCache();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof HermesApiError) {
      return NextResponse.json({ error: "api_error", detail: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: "api_unreachable", detail: "The AI layer could not be reached." },
      { status: 502 },
    );
  }
}
