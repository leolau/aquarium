/**
 * FG-33 decision 4: local apps share this origin under `/apps/*` and
 * `/apps-dev/*`, so refuse agent-home requests that an app page made
 * (see `lib/apps/guard.ts`).
 *
 * Settings → Menu: pages and BFF routes of an app hidden from the caller's
 * role are refused here — pages render `/not-available`, APIs answer 403
 * (mapping: `lib/nav/menu-access.ts`).
 */
import { NextResponse, type NextRequest } from "next/server";

import { guardAgentHomeRequest } from "@/lib/apps/guard";
import { deserializeSession, sessionCookieValue } from "@/lib/auth/session";
import { getHiddenAppsForMiddleware } from "@/lib/nav/hidden-apps";
import { blockedAppForPath, NOT_AVAILABLE_PATH, ROLE_GATED_APPS } from "@/lib/nav/menu-access";

async function roleGate(request: NextRequest): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl;
  // Most requests touch no hideable app: skip the session and the lookup.
  if (!blockedAppForPath(pathname, ROLE_GATED_APPS)) return null;
  let session;
  try {
    session = deserializeSession(sessionCookieValue(request.cookies));
  } catch {
    return null;
  }
  if (!session) return null;
  const hidden = await getHiddenAppsForMiddleware(session.principal, session.hermesToken);
  const blocked = blockedAppForPath(pathname, hidden);
  if (!blocked) return null;
  if (blocked.kind === "api") {
    return NextResponse.json(
      { error: "not_available_for_role", app: blocked.app, detail: "This isn't available for your role." },
      { status: 403 },
    );
  }
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
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
