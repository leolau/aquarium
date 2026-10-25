/**
 * FG-33 decision 4 mitigations that run on request headers.
 *
 * Apps share agent-home's origin, so the browser's own same-origin checks do
 * not separate them. Origin carries no path, so the discriminator is the
 * Referer (agent-home and apps send full same-origin referrers), backed by
 * Sec-Fetch-* where the browser provides them.
 *
 * - `guardAgentHomeRequest` (agent-home middleware): refuse agent-home API
 *   calls made from an app page, and same-origin API calls with no Referer
 *   at all (an app can suppress it), except the public routes agent-home's
 *   own no-referrer pages (`/activate`, `/setup`, `/survey`) call.
 * - `guardAppRequest` (`/api/apps/auth`): refuse an app's ticket for
 *   subresource requests made by another app's (or agent-home's) page, so
 *   app A cannot drive app B with the visitor's identity.
 */
import { isAppPath, isWithinApp, type AppTarget } from "@/lib/apps/paths";
import routeRoles from "@/lib/auth/route-roles.json";

export interface HeaderBag {
  get(name: string): string | null;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

export const FRONT_DOOR_AUTH_PATH = "/api/apps/auth";

const OK: GuardResult = { ok: true };
const FRAME_DESTS = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

function deny(reason: string): GuardResult {
  return { ok: false, reason };
}

interface CompiledRoute {
  method: string;
  pattern: RegExp;
}

function compileRoute(key: string): CompiledRoute {
  const [method, path] = key.split(" ");
  const source = path
    .split("/")
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return ".+";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { method, pattern: new RegExp(`^${source}$`) };
}

const PUBLIC_API_ROUTES: CompiledRoute[] = Object.entries(routeRoles as Record<string, string>)
  .filter(([, role]) => role === "public")
  .map(([key]) => compileRoute(key));

export function isPublicApiRoute(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  return PUBLIC_API_ROUTES.some((r) => r.method === m && r.pattern.test(pathname));
}

function requestHost(headers: HeaderBag): string | null {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  return host ? host.split(",")[0].trim().toLowerCase() : null;
}

/** The Referer when it is a URL on this host; null otherwise. */
function sameHostReferer(headers: HeaderBag): URL | null {
  const raw = headers.get("referer");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = requestHost(headers);
  if (host && url.host.toLowerCase() !== host) return null;
  return url;
}

function isTopLevelNavigation(headers: HeaderBag): boolean {
  return (
    headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document"
  );
}

export function guardAgentHomeRequest(
  method: string,
  pathname: string,
  headers: HeaderBag,
): GuardResult {
  // The forward_auth subrequest carries the app page's own headers.
  if (pathname === FRONT_DOOR_AUTH_PATH) return OK;
  const site = headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return OK;
  const isApi = pathname === "/api" || pathname.startsWith("/api/");
  const referer = sameHostReferer(headers);
  if (referer && isAppPath(referer.pathname)) {
    return !isApi && isTopLevelNavigation(headers) ? OK : deny("app_page_origin");
  }
  if (site === "same-origin" && !referer) {
    if (isApi) return isPublicApiRoute(method, pathname) ? OK : deny("missing_referer");
    if (FRAME_DESTS.has(headers.get("sec-fetch-dest") ?? "")) return deny("missing_referer");
  }
  return OK;
}

export function guardAppRequest(target: AppTarget, headers: HeaderBag): GuardResult {
  const site = headers.get("sec-fetch-site");
  if (!site || site === "none") return OK;
  if (isTopLevelNavigation(headers)) return OK;
  if (site === "same-origin") {
    if (headers.get("sec-fetch-mode") === "websocket") return OK;
    const referer = sameHostReferer(headers);
    if (referer && isWithinApp(referer.pathname, target)) return OK;
    return deny("cross_app_request");
  }
  return deny("cross_site_subresource");
}
