import { headers } from "next/headers";
import { AUTH_MODE } from "@/app.config.mjs";
import { serverSupabase } from "./supabase/server";

export interface AppUser {
  id: string;
  source: "aquarium" | "supabase";
}

/** Header the Aquarium front door sets after checking the agent-home session. */
export const PRINCIPAL_HEADER = "x-aquarium-principal";
const PRINCIPAL_ID = /^[A-Za-z0-9._:@-]{1,128}$/;

/**
 * The one place the app learns who is calling. `aquarium` trusts only the
 * front-door header (the app listens on loopback behind it); `supabase` reads
 * the GoTrue session; `none` has no end-user identity.
 */
export async function getUser(): Promise<AppUser | null> {
  if (AUTH_MODE === "aquarium") {
    const id = (await headers()).get(PRINCIPAL_HEADER);
    return id && PRINCIPAL_ID.test(id) ? { id, source: "aquarium" } : null;
  }
  if (AUTH_MODE === "supabase") {
    const supabase = await serverSupabase();
    if (!supabase) return null;
    const { data } = await supabase.auth.getUser();
    return data.user ? { id: data.user.id, source: "supabase" } : null;
  }
  return null;
}
