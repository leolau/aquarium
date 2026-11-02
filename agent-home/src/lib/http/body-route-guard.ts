/**
 * Request checks for the upload routes the middleware does not run on.
 *
 * Next 15.5's Node middleware tees every request body it matches and swaps the
 * buffered copy in without awaiting it (`next-server.js`:
 * `requestData.body.finalize()`), so a multipart body still arriving when the
 * middleware returns reaches the route half-consumed and `formData()` throws
 * (`invalid_form`); the tee also truncates bodies over 10 MB
 * (`middlewareClientMaxBodySize`). The routes in `BODY_ROUTES` are therefore
 * excluded from the middleware matcher and call `guardBodyRoute` first, which
 * runs the same checks the middleware would: the FG-33 same-origin guard and
 * the Settings → Menu role gate.
 */
import { NextResponse } from "next/server";

import { guardAgentHomeRequest } from "@/lib/apps/guard";
import { blockedAppForPath, ROLE_GATED_APPS } from "@/lib/nav/menu-access";

/** Body-heavy POST routes kept out of the middleware matcher (`src/middleware.ts`). */
export const BODY_ROUTES = [
  "/api/chat/upload",
  "/api/projects/[slug]/files/upload",
  "/api/files/import",
] as const;

export type CookieReader = { get(name: string): { value: string } | undefined };

/** A cookie reader over a raw `Cookie` header. */
export function cookieReader(header: string | null): CookieReader {
  const jar = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || jar.has(name)) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      jar.set(name, decodeURIComponent(raw));
    } catch {
      jar.set(name, raw);
    }
  }
  return { get: (name) => (jar.has(name) ? { value: jar.get(name)! } : undefined) };
}

/** The app hidden from the caller's role that `pathname` belongs to, if any. */
export async function roleBlockedApp(
  pathname: string,
  cookies: CookieReader,
): Promise<{ app: string; kind: "page" | "api" } | null> {
  // Most requests touch no hideable app: skip the session and the lookup.
  if (!blockedAppForPath(pathname, ROLE_GATED_APPS)) return null;
  const { deserializeSession, sessionCookieValue } = await import("@/lib/auth/session");
  const { getHiddenAppsForMiddleware } = await import("@/lib/nav/hidden-apps");
  let session;
  try {
    session = deserializeSession(sessionCookieValue(cookies));
  } catch {
    return null;
  }
  if (!session) return null;
  const hidden = await getHiddenAppsForMiddleware(session.principal, session.hermesToken);
  return blockedAppForPath(pathname, hidden);
}

export function notAvailableForRole(app: string): NextResponse {
  return NextResponse.json(
    { error: "not_available_for_role", app, detail: "This isn't available for your role." },
    { status: 403 },
  );
}

/** The middleware's checks for a route it does not run on; null when allowed. */
export async function guardBodyRoute(request: Request): Promise<NextResponse | null> {
  const { pathname } = new URL(request.url);
  const verdict = guardAgentHomeRequest(request.method, pathname, request.headers);
  if (!verdict.ok) {
    return NextResponse.json({ error: "forbidden", detail: verdict.reason }, { status: 403 });
  }
  const blocked = await roleBlockedApp(pathname, cookieReader(request.headers.get("cookie")));
  return blocked ? notAvailableForRole(blocked.app) : null;
}
