/**
 * GET /api/apps/auth — Caddy `forward_auth` target for local apps
 * (FG-33 P8-1 1.5, decision 4: `/apps/<slug>/` prod, `/apps-dev/<slug>/` dev).
 *
 * Caddy calls this for every request to an app instance, forwarding the
 * browser's headers plus `X-Forwarded-Uri` and `X-Aquarium-App:
 * <slug>/<mode>` (set by the instance block, so the slug checked here is the
 * one Caddy routes to). A 2xx answer carries `X-Aquarium-Principal`, which
 * Caddy copies onto the proxied request; any other answer goes back to the
 * browser as-is. Caddy refuses this path from the outside, so only the
 * forward_auth subrequest reaches it.
 *
 *   404 not an app path / no such local app the visitor may read
 *   403 a request one app's page made to another app (guard.ts)
 *   401 / 302 → /login when signed out (302 for page navigations)
 *   503 front door not configured, or the registry is unreachable
 */
import { resolveAppAccess } from "@/lib/apps/access";
import { guardAppRequest } from "@/lib/apps/guard";
import { parseAppPath } from "@/lib/apps/paths";
import {
  APP_TICKET_HEADER,
  appAudience,
  appsTicketSecret,
  mintAppTicket,
} from "@/lib/apps/ticket";
import { apiClientForRequest, getPrincipal } from "@/lib/auth/principal";

export const dynamic = "force-dynamic";

function reply(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function isNavigation(request: Request): boolean {
  return request.headers.get("sec-fetch-mode") === "navigate";
}

function signedOut(request: Request): Response {
  if (isNavigation(request)) return reply(302, "", { location: "/login" });
  return reply(401, "Sign in to continue.");
}

export async function GET(request: Request): Promise<Response> {
  const target = parseAppPath(request.headers.get("x-forwarded-uri") ?? "");
  if (!target || request.headers.get("x-aquarium-app") !== appAudience(target.slug, target.mode)) {
    return reply(404, "Not found.");
  }
  const verdict = guardAppRequest(target, request.headers);
  if (!verdict.ok) return reply(403, "Forbidden.");

  const principal = await getPrincipal();
  if (!principal) return signedOut(request);
  const master = appsTicketSecret();
  if (!master) return reply(503, "Local apps are not configured on this box.");

  const access = await resolveAppAccess(
    await apiClientForRequest(),
    principal,
    target.slug,
    target.mode,
  );
  if (access.status === "unauthenticated") return signedOut(request);
  if (access.status === "not_found") return reply(404, "Not found.");
  if (access.status === "unavailable") return reply(503, "The app registry is unavailable.");

  return reply(200, "", {
    [APP_TICKET_HEADER]: mintAppTicket(principal, target.slug, target.mode, master),
  });
}
