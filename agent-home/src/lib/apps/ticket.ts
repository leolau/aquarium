/**
 * FG-33 front door: the `X-Aquarium-Principal` ticket a local app receives.
 *
 * Caddy's `forward_auth` asks `/api/apps/auth` about every request to
 * `/apps/<slug>/…` (prod) or `/apps-dev/<slug>/…` (dev). On success the route
 * mints this ticket and Caddy copies it onto the proxied request, after first
 * deleting any client-supplied copy. The app never sees the agent-home
 * session cookie (Caddy strips it), only this.
 *
 *   v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(appKey, "v1." + payload))>
 *
 * Claims: `sub` (user id), `role`, `name`, `aud` (`<slug>/<mode>`), `iat`,
 * `exp` (seconds; `exp - iat` = 60). The HMAC key is per app instance:
 * `appKey = hex(HMAC-SHA256(master, "aquarium-app-ticket/v1/<slug>/<mode>"))`,
 * so a compromised app holds only its own key and cannot mint tickets for a
 * sibling, and `aud` stops a ticket sent to one app being replayed to another.
 * The master secret is `AGENT_HOME_APPS_TICKET_SECRET` (agent-home `.env`);
 * the app helper derives `appKey` with the same formula and hands it to the
 * instance as a systemd credential.
 */
import { createHmac, timingSafeEqual } from "crypto";

import type { AppMode } from "@/lib/apps/paths";
import type { Principal } from "@/types";

export const APP_TICKET_HEADER = "X-Aquarium-Principal";
export const APP_TICKET_TTL_SECONDS = 60;
const VERSION = "v1";
const MAX_CLOCK_SKEW_SECONDS = 5;

export interface AppTicketClaims {
  sub: string;
  role: string;
  name: string;
  aud: string;
  iat: number;
  exp: number;
}

/** Master secret for app tickets; unset = the front door is off (503). */
export function appsTicketSecret(): string | undefined {
  return process.env.AGENT_HOME_APPS_TICKET_SECRET || undefined;
}

export function appAudience(slug: string, mode: AppMode): string {
  return `${slug}/${mode}`;
}

/** The per-instance verification key handed to the app (hex string). */
export function deriveAppKey(master: string, slug: string, mode: AppMode): string {
  return createHmac("sha256", master)
    .update(`aquarium-app-ticket/${VERSION}/${appAudience(slug, mode)}`)
    .digest("hex");
}

function sign(appKey: string, payload: string): string {
  return createHmac("sha256", appKey).update(`${VERSION}.${payload}`).digest("base64url");
}

export function mintAppTicket(
  principal: Principal,
  slug: string,
  mode: AppMode,
  master: string,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: AppTicketClaims = {
    sub: principal.user_id,
    role: principal.role,
    name: principal.display,
    aud: appAudience(slug, mode),
    iat,
    exp: iat + APP_TICKET_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${VERSION}.${payload}.${sign(deriveAppKey(master, slug, mode), payload)}`;
}

function isClaims(value: unknown): value is AppTicketClaims {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.sub === "string" &&
    c.sub.length > 0 &&
    typeof c.role === "string" &&
    typeof c.name === "string" &&
    typeof c.aud === "string" &&
    Number.isInteger(c.iat) &&
    Number.isInteger(c.exp)
  );
}

/**
 * Reference verifier (what an app's `lib/auth.ts` does): signature, audience
 * and expiry. Returns the claims, or null for anything not a live ticket for
 * exactly this app instance.
 */
export function verifyAppTicket(
  ticket: string,
  appKey: string,
  audience: string,
  nowMs: number = Date.now(),
): AppTicketClaims | null {
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const [, payload, sig] = parts;
  const expected = Buffer.from(sign(appKey, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(claims) || claims.aud !== audience) return null;
  const now = Math.floor(nowMs / 1000);
  if (claims.exp <= now || claims.iat > now + MAX_CLOCK_SKEW_SECONDS) return null;
  return claims;
}
