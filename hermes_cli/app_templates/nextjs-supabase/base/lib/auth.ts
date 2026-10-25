import { headers } from "next/headers";
import { APP_SLUG, AUTH_MODE, appMode } from "@/app.config.mjs";
import { secret } from "./env";
import { serverSupabase } from "./supabase/server";
import { verifyTicket } from "./ticket";

export interface AppUser {
  id: string;
  source: "aquarium" | "supabase";
}

/** Header the Aquarium front door sets after checking the agent-home session:
 * a signed, 60-second ticket for exactly this app and mode (lib/ticket.ts). */
export const PRINCIPAL_HEADER = "x-aquarium-principal";

/**
 * The one place the app learns who is calling. `aquarium` trusts only a
 * front-door ticket signed with this instance's key; `supabase` reads
 * the GoTrue session; `none` has no end-user identity.
 */
export async function getUser(): Promise<AppUser | null> {
  if (AUTH_MODE === "aquarium") {
    const claims = verifyTicket(
      (await headers()).get(PRINCIPAL_HEADER),
      secret("APP_TICKET_KEY"),
      `${APP_SLUG}/${appMode()}`,
    );
    return claims ? { id: claims.sub, source: "aquarium" } : null;
  }
  if (AUTH_MODE === "supabase") {
    const supabase = await serverSupabase();
    if (!supabase) return null;
    const { data } = await supabase.auth.getUser();
    return data.user ? { id: data.user.id, source: "supabase" } : null;
  }
  return null;
}
