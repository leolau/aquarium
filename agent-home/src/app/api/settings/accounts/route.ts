/**
 * /api/settings/accounts — whose each mailbox, calendar and WhatsApp phone is
 * (FG-38 P2b). GET lists them with the reason; PUT {surface, account,
 * owner_user_id} names whose new arrivals are (`null` clears the choice).
 * Owner only; Python re-checks and is the authority.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { getPrincipal } from "@/lib/auth/principal";
import { ACCOUNT_SURFACES, type AccountsState } from "@/lib/accounts";

const UNAUTHENTICATED = { error: "unauthenticated" };
const FORBIDDEN = { error: "forbidden", detail: "Only the owner manages whose accounts are whose." };

async function gate(): Promise<NextResponse | null> {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json(UNAUTHENTICATED, { status: 401 });
  if (!principal.is_owner) return NextResponse.json(FORBIDDEN, { status: 403 });
  return null;
}

function invalid(detail: string): NextResponse {
  return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;
  return withPrincipal((client) => client.request<AccountsState>("/api/settings/accounts"));
}

export async function PUT(req: Request): Promise<NextResponse> {
  const denied = await gate();
  if (denied) return denied;
  const raw: unknown = await readBody(req);
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const { surface, account, owner_user_id: who } = body;
  if (typeof surface !== "string" || !(ACCOUNT_SURFACES as readonly string[]).includes(surface)) {
    return invalid("surface must be email, calendar or whatsapp.");
  }
  if (typeof account !== "string" || account.trim() === "") return invalid("account is required.");
  if (!("owner_user_id" in body)) return invalid("Give owner_user_id (or null to clear it).");
  if (who !== null && (typeof who !== "string" || who.trim() === "")) {
    return invalid("owner_user_id must be a person's id or null.");
  }
  return withPrincipal((client) =>
    client.request<AccountsState>("/api/settings/accounts", {
      method: "PUT",
      json: { surface, account, owner_user_id: who },
    }),
  );
}
