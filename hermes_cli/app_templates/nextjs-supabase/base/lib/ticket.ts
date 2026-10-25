import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The front door's `X-Aquarium-Principal` ticket (agent-home
 * src/lib/apps/ticket.ts): `v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256(key, "v1." + payload))>`.
 * `key` is this instance's APP_TICKET_KEY credential; `aud` must be
 * `<slug>/<mode>` and the ticket lives 60 s.
 */
export interface TicketClaims {
  sub: string;
  role: string;
  name: string;
  aud: string;
  iat: number;
  exp: number;
}

const MAX_CLOCK_SKEW_SECONDS = 5;

export function verifyTicket(
  ticket: string | null | undefined,
  key: string | undefined,
  audience: string,
  nowMs: number = Date.now(),
): TicketClaims | null {
  if (!ticket || !key) return null;
  const parts = ticket.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, sig] = parts;
  const expected = Buffer.from(createHmac("sha256", key).update(`v1.${payload}`).digest("base64url"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let claims: Partial<TicketClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.sub !== "string" ||
    !claims.sub ||
    typeof claims.role !== "string" ||
    typeof claims.name !== "string" ||
    claims.aud !== audience ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp)
  ) {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  if ((claims.exp as number) <= now || (claims.iat as number) > now + MAX_CLOCK_SKEW_SECONDS) return null;
  return claims as TicketClaims;
}
