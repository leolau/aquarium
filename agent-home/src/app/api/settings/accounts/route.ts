/**
 * /api/settings/accounts — whose each mailbox, calendar and WhatsApp phone is
 * (FG-38 P2b). GET lists them with the reason; PUT {surface, account,
 * owner_user_id} names whose new arrivals are (`null` clears the choice).
 * Owner only; Python re-checks and is the authority.
 */
import { NextResponse } from "next/server";

import { readBody, withPrincipal } from "@/app/api/projects/hermes-bridge";
import { ACCOUNT_SURFACES, type AccountsState } from "@/lib/accounts";
import { requireMemberOwner } from "@/lib/api/member-bff";

const OWNER_ONLY = "Only the owner manages whose accounts are whose.";


function invalid(detail: string): NextResponse {
  return NextResponse.json({ error: "invalid_body", detail }, { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  const owner = await requireMemberOwner(OWNER_ONLY);
  if ("response" in owner) return owner.response;
  return withPrincipal((client) => client.request<AccountsState>("/api/settings/accounts"));
}

export async function PUT(req: Request): Promise<NextResponse> {
  const owner = await requireMemberOwner(OWNER_ONLY);
  if ("response" in owner) return owner.response;
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
