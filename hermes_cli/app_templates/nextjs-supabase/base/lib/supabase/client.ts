"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client, or null when the app has not opted into Supabase APIs. */
export function browserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createBrowserClient(url, key, {
    cookieOptions: { path: process.env.APP_BASE_PATH || "/", sameSite: "lax" },
  });
}
