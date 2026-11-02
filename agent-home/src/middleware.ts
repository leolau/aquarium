/**
 * FG-33 decision 4: local apps share this origin under `/apps/*` and
 * `/apps-dev/*`, so refuse agent-home requests that an app page made
 * (see `lib/apps/guard.ts`).
 *
 * Settings → Menu: pages and BFF routes of an app hidden from the caller's
 * role are refused here — pages render `/not-available`, APIs answer 403
 * (mapping: `lib/nav/menu-access.ts`).
 *
 * Upload routes (`BODY_ROUTES` in `lib/http/body-route-guard.ts`) are not
 * matched: running middleware on a streaming request body corrupts it in
 * Next 15.5, so those handlers call `guardBodyRoute` for the same checks.
 */
import { NextResponse, type NextRequest } from "next/server";

import { guardAgentHomeRequest } from "@/lib/apps/guard";
import { notAvailableForRole, roleBlockedApp } from "@/lib/http/body-route-guard";
import { NOT_AVAILABLE_PATH } from "@/lib/nav/menu-access";

async function roleGate(request: NextRequest): Promise<NextResponse | null> {
  const blocked = await roleBlockedApp(request.nextUrl.pathname, request.cookies);
  if (!blocked) return null;
  if (blocked.kind === "api") return notAvailableForRole(blocked.app);
  return NextResponse.rewrite(
    new URL(`${NOT_AVAILABLE_PATH}?app=${encodeURIComponent(blocked.app)}`, request.url),
  );
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const verdict = guardAgentHomeRequest(request.method, request.nextUrl.pathname, request.headers);
  if (!verdict.ok) {
    return NextResponse.json({ error: "forbidden", detail: verdict.reason }, { status: 403 });
  }
  return (await roleGate(request)) ?? NextResponse.next();
}

export const config = {
  // Node runtime: an edge bundle would also pull instrumentation.ts (undici).
  runtime: "nodejs",
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/chat/upload/?$|api/files/import/?$|api/projects/[^/]+/files/upload/?$).*)",
  ],
};
