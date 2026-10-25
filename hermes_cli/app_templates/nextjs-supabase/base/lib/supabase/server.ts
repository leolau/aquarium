import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { basePath } from "@/app.config.mjs";

/** Server-side Supabase client, or null when the app has not opted into Supabase APIs. */
export async function serverSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  const store = await cookies();
  return createServerClient(url, key, {
    cookieOptions: { path: basePath() || "/", sameSite: "lax" },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server Components cannot set cookies; middleware refreshes the session.
        }
      },
    },
  });
}
