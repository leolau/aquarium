import { notFound, redirect } from "next/navigation";

import { HermesApiError } from "@/lib/api/client";
import { apiClientForRequest, requirePrincipal } from "@/lib/auth/principal";
import { parseRef } from "@/lib/refs";

// Resolves under the live principal per request — never at build time.
export const dynamic = "force-dynamic";

/**
 * `/go/P12`, `/go/t345`, `/go/P12-R3` → the page of whatever the short ref
 * names (FG-36). A ref that names nothing, or something the caller may not
 * see, is the same not-found.
 */
export default async function Page({ params }: { params: Promise<{ ref: string }> }) {
  await requirePrincipal();
  const { ref } = await params;
  const parsed = parseRef(decodeURIComponent(ref));
  if (!parsed) notFound();
  const client = await apiClientForRequest();
  let url: string | null = null;
  try {
    url = (await client.resolveRef(parsed.ref)).url;
  } catch (err) {
    if (err instanceof HermesApiError && err.status === 404) notFound();
    throw err;
  }
  // Only ever an in-app path.
  if (!url || !url.startsWith("/") || url.startsWith("//")) notFound();
  redirect(url);
}
